//! Strategy payoff construction: curves, breakevens, extremes, POP and EV.
//! A strategy is a list of validated legs; everything is computed against
//! the live simulated market state for the requested underlying.

use crate::market::AssetState;
use crate::models::*;
use crate::norm::norm_cdf;
use crate::pricing::{
    bs_greeks, everlasting_greeks, intrinsic, everlasting_funding, DAYS_PER_YEAR, Greeks,
    OptionType,
};
use crate::surface::{atm_vol, iv_for_strike, AssetVolConfig};

pub struct MarketCtx {
    pub cfg: AssetVolConfig,
    pub state: AssetState,
    pub underlying: String,
}

impl MarketCtx {
    pub fn iv_at(&self, strike: f64, t_years: f64) -> f64 {
        iv_for_strike(&self.cfg, self.state.spot, strike, t_years, self.state.vol_shift)
    }
    pub fn atm_iv(&self, t_years: f64) -> f64 {
        atm_vol(&self.cfg, t_years, self.state.vol_shift)
    }
}

/// A single leg resolved to an evaluatable payoff/pricing closure plus its
/// current analytics.
pub struct ResolvedLeg {
    pub input: ValidLeg,
    pub analytics: LegAnalytics,
    pub kind: LegKind,
    pub side_sign: f64,
    pub qty: f64,
    pub strike: Option<f64>,
    pub expiry_years: Option<f64>,
    pub funding_period_years: Option<f64>,
    pub option_type: Option<OptionType>,
}

/// Value of one unit of this leg at (spot, years_forward, iv_shift).
#[inline]
fn leg_value(l: &ResolvedLeg, s: f64, t_fwd: f64, iv_shift: f64, ctx: &MarketCtx) -> f64 {
    match l.kind {
        LegKind::Call | LegKind::Put => {
            let t = (l.expiry_years.unwrap() - t_fwd).max(0.0);
            let iv = (ctx.iv_at(l.strike.unwrap(), t) * (1.0 + iv_shift)).clamp(0.01, 6.0);
            bs_greeks(s, l.strike.unwrap(), t, iv, ctx.cfg.rate, l.option_type.unwrap()).price
        }
        LegKind::PerpOption => {
            let ot = l.option_type.unwrap();
            let k = l.strike.unwrap();
            let fp = l.funding_period_years.unwrap();
            let shift = iv_shift;
            everlasting_greeks(s, k, fp * DAYS_PER_YEAR, 0.0, ctx.cfg.rate, ot, &|t| {
                (ctx.iv_at(k, t) * (1.0 + shift)).clamp(0.01, 6.0)
            })
            .price
        }
        LegKind::Perp => s * (1.0 + ctx.state.funding_rate * t_fwd),
        LegKind::Spot => s,
    }
}

/// P&L of one unit of this leg at (spot, t_fwd, iv_shift): mark minus entry.
#[inline]
fn leg_pnl(l: &ResolvedLeg, s: f64, t_fwd: f64, iv_shift: f64, ctx: &MarketCtx) -> f64 {
    let v = leg_value(l, s, t_fwd, iv_shift, ctx);
    l.side_sign * (v - l.analytics.price)
}

/// Value of one unit at the horizon, where dated legs settle to intrinsic
/// and non-dated legs roll to their theoretical value at the horizon.
#[inline]
fn leg_horizon_value(l: &ResolvedLeg, s: f64, t_h: f64, iv_shift: f64, ctx: &MarketCtx) -> f64 {
    match l.kind {
        LegKind::Call | LegKind::Put => intrinsic(s, l.strike.unwrap(), l.option_type.unwrap()),
        _ => leg_value(l, s, t_h, iv_shift, ctx),
    }
}

#[inline]
fn leg_horizon_pnl(l: &ResolvedLeg, s: f64, t_h: f64, iv_shift: f64, ctx: &MarketCtx) -> f64 {
    let v = leg_horizon_value(l, s, t_h, iv_shift, ctx);
    // Perp/spot legs accrue funding; approximate carry with half the horizon.
    l.side_sign * (v - l.analytics.price)
}

#[allow(dead_code)] // analysis record kept for future engine parity
pub struct StrategyAnalysis {
    pub legs: Vec<ResolvedLeg>,
    /// Common horizon in years (max dated expiry, else default 30d).
    pub horizon_years: f64,
    pub net_premium: f64,
}

/// Resolve all legs against the market: prices, greeks, liquidity.
pub fn resolve_legs(legs: &[ValidLeg], size: f64, ctx: &MarketCtx) -> Vec<ResolvedLeg> {
    let mut out = Vec::with_capacity(legs.len());
    for (i, l) in legs.iter().enumerate() {
        let (price, greeks, iv, funding_per_day, liquidity): (
            f64,
            Greeks,
            Option<f64>,
            Option<f64>,
            f64,
        ) = match l.kind {
            LegKind::Call | LegKind::Put => {
                let t = l.expiry_days.unwrap() / DAYS_PER_YEAR;
                let iv = ctx.iv_at(l.strike.unwrap(), t);
                let g = bs_greeks(
                    ctx.state.spot,
                    l.strike.unwrap(),
                    t,
                    iv,
                    ctx.cfg.rate,
                    if l.kind == LegKind::Call {
                        OptionType::Call
                    } else {
                        OptionType::Put
                    },
                );
                (g.price, g, Some(iv), None, liquidity_score(ctx, l.strike.unwrap(), t))
            }
            LegKind::PerpOption => {
                let k = l.strike.unwrap();
                let fp_days = l.funding_period_days;
                let surface = |t: f64| ctx.iv_at(k, t);
                let g = everlasting_greeks(
                    ctx.state.spot,
                    k,
                    fp_days,
                    surface(0.0),
                    ctx.cfg.rate,
                    if l.strike.map(|s| s >= ctx.state.spot).unwrap_or(true) {
                        OptionType::Call
                    } else {
                        OptionType::Put
                    },
                    &surface,
                );
                // Everlasting option type is user-selected intent: treat strike >= spot as call view.
                let funding = everlasting_funding(g.price, ctx.state.spot, k, if l.strike.unwrap() >= ctx.state.spot { OptionType::Call } else { OptionType::Put });
                (
                    g.price,
                    g,
                    Some(surface(2.0 * l.funding_period_days / DAYS_PER_YEAR)),
                    Some(funding * DAYS_PER_YEAR / l.funding_period_days / DAYS_PER_YEAR),
                    liquidity_score(ctx, k, 2.0 * l.funding_period_days / DAYS_PER_YEAR),
                )
            }
            LegKind::Perp => {
                let px = ctx.state.spot;
                (
                    px,
                    Greeks { price: px, delta: 1.0, gamma: 0.0, vega: 0.0, theta: 0.0, rho: 0.0 },
                    None,
                    Some(ctx.state.funding_rate * px / DAYS_PER_YEAR),
                    99.0,
                )
            }
            LegKind::Spot => {
                let px = ctx.state.spot;
                (
                    px,
                    Greeks { price: px, delta: 1.0, gamma: 0.0, vega: 0.0, theta: 0.0, rho: 0.0 },
                    None,
                    None,
                    100.0,
                )
            }
        };
        let cost = l.side.sign() * l.qty * price * size;
        out.push(ResolvedLeg {
            input: l.clone(),
            analytics: LegAnalytics {
                id: i,
                kind: l.kind,
                side: l.side,
                qty: l.qty,
                strike: l.strike,
                expiry_days: l.expiry_days,
                funding_period_days: if l.kind == LegKind::PerpOption {
                    Some(l.funding_period_days)
                } else {
                    None
                },
                iv,
                price,
                delta: greeks.delta,
                gamma: greeks.gamma,
                vega: greeks.vega,
                theta: greeks.theta,
                rho: greeks.rho,
                cost,
                liquidity,
                funding_per_day,
            },
            kind: l.kind,
            side_sign: l.side.sign(),
            qty: l.qty,
            strike: l.strike,
            expiry_years: l.expiry_days.map(|d| d / DAYS_PER_YEAR),
            funding_period_years: if l.kind == LegKind::PerpOption {
                Some(l.funding_period_days / DAYS_PER_YEAR)
            } else {
                None
            },
            option_type: match l.kind {
                LegKind::Call | LegKind::PerpOption => {
                    if l.kind == LegKind::Call {
                        Some(OptionType::Call)
                    } else if l.strike.map(|s| s >= ctx.state.spot).unwrap_or(true) {
                        Some(OptionType::Call)
                    } else {
                        Some(OptionType::Put)
                    }
                }
                LegKind::Put => Some(OptionType::Put),
                _ => None,
            },
        });
    }
    out
}

fn liquidity_score(_ctx: &MarketCtx, strike: f64, t_years: f64) -> f64 {
    // Heuristic exit-liquidity model: penalise deep wings and far dates.
    let m = (strike / 100_000_f64).ln().abs() * 0.0; // placeholder replaced below
    let _ = m;
    let wing = ((strike / 1.0).ln()).abs() * 0.0;
    let _ = wing;
    let t_score = 1.0 / (1.0 + (t_years * 365.0 / 45.0).powi(2)).sqrt();
    let base = 92.0 * t_score + 8.0;
    base.clamp(12.0, 99.0)
}

/// Heuristic exit-liquidity model using moneyness + tenor.
fn liquidity_moneyness(ctx: &MarketCtx, strike: f64, t_years: f64) -> f64 {
    let m = (strike / ctx.state.spot).ln().abs();
    let m_pen = (m * 260.0).min(60.0);
    let t = t_years * 365.0;
    let t_pen = ((t - 30.0).abs() / 6.0).min(28.0);
    (97.0 - m_pen - t_pen).clamp(8.0, 99.0)
}

/// Main analysis entry point used by the API layer.
pub fn analyze(legs: &[ValidLeg], size: f64, ctx: &MarketCtx) -> AnalyzeResponse {
    let started = std::time::Instant::now();
    let resolved = resolve_legs(legs, size, ctx);
    let spot = ctx.state.spot;

    // Horizon: max dated expiry; default 30d for all-perpetual strategies.
    let horizon_days = resolved
        .iter()
        .filter_map(|l| l.input.expiry_days)
        .fold(0.0_f64, f64::max)
        .max(if resolved.iter().all(|l| l.input.expiry_days.is_none()) {
            30.0
        } else {
            0.0
        });
    let horizon_years = (horizon_days / DAYS_PER_YEAR).max(1.0 / 365.0);

    // Price axis: +/- 3.2 sigma around spot over the horizon (min +/-8%).
    let sigma_h = ctx.atm_iv(horizon_years) * horizon_years.sqrt();
    let half_span = (spot * 3.2 * sigma_h).max(spot * 0.08);
    let lo = (spot - half_span).max(spot * 0.05);
    let hi = spot + half_span;
    let n_points = 121usize;
    let spot_axis: Vec<f64> = (0..n_points)
        .map(|i| lo + (hi - lo) * (i as f64) / ((n_points - 1) as f64))
        .collect();

    // Net premium (positive = debit).
    let net_premium: f64 = resolved
        .iter()
        .map(|l| l.side_sign * l.qty * l.analytics.price * size)
        .sum();

    // Curves.
    let mut pnl_expiry = Vec::with_capacity(n_points);
    let mut pnl_now = Vec::with_capacity(n_points);
    let mut pnl_t25 = Vec::with_capacity(n_points);
    let mut pnl_t50 = Vec::with_capacity(n_points);
    let mut pnl_t75 = Vec::with_capacity(n_points);
    for &s in spot_axis.iter() {
        let mut e = 0.0;
        let mut now = 0.0;
        let mut t25 = 0.0;
        let mut t50 = 0.0;
        let mut t75 = 0.0;
        for l in resolved.iter() {
            let scale = l.qty * size;
            e += scale * leg_horizon_pnl(l, s, horizon_years, 0.0, ctx);
            now += scale * leg_pnl(l, s, 0.0, 0.0, ctx);
            t25 += scale * leg_pnl(l, s, horizon_years * 0.25, 0.0, ctx);
            t50 += scale * leg_pnl(l, s, horizon_years * 0.50, 0.0, ctx);
            t75 += scale * leg_pnl(l, s, horizon_years * 0.75, 0.0, ctx);
        }
        pnl_expiry.push(e);
        pnl_now.push(now);
        pnl_t25.push(t25);
        pnl_t50.push(t50);
        pnl_t75.push(t75);
    }

    // Breakevens on the expiry curve (sign changes).
    let mut breakevens = Vec::new();
    for i in 0..n_points - 1 {
        let a = pnl_expiry[i];
        let b = pnl_expiry[i + 1];
        if a == 0.0 {
            breakevens.push(spot_axis[i]);
        } else if a * b < 0.0 {
            let x = spot_axis[i] + (spot_axis[i + 1] - spot_axis[i]) * (-a) / (b - a);
            breakevens.push(x);
        }
    }
    breakevens.dedup_by(|a, b| (*a - *b).abs() < spot * 0.001);

    // Extremes on expiry curve, extrapolating linear tails.
    let (max_profit, max_loss) = extremes(&pnl_expiry, &spot_axis, &resolved, horizon_years, ctx);

    // POP under lognormal at the horizon with ATM IV.
    let sig = ctx.atm_iv(horizon_years);
    let ln_std = sig * horizon_years.sqrt();
    let pop = probability_of_profit(&pnl_expiry, &spot_axis, spot, ln_std);

    // Expected value: integrate P&L against the lognormal density.
    let expected_value = expected_value(&pnl_expiry, &spot_axis, spot, ln_std);

    // Aggregate Greeks.
    let (mut delta, mut gamma, mut vega, mut theta, mut rho) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for l in resolved.iter() {
        let scale = l.side_sign * l.qty * size;
        delta += scale * l.analytics.delta;
        gamma += scale * l.analytics.gamma;
        vega += scale * l.analytics.vega;
        theta += scale * l.analytics.theta;
        rho += scale * l.analytics.rho;
    }

    // Liquidity: weighted min across legs.
    let liquidity = resolved
        .iter()
        .map(|l| liquidity_moneyness(ctx, l.strike.unwrap_or(spot), l.expiry_years.unwrap_or(horizon_years)))
        .fold(f64::INFINITY, f64::min)
        .min(99.0);

    // Carry budget if any everlasting/perp legs exist.
    let carry = build_carry(&resolved, size, ctx);

    // Scenario matrix: instantaneous revaluation.
    let spot_shocks: Vec<f64> = vec![-0.30, -0.20, -0.10, -0.05, 0.0, 0.05, 0.10, 0.20, 0.30];
    let iv_shocks: Vec<f64> = vec![-0.40, -0.20, 0.0, 0.20, 0.40, 0.80];
    let mut matrix = Vec::with_capacity(iv_shocks.len());
    for &ivs in iv_shocks.iter() {
        let mut row = Vec::with_capacity(spot_shocks.len());
        for &ss in spot_shocks.iter() {
            let s2 = spot * (1.0 + ss);
            let mut pnl = 0.0;
            for l in resolved.iter() {
                let scale = l.qty * size;
                let v = leg_value(l, s2, 0.0, ivs, ctx);
                pnl += scale * l.side_sign * (v - l.analytics.price);
            }
            row.push(pnl);
        }
        matrix.push(row);
    }

    // Margin estimate: worst instantaneous scenario loss + buffer.
    let worst = matrix
        .iter()
        .flat_map(|r| r.iter().copied())
        .fold(f64::NEG_INFINITY, f64::max)
        .min(0.0);
    let margin = (-worst * 1.10 + net_premium.max(0.0)).max(net_premium.max(0.0)).max(1.0);

    let risk_reward = match (max_profit.kind, max_loss.kind) {
        ("value", "value") if max_loss.value.map(|v| v > 0.0).unwrap_or(false) => {
            max_profit.value.map(|p| p / max_loss.value.unwrap())
        }
        _ => None,
    };

    let quote_seed = format!(
        "{}-{}-{}",
        ctx.underlying,
        resolved.len(),
        (net_premium * 1e4).round() as i64
    );

    AnalyzeResponse {
        underlying: ctx.underlying.clone(),
        spot,
        atm_iv_30d: ctx.atm_iv(30.0 / DAYS_PER_YEAR),
        size,
        legs: resolved.iter().map(|l| l.analytics.clone()).collect(),
        curves: vec![
            CurvePayload { label: "expiry", pnl: pnl_expiry },
            CurvePayload { label: "now", pnl: pnl_now },
            CurvePayload { label: "t25", pnl: pnl_t25 },
            CurvePayload { label: "t50", pnl: pnl_t50 },
            CurvePayload { label: "t75", pnl: pnl_t75 },
        ],
        spot_axis,
        net_premium,
        net_credit: net_premium < 0.0,
        max_profit,
        max_loss,
        breakevens,
        pop,
        expected_value,
        risk_reward,
        greeks: GreeksPayload {
            delta,
            gamma,
            vega,
            theta,
            rho,
            delta_exposure_usd: delta * spot,
        },
        carry,
        liquidity,
        margin_estimate: margin,
        scenario_matrix: ScenarioMatrix { spot_shocks, iv_shocks, pnl: matrix },
        diagnostics: Diagnostics {
            engine: "volos-rust",
            compute_us: started.elapsed().as_micros(),
            server_version: env!("CARGO_PKG_VERSION"),
            notes: Vec::new(),
        },
        quote_id: quote_seed,
    }
}

/// Max profit / max loss from curve tails. Linear tail extrapolation: for
/// strategies whose expiry P&L is unbounded (short calls etc.) report
/// "unlimited".
fn extremes(
    pnl: &[f64],
    axis: &[f64],
    legs: &[ResolvedLeg],
    horizon_years: f64,
    ctx: &MarketCtx,
) -> (Extreme, Extreme) {
    // Tail slopes of expiry P&L: sum of leg payoffs' slopes.
    let mut left_slope = 0.0;
    let mut right_slope = 0.0;
    for l in legs {
        let scale = l.side_sign * l.qty;
        match l.kind {
            LegKind::Call => {
                right_slope += scale;
            }
            LegKind::Put => {
                left_slope -= scale;
            }
            LegKind::PerpOption => {
                let ot = l.option_type.unwrap();
                // Everlasting tails behave like their option type.
                match ot {
                    OptionType::Call => right_slope += scale * 0.85,
                    OptionType::Put => left_slope -= scale * 0.85,
                }
            }
            LegKind::Perp | LegKind::Spot => {
                left_slope += scale;
                right_slope += scale;
            }
        }
    }
    let _ = horizon_years;
    let _ = ctx;
    // Interior extremes.
    let mut max_v = f64::NEG_INFINITY;
    let mut min_v = f64::INFINITY;
    let mut max_at = None;
    let mut min_at = None;
    for (i, &v) in pnl.iter().enumerate() {
        if v > max_v {
            max_v = v;
            max_at = Some(axis[i]);
        }
        if v < min_v {
            min_v = v;
            min_at = Some(axis[i]);
        }
    }
    let eps = 1e-9;
    let max_profit = if right_slope > eps || left_slope < -eps {
        Extreme { kind: "unlimited", value: None, at_price: None }
    } else {
        Extreme { kind: "value", value: Some(max_v), at_price: max_at }
    };
    let max_loss = if right_slope < -eps || left_slope > eps {
        // Downside unbounded only for net-long-perp/spot or short puts tails.
        if left_slope > eps {
            Extreme { kind: "unlimited", value: None, at_price: None }
        } else {
            Extreme { kind: "value", value: Some(min_v), at_price: min_at }
        }
    } else {
        Extreme { kind: "value", value: Some(min_v), at_price: min_at }
    };
    (max_profit, max_loss)
}

/// POP: probability mass of the profitable region under lognormal(S_T).
fn probability_of_profit(pnl: &[f64], axis: &[f64], s0: f64, ln_std: f64) -> f64 {
    let mu = s0.ln(); // driftless
    let mut prob = 0.0;
    let n = pnl.len();
    for i in 0..n - 1 {
        let a = pnl[i];
        let b = pnl[i + 1];
        if a <= 0.0 && b <= 0.0 {
            continue;
        }
        let (x0, x1) = (axis[i], axis[i + 1]);
        // Segment profitability via clipping to [x0, x1].
        let (lo, hi) = if a == 0.0 && b == 0.0 {
            continue;
        } else if a >= 0.0 && b >= 0.0 {
            (x0, x1)
        } else {
            let cross = x0 + (x1 - x0) * (-a) / (b - a);
            if a >= 0.0 { (x0, cross) } else { (cross, x1) }
        };
        if hi <= lo {
            continue;
        }
        let z_hi = if ln_std <= 0.0 { 0.0 } else { (hi.ln() - mu) / ln_std };
        let z_lo = if ln_std <= 0.0 { 0.0 } else { (lo.ln() - mu) / ln_std };
        prob += norm_cdf(z_hi) - norm_cdf(z_lo);
    }
    // Handle open tails.
    if pnl[0] > 0.0 {
        prob += norm_cdf((axis[0].ln() - mu) / ln_std);
    }
    if pnl[n - 1] > 0.0 {
        prob += 1.0 - norm_cdf((axis[n - 1].ln() - mu) / ln_std);
    }
    prob.clamp(0.0, 1.0)
}

/// E[P&L] under the lognormal density (trapezoid with lognormal weights).
fn expected_value(pnl: &[f64], axis: &[f64], s0: f64, ln_std: f64) -> f64 {
    let mu = s0.ln();
    let n = pnl.len();
    let mut dens = Vec::with_capacity(n);
    for &x in axis.iter() {
        let z = (x.ln() - mu) / ln_std;
        dens.push((-(z * z) / 2.0).exp() / (x * ln_std * crate::norm::SQRT_2PI));
    }
    let mut ev = 0.0;
    for i in 0..n - 1 {
        let dx = axis[i + 1] - axis[i];
        ev += 0.5 * (pnl[i] * dens[i] + pnl[i + 1] * dens[i + 1]) * dx;
    }
    // Tails: assume P&L linear outside the grid, integrate analytically-ish.
    let left_ext = (pnl[1] - pnl[0]) / (axis[1] - axis[0]);
    let left_dens = dens[0];
    let left_p = norm_cdf((axis[0].ln() - mu) / ln_std);
    let dx = 1.0; // characteristic tail width approximation
    ev += pnl[0] * left_p - left_ext * dx * left_dens * dx;
    let right_ext = (pnl[n - 1] - pnl[n - 2]) / (axis[n - 1] - axis[n - 2]);
    let right_p = 1.0 - norm_cdf((axis[n - 1].ln() - mu) / ln_std);
    ev += pnl[n - 1] * right_p + right_ext * dx * dens[n - 1] * dx;
    ev
}

/// Carry budget panel data for everlasting/perp legs.
fn build_carry(legs: &[ResolvedLeg], size: f64, ctx: &MarketCtx) -> Option<CarryBudget> {
    let mut daily = 0.0;
    let mut any = false;
    for l in legs.iter() {
        let scale = l.side_sign * l.qty * size;
        match l.kind {
            LegKind::PerpOption => {
                any = true;
                let ot = l.option_type.unwrap();
                let k = l.strike.unwrap();
                let fp_days = l.input.funding_period_days;
                let surface = |t: f64| ctx.iv_at(k, t);
                let mark = everlasting_greeks(ctx.state.spot, k, fp_days, surface(0.0), ctx.cfg.rate, ot, &surface).price;
                let f = everlasting_funding(mark, ctx.state.spot, k, ot);
                // Longs pay positive funding; daily = f * (1 day / fp_days).
                daily -= scale * f * (1.0 / fp_days);
            }
            LegKind::Perp => {
                any = true;
                // Long perp pays positive funding when rate > 0.
                daily -= scale * ctx.state.funding_rate * l.analytics.price / DAYS_PER_YEAR;
            }
            _ => {}
        }
    }
    if !any {
        return None;
    }
    let scenarios = vec![
        CarryScenario { label: "Low volatility (IV −25%)".into(), carry_7d: daily * 7.0 * 0.72 },
        CarryScenario { label: "Current conditions".into(), carry_7d: daily * 7.0 },
        CarryScenario { label: "IV +25%".into(), carry_7d: daily * 7.0 * 1.38 },
        CarryScenario { label: "High utilization stress".into(), carry_7d: daily * 7.0 * 1.92 },
    ];
    Some(CarryBudget {
        daily_carry: daily,
        weekly_carry: daily * 7.0,
        monthly_carry: daily * 30.0,
        scenarios,
        hard_budget: None,
        budget_remaining: None,
    })
}

/// Liquidity for a leg (moneyness-aware wrapper used by resolve).
pub fn leg_liquidity(ctx: &MarketCtx, strike: f64, t_years: f64) -> f64 {
    liquidity_moneyness(ctx, strike, t_years)
}

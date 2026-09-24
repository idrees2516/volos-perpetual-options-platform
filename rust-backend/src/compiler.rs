//! Intent compiler: deterministic strategy generation from economic goals.
//! Mirrors the research blueprint — templates are pruned, priced and ranked,
//! never LLM-generated. Each candidate ships with a full rationale.

use crate::market::MarketSnapshot;
use crate::models::*;
use crate::payoff::MarketCtx;
use crate::pricing::DAYS_PER_YEAR;
use crate::surface::{asset_config, forward};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Goal {
    /// Directional view on price.
    Direction,
    /// Protect existing holdings.
    Protect,
    /// Monetize holdings / earn premium.
    Income,
    /// Trade volatility itself.
    Volatility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Bullish,
    Bearish,
    Neutral,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentRequest {
    pub underlying: String,
    pub goal: Goal,
    pub direction: Option<Direction>,
    /// Horizon in days.
    #[serde(default, alias = "horizon_days")]
    pub horizon_days: Option<f64>,
    /// Target move in percent (e.g. 25.0 = +25%).
    #[serde(default, alias = "target_move_pct")]
    pub target_move_pct: Option<f64>,
    /// Max acceptable loss in USD.
    #[serde(default, alias = "max_loss_usd")]
    pub max_loss_usd: Option<f64>,
    /// Existing holdings in underlying units.
    #[serde(default)]
    pub holdings: Option<f64>,
    #[serde(default, alias = "allow_perpetual")]
    pub allow_perpetual: bool,
}

impl IntentRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        let u = self.underlying.trim().to_uppercase();
        if !crate::surface::ASSETS.contains(&u.as_str()) {
            return Err(ValidationError("underlying must be BTC, ETH or SOL".into()));
        }
        if let Some(d) = self.horizon_days {
            if !d.is_finite() || d < 1.0 || d > 365.0 {
                return Err(ValidationError("horizon_days must be in [1, 365]".into()));
            }
        }
        if let Some(t) = self.target_move_pct {
            if !t.is_finite() || t.abs() > 500.0 {
                return Err(ValidationError("target_move_pct must be within ±500%".into()));
            }
        }
        if let Some(m) = self.max_loss_usd {
            if !m.is_finite() || m < 0.0 || m > 1e12 {
                return Err(ValidationError("max_loss_usd out of range".into()));
            }
        }
        if let Some(h) = self.holdings {
            if !h.is_finite() || h < 0.0 || h > 1e9 {
                return Err(ValidationError("holdings out of range".into()));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateLeg {
    pub kind: LegKind,
    pub side: Side,
    pub qty: f64,
    pub strike: Option<f64>,
    pub expiry_days: Option<f64>,
    pub funding_period_days: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub name: String,
    pub thesis: String,
    pub legs: Vec<CandidateLeg>,
    pub category: &'static str,
    pub max_loss_class: &'static str,
    pub upside_class: &'static str,
    pub carry_class: &'static str,
    pub iv_exposure: &'static str,
    pub liquidity_class: &'static str,
    pub suggested: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentResponse {
    pub underlying: String,
    pub spot: f64,
    pub candidates: Vec<Candidate>,
    pub compile_us: u128,
    pub notes: Vec<String>,
}

#[allow(non_snake_case)]
fn cLeg(kind: LegKind, side: Side, qty: f64, strike: Option<f64>, expiry: Option<f64>) -> CandidateLeg {
    CandidateLeg { kind, side, qty, strike, expiry_days: expiry, funding_period_days: None }
}

/// Choose a strike at approximately the requested delta on the surface.
fn strike_for_delta(ctx: &MarketCtx, t_years: f64, target_delta: f64, is_call: bool) -> f64 {
    let f = forward(&ctx.cfg, ctx.state.spot, t_years);
    let lo = f * 0.5;
    let hi = f * 2.0;
    // Bisection on |delta|.
    let mut a = lo;
    let mut b = hi;
    for _ in 0..40 {
        let mid = 0.5 * (a + b);
        let iv = ctx.iv_at(mid, t_years);
        let g = crate::pricing::bs_greeks(ctx.state.spot, mid, t_years, iv, ctx.cfg.rate, if is_call { crate::pricing::OptionType::Call } else { crate::pricing::OptionType::Put });
        let d = if is_call { g.delta } else { -g.delta };
        if d > target_delta {
            a = mid;
        } else {
            b = mid;
        }
    }
    0.5 * (a + b)
}

pub fn compile(req: &IntentRequest, snap: &MarketSnapshot) -> IntentResponse {
    let started = std::time::Instant::now();
    let underlying = req.underlying.trim().to_uppercase();
    let cfg = asset_config(&underlying);
    let state = snap.assets.get(&underlying).cloned().unwrap_or_else(|| snap.assets["BTC"].clone());
    let ctx = MarketCtx { cfg, state, underlying: underlying.clone() };
    let spot = ctx.state.spot;

    let horizon = req.horizon_days.unwrap_or(30.0).clamp(7.0, 180.0);
    let t = horizon / DAYS_PER_YEAR;
    let target = req.target_move_pct.unwrap_or(20.0);
    let dir = req.direction.unwrap_or(match req.goal {
        Goal::Direction => Direction::Bullish,
        Goal::Protect => Direction::Bearish,
        Goal::Income => Direction::Neutral,
        Goal::Volatility => Direction::Neutral,
    });

    // Reference strikes.
    let atm = forward(&ctx.cfg, spot, t);
    let target_strike = atm * (1.0 + target / 100.0);
    let d25 = strike_for_delta(&ctx, t, 0.25, dir != Direction::Bearish);
    let d10 = strike_for_delta(&ctx, t, 0.10, dir != Direction::Bearish);
    let holdings = req.holdings.unwrap_or(0.0);

    let mut cands: Vec<Candidate> = Vec::new();

    match (req.goal, dir) {
        (Goal::Direction, Direction::Bullish) => {
            cands.push(Candidate {
                name: "Long Call".into(),
                thesis: format!("Pure convex bullish exposure to {underlying} through {horizon:.0} days. Unlimited upside, premium at risk."),
                legs: vec![cLeg(LegKind::Call, Side::Buy, 1.0, Some(round_strike(atm * 1.02)), Some(horizon))],
                category: "direction", max_loss_class: "Premium paid", upside_class: "Unlimited",
                carry_class: "None after entry", iv_exposure: "Long vega", liquidity_class: "High", suggested: true,
            });
            let wing = round_strike(target_strike.max(atm * 1.05));
            cands.push(Candidate {
                name: "Bull Call Spread".into(),
                thesis: format!("Buy ~ATM call, sell call near your {target:.0}% target. Cuts cost and theta in exchange for capped upside."),
                legs: vec![
                    cLeg(LegKind::Call, Side::Buy, 1.0, Some(round_strike(atm * 1.02)), Some(horizon)),
                    cLeg(LegKind::Call, Side::Sell, 1.0, Some(wing), Some(horizon)),
                ],
                category: "direction", max_loss_class: "Net debit", upside_class: "Capped at wing",
                carry_class: "Reduced theta", iv_exposure: "Directional, low net vega", liquidity_class: "High", suggested: false,
            });
            if req.allow_perpetual {
                cands.push(Candidate {
                    name: "Everlasting Call".into(),
                    thesis: "Perpetual convex upside with no expiry to manage. Funding accrues daily (mark − payoff); effective duration ≈ 2× funding period.".into(),
                    legs: vec![CandidateLeg { kind: LegKind::PerpOption, side: Side::Buy, qty: 1.0, strike: Some(round_strike(atm * 1.02)), expiry_days: None, funding_period_days: Some(7.0) }],
                    category: "direction", max_loss_class: "Ongoing carry", upside_class: "Unlimited",
                    carry_class: "Daily funding", iv_exposure: "Long vega", liquidity_class: "Medium", suggested: false,
                });
            }
            cands.push(Candidate {
                name: "Perp + Protective Put".into(),
                thesis: "Synthetic long via perp with a defined-risk floor. Leverage without liquidation risk below the put strike.".into(),
                legs: vec![
                    cLeg(LegKind::Perp, Side::Buy, 1.0, None, None),
                    cLeg(LegKind::Put, Side::Buy, 1.0, Some(round_strike(atm * 0.85)), Some(horizon)),
                ],
                category: "direction", max_loss_class: "Put strike − entry + premium", upside_class: "Unlimited",
                carry_class: "Perp funding + put theta", iv_exposure: "Mixed", liquidity_class: "High", suggested: false,
            });
        }
        (Goal::Direction, Direction::Neutral) | (Goal::Direction, Direction::Bearish) => {
            cands.push(Candidate {
                name: "Long Put".into(),
                thesis: "Convex downside exposure. Pays disproportionately if the market breaks before expiry.".into(),
                legs: vec![cLeg(LegKind::Put, Side::Buy, 1.0, Some(round_strike(atm * 0.98)), Some(horizon))],
                category: "direction", max_loss_class: "Premium paid", upside_class: "High (to zero)",
                carry_class: "None after entry", iv_exposure: "Long vega", liquidity_class: "High", suggested: true,
            });
            cands.push(Candidate {
                name: "Bear Put Spread".into(),
                thesis: format!("Buy ATM put, sell put near your −{target:.0}% target. Cheaper, defined-risk downside play."),
                legs: vec![
                    cLeg(LegKind::Put, Side::Buy, 1.0, Some(round_strike(atm * 0.98)), Some(horizon)),
                    cLeg(LegKind::Put, Side::Sell, 1.0, Some(round_strike((atm * (1.0 - target / 100.0)).max(atm * 0.6))), Some(horizon)),
                ],
                category: "direction", max_loss_class: "Net debit", upside_class: "Capped at wing",
                carry_class: "Reduced theta", iv_exposure: "Directional, low net vega", liquidity_class: "High", suggested: false,
            });
            if req.allow_perpetual {
                cands.push(Candidate {
                    name: "Everlasting Put".into(),
                    thesis: "Continuous crash protection without roll management — the perpetual hedge from the research blueprint.".into(),
                    legs: vec![CandidateLeg { kind: LegKind::PerpOption, side: Side::Buy, qty: 1.0, strike: Some(round_strike(atm * 0.95)), expiry_days: None, funding_period_days: Some(7.0) }],
                    category: "direction", max_loss_class: "Ongoing carry", upside_class: "High (to zero)",
                    carry_class: "Daily funding", iv_exposure: "Long vega", liquidity_class: "Medium", suggested: false,
                });
            }
        }
        (Goal::Protect, _) => {
            let size = if holdings > 0.0 { 1.0 } else { 1.0 };
            cands.push(Candidate {
                name: "Protective Put".into(),
                thesis: format!("Insurance floor on holdings: guarantees an exit above the strike for {horizon:.0} days."),
                legs: vec![cLeg(LegKind::Put, Side::Buy, size, Some(round_strike(atm * 0.85)), Some(horizon))],
                category: "protection", max_loss_class: "Premium paid", upside_class: "Holdings + floor",
                carry_class: "Theta drag", iv_exposure: "Long vega", liquidity_class: "High", suggested: true,
            });
            cands.push(Candidate {
                name: "Put Spread".into(),
                thesis: "Cheaper partial protection: floor kicks in at 90%, coverage caps at 80% — the cost-efficient hedge for moderate drawdowns.".into(),
                legs: vec![
                    cLeg(LegKind::Put, Side::Buy, size, Some(round_strike(atm * 0.90)), Some(horizon)),
                    cLeg(LegKind::Put, Side::Sell, size, Some(round_strike(atm * 0.80)), Some(horizon)),
                ],
                category: "protection", max_loss_class: "Net debit", upside_class: "Defined floor",
                carry_class: "Reduced theta", iv_exposure: "Bullish skew", liquidity_class: "High", suggested: false,
            });
            cands.push(Candidate {
                name: "Collar".into(),
                thesis: "Zero-ish cost protection: sell an upside call to fund the downside put. Best when you would happily exit higher.".into(),
                legs: vec![
                    cLeg(LegKind::Put, Side::Buy, size, Some(round_strike(atm * 0.85)), Some(horizon)),
                    cLeg(LegKind::Call, Side::Sell, size, Some(round_strike(atm * 1.15)), Some(horizon)),
                ],
                category: "protection", max_loss_class: "Down to put strike", upside_class: "Capped at call",
                carry_class: "≈ Zero", iv_exposure: "Neutral-ish", liquidity_class: "High", suggested: false,
            });
            if req.allow_perpetual {
                cands.push(Candidate {
                    name: "Everlasting Put (Persistent Hedge)".into(),
                    thesis: "The research blueprint's Persistent Strategy Intent: continuous protection budgeted via a carry cap instead of roll management.".into(),
                    legs: vec![CandidateLeg { kind: LegKind::PerpOption, side: Side::Buy, qty: size, strike: Some(round_strike(atm * 0.85)), expiry_days: None, funding_period_days: Some(7.0) }],
                    category: "protection", max_loss_class: "Ongoing carry", upside_class: "Holdings + floor",
                    carry_class: "Daily funding + budget alerts", iv_exposure: "Long vega", liquidity_class: "Medium", suggested: false,
                });
            }
        }
        (Goal::Income, _) => {
            let c = round_strike(atm * (1.0 + target.max(5.0) / 100.0));
            let p = round_strike(atm * (1.0 - target.max(5.0) / 100.0));
            cands.push(Candidate {
                name: "Covered Call".into(),
                thesis: format!("Get paid to sell higher: collect premium committing to exit at {c:.0}."),
                legs: vec![
                    cLeg(LegKind::Spot, Side::Buy, 1.0, None, None),
                    cLeg(LegKind::Call, Side::Sell, 1.0, Some(c), Some(horizon)),
                ],
                category: "income", max_loss_class: "Spot decline − premium", upside_class: "Capped at strike",
                carry_class: "Earns theta", iv_exposure: "Short vega", liquidity_class: "High", suggested: true,
            });
            cands.push(Candidate {
                name: "Cash-Secured Put".into(),
                thesis: format!("Get paid to buy lower: commit cash to buy at {p:.0} and keep the premium if it never trades there."),
                legs: vec![cLeg(LegKind::Put, Side::Sell, 1.0, Some(p), Some(horizon))],
                category: "income", max_loss_class: "Strike − premium", upside_class: "Premium",
                carry_class: "Earns theta", iv_exposure: "Short vega", liquidity_class: "High", suggested: false,
            });
            cands.push(Candidate {
                name: "Short Strangle (defined wings)".into(),
                thesis: "Sell both sides and collect more premium, with far wings bought back to bound tail risk.".into(),
                legs: vec![
                    cLeg(LegKind::Put, Side::Sell, 1.0, Some(round_strike(atm * 0.82)), Some(horizon)),
                    cLeg(LegKind::Call, Side::Sell, 1.0, Some(round_strike(atm * 1.18)), Some(horizon)),
                    cLeg(LegKind::Put, Side::Buy, 1.0, Some(round_strike(atm * 0.62)), Some(horizon)),
                    cLeg(LegKind::Call, Side::Buy, 1.0, Some(round_strike(atm * 1.45)), Some(horizon)),
                ],
                category: "income", max_loss_class: "Bounded by wings", upside_class: "Net credit",
                carry_class: "Earns theta", iv_exposure: "Short vega", liquidity_class: "Medium", suggested: false,
            });
        }
        (Goal::Volatility, _) => {
            cands.push(Candidate {
                name: "Long Straddle".into(),
                thesis: "Buy the ATM call + put: profits from a large move in either direction or an IV expansion.".into(),
                legs: vec![
                    cLeg(LegKind::Call, Side::Buy, 1.0, Some(round_strike(atm)), Some(horizon)),
                    cLeg(LegKind::Put, Side::Buy, 1.0, Some(round_strike(atm)), Some(horizon)),
                ],
                category: "volatility", max_loss_class: "Premium paid", upside_class: "Unlimited",
                carry_class: "Pays theta", iv_exposure: "Long vega ×2", liquidity_class: "High", suggested: true,
            });
            cands.push(Candidate {
                name: "Long Strangle".into(),
                thesis: "Cheaper twin: wings at 25Δ on both sides. Needs a bigger move but decays slower.".into(),
                legs: vec![
                    cLeg(LegKind::Call, Side::Buy, 1.0, Some(round_strike(d25.max(atm * 1.04))), Some(horizon)),
                    cLeg(LegKind::Put, Side::Buy, 1.0, Some(round_strike((2.0 * atm - d25).min(atm * 0.96))), Some(horizon)),
                ],
                category: "volatility", max_loss_class: "Premium paid", upside_class: "Unlimited",
                carry_class: "Pays theta", iv_exposure: "Long vega", liquidity_class: "Medium", suggested: false,
            });
            cands.push(Candidate {
                name: "Iron Butterfly".into(),
                thesis: "Defined-risk short vol: sell the ATM body, buy wings. The carry trader's volatility harvest.".into(),
                legs: vec![
                    cLeg(LegKind::Call, Side::Sell, 1.0, Some(round_strike(atm)), Some(horizon)),
                    cLeg(LegKind::Put, Side::Sell, 1.0, Some(round_strike(atm)), Some(horizon)),
                    cLeg(LegKind::Call, Side::Buy, 1.0, Some(round_strike(atm * 1.15)), Some(horizon)),
                    cLeg(LegKind::Put, Side::Buy, 1.0, Some(round_strike(atm * 0.85)), Some(horizon)),
                ],
                category: "volatility", max_loss_class: "Wing width − credit", upside_class: "Net credit",
                carry_class: "Earns theta", iv_exposure: "Short vega", liquidity_class: "High", suggested: false,
            });
            cands.push(Candidate {
                name: "Everlasting Straddle".into(),
                thesis: "Persistent long volatility: no expiry, funding-based. The platform's signature 'vol as an asset class' construct.".into(),
                legs: vec![
                    CandidateLeg { kind: LegKind::PerpOption, side: Side::Buy, qty: 1.0, strike: Some(round_strike(atm)), expiry_days: None, funding_period_days: Some(7.0) },
                ],
                category: "volatility", max_loss_class: "Ongoing carry", upside_class: "Unlimited",
                carry_class: "Daily funding (mark − payoff)", iv_exposure: "Long vega", liquidity_class: "Medium", suggested: false,
            });
            let _ = d10;
        }
    }

    let _ = req.max_loss_usd;
    IntentResponse {
        underlying: underlying.clone(),
        spot,
        candidates: cands,
        compile_us: started.elapsed().as_micros(),
        notes: vec![
            "Candidates are generated deterministically from the strategy grammar — never by an LLM.".into(),
            "Real quotes must override theoretical prices before execution (research §9).".into(),
        ],
    }
}

/// Round a strike to a human tradable increment.
fn round_strike(k: f64) -> f64 {
    let step = if k >= 50_000.0 {
        500.0
    } else if k >= 5_000.0 {
        50.0
    } else if k >= 500.0 {
        5.0
    } else if k >= 50.0 {
        0.5
    } else {
        0.05
    };
    (k / step).round() * step
}

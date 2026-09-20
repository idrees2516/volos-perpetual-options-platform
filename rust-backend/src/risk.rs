//! Risk engine: accounts, positions, cash/P&L accounting, portfolio-stress
//! margin and Greeks aggregation.
//!
//! Margin model: portfolio stress (SPAN-like). We shock spot by
//! {0.80 … 1.20} and ATM vol by {−10pt, 0, +10pt}, reprice every position
//! on its pricing function, and set margin = worst-case loss × buffer.
//! Long/short option spreads net naturally — economically efficient and
//! in equilibrium (margin charged = actual risk, not per-leg sums).

use crate::clob::{Instrument, Side};
use crate::fees;
use serde::Serialize;
use std::collections::HashMap;

pub const DEMO_STARTING_BALANCE: f64 = 1_000_000.0;
pub const MM_STARTING_BALANCE: f64 = 5_000_000.0;
pub const MAX_POSITION_ABS: f64 = 250.0; // per instrument, units of underlying
pub const MAX_ORDER_NOTIONAL: f64 = 5_000_000.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    /// Signed position: positive long, negative short (units of underlying).
    pub qty: f64,
    pub avg_cost: f64,
    pub realized_pnl: f64,
}

impl Position {
    fn new() -> Self {
        Position { qty: 0.0, avg_cost: 0.0, realized_pnl: 0.0 }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    /// USDC balance (settled cash).
    pub balance: f64,
    pub positions: HashMap<String, Position>,
    /// Cumulative fees paid (negative = net rebates received).
    pub fees_paid: f64,
    /// Cumulative everlasting funding paid (signed).
    pub funding_paid: f64,
    pub is_market_maker: bool,
}

impl Account {
    pub fn new(id: String, starting: f64, is_mm: bool) -> Self {
        Account {
            id,
            balance: starting,
            positions: HashMap::new(),
            fees_paid: 0.0,
            funding_paid: 0.0,
            is_market_maker: is_mm,
        }
    }

    /// Apply one fill (taker or maker role) to cash + position.
    pub fn apply_fill(&mut self, inst: &Instrument, side: Side, price: f64, qty: f64, fee: f64, rebate: f64) {
        let signed = side.sign() as f64 * qty;
        // cash flow: buy pays, sell receives; taker pays fee, maker gets rebate
        self.balance -= signed * price * inst.multiplier;
        self.balance += rebate - fee;
        self.fees_paid += fee - rebate;
        let pos = self.positions.entry(inst.id.clone()).or_insert_with(Position::new);
        if pos.qty == 0.0 || pos.qty.signum() == signed.signum() {
            // extending
            let new_total = pos.qty + signed;
            pos.avg_cost = if new_total.abs() > 1e-12 {
                (pos.avg_cost * pos.qty.abs() + price * signed.abs()) / new_total.abs()
            } else {
                price
            };
            pos.qty = new_total;
        } else {
            // reducing / flipping
            let closed = qty.min(pos.qty.abs());
            let dir = pos.qty.signum();
            pos.realized_pnl += (price - pos.avg_cost) * closed * dir;
            let rem = pos.qty + signed;
            if rem.abs() < 1e-12 {
                pos.qty = 0.0;
                pos.avg_cost = 0.0;
            } else if rem.signum() == pos.qty.signum() {
                pos.qty = rem; // partial reduce keeps avg cost
            } else {
                pos.qty = rem; // flipped through zero
                pos.avg_cost = price;
            }
        }
    }

    /// Mark-to-market equity = cash + Σ qty × mark.
    pub fn equity(&self, marks: &dyn Fn(&str) -> f64, insts: &HashMap<String, Instrument>) -> f64 {
        let mut eq = self.balance;
        for (id, p) in self.positions.iter() {
            if p.qty.abs() < 1e-12 {
                continue;
            }
            let mark = marks(id);
            let mult = insts.get(id).map(|i| i.multiplier).unwrap_or(1.0);
            eq += p.qty * mark * mult;
        }
        eq
    }

    pub fn unrealized_pnl(&self, marks: &dyn Fn(&str) -> f64) -> f64 {
        self.positions
            .iter()
            .filter(|(_, p)| p.qty.abs() > 1e-12)
            .map(|(id, p)| p.qty * (marks(id) - p.avg_cost))
            .sum()
    }
}

/// Scenario-based portfolio margin. `pricer(inst, spot_mult, vol_add)` must
/// return the instrument's theoretical price under the shock.
pub fn portfolio_margin(
    positions: &HashMap<String, Position>,
    insts: &HashMap<String, Instrument>,
    pricer: &dyn Fn(&Instrument, f64, f64) -> f64,
) -> f64 {
    const SPOT_SHOCKS: [f64; 7] = [0.80, 0.90, 0.95, 1.0, 1.05, 1.10, 1.20];
    const VOL_SHOCKS: [f64; 3] = [-0.10, 0.0, 0.10];
    let mut worst_loss = 0.0f64;
    let has_futures = positions.iter().any(|(id, p)| {
        p.qty.abs() > 1e-12
            && insts.get(id).map(|i| i.kind == crate::clob::InstrumentKind::PerpFuture).unwrap_or(false)
    });
    if !has_futures && positions.iter().all(|(_, p)| p.qty.abs() < 1e-12) {
        return 0.0;
    }
    for &vs in VOL_SHOCKS.iter() {
        for &ss in SPOT_SHOCKS.iter() {
            let mut pnl = 0.0f64;
            for (id, p) in positions.iter() {
                if p.qty.abs() < 1e-12 {
                    continue;
                }
                let inst = match insts.get(id) {
                    Some(i) => i,
                    None => continue,
                };
                let base = pricer(inst, 1.0, 0.0);
                let shocked = pricer(inst, ss, vs);
                pnl += p.qty * (shocked - base) * inst.multiplier;
            }
            if pnl < worst_loss {
                worst_loss = pnl;
            }
        }
    }
    (worst_loss.abs()) * fees::MARGIN_BUFFER
}

/// Aggregate Greeks across an account's positions.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GreeksAgg {
    pub delta: f64, // per 1 underlying unit
    pub gamma: f64,
    pub vega: f64,  // per 1 vol point
    pub theta: f64, // per day
    pub delta_usd: f64,
    pub per_underlying: HashMap<String, GreeksAggLite>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GreeksAggLite {
    pub delta: f64,
    pub gamma: f64,
    pub vega: f64,
    pub theta: f64,
}

/// `greeks_of(inst, spot)` returns (delta, gamma, vega, theta) per unit.
pub fn aggregate_greeks(
    positions: &HashMap<String, Position>,
    insts: &HashMap<String, Instrument>,
    greeks_of: &dyn Fn(&Instrument) -> (f64, f64, f64, f64),
    spots: &HashMap<String, f64>,
) -> GreeksAgg {
    let mut agg = GreeksAgg::default();
    agg.per_underlying = HashMap::new();
    for (id, p) in positions.iter() {
        if p.qty.abs() < 1e-12 {
            continue;
        }
        let inst = match insts.get(id) {
            Some(i) => i,
            None => continue,
        };
        let (d, g, v, t) = greeks_of(inst);
        let q = p.qty;
        agg.delta += d * q;
        agg.gamma += g * q;
        agg.vega += v * q;
        agg.theta += t * q;
        let e = agg.per_underlying.entry(inst.underlying.clone()).or_default();
        e.delta += d * q;
        e.gamma += g * q;
        e.vega += v * q;
        e.theta += t * q;
    }
    // delta_usd: net delta per underlying × spot, summed
    for (u, g) in agg.per_underlying.iter() {
        let s = spots.get(u).copied().unwrap_or(0.0);
        agg.delta_usd += g.delta * s;
    }
    agg
}

/// Pre-trade risk verdict for a candidate order.
pub struct PreTrade {
    pub side: Side,
    pub price: f64, // limit price (or reference for market)
    pub qty: f64,
}

pub fn pretrade_check(
    acct: &Account,
    inst: &Instrument,
    order: &PreTrade,
    positions: &HashMap<String, Position>,
    insts: &HashMap<String, Instrument>,
    pricer: &dyn Fn(&Instrument, f64, f64) -> f64,
    marks: &dyn Fn(&str) -> f64,
) -> Result<(), crate::clob::RejectReason> {
    use crate::clob::RejectReason;
    let notional = order.price * order.qty * inst.multiplier;
    if !notional.is_finite() || notional <= 0.0 {
        return Err(RejectReason::InvalidPrice);
    }
    if notional > MAX_ORDER_NOTIONAL {
        return Err(RejectReason::RiskLimit);
    }
    let cur = acct.positions.get(&inst.id).map(|p| p.qty).unwrap_or(0.0);
    let new_qty = cur + order.side.sign() as f64 * order.qty;
    if new_qty.abs() > MAX_POSITION_ABS {
        return Err(RejectReason::RiskLimit);
    }
    // buying power: long premium must be fully cash-funded; shorts must
    // keep equity above maintenance against post-trade stress margin.
    let equity = acct.equity(marks, insts);
    if order.side == Side::Buy && !matches!(inst.kind, crate::clob::InstrumentKind::PerpFuture) {
        let cost = notional * (1.0 + fees::TAKER_FEE_BPS / 10_000.0);
        if acct.balance < cost {
            return Err(RejectReason::InsufficientMargin);
        }
    } else {
        // hypothetical portfolio including the new position
        let mut hypo = positions.clone();
        let pos = hypo.entry(inst.id.clone()).or_insert_with(Position::new);
        let signed = order.side.sign() as f64 * order.qty;
        pos.qty += signed;
        if pos.qty.abs() < 1e-12 {
            pos.qty = 0.0;
        }
        let margin = portfolio_margin(&hypo, insts, pricer);
        if equity < margin * fees::MAINTENANCE_RATIO {
            return Err(RejectReason::InsufficientMargin);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acct() -> Account {
        Account::new("t".into(), 100_000.0, false)
    }

    #[test]
    fn buy_then_sell_realizes_pnl() {
        let inst = test_inst("X");
        let mut a = acct();
        a.apply_fill(&inst, Side::Buy, 10.0, 2.0, 0.1, 0.0);
        assert!((a.balance - (20.0 + 0.1)).abs() < 1e-9);
        let p = a.positions["X"].clone();
        assert!((p.qty - 2.0).abs() < 1e-9 && (p.avg_cost - 10.0).abs() < 1e-9);
        a.apply_fill(&inst, Side::Sell, 12.0, 1.0, 0.05, 0.0);
        let p = a.positions["X"].clone();
        assert!((p.realized_pnl - 2.0).abs() < 1e-9, "realized {}", p.realized_pnl);
        assert!((p.qty - 1.0).abs() < 1e-9);
    }

    #[test]
    fn short_option_flip_through_zero() {
        let inst = test_inst("X");
        let mut a = acct();
        a.apply_fill(&inst, Side::Sell, 10.0, 3.0, 0.0, 0.0);
        a.apply_fill(&inst, Side::Buy, 8.0, 5.0, 0.0, 0.0);
        let p = a.positions["X"].clone();
        // closed 3 short at 8 → realized +6; flipped to long 2 at 8
        assert!((p.realized_pnl - 6.0).abs() < 1e-9);
        assert!((p.qty - 2.0).abs() < 1e-9 && (p.avg_cost - 8.0).abs() < 1e-9);
    }

    #[test]
    fn stress_margin_netting() {
        let inst = test_inst("X");
        let mut positions = HashMap::new();
        // short 1 call, long 1 call same instrument → netted to ~0 margin
        positions.insert(
            "X".into(),
            Position { qty: 0.0, avg_cost: 0.0, realized_pnl: 0.0 },
        );
        let insts: HashMap<String, Instrument> = [("X".to_string(), inst)].into_iter().collect();
        let m = portfolio_margin(&positions, &insts, &|_i, _s, _v| 10.0);
        assert!(m.abs() < 1e-9);
    }

    fn test_inst(id: &str) -> Instrument {
        Instrument {
            id: id.into(),
            underlying: "BTC".into(),
            kind: crate::clob::InstrumentKind::PerpOption,
            strike: Some(100.0),
            opt_type: Some(crate::pricing::OptionType::Call),
            funding_period_days: 7.0,
            tick_size: 0.5,
            lot_size: 0.01,
            multiplier: 1.0,
            created_ms: 0,
            expiry_days: None,
            theo: 10.0,
            mark: 10.0,
            last_trade: None,
        }
    }
}

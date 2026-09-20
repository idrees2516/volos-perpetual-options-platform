//! Composite trading engine: instruments + books + accounts + OMS +
//! market-maker desks + flow simulation + stops + funding + strategy RFQ +
//! multi-venue routing. One Mutex<T> shared across handlers (identical to
//! the analytics engine pattern; contention is negligible at this scale).

use crate::clob::*;
use crate::market::{MarketSnapshot, SharedSim};
use crate::models::ValidLeg;
use crate::payoff::{self, MarketCtx};
use crate::pricing::{self, OptionType};
use crate::rfqs::{RfqBook, RfqExecution};
use crate::risk::{self, Account, GreeksAgg, Position, PreTrade};
use crate::surface::{asset_config, forward, ASSETS};
use crate::venues::{FeedMode, RouteChild, RoutePlan, SharedLive, VenuePool};
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use serde::Serialize;
use std::collections::HashMap;

/// Quote-skew per unit of MM inventory (fraction of theo).
pub const MM_INV_SKEW: f64 = 0.008;
pub const MM_LEVELS: usize = 5;
pub const MAX_SUBSCRIBED: usize = 12;

pub struct MmDesk {
    pub name: String,
    pub edge_bps: f64,
    pub base_qty: f64,
}

pub const MM_DESKS: [(&str, f64, f64); 3] = [
    ("mm-atlas", 6.0, 0.9),
    ("mm-borealis", 9.0, 0.6),
    ("mm-cirrus", 13.0, 0.45),
];

// ---------------------------------------------------------------- events

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    /// Top-of-book + theo for every instrument (1 Hz heartbeat).
    L1All { data: Vec<L1Dto> },
    Trades { data: Vec<Trade> },
    Orders { data: Vec<Order> },
    Account { id: String },
    Rfq { id: u64 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct L1Dto {
    pub instrument: String,
    pub underlying: String,
    pub kind: InstrumentKind,
    pub strike: Option<f64>,
    pub opt_type: Option<String>,
    pub theo: f64,
    pub mark: f64,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub bid_qty: Option<f64>,
    pub ask_qty: Option<f64>,
    pub last: Option<f64>,
}

// ------------------------------------------------------- ledger (FillSink)

struct Ledger<'a> {
    accounts: &'a mut HashMap<String, Account>,
    orders: Option<&'a mut HashMap<u64, Order>>,
    events: &'a mut Vec<EngineEvent>,
    trades_out: &'a mut Vec<Trade>,
}

impl<'a> FillSink for Ledger<'a> {
    fn on_fill(&mut self, fill: &Fill, inst: &Instrument) {
        let t = &fill.trade;
        // accounts: taker pays fee; maker receives rebate
        if let Some(a) = self.accounts.get_mut(&t.taker) {
            let rebate = if a.is_market_maker { t.maker_rebate } else { 0.0 };
            a.apply_fill(inst, t.taker_side, t.price, t.qty, t.taker_fee, rebate);
        }
        if t.maker != t.taker {
            if let Some(a) = self.accounts.get_mut(&t.maker) {
                let fee = if a.is_market_maker { 0.0 } else { t.taker_fee };
                let rebate = if a.is_market_maker { t.maker_rebate } else { 0.0 };
                a.apply_fill(inst, t.taker_side.opp(), t.price, t.qty, fee, rebate);
            }
        }
        // OMS record update for the maker (user orders only)
        if let Some(orders) = self.orders.as_deref_mut() {
            if let Some(m) = orders.get_mut(&fill.maker_id) {
                if m.status == OrderStatus::Open || m.status == OrderStatus::Partially {
                    let lots = inst.lots(t.qty);
                    let new_filled = m.filled_lots + lots;
                    let new_notional = m.filled_notional_ticks + inst.ticks(t.price) * lots;
                    m.filled_lots = new_filled;
                    m.filled_notional_ticks = new_notional;
                    m.avg_fill_price = (new_notional as f64 / new_filled.max(1) as f64) * inst.tick_size;
                    m.status = if new_filled >= m.lots { OrderStatus::Filled } else { OrderStatus::Partially };
                    m.update_ms = now_ms();
                    let ev = m.clone();
                    self.events.push(EngineEvent::Orders { data: vec![ev] });
                }
            }
        }
        self.trades_out.push(t.clone());
    }
}

// ------------------------------------------------------------- the engine

pub struct TradingEngine {
    pub insts: HashMap<String, Instrument>,
    pub engines: HashMap<String, MatchingEngine>,
    pub accounts: HashMap<String, Account>,
    /// OMS records for user accounts (mm/flow orders bypass the OMS).
    pub orders: HashMap<u64, Order>,
    pub orders_by_account: HashMap<String, Vec<u64>>,
    pub next_order_record_id: u64,
    /// Pending stop orders (parked, waiting for trigger).
    pub stops: HashMap<u64, Order>,
    /// MM resting order ids per instrument (for sweeping on requote).
    pub mm_orders: HashMap<String, Vec<u64>>,
    pub rfq: RfqBook,
    pub venues: VenuePool,
    pub flow_rng: SmallRng,
    pub last_funding_ms: u64,
    /// Per-underlying spot from the latest market snapshot.
    pub spots: HashMap<String, f64>,
    /// Per-underlying ATM vol shift from the latest market snapshot.
    pub vol_shifts: HashMap<String, f64>,
    pub started_ms: u64,
}

impl TradingEngine {
    pub fn new(spot_seeds: &HashMap<String, f64>) -> Self {
        let mut insts = HashMap::new();
        let started = now_ms();
        for a in ASSETS.iter() {
            let spot = spot_seeds.get(*a).copied().unwrap_or(100.0);
            let (tick, lot) = if spot >= 1_000.0 { (0.5, 0.01) } else { (0.01, 0.1) };
            // perp future
            let perp = Instrument {
                id: format!("{a}-PERP"),
                underlying: a.to_string(),
                kind: InstrumentKind::PerpFuture,
                strike: None,
                opt_type: None,
                funding_period_days: 0.0,
                expiry_days: None,
                created_ms: started,
                tick_size: if spot >= 1_000.0 { 1.0 } else { 0.05 },
                lot_size: lot,
                multiplier: 1.0,
                theo: spot,
                mark: spot,
                last_trade: None,
            };
            insts.insert(perp.id.clone(), perp);
            // perp option grid: ±10% around spot, 5 strikes
            let step = if spot >= 50_000.0 {
                2_500.0
            } else if spot >= 2_000.0 {
                100.0
            } else {
                5.0
            };
            let atm = (spot / step).round() * step;
            for i in -2i32..=2 {
                let k = atm + i as f64 * step;
                for (ot, letter) in [(OptionType::Call, "C"), (OptionType::Put, "P")] {
                    let id = format!("{a}-{:?}-{letter}-PERP", k as i64);
                    let inst = Instrument {
                        id: id.clone(),
                        underlying: a.to_string(),
                        kind: InstrumentKind::PerpOption,
                        strike: Some(k),
                        opt_type: Some(ot),
                        funding_period_days: 7.0,
                        expiry_days: None,
                        created_ms: started,
                        tick_size: tick,
                        lot_size: lot,
                        multiplier: 1.0,
                        theo: 0.0,
                        mark: 0.0,
                        last_trade: None,
                    };
                    insts.insert(id, inst);
                }
            }
        }
        let engines: HashMap<String, MatchingEngine> = insts
            .iter()
            .map(|(id, i)| (id.clone(), MatchingEngine::new(i.clone())))
            .collect();
        let mut accounts = HashMap::new();
        for (name, _, _) in MM_DESKS.iter() {
            accounts.insert(name.to_string(), Account::new(name.to_string(), risk::MM_STARTING_BALANCE, true));
        }
        for f in ["flow-1", "flow-2"] {
            accounts.insert(f.to_string(), Account::new(f.to_string(), 250_000.0, true));
        }
        TradingEngine {
            insts,
            engines,
            accounts,
            orders: HashMap::new(),
            orders_by_account: HashMap::new(),
            next_order_record_id: 1,
            stops: HashMap::new(),
            mm_orders: HashMap::new(),
            rfq: RfqBook::new(),
            venues: VenuePool::new(),
            flow_rng: SmallRng::from_entropy(),
            last_funding_ms: started,
            spots: spot_seeds.clone(),
            vol_shifts: HashMap::new(),
            started_ms: started,
        }
    }

    // ------------------------------------------------------ pricing core

    pub fn ctx_of(snapshot: &MarketSnapshot, underlying: &str) -> Option<MarketCtx> {
        let st = snapshot.assets.get(underlying)?.clone();
        Some(MarketCtx {
            cfg: asset_config(underlying),
            state: st,
            underlying: underlying.to_string(),
        })
    }

    /// Theoretical price of an instrument under (spot_mult, vol_add) shocks.
    pub fn price_inst(&self, inst: &Instrument, snapshot: &MarketSnapshot, spot_mult: f64, vol_add: f64) -> f64 {
        let ctx = match Self::ctx_of(snapshot, &inst.underlying) {
            Some(c) => c,
            None => return inst.mark,
        };
        Self::price_inst_ctx(inst, &ctx, spot_mult, vol_add)
    }

    pub fn price_inst_ctx(inst: &Instrument, ctx: &MarketCtx, spot_mult: f64, vol_add: f64) -> f64 {
        let s = ctx.state.spot * spot_mult;
        match inst.kind {
            InstrumentKind::PerpFuture => s,
            InstrumentKind::PerpOption => {
                let k = inst.strike.unwrap_or(s);
                let ot = inst.opt_type.unwrap_or(OptionType::Call);
                let fp = inst.funding_period_days.max(0.25);
                let g = pricing::everlasting_greeks(s, k, fp, 0.5, ctx.cfg.rate, ot, &|t| {
                    (ctx.iv_at(k, t) + vol_add).max(0.01)
                });
                g.price
            }
            InstrumentKind::DatedOption => {
                let k = inst.strike.unwrap_or(s);
                let ot = inst.opt_type.unwrap_or(OptionType::Call);
                let elapsed_days = (now_ms().saturating_sub(inst.created_ms)) as f64 / 86_400_000.0;
                let rem = (inst.expiry_days.unwrap_or(30.0) - elapsed_days).max(0.5);
                let t = rem / pricing::DAYS_PER_YEAR;
                pricing::bs_price(s, k, t, (ctx.iv_at(k, t) + vol_add).max(0.01), ctx.cfg.rate, ot)
            }
        }
    }

    pub fn greeks_inst(inst: &Instrument, ctx: &MarketCtx) -> (f64, f64, f64, f64) {
        let s = ctx.state.spot;
        match inst.kind {
            InstrumentKind::PerpFuture => (1.0, 0.0, 0.0, 0.0),
            InstrumentKind::PerpOption => {
                let k = inst.strike.unwrap_or(s);
                let ot = inst.opt_type.unwrap_or(OptionType::Call);
                let fp = inst.funding_period_days.max(0.25);
                let g = pricing::everlasting_greeks(s, k, fp, 0.5, ctx.cfg.rate, ot, &|t| ctx.iv_at(k, t).max(0.01));
                (g.delta, g.gamma, g.vega, g.theta)
            }
            InstrumentKind::DatedOption => {
                let k = inst.strike.unwrap_or(s);
                let ot = inst.opt_type.unwrap_or(OptionType::Call);
                let elapsed_days = (now_ms().saturating_sub(inst.created_ms)) as f64 / 86_400_000.0;
                let rem = (inst.expiry_days.unwrap_or(30.0) - elapsed_days).max(0.5);
                let t = rem / pricing::DAYS_PER_YEAR;
                let g = pricing::bs_greeks(s, k, t, ctx.iv_at(k, t).max(0.01), ctx.cfg.rate, ot);
                (g.delta, g.gamma, g.vega, g.theta)
            }
        }
    }

    /// Register (or fetch) the tradable instrument backing an RFQ leg.
    pub fn ensure_leg_instrument(&mut self, underlying: &str, leg: &ValidLeg, snapshot: &MarketSnapshot) -> String {
        let ctx = Self::ctx_of(snapshot, underlying);
        let (tick, lot) = {
            let spot = self.spots.get(underlying).copied().unwrap_or(100.0);
            if spot >= 1_000.0 { (0.5, 0.01) } else { (0.01, 0.1) }
        };
        let spot_now = self.spots.get(underlying).copied().unwrap_or(100.0);
        let id = match leg.kind {
            crate::models::LegKind::Perp | crate::models::LegKind::Spot => format!("{underlying}-PERP"),
            crate::models::LegKind::PerpOption => {
                let ot = perp_option_type(leg.strike.unwrap_or(spot_now), spot_now);
                format!(
                    "{underlying}-{:?}-{}-PERP",
                    leg.strike.unwrap_or(0.0) as i64,
                    if ot == OptionType::Put { "P" } else { "C" }
                )
            }
            crate::models::LegKind::Call | crate::models::LegKind::Put => {
                format!(
                    "{underlying}-{:?}-{}-{}D",
                    leg.strike.unwrap_or(0.0) as i64,
                    if matches!(leg.kind, crate::models::LegKind::Call) { "C" } else { "P" },
                    leg.expiry_days.unwrap_or(30.0)
                )
            }
        };
        if self.insts.contains_key(&id) {
            return id;
        }
        let kind = match leg.kind {
            crate::models::LegKind::Call | crate::models::LegKind::Put => InstrumentKind::DatedOption,
            _ => InstrumentKind::PerpOption,
        };
        let ot = match leg.kind {
            crate::models::LegKind::Put => Some(OptionType::Put),
            crate::models::LegKind::Call => Some(OptionType::Call),
            crate::models::LegKind::PerpOption => Some(perp_option_type(leg.strike.unwrap_or(spot_now), spot_now)),
            _ => None,
        };
        let inst = Instrument {
            id: id.clone(),
            underlying: underlying.to_string(),
            kind,
            strike: leg.strike,
            opt_type: ot,
            funding_period_days: leg.funding_period_days,
            expiry_days: leg.expiry_days,
            created_ms: now_ms(),
            tick_size: tick,
            lot_size: lot,
            multiplier: 1.0,
            theo: 0.0,
            mark: 0.0,
            last_trade: None,
        };
        let theo = ctx
            .map(|c| Self::price_inst_ctx(&inst, &c, 1.0, 0.0))
            .unwrap_or(0.0);
        let mut inst = inst;
        inst.theo = theo;
        inst.mark = theo;
        self.insts.insert(id.clone(), inst.clone());
        self.engines.insert(id.clone(), MatchingEngine::new(inst));
        id
    }

    // ------------------------------------------------------ snapshots

    pub fn l1_all(&self) -> Vec<L1Dto> {
        let mut out = Vec::with_capacity(self.insts.len());
        for (id, eng) in self.engines.iter() {
            let inst = &eng.inst;
            let (bb, ba) = (eng.book.best_bid(), eng.book.best_ask());
            let bq = bb.map(|t| inst.qty_of(eng.book.bids.levels[&t].iter().map(|o| o.lots).sum::<u64>()));
            let aq = ba.map(|t| inst.qty_of(eng.book.asks.levels[&t].iter().map(|o| o.lots).sum::<u64>()));
            out.push(L1Dto {
                instrument: id.clone(),
                underlying: inst.underlying.clone(),
                kind: inst.kind,
                strike: inst.strike,
                opt_type: inst.opt_type.map(|o| match o {
                    OptionType::Call => "C".to_string(),
                    OptionType::Put => "P".to_string(),
                }),
                theo: inst.theo,
                mark: inst.mark,
                bid: bb.map(|t| inst.price_of(t)),
                ask: ba.map(|t| inst.price_of(t)),
                bid_qty: bq,
                ask_qty: aq,
                last: inst.last_trade,
            });
        }
        out.sort_by(|a, b| a.instrument.cmp(&b.instrument));
        out
    }

    pub fn marks(&self) -> HashMap<String, f64> {
        self.insts.iter().map(|(k, i)| (k.clone(), i.mark)).collect()
    }
}

// helper: infer call/put for perp-option legs (same convention as payoff.rs)
pub fn perp_option_type(strike: f64, spot: f64) -> OptionType {
    if strike >= spot {
        OptionType::Call
    } else {
        OptionType::Put
    }
}

// ------------------------------------------------------------ tick + OMS

impl TradingEngine {
    /// One trading-loop beat (1 Hz): refresh theos, requote MMs, run flow
    /// bots, trigger stops, accrue funding, poll RFQ lifecycle.
    pub fn tick(&mut self, snapshot: &MarketSnapshot, live: &crate::venues::LiveState, events: &mut Vec<EngineEvent>) {
        self.spots = snapshot.assets.iter().map(|(k, v)| (k.clone(), v.spot)).collect();
        self.vol_shifts = snapshot.assets.iter().map(|(k, v)| (k.clone(), v.vol_shift)).collect();
        let now = now_ms();

        // ---- 1. theos
        let mut theos: HashMap<String, f64> = HashMap::with_capacity(self.insts.len());
        for (id, inst) in self.insts.iter_mut() {
            let ctx = Self::ctx_of(snapshot, &inst.underlying);
            let theo = ctx
                .as_ref()
                .map(|c| Self::price_inst_ctx(inst, c, 1.0, 0.0))
                .unwrap_or(inst.mark);
            inst.theo = theo;
            if inst.last_trade.is_none() {
                inst.mark = theo;
            }
            theos.insert(id.clone(), theo);
        }
        // sync engine copies
        for (id, eng) in self.engines.iter_mut() {
            if let Some(inst) = self.insts.get(id) {
                eng.inst.theo = inst.theo;
                if eng.inst.last_trade.is_none() {
                    eng.inst.mark = inst.mark;
                }
            }
        }

        // ---- 2. external venue liquidity
        self.venues.refresh(&theos, live);

        // ---- 3. MM requote (cancel + repost around theo with inv skew)
        self.requote_mms(events);

        // ---- 4. flow bots hit the book
        self.run_flow_bots(events);

        // ---- 5. stop triggers
        self.check_stops(events);

        // ---- 6. funding accrual
        if now.saturating_sub(self.last_funding_ms) >= crate::fees::FUNDING_PERIOD_SECS * 1000 {
            self.last_funding_ms = now;
            self.accrue_funding(events);
        }

        // ---- 7. RFQ lifecycle
        let session_ids: Vec<u64> = self
            .rfq
            .sessions
            .iter()
            .filter(|(_, s)| s.state == crate::rfqs::RfqState::Quoting)
            .map(|(k, _)| *k)
            .collect();
        for id in session_ids {
            let (legs, size, under) = {
                let s = &self.rfq.sessions[&id];
                (s.legs.clone(), s.size, s.underlying.clone())
            };
            let ctx = Self::ctx_of(snapshot, &under);
            if let Some(c) = ctx {
                let analysis = payoff::analyze(&legs, size, &c);
                self.rfq.poll(id, now, analysis.net_premium);
                events.push(EngineEvent::Rfq { id });
            }
        }
        self.rfq.gc(now);

        // ---- 8. heartbeat event
        events.push(EngineEvent::L1All { data: self.l1_all() });
    }

    fn requote_mms(&mut self, events: &mut Vec<EngineEvent>) {
        let ids: Vec<String> = self.engines.keys().cloned().collect();
        for inst_id in ids {
            // sweep this instrument's MM orders
            let mm_ids: Vec<u64> = self.mm_orders.remove(&inst_id).unwrap_or_default();
            let (eng, accounts, orders) = (&mut self.engines, &mut self.accounts, &mut self.orders);
            if let Some(eng) = eng.get_mut(&inst_id) {
                for id in mm_ids.iter() {
                    if eng.book.cancel(*id, Side::Buy).is_none() {
                        eng.book.cancel(*id, Side::Sell);
                    }
                }
                // post fresh quotes per desk
                for (name, edge_bps, base_qty) in MM_DESKS.iter() {
                    let inst = eng.inst.clone();
                    let theo = inst.theo;
                    if !theo.is_finite() || theo <= 0.0 {
                        continue;
                    }
                    let inv = accounts
                        .get(*name)
                        .and_then(|a| a.positions.get(&inst_id))
                        .map(|p| p.qty)
                        .unwrap_or(0.0);
                    let skew = -inv * MM_INV_SKEW * theo;
                    let mut placed_ids = Vec::with_capacity(MM_LEVELS * 2);
                    for lvl in 0..MM_LEVELS {
                        let half = theo * (edge_bps + lvl as f64 * 3.5) / 10_000.0 + lvl as f64 * inst.tick_size * 2.0;
                        let qty = ((base_qty * (0.6 + 0.3 * lvl as f64)) / inst.lot_size).round().max(1.0) as u64;
                        let bid_px = eng.inst.ticks((theo - half + skew).max(inst.tick_size));
                        let ask_px = eng.inst.ticks(((theo + half + skew).max(inst.tick_size * 2.0)).max(0.0));
                        let mut trades = Vec::new();
                        {
                            let mut ledger = Ledger {
                                accounts: &mut *accounts,
                                orders: Some(&mut *orders),
                                events,
                                trades_out: &mut trades,
                            };
                            let out = eng.place(
                                PlaceRequest {
                                    account: name.to_string(),
                                    side: Side::Buy,
                                    kind: OrderKind::PostOnly,
                                    price_ticks: Some(bid_px),
                                    trigger_ticks: None,
                                    lots: qty,
                                    stp: StpPolicy::CancelNewest,
                                },
                                usize::MAX / 2,
                                Ok(()),
                                &mut ledger,
                            );
                            if out.order.status == OrderStatus::Open || out.order.status == OrderStatus::Partially {
                                placed_ids.push(out.order.id);
                            }
                        }
                        drain_trades(events, &mut trades);
                        let mut trades2 = Vec::new();
                        {
                            let mut ledger = Ledger {
                                accounts: &mut *accounts,
                                orders: Some(&mut *orders),
                                events,
                                trades_out: &mut trades2,
                            };
                            let out = eng.place(
                                PlaceRequest {
                                    account: name.to_string(),
                                    side: Side::Sell,
                                    kind: OrderKind::PostOnly,
                                    price_ticks: Some(ask_px),
                                    trigger_ticks: None,
                                    lots: qty,
                                    stp: StpPolicy::CancelNewest,
                                },
                                usize::MAX / 2,
                                Ok(()),
                                &mut ledger,
                            );
                            if out.order.status == OrderStatus::Open || out.order.status == OrderStatus::Partially {
                                placed_ids.push(out.order.id);
                            }
                        }
                        drain_trades(events, &mut trades2);
                    }
                    if !placed_ids.is_empty() {
                        self.mm_orders.entry(inst_id.clone()).or_default().extend(placed_ids);
                    }
                }
            }
        }
    }

    fn run_flow_bots(&mut self, events: &mut Vec<EngineEvent>) {
        // 1-2 marketable flow orders per tick across random instruments
        let n_bots = if self.flow_rng.gen::<f64>() < 0.55 { 1 } else if self.flow_rng.gen::<f64>() < 0.35 { 2 } else { 0 };
        let inst_ids: Vec<String> = self
            .insts
            .iter()
            .filter(|(_, i)| i.kind != InstrumentKind::DatedOption)
            .map(|(k, _)| k.clone())
            .collect();
        if inst_ids.is_empty() {
            return;
        }
        for _ in 0..n_bots {
            let pick = &inst_ids[self.flow_rng.gen_range(0..inst_ids.len())];
            let side = if self.flow_rng.gen::<f64>() < 0.5 { Side::Buy } else { Side::Sell };
            let flow_acct = if self.flow_rng.gen::<f64>() < 0.5 { "flow-1" } else { "flow-2" };
            let eng = match self.engines.get(pick) {
                Some(e) => e,
                None => continue,
            };
            let lot = eng.inst.lot_size;
            let qty = ((0.02 + self.flow_rng.gen::<f64>() * 0.12) / lot).round().max(1.0) as u64;
            let mut trades = Vec::new();
            {
                let (accounts, orders) = (&mut self.accounts, &mut self.orders);
                let eng = self.engines.get_mut(pick).unwrap();
                let mut ledger = Ledger {
                    accounts,
                    orders: Some(orders),
                    events,
                    trades_out: &mut trades,
                };
                eng.place(
                    PlaceRequest {
                        account: flow_acct.to_string(),
                        side,
                        kind: OrderKind::Market,
                        price_ticks: None,
                        trigger_ticks: None,
                        lots: qty,
                        stp: StpPolicy::CancelNewest,
                    },
                    usize::MAX / 2,
                    Ok(()),
                    &mut ledger,
                );
            }
            drain_trades(events, &mut trades);
            // sync mark back to insts
            if let Some(eng) = self.engines.get(pick) {
                if let Some(inst) = self.insts.get_mut(pick) {
                    inst.last_trade = eng.inst.last_trade;
                    inst.mark = eng.inst.mark;
                }
            }
        }
    }

    fn check_stops(&mut self, events: &mut Vec<EngineEvent>) {
        let triggered: Vec<(u64, String)> = {
            let mut out = Vec::new();
            for (id, o) in self.stops.iter() {
                if let Some(eng) = self.engines.get(&o.instrument) {
                    let mark = eng.inst.mark;
                    let hit = match o.side {
                        Side::Buy => o.trigger_ticks.map_or(false, |t| mark >= eng.inst.price_of(t)),
                        Side::Sell => o.trigger_ticks.map_or(false, |t| mark <= eng.inst.price_of(t)),
                    };
                    if hit {
                        out.push((*id, o.instrument.clone()));
                    }
                }
            }
            out
        };
        for (id, inst_id) in triggered {
            let order = match self.stops.remove(&id) {
                Some(o) => o,
                None => continue,
            };
            let mut trades = Vec::new();
            let out = {
                let (accounts, orders) = (&mut self.accounts, &mut self.orders);
                let eng = match self.engines.get_mut(&inst_id) {
                    Some(e) => e,
                    None => continue,
                };
                let mut ledger = Ledger {
                    accounts,
                    orders: Some(orders),
                    events,
                    trades_out: &mut trades,
                };
                eng.activate_stop(&order, &mut ledger)
            };
            drain_trades(events, &mut trades);
            // record the activated order for the owner
            if order.account_record() {
                let rec = out.order;
                if rec.status != OrderStatus::Rejected {
                    let is_pending = rec.status == OrderStatus::Pending;
                    let rec_id = rec.id;
                    self.record_order(rec.clone());
                    events.push(EngineEvent::Orders { data: vec![rec] });
                    if is_pending {
                        // stop-on-stop: keep parked
                        if let Some(p) = self.orders.get(&rec_id) {
                            self.stops.insert(rec_id, p.clone());
                        }
                    }
                }
            }
        }
    }

    fn accrue_funding(&mut self, events: &mut Vec<EngineEvent>) {
        let touched: Vec<String> = self
            .accounts
            .iter()
            .filter(|(_, a)| a.positions.values().any(|p| p.qty.abs() > 1e-9))
            .map(|(k, _)| k.clone())
            .collect();
        for acct in touched {
            let mut total = 0.0f64;
            let mut legs: Vec<(String, f64)> = Vec::new();
            {
                let a = self.accounts.get(&acct).unwrap();
                for (inst_id, p) in a.positions.iter() {
                    if p.qty.abs() < 1e-9 {
                        continue;
                    }
                    let inst = match self.insts.get(inst_id) {
                        Some(i) => i,
                        None => continue,
                    };
                    let spot = self.spots.get(&inst.underlying).copied().unwrap_or(0.0);
                    let amount = match inst.kind {
                        InstrumentKind::PerpOption => {
                            let ot = inst.opt_type.unwrap_or(OptionType::Call);
                            let intr = pricing::intrinsic(spot, inst.strike.unwrap_or(spot), ot);
                            inst.mark - intr
                        }
                        InstrumentKind::PerpFuture => inst.mark - spot,
                        InstrumentKind::DatedOption => 0.0,
                    };
                    legs.push((inst_id.clone(), p.qty * amount));
                }
            }
            for (_, v) in legs.iter() {
                total += v;
            }
            if let Some(a) = self.accounts.get_mut(&acct) {
                a.balance -= total; // longs pay shorts
                a.funding_paid += total;
            }
            events.push(EngineEvent::Account { id: acct });
        }
    }

    // ------------------------------------------------------- user actions

    fn ensure_account(&mut self, id: &str) -> Result<(), String> {
        if self.accounts.contains_key(id) {
            return Ok(());
        }
        let is_system = id.starts_with("mm-") || id.starts_with("flow-");
        if is_system {
            return Err("system account names are reserved".into());
        }
        self.accounts
            .insert(id.to_string(), Account::new(id.to_string(), risk::DEMO_STARTING_BALANCE, false));
        Ok(())
    }

    fn open_order_count(&self, account: &str) -> usize {
        self.orders_by_account
            .get(account)
            .map(|ids| {
                ids.iter()
                    .filter(|id| {
                        self.orders
                            .get(*id)
                            .map(|o| {
                                matches!(o.status, OrderStatus::Open | OrderStatus::Partially | OrderStatus::Pending)
                            })
                            .unwrap_or(false)
                    })
                    .count()
            })
            .unwrap_or(0)
    }

    fn record_order(&mut self, order: Order) {
        let id = order.id;
        let acct = order.account.clone();
        self.orders.insert(id, order);
        let list = self.orders_by_account.entry(acct).or_default();
        list.push(id);
        // cap history: drop oldest terminal records
        while list.len() > 500 {
            let oldest = list[0];
            let terminal = self
                .orders
                .get(&oldest)
                .map(|o| !matches!(o.status, OrderStatus::Open | OrderStatus::Partially | OrderStatus::Pending))
                .unwrap_or(true);
            if terminal {
                list.remove(0);
                self.orders.remove(&oldest);
            } else {
                break;
            }
        }
    }

    pub fn place_order(
        &mut self,
        account_id: &str,
        instrument: &str,
        side: Side,
        kind: OrderKind,
        price: Option<f64>,
        trigger: Option<f64>,
        qty: f64,
        stp: StpPolicy,
        events: &mut Vec<EngineEvent>,
    ) -> Result<Order, String> {
        self.ensure_account(account_id)?;
        let inst = self
            .insts
            .get(instrument)
            .cloned()
            .ok_or_else(|| format!("unknown instrument {instrument}"))?;
        if !qty.is_finite() || qty <= 0.0 || qty > risk::MAX_POSITION_ABS {
            return Err("qty must be in (0, 250]".into());
        }
        let lots = inst.lots(qty);
        if lots == 0 {
            return Err(format!("qty rounds to zero below lot size {}", inst.lot_size));
        }
        let price_ticks = match price {
            Some(p) if p.is_finite() && p > 0.0 => Some(inst.ticks(p)),
            Some(_) => return Err("price must be positive and finite".into()),
            None => {
                if matches!(kind, OrderKind::Limit | OrderKind::PostOnly | OrderKind::Ioc | OrderKind::Fok | OrderKind::StopLimit) {
                    return Err("price is required for limit-type orders".into());
                }
                None
            }
        };
        let trigger_ticks = match trigger {
            Some(t) if t.is_finite() && t > 0.0 => Some(inst.ticks(t)),
            Some(_) => return Err("trigger must be positive and finite".into()),
            None => None,
        };
        // pre-trade risk (users only) — computed with owned closures so no
        // borrows survive into the placement block
        let risk_ok = {
            let acct = &self.accounts[account_id];
            let ref_px = price.unwrap_or(inst.mark.max(inst.tick_size));
            let pt = PreTrade { side, price: ref_px, qty: inst.qty_of(lots) };
            let spots = self.spots.clone();
            let vol_shifts = self.vol_shifts.clone();
            let marks_map = self.marks();
            let insts = &self.insts;
            risk::pretrade_check(
                acct,
                &inst,
                &pt,
                &acct.positions,
                insts,
                &move |i: &Instrument, sm: f64, va: f64| {
                    let ctx = ctx_from(&spots, &vol_shifts, &i.underlying);
                    match ctx {
                        Some(c) => Self::price_inst_ctx(i, &c, sm, va),
                        None => i.mark,
                    }
                },
                &|id: &str| marks_map.get(id).copied().unwrap_or(0.0),
            )
        };
        let open = self.open_order_count(account_id);
        let mut trades = Vec::new();
        let out = {
            let eng = self
                .engines
                .get_mut(instrument)
                .ok_or_else(|| format!("no book for {instrument}"))?;
            let mut ledger = Ledger {
                accounts: &mut self.accounts,
                orders: Some(&mut self.orders),
                events,
                trades_out: &mut trades,
            };
            eng.place(
                PlaceRequest {
                    account: account_id.to_string(),
                    side,
                    kind,
                    price_ticks,
                    trigger_ticks,
                    lots,
                    stp,
                },
                open,
                risk_ok,
                &mut ledger,
            )
        };
        let had_fills = !trades.is_empty();
        drain_trades(events, &mut trades);
        // sync mark
        if let Some(eng) = self.engines.get(instrument) {
            if let Some(i) = self.insts.get_mut(instrument) {
                i.last_trade = eng.inst.last_trade;
                i.mark = eng.inst.mark;
            }
        }
        let mut order = out.order;
        if order.status != OrderStatus::Rejected {
            self.record_order(order.clone());
            if order.status == OrderStatus::Pending {
                self.stops.insert(order.id, order.clone());
            }
        }
        events.push(EngineEvent::Orders { data: vec![order.clone()] });
        if had_fills {
            events.push(EngineEvent::Account { id: account_id.to_string() });
        }
        order.account = account_id.to_string();
        Ok(order)
    }

    pub fn price_inst_now(&self, inst: &Instrument, spot_mult: f64, vol_add: f64) -> f64 {
        match self.last_snapshot_ctx(&inst.underlying) {
            Some(c) => Self::price_inst_ctx(inst, &c, spot_mult, vol_add),
            None => inst.mark,
        }
    }

    fn last_snapshot_ctx(&self, underlying: &str) -> Option<MarketCtx> {
        let spot = self.spots.get(underlying).copied()?;
        let vol_shift = self.vol_shifts.get(underlying).copied().unwrap_or(0.0);
        Some(MarketCtx {
            cfg: asset_config(underlying),
            state: crate::market::AssetState {
                spot,
                vol_shift,
                funding_rate: 0.08,
                change_24h: 0.0,
                open_interest: 0.0,
                volume_24h: 0.0,
            },
            underlying: underlying.to_string(),
        })
    }

    pub fn cancel_order(&mut self, account: &str, id: u64, events: &mut Vec<EngineEvent>) -> Result<Order, String> {
        let mut order = self
            .orders
            .get_mut(&id)
            .cloned()
            .ok_or_else(|| format!("order {id} not found"))?;
        if order.account != account {
            return Err("order belongs to another account".into());
        }
        if !matches!(order.status, OrderStatus::Open | OrderStatus::Partially | OrderStatus::Pending) {
            return Err(format!("order {} is already {}", id, status_str(order.status)));
        }
        if order.status == OrderStatus::Pending {
            self.stops.remove(&id);
        } else if let Some(eng) = self.engines.get_mut(&order.instrument) {
            if eng.book.cancel(id, order.side).is_none() {
                eng.book.cancel(id, order.side.opp());
            }
        }
        order.status = OrderStatus::Canceled;
        order.update_ms = now_ms();
        if let Some(o) = self.orders.get_mut(&id) {
            *o = order.clone();
        }
        events.push(EngineEvent::Orders { data: vec![order.clone()] });
        Ok(order)
    }

    pub fn cancel_all(&mut self, account: &str, instrument: Option<&str>, events: &mut Vec<EngineEvent>) -> usize {
        let ids: Vec<u64> = self
            .orders_by_account
            .get(account)
            .cloned()
            .unwrap_or_default();
        let mut n = 0;
        for id in ids {
            let ok = self
                .orders
                .get(&id)
                .map(|o| {
                    matches!(o.status, OrderStatus::Open | OrderStatus::Partially | OrderStatus::Pending)
                        && instrument.map_or(true, |i| o.instrument == i)
                })
                .unwrap_or(false);
            if ok && self.cancel_order(account, id, events).is_ok() {
                n += 1;
            }
        }
        n
    }

    pub fn amend_order(
        &mut self,
        account: &str,
        id: u64,
        price: Option<f64>,
        qty: Option<f64>,
        events: &mut Vec<EngineEvent>,
    ) -> Result<Order, String> {
        let order = self
            .orders
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("order {id} not found"))?;
        if order.account != account {
            return Err("order belongs to another account".into());
        }
        if order.status == OrderStatus::Pending {
            return Err("cannot amend a parked stop order; cancel and replace".into());
        }
        if !matches!(order.status, OrderStatus::Open | OrderStatus::Partially) {
            return Err(format!("order {} is not amendable ({})", id, status_str(order.status)));
        }
        let inst = self.insts.get(&order.instrument).cloned().ok_or("instrument missing")?;
        let new_ticks = match price {
            Some(p) if p.is_finite() && p > 0.0 => Some(inst.ticks(p)),
            Some(_) => return Err("price must be positive and finite".into()),
            None => None,
        };
        let new_lots = match qty {
            Some(q) if q.is_finite() && q > 0.0 => inst.lots(q),
            Some(_) => return Err("qty must be positive and finite".into()),
            None => order.remaining_lots(),
        };
        if new_lots == 0 {
            return Err("qty rounds to zero".into());
        }
        let mut trades = Vec::new();
        let result = {
            let eng = self
                .engines
                .get_mut(&order.instrument)
                .ok_or_else(|| "book missing".to_string())?;
            let mut ledger = Ledger {
                accounts: &mut self.accounts,
                orders: Some(&mut self.orders),
                events,
                trades_out: &mut trades,
            };
            eng.amend(&order, new_ticks, new_lots, &mut ledger)
        };
        drain_trades(events, &mut trades);
        match result {
            Ok(mut o) => {
                o.id = order.id;
                o.account = account.to_string();
                if matches!(o.status, OrderStatus::Open | OrderStatus::Partially) {
                    // engine may have re-keyed the resting order id — patch book
                    if let Some(eng) = self.engines.get_mut(&order.instrument) {
                        if let Some(t) = o.price_ticks {
                            let book = match o.side {
                                Side::Buy => &mut eng.book.bids,
                                Side::Sell => &mut eng.book.asks,
                            };
                            if let Some(q) = book.levels.get_mut(&t) {
                                for ro in q.iter_mut() {
                                    if ro.id == order.id || ro.seq == o.seq {
                                        ro.id = order.id;
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(rec) = self.orders.get_mut(&order.id) {
                    *rec = o.clone();
                }
                events.push(EngineEvent::Orders { data: vec![o.clone()] });
                if filled(&o) {
                    events.push(EngineEvent::Account { id: account.to_string() });
                }
                Ok(o)
            }
            Err(e) => Err(format!("{:?}", e)),
        }
    }
}

/// Build a lightweight pricing context from cached spots + vol shifts.
pub fn ctx_from(
    spots: &HashMap<String, f64>,
    vol_shifts: &HashMap<String, f64>,
    underlying: &str,
) -> Option<MarketCtx> {
    let spot = spots.get(underlying).copied()?;
    let vol_shift = vol_shifts.get(underlying).copied().unwrap_or(0.0);
    Some(MarketCtx {
        cfg: asset_config(underlying),
        state: crate::market::AssetState {
            spot,
            vol_shift,
            funding_rate: 0.08,
            change_24h: 0.0,
            open_interest: 0.0,
            volume_24h: 0.0,
        },
        underlying: underlying.to_string(),
    })
}

fn filled(o: &Order) -> bool {
    o.filled_lots > 0
}

fn status_str(s: OrderStatus) -> &'static str {
    match s {
        OrderStatus::Pending => "pending",
        OrderStatus::Open => "open",
        OrderStatus::Partially => "partially_filled",
        OrderStatus::Filled => "filled",
        OrderStatus::Canceled => "canceled",
        OrderStatus::Rejected => "rejected",
        OrderStatus::Expired => "expired",
    }
}

fn drain_trades(events: &mut Vec<EngineEvent>, trades: &mut Vec<Trade>) {
    if !trades.is_empty() {
        events.push(EngineEvent::Trades { data: trades.clone() });
        trades.clear();
    }
}

impl Order {
    /// Whether this order should be tracked in the user OMS (vs system flow).
    fn account_record(&self) -> bool {
        !(self.account.starts_with("mm-") || self.account.starts_with("flow-"))
    }
}

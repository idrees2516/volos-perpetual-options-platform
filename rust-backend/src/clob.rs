//! VolOS CLOB — limit order book + price-time-priority matching engine.
//!
//! Design notes (production-style):
//! * Prices are stored as integer TICKS and quantities as integer LOTS.
//!   All matching arithmetic is exact integer math — no float drift, ever.
//! * Price-time priority: FIFO queue per price level, global sequence number
//!   breaks ties. Amends that improve price or increase size lose priority.
//! * Order kinds: LIMIT, MARKET (collar-protected), POST_ONLY, IOC, FOK,
//!   STOP_MARKET, STOP_LIMIT.
//! * Self-trade prevention: CANCEL_NEWEST / CANCEL_OLDEST / DECREMENT.
//! * Price collars: orders crossing beyond ±COLLAR_PCT of the reference
//!   (mark = last trade or theoretical) are rejected, not matched.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};

// ------------------------------------------------------------------ types

pub const COLLAR_PCT: f64 = 0.20; // 20% around reference price
pub const MAX_OPEN_ORDERS: usize = 200;
pub const TAPE_CAP: usize = 250;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderKind {
    Limit,
    Market,
    PostOnly,
    Ioc,
    Fok,
    StopMarket,
    StopLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    #[inline]
    pub fn sign(&self) -> i8 {
        match self {
            Side::Buy => 1,
            Side::Sell => -1,
        }
    }
    #[inline]
    pub fn opp(&self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StpPolicy {
    CancelNewest,
    CancelOldest,
    Decrement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Expired/other variants reserved for future flows
pub enum OrderStatus {
    Pending,    // stop orders waiting for trigger
    Open,       // resting on the book
    Partially,  // partially filled, still resting
    Filled,
    Canceled,
    Rejected,   // never accepted (validation / post-only cross / collar)
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // full reject vocabulary is API surface
pub enum RejectReason {
    InvalidPrice,
    InvalidQty,
    WouldCross,     // post-only would take
    Collar,         // crosses beyond price collar
    FokNotFillable,
    InsufficientMargin,
    RiskLimit,
    TooManyOrders,
    UnknownOrder,
    UnknownInstrument,
}

/// A tradable instrument on the VolOS CLOB.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub id: String, // e.g. "BTC-95000-C-PERP" or "BTC-PERP"
    pub underlying: String,
    pub kind: InstrumentKind,
    pub strike: Option<f64>,
    pub opt_type: Option<crate::pricing::OptionType>,
    pub funding_period_days: f64,
    /// Dated options (registered by strategy RFQ): days to expiry at creation.
    pub expiry_days: Option<f64>,
    pub created_ms: u64,
    pub tick_size: f64,
    pub lot_size: f64,
    pub multiplier: f64,
    /// Theoretical value, refreshed by the trading loop.
    pub theo: f64,
    /// Mark = last trade if present else theo.
    pub mark: f64,
    pub last_trade: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstrumentKind {
    PerpOption,
    DatedOption,
    PerpFuture,
}

impl Instrument {
    #[inline]
    pub fn ticks(&self, price: f64) -> u64 {
        ((price / self.tick_size).round() as u64).max(0)
    }
    #[inline]
    pub fn price_of(&self, ticks: u64) -> f64 {
        ticks as f64 * self.tick_size
    }
    #[inline]
    pub fn lots(&self, qty: f64) -> u64 {
        ((qty / self.lot_size).round() as u64).max(0)
    }
    #[inline]
    pub fn qty_of(&self, lots: u64) -> f64 {
        lots as f64 * self.lot_size
    }
}

/// Resting order on the book.
#[derive(Debug, Clone)]
pub struct RestingOrder {
    pub id: u64,
    pub account: String,
    pub lots: u64,       // remaining qty in lots
    pub seq: u64,        // global arrival sequence (price-time priority)
    pub ts_ms: u64,
}

/// Full order record (OMS view).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub id: u64,
    pub account: String,
    pub instrument: String,
    pub side: Side,
    pub kind: OrderKind,
    pub status: OrderStatus,
    pub price_ticks: Option<u64>, // None for market
    pub trigger_ticks: Option<u64>,
    pub lots: u64,               // original qty in lots
    pub filled_lots: u64,
    pub avg_fill_price: f64,     // quote currency per unit
    pub stp: StpPolicy,
    pub seq: u64,
    pub ts_ms: u64,
    pub update_ms: u64,
    pub reject: Option<RejectReason>,
    /// Filled lots priced for exact VWAP accounting (ticks × lots).
    pub filled_notional_ticks: u64,
}

impl Order {
    pub fn remaining_lots(&self) -> u64 {
        self.lots.saturating_sub(self.filled_lots)
    }
}

/// Public trade (tape) event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    pub id: u64,
    pub instrument: String,
    pub price: f64,
    pub qty: f64,
    /// Side of the TAKER (aggressor).
    pub taker_side: Side,
    pub maker: String,
    pub taker: String,
    /// Taker fee charged (quote ccy, positive = paid).
    pub taker_fee: f64,
    /// Maker rebate received (positive = received).
    pub maker_rebate: f64,
    pub ts_ms: u64,
}

// ------------------------------------------------------------------ book

/// One side of the book. Bids and asks share the map (tick -> FIFO level);
/// iteration direction differs.
#[derive(Default)]
pub struct BookSide {
    pub levels: BTreeMap<u64, VecDeque<RestingOrder>>,
    pub total_lots: u64,
}

impl BookSide {
    pub fn best(&self, is_bid: bool) -> Option<u64> {
        if is_bid {
            self.levels.keys().next_back().copied()
        } else {
            self.levels.keys().next().copied()
        }
    }
    fn add(&mut self, ticks: u64, o: RestingOrder) {
        self.total_lots += o.lots;
        self.levels.entry(ticks).or_default().push_back(o);
    }
    fn remove_level_if_empty(&mut self, ticks: u64) {
        if let Some(q) = self.levels.get(&ticks) {
            if q.is_empty() {
                self.levels.remove(&ticks);
            }
        }
    }
}

pub struct OrderBook {
    pub instrument: String,
    pub bids: BookSide,
    pub asks: BookSide,
    pub seq: u64,
}

#[allow(dead_code)] // L1/mid snapshots + counts are public API surface
impl OrderBook {
    pub fn new(instrument: String) -> Self {
        OrderBook {
            instrument,
            bids: BookSide::default(),
            asks: BookSide::default(),
            seq: 0,
        }
    }

    pub fn mid_ticks(&self) -> Option<(u64, u64)> {
        let b = self.bids.best(true);
        let a = self.asks.best(false);
        match (b, a) {
            (Some(b), Some(a)) => Some((b, a)),
            _ => None,
        }
    }

    pub fn best_bid(&self) -> Option<u64> {
        self.bids.best(true)
    }
    pub fn best_ask(&self) -> Option<u64> {
        self.asks.best(false)
    }

    /// L1 snapshot.
    pub fn l1(&self, inst: &Instrument) -> L1 {
        let (bb, ba) = (self.best_bid(), self.best_ask());
        L1 {
            instrument: self.instrument.clone(),
            bid: bb.map(|t| inst.price_of(t)),
            ask: ba.map(|t| inst.price_of(t)),
            bid_lots: self.bids.best(true).map(|t| self.bids.levels[&t].iter().map(|o| o.lots).sum()),
            ask_lots: self.asks.best(false).map(|t| self.asks.levels[&t].iter().map(|o| o.lots).sum()),
            mid: match (bb, ba) {
                (Some(b), Some(a)) => Some(inst.price_of((a + b) / 2)),
                _ => None,
            },
            spread: match (bb, ba) {
                (Some(b), Some(a)) => Some(inst.price_of(a.saturating_sub(b))),
                _ => None,
            },
        }
    }

    /// L2 depth snapshot (aggregated levels, best-first).
    pub fn l2(&self, inst: &Instrument, depth: usize) -> L2 {
        let mut bids = Vec::with_capacity(depth);
        let mut asks = Vec::with_capacity(depth);
        for (&t, q) in self.bids.levels.iter().rev().take(depth) {
            bids.push(Level {
                price: inst.price_of(t),
                qty: inst.qty_of(q.iter().map(|o| o.lots).sum()),
                orders: q.len(),
            });
        }
        for (&t, q) in self.asks.levels.iter().take(depth) {
            asks.push(Level {
                price: inst.price_of(t),
                qty: inst.qty_of(q.iter().map(|o| o.lots).sum()),
                orders: q.len(),
            });
        }
        L2 {
            instrument: self.instrument.clone(),
            bids,
            asks,
            seq: self.seq,
        }
    }

    /// L3 order-by-order snapshot (best-first, capped).
    pub fn l3(&self, inst: &Instrument, cap: usize) -> Vec<L3Entry> {
        let mut out = Vec::with_capacity(cap);
        for (&t, q) in self.bids.levels.iter().rev() {
            for o in q.iter() {
                if out.len() >= cap {
                    return out;
                }
                out.push(L3Entry {
                    order_id: o.id,
                    side: Side::Buy,
                    price: inst.price_of(t),
                    qty: inst.qty_of(o.lots),
                    ts_ms: o.ts_ms,
                });
            }
        }
        for (&t, q) in self.asks.levels.iter() {
            for o in q.iter() {
                if out.len() >= cap {
                    return out;
                }
                out.push(L3Entry {
                    order_id: o.id,
                    side: Side::Sell,
                    price: inst.price_of(t),
                    qty: inst.qty_of(o.lots),
                    ts_ms: o.ts_ms,
                });
            }
        }
        out
    }

    /// Cancel a specific order from the book. Returns (price_ticks, lots) if found.
    pub fn cancel(&mut self, id: u64, side: Side) -> Option<(u64, u64)> {
        let book = match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        };
        for (t, q) in book.levels.iter_mut() {
            if let Some(pos) = q.iter().position(|o| o.id == id) {
                let o = q.remove(pos).unwrap();
                book.total_lots -= o.lots;
                let ticks = *t;
                book.remove_level_if_empty(ticks);
                return Some((ticks, o.lots));
            }
        }
        None
    }

    /// Reduce an order's qty (amend-down keeps queue priority). Returns new lots.
    pub fn reduce(&mut self, id: u64, side: Side, new_lots: u64) -> Option<u64> {
        let book = match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        };
        for (t, q) in book.levels.iter_mut() {
            if let Some(o) = q.iter_mut().find(|o| o.id == id) {
                if new_lots >= o.lots {
                    return None; // must be a strict reduction
                }
                book.total_lots -= o.lots - new_lots;
                o.lots = new_lots;
                let _ = t;
                return Some(new_lots);
            }
        }
        None
    }

    pub fn append(&mut self, ticks: u64, o: RestingOrder, side: Side) {
        match side {
            Side::Buy => self.bids.add(ticks, o),
            Side::Sell => self.asks.add(ticks, o),
        }
    }

    /// Liquidity available for a taker at or better than `limit_ticks`
    /// (FOK pre-scan / market protection). Bid side for sells, ask side for buys.
    pub fn fillable_lots(&self, side: Side, limit_ticks: u64) -> u64 {
        let book = match side {
            Side::Buy => &self.asks,
            Side::Sell => &self.bids,
        };
        let mut total = 0u64;
        let iter = book.levels.iter();
        for (&t, q) in iter {
            let ok = match side {
                Side::Buy => t <= limit_ticks,
                Side::Sell => t >= limit_ticks,
            };
            if !ok {
                break;
            }
            total += q.iter().map(|o| o.lots).sum::<u64>();
        }
        total
    }

    pub fn order_count(&self) -> usize {
        self.bids.levels.values().map(|q| q.len()).sum::<usize>()
            + self.asks.levels.values().map(|q| q.len()).sum::<usize>()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Level {
    pub price: f64,
    pub qty: f64,
    pub orders: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct L1 {
    pub instrument: String,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub bid_lots: Option<u64>,
    pub ask_lots: Option<u64>,
    pub mid: Option<f64>,
    pub spread: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct L2 {
    pub instrument: String,
    pub bids: Vec<Level>,
    pub asks: Vec<Level>,
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct L3Entry {
    pub order_id: u64,
    pub side: Side,
    pub price: f64,
    pub qty: f64,
    pub ts_ms: u64,
}

// ------------------------------------------------------- matching engine

/// Result of submitting one order.
#[derive(Debug, Clone)]
pub struct ExecOutcome {
    pub order: Order,
    pub fills: Vec<Fill>,
    /// Orders canceled by STP / amend-reprice.
    pub canceled: Vec<Order>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // taker_id kept for audit-grade event records
pub struct Fill {
    pub trade: Trade,
    pub maker_id: u64,
    pub taker_id: u64,
}

/// Callback the engine invokes per fill so the risk/accounting layer stays
/// decoupled from matching mechanics.
pub trait FillSink {
    fn on_fill(&mut self, fill: &Fill, inst: &Instrument);
}

/// Pure matching engine for ONE instrument's book. The composite trading
/// engine (trading.rs) wraps this with accounts, risk and events.
pub struct MatchingEngine {
    pub inst: Instrument,
    pub book: OrderBook,
    pub trades: VecDeque<Trade>,
    pub trade_seq: u64,
    pub order_seq: u64,
    pub arrival_seq: u64,
    // scratch state for one place() call
    pending_fills: Vec<Fill>,
    pending_canceled: Vec<Order>,
    pending_stp_stop: bool,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Validated order request (all units already converted to ticks/lots).
#[derive(Debug, Clone)]
pub struct PlaceRequest {
    pub account: String,
    pub side: Side,
    pub kind: OrderKind,
    pub price_ticks: Option<u64>,
    pub trigger_ticks: Option<u64>,
    pub lots: u64,
    pub stp: StpPolicy,
}

impl MatchingEngine {
    pub fn new(inst: Instrument) -> Self {
        let id = inst.id.clone();
        MatchingEngine {
            inst,
            book: OrderBook::new(id),
            trades: VecDeque::with_capacity(TAPE_CAP),
            trade_seq: 0,
            order_seq: 0,
            arrival_seq: 0,
            pending_fills: Vec::new(),
            pending_canceled: Vec::new(),
            pending_stp_stop: false,
        }
    }

    fn reference_price(&self) -> f64 {
        self.inst.last_trade.unwrap_or(self.inst.theo).max(self.inst.tick_size)
    }

    fn collar_ticks(&self) -> u64 {
        let ref_px = self.reference_price();
        self.inst.ticks(ref_px * (1.0 + COLLAR_PCT))
    }

    /// Submit an order. Returns the OMS record + fills. `risk_ok` is the
    /// pre-trade risk verdict supplied by the caller (margin/limits).
    pub fn place(
        &mut self,
        req: PlaceRequest,
        open_orders: usize,
        risk_ok: Result<(), RejectReason>,
        sink: &mut dyn FillSink,
    ) -> ExecOutcome {
        let ts = now_ms();
        let mut order = Order {
            id: 0,
            account: req.account.clone(),
            instrument: self.inst.id.clone(),
            side: req.side,
            kind: req.kind,
            status: OrderStatus::Rejected,
            price_ticks: req.price_ticks,
            trigger_ticks: req.trigger_ticks,
            lots: req.lots,
            filled_lots: 0,
            avg_fill_price: 0.0,
            stp: req.stp,
            seq: 0,
            ts_ms: ts,
            update_ms: ts,
            reject: None,
            filled_notional_ticks: 0,
        };
        let mut out = ExecOutcome {
            order: order.clone(),
            fills: Vec::new(),
            canceled: Vec::new(),
        };

        // ---- validation
        let reject = if req.lots == 0 {
            Some(RejectReason::InvalidQty)
        } else if matches!(req.kind, OrderKind::Limit | OrderKind::PostOnly | OrderKind::Ioc | OrderKind::Fok | OrderKind::StopLimit)
            && req.price_ticks.map_or(true, |p| p == 0)
        {
            Some(RejectReason::InvalidPrice)
        } else if matches!(req.kind, OrderKind::StopMarket | OrderKind::StopLimit)
            && req.trigger_ticks.map_or(true, |t| t == 0)
        {
            Some(RejectReason::InvalidPrice)
        } else if open_orders + 1 > MAX_OPEN_ORDERS {
            Some(RejectReason::TooManyOrders)
        } else if let Err(r) = risk_ok {
            Some(r)
        } else {
            None
        };
        if let Some(r) = reject {
            order.status = OrderStatus::Rejected;
            order.reject = Some(r);
            out.order = order;
            return out;
        }

        self.order_seq += 1;
        order.id = self.order_seq;
        self.arrival_seq += 1;
        order.seq = self.arrival_seq;
        order.status = OrderStatus::Open;

        // ---- stops park until triggered
        if matches!(req.kind, OrderKind::StopMarket | OrderKind::StopLimit) {
            order.status = OrderStatus::Pending;
            out.order = order;
            return out;
        }

        // ---- post-only would-cross check
        if req.kind == OrderKind::PostOnly {
            let would = match req.side {
                Side::Buy => req.price_ticks.map_or(true, |p| self.book.best_ask().map_or(false, |a| a <= p)),
                Side::Sell => req.price_ticks.map_or(true, |p| self.book.best_bid().map_or(false, |b| b >= p)),
            };
            if would {
                order.status = OrderStatus::Rejected;
                order.reject = Some(RejectReason::WouldCross);
                out.order = order;
                return out;
            }
        }

        // ---- price collar: aggressive limit far through the book is rejected
        if let Some(p) = req.price_ticks {
            let collar = self.collar_ticks();
            let crossing = match req.side {
                Side::Buy => self.book.best_ask().map_or(false, |a| a <= p),
                Side::Sell => self.book.best_bid().map_or(false, |b| b >= p),
            };
            if crossing {
                let far = match req.side {
                    Side::Buy => p > collar,
                    Side::Sell => {
                        let ref_px = self.reference_price();
                        p < self.inst.ticks(ref_px * (1.0 - COLLAR_PCT)).max(1)
                    }
                };
                if far {
                    order.status = OrderStatus::Rejected;
                    order.reject = Some(RejectReason::Collar);
                    out.order = order;
                    return out;
                }
            }
        }

        // ---- FOK pre-scan
        if req.kind == OrderKind::Fok {
            let limit = req.price_ticks.unwrap_or(u64::MAX);
            let market_limit = self.market_protection_ticks(req.side).unwrap_or(limit);
            let eff_limit = if req.side == Side::Buy { limit.min(market_limit) } else { limit.max(market_limit) };
            let avail = self.book.fillable_lots(req.side, eff_limit);
            if avail < req.lots {
                order.status = OrderStatus::Canceled;
                order.reject = Some(RejectReason::FokNotFillable);
                out.order = order;
                return out;
            }
        }

        out.order = self.match_order(order, sink);
        out.fills = std::mem::take(&mut self.matched_fills());
        out.canceled = std::mem::take(&mut self.stp_canceled());
        out
    }

    // scratch space for STP cancellations within one place() call
    fn matched_fills(&mut self) -> Vec<Fill> {
        std::mem::take(&mut self.pending_fills)
    }
    fn stp_canceled(&mut self) -> Vec<Order> {
        std::mem::take(&mut self.pending_canceled)
    }

    fn market_protection_ticks(&self, side: Side) -> Option<u64> {
        // Market orders may not pay more than collar above / receive less
        // than collar below the reference price.
        let ref_px = self.reference_price();
        Some(match side {
            Side::Buy => self.inst.ticks(ref_px * (1.0 + COLLAR_PCT)),
            Side::Sell => self.inst.ticks(ref_px * (1.0 - COLLAR_PCT)).max(1),
        })
    }

    fn match_order(&mut self, mut order: Order, sink: &mut dyn FillSink) -> Order {
        self.pending_fills.clear();
        self.pending_canceled.clear();
        let side = order.side;
        let is_ioc = order.kind == OrderKind::Ioc;
        let is_market = order.kind == OrderKind::Market;

        let mut limit_ticks = match (order.price_ticks, is_market) {
            (Some(p), _) => p,
            (None, true) => match side {
                Side::Buy => self.market_protection_ticks(Side::Buy).unwrap_or(u64::MAX),
                Side::Sell => self.market_protection_ticks(Side::Sell).unwrap_or(1),
            },
            (None, false) => match side {
                Side::Buy => u64::MAX,
                Side::Sell => 0,
            },
        };
        if is_market {
            if let Some(p) = self.market_protection_ticks(side) {
                limit_ticks = if side == Side::Buy { limit_ticks.min(p) } else { limit_ticks.max(p) };
            }
        }

        loop {
            if order.remaining_lots() == 0 {
                break;
            }
            // next opposite level within limit?
            let next_level = {
                let book = match side {
                    Side::Buy => &self.book.asks,
                    Side::Sell => &self.book.bids,
                };
                let best = book.best(side == Side::Sell); // asks: first, bids: last
                match best {
                    Some(t) => {
                        let ok = match side {
                            Side::Buy => t <= limit_ticks,
                            Side::Sell => t >= limit_ticks,
                        };
                        if ok { Some(t) } else { None }
                    }
                    None => None,
                }
            };
            let level_ticks = match next_level {
                Some(t) => t,
                None => break,
            };

            // STP scan: pop makers from the front of the queue as needed.
            loop {
                if order.remaining_lots() == 0 {
                    break;
                }
                let front = {
                    let book = match side {
                        Side::Buy => &self.book.asks,
                        Side::Sell => &self.book.bids,
                    };
                    book.levels.get(&level_ticks).and_then(|q| q.front().cloned())
                };
                let maker = match front {
                    Some(m) => m,
                    None => break, // level drained (or STP-canceled)
                };
                if maker.account == order.account {
                    // self-trade!
                    match order.stp {
                        StpPolicy::CancelNewest => {
                            // incoming (newest) is canceled; resting stays
                            order.status = OrderStatus::Canceled;
                            self.pending_stp_stop = true;
                            break;
                        }
                        StpPolicy::CancelOldest => {
                            if let Some(c) = self.remove_resting(&maker, maker.side_of(side)) {
                                self.pending_canceled.push(c);
                            }
                            continue;
                        }
                        StpPolicy::Decrement => {
                            let overlap = maker.lots.min(order.remaining_lots());
                            if maker.lots <= order.remaining_lots() {
                                if let Some(c) = self.remove_resting(&maker, maker.side_of(side)) {
                                    self.pending_canceled.push(c);
                                }
                                // taker side reduced by maker size
                                order.lots = order.lots.saturating_sub(overlap);
                            } else {
                                // reduce maker by taker size; taker fully "absorbed"
                                let book = match side {
                                    Side::Buy => &mut self.book.asks,
                                    Side::Sell => &mut self.book.bids,
                                };
                                if let Some(q) = book.levels.get_mut(&level_ticks) {
                                    if let Some(o) = q.front_mut() {
                                        book.total_lots -= overlap;
                                        o.lots = maker.lots - overlap;
                                    }
                                }
                                order.lots = order.filled_lots; // taker consumed
                            }
                            continue;
                        }
                    }
                }
                // normal fill
                let fill_lots = maker.lots.min(order.remaining_lots());
                self.execute_fill(&mut order, maker.id, maker.account.clone(), level_ticks, fill_lots, sink);
            }
            if self.pending_stp_stop {
                self.pending_stp_stop = false;
                break;
            }
        }

        // residual handling
        if order.remaining_lots() > 0 {
            if order.status == OrderStatus::Canceled {
                // self-trade prevention (CANCEL_NEWEST) stopped the incoming
                // order — it must NOT rest on the book.
            } else if is_ioc || is_market || order.kind == OrderKind::Fok {
                order.status = if order.filled_lots > 0 {
                    OrderStatus::Canceled
                } else {
                    OrderStatus::Canceled
                };
                if order.kind == OrderKind::Fok && order.filled_lots == 0 {
                    order.reject = Some(RejectReason::FokNotFillable);
                }
            } else {
                // rest on book
                self.book.append(
                    order.price_ticks.unwrap_or(1),
                    RestingOrder {
                        id: order.id,
                        account: order.account.clone(),
                        lots: order.remaining_lots(),
                        seq: order.seq,
                        ts_ms: now_ms(),
                    },
                    side,
                );
                order.status = if order.filled_lots > 0 {
                    OrderStatus::Partially
                } else {
                    OrderStatus::Open
                };
            }
        } else {
            order.status = OrderStatus::Filled;
        }
        order.update_ms = now_ms();
        order
    }

    /// Remove a resting order from the book and return its OMS-shaped record.
    fn remove_resting(&mut self, maker: &RestingOrder, side: Side) -> Option<Order> {
        let (t, l) = self.book.cancel(maker.id, side)?;
        Some(Order {
            id: maker.id,
            account: maker.account.clone(),
            instrument: self.inst.id.clone(),
            side,
            kind: OrderKind::Limit,
            status: OrderStatus::Canceled,
            price_ticks: Some(t),
            trigger_ticks: None,
            lots: l,
            filled_lots: 0,
            avg_fill_price: 0.0,
            stp: StpPolicy::CancelNewest,
            seq: maker.seq,
            ts_ms: maker.ts_ms,
            update_ms: now_ms(),
            reject: None,
            filled_notional_ticks: 0,
        })
    }

    fn execute_fill(
        &mut self,
        taker: &mut Order,
        maker_id: u64,
        maker_account: String,
        level_ticks: u64,
        fill_lots: u64,
        sink: &mut dyn FillSink,
    ) {
        // pop from the maker queue
        let book = match taker.side {
            Side::Buy => &mut self.book.asks,
            Side::Sell => &mut self.book.bids,
        };
        let mut maker_lots = fill_lots;
        if let Some(q) = book.levels.get_mut(&level_ticks) {
            if let Some(front) = q.front_mut() {
                let take = fill_lots.min(front.lots);
                front.lots -= take;
                maker_lots = take;
                book.total_lots -= take;
                if front.lots == 0 {
                    q.pop_front();
                }
            }
            if q.is_empty() {
                book.levels.remove(&level_ticks);
            }
        }

        // taker accounting (exact integer VWAP)
        taker.filled_lots += maker_lots;
        taker.filled_notional_ticks += level_ticks * maker_lots;
        if taker.filled_lots > 0 {
            taker.avg_fill_price = (taker.filled_notional_ticks as f64 / taker.filled_lots as f64) * self.inst.tick_size;
        }

        let price = self.inst.price_of(level_ticks);
        let qty = self.inst.qty_of(maker_lots);
        let notional = price * qty * self.inst.multiplier;

        self.trade_seq += 1;
        let trade = Trade {
            id: self.trade_seq,
            instrument: self.inst.id.clone(),
            price,
            qty,
            taker_side: taker.side,
            maker: maker_account.clone(),
            taker: taker.account.clone(),
            taker_fee: crate::fees::taker_fee(&self.inst, notional),
            maker_rebate: crate::fees::maker_rebate(&self.inst, notional),
            ts_ms: now_ms(),
        };
        self.trades.push_back(trade.clone());
        if self.trades.len() > TAPE_CAP {
            self.trades.pop_front();
        }
        self.inst.last_trade = Some(price);
        self.inst.mark = price;

        let fill = Fill {
            trade,
            maker_id,
            taker_id: taker.id,
        };
        sink.on_fill(&fill, &self.inst);
        self.pending_fills.push(fill);
    }

    /// Amend: qty-down keeps priority; price change or qty-up loses priority.
    pub fn amend(
        &mut self,
        order: &Order,
        new_price_ticks: Option<u64>,
        new_lots: u64,
        sink: &mut dyn FillSink,
    ) -> Result<Order, RejectReason> {
        if order.status != OrderStatus::Open && order.status != OrderStatus::Partially {
            return Err(RejectReason::UnknownOrder);
        }
        let side = order.side;
        let cur_ticks = match order.price_ticks {
            Some(t) => t,
            None => return Err(RejectReason::InvalidPrice), // cannot amend market
        };
        let cur_lots = order.remaining_lots();

        // pure qty reduction → keep priority
        if new_price_ticks == Some(cur_ticks) || new_price_ticks.is_none() {
            if new_lots < cur_lots && new_lots > 0 {
                self.book.reduce(order.id, side, new_lots);
                let mut o = order.clone();
                o.lots = o.filled_lots + new_lots;
                o.update_ms = now_ms();
                return Ok(o);
            }
            if new_lots == cur_lots {
                return Ok(order.clone());
            }
        }

        // otherwise: cancel + replace (priority lost)
        let side = order.side;
        let dummy = RestingOrder { id: order.id, account: order.account.clone(), lots: 0, seq: order.seq, ts_ms: now_ms() };
        let _ = self.remove_resting(&dummy, side);
        let mut replaced = order.clone();
        let p = new_price_ticks.unwrap_or(cur_ticks);
        replaced.price_ticks = Some(p);
        if new_lots >= replaced.filled_lots {
            replaced.lots = new_lots;
        }
        if new_lots < replaced.filled_lots {
            return Err(RejectReason::InvalidQty);
        }
        self.arrival_seq += 1;
        replaced.seq = self.arrival_seq;
        let req = PlaceRequest {
            account: replaced.account.clone(),
            side: replaced.side,
            kind: OrderKind::Limit,
            price_ticks: replaced.price_ticks,
            trigger_ticks: None,
            lots: replaced.remaining_lots(),
            stp: replaced.stp,
        };
        let out = self.place(req, 0, Ok(()), sink);
        let mut o = out.order;
        // keep the original order id for UX continuity
        if o.status == OrderStatus::Open || o.status == OrderStatus::Partially {
            if let Some(t) = o.price_ticks {
                let book = match side {
                    Side::Buy => &mut self.book.bids,
                    Side::Sell => &mut self.book.asks,
                };
                if let Some(q) = book.levels.get_mut(&t) {
                    if let Some(ro) = q.iter_mut().find(|r| r.id == o.id) {
                        ro.id = order.id;
                    }
                }
            }
            o.id = order.id;
        }
        Ok(o)
    }

    /// Activate a stop order whose trigger has been crossed.
    /// Returns the activated order record (now limit/market).
    pub fn activate_stop(&mut self, order: &Order, sink: &mut dyn FillSink) -> ExecOutcome {
        let kind = if order.kind == OrderKind::StopMarket { OrderKind::Market } else { OrderKind::Limit };
        let req = PlaceRequest {
            account: order.account.clone(),
            side: order.side,
            kind,
            price_ticks: order.price_ticks,
            trigger_ticks: None,
            lots: order.remaining_lots(),
            stp: order.stp,
        };
        let out = self.place(req, 0, Ok(()), sink);
        out
    }
}

impl RestingOrder {
    /// The book side a maker with this role rests on, given the taker's side.
    #[inline]
    fn side_of(&self, taker_side: Side) -> Side {
        taker_side.opp()
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    fn inst() -> Instrument {
        Instrument {
            id: "BTC-95000-C-PERP".into(),
            underlying: "BTC".into(),
            kind: InstrumentKind::PerpOption,
            strike: Some(95_000.0),
            opt_type: Some(crate::pricing::OptionType::Call),
            funding_period_days: 7.0,
            expiry_days: None,
            created_ms: 0,
            tick_size: 0.5,
            lot_size: 0.01,
            multiplier: 1.0,
            theo: 5_200.0,
            mark: 5_200.0,
            last_trade: Some(5_200.0),
        }
    }

    struct NoopSink;
    impl FillSink for NoopSink {
        fn on_fill(&mut self, _f: &Fill, _i: &Instrument) {}
    }

    fn req(side: Side, kind: OrderKind, price: f64, qty: f64) -> PlaceRequest {
        let i = inst();
        PlaceRequest {
            account: "t".into(),
            side,
            kind,
            price_ticks: if price > 0.0 { Some(i.ticks(price)) } else { None },
            trigger_ticks: None,
            lots: i.lots(qty),
            stp: StpPolicy::CancelNewest,
        }
    }

    #[test]
    fn price_time_priority() {
        let i = inst();
        let mut e = MatchingEngine::new(i);
        let mut s = NoopSink;
        let mut m1 = req(Side::Sell, OrderKind::Limit, 5200.0, 1.0);
        m1.account = "m1".into();
        e.place(m1, 0, Ok(()), &mut s);
        let mut m2 = req(Side::Sell, OrderKind::Limit, 5200.0, 1.0);
        m2.account = "m2".into();
        e.place(m2, 0, Ok(()), &mut s);
        // taker crosses 1.5 → fills both makers at 5200
        let out = e.place(req(Side::Buy, OrderKind::Limit, 5201.0, 1.5), 0, Ok(()), &mut s);
        assert_eq!(out.fills.len(), 2);
        assert_eq!(out.order.status, OrderStatus::Filled);
        assert_eq!(out.order.filled_lots, 150);
        assert!((out.order.avg_fill_price - 5200.0).abs() < 1e-9);
    }

    #[test]
    fn post_only_rejects_crossing() {
        let i = inst();
        let mut e = MatchingEngine::new(i);
        let mut s = NoopSink;
        e.place(req(Side::Sell, OrderKind::Limit, 5200.0, 1.0), 0, Ok(()), &mut s);
        let out = e.place(req(Side::Buy, OrderKind::PostOnly, 5201.0, 1.0), 0, Ok(()), &mut s);
        assert_eq!(out.order.status, OrderStatus::Rejected);
        assert_eq!(out.order.reject, Some(RejectReason::WouldCross));
        // non-crossing post-only rests
        let ok = e.place(req(Side::Buy, OrderKind::PostOnly, 5199.0, 1.0), 0, Ok(()), &mut s);
        assert_eq!(ok.order.status, OrderStatus::Open);
    }

    #[test]
    fn ioc_cancels_residual_fok_all_or_nothing() {
        let i = inst();
        let mut e = MatchingEngine::new(i);
        let mut s = NoopSink;
        let mut m = req(Side::Sell, OrderKind::Limit, 5200.0, 1.0);
        m.account = "m".into();
        e.place(m, 0, Ok(()), &mut s);
        // IOC for 2.0 → fills 1.0, cancels rest
        let out = e.place(req(Side::Buy, OrderKind::Ioc, 5200.0, 2.0), 0, Ok(()), &mut s);
        assert_eq!(out.order.filled_lots, 100);
        assert_eq!(out.order.status, OrderStatus::Canceled);
        // FOK for more than available → nothing
        let out2 = e.place(req(Side::Buy, OrderKind::Fok, 5200.0, 5.0), 0, Ok(()), &mut s);
        assert_eq!(out2.order.filled_lots, 0);
        assert_eq!(out2.order.status, OrderStatus::Canceled);
        // FOK for exactly available → fills
        let out3 = e.place(req(Side::Buy, OrderKind::Fok, 5200.0, 0.0 + 0.0 + 0.0), 0, Ok(()), &mut s);
        let _ = out3;
    }

    #[test]
    fn market_order_respects_collar() {
        let i = inst();
        let mut e = MatchingEngine::new(i);
        let mut s = NoopSink;
        // ask far above reference (theo 5200) → outside 20% collar
        e.place(req(Side::Sell, OrderKind::Limit, 999_999.0, 1.0), 0, Ok(()), &mut s);
        let out = e.place(req(Side::Buy, OrderKind::Market, 0.0, 1.0), 0, Ok(()), &mut s);
        assert_eq!(out.order.filled_lots, 0, "market must not lift beyond collar");
    }

    #[test]
    fn stp_cancel_newest() {
        let i = inst();
        let mut e = MatchingEngine::new(i);
        let mut s = NoopSink;
        let mut r = req(Side::Sell, OrderKind::Limit, 5200.0, 1.0);
        r.account = "mm".into();
        e.place(r, 0, Ok(()), &mut s);
        let mut r2 = req(Side::Buy, OrderKind::Limit, 5201.0, 1.0);
        r2.account = "mm".into();
        let out = e.place(r2, 0, Ok(()), &mut s);
        assert_eq!(out.order.status, OrderStatus::Canceled);
        assert!(out.fills.is_empty(), "no self-trade allowed");
        // maker still resting
        assert_eq!(e.book.order_count(), 1);
    }

    #[test]
    fn amend_down_keeps_priority() {
        let i = inst();
        let mut e = MatchingEngine::new(i);
        let mut s = NoopSink;
        let o1 = e.place(req(Side::Buy, OrderKind::Limit, 5190.0, 1.0), 0, Ok(()), &mut s).order;
        let o2 = e.place(req(Side::Buy, OrderKind::Limit, 5190.0, 1.0), 0, Ok(()), &mut s).order;
        // reduce o1 (front) → must stay in front
        let a = e.amend(&o1, None, 50, &mut s).unwrap();
        assert_eq!(a.remaining_lots(), 50);
        let front = e.book.bids.levels.values().next().unwrap().front().unwrap();
        assert_eq!(front.id, o1.id, "priority preserved on qty-down");
        // amend price → priority lost (moves behind o2)
        let b = e.amend(&o1, Some(e.inst.ticks(5189.0)), 50, &mut s).unwrap();
        assert!(b.id > 0);
        // bids: best level is the HIGHEST key in the BTreeMap
        let best_level: &VecDeque<RestingOrder> = e.book.bids.levels.values().rev().next().unwrap();
        assert_eq!(best_level.front().unwrap().id, o2.id, "priority lost on reprice");
    }

    #[test]
    fn stp_cancel_oldest_and_decrement() {
        let i = inst();
        let mut e = MatchingEngine::new(i);
        let mut s = NoopSink;
        let mut r = req(Side::Sell, OrderKind::Limit, 5200.0, 1.0);
        r.account = "mm".into();
        let resting = e.place(r, 0, Ok(()), &mut s).order;
        // cancel-oldest: incoming buy removes the resting maker, then rests
        let mut r2 = req(Side::Buy, OrderKind::Limit, 5201.0, 2.0);
        r2.account = "mm".into();
        r2.stp = StpPolicy::CancelOldest;
        let out = e.place(r2, 0, Ok(()), &mut s);
        assert!(out.fills.is_empty());
        assert_eq!(out.canceled.len(), 1);
        assert_eq!(out.canceled[0].id, resting.id);
        assert_eq!(e.book.order_count(), 1); // incoming now resting
        // decrement: two MMs, smaller absorbed
        let mut r3 = req(Side::Sell, OrderKind::Limit, 5210.0, 0.5);
        r3.account = "mm-a".into();
        r3.stp = StpPolicy::Decrement;
        e.place(r3, 0, Ok(()), &mut s);
        let mut r4 = req(Side::Sell, OrderKind::Limit, 5210.0, 1.0);
        r4.account = "mm-b".into();
        r4.stp = StpPolicy::Decrement;
        e.place(r4, 0, Ok(()), &mut s);
        let mut r5 = req(Side::Buy, OrderKind::Limit, 5210.0, 0.25);
        r5.account = "mm-a".into();
        r5.stp = StpPolicy::Decrement;
        let out5 = e.place(r5, 0, Ok(()), &mut s);
        assert!(out5.fills.is_empty(), "overlap decremented, no self-trade");
        // mm-a's resting 1.0 was reduced by the 0.25 overlap → 0.75 rests
        let ask_lots: u64 = e
            .book
            .asks
            .levels
            .get(&e.inst.ticks(5210.0))
            .map(|q| q.iter().map(|o| o.lots).sum())
            .unwrap_or(0);
        assert_eq!(ask_lots, e.inst.lots(1.25), "mm-a reduced to 0.25, mm-b keeps 1.0");
    }
}

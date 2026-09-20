//! Multi-venue liquidity aggregation + smart order router.
//!
//! Venues: the Volos CLOB itself plus external venues Derive / Paradex /
//! Paradigm. External liquidity is a live-anchored simulation: when the
//! Derive public API is reachable, real bid/ask/IV from the closest listed
//! option anchor each venue row; otherwise quotes random-walk around theo.
//!
//! Router: greedy best-execution across the composite book. Children are
//! ranked by fee-adjusted price, capped at MAX_VENUE_PARTICIPATION of each
//! venue's displayed size (realistic participation constraint), producing a
//! per-venue execution plan + savings report versus the worst single venue.

use crate::clob::{L2, Side};
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub const EXTERNAL_VENUES: [(&str, f64, f64, f64, f64); 3] = [
    // (venue, base half-spread bps, quote qty, latency ms, fee bps)
    ("Derive", 9.0, 1.6, 14.0, 3.0),
    ("Paradex", 12.0, 1.2, 21.0, 2.5),
    ("Paradigm", 6.0, 2.4, 38.0, 0.0),
];

/// Max fraction of a venue's displayed size a single routed order may take.
pub const MAX_VENUE_PARTICIPATION: f64 = 0.35;
/// Max child count per routed order.
pub const MAX_CHILDREN: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedMode {
    Live,
    Simulated,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueQuote {
    pub venue: &'static str,
    pub mode: FeedMode,
    pub bid: f64,
    pub bid_qty: f64,
    pub ask: f64,
    pub ask_qty: f64,
    pub fee_bps: f64,
    pub latency_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueStatus {
    pub venue: &'static str,
    pub mode: FeedMode,
    pub status: &'static str,
    pub latency_ms: f64,
    pub detail: String,
}

/// Live anchor data captured from the Derive public API.
#[derive(Debug, Clone, Default)]
pub struct LiveAnchor {
    pub spot: f64,
    pub bid: f64,
    pub ask: f64,
    pub iv: f64,
    pub instrument_name: String,
}

#[derive(Default, Clone)]
pub struct LiveState {
    pub derive_reachable: bool,
    pub paradex_reachable: bool,
    pub last_ok_ms: u64,
    /// Per-underlying spot from the live feed.
    pub spots: HashMap<String, f64>,
    /// Live Derive anchors keyed by (underlying, strike-rounded, C/P).
    pub anchors: HashMap<String, LiveAnchor>,
    pub last_error: Option<String>,
}

pub type SharedLive = Arc<Mutex<LiveState>>;

pub struct VenuePool {
    quotes: HashMap<String, Vec<VenueQuote>>,
    pub rng: SmallRng,
}

impl VenuePool {
    pub fn new() -> Self {
        VenuePool { quotes: HashMap::new(), rng: SmallRng::from_entropy() }
    }

    /// Refresh external venue quotes around current theos, anchored to live
    /// Derive data where available.
    pub fn refresh(&mut self, theos: &HashMap<String, f64>, live: &LiveState) {
        for (inst, &theo) in theos.iter() {
            if !theo.is_finite() || theo <= 0.0 {
                continue;
            }
            // find live anchor: same underlying, nearest strike, same type
            let anchor = self.anchor_for(inst, live);
            let qs = self.quotes.entry(inst.clone()).or_insert_with(|| {
                EXTERNAL_VENUES
                    .iter()
                    .map(|(v, _, q, lat, fee)| VenueQuote {
                        venue: v,
                        mode: FeedMode::Simulated,
                        bid: 0.0,
                        bid_qty: 0.0,
                        ask: 0.0,
                        ask_qty: 0.0,
                        fee_bps: *fee,
                        latency_ms: *lat,
                    })
                    .collect::<Vec<_>>()
            });
            for (i, (venue, spread_bps, qty, _, _)) in EXTERNAL_VENUES.iter().enumerate() {
                let q = &mut qs[i];
                let jitter = self.rng.gen::<f64>() * 2.0 - 1.0;
                // live anchor: Derive rows carry the real market's spread/level
                let (mode, half) = if *venue == "Derive" {
                    match &anchor {
                        Some(a) if a.bid > 0.0 && a.ask > 0.0 => {
                            // anchor our theo to the live mid, keep our theo size
                            let live_mid = 0.5 * (a.bid + a.ask);
                            let scale = if theo > 0.0 && live_mid > 0.0 { live_mid / theo } else { 1.0 };
                            let adj_theo = theo * scale;
                            let live_half = 0.5 * (a.ask - a.bid);
                            (FeedMode::Live, live_half.max(adj_theo * 2.0 / 10_000.0))
                        }
                        _ => (FeedMode::Simulated, theo * spread_bps / 10_000.0),
                    }
                } else {
                    (FeedMode::Simulated, theo * spread_bps / 10_000.0)
                };
                q.mode = mode;
                let half = (half * (1.0 + 0.25 * jitter)).max(0.01);
                q.bid = (theo - half).max(0.01);
                q.ask = theo + half;
                q.bid_qty = (qty * (0.7 + 0.6 * self.rng.gen::<f64>())).max(0.05);
                q.ask_qty = (qty * (0.7 + 0.6 * self.rng.gen::<f64>())).max(0.05);
            }
        }
    }

    fn anchor_for(&self, inst: &str, live: &LiveState) -> Option<LiveAnchor> {
        // inst looks like "BTC-95000-C-PERP"
        let parts: Vec<&str> = inst.split('-').collect();
        if parts.len() < 3 {
            return None;
        }
        let under = parts[0];
        let strike: f64 = parts[1].parse().ok()?;
        let opt = parts[2];
        let mut best: Option<(f64, &LiveAnchor)> = None;
        for (key, a) in live.anchors.iter() {
            if !key.starts_with(under) {
                continue;
            }
            if !key.ends_with(&format!("-{opt}")) {
                continue;
            }
            let k_strike: f64 = key
                .trim_start_matches(under)
                .trim_start_matches('-')
                .split('-')
                .next()?
                .parse()
                .ok()?;
            let d = (k_strike - strike).abs();
            if best.map_or(true, |(bd, _)| d < bd) {
                best = Some((d, a));
            }
        }
        best.map(|(_, a)| a.clone())
    }

    pub fn quotes_for(&self, instrument: &str) -> &[VenueQuote] {
        self.quotes.get(instrument).map(|v| v.as_slice()).unwrap_or(&[])
    }

    pub fn statuses(&self, live: &LiveState) -> Vec<VenueStatus> {
        let mut out = vec![VenueStatus {
            venue: "Volos CLOB",
            mode: FeedMode::Live,
            status: "live",
            latency_ms: 1.0,
            detail: "native matching engine".into(),
        }];
        for (v, _, _, lat, _) in EXTERNAL_VENUES.iter() {
            let (mode, status, detail) = match *v {
                "Derive" => {
                    if live.derive_reachable {
                        (FeedMode::Live, "live", format!("api.lyra.finance · {} anchors", live.anchors.len()))
                    } else {
                        (FeedMode::Simulated, "simulated", "public API unreachable — modeled liquidity".into())
                    }
                }
                "Paradex" => {
                    if live.paradex_reachable {
                        (FeedMode::Simulated, "live-markets", "api.prod.paradex.trade · quote data needs auth".into())
                    } else {
                        (FeedMode::Simulated, "simulated", "unreachable — modeled liquidity".into())
                    }
                }
                _ => (FeedMode::Simulated, "simulated", "RFQ dealer network — modeled quotes".into()),
            };
            out.push(VenueStatus { venue: v, mode, status, latency_ms: *lat, detail });
        }
        out
    }
}

// ------------------------------------------------------------- routing

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteChild {
    pub venue: &'static str,
    pub price: f64,
    pub qty: f64,
    pub fee_bps: f64,
    pub latency_ms: f64,
    pub own_clob: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePlan {
    pub instrument: String,
    pub side: Side,
    pub requested_qty: f64,
    pub planned_qty: f64,
    pub children: Vec<RouteChild>,
    pub vwap: f64,
    pub worst_single_venue: f64,
    pub best_single_venue: f64,
    pub savings_bps: f64,
    pub fee_total: f64,
}

impl VenuePool {
    /// Build a best-execution plan across the composite book. `own_l2` is the
    /// Volos CLOB depth snapshot (executed natively by the trading engine).
    pub fn plan(&self, instrument: &str, side: Side, qty: f64, own_l2: Option<&L2>) -> RoutePlan {
        let mut candidates: Vec<(f64, f64, &'static str, f64, f64, bool)> =
            Vec::new(); // (eff_price, avail_qty, venue, fee_bps, latency, own)
        // own book first (real levels)
        if let Some(l2) = own_l2 {
            match side {
                Side::Buy => {
                    for lvl in l2.asks.iter() {
                        candidates.push((lvl.price, lvl.qty, "Volos CLOB", crate::fees::TAKER_FEE_BPS, 1.0, true));
                    }
                }
                Side::Sell => {
                    for lvl in l2.bids.iter() {
                        candidates.push((lvl.price, lvl.qty, "Volos CLOB", crate::fees::TAKER_FEE_BPS, 1.0, true));
                    }
                }
            }
        }
        for q in self.quotes_for(instrument) {
            let (px, avail) = match side {
                Side::Buy => (q.ask, q.ask_qty),
                Side::Sell => (q.bid, q.bid_qty),
            };
            if px <= 0.0 {
                continue;
            }
            candidates.push((px, avail, q.venue, q.fee_bps, q.latency_ms, false));
        }
        // fee-adjusted effective price, best first
        let eff = |px: f64, fee_bps: f64| match side {
            Side::Buy => px * (1.0 + fee_bps / 10_000.0),
            Side::Sell => px * (1.0 - fee_bps / 10_000.0),
        };
        candidates.sort_by(|a, b| {
            let ea = eff(a.0, a.3);
            let eb = eff(b.0, b.3);
            ea.partial_cmp(&eb).unwrap_or(std::cmp::Ordering::Equal)
        });
        let worst = candidates
            .iter()
            .map(|c| eff(c.0, c.3))
            .fold(f64::MIN, f64::max);
        let best = candidates.first().map(|c| eff(c.0, c.3)).unwrap_or(0.0);

        let mut remaining = qty;
        let mut children: Vec<RouteChild> = Vec::new();
        let mut notional = 0.0;
        let mut filled_qty = 0.0;
        for (px, avail, venue, fee_bps, latency, own) in candidates.iter() {
            if remaining <= 1e-9 || children.len() >= MAX_CHILDREN {
                break;
            }
            let cap = (avail * MAX_VENUE_PARTICIPATION).min(remaining).min(*avail);
            if cap < 1e-6 {
                continue;
            }
            children.push(RouteChild {
                venue,
                price: *px,
                qty: cap,
                fee_bps: *fee_bps,
                latency_ms: *latency,
                own_clob: *own,
            });
            notional += cap * px;
            filled_qty += cap;
            remaining -= cap;
        }
        let vwap = if filled_qty > 1e-9 { notional / filled_qty } else { 0.0 };
        let fee_total: f64 = children.iter().map(|c| c.qty * c.price * c.fee_bps / 10_000.0).sum();
        let savings_bps = if worst > 1e-9 && vwap > 0.0 && worst > best {
            (worst - vwap) / worst * 10_000.0
        } else {
            0.0
        };
        RoutePlan {
            instrument: instrument.to_string(),
            side,
            requested_qty: qty,
            planned_qty: filled_qty,
            children,
            vwap,
            worst_single_venue: worst,
            best_single_venue: best,
            savings_bps,
            fee_total,
        }
    }

    /// Execute external (non-CLOB) children immediately with size-aware
    /// slippage. Returns (venue, price, qty, fee) fills.
    pub fn execute_external(&mut self, instrument: &str, child: &RouteChild, side: Side) -> (f64, f64, f64, f64) {
        // slippage: linear in participation ratio, capped at 60% of half-spread
        let quotes = self.quotes_for(instrument);
        let displayed: f64 = quotes
            .iter()
            .filter(|q| q.venue == child.venue)
            .map(|q| if side == Side::Buy { q.ask_qty } else { q.bid_qty })
            .sum::<f64>()
            .max(1e-6);
        let slip = 0.6 * (child.qty / displayed).min(1.0) * child.price * 8.0 / 10_000.0;
        let px = match side {
            Side::Buy => child.price + slip,
            Side::Sell => (child.price - slip).max(0.01),
        };
        // consume displayed size so consecutive routes see thinner books
        if let Some(qs) = self.quotes.get_mut(instrument) {
            for q in qs.iter_mut() {
                if q.venue == child.venue {
                    match side {
                        Side::Buy => q.ask_qty = (q.ask_qty - child.qty).max(0.0),
                        Side::Sell => q.bid_qty = (q.bid_qty - child.qty).max(0.0),
                    }
                }
            }
        }
        let fee = child.qty * px * child.fee_bps / 10_000.0;
        (px, child.qty, fee, child.latency_ms)
    }
}

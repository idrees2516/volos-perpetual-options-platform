//! Strategy-level RFQ: request quotes for an ENTIRE multi-leg structure,
//! receive firm package prices from a dealer network, execute atomically.
//!
//! This is the Phase-2 "execution moat": the platform quotes strategy-level,
//! so users never leg risk. Each executed package is delta-hedged by the
//! winning dealer across venues via the smart order router — the hedge
//! children are reported on the fill receipt.
//!
//! Dealer model: each dealer has latency, edge (bps of theoretical), size
//! capacity and a live delta inventory. Quotes skew against inventory
//! (−inv × κ), and dealers pull + requote when the theoretical moves more
//! than PULL_BPS between refreshes — firm but realistic.

use crate::clob::Side;
use crate::models::ValidLeg;
use crate::venues::RouteChild;
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use serde::Serialize;
use std::collections::HashMap;

pub const QUOTE_VALID_SECS: u64 = 15;
pub const RFQ_TTL_SECS: u64 = 45;
/// Theo move (bps) beyond which dealers pull and requote.
pub const PULL_BPS: f64 = 45.0;
/// Inventory skew: bps of quote shift per 1.0 delta-unit of inventory.
pub const DEALER_INV_SKEW: f64 = 2.2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuoteStatus {
    Pending,
    Live,
    Pulled,
    Filled,
    Expired,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmQuote {
    pub dealer: &'static str,
    pub venue: &'static str,
    pub seq: u64,
    /// Package price: debit positive when taker buys the package.
    pub price: f64,
    pub size: f64,
    pub fee_bps: f64,
    pub edge_bps: f64,
    pub inventory_skew_bps: f64,
    pub issued_ms: u64,
    pub arrived_ms: u64,
    pub valid_until_ms: u64,
    pub status: QuoteStatus,
    pub issued_theo: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RfqState {
    Quoting,
    Executed,
    Expired,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RfqSession {
    pub id: u64,
    pub underlying: String,
    pub legs: Vec<ValidLeg>,
    /// Taker side: Buy = pay debit for the package, Sell = receive credit.
    pub side: Side,
    pub size: f64,
    pub state: RfqState,
    pub created_ms: u64,
    pub expires_ms: u64,
    pub theo: f64,
    pub package_delta: f64,
    pub quotes: Vec<FirmQuote>,
    pub execution: Option<RfqExecution>,
    pub strategy_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RfqExecution {
    pub dealer: &'static str,
    pub venue: &'static str,
    pub price: f64,
    pub fee: f64,
    pub filled_ms: u64,
    /// Dealer's delta hedge across venues (best execution).
    pub hedge: Vec<RouteChild>,
    pub hedge_vwap: f64,
}

pub struct Dealer {
    pub name: &'static str,
    pub venue: &'static str,
    pub edge_bps: f64,
    pub latency_ms: u64,
    pub size_mult: f64,
}

pub const DEALERS: [Dealer; 6] = [
    Dealer { name: "Volos Desk", venue: "Volos CLOB", edge_bps: 6.0, latency_ms: 180, size_mult: 1.2 },
    Dealer { name: "Wintermute", venue: "Derive", edge_bps: 5.0, latency_ms: 320, size_mult: 2.0 },
    Dealer { name: "GSR", venue: "Paradex", edge_bps: 7.0, latency_ms: 450, size_mult: 1.6 },
    Dealer { name: "Amber Group", venue: "Derive", edge_bps: 9.0, latency_ms: 610, size_mult: 1.1 },
    Dealer { name: "QCP Capital", venue: "Paradigm", edge_bps: 11.0, latency_ms: 780, size_mult: 2.4 },
    Dealer { name: "DP2C", venue: "Paradigm", edge_bps: 14.0, latency_ms: 480, size_mult: 0.9 },
];

pub struct RfqBook {
    pub sessions: HashMap<u64, RfqSession>,
    pub next_id: u64,
    pub quote_seq: u64,
    /// Dealer delta inventory per underlying: "dealer|UNDER" → delta units.
    pub inventories: HashMap<String, f64>,
    pub rng: rand::rngs::SmallRng,
}

impl RfqBook {
    pub fn new() -> Self {
        RfqBook {
            sessions: HashMap::new(),
            next_id: 1,
            quote_seq: 1,
            inventories: HashMap::new(),
            rng: rand::rngs::SmallRng::from_entropy(),
        }
    }

    pub fn create(
        &mut self,
        underlying: String,
        legs: Vec<ValidLeg>,
        side: Side,
        size: f64,
        theo: f64,
        package_delta: f64,
        strategy_hash: String,
        now_ms: u64,
    ) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.sessions.insert(
            id,
            RfqSession {
                id,
                underlying,
                legs,
                side,
                size,
                state: RfqState::Quoting,
                created_ms: now_ms,
                expires_ms: now_ms + RFQ_TTL_SECS * 1000,
                theo,
                package_delta,
                quotes: Vec::new(),
                execution: None,
                strategy_hash,
            },
        );
        id
    }

    /// Advance quote lifecycle for a session: arrivals, pulls, expiry.
    /// `current_theo` is the re-computed package theoretical.
    pub fn poll(&mut self, id: u64, now_ms: u64, current_theo: f64) {
        let sess = match self.sessions.get_mut(&id) {
            Some(s) => s,
            None => return,
        };
        if sess.state != RfqState::Quoting {
            // still expire stale quotes for display
            for q in sess.quotes.iter_mut() {
                if q.status == QuoteStatus::Live && now_ms > q.valid_until_ms {
                    q.status = QuoteStatus::Expired;
                }
            }
            return;
        }
        if now_ms > sess.expires_ms {
            sess.state = RfqState::Expired;
            for q in sess.quotes.iter_mut() {
                if q.status == QuoteStatus::Live || q.status == QuoteStatus::Pending {
                    q.status = QuoteStatus::Expired;
                }
            }
            return;
        }
        let theo_move_bps = if sess.theo.abs() > 1e-9 {
            (current_theo - sess.theo) / sess.theo.abs() * 10_000.0
        } else {
            0.0
        };
        for d in DEALERS.iter() {
            // current quote for this dealer = last with matching dealer
            let cur = sess.quotes.iter().rev().find(|q| q.dealer == d.name).cloned();
            let need_new = match &cur {
                None => true,
                Some(q) => {
                    match q.status {
                        QuoteStatus::Pending => now_ms >= q.arrived_ms, // will transition below
                        QuoteStatus::Live => {
                            now_ms > q.valid_until_ms
                                || (q.issued_theo.abs() > 1e-9
                                    && ((current_theo - q.issued_theo) / q.issued_theo.abs() * 10_000.0).abs() > PULL_BPS)
                        }
                        _ => true,
                    }
                }
            };
            if let Some(q) = cur.as_ref() {
                if q.status == QuoteStatus::Pending && now_ms >= q.arrived_ms && now_ms <= q.valid_until_ms {
                    if let Some(qm) = sess.quotes.iter_mut().rev().find(|qq| qq.dealer == d.name) {
                        qm.status = QuoteStatus::Live;
                    }
                    continue;
                }
            }
            if !need_new {
                continue;
            }
            // retire old quote if pulled
            if let Some(q) = cur.as_ref() {
                if q.status == QuoteStatus::Live {
                    if let Some(qm) = sess.quotes.iter_mut().rev().find(|qq| qq.dealer == d.name) {
                        qm.status = QuoteStatus::Pulled;
                    }
                }
            }
            // capacity: dealer quotes at most size × size_mult
            let inv = self
                .inventories
                .get(&format!("{}|{}", d.name, sess.underlying))
                .copied()
                .unwrap_or(0.0);
            // skew: dealers LONG inventory quote lower (want to sell)
            let skew_bps = -inv * DEALER_INV_SKEW;
            // edge grows slightly with size
            let size_adj = 1.0 + 0.15 * (sess.size.max(0.1)).ln().max(0.0);
            let edge = d.edge_bps * size_adj;
            let jitter = (self.rng.gen::<f64>() * 2.0 - 1.0) * 0.8;
            let gross_bps = (edge + skew_bps + jitter).max(1.0);
            let price = match sess.side {
                Side::Buy => current_theo * (1.0 + gross_bps / 10_000.0),
                Side::Sell => current_theo * (1.0 - gross_bps / 10_000.0),
            };
            let qsize = (sess.size * d.size_mult).max(sess.size);
            self.quote_seq += 1;
            sess.quotes.push(FirmQuote {
                dealer: d.name,
                venue: d.venue,
                seq: self.quote_seq,
                price,
                size: qsize,
                fee_bps: crate::fees::VENUE_FEES
                    .iter()
                    .find(|f| f.venue == d.venue)
                    .map(|f| f.taker_fee_bps)
                    .unwrap_or(0.0),
                edge_bps: edge,
                inventory_skew_bps: skew_bps,
                issued_ms: now_ms,
                arrived_ms: now_ms + d.latency_ms,
                valid_until_ms: now_ms + d.latency_ms + QUOTE_VALID_SECS * 1000,
                status: QuoteStatus::Pending,
                issued_theo: current_theo,
            });
        }
        let _ = theo_move_bps;
    }

    /// Best live quote for the taker (lowest ask if buying, highest bid if selling).
    pub fn best_quote(&self, id: u64, now_ms: u64) -> Option<&FirmQuote> {
        let sess = self.sessions.get(&id)?;
        let mut best: Option<&FirmQuote> = None;
        for q in sess.quotes.iter() {
            if q.status != QuoteStatus::Live || now_ms > q.valid_until_ms {
                continue;
            }
            best = Some(match best {
                None => q,
                Some(b) => match sess.side {
                    Side::Buy => {
                        if q.price < b.price { q } else { b }
                    }
                    Side::Sell => {
                        if q.price > b.price { q } else { b }
                    }
                },
            });
        }
        best
    }

    /// Execute a dealer's live quote atomically. Returns the execution (with
    /// dealer hedge plan) for the trading engine to settle.
    pub fn execute(
        &mut self,
        id: u64,
        dealer: &str,
        now_ms: u64,
        hedge: Vec<RouteChild>,
        hedge_vwap: f64,
    ) -> Result<RfqExecution, String> {
        let sess = self
            .sessions
            .get_mut(&id)
            .ok_or_else(|| "rfq session not found".to_string())?;
        if sess.state != RfqState::Quoting {
            return Err("session is not quotable".into());
        }
        // find + verify the dealer's current live quote
        let idx = sess
            .quotes
            .iter()
            .rposition(|q| q.dealer == dealer)
            .ok_or_else(|| format!("dealer {dealer} has not quoted"))?;
        if sess.quotes[idx].status != QuoteStatus::Live || now_ms > sess.quotes[idx].valid_until_ms {
            return Err("quote is not live".into());
        }
        let q = sess.quotes[idx].clone();
        // mark this filled, all others cancelled-expired
        for qq in sess.quotes.iter_mut() {
            if qq.status == QuoteStatus::Live || qq.status == QuoteStatus::Pending {
                qq.status = if qq.seq == q.seq { QuoteStatus::Filled } else { QuoteStatus::Expired };
            }
        }
        let fee = q.price.abs() * sess.size * q.fee_bps / 10_000.0;
        // dealer inventory: they take the opposite side of the taker
        let dealer_delta = -sess.package_delta * sess.side.sign() as f64 * sess.size;
        *self
            .inventories
            .entry(format!("{}|{}", q.dealer, sess.underlying))
            .or_insert(0.0) += dealer_delta;
        // mean-revert all inventories slightly toward zero
        for v in self.inventories.values_mut() {
            *v *= 0.995;
        }
        let exec = RfqExecution {
            dealer: q.dealer,
            venue: q.venue,
            price: q.price,
            fee,
            filled_ms: now_ms,
            hedge,
            hedge_vwap,
        };
        sess.state = RfqState::Executed;
        sess.execution = Some(exec.clone());
        Ok(exec)
    }

    pub fn cancel(&mut self, id: u64) -> Result<(), String> {
        let sess = self
            .sessions
            .get_mut(&id)
            .ok_or_else(|| "rfq session not found".to_string())?;
        if sess.state != RfqState::Quoting {
            return Err("session already finished".into());
        }
        sess.state = RfqState::Cancelled;
        for q in sess.quotes.iter_mut() {
            if q.status == QuoteStatus::Live || q.status == QuoteStatus::Pending {
                q.status = QuoteStatus::Expired;
            }
        }
        Ok(())
    }

    /// Drop finished sessions older than 10 minutes to bound memory.
    pub fn gc(&mut self, now_ms: u64) {
        self.sessions
            .retain(|_, s| s.state == RfqState::Quoting || now_ms < s.created_ms + 600_000);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leg() -> ValidLeg {
        ValidLeg {
            kind: crate::models::LegKind::PerpOption,
            side: crate::models::Side::Buy,
            qty: 1.0,
            strike: Some(95_000.0),
            expiry_days: None,
            funding_period_days: 7.0,
        }
    }

    #[test]
    fn quotes_arrive_expire_and_execute() {
        let mut book = RfqBook::new();
        let id = book.create("BTC".into(), vec![leg()], Side::Buy, 1.0, 5_000.0, 0.45, "h".into(), 0);
        // before latency: nothing live
        book.poll(id, 100, 5_000.0);
        assert!(book.best_quote(id, 100).is_none());
        // after max dealer latency: all live
        book.poll(id, 1_500, 5_000.0);
        let best = book.best_quote(id, 1_500).expect("quotes live").clone();
        assert!(best.price > 5_000.0, "buy package = debit above theo");
        // execute
        let exec = book.execute(id, best.dealer, 1_600, vec![], 0.0).unwrap();
        assert!(exec.price > 0.0);
        assert_eq!(book.sessions[&id].state, RfqState::Executed);
        // second execution rejected
        assert!(book.execute(id, best.dealer, 1_700, vec![], 0.0).is_err());
    }

    #[test]
    fn dealer_pulls_on_market_move() {
        let mut book = RfqBook::new();
        let id = book.create("BTC".into(), vec![leg()], Side::Sell, 1.0, 5_000.0, -0.4, "h".into(), 0);
        book.poll(id, 1_500, 5_000.0);
        // theo jumps +1% (> 45 bps pull threshold)
        book.poll(id, 2_000, 5_050.0);
        let sess = &book.sessions[&id];
        assert!(sess
            .quotes
            .iter()
            .any(|q| q.status == QuoteStatus::Pulled));
    }
}

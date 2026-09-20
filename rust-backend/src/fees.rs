//! Fee schedule + economic-equilibrium parameters.
//!
//! Equilibrium design (maker-taker balance):
//! * Takers pay `TAKER_FEE_BPS` for immediacy; the fee must cover the
//!   adverse-selection + inventory-carry cost a maker bears when filled.
//! * Makers receive `MAKER_REBATE_BPS` (net edge = spread/2 − rebate ≥ 0),
//!   keeping quoting profitable at tight spreads.
//! * Perp-option MM quoting bands include an inventory skew: quotes shift
//!   by −inventory × κ so flow mean-reverts dealer inventory — this is what
//!   keeps the book "in equilibrium" rather than trending inventory.
//!
//! Numbers chosen so a 2·edge spread with edge = 6 bps of theo covers the
//! expected adverse selection per fill (~4 bps) plus carry (~1 bp) with a
//! positive but competitive maker margin — the classic CLOB equilibrium.

use crate::clob::Instrument;
use serde::Serialize;

pub const TAKER_FEE_BPS: f64 = 3.0; // 0.03% of notional
pub const MAKER_REBATE_BPS: f64 = 1.5; // paid to makers on notional
/// Inventory skew coefficient: quote shift (in price units) per unit of
/// inventory per unit of theo.
pub const INVENTORY_SKEW: f64 = 0.04;
/// Buffer added on top of worst-case portfolio stress loss.
pub const MARGIN_BUFFER: f64 = 1.10;
/// Maintenance margin ratio (equity / margin must stay above this).
pub const MAINTENANCE_RATIO: f64 = 1.10;
/// Simulated funding period for perp options (wall-clock seconds per period).
pub const FUNDING_PERIOD_SECS: u64 = 45;

#[inline]
pub fn taker_fee(_inst: &Instrument, notional: f64) -> f64 {
    notional * TAKER_FEE_BPS / 10_000.0
}

#[inline]
pub fn maker_rebate(_inst: &Instrument, notional: f64) -> f64 {
    notional * MAKER_REBATE_BPS / 10_000.0
}

/// External venue fee profiles used by the smart order router.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueFees {
    pub venue: &'static str,
    pub taker_fee_bps: f64,
    pub maker_rebate_bps: f64,
    pub taker_rebate: bool,
}

pub const VENUE_FEES: [VenueFees; 4] = [
    VenueFees { venue: "Volos CLOB", taker_fee_bps: TAKER_FEE_BPS, maker_rebate_bps: MAKER_REBATE_BPS, taker_rebate: false },
    VenueFees { venue: "Derive", taker_fee_bps: 3.0, maker_rebate_bps: 1.0, taker_rebate: false },
    VenueFees { venue: "Paradex", taker_fee_bps: 2.5, maker_rebate_bps: 0.5, taker_rebate: false },
    VenueFees { venue: "Paradigm", taker_fee_bps: 0.0, maker_rebate_bps: 0.0, taker_rebate: true }, // RFQ: fee inside quote
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeSchedule {
    pub taker_fee_bps: f64,
    pub maker_rebate_bps: f64,
    pub inventory_skew: f64,
    pub margin_buffer: f64,
    pub maintenance_ratio: f64,
    pub collateral_currencies: [&'static str; 1],
    pub venues: [VenueFees; 4],
    pub notes: Vec<&'static str>,
}

pub fn schedule() -> FeeSchedule {
    FeeSchedule {
        taker_fee_bps: TAKER_FEE_BPS,
        maker_rebate_bps: MAKER_REBATE_BPS,
        inventory_skew: INVENTORY_SKEW,
        margin_buffer: MARGIN_BUFFER,
        maintenance_ratio: MAINTENANCE_RATIO,
        collateral_currencies: ["USDC"],
        venues: VENUE_FEES,
        notes: vec![
            "Taker fee covers adverse selection + inventory carry; maker rebate keeps 2×6bp spreads profitable.",
            "Perp-option makers skew quotes by −inventory × κ, so taker flow mean-reverts dealer inventory.",
            "Margin = worst-case portfolio stress loss (±20% spot, ±10 vol pts) × 1.10 buffer; spread-netted.",
            "Everlasting funding: longs pay shorts (mark − intrinsic) each funding period.",
        ],
    }
}

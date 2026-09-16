//! Strategy-level RFQ quote simulation: multiple market makers return
//! package prices for the entire structure, atomically settleable.

use crate::models::AnalyzeResponse;
use rand::Rng;

pub struct MakerQuote {
    pub maker: &'static str,
    pub net_price: f64,   // package price (debit positive)
    pub size: f64,
    pub valid_seconds: u32,
    pub venue: &'static str,
    pub fee_bps: f64,
}

const MAKERS: [(&str, &str, f64); 5] = [
    // (name, venue, typical half-spread bps of theoretical)
    ("Wintermute", "Derive", 28.0),
    ("GSR", "Paradex", 34.0),
    ("Amber Group", "Deribit", 41.0),
    ("QCP Capital", "Paradigm RFQ", 47.0),
    ("DP2C", "Derive", 55.0),
];

pub fn quote_for(analysis: &AnalyzeResponse) -> Vec<MakerQuote> {
    let theoretical = analysis.net_premium; // per current size
    let mut rng = rand::thread_rng();
    let mut out = Vec::with_capacity(MAKERS.len());
    for (name, venue, spread_bps) in MAKERS.iter() {
        let jitter: f64 = rng.gen::<f64>() * 2.0 - 1.0;
        let half = spread_bps / 10_000.0;
        let skew = 1.0 + jitter * half;
        let net = theoretical * skew + jitter * theoretical.abs() * 0.0015;
        out.push(MakerQuote {
            maker: name,
            net_price: net,
            size: analysis.size,
            valid_seconds: 8,
            venue,
            fee_bps: 3.0 + rng.gen::<f64>() * 5.0,
        });
    }
    out.sort_by(|a, b| a.net_price.partial_cmp(&b.net_price).unwrap_or(std::cmp::Ordering::Equal));
    out
}

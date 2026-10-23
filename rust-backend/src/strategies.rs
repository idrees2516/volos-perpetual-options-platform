//! Strategy catalog: 131 pre-built strategies (1..=25 legs) shared with the
//! frontend through a single JSON source of truth (`strategies.json`).
//!
//! Each entry is defined *parametrically*: strikes are multipliers of live
//! spot, so every strategy resolves to tradable strikes on any underlying
//! (BTC / ETH / SOL). The catalog covers seven families — direction, income,
//! volatility, protection, spread, perpetual-native and multi-leg monsters
//! up to the platform maximum of 25 legs.

use crate::models::{LegInput, LegKind, Side};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub const MAX_LEGS: usize = crate::models::MAX_LEGS;
const STRATEGIES_JSON: &str = include_str!("../strategies.json");

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyLegSpec {
    pub kind: LegKind,
    pub side: Side,
    pub qty: f64,
    /// Strike as a multiplier of live spot (e.g. 1.10 => 10% OTM).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strike: Option<f64>,
    /// Days to expiry for dated legs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiry_days: Option<f64>,
    /// Funding period (days) for everlasting legs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub funding_period_days: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategySpec {
    pub id: String,
    pub name: String,
    /// direction | income | volatility | protection | spread | perpetual | multileg
    pub category: String,
    /// bullish | bearish | neutral | volatile | low-vol
    pub view: String,
    /// 1 (simple) ..= 5 (monster).
    pub complexity: u8,
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub legs: Vec<StrategyLegSpec>,
}

#[allow(dead_code)]
impl StrategySpec {
    pub fn leg_count(&self) -> usize {
        self.legs.len()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogFile {
    strategies: Vec<StrategySpec>,
    #[serde(default)]
    max_legs: usize,
}

/// The parsed global catalog. Parsed exactly once; malformed data is a
/// compile/startup invariant and panics loudly in tests.
pub fn catalog() -> &'static [StrategySpec] {
    static CAT: OnceLock<Vec<StrategySpec>> = OnceLock::new();
    CAT.get_or_init(|| {
        let file: CatalogFile = serde_json::from_str(STRATEGIES_JSON)
            .expect("strategies.json is malformed — regenerate with scripts/gen_strategies.py");
        assert_eq!(
            file.max_legs, MAX_LEGS,
            "strategies.json maxLegs must match models::MAX_LEGS"
        );
        file.strategies
    })
}

pub fn find(id: &str) -> Option<&'static StrategySpec> {
    catalog().iter().find(|s| s.id == id)
}

/// Tradable strike step for an asset given its spot (mirrors the frontend
/// step ladder so resolved strategies land on the same grid everywhere).
pub fn strike_step(spot: f64) -> f64 {
    if spot >= 50_000.0 {
        500.0
    } else if spot >= 4_000.0 {
        50.0
    } else if spot >= 400.0 {
        5.0
    } else if spot >= 40.0 {
        0.5
    } else {
        0.05
    }
}

fn snap(spot: f64, mult: f64) -> f64 {
    let step = strike_step(spot);
    ((spot * mult) / step).round() * step
}

/// Resolve a strategy spec against live spot: multipliers become snapped
/// absolute strikes. Output is a plain `LegInput` list ready for the same
/// validation path as builder-defined strategies (1..=25 legs enforced).
pub fn resolve(spec: &StrategySpec, spot: f64) -> Vec<LegInput> {
    spec.legs
        .iter()
        .map(|l| LegInput {
            kind: l.kind,
            side: l.side,
            qty: l.qty,
            strike: l.strike.map(|m| snap(spot, m)),
            expiry_days: l.expiry_days,
            funding_period_days: l.funding_period_days,
        })
        .collect()
}

/// Catalog summary metadata for the library UI (counts per category/view).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMeta {
    pub total: usize,
    pub max_legs: usize,
    pub categories: Vec<(String, usize)>,
    pub leg_histogram: Vec<(usize, usize)>,
}

pub fn meta() -> CatalogMeta {
    let specs = catalog();
    let mut cats: std::collections::BTreeMap<String, usize> = Default::default();
    let mut hist: std::collections::BTreeMap<usize, usize> = Default::default();
    for s in specs {
        *cats.entry(s.category.clone()).or_default() += 1;
        *hist.entry(s.legs.len()).or_default() += 1;
    }
    CatalogMeta {
        total: specs.len(),
        max_legs: MAX_LEGS,
        categories: cats.into_iter().collect(),
        leg_histogram: hist.into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPOTS: [f64; 3] = [65_000.0, 3_200.0, 148.0];

    #[test]
    fn catalog_has_at_least_100_strategies() {
        assert!(catalog().len() >= 100, "catalog too small: {}", catalog().len());
    }

    #[test]
    fn ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for s in catalog() {
            assert!(seen.insert(s.id.clone()), "duplicate id {}", s.id);
        }
    }

    #[test]
    fn leg_counts_within_bounds_and_big_strategies_exist() {
        let mut big10 = 0;
        let mut big20 = 0;
        for s in catalog() {
            assert!(
                !s.legs.is_empty() && s.legs.len() <= MAX_LEGS,
                "{} has {} legs",
                s.id,
                s.legs.len()
            );
            if s.legs.len() >= 10 {
                big10 += 1;
            }
            if s.legs.len() >= 20 {
                big20 += 1;
            }
        }
        assert!(big10 >= 8, "need >= 8 strategies with 10+ legs, got {big10}");
        assert!(big20 >= 4, "need >= 4 strategies with 20+ legs, got {big20}");
        // The 25-leg showcase must exist and hit the cap exactly.
        assert!(
            catalog().iter().any(|s| s.legs.len() == MAX_LEGS),
            "no strategy uses the full 25-leg cap"
        );
    }

    #[test]
    fn every_strategy_resolves_and_validates_on_all_assets() {
        use crate::models::AnalyzeRequest;
        for &spot in SPOTS.iter() {
            for s in catalog() {
                let legs = resolve(s, spot);
                let req = AnalyzeRequest {
                    underlying: "BTC".to_string(),
                    legs,
                    size: Some(1.0),
                };
                req.validate(spot).unwrap_or_else(|e| {
                    panic!("strategy {} failed validation at spot {spot}: {e}", s.id)
                });
            }
        }
    }

    #[test]
    fn resolve_snaps_to_grid() {
        let spec = find("bull-call-spread").expect("bull-call-spread missing");
        for &spot in SPOTS.iter() {
            let legs = resolve(spec, spot);
            let step = strike_step(spot);
            for l in legs.iter() {
                let k = l.strike.expect("strike resolved");
                assert!((k / step).fract().abs() < 1e-9, "strike {k} off {step} grid");
                assert!(k > 0.0);
            }
        }
    }

    #[test]
    fn categories_and_views_are_sane() {
        let cats = ["direction", "income", "volatility", "protection", "spread", "perpetual", "multileg"];
        let views = ["bullish", "bearish", "neutral", "volatile", "low-vol"];
        for s in catalog() {
            assert!(cats.contains(&s.category.as_str()), "{} bad category", s.id);
            assert!(views.contains(&s.view.as_str()), "{} bad view", s.id);
            assert!((1..=5).contains(&s.complexity), "{} bad complexity", s.id);
            assert!(s.description.len() >= 40, "{} description too short", s.id);
        }
    }
}

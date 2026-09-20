//! Request/response models with strict validation. Every numeric field is
//! checked for finiteness and clamped/rejected before it reaches the math.

use serde::{Deserialize, Serialize};

pub const MAX_LEGS: usize = 25;
pub const MAX_QTY: f64 = 10_000.0;
pub const MAX_EXPIRY_DAYS: f64 = 730.0;
pub const MAX_FUNDING_PERIOD_DAYS: f64 = 60.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegKind {
    Call,
    Put,
    /// Everlasting / perpetual option (no expiry, funding-based).
    PerpOption,
    /// Perpetual future.
    Perp,
    /// Spot.
    Spot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    #[inline]
    pub fn sign(&self) -> f64 {
        match self {
            Side::Buy => 1.0,
            Side::Sell => -1.0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegInput {
    pub kind: LegKind,
    pub side: Side,
    pub qty: f64,
    #[serde(default, alias = "strike")]
    pub strike: Option<f64>,
    /// Days to expiry for dated legs. None => use perpetual horizon.
    #[serde(default, alias = "expiry_days")]
    pub expiry_days: Option<f64>,
    /// Funding period in days for everlasting options.
    #[serde(default, alias = "funding_period_days")]
    pub funding_period_days: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeRequest {
    pub underlying: String,
    pub legs: Vec<LegInput>,
    /// Position size multiplier applied to all legs.
    #[serde(default)]
    pub size: Option<f64>,
}

#[derive(Debug)]
pub struct ValidationError(pub String);

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "validation error: {}", self.0)
    }
}

fn check_finite(v: f64, name: &str) -> Result<f64, ValidationError> {
    if !v.is_finite() {
        Err(ValidationError(format!("{name} must be finite")))
    } else {
        Ok(v)
    }
}

/// Fully validated leg, ready for the analytics engine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidLeg {
    pub kind: LegKind,
    pub side: Side,
    pub qty: f64,
    pub strike: Option<f64>,
    pub expiry_days: Option<f64>,
    pub funding_period_days: f64,
}

impl AnalyzeRequest {
    pub fn validate(&self, spot: f64) -> Result<(Vec<ValidLeg>, f64), ValidationError> {
        let underlying = self.underlying.trim().to_uppercase();
        if !crate::surface::ASSETS.contains(&underlying.as_str()) {
            return Err(ValidationError(format!(
                "underlying must be one of {:?}",
                crate::surface::ASSETS
            )));
        }
        if self.legs.is_empty() || self.legs.len() > MAX_LEGS {
            return Err(ValidationError(format!(
                "legs must contain between 1 and {MAX_LEGS} entries"
            )));
        }
        let size = self.size.unwrap_or(1.0);
        let size = check_finite(size, "size")?;
        if size <= 0.0 || size > 10_000.0 {
            return Err(ValidationError("size must be in (0, 10000]".into()));
        }
        let mut out = Vec::with_capacity(self.legs.len());
        for (i, leg) in self.legs.iter().enumerate() {
            let qty = check_finite(leg.qty, &format!("legs[{i}].qty"))?;
            if qty <= 0.0 || qty > MAX_QTY {
                return Err(ValidationError(format!(
                    "legs[{i}].qty must be in (0, {MAX_QTY}]"
                )));
            }
            let mut strike = None;
            if matches!(leg.kind, LegKind::Call | LegKind::Put | LegKind::PerpOption) {
                let raw = leg.strike.ok_or_else(|| {
                    ValidationError(format!("legs[{i}].strike is required for {:?}", leg.kind))
                })?;
                let raw = check_finite(raw, &format!("legs[{i}].strike"))?;
                if raw <= 0.0 {
                    return Err(ValidationError(format!(
                        "legs[{i}].strike must be positive"
                    )));
                }
                let lo = spot * 0.02;
                let hi = spot * 25.0;
                if raw < lo || raw > hi {
                    return Err(ValidationError(format!(
                        "legs[{i}].strike {raw} outside tradable range [{lo:.2}, {hi:.2}]"
                    )));
                }
                strike = Some(raw);
            }
            let mut expiry_days = None;
            if let Some(d) = leg.expiry_days {
                let d = check_finite(d, &format!("legs[{i}].expiry_days"))?;
                if d <= 0.0 || d > MAX_EXPIRY_DAYS {
                    return Err(ValidationError(format!(
                        "legs[{i}].expiry_days must be in (0, {MAX_EXPIRY_DAYS}]"
                    )));
                }
                expiry_days = Some(d);
            }
            if matches!(leg.kind, LegKind::Call | LegKind::Put) && expiry_days.is_none() {
                return Err(ValidationError(format!(
                    "legs[{i}].expiry_days is required for dated {:?}",
                    leg.kind
                )));
            }
            let fp = leg.funding_period_days.unwrap_or(7.0);
            let fp = check_finite(fp, &format!("legs[{i}].funding_period_days"))?;
            if fp < 0.25 || fp > MAX_FUNDING_PERIOD_DAYS {
                return Err(ValidationError(format!(
                    "legs[{i}].funding_period_days must be in [0.25, {MAX_FUNDING_PERIOD_DAYS}]"
                )));
            }
            out.push(ValidLeg {
                kind: leg.kind,
                side: leg.side,
                qty,
                strike,
                expiry_days,
                funding_period_days: fp,
            });
        }
        Ok((out, size))
    }
}

// ---------- Response shapes (camelCase for the TS client) ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegAnalytics {
    pub id: usize,
    pub kind: LegKind,
    pub side: Side,
    pub qty: f64,
    pub strike: Option<f64>,
    pub expiry_days: Option<f64>,
    pub funding_period_days: Option<f64>,
    pub iv: Option<f64>,
    pub price: f64,
    pub delta: f64,
    pub gamma: f64,
    pub vega: f64,
    pub theta: f64,
    pub rho: f64,
    pub cost: f64, // signed cash flow (buy = negative)
    pub liquidity: f64,
    pub funding_per_day: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurvePayload {
    pub label: &'static str,
    pub pnl: Vec<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extreme {
    pub kind: &'static str, // "value" | "unlimited"
    pub value: Option<f64>,
    pub at_price: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryScenario {
    pub label: String,
    pub carry_7d: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryBudget {
    pub daily_carry: f64,
    pub weekly_carry: f64,
    pub monthly_carry: f64,
    pub scenarios: Vec<CarryScenario>,
    pub hard_budget: Option<f64>,
    pub budget_remaining: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeResponse {
    pub underlying: String,
    pub spot: f64,
    pub atm_iv_30d: f64,
    pub size: f64,
    pub legs: Vec<LegAnalytics>,
    pub curves: Vec<CurvePayload>,
    pub spot_axis: Vec<f64>,
    pub net_premium: f64,
    pub net_credit: bool,
    pub max_profit: Extreme,
    pub max_loss: Extreme,
    pub breakevens: Vec<f64>,
    pub pop: f64,
    pub expected_value: f64,
    pub risk_reward: Option<f64>,
    pub greeks: GreeksPayload,
    pub carry: Option<CarryBudget>,
    pub liquidity: f64,
    pub margin_estimate: f64,
    pub scenario_matrix: ScenarioMatrix,
    pub diagnostics: Diagnostics,
    pub quote_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GreeksPayload {
    pub delta: f64,
    pub gamma: f64,
    pub vega: f64,
    pub theta: f64,
    pub rho: f64,
    pub delta_exposure_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioMatrix {
    pub spot_shocks: Vec<f64>,
    pub iv_shocks: Vec<f64>,
    /// Row-major [iv][spot] P&L values (instantaneous revaluation).
    pub pnl: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub engine: &'static str,
    pub compute_us: u128,
    pub server_version: &'static str,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainRow {
    pub strike: f64,
    pub call_iv: f64,
    pub call_price: f64,
    pub call_delta: f64,
    pub call_oi: f64,
    pub call_volume: f64,
    pub put_iv: f64,
    pub put_price: f64,
    pub put_delta: f64,
    pub put_oi: f64,
    pub put_volume: f64,
    pub is_atm: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainResponse {
    pub underlying: String,
    pub expiry_days: f64,
    pub spot: f64,
    pub forward: f64,
    pub atm_iv: f64,
    pub rows: Vec<ChainRow>,
    pub compute_us: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfacePoint {
    pub strike: f64,
    #[serde(rename = "T")]
    pub t_days: f64,
    pub iv: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceResponse {
    pub underlying: String,
    pub spot: f64,
    pub tenors_days: Vec<f64>,
    pub points: Vec<SurfacePoint>,
    pub atm_term_structure: Vec<(f64, f64)>, // (days, iv)
    pub compute_us: u128,
}

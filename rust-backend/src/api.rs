//! HTTP API layer: routes, handlers, SSE stream.

use crate::compiler::{self, IntentRequest, IntentResponse};
use crate::market::{MarketSnapshot, SharedSim};
use crate::models::*;
use crate::payoff::{self, MarketCtx};
use crate::quotes;
use crate::surface::{asset_config, forward, ASSETS};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use serde::Serialize;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

pub struct AppState {
    pub sim: SharedSim,
    pub tx: broadcast::Sender<String>,
}

pub type SharedState = Arc<AppState>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QuoteResponse {
    quote_id: String,
    underlying: String,
    strategy_hash: String,
    theoretical_net: f64,
    quotes: Vec<MakerQuoteDto>,
    settlement: &'static str,
    compute_us: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MakerQuoteDto {
    maker: &'static str,
    venue: &'static str,
    net_price: f64,
    size: f64,
    valid_seconds: u32,
    fee_bps: f64,
    improvement_bps: f64,
}

pub fn router(state: SharedState) -> axum::Router {
    axum::Router::new()
        .route("/health", axum::routing::get(health))
        .route("/api/v1/market/snapshot", axum::routing::get(market_snapshot))
        .route("/api/v1/market/stream", axum::routing::get(market_stream))
        .route("/api/v1/options/chain", axum::routing::get(option_chain))
        .route("/api/v1/vol/surface", axum::routing::get(vol_surface))
        .route("/api/v1/strategy/analyze", axum::routing::post(analyze))
        .route("/api/v1/strategy/quote", axum::routing::post(strategy_quote))
        .route("/api/v1/intent/compile", axum::routing::post(intent_compile))
        .layer(axum::middleware::from_fn(crate::security::rate_limit_mw))
        .layer(axum::middleware::from_fn(crate::security::security_headers_mw))
        .with_state(state)
}

fn err_json(status: StatusCode, msg: String) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(serde_json::json!({ "error": status.as_str(), "message": msg })))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "engine": "volos-rust",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

fn current_ctx(state: &AppState, underlying: &str) -> Result<MarketCtx, String> {
    let u = underlying.trim().to_uppercase();
    if !ASSETS.contains(&u.as_str()) {
        return Err(format!("underlying must be one of {ASSETS:?}"));
    }
    let snap = state.sim.lock().unwrap().snapshot();
    let st = snap
        .assets
        .get(&u)
        .cloned()
        .ok_or_else(|| "underlying not found".to_string())?;
    Ok(MarketCtx { cfg: asset_config(&u), state: st, underlying: u })
}

async fn market_snapshot(State(state): State<SharedState>) -> Json<MarketSnapshot> {
    let snap = state.sim.lock().unwrap().snapshot();
    Json(snap)
}

async fn market_stream(
    State(state): State<SharedState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.tx.subscribe();
    let stream = BroadcastStream::new(rx).map(|msg| {
        let data = match msg {
            Ok(d) => d,
            Err(_) => "{}".to_string(),
        };
        Ok::<Event, Infallible>(Event::default().data(data))
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(3)))
}

#[derive(serde::Deserialize)]
struct ChainQuery {
    underlying: Option<String>,
    expiry_days: Option<f64>,
}

async fn option_chain(
    State(state): State<SharedState>,
    axum::extract::Query(q): axum::extract::Query<ChainQuery>,
) -> Result<Json<ChainResponse>, (StatusCode, Json<serde_json::Value>)> {
    let started = std::time::Instant::now();
    let underlying = q.underlying.as_deref().unwrap_or("BTC").trim().to_uppercase();
    let ctx = map_err(current_ctx(&state, &underlying))?;
    let expiry_days = q.expiry_days.unwrap_or(30.0);
    if !expiry_days.is_finite() || expiry_days < 0.5 || expiry_days > 730.0 {
        return Err(err_json(StatusCode::BAD_REQUEST, "expiry_days must be in [0.5, 730]".into()));
    }
    let t = expiry_days / crate::pricing::DAYS_PER_YEAR;
    let f = forward(&ctx.cfg, ctx.state.spot, t);
    // Strikes: +/- 30% around forward in tradable steps.
    let step = if f >= 50_000.0 {
        1000.0
    } else if f >= 5_000.0 {
        100.0
    } else if f >= 500.0 {
        5.0
    } else {
        1.0
    };
    let mut strikes: Vec<f64> = Vec::new();
    let lo = (f * 0.7 / step).floor() * step;
    let hi = (f * 1.3 / step).ceil() * step;
    let mut k = lo;
    while k <= hi + 1e-9 {
        strikes.push(k);
        k += step;
    }
    let mut rows = Vec::with_capacity(strikes.len());
    for k in strikes {
        let call_iv = ctx.iv_at(k, t);
        let put_iv = ctx.iv_at(k, t);
        let cg = crate::pricing::bs_greeks(ctx.state.spot, k, t, call_iv, ctx.cfg.rate, crate::pricing::OptionType::Call);
        let pg = crate::pricing::bs_greeks(ctx.state.spot, k, t, put_iv, ctx.cfg.rate, crate::pricing::OptionType::Put);
        let liq = payoff::leg_liquidity(&ctx, k, t);
        rows.push(ChainRow {
            strike: k,
            call_iv: call_iv * 100.0,
            call_price: cg.price,
            call_delta: cg.delta,
            call_oi: (liq * 137.0 + 40.0) * 10.0,
            call_volume: (liq * 61.0 + 12.0) * 3.0,
            put_iv: put_iv * 100.0,
            put_price: pg.price,
            put_delta: pg.delta,
            put_oi: (liq * 121.0 + 35.0) * 10.0,
            put_volume: (liq * 54.0 + 10.0) * 3.0,
            is_atm: (k - f).abs() < step * 0.5,
        });
    }
    Ok(Json(ChainResponse {
        underlying,
        expiry_days,
        spot: ctx.state.spot,
        forward: f,
        atm_iv: ctx.atm_iv(t) * 100.0,
        rows,
        compute_us: started.elapsed().as_micros(),
    }))
}

#[derive(serde::Deserialize)]
struct SurfaceQuery {
    underlying: Option<String>,
}

async fn vol_surface(
    State(state): State<SharedState>,
    axum::extract::Query(q): axum::extract::Query<SurfaceQuery>,
) -> Result<Json<SurfaceResponse>, (StatusCode, Json<serde_json::Value>)> {
    let started = std::time::Instant::now();
    let underlying = q.underlying.as_deref().unwrap_or("BTC").trim().to_uppercase();
    let ctx = map_err(current_ctx(&state, &underlying))?;
    let tenors: Vec<f64> = vec![1.0, 7.0, 14.0, 30.0, 60.0, 90.0, 180.0, 365.0];
    let mut points = Vec::new();
    let mut atm_ts = Vec::new();
    for &d in tenors.iter() {
        let t = d / crate::pricing::DAYS_PER_YEAR;
        let f = forward(&ctx.cfg, ctx.state.spot, t);
        atm_ts.push((d, ctx.atm_iv(t) * 100.0));
        for &m in [-0.3_f64, -0.2, -0.1, -0.05, 0.0, 0.05, 0.1, 0.2, 0.3].iter() {
            let k = f * m.exp();
            points.push(SurfacePoint { strike: k, t_days: d, iv: ctx.iv_at(k, t) * 100.0 });
        }
    }
    Ok(Json(SurfaceResponse {
        underlying,
        spot: ctx.state.spot,
        tenors_days: tenors,
        points,
        atm_term_structure: atm_ts,
        compute_us: started.elapsed().as_micros(),
    }))
}

async fn analyze(
    State(state): State<SharedState>,
    Json(req): Json<AnalyzeRequest>,
) -> Result<Json<AnalyzeResponse>, (StatusCode, Json<serde_json::Value>)> {
    let ctx = map_err(current_ctx(&state, &req.underlying))?;
    let (legs, size) = map_err(req.validate(ctx.state.spot))?;
    let mut resp = payoff::analyze(&legs, size, &ctx);
    let theory = resp.net_premium;
    let _ = theory;
    if resp.diagnostics.notes.is_empty() {
        resp.diagnostics.notes = vec![
            "Deterministic pricing engine: BS-76 style with SVI surface.".into(),
            "Everlasting legs priced via the Paradigm equivalent-portfolio method.".into(),
        ];
    }
    Ok(Json(resp))
}

async fn strategy_quote(
    State(state): State<SharedState>,
    Json(req): Json<AnalyzeRequest>,
) -> Result<Json<QuoteResponse>, (StatusCode, Json<serde_json::Value>)> {
    let started = std::time::Instant::now();
    let ctx = map_err(current_ctx(&state, &req.underlying))?;
    let (legs, size) = map_err(req.validate(ctx.state.spot))?;
    let analysis = payoff::analyze(&legs, size, &ctx);
    let qs = quotes::quote_for(&analysis);
    let theoretical = analysis.net_premium;
    let dtos = qs
        .iter()
        .map(|q| MakerQuoteDto {
            maker: q.maker,
            venue: q.venue,
            net_price: q.net_price,
            size: q.size,
            valid_seconds: q.valid_seconds,
            fee_bps: q.fee_bps,
            improvement_bps: if theoretical.abs() > 1e-9 {
                (theoretical - q.net_price) / theoretical.abs() * 10_000.0
            } else {
                0.0
            },
        })
        .collect();
    let strategy_hash = {
        use std::fmt::Write;
        let mut s = String::new();
        for l in legs.iter() {
            let _ = write!(
                s,
                "{:?}|{:?}|{}|{:?}|{:?}|{:?};",
                l.kind, l.side, l.qty, l.strike, l.expiry_days, l.funding_period_days
            );
        }
        format!("{:016x}", fnv1a(s.as_bytes()))
    };
    Ok(Json(QuoteResponse {
        quote_id: format!("rfq-{:x}", fnv1a(strategy_hash.as_bytes())),
        underlying: req.underlying.trim().to_uppercase(),
        strategy_hash,
        theoretical_net: theoretical,
        quotes: dtos,
        settlement: "atomic package — all legs settle or the block is rejected",
        compute_us: started.elapsed().as_micros(),
    }))
}

async fn intent_compile(
    State(state): State<SharedState>,
    Json(req): Json<IntentRequest>,
) -> Result<Json<IntentResponse>, (StatusCode, Json<serde_json::Value>)> {
    map_err(req.validate())?;
    let snap = state.sim.lock().unwrap().snapshot();
    Ok(Json(compiler::compile(&req, &snap)))
}

fn map_err<T, E: std::fmt::Display>(r: Result<T, E>) -> Result<T, (StatusCode, Json<serde_json::Value>)> {
    r.map_err(|e| err_json(StatusCode::BAD_REQUEST, e.to_string()))
}

/// FNV-1a 64-bit for stable non-crypto hashes of strategy definitions.
fn fnv1a(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

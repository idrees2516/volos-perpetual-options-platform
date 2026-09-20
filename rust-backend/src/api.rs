//! HTTP API layer: analytics, strategy catalog, CLOB trading, strategy RFQ,
//! multi-venue routing, risk and fees. REST + SSE.

use crate::clob::{self, Order, OrderKind, Side, StpPolicy, Trade};
use crate::market::{MarketSnapshot, SharedSim};
use crate::models::*;
use crate::payoff::{self, MarketCtx};
use crate::quotes;
use crate::risk;
use crate::rfqs;
use crate::strategies::{self, StrategySpec};
use crate::trading::{self, L1Dto, TradingEngine};
use crate::venues::{SharedLive, VenuePool};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::compiler::{self, IntentRequest, IntentResponse};
use crate::surface::{asset_config, forward, ASSETS};

/// The default taker account used by the terminal.
pub const DEMO_ACCOUNT: &str = "demo";

pub struct AppState {
    pub sim: SharedSim,
    pub tx: broadcast::Sender<String>,
    pub trading: SharedTrading,
    pub live: SharedLive,
    pub engine_tx: broadcast::Sender<String>,
}

pub type SharedState = Arc<AppState>;
pub type SharedTrading = Arc<Mutex<TradingEngine>>;

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
        // ---- health + market data
        .route("/health", axum::routing::get(health))
        .route("/api/v1/market/snapshot", axum::routing::get(market_snapshot))
        .route("/api/v1/market/stream", axum::routing::get(market_stream))
        .route("/api/v1/options/chain", axum::routing::get(option_chain))
        .route("/api/v1/vol/surface", axum::routing::get(vol_surface))
        // ---- strategy analytics + catalog (118 strategies, <=25 legs)
        .route("/api/v1/strategy/analyze", axum::routing::post(analyze))
        .route("/api/v1/strategy/quote", axum::routing::post(strategy_quote))
        .route("/api/v1/intent/compile", axum::routing::post(intent_compile))
        .route("/api/v1/strategies", axum::routing::get(strategy_catalog))
        .route(
            "/api/v1/strategies/{id}/resolve",
            axum::routing::get(strategy_resolve),
        )
        // ---- CLOB trading engine
        .route("/api/v1/trading/state", axum::routing::get(trading_state))
        .route("/api/v1/trading/instruments", axum::routing::get(trading_instruments))
        .route("/api/v1/trading/book", axum::routing::get(trading_book))
        .route("/api/v1/trading/order", axum::routing::post(place_order))
        .route("/api/v1/trading/order/amend", axum::routing::post(amend_order))
        .route("/api/v1/trading/order/cancel", axum::routing::post(cancel_order))
        .route("/api/v1/trading/order/cancel-all", axum::routing::post(cancel_all))
        .route("/api/v1/trading/orders", axum::routing::get(open_orders))
        .route("/api/v1/trading/tape", axum::routing::get(trade_tape))
        .route("/api/v1/trading/stream", axum::routing::get(trading_stream))
        // ---- strategy-level RFQ (up to 25 legs)
        .route("/api/v1/rfq", axum::routing::post(rfq_create))
        .route("/api/v1/rfq/{id}", axum::routing::get(rfq_get))
        .route("/api/v1/rfq/{id}/execute", axum::routing::post(rfq_execute))
        .route("/api/v1/rfq/{id}/cancel", axum::routing::post(rfq_cancel))
        // ---- multi-venue liquidity + smart order router
        .route("/api/v1/venues", axum::routing::get(venue_statuses))
        .route("/api/v1/venues/quotes", axum::routing::get(venue_quotes))
        .route("/api/v1/venues/route", axum::routing::post(route_plan))
        // ---- risk + fees
        .route("/api/v1/risk", axum::routing::get(risk_summary))
        .route("/api/v1/fees", axum::routing::get(fee_schedule))
        .layer(axum::middleware::from_fn(crate::security::rate_limit_mw))
        .layer(axum::middleware::from_fn(crate::security::security_headers_mw))
        .with_state(state)
}

fn err_json(status: StatusCode, msg: String) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(serde_json::json!({ "error": status.as_str(), "message": msg })))
}

fn bad_request<T>(msg: String) -> Result<T, (StatusCode, Json<serde_json::Value>)> {
    Err(err_json(StatusCode::BAD_REQUEST, msg))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "engine": "volos-rust",
        "version": env!("CARGO_PKG_VERSION"),
        "strategies": strategies::catalog().len(),
        "maxLegs": strategies::MAX_LEGS,
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

fn map_err<T, E: std::fmt::Display>(r: Result<T, E>) -> Result<T, (StatusCode, Json<serde_json::Value>)> {
    r.map_err(|e| err_json(StatusCode::BAD_REQUEST, e.to_string()))
}

/// Broadcast engine events (fills / book / orders / rfq) to SSE subscribers.
fn emit(state: &AppState, events: Vec<trading::EngineEvent>) {
    for ev in events {
        if let Ok(json) = serde_json::to_string(&ev) {
            let _ = state.engine_tx.send(json);
        }
    }
}

// ------------------------------------------------------------ market data

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
        return bad_request("expiry_days must be in [0.5, 730]".into());
    }
    let t = expiry_days / crate::pricing::DAYS_PER_YEAR;
    let f = forward(&ctx.cfg, ctx.state.spot, t);
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

// ------------------------------------------------------ analytics engine

async fn analyze(
    State(state): State<SharedState>,
    Json(req): Json<AnalyzeRequest>,
) -> Result<Json<AnalyzeResponse>, (StatusCode, Json<serde_json::Value>)> {
    let ctx = map_err(current_ctx(&state, &req.underlying))?;
    let (legs, size) = map_err(req.validate(ctx.state.spot))?;
    let mut resp = payoff::analyze(&legs, size, &ctx);
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

// ----------------------------------------------------- strategy catalog

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogResponse {
    total: usize,
    max_legs: usize,
    categories: Vec<(String, usize)>,
    leg_histogram: Vec<(usize, usize)>,
    strategies: Vec<&'static StrategySpec>,
}

async fn strategy_catalog() -> Json<CatalogResponse> {
    let meta = strategies::meta();
    Json(CatalogResponse {
        total: meta.total,
        max_legs: meta.max_legs,
        categories: meta.categories,
        leg_histogram: meta.leg_histogram,
        strategies: strategies::catalog().iter().collect(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedLeg {
    kind: LegKind,
    side: crate::models::Side,
    qty: f64,
    strike: Option<f64>,
    expiry_days: Option<f64>,
    funding_period_days: Option<f64>,
    /// Resolved CLOB instrument id — instantly tradable after resolve.
    instrument: String,
    /// Theoretical mid price of the leg.
    theo: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolveResponse {
    strategy: &'static StrategySpec,
    underlying: String,
    spot: f64,
    step: f64,
    legs: Vec<ResolvedLeg>,
}

#[derive(serde::Deserialize)]
struct ResolveQuery {
    underlying: Option<String>,
}

async fn strategy_resolve(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<ResolveQuery>,
) -> Result<Json<ResolveResponse>, (StatusCode, Json<serde_json::Value>)> {
    let spec = strategies::find(&id)
        .ok_or_else(|| err_json(StatusCode::NOT_FOUND, format!("unknown strategy {id}")))?;
    let underlying = q.underlying.as_deref().unwrap_or("BTC").trim().to_uppercase();
    let ctx = map_err(current_ctx(&state, &underlying))?;
    let inputs = strategies::resolve(spec, ctx.state.spot);
    let (legs, _size) = map_err(
        AnalyzeRequest { underlying: underlying.clone(), legs: inputs.clone(), size: Some(1.0) }
            .validate(ctx.state.spot),
    )?;
    // Register each leg as a tradable instrument so it appears on the CLOB.
    let snapshot = state.sim.lock().unwrap().snapshot();
    let mut eng = state.trading.lock().unwrap();
    let mut out = Vec::with_capacity(legs.len());
    for (leg, input) in legs.iter().zip(inputs.iter()) {
        let inst_id = eng.ensure_leg_instrument(&underlying, leg, &snapshot);
        let theo = eng
            .insts
            .get(&inst_id)
            .map(|i| {
                TradingEngine::price_inst_ctx(i, &ctx, 1.0, 0.0)
            })
            .unwrap_or(0.0);
        out.push(ResolvedLeg {
            kind: leg.kind,
            side: leg.side,
            qty: leg.qty,
            strike: input.strike,
            expiry_days: input.expiry_days,
            funding_period_days: Some(leg.funding_period_days),
            instrument: inst_id,
            theo,
        });
    }
    Ok(Json(ResolveResponse {
        strategy: spec,
        underlying,
        spot: ctx.state.spot,
        step: strategies::strike_step(ctx.state.spot),
        legs: out,
    }))
}

// ---------------------------------------------------------- trading engine

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountDto {
    id: String,
    balance: f64,
    equity: f64,
    unrealized_pnl: f64,
    fees_paid: f64,
    funding_paid: f64,
    margin_used: f64,
    margin_ratio: f64,
    open_orders: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PositionDto {
    instrument: String,
    underlying: String,
    kind: String,
    qty: f64,
    avg_cost: f64,
    mark: f64,
    value: f64,
    unrealized_pnl: f64,
    realized_pnl: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TradingStateDto {
    server_ms: u64,
    account: AccountDto,
    l1: Vec<L1Dto>,
    positions: Vec<PositionDto>,
    greeks: risk::GreeksAgg,
    venues: Vec<crate::venues::VenueStatus>,
    strategy_count: usize,
    max_legs: usize,
}

fn demo_account(eng: &mut TradingEngine) -> risk::Account {
    eng.accounts
        .entry(DEMO_ACCOUNT.to_string())
        .or_insert_with(|| risk::Account::new(DEMO_ACCOUNT.to_string(), risk::DEMO_STARTING_BALANCE, false))
        .clone()
}

/// Compute account-level economics (equity, margin, greeks) for an account snapshot.
fn account_economics(
    account: &risk::Account,
    eng: &TradingEngine,
) -> (f64, f64, risk::GreeksAgg) {
    let insts = &eng.insts;
    let marks: HashMap<String, f64> = eng.marks();
    let spots = eng.spots.clone();
    let vol_shifts = eng.vol_shifts.clone();
    let equity = account.equity(&|id| marks.get(id).copied().unwrap_or(0.0), insts);
    let margin = risk::portfolio_margin(&account.positions, insts, &|inst, sm, va| {
        match trading::ctx_from(&spots, &vol_shifts, &inst.underlying) {
            Some(c) => TradingEngine::price_inst_ctx(inst, &c, sm, va),
            None => inst.mark,
        }
    });
    let greeks = risk::aggregate_greeks(&account.positions, insts, &|inst| {
        match trading::ctx_from(&spots, &vol_shifts, &inst.underlying) {
            Some(c) => TradingEngine::greeks_inst(inst, &c),
            None => (0.0, 0.0, 0.0, 0.0),
        }
    }, &spots);
    (equity, margin, greeks)
}

fn inst_kind_label(kind: &clob::InstrumentKind) -> String {
    match kind {
        clob::InstrumentKind::PerpFuture => "perp".into(),
        clob::InstrumentKind::PerpOption => "everlasting".into(),
        clob::InstrumentKind::DatedOption => "dated".into(),
    }
}

async fn trading_state(
    State(state): State<SharedState>,
) -> Result<Json<TradingStateDto>, (StatusCode, Json<serde_json::Value>)> {
    let mut eng = state.trading.lock().unwrap();
    let account = demo_account(&mut eng);
    let (equity, margin, greeks) = account_economics(&account, &eng);
    let marks = eng.marks();
    let mut positions: Vec<PositionDto> = account
        .positions
        .iter()
        .filter(|(_, p)| p.qty.abs() > 1e-12)
        .map(|(id, p)| {
            let inst = eng.insts.get(id);
            let mark = marks.get(id).copied().unwrap_or(p.avg_cost);
            PositionDto {
                instrument: id.clone(),
                underlying: inst.map(|i| i.underlying.clone()).unwrap_or_default(),
                kind: inst.map(|i| inst_kind_label(&i.kind)).unwrap_or_default(),
                qty: p.qty,
                avg_cost: p.avg_cost,
                mark,
                value: p.qty * mark,
                unrealized_pnl: (mark - p.avg_cost) * p.qty,
                realized_pnl: p.realized_pnl,
            }
        })
        .collect();
    positions.sort_by(|a, b| b.value.abs().partial_cmp(&a.value.abs()).unwrap_or(std::cmp::Ordering::Equal));
    let open_orders = eng
        .orders
        .values()
        .filter(|o| {
            o.account == DEMO_ACCOUNT
                && matches!(o.status, clob::OrderStatus::Open | clob::OrderStatus::Partially | clob::OrderStatus::Pending)
        })
        .count();
    let l1 = eng.l1_all();
    let live = state.live.lock().unwrap().clone();
    let venue_statuses = eng.venues.statuses(&live);
    Ok(Json(TradingStateDto {
        server_ms: clob::now_ms(),
        account: AccountDto {
            id: account.id.clone(),
            balance: account.balance,
            equity,
            unrealized_pnl: account.unrealized_pnl(&|id| marks.get(id).copied().unwrap_or(0.0)),
            fees_paid: account.fees_paid,
            funding_paid: account.funding_paid,
            margin_used: margin,
            margin_ratio: if margin > 1e-9 { equity / margin } else { 999.0 },
            open_orders,
        },
        l1,
        positions,
        greeks,
        venues: venue_statuses,
        strategy_count: strategies::catalog().len(),
        max_legs: strategies::MAX_LEGS,
    }))
}

async fn trading_instruments(State(state): State<SharedState>) -> Json<Vec<L1Dto>> {
    let eng = state.trading.lock().unwrap();
    Json(eng.l1_all())
}

#[derive(Deserialize)]
struct BookQuery {
    instrument: Option<String>,
    depth: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BookResponse {
    instrument: String,
    l2: clob::L2,
    l3: Vec<clob::L3Entry>,
    theo: f64,
    mark: f64,
    last: Option<f64>,
}

async fn trading_book(
    State(state): State<SharedState>,
    axum::extract::Query(q): axum::extract::Query<BookQuery>,
) -> Result<Json<BookResponse>, (StatusCode, Json<serde_json::Value>)> {
    let instrument = q.instrument.unwrap_or_default();
    let depth = q.depth.unwrap_or(12).clamp(1, 50);
    let eng = state.trading.lock().unwrap();
    let e = eng
        .engines
        .get(&instrument)
        .ok_or_else(|| err_json(StatusCode::NOT_FOUND, format!("unknown instrument {instrument}")))?;
    let l2 = e.book.l2(&e.inst, depth);
    let l3 = e.book.l3(&e.inst, depth * 3);
    Ok(Json(BookResponse {
        instrument,
        l2,
        l3,
        theo: e.inst.theo,
        mark: e.inst.mark,
        last: e.inst.last_trade,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaceOrderRequest {
    instrument: String,
    side: Side,
    kind: OrderKind,
    #[serde(default)]
    price: Option<f64>,
    #[serde(default)]
    trigger: Option<f64>,
    qty: f64,
    #[serde(default)]
    stp: Option<StpPolicy>,
    #[serde(default)]
    account: Option<String>,
}

async fn place_order(
    State(state): State<SharedState>,
    Json(req): Json<PlaceOrderRequest>,
) -> Result<Json<Order>, (StatusCode, Json<serde_json::Value>)> {
    let account = req.account.unwrap_or_else(|| DEMO_ACCOUNT.to_string());
    if account.len() > 32 || !account.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') {
        return bad_request("account must be a short slug".into());
    }
    let mut events = Vec::new();
    let order = {
        let mut eng = state.trading.lock().unwrap();
        eng.place_order(
            &account,
            &req.instrument,
            req.side,
            req.kind,
            req.price,
            req.trigger,
            req.qty,
            req.stp.unwrap_or(StpPolicy::CancelNewest),
            &mut events,
        )
    };
    emit(&state, events);
    match order {
        Ok(o) => {
            if o.status == clob::OrderStatus::Rejected {
                let reason = o
                    .reject
                    .map(|r| format!("{r:?}"))
                    .unwrap_or_else(|| "rejected".into());
                Err(err_json(StatusCode::UNPROCESSABLE_ENTITY, format!("order rejected: {reason}")))
            } else {
                Ok(Json(o))
            }
        }
        Err(e) => bad_request(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AmendOrderRequest {
    order_id: u64,
    #[serde(default)]
    price: Option<f64>,
    #[serde(default)]
    qty: Option<f64>,
    #[serde(default)]
    account: Option<String>,
}

async fn amend_order(
    State(state): State<SharedState>,
    Json(req): Json<AmendOrderRequest>,
) -> Result<Json<Order>, (StatusCode, Json<serde_json::Value>)> {
    let account = req.account.unwrap_or_else(|| DEMO_ACCOUNT.to_string());
    let mut events = Vec::new();
    let out = {
        let mut eng = state.trading.lock().unwrap();
        eng.amend_order(&account, req.order_id, req.price, req.qty, &mut events)
    };
    emit(&state, events);
    map_err(out).map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelOrderRequest {
    order_id: u64,
    #[serde(default)]
    account: Option<String>,
}

async fn cancel_order(
    State(state): State<SharedState>,
    Json(req): Json<CancelOrderRequest>,
) -> Result<Json<Order>, (StatusCode, Json<serde_json::Value>)> {
    let account = req.account.unwrap_or_else(|| DEMO_ACCOUNT.to_string());
    let mut events = Vec::new();
    let out = {
        let mut eng = state.trading.lock().unwrap();
        eng.cancel_order(&account, req.order_id, &mut events)
    };
    emit(&state, events);
    map_err(out).map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelAllRequest {
    #[serde(default)]
    instrument: Option<String>,
    #[serde(default)]
    account: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelAllResponse {
    canceled: usize,
}

async fn cancel_all(
    State(state): State<SharedState>,
    Json(req): Json<CancelAllRequest>,
) -> Result<Json<CancelAllResponse>, (StatusCode, Json<serde_json::Value>)> {
    let account = req.account.unwrap_or_else(|| DEMO_ACCOUNT.to_string());
    let mut events = Vec::new();
    let n = {
        let mut eng = state.trading.lock().unwrap();
        eng.cancel_all(&account, req.instrument.as_deref(), &mut events)
    };
    emit(&state, events);
    Ok(Json(CancelAllResponse { canceled: n }))
}

async fn open_orders(
    State(state): State<SharedState>,
    axum::extract::Query(q): axum::extract::Query<CancelAllRequest>,
) -> Json<Vec<Order>> {
    let eng = state.trading.lock().unwrap();
    let mut orders: Vec<Order> = eng
        .orders
        .values()
        .filter(|o| o.account == DEMO_ACCOUNT)
        .cloned()
        .collect();
    if let Some(inst) = &q.instrument {
        orders.retain(|o| &o.instrument == inst);
    }
    orders.sort_by(|a, b| b.id.cmp(&a.id));
    orders.truncate(80);
    Json(orders)
}

#[derive(Deserialize)]
struct TapeQuery {
    #[serde(default)]
    instrument: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn trade_tape(
    State(state): State<SharedState>,
    axum::extract::Query(q): axum::extract::Query<TapeQuery>,
) -> Json<Vec<Trade>> {
    let limit = q.limit.unwrap_or(120).clamp(1, 400);
    let eng = state.trading.lock().unwrap();
    let mut trades: Vec<Trade> = eng
        .engines
        .values()
        .flat_map(|e| e.trades.iter().cloned())
        .filter(|t| match &q.instrument {
            Some(i) => &t.instrument == i,
            None => true,
        })
        .collect();
    trades.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms).then(b.id.cmp(&a.id)));
    trades.truncate(limit);
    Json(trades)
}

async fn trading_stream(
    State(state): State<SharedState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.engine_tx.subscribe();
    let stream = BroadcastStream::new(rx).map(|msg| {
        let data = match msg {
            Ok(d) => d,
            Err(_) => "{}".to_string(),
        };
        Ok::<Event, Infallible>(Event::default().data(data))
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(3)))
}

// ------------------------------------------------------------------- RFQ

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RfqCreateRequest {
    underlying: String,
    legs: Vec<LegInput>,
    side: Side,
    #[serde(default)]
    size: Option<f64>,
    #[serde(default)]
    strategy_name: Option<String>,
}

async fn rfq_create(
    State(state): State<SharedState>,
    Json(req): Json<RfqCreateRequest>,
) -> Result<Json<rfqs::RfqSession>, (StatusCode, Json<serde_json::Value>)> {
    let ctx = map_err(current_ctx(&state, &req.underlying))?;
    let underlying = req.underlying.trim().to_uppercase();
    let (legs, size) = map_err(
        AnalyzeRequest { underlying: underlying.clone(), legs: req.legs, size: req.size }
            .validate(ctx.state.spot),
    )?;
    if legs.len() > strategies::MAX_LEGS {
        return bad_request(format!("RFQ supports at most {} legs", strategies::MAX_LEGS));
    }
    let analysis = payoff::analyze(&legs, size, &ctx);
    let per_unit_delta = if size > 1e-12 { analysis.greeks.delta / size } else { analysis.greeks.delta };
    let strategy_hash = hash_valid_legs(&legs);
    let mut events = Vec::new();
    let sess = {
        let snapshot = state.sim.lock().unwrap().snapshot();
        let mut eng = state.trading.lock().unwrap();
        for leg in legs.iter() {
            eng.ensure_leg_instrument(&underlying, leg, &snapshot);
        }
        let id = eng.rfq.create(
            underlying.clone(),
            legs,
            req.side,
            size,
            analysis.net_premium,
            per_unit_delta,
            strategy_hash,
            clob::now_ms(),
        );
        let _ = &req.strategy_name;
        events.push(trading::EngineEvent::Rfq { id });
        eng.rfq.sessions.get(&id).cloned()
    };
    emit(&state, events);
    match sess {
        Some(s) => Ok(Json(s)),
        None => bad_request("rfq session creation failed".into()),
    }
}

async fn rfq_get(
    State(state): State<SharedState>,
    Path(id): Path<u64>,
) -> Result<Json<rfqs::RfqSession>, (StatusCode, Json<serde_json::Value>)> {
    let mut eng = state.trading.lock().unwrap();
    // advance quote lifecycle eagerly for a fresh view
    let info = eng
        .rfq
        .sessions
        .get(&id)
        .map(|s| (s.legs.clone(), s.size, s.underlying.clone()))
        .ok_or_else(|| err_json(StatusCode::NOT_FOUND, format!("rfq {id} not found")))?;
    let ctx = current_ctx(&state, &info.2).ok();
    if let Some(c) = ctx {
        let analysis = payoff::analyze(&info.0, info.1, &c);
        eng.rfq.poll(id, clob::now_ms(), analysis.net_premium);
    }
    match eng.rfq.sessions.get(&id).cloned() {
        Some(s) => Ok(Json(s)),
        None => bad_request("rfq session vanished".into()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RfqExecuteRequest {
    dealer: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RfqExecuteResponse {
    execution: rfqs::RfqExecution,
    hedge_route: crate::venues::RoutePlan,
    position_applied: usize,
}

async fn rfq_execute(
    State(state): State<SharedState>,
    Path(id): Path<u64>,
    Json(req): Json<RfqExecuteRequest>,
) -> Result<Json<RfqExecuteResponse>, (StatusCode, Json<serde_json::Value>)> {
    let now = clob::now_ms();
    let mut events = Vec::new();
    let out = {
        let mut eng = state.trading.lock().unwrap();
        let sess = eng
            .rfq
            .sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| err_json(StatusCode::NOT_FOUND, format!("rfq {id} not found")))?;

        // ---- dealer delta hedge: route the opposite delta across venues
        let dealer_delta = -sess.package_delta * sess.side.sign() as f64 * sess.size;
        let perp_id = format!("{}-PERP", sess.underlying);
        let hedge_side = if dealer_delta >= 0.0 { Side::Buy } else { Side::Sell };
        let hedge_qty = dealer_delta.abs().min(risk::MAX_POSITION_ABS).max(0.0);
        let own_l2 = eng.engines.get(&perp_id).map(|e| e.book.l2(&e.inst, 8));
        let plan = eng.venues.plan(&perp_id, hedge_side, hedge_qty, own_l2.as_ref());
        for child in plan.children.iter() {
            if !child.own_clob {
                let _ = eng.venues.execute_external(&perp_id, child, hedge_side);
            }
        }

        let exec = eng
            .rfq
            .execute(id, &req.dealer, now, plan.children.clone(), plan.vwap)
            .map_err(|e| err_json(StatusCode::UNPROCESSABLE_ENTITY, e))?;

        // ---- settle the package into the taker account at leg theo
        let snapshot = state.sim.lock().unwrap().snapshot();
        let ctx = TradingEngine::ctx_of(&snapshot, &sess.underlying);
        let mut applied = 0usize;
        if let Some(ctx) = ctx {
            let flip = |s: crate::models::Side| {
                if s == crate::models::Side::Buy { crate::models::Side::Sell } else { crate::models::Side::Buy }
            };
            // Pre-register every leg instrument (needs &mut engine) before the
            // account borrow; then use disjoint field borrows for settlement.
            let mut pending: Vec<(String, Side, f64)> = Vec::with_capacity(sess.legs.len());
            for leg in sess.legs.iter() {
                let inst_id = eng.ensure_leg_instrument(&sess.underlying, leg, &snapshot);
                let eff = if sess.side == Side::Buy { leg.side } else { flip(leg.side) };
                let clob_side = if eff == crate::models::Side::Buy { Side::Buy } else { Side::Sell };
                pending.push((inst_id, clob_side, leg.qty * sess.size));
            }
            // Split field borrows through one deref of the MutexGuard.
            let TradingEngine { insts, accounts, .. } = &mut *eng;
            let acct = accounts
                .entry(DEMO_ACCOUNT.to_string())
                .or_insert_with(|| risk::Account::new(DEMO_ACCOUNT.to_string(), risk::DEMO_STARTING_BALANCE, false));
            let mut theo_cash = 0.0;
            for (inst_id, clob_side, qty) in pending {
                if let Some(inst) = insts.get(&inst_id) {
                    let theo = TradingEngine::price_inst_ctx(inst, &ctx, 1.0, 0.0);
                    acct.apply_fill(inst, clob_side, theo, qty, 0.0, 0.0);
                    theo_cash -= clob_side.sign() as f64 * theo * qty;
                    applied += 1;
                }
            }
            // dealer edge + fee settle on top of theo fills
            let actual_cash = -exec.price * sess.size;
            acct.balance += actual_cash - theo_cash;
            acct.balance -= exec.fee;
            acct.fees_paid += exec.fee;
        }
        events.push(trading::EngineEvent::Account { id: DEMO_ACCOUNT.to_string() });
        events.push(trading::EngineEvent::Rfq { id });
        Ok::<RfqExecuteResponse, (StatusCode, Json<serde_json::Value>)>(RfqExecuteResponse {
            execution: exec,
            hedge_route: plan,
            position_applied: applied,
        })
    };
    emit(&state, events);
    out.map(Json)
}

async fn rfq_cancel(
    State(state): State<SharedState>,
    Path(id): Path<u64>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let mut eng = state.trading.lock().unwrap();
    map_err(eng.rfq.cancel(id))?;
    Ok(Json(serde_json::json!({ "cancelled": id })))
}

// ---------------------------------------------------------------- venues

async fn venue_statuses(State(state): State<SharedState>) -> Json<Vec<crate::venues::VenueStatus>> {
    let eng = state.trading.lock().unwrap();
    let live = state.live.lock().unwrap().clone();
    Json(eng.venues.statuses(&live))
}

#[derive(Deserialize)]
struct VenueQuoteQuery {
    #[serde(default)]
    instrument: Option<String>,
}

async fn venue_quotes(
    State(state): State<SharedState>,
    axum::extract::Query(q): axum::extract::Query<VenueQuoteQuery>,
) -> Json<Vec<crate::venues::VenueQuote>> {
    let eng = state.trading.lock().unwrap();
    match q.instrument {
        Some(inst) => Json(eng.venues.quotes_for(&inst).to_vec()),
        None => {
            // top liquidity instruments only (perps)
            let mut out = Vec::new();
            for a in ASSETS.iter() {
                let perp = format!("{a}-PERP");
                out.extend(eng.venues.quotes_for(&perp).iter().cloned());
            }
            Json(out)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteRequest {
    instrument: String,
    side: Side,
    qty: f64,
}

async fn route_plan(
    State(state): State<SharedState>,
    Json(req): Json<RouteRequest>,
) -> Result<Json<crate::venues::RoutePlan>, (StatusCode, Json<serde_json::Value>)> {
    if !req.qty.is_finite() || req.qty <= 0.0 || req.qty > 1000.0 {
        return bad_request("qty must be in (0, 1000]".into());
    }
    let eng = state.trading.lock().unwrap();
    let own_l2 = eng.engines.get(&req.instrument).map(|e| e.book.l2(&e.inst, 10));
    if own_l2.is_none() && eng.insts.get(&req.instrument).is_none() {
        return bad_request(format!("unknown instrument {}", req.instrument));
    }
    let plan = eng.venues.plan(&req.instrument, req.side, req.qty, own_l2.as_ref());
    Ok(Json(plan))
}

// ----------------------------------------------------------------- risk

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RiskSummary {
    equity: f64,
    balance: f64,
    margin_used: f64,
    margin_ratio: f64,
    maintenance_ratio: f64,
    healthy: bool,
    greeks: risk::GreeksAgg,
    limits: RiskLimits,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RiskLimits {
    max_position_abs: f64,
    max_order_notional: f64,
    max_open_orders: usize,
}

async fn risk_summary(State(state): State<SharedState>) -> Json<RiskSummary> {
    let mut eng = state.trading.lock().unwrap();
    let account = demo_account(&mut eng);
    let (equity, margin, greeks) = account_economics(&account, &eng);
    let ratio = if margin > 1e-9 { equity / margin } else { 999.0 };
    Json(RiskSummary {
        equity,
        balance: account.balance,
        margin_used: margin,
        margin_ratio: ratio,
        maintenance_ratio: crate::fees::MAINTENANCE_RATIO,
        healthy: ratio >= crate::fees::MAINTENANCE_RATIO,
        greeks,
        limits: RiskLimits {
            max_position_abs: risk::MAX_POSITION_ABS,
            max_order_notional: risk::MAX_ORDER_NOTIONAL,
            max_open_orders: clob::MAX_OPEN_ORDERS,
        },
    })
}

async fn fee_schedule() -> Json<crate::fees::FeeSchedule> {
    Json(crate::fees::schedule())
}

// ----------------------------------------------------------------- utils

fn hash_valid_legs(legs: &[ValidLeg]) -> String {
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

// Suppress unused-import warnings for items used only in some feature paths.
#[allow(unused)]
fn _unused(_v: &VenuePool) {}

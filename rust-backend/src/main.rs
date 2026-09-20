//! VolOS backend — high-performance options strategy analytics + trading engine.
//! Axum + Tokio, zero unsafe code, strict input validation, rate limited.
//!
//! Services:
//!   * analytics engine  — pricing / Greeks / payoff / risk (payoff.rs & friends)
//!   * market simulator  — GBM spot + OU vol-shift, 1 Hz SSE broadcast
//!   * trading engine    — CLOB matching, OMS, MM desks, flow, stops, funding
//!   * RFQ dealer net    — strategy-level (up to 25 legs) firm quotes
//!   * venue router      — Derive / Paradex / Paradigm liquidity aggregation
//!   * live feed         — real venue anchors when APIs are reachable
//!   * strategy catalog  — 118 pre-built strategies (1..=25 legs)

mod api;
mod clob;
mod compiler;
mod fees;
mod livefeed;
mod market;
mod models;
mod norm;
mod payoff;
mod pricing;
mod quotes;
mod risk;
mod rfqs;
mod security;
mod strategies;
mod surface;
mod trading;
mod venues;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::set_header::SetResponseHeaderLayer;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("VOLOS_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3031);

    // ---- market simulator + SSE broadcast (analytics-grade, 1 Hz)
    let (sim, tx) = market::spawn();

    // ---- live venue anchors (Derive / Paradex probes, graceful fallback)
    let live: venues::SharedLive = Arc::new(Mutex::new(venues::LiveState::default()));
    livefeed::spawn(live.clone(), sim.clone());

    // ---- trading engine + event broadcast (CLOB / RFQ / venues / risk)
    let seeds: std::collections::HashMap<String, f64> = {
        let snap = sim.lock().unwrap().snapshot();
        snap.assets.iter().map(|(k, v)| (k.clone(), v.spot)).collect()
    };
    let trading: api::SharedTrading = Arc::new(Mutex::new(trading::TradingEngine::new(&seeds)));
    let (engine_tx, _engine_rx) = tokio::sync::broadcast::channel::<String>(1024);

    // 1 Hz engine heartbeat: reprice, requote MMs, run flow, trigger stops,
    // accrue funding, advance RFQ lifecycles, broadcast events.
    {
        let sim = sim.clone();
        let live = live.clone();
        let trading = trading.clone();
        let engine_tx = engine_tx.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                let snapshot = sim.lock().unwrap().snapshot();
                let live_state = live.lock().unwrap().clone();
                let mut events = Vec::new();
                trading.lock().unwrap().tick(&snapshot, &live_state, &mut events);
                for ev in events {
                    if let Ok(json) = serde_json::to_string(&ev) {
                        let _ = engine_tx.send(json);
                    }
                }
            }
        });
    }

    let state = Arc::new(api::AppState {
        sim,
        tx,
        trading,
        live,
        engine_tx,
    });

    let limiter = Arc::new(security::RateLimiter::new(90.0, 30.0));

    let app = api::router(state)
        .layer(axum::Extension(limiter))
        .layer(RequestBodyLimitLayer::new(512 * 1024)) // 512 KiB (25-leg RFQs)
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::SERVER,
            axum::http::HeaderValue::from_static("volos"),
        ))
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("[volos] engine listening on {addr}");
    println!(
        "[volos] rust engine v{} — axum/tokio, no unsafe — {} strategies (max {} legs)",
        env!("CARGO_PKG_VERSION"),
        strategies::catalog().len(),
        strategies::MAX_LEGS
    );

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind port");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    println!("[volos] shutdown signal received");
}

//! VolOS backend — high-performance options strategy analytics engine.
//! Axum + Tokio, zero unsafe code, strict input validation, rate limited.

mod api;
mod compiler;
mod market;
mod models;
mod norm;
mod payoff;
mod pricing;
mod quotes;
mod security;
mod surface;

use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::set_header::SetResponseHeaderLayer;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("VOLOS_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3031);

    let (sim, tx) = market::spawn();
    let state = Arc::new(api::AppState { sim, tx });

    let limiter = Arc::new(security::RateLimiter::new(60.0, 25.0));

    let app = api::router(state)
        .layer(axum::Extension(limiter))
        .layer(RequestBodyLimitLayer::new(64 * 1024)) // 64 KiB
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::SERVER,
            axum::http::HeaderValue::from_static("volos"),
        ))
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("[volos] engine listening on {addr}");
    println!("[volos] rust analytics engine v{} — axum/tokio, no unsafe", env!("CARGO_PKG_VERSION"));

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

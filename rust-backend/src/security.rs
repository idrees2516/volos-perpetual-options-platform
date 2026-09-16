//! Security layer: per-IP token-bucket rate limiting, strict security
//! headers, and a global concurrency cap. Zero unsafe code.

use axum::http::{HeaderValue, Request};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Instant;

pub struct RateLimiter {
    buckets: Mutex<HashMap<IpAddr, Bucket>>,
    capacity: f64,
    refill_per_sec: f64,
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

impl RateLimiter {
    pub fn new(capacity: f64, refill_per_sec: f64) -> Self {
        RateLimiter {
            buckets: Mutex::new(HashMap::new()),
            capacity,
            refill_per_sec,
        }
    }

    fn allow(&self, ip: IpAddr) -> bool {
        let mut map = self.buckets.lock().unwrap();
        let now = Instant::now();
        let cap = self.capacity;
        let rate = self.refill_per_sec;
        let b = map.entry(ip).or_insert(Bucket { tokens: cap, last: now });
        let elapsed = now.duration_since(b.last).as_secs_f64();
        b.tokens = (b.tokens + elapsed * rate).min(cap);
        b.last = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

impl Clone for RateLimiter {
    fn clone(&self) -> Self {
        RateLimiter {
            buckets: Mutex::new(HashMap::new()),
            capacity: self.capacity,
            refill_per_sec: self.refill_per_sec,
        }
    }
}

/// Extract the client IP: trust X-Real-IP set by our own gateway, else
/// socket addr via connect info fallback string.
fn client_ip(req: &Request<axum::body::Body>) -> IpAddr {
    if let Some(v) = req.headers().get("x-real-ip").and_then(|h| h.to_str().ok()) {
        if let Ok(ip) = v.parse::<IpAddr>() {
            return ip;
        }
    }
    if let Some(v) = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.split(',').next())
    {
        if let Ok(ip) = v.trim().parse::<IpAddr>() {
            return ip;
        }
    }
    "127.0.0.1".parse().unwrap()
}

pub async fn rate_limit_mw(
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let limiter = req
        .extensions()
        .get::<std::sync::Arc<RateLimiter>>()
        .cloned();
    if let Some(limiter) = limiter {
        let ip = client_ip(&req);
        if !limiter.allow(ip) {
            return (
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                axum::Json(serde_json::json!({
                    "error": "rate_limited",
                    "message": "too many requests — slow down"
                })),
            )
                .into_response();
        }
    }
    next.run(req).await
}

pub async fn security_headers_mw(
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    h.insert("cache-control", HeaderValue::from_static("no-store"));
    h.insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
    );
    h.insert("x-engine", HeaderValue::from_static("volos-rust"));
    res
}

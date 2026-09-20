//! Live venue connectivity: probes Derive + Paradex public REST APIs on a
//! background schedule and stores real top-of-book anchors used by the
//! venue pool. All failures degrade gracefully to simulated liquidity.

use crate::venues::{LiveAnchor, LiveState, SharedLive};
use crate::market::SharedSim;
use std::collections::HashMap;
use std::time::Duration;

const REFRESH_SECS: u64 = 12;
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const DERIVE_BASE: &str = "https://api.lyra.finance";
const PARADEX_MARKETS: &str = "https://api.prod.paradex.trade/v1/markets?asset_type=perp";

pub fn spawn(live: SharedLive, sim: SharedSim) {
    tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .user_agent("volos-terminal/1.0 (+research prototype)")
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        loop {
            refresh_once(&client, &live, &sim).await;
            tokio::time::sleep(Duration::from_secs(REFRESH_SECS)).await;
        }
    });
}

async fn refresh_once(client: &reqwest::Client, live: &SharedLive, sim: &SharedSim) {
    // reference spots from our simulator for strike selection
    let spots: HashMap<String, f64> = {
        let guard = sim.lock().unwrap();
        let snap = guard.snapshot();
        snap.assets.iter().map(|(k, v)| (k.clone(), v.spot)).collect()
    };

    // ---- Paradex reachability (public markets listing)
    let paradex_ok = match client.get(PARADEX_MARKETS).send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    };

    // ---- Derive: instruments then tickers near the money
    let mut anchors: HashMap<String, LiveAnchor> = HashMap::new();
    let mut derive_ok = false;
    let mut last_error: Option<String> = None;

    for asset in ["BTC", "ETH", "SOL"] {
        let spot = match spots.get(asset) {
            Some(s) if *s > 0.0 => *s,
            _ => continue,
        };
        let url = format!(
            "{DERIVE_BASE}/public/get_instruments?currency={asset}&expired=false&instrument_type=option"
        );
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                last_error = Some(format!("derive instruments: {e}"));
                continue;
            }
        };
        if !resp.status().is_success() {
            last_error = Some(format!("derive instruments: HTTP {}", resp.status()));
            continue;
        }
        derive_ok = true;
        let body: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                last_error = Some(format!("derive instruments json: {e}"));
                continue;
            }
        };
        let instruments = match body.get("result").and_then(|r| r.as_array()) {
            Some(a) => a.clone(),
            None => continue,
        };
        // nearest listed strikes to ±10% around spot, nearest expiry first
        let mut with_meta: Vec<(f64, f64, String)> = Vec::new(); // (|strike-spot|, expiry, name)
        for ins in instruments.iter() {
            let name = ins.get("instrument_name").and_then(|v| v.as_str()).unwrap_or("");
            let od = match ins.get("option_details") {
                Some(d) => d.clone(),
                None => continue,
            };
            let strike: f64 = od
                .get("strike")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
            let expiry: f64 = od.get("expiry").and_then(|v| v.as_f64()).unwrap_or(f64::MAX);
            if strike <= 0.0 || (strike - spot).abs() / spot > 0.15 {
                continue;
            }
            with_meta.push(((strike - spot).abs(), expiry, name.to_string()));
        }
        with_meta.sort_by(|a, b| {
            a.1.partial_cmp(&b.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
        });
        // nearest expiry, 3 nearest strikes
        let nearest_expiry = with_meta.first().map(|(_, e, _)| *e);
        let mut picked: Vec<String> = Vec::new();
        for (d, e, name) in with_meta.iter() {
            if Some(*e) == nearest_expiry && picked.len() < 3 {
                let _ = d;
                picked.push(name.clone());
            }
        }
        for name in picked {
            let url = format!("{DERIVE_BASE}/public/get_ticker?instrument_name={name}");
            let resp = match client.get(&url).send().await {
                Ok(r) => r,
                Err(_) => continue,
            };
            if !resp.status().is_success() {
                continue;
            }
            let body: serde_json::Value = match resp.json().await {
                Ok(v) => v,
                Err(_) => continue,
            };
            let r = match body.get("result") {
                Some(r) => r.clone(),
                None => continue,
            };
            let parse_f = |keys: &[&str]| -> f64 {
                for k in keys {
                    if let Some(v) = r.get(k) {
                        if let Some(s) = v.as_str() {
                            if let Ok(f) = s.parse::<f64>() {
                                return f;
                            }
                        }
                        if let Some(f) = v.as_f64() {
                            return f;
                        }
                    }
                }
                0.0
            };
            let bid = parse_f(&["best_bid_price"]);
            let ask = parse_f(&["best_ask_price"]);
            let iv = parse_f(&["iv", "volatility", "implied_vol", "mark_iv"]);
            let mark = parse_f(&["mark_price", "option_pricing.mark_price"]);
            let mid = if bid > 0.0 && ask > 0.0 {
                0.5 * (bid + ask)
            } else {
                mark
            };
            // key: "BTC-100000-C" → matches venues.rs anchor_for()
            let strike: f64 = name
                .split('-')
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
            let opt = name.split('-').nth(2).unwrap_or("C");
            if strike > 0.0 && mid > 0.0 {
                anchors.insert(
                    format!("{asset}-{strike:.0}-{opt}"),
                    LiveAnchor { spot, bid, ask, iv, instrument_name: name.clone() },
                );
            }
        }
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut guard = live.lock().unwrap();
    guard.paradex_reachable = paradex_ok;
    if derive_ok || !anchors.is_empty() {
        guard.derive_reachable = derive_ok;
        guard.anchors = anchors;
        guard.last_ok_ms = now_ms;
        guard.last_error = None;
    } else if let Some(e) = last_error {
        guard.last_error = Some(e);
    }
}

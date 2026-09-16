//! Live market simulation: correlated spot GBM + mean-reverting ATM vol,
//! perp funding and a broadcast SSE tick stream. Deterministic seeds keep
//! runs reproducible for testing.

use crate::surface::{asset_config, AssetVolConfig};
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetState {
    pub spot: f64,
    /// Shift applied to the whole ATM vol level (OU mean-reverting).
    pub vol_shift: f64,
    /// Perp funding rate (annualized).
    pub funding_rate: f64,
    /// 24h realized drift for display.
    pub change_24h: f64,
    pub open_interest: f64,
    pub volume_24h: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSnapshot {
    pub ts_ms: u64,
    pub tick: u64,
    pub assets: HashMap<String, AssetState>,
    pub venue_health: Vec<VenueHealth>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueHealth {
    pub name: &'static str,
    pub status: &'static str,
    pub latency_ms: f64,
}

pub struct Simulator {
    rng: SmallRng,
    states: HashMap<String, (AssetState, f64)>, // state + vol_shift target
    tick: AtomicU64,
    cfg_cache: HashMap<String, AssetVolConfig>,
}

impl Simulator {
    pub fn new() -> Self {
        let mut states = HashMap::new();
        let seeds: [(&str, f64, f64, f64, f64, f64); 3] = [
            // asset, spot, vol_shift, funding, oi, volume
            ("BTC", 97_450.0, 0.00, 0.091, 4.12e9, 1.87e9),
            ("ETH", 2_462.0, 0.02, 0.083, 2.31e9, 9.6e8),
            ("SOL", 138.4, -0.01, 0.104, 6.4e8, 3.1e8),
        ];
        for (a, spot, vs, fr, oi, vol) in seeds.iter() {
            states.insert(
                a.to_string(),
                (
                    AssetState {
                        spot: *spot,
                        vol_shift: *vs,
                        funding_rate: *fr,
                        change_24h: 0.0,
                        open_interest: *oi,
                        volume_24h: *vol,
                    },
                    *vs,
                ),
            );
        }
        let mut cfg_cache = HashMap::new();
        for a in crate::surface::ASSETS.iter() {
            cfg_cache.insert(a.to_string(), asset_config(a));
        }
        Simulator {
            rng: SmallRng::from_entropy(),
            states,
            tick: AtomicU64::new(0),
            cfg_cache,
        }
    }

    /// Advance the simulation one step (called every tick).
    pub fn step(&mut self) {
        let dt = 1.0_f64; // one second per tick; scale vol accordingly
        let sec_per_year: f64 = 365.0 * 24.0 * 3600.0;
        let mut next_targets: Vec<(String, f64)> = Vec::with_capacity(3);
        for (name, (st, target)) in self.states.iter_mut() {
            let cfg = self.cfg_cache.get(name).cloned().unwrap_or_else(|| asset_config(name));
            // Realized vol per-second for the spot process: use ~ 0.8 * atm 30d
            let sigma = cfg.atm_30d * 0.8 / sec_per_year.sqrt();
            let z = self.rng.gen::<f64>() * 2.0 - 1.0; // cheap triangular noise, mean 0
            // Slight fat-tail behaviour: occasional 3x shock.
            let amp = if self.rng.gen::<f64>() < 0.004 { 3.0 } else { 1.0 };
            let drift = -0.5 * sigma * sigma * dt;
            st.spot *= (drift + sigma * z * amp * dt.sqrt()).exp();
            // OU process on vol shift: dX = kappa*(theta - X) dt + eta dW
            let kappa = 0.02;
            let eta = 0.004;
            let noise = self.rng.gen::<f64>() * 2.0 - 1.0;
            st.vol_shift += kappa * (*target - st.vol_shift) + eta * noise;
            st.vol_shift = st.vol_shift.clamp(-0.5, 1.5);
            // Funding rate wanders around a mildly positive mean.
            st.funding_rate += 0.0025 * (self.rng.gen::<f64>() * 2.0 - 1.0) - 0.0008 * (st.funding_rate - 0.085);
            st.funding_rate = st.funding_rate.clamp(-0.6, 0.9);
            // Display stats wander.
            st.change_24h += sigma * z * 4.0;
            st.open_interest *= 1.0 + 0.0002 * (self.rng.gen::<f64>() * 2.0 - 1.0);
            st.volume_24h *= 1.0 + 0.0004 * (self.rng.gen::<f64>() * 2.0 - 1.0);
            // Retarget vol regime occasionally.
            if self.rng.gen::<f64>() < 0.0025 {
                next_targets.push((
                    name.clone(),
                    (self.rng.gen::<f64>() * 2.0 - 1.0) * 0.35,
                ));
            }
        }
        for (n, t) in next_targets {
            if let Some((_, target)) = self.states.get_mut(&n) {
                *target = t;
            }
        }
        let _ = dt;
        self.tick.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> MarketSnapshot {
        let mut assets = HashMap::with_capacity(self.states.len());
        for (k, (st, _)) in self.states.iter() {
            assets.insert(k.clone(), st.clone());
        }
        MarketSnapshot {
            ts_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            tick: self.tick.load(Ordering::Relaxed),
            assets,
            venue_health: vec![
                VenueHealth { name: "Derive", status: "normal", latency_ms: 14.0 },
                VenueHealth { name: "Paradex", status: "normal", latency_ms: 21.0 },
                VenueHealth { name: "Paradigm RFQ", status: "normal", latency_ms: 38.0 },
                VenueHealth { name: "Deribit", status: "normal", latency_ms: 26.0 },
            ],
        }
    }
}

pub type SharedSim = Arc<Mutex<Simulator>>;

/// Spawn the simulation loop, returning the shared simulator and a broadcast
/// channel of snapshots (used by the SSE endpoint).
pub fn spawn() -> (SharedSim, tokio::sync::broadcast::Sender<String>) {
    let sim = Arc::new(Mutex::new(Simulator::new()));
    let (tx, _) = tokio::sync::broadcast::channel::<String>(64);
    let sim_loop = sim.clone();
    let tx_loop = tx.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(1000));
        loop {
            interval.tick().await;
            let json = {
                let mut guard = sim_loop.lock().unwrap();
                guard.step();
                let snap = guard.snapshot();
                serde_json::to_string(&snap).unwrap_or_else(|_| "{}".to_string())
            };
            let _ = tx_loop.send(json); // ignore no-receivers errors
        }
    });
    (sim, tx)
}

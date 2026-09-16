//! SVI-style volatility surface with a crypto-realistic term structure.
//! w(k) = a + b * (rho*(k-m) + sqrt((k-m)^2 + sigma^2)), k = log(K/F).
//! Parameters are generated per (asset, tenor) from a small set of anchors
//! and interpolated in total-variance space, which keeps the surface
//! arbitrage-plausible and cheap to evaluate on the hot path.

use crate::pricing::DAYS_PER_YEAR;

#[derive(Debug, Clone, Copy)]
pub struct SviParams {
    pub a: f64,
    pub b: f64,
    pub rho: f64,
    pub m: f64,
    pub sigma: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct AssetVolConfig {
    /// ATM implied vol at the 30d tenor.
    pub atm_30d: f64,
    /// Term-structure slope per log-year around 30d (contango > 0).
    pub term_slope: f64,
    /// Overall smile curvature (wing richness).
    pub curv: f64,
    /// Skew (negative = downside puts richer).
    pub skew: f64,
    /// Funding/borrow rate used for the forward.
    pub rate: f64,
}

pub const ASSETS: [&str; 3] = ["BTC", "ETH", "SOL"];

pub fn asset_config(asset: &str) -> AssetVolConfig {
    match asset {
        "BTC" => AssetVolConfig { atm_30d: 0.52, term_slope: 0.06, curv: 0.42, skew: -0.62, rate: 0.055 },
        "ETH" => AssetVolConfig { atm_30d: 0.62, term_slope: 0.07, curv: 0.46, skew: -0.66, rate: 0.06 },
        "SOL" => AssetVolConfig { atm_30d: 0.85, term_slope: 0.05, curv: 0.52, skew: -0.55, rate: 0.075 },
        _ => AssetVolConfig { atm_30d: 0.55, term_slope: 0.06, curv: 0.45, skew: -0.6, rate: 0.05 },
    }
}

/// ATM vol for a given time-to-expiry in years (log-linear term structure).
#[inline]
pub fn atm_vol(cfg: &AssetVolConfig, t_years: f64, vol_level_shift: f64) -> f64 {
    let t = t_years.max(1.0 / 365.0 / 8.0);
    let v = cfg.atm_30d * ((t / (30.0 / DAYS_PER_YEAR)).ln() * cfg.term_slope).exp();
    (v * (1.0 + vol_level_shift)).clamp(0.05, 4.0)
}

/// Build SVI slice params for a tenor, matching ATM variance and skew.
#[inline]
pub fn svi_for_tenor(
    cfg: &AssetVolConfig,
    t_years: f64,
    vol_level_shift: f64,
) -> SviParams {
    let v = atm_vol(cfg, t_years, vol_level_shift);
    let total_var = v * v * t_years;
    // Split ATM total variance between the base level `a` and the kink `b*sigma`.
    let sigma = 0.28; // kink width in log-moneyness
    let wing_frac = cfg.curv.clamp(0.15, 0.6);
    let b_sigma = total_var * wing_frac;
    let b = b_sigma / sigma;
    let a = total_var - b_sigma; // >= 0 by construction
    SviParams { a, b, rho: cfg.skew.clamp(-0.99, 0.99), m: 0.0, sigma }
}

/// Implied vol for strike K at tenor t (years) under current market state.
/// `fwd_shift` moves the moneyness centre (forward vs spot).
#[inline]
pub fn iv_for_strike(
    cfg: &AssetVolConfig,
    spot: f64,
    strike: f64,
    t_years: f64,
    vol_level_shift: f64,
) -> f64 {
    if strike <= 0.0 || spot <= 0.0 {
        return atm_vol(cfg, t_years, vol_level_shift);
    }
    let t = t_years.max(1.0 / 365.0 / 8.0);
    let fwd = spot * (cfg.rate * t).exp();
    let k = (strike / fwd).ln();
    let p = svi_for_tenor(cfg, t, vol_level_shift);
    let km = k - p.m;
    let w = p.a + p.b * (p.rho * km + (km * km + p.sigma * p.sigma).sqrt());
    let v = (w / t).max(1e-6).sqrt();
    // Keep wings within sane trading bounds.
    v.clamp(0.05, 5.0)
}

/// Forward price for tenor.
#[inline]
pub fn forward(cfg: &AssetVolConfig, spot: f64, t_years: f64) -> f64 {
    spot * (cfg.rate * t_years).exp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atm_iv_matches_config() {
        let cfg = asset_config("BTC");
        let v = iv_for_strike(&cfg, 100_000.0, forward(&cfg, 100_000.0, 30.0 / 365.0), 30.0 / 365.0, 0.0);
        assert!((v - 0.52).abs() < 0.01, "atm iv {}", v);
    }

    #[test]
    fn skew_downside_richer() {
        let cfg = asset_config("BTC");
        let t = 30.0 / 365.0;
        let f = forward(&cfg, 100_000.0, t);
        let put_iv = iv_for_strike(&cfg, 100_000.0, f * 0.8, t, 0.0);
        let call_iv = iv_for_strike(&cfg, 100_000.0, f * 1.2, t, 0.0);
        assert!(put_iv > call_iv, "put {} vs call {}", put_iv, call_iv);
    }

    #[test]
    fn variance_positive_and_smooth() {
        let cfg = asset_config("ETH");
        for &m in [-0.5_f64, -0.2, 0.0, 0.2, 0.5].iter() {
            for &d in [1.0, 7.0, 30.0, 180.0, 365.0].iter() {
                let t = d / 365.0;
                let f = forward(&cfg, 3000.0, t);
                let v = iv_for_strike(&cfg, 3000.0, f * m.exp(), t, 0.0);
                assert!(v.is_finite() && v > 0.03 && v < 5.0, "m={} d={} v={}", m, d, v);
            }
        }
    }
}

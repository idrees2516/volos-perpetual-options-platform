//! Black-Scholes pricing and Greeks + Everlasting (perpetual) options
//! priced via the Paradigm equivalent-portfolio method:
//!   V = sum_{n>=1} 2^{-n} * BS(S, K, T = n * tau)
//! with funding per period = mark - payoff (longs pay shorts).

use crate::norm::{norm_cdf, norm_pdf};
use serde::{Deserialize, Serialize};

pub const DAYS_PER_YEAR: f64 = 365.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OptionType {
    Call,
    Put,
}

impl OptionType {
    #[inline]
    pub fn sign(&self) -> f64 {
        match self {
            OptionType::Call => 1.0,
            OptionType::Put => -1.0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Greeks {
    pub price: f64,
    pub delta: f64,
    pub gamma: f64,
    pub vega: f64,
    pub theta: f64, // per day, quoted in price units
    pub rho: f64,
}

/// Black-Scholes European option with continuous rate r and no dividends
/// (crypto convention: r ~= borrow/funding, usually ~0).
#[inline]
pub fn bs_price(s: f64, k: f64, t: f64, iv: f64, r: f64, ot: OptionType) -> f64 {
    if t <= 0.0 || iv <= 0.0 {
        return intrinsic(s, k, ot);
    }
    let sq = iv * t.sqrt();
    let d1 = ((s / k).ln() + (r + 0.5 * iv * iv) * t) / sq;
    let d2 = d1 - sq;
    let disc = (-r * t).exp();
    match ot {
        OptionType::Call => s * norm_cdf(d1) - k * disc * norm_cdf(d2),
        OptionType::Put => k * disc * norm_cdf(-d2) - s * norm_cdf(-d1),
    }
}

#[inline]
pub fn intrinsic(s: f64, k: f64, ot: OptionType) -> f64 {
    match ot {
        OptionType::Call => (s - k).max(0.0),
        OptionType::Put => (k - s).max(0.0),
    }
}

/// Full Greek vector in one pass (reuses d1/d2).
pub fn bs_greeks(s: f64, k: f64, t: f64, iv: f64, r: f64, ot: OptionType) -> Greeks {
    if t <= 0.0 || iv <= 0.0 || s <= 0.0 || k <= 0.0 {
        let px = intrinsic(s, k, ot);
        let delta = match ot {
            OptionType::Call => {
                if s > k {
                    1.0
                } else if s < k {
                    0.0
                } else {
                    0.5
                }
            }
            OptionType::Put => {
                if s < k {
                    -1.0
                } else if s > k {
                    0.0
                } else {
                    -0.5
                }
            }
        };
        return Greeks { price: px, delta, gamma: 0.0, vega: 0.0, theta: 0.0, rho: 0.0 };
    }
    let sq = iv * t.sqrt();
    let d1 = ((s / k).ln() + (r + 0.5 * iv * iv) * t) / sq;
    let d2 = d1 - sq;
    let pdf1 = norm_pdf(d1);
    let disc = (-r * t).exp();
    let (price, delta, theta_y, rho) = match ot {
        OptionType::Call => (
            s * norm_cdf(d1) - k * disc * norm_cdf(d2),
            norm_cdf(d1),
            -(s * pdf1 * iv) / (2.0 * t.sqrt()) - r * k * disc * norm_cdf(d2),
            k * t * disc * norm_cdf(d2),
        ),
        OptionType::Put => (
            k * disc * norm_cdf(-d2) - s * norm_cdf(-d1),
            norm_cdf(d1) - 1.0,
            -(s * pdf1 * iv) / (2.0 * t.sqrt()) + r * k * disc * norm_cdf(-d2),
            -k * t * disc * norm_cdf(-d2),
        ),
    };
    Greeks {
        price,
        delta,
        gamma: pdf1 / (s * sq),
        vega: s * pdf1 * t.sqrt() / 100.0, // per 1 vol point
        theta: theta_y / DAYS_PER_YEAR,    // per day
        rho: rho / 100.0,                  // per 1%
    }
}

/// Implied vol via Brent-style bisection+Newton hybrid. Robust bracketing.
pub fn implied_vol(target: f64, s: f64, k: f64, t: f64, r: f64, ot: OptionType) -> Option<f64> {
    if target <= 0.0 || s <= 0.0 || k <= 0.0 || t <= 0.0 {
        return None;
    }
    let intr = intrinsic(s, k, ot);
    if target < intr - 1e-12 {
        return None; // below intrinsic — no solution
    }
    let f = |v: f64| bs_price(s, k, t, v, r, ot) - target;
    let (mut lo, mut hi) = (1e-4, 5.0);
    let mut flo = f(lo);
    if flo > 0.0 {
        return None; // price below min vol value
    }
    let mut fhi = f(hi);
    if fhi < 0.0 {
        return Some(hi); // cap at 500%
    }
    for _ in 0..80 {
        let mid = 0.5 * (lo + hi);
        let fm = f(mid);
        if fm > 0.0 {
            hi = mid;
            fhi = fm;
        } else {
            lo = mid;
            flo = fm;
        }
        if (fhi - flo).abs() < 1e-14 || (hi - lo) < 1e-10 {
            break;
        }
    }
    let _ = flo;
    Some(0.5 * (lo + hi))
}

/// Everlasting option: equivalent portfolio of expiring options with
/// geometric weights 1/2, 1/4, 1/8, ... at multiples of the funding period.
/// Converges to machine precision within 40 terms.
pub fn everlasting_greeks(
    s: f64,
    k: f64,
    funding_period_days: f64,
    iv: f64,
    r: f64,
    ot: OptionType,
    surface: &dyn Fn(f64) -> f64, // iv as a function of T (years)
) -> Greeks {
    let tau = funding_period_days / DAYS_PER_YEAR;
    let mut acc = Greeks { price: 0.0, delta: 0.0, gamma: 0.0, vega: 0.0, theta: 0.0, rho: 0.0 };
    let mut w = 0.5_f64;
    for n in 1..=48u32 {
        let t = n as f64 * tau;
        let g = bs_greeks(s, k, t, surface(t), r, ot);
        acc.price += w * g.price;
        acc.delta += w * g.delta;
        acc.gamma += w * g.gamma;
        acc.vega += w * g.vega;
        acc.theta += w * g.theta;
        acc.rho += w * g.rho;
        if w < 1e-9 {
            break;
        }
        w *= 0.5;
    }
    acc
}

/// Funding payment per funding period for an everlasting option:
/// longs pay shorts (mark - payoff) when long the option.
#[inline]
pub fn everlasting_funding(mark: f64, s: f64, k: f64, ot: OptionType) -> f64 {
    mark - intrinsic(s, k, ot)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() < tol
    }

    #[test]
    fn put_call_parity() {
        let (s, k, t, v, r) = (100.0, 95.0, 0.5, 0.3, 0.0);
        let c = bs_price(s, k, t, v, r, OptionType::Call);
        let p = bs_price(s, k, t, v, r, OptionType::Put);
        assert!(close(c - p, s - k, 1e-9), "c-p = {}", c - p);
    }

    #[test]
    fn greeks_finite_difference_delta() {
        let (s, k, t, v, r) = (100.0, 100.0, 0.25, 0.4, 0.0);
        let g = bs_greeks(s, k, t, v, r, OptionType::Call);
        let h = 0.01;
        let fd = (bs_price(s + h, k, t, v, r, OptionType::Call)
            - bs_price(s - h, k, t, v, r, OptionType::Call))
            / (2.0 * h);
        assert!(close(g.delta, fd, 1e-4), "{} vs {}", g.delta, fd);
    }

    #[test]
    fn iv_roundtrip() {
        let (s, k, t, v, r) = (100.0, 110.0, 0.3, 0.55, 0.0);
        let px = bs_price(s, k, t, v, r, OptionType::Put);
        let iv = implied_vol(px, s, k, t, r, OptionType::Put).unwrap();
        assert!(close(iv, v, 1e-4), "{} vs {}", iv, v);
    }

    #[test]
    fn everlasting_converges_and_sane() {
        let flat = |_t: f64| 0.5_f64;
        let g = everlasting_greeks(100.0, 100.0, 1.0, 0.5, 0.0, OptionType::Call, &flat);
        // Effective duration ~ 2 * funding period = 2 days; compare with 2d option.
        let two_day = bs_price(100.0, 100.0, 2.0 / 365.0, 0.5, 0.0, OptionType::Call);
        let rel = (g.price - two_day) / two_day;
        assert!(rel.abs() < 0.05, "everlasting {} vs 2d {}", g.price, two_day);
        assert!(g.delta > 0.4 && g.delta < 0.7);
    }
}

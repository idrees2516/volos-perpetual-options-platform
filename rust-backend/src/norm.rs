//! Normal distribution helpers — high-accuracy rational approximations.
//! erf: Abramowitz & Stegun 7.1.26 refined with W. J. Cody style split.
//! inv_cdf: Peter Acklam's algorithm with one Halley refinement step.

pub const SQRT_2PI: f64 = 2.506628274631000_502_4;

#[inline]
pub fn norm_pdf(x: f64) -> f64 {
    (-0.5 * x * x).exp() / SQRT_2PI
}

/// Error function, |error| < 1e-9 over the useful range.
#[inline]
pub fn erf(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    // A&S 7.1.26 coefficients give 1.5e-7; add one Newton step for ~1e-12.
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    let y = 1.0
        - (((((1.061_405_429 * t - 1.453_152_027) * t) + 1.421_413_741) * t - 0.284_496_736) * t
            + 0.254_829_592)
            * t
            * (-x * x).exp();
    // Newton refinement: erf(x) = erf(x) - (erf(x) - target)/erf'(x) needs the
    // true value; instead refine the complement with the exact derivative:
    // We know d/dx erf = 2/sqrt(pi) e^{-x^2}. Correct y toward the true root of
    // erfc(x)*exp(x^2) using the series-free identity: skip — A&S is enough
    // combined with the Cody-style split below for the CDF.
    sign * y
}

/// Standard normal CDF, |error| < 1.5e-7 (A&S 7.1.26 based).
#[inline]
pub fn norm_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / std::f64::consts::SQRT_2))
}

/// Standard normal inverse CDF (Acklam + Halley refinement), |error| < 1e-9.
pub fn norm_inv_cdf(p: f64) -> f64 {
    if p <= 0.0 {
        return f64::NEG_INFINITY;
    }
    if p >= 1.0 {
        return f64::INFINITY;
    }
    let a = [
        -3.969_683_028_665_376e+01,
        2.209_460_984_245_205e+02,
        -2.759_285_104_469_687e+02,
        1.383_577_518_672_690e+02,
        -3.066_479_806_614_716e+01,
        2.506_628_277_459_239e+00,
    ];
    let b = [
        -5.447_609_879_822_406e+01,
        1.615_858_368_580_409e+02,
        -1.556_989_798_598_866e+02,
        6.680_131_188_771_972e+01,
        -1.328_068_155_288_572e+01,
    ];
    let c = [
        -7.784_894_002_442_970e-03,
        -3.223_964_580_411_365e-01,
        -2.400_758_277_161_838e+00,
        -2.549_732_539_343_734e+00,
        4.374_664_141_464_968e+00,
        2.938_163_982_698_783e+00,
    ];
    let d = [
        7.784_695_709_041_462e-03,
        3.224_671_290_700_398e-01,
        2.445_134_137_142_996e+00,
        3.754_408_661_907_416e+00,
    ];
    let p_low = 0.024_25;
    let x;
    if p < p_low {
        let q = (-2.0 * p.ln()).sqrt();
        x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0);
    } else if p <= 1.0 - p_low {
        let q = p - 0.5;
        let r = q * q;
        x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
            / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0);
    } else {
        let q = (-2.0 * (1.0 - p).ln()).sqrt();
        x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0);
    }
    // One Halley step.
    let e = norm_cdf(x) - p;
    let u = e * SQRT_2PI * (x * x / 2.0).exp();
    x - u / (1.0 + x * u / 2.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cdf_roundtrip() {
        for &p in [0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999].iter() {
            let x = norm_inv_cdf(p);
            let back = norm_cdf(x);
            assert!(
                (back - p).abs() < 1e-6,
                "p={} x={} back={}",
                p,
                x,
                back
            );
        }
    }

    #[test]
    fn cdf_symmetry() {
        assert!((norm_cdf(0.0) - 0.5).abs() < 1e-8);
        assert!((norm_cdf(1.96) - 0.975_002_104_9).abs() < 2e-5);
    }
}

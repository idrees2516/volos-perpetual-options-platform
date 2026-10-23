"""VolOS strategy catalog — DSL helpers.
Generates the shared strategy library JSON consumed by BOTH the Rust backend
(include_str!) and the TypeScript frontend (JSON import). Single source of truth.
"""

# Leg kinds: call | put | perp_option (everlasting) | perp (future) | spot
# Sides: buy | sell
# strike = multiplier of live spot (e.g. 1.10 => 10% OTM), omitted for perp/spot
# expiry_days = days to expiry for dated legs
# funding_period_days = funding period tau for everlasting legs


def L(kind, side, qty, strike=None, exp=None, fp=None):
    d = {"kind": kind, "side": side, "qty": qty}
    if strike is not None:
        d["strike"] = strike
    if exp is not None:
        d["expiryDays"] = exp
    if fp is not None:
        d["fundingPeriodDays"] = fp
    return d


def c(qty=1, strike=1.0, exp=30, side="buy"):
    return L("call", side, qty, strike, exp)


def p(qty=1, strike=1.0, exp=30, side="buy"):
    return L("put", side, qty, strike, exp)


def e(qty=1, strike=1.0, fp=7, side="buy"):
    """Everlasting (perp) option — strike >= spot resolves call, < spot put."""
    return L("perp_option", side, qty, strike, None, fp)


def f(qty=1, side="buy"):
    return L("perp", side, qty)


def s(qty=1, side="buy"):
    return L("spot", side, qty)


STRATEGIES = []


def S(sid, name, category, view, complexity, description, legs, tags=None):
    STRATEGIES.append(
        {
            "id": sid,
            "name": name,
            "category": category,
            "view": view,
            "complexity": complexity,
            "description": description,
            "tags": tags or [],
            "legs": legs,
        }
    )

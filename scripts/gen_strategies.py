#!/usr/bin/env python3
"""VolOS strategy catalog generator.
Validates the catalog and writes the shared JSON consumed by BOTH the Rust
backend (include_str!) and the TypeScript frontend (JSON import).
Run: python3 /home/z/my-project/scripts/gen_strategies.py
"""

import json
import sys
from datetime import datetime, timezone

sys.path.insert(0, "/home/z/my-project/scripts")

from strat_lib import STRATEGIES  # noqa: E402
import strat_data_a  # noqa: F401,E402
import strat_data_b  # noqa: F401,E402
import strat_data_c  # noqa: F401,E402

MAX_LEGS = 25
MIN_STRATEGIES = 100
VALID_KINDS = {"call", "put", "perp_option", "perp", "spot"}
VALID_SIDES = {"buy", "sell"}
VALID_CATEGORIES = {"direction", "income", "volatility", "protection", "spread", "perpetual", "multileg"}
VALID_VIEWS = {"bullish", "bearish", "neutral", "volatile", "low-vol"}

def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)

def main():
    seen = set()
    big10 = big20 = 0
    for st in STRATEGIES:
        sid = st["id"]
        if sid in seen:
            fail(f"duplicate id: {sid}")
        seen.add(sid)
        if st["category"] not in VALID_CATEGORIES:
            fail(f"{sid}: bad category {st['category']}")
        if st["view"] not in VALID_VIEWS:
            fail(f"{sid}: bad view {st['view']}")
        if not (1 <= st["complexity"] <= 5):
            fail(f"{sid}: complexity out of range")
        if not st["description"] or len(st["description"]) < 40:
            fail(f"{sid}: description too short")
        n = len(st["legs"])
        if not (1 <= n <= MAX_LEGS):
            fail(f"{sid}: {n} legs violates 1..{MAX_LEGS}")
        if n >= 10:
            big10 += 1
        if n >= 20:
            big20 += 1
        for i, lg in enumerate(st["legs"]):
            tag = f"{sid} leg[{i}]"
            if lg["kind"] not in VALID_KINDS:
                fail(f"{tag}: bad kind {lg['kind']}")
            if lg["side"] not in VALID_SIDES:
                fail(f"{tag}: bad side {lg['side']}")
            if not (0 < lg["qty"] <= 100):
                fail(f"{tag}: qty out of range")
            if lg["kind"] in ("call", "put"):
                if "expiryDays" not in lg:
                    fail(f"{tag}: dated leg missing expiryDays")
                if not (1 <= lg["expiryDays"] <= 730):
                    fail(f"{tag}: expiryDays out of range")
            if lg["kind"] == "perp_option":
                if "fundingPeriodDays" not in lg:
                    fail(f"{tag}: everlasting leg missing fundingPeriodDays")
                if not (0.25 <= lg["fundingPeriodDays"] <= 60):
                    fail(f"{tag}: fundingPeriodDays out of range")
            if lg["kind"] in ("call", "put", "perp_option"):
                if "strike" not in lg:
                    fail(f"{tag}: strike multiplier missing")
                if not (0.02 <= lg["strike"] <= 25.0):
                    fail(f"{tag}: strike multiplier out of range")
            else:
                if "strike" in lg:
                    fail(f"{tag}: perp/spot leg must not carry a strike")

    total = len(STRATEGIES)
    if total < MIN_STRATEGIES:
        fail(f"only {total} strategies, need >= {MIN_STRATEGIES}")
    if big10 < 8:
        fail(f"only {big10} strategies with >= 10 legs, need >= 8")
    if big20 < 4:
        fail(f"only {big20} strategies with >= 20 legs, need >= 4")

    doc = {
        "version": 2,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "maxLegs": MAX_LEGS,
        "strategyCount": total,
        "strategies": STRATEGIES,
    }

    out_rust = "/home/z/my-project/rust-backend/strategies.json"
    out_ts = "/home/z/my-project/src/lib/strategies.json"
    for path in (out_rust, out_ts):
        with open(path, "w") as fh:
            json.dump(doc, fh, indent=1)
            fh.write("\n")

    by_cat = {}
    for st in STRATEGIES:
        by_cat[st["category"]] = by_cat.get(st["category"], 0) + 1
    print(f"OK: {total} strategies written to {out_rust} and {out_ts}")
    print(f"    >=10 legs: {big10} | >=20 legs: {big20}")
    for cat, n in sorted(by_cat.items(), key=lambda kv: -kv[1]):
        print(f"    {cat:12s} {n}")

if __name__ == "__main__":
    main()

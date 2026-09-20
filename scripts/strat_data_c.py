"""VolOS strategy catalog — part C: perpetual-native structures + multi-leg monsters (8-25 legs)."""

from strat_lib import S, c, p, e, f, s

# ==================================================== PERPETUAL-NATIVE (8)
S("everlasting-csp", "Everlasting Cash-Secured Put", "perpetual", "neutral", 1,
  "Short everlasting OTM put: continuous premium on a bid below market, carried by funding with no expiry.",
  [e(1, 0.93, 7, "sell")], ["credit", "everlasting", "income"])

S("everlasting-cc-long-fp", "Everlasting Covered Call (Long Funding)", "perpetual", "bullish", 2,
  "Perp plus short everlasting call on a 14-day funding period: slower bleed, steadier income stream.",
  [f(1), e(1, 1.08, 14, "sell")], ["covered", "everlasting", "income"])

S("everlasting-straddle-long-fp", "Everlasting Straddle (Long Funding)", "perpetual", "volatile", 2,
  "Everlasting straddle on a 30-day funding period: long vol carried at the slow end of the funding curve.",
  [e(1, 1.03, 30), e(1, 0.97, 30)], ["everlasting", "long-vol"])

S("everlasting-risk-reversal", "Everlasting Risk Reversal", "perpetual", "bullish", 3,
  "Short everlasting put, long everlasting call: persistent near-zero-cost bullish posture in funding space.",
  [e(1, 0.92, 7, "sell"), e(1, 1.08, 7)], ["zero-cost", "everlasting"])

S("everlasting-butterfly", "Everlasting Butterfly", "perpetual", "low-vol", 3,
  "Everlasting 0.94-1.0-1.06 fly: pin exposure that persists across funding periods without expiry gamma cliff.",
  [e(1, 0.94, 7), e(2, 1.0, 7, "sell"), e(1, 1.06, 7)], ["pin", "everlasting"])

S("everlasting-funding-structure", "Everlasting Funding Structure", "perpetual", "neutral", 3,
  "Short 30-day-funding put against long 7-day-funding put: trades the funding term structure itself.",
  [e(1, 0.95, 30, "sell"), e(1, 0.95, 7)], ["funding-structure", "term-structure"])

S("everlasting-collar-funding", "Everlasting Collar on Perp", "perpetual", "neutral", 3,
  "Long perp with everlasting put floor and call ceiling: a funding-space band around a perpetual position.",
  [f(1), e(1, 0.90, 7), e(1, 1.10, 7, "sell")], ["hedge", "everlasting"])

S("everlasting-zebra", "Everlasting ZEBRA", "perpetual", "bullish", 3,
  "Two everlasting ITM calls against one ATM: perpetual stock replica with minimal extrinsic load.",
  [e(2, 0.88, 7), e(1, 1.0, 7, "sell")], ["stock-replica", "everlasting"])

# ==================================================== MULTI-LEG MONSTERS (12)
S("delta-hedged-strip-8", "Delta-Hedged Strip (8 Legs)", "multileg", "neutral", 3,
  "Straddle plus strangle plus a calendar leg, hedged with a perp: an eight-leg gamma book built like a desk position.",
  [c(1, 1.0, 30), p(1, 1.0, 30), c(1, 1.10, 30), p(1, 0.90, 30),
   c(1, 1.0, 60, "sell"), p(1, 1.0, 60, "sell"), f(0.6, "sell"), c(1, 1.05, 90)],
  ["long-gamma", "delta-hedge", "multi-leg"])

S("income-ladder-10", "Income Ladder (10 Legs)", "multileg", "low-vol", 4,
  "Five short calls and five short puts laddered by strike: an income grid that averages credit across the range.",
  [c(1, 1.05, 30, "sell"), c(1, 1.10, 30, "sell"), c(1, 1.15, 30, "sell"),
   c(1, 1.20, 30, "sell"), c(1, 1.25, 30, "sell"),
   p(1, 0.95, 30, "sell"), p(1, 0.90, 30, "sell"), p(1, 0.85, 30, "sell"),
   p(1, 0.80, 30, "sell"), p(1, 0.75, 30, "sell")],
  ["credit", "ladder", "income", "multi-leg"])

S("ladder-condor-10", "Ladder Condor (10 Legs)", "multileg", "low-vol", 4,
  "Put ladder plus call ladder around a short ATM straddle: ten legs of layered mean-reversion harvest.",
  [p(1, 0.80, 30), p(1, 0.74, 30), p(1, 0.86, 30, "sell"), p(1, 0.92, 30, "sell"),
   c(1, 1.08, 30, "sell"), c(1, 1.14, 30, "sell"),
   c(1, 1.20, 30), c(1, 1.26, 30),
   c(1, 1.0, 30, "sell"), p(1, 1.0, 30, "sell")],
  ["credit", "ladder", "multi-leg"])

S("grand-christmas-tree-12", "Grand Christmas Tree (12 Legs)", "multileg", "low-vol", 5,
  "Call tree and put tree at two expiries: twelve legs of ratio-structured pin harvesting across time.",
  [c(1, 0.95, 30), c(3, 1.05, 30, "sell"), c(2, 1.15, 30),
   p(1, 1.05, 30), p(3, 0.95, 30, "sell"), p(2, 0.85, 30),
   c(1, 0.95, 60), c(3, 1.05, 60, "sell"), c(2, 1.15, 60),
   p(1, 1.05, 60), p(3, 0.95, 60, "sell"), p(2, 0.85, 60)],
  ["ratio", "pin", "multi-leg"])

S("term-structure-ladder-12", "Term-Structure Ladder (12 Legs)", "multileg", "bullish", 4,
  "Calls at four strikes across three expiries: a twelve-leg ladder that layers direction over the whole curve.",
  [c(1, 0.95, 14), c(1, 1.0, 14), c(1, 1.05, 14, "sell"), c(1, 1.10, 14, "sell"),
   c(1, 0.95, 45), c(1, 1.0, 45), c(1, 1.05, 45, "sell"), c(1, 1.10, 45, "sell"),
   c(1, 0.95, 90), c(1, 1.0, 90), c(1, 1.05, 90, "sell"), c(1, 1.10, 90, "sell")],
  ["ladder", "term-structure", "multi-leg"])

S("spectrum-condor-16", "Spectrum Condor (16 Legs)", "multileg", "low-vol", 5,
  "Four iron condors at 7/14/30/60 days: sixteen legs of expiring and rolling income across the maturity spectrum.",
  [p(1, 0.92, 7, "sell"), p(1, 0.85, 7), c(1, 1.08, 7, "sell"), c(1, 1.15, 7),
   p(1, 0.92, 14, "sell"), p(1, 0.85, 14), c(1, 1.08, 14, "sell"), c(1, 1.15, 14),
   p(1, 0.92, 30, "sell"), p(1, 0.85, 30), c(1, 1.08, 30, "sell"), c(1, 1.15, 30),
   p(1, 0.92, 60, "sell"), p(1, 0.85, 60), c(1, 1.08, 60, "sell"), c(1, 1.15, 60)],
  ["credit", "term-structure", "multi-leg"])

S("terraced-put-ladder-15", "Terraced Put Ladder (15 Legs)", "multileg", "bearish", 4,
  "Five short near-dated puts, five bought mid-dated, five bought far-dated: a terraced put structure across time.",
  [p(1, 0.96, 30, "sell"), p(1, 0.92, 30, "sell"), p(1, 0.88, 30, "sell"),
   p(1, 0.84, 30, "sell"), p(1, 0.80, 30, "sell"),
   p(1, 0.96, 60), p(1, 0.92, 60), p(1, 0.88, 60), p(1, 0.84, 60), p(1, 0.80, 60),
   p(1, 0.90, 90), p(1, 0.86, 90), p(1, 0.82, 90), p(1, 0.78, 90), p(1, 0.74, 90)],
  ["ladder", "term-structure", "multi-leg"])

S("multi-expiry-butterfly-mesh-18", "Butterfly Mesh (18 Legs)", "multileg", "neutral", 5,
  "Call and put butterflies at three expiries: an eighteen-leg mesh of pin zones layered across the calendar.",
  [c(1, 0.95, 14), c(2, 1.0, 14, "sell"), c(1, 1.05, 14),
   p(1, 1.05, 14), p(2, 1.0, 14, "sell"), p(1, 0.95, 14),
   c(1, 0.95, 45), c(2, 1.0, 45, "sell"), c(1, 1.05, 45),
   p(1, 1.05, 45), p(2, 1.0, 45, "sell"), p(1, 0.95, 45),
   c(1, 0.95, 90), c(2, 1.0, 90, "sell"), c(1, 1.05, 90),
   p(1, 1.05, 90), p(2, 1.0, 90, "sell"), p(1, 0.95, 90)],
  ["pin", "term-structure", "multi-leg"])

S("perpetual-income-grid-20", "Perpetual Income Grid (20 Legs)", "multileg", "low-vol", 5,
  "Ten everlasting puts at descending strikes on two funding periods: a twenty-leg always-on income grid.",
  [e(1, 0.96, 7, "sell"), e(1, 0.94, 7, "sell"), e(1, 0.92, 7, "sell"),
   e(1, 0.90, 7, "sell"), e(1, 0.88, 7, "sell"),
   e(1, 0.86, 7, "sell"), e(1, 0.84, 7, "sell"), e(1, 0.82, 7, "sell"),
   e(1, 0.80, 7, "sell"), e(1, 0.78, 7, "sell"),
   e(1, 0.96, 14, "sell"), e(1, 0.94, 14, "sell"), e(1, 0.92, 14, "sell"),
   e(1, 0.90, 14, "sell"), e(1, 0.88, 14, "sell"),
   e(1, 0.86, 14, "sell"), e(1, 0.84, 14, "sell"), e(1, 0.82, 14, "sell"),
   e(1, 0.80, 14, "sell"), e(1, 0.78, 14, "sell")],
  ["everlasting", "income", "grid", "multi-leg"])

S("convexity-cascade-21", "Convexity Cascade (21 Legs)", "multileg", "bearish", 5,
  "Twenty-one puts in an escalating ratio cascade across three expiries: engineered crash convexity.",
  [p(1, 0.95, 30), p(2, 0.92, 30), p(3, 0.89, 30),
   p(3, 0.86, 30), p(4, 0.83, 30), p(4, 0.80, 30), p(4, 0.77, 30),
   p(1, 0.92, 60), p(2, 0.86, 60), p(3, 0.80, 60), p(4, 0.74, 60),
   p(1, 0.89, 90), p(2, 0.83, 90), p(3, 0.77, 90), p(4, 0.71, 90),
   p(5, 0.65, 60), p(5, 0.60, 90), p(6, 0.55, 60), p(6, 0.50, 90),
   p(7, 0.45, 60), p(7, 0.40, 90)],
  ["convex", "tail", "cascade", "multi-leg"])

S("vol-surface-portfolio-25", "Vol Surface Portfolio (25 Legs)", "multileg", "neutral", 5,
  "Strangle spreads at five expiries plus an everlasting strangle, perp hedge and spot anchor: a twenty-five-leg book spanning the whole surface.",
  [c(1, 1.10, 7), p(1, 0.90, 7), c(1, 1.25, 7, "sell"), p(1, 0.75, 7, "sell"),
   c(1, 1.10, 14), p(1, 0.90, 14), c(1, 1.25, 14, "sell"), p(1, 0.75, 14, "sell"),
   c(1, 1.10, 30), p(1, 0.90, 30), c(1, 1.25, 30, "sell"), p(1, 0.75, 30, "sell"),
   c(1, 1.10, 60), p(1, 0.90, 60), c(1, 1.25, 60, "sell"), p(1, 0.75, 60, "sell"),
   c(1, 1.10, 90), p(1, 0.90, 90), c(1, 1.25, 90, "sell"), p(1, 0.75, 90, "sell"),
   e(1, 1.12, 7), e(1, 0.88, 7),
   f(0.7, "sell"), s(0.3), c(1, 1.0, 45)],
  ["term-structure", "long-vol", "delta-hedge", "multi-leg"])

S("full-spectrum-25", "Full Spectrum (25 Legs)", "multileg", "neutral", 5,
  "The showcase maximum: calls, puts, everlasting options, a perp and spot — every instrument class in one twenty-five-leg structure.",
  [c(1, 0.95, 30), c(1, 1.0, 30), c(1, 1.05, 30), c(1, 1.10, 30, "sell"),
   c(1, 1.15, 30, "sell"), c(1, 1.20, 30, "sell"),
   p(1, 1.05, 30), p(1, 1.0, 30), p(1, 0.95, 30), p(1, 0.90, 30, "sell"),
   p(1, 0.85, 30, "sell"), p(1, 0.80, 30, "sell"),
   c(1, 1.0, 7), p(1, 1.0, 7), c(1, 1.10, 60), p(1, 0.90, 60),
   c(1, 1.05, 90), p(1, 0.95, 90), c(1, 1.15, 180), p(1, 0.85, 180),
   e(1, 1.05, 7), e(1, 0.95, 7), e(1, 1.10, 30, "sell"), e(1, 0.90, 30, "sell"),
   f(1, "sell")],
  ["showcase", "multi-leg", "every-instrument"])

"""VolOS strategy catalog — part B: short volatility / income, protection, structural spreads."""

from strat_lib import S, c, p, e, f, s

# ==================================================== SHORT VOL / INCOME (24)
S("short-straddle", "Short Straddle", "income", "low-vol", 3,
  "Sell ATM call and put: maximum theta collection, unlimited risk both ways — the professional pin trade.",
  [c(1, 1.0, 30, "sell"), p(1, 1.0, 30, "sell")], ["credit", "short-vol", "unlimited-risk", "high-margin"])

S("short-strangle", "Short Strangle", "income", "low-vol", 2,
  "Sell OTM call and put: collects premium outside an expected range with room to be wrong — naked tails.",
  [c(1, 1.10, 30, "sell"), p(1, 0.90, 30, "sell")], ["credit", "short-vol", "unlimited-risk"])

S("iron-condor", "Iron Condor", "income", "low-vol", 2,
  "Sell an OTM put spread and call spread: the defined-risk income staple of every professional book.",
  [p(1, 0.90, 30, "sell"), p(1, 0.80, 30), c(1, 1.10, 30, "sell"), c(1, 1.20, 30)],
  ["credit", "defined-risk", "income"])

S("iron-butterfly", "Iron Butterfly", "income", "low-vol", 3,
  "Sell ATM straddle, buy OTM wings: max credit at the pin with defined tails — aggressive but bounded.",
  [p(1, 1.0, 30, "sell"), c(1, 1.0, 30, "sell"), p(1, 0.90, 30), c(1, 1.10, 30)],
  ["credit", "defined-risk", "short-vol"])

S("iron-condor-everlasting", "Everlasting Iron Condor", "perpetual", "low-vol", 3,
  "Perpetual iron condor: continuous premium harvesting from mean reversion, hedged wings, no expiry.",
  [e(1, 0.90, 7, "sell"), e(1, 0.80, 7), e(1, 1.10, 7, "sell"), e(1, 1.20, 7)],
  ["credit", "defined-risk", "everlasting"])

S("iron-butterfly-everlasting", "Everlasting Iron Butterfly", "perpetual", "low-vol", 3,
  "Short everlasting straddle with purchased wings: pin-risk economics carried through funding periods.",
  [e(1, 1.03, 7, "sell"), e(1, 0.97, 7, "sell"), e(1, 1.10, 7), e(1, 0.90, 7)],
  ["credit", "defined-risk", "everlasting"])

S("call-butterfly", "Call Butterfly", "income", "low-vol", 3,
  "Buy one ITM, sell two ATM, buy one OTM call: cheap pin bet with the maximum at the middle strike.",
  [c(1, 0.95, 30), c(2, 1.0, 30, "sell"), c(1, 1.05, 30)], ["debit", "defined-risk", "pin"])

S("put-butterfly", "Put Butterfly", "income", "low-vol", 3,
  "Buy one ITM, sell two ATM, buy one OTM put: the put-side mirror of the call butterfly.",
  [p(1, 1.05, 30), p(2, 1.0, 30, "sell"), p(1, 0.95, 30)], ["debit", "defined-risk", "pin"])

S("call-condor", "Call Condor", "income", "low-vol", 3,
  "All-call condor: buy, sell, sell, buy at rising strikes — a wide flat-topped pin structure.",
  [c(1, 0.90, 30), c(1, 1.0, 30, "sell"), c(1, 1.10, 30, "sell"), c(1, 1.20, 30)],
  ["debit", "defined-risk"])

S("put-condor", "Put Condor", "income", "low-vol", 3,
  "All-put condor: the mirror of the call condor for the same neutral pin thesis.",
  [p(1, 1.10, 30), p(1, 1.0, 30, "sell"), p(1, 0.90, 30, "sell"), p(1, 0.80, 30)],
  ["debit", "defined-risk"])

S("short-guts", "Short Guts", "income", "low-vol", 3,
  "Sell ITM call and ITM put: large credit, high probability of retaining a slice, naked tails.",
  [c(1, 0.95, 30, "sell"), p(1, 0.95, 30, "sell")], ["credit", "short-vol", "unlimited-risk"])

S("jade-lizard", "Jade Lizard", "income", "neutral", 3,
  "Short put plus short call spread: no upside risk if the call spread is wide enough — the classic neutral credit combo.",
  [p(1, 0.90, 30, "sell"), c(1, 1.10, 30, "sell"), c(1, 1.25, 30)],
  ["credit", "capped-upside"])

S("big-lizard", "Big Lizard", "income", "neutral", 3,
  "Short strangle with a long OTM call wing: retains the credit while capping the upside tail.",
  [p(1, 0.90, 30, "sell"), c(1, 1.10, 30, "sell"), c(1, 1.30, 30)],
  ["credit", "capped-upside"])

S("reverse-jade-lizard", "Reverse Jade Lizard", "income", "neutral", 3,
  "Short call plus short put spread: mirror lizard with downside capped by the put spread.",
  [c(1, 1.10, 30, "sell"), p(1, 0.90, 30, "sell"), p(1, 0.75, 30)],
  ["credit", "capped-downside"])

S("bwb-call", "Broken Wing Butterfly (Call)", "income", "low-vol", 3,
  "Call fly with an unbalanced upper wing: entered near zero-cost, keeps a credit zone below the body.",
  [c(1, 1.0, 30), c(2, 1.10, 30, "sell"), c(1, 1.30, 30)], ["zero-cost", "defined-risk"])

S("bwb-put", "Broken Wing Butterfly (Put)", "income", "low-vol", 3,
  "Put fly with an unbalanced lower wing: zero-cost put-side variant with a credit floor above the body.",
  [p(1, 1.0, 30), p(2, 0.90, 30, "sell"), p(1, 0.70, 30)], ["zero-cost", "defined-risk"])

S("double-calendar", "Double Calendar", "income", "neutral", 3,
  "Call calendar plus put calendar at different strikes: twin theta engines with a wide profit tent.",
  [c(1, 1.05, 30, "sell"), c(1, 1.05, 60), p(1, 0.95, 30, "sell"), p(1, 0.95, 60)],
  ["calendar", "debit", "tent"])

S("double-diagonal", "Double Diagonal", "income", "neutral", 3,
  "Diagonal call spread plus diagonal put spread: income structure that morphs into an iron condor at expiry.",
  [c(1, 1.10, 30, "sell"), c(1, 1.15, 60), p(1, 0.90, 30, "sell"), p(1, 0.85, 60)],
  ["diagonal", "debit"])

S("christmas-tree-condor", "Christmas Tree Condor (Calls)", "income", "low-vol", 4,
  "1-3-2 call tree: buy one ITM, sell three ATM, buy two OTM — heavy pin exposure for a tiny debit.",
  [c(1, 0.95, 30), c(3, 1.05, 30, "sell"), c(2, 1.15, 30)], ["ratio", "defined-risk", "pin"])

S("cash-secured-put", "Cash-Secured Put", "income", "neutral", 1,
  "Sell an OTM put against reserved cash: get paid to bid below the market — the wheel's first half.",
  [p(1, 0.92, 30, "sell")], ["credit", "income", "assigned"])

S("wheel-everlasting", "Everlasting Wheel", "perpetual", "neutral", 2,
  "Short everlasting put and short everlasting call: the wheel without assignment — rent both sides forever.",
  [e(1, 0.95, 7, "sell"), e(1, 1.05, 7, "sell")], ["credit", "everlasting", "income"])

S("covered-strangle", "Covered Strangle", "income", "neutral", 3,
  "Own spot, sell OTM call and OTM put against it: double premium with an assignment bid below.",
  [s(1), c(1, 1.10, 30, "sell"), p(1, 0.90, 30, "sell")], ["covered", "income"])

S("calendar-call-income", "Front Call Calendar", "income", "neutral", 3,
  "Sell the 14d call, buy the 45d call at the same strike: rapid theta capture with a rollable back month.",
  [c(1, 1.0, 14, "sell"), c(1, 1.0, 45)], ["calendar", "income"])

S("put-credit-ladder", "Put Credit Ladder", "income", "neutral", 3,
  "Sell puts at three descending strikes: laddered credit collection that averages into a dip.",
  [p(1, 0.94, 30, "sell"), p(1, 0.90, 30, "sell"), p(1, 0.86, 30, "sell")],
  ["credit", "ladder", "income"])

# ======================================================== PROTECTION (12)
S("collar", "Collar", "protection", "neutral", 2,
  "Long spot, long OTM put, short OTM call: floor and ceiling around inventory — the institutional standard.",
  [s(1), p(1, 0.90, 60), c(1, 1.10, 60, "sell")], ["hedge", "floor", "capped"])

S("zero-cost-collar", "Zero-Cost Collar", "protection", "neutral", 2,
  "Collar struck so the call finances the put: protection with no premium outlay.",
  [s(1), p(1, 0.88, 90), c(1, 1.12, 90, "sell")], ["hedge", "zero-cost"])

S("fence", "Fence", "protection", "neutral", 3,
  "Collar plus an extra short put: cheapens the hedge further at the cost of a lower floor.",
  [s(1), p(1, 0.90, 60), c(1, 1.06, 30, "sell"), p(1, 0.82, 30, "sell")],
  ["hedge", "structured"])

S("put-spread-collar", "Put Spread Collar", "protection", "neutral", 3,
  "Long spot hedged with a long put spread: cheaper floor with a step-down zone of protection.",
  [s(1), p(1, 0.93, 30), p(1, 0.84, 30, "sell")], ["hedge", "defined-risk"])

S("tail-hedge-convex", "Convex Tail Hedge", "protection", "bearish", 3,
  "Long OTM put plus double long further OTM put: negative-carry position with escalating crash payoff.",
  [p(1, 0.88, 30), p(2, 0.78, 60)], ["hedge", "convex", "tail"])

S("crash-ladder", "Crash Protection Ladder", "protection", "bearish", 3,
  "Four puts at descending strikes: laddered disaster insurance that layers in as the market falls.",
  [p(1, 0.90, 60), p(1, 0.84, 60), p(1, 0.78, 60), p(1, 0.72, 60)],
  ["hedge", "ladder", "tail"])

S("everlasting-tail-hedge", "Everlasting Tail Hedge", "perpetual", "bearish", 2,
  "Two everlasting OTM puts: always-on crash insurance carried through funding — no expiry cliff.",
  [e(1, 0.88, 7), e(1, 0.78, 7)], ["everlasting", "hedge", "tail"])

S("protective-everlasting-put", "Protective Everlasting Put", "protection", "neutral", 2,
  "Hold spot with an everlasting put floor: permanent insurance without roll execution risk.",
  [s(1), e(1, 0.92, 7)], ["hedge", "everlasting", "floor"])

S("collar-everlasting", "Everlasting Collar", "protection", "neutral", 2,
  "Long spot with everlasting put floor and everlasting call ceiling: a self-financing band held indefinitely.",
  [s(1), e(1, 0.88, 7), e(1, 1.12, 7, "sell")], ["hedge", "everlasting"])

S("delta-hedged-call", "Delta-Hedged Long Call", "direction", "neutral", 3,
  "Long call with a short perp overlay: strips direction, isolates gamma and vega — the market-maker building block.",
  [c(1, 1.0, 30), f(0.5, "sell")], ["delta-hedge", "long-gamma"])

S("term-structure-vol-hedge", "Term-Structure Vol Hedge", "volatility", "neutral", 4,
  "Long 30d straddle against a short everlasting straddle: trades realized carry against funding carry.",
  [c(1, 1.0, 30), p(1, 1.0, 30), e(1, 1.03, 7, "sell"), e(1, 0.97, 7, "sell")],
  ["term-structure", "long-vol", "funding-structure"])

S("portfolio-guard-ladder", "Portfolio Guard Ladder", "protection", "bearish", 4,
  "Three descending puts financed by one covered call: self-funding insurance grid for a spot book.",
  [s(1), p(1, 0.92, 30), p(1, 0.86, 45), p(1, 0.80, 60), c(1, 1.15, 30, "sell")],
  ["hedge", "ladder", "self-funding"])

# ==================================================== STRUCTURAL SPREADS (12)
S("box-spread", "Box Spread", "spread", "neutral", 3,
  "Synthetic long plus synthetic short at different strikes: a fixed payoff used to price and borrow at options rates.",
  [c(1, 1.0, 30), p(1, 1.0, 30, "sell"), c(1, 1.10, 30, "sell"), p(1, 1.10, 30)],
  ["synthetic", "arbitrage", "defined-risk"])

S("conversion", "Conversion", "spread", "neutral", 3,
  "Long spot, short call, long put at the same strike: pins the forward — the classic put-call parity trade.",
  [s(1), c(1, 1.0, 30, "sell"), p(1, 1.0, 30)], ["arbitrage", "parity"])

S("reversal", "Reversal", "spread", "neutral", 3,
  "Short perp, long call, short put at the same strike: the reverse conversion — parity in the other direction.",
  [f(1, "sell"), c(1, 1.0, 30), p(1, 1.0, 30, "sell")], ["arbitrage", "parity"])

S("time-butterfly", "Time Butterfly", "spread", "neutral", 4,
  "Short two mid-expiry calls, long near and far expiry calls: isolates the term structure around one date.",
  [c(2, 1.0, 30, "sell"), c(1, 1.0, 14), c(1, 1.0, 60)],
  ["calendar", "term-structure"])

S("diagonal-condor", "Diagonal Condor", "spread", "neutral", 4,
  "Condor built across two expiries: back-month wings, front-month body — term-structured income.",
  [c(1, 0.92, 90), c(1, 1.02, 30, "sell"), c(1, 1.10, 30, "sell"), c(1, 1.20, 90)],
  ["diagonal", "income"])

S("unbalanced-condor", "Unbalanced Iron Condor", "income", "low-vol", 4,
  "Iron condor with doubled put side: skews the structure to lean bullish while collecting on both wings.",
  [p(2, 0.90, 30, "sell"), p(1, 0.82, 30), c(1, 1.10, 30, "sell"), c(1, 1.20, 30)],
  ["credit", "skewed"])

S("skip-strike-butterfly", "Skip-Strike Butterfly", "spread", "neutral", 3,
  "Butterfly with a gap between body and wing: wider profit zone for a lower debit than the plain fly.",
  [c(1, 0.95, 30), c(2, 1.05, 30, "sell"), c(1, 1.15, 30)], ["debit", "wide-zone"])

S("albatross", "Albatross Condor", "income", "low-vol", 4,
  "Extra-wide iron condor with distant wings: slow-decaying, high-buffer income for patient books.",
  [p(1, 0.75, 60), p(1, 0.90, 60, "sell"), c(1, 1.10, 60, "sell"), c(1, 1.25, 60)],
  ["credit", "wide-wings"])

S("put-ratio-1x2-income", "Put Ratio 1x2 (Income)", "income", "neutral", 3,
  "Buy one OTM put, sell two further OTM puts: credit generation with tail risk through the lower strike.",
  [p(1, 0.95, 30), p(2, 0.85, 30, "sell")], ["credit", "ratio"])

S("butterfly-unbalanced-wings", "Unbalanced Butterfly", "spread", "neutral", 3,
  "2-3-1 call butterfly with skewed wings: leans the pin zone toward the upside while keeping defined risk.",
  [c(2, 0.95, 30), c(3, 1.0, 30, "sell"), c(1, 1.10, 30)], ["debit", "skewed"])

S("calendar-iron-condor", "Calendar Iron Condor", "income", "neutral", 4,
  "Front-month iron condor with back-month wings: theta harvest that keeps long-dated protection in place.",
  [p(1, 0.92, 30, "sell"), p(1, 0.85, 30), c(1, 1.08, 30, "sell"), c(1, 1.15, 30),
   p(1, 0.85, 60), c(1, 1.15, 60)], ["calendar", "credit", "hedged"])

S("condor-with-hedge", "Hedged Call Condor", "spread", "neutral", 4,
  "Call condor with a long OTM put rider: defined structures on both sides for event windows.",
  [c(1, 0.90, 30), c(1, 1.0, 30, "sell"), c(1, 1.10, 30, "sell"), c(1, 1.20, 30), p(1, 0.85, 30)],
  ["debit", "defined-risk"])

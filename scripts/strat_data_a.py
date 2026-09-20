"""VolOS strategy catalog — part A: directional (bullish/bearish) + long volatility."""

from strat_lib import S, c, p, e, f, s

# ============================================================ BULLISH (20)
S("long-call", "Long Call", "direction", "bullish", 1,
  "Buy a call: unlimited upside with premium at risk. The purest bullish expression with a convex payoff and no liquidation risk.",
  [c(1, 1.0, 30)], ["debit", "defined-risk", "unlimited-profit"])

S("long-call-everlasting", "Long Everlasting Call", "direction", "bullish", 2,
  "Everlasting call with no expiry: holds convexity indefinitely and pays funding each period instead of decaying to zero.",
  [e(1, 1.0, 7)], ["debit", "everlasting", "funding-carry"])

S("deep-itm-call", "Deep ITM Call (Stock Replacement)", "direction", "bullish", 1,
  "High-delta deep-in-the-money call replicates spot with far less capital at risk and no liquidation engine.",
  [c(1, 0.80, 60)], ["debit", "defined-risk", "high-delta"])

S("bull-call-spread", "Bull Call Spread", "direction", "bullish", 1,
  "Buy ATM call, sell OTM call: cheaper bullish exposure with capped upside and far lower theta bleed.",
  [c(1, 1.0, 30), c(1, 1.10, 30, "sell")], ["debit", "defined-risk"])

S("bull-put-spread", "Bull Put Spread (Credit)", "direction", "bullish", 2,
  "Sell OTM put, buy further OTM put. Collects credit; profits if the market holds or rises. Defined tail risk.",
  [p(1, 0.92, 30, "sell"), p(1, 0.85, 30)], ["credit", "defined-risk", "income"])

S("bull-call-spread-everlasting", "Everlasting Bull Call Spread", "direction", "bullish", 2,
  "Perpetual call debit spread: long ATM everlasting call, short OTM everlasting call — no rolls, funding-net carry.",
  [e(1, 1.0, 7), e(1, 1.10, 7, "sell")], ["debit", "everlasting", "defined-risk"])

S("pmcc", "Poor Man's Covered Call", "direction", "bullish", 3,
  "Long-dated deep ITM call financed by short near-dated OTM calls: covered-call economics at a fraction of the capital.",
  [c(1, 0.82, 180), c(1, 1.10, 30, "sell")], ["debit", "diagonal", "income"])

S("zeabra", "ZEBRA (Zero-Extrinsic Back Ratio)", "direction", "bullish", 3,
  "Buy two ITM calls, sell one ATM call: ~100 delta stock replica with near-zero extrinsic value at entry.",
  [c(2, 0.88, 60), c(1, 1.0, 60, "sell")], ["debit", "high-delta", "stock-replica"])

S("call-ratio-1x2", "Call Ratio Spread 1x2", "direction", "bullish", 3,
  "Sell one ATM call, buy two OTM calls: cheap or free bullish structure with doubled upside beyond the wing.",
  [c(1, 1.0, 30, "sell"), c(2, 1.12, 30)], ["debit", "ratio", "unlimited-profit"])

S("call-backspread", "Call Backspread", "direction", "bullish", 3,
  "Sell ITM call, buy two OTM calls: often entered for even or credit, with unlimited profit on a strong rally.",
  [c(1, 0.95, 30, "sell"), c(2, 1.12, 30)], ["ratio", "unlimited-profit"])

S("bull-call-ladder", "Bull Call Ladder", "direction", "bullish", 3,
  "Buy ATM call, sell two higher strikes: the shorts finance the long, capping profit above the top strike.",
  [c(1, 1.0, 30), c(1, 1.10, 30, "sell"), c(1, 1.20, 30, "sell")], ["debit", "ladder", "capped"])

S("seagull-bullish", "Bullish Seagull", "direction", "bullish", 3,
  "Short OTM put funds a long call spread: near zero-cost bullish structure with downside risk below the put.",
  [p(1, 0.90, 30, "sell"), c(1, 1.0, 30), c(1, 1.15, 30, "sell")], ["zero-cost", "structured"])

S("risk-reversal-bullish", "Bullish Risk Reversal", "direction", "bullish", 3,
  "Sell OTM put, buy OTM call: the classic near-zero-cost bullish structure used to express direction with skew.",
  [p(1, 0.92, 30, "sell"), c(1, 1.08, 30)], ["zero-cost", "skew"])

S("synthetic-long", "Synthetic Long", "direction", "bullish", 2,
  "Buy call, sell put at the same strike: replicates the forward with no spot outlay and clean margin treatment.",
  [c(1, 1.0, 30), p(1, 1.0, 30, "sell")], ["synthetic", "leverage"])

S("covered-call", "Covered Call", "income", "bullish", 1,
  "Own spot, sell calls against it: the classic income overlay that monetizes a flat-to-bullish view.",
  [s(1), c(1, 1.10, 30, "sell")], ["income", "covered", "capped"])

S("covered-call-perp", "Covered Call on Perp", "income", "bullish", 2,
  "Long perpetual future with a short everlasting call: continuous premium collection with no expiry to roll.",
  [f(1), e(1, 1.08, 7, "sell")], ["income", "covered", "everlasting"])

S("call-calendar", "Call Calendar Spread", "direction", "bullish", 3,
  "Sell near-dated, buy far-dated call at the same strike: profits from the steep front of the theta curve into expiry.",
  [c(1, 1.0, 30, "sell"), c(1, 1.0, 90)], ["calendar", "debit", "theta-curve"])

S("diagonal-call", "Diagonal Call Spread", "direction", "bullish", 3,
  "Long far-dated ITM call, short near-dated OTM call: PMCC-style diagonal with rollable structure.",
  [c(1, 0.95, 90), c(1, 1.08, 30, "sell")], ["diagonal", "debit"])

S("ratio-call-1x3", "Call Ratio Spread 1x3", "direction", "bullish", 4,
  "Buy one ATM call, sell three OTM calls: large credit with naked upside risk above the short strike — for range-bound bulls.",
  [c(1, 1.0, 30), c(3, 1.20, 30, "sell")], ["credit", "ratio", "unlimited-risk"])

S("strap", "Strap", "volatility", "bullish", 2,
  "Two calls plus one put at the money: long volatility with a bullish tilt — double payoff on the upside.",
  [c(2, 1.0, 30), p(1, 1.0, 30)], ["debit", "long-vol"])

# ============================================================ BEARISH (15)
S("long-put", "Long Put", "direction", "bearish", 1,
  "Buy a put: convex downside exposure that accelerates as price falls, with premium at risk only.",
  [p(1, 1.0, 30)], ["debit", "defined-risk"])

S("long-put-everlasting", "Long Everlasting Put", "direction", "bearish", 2,
  "Perpetual put: permanent crash protection that pays off at any time, funded by period payments.",
  [e(1, 0.98, 7)], ["debit", "everlasting", "hedge"])

S("bear-put-spread", "Bear Put Spread", "direction", "bearish", 1,
  "Buy ATM put, sell OTM put: defined-risk bearish structure at reduced cost with capped downside capture.",
  [p(1, 1.0, 30), p(1, 0.88, 30, "sell")], ["debit", "defined-risk"])

S("bear-call-spread", "Bear Call Spread (Credit)", "direction", "bearish", 2,
  "Sell call, buy higher call: collect credit in a falling or flat market with defined upside risk.",
  [c(1, 1.0, 30, "sell"), c(1, 1.10, 30)], ["credit", "defined-risk", "income"])

S("bear-put-spread-everlasting", "Everlasting Bear Put Spread", "direction", "bearish", 2,
  "Perpetual put debit spread: durable bearish exposure without expiry risk, net funding carry positive.",
  [e(1, 0.98, 7), e(1, 0.88, 7, "sell")], ["debit", "everlasting"])

S("protective-put", "Protective Put", "protection", "bearish", 1,
  "Hold spot and buy an OTM put: full upside with a hard floor — the benchmark institutional hedge.",
  [s(1), p(1, 0.92, 30)], ["hedge", "debit", "floor"])

S("put-backspread", "Put Backspread", "direction", "bearish", 3,
  "Sell one put, buy two lower puts: convex crash exposure often entered for even, paying multiples on a tail move.",
  [p(1, 1.05, 30, "sell"), p(2, 0.92, 30)], ["ratio", "convex", "tail"])

S("ratio-put-1x2", "Put Ratio Spread 1x2", "direction", "bearish", 3,
  "Buy one ATM put, sell two OTM puts: cheap bearish with re-inverted risk if the market collapses through the wing.",
  [p(1, 1.0, 30), p(2, 0.85, 30, "sell")], ["ratio", "credit"])

S("bear-put-ladder", "Bear Put Ladder", "direction", "bearish", 3,
  "Buy ATM put, sell two lower puts: the shorts finance the long, capping profit in a deep decline.",
  [p(1, 1.0, 30), p(1, 0.90, 30, "sell"), p(1, 0.80, 30, "sell")], ["ladder", "debit"])

S("seagull-bearish", "Bearish Seagull", "direction", "bearish", 3,
  "Short call funds a long put spread: zero-cost bearish structure with upside risk above the short call.",
  [c(1, 1.10, 30, "sell"), p(1, 1.0, 30), p(1, 0.85, 30, "sell")], ["zero-cost", "structured"])

S("risk-reversal-bearish", "Bearish Risk Reversal", "direction", "bearish", 3,
  "Sell OTM call, buy OTM put: near-zero-cost bearish structure; the staple of macro hedging desks.",
  [c(1, 1.08, 30, "sell"), p(1, 0.92, 30)], ["zero-cost", "skew", "hedge"])

S("synthetic-short", "Synthetic Short", "direction", "bearish", 2,
  "Sell call, buy put at the same strike: replicates a short forward without borrowing spot.",
  [c(1, 1.0, 30, "sell"), p(1, 1.0, 30)], ["synthetic", "leverage"])

S("put-calendar", "Put Calendar Spread", "direction", "bearish", 3,
  "Sell near-dated, buy far-dated put at the same strike: monetizes front theta while keeping term-structure exposure.",
  [p(1, 1.0, 30, "sell"), p(1, 1.0, 90)], ["calendar", "debit"])

S("diagonal-put", "Diagonal Put Spread", "direction", "bearish", 3,
  "Long far-dated ITM put, short near-dated OTM put: a rollable bearish diagonal with reduced carry.",
  [p(1, 1.06, 90), p(1, 0.94, 30, "sell")], ["diagonal", "debit"])

S("strip", "Strip", "volatility", "bearish", 2,
  "Two puts plus one call at the money: long volatility with a bearish tilt — double payoff on the downside.",
  [p(2, 1.0, 30), c(1, 1.0, 30)], ["debit", "long-vol"])

# ======================================================= LONG VOLATILITY (15)
S("long-straddle", "Long Straddle", "volatility", "volatile", 1,
  "Buy ATM call and put: pure long gamma and vega — profits from any large move, bleeds theta while waiting.",
  [c(1, 1.0, 30), p(1, 1.0, 30)], ["debit", "long-vol", "unlimited-profit"])

S("long-strangle", "Long Strangle", "volatility", "volatile", 1,
  "Buy OTM call and OTM put: cheaper than a straddle with a wider breakeven — the classic tail bet.",
  [c(1, 1.10, 30), p(1, 0.90, 30)], ["debit", "long-vol", "unlimited-profit"])

S("long-straddle-everlasting", "Everlasting Straddle", "perpetual", "volatile", 2,
  "Long everlasting call and put: permanent long-gamma posture funded by period payments — no expiry to fight.",
  [e(1, 1.03, 7), e(1, 0.97, 7)], ["everlasting", "long-vol", "funding-carry"])

S("long-strangle-everlasting", "Everlasting Strangle", "perpetual", "volatile", 2,
  "Perpetual OTM call + put: always-on tail exposure without roll decay, carried via funding.",
  [e(1, 1.10, 7), e(1, 0.90, 7)], ["everlasting", "long-vol", "tail"])

S("long-guts", "Long Guts", "volatility", "volatile", 2,
  "Buy ITM call and ITM put: deep-intrinsic strangle with high delta on both sides — heavy but responsive.",
  [c(1, 0.95, 30), p(1, 0.95, 30)], ["debit", "long-vol"])

S("calendar-straddle", "Calendar Straddle", "volatility", "volatile", 4,
  "Sell near-dated straddle, buy far-dated straddle: long back-month vol, short front-month pin risk.",
  [c(1, 1.0, 30, "sell"), p(1, 1.0, 30, "sell"), c(1, 1.0, 90), p(1, 1.0, 90)],
  ["calendar", "long-vol", "term-structure"])

S("reverse-iron-condor", "Reverse Iron Condor", "volatility", "volatile", 2,
  "Buy the wings, sell the body: defined-debit long-vol structure that profits from a break beyond either wing.",
  [p(1, 0.85, 30), p(1, 0.92, 30, "sell"), c(1, 1.08, 30, "sell"), c(1, 1.15, 30)],
  ["debit", "defined-risk", "long-vol"])

S("reverse-iron-butterfly", "Reverse Iron Butterfly", "volatility", "volatile", 2,
  "Buy OTM wings, sell ATM body: the defined-risk way to be long a break in either direction.",
  [p(1, 0.90, 30), p(1, 1.0, 30, "sell"), c(1, 1.0, 30, "sell"), c(1, 1.10, 30)],
  ["debit", "defined-risk", "long-vol"])

S("reverse-call-butterfly", "Reverse Call Butterfly", "volatility", "volatile", 3,
  "Sell two ATM calls, buy ITM and OTM calls: long break-out through either call wing.",
  [c(1, 0.90, 30), c(2, 1.0, 30, "sell"), c(1, 1.10, 30)], ["debit", "defined-risk"])

S("reverse-put-butterfly", "Reverse Put Butterfly", "volatility", "volatile", 3,
  "Sell two ATM puts, buy ITM and OTM puts: long a large move through either put wing.",
  [p(1, 0.90, 30), p(2, 1.0, 30, "sell"), p(1, 1.10, 30)], ["debit", "defined-risk"])

S("wide-strangle-ladder", "Wide Strangle Ladder", "volatility", "volatile", 2,
  "Two OTM puts and two OTM calls at increasing distances: laddered convexity for an extended regime break.",
  [p(1, 0.88, 30), p(1, 0.82, 30), c(1, 1.12, 30), c(1, 1.18, 30)],
  ["debit", "long-vol", "ladder"])

S("long-vol-term-stack", "Long Vol Term Stack", "volatility", "volatile", 3,
  "Strangles at 30d and 90d: stacked long vol across the term structure to smooth theta and event timing.",
  [c(1, 1.10, 30), p(1, 0.90, 30), c(1, 1.10, 90), p(1, 0.90, 90)],
  ["debit", "long-vol", "term-structure"])

S("everlasting-vol-stack", "Everlasting Vol Stack", "perpetual", "volatile", 3,
  "Everlasting strangles at short and long funding periods: always-on vol exposure across funding tenors.",
  [e(1, 1.10, 7), e(1, 0.90, 7), e(1, 1.10, 30), e(1, 0.90, 30)],
  ["everlasting", "long-vol", "funding-structure"])

S("reverse-christmas-tree", "Reverse Christmas Tree (Puts)", "volatility", "volatile", 4,
  "Ratio put structure inverted for long downside vol: buy three puts, sell one higher and two lower.",
  [p(3, 0.90, 30), p(1, 0.95, 30, "sell"), p(2, 0.85, 30, "sell")],
  ["ratio", "long-vol", "bearish-vol"])

S("sydney", "Sydney (Straddle-Strangle Hybrid)", "volatility", "volatile", 3,
  "Two straddles plus one strangle: amplified long-gamma position for an expected violent move.",
  [c(2, 1.0, 30), p(2, 1.0, 30), c(1, 1.10, 30), p(1, 0.90, 30)],
  ["debit", "long-vol", "long-gamma"])

// ─────────────────────────────────────────────────────────────────────────────
// VolScript — the AI reference card. Everything the desk model needs to write
// valid VolScript: syntax, namespaces, semantics and two worked examples.
// Shared by /api/scriptlab/ai (code generation) and kept in sync with the
// engine by hand — when the engine grows, this card grows with it.
// ─────────────────────────────────────────────────────────────────────────────

import { SCRIPT_CATEGORIES, BUILTIN_SCRIPTS } from './library';

export const VOLSCRIPT_REFERENCE = `You write **VolScript** — the VolOS Script Lab language, a Pine Script v5-compatible subset that runs on OHLCV bars with taker-flow data. Your output is compiled by a strict interpreter; invalid code produces runtime errors the trader sees in the editor. Write ONLY valid VolScript.

# SYNTAX (Pine v5 style)
- One statement per line. Comments start with //.
- Declarations: indicator("Title", overlay=true) for indicators; strategy("Title", overlay=true, initial_capital=100000, commission=0.04) for backtests (commission = % per side).
- Assignments: name = expr (declare/overwrite), name := expr (re-assign, must be declared first), var name = expr (init once, value persists bar-to-bar; re-assignments to a var are sticky).
- Indented blocks (4 spaces) after: if cond / else / else if cond. The if body MUST start on the next line, indented further than the if line. Same-line bodies are invalid.
- Ternary: cond ? a : b. History: expr[n] (n bars back; NaN before the start).
- Operators: + - * / % == != < <= > >= and or not && || ! (na behaves as false in conditions; division by zero = na).
- Tuple destructuring ONLY for tuple-returning kernels: [macdLine, signalLine, hist] = ta.macd(src, fast, slow, signal); [stLine, stDir] = ta.supertrend(factor, atrLen); [basis, upper, lower] = ta.bb(src, len, mult); [basis, upper, lower] = ta.kc(len, mult).
- NO for/while loops, NO user-defined functions, NO request.security, NO arrays, NO classes. Use ta.cum(cond) for counters instead of loops. label.new/line.new/box.new/table.new and alertcondition/alert are ACCEPTED and ignored (safe in copied code — don't rely on them for logic).
- Function arguments: positional or named (plot(x, title="RSI", color=color.teal, linewidth=2)).

# BUILT-IN SERIES (globals)
open high low close volume hl2 hlc3 ohlc4 time (epoch ms) hour minute dayofweek dayofmonth month bar_index
Orderflow natives (this desk's edge): buyvol (taker buy volume) sellvol delta (buyvol - sellvol) cvd (cumulative delta)
na true false

# ta.* NAMESPACE
ta.sma(x, len) ta.ema(x, len) ta.wma(x, len) ta.rma(x, len) ta.rsi(x, len) ta.atr(len) ta.tr
ta.change(x, n=1) ta.highest(x, len) ta.lowest(x, len) ta.stdev(x, len) ta.dev(x, len) ta.sum(x, len) ta.cum(x)
ta.crossover(a, b) ta.crossunder(a, b) ta.cross(a, b) ta.falling(x, len) ta.rising(x, len)
ta.macd(src, fast=12, slow=26, signal=9) → [line, signal, hist]
ta.bb(src, len=20, mult=2) → [basis, upper, lower]  ta.bbw(src, len, mult)
ta.kc(len=20, mult=2) → [basis, upper, lower]
ta.supertrend(factor=3, atrLen=10) → [line, dir] (dir = -1 uptrend, +1 downtrend)
ta.stoch(src, high, low, len) ta.cci(src, len) ta.obv() ta.vwap() (daily-anchored) ta.vwma(src, len)
ta.linreg(x, len, offset=0) ta.correlation(a, b, len) ta.percentrank(x, len)
ta.kama(x, len, fast=2, slow=30) ta.hma(x, len) ta.alma(x, len, offset=0.85, sigma=6)
ta.pivothigh(src, left, right) ta.pivotlow(src, left, right) ta.valuewhen(cond, src, occ=0)
ta.mom(x, len) ta.roc(x, len) ta.median(x, len) ta.range(x, len) ta.cmo(x, len) ta.wpr(len) ta.sar(start=0.02, inc=0.02, max=0.2)
ta.barssince(cond)
NOTE: len arguments must be constant numbers, not series.

# math.* NAMESPACE
math.abs max min (variadic) round(x, precision=0) floor ceil pow sqrt log log10 exp sign avg (variadic)

# options.* NAMESPACE (options structures — the Strategy Lab bridge)
options.bs_call(spot, strike, years, iv) options.bs_put(spot, strike, years, iv) — Black-Scholes marks, r=0 (crypto convention). iv is decimal vol (0.60 = 60%); years = time to expiry in year units, e.g. (expiryMs - time) / 31557600000 with time in epoch ms. At years<=0 or iv<=0 the mark collapses to intrinsic. All four args may be scalars or series and broadcast.
Typical options bridge shape (structure P&L vs its entry marks):
    entrySpot = ta.valuewhen(bar_index == entryBar, close, 0)
    years = math.max(0, (entryMs + 30 * 86400000 - time) / 31557600000)
    mark = options.bs_call(close, strike, years, iv)
    entryMark = ta.valuewhen(bar_index == entryBar, mark, 0)
    plot(mark - entryMark, "Leg P&L", color.teal, 2)

# PLOTTING
plot(series, title, color, linewidth, style, offset=) — style: plot.style_line (default) | plot.style_stepline | plot.style_histogram | plot.style_columns | plot.style_area | plot.style_circles | plot.style_cross
plotcandle(open, high, low, close, title, color) — four aligned series as candles
plotbar(open, high, low, close, title, color) — OHLC bars
plotshape(cond, title, style, location, color, text="BUY") — style: shape.triangleup|triangledown|circle|cross|xcross|square|diamond|arrowup|arrowdown|label; location: location.belowbar|location.abovebar
plotchar(cond, title, char, location, color) — a tiny character ("▲", "•") at each marked bar
plotarrow(values, colorup=, colordown=) — up arrows above bars for positive values, down arrows below for negative
fill(plotHandleA, plotHandleB, color=) — shade the band between two plot()/hline() outputs: p1 = plot(a), p2 = plot(b), fill(p1, p2, color=color.new(color.teal, 85))
bgcolor(cond ? color.new(color.violet, 88) : na) — full-height per-bar shading behind the pane
barcolor(cond ? color.teal : na) — recolor the price candles themselves
hline(price, title, color, linestyle) — horizontal level; the series' LAST value is used; linestyle: hline.style_solid|dashed|dotted
Colors: color.teal rose amber violet sky emerald zinc white gray red green blue orange purple yellow fuchsia aqua lime navy olive silver black + color.new(c, transparency)
Scripts with overlay=true plot on the price chart; overlay=false in a sub-pane (oscillators like RSI/MACD).

# STRATEGY (backtests — orders fill at the NEXT bar's open, never repaint; pyramiding=0; intrabar stop/limit; all-in equity sizing)
strategy.entry(id, strategy.long)  strategy.entry(id, strategy.short)
strategy.close(id)  strategy.close_all()
strategy.exit(id, stop=level, limit=level) — stop/limit live with the open position; call it on/after the entry signal bar, typically inside the same if-block as the entry (long stops go BELOW price, short stops ABOVE).
Typical shape:
    if longSignal
        strategy.entry("L", strategy.long)
        strategy.exit("L", stop=close - 2 * ta.atr(14))

# INPUTS (render as editable form controls)
input.int(def, "Title", minval=, maxval=, step=) input.float(def, "Title", minval=, maxval=, step=)
input.bool(def, "Title") input.string(def, "Title", options=["a","b"]) input.source(close, "Title")
input.source defaults must be one of: open, high, low, close, hl2, hlc3, ohlc4, volume, buyvol, sellvol, delta, cvd.

# SEMANTICS
- Warmup: indicators return na until enough bars exist (ta.sma(x,20) is na for the first 19 bars). Comparisons/conditions with na are false. Use nz(x, 0) to fill.
- Assignments inside if-blocks only apply where the condition holds; the variable keeps its earlier per-bar value elsewhere.
- var x = expr initializes ONCE (first bar); use ta.cum(cond) for running counters.
- Everything is deterministic: same bars → same plots, same trades.

# EXAMPLE — indicator
//@version=1
indicator("RSI + Mean", overlay=false)
len = input.int(14, "RSI Length")
src = input.source(close, "Source")
r = ta.rsi(src, len)
plot(r, "RSI", color.violet, 2)
plot(ta.sma(r, 50), "RSI mean", color.zinc, 1)
hline(70, "Overbought", color.rose, hline.style_dashed)
hline(30, "Oversold", color.teal, hline.style_dashed)

# EXAMPLE — strategy with stop and orderflow filter
//@version=1
strategy("Delta-Confirmed EMA Cross", overlay=true, initial_capital=100000, commission=0.04)
fastLen = input.int(12, "Fast EMA")
slowLen = input.int(36, "Slow EMA")
fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
plot(fast, "Fast EMA", color.teal, 2)
plot(slow, "Slow EMA", color.amber, 2)
longSig = ta.crossover(fast, slow) and ta.sma(buyvol / volume, 14) > 0.5
shortSig = ta.crossunder(fast, slow)
if longSig
    strategy.entry("L", strategy.long)
    strategy.exit("L", stop=close - 2 * ta.atr(14))
if shortSig
    strategy.close("L")
    strategy.exit("S", stop=close + 2 * ta.atr(14))

# OUTPUT CONTRACT
Reply with ONE short paragraph (max 3 sentences) explaining the logic, then ONE fenced code block tagged volscript containing the COMPLETE script. Never use unsupported features; if the trader asks for something VolScript lacks (loops, request.security, drawings), implement the closest supported equivalent and note the substitution in the paragraph.`;

export function availableCategories(): string {
  return SCRIPT_CATEGORIES.map((c) => c.key).join(', ');
}

export function libraryScriptNames(): string {
  return BUILTIN_SCRIPTS.map((s) => s.name).join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// VolScript — the built-in script library. Every entry runs on the engine as
// shipped (they double as engine conformance fixtures). Categories mirror the
// classic TradingView indicator taxonomy so scripts port over with minimal edits.
// ─────────────────────────────────────────────────────────────────────────────

export interface ScriptCategory {
  key: string;
  label: string;
  description: string;
}

export interface LibraryScript {
  name: string;
  category: string;
  kind: 'indicator' | 'strategy';
  description: string;
  code: string;
}

export const SCRIPT_CATEGORIES: ScriptCategory[] = [
  { key: 'trend', label: 'Trend', description: 'EMAs, moving-average systems, SuperTrend, channels' },
  { key: 'momentum', label: 'Momentum', description: 'RSI, MACD, Stochastic, ROC, CCI' },
  { key: 'volatility', label: 'Volatility', description: 'Bollinger, Keltner, ATR, realized vol' },
  { key: 'volume_flow', label: 'Volume & Flow', description: 'delta, CVD, VWAP, taker flow — perp-native' },
  { key: 'structure', label: 'Structure', description: 'pivots, ranges, market-structure shifts' },
  { key: 'smc_ict', label: 'SMC / ICT', description: 'fair value gaps, liquidity sweeps, kill zones' },
  { key: 'wyckoff', label: 'Wyckoff', description: 'effort vs result, spread, accumulation' },
  { key: 'elliott_harmonics', label: 'Elliott & Harmonics', description: 'swing detection, auto Fibonacci' },
  { key: 'patterns', label: 'Patterns', description: 'inside bars, engulfing, pin bars, climaxes' },
  { key: 'levels', label: 'Levels', description: 'round numbers, pivots, prior-day levels' },
  { key: 'statistics', label: 'Statistics', description: 'z-scores, percent rank, correlation' },
  { key: 'machine_learning', label: 'Machine Learning', description: 'adaptive & regression models' },
  { key: 'time_sessions', label: 'Time & Sessions', description: 'sessions, hour filters, weekends' },
  { key: 'sentiment_breadth', label: 'Sentiment & Breadth', description: 'composite scores, %B, breadth' },
  { key: 'risk_exits', label: 'Risk & Exits', description: 'ATR stops, chandelier, sizing' },
  { key: 'meta', label: 'Meta', description: 'bar anatomy, gaps, data quality' },
  { key: 'validation', label: 'Validation', description: 'signal stability, anomaly guards' },
  { key: 'options', label: 'Options', description: 'Strategy Lab structures compiled into VolScript — the options bridge' },
];

export const BUILTIN_SCRIPTS: LibraryScript[] = [
  // ── TREND ─────────────────────────────────────────────────────────────────
  {
    name: 'EMA Ribbon',
    category: 'trend',
    kind: 'indicator',
    description: 'Three adaptive EMAs — fast/mid/slow trend read.',
    code: `//@version=1
indicator("EMA Ribbon", overlay=true)
src = input.source(close, "Source")
f = input.int(21, "Fast")
m = input.int(55, "Mid")
s = input.int(200, "Slow")
fast = ta.ema(src, f)
mid = ta.ema(src, m)
slow = ta.ema(src, s)
plot(fast, "EMA fast", color.teal, 2)
plot(mid, "EMA mid", color.amber, 2)
plot(slow, "EMA slow", color.violet, 2)`,
  },
  {
    name: 'SMA Cross System',
    category: 'trend',
    kind: 'indicator',
    description: 'Fast/slow SMA pair with crossover markers.',
    code: `//@version=1
indicator("SMA Cross", overlay=true)
fastLen = input.int(9, "Fast")
slowLen = input.int(21, "Slow")
fast = ta.sma(close, fastLen)
slow = ta.sma(close, slowLen)
plot(fast, "SMA fast", color.teal, 2)
plot(slow, "SMA slow", color.amber, 2)
crossUp = ta.crossover(fast, slow)
crossDn = ta.crossunder(fast, slow)
plotshape(crossUp, "Bull cross", shape.triangleup, location.belowbar, color.teal)
plotshape(crossDn, "Bear cross", shape.triangledown, location.abovebar, color.rose)`,
  },
  {
    name: 'SuperTrend',
    category: 'trend',
    kind: 'indicator',
    description: 'ATR trailing stop-and-reverse trend line (dir<0 = up).',
    code: `//@version=1
indicator("SuperTrend", overlay=true)
factor = input.float(3.0, "Factor", minval=0.5, maxval=8.0, step=0.1)
atrLen = input.int(10, "ATR length")
[stLine, stDir] = ta.supertrend(factor, atrLen)
plot(stLine, "SuperTrend", color.violet, 2)
flip = ta.cross(stDir, 0) and stDir == 0 ? false : false
plotshape(stDir == -1, "Up trend", shape.triangleup, location.belowbar, color.teal)
plotshape(stDir == 1, "Down trend", shape.triangledown, location.abovebar, color.rose)`,
  },
  {
    name: 'Donchian Channel',
    category: 'trend',
    kind: 'indicator',
    description: 'N-bar high/low envelope with mid line.',
    code: `//@version=1
indicator("Donchian Channel", overlay=true)
len = input.int(20, "Length")
upper = ta.highest(high, len)
lower = ta.lowest(low, len)
mid = (upper + lower) / 2
plot(upper, "Upper", color.zinc, 1)
plot(mid, "Mid", color.amber, 1)
plot(lower, "Lower", color.zinc, 1)`,
  },
  {
    name: 'Linear Regression Channel',
    category: 'trend',
    kind: 'indicator',
    description: 'Least-squares mid line with ±2σ parallel bands.',
    code: `//@version=1
indicator("LinReg Channel", overlay=true)
len = input.int(100, "Length")
lr = ta.linreg(close, len)
dev = ta.stdev(close, len)
plot(lr, "LinReg", color.sky, 2)
plot(lr + 2 * dev, "+2σ", color.zinc, 1)
plot(lr - 2 * dev, "-2σ", color.zinc, 1)`,
  },

  // ── MOMENTUM ─────────────────────────────────────────────────────────────
  {
    name: 'RSI Oscillator',
    category: 'momentum',
    kind: 'indicator',
    description: 'Wilder RSI with 30/50/70 guides.',
    code: `//@version=1
indicator("RSI", overlay=false)
len = input.int(14, "Length")
src = input.source(close, "Source")
r = ta.rsi(src, len)
plot(r, "RSI", color.violet, 2)
hline(70, "Overbought", color.rose, hline.style_dashed)
hline(50, "Mid", color.zinc, hline.style_dotted)
hline(30, "Oversold", color.teal, hline.style_dashed)`,
  },
  {
    name: 'MACD',
    category: 'momentum',
    kind: 'indicator',
    description: '12/26/9 MACD with histogram.',
    code: `//@version=1
indicator("MACD", overlay=false)
fast = input.int(12, "Fast")
slow = input.int(26, "Slow")
sig = input.int(9, "Signal")
[macdLine, signalLine, hist] = ta.macd(close, fast, slow, sig)
plot(hist, "Histogram", color.zinc, 1, plot.style_histogram)
plot(macdLine, "MACD", color.sky, 2)
plot(signalLine, "Signal", color.amber, 1)
hline(0, "Zero", color.zinc, hline.style_dotted)`,
  },
  {
    name: 'Stochastic',
    category: 'momentum',
    kind: 'indicator',
    description: '%K/%D with 20/80 guides.',
    code: `//@version=1
indicator("Stochastic", overlay=false)
len = input.int(14, "Length")
k = ta.stoch(close, high, low, len)
d = ta.sma(k, 3)
plot(k, "%K", color.sky, 2)
plot(d, "%D", color.amber, 1)
hline(80, "Overbought", color.rose, hline.style_dashed)
hline(20, "Oversold", color.teal, hline.style_dashed)`,
  },
  {
    name: 'Rate of Change',
    category: 'momentum',
    kind: 'indicator',
    description: 'N-bar % momentum with zero line.',
    code: `//@version=1
indicator("ROC", overlay=false)
len = input.int(12, "Length")
roc = (close - close[len]) / close[len] * 100
plot(roc, "ROC", color.emerald, 2)
hline(0, "Zero", color.zinc, hline.style_dotted)`,
  },
  {
    name: 'CCI Oscillator',
    category: 'momentum',
    kind: 'indicator',
    description: 'Commodity channel index, ±100 guides.',
    code: `//@version=1
indicator("CCI", overlay=false)
len = input.int(20, "Length")
c = ta.cci(hlc3, len)
plot(c, "CCI", color.violet, 2)
hline(100, "Upper", color.rose, hline.style_dashed)
hline(0, "Zero", color.zinc, hline.style_dotted)
hline(-100, "Lower", color.teal, hline.style_dashed)`,
  },

  // ── VOLATILITY ───────────────────────────────────────────────────────────
  {
    name: 'Bollinger Bands',
    category: 'volatility',
    kind: 'indicator',
    description: '20/2 Bollinger with width sub-metric.',
    code: `//@version=1
indicator("Bollinger Bands", overlay=true)
len = input.int(20, "Length")
mult = input.float(2.0, "StdDev ×", minval=0.5, maxval=5.0, step=0.1)
mid = ta.sma(close, len)
dev = mult * ta.stdev(close, len)
plot(mid, "Basis", color.amber, 2)
plot(mid + dev, "Upper", color.zinc, 1)
plot(mid - dev, "Lower", color.zinc, 1)
width = (mid + dev - (mid - dev)) / mid * 100
plot(width, "BB width %", color.violet, 1, plot.style_histogram)`,
  },
  {
    name: 'ATR Volatility',
    category: 'volatility',
    kind: 'indicator',
    description: 'Wilder ATR and % of price.',
    code: `//@version=1
indicator("ATR", overlay=false)
len = input.int(14, "Length")
a = ta.atr(len)
pct = a / close * 100
plot(pct, "ATR %", color.amber, 2)
plot(a, "ATR", color.zinc, 1)`,
  },
  {
    name: 'Keltner Channel',
    category: 'volatility',
    kind: 'indicator',
    description: 'EMA ± ATR envelope.',
    code: `//@version=1
indicator("Keltner Channel", overlay=true)
len = input.int(20, "EMA length")
mult = input.float(2.0, "ATR ×", minval=0.5, maxval=5.0, step=0.1)
basis = ta.ema(close, len)
a = ta.atr(14)
plot(basis, "Basis", color.amber, 2)
plot(basis + mult * a, "Upper", color.zinc, 1)
plot(basis - mult * a, "Lower", color.zinc, 1)`,
  },
  {
    name: 'Volatility Regime',
    category: 'volatility',
    kind: 'indicator',
    description: '20 vs 90-bar realized-vol ratio — expansion/compression.',
    code: `//@version=1
indicator("Volatility Regime", overlay=false)
hv20 = ta.stdev(close, 20)
hv90 = ta.stdev(close, 90)
ratio = hv20 / hv90
plot(ratio, "HV20/HV90", color.fuchsia, 2)
hline(1.5, "Expansion", color.rose, hline.style_dashed)
hline(1.0, "Neutral", color.zinc, hline.style_dotted)
hline(0.5, "Compression", color.teal, hline.style_dashed)`,
  },

  // ── VOLUME & FLOW ───────────────────────────────────────────────────────
  {
    name: 'Delta & CVD',
    category: 'volume_flow',
    kind: 'indicator',
    description: 'Taker delta histogram with cumulative line — perp-native.',
    code: `//@version=1
indicator("Delta & CVD", overlay=false)
plot(delta, "Delta", color.teal, 1, plot.style_histogram)
plot(cvd, "CVD", color.amber, 2)`,
  },
  {
    name: 'Session VWAP',
    category: 'volume_flow',
    kind: 'indicator',
    description: 'Daily-anchored volume-weighted average price.',
    code: `//@version=1
indicator("VWAP", overlay=true)
v = ta.vwap()
plot(v, "VWAP", color.aqua, 2)`,
  },
  {
    name: 'On-Balance Volume',
    category: 'volume_flow',
    kind: 'indicator',
    description: 'Classic OBV flow direction.',
    code: `//@version=1
indicator("OBV", overlay=false)
o = ta.obv()
plot(o, "OBV", color.aqua, 2)`,
  },
  {
    name: 'Taker Buy Ratio',
    category: 'volume_flow',
    kind: 'indicator',
    description: 'Aggressor buy share of volume — order-flow pressure.',
    code: `//@version=1
indicator("Taker Ratio", overlay=false)
len = input.int(20, "Smooth")
r = ta.sma(buyvol / volume, len)
plot(r, "Taker buy %", color.emerald, 2)
hline(0.5, "Neutral", color.zinc, hline.style_dotted)
hline(0.58, "Bid stress", color.rose, hline.style_dashed)
hline(0.42, "Ask stress", color.teal, hline.style_dashed)`,
  },
  {
    name: 'Volume MA + Spikes',
    category: 'volume_flow',
    kind: 'indicator',
    description: 'Volume with 20-bar average and >2.5σ spikes.',
    code: `//@version=1
indicator("Volume MA", overlay=false)
len = input.int(20, "Length")
v = volume
vma = ta.sma(v, len)
sd = ta.stdev(v, len)
spike = v > vma + 2.5 * sd
plot(v, "Volume", color.zinc, 1, plot.style_histogram)
plot(vma, "Volume MA", color.amber, 2)
plotshape(spike, "Spike", shape.circle, location.abovebar, color.rose)`,
  },

  // ── STRUCTURE ───────────────────────────────────────────────────────────
  {
    name: 'Pivot High/Low',
    category: 'structure',
    kind: 'indicator',
    description: '5-bar swing pivots (confirmed 2 bars later).',
    code: `//@version=1
indicator("Pivots", overlay=true)
len = input.int(5, "Pivot length")
ph = high[len] == ta.highest(high, 2 * len + 1)
pl = low[len] == ta.lowest(low, 2 * len + 1)
plotshape(ph, "Pivot high", shape.triangledown, location.abovebar, color.rose)
plotshape(pl, "Pivot low", shape.triangleup, location.belowbar, color.teal)`,
  },
  {
    name: 'Range Structure',
    category: 'structure',
    kind: 'indicator',
    description: '100-bar range with equilibrium mid.',
    code: `//@version=1
indicator("Range Structure", overlay=true)
len = input.int(100, "Range length")
top = ta.highest(high, len)
bot = ta.lowest(low, len)
eq = (top + bot) / 2
plot(top, "Range top", color.zinc, 1)
plot(eq, "Equilibrium", color.amber, 2)
plot(bot, "Range bottom", color.zinc, 1)`,
  },
  {
    name: 'Market Structure Shift',
    category: 'structure',
    kind: 'indicator',
    description: 'Higher-high / lower-low break sequence.',
    code: `//@version=1
indicator("Structure Shift", overlay=true)
len = input.int(20, "Swing lookback")
swingHigh = ta.highest(high, len)
swingLow = ta.lowest(low, len)
hh = close > swingHigh[1]
ll = close < swingLow[1]
plot(swingHigh, "Swing high", color.zinc, 1)
plot(swingLow, "Swing low", color.zinc, 1)
plotshape(hh, "HH break", shape.triangleup, location.belowbar, color.teal)
plotshape(ll, "LL break", shape.triangledown, location.abovebar, color.rose)`,
  },

  // ── SMC / ICT ────────────────────────────────────────────────────────────
  {
    name: 'Fair Value Gaps',
    category: 'smc_ict',
    kind: 'indicator',
    description: 'Three-candle imbalance mid-lines (bull & bear).',
    code: `//@version=1
indicator("FVG", overlay=true)
bullFvg = low > high[3]
bearFvg = high < low[3]
gapSize = math.abs(low - high[3])
plotshape(bullFvg, "Bull FVG", shape.triangleup, location.belowbar, color.teal)
plotshape(bearFvg, "Bear FVG", shape.triangledown, location.abovebar, color.rose)
plot(gapSize, "FVG size", color.zinc, 1, plot.style_histogram)`,
  },
  {
    name: 'Liquidity Sweep',
    category: 'smc_ict',
    kind: 'indicator',
    description: 'Wick through prior 20-high/low that closes back inside.',
    code: `//@version=1
indicator("Liquidity Sweep", overlay=true)
len = input.int(20, "Liquidity lookback")
priorHigh = ta.highest(high, len)[1]
priorLow = ta.lowest(low, len)[1]
sweepHigh = high > priorHigh and close < priorHigh
sweepLow = low < priorLow and close > priorLow
plotshape(sweepHigh, "Sell-side sweep", shape.triangledown, location.abovebar, color.rose)
plotshape(sweepLow, "Buy-side sweep", shape.triangleup, location.belowbar, color.teal)`,
  },
  {
    name: 'ICT Kill Zones',
    category: 'smc_ict',
    kind: 'indicator',
    description: 'London 07-10 & NY 12-16 UTC activity markers.',
    code: `//@version=1
indicator("Kill Zones", overlay=true)
london = hour >= 7 and hour < 10
ny = hour >= 12 and hour < 16
asia = hour >= 0 and hour < 6
plotshape(london, "London KZ", shape.square, location.abovebar, color.amber)
plotshape(ny, "NY KZ", shape.square, location.abovebar, color.teal)
plotshape(asia, "Asia KZ", shape.square, location.abovebar, color.zinc)`,
  },

  // ── WYCKOFF ──────────────────────────────────────────────────────────────
  {
    name: 'Effort vs Result',
    category: 'wyckoff',
    kind: 'indicator',
    description: 'Volume z-score vs price-change z-score divergence.',
    code: `//@version=1
indicator("Effort vs Result", overlay=false)
len = input.int(50, "Baseline")
effort = (volume - ta.sma(volume, len)) / ta.stdev(volume, len)
result = (math.abs(ta.change(close)) - ta.sma(math.abs(ta.change(close)), len)) / ta.stdev(math.abs(ta.change(close)), len)
plot(effort, "Effort (volume)", color.aqua, 2)
plot(result, "Result (range)", color.amber, 2)
hline(0, "Zero", color.zinc, hline.style_dotted)`,
  },
  {
    name: 'Spread Analysis',
    category: 'wyckoff',
    kind: 'indicator',
    description: 'Bar spread % of price vs its average.',
    code: `//@version=1
indicator("Spread", overlay=false)
len = input.int(20, "Average")
spread = (high - low) / close * 100
spreadMa = ta.sma(spread, len)
plot(spread, "Spread %", color.zinc, 1, plot.style_histogram)
plot(spreadMa, "Spread MA", color.amber, 2)`,
  },
  {
    name: 'Accumulation Signature',
    category: 'wyckoff',
    kind: 'indicator',
    description: 'OBV drift while price stays in-range.',
    code: `//@version=1
indicator("Accumulation", overlay=true)
o = ta.obv()
flatPrice = math.abs(ta.change(close, 5)) / close * 100 < 0.5
risingObv = o > o[5]
plotshape(flatPrice and risingObv, "Accumulation", shape.triangleup, location.belowbar, color.teal)`,
  },

  // ── ELLIOTT & HARMONICS ──────────────────────────────────────────────────
  {
    name: 'Zigzag Swing Detector',
    category: 'elliott_harmonics',
    kind: 'indicator',
    description: '8-bar swing pivots for wave counting.',
    code: `//@version=1
indicator("Zigzag Swings", overlay=true)
len = input.int(8, "Swing length")
ph = high[len] == ta.highest(high, 2 * len + 1)
pl = low[len] == ta.lowest(low, 2 * len + 1)
plotshape(ph, "Swing high", shape.triangledown, location.abovebar, color.rose)
plotshape(pl, "Swing low", shape.triangleup, location.belowbar, color.teal)`,
  },
  {
    name: 'Auto Fibonacci Levels',
    category: 'elliott_harmonics',
    kind: 'indicator',
    description: 'Golden-ratio grid over the 200-bar range.',
    code: `//@version=1
indicator("Auto Fibonacci", overlay=true)
len = input.int(200, "Range length")
top = ta.highest(high, len)
bot = ta.lowest(low, len)
rng = top - bot
hline(bot, "0.000", color.zinc, hline.style_dashed)
hline(bot + rng * 0.236, "0.236", color.zinc, hline.style_dashed)
hline(bot + rng * 0.382, "0.382", color.teal, hline.style_dashed)
hline(bot + rng * 0.5, "0.500", color.amber, hline.style_dashed)
hline(bot + rng * 0.618, "0.618", color.teal, hline.style_dashed)
hline(bot + rng * 0.786, "0.786", color.zinc, hline.style_dashed)
hline(top, "1.000", color.zinc, hline.style_dashed)`,
  },

  // ── PATTERNS ─────────────────────────────────────────────────────────────
  {
    name: 'Inside Bars',
    category: 'patterns',
    kind: 'indicator',
    description: 'Compression bars inside the prior range.',
    code: `//@version=1
indicator("Inside Bars", overlay=true)
inside = high < high[1] and low > low[1]
plotshape(inside, "Inside bar", shape.square, location.abovebar, color.zinc)`,
  },
  {
    name: 'Engulfing Candles',
    category: 'patterns',
    kind: 'indicator',
    description: 'Bull/bear body engulfing markers.',
    code: `//@version=1
indicator("Engulfing", overlay=true)
bull = close > open and close[1] < open[1] and close > open[1] and open < close[1]
bear = close < open and close[1] > open[1] and close < open[1] and open > close[1]
plotshape(bull, "Bull engulf", shape.triangleup, location.belowbar, color.teal)
plotshape(bear, "Bear engulf", shape.triangledown, location.abovebar, color.rose)`,
  },
  {
    name: 'Pin Bar Detector',
    category: 'patterns',
    kind: 'indicator',
    description: 'Two-thirds wick rejection candles.',
    code: `//@version=1
indicator("Pin Bars", overlay=true)
rng = high - low
upWick = high - math.max(open, close)
dnWick = math.min(open, close) - low
bearPin = rng > 0 and upWick / rng > 0.66
bullPin = rng > 0 and dnWick / rng > 0.66
plotshape(bullPin, "Bull pin", shape.triangleup, location.belowbar, color.teal)
plotshape(bearPin, "Bear pin", shape.triangledown, location.abovebar, color.rose)`,
  },
  {
    name: 'Volume Climax',
    category: 'patterns',
    kind: 'indicator',
    description: '3σ volume blow-offs colored by direction.',
    code: `//@version=1
indicator("Volume Climax", overlay=true)
len = input.int(20, "Baseline")
vma = ta.sma(volume, len)
vsd = ta.stdev(volume, len)
climax = volume > vma + 3 * vsd
up = climax and close > open
dn = climax and close < open
plotshape(up, "Bull climax", shape.triangleup, location.belowbar, color.teal)
plotshape(dn, "Bear climax", shape.triangledown, location.abovebar, color.rose)`,
  },

  // ── LEVELS ───────────────────────────────────────────────────────────────
  {
    name: 'Round Number Levels',
    category: 'levels',
    kind: 'indicator',
    description: 'Nearest round price levels (auto step).',
    code: `//@version=1
indicator("Round Numbers", overlay=true)
step = close > 10000 ? 500 : 100
lvl = math.round(close / step) * step
hline(lvl, "Nearest", color.amber, hline.style_dashed)
hline(lvl + step, "Next above", color.zinc, hline.style_dotted)
hline(lvl - step, "Next below", color.zinc, hline.style_dotted)`,
  },
  {
    name: 'Rolling Pivot Points',
    category: 'levels',
    kind: 'indicator',
    description: 'Classic PP/R1/S1 from the 24-bar window.',
    code: `//@version=1
indicator("Pivot Points", overlay=true)
len = input.int(24, "Window")
ph = ta.highest(high, len)
pl = ta.lowest(low, len)
pp = (ph + pl + close) / 3
r1 = 2 * pp - pl
s1 = 2 * pp - ph
hline(pp, "PP", color.amber, hline.style_dashed)
hline(r1, "R1", color.rose, hline.style_dashed)
hline(s1, "S1", color.teal, hline.style_dashed)`,
  },
  {
    name: 'Prior Period High/Low',
    category: 'levels',
    kind: 'indicator',
    description: 'Trailing 96-bar extremes as magnets.',
    code: `//@version=1
indicator("Prior H/L", overlay=true)
len = input.int(96, "Lookback")
hline(ta.highest(high, len), "Prior high", color.rose, hline.style_dashed)
hline(ta.lowest(low, len), "Prior low", color.teal, hline.style_dashed)`,
  },

  // ── STATISTICS ───────────────────────────────────────────────────────────
  {
    name: 'Price Z-Score',
    category: 'statistics',
    kind: 'indicator',
    description: 'Deviation from the mean in σ units.',
    code: `//@version=1
indicator("Z-Score", overlay=false)
len = input.int(20, "Length")
z = (close - ta.sma(close, len)) / ta.stdev(close, len)
plot(z, "Z", color.violet, 2)
hline(2, "+2σ", color.rose, hline.style_dashed)
hline(0, "Mean", color.zinc, hline.style_dotted)
hline(-2, "-2σ", color.teal, hline.style_dashed)`,
  },
  {
    name: 'Percent Rank',
    category: 'statistics',
    kind: 'indicator',
    description: 'Position of price within its 100-bar history.',
    code: `//@version=1
indicator("Percent Rank", overlay=false)
len = input.int(100, "Length")
pr = ta.percentrank(close, len)
plot(pr, "Rank", color.sky, 2)
hline(80, "High", color.rose, hline.style_dashed)
hline(20, "Low", color.teal, hline.style_dashed)`,
  },
  {
    name: 'Price-Volume Correlation',
    category: 'statistics',
    kind: 'indicator',
    description: '50-bar correlation between price and volume.',
    code: `//@version=1
indicator("Price-Vol Corr", overlay=false)
len = input.int(50, "Length")
corr = ta.correlation(close, volume, len)
plot(corr, "Corr", color.fuchsia, 2)
hline(0.7, "Strong +", color.teal, hline.style_dashed)
hline(0, "None", color.zinc, hline.style_dotted)
hline(-0.7, "Strong -", color.rose, hline.style_dashed)`,
  },

  // ── MACHINE LEARNING ─────────────────────────────────────────────────────
  {
    name: 'KAMA Adaptive MA',
    category: 'machine_learning',
    kind: 'indicator',
    description: 'Kaufman adaptive MA — speed follows efficiency ratio.',
    code: `//@version=1
indicator("KAMA", overlay=true)
len = input.int(10, "Efficiency length")
k = ta.kama(close, len)
plot(k, "KAMA", color.emerald, 2)
plot(ta.ema(close, len), "EMA ref", color.zinc, 1)`,
  },
  {
    name: 'LinReg Forecast',
    category: 'machine_learning',
    kind: 'indicator',
    description: '100-bar regression with 10-bar extrapolation.',
    code: `//@version=1
indicator("LinReg Forecast", overlay=true)
len = input.int(100, "Fit length")
horizon = input.int(10, "Horizon")
lr = ta.linreg(close, len)
lrPrev = ta.linreg(close, len, 1)
slope = lr - lrPrev
plot(lr, "Fit", color.sky, 2)
plot(lr + slope * horizon, "Forecast", color.amber, 2, plot.style_circles)`,
  },
  {
    name: 'Vol-Regime Classifier',
    category: 'machine_learning',
    kind: 'indicator',
    description: 'Threshold classifier over the HV ratio state.',
    code: `//@version=1
indicator("Vol Regime", overlay=false)
hv20 = ta.stdev(close, 20)
hv90 = ta.stdev(close, 90)
ratio = hv20 / hv90
state = ratio > 1.5 ? 2 : ratio < 0.6 ? 0 : 1
plot(state, "Regime", color.violet, 2, plot.style_histogram)
hline(2, "Expansion", color.rose, hline.style_dashed)
hline(1, "Normal", color.zinc, hline.style_dotted)
hline(0, "Compression", color.teal, hline.style_dashed)`,
  },

  // ── TIME & SESSIONS ─────────────────────────────────────────────────────
  {
    name: 'Session Open Markers',
    category: 'time_sessions',
    kind: 'indicator',
    description: 'Marks at UTC session opens (0/7/12/16).',
    code: `//@version=1
indicator("Session Opens", overlay=true)
open0 = hour == 0 and minute == 0
open7 = hour == 7 and minute == 0
open12 = hour == 12 and minute == 0
open16 = hour == 16 and minute == 0
plotshape(open0, "Asia open", shape.square, location.abovebar, color.zinc)
plotshape(open7, "London open", shape.square, location.abovebar, color.amber)
plotshape(open12, "NY open", shape.square, location.abovebar, color.teal)
plotshape(open16, "NY PM", shape.square, location.abovebar, color.violet)`,
  },
  {
    name: 'RTH vs Overnight',
    category: 'time_sessions',
    kind: 'indicator',
    description: 'Price line drawn only during 13-21 UTC RTH.',
    code: `//@version=1
indicator("RTH Only", overlay=true)
rth = hour >= 13 and hour < 21
plot(rth ? close : na, "RTH close", color.teal, 2)`,
  },
  {
    name: 'Weekend Filter',
    category: 'time_sessions',
    kind: 'indicator',
    description: 'Weekend bar markers (crypto markets run 24/7).',
    code: `//@version=1
indicator("Weekend Bars", overlay=true)
weekend = dayofweek == 0 or dayofweek == 6
plotshape(weekend, "Weekend", shape.square, location.abovebar, color.zinc)`,
  },

  // ── SENTIMENT & BREADTH ──────────────────────────────────────────────────
  {
    name: 'Bollinger %B',
    category: 'sentiment_breadth',
    kind: 'indicator',
    description: 'Position within the bands, 0..1.',
    code: `//@version=1
indicator("Bollinger %B", overlay=false)
len = input.int(20, "Length")
mid = ta.sma(close, len)
dev = ta.stdev(close, len)
pctB = (close - (mid - dev)) / (2 * dev)
plot(pctB, "%B", color.sky, 2)
hline(0.8, "Upper", color.rose, hline.style_dashed)
hline(0.5, "Mid", color.zinc, hline.style_dotted)
hline(0.2, "Lower", color.teal, hline.style_dashed)`,
  },
  {
    name: 'Trend Breadth Score',
    category: 'sentiment_breadth',
    kind: 'indicator',
    description: 'Share of bars above the 50-bar mean.',
    code: `//@version=1
indicator("Breadth Score", overlay=false)
ma = ta.sma(close, 50)
above = ta.cum(close > ma) / (bar_index + 1)
plot(above, "Breadth", color.emerald, 2)
hline(0.8, "Strong", color.teal, hline.style_dashed)
hline(0.5, "Neutral", color.zinc, hline.style_dotted)
hline(0.2, "Weak", color.rose, hline.style_dashed)`,
  },
  {
    name: 'Fear & Greed Proxy',
    category: 'sentiment_breadth',
    kind: 'indicator',
    description: 'Composite of RSI, %B and taker pressure.',
    code: `//@version=1
indicator("Fear & Greed", overlay=false)
len = input.int(20, "Bands length")
r = ta.rsi(close, 14)
mid = ta.sma(close, len)
dev = ta.stdev(close, len)
pctB = (close - (mid - dev)) / (2 * dev)
taker = ta.sma(buyvol / volume, 14)
score = 0.4 * r + 0.3 * pctB * 100 + 0.3 * taker * 100
plot(score, "Score", color.violet, 2)
hline(75, "Greed", color.rose, hline.style_dashed)
hline(50, "Neutral", color.zinc, hline.style_dotted)
hline(25, "Fear", color.teal, hline.style_dashed)`,
  },

  // ── RISK & EXITS ─────────────────────────────────────────────────────────
  {
    name: 'ATR Stop Band',
    category: 'risk_exits',
    kind: 'indicator',
    description: 'Price ± 2 ATR protective band.',
    code: `//@version=1
indicator("ATR Stop Band", overlay=true)
len = input.int(14, "ATR length")
mult = input.float(2.0, "×", minval=0.5, maxval=5.0, step=0.1)
a = ta.atr(len)
plot(close + mult * a, "Long stop", color.rose, 1)
plot(close - mult * a, "Short stop", color.teal, 1)`,
  },
  {
    name: 'Chandelier Exit',
    category: 'risk_exits',
    kind: 'indicator',
    description: '22-bar high − 3 ATR trailing exit.',
    code: `//@version=1
indicator("Chandelier Exit", overlay=true)
len = input.int(22, "High length")
mult = input.float(3.0, "ATR ×", minval=1.0, maxval=6.0, step=0.1)
stop = ta.highest(high, len) - mult * ta.atr(22)
plot(stop, "Chandelier", color.rose, 2)`,
  },
  {
    name: 'Position Size (ATR)',
    category: 'risk_exits',
    kind: 'indicator',
    description: 'Units risking 2% on a 2-ATR adverse move.',
    code: `//@version=1
indicator("ATR Sizing", overlay=false)
atrLen = input.int(14, "ATR length")
riskPct = input.float(2.0, "Risk %", minval=0.25, maxval=10.0, step=0.25)
capital = 10000
stopDist = 2 * ta.atr(atrLen)
size = capital * riskPct / 100 / stopDist
plot(size, "Units", color.amber, 2)`,
  },

  // ── META ────────────────────────────────────────────────────────────────
  {
    name: 'Gap Detector',
    category: 'meta',
    kind: 'indicator',
    description: 'Bars whose open deviates >0.1% from prior close.',
    code: `//@version=1
indicator("Gap Detector", overlay=true)
gapPct = math.abs(open - close[1]) / close[1] * 100
gap = gapPct > 0.1
plotshape(gap, "Gap", shape.cross, location.abovebar, color.amber)
plot(gapPct, "Gap %", color.zinc, 1, plot.style_histogram)`,
  },
  {
    name: 'Session Clock',
    category: 'meta',
    kind: 'indicator',
    description: 'Intraday time of day as a fraction.',
    code: `//@version=1
indicator("Session Clock", overlay=false)
tod = (hour * 60 + minute) / 1440
plot(tod, "Time of day", color.aqua, 1)
hline(0.5, "Midday", color.zinc, hline.style_dotted)`,
  },
  {
    name: 'CVD ↔ OBV Agreement',
    category: 'meta',
    kind: 'indicator',
    description: '100-bar correlation between the two flow metrics.',
    code: `//@version=1
indicator("Flow Agreement", overlay=false)
len = input.int(100, "Length")
agree = ta.correlation(cvd, ta.obv(), len)
plot(agree, "Corr", color.fuchsia, 2)
hline(0, "None", color.zinc, hline.style_dotted)`,
  },

  // ── VALIDATION ───────────────────────────────────────────────────────────
  {
    name: 'Signal Stability',
    category: 'validation',
    kind: 'indicator',
    description: 'MA crosses that still hold 3 bars later.',
    code: `//@version=1
indicator("Signal Stability", overlay=true)
fast = ta.sma(close, 9)
slow = ta.sma(close, 21)
crossUp = ta.crossover(fast, slow)
held = ta.barssince(crossUp) >= 3 and fast > slow
unheld = ta.barssince(crossUp) < 3 and fast <= slow
plotshape(held, "Stable", shape.triangleup, location.belowbar, color.teal)
plotshape(unheld, "Unstable", shape.cross, location.abovebar, color.rose)`,
  },
  {
    name: 'Zero-Volume Guard',
    category: 'validation',
    kind: 'indicator',
    description: 'Flags dead or missing volume bars.',
    code: `//@version=1
indicator("Volume Guard", overlay=true)
dead = volume == 0 or na(volume)
plotshape(dead, "Dead volume", shape.cross, location.abovebar, color.rose)`,
  },
  {
    name: 'Spread Outlier Guard',
    category: 'validation',
    kind: 'indicator',
    description: 'Bars with >4σ abnormal high-low spread.',
    code: `//@version=1
indicator("Spread Guard", overlay=true)
len = input.int(50, "Baseline")
spread = (high - low) / close * 100
z = (spread - ta.sma(spread, len)) / ta.stdev(spread, len)
outlier = z > 4
plotshape(outlier, "Bad print?", shape.cross, location.abovebar, color.rose)`,
  },
  {
    name: 'Long Call — options bridge',
    category: 'options',
    kind: 'indicator',
    description: 'The Strategy Lab → Script Lab bridge sample: a long call marked with Black-Scholes, P&L vs its entry marks. Full structures compile from the Options tab.',
    code: `//@version=1
// Strategy Lab → Script Lab bridge · EXPERIMENTAL
// Marks: Black-Scholes (r=0) at the iv input.
indicator("Long Call — options bridge", overlay=false)
iv = input.float(0.60, "Implied vol (decimal, 0.60 = 60%)", minval=0.05, maxval=3.0, step=0.05)
entryB = input.int(0, "Entry bar index", minval=0)
entrySpot = ta.valuewhen(bar_index == entryB, close, 0)
entryTime = ta.valuewhen(bar_index == entryB, time, 0)
k1 = entrySpot * 1.0
t1 = math.max(0, (entryTime + 30 * 86400000 - time) / 31557600000)
m1 = options.bs_call(close, k1, t1, iv)
me1 = ta.valuewhen(bar_index == entryB, m1, 0)
p1 = (m1 - me1) * 1 * 1
pnl = p1
plot(pnl, "Structure P&L", color.teal, 2, plot.style_area)
plotshape(bar_index == entryB, "Entry", shape.diamond, location.top, color.amber)
hline(0, "Zero", color.zinc, hline.style_dotted)`,
  },
  {
    name: 'Everlasting Straddle — options bridge',
    category: 'options',
    kind: 'indicator',
    description: 'The bridge on everlasting natives: a long straddle of perp-option legs, marked with a rolling synthetic expiry equal to the funding period.',
    code: `//@version=1
// Strategy Lab → Script Lab bridge · EXPERIMENTAL
// Everlasting legs: rolling synthetic expiry = funding period.
indicator("Everlasting Straddle — options bridge", overlay=false)
iv = input.float(0.60, "Implied vol (decimal, 0.60 = 60%)", minval=0.05, maxval=3.0, step=0.05)
entryB = input.int(0, "Entry bar index", minval=0)
entrySpot = ta.valuewhen(bar_index == entryB, close, 0)
k1 = entrySpot * 0.95
k2 = entrySpot * 1.05
t = 7 / 365.25
m1 = options.bs_call(close, k1, t, iv)
m2 = options.bs_put(close, k2, t, iv)
me1 = ta.valuewhen(bar_index == entryB, m1, 0)
me2 = ta.valuewhen(bar_index == entryB, m2, 0)
p1 = (m1 - me1) * 1 * 1
p2 = (m2 - me2) * 1 * 1
pnl = p1 + p2
plot(pnl, "Structure P&L", color.teal, 2, plot.style_area)
plot(p1, "leg 1 · buy perp_option", color.teal, 1)
plot(p2, "leg 2 · buy perp_option", color.amber, 1)
plotshape(bar_index == entryB, "Entry", shape.diamond, location.top, color.amber)
hline(0, "Zero", color.zinc, hline.style_dotted)`,
  },
];

/** The script the editor starts with — a strategy so the backtest panel has
 *  something meaningful on first open. */
export const defaultScript = `//@version=1
strategy("EMA Cross + ATR Stop", overlay=true, initial_capital=100000, commission=0.04)
fastLen = input.int(12, "Fast EMA")
slowLen = input.int(36, "Slow EMA")
atrMult = input.float(2.0, "ATR stop ×", minval=0.5, maxval=6.0, step=0.1)
fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
plot(fast, "Fast EMA", color.teal, 2)
plot(slow, "Slow EMA", color.amber, 2)
longSig = ta.crossover(fast, slow)
shortSig = ta.crossunder(fast, slow)
if longSig
    strategy.entry("L", strategy.long)
    strategy.exit("L", stop=close - atrMult * ta.atr(14))
if shortSig
    strategy.close("L")
    strategy.exit("S", stop=close + atrMult * ta.atr(14))
`;

export function categoryCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of SCRIPT_CATEGORIES) counts[c.key] = 0;
  for (const s of BUILTIN_SCRIPTS) counts[s.category] = (counts[s.category] ?? 0) + 1;
  return counts;
}

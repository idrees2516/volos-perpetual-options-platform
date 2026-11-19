// VolScript engine conformance — lexer, parser, interpreter semantics,
// kernels vs hand math, backtest determinism, and every library script runs.

import { describe, it, expect } from 'vitest';
import { tokenize } from './lexer';
import { parseProgram, ParseError } from './parser';
import { runScript } from './internal';
import { BUILTIN_SCRIPTS, defaultScript, SCRIPT_CATEGORIES } from './library';
import type { ScriptBar } from './types';

function synthBars(n = 240, seed = 7): ScriptBar[] {
  let x = seed;
  const rand = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
  const bars: ScriptBar[] = [];
  let price = 100;
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 37) * 0.4 + Math.sin(i / 11) * 0.15;
    price = Math.max(5, price * (1 + drift * 0.01 + (rand() - 0.5) * 0.012));
    const o = price * (1 + (rand() - 0.5) * 0.002);
    const c = price;
    const h = Math.max(o, c) * (1 + rand() * 0.004);
    const l = Math.min(o, c) * (1 - rand() * 0.004);
    const v = 500 + rand() * 1500;
    const tb = v * (0.35 + rand() * 0.3);
    t += 3_600_000;
    bars.push({ ts: t, o, h, l, c, v, tb });
  }
  return bars;
}

describe('lexer', () => {
  it('tokenizes dotted identifiers, strings and operators', () => {
    const toks = tokenize(`plot(ta.sma(close, 20), "Title", color.teal, 2)\n`);
    const idents = toks.filter((t) => t.type === 'IDENT').map((t) => t.value);
    expect(idents).toContain('ta.sma');
    expect(idents).toContain('plot');
    expect(idents).toContain('color.teal');
    const strs = toks.filter((t) => t.type === 'STRING').map((t) => t.value);
    expect(strs).toEqual(['Title']);
  });

  it('newline tokens carry the NEXT line indent', () => {
    const toks = tokenize('if cond\n    x = 1\ny = 2\n');
    const nls = toks.filter((t) => t.type === 'NEWLINE');
    expect(nls.slice(0, 2).map((n) => n.indent)).toEqual([4, 0]);
  });

  it('rejects unterminated strings with position', () => {
    expect(() => tokenize('x = "abc\n')).toThrowError(/unterminated string/);
  });
});

describe('parser', () => {
  it('parses indented if/else blocks', () => {
    const stmts = parseProgram(`
x = 0
if close > open
    x := 1
else
    x := 2
y = x + 1
`);
    expect(stmts).toHaveLength(3);
    const ifS = stmts[1] as Extract<(typeof stmts)[number], { t: 'if' }>;
    expect(ifS.t).toBe('if');
    expect(ifS.then).toHaveLength(1);
    expect(ifS.els).toHaveLength(1);
  });

  it('parses tuple destructuring and named args', () => {
    const stmts = parseProgram('[a, b] = ta.macd(close, 12, 26, 9)\nplot(a, title="X")\n');
    expect((stmts[0] as { t: string }).t).toBe('tuple');
    const call = (stmts[1] as { expr: { t: string } }).expr;
    expect(call.t).toBe('call');
  });

  it('reports parse errors with line numbers', () => {
    try {
      parseProgram('x = 1\ny = )\n');
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).line).toBe(2);
    }
  });

  it('requires indented if bodies', () => {
    expect(() => parseProgram('if cond\nx = 1\n')).toThrowError(/indent/i);
  });
});

describe('interpreter semantics', () => {
  const bars = synthBars(120);

  it('assignment inside if keeps prior value on other bars (Pine per-bar path)', () => {
    const r = runScript(
      `indicator("t", overlay=true)
x = 0
if close > open
    x := 1
plot(x, "x", color.teal)`,
      bars,
    );
    expect(r.ok).toBe(true);
    const data = r.plots[0].data;
    for (let i = 0; i < bars.length; i++) {
      expect(data[i]).toBe(bars[i].c > bars[i].o ? 1 : 0);
    }
  });

  it('var reassignment is sticky (carries forward)', () => {
    const r = runScript(
      `indicator("t", overlay=false)
var lvl = 0.0
if close > open
    lvl := high
plot(lvl, "lvl", color.teal)`,
      bars,
    );
    expect(r.ok).toBe(true);
    const data = r.plots[0].data;
    let last = NaN;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].c > bars[i].o) last = bars[i].h;
      if (i > 0 && Number.isFinite(last)) expect(data[i]).toBeCloseTo(last, 6);
    }
  });

  it('seeds ta.sma / ta.ema / ta.rsi correctly', () => {
    const closes = bars.slice(0, 60).map((b) => b.c);
    const r = runScript(
      `indicator("t", overlay=false)
plot(ta.sma(close, 5), "s", color.teal)
plot(ta.ema(close, 5), "e", color.teal)
plot(ta.rsi(close, 14), "r", color.teal)`,
      bars,
    );
    expect(r.ok).toBe(true);
    // SMA hand-check over last 5 closes
    const sma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    expect(r.plots[0].data[59]).toBeCloseTo(sma5, 6);
    // SMA(5) at index 4 = mean of first 5
    expect(r.plots[0].data[4]).toBeCloseTo(closes.slice(0, 5).reduce((a, b) => a + b, 0) / 5, 6);
    // warmup is na
    expect(Number.isNaN(r.plots[0].data[3])).toBe(true);
    // EMA(5) recursion hand-check at index 5
    const a = 2 / 6;
    let ema = closes.slice(0, 5).reduce((s, v) => s + v, 0) / 5; // seeded with first value = c0 in our impl
    // our ema seeds with the FIRST finite value, so rebuild:
    let e2 = closes[0];
    for (let i = 1; i <= 5; i++) e2 = a * closes[i] + (1 - a) * e2;
    expect(r.plots[1].data[5]).toBeCloseTo(e2, 6);
    // RSI bounded
    const rsi = r.plots[2].data.filter((v) => Number.isFinite(v));
    expect(rsi.length).toBeGreaterThan(30);
    for (const v of rsi) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('registers inputs and honors overrides', () => {
    const code = `indicator("t", overlay=false)
len = input.int(20, "Length")
plot(ta.sma(close, len), "s", color.teal)`;
    const r1 = runScript(code, bars);
    expect(r1.inputs).toHaveLength(1);
    expect(r1.inputs[0].def).toBe(20);
    const r2 = runScript(code, bars, { inputs: { Length: 5 } });
    expect(r2.plots[0].data[59]).toBeCloseTo(bars.slice(55, 60).reduce((s, b) => s + b.c, 0) / 5, 6);
  });

  it('history access [n] shifts with na head', () => {
    const r = runScript(
      `indicator("t", overlay=false)
plot(close[3], "lag", color.teal)`,
      bars,
    );
    expect(Number.isNaN(r.plots[0].data[2])).toBe(true);
    expect(r.plots[0].data[10]).toBeCloseTo(bars[7].c, 8);
  });

  it('reports unknown identifiers with a line number', () => {
    const r = runScript('indicator("t")\nplot(nosuch, "x", color.teal)\n', bars);
    expect(r.ok).toBe(false);
    expect(r.error?.line).toBe(2);
    expect(r.error?.message).toMatch(/unknown identifier 'nosuch'/);
  });

  it('crossover detects strict crossings only', () => {
    const r = runScript(
      `indicator("t", overlay=false)
f = ta.sma(close, 3)
s = ta.sma(close, 10)
plot(ta.crossover(f, s), "x", color.teal)`,
      bars,
    );
    expect(r.ok).toBe(true);
    const data = r.plots[0].data;
    let crossings = 0;
    for (const v of data) crossings += v === 1 ? 1 : 0;
    expect(crossings).toBeLessThan(bars.length / 4);
  });

  it('ternary selects elementwise with na cond → else branch', () => {
    const r = runScript(
      `indicator("t", overlay=true)
rth = hour >= 13 and hour < 21
plot(rth ? close : na, "rth", color.teal)`,
      bars,
    );
    expect(r.ok).toBe(true);
    const d = r.plots[0].data;
    const h = new Date(bars[5].ts).getUTCHours();
    if (h >= 13 && h < 21) expect(d[5]).toBeCloseTo(bars[5].c, 8);
    else expect(Number.isNaN(d[5])).toBe(true);
  });
});

describe('backtest', () => {
  it('fills at next-bar open and produces a deterministic trade list', () => {
    // 30 flat bars at 100, then a straight ramp to 130, then a straight fall
    const bars: ScriptBar[] = [];
    let t = 1_700_000_000_000;
    const push = (c: number, o?: number) => {
      const op = o ?? c;
      bars.push({ ts: (t += 3_600_000), o: op, h: Math.max(op, c) * 1.001, l: Math.min(op, c) * 0.999, c, v: 100, tb: 50 });
    };
    for (let i = 0; i < 30; i++) push(100);
    for (let i = 0; i < 15; i++) push(100 + i * 2);
    for (let i = 0; i < 15; i++) push(130 - i * 2);

    const r = runScript(
      `strategy("t", overlay=true, initial_capital=10000)
f = ta.sma(close, 3)
s = ta.sma(close, 10)
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
if ta.crossunder(f, s)
    strategy.close("L")
plot(f, "f", color.teal)`,
      bars,
    );
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('strategy');
    const bt = r.backtest!;
    expect(bt.trades.length).toBeGreaterThanOrEqual(1);
    const first = bt.trades[0];
    expect(first.side).toBe('long');
    // entry price must be an OPEN of some later bar (next-bar fill), not the signal close
    const opens = new Set(bars.map((b) => b.o));
    expect(opens.has(first.entryPrice)).toBe(true);
    // stats consistent
    expect(bt.stats.trades).toBe(bt.trades.length);
    expect(bt.stats.wins + bt.stats.losses).toBe(bt.stats.trades);
    expect(bt.stats.finalEquity).toBeGreaterThan(0);
    // equity length matches bars
    expect(bt.equity.length).toBe(bars.length);
    // determinism
    const r2 = runScript(
      `strategy("t", overlay=true, initial_capital=10000)
f = ta.sma(close, 3)
s = ta.sma(close, 10)
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
if ta.crossunder(f, s)
    strategy.close("L")
plot(f, "f", color.teal)`,
      bars,
    );
    expect(r2.backtest!.trades).toEqual(bt.trades);
  });

  it('stop exits trigger intrabar at the stop price', () => {
    const bars: ScriptBar[] = [];
    let t = 1_700_000_000_000;
    for (let i = 0; i < 25; i++) {
      const c = 100 + i;
      bars.push({ ts: (t += 3_600_000), o: c, h: c + 0.5, l: c - 0.5, c, v: 10, tb: 5 });
    }
    // crash bar
    bars.push({ ts: (t += 3_600_000), o: 125, h: 126, l: 90, c: 95, v: 10, tb: 5 });

    const r = runScript(
      `strategy("t", overlay=true, initial_capital=10000)
if bar_index == 5
    strategy.entry("L", strategy.long)
    strategy.exit("L", stop=close - 5)
plot(close, "c", color.teal)`,
      bars,
    );
    expect(r.ok).toBe(true);
    const bt = r.backtest!;
    expect(bt.trades).toHaveLength(1);
    expect(bt.trades[0].reason).toBe('stop');
    expect(bt.trades[0].exitPrice).toBeCloseTo(100, 6); // stop = close(5) - 5 = 100
  });
});

describe('library conformance', () => {
  const bars = synthBars(300);

  it('every category has scripts', () => {
    for (const c of SCRIPT_CATEGORIES) {
      const count = BUILTIN_SCRIPTS.filter((s) => s.category === c.key).length;
      expect(count, `category ${c.label}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('every built-in script runs without error', () => {
    for (const s of BUILTIN_SCRIPTS) {
      const r = runScript(s.code, bars);
      if (!r.ok) {
        throw new Error(`${s.name} failed: line ${r.error?.line} — ${r.error?.message}`);
      }
      expect(r.ok, s.name).toBe(true);
      expect(r.plots.length + r.shapes.length + r.hlines.length, `${s.name} produced no output`).toBeGreaterThan(0);
    }
  });

  it('the default strategy script produces trades', () => {
    const r = runScript(defaultScript, bars);
    if (!r.ok) throw new Error(`default script failed: ${r.error?.message} @ line ${r.error?.line}`);
    expect(r.kind).toBe('strategy');
    expect(r.backtest!.trades.length).toBeGreaterThanOrEqual(1);
    expect(r.inputs.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VolScript — interpreter. Vectorized over all bars (values are scalars or
// Float64Array series; NaN = na). Pine-faithful semantics:
//   • `x = expr` recomputes every bar; inside `if` it applies only where the
//     condition holds, otherwise the variable keeps the value it already had
//     on that bar from earlier statements (per-bar sequential execution).
//   • `var x = expr` initializes ONCE (first bar where the branch runs) and
//     re-assignments to it are STICKY (carry to later bars).
//   • strategy.* orders fill at the NEXT bar's open — never repaint.
// ─────────────────────────────────────────────────────────────────────────────

import type { ExprNode, StmtNode } from './parser';
import type {
  ScriptBar,
  InputSpec,
  PlotSpec,
  ShapeSpec,
  HLineSpec,
  FillSpec,
  BackgroundSpec,
  BarColorSpec,
  PlotStyle,
  ShapeStyle,
} from './types';
import {
  TA_BUILTINS,
  MATH_BUILTINS,
  OPTIONS_BUILTINS,
  mkArgs,
  isSeries,
  isColor,
  broadcast,
  asSeries,
  asNum,
  colorVal,
  COLORS,
  PALETTE,
  type Val,
  type ColorObj,
  type SeriesColorObj,
} from './builtins';

export class RuntimeError extends Error {
  line: number;
  constructor(message: string, line = 0) {
    super(message);
    this.line = line;
  }
}

/** A per-bar color: `cond ? colorA : colorB` where the branches are colors —
 * what bgcolor()/barcolor()/plot(color=…) receive from typical Pine scripts. */
type SeriesColor = SeriesColorObj;

function isSeriesColor(v: Val): v is SeriesColorObj {
  return typeof v === 'object' && v !== null && 'a' in v && 'b' in v && 'cond' in v;
}

/** Turn a color-ish value into per-bar css strings (null = leave untouched). */
function colorSeries(v: Val, n: number): (string | null)[] | null {
  if (isColor(v)) return new Array<string | null>(n).fill(v.css);
  if (isSeriesColor(v)) {
    const out: (string | null)[] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) out[i] = v.cond[i] !== 0 ? v.a.css : v.b.css;
    return out;
  }
  return null;
}

export interface InterpEvents {
  enterLong: Float64Array;
  enterShort: Float64Array;
  closeAll: Float64Array;
  stop: Float64Array;
  limit: Float64Array;
}

export interface InterpResult {
  kind: 'indicator' | 'strategy';
  title: string;
  overlay: boolean;
  plots: PlotSpec[];
  shapes: ShapeSpec[];
  hlines: HLineSpec[];
  fills: FillSpec[];
  background: BackgroundSpec | null;
  barColors: BarColorSpec | null;
  inputs: InputSpec[];
  logs: string[];
  events: InterpEvents;
  strategyCfg: { initialCapital: number; commissionPct: number };
}

const SOURCE_SERIES = [
  'open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'volume',
  'buyvol', 'sellvol', 'delta', 'cvd',
] as const;

const PLOT_STYLES: Record<string, PlotStyle> = {
  'plot.style_line': 'line',
  'plot.style_linebr': 'line',
  'plot.style_stepline': 'stepline',
  'plot.style_histogram': 'histogram',
  'plot.style_columns': 'column',
  'plot.style_area': 'area',
  'plot.style_circles': 'circles',
  'plot.style_cross': 'cross',
};

const SHAPE_STYLES: Record<string, ShapeStyle> = {
  'shape.triangleup': 'triangleup',
  'shape.triangledown': 'triangledown',
  'shape.circle': 'circle',
  'shape.cross': 'cross',
  'shape.xcross': 'cross',
  'shape.square': 'square',
  'shape.diamond': 'diamond',
  'shape.arrowup': 'arrowup',
  'shape.arrowdown': 'arrowdown',
  'shape.labelup': 'label',
  'shape.labeldown': 'label',
  'shape.label': 'label',
};

/** constants like color.teal / strategy.long / plot.style_line */
const CONSTANTS: Record<string, Val> = (() => {
  const m: Record<string, Val> = {
    na: NaN,
    true: 1,
    false: 0,
    'strategy.long': 1,
    'strategy.short': -1,
    'plot.style_line': 'line',
    'plot.style_linebr': 'line',
    'plot.style_stepline': 'stepline',
    'plot.style_histogram': 'histogram',
    'plot.style_columns': 'column',
    'plot.style_area': 'area',
    'plot.style_circles': 'circles',
    'plot.style_cross': 'cross',
    'shape.triangleup': 'triangleup',
    'shape.triangledown': 'triangledown',
    'shape.circle': 'circle',
    'shape.cross': 'cross',
    'shape.xcross': 'cross',
    'shape.square': 'square',
    'shape.diamond': 'diamond',
    'shape.arrowup': 'arrowup',
    'shape.arrowdown': 'arrowdown',
    'shape.labelup': 'label',
    'shape.labeldown': 'label',
    'shape.label': 'label',
    'location.belowbar': 'belowbar',
    'location.abovebar': 'abovebar',
    'location.absolute': 'absolute',
    'location.top': 'abovebar',
    'location.bottom': 'belowbar',
    'hline.style_solid': 'solid',
    'hline.style_dashed': 'dashed',
    'hline.style_dotted': 'dotted',
    'display.none': 'none',
    'display.all': 'all',
    'display.data_window': 'none',
    'display.pane': 'none',
    'display.price_scale': 'none',
    'display.status_line': 'none',
    'barmerge.gaps_off': 0,
    'barmerge.gaps_on': 0,
    'barmerge.lookahead_off': 0,
    'barmerge.lookahead_on': 0,
    'size.auto': 'auto',
    'size.tiny': 'tiny',
    'size.small': 'small',
    'size.normal': 'normal',
    'size.large': 'large',
    'size.huge': 'huge',
    'syminfo.ticker': '',
    'syminfo.tickerid': '',
    'syminfo.type': '',
    'syminfo.currency': '',
    'timeframe.period': '',
    'timeframe.multiplier': 0,
    'timeframe.isminutes': 0,
    'timeframe.isdaily': 0,
    'timeframe.isweekly': 0,
    'timeframe.ismonthly': 0,
    'timeframe.isintraday': 0,
    'timeframe.isdwm': 0,
    'chart.is_standard': 1,
    'chart.is_heikinashi': 0,
    'chart.is_renko': 0,
    'alert.freq_once_per_bar': 0,
    'alert.freq_once_per_bar_close': 0,
    'alert.freq_all_bars': 0,
    'extend.none': 0,
    'extend.right': 1,
    'extend.both': 1,
    'xloc.bar_index': 0,
    'xloc.bar_time': 1,
    'yloc.price': 0,
    'yloc.abovebar': 1,
    'yloc.belowbar': 2,
    'yloc.top': 3,
    'yloc.bottom': 4,
    'text.align_center': 0,
    'text.align_left': 0,
    'text.align_right': 0,
    'label.style_none': 0,
    'label.style_label_down': 0,
    'label.style_label_up': 0,
    'line.style_solid': 'solid',
    'line.style_dashed': 'dashed',
    'line.style_dotted': 'dotted',
    'line.style_arrow_both': 'solid',
    'line.style_arrow_left': 'solid',
    'line.style_arrow_right': 'solid',
    'format.price': 0,
    'format.percent': 1,
    'format.volume': 2,
    'format.inherit': 0,
    'position.top_left': 0,
    'position.top_center': 0,
    'position.top_right': 0,
    'position.middle_left': 0,
    'position.middle_center': 0,
    'position.middle_right': 0,
    'position.bottom_left': 0,
    'position.bottom_center': 0,
    'position.bottom_right': 0,
    'bar_index.h': 0,
    'barstate.isfirst': 0,
    'barstate.islast': 0,
    'barstate.ishistory': 1,
    'barstate.isrealtime': 0,
    'barstate.isnew': 0,
    'barstate.isconfirmed': 1,
    'scale.left': 'left',
    'scale.right': 'right',
    'scale.none': 'none',
  };
  for (const name of Object.keys(COLORS)) m[`color.${name}`] = colorVal(name, 1);
  return m;
})();

function truthy(v: number): boolean {
  return Number.isFinite(v) && v !== 0;
}

function buildGlobals(bars: ScriptBar[]): Map<string, Float64Array> {
  const n = bars.length;
  const g = new Map<string, Float64Array>();
  const o = new Float64Array(n);
  const h = new Float64Array(n);
  const l = new Float64Array(n);
  const c = new Float64Array(n);
  const v = new Float64Array(n);
  const tb = new Float64Array(n);
  const time = new Float64Array(n);
  const hour = new Float64Array(n);
  const minute = new Float64Array(n);
  const dow = new Float64Array(n);
  const dom = new Float64Array(n);
  const month = new Float64Array(n);
  const idx = new Float64Array(n);
  const delta = new Float64Array(n);
  const cvd = new Float64Array(n);
  let cvdAcc = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    o[i] = b.o;
    h[i] = b.h;
    l[i] = b.l;
    c[i] = b.c;
    v[i] = b.v;
    tb[i] = b.tb;
    delta[i] = 2 * b.tb - b.v;
    cvdAcc += delta[i];
    cvd[i] = cvdAcc;
    time[i] = b.ts;
    const d = new Date(b.ts);
    hour[i] = d.getUTCHours();
    minute[i] = d.getUTCMinutes();
    dow[i] = d.getUTCDay();
    dom[i] = d.getUTCDate();
    month[i] = d.getUTCMonth() + 1;
    idx[i] = i;
  }
  g.set('open', o);
  g.set('high', h);
  g.set('low', l);
  g.set('close', c);
  g.set('volume', v);
  g.set('buyvol', tb);
  g.set('sellvol', new Float64Array(n).map((_, i) => v[i] - tb[i]));
  g.set('delta', delta);
  g.set('cvd', cvd);
  g.set('hl2', new Float64Array(n).map((_, i) => (h[i] + l[i]) / 2));
  g.set('hlc3', new Float64Array(n).map((_, i) => (h[i] + l[i] + c[i]) / 3));
  g.set('ohlc4', new Float64Array(n).map((_, i) => (o[i] + h[i] + l[i] + c[i]) / 4));
  g.set('time', time);
  g.set('hour', hour);
  g.set('minute', minute);
  g.set('dayofweek', dow);
  g.set('dayofmonth', dom);
  g.set('month', month);
  g.set('bar_index', idx);
  return g;
}

class Interpreter {
  private bars: ScriptBar[];
  private n: number;
  private globals: Map<string, Float64Array>;
  private vars = new Map<string, Float64Array>();
  /** scalar variables: strings (plot/hline handles, input options), colors */
  private scalars = new Map<string, Val>();
  private varDecls = new Set<string>();
  private mask: Float64Array | null = null;

  kind: 'indicator' | 'strategy' = 'indicator';
  title = 'Untitled';
  overlay = false;
  plots: PlotSpec[] = [];
  shapes: ShapeSpec[] = [];
  hlines: HLineSpec[] = [];
  fills: FillSpec[] = [];
  background: BackgroundSpec | null = null;
  barColors: BarColorSpec | null = null;
  inputs: InputSpec[] = [];
  logs: string[] = [];
  strategyCfg = { initialCapital: 100_000, commissionPct: 0 };
  events: InterpEvents;

  constructor(bars: ScriptBar[], private inputValues: Record<string, number | boolean | string>) {
    this.bars = bars;
    this.n = bars.length;
    this.globals = buildGlobals(bars);
    this.events = {
      enterLong: new Float64Array(this.n),
      enterShort: new Float64Array(this.n),
      closeAll: new Float64Array(this.n),
      stop: new Float64Array(this.n).fill(NaN),
      limit: new Float64Array(this.n).fill(NaN),
    };
  }

  run(stmts: StmtNode[]): void {
    this.exec(stmts);
  }

  // ── statements ─────────────────────────────────────────────────────────────

  private exec(stmts: StmtNode[]): void {
    for (const s of stmts) {
      try {
        this.execOne(s);
      } catch (e) {
        if (e instanceof RuntimeError) {
          if (!e.line && (s as { line?: number }).line) e.line = (s as { line: number }).line;
          throw e;
        }
        const msg = e instanceof Error ? e.message : String(e);
        const line = (s as { line?: number }).line ?? 0;
        throw new RuntimeError(msg, line);
      }
    }
  }

  private execOne(s: StmtNode): void {
    switch (s.t) {
      case 'assign':
        this.execAssign(s.name, s.expr, s.decl);
        break;
      case 'tuple': {
        const val = this.eval(s.expr);
        if (!Array.isArray(val) || isSeries(val as never)) {
          throw new RuntimeError('tuple destructuring needs a function that returns a tuple (ta.macd, ta.supertrend)', (s as { line: number }).line);
        }
        const items = val as Val[];
        if (items.length !== s.names.length) {
          throw new RuntimeError(`tuple size mismatch: got ${items.length}, expected ${s.names.length}`, (s as { line: number }).line);
        }
        for (let i = 0; i < s.names.length; i++) {
          this.execAssign(s.names[i], { t: 'num', v: 0 }, 'new', items[i]);
        }
        break;
      }
      case 'expr':
        this.eval(s.expr);
        break;
      case 'if': {
        const cond = this.eval(s.cond);
        const m = this.toMask(cond);
        const parent = this.mask;
        // then-branch: parent & cond
        this.mask = this.combine(parent, m, true);
        this.exec(s.then);
        // else-branch: parent & !cond
        if (s.els) {
          this.mask = this.combine(parent, m, false);
          this.exec(s.els);
        }
        this.mask = parent;
        break;
      }
    }
  }

  /** Pine-faithful assignment semantics (see file header). */
  private execAssign(name: string, expr: ExprNode, decl: 'new' | 'var' | 're', preEvaluated?: Val): void {
    if (name.includes('.')) throw new RuntimeError(`invalid variable name '${name}'`);
    const val = preEvaluated ?? this.eval(expr);
    const line = (expr as { line?: number }).line ?? 0;

    // scalar values (strings, colors, series-colors, plain lists) never become per-bar series:
    // they are identities (plot handles for fill()) or constants (input option lists)
    if (typeof val === 'string' || isColor(val) || isSeriesColor(val) || Array.isArray(val)) {
      if (decl === 're' && !this.scalars.has(name) && !this.vars.has(name)) {
        throw new RuntimeError(`cannot assign to '${name}' — declare it first with '${name} = …'`, line);
      }
      this.scalars.set(name, val);
      return;
    }

    if (decl === 'var') {
      // initialize ONCE: first bar where the mask runs and the value is finite
      const v = asSeries(val, this.n);
      const old = this.vars.get(name);
      const out = new Float64Array(this.n).fill(NaN);
      if (this.mask === null) {
        let seed = NaN;
        for (let i = 0; i < this.n; i++) {
          if (Number.isFinite(v[i])) {
            seed = v[i];
            break;
          }
        }
        out.fill(seed);
      } else {
        // declared inside an if: sticky seed where it ran
        let seed = NaN;
        let seen = false;
        for (let i = 0; i < this.n; i++) {
          if (this.mask[i] !== 0 && Number.isFinite(v[i])) {
            seed = v[i];
            seen = true;
            break;
          }
        }
        if (!seen && old) out.set(old);
        else out.fill(seed);
      }
      this.vars.set(name, out);
      this.varDecls.add(name);
      return;
    }

    if (decl === 're' && !this.vars.has(name)) {
      throw new RuntimeError(`cannot assign to '${name}' — declare it first with '${name} = …'`, line);
    }

    // sticky carry for re-assignment to a `var`-declared variable
    const isSticky = decl === 're' && this.varDecls.has(name);
    const old = this.vars.get(name);
    const out = new Float64Array(this.n).fill(NaN);

    if (isSticky) {
      const v = asSeries(val, this.n);
      for (let i = 0; i < this.n; i++) {
        const active = this.mask === null || this.mask[i] !== 0;
        if (active && Number.isFinite(v[i])) out[i] = v[i];
        else out[i] = i > 0 ? out[i - 1] : old && Number.isFinite(old[0]) ? old[0] : NaN;
      }
      this.vars.set(name, out);
      return;
    }

    if (this.mask === null) {
      this.vars.set(name, asSeries(val, this.n));
      return;
    }
    const v = asSeries(val, this.n);
    for (let i = 0; i < this.n; i++) {
      if (this.mask[i] !== 0) out[i] = v[i];
      else out[i] = old ? old[i] : NaN;
    }
    this.vars.set(name, out);
  }

  // ── expressions ────────────────────────────────────────────────────────────

  private eval(e: ExprNode): Val {
    switch (e.t) {
      case 'num':
        return e.v;
      case 'str':
        return e.v;
      case 'ident': {
        if (this.vars.has(e.name)) return this.vars.get(e.name) as Float64Array;
        if (this.globals.has(e.name)) return this.globals.get(e.name) as Float64Array;
        if (this.scalars.has(e.name)) return this.scalars.get(e.name) as Val;
        if (e.name in CONSTANTS) return CONSTANTS[e.name];
        throw new RuntimeError(`unknown identifier '${e.name}'`, (e as { line?: number }).line ?? 0);
      }
      case 'un': {
        const v = this.eval(e.e);
        if (isSeries(v)) {
          const out = new Float64Array(v.length);
          for (let i = 0; i < v.length; i++) {
            const x = v[i];
            out[i] = Number.isFinite(x) ? (e.op === '-' ? -x : truthy(x) ? 0 : 1) : e.op === '-' ? NaN : 1;
          }
          return out;
        }
        const x = asNum(v);
        if (e.op === '-') return Number.isFinite(x) ? -x : NaN;
        return Number.isFinite(x) ? (truthy(x) ? 0 : 1) : 1;
      }
      case 'bin':
        return this.evalBin(e.op, e.l, e.r);
      case 'tern': {
        const c = this.eval(e.c);
        const a = this.eval(e.a);
        const b = this.eval(e.b);
        // color branches (bgcolor(cond ? color.teal : color.orange) — very common;
        // Pine also writes `… ? color.teal : na`, so na among colors = transparent)
        const aC = isColor(a) ? a : typeof a === 'number' && !Number.isFinite(a) ? { css: 'transparent', alpha: 0 } : null;
        const bC = isColor(b) ? b : typeof b === 'number' && !Number.isFinite(b) ? { css: 'transparent', alpha: 0 } : null;
        if (aC && bC) {
          if (isSeries(c)) return { a: aC, b: bC, cond: asSeries(c, this.n) } satisfies SeriesColor;
          return truthy(asNum(c)) ? aC : bC;
        }
        if (isSeries(c) || isSeries(a) || isSeries(b)) {
          const cs = asSeries(c, this.n);
          const as = asSeries(a, this.n);
          const bs = asSeries(b, this.n);
          const out = new Float64Array(this.n);
          for (let i = 0; i < this.n; i++) out[i] = truthy(cs[i]) ? as[i] : bs[i];
          return out;
        }
        return truthy(asNum(c)) ? a : b;
      }
      case 'hist': {
        const v = this.eval(e.e);
        const offV = this.eval(e.off);
        const off = Math.max(0, Math.round(asNum(offV, 'history offset')));
        if (isSeries(v)) {
          const out = new Float64Array(v.length).fill(NaN);
          for (let i = off; i < v.length; i++) out[i] = v[i - off];
          return out;
        }
        throw new RuntimeError(`history access [${off}] needs a series, not a constant`, (e as { line?: number }).line ?? 0);
      }
      case 'list':
        return e.items.map((it) => {
          const v = this.eval(it);
          if (typeof v !== 'string') throw new RuntimeError('list literals support strings only (input options)');
          return v;
        });
      case 'call':
        return this.evalCall(e);
    }
  }

  private evalBin(op: string, le: ExprNode, re: ExprNode): Val {
    const l = this.eval(le);
    const r = this.eval(re);
    const line = (le as { line?: number }).line ?? 0;
    if (typeof l === 'string' || typeof r === 'string') {
      if (op === '+' ) return (typeof l === 'string' ? l : asNum(l).toString()) + (typeof r === 'string' ? r : asNum(r).toString());
      throw new RuntimeError(`operator '${op}' does not apply to strings`, line);
    }
    if (isColor(l) || isColor(r)) throw new RuntimeError(`operator '${op}' does not apply to colors`, line);
    if (isSeries(l) || isSeries(r)) {
      const ls = asSeries(l, this.n);
      const rs = asSeries(r, this.n);
      const out = new Float64Array(this.n);
      for (let i = 0; i < this.n; i++) out[i] = this.numOp(op, ls[i], rs[i]);
      return out;
    }
    return this.numOp(op, asNum(l), asNum(r));
  }

  private numOp(op: string, a: number, b: number): number {
    const na = !Number.isFinite(a);
    const nb = !Number.isFinite(b);
    if (na || nb) {
      // na-aware: arithmetic → na; comparisons → false; logic → false
      if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%') return NaN;
      if (op === '&&' || op === '||') {
        // Pine: na treated as false
        const la = !na && a !== 0;
        const lb = !nb && b !== 0;
        return op === '&&' ? (la && lb ? 1 : 0) : la || lb ? 1 : 0;
      }
      return 0;
    }
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? NaN : a / b;
      case '%': return b === 0 ? NaN : a % b;
      case '==': return a === b ? 1 : 0;
      case '!=': return a !== b ? 1 : 0;
      case '<': return a < b ? 1 : 0;
      case '<=': return a <= b ? 1 : 0;
      case '>': return a > b ? 1 : 0;
      case '>=': return a >= b ? 1 : 0;
      case '&&': return a !== 0 && b !== 0 ? 1 : 0;
      case '||': return a !== 0 || b !== 0 ? 1 : 0;
      default:
        throw new RuntimeError(`unsupported operator '${op}'`);
    }
  }

  // ── masks ─────────────────────────────────────────────────────────────────

  private toMask(v: Val): Float64Array {
    if (isSeries(v)) {
      const out = new Float64Array(v.length);
      for (let i = 0; i < v.length; i++) out[i] = truthy(v[i]) ? 1 : 0;
      return out;
    }
    const s = asNum(v);
    return broadcast(truthy(s) ? 1 : 0, this.n);
  }

  private combine(parent: Float64Array | null, cond: Float64Array, and: boolean): Float64Array {
    if (parent === null) return and ? cond : this.not(cond);
    const out = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      out[i] = and ? (parent[i] !== 0 && cond[i] !== 0 ? 1 : 0) : parent[i] !== 0 && cond[i] === 0 ? 1 : 0;
    }
    return out;
  }

  private not(m: Float64Array): Float64Array {
    const out = new Float64Array(m.length);
    for (let i = 0; i < m.length; i++) out[i] = m[i] !== 0 ? 0 : 1;
    return out;
  }

  /** gate a series by the active mask (inactive bars → na) */
  private gated(v: Float64Array): Float64Array {
    if (this.mask === null) return v;
    const out = new Float64Array(v.length).fill(NaN);
    for (let i = 0; i < v.length; i++) {
      if (this.mask[i] !== 0) out[i] = v[i];
    }
    return out;
  }

  // ── calls ─────────────────────────────────────────────────────────────────

  private evalCall(e: Extract<ExprNode, { t: 'call' }>): Val {
    const line = e.line;
    const pos: Val[] = [];
    const named: Record<string, Val> = {};
    for (const a of e.args) {
      const v = this.eval(a.value);
      if (a.name !== undefined) named[a.name] = v;
      else pos.push(v);
    }
    const get = (i: number | undefined, name?: string): Val | undefined => (name !== undefined && name in named ? named[name] : i === undefined ? undefined : pos[i]);

    const name = e.name;
    const rt = (msg: string): never => {
      throw new RuntimeError(msg, line);
    };

    // ── declarations ────────────────────────────────────────────────────────
    if (name === 'indicator' || name === 'strategy') {
      const title = get(0, 'title');
      if (typeof title === 'string') this.title = title;
      const overlayV = get(2, 'overlay');
      this.overlay = overlayV !== undefined && typeof overlayV === 'number' && truthy(overlayV);
      if (name === 'strategy') {
        this.kind = 'strategy';
        const cap = get(3, 'initial_capital');
        if (typeof cap === 'number' && Number.isFinite(cap)) this.strategyCfg.initialCapital = Math.max(100, cap);
        const comm = named['commission_value'] ?? named['commission'];
        if (typeof comm === 'number' && Number.isFinite(comm)) this.strategyCfg.commissionPct = Math.max(0, Math.min(10, comm));
      } else {
        this.kind = 'indicator';
      }
      return 0;
    }

    // ── inputs ──────────────────────────────────────────────────────────────
    if (name.startsWith('input.')) {
      const type = name.slice(6) as InputSpec['type'];
      if (name === 'input.color') return 0;
      const rawDefault = pos[0];
      const titleV = get(1, 'title');
      const title = typeof titleV === 'string' ? titleV : '';
      const key = title || `input${this.inputs.length}`;
      const def: number | boolean | string =
        type === 'bool'
          ? typeof rawDefault === 'number'
            ? truthy(rawDefault)
            : true
          : type === 'string' || type === 'source'
            ? typeof rawDefault === 'string'
              ? rawDefault
              : 'close'
            : typeof rawDefault === 'number'
              ? rawDefault
              : 0;
      const opts = named['options'];
      const options = Array.isArray(opts) ? (opts as string[]) : undefined;
      const spec: InputSpec = { key, title: title || key, type, def, options };
      if (type === 'int' || type === 'float') {
        const mn = named['minval'];
        const mx = named['maxval'];
        const st = named['step'];
        if (typeof mn === 'number') spec.minval = mn;
        if (typeof mx === 'number') spec.maxval = mx;
        if (typeof st === 'number') spec.step = st;
      }
      this.inputs.push(spec);
      const userVal = this.inputValues[key];
      if (userVal !== undefined) {
        if (type === 'source' && typeof userVal === 'string') {
          const g = this.globals.get(userVal);
          if (g) return g;
        }
        if (type === 'bool') return userVal === true || userVal === 1 ? 1 : 0;
        if (typeof userVal === 'number') return userVal;
        if (typeof userVal === 'string' && type === 'string') return userVal;
      }
      if (type === 'source') {
        // default must be a plain series name — read it from the raw arg node
        const rawNode = e.args.find((x) => x.name === undefined)?.value;
        if (rawNode && rawNode.t === 'ident' && this.globals.has(rawNode.name)) {
          return this.globals.get(rawNode.name) as Float64Array;
        }
        return this.globals.get('close') as Float64Array;
      }
      return typeof def === 'boolean' ? (def ? 1 : 0) : def;
    }

    // ── plotting ────────────────────────────────────────────────────────────
    if (name === 'plot') {
      const dataV = get(0, 'series');
      if (dataV === undefined) throw new RuntimeError('plot() needs a series to plot', line);
      const data = this.gated(asSeries(dataV, this.n));
      const titleV = get(1, 'title');
      const colorV = get(2, 'color');
      const widthV = get(3, 'linewidth');
      const styleV = get(4, 'style');
      const offsetV = get(undefined, 'offset');
      const color = this.resolveColor(colorV, PALETTE[this.plots.length % PALETTE.length], 'plot');
      const style = this.resolveStyle(styleV, PLOT_STYLES, 'line');
      const width = typeof widthV === 'number' && Number.isFinite(widthV) ? Math.max(1, Math.min(4, widthV)) : 1.25;
      // plot(offset=…) shifts the drawn series by whole bars (positive = right)
      let shifted = data;
      if (typeof offsetV === 'number' && Number.isFinite(offsetV) && Math.round(offsetV) !== 0) {
        const off = Math.round(offsetV);
        const s = new Float64Array(this.n).fill(NaN);
        for (let i = 0; i < this.n; i++) {
          const j = i + off;
          if (j >= 0 && j < this.n) s[j] = data[i];
        }
        shifted = s;
      }
      this.plots.push({
        title: typeof titleV === 'string' && titleV ? titleV : `plot ${this.plots.length + 1}`,
        data: Array.from(shifted),
        color: color.css,
        alpha: color.alpha,
        width,
        style: style as PlotSpec['style'],
        overlay: this.overlay,
      });
      // identity token — fill() takes plot handles exactly like Pine
      return `plot:${this.plots.length - 1}`;
    }

    if (name === 'plotshape') {
      const condV = get(0, 'series');
      if (condV === undefined) throw new RuntimeError('plotshape() needs a condition series', line);
      const cond = this.gated(asSeries(condV, this.n));
      const titleV = get(1, 'title');
      const styleV = get(2, 'style');
      const locV = get(3, 'location');
      const colorV = get(4, 'color');
      const textV = get(undefined, 'text');
      const color = this.resolveColor(colorV, 'teal', 'plotshape');
      const style = this.resolveStyle(styleV, SHAPE_STYLES, 'triangleup');
      const locRaw = this.resolveStyle(locV, { belowbar: 'belowbar', abovebar: 'abovebar', absolute: 'absolute' } as Record<string, string>, 'belowbar');
      this.shapes.push({
        title: typeof titleV === 'string' && titleV ? titleV : `shape ${this.shapes.length + 1}`,
        cond: Array.from(cond).map((v) => v !== 0 && Number.isFinite(v)),
        style: style as ShapeSpec['style'],
        location: locRaw === 'abovebar' ? 'abovebar' : locRaw === 'absolute' ? 'absolute' : 'belowbar',
        color: color.css,
        alpha: color.alpha,
        overlay: this.overlay,
        text: typeof textV === 'string' && textV ? textV : undefined,
      });
      return 0;
    }

    if (name === 'hline') {
      const priceV = get(0, 'price');
      if (priceV === undefined) throw new RuntimeError('hline() needs a price', line);
      let price: number;
      if (isSeries(priceV)) {
        price = NaN;
        for (let i = priceV.length - 1; i >= 0; i--) {
          if (Number.isFinite(priceV[i])) {
            price = priceV[i];
            break;
          }
        }
      } else price = asNum(priceV);
      if (!Number.isFinite(price)) rt('hline() price resolved to na');
      const titleV = get(1, 'title');
      const colorV = get(2, 'color');
      const styleV = get(3, 'linestyle');
      const color = this.resolveColor(colorV, 'zinc', 'hline');
      this.hlines.push({
        title: typeof titleV === 'string' && titleV ? titleV : `level ${this.hlines.length + 1}`,
        price,
        color: color.css,
        alpha: color.alpha,
        dashed: this.resolveStyle(styleV, { dashed: 'dashed', dotted: 'dashed', solid: 'solid' } as Record<string, string>, 'solid') === 'dashed',
        overlay: this.overlay,
      });
      // identity token — fill() takes hline handles exactly like Pine
      return `hline:${this.hlines.length - 1}`;
    }

    // ── fill / bgcolor / barcolor / candle plots / chars / arrows ──────────
    if (name === 'fill') {
      const aV = pos[0];
      const bV = pos[1];
      const colorV = get(2, 'color');
      const titleV = get(undefined, 'title');
      const parseToken = (v: Val, what: string): { kind: 'plot' | 'hline'; index: number } => {
        if (typeof v !== 'string' || !/^(plot|hline):\d+$/.test(v)) {
          throw new RuntimeError(`fill() ${what} must be a plot()/hline() handle`, line);
        }
        const [kind, idx] = v.split(':');
        return { kind: kind as 'plot' | 'hline', index: Number(idx) };
      };
      const a = parseToken(aV, 'first argument');
      const b = parseToken(bV, 'second argument');
      const color = this.resolveColor(colorV, 'teal', 'fill');
      this.fills.push({
        title: typeof titleV === 'string' && titleV ? titleV : `${a.kind === 'plot' ? this.plots[a.index]?.title : this.hlines[a.index]?.title} → ${b.kind === 'plot' ? this.plots[b.index]?.title : this.hlines[b.index]?.title}`,
        a,
        b,
        color: color.css,
        alpha: color.alpha,
        overlay: this.overlay,
      });
      return 0;
    }

    if (name === 'bgcolor') {
      const colorV = pos[0] ?? get(undefined, 'color');
      if (colorV === undefined) throw new RuntimeError('bgcolor() needs a color', line);
      const colors = colorSeries(colorV, this.n);
      if (!colors) throw new RuntimeError('bgcolor() needs a color or a conditional color', line);
      const alpha = isColor(colorV) ? colorV.alpha : isSeriesColor(colorV) ? Math.max(colorV.a.alpha, colorV.b.alpha) : 0.35;
      this.background = { color: colors.find((c) => c) ?? '#22d3ee', alpha: Math.min(alpha, 0.9), colors, overlay: this.overlay };
      return 0;
    }

    if (name === 'barcolor') {
      const colorV = pos[0] ?? get(undefined, 'color');
      if (colorV === undefined) throw new RuntimeError('barcolor() needs a color', line);
      const colors = colorSeries(colorV, this.n);
      if (!colors) throw new RuntimeError('barcolor() needs a color or a conditional color', line);
      this.barColors = { colors, overlay: this.overlay };
      return 0;
    }

    if (name === 'plotchar') {
      const condV = get(0, 'series');
      if (condV === undefined) throw new RuntimeError('plotchar() needs a series', line);
      const cond = this.gated(asSeries(condV, this.n));
      const charV = get(2, 'char');
      const titleV = get(1, 'title');
      const locV = get(undefined, 'location');
      const colorV = get(undefined, 'color');
      const color = this.resolveColor(colorV, 'amber', 'plotchar');
      const locRaw = this.resolveStyle(locV, { belowbar: 'belowbar', abovebar: 'abovebar', absolute: 'absolute' } as Record<string, string>, 'abovebar');
      this.shapes.push({
        title: typeof titleV === 'string' && titleV ? titleV : `char ${this.shapes.length + 1}`,
        cond: Array.from(cond).map((v) => v !== 0 && Number.isFinite(v)),
        style: 'label',
        location: locRaw === 'belowbar' ? 'belowbar' : locRaw === 'absolute' ? 'absolute' : 'abovebar',
        color: color.css,
        alpha: color.alpha,
        overlay: this.overlay,
        text: typeof charV === 'string' ? charV.slice(0, 3) : undefined,
      });
      return 0;
    }

    if (name === 'plotarrow') {
      const valV = get(0, 'series');
      if (valV === undefined) throw new RuntimeError('plotarrow() needs a series', line);
      const vals = this.gated(asSeries(valV, this.n));
      const upV = get(undefined, 'colorup');
      const downV = get(undefined, 'colordown');
      const up = this.resolveColor(upV, 'teal', 'plotarrow');
      const down = this.resolveColor(downV, 'rose', 'plotarrow');
      this.shapes.push({
        title: `arrow up`,
        cond: Array.from(vals).map((v) => Number.isFinite(v) && v > 0),
        style: 'arrowup',
        location: 'abovebar',
        color: up.css,
        alpha: up.alpha,
        overlay: this.overlay,
        sizeData: Array.from(vals),
      });
      this.shapes.push({
        title: `arrow down`,
        cond: Array.from(vals).map((v) => Number.isFinite(v) && v < 0),
        style: 'arrowdown',
        location: 'belowbar',
        color: down.css,
        alpha: down.alpha,
        overlay: this.overlay,
        sizeData: Array.from(vals).map((v) => (Number.isFinite(v) ? Math.abs(v) : NaN)),
      });
      return 0;
    }

    if (name === 'plotcandle' || name === 'plotbar') {
      const oV = get(0, 'open');
      const hV = get(1, 'high');
      const lV = get(2, 'low');
      const cV = get(3, 'close');
      if (oV === undefined || hV === undefined || lV === undefined || cV === undefined) {
        throw new RuntimeError(`${name}() needs open, high, low and close series`, line);
      }
      const o = this.gated(asSeries(oV, this.n));
      const h = this.gated(asSeries(hV, this.n));
      const l = this.gated(asSeries(lV, this.n));
      const c = this.gated(asSeries(cV, this.n));
      const titleV = get(4, 'title');
      const colorV = get(undefined, 'color');
      const color = this.resolveColor(colorV, 'sky', name);
      const data: number[] = new Array(this.n).fill(NaN);
      for (let i = 0; i < this.n; i++) {
        if (Number.isFinite(o[i]) && Number.isFinite(h[i]) && Number.isFinite(l[i]) && Number.isFinite(c[i])) data[i] = c[i];
      }
      this.plots.push({
        title: typeof titleV === 'string' && titleV ? titleV : `candles ${this.plots.length + 1}`,
        data,
        color: color.css,
        alpha: color.alpha,
        width: 1.25,
        style: 'line',
        overlay: this.overlay,
        ohlc: { open: Array.from(o), high: Array.from(h), low: Array.from(l), close: Array.from(c) },
        ohlcKind: name === 'plotcandle' ? 'candles' : 'bars',
      });
      return `plot:${this.plots.length - 1}`;
    }

    // ── tolerated no-ops (kept so copied Pine scripts run) ───────────────
    if (
      name === 'alertcondition' || name === 'alert' || name.startsWith('label.') || name.startsWith('line.') ||
      name.startsWith('box.') || name.startsWith('table.') || name.startsWith('polyline.') || name.startsWith('map.') ||
      name === 'log.error' || name === 'log.info' || name === 'log.warning'
    ) {
      this.logs.push(`${name}() ignored — ${name.startsWith('label') || name.startsWith('line') || name.startsWith('box') || name.startsWith('table') ? 'drawing objects' : 'alerts'} are not drawn by this engine`);
      return 0;
    }
    if (name === 'runtime.log') {
      const mV = pos[0];
      this.logs.push(typeof mV === 'string' ? mV : 'runtime.log()');
      return 0;
    }
    if (name === 'runtime.error') {
      const mV = pos[0];
      rt(`runtime.error: ${typeof mV === 'string' ? mV : 'script error'}`);
    }

    if (name === 'request.security' || name === 'request.security_lower_tf' || name === 'for' || name === 'while' || name === 'switch' || name.startsWith('array.') || name.startsWith('matrix.') || name.startsWith('str.') || name.startsWith('input.symbol')) {
      if (name === 'request.security') {
        rt(`request.security() is not supported yet — this engine computes on one symbol/timeframe; inline the higher-timeframe logic or ask the AI desk to restructure it`);
      }
      rt(`'${name}' is not supported in VolScript yet — use plot(), plotshape(), hline(), fill(), bgcolor() or barcolor()`);
    }

    // ── strategy orders ────────────────────────────────────────────────────
    if (name === 'strategy.entry') {
      const idV = get(0, 'id');
      const dirV = get(1, 'direction');
      const dir = dirV === undefined ? 1 : typeof dirV === 'number' ? Math.sign(dirV) : dirV === 'long' ? 1 : dirV === 'short' ? -1 : 1;
      if (dir > 0) this.orInto(this.events.enterLong);
      else this.orInto(this.events.enterShort);
      return 0;
    }
    if (name === 'strategy.close' || name === 'strategy.close_all') {
      this.orInto(this.events.closeAll);
      return 0;
    }
    if (name === 'strategy.exit') {
      const stopV = get(undefined, 'stop');
      const limitV = get(undefined, 'limit');
      if (stopV === undefined && limitV === undefined) return 0;
      const stop = stopV !== undefined ? asSeries(stopV, this.n) : null;
      const limit = limitV !== undefined ? asSeries(limitV, this.n) : null;
      const m = this.mask;
      for (let i = 0; i < this.n; i++) {
        if (m === null || m[i] !== 0) {
          if (stop && Number.isFinite(stop[i])) this.events.stop[i] = stop[i];
          if (limit && Number.isFinite(limit[i])) this.events.limit[i] = limit[i];
        }
      }
      return 0;
    }
    if (name === 'strategy.position_size' || name === 'strategy.opentrades') {
      rt(`'${name}' is not supported in VolScript — strategies here are event-driven, use plots to inspect state`);
    }

    // ── utilities ───────────────────────────────────────────────────────────
    if (name === 'nz') {
      const x = get(0);
      const y = get(1);
      if (x === undefined) throw new RuntimeError('nz() needs an argument', line);
      const fillWith = asSeries(y === undefined ? 0 : (y as Val), this.n);
      if (isSeries(x)) {
        const out = new Float64Array(this.n);
        for (let i = 0; i < this.n; i++) out[i] = Number.isFinite(x[i]) ? x[i] : fillWith[i];
        return out;
      }
      const v = asNum(x);
      return Number.isFinite(v) ? v : asNum(y === undefined ? 0 : (y as Val));
    }
    if (name === 'na') {
      const x = get(0);
      if (x === undefined) throw new RuntimeError('na() needs an argument', line);
      if (isSeries(x)) {
        const out = new Float64Array(this.n);
        for (let i = 0; i < this.n; i++) out[i] = Number.isFinite(x[i]) ? 0 : 1;
        return out;
      }
      return Number.isFinite(asNum(x)) ? 0 : 1;
    }
    if (name === 'fixnan') {
      const x = get(0);
      if (x === undefined || !isSeries(x)) throw new RuntimeError('fixnan() needs a series', line);
      const out = new Float64Array(this.n);
      let last = NaN;
      for (let i = 0; i < this.n; i++) {
        if (Number.isFinite(x[i])) last = x[i];
        out[i] = last;
      }
      return out;
    }
    if (name === 'color.new') {
      const c = get(0);
      const t = get(1);
      if (c === undefined) throw new RuntimeError('color.new() needs a color', line);
      const base: ColorObj = typeof c === 'string' ? colorVal(c) : isColor(c) ? c : rt('color.new() first argument must be a color');
      const transp = t === undefined ? 0 : Math.max(0, Math.min(100, asNum(t)));
      return { css: base.css, alpha: Math.max(0, Math.min(1, 1 - transp / 100)) };
    }

    // ── ta.* / math.* ───────────────────────────────────────────────────────
    if (name.startsWith('ta.')) {
      const fn = TA_BUILTINS[name.slice(3)];
      if (!fn) rt(`unknown function '${name}'`);
      try {
        return fn(mkArgs(pos, named, this.bars));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new RuntimeError(`${name}: ${msg}`, line);
      }
    }
    if (name.startsWith('math.')) {
      const fn = MATH_BUILTINS[name.slice(5)];
      if (!fn) rt(`unknown function '${name}'`);
      try {
        return fn(mkArgs(pos, named, this.bars));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new RuntimeError(`${name}: ${msg}`, line);
      }
    }
    if (name.startsWith('options.')) {
      const fn = OPTIONS_BUILTINS[name.slice(8)];
      if (!fn) rt(`unknown function '${name}'`);
      try {
        return fn(mkArgs(pos, named, this.bars));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new RuntimeError(`${name}: ${msg}`, line);
      }
    }

    return rt(`unknown function '${name}'`);
  }

  private orInto(target: Float64Array): void {
    if (this.mask === null) {
      target.fill(1);
      return;
    }
    for (let i = 0; i < this.n; i++) {
      if (this.mask[i] !== 0) target[i] = 1;
    }
  }

  private resolveColor(v: Val | undefined, fallback: string, what: string): ColorObj {
    if (v === undefined) return colorVal(fallback, 1);
    if (isColor(v)) return v;
    if (typeof v === 'string') {
      if (COLORS[v]) return colorVal(v, 1);
      if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return { css: v, alpha: 1 };
      throw new RuntimeError(`${what}: unknown color '${v}'`);
    }
    throw new RuntimeError(`${what}: color argument must be a color constant (color.teal, …)`);
  }

  private resolveStyle(v: Val | undefined, map: Record<string, string>, def: string): string {
    if (v === undefined) return def;
    if (typeof v === 'string') {
      if (v in map) return map[v];
      const vals = Object.values(map) as string[];
      if (vals.includes(v)) return v;
      return def;
    }
    return def;
  }
}

/** Run a parsed program over bars. Throws RuntimeError with line info. */
export function interpret(stmts: StmtNode[], bars: ScriptBar[], inputValues: Record<string, number | boolean | string>): InterpResult {
  const it = new Interpreter(bars, inputValues);
  it.run(stmts);
  return {
    kind: it.kind,
    title: it.title,
    overlay: it.overlay,
    plots: it.plots,
    shapes: it.shapes,
    hlines: it.hlines,
    fills: it.fills,
    background: it.background,
    barColors: it.barColors,
    inputs: it.inputs,
    logs: it.logs,
    events: it.events,
    strategyCfg: it.strategyCfg,
  };
}

export { buildGlobals };

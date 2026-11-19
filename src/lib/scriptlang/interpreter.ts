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
import type { ScriptBar, InputSpec, PlotSpec, ShapeSpec, HLineSpec, PlotStyle, ShapeStyle } from './types';
import {
  TA_BUILTINS,
  MATH_BUILTINS,
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
} from './builtins';

export class RuntimeError extends Error {
  line: number;
  constructor(message: string, line = 0) {
    super(message);
    this.line = line;
  }
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
  'plot.style_histogram': 'histogram',
  'plot.style_area': 'area',
  'plot.style_circles': 'circles',
  'plot.style_cross': 'cross',
};

const SHAPE_STYLES: Record<string, ShapeStyle> = {
  'shape.triangleup': 'triangleup',
  'shape.triangledown': 'triangledown',
  'shape.circle': 'circle',
  'shape.cross': 'cross',
  'shape.square': 'square',
  'shape.diamond': 'diamond',
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
    'plot.style_histogram': 'histogram',
    'plot.style_area': 'area',
    'plot.style_circles': 'circles',
    'plot.style_cross': 'cross',
    'shape.triangleup': 'triangleup',
    'shape.triangledown': 'triangledown',
    'shape.circle': 'circle',
    'shape.cross': 'cross',
    'shape.square': 'square',
    'shape.diamond': 'diamond',
    'location.belowbar': 'belowbar',
    'location.abovebar': 'abovebar',
    'location.absolute': 'belowbar',
    'hline.style_solid': 'solid',
    'hline.style_dashed': 'dashed',
    'hline.style_dotted': 'dotted',
    'display.none': 'none',
    'barmerge.gaps_off': 0,
    'barmerge.gaps_on': 0,
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
  private varDecls = new Set<string>();
  private mask: Float64Array | null = null;

  kind: 'indicator' | 'strategy' = 'indicator';
  title = 'Untitled';
  overlay = false;
  plots: PlotSpec[] = [];
  shapes: ShapeSpec[] = [];
  hlines: HLineSpec[] = [];
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
      const color = this.resolveColor(colorV, PALETTE[this.plots.length % PALETTE.length], 'plot');
      const style = this.resolveStyle(styleV, PLOT_STYLES, 'line');
      const width = typeof widthV === 'number' && Number.isFinite(widthV) ? Math.max(1, Math.min(4, widthV)) : 1.25;
      this.plots.push({
        title: typeof titleV === 'string' && titleV ? titleV : `plot ${this.plots.length + 1}`,
        data: Array.from(data),
        color: color.css,
        alpha: color.alpha,
        width,
        style: style as PlotSpec['style'],
        overlay: this.overlay,
      });
      return 0;
    }

    if (name === 'plotshape') {
      const condV = get(0, 'series');
      if (condV === undefined) throw new RuntimeError('plotshape() needs a condition series', line);
      const cond = this.gated(asSeries(condV, this.n));
      const titleV = get(1, 'title');
      const styleV = get(2, 'style');
      const locV = get(3, 'location');
      const colorV = get(4, 'color');
      const color = this.resolveColor(colorV, 'teal', 'plotshape');
      const style = this.resolveStyle(styleV, SHAPE_STYLES, 'triangleup');
      const locRaw = this.resolveStyle(locV, { belowbar: 'belowbar', abovebar: 'abovebar' } as Record<string, string>, 'belowbar');
      this.shapes.push({
        title: typeof titleV === 'string' && titleV ? titleV : `shape ${this.shapes.length + 1}`,
        cond: Array.from(cond).map((v) => v !== 0 && Number.isFinite(v)),
        style: style as ShapeSpec['style'],
        location: locRaw === 'abovebar' ? 'abovebar' : 'belowbar',
        color: color.css,
        alpha: color.alpha,
        overlay: this.overlay,
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
      return 0;
    }

    if (name === 'fill' || name === 'bgcolor' || name === 'barcolor' || name === 'plotchar' || name === 'plotcandle' || name === 'plotbar' || name === 'alert' || name === 'label.new' || name === 'line.new' || name === 'box.new' || name === 'table.new' || name === 'request.security' || name === 'for' || name === 'while') {
      rt(`'${name}' is not supported in VolScript yet — use plot(), plotshape() or hline()`);
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
    inputs: it.inputs,
    logs: it.logs,
    events: it.events,
    strategyCfg: it.strategyCfg,
  };
}

export { buildGlobals };

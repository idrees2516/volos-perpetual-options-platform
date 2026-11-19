// internal — runScript implementation (kept out of index.ts so the public
// barrel re-exports stay clean).
import { parseProgram } from './parser';
import { LexError } from './lexer';
import { interpret, RuntimeError, type InterpEvents } from './interpreter';
import { ParseError } from './parser';
import { simulateBacktest } from './backtest';
import type { RunResult, RunOptions, ScriptBar } from './types';

export function runScript(code: string, bars: ScriptBar[], opts: RunOptions = {}): RunResult {
  const t0 = Date.now();
  const base = {
    kind: 'indicator' as const,
    title: 'Untitled',
    overlay: false,
    plots: [],
    shapes: [],
    hlines: [],
    inputs: [],
    logs: [],
    runtimeMs: 0,
    bars: bars.length,
  };
  try {
    if (!bars.length) {
      return { ...base, ok: false, error: { line: 0, col: 0, message: 'no bars loaded — pick a symbol and timeframe first', stage: 'runtime' } };
    }
    const stmts = parseProgram(code);
    const it = interpret(stmts, bars, (opts.inputs ?? {}) as Record<string, number | boolean | string>);
    const backtest = it.kind === 'strategy' ? simulateBacktest(bars, it.events, it.strategyCfg) : undefined;
    return {
      ok: true,
      kind: it.kind,
      title: it.title,
      overlay: it.overlay,
      plots: it.plots,
      shapes: it.shapes,
      hlines: it.hlines,
      inputs: it.inputs,
      logs: it.logs,
      backtest,
      runtimeMs: Date.now() - t0,
      bars: bars.length,
    };
  } catch (e) {
    let line = 0;
    let col = 0;
    let stage: 'lex' | 'parse' | 'runtime' = 'runtime';
    let message = e instanceof Error ? e.message : String(e);
    if (e instanceof LexError) {
      line = e.line;
      col = e.col;
      stage = 'lex';
    } else if (e instanceof ParseError) {
      line = e.line;
      col = e.col;
      stage = 'parse';
    } else if (e instanceof RuntimeError) {
      line = e.line;
    }
    return { ...base, ok: false, error: { line, col, message, stage } };
  }
}

export type { InterpEvents };

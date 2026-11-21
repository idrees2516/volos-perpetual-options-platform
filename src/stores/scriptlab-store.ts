'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab store — the whole VolScript studio state. The studio is ONE
// unified surface: the indicator/strategy applies to the price chart up top,
// and everything about that script lives in the panel below the chart — the
// Pine-style editor (with the AI desk embedded beside it), the backtest
// results and the performance analytics. There is no separate backtesting
// module; dataset, draft, run result, AI chat and user scripts persist to
// localStorage like the rest of the terminal.
//
// Bar replay lives here too (EXPERIMENTAL): while replay is active the
// visible dataset is bars.slice(0, replayIdx + 1) — the chart AND the script
// engine only ever see the bars revealed so far, so indicators, strategies,
// backtests and performance all replay bar-by-bar exactly like TradingView.
// Replay state is deliberately transient (never persisted).
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { runScript } from '@/lib/scriptlang/internal';
import { defaultScript, SCRIPT_CATEGORIES } from '@/lib/scriptlang/library';
import type { RunResult, ScriptBar } from '@/lib/scriptlang/types';

/** The tabs of the panel that lives directly below the chart. */
export type BottomTab = 'editor' | 'backtest' | 'performance' | 'library' | 'options' | 'data';

export interface UserScript {
  id: string;
  name: string;
  description: string | null;
  category: string;
  kind: string;
  code: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  code?: string;
  ts: number;
}

export type TfKey2 = '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
export const SCRIPTLAB_TFS: TfKey2[] = ['5m', '15m', '30m', '1h', '4h', '1d'];
export const SCRIPTLAB_SYMBOLS = ['BTC', 'ETH', 'SOL'] as const;

/** default share of the workspace the price chart takes (rest = the panel) */
export const DEFAULT_CHART_SPLIT = 58;
const SPLIT_MIN = 22;
const SPLIT_MAX = 82;

/** bar-replay playback speeds — ms per revealed bar (EXPERIMENTAL feature) */
export const REPLAY_SPEEDS: { label: string; ms: number }[] = [
  { label: '0.5×', ms: 1200 },
  { label: '1×', ms: 500 },
  { label: '2×', ms: 220 },
  { label: '5×', ms: 80 },
];

/** the live playback timer — module-level so it survives store re-creation */
let replayTimer: ReturnType<typeof setInterval> | null = null;

/** slice bars to the replay cursor (identity when replay is off) */
function replaySlice(bars: ScriptBar[] | null, active: boolean, idx: number): ScriptBar[] | null {
  if (!bars || !active) return bars;
  return bars.slice(0, Math.min(bars.length, Math.max(0, idx) + 1));
}

interface ScriptLabState {
  // dataset
  symbol: string;
  tf: TfKey2;
  limit: number;
  bars: ScriptBar[] | null;
  barsSource: string | null;
  barsAsOf: number | null;
  barsLoading: boolean;
  barsError: string | null;

  // editor draft
  scriptName: string;
  scriptCode: string;
  scriptCategory: string;
  scriptDescription: string;
  scriptDirty: boolean;

  // run
  inputs: Record<string, number | boolean | string>;
  result: RunResult | null;
  running: boolean;

  // unified layout — chart on top, one panel below it
  bottomTab: BottomTab;
  aiOpen: boolean;
  chartSplitPct: number;
  bottomCollapsed: boolean;
  /** set when a script is loaded from the library / AI / template — auto-reveals backtest results */
  autoShowBacktest: boolean;

  // bar replay (EXPERIMENTAL — transient, never persisted)
  replayActive: boolean;
  /** index of the last revealed bar (0-based) */
  replayIdx: number;
  replayPlaying: boolean;
  /** ms per revealed bar — one of REPLAY_SPEEDS */
  replaySpeedMs: number;

  // AI
  chat: ChatMessage[];
  aiBusy: boolean;

  // user scripts
  userScripts: UserScript[];

  // actions
  setDataset: (patch: { symbol?: string; tf?: TfKey2; limit?: number }) => void;
  refreshBars: () => Promise<void>;
  rerun: (opts?: { code?: string; inputs?: Record<string, number | boolean | string> }) => void;
  setCode: (code: string) => void;
  setDraftMeta: (patch: { name?: string; category?: string; description?: string }) => void;
  setInput: (key: string, value: number | boolean | string) => void;
  loadScript: (s: { name: string; code: string; category?: string; description?: string }) => void;
  newFromTemplate: (kind: 'indicator' | 'strategy') => void;

  setBottomTab: (tab: BottomTab) => void;
  toggleAiOpen: () => void;
  setChartSplitPct: (pct: number) => void;
  resetChartSplit: () => void;
  toggleBottomCollapsed: () => void;

  // bar replay (EXPERIMENTAL)
  enterReplay: (idx?: number) => void;
  exitReplay: () => void;
  replayStep: (delta: number) => void;
  replaySeek: (idx: number) => void;
  replayTogglePlay: () => void;
  replaySetSpeed: (ms: number) => void;
  replayPlay: () => void;
  replayPause: () => void;

  pushChat: (m: Omit<ChatMessage, 'id' | 'ts'>) => void;
  setAiBusy: (b: boolean) => void;
  /** the one AI desk action — shared by the AI panel and the editor's fix button */
  aiSend: (mode: 'generate' | 'explain' | 'improve' | 'translate' | 'fix', text?: string, useCurrentCode?: boolean) => Promise<void>;

  fetchUserScripts: () => Promise<void>;
  saveScript: () => Promise<string | null>;
  deleteUserScript: (id: string) => Promise<void>;
}

export const useScriptLab = create<ScriptLabState>()(
  persist(
    (set, get) => ({
      symbol: 'BTC',
      tf: '1h',
      limit: 600,
      bars: null,
      barsSource: null,
      barsAsOf: null,
      barsLoading: false,
      barsError: null,

      scriptName: 'EMA Cross + ATR Stop',
      scriptCode: defaultScript,
      scriptCategory: 'trend',
      scriptDescription: 'Default strategy — fast/slow EMA cross with an ATR trailing stop.',
      scriptDirty: false,

      inputs: {},
      result: null,
      running: false,

      bottomTab: 'editor',
      aiOpen: true,
      chartSplitPct: DEFAULT_CHART_SPLIT,
      bottomCollapsed: false,
      autoShowBacktest: false,

      replayActive: false,
      replayIdx: 0,
      replayPlaying: false,
      replaySpeedMs: 500,

      chat: [],
      aiBusy: false,

      userScripts: [],

      setDataset: (patch) => set(patch),

      refreshBars: async () => {
        const { symbol, tf, limit, replayActive } = get();
        set({ barsLoading: true, barsError: null });
        try {
          const res = await fetch(`/api/scriptlab/bars?symbol=${symbol}&tf=${tf}&limit=${limit}`);
          const json = (await res.json()) as {
            success?: boolean;
            data?: { bars: ScriptBar[]; source: string; asOf: number };
            error?: { message?: string };
          };
          if (!json.success || !json.data) throw new Error(json.error?.message ?? 'bars request failed');
          const bars = json.data.bars;
          // a fresh dataset may be shorter than the replay cursor — clamp it
          const replayIdx = replayActive ? Math.min(get().replayIdx, bars.length - 1) : get().replayIdx;
          set({
            bars,
            barsSource: json.data.source,
            barsAsOf: json.data.asOf,
            barsLoading: false,
            replayIdx,
          });
          get().rerun();
        } catch (e) {
          set({ barsLoading: false, barsError: e instanceof Error ? e.message : String(e) });
        }
      },

      rerun: (opts) => {
        const { bars, scriptCode, inputs, replayActive, replayIdx } = get();
        // replay: the script engine only sees bars revealed so far — the
        // indicator, its backtest and its performance all replay with the chart
        const visible = replaySlice(bars, replayActive, replayIdx);
        if (!visible || visible.length === 0) return;
        const code = opts?.code ?? scriptCode;
        const mergedInputs = { ...inputs, ...(opts?.inputs ?? {}) };
        set({ running: true });
        const result = runScript(code, visible, { inputs: mergedInputs });
        const patch: Partial<ScriptLabState> = { result, running: false, inputs: mergedInputs };
        // a script that just arrived from the library / AI desk / template:
        // reveal the backtest results below the chart straight away
        if (get().autoShowBacktest) {
          patch.autoShowBacktest = false;
          if (result.ok && result.kind === 'strategy' && !replayActive) patch.bottomTab = 'backtest';
        }
        set(patch);
        // replaying a strategy re-runs every bar — the runs ledger records the
        // full-window run only (the non-replay rerun), never the replay steps
        if (result.ok && result.kind === 'strategy' && !replayActive) {
          // append-only track record — fire and forget, never blocks the UI
          const { symbol, tf } = get();
          void fetch('/api/scriptlab/runs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              scriptName: get().scriptName,
              symbol,
              tf,
              bars: visible.length,
              metrics: result.backtest?.stats,
              code,
            }),
          }).catch(() => undefined);
        }
      },

      setCode: (code) => set({ scriptCode: code, scriptDirty: true }),
      setDraftMeta: (patch) =>
        set({
          ...(patch.name !== undefined ? { scriptName: patch.name } : {}),
          ...(patch.category !== undefined ? { scriptCategory: patch.category } : {}),
          ...(patch.description !== undefined ? { scriptDescription: patch.description } : {}),
          scriptDirty: true,
        }),
      setInput: (key, value) => {
        const inputs = { ...get().inputs, [key]: value };
        set({ inputs });
        get().rerun({ inputs });
      },

      loadScript: (s) =>
        set({
          scriptName: s.name,
          scriptCode: s.code,
          scriptCategory: s.category ?? 'trend',
          scriptDescription: s.description ?? '',
          scriptDirty: false,
          inputs: {},
          result: null,
          autoShowBacktest: true,
        }),

      newFromTemplate: (kind) => {
        const tpl =
          kind === 'strategy'
            ? defaultScript
            : `//@version=1\nindicator("My Indicator", overlay=true)\nlen = input.int(20, "Length")\nplot(ta.sma(close, len), "SMA", color.teal, 2)\n`;
        set({
          scriptName: kind === 'strategy' ? 'New Strategy' : 'New Indicator',
          scriptCode: tpl,
          scriptCategory: 'trend',
          scriptDescription: '',
          scriptDirty: true,
          inputs: {},
          result: null,
          autoShowBacktest: kind === 'strategy',
        });
      },

      setBottomTab: (tab) => set({ bottomTab: tab, bottomCollapsed: false }),
      toggleAiOpen: () => set({ aiOpen: !get().aiOpen }),
      setChartSplitPct: (pct) => set({ chartSplitPct: Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct)) }),
      resetChartSplit: () => set({ chartSplitPct: DEFAULT_CHART_SPLIT }),
      toggleBottomCollapsed: () => set({ bottomCollapsed: !get().bottomCollapsed }),

      // ── bar replay (EXPERIMENTAL) ───────────────────────────────────────
      enterReplay: (idx) => {
        const { bars } = get();
        if (!bars || bars.length < 2) return;
        const start = Math.max(0, Math.min(bars.length - 1, idx ?? Math.floor(bars.length * 0.66)));
        if (replayTimer) {
          clearInterval(replayTimer);
          replayTimer = null;
        }
        set({ replayActive: true, replayIdx: start, replayPlaying: false });
        get().rerun();
      },
      exitReplay: () => {
        if (replayTimer) {
          clearInterval(replayTimer);
          replayTimer = null;
        }
        set({ replayActive: false, replayPlaying: false, replayIdx: 0 });
        get().rerun();
      },
      replayStep: (delta) => {
        const { bars, replayActive, replayIdx } = get();
        if (!replayActive || !bars) return;
        const next = Math.max(0, Math.min(bars.length - 1, replayIdx + delta));
        if (next === replayIdx) {
          if (delta > 0) get().replayPause();
          return;
        }
        set({ replayIdx: next });
        get().rerun();
      },
      replaySeek: (idx) => {
        const { bars, replayActive } = get();
        if (!replayActive || !bars) return;
        const next = Math.max(0, Math.min(bars.length - 1, Math.round(idx)));
        set({ replayIdx: next });
        get().rerun();
      },
      replayTogglePlay: () => {
        const { replayPlaying } = get();
        if (replayPlaying) get().replayPause();
        else get().replayPlay();
      },
      replaySetSpeed: (ms) => {
        set({ replaySpeedMs: ms });
        // a live playback moves to the new speed immediately
        if (get().replayPlaying) {
          get().replayPause();
          get().replayPlay();
        }
      },
      replayPlay: () => {
        const { bars, replayActive, replayIdx, replayPlaying, replaySpeedMs } = get();
        if (!replayActive || replayPlaying || !bars) return;
        if (replayIdx >= bars.length - 1) return; // already at the live edge
        set({ replayPlaying: true });
        replayTimer = setInterval(() => {
          const s = get();
          if (!s.replayActive || !s.replayPlaying) {
            if (replayTimer) clearInterval(replayTimer);
            replayTimer = null;
            return;
          }
          const next = s.replayIdx + 1;
          if (next >= (s.bars?.length ?? 0)) {
            // reached the live edge — stop the tape
            if (replayTimer) clearInterval(replayTimer);
            replayTimer = null;
            set({ replayPlaying: false, replayIdx: (s.bars?.length ?? 1) - 1 });
            return;
          }
          set({ replayIdx: next });
          get().rerun();
        }, Math.max(60, replaySpeedMs));
      },
      replayPause: () => {
        if (replayTimer) {
          clearInterval(replayTimer);
          replayTimer = null;
        }
        if (get().replayPlaying) set({ replayPlaying: false });
      },

      pushChat: (m) => {
        const chat = [...get().chat, { ...m, id: `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`, ts: Date.now() }];
        set({ chat: chat.slice(-60) });
      },
      setAiBusy: (b) => set({ aiBusy: b }),

      aiSend: async (mode, text, useCurrentCode = false) => {
        const { scriptCode, scriptName, bars, symbol, tf, result } = get();
        const p = (text ?? '').trim();
        const err = result && !result.ok ? result.error : undefined;
        if (!p && !useCurrentCode && !['explain', 'improve', 'fix'].includes(mode)) return;
        if ((mode === 'fix' || mode === 'explain' || mode === 'improve') && !scriptCode) return;
        const userText =
          mode === 'fix' && err
            ? `Fix the compile error — line ${err.line}: ${err.message}`
            : mode === 'explain'
              ? `Explain the current script (${scriptName})`
              : mode === 'improve'
                ? `Improve the current script (${scriptName})`
                : p;
        get().pushChat({ role: 'user', text: userText });
        set({ aiBusy: true });
        try {
          const res = await fetch('/api/scriptlab/ai', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode,
              prompt: p,
              code: useCurrentCode || ['explain', 'improve', 'fix'].includes(mode) ? scriptCode : undefined,
              symbol,
              tf,
              bars: bars?.length ?? 0,
              error: mode === 'fix' && err ? { line: err.line, message: err.message } : undefined,
            }),
          });
          const j = (await res.json()) as { ok?: boolean; reply?: string; code?: string; error?: { message?: string } };
          if (!j.ok) throw new Error(j.error?.message ?? 'AI request failed');
          get().pushChat({ role: 'assistant', text: j.reply ?? '', code: j.code });
        } catch (e) {
          get().pushChat({ role: 'assistant', text: e instanceof Error ? e.message : 'AI request failed' });
        } finally {
          set({ aiBusy: false });
        }
      },

      fetchUserScripts: async () => {
        try {
          const res = await fetch('/api/scriptlab/scripts');
          const json = (await res.json()) as { ok?: boolean; data?: UserScript[] };
          if (json.ok && json.data) set({ userScripts: json.data });
        } catch {
          /* offline-tolerant */
        }
      },

      saveScript: async () => {
        const { scriptName, scriptCode, scriptCategory, scriptDescription, result } = get();
        if (!scriptName.trim()) return 'Script needs a name';
        try {
          const res = await fetch('/api/scriptlab/scripts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: scriptName.trim(),
              code: scriptCode,
              category: scriptCategory,
              description: scriptDescription,
              kind: result?.kind ?? 'indicator',
            }),
          });
          const json = (await res.json()) as { ok?: boolean; error?: { message?: string } };
          if (!json.ok) return json.error?.message ?? 'save failed';
          set({ scriptDirty: false });
          await get().fetchUserScripts();
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : 'save failed';
        }
      },

      deleteUserScript: async (id) => {
        try {
          await fetch(`/api/scriptlab/scripts/${id}`, { method: 'DELETE' });
          await get().fetchUserScripts();
        } catch {
          /* ignore */
        }
      },
    }),
    {
      name: 'volos-scriptlab',
      storage: createJSONStorage(() => localStorage),
      skipHydration: true, // rehydrate from an effect — keeps SSR/hydration safe
      version: 2,
      migrate: (persisted) => {
        // v1 kept a floating-window layout — retired in favor of the unified
        // chart + below-panel studio; drop the stale window geometry.
        const s = persisted as Record<string, unknown>;
        const { windows: _w, zTop: _z, ...rest } = s;
        return rest as unknown as ScriptLabState;
      },
      partialize: (s) => ({
        symbol: s.symbol,
        tf: s.tf,
        limit: s.limit,
        scriptName: s.scriptName,
        scriptCode: s.scriptCode,
        scriptCategory: s.scriptCategory,
        scriptDescription: s.scriptDescription,
        inputs: s.inputs,
        bottomTab: s.bottomTab,
        aiOpen: s.aiOpen,
        chartSplitPct: s.chartSplitPct,
        bottomCollapsed: s.bottomCollapsed,
        chat: s.chat.slice(-30),
      }),
    },
  ),
);

export { SPLIT_MIN, SPLIT_MAX };
export const CATEGORY_KEYS = SCRIPT_CATEGORIES.map((c) => c.key);

/** Call once from a top-level client effect to restore persisted studio state. */
export function rehydrateScriptLab(): void {
  void useScriptLab.persist.rehydrate();
}

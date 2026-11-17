'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab store — the whole VolScript studio state: bars dataset, editor
// draft, run result, floating-window layout, AI chat, user scripts. Layout +
// draft + inputs persist to localStorage like the rest of the terminal.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { runScript } from '@/lib/scriptlang/internal';
import { defaultScript, SCRIPT_CATEGORIES } from '@/lib/scriptlang/library';
import type { RunResult, ScriptBar } from '@/lib/scriptlang/types';

export type PanelId = 'library' | 'editor' | 'chart' | 'backtest' | 'ai' | 'data';

export interface WindowLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  closed: boolean;
  maximized: boolean;
  prev?: { x: number; y: number; w: number; h: number };
}

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

const PANEL_MIN = { w: 300, h: 240 };

function defaultWindows(w: number, h: number): Record<PanelId, WindowLayout> {
  // a professional starting layout: chart big center, editor right, library
  // left, backtest + AI bottom, data small. Everything draggable/resizable.
  const colL = Math.max(280, Math.round(w * 0.2));
  const colR = Math.max(320, Math.round(w * 0.26));
  const bottomH = Math.max(260, Math.round(h * 0.34));
  const topH = h - bottomH - 8;
  return {
    library: { x: 0, y: 0, w: colL, h: topH, z: 1, minimized: false, closed: false, maximized: false },
    chart: { x: colL + 8, y: 0, w: w - colL - colR - 24, h: topH, z: 2, minimized: false, closed: false, maximized: false },
    editor: { x: w - colR - 8, y: 0, w: colR, h: topH, z: 3, minimized: false, closed: false, maximized: false },
    backtest: { x: colL + 8, y: topH + 8, w: Math.max(300, Math.round((w - colL - colR - 24) * 0.6)), h: bottomH, z: 4, minimized: false, closed: false, maximized: false },
    ai: { x: colL + 8 + Math.max(300, Math.round((w - colL - colR - 24) * 0.6)) + 8, y: topH + 8, w: w - colL - Math.round((w - colL - colR - 24) * 0.6) - colR - 32, h: bottomH, z: 5, minimized: false, closed: false, maximized: false },
    data: { x: 0, y: topH + 8, w: colL, h: bottomH, z: 6, minimized: false, closed: false, maximized: false },
  };
}

export type TfKey2 = '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
export const SCRIPTLAB_TFS: TfKey2[] = ['5m', '15m', '30m', '1h', '4h', '1d'];
export const SCRIPTLAB_SYMBOLS = ['BTC', 'ETH', 'SOL'] as const;

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

  // windows
  windows: Record<PanelId, WindowLayout> | null;
  zTop: number;

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

  focusPanel: (id: PanelId) => void;
  openPanel: (id: PanelId) => void;
  closePanel: (id: PanelId) => void;
  minimizePanel: (id: PanelId) => void;
  restorePanel: (id: PanelId) => void;
  toggleMaximize: (id: PanelId) => void;
  movePanel: (id: PanelId, x: number, y: number) => void;
  resizePanel: (id: PanelId, rect: { x?: number; y?: number; w?: number; h?: number }) => void;
  tilePanels: (w: number, h: number) => void;
  resetLayout: (w: number, h: number) => void;
  ensureWindows: (w: number, h: number) => void;

  pushChat: (m: Omit<ChatMessage, 'id' | 'ts'>) => void;
  setAiBusy: (b: boolean) => void;

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

      windows: null,
      zTop: 10,

      chat: [],
      aiBusy: false,

      userScripts: [],

      setDataset: (patch) => set(patch),

      refreshBars: async () => {
        const { symbol, tf, limit } = get();
        set({ barsLoading: true, barsError: null });
        try {
          const res = await fetch(`/api/scriptlab/bars?symbol=${symbol}&tf=${tf}&limit=${limit}`);
          const json = (await res.json()) as {
            success?: boolean;
            data?: { bars: ScriptBar[]; source: string; asOf: number };
            error?: { message?: string };
          };
          if (!json.success || !json.data) throw new Error(json.error?.message ?? 'bars request failed');
          set({
            bars: json.data.bars,
            barsSource: json.data.source,
            barsAsOf: json.data.asOf,
            barsLoading: false,
          });
          get().rerun();
        } catch (e) {
          set({ barsLoading: false, barsError: e instanceof Error ? e.message : String(e) });
        }
      },

      rerun: (opts) => {
        const { bars, scriptCode, inputs } = get();
        if (!bars || bars.length === 0) return;
        const code = opts?.code ?? scriptCode;
        const mergedInputs = { ...inputs, ...(opts?.inputs ?? {}) };
        set({ running: true });
        const result = runScript(code, bars, { inputs: mergedInputs });
        set({ result, running: false, inputs: mergedInputs });
        if (result.ok && result.kind === 'strategy') {
          // append-only track record — fire and forget, never blocks the UI
          const { symbol, tf } = get();
          void fetch('/api/scriptlab/runs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              scriptName: get().scriptName,
              symbol,
              tf,
              bars: bars.length,
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
        });
      },

      focusPanel: (id) => {
        const windows = get().windows;
        if (!windows || windows[id]?.z === get().zTop) return;
        set({ zTop: get().zTop + 1, windows: { ...windows, [id]: { ...windows[id], z: get().zTop + 1 } } });
      },
      openPanel: (id) => {
        const windows = get().windows;
        if (!windows) return;
        const z = get().zTop + 1;
        set({ zTop: z, windows: { ...windows, [id]: { ...windows[id], closed: false, minimized: false, z } } });
      },
      closePanel: (id) => {
        const windows = get().windows;
        if (!windows) return;
        set({ windows: { ...windows, [id]: { ...windows[id], closed: true, minimized: false, maximized: false } } });
      },
      minimizePanel: (id) => {
        const windows = get().windows;
        if (!windows) return;
        set({ windows: { ...windows, [id]: { ...windows[id], minimized: true, maximized: false } } });
      },
      restorePanel: (id) => {
        const windows = get().windows;
        if (!windows) return;
        const z = get().zTop + 1;
        set({ zTop: z, windows: { ...windows, [id]: { ...windows[id], minimized: false, z } } });
      },
      toggleMaximize: (id) => {
        const windows = get().windows;
        if (!windows) return;
        const cur = windows[id];
        if (cur.maximized && cur.prev) {
          set({ windows: { ...windows, [id]: { ...cur, maximized: false, ...cur.prev } } });
        } else {
          const z = get().zTop + 1;
          set({
            zTop: z,
            windows: {
              ...windows,
              [id]: { ...cur, maximized: true, prev: { x: cur.x, y: cur.y, w: cur.w, h: cur.h }, z },
            },
          });
        }
      },
      movePanel: (id, x, y) => {
        const windows = get().windows;
        if (!windows) return;
        set({ windows: { ...windows, [id]: { ...windows[id], x, y } } });
      },
      resizePanel: (id, rect) => {
        const windows = get().windows;
        if (!windows) return;
        const cur = windows[id];
        const w = rect.w ?? cur.w;
        const h = rect.h ?? cur.h;
        set({
          windows: {
            ...windows,
            [id]: {
              ...cur,
              x: rect.x ?? cur.x,
              y: rect.y ?? cur.y,
              w: Math.max(PANEL_MIN.w, w),
              h: Math.max(PANEL_MIN.h, h),
            },
          },
        });
      },
      tilePanels: (w, h) => {
        // 3 columns × 2 rows grid of the open panels
        const windows = get().windows;
        if (!windows) return;
        const ids = (Object.keys(windows) as PanelId[]).filter((id) => !windows[id].closed && !windows[id].minimized);
        if (!ids.length) return;
        const cols = ids.length <= 2 ? 1 : ids.length <= 4 ? 2 : 3;
        const rows = Math.ceil(ids.length / cols);
        const cw = Math.floor(w / cols);
        const ch = Math.floor(h / rows);
        const next = { ...windows };
        ids.forEach((id, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          next[id] = {
            ...next[id],
            x: col * cw,
            y: row * ch,
            w: cw - 4,
            h: ch - 4,
            maximized: false,
            prev: undefined,
            z: 10 + i,
          };
        });
        set({ windows: next, zTop: 10 + ids.length });
      },
      resetLayout: (w, h) => set({ windows: defaultWindows(w, h), zTop: 10 }),
      ensureWindows: (w, h) => {
        if (!get().windows) set({ windows: defaultWindows(w, h), zTop: 10 });
      },

      pushChat: (m) => {
        const chat = [...get().chat, { ...m, id: `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`, ts: Date.now() }];
        set({ chat: chat.slice(-60) });
      },
      setAiBusy: (b) => set({ aiBusy: b }),

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
      version: 1,
      partialize: (s) => ({
        symbol: s.symbol,
        tf: s.tf,
        limit: s.limit,
        scriptName: s.scriptName,
        scriptCode: s.scriptCode,
        scriptCategory: s.scriptCategory,
        scriptDescription: s.scriptDescription,
        inputs: s.inputs,
        windows: s.windows,
        zTop: s.zTop,
        chat: s.chat.slice(-30),
      }),
    },
  ),
);

export { PANEL_MIN, defaultWindows };
export const CATEGORY_KEYS = SCRIPT_CATEGORIES.map((c) => c.key);

/** Call once from a top-level client effect to restore persisted studio state. */
export function rehydrateScriptLab(): void {
  void useScriptLab.persist.rehydrate();
}

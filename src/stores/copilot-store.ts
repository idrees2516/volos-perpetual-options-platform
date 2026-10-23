'use client';

// AI Copilot panel state: open/closed, active tab, deep-research run state.

import { create } from 'zustand';

export type CopilotTab = 'chat' | 'research';

export interface AgentStageState {
  agent: string;
  name: string;
  title: string;
  status: 'running' | 'done' | 'error';
  error?: string;
  report?: string;
  toolTrace?: Array<{ toolName: string; args: unknown }>;
}

export interface ResearchRun {
  asset: string;
  spot: number;
  focus: string;
  horizonDays: number;
  riskAppetite: string;
  stages: Record<string, AgentStageState>;
  order: string[];
  strategies: Array<{
    strategyId: string;
    name: string;
    category: string;
    view: string;
    complexity: number;
    description: string;
    legCount: number;
    resolvedLegs: Array<{
      kind: string;
      side: string;
      qty: number;
      strike?: number;
      expiryDays?: number;
      fundingPeriodDays?: number;
    }>;
  }>;
  dossier: string;
  done: boolean;
  error?: string;
}

interface CopilotState {
  open: boolean;
  tab: CopilotTab;
  /** Deep research runs keyed by run id. */
  runs: Record<string, ResearchRun>;
  activeRunId: string | null;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setTab: (tab: CopilotTab) => void;
  startRun: (params: { asset: string; focus?: string; horizonDays?: number; riskAppetite?: string }) => string;
  patchRun: (id: string, patch: Partial<ResearchRun>) => void;
  upsertStage: (id: string, stage: AgentStageState) => void;
  appendDossier: (id: string, text: string) => void;
}

export const useCopilot = create<CopilotState>((set, get) => ({
  open: false,
  tab: 'chat',
  runs: {},
  activeRunId: null,
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
  setTab: (tab) => set({ tab }),
  startRun: (params) => {
    const id = `run-${Date.now().toString(36)}`;
    const run: ResearchRun = {
      asset: params.asset,
      spot: 0,
      focus: params.focus ?? '',
      horizonDays: params.horizonDays ?? 30,
      riskAppetite: params.riskAppetite ?? 'balanced',
      stages: {},
      order: [],
      strategies: [],
      dossier: '',
      done: false,
    };
    set((s) => ({ runs: { ...s.runs, [id]: run }, activeRunId: id, tab: 'research', open: true }));
    return id;
  },
  patchRun: (id, patch) =>
    set((s) => (s.runs[id] ? { runs: { ...s.runs, [id]: { ...s.runs[id], ...patch } } } : {})),
  upsertStage: (id, stage) =>
    set((s) => {
      const run = s.runs[id];
      if (!run) return {};
      const isNew = !(stage.agent in run.stages);
      return {
        runs: {
          ...s.runs,
          [id]: {
            ...run,
            stages: { ...run.stages, [stage.agent]: stage },
            order: isNew ? [...run.order, stage.agent] : run.order,
          },
        },
      };
    }),
  appendDossier: (id, text) => {
    const run = get().runs[id];
    if (run) {
      set((s) => ({ runs: { ...s.runs, [id]: { ...s.runs[id], dossier: s.runs[id].dossier + text } } }));
    }
  },
}));

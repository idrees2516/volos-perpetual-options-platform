// Morning brief unit tests — deterministic section builders + the ensure-window
// logic, with mocked intelligence engine, autopilot journal, AI model and fs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(() => {
      throw new Error('ENOENT (test)');
    }),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

let report: Record<string, unknown>;
vi.mock('@/lib/positions/intelligence', () => ({
  buildPositionIntelligence: vi.fn(async () => report as never),
}));

const autopilotState = {
  settings: {
    enabled: true,
    dryRun: true,
    intervalSec: 60,
    minConfidence: 70,
    maxActionsPerCycle: 2,
    cooldownMin: 30,
    execute: { takeProfit: true, exit: true, roll: false, adjust: false, scaleIn: false },
    adjustTrimFraction: 0.25,
    scaleInFraction: 0.5,
    briefHour: 8,
    briefTz: 'Asia/Karachi',
  },
  journal: [] as unknown[],
};
vi.mock('@/lib/positions/autopilot', () => ({
  getAutopilotSettings: () => autopilotState.settings,
  getJournal: (limit: number, since?: number) =>
    (autopilotState.journal as { ts: number }[]).filter((e) => since === undefined || e.ts >= since).slice(-limit),
  journalCount: (since?: number) =>
    (autopilotState.journal as { ts: number }[]).filter((e) => since === undefined || e.ts >= since).length,
}));

const ai = { generateText: vi.fn() };
vi.mock('ai', () => ({ generateText: (...args: unknown[]) => ai.generateText(...args) }));
vi.mock('@/lib/ai/model-router', () => ({ getDeskModel: () => ({}) }));

import { buildMorningBrief, ensureMorningBrief, localDateStr } from './morning-brief';

// --- fixtures -------------------------------------------------------------------------

function mkReport() {
  return {
    tsMs: Date.now(),
    source: 'test',
    market: [
      {
        asset: 'BTC',
        spot: 101_000,
        change24hPct: 2.4,
        atmIv30dPct: 45,
        fundingRate: 0.0001,
        fundingAnnualizedPct: 3.6,
        openInterestUsd: 1e9,
        technicals: { biasScore: 40, biasLabel: 'bullish', rsi14: 58, atr14: 1200, atrPct: 1.2, emaAlignment: 'up', adx14: 25, priceVsVwapPct: 0.8, signals: [] },
        volRegime: { ivRank: 62, verdict: 'mid', iv30Pct: 45, rv30Pct: 40 },
        decision: { regimeScore: 30, regimeLabel: 'risk-on', volBias: 'neutral', topSignals: [{ title: 'trend', state: 'up', strength: 70 }] },
      },
    ],
    positions: [
      {
        positionId: 'p1',
        instrument: 'BTC 27DEC26 100000 C',
        side: 'long',
        qty: 1,
        dte: 12,
        pnl: { unrealized: 300, pct: 48, deltaPnl: 200, vegaPnl: 60, thetaPnl: -20, residualPnl: 0 },
        decision: { action: 'TAKE_PROFIT', confidence: 88, healthScore: 80, reasons: ['tp band'], suggestedAction: 'close' },
        current: { mark: 0.09, spot: 101_000, ivPct: 45, greeks: null, probItmPct: 55, quoteSource: 'live' },
        market: { alignmentScore: 20, alignmentLabel: 'supportive', ivMovePts: 1, fundingTailwind: true },
        settings: { takeProfitPct: 60, stopLossPct: 35, minDte: 7, probItmFloorPct: 20, probItmCeilPct: 70, alignmentBreakScore: 45 },
        triggers: [{ code: 'TAKE_PROFIT', level: 'critical', message: 'x' }],
      },
      {
        positionId: 'p2',
        instrument: 'ETH 27DEC26 4000 P',
        side: 'short',
        qty: 2,
        dte: 8,
        pnl: { unrealized: -80, pct: -18, deltaPnl: -50, vegaPnl: -20, thetaPnl: 20, residualPnl: 0 },
        decision: { action: 'HOLD', confidence: 90, healthScore: 70, reasons: ['stable'], suggestedAction: 'hold' },
        current: { mark: 0.02, spot: 3900, ivPct: 50, greeks: null, probItmPct: 30, quoteSource: 'live' },
        market: { alignmentScore: -5, alignmentLabel: 'mixed', ivMovePts: 2, fundingTailwind: false },
        settings: { takeProfitPct: 60, stopLossPct: 35, minDte: 7, probItmFloorPct: 20, probItmCeilPct: 65, alignmentBreakScore: 45 },
        triggers: [],
      },
    ],
    portfolio: {
      equity: 100_300,
      unrealized: 220,
      marginHeld: 500,
      buyingPower: 99_800,
      marginUtilizationPct: 0.5,
      netGreeks: { total: { delta: 0.3, deltaUsd: 30_000, gamma: 0.01, vega: 120, theta: -8 }, byAsset: {} },
      stress: { down1AtrPnl: -400, up1AtrPnl: 600 },
      alerts: { critical: 1, warn: 0, info: 0 },
      decisionCounts: { TAKE_PROFIT: 1, HOLD: 1 },
    },
    notes: [],
  };
}

// --- tests ----------------------------------------------------------------------------

describe('localDateStr', () => {
  it('renders the Karachi calendar date for a UTC instant', () => {
    // 2026-11-14 22:30 UTC is 2026-11-15 03:30 in Karachi (UTC+5)
    expect(localDateStr(new Date('2026-11-14T22:30:00Z'), 'Asia/Karachi')).toBe('2026-11-15');
  });
  it('falls back to UTC on an invalid timezone', () => {
    expect(localDateStr(new Date('2026-11-14T10:00:00Z'), 'Not/AZone!')).toBe('2026-11-14');
  });
});

describe('buildMorningBrief', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    report = mkReport();
    autopilotState.journal = [
      { ts: Date.now() - 3600_000, result: 'closed', positionId: 'p0', action: 'EXIT', mode: 'live' },
      { ts: Date.now() - 1800_000, result: 'planned', positionId: 'p1', action: 'TAKE_PROFIT', mode: 'dry-run' },
    ] as never;
    ai.generateText.mockReset();
  });

  it('builds the deterministic sections from the fusion report', async () => {
    ai.generateText.mockRejectedValue(new Error('no model'));
    const b = await buildMorningBrief({ includeAi: false });
    expect(b.market[0]).toMatchObject({ asset: 'BTC', change24hPct: 2.4, biasLabel: 'bullish', regimeLabel: 'risk-on', ivRank: 62 });
    expect(b.portfolio).toMatchObject({ equity: 100_300, netVega: 120, openPositions: 2 });
    expect(b.positions).toHaveLength(2);
    expect(b.decisionCensus).toEqual({ TAKE_PROFIT: 1, HOLD: 1 });
    expect(b.autopilot.closed).toBe(1);
    expect(b.autopilot.planned).toBe(1);
    expect(b.aiNarrative).toBeNull();
  });

  it('flags near-threshold positions on the watchlist', async () => {
    ai.generateText.mockRejectedValue(new Error('no model'));
    const b = await buildMorningBrief({ includeAi: false });
    // p1: P&L 48% vs TP 60% → within 70% of target; dte 12 vs floor 7 → near
    const p1 = b.watchlist.find((w) => w.positionId === 'p1');
    expect(p1).toBeTruthy();
    expect(p1?.note).toContain('TP 60%');
    // p2: calm short, no triggers, dte 8 vs floor 7 → 8 ≤ 7*2+2 → included for DTE
    expect(b.watchlist.some((w) => w.positionId === 'p2')).toBe(true);
  });

  it('attaches the AI narrative when the desk model answers', async () => {
    ai.generateText.mockResolvedValue({ text: '- tape up\n- vega heavy\n' });
    const b = await buildMorningBrief();
    expect(b.aiNarrative).toBe('- tape up\n- vega heavy');
    expect(b.aiModel).toBe('desk-router');
  });

  it('is resilient to a narrative timeout (Promise.race → null)', async () => {
    vi.useFakeTimers();
    try {
      ai.generateText.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ text: 'late' }), 31_000)),
      );
      const p = buildMorningBrief();
      await vi.advanceTimersByTimeAsync(31_000);
      const b = await p;
      expect(b.aiNarrative).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ensureMorningBrief', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    report = mkReport();
    ai.generateText.mockRejectedValue(new Error('no model'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates exactly once per day, only after the configured hour', async () => {
    vi.useFakeTimers();
    // 2026-12-25 02:30 UTC == 07:30 Karachi — BEFORE the 08:00 briefHour
    vi.setSystemTime(new Date('2026-12-25T02:30:00Z'));
    const before = await ensureMorningBrief();
    expect(before.generated).toBe(false);
    expect(before.reason).toContain('before briefHour');

    // 08:00 Karachi — the hour has come
    vi.setSystemTime(new Date('2026-12-25T03:00:00Z'));
    const first = await ensureMorningBrief();
    expect(first.generated).toBe(true);
    expect(first.date).toBe('2026-12-25');

    // a minute later — already exists, no regeneration
    vi.setSystemTime(new Date('2026-12-25T03:01:00Z'));
    const second = await ensureMorningBrief();
    expect(second.generated).toBe(false);
    expect(second.reason).toBe('already exists');
  });
});

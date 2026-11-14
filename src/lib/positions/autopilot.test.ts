// Autopilot unit tests — the auto-rebalance loop's pure decision gating,
// guarded by mocks for the paper engine, the intelligence fusion engine and
// the filesystem (settings/journal stay in-memory).

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- module mocks (hoisted) -----------------------------------------------------------

const paper = vi.hoisted(() => ({
  closePaperPosition: vi.fn(),
  placePaperOrder: vi.fn(),
  deployPaperStrategy: vi.fn(),
}));
vi.mock('@/lib/ai/paper', () => paper);

let report: { positions: unknown[]; portfolio: unknown; market: unknown[]; tsMs: number; source: string; notes: string[] };
vi.mock('@/lib/positions/intelligence', () => ({
  buildPositionIntelligence: vi.fn(async () => report),
}));

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

import {
  AUTOPILOT_DEFAULTS,
  getAutopilotSettings,
  resetAutopilotSettings,
  resetJournal,
  runAutopilotCycle,
  sanitizeAutopilotPatch,
  updateAutopilotSettings,
} from './autopilot';

// --- fixtures -------------------------------------------------------------------------

let idc = 0;
function mkPos(over: Record<string, unknown> = {}) {
  idc += 1;
  const id = `pos-${idc}`;
  return {
    positionId: id,
    instrument: `BTC 27DEC26 100000 C #${id}`,
    venue: 'deribit',
    asset: 'BTC',
    kind: 'call',
    side: 'long',
    qty: 1,
    strike: 100_000,
    expiry: '27DEC26',
    expiryMs: Date.now() + 30 * 86_400_000,
    dte: 30,
    daysHeld: 2,
    strategyTag: null,
    entry: { price: 0.05, spot: 100_000, ivPct: 45, greeks: null },
    current: { mark: 0.06, spot: 101_000, ivPct: 46, greeks: null, probItmPct: 55, quoteSource: 'live' },
    pnl: { unrealized: 120, pct: 30, deltaPnl: 80, vegaPnl: 20, thetaPnl: -10, residualPnl: 0 },
    risk: { thetaBleedPctPerDay: 1, breakeven: 101_000, distanceToBreakevenAtr: 1, distanceToStrikeAtr: 1, probTouchBreakevenPct: 40, moneynessPct: 1, marginHeld: 500, notionalUsd: 1000 },
    market: { alignmentScore: 10, alignmentLabel: 'supportive', ivMovePts: 1, fundingTailwind: true },
    settings: { ...AUTOPILOT_DEFAULTS.execute }, // shape only — real settings come from the store
    settingsSource: 'global',
    triggers: [{ code: 'TAKE_PROFIT', level: 'critical', message: 'tp hit' }],
    decision: {
      action: 'TAKE_PROFIT',
      confidence: 85,
      healthScore: 82,
      reasons: ['take-profit band hit'],
      suggestedAction: 'Close the winner',
    },
    ...over,
  };
}

function mkReport(positions: unknown[]) {
  return {
    tsMs: Date.now(),
    source: 'test',
    market: [],
    positions,
    portfolio: {
      equity: 100_000,
      unrealized: 120,
      marginHeld: 500,
      buyingPower: 99_500,
      marginUtilizationPct: 0.5,
      netGreeks: { total: { delta: 0.2, deltaUsd: 20_000, gamma: 0, vega: 50, theta: -5 }, byAsset: {} },
      stress: { down1AtrPnl: -100, up1AtrPnl: +100 },
      alerts: { critical: 1, warn: 0, info: 0 },
      decisionCounts: { TAKE_PROFIT: positions.length },
    },
    notes: [],
  };
}

// --- tests ----------------------------------------------------------------------------

describe('sanitizeAutopilotPatch', () => {
  it('parses booleans in every accepted shape', () => {
    expect(sanitizeAutopilotPatch({ enabled: 'true', dryRun: 0 })).toEqual({ enabled: true, dryRun: false });
  });
  it('clamps numeric ranges', () => {
    expect(sanitizeAutopilotPatch({ intervalSec: 5, minConfidence: 140, maxActionsPerCycle: 0, cooldownMin: -10, briefHour: 30 })).toEqual({
      intervalSec: 30,
      minConfidence: 100,
      maxActionsPerCycle: 1,
      cooldownMin: 0,
      briefHour: 23,
    });
  });
  it('accepts execute toggles', () => {
    expect(sanitizeAutopilotPatch({ execute: { roll: true, adjust: 'false' } })).toEqual({
      execute: { roll: true, adjust: false },
    });
  });
  it('validates the IANA timezone and drops junk', () => {
    expect(sanitizeAutopilotPatch({ briefTz: 'Asia/Karachi' }).briefTz).toBe('Asia/Karachi');
    expect(sanitizeAutopilotPatch({ briefTz: 'Not/AZone!' })).toEqual({});
  });
  it('rejects unknown fields', () => {
    expect(sanitizeAutopilotPatch({ bogus: 1 })).toEqual({});
  });
});

describe('runAutopilotCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJournal();
    resetAutopilotSettings();
    paper.closePaperPosition.mockReset();
    paper.placePaperOrder.mockReset();
    paper.deployPaperStrategy.mockReset();
    report = mkReport([]);
  });

  it('loop cycles are a no-op while the master switch is off', async () => {
    const res = await runAutopilotCycle('loop');
    expect(res.mode).toBe('disabled');
    expect(res.error).toBe('autopilot disabled');
    expect(paper.closePaperPosition).not.toHaveBeenCalled();
  });

  it('dry-run: journals the planned action without touching the account', async () => {
    updateAutopilotSettings({ enabled: true, dryRun: true });
    report = mkReport([mkPos()]);
    const res = await runAutopilotCycle('manual');
    expect(res.mode).toBe('dry-run');
    expect(res.acted).toBe(1);
    expect(res.executed).toBe(0);
    expect(paper.closePaperPosition).not.toHaveBeenCalled();
    const entry = res.entries.find((e) => e.positionId === 'pos-1');
    expect(entry?.result).toBe('planned');
    expect(entry?.executed).toBe(false);
    expect(entry?.triggerCodes).toContain('TAKE_PROFIT');
  });

  it('live: closes the position and journals the fill with realized P&L', async () => {
    updateAutopilotSettings({ enabled: true, dryRun: false });
    report = mkReport([mkPos()]);
    paper.closePaperPosition.mockResolvedValue({
      ok: true,
      fill: { id: 'f1', ts: Date.now(), venue: 'deribit', asset: 'BTC', expiry: '27DEC26', strike: 100000, kind: 'call', side: 'sell', qty: 1, price: 0.08, fee: 3, spotAtFill: 101_000 },
    });
    const res = await runAutopilotCycle('manual');
    expect(paper.closePaperPosition).toHaveBeenCalledWith('pos-2');
    expect(res.executed).toBe(1);
    const entry = res.entries.find((e) => e.positionId === 'pos-2');
    expect(entry?.result).toBe('closed');
    expect(entry?.executed).toBe(true);
    // long: (0.08 - 0.05) * 1 * 100000-size… fixture uses entry.price 0.05 → (0.08−0.05)*1 − fee
    expect(entry?.fill?.realizedPnl).toBeCloseTo(0.08 - 0.05 - 3, 4);
  });

  it('skips decisions under the confidence gate', async () => {
    updateAutopilotSettings({ enabled: true, minConfidence: 90 });
    report = mkReport([mkPos({ decision: { action: 'EXIT', confidence: 60, healthScore: 40, reasons: ['fading'], suggestedAction: 'cut' } })]);
    const res = await runAutopilotCycle('manual');
    expect(res.acted).toBe(0);
    expect(res.entries[0].result).toBe('skipped');
    expect(res.entries[0].detail).toContain('confidence 60 < gate 90');
  });

  it('skips actions disabled in the execute toggles', async () => {
    updateAutopilotSettings({ enabled: true, execute: { takeProfit: false } as never });
    report = mkReport([mkPos()]);
    const res = await runAutopilotCycle('manual');
    expect(res.entries[0].result).toBe('skipped');
    expect(res.entries[0].detail).toContain('disabled in execute toggles');
  });

  it('respects the per-position cooldown on back-to-back cycles', async () => {
    updateAutopilotSettings({ enabled: true, dryRun: true, cooldownMin: 30 });
    report = mkReport([mkPos()]);
    await runAutopilotCycle('manual');
    const res2 = await runAutopilotCycle('manual');
    expect(res2.acted).toBe(0);
    expect(res2.entries.length).toBe(0);
  });

  it('caps planned actions per cycle at maxActionsPerCycle', async () => {
    updateAutopilotSettings({ enabled: true, dryRun: true, maxActionsPerCycle: 1 });
    report = mkReport([mkPos(), mkPos()]);
    const res = await runAutopilotCycle('manual');
    expect(res.acted).toBe(1);
    expect(res.entries.filter((e) => e.result === 'planned').length).toBe(1);
  });

  it('SCALE_IN adds the configured fraction via placePaperOrder', async () => {
    updateAutopilotSettings({ enabled: true, dryRun: false, execute: { takeProfit: false, exit: false, scaleIn: true } as never, scaleInFraction: 0.5 });
    const p = mkPos({ qty: 2, decision: { action: 'SCALE_IN', confidence: 90, healthScore: 90, reasons: ['alignment'], suggestedAction: 'add' } });
    report = mkReport([p]);
    paper.placePaperOrder.mockResolvedValue({ ok: true, fill: { qty: 1, price: 0.06, fee: 1 } });
    const res = await runAutopilotCycle('manual');
    expect(paper.placePaperOrder).toHaveBeenCalledWith(expect.objectContaining({ qty: 1, side: 'buy', asset: 'BTC' }));
    expect(res.entries[0].result).toBe('scaled');
  });

  it('journalizes a failed close as failed, never crashes the cycle', async () => {
    updateAutopilotSettings({ enabled: true, dryRun: false });
    report = mkReport([mkPos()]);
    paper.closePaperPosition.mockResolvedValue({ ok: false, error: 'no quote to close' });
    const res = await runAutopilotCycle('manual');
    expect(res.error).toBeNull();
    expect(res.entries[0].result).toBe('failed');
    expect(res.entries[0].executed).toBe(false);
  });
});

describe('settings store', () => {
  it('updateAutopilotSettings merges and exposes the effective settings', () => {
    resetAutopilotSettings();
    const s = updateAutopilotSettings({ enabled: true, minConfidence: 80 });
    expect(getAutopilotSettings().enabled).toBe(true);
    expect(getAutopilotSettings().minConfidence).toBe(80);
    expect(getAutopilotSettings().execute.takeProfit).toBe(true); // untouched defaults survive
    expect(s.intervalSec).toBe(AUTOPILOT_DEFAULTS.intervalSec);
  });
});

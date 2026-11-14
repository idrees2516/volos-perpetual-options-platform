import { describe, expect, it } from 'vitest';
import {
  SETTINGS_PRESETS,
  evaluateTriggers,
  presetFor,
  sanitizeSettingsPatch,
} from './settings';

describe('sanitizeSettingsPatch', () => {
  it('accepts valid numeric fields and nulls (disable)', () => {
    const patch = sanitizeSettingsPatch({
      takeProfitPct: '30',
      stopLossPct: 12.5,
      minDte: null,
    });
    expect(patch).toEqual({ takeProfitPct: 30, stopLossPct: 12.5, minDte: null });
  });

  it('rejects unknown and invalid fields', () => {
    const patch = sanitizeSettingsPatch({ bogus: 1, profile: 'nonsense', ivMoveAlertPts: -5, alignmentBreakScore: 'abc' });
    expect(patch).toEqual({});
  });

  it('accepts a valid profile name', () => {
    expect(sanitizeSettingsPatch({ profile: 'scalper' })).toEqual({ profile: 'scalper' });
  });
});

describe('presetFor', () => {
  it('returns full preset for known profiles', () => {
    expect(presetFor('harvester')).toEqual(SETTINGS_PRESETS.harvester);
  });
  it('custom falls back to swing values with custom tag', () => {
    const c = presetFor('custom');
    expect(c.profile).toBe('custom');
    expect(c.takeProfitPct).toBe(SETTINGS_PRESETS.swing.takeProfitPct);
  });
});

describe('evaluateTriggers', () => {
  const base = {
    pnlPct: 5,
    dte: 20,
    daysHeld: 3,
    probItmPct: 50,
    side: 'long' as const,
    thetaBleedPctPerDay: 1,
    ivMovePts: 1,
    alignmentScore: 10,
  };
  const st = { ...SETTINGS_PRESETS.swing };

  it('no triggers on a calm healthy position', () => {
    expect(evaluateTriggers(base, st)).toEqual([]);
  });

  it('fires TAKE_PROFIT above the target', () => {
    const hits = evaluateTriggers({ ...base, pnlPct: 61 }, st);
    expect(hits.map((h) => h.code)).toContain('TAKE_PROFIT');
    expect(hits.find((h) => h.code === 'TAKE_PROFIT')?.level).toBe('critical');
  });

  it('fires STOP_LOSS below the limit', () => {
    const hits = evaluateTriggers({ ...base, pnlPct: -36 }, st);
    expect(hits.map((h) => h.code)).toContain('STOP_LOSS');
  });

  it('fires DTE_FLOOR, THETA_BLEED, IV_MOVE and ALIGNMENT_BREAK together when stressed', () => {
    const hits = evaluateTriggers(
      { ...base, dte: 6, thetaBleedPctPerDay: 3, ivMovePts: -9, alignmentScore: -50 },
      st,
    );
    expect(hits.map((h) => h.code)).toEqual(
      expect.arrayContaining(['DTE_FLOOR', 'THETA_BLEED', 'IV_MOVE', 'ALIGNMENT_BREAK']),
    );
  });

  it('prob bands are side-aware: floor for longs, ceiling for shorts', () => {
    const long = evaluateTriggers({ ...base, probItmPct: 15 }, st);
    expect(long.map((h) => h.code)).toContain('PROB_FLOOR');
    const short = evaluateTriggers({ ...base, side: 'short', probItmPct: 75 }, st);
    expect(short.map((h) => h.code)).toContain('PROB_CEIL');
  });

  it('null rules never fire', () => {
    const off = { ...st, takeProfitPct: null, stopLossPct: null, minDte: null };
    const hits = evaluateTriggers({ ...base, pnlPct: 500, dte: 0 }, off);
    expect(hits.map((h) => h.code)).not.toContain('TAKE_PROFIT');
    expect(hits.map((h) => h.code)).not.toContain('STOP_LOSS');
    expect(hits.map((h) => h.code)).not.toContain('DTE_FLOOR');
  });

  it('TIME_STOP after the hold limit', () => {
    const hits = evaluateTriggers({ ...base, daysHeld: 15 }, st);
    expect(hits.map((h) => h.code)).toContain('TIME_STOP');
    expect(hits.find((h) => h.code === 'TIME_STOP')?.level).toBe('info');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// positions/settings — the POSITION MANAGEMENT SETTINGS system.
//
// Every paper position can be governed by its own rule-set (or fall back to
// the global default): take-profit / stop-loss bands, theta-bleed tolerance,
// DTE floor, probability-of-ITM bands, IV-move alerts and market-alignment
// break rules. Four presets (scalper / swing / harvester / longshot) give
// one-click profiles; every field is independently overridable ('custom').
//
// Settings are persisted to data/position-settings.json (same write-through
// pattern as the paper account) and are readable + writable from BOTH the UI
// (POST /api/positions/settings) and the AI copilot (update_position_settings
// tool) — the same single source of truth.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

export type PositionProfile = 'scalper' | 'swing' | 'harvester' | 'longshot' | 'custom';

export interface PositionSettings {
  /** Which preset this rule-set derives from (informational once edited). */
  profile: PositionProfile;
  /** Close when unrealized P&L ≥ +X% (null = disabled). */
  takeProfitPct: number | null;
  /** Close when unrealized P&L ≤ −X% (null = disabled). */
  stopLossPct: number | null;
  /** Warn when daily theta bleed exceeds X% of remaining mark (longs) or credit income (shorts). */
  maxThetaBleedPctPerDay: number | null;
  /** Exit / roll when days-to-expiry falls below this. */
  minDte: number | null;
  /** Longs: exit if probability of finishing ITM drops below X%. */
  probItmFloorPct: number | null;
  /** Shorts: exit if probability of finishing ITM rises above X%. */
  probItmCeilPct: number | null;
  /** Alert when |IV move since entry| exceeds X points (vega risk guard). */
  ivMoveAlertPts: number | null;
  /** Alert when market bias/regime turns against the position's delta beyond this score. */
  alignmentBreakScore: number | null;
  /** Hard time stop — exit after N days regardless of P&L (null = disabled). */
  maxHoldDays: number | null;
}

export const SETTINGS_PRESETS: Record<Exclude<PositionProfile, 'custom'>, PositionSettings> = {
  // Fast in-and-out: bank quick wins, cut quick, never bleed theta.
  scalper: {
    profile: 'scalper',
    takeProfitPct: 25,
    stopLossPct: 15,
    maxThetaBleedPctPerDay: 4,
    minDte: 3,
    probItmFloorPct: 25,
    probItmCeilPct: 65,
    ivMoveAlertPts: 6,
    alignmentBreakScore: 35,
    maxHoldDays: 4,
  },
  // Multi-day trend rides: room to breathe, wider exits.
  swing: {
    profile: 'swing',
    takeProfitPct: 60,
    stopLossPct: 35,
    maxThetaBleedPctPerDay: 2.5,
    minDte: 7,
    probItmFloorPct: 20,
    probItmCeilPct: 70,
    ivMoveAlertPts: 8,
    alignmentBreakScore: 45,
    maxHoldDays: 14,
  },
  // Premium-selling profile: protect the credit, respect theta income.
  harvester: {
    profile: 'harvester',
    takeProfitPct: 55,
    stopLossPct: 100,
    maxThetaBleedPctPerDay: 1.5,
    minDte: 5,
    probItmFloorPct: null,
    probItmCeilPct: 60,
    ivMoveAlertPts: 10,
    alignmentBreakScore: 40,
    maxHoldDays: 30,
  },
  // Asymmetric lottery tickets: cut fast, let winners run wide.
  longshot: {
    profile: 'longshot',
    takeProfitPct: 150,
    stopLossPct: 50,
    maxThetaBleedPctPerDay: 6,
    minDte: 2,
    probItmFloorPct: 8,
    probItmCeilPct: 75,
    ivMoveAlertPts: 12,
    alignmentBreakScore: 60,
    maxHoldDays: 21,
  },
};

export function presetFor(profile: PositionProfile): PositionSettings {
  if (profile === 'custom') return { ...SETTINGS_PRESETS.swing, profile: 'custom' };
  return { ...SETTINGS_PRESETS[profile] };
}

const NUM_FIELDS = [
  'takeProfitPct',
  'stopLossPct',
  'maxThetaBleedPctPerDay',
  'minDte',
  'probItmFloorPct',
  'probItmCeilPct',
  'ivMoveAlertPts',
  'alignmentBreakScore',
  'maxHoldDays',
] as const;

/** Sanitize an incoming patch: only known fields, nulls allowed (disables a rule). */
export function sanitizeSettingsPatch(raw: Record<string, unknown>): Partial<PositionSettings> {
  const out: Partial<PositionSettings> = {};
  const profile = String(raw.profile ?? '');
  if (['scalper', 'swing', 'harvester', 'longshot', 'custom'].includes(profile)) {
    out.profile = profile as PositionProfile;
  }
  for (const f of NUM_FIELDS) {
    const v = raw[f];
    if (v === null || v === '' || v === 'null') {
      out[f] = null;
    } else {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 10000) out[f] = n;
    }
  }
  return out;
}

// --- persistence ----------------------------------------------------------------

interface SettingsFile {
  version: 1;
  global: PositionSettings;
  /** Per-position overrides keyed by paper position id. */
  positions: Record<string, PositionSettings>;
  updatedAt: number;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'position-settings.json');

interface SettingsGlobal {
  __positionSettings?: SettingsFile;
  __settingsWrite?: Promise<void>;
}

const g = globalThis as unknown as SettingsGlobal;

function freshSettings(): SettingsFile {
  return {
    version: 1,
    global: { ...SETTINGS_PRESETS.swing },
    positions: {},
    updatedAt: Date.now(),
  };
}

function loadSettings(): SettingsFile {
  if (g.__positionSettings) return g.__positionSettings;
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const s = JSON.parse(raw) as SettingsFile;
    if (s && s.version === 1 && s.global && s.positions) {
      g.__positionSettings = s;
      return s;
    }
  } catch {
    /* first run */
  }
  g.__positionSettings = freshSettings();
  return g.__positionSettings;
}

function saveSettings(): void {
  const s = g.__positionSettings;
  if (!s) return;
  s.updatedAt = Date.now();
  const write = (async () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = SETTINGS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s));
      fs.renameSync(tmp, SETTINGS_FILE);
    } catch {
      /* keep in memory */
    }
  })();
  g.__settingsWrite = (g.__settingsWrite ?? Promise.resolve()).then(() => write).catch(() => {});
}

// --- public API ------------------------------------------------------------------

export interface SettingsView {
  global: PositionSettings;
  presets: Record<string, PositionSettings>;
  positions: Record<string, PositionSettings>;
  updatedAt: number;
}

export function getSettingsView(): SettingsView {
  const s = loadSettings();
  return {
    global: { ...s.global },
    presets: {
      scalper: { ...SETTINGS_PRESETS.scalper },
      swing: { ...SETTINGS_PRESETS.swing },
      harvester: { ...SETTINGS_PRESETS.harvester },
      longshot: { ...SETTINGS_PRESETS.longshot },
    },
    positions: Object.fromEntries(Object.entries(s.positions).map(([k, v]) => [k, { ...v }])),
    updatedAt: s.updatedAt,
  };
}

/** Effective settings for one position: override → global fallback. */
export function resolveSettings(positionId: string): PositionSettings {
  const s = loadSettings();
  return { ...(s.positions[positionId] ?? s.global) };
}

export function updateGlobalSettings(patch: Partial<PositionSettings>): PositionSettings {
  const s = loadSettings();
  s.global = { ...s.global, ...patch };
  saveSettings();
  return { ...s.global };
}

export function updatePositionSettings(
  positionId: string,
  patch: Partial<PositionSettings>,
): PositionSettings {
  const s = loadSettings();
  const base = s.positions[positionId] ?? s.global;
  s.positions[positionId] = { ...base, ...patch };
  saveSettings();
  return { ...s.positions[positionId] };
}

export function clearPositionSettings(positionId: string): boolean {
  const s = loadSettings();
  if (!(positionId in s.positions)) return false;
  delete s.positions[positionId];
  saveSettings();
  return true;
}

export function resetAllSettings(): void {
  g.__positionSettings = freshSettings();
  saveSettings();
}

// --- trigger evaluation ------------------------------------------------------------
//
// Pure function: given computed per-position metrics + the effective settings,
// decide which management rules fire. Consumed by the intelligence engine and
// surfaced to both the UI badge rail and the AI copilot tools.

export type TriggerLevel = 'info' | 'warn' | 'critical';

export interface Trigger {
  code: string;
  level: TriggerLevel;
  message: string;
}

export interface TriggerMetricsInput {
  pnlPct: number;
  dte: number;
  daysHeld: number;
  probItmPct: number;
  side: 'long' | 'short';
  thetaBleedPctPerDay: number | null;
  ivMovePts: number | null;
  /** −100..+100 — signed market score in the direction the position wants. */
  alignmentScore: number | null;
}

export function evaluateTriggers(m: TriggerMetricsInput, st: PositionSettings): Trigger[] {
  const out: Trigger[] = [];
  const long = m.side === 'long';

  if (st.takeProfitPct != null && st.takeProfitPct > 0 && m.pnlPct >= st.takeProfitPct) {
    out.push({
      code: 'TAKE_PROFIT',
      level: 'critical',
      message: `Take-profit hit: P&L +${m.pnlPct.toFixed(1)}% ≥ target +${st.takeProfitPct}% — close, trail, or scale out per plan.`,
    });
  }
  if (st.stopLossPct != null && st.stopLossPct > 0 && m.pnlPct <= -st.stopLossPct) {
    out.push({
      code: 'STOP_LOSS',
      level: 'critical',
      message: `Stop-loss hit: P&L ${m.pnlPct.toFixed(1)}% ≤ limit −${st.stopLossPct}% — cut or hedge now.`,
    });
  }
  if (st.minDte != null && st.minDte > 0 && m.dte <= st.minDte) {
    out.push({
      code: 'DTE_FLOOR',
      level: 'warn',
      message: `Only ${m.dte.toFixed(1)}d left (floor ${st.minDte}d) — roll or exit before gamma/theta accelerates.`,
    });
  }
  if (
    st.maxThetaBleedPctPerDay != null &&
    st.maxThetaBleedPctPerDay > 0 &&
    m.thetaBleedPctPerDay != null &&
    m.thetaBleedPctPerDay > st.maxThetaBleedPctPerDay
  ) {
    out.push({
      code: 'THETA_BLEED',
      level: 'warn',
      message: `Theta bleed ${m.thetaBleedPctPerDay.toFixed(1)}%/day > tolerance ${st.maxThetaBleedPctPerDay}%/day ${
        long ? '— the position is decaying faster than planned' : '(short: income banked, consider locking it in)'
      }.`,
    });
  }
  if (long && st.probItmFloorPct != null && st.probItmFloorPct > 0 && m.probItmPct < st.probItmFloorPct) {
    out.push({
      code: 'PROB_FLOOR',
      level: 'warn',
      message: `Probability ITM fell to ${m.probItmPct.toFixed(1)}% (floor ${st.probItmFloorPct}%) — thesis is fading.`,
    });
  }
  if (!long && st.probItmCeilPct != null && st.probItmCeilPct > 0 && m.probItmPct > st.probItmCeilPct) {
    out.push({
      code: 'PROB_CEIL',
      level: 'warn',
      message: `Short is ${m.probItmPct.toFixed(1)}% likely to finish ITM (ceiling ${st.probItmCeilPct}%) — assignment-style risk building.`,
    });
  }
  if (
    st.ivMoveAlertPts != null &&
    st.ivMoveAlertPts > 0 &&
    m.ivMovePts != null &&
    Math.abs(m.ivMovePts) > st.ivMoveAlertPts
  ) {
    out.push({
      code: 'IV_MOVE',
      level: 'warn',
      message: `IV moved ${m.ivMovePts >= 0 ? '+' : ''}${m.ivMovePts.toFixed(1)} pts since entry (alert ±${st.ivMoveAlertPts}) — vega P&L driver needs attention.`,
    });
  }
  if (
    st.alignmentBreakScore != null &&
    st.alignmentBreakScore > 0 &&
    m.alignmentScore != null &&
    m.alignmentScore < -st.alignmentBreakScore
  ) {
    out.push({
      code: 'ALIGNMENT_BREAK',
      level: 'warn',
      message: `Market score turned against the position (${m.alignmentScore.toFixed(0)}/100 vs break −${st.alignmentBreakScore}) — tape, regime or gamma backdrop flipped.`,
    });
  }
  if (st.maxHoldDays != null && st.maxHoldDays > 0 && m.daysHeld >= st.maxHoldDays) {
    out.push({
      code: 'TIME_STOP',
      level: 'info',
      message: `Held ${m.daysHeld.toFixed(1)}d (time stop ${st.maxHoldDays}d) — decide: renew the thesis or free the capital.`,
    });
  }
  return out;
}

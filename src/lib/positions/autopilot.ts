// ─────────────────────────────────────────────────────────────────────────────
// positions/autopilot — the AUTO-REBALANCE LOOP wired to the decision engine.
//
// Runs the position-intelligence fusion engine on a timer (server-side
// singleton, started from instrumentation.ts) and, for every position whose
// composite decision says ACT (TAKE_PROFIT / EXIT / ROLL / SCALE_IN / ADJUST),
// executes the rebalance against the paper account — with guard rails:
//
//   • master switch (default OFF) + DRY-RUN mode (default ON: journal what
//     WOULD happen, never touch the account)
//   • min-confidence gate (only act on high-conviction decisions)
//   • per-position cooldown, max actions per cycle
//   • per-action enable toggles (take-profit / exit on by default; roll /
//     scale-in / trim off — they change portfolio shape, opt in explicitly)
//
// Every evaluated action lands in a persistent JOURNAL (data/autopilot-
// journal.json, ring buffer) — the audit trail surfaced in the UI, the AI
// copilot tools and the MORNING BRIEF. The same loop also rolls the daily
// morning brief (positions × market recap, generated at briefHour in
// briefTz). Settings live in data/autopilot-settings.json and are
// readable + writable from the UI, the API and the copilot — one source of truth.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import {
  buildPositionIntelligence,
  type IntelligenceReport,
  type PositionAction,
  type PositionIntelligence,
} from '@/lib/positions/intelligence';
import {
  closePaperPosition,
  deployPaperStrategy,
  placePaperOrder,
} from '@/lib/ai/paper';
import type { VenueId } from '@/lib/ai/exchange-feeds';
import { getSettingsView, resolveSettings } from '@/lib/positions/settings';

const DAY_MS = 86_400_000;

// --- settings -------------------------------------------------------------------------

export interface AutopilotExecute {
  takeProfit: boolean;
  exit: boolean;
  roll: boolean;
  adjust: boolean;
  scaleIn: boolean;
}

export interface AutopilotSettings {
  /** Master switch — the loop only evaluates (and journals) when true. Default false. */
  enabled: boolean;
  /** Dry-run: journal the planned actions but never touch the paper account. Default true. */
  dryRun: boolean;
  /** Cycle interval in seconds (30–3600). Default 60. */
  intervalSec: number;
  /** Only act on decisions with confidence ≥ this (0–100). Default 70. */
  minConfidence: number;
  /** Guard rail — max executed actions in one cycle (1–10). Default 2. */
  maxActionsPerCycle: number;
  /** Per-position cooldown in minutes before another action on the same id (0–1440). Default 30. */
  cooldownMin: number;
  /** Which decision actions the loop may execute. */
  execute: AutopilotExecute;
  /** ADJUST trims this fraction of the position (0.05–1). Default 0.25. */
  adjustTrimFraction: number;
  /** SCALE_IN adds this fraction of the current qty (0.05–1). Default 0.5. */
  scaleInFraction: number;
  /** Local hour (0–23) at which the daily morning brief is generated. Default 8. */
  briefHour: number;
  /** IANA timezone for "today" of the morning brief. Default Asia/Karachi. */
  briefTz: string;
}

export const AUTOPILOT_DEFAULTS: AutopilotSettings = {
  enabled: false,
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
};

const EXEC_KEYS = ['takeProfit', 'exit', 'roll', 'adjust', 'scaleIn'] as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Sanitize + clamp an incoming settings patch (used by the API and the AI tool). */
export function sanitizeAutopilotPatch(raw: Record<string, unknown>): Partial<AutopilotSettings> {
  const out: Partial<AutopilotSettings> = {};
  const bool = (v: unknown): boolean | undefined => {
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    return undefined;
  };
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const enabled = bool(raw.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  const dryRun = bool(raw.dryRun);
  if (dryRun !== undefined) out.dryRun = dryRun;

  const intervalSec = num(raw.intervalSec);
  if (intervalSec !== undefined) out.intervalSec = clamp(Math.round(intervalSec), 30, 3600);
  const minConfidence = num(raw.minConfidence);
  if (minConfidence !== undefined) out.minConfidence = clamp(minConfidence, 0, 100);
  const maxActionsPerCycle = num(raw.maxActionsPerCycle);
  if (maxActionsPerCycle !== undefined) out.maxActionsPerCycle = clamp(Math.round(maxActionsPerCycle), 1, 10);
  const cooldownMin = num(raw.cooldownMin);
  if (cooldownMin !== undefined) out.cooldownMin = clamp(Math.round(cooldownMin), 0, 1440);
  const adjustTrimFraction = num(raw.adjustTrimFraction);
  if (adjustTrimFraction !== undefined) out.adjustTrimFraction = clamp(adjustTrimFraction, 0.05, 1);
  const scaleInFraction = num(raw.scaleInFraction);
  if (scaleInFraction !== undefined) out.scaleInFraction = clamp(scaleInFraction, 0.05, 1);
  const briefHour = num(raw.briefHour);
  if (briefHour !== undefined) out.briefHour = clamp(Math.round(briefHour), 0, 23);

  const tz = raw.briefTz;
  if (typeof tz === 'string' && tz.length > 0 && tz.length < 64) {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(new Date());
      out.briefTz = tz;
    } catch {
      /* invalid IANA zone — ignored */
    }
  }

  const ex = raw.execute;
  if (ex && typeof ex === 'object') {
    const exec: Partial<AutopilotExecute> = {};
    for (const k of EXEC_KEYS) {
      const b = bool((ex as Record<string, unknown>)[k]);
      if (b !== undefined) exec[k] = b;
    }
    if (Object.keys(exec).length > 0) out.execute = exec as AutopilotExecute;
  }
  return out;
}

// --- persistence (data/autopilot-settings.json) ----------------------------------------

const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'autopilot-settings.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'autopilot-journal.json');
const JOURNAL_MAX = 400;

interface SettingsGlobal {
  __autopilotSettings?: AutopilotSettings;
  __autopilotWrite?: Promise<void>;
  __autopilotJournal?: JournalFile;
  __autopilotJournalWrite?: Promise<void>;
  __autopilotLoop?: {
    timer?: ReturnType<typeof setInterval>;
    running: boolean;
    startedAt: number;
    inFlight: boolean;
  };
  __autopilotStats?: AutopilotStats;
  __autopilotLastAction?: Map<string, number>;
}

const g = globalThis as unknown as SettingsGlobal;

function loadSettings(): AutopilotSettings {
  if (g.__autopilotSettings) return g.__autopilotSettings;
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const s = JSON.parse(raw) as Partial<AutopilotSettings>;
    if (s && typeof s === 'object') {
      g.__autopilotSettings = {
        ...AUTOPILOT_DEFAULTS,
        ...s,
        execute: { ...AUTOPILOT_DEFAULTS.execute, ...(s.execute ?? {}) },
      };
      return g.__autopilotSettings;
    }
  } catch {
    /* first run */
  }
  g.__autopilotSettings = { ...AUTOPILOT_DEFAULTS, execute: { ...AUTOPILOT_DEFAULTS.execute } };
  return g.__autopilotSettings;
}

function saveSettings(): void {
  const s = g.__autopilotSettings;
  if (!s) return;
  const write = (async () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = SETTINGS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, SETTINGS_FILE);
    } catch {
      /* keep in memory */
    }
  })();
  g.__autopilotWrite = (g.__autopilotWrite ?? Promise.resolve()).then(() => write).catch(() => {});
}

export function getAutopilotSettings(): AutopilotSettings {
  const s = loadSettings();
  return { ...s, execute: { ...s.execute } };
}

export function updateAutopilotSettings(patch: Partial<AutopilotSettings>): AutopilotSettings {
  const s = loadSettings();
  g.__autopilotSettings = {
    ...s,
    ...patch,
    execute: { ...s.execute, ...(patch.execute ?? {}) },
  };
  saveSettings();
  // interval changes apply to a running loop immediately
  if (patch.intervalSec !== undefined && g.__autopilotLoop?.running) {
    restartLoopTimer();
  }
  return { ...g.__autopilotSettings, execute: { ...g.__autopilotSettings.execute } };
}

export function resetAutopilotSettings(): AutopilotSettings {
  g.__autopilotSettings = { ...AUTOPILOT_DEFAULTS, execute: { ...AUTOPILOT_DEFAULTS.execute } };
  saveSettings();
  if (g.__autopilotLoop?.running) restartLoopTimer();
  return getAutopilotSettings();
}

// --- journal ---------------------------------------------------------------------------

export type JournalResult = 'closed' | 'trimmed' | 'scaled' | 'rolled' | 'planned' | 'skipped' | 'failed';

export interface AutopilotJournalEntry {
  id: string;
  ts: number;
  cycleReason: 'loop' | 'manual' | 'brief';
  mode: 'live' | 'dry-run';
  positionId: string;
  instrument: string;
  asset: string;
  action: PositionAction;
  confidence: number;
  healthScore: number;
  pnlPct: number;
  triggerCodes: string[];
  executed: boolean;
  result: JournalResult;
  detail: string;
  fill?: { price: number; qty: number; fee: number; realizedPnl: number };
}

interface JournalFile {
  version: 1;
  entries: AutopilotJournalEntry[];
}

function loadJournal(): JournalFile {
  if (g.__autopilotJournal) return g.__autopilotJournal;
  try {
    const raw = fs.readFileSync(JOURNAL_FILE, 'utf8');
    const j = JSON.parse(raw) as JournalFile;
    if (j && Array.isArray(j.entries)) {
      g.__autopilotJournal = { version: 1, entries: j.entries.slice(-JOURNAL_MAX) };
      return g.__autopilotJournal;
    }
  } catch {
    /* first run */
  }
  g.__autopilotJournal = { version: 1, entries: [] };
  return g.__autopilotJournal;
}

function appendJournal(e: AutopilotJournalEntry): void {
  const j = loadJournal();
  j.entries.push(e);
  if (j.entries.length > JOURNAL_MAX) j.entries = j.entries.slice(-JOURNAL_MAX);
  const write = (async () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = JOURNAL_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(j));
      fs.renameSync(tmp, JOURNAL_FILE);
    } catch {
      /* keep in memory */
    }
  })();
  g.__autopilotJournalWrite = (g.__autopilotJournalWrite ?? Promise.resolve()).then(() => write).catch(() => {});
}

export function getJournal(limit = 50, sinceMs?: number): AutopilotJournalEntry[] {
  const j = loadJournal();
  let out = j.entries;
  if (sinceMs !== undefined) out = out.filter((e) => e.ts >= sinceMs);
  return out.slice(-limit).reverse();
}

export function journalCount(sinceMs?: number): number {
  const j = loadJournal();
  return sinceMs === undefined ? j.entries.length : j.entries.filter((e) => e.ts >= sinceMs).length;
}

export function resetJournal(): number {
  const j = loadJournal();
  const n = j.entries.length;
  j.entries = [];
  const write = (async () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(JOURNAL_FILE, JSON.stringify(j));
    } catch {
      /* keep in memory */
    }
  })();
  g.__autopilotJournalWrite = (g.__autopilotJournalWrite ?? Promise.resolve()).then(() => write).catch(() => {});
  return n;
}

// --- cycle stats -----------------------------------------------------------------------

export interface AutopilotStats {
  startedAt: number;
  cyclesRun: number;
  actionsExecuted: number;
  actionsPlanned: number;
  errors: number;
  lastCycleAt: number;
  lastCycleDurationMs: number;
  lastError: string | null;
}

function stats(): AutopilotStats {
  if (!g.__autopilotStats) {
    g.__autopilotStats = {
      startedAt: 0,
      cyclesRun: 0,
      actionsExecuted: 0,
      actionsPlanned: 0,
      errors: 0,
      lastCycleAt: 0,
      lastCycleDurationMs: 0,
      lastError: null,
    };
  }
  return g.__autopilotStats;
}

function lastActionMap(): Map<string, number> {
  if (!g.__autopilotLastAction) g.__autopilotLastAction = new Map();
  return g.__autopilotLastAction;
}

// --- decision → action mapping ----------------------------------------------------------

function actionAllowed(a: PositionAction, ex: AutopilotExecute): boolean {
  switch (a) {
    case 'TAKE_PROFIT':
      return ex.takeProfit;
    case 'EXIT':
      return ex.exit;
    case 'ROLL':
      return ex.roll;
    case 'ADJUST':
      return ex.adjust;
    case 'SCALE_IN':
      return ex.scaleIn;
    default:
      return false;
  }
}

function entryId(): string {
  return `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function baseEntry(
  p: PositionIntelligence,
  s: AutopilotSettings,
  reason: 'loop' | 'manual',
): AutopilotJournalEntry {
  return {
    id: entryId(),
    ts: Date.now(),
    cycleReason: reason,
    mode: s.dryRun ? 'dry-run' : 'live',
    positionId: p.positionId,
    instrument: p.instrument,
    asset: p.asset,
    action: p.decision.action,
    confidence: p.decision.confidence,
    healthScore: p.decision.healthScore,
    pnlPct: p.pnl.pct,
    triggerCodes: p.triggers.map((t) => t.code),
    executed: false,
    result: 'skipped',
    detail: '',
  };
}

function realizedPnl(p: PositionIntelligence, price: number, qty: number, fee: number): number {
  const dir = p.side === 'long' ? 1 : -1;
  return (price - p.entry.price) * qty * dir - fee;
}

/** Trim on ADJUST: reduce the position by the trim fraction. */
async function executeTrim(
  p: PositionIntelligence,
  frac: number,
): Promise<{ result: JournalResult; detail: string; fill?: AutopilotJournalEntry['fill'] }> {
  const qty = p.qty * frac;
  if (qty < 0.01) return { result: 'failed', detail: 'trim qty below minimum (0.01)' };
  const res = await closePaperPosition(p.positionId, qty);
  if (!res.ok || !res.fill) {
    return { result: 'failed', detail: res.error ?? 'trim failed' };
  }
  const f = res.fill;
  return {
    result: 'trimmed',
    detail: `trimmed ${qty.toFixed(3)} @ ${f.price} on ${f.venue}`,
    fill: { price: f.price, qty: f.qty, fee: f.fee, realizedPnl: realizedPnl(p, f.price, f.qty, f.fee) },
  };
}

/** SCALE_IN: add a fraction of the current qty on the same instrument. */
async function executeScaleIn(
  p: PositionIntelligence,
  frac: number,
): Promise<{ result: JournalResult; detail: string; fill?: AutopilotJournalEntry['fill'] }> {
  const qty = p.qty * frac;
  if (qty < 0.01) return { result: 'failed', detail: 'scale-in qty below minimum (0.01)' };
  const res = await placePaperOrder({
    venue: p.venue as VenueId,
    asset: p.asset as 'BTC' | 'ETH' | 'SOL',
    expiry: p.expiry,
    strike: p.strike,
    kind: p.kind,
    side: p.side === 'long' ? 'buy' : 'sell',
    qty,
    strategyTag: p.strategyTag ?? undefined,
  });
  if (!res.ok || !res.fill) return { result: 'failed', detail: res.error ?? 'scale-in failed' };
  const f = res.fill;
  return {
    result: 'scaled',
    detail: `added ${f.qty} @ ${f.price} on ${f.venue}`,
    fill: { price: f.price, qty: f.qty, fee: f.fee, realizedPnl: -f.fee },
  };
}

/**
 * ROLL: close the dying leg and re-deploy the same structure one cycle
 * further out, keeping the entry moneyness (strike scales with spot).
 */
async function executeRoll(
  p: PositionIntelligence,
  minDte: number,
): Promise<{ result: JournalResult; detail: string; fill?: AutopilotJournalEntry['fill'] }> {
  const closeRes = await closePaperPosition(p.positionId);
  if (!closeRes.ok || !closeRes.fill) {
    return { result: 'failed', detail: `roll: close failed — ${closeRes.error ?? 'no fill'}` };
  }
  const cf = closeRes.fill;
  const realized = realizedPnl(p, cf.price, cf.qty, cf.fee);

  const spotEntry = p.entry.spot || p.current.spot || p.strike;
  const spotNow = p.current.spot || spotEntry;
  const rollStrike = spotNow > 0 ? p.strike * (spotNow / spotEntry) : p.strike;
  const targetDte = Math.max(14, Math.round((minDte || 7) * 3));
  const deploy = await deployPaperStrategy({
    name: `autopilot-roll-${p.strategyTag ?? p.kind}`,
    asset: p.asset as 'BTC' | 'ETH' | 'SOL',
    legs: [
      {
        kind: p.kind,
        side: p.side === 'long' ? 'buy' : 'sell',
        qty: p.qty,
        strike: rollStrike,
        expiryDays: targetDte,
      },
    ],
  });
  if (!deploy.ok) {
    return {
      result: 'rolled',
      detail: `closed @ ${cf.price} (+${realized.toFixed(0)} realized) but re-deploy failed: ${deploy.rejected ?? deploy.error ?? 'unknown'}`,
      fill: { price: cf.price, qty: cf.qty, fee: cf.fee, realizedPnl: realized },
    };
  }
  const leg = deploy.legs?.[0];
  return {
    result: 'rolled',
    detail: `closed @ ${cf.price} (${realized >= 0 ? '+' : ''}${realized.toFixed(0)}) → re-deployed ${leg?.expiry} ${leg?.strike ?? rollStrike} ${leg?.side ?? ''} ×${leg?.qty ?? p.qty} @ ${leg?.price ?? '?'}`,
    fill: { price: cf.price, qty: cf.qty, fee: cf.fee, realizedPnl: realized },
  };
}

// --- the cycle --------------------------------------------------------------------------

export interface CycleResult {
  tsMs: number;
  durationMs: number;
  mode: 'live' | 'dry-run' | 'disabled';
  reason: 'loop' | 'manual';
  positions: number;
  acted: number;
  executed: number;
  error: string | null;
  entries: AutopilotJournalEntry[];
}

/**
 * One auto-rebalance cycle: run the fusion engine, map decisions to actions,
 * respect every guard rail, execute (or plan, in dry-run), journal it all.
 */
export async function runAutopilotCycle(reason: 'loop' | 'manual' = 'loop'): Promise<CycleResult> {
  const t0 = Date.now();
  const s = getAutopilotSettings();
  const st = stats();
  const entries: AutopilotJournalEntry[] = [];

  const finish = (error: string | null, positions = 0, acted = 0, executed = 0): CycleResult => {
    st.cyclesRun += 1;
    st.lastCycleAt = t0;
    st.lastCycleDurationMs = Date.now() - t0;
    if (error) {
      st.errors += 1;
      st.lastError = error;
    } else {
      st.lastError = null;
    }
    st.actionsExecuted += executed;
    st.actionsPlanned += entries.filter((e) => e.result === 'planned').length;
    return {
      tsMs: t0,
      durationMs: Date.now() - t0,
      mode: !s.enabled && reason === 'loop' ? 'disabled' : s.dryRun ? 'dry-run' : 'live',
      reason,
      positions,
      acted,
      executed,
      error,
      entries,
    };
  };

  if (!s.enabled && reason !== 'manual') return finish('autopilot disabled');
  // manual runs are allowed while disabled (that's how you test settings),
  // but dry-run still protects the account unless explicitly live.

  if (g.__autopilotLoop?.inFlight) {
    return finish('cycle already in flight — skipped');
  }
  if (g.__autopilotLoop) g.__autopilotLoop.inFlight = true;
  try {
    let report: IntelligenceReport;
    try {
      report = await buildPositionIntelligence();
    } catch (e) {
      return finish(`intelligence engine failed: ${(e as Error).message}`);
    }

    const cooldownMs = s.cooldownMin * 60_000;
    const lastAct = lastActionMap();
    let acted = 0;
    let executed = 0;

    // highest-conviction decisions first
    const actionable = report.positions
      .filter((p) => p.decision.action !== 'HOLD')
      .sort((a, b) => b.decision.confidence - a.decision.confidence);

    for (const p of actionable) {
      const e = baseEntry(p, s, reason);

      if (!actionAllowed(p.decision.action, s.execute)) {
        e.result = 'skipped';
        e.detail = `${p.decision.action} disabled in execute toggles`;
        entries.push(e);
        continue;
      }
      if (p.decision.confidence < s.minConfidence) {
        e.result = 'skipped';
        e.detail = `confidence ${p.decision.confidence} < gate ${s.minConfidence}`;
        entries.push(e);
        continue;
      }
      const lastTs = lastAct.get(p.positionId) ?? 0;
      if (cooldownMs > 0 && t0 - lastTs < cooldownMs) {
        // silent skip — no journal spam during cooldown
        continue;
      }
      if (acted >= s.maxActionsPerCycle) {
        // guard rail applies to planned (dry-run) AND executed actions alike
        continue;
      }

      if (s.dryRun) {
        e.result = 'planned';
        e.detail = `${p.decision.action} planned: ${p.decision.suggestedAction}`;
        entries.push(e);
        lastAct.set(p.positionId, t0); // cooldown still applies to dry-run spam
        acted += 1;
        continue;
      }

      // live execution
      let out: { result: JournalResult; detail: string; fill?: AutopilotJournalEntry['fill'] };
      try {
        switch (p.decision.action) {
          case 'TAKE_PROFIT':
          case 'EXIT': {
            const res = await closePaperPosition(p.positionId);
            if (!res.ok || !res.fill) {
              out = { result: 'failed', detail: res.error ?? 'close failed' };
            } else {
              const f = res.fill;
              out = {
                result: 'closed',
                detail: `closed ${f.qty} @ ${f.price} on ${f.venue}`,
                fill: { price: f.price, qty: f.qty, fee: f.fee, realizedPnl: realizedPnl(p, f.price, f.qty, f.fee) },
              };
            }
            break;
          }
          case 'ROLL': {
            const eff = resolveSettings(p.positionId);
            out = await executeRoll(p, eff.minDte ?? 7);
            break;
          }
          case 'ADJUST':
            out = await executeTrim(p, s.adjustTrimFraction);
            break;
          case 'SCALE_IN':
            out = await executeScaleIn(p, s.scaleInFraction);
            break;
          default:
            out = { result: 'skipped', detail: 'unmapped action' };
        }
      } catch (err) {
        out = { result: 'failed', detail: `execution error: ${(err as Error).message}` };
      }

      e.executed = out.result !== 'failed' && out.result !== 'skipped';
      e.result = out.result;
      e.detail = out.detail;
      e.fill = out.fill;
      entries.push(e);
      lastAct.set(p.positionId, t0);
      acted += 1;
      if (e.executed) executed += 1;
    }

    return finish(null, report.positions.length, acted, executed);
  } finally {
    if (g.__autopilotLoop) g.__autopilotLoop.inFlight = false;
    // journal AFTER the loop released — append synchronously, cheap
    for (const e of entries) appendJournal(e);
  }
}

// --- the loop --------------------------------------------------------------------------

function loopState() {
  if (!g.__autopilotLoop) {
    g.__autopilotLoop = { timer: undefined, running: false, startedAt: 0, inFlight: false };
  }
  return g.__autopilotLoop;
}

function stopLoopTimer(): void {
  const L = loopState();
  if (L.timer) clearInterval(L.timer);
  L.timer = undefined;
}

function restartLoopTimer(): void {
  const s = getAutopilotSettings();
  stopLoopTimer();
  const L = loopState();
  L.timer = setInterval(() => {
    void tick();
  }, s.intervalSec * 1000);
  L.timer.unref?.();
}

/** One loop tick: morning-brief roll + (when enabled) the rebalance cycle. */
async function tick(): Promise<void> {
  try {
    // 1 — morning brief (independent of the enabled flag; briefs are passive)
    const { ensureMorningBrief } = await import('@/lib/positions/morning-brief');
    await ensureMorningBrief().catch(() => {});
    // 2 — auto-rebalance
    const s = getAutopilotSettings();
    if (s.enabled) await runAutopilotCycle('loop').catch(() => {});
  } catch {
    /* never let the timer die */
  }
}

/**
 * Start the server-side singleton loop (idempotent, survives dev HMR via
 * globalThis). Called from src/instrumentation.ts on server boot and lazily
 * by the API routes so /api/positions/autopilot also boots it.
 */
export function startAutopilotLoop(): { started: boolean; alreadyRunning: boolean } {
  const L = loopState();
  if (L.running) return { started: false, alreadyRunning: true };
  L.running = true;
  L.startedAt = Date.now();
  stats().startedAt = L.startedAt;
  restartLoopTimer();
  return { started: true, alreadyRunning: false };
}

export function stopAutopilotLoop(): void {
  const L = loopState();
  stopLoopTimer();
  L.running = false;
}

export function autopilotStatus() {
  const L = loopState();
  const s = getAutopilotSettings();
  const st = stats();
  return {
    running: L.running,
    inFlight: L.inFlight,
    startedAt: L.startedAt || null,
    intervalSec: s.intervalSec,
    settings: s,
    stats: { ...st },
    journalCount: journalCount(),
    lastJournal: getJournal(1)[0] ?? null,
  };
}

export { DAY_MS };

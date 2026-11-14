// ─────────────────────────────────────────────────────────────────────────────
// positions/morning-brief — the desk's DAILY BRIEF, wired to the decision engine.
//
// Once a day (default 08:00 Asia/Karachi — configurable), the autopilot loop
// rolls the brief:
//   • overnight market recap per asset (spot move, IV, bias, regime, funding)
//   • portfolio rollup (equity, unrealized, margin utilization, stress)
//   • per-position DECISION digest straight from the fusion engine
//     (action, confidence, health, P&L, triggers, first reason)
//   • the watchlist — positions sitting near a management threshold
//   • what the AUTOPILOT did since the previous brief (journal digest)
//   • an AI narrative (desk-model synthesis, graceful null on failure)
//
// Deterministic sections are pure data; the narrative is optional. Briefs
// persist to data/morning-briefs.json (last 30) — readable via
// GET /api/positions/morning-brief, regenerable via POST. The UI panel and
// the copilot morning_brief tool both read this store.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { generateText } from 'ai';
import {
  buildPositionIntelligence,
  type IntelligenceReport,
  type PositionAction,
} from '@/lib/positions/intelligence';
import { getAutopilotSettings, getJournal, journalCount, type AutopilotJournalEntry } from '@/lib/positions/autopilot';
import { getDeskModel } from '@/lib/ai/model-router';

const DATA_DIR = path.join(process.cwd(), 'data');
const BRIEFS_FILE = path.join(DATA_DIR, 'morning-briefs.json');
const KEEP_BRIEFS = 30;
const NARRATIVE_TIMEOUT_MS = 30_000;

// --- types ---------------------------------------------------------------------------

export interface BriefMarketSlice {
  asset: string;
  spot: number;
  change24hPct: number;
  atmIv30dPct: number | null;
  biasLabel: string | null;
  biasScore: number | null;
  regimeLabel: string | null;
  regimeScore: number | null;
  ivRank: number | null;
  fundingAnnualizedPct: number | null;
  topSignals: string[];
}

export interface BriefPositionDigest {
  positionId: string;
  instrument: string;
  side: 'long' | 'short';
  qty: number;
  dte: number;
  pnlPct: number;
  unrealized: number;
  healthScore: number;
  action: PositionAction;
  confidence: number;
  triggers: string[];
  reason: string;
}

export interface BriefWatchItem {
  positionId: string;
  instrument: string;
  action: PositionAction;
  note: string;
}

export interface MorningBrief {
  date: string; // YYYY-MM-DD in briefTz
  tz: string;
  generatedAt: number;
  source: string;
  market: BriefMarketSlice[];
  portfolio: {
    equity: number;
    unrealized: number;
    marginUtilizationPct: number;
    netDeltaUsd: number;
    netVega: number;
    netTheta: number;
    stressDown1Atr: number;
    stressUp1Atr: number;
    openPositions: number;
  };
  positions: BriefPositionDigest[];
  decisionCensus: Partial<Record<PositionAction, number>>;
  watchlist: BriefWatchItem[];
  autopilot: {
    enabled: boolean;
    dryRun: boolean;
    journalSincePrev: number;
    closed: number;
    planned: number;
    failed: number;
    lastActions: AutopilotJournalEntry[];
  };
  aiNarrative: string | null;
  aiModel: string | null;
}

// --- persistence ---------------------------------------------------------------------

interface BriefsFile {
  version: 1;
  briefs: Record<string, MorningBrief>;
  order: string[]; // most recent last
}

interface BriefsGlobal {
  __morningBriefs?: BriefsFile;
  __briefWrite?: Promise<void>;
}

const g = globalThis as unknown as BriefsGlobal;

function loadBriefs(): BriefsFile {
  if (g.__morningBriefs) return g.__morningBriefs;
  try {
    const raw = fs.readFileSync(BRIEFS_FILE, 'utf8');
    const b = JSON.parse(raw) as BriefsFile;
    if (b && b.briefs && Array.isArray(b.order)) {
      g.__morningBriefs = b;
      return b;
    }
  } catch {
    /* first run */
  }
  g.__morningBriefs = { version: 1, briefs: {}, order: [] };
  return g.__morningBriefs;
}

function saveBriefs(): void {
  const b = g.__morningBriefs;
  if (!b) return;
  // trim to the newest KEEP_BRIEFS
  if (b.order.length > KEEP_BRIEFS) {
    const drop = b.order.slice(0, b.order.length - KEEP_BRIEFS);
    for (const d of drop) delete b.briefs[d];
    b.order = b.order.slice(-KEEP_BRIEFS);
  }
  const write = (async () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = BRIEFS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(b));
      fs.renameSync(tmp, BRIEFS_FILE);
    } catch {
      /* keep in memory */
    }
  })();
  g.__briefWrite = (g.__briefWrite ?? Promise.resolve()).then(() => write).catch(() => {});
}

// --- local date helpers ---------------------------------------------------------------

export function localDateStr(d = new Date(), tz = 'Asia/Karachi'): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(d); // YYYY-MM-DD
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function localHour(d = new Date(), tz = 'Asia/Karachi'): number {
  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(d),
    );
  } catch {
    return d.getUTCHours();
  }
}

// --- deterministic sections ----------------------------------------------------------

function marketSlices(report: IntelligenceReport): BriefMarketSlice[] {
  return report.market.map((c) => ({
    asset: c.asset,
    spot: c.spot,
    change24hPct: c.change24hPct,
    atmIv30dPct: c.atmIv30dPct,
    biasLabel: c.technicals?.biasLabel ?? null,
    biasScore: c.technicals?.biasScore ?? null,
    regimeLabel: c.decision?.regimeLabel ?? null,
    regimeScore: c.decision?.regimeScore ?? null,
    ivRank: c.volRegime?.ivRank ?? null,
    fundingAnnualizedPct: c.fundingAnnualizedPct ?? null,
    topSignals: (c.decision?.topSignals ?? []).map((s) => `${s.title}: ${s.state} (${s.strength})`).slice(0, 3),
  }));
}

function positionDigests(report: IntelligenceReport): BriefPositionDigest[] {
  return report.positions.map((p) => ({
    positionId: p.positionId,
    instrument: p.instrument,
    side: p.side,
    qty: p.qty,
    dte: p.dte,
    pnlPct: p.pnl.pct,
    unrealized: p.pnl.unrealized,
    healthScore: p.decision.healthScore,
    action: p.decision.action,
    confidence: p.decision.confidence,
    triggers: p.triggers.map((t) => t.code),
    reason: p.decision.reasons[0] ?? '',
  }));
}

/** Positions near a management threshold — they will drive today's decisions. */
function buildWatchlist(report: IntelligenceReport): BriefWatchItem[] {
  const out: BriefWatchItem[] = [];
  for (const p of report.positions) {
    const notes: string[] = [];
    const st = p.settings;
    if (st.takeProfitPct != null && st.takeProfitPct > 0 && p.pnl.pct >= st.takeProfitPct * 0.7) {
      notes.push(`P&L ${p.pnl.pct.toFixed(1)}% → TP ${st.takeProfitPct}% within reach`);
    }
    if (st.stopLossPct != null && st.stopLossPct > 0 && p.pnl.pct <= -st.stopLossPct * 0.7) {
      notes.push(`P&L ${p.pnl.pct.toFixed(1)}% → SL ${st.stopLossPct}% within reach`);
    }
    if (st.minDte != null && st.minDte > 0 && p.dte <= st.minDte * 2 + 2) {
      notes.push(`${p.dte.toFixed(1)}d left (floor ${st.minDte}d)`);
    }
    if (st.probItmFloorPct != null && p.side === 'long' && p.current.probItmPct != null &&
        p.current.probItmPct < st.probItmFloorPct + 10) {
      notes.push(`prob ITM ${p.current.probItmPct.toFixed(0)}% vs floor ${st.probItmFloorPct}%`);
    }
    if (st.probItmCeilPct != null && p.side === 'short' && p.current.probItmPct != null &&
        p.current.probItmPct > st.probItmCeilPct - 10) {
      notes.push(`prob ITM ${p.current.probItmPct.toFixed(0)}% vs ceiling ${st.probItmCeilPct}%`);
    }
    if (p.market.alignmentScore != null && st.alignmentBreakScore != null &&
        p.market.alignmentScore < -st.alignmentBreakScore * 0.7) {
      notes.push(`alignment ${p.market.alignmentScore.toFixed(0)} turning adverse`);
    }
    if (p.decision.healthScore < 50) notes.push(`health ${p.decision.healthScore}/100`);
    if (notes.length > 0) {
      out.push({
        positionId: p.positionId,
        instrument: p.instrument,
        action: p.decision.action,
        note: notes.slice(0, 3).join(' · '),
      });
    }
  }
  return out;
}

// --- the AI narrative (optional, never fatal) -------------------------------------------

async function aiNarrative(brief: Omit<MorningBrief, 'aiNarrative' | 'aiModel'>): Promise<{ text: string; model: string } | null> {
  try {
    const model = getDeskModel();
    const digest = {
      market: brief.market.map((m) => ({
        a: m.asset,
        spot: m.spot,
        chg24h: m.change24hPct,
        iv: m.atmIv30dPct,
        bias: m.biasLabel,
        regime: m.regimeLabel,
        ivRank: m.ivRank,
      })),
      portfolio: brief.portfolio,
      decisions: brief.positions.map((p) => ({
        i: p.instrument,
        action: p.action,
        conf: p.confidence,
        pnl: p.pnlPct,
        health: p.healthScore,
        dte: p.dte,
        triggers: p.triggers,
      })),
      watchlist: brief.watchlist.slice(0, 8),
      autopilot: { closed: brief.autopilot.closed, planned: brief.autopilot.planned, failed: brief.autopilot.failed },
    };
    const result = await Promise.race([
      generateText({
        model,
        system:
          "You are the morning desk analyst of a crypto perpetual-options paper desk. Write a crisp morning brief in 6-9 short bullet lines (max ~140 words total): (1) what the tape did overnight, (2) what it means for the book's risk (delta/vega/theta), (3) the 2-4 positions that need attention today with the concrete action, (4) one line on what the auto-rebalance loop did. Concrete numbers only from the data — never invent prices. No preamble, no headings, just the bullets.",
        prompt: `Today's desk digest (JSON):\n${JSON.stringify(digest).slice(0, 6000)}\n\nWrite the morning brief.`,
        temperature: 0.5,
        maxRetries: 1,
      }),
      new Promise<null>((res) => setTimeout(() => res(null), NARRATIVE_TIMEOUT_MS)),
    ]);
    if (!result) return null;
    const text = result.text?.trim();
    if (!text) return null;
    return { text, model: 'desk-router' };
  } catch {
    return null;
  }
}

// --- the builder ------------------------------------------------------------------------

export async function buildMorningBrief(opts?: { includeAi?: boolean }): Promise<MorningBrief> {
  const apSettings = getAutopilotSettings();
  const now = new Date();
  const date = localDateStr(now, apSettings.briefTz);

  const report = await buildPositionIntelligence();

  // autopilot activity since the PREVIOUS brief (or the last 24h)
  const prev = latestBrief();
  const since = prev ? prev.generatedAt : Date.now() - 86_400_000;
  const sinceEntries = getJournal(400, since);

  const brief: Omit<MorningBrief, 'aiNarrative' | 'aiModel'> = {
    date,
    tz: apSettings.briefTz,
    generatedAt: Date.now(),
    source: report.source,
    market: marketSlices(report),
    portfolio: {
      equity: report.portfolio.equity,
      unrealized: report.portfolio.unrealized,
      marginUtilizationPct: report.portfolio.marginUtilizationPct,
      netDeltaUsd: report.portfolio.netGreeks.total.deltaUsd,
      netVega: report.portfolio.netGreeks.total.vega,
      netTheta: report.portfolio.netGreeks.total.theta,
      stressDown1Atr: report.portfolio.stress.down1AtrPnl,
      stressUp1Atr: report.portfolio.stress.up1AtrPnl,
      openPositions: report.positions.length,
    },
    positions: positionDigests(report),
    decisionCensus: report.portfolio.decisionCounts,
    watchlist: buildWatchlist(report),
    autopilot: {
      enabled: apSettings.enabled,
      dryRun: apSettings.dryRun,
      journalSincePrev: journalCount(since),
      closed: sinceEntries.filter((e) => e.result === 'closed' || e.result === 'rolled' || e.result === 'trimmed').length,
      planned: sinceEntries.filter((e) => e.result === 'planned').length,
      failed: sinceEntries.filter((e) => e.result === 'failed').length,
      lastActions: sinceEntries.slice(0, 8),
    },
  };

  let narrative: { text: string; model: string } | null = null;
  if (opts?.includeAi !== false) {
    narrative = await aiNarrative(brief);
  }

  const full: MorningBrief = { ...brief, aiNarrative: narrative?.text ?? null, aiModel: narrative?.model ?? null };

  // persist (today's brief replaces an earlier same-day generation)
  const store = loadBriefs();
  store.briefs[date] = full;
  if (!store.order.includes(date)) store.order.push(date);
  saveBriefs();
  return full;
}

/** Latest stored brief (does not generate). */
export function latestBrief(): MorningBrief | null {
  const b = loadBriefs();
  if (b.order.length === 0) return null;
  return b.briefs[b.order[b.order.length - 1]] ?? null;
}

export function getBrief(date: string): MorningBrief | null {
  return loadBriefs().briefs[date] ?? null;
}

/** History metadata, newest first. */
export function briefHistory(limit = 30) {
  const b = loadBriefs();
  return b.order
    .slice(-limit)
    .reverse()
    .map((d) => {
      const br = b.briefs[d];
      return {
        date: d,
        generatedAt: br.generatedAt,
        positions: br.positions.length,
        watchlist: br.watchlist.length,
        decisions: br.decisionCensus,
        hasNarrative: Boolean(br.aiNarrative),
      };
    });
}

/**
 * Roll-call used by the autopilot loop every tick: generate today's brief if
 * the configured hour has arrived and it doesn't exist yet. Cheap no-op when
 * the brief is already in place (or the hour hasn't come).
 */
export async function ensureMorningBrief(): Promise<{ generated: boolean; date?: string; reason?: string }> {
  const s = getAutopilotSettings();
  const now = new Date();
  const today = localDateStr(now, s.briefTz);
  if (getBrief(today)) return { generated: false, date: today, reason: 'already exists' };
  const hour = localHour(now, s.briefTz);
  if (hour < s.briefHour) return { generated: false, reason: `before briefHour ${s.briefHour}` };
  const brief = await buildMorningBrief();
  return { generated: true, date: brief.date };
}

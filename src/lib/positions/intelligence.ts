// ─────────────────────────────────────────────────────────────────────────────
// positions/intelligence — the POSITION × MARKET fusion engine.
//
// Takes every open paper position and fuses it with the platform's whole
// market data stack — live spot/IV/funding/OI, 4h technicals (bias score,
// RSI, ATR, EMA structure), the VolQuant vol-regime verdict and the signal
// battery's regime score — to produce, per position:
//
//   • live Greeks re-priced at the current mark (delta/gamma/vega/theta)
//   • probability of finishing ITM + probability of touching breakeven
//   • P&L ATTRIBUTION (how much of the move came from delta, vega, theta)
//   • theta-bleed rate, distance-to-strike/breakeven in ATR units
//   • market-alignment score (is the tape supporting or fighting this trade?)
//   • the effective management settings + every trigger they fire
//   • a composite decision: HOLD / ADJUST / SCALE_IN / TAKE_PROFIT / EXIT / ROLL
//     with a confidence, the health score behind it and concrete reasons.
//
// Plus a portfolio-level rollup (net greeks by asset, ±1-ATR stress P&L,
// margin utilization, alert census). Pure typed output — consumed by
// /api/positions/intelligence, the Paper Desk UI and the AI copilot tools.
// ─────────────────────────────────────────────────────────────────────────────

import { getPaperAccount, resolveOptionQuote, type PaperPosition, type ResolvedQuote } from '@/lib/ai/paper';
import {
  ASSET_IDS,
  liveMarketState,
  marketDataSource,
  primeLiveCandles,
  primeLiveMarket,
  computeTechnicalSnapshot,
  type AssetId,
} from '@/lib/ai/market-intel';
import { volRegime } from '@/lib/quant/volatility';
import { decisionBrief } from '@/lib/quant/signals';
import { probTouch } from '@/lib/quant/perps';
import { bsGreeks, bsPrice, normCdf } from '@/lib/pricing';
import { evaluateTriggers, getSettingsView, resolveSettings, type PositionSettings, type Trigger } from './settings';

// --- types -------------------------------------------------------------------------

export type PositionAction = 'HOLD' | 'ADJUST' | 'SCALE_IN' | 'TAKE_PROFIT' | 'EXIT' | 'ROLL';

export interface AssetMarketContext {
  asset: string;
  spot: number;
  change24hPct: number;
  atmIv30dPct: number | null;
  fundingRate: number | null;
  fundingAnnualizedPct: number | null;
  openInterestUsd: number | null;
  technicals: {
    biasScore: number;
    biasLabel: string;
    rsi14: number;
    atr14: number;
    atrPct: number;
    emaAlignment: string;
    adx14: number;
    priceVsVwapPct: number;
    signals: string[];
  } | null;
  volRegime: { ivRank: number | null; verdict: string; iv30Pct: number | null; rv30Pct: number | null } | null;
  decision: {
    regimeScore: number;
    regimeLabel: string;
    volBias: string;
    topSignals: { title: string; state: string; strength: number }[];
  } | null;
}

export interface GreeksSnap {
  delta: number; // per unit, signed by side
  gamma: number;
  vega: number; // per vol point, signed by side
  theta: number; // per day, signed by side
  positionDelta: number; // delta × qty (underlying units)
}

export interface PositionIntelligence {
  positionId: string;
  instrument: string;
  venue: string;
  asset: string;
  kind: 'call' | 'put';
  side: 'long' | 'short';
  qty: number;
  strike: number;
  expiry: string;
  expiryMs: number;
  dte: number;
  daysHeld: number;
  strategyTag: string | null;
  entry: { price: number; spot: number; ivPct: number | null; greeks: GreeksSnap | null };
  current: {
    mark: number;
    spot: number;
    ivPct: number | null;
    greeks: GreeksSnap | null;
    probItmPct: number | null;
    quoteSource: string | null;
  };
  pnl: {
    unrealized: number;
    pct: number;
    deltaPnl: number;
    vegaPnl: number;
    thetaPnl: number;
    residualPnl: number;
  };
  risk: {
    thetaBleedPctPerDay: number | null;
    breakeven: number;
    distanceToBreakevenAtr: number | null;
    distanceToStrikeAtr: number | null;
    probTouchBreakevenPct: number | null;
    moneynessPct: number;
    marginHeld: number;
    notionalUsd: number;
  };
  market: {
    alignmentScore: number | null;
    alignmentLabel: string;
    ivMovePts: number | null;
    fundingTailwind: boolean | null;
  };
  settings: PositionSettings;
  settingsSource: 'position' | 'global';
  triggers: Trigger[];
  decision: {
    action: PositionAction;
    confidence: number;
    healthScore: number;
    reasons: string[];
    suggestedAction: string;
  };
}

export interface PortfolioRollup {
  equity: number;
  unrealized: number;
  marginHeld: number;
  buyingPower: number;
  marginUtilizationPct: number;
  netGreeks: {
    total: { delta: number; deltaUsd: number; gamma: number; vega: number; theta: number };
    byAsset: Record<string, { delta: number; deltaUsd: number; gamma: number; vega: number; theta: number; positionCount: number; exposureUsd: number }>;
  };
  stress: { down1AtrPnl: number; up1AtrPnl: number };
  alerts: { critical: number; warn: number; info: number };
  decisionCounts: Partial<Record<PositionAction, number>>;
}

export interface IntelligenceReport {
  tsMs: number;
  source: string;
  market: AssetMarketContext[];
  positions: PositionIntelligence[];
  portfolio: PortfolioRollup;
  notes: string[];
}

// --- helpers -----------------------------------------------------------------------

const DAY_MS = 86_400_000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round(v: number | null | undefined, dp = 2): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return +v.toFixed(dp);
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return await Promise.race([p, new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);
}

/** Invert BS price → implied vol (bisection). Returns decimal IV or null. */
function impliedVol(
  price: number,
  spot: number,
  strike: number,
  tYears: number,
  kind: 'call' | 'put',
): number | null {
  if (!(price > 0) || !(spot > 0) || !(strike > 0) || tYears <= 0) return null;
  const intr = Math.max(0, kind === 'call' ? spot - strike : strike - spot);
  if (price <= intr + 1e-8) return null; // no time value → vol ~ 0
  let lo = 0.01;
  let hi = 3.0;
  const f = (iv: number) => bsPrice(spot, strike, tYears, iv, 0, kind) - price;
  if (f(hi) < 0) return hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

function greeksSnap(
  spot: number,
  strike: number,
  tYears: number,
  iv: number,
  kind: 'call' | 'put',
  side: 'long' | 'short',
  qty: number,
): GreeksSnap | null {
  if (!(spot > 0) || !(strike > 0)) return null;
  const t = Math.max(tYears, 1 / 365 / 24); // floor ~1h so greeks exist near expiry
  const useIv = Math.max(iv, 0.02);
  const g = bsGreeks(spot, strike, t, useIv, 0, kind);
  const dir = side === 'long' ? 1 : -1;
  return {
    delta: +(g.delta * dir).toFixed(4),
    gamma: +(g.gamma * dir).toFixed(6),
    vega: +(g.vega * dir).toFixed(3),
    theta: +(g.theta * dir).toFixed(3),
    positionDelta: +(g.delta * dir * qty).toFixed(4),
  };
}

/** d2 from BS (needed for prob ITM without re-deriving). */
function probItm(spot: number, strike: number, tYears: number, iv: number, kind: 'call' | 'put'): number | null {
  if (!(spot > 0) || !(strike > 0) || tYears <= 0 || !(iv > 0)) return null;
  const sq = iv * Math.sqrt(tYears);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * tYears) / sq;
  const d2 = d1 - sq;
  return kind === 'call' ? normCdf(d2) : normCdf(-d2);
}

/** Signed market score in the direction the position WANTS (−100..+100). */
function alignmentScoreFor(
  positionDelta: number | null,
  ctx: AssetMarketContext | undefined,
): number | null {
  if (positionDelta == null || !ctx) return null;
  const dirWanted = Math.sign(positionDelta);
  if (dirWanted === 0) return 0;
  const bias = ctx.technicals?.biasScore ?? 0; // −1..1
  const regime = (ctx.decision?.regimeScore ?? 0) / 100; // −1..1
  const raw = dirWanted * (50 * bias + 50 * regime);
  return clamp(Math.round(raw), -100, 100);
}

function alignmentLabel(score: number | null): string {
  if (score == null) return 'no market read';
  if (score > 45) return 'market strongly supports this trade';
  if (score > 15) return 'market mildly supports this trade';
  if (score < -45) return 'market strongly fights this trade';
  if (score < -15) return 'market mildly fights this trade';
  return 'market neutral to this trade';
}

// --- market context ------------------------------------------------------------------

async function buildMarketContexts(assets: string[]): Promise<AssetMarketContext[]> {
  // prime the live feeds once (no-op when fresh)
  await withTimeout(primeLiveMarket(), 6000, undefined);
  await Promise.allSettled(assets.map((a) => withTimeout(primeLiveCandles(a as AssetId), 6000, undefined)));
  const state = liveMarketState();

  const contexts = await Promise.all(
    assets.map(async (asset) => {
      const s = (state as Record<string, (typeof state)[AssetId]>)[asset];
      let technicals: AssetMarketContext['technicals'] = null;
      try {
        const snap = computeTechnicalSnapshot(asset as AssetId, '4h');
        technicals = {
          biasScore: +snap.biasScore.toFixed(2),
          biasLabel: snap.biasLabel,
          rsi14: +snap.momentum.rsi14.toFixed(1),
          atr14: +snap.volatility.atr14.toFixed(2),
          atrPct: +snap.volatility.atrPct.toFixed(2),
          emaAlignment: snap.trend.alignment,
          adx14: +snap.strength.adx14.toFixed(1),
          priceVsVwapPct: +snap.volume.priceVsVwapPct.toFixed(2),
          signals: snap.signals.slice(0, 4),
        };
      } catch {
        /* technicals unavailable */
      }

      const [vr, db] = await Promise.all([
        withTimeout(volRegime(asset), 7000, null).catch(() => null),
        withTimeout(decisionBrief(asset as 'BTC' | 'ETH' | 'SOL'), 7000, null).catch(() => null),
      ]);

      return {
        asset,
        spot: s?.spot ?? 0,
        change24hPct: s ? +s.change24h.toFixed(2) : 0,
        atmIv30dPct: s ? +(s.atmIv30d * 100).toFixed(1) : null,
        fundingRate: s ? +s.fundingRate.toFixed(4) : null,
        fundingAnnualizedPct: s ? +(s.fundingRate * 365 * 100).toFixed(1) : null,
        openInterestUsd: s ? Math.round(s.openInterest) : null,
        technicals,
        volRegime: vr
          ? {
              ivRank: round(vr.ivStats?.rank ?? null, 0),
              verdict: vr.verdict,
              iv30Pct: round(vr.triangle?.iv30Pct ?? null, 1),
              rv30Pct: round(vr.triangle?.rv30Pct ?? null, 1),
            }
          : null,
        decision: db
          ? {
              regimeScore: Math.round(db.regimeScore),
              regimeLabel: db.regimeLabel,
              volBias: db.volBias,
              topSignals: db.signals
                .slice()
                .sort((a, b) => b.strength - a.strength)
                .slice(0, 3)
                .map((sig) => ({ title: sig.title, state: sig.state, strength: sig.strength })),
            }
          : null,
      } satisfies AssetMarketContext;
    }),
  );
  return contexts;
}

// --- per-position intelligence ---------------------------------------------------------

function findEntryFill(
  fills: { asset: string; expiry: string; strike: number; kind: string; side: string; ts: number; spotAtFill: number }[],
  pos: PaperPosition,
): number | null {
  // opening fill: same instrument, opening direction, closest to openedAt
  let best: number | null = null;
  let bestDt = Infinity;
  for (const f of fills) {
    if (f.asset !== pos.asset || f.expiry !== pos.expiry || f.strike !== pos.strike || f.kind !== pos.kind) continue;
    const openingSide = pos.side === 'long' ? 'buy' : 'sell';
    if (f.side !== openingSide) continue;
    const dt = Math.abs(f.ts - pos.openedAt);
    if (dt < bestDt) {
      bestDt = dt;
      best = f.spotAtFill;
    }
  }
  return best;
}

function decideForPosition(m: {
  triggers: Trigger[];
  health: number;
  dte: number;
  pnlPct: number;
  alignment: number | null;
  probItm: number | null;
  side: 'long' | 'short';
  daysHeld: number;
}): { action: PositionAction; confidence: number; healthScore: number; reasons: string[]; suggestedAction: string } {
  const reasons: string[] = [];
  const critical = m.triggers.filter((t) => t.level === 'critical');
  const warns = m.triggers.filter((t) => t.level === 'warn');

  let action: PositionAction = 'HOLD';
  let confidence = 55;

  if (critical.some((t) => t.code === 'TAKE_PROFIT')) {
    action = 'TAKE_PROFIT';
    confidence = 88;
    reasons.push(`Profit target reached at +${m.pnlPct.toFixed(1)}% — the plan says to harvest.`);
  } else if (critical.some((t) => t.code === 'STOP_LOSS')) {
    action = 'EXIT';
    confidence = 90;
    reasons.push(`Stop level breached at ${m.pnlPct.toFixed(1)}% — capital preservation first.`);
  }

  if (action === 'HOLD') {
    if (m.health < 30 || (critical.length > 0 && m.health < 45)) {
      action = 'EXIT';
      confidence = clamp(60 + (30 - m.health), 60, 92);
    } else if (warns.length >= 2 || m.health < 50 || critical.length > 0) {
      action = 'ADJUST';
      confidence = clamp(52 + (50 - m.health), 52, 85);
    } else if (m.health >= 78 && (m.alignment ?? 0) >= 40 && m.pnlPct > 0 && m.dte > 7) {
      action = 'SCALE_IN';
      confidence = clamp(m.health - 10, 60, 85);
    }
  }

  // DTE floor with a healthy thesis → ROLL rather than plain exit
  if (m.dte <= 5 && m.pnlPct > -10 && (action === 'ADJUST' || action === 'HOLD') && m.dte <= 5) {
    action = 'ROLL';
    confidence = Math.max(confidence, 70);
  }

  if (reasons.length === 0 && action === 'HOLD') {
    reasons.push(`Health score ${m.health.toFixed(0)}/100 with no management rules triggered — let the trade work.`);
  }
  for (const t of critical) reasons.push(t.message);
  for (const t of warns) reasons.push(t.message);
  if (m.alignment != null && m.alignment < -30 && action === 'HOLD') {
    reasons.push(`Market score is ${m.alignment} against the position — watch for an ADJUST signal if it deepens.`);
  }

  const suggestedAction: Record<PositionAction, string> = {
    HOLD: 'No action needed — keep monitoring; the market tape currently does not demand a change.',
    ADJUST: 'Consider rolling the strike, hedging delta, or trimming size to realign with the current tape.',
    SCALE_IN: 'Thesis is working and the market supports it — a disciplined add (with a fresh stop) is justified.',
    TAKE_PROFIT: 'Close (or half-close and trail the rest) to bank the gain at the real venue bid/ask.',
    EXIT: 'Close the position at market — risk limits are breached or the thesis has broken down.',
    ROLL: 'Time is running out but the thesis is intact — roll to a later expiry (and possibly re-strike) before theta/gamma bite.',
  };

  return { action, confidence, healthScore: m.health, reasons: reasons.slice(0, 6), suggestedAction: suggestedAction[action] };
}

function healthScoreFor(m: {
  pnlPct: number;
  alignment: number | null;
  thetaBleed: number | null;
  probItm: number | null;
  side: 'long' | 'short';
  dte: number;
  ivMovePts: number | null;
  positionVega: number | null;
  triggers: Trigger[];
}): number {
  let score = 50;
  // P&L trajectory
  if (m.pnlPct > 20) score += 12;
  else if (m.pnlPct > 5) score += 7;
  else if (m.pnlPct < -20) score -= 14;
  else if (m.pnlPct < -5) score -= 7;
  // alignment
  if (m.alignment != null) {
    if (m.alignment > 40) score += 10;
    else if (m.alignment > 15) score += 5;
    else if (m.alignment < -40) score -= 12;
    else if (m.alignment < -15) score -= 6;
  }
  // theta decay pace (long side penalized, short side rewarded mildly)
  if (m.thetaBleed != null) {
    if (m.side === 'long') {
      if (m.thetaBleed > 4) score -= 12;
      else if (m.thetaBleed > 2) score -= 6;
    } else if (m.thetaBleed > 2) score += 4;
  }
  // probability of finishing ITM vs side
  if (m.probItm != null) {
    if (m.side === 'long' && m.probItm < 20) score -= 10;
    if (m.side === 'short' && m.probItm > 65) score -= 10;
    if (m.side === 'long' && m.probItm > 55) score += 5;
  }
  // time
  if (m.dte < 3) score -= 8;
  else if (m.dte < 7) score -= 4;
  else if (m.dte > 21) score += 2;
  // vega environment
  if (m.ivMovePts != null && m.positionVega != null) {
    const vegaHurt = m.positionVega * m.ivMovePts < 0; // vega sign opposite of iv move
    if (Math.abs(m.ivMovePts) > 5) score += vegaHurt ? -8 : 6;
  }
  // triggers
  for (const t of m.triggers) {
    if (t.level === 'critical') score -= 18;
    else if (t.level === 'warn') score -= 7;
  }
  return clamp(Math.round(score), 0, 100);
}

// --- the report builder -----------------------------------------------------------------

export async function buildPositionIntelligence(opts?: {
  positionId?: string;
}): Promise<IntelligenceReport> {
  const account = await getPaperAccount();
  const now = Date.now();
  const notes: string[] = [];

  const positions = opts?.positionId
    ? account.positions.filter((p) => p.id === opts.positionId)
    : account.positions;

  const assets = [...new Set(positions.map((p) => p.asset))].filter((a) =>
    (ASSET_IDS as readonly string[]).includes(a),
  );
  const market = await buildMarketContexts(assets.length > 0 ? assets : ['BTC']);
  const ctxByAsset = new Map(market.map((c) => [c.asset, c]));

  // resolve a current quote per (venue,asset,expiry,strike,kind) group
  const quoteGroups = new Map<string, PaperPosition[]>();
  for (const p of positions) {
    const key = `${p.venue}:${p.asset}:${p.expiry}:${p.strike}:${p.kind}`;
    const arr = quoteGroups.get(key) ?? [];
    arr.push(p);
    quoteGroups.set(key, arr);
  }
  const quotes = new Map<string, ResolvedQuote>();
  await Promise.all(
    [...quoteGroups.entries()].map(async ([key, ps]) => {
      try {
        const p = ps[0];
        const { quote } = await resolveOptionQuote(
          p.venue,
          p.asset,
          p.expiry,
          p.strike,
          p.kind,
          p.side === 'long' ? 'sell' : 'buy',
        );
        if (quote?.venue) quotes.set(key, quote);
      } catch {
        /* keep going without a fresh quote */
      }
    }),
  );

  // which positions carry their own settings override (single lookup)
  const settingsOverrides = getSettingsView().positions;

  const intel: PositionIntelligence[] = positions.map((p) => {
    const ctx = ctxByAsset.get(p.asset);
    const key = `${p.venue}:${p.asset}:${p.expiry}:${p.strike}:${p.kind}`;
    const q = quotes.get(key);
    const spot = q?.spot ?? ctx?.spot ?? 0;
    const dte = Math.max((p.expiryMs - now) / DAY_MS, 0);
    const daysHeld = (now - p.openedAt) / DAY_MS;
    const tNow = Math.max(dte / 365, 1e-6);
    const tEntry = Math.max((p.expiryMs - p.openedAt) / DAY_MS / 365, 1e-6); // years remaining at entry
    const dir = p.side === 'long' ? 1 : -1;

    // entry state (implied vol inverted from the fill price at the entry spot)
    const entrySpot = findEntryFill(account.fills, p) ?? spot;
    const entryIv = impliedVol(p.entryPrice, entrySpot, p.strike, tEntry, p.kind);
    // venue chain IVs come in PERCENT (e.g. 34.02 = 34%) — normalize to decimal
    const curIv = q?.iv != null ? q.iv / 100 : null;

    const entryGreeks = entryIv != null ? greeksSnap(entrySpot, p.strike, tEntry, entryIv, p.kind, p.side, p.qty) : null;
    const curGreeks = curIv != null ? greeksSnap(spot, p.strike, tNow, curIv, p.kind, p.side, p.qty) : null;

    // pnl
    const uPnl = dir * (p.markPrice - p.entryPrice) * p.qty;
    const pnlPct = (dir * (p.markPrice - p.entryPrice) / Math.max(p.entryPrice, 1e-9)) * 100;

    // attribution (approximation with entry greeks over the realized moves)
    const dSpot = spot - entrySpot;
    const dIvPts = entryIv != null && curIv != null ? (curIv - entryIv) * 100 : null;
    const deltaPnl = entryGreeks ? entryGreeks.positionDelta * dSpot : 0;
    const vegaPnl = entryGreeks && dIvPts != null ? entryGreeks.vega * p.qty * dIvPts : 0;
    const thetaPnl = entryGreeks ? entryGreeks.theta * p.qty * daysHeld : 0;
    const residualPnl = uPnl - deltaPnl - vegaPnl - thetaPnl;

    // risk metrics
    const atr = ctx?.technicals?.atr14 ?? null;
    const breakeven = p.kind === 'call' ? p.strike + p.entryPrice : p.strike - p.entryPrice;
    const distBE = Math.abs(spot - breakeven);
    const distK = Math.abs(spot - p.strike);
    const thetaBleed =
      curGreeks != null && p.markPrice > 0
        ? Math.abs(curGreeks.theta * p.qty) / (p.side === 'long' ? p.markPrice : Math.max(p.entryPrice, 1e-9)) * 100
        : null;
    const pItm = curIv != null ? probItm(spot, p.strike, tNow, curIv, p.kind) : null;
    const pTouch =
      curIv != null && dte > 0
        ? clamp(probTouch(spot, breakeven, curIv, dte) * 100, 0, 100)
        : null;

    // market alignment
    const alignment = alignmentScoreFor(curGreeks?.positionDelta ?? entryGreeks?.positionDelta ?? null, ctx);
    const fundingTailwind =
      ctx?.fundingRate != null && curGreeks != null
        ? Math.sign(curGreeks.positionDelta) !== 0 && Math.sign(ctx.fundingRate) === Math.sign(curGreeks.positionDelta)
        : null;

    // settings + triggers (per-position override wins over the global default)
    const settings = resolveSettings(p.id);
    const settingsSource: 'position' | 'global' = p.id in settingsOverrides ? 'position' : 'global';
    const triggers = evaluateTriggers(
      {
        pnlPct,
        dte,
        daysHeld,
        probItmPct: pItm != null ? pItm * 100 : 50,
        side: p.side,
        thetaBleedPctPerDay: thetaBleed,
        ivMovePts: dIvPts,
        alignmentScore: alignment,
      },
      settings,
    );

    const health = healthScoreFor({
      pnlPct,
      alignment,
      thetaBleed,
      probItm: pItm != null ? pItm * 100 : null,
      side: p.side,
      dte,
      ivMovePts: dIvPts,
      positionVega: curGreeks?.vega ?? null,
      triggers,
    });
    const decision = decideForPosition({
      triggers,
      health,
      dte,
      pnlPct,
      alignment,
      probItm: pItm != null ? pItm * 100 : null,
      side: p.side,
      daysHeld,
    });

    return {
      positionId: p.id,
      instrument: `${p.asset} ${p.expiry} ${p.strike} ${p.kind.toUpperCase()}`,
      venue: p.venue,
      asset: p.asset,
      kind: p.kind,
      side: p.side,
      qty: p.qty,
      strike: p.strike,
      expiry: p.expiry,
      expiryMs: p.expiryMs,
      dte: +dte.toFixed(1),
      daysHeld: +daysHeld.toFixed(1),
      strategyTag: p.strategyTag ?? null,
      entry: {
        price: +p.entryPrice.toFixed(2),
        spot: +entrySpot.toFixed(2),
        ivPct: round(entryIv != null ? entryIv * 100 : null, 1),
        greeks: entryGreeks,
      },
      current: {
        mark: +p.markPrice.toFixed(2),
        spot: +spot.toFixed(2),
        ivPct: round(curIv != null ? curIv * 100 : null, 1),
        greeks: curGreeks,
        probItmPct: round(pItm != null ? pItm * 100 : null, 1),
        quoteSource: q?.quoteSource ?? null,
      },
      pnl: {
        unrealized: +uPnl.toFixed(2),
        pct: +pnlPct.toFixed(1),
        deltaPnl: +deltaPnl.toFixed(2),
        vegaPnl: +vegaPnl.toFixed(2),
        thetaPnl: +thetaPnl.toFixed(2),
        residualPnl: +residualPnl.toFixed(2),
      },
      risk: {
        thetaBleedPctPerDay: round(thetaBleed, 2),
        breakeven: +breakeven.toFixed(2),
        distanceToBreakevenAtr: atr != null && atr > 0 ? +(distBE / atr).toFixed(2) : null,
        distanceToStrikeAtr: atr != null && atr > 0 ? +(distK / atr).toFixed(2) : null,
        probTouchBreakevenPct: round(pTouch, 1),
        moneynessPct: +(((spot - p.strike) / p.strike) * 100).toFixed(2),
        marginHeld: +p.marginHeld.toFixed(2),
        notionalUsd: +(spot * p.qty).toFixed(2),
      },
      market: {
        alignmentScore: alignment,
        alignmentLabel: alignmentLabel(alignment),
        ivMovePts: round(dIvPts, 1),
        fundingTailwind,
      },
      settings,
      settingsSource,
      triggers,
      decision,
    };
  });

  // --- portfolio rollup -----------------------------------------------------------------
  const byAsset: PortfolioRollup['netGreeks']['byAsset'] = {};
  let totDelta = 0,
    totGamma = 0,
    totVega = 0,
    totTheta = 0,
    totDeltaUsd = 0;
  let down1Atr = 0,
    up1Atr = 0;
  const decisionCounts: Partial<Record<PositionAction, number>> = {};
  let critical = 0,
    warn = 0,
    info = 0;

  for (const i of intel) {
    const g = i.current.greeks ?? i.entry.greeks;
    const slot =
      byAsset[i.asset] ?? { delta: 0, deltaUsd: 0, gamma: 0, vega: 0, theta: 0, positionCount: 0, exposureUsd: 0 };
    if (g) {
      slot.delta += g.positionDelta;
      slot.deltaUsd += g.positionDelta * i.current.spot;
      slot.gamma += g.gamma * i.qty;
      slot.vega += g.vega * i.qty;
      slot.theta += g.theta * i.qty;
      totDelta += g.positionDelta;
      totDeltaUsd += g.positionDelta * i.current.spot;
      totGamma += g.gamma * i.qty;
      totVega += g.vega * i.qty;
      totTheta += g.theta * i.qty;
      // ±1 ATR stress (gamma-adjusted quadratic)
      const atrEst =
        i.risk.distanceToStrikeAtr != null && i.risk.distanceToStrikeAtr > 0
          ? Math.abs(i.current.spot - i.strike) / i.risk.distanceToStrikeAtr
          : null;
      if (atrEst != null && atrEst > 0) {
        for (const ds of [-atrEst, atrEst]) {
          const pnl = g.positionDelta * ds + 0.5 * (g.gamma * i.qty) * ds * ds;
          if (ds < 0) down1Atr += pnl;
          else up1Atr += pnl;
        }
      }
    }
    slot.positionCount += 1;
    slot.exposureUsd += i.risk.notionalUsd;
    byAsset[i.asset] = slot;
    decisionCounts[i.decision.action] = (decisionCounts[i.decision.action] ?? 0) + 1;
    for (const t of i.triggers) {
      if (t.level === 'critical') critical += 1;
      else if (t.level === 'warn') warn += 1;
      else info += 1;
    }
  }
  for (const a of Object.values(byAsset)) {
    a.delta = +a.delta.toFixed(4);
    a.deltaUsd = +a.deltaUsd.toFixed(0);
    a.gamma = +a.gamma.toFixed(5);
    a.vega = +a.vega.toFixed(2);
    a.theta = +a.theta.toFixed(2);
    a.exposureUsd = +a.exposureUsd.toFixed(0);
  }

  const marginUtil = account.marginHeld > 0 ? (account.marginHeld / Math.max(account.equity, 1)) * 100 : 0;

  if (positions.length === 0) notes.push('No open paper positions — intelligence panel shows the live market context only.');
  if (market.some((c) => !c.technicals)) notes.push('Technical context partially unavailable (feeds warming up) — metrics that need it are shown as “—”.');

  return {
    tsMs: now,
    source: marketDataSource(),
    market,
    positions: intel,
    portfolio: {
      equity: account.equity,
      unrealized: account.unrealized,
      marginHeld: account.marginHeld,
      buyingPower: account.buyingPower,
      marginUtilizationPct: +marginUtil.toFixed(1),
      netGreeks: {
        total: {
          delta: +totDelta.toFixed(4),
          deltaUsd: +totDeltaUsd.toFixed(0),
          gamma: +totGamma.toFixed(5),
          vega: +totVega.toFixed(2),
          theta: +totTheta.toFixed(2),
        },
        byAsset,
      },
      stress: { down1AtrPnl: +down1Atr.toFixed(0), up1AtrPnl: +up1Atr.toFixed(0) },
      alerts: { critical, warn, info },
      decisionCounts,
    },
    notes,
  };
}

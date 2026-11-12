// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · signals — the DECISION-SUPPORT engine.
//
// Turns every live metric the native engine computes (dealer gamma levels, IV
// surface, VRP, skew, term shape, funding, OI, CVD, tape flow, liquidation
// magnets) into an actionable signal battery with a composite regime score,
// a strategy playbook with concrete numbers, and a watchlist of levels that
// matter. This is the layer that answers "what should I do right now" —
// the reason no other analytics platform is needed.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '@/lib/db';
import { getChainSnapshot } from './engine';
import { getPerpBundle, probTouch } from './perps';
import { ensureTape, tapeAggregates } from './tape';
import { historicalVolatility } from './deribit';
import type { QuantSymbol } from './types';

const YEAR_MS = 365 * 24 * 3600 * 1000;

export type SignalState = 'bullish' | 'bearish' | 'neutral' | 'extreme-bullish' | 'extreme-bearish';

export interface Signal {
  id: string;
  group: 'Gamma' | 'Volatility' | 'Flow' | 'Perps' | 'Structure';
  title: string;
  state: SignalState;
  strength: number; // 0..100 conviction
  weight: number; // contribution weight to the regime score
  headline: string;
  detail: string;
  action: string;
}

export interface Playbook {
  id: string;
  title: string;
  setup: string;
  rationale: string;
  confidence: number; // 0..1
  tags: string[];
}

export interface WatchLevel {
  id: string;
  label: string;
  price: number | null;
  kind: 'price' | 'metric';
  distancePct: number | null;
  note: string;
  tone: 'teal' | 'rose' | 'amber' | 'violet' | 'zinc';
}

export interface DecisionBrief {
  symbol: string;
  asOf: number;
  spot: number;
  regimeScore: number; // −100..+100
  regimeLabel: string;
  volBias: 'expansion' | 'compression' | 'balanced';
  signals: Signal[];
  playbook: Playbook[];
  watchlist: WatchLevel[];
  drivers: { label: string; contribution: number }[];
  context: { ivRank: number | null; ivWindowDays: number; ivPoints: number; fundingPctile: number | null; snapshots: number };
  notes: string[];
}

function pctile(sorted: number[], v: number): number {
  if (!sorted.length) return NaN;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return (lo / sorted.length) * 100;
}

function slopePct(pts: { ts: number; v: number }[]): number {
  if (pts.length < 4) return 0;
  const t0 = pts[0].ts;
  const t1 = pts[pts.length - 1].ts || 1;
  const dt = (t1 - t0) || 1;
  // normalized regression slope: % change of v over window per unit time → just first-vs-last in %
  const a = pts[0].v;
  const b = pts[pts.length - 1].v;
  if (!(a > 0) || !Number.isFinite(b)) return 0;
  return ((b - a) / a) * 100;
}

/** The full decision brief for one symbol. */
export async function decisionBrief(symbol: QuantSymbol): Promise<DecisionBrief> {
  const t0 = Date.now();
  const hasOpts = symbol === 'BTC' || symbol === 'ETH';
  const [perp, snap] = await Promise.all([
    getPerpBundle(symbol),
    hasOpts ? getChainSnapshot(symbol).catch(() => null) : Promise.resolve(null),
  ]);
  if (hasOpts && snap) ensureTape(symbol);
  const tape = hasOpts && snap ? await tapeAggregates(symbol, 12).catch(() => null) : null;

  const spot = snap?.spot ?? perp.spot;
  const signals: Signal[] = [];
  const notes: string[] = [];
  if (!snap) notes.push(`${symbol}: no options chain on free venues — perp/flow signals only`);

  // ── snapshot-history context (IV rank, funding percentile) ─────────────────
  let ivSeries: { ts: number; iv: number }[] = [];
  if (hasOpts) {
    try {
      const rows = await db.quantSnapshot.findMany({
        where: { symbol, ts: { gte: new Date(Date.now() - 30 * 864e5) }, atmIv30: { not: null } },
        orderBy: { ts: 'asc' },
        take: 8000,
      });
      ivSeries = rows.map((r) => ({ ts: r.ts.getTime(), iv: r.atmIv30 as number }));
    } catch {
      /* db unavailable — IV rank degrades to null */
    }
  }
  const ivVals = ivSeries.map((p) => p.iv).filter(Number.isFinite);
  const ivSorted = [...ivVals].sort((a, b) => a - b);
  const ivCur = snap?.iv30vsRv30.iv30Pct ?? NaN;
  const ivRank = ivSorted.length >= 12 && Number.isFinite(ivCur) ? pctile(ivSorted, ivCur) : null;
  const fundingRates = perp.fundingHist.map((f) => f.rate);
  const fundingCur = perp.fundingRate;
  const fundingPctile = fundingRates.length >= 8 ? pctile([...fundingRates].sort((a, b) => a - b), fundingCur) : null;

  // ══ GAMMA GROUP ═══════════════════════════════════════════════════════════
  if (snap) {
    const lv = snap.levels;
    const gexMag = Math.abs(lv.totalGexUsd1pct);
    const gexRelOi = snap.totalOiUsd > 0 ? gexMag / snap.totalOiUsd : 0; // per-1% exposure vs notional
    const longG = lv.totalGexUsd1pct >= 0;
    signals.push({
      id: 'gamma-regime',
      group: 'Gamma',
      title: 'Dealer Gamma Regime',
      state: longG ? 'bullish' : 'bearish',
      strength: Math.min(100, 30 + gexRelOi * 350),
      weight: 0.2,
      headline: `${longG ? 'LONG' : 'SHORT'} gamma · ${gexRelOi.toFixed(1)}% of OI per 1% move`,
      detail: longG
        ? `Net dealer gamma +$${Math.round(gexMag / 1e6)}M per 1% — dealers hedge AGAINST the move (sell rallies, buy dips), damping realized range and pinning price toward max pain ${lv.maxPain ? Math.round(lv.maxPain).toLocaleString() : '—'}.`
        : `Net dealer gamma −$${Math.round(gexMag / 1e6)}M per 1% — dealer hedening AMPLIFIES moves. Below the HVL flip ${lv.hvl ? Math.round(lv.hvl).toLocaleString() : '—'} expect acceleration, not mean reversion.`,
      action: longG
        ? 'Favor mean-reversion: sell premium / fade range extremes toward max pain; keep straddle-buying small.'
        : 'Favor trend continuation: buy wings / stop-and-reverse; avoid naked short gamma near the flip.',
    });

    if (lv.hvl) {
      const distPct = ((spot - lv.hvl) / lv.hvl) * 100;
      const nearFlip = Math.abs(distPct) <= 1.2;
      signals.push({
        id: 'hvl-distance',
        group: 'Gamma',
        title: 'Distance to Gamma Flip (HVL)',
        state: nearFlip ? (distPct >= 0 ? 'extreme-bullish' : 'extreme-bearish') : distPct >= 0 ? 'bullish' : 'bearish',
        strength: nearFlip ? 85 : Math.max(15, 60 - Math.abs(distPct) * 8),
        weight: 0.12,
        headline: `${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}% ${distPct >= 0 ? 'above' : 'below'} HVL ${Math.round(lv.hvl).toLocaleString()}`,
        detail: nearFlip
          ? `Spot is trading ON the volatility trigger. One close through ${Math.round(lv.hvl).toLocaleString()} flips the whole dealer book ${distPct >= 0 ? 'short→long' : 'long→short'} — expect a volatility regime change at this level.`
          : `The zero-gamma pivot sits ${Math.abs(distPct).toFixed(1)}% ${distPct >= 0 ? 'below' : 'above'} — while spot stays ${distPct >= 0 ? 'above' : 'below'} it, ${distPct >= 0 ? 'the damping regime holds' : 'hedging flows accelerate moves'}.`,
        action: distPct >= 0 ? `Longs: place stops below ${Math.round(lv.hvl).toLocaleString()} (flip level) — losing it changes the regime.` : `Bears: a reclaim of ${Math.round(lv.hvl).toLocaleString()} re-arms dealer damping — respect it as resistance-turned-support.`,
      });
    }

    const front = snap.expiries[0];
    if (front && front.maxPain > 0) {
      const T = Math.max(front.expiryTs - Date.now(), 3600_000) / YEAR_MS;
      const sigma = front.atmIv > 0 ? front.atmIv : NaN;
      const distSig = Number.isFinite(sigma) ? (spot - front.maxPain) / (spot * sigma * Math.sqrt(T)) : NaN;
      if (Number.isFinite(distSig) && Math.abs(distSig) < 1.1) {
        signals.push({
          id: 'max-pain-pin',
          group: 'Gamma',
          title: 'Max-Pain Pin Gravity',
          state: 'neutral',
          strength: Math.round(Math.max(0, 90 - Math.abs(distSig) * 80)),
          weight: 0.05,
          headline: `${Math.abs(distSig).toFixed(2)}σ from front-expiry max pain ${Math.round(front.maxPain).toLocaleString()}`,
          detail: `${front.expiry} (${front.dte.toFixed(1)}d out) settles into the strike minimizing total option payouts. Dealers defending ${Math.round(front.maxPain).toLocaleString()} drag price as expiry approaches when gamma is long.`,
          action: `Into ${front.expiry} 08:00 UTC: short straddle at ${Math.round(front.maxPain).toLocaleString()} is the classic pin expression; exit before the last hours if spot breaks ±0.5σ.`,
        });
      }
    }

    if (lv.callWall) {
      const d = ((lv.callWall - spot) / spot) * 100;
      if (d < 3) {
        signals.push({
          id: 'call-wall',
          group: 'Gamma',
          title: 'Call-Wall Resistance',
          state: d < 1 ? 'extreme-bearish' : 'bearish',
          strength: Math.round(Math.max(20, 75 - d * 20)),
          weight: 0.08,
          headline: `wall ${Math.round(lv.callWall).toLocaleString()} · +${d.toFixed(2)}% above spot`,
          detail: `Largest net call-gamma strike: dealer selling into rallies here caps upside. Breaks ABOVE flip it to an accelerator (short-squeeze fuel), but rejections are the base case while spot is below.`,
          action: `Treat ${Math.round(lv.callWall).toLocaleString()} as profit-taking for longs / premium-selling strike for calls; flip bias only on a sustained break above.`,
        });
      }
    }
    if (lv.putSupport) {
      const d = ((spot - lv.putSupport) / spot) * 100;
      if (d < 3) {
        signals.push({
          id: 'put-support',
          group: 'Gamma',
          title: 'Put-Support Floor',
          state: d < 1 ? 'extreme-bullish' : 'bullish',
          strength: Math.round(Math.max(20, 75 - d * 20)),
          weight: 0.08,
          headline: `support ${Math.round(lv.putSupport).toLocaleString()} · ${d.toFixed(2)}% below spot`,
          detail: `Largest net put-gamma strike: dealer buying on dips builds a floor. Losing it removes the biggest bid-shield in the market.`,
          action: `Dips into ${Math.round(lv.putSupport).toLocaleString()} are buyable while it holds; a close below = de-risk, floor is gone.`,
        });
      }
    }
  }

  // ══ VOLATILITY GROUP ═════════════════════════════════════════════════════
  if (snap) {
    if (ivRank != null) {
      const rank = Math.round(ivRank);
      const st: SignalState = rank >= 85 ? 'extreme-bearish' : rank >= 65 ? 'bearish' : rank <= 15 ? 'extreme-bullish' : rank <= 35 ? 'bullish' : 'neutral';
      signals.push({
        id: 'iv-rank',
        group: 'Volatility',
        title: 'IV Rank (own 30d history)',
        state: st,
        strength: Math.round(Math.abs(rank - 50) * 1.9),
        weight: 0.15,
        headline: `rank ${rank} of 100 · CM30 ${snap.iv30vsRv30.iv30Pct.toFixed(1)}%`,
        detail: `Our constant-maturity 30d IV sits in the ${rank}th percentile of its own last-30-day distribution (${ivSorted.length} snapshots; range ${Math.min(...ivSorted).toFixed(1)}–${Math.max(...ivSorted).toFixed(1)}%). ${rank >= 65 ? 'Options are EXPENSIVE vs recent norm — premium sellers have the statistical edge.' : rank <= 35 ? 'Options are CHEAP vs recent norm — premium buyers have the statistical edge.' : 'Vol is mid-range — neither side has a pricing edge.'}`,
        action: rank >= 65 ? 'Bias to net-short-vol structures (condors, credit spreads, covered calls); avoid paying outright vega.' : rank <= 35 ? 'Bias to net-long-vol (straddles, calendars, debit flies) while vol is cheap.' : 'Play gamma/theta, not vega: direction-neutral structures sized to the expected move.',
      });
    }

    const vrp = snap.iv30vsRv30.vrpPct;
    if (Number.isFinite(vrp)) {
      const st: SignalState = vrp >= 6 ? 'extreme-bearish' : vrp >= 2.5 ? 'bearish' : vrp <= -3 ? 'extreme-bullish' : vrp <= -1 ? 'bullish' : 'neutral';
      signals.push({
        id: 'vrp',
        group: 'Volatility',
        title: 'Variance Risk Premium',
        state: st,
        strength: Math.min(100, Math.abs(vrp) * 12 + 15),
        weight: 0.1,
        headline: `VRP ${vrp >= 0 ? '+' : ''}${vrp.toFixed(1)} pts (IV ${snap.iv30vsRv30.iv30Pct.toFixed(1)}% vs RV ${snap.iv30vsRv30.rv30Pct.toFixed(1)}%)`,
        detail: `${vrp >= 0 ? `Implied is running ${vrp.toFixed(1)} points ABOVE realized — the market pays a premium for insurance that has not (yet) been needed.` : `Implied is ${Math.abs(vrp).toFixed(1)} points BELOW realized — options are priced UNDER how the market actually moved. This is statistically unusual and mean-reverts.`}`,
        action: vrp >= 2.5 ? 'Sell the richness: credit structures / short strangles with hard stops at the flip level.' : vrp <= -1 ? 'Buy realized before it reprices: long straddle/strangle, or long front / short back calendar.' : 'VRP is mid-range — vol pricing is fair, no statistical edge either way.',
      });
    }

    const front = snap.expiries[0];
    const cm30 = snap.iv30vsRv30.iv30Pct;
    if (front && Number.isFinite(cm30) && Number.isFinite(front.atmIvPct)) {
      const shape = front.atmIvPct - cm30;
      if (Math.abs(shape) >= 1.5) {
        const backwardation = shape > 0;
        signals.push({
          id: 'term-shape',
          group: 'Volatility',
          title: 'Vol Term-Structure Shape',
          state: backwardation ? 'bearish' : 'bullish',
          strength: Math.min(90, 25 + Math.abs(shape) * 12),
          weight: 0.06,
          headline: `${backwardation ? 'BACKWARDATION' : 'CONTANGO'} · front ${front.atmIvPct.toFixed(1)}% vs 30d ${cm30.toFixed(1)}%`,
          detail: backwardation
            ? `Front expiries price ABOVE longer-dated vol — the market is paying up for immediate protection (event fear, spot weakness). Backwardation historically accompanies stress and mean-reverts.`
            : `Front expiries price BELOW longer-dated — calm now, long-dated insurance bid. The carry trade (sell near, buy far) works while this holds.`,
          action: backwardation
            ? 'Do NOT chase buying front vol — it is already rich; if positioned long vol, roll to the cheap back months.'
            : 'Calendars (long back / short front) harvest the term spread; close before events that re-flatten it.',
        });
      }
    }

    const rr25 = front?.rr25 ?? NaN;
    if (front && Number.isFinite(rr25)) {
      const st: SignalState = rr25 >= 8 ? 'extreme-bearish' : rr25 >= 4.5 ? 'bearish' : rr25 <= 0.5 ? 'extreme-bullish' : rr25 <= 2 ? 'bullish' : 'neutral';
      signals.push({
        id: 'skew',
        group: 'Volatility',
        title: '25Δ Put Skew',
        state: st,
        strength: Math.min(95, 20 + Math.abs(rr25 - 3) * 11),
        weight: 0.07,
        headline: `RR25 ${rr25.toFixed(1)} pts · ${rr25 > 4.5 ? 'puts rich' : rr25 < 1.5 ? 'calls bid / puts cheap' : 'normal'}`,
        detail: `Front-expiry 25Δ risk reversal (${front.expiry}). ${rr25 >= 4.5 ? `Downside protection is bid — hedgers dominate. Historically extreme put skew marks local bottoms when spot stabilizes.` : rr25 <= 1.5 ? `Upside calls are favored vs puts — greed positioning; cheap crash insurance while it lasts.` : 'Skew near its typical mid.'}`,
        action: rr25 >= 4.5 ? 'Skew harvest: sell the rich put wing (risk reversal / put credit spread), keep size small — skew can go richer.' : rr25 <= 1.5 ? 'Cheap tail insurance: buy the neglected put wing or 1x2 call spreads while calls are the bid side.' : 'Skew mid-range — no wing is statistically mispriced; trade the body if anything.',
      });
    }
  }

  // ══ PERPS GROUP ══════════════════════════════════════════════════════════
  {
    const apr = perp.fundingApr * 100;
    const st: SignalState = fundingPctile != null && fundingPctile >= 90 ? 'extreme-bearish' : fundingPctile != null && fundingPctile >= 70 ? 'bearish' : fundingPctile != null && fundingPctile <= 10 ? 'extreme-bullish' : fundingPctile != null && fundingPctile <= 30 ? 'bullish' : 'neutral';
    signals.push({
      id: 'funding',
      group: 'Perps',
      title: 'Funding & Crowding',
      state: st,
      strength: fundingPctile != null ? Math.round(Math.abs(fundingPctile - 50) * 1.8) : 25,
      weight: 0.12,
      headline: `APR ${apr >= 0 ? '+' : ''}${apr.toFixed(1)}% · ${fundingPctile != null ? `${Math.round(fundingPctile)}th pctile of own 3d history` : 'no history yet'}`,
      detail: `${perp.fundingRate >= 0 ? 'Longs pay shorts' : 'Shorts pay longs'} — ${Math.abs(apr) >= 25 ? 'crowding is EXTREME; funding this one-sided fuels squeezes/flushes' : Math.abs(apr) >= 8 ? 'positioning is stretched' : 'positioning is balanced'}. Perp basis ${(perp.perpBasisPct * 100).toFixed(2)}% vs index.`,
      action: apr >= 25 ? 'Carry: short perp / long spot or dated future collects the squeeze premium; contrarian bullish signal for spot after a flush.' : apr <= -20 ? 'Counter-carry: long perp / short spot; shorts paying this much usually unwind upward.' : 'Funding not extreme — no carry edge; use it only as a confirmation filter.',
    });

    // OI momentum
    const oi24 = perp.oiHist.length > 8 ? perp.oiHist.slice(-Math.min(perp.oiHist.length, 288)) : perp.oiHist;
    if (oi24.length > 4) {
      const oiChg = ((oi24[oi24.length - 1].oiUsd - oi24[0].oiUsd) / (oi24[0].oiUsd || 1)) * 100;
      const pxChg = slopePct(perp.candles.map((c) => ({ ts: c.ts, v: c.c })));
      let st: SignalState = 'neutral';
      let detail = '';
      if (oiChg > 2 && pxChg > 0.3) {
        st = 'bearish';
        detail = `Fresh longs are driving price up — rally is LEVERAGED and unwind-prone.`;
      } else if (oiChg > 2 && pxChg < -0.3) {
        st = 'bullish';
        detail = `Fresh shorts pressing price down — flush fuel; squeezes get violent with this positioning.`;
      } else if (oiChg < -2) {
        st = pxChg < 0 ? 'bearish' : 'neutral';
        detail = `Open interest is unwinding (deleveraging) — moves are positioning-driven, not conviction.`;
      } else {
        detail = `OI ${oiChg >= 0 ? 'building' : 'flat-to-lower'} with price ${pxChg >= 0 ? 'up' : 'down'} — no crowding signature.`;
      }
      signals.push({
        id: 'oi-momentum',
        group: 'Perps',
        title: 'OI Momentum vs Price',
        state: st,
        strength: Math.min(80, 20 + Math.abs(oiChg) * 5 + Math.abs(pxChg) * 2),
        weight: 0.08,
        headline: `24h OI ${oiChg >= 0 ? '+' : ''}${oiChg.toFixed(1)}% · price ${pxChg >= 0 ? '+' : ''}${pxChg.toFixed(1)}%`,
        detail,
        action: oiChg > 2 && pxChg < -0.3 ? 'Favor squeeze setups: buy dips with stops below the liquidation magnet; shorts are crowded.' : oiChg > 2 && pxChg > 0.3 ? 'Trail stops on longs — leveraged longs unwind fast through the long-liq magnet.' : 'No positioning edge from OI right now.',
      });
    }

    // CVD divergence
    if (perp.cvd.length > 8) {
      const cvdChg = perp.cvd[perp.cvd.length - 1].cvdUsd - perp.cvd[0].cvdUsd;
      const pxChg = slopePct(perp.candles.map((c) => ({ ts: c.ts, v: c.c })));
      const diverge = (pxChg > 0.25 && cvdChg < 0) || (pxChg < -0.25 && cvdChg > 0);
      signals.push({
        id: 'cvd-divergence',
        group: 'Perps',
        title: 'Aggressor Flow (CVD) vs Price',
        state: diverge ? (pxChg > 0 ? 'bearish' : 'bullish') : (cvdChg > 0 ? 'bullish' : cvdChg < 0 ? 'bearish' : 'neutral'),
        strength: diverge ? 65 : 35,
        weight: 0.1,
        headline: `CVD ${cvdChg >= 0 ? '+' : ''}$${(Math.abs(cvdChg) / 1e6).toFixed(1)}M vs price ${pxChg >= 0 ? '+' : ''}${pxChg.toFixed(1)}%${diverge ? ' · DIVERGENCE' : ''}`,
        detail: diverge
          ? pxChg > 0
            ? 'Price rising while cumulative aggressive BUYING is negative — rallies are being sold into: distribution signature.'
            : 'Price falling while cumulative aggressive SELLING is positive — dips are being absorbed: accumulation signature.'
          : 'Flow and price agree — no divergence edge.',
        action: diverge ? (pxChg > 0 ? 'Trust the flow over the price: tighten long stops / consider taking profit into strength.' : 'Accumulation signature — buy pullbacks with flow confirmation.') : 'No action from flow.',
      });
    }

    // Liquidation magnets
    const above = perp.liquidationClusters.filter((c) => c.price > spot && c.side === 'long').sort((a, b) => a.price - b.price)[0];
    const below = perp.liquidationClusters.filter((c) => c.price < spot && c.side === 'short').sort((a, b) => b.price - a.price)[0];
    if (above || below) {
      const dA = above ? ((above.price - spot) / spot) * 100 : null;
      const dB = below ? ((below.price - spot) / spot) * 100 : null;
      const nearest = Math.min(Math.abs(dA ?? 99), Math.abs(dB ?? 99));
      const st: SignalState = nearest <= 1.5 ? (dA != null && Math.abs(dA) <= 1.5 ? 'extreme-bearish' : 'extreme-bullish') : 'neutral';
      signals.push({
        id: 'liq-magnet',
        group: 'Perps',
        title: 'Liquidation Magnets',
        state: st,
        strength: st === 'neutral' ? 30 : 80,
        weight: 0.07,
        headline: `${above ? `long-ladder ${dA?.toFixed(1)}% above` : '—'} · ${below ? `short-ladder ${Math.abs(dB ?? 0).toFixed(1)}% below` : '—'}`,
        detail: `Model-estimated forced-liquidation buildups (OI × leverage tiers). ${above ? `${fmtM(above.notionalUsd)} of long liquidation pressure sits at ${Math.round(above.price).toLocaleString()} (${above.leverage}× tier) — a magnet price gets PULLED toward. ` : ''}${below ? `${fmtM(below.notionalUsd)} of short liquidations at ${Math.round(below.price).toLocaleString()} fuel squeezes. ` : ''}${nearest <= 1.5 ? 'Spot is INSIDE the magnet zone — expect violent wicks.' : ''}`,
        action: nearest <= 1.5 ? 'Magnet active: reduce size / widen stops beyond the cluster price; wicks through these levels are mechanical, not directional.' : `Magnet levels: ${above ? Math.round(above.price).toLocaleString() + ' (above) ' : ''}${below ? Math.round(below.price).toLocaleString() + ' (below)' : ''} — place stops beyond them, not in front.`,
      });
    }
  }

  // ══ FLOW GROUP (options tape) ═══════════════════════════════════════════
  if (tape && tape.premiumUsd > 0) {
    const imb = tape.imbalance;
    const st: SignalState = imb >= 0.45 ? 'extreme-bullish' : imb >= 0.18 ? 'bullish' : imb <= -0.45 ? 'extreme-bearish' : imb <= -0.18 ? 'bearish' : 'neutral';
    signals.push({
      id: 'tape-imbalance',
      group: 'Flow',
      title: 'Options-Tape Aggression (12h)',
      state: st,
      strength: Math.min(90, Math.abs(imb) * 130 + (tape.whaleCount > 3 ? 15 : 0)),
      weight: 0.1,
      headline: `${(imb * 100).toFixed(0)}% net ${imb >= 0 ? 'BUY' : 'SELL'} · $${(tape.premiumUsd / 1e6).toFixed(1)}M premium · ${tape.whaleCount} whales`,
      detail: `Taker aggression in listed options over the last 12h across ${tape.prints} prints. ${imb >= 0 ? 'Buyers lifting offers — initiative is on the upside.' : 'Sellers hitting bids — initiative is on the downside.'} ${tape.whaleCount > 0 ? `${tape.whaleCount} prints ≥ $100k premium.` : ''}`,
      action: Math.abs(imb) >= 0.18 ? `Trade WITH the aggressors while |imbalance| stays >15%; fade only at gamma walls with confirmation.` : 'Flow is two-way — no initiative edge from the tape.',
    });

    const callShare = tape.callPremiumUsd / tape.premiumUsd;
    if (Number.isFinite(callShare) && (callShare > 0.72 || callShare < 0.28) && tape.premiumUsd > 2e6) {
      signals.push({
        id: 'tape-callshare',
        group: 'Flow',
        title: 'Calls vs Puts Premium Share',
        state: callShare > 0.72 ? 'bullish' : 'bearish',
        strength: 55,
        weight: 0.05,
        headline: `${(callShare * 100).toFixed(0)}% of premium is ${callShare > 0.72 ? 'CALLS' : 'PUTS'}`,
        detail: `Directional skew of traded premium over 12h. ${callShare > 0.72 ? 'Call-heavy tape: upside speculation/hedging dominates.' : 'Put-heavy tape: downside protection/speculation dominates.'}`,
        action: callShare > 0.72 ? 'Call-chasing tapes mark local euphoria — prefer call spreads over outright calls.' : 'Put-heavy tapes often mark fear peaks — favor risk reversals over naked puts.',
      });
    }
  }

  if (snap) {
    const pcr = snap.putCallRatioOi;
    if (Number.isFinite(pcr)) {
      const st: SignalState = pcr >= 1.15 ? 'bearish' : pcr <= 0.55 ? 'extreme-bullish' : pcr <= 0.7 ? 'bullish' : 'neutral';
      signals.push({
        id: 'pcr',
        group: 'Flow',
        title: 'Put/Call Open-Interest Ratio',
        state: st,
        strength: Math.min(70, Math.abs(pcr - 0.85) * 90),
        weight: 0.05,
        headline: `PCR ${pcr.toFixed(2)} · ${pcr >= 1 ? 'puts ≥ calls' : 'calls ≥ puts'} in OI`,
        detail: `${pcr >= 1.15 ? 'Unusually put-heavy open interest — either genuine hedging demand (bearish) or crowded insurance at a bottom (contrarian bullish).' : pcr <= 0.55 ? 'Extremely call-heavy positioning — greed; downside is unhedged.' : 'Balanced options positioning.'}`,
        action: pcr <= 0.55 ? 'With calls this crowded, own convexity via put spreads (cheap insurance against a de-greed event).' : pcr >= 1.15 ? 'Heavy hedging often precedes bottoms — combine with IV rank before fading.' : 'PCR is mid-range — positioning gives no edge.',
      });
    }
  }

  // ══ STRUCTURE GROUP ═════════════════════════════════════════════════════
  if (snap) {
    const em = snap.expectedMoves[0];
    const rv30Ref = snap.iv30vsRv30.rv30Pct; // Deribit 30d daily realized
    if (em && Number.isFinite(rv30Ref) && em.oneSigmaPct > 0) {
      const emAnn = em.oneSigmaPct / Math.sqrt(Math.max(em.dte, 0.2) / 365);
      const ratio = emAnn / (rv30Ref > 0 ? rv30Ref : NaN);
      if (Number.isFinite(ratio)) {
        signals.push({
          id: 'em-vs-rv',
          group: 'Structure',
          title: 'Priced Range vs Realized',
          state: ratio >= 1.6 ? 'bearish' : ratio <= 0.9 ? 'bullish' : 'neutral',
          strength: Math.min(70, Math.abs(ratio - 1.2) * 80),
          weight: 0.06,
          headline: `1σ ${em.oneSigmaPct.toFixed(2)}% by ${em.expiry} (${em.dte.toFixed(0)}d) vs RV30 ${rv30Ref.toFixed(1)}%`,
          detail: `The market prices a ${em.oneSigmaPct.toFixed(2)}% 1σ move by ${em.expiry}; annualized that is ${emAnn.toFixed(0)}% vs ${rv30Ref.toFixed(1)}% realized — implied range runs ${ratio >= 1 ? `${((ratio - 1) * 100).toFixed(0)}% richer` : `${((1 - ratio) * 100).toFixed(0)}% cheaper`} than spot has actually moved.`,
          action: ratio >= 1.6 ? 'Range is over-priced: iron condor / short strangle at the ±1σ strikes.' : ratio <= 0.9 ? 'Range is under-priced: straddle/strangle buys the cheap move.' : 'Priced range is fair vs realized — no range edge.',
        });
      }
    }
  }

  // ══ COMPOSITE REGIME SCORE ══════════════════════════════════════════════
  const stateScore: Record<SignalState, number> = { 'extreme-bullish': 1, bullish: 0.6, neutral: 0, bearish: -0.6, 'extreme-bearish': -1 };
  let wsum = 0;
  let raw = 0;
  const drivers: { label: string; contribution: number }[] = [];
  for (const s of signals) {
    const w = s.weight * (0.5 + (s.strength / 100) * 0.5);
    raw += stateScore[s.state] * w;
    wsum += s.weight;
    drivers.push({ label: `${s.group} · ${s.title}`, contribution: Math.round(stateScore[s.state] * w * 100) / 100 });
  }
  drivers.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const regimeScore = wsum > 0 ? Math.max(-100, Math.min(100, Math.round((raw / wsum) * 100))) : 0;
  const regimeLabel =
    regimeScore >= 45 ? 'RISK-ON' : regimeScore >= 18 ? 'CONSTRUCTIVE' : regimeScore > -18 ? 'TWO-WAY' : regimeScore > -45 ? 'DEFENSIVE' : 'RISK-OFF';

  // vol bias
  let volBias: DecisionBrief['volBias'] = 'balanced';
  if (snap) {
    const rich = (ivRank != null && ivRank >= 65) || (Number.isFinite(snap.iv30vsRv30.vrpPct) && snap.iv30vsRv30.vrpPct >= 3);
    const cheap = (ivRank != null && ivRank <= 35) || (Number.isFinite(snap.iv30vsRv30.vrpPct) && snap.iv30vsRv30.vrpPct <= -1);
    const shortG = snap.levels.totalGexUsd1pct < 0;
    volBias = rich && !shortG ? 'compression' : cheap || shortG ? 'expansion' : 'balanced';
  }

  // ══ PLAYBOOK (rule-based, all numbers concrete) ══════════════════════════
  const playbook: Playbook[] = [];
  const byId = new Map(signals.map((s) => [s.id, s]));
  if (snap) {
    const lv = snap.levels;
    const front = snap.expiries[0];
    if (ivRank != null && ivRank >= 65) {
      playbook.push({
        id: 'harvest-premium',
        title: 'Premium Harvest — Iron Condor',
        setup: `Sell ${front?.expiry} ${Math.round((front?.maxPain ?? snap.spot) * 0.94 / 100) * 100}-P / ${Math.round((front?.maxPain ?? snap.spot) * 1.06 / 100) * 100}-C, buy wings ±${snap.expectedMoves[0]?.oneSigmaPct.toFixed(1) ?? 5}% further out; size ≤ 5% of book.`,
        rationale: `IV rank ${Math.round(ivRank)} with VRP ${snap.iv30vsRv30.vrpPct.toFixed(1)} pts — options are rich vs both their own history AND realized moves${lv.totalGexUsd1pct >= 0 ? ', and dealers in long gamma pin the range' : ''}.`,
        confidence: Math.min(0.85, 0.5 + (ivRank - 65) / 100),
        tags: ['short-vol', 'mean-reversion', 'defined-risk'],
      });
    }
    if (ivRank != null && ivRank <= 35) {
      playbook.push({
        id: 'cheap-convexity',
        title: 'Cheap Convexity — Calendar',
        setup: `Buy 60–90d ${Math.round(snap.spot / 100) * 100} straddle, sell ${front?.expiry} same-strike straddle against it (long back / short front).`,
        rationale: `IV rank ${Math.round(ivRank)} — the cheapest decile of its own history. Long-dated vol retains the upside while the rich front decays into the pin.`,
        confidence: Math.min(0.8, 0.5 + (35 - ivRank) / 100),
        tags: ['long-vol', 'calendar', 'cheap'],
      });
    }
    const rr25 = front?.rr25 ?? NaN;
    if (Number.isFinite(rr25) && rr25 >= 6) {
      playbook.push({
        id: 'skew-harvest',
        title: 'Skew Harvest — Risk Reversal',
        setup: `Sell ${front?.expiry} 25Δ put, buy ${front?.expiry} 25Δ call (collects the ${rr25.toFixed(1)}pt skew), delta-hedge with a small perp short.`,
        rationale: `Put wing is rich (RR25 ${rr25.toFixed(1)} pts vs ~3 typical). You are PAID to hold upside while insurance is over-bid.`,
        confidence: Math.min(0.75, 0.4 + (rr25 - 6) / 20),
        tags: ['skew', 'risk-reversal', 'contrarian'],
      });
    }
    if (lv.totalGexUsd1pct < 0 && lv.hvl) {
      playbook.push({
        id: 'gamma-trigger',
        title: 'Gamma Trigger — Trend Ride',
        setup: `Buy ${front?.expiry} ~15–20Δ wings on BOTH sides (strangle), or buy spot with stop under ${Math.round(lv.hvl).toLocaleString()}; add on flips.`,
        rationale: `Dealers are SHORT $${Math.abs(Math.round(lv.totalGexUsd1pct / 1e6))}M gamma/1% — their hedging accelerates whichever way spot breaks the flip at ${Math.round(lv.hvl).toLocaleString()}.`,
        confidence: 0.55,
        tags: ['long-gamma', 'breakout', 'trend'],
      });
    }
    const pinSig = byId.get('max-pain-pin');
    if (pinSig && front) {
      playbook.push({
        id: 'expiry-pin',
        title: 'Expiry Pin — Short Straddle',
        setup: `Sell ${front.expiry} ATM ${Math.round(front.maxPain / 100) * 100} straddle into Friday 08:00 UTC settle; exit at T−2h.`,
        rationale: `Spot ${Math.abs((snap.spot - front.maxPain) / (snap.spot * (front.atmIv || 0.4) * Math.sqrt(Math.max(front.dte, 0.1) / 365))).toFixed(2)}σ from max pain with long dealer gamma — payout-minimizing gravity into settlement.`,
        confidence: 0.6,
        tags: ['0dte', 'pin', 'short-vol'],
      });
    }
  }
  {
    const fundSig = byId.get('funding');
    if (fundSig && perp.fundingApr >= 0.25) {
      playbook.push({
        id: 'carry-short-perp',
        title: 'Carry — Short Perp / Long Spot',
        setup: `Short ${symbol} perp, long equivalent spot (or dated future); collect ${(perp.fundingApr * 100).toFixed(0)}% APR funding.`,
        rationale: `Funding in the ${Math.round(fundingPctile ?? 70)}th percentile — longs are paying up; the carry is the squeeze insurance premium paid to you.`,
        confidence: 0.6,
        tags: ['carry', 'delta-neutral', 'perps'],
      });
    } else if (fundSig && perp.fundingApr <= -0.2) {
      playbook.push({
        id: 'carry-long-perp',
        title: 'Counter-Carry — Long Perp',
        setup: `Long ${symbol} perp vs short dated future; shorts are paying you ${(Math.abs(perp.fundingApr) * 100).toFixed(0)}% APR.`,
        rationale: `Deeply negative funding marks crowded shorts — historically squeeze territory.`,
        confidence: 0.55,
        tags: ['carry', 'squeeze', 'contrarian'],
      });
    }
    const liqSig = byId.get('liq-magnet');
    if (liqSig && liqSig.strength >= 80) {
      playbook.push({
        id: 'magnet-scalp',
        title: 'Magnet Wick Scalp',
        setup: `Work stops/limits BEYOND the magnet prices printed in the Liquidation panel (never in front); fade the wick after the cluster clears.`,
        rationale: liqSig.headline,
        confidence: 0.5,
        tags: ['liquidations', 'microstructure', 'scalp'],
      });
    }
    const cvdSig = byId.get('cvd-divergence');
    if (cvdSig && (cvdSig.state === 'bearish' || cvdSig.state === 'bullish') && cvdSig.strength >= 65) {
      playbook.push({
        id: 'flow-follow',
        title: `Flow-${cvdSig.state === 'bullish' ? 'Confirmed' : 'Distribution'} Positioning`,
        setup: cvdSig.state === 'bullish' ? 'Buy pullbacks with CVD confirming (aggressors net buyers); stop below the put-support / short-ladder magnet.' : 'Cut longs into strength; re-enter only after CVD turns up.',
        rationale: cvdSig.detail,
        confidence: 0.5,
        tags: ['flow', 'cvd', 'execution'],
      });
    }
  }
  playbook.sort((a, b) => b.confidence - a.confidence);

  // ══ WATCHLIST ═══════════════════════════════════════════════════════════
  const watchlist: WatchLevel[] = [];
  if (snap) {
    const lv = snap.levels;
    const pushLevel = (id: string, label: string, price: number | null, tone: WatchLevel['tone'], note: string) => {
      if (price == null || !Number.isFinite(price)) return;
      watchlist.push({ id, label, price, kind: 'price', distancePct: ((price - spot) / spot) * 100, note, tone });
    };
    pushLevel('hvl', 'gamma flip (HVL)', lv.hvl, 'teal', 'regime pivot — losing it flips dealer hedging');
    pushLevel('wall', 'call wall', lv.callWall, 'amber', 'largest call-gamma resistance');
    pushLevel('support', 'put support', lv.putSupport, 'rose', 'largest put-gamma floor');
    pushLevel('maxpain', 'max pain', lv.maxPain, 'violet', 'expiry gravity target');
    const above = perp.liquidationClusters.filter((c) => c.price > spot).sort((a, b) => a.price - b.price)[0];
    const below = perp.liquidationClusters.filter((c) => c.price < spot).sort((a, b) => b.price - a.price)[0];
    pushLevel('liq-up', 'long-liq magnet', above?.price ?? null, 'rose', `${fmtM(above?.notionalUsd ?? 0)} @ ${above?.leverage ?? ''}× — wick magnet above`);
    pushLevel('liq-dn', 'short-liq magnet', below?.price ?? null, 'teal', `${fmtM(below?.notionalUsd ?? 0)} — squeeze fuel below`);
    const em = snap.expectedMoves[0];
    if (em) {
      watchlist.push({ id: 'em-hi', label: `1σ hi (${em.expiry})`, price: em.rangeHigh, kind: 'price', distancePct: ((em.rangeHigh - spot) / spot) * 100, note: 'priced 1σ upper bound', tone: 'zinc' });
      watchlist.push({ id: 'em-lo', label: `1σ lo (${em.expiry})`, price: em.rangeLow, kind: 'price', distancePct: ((em.rangeLow - spot) / spot) * 100, note: 'priced 1σ lower bound', tone: 'zinc' });
    }
    if (ivRank != null) {
      watchlist.push({ id: 'iv-band', label: 'IV rank band', price: null, kind: 'metric', distancePct: null, note: `currently ${Math.round(ivRank)}/100 — crossing ${ivRank >= 50 ? '↓35 turns vol CHEAP (buy)' : '↑65 turns vol RICH (sell)'}`, tone: 'teal' });
    }
    watchlist.push({ id: 'funding-band', label: 'funding pctile', price: null, kind: 'metric', distancePct: null, note: fundingPctile != null ? `currently ${Math.round(fundingPctile)}/100 of own 3d — ≥90 squeeze risk, ≤10 flush risk` : 'collecting history…', tone: 'amber' });
  }

  void t0;
  return {
    symbol,
    asOf: Date.now(),
    spot,
    regimeScore,
    regimeLabel,
    volBias,
    signals: signals.sort((a, b) => Math.abs(stateScore[b.state] * b.strength) - Math.abs(stateScore[a.state] * a.strength)),
    playbook: playbook.slice(0, 5),
    watchlist,
    drivers: drivers.slice(0, 8),
    context: { ivRank: ivRank != null ? Math.round(ivRank) : null, ivWindowDays: 30, ivPoints: ivSorted.length, fundingPctile: fundingPctile != null ? Math.round(fundingPctile) : null, snapshots: ivSeries.length },
    notes,
  };
}

function fmtM(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `$${(v / 1e6).toFixed(1)}M`;
}

/** Probability spot touches a level before an expiry (for order-fill odds). */
export function fillProbability(spot: number, level: number, iv: number, days: number): number {
  return probTouch(spot, level, iv, days);
}

/** Realized-vol series accessor reused by the vol-regime panel. */
export async function rvSeries(symbol: string) {
  const hv = await historicalVolatility(symbol).catch(() => ({ v: [] as [number, number][], ts: Date.now() }));
  return hv.v;
}

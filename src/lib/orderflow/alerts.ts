// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — alert monitor (server-side, per client)
//
// Rules: VWAP cross · value-area edge · volume spike (σ) · block print ·
// CVD divergence · large liquidation · absorption · iceberg.
// Crossing rules wait for 50 session trades and re-fire at most once per
// cooldown. Adapted from the open-source order-flow-screener (Apache-2.0).
// ─────────────────────────────────────────────────────────────────────────────

import type { OrderFlowEngine } from './engine';
import type { OfAlertEvent, OfAlertSettings, OfLiquidation, OfMicroEvent, OfTrade } from './types';

export const DEFAULT_ALERT_SETTINGS: OfAlertSettings = {
  vwapCross: true,
  valueAreaEdge: true,
  volumeSpike: 3,
  blockPrint: 10,
  cvdDivergence: true,
  largeLiquidation: 250_000,
  absorption: true,
  iceberg: true,
};

const COOLDOWNS: Record<keyof OfAlertSettings, number> = {
  vwapCross: 60_000,
  valueAreaEdge: 60_000,
  volumeSpike: 30_000,
  blockPrint: 10_000,
  cvdDivergence: 60_000,
  largeLiquidation: 10_000,
  absorption: 60_000,
  iceberg: 60_000,
};

let alertSeq = 0;

/** Session value area from the engine's 1-minute footprint levels. */
function sessionValueArea(engine: OrderFlowEngine): { poc: number; vah: number; val: number } | null {
  const candles = engine.candlesFor(60_000);
  if (!candles.length) return null;
  const profile = new Map<number, number>();
  for (const c of candles) {
    for (const l of c.levels.values()) {
      profile.set(l.price, (profile.get(l.price) ?? 0) + l.bidVolume + l.askVolume);
    }
  }
  if (profile.size < 3) return null;
  const entries = [...profile.entries()].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let pocAt = 0;
  for (let i = 0; i < entries.length; i++) {
    total += entries[i][1];
    if (entries[i][1] > entries[pocAt][1]) pocAt = i;
  }
  let lo = pocAt;
  let hi = pocAt;
  let inside = entries[pocAt][1];
  while (inside < total * 0.7 && (lo > 0 || hi < entries.length - 1)) {
    const below = lo > 0 ? entries[lo - 1][1] : -1;
    const above = hi < entries.length - 1 ? entries[hi + 1][1] : -1;
    if (above >= below) inside += entries[++hi][1];
    else inside += entries[--lo][1];
  }
  return { poc: entries[pocAt][0], vah: entries[hi][0], val: entries[lo][0] };
}

export interface AlertContext {
  engine: OrderFlowEngine;
  now: number;
  newTrades: OfTrade[];
  newLiquidations: OfLiquidation[];
  newMicro: OfMicroEvent[];
}

export class AlertMonitor {
  settings: OfAlertSettings;
  private lastFired = new Map<string, number>();
  private vwapSide: 'above' | 'below' | null = null;
  private divergence: 'bullish' | 'bearish' | null = null;

  constructor(settings?: Partial<OfAlertSettings>) {
    this.settings = { ...DEFAULT_ALERT_SETTINGS, ...(settings ?? {}) };
  }

  private fire(rule: string, title: string, detail: string | undefined, severity: OfAlertEvent['severity'], now: number): OfAlertEvent | null {
    const cooldown = COOLDOWNS[rule as keyof OfAlertSettings] ?? 30_000;
    const last = this.lastFired.get(rule) ?? 0;
    if (now - last < cooldown) return null;
    this.lastFired.set(rule, now);
    return { id: `alert-${++alertSeq}`, rule, title, detail, tsMs: now, severity };
  }

  evaluate(ctx: AlertContext): OfAlertEvent[] {
    const { engine, now, newTrades, newLiquidations, newMicro } = ctx;
    const stats = engine.sessionStats();
    const out: OfAlertEvent[] = [];

    // VWAP cross — needs ≥50 session trades
    if (this.settings.vwapCross && stats.trades >= 50 && stats.vwap > 0 && stats.last > 0) {
      const side: 'above' | 'below' = stats.last > stats.vwap ? 'above' : 'below';
      if (this.vwapSide && this.vwapSide !== side) {
        const e = this.fire(
          'vwapCross',
          `VWAP cross — price now ${side} session VWAP`,
          `${side === 'above' ? ' reclaimed' : ' lost'} ${stats.vwap.toFixed(2)} · last ${stats.last.toFixed(2)}`,
          'warn',
          now,
        );
        if (e) out.push(e);
      }
      this.vwapSide = side;
    }

    // Value-area edge
    if (this.settings.valueAreaEdge) {
      const va = sessionValueArea(engine);
      if (va && stats.last > 0) {
        const outside = stats.last > va.vah ? 'above' : stats.last < va.val ? 'below' : 'inside';
        if (outside !== 'inside') {
          const e = this.fire(
            'valueAreaEdge',
            `Value-area ${outside === 'above' ? 'high' : 'low'} crossed`,
            `price ${stats.last.toFixed(2)} left the value area ${outside === 'above' ? `above VAH ${va.vah.toFixed(2)}` : `below VAL ${va.val.toFixed(2)}`} · POC ${va.poc.toFixed(2)}`,
            'warn',
            now,
          );
          if (e) out.push(e);
        }
      }
    }

    // Volume spike — completed 5-second bar's volume z-score
    if (this.settings.volumeSpike > 0) {
      const z = fiveSecondVolumeZ(engine);
      if (z !== null && z >= this.settings.volumeSpike) {
        const e = this.fire(
          'volumeSpike',
          `Volume spike — ${z.toFixed(1)}σ above recent flow`,
          `5-second flow bar z-score reached ${z.toFixed(1)}σ (threshold ${this.settings.volumeSpike}σ)`,
          'warn',
          now,
        );
        if (e) out.push(e);
      }
    }

    // Block print — at least N× the session average print
    if (this.settings.blockPrint > 0 && stats.averagePrint > 0) {
      let biggest: OfTrade | null = null;
      for (const t of newTrades) {
        if (t.quantity >= stats.averagePrint * this.settings.blockPrint) {
          if (!biggest || t.quantity > biggest.quantity) biggest = t;
        }
      }
      if (biggest) {
        const e = this.fire(
          'blockPrint',
          `Block ${biggest.side} print — ${(biggest.quantity / stats.averagePrint).toFixed(0)}× average`,
          `${biggest.venue} · ${biggest.quantity.toFixed(3)} @ ${biggest.price.toFixed(2)} · $${Math.round(biggest.quoteVolume / 1000)}K`,
          'warn',
          now,
        );
        if (e) out.push(e);
      }
    }

    // CVD divergence — 1-minute CVD and price change disagree in sign
    if (this.settings.cvdDivergence) {
      const bars = engine.flowBars(120);
      if (bars.length >= 20) {
        const last = bars[bars.length - 1];
        const oneMinuteAgo = ctx.now - 60_000;
        const idx = bars.findIndex((b) => b.time >= oneMinuteAgo);
        const first = idx > 0 ? bars[idx] : bars[0];
        const cvd = last.cvd - first.cvd;
        const priceChange = (last.close - first.close) / first.close;
        const volume = bars.slice(bars.indexOf(first)).reduce((a, b) => a + b.volume, 0);
        const material = Math.abs(priceChange) > 0.0005 && Math.abs(cvd) > volume * 0.15;
        let state: 'bullish' | 'bearish' | null = null;
        if (material && priceChange > 0 && cvd < 0) state = 'bullish'; // price up on negative delta = bullish absorption of selling
        if (material && priceChange < 0 && cvd > 0) state = 'bearish'; // price down on positive delta = supply absorbing buys
        if (state && state !== this.divergence) {
          const e = this.fire(
            'cvdDivergence',
            `${state === 'bullish' ? 'Bullish' : 'Bearish'} CVD divergence`,
            `1-minute ΔCVD ${(cvd / Math.max(1, volume) * 100).toFixed(0)}% of volume vs price ${(priceChange * 100).toFixed(2)}% — flow and price disagree`,
            'warn',
            now,
          );
          if (e) out.push(e);
        }
        this.divergence = state;
      }
    }

    // Large liquidation
    if (this.settings.largeLiquidation > 0) {
      let biggest: OfLiquidation | null = null;
      for (const l of newLiquidations) {
        if (l.quoteVolume >= this.settings.largeLiquidation) {
          if (!biggest || l.quoteVolume > biggest.quoteVolume) biggest = l;
        }
      }
      if (biggest) {
        const e = this.fire(
          'largeLiquidation',
          `${biggest.side === 'long' ? 'Long' : 'Short'} liquidation — $${(biggest.quoteVolume / 1000).toFixed(0)}K`,
          `${biggest.venue} · ${biggest.quantity.toFixed(3)} @ ${biggest.price.toFixed(2)} forced ${biggest.side === 'long' ? 'sell' : 'buy'}`,
          biggest.quoteVolume >= 1_000_000 ? 'critical' : 'warn',
          now,
        );
        if (e) out.push(e);
      }
    }

    // Absorption / iceberg
    for (const m of newMicro) {
      if (m.kind === 'absorption' && this.settings.absorption) {
        const e = this.fire(
          'absorption',
          `Absorption at ${m.price.toFixed(2)} — ${m.side === 'bid' ? 'bids held selling' : 'offer held buying'}`,
          `${m.volume.toFixed(3)} traded into the ${m.side} level (${m.ratio.toFixed(1)}× window average) without price progression`,
          'info',
          now,
        );
        if (e) out.push(e);
      }
      if (m.kind === 'iceberg' && this.settings.iceberg) {
        const e = this.fire(
          'iceberg',
          `Iceberg at ${m.price.toFixed(2)} on ${m.venue ?? ''} ${m.side}`,
          `${m.volume.toFixed(3)} traded vs ${(m.volume / m.ratio).toFixed(3)} displayed (${m.ratio.toFixed(1)}×) and the level refilled`,
          'info',
          now,
        );
        if (e) out.push(e);
      }
    }

    return out;
  }
}

/** Volume z-score of the completed 5-second flow bar vs preceding windows. */
function fiveSecondVolumeZ(engine: OrderFlowEngine): number | null {
  const bars = engine.flowBars(360); // ~3 minutes of 1s bars
  if (bars.length < 90) return null;
  const windowCount = Math.floor((bars.length - 5) / 5);
  if (windowCount < 12) return null;
  const sums: number[] = [];
  for (let w = 0; w < windowCount; w++) {
    let s = 0;
    for (let i = bars.length - 5 - (w + 1) * 5; i < bars.length - 5 - w * 5; i++) s += bars[i].volume;
    sums.push(s);
  }
  let current = 0;
  for (let i = bars.length - 5; i < bars.length; i++) current += bars[i].volume;
  const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
  const variance = sums.reduce((a, b) => a + (b - mean) ** 2, 0) / sums.length;
  const std = Math.sqrt(variance);
  return std > 0 ? (current - mean) / std : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — prior-session levels
//
// Previous UTC days' POC, value area, VWAP and range, built from Binance
// 5-minute klines, plus the POCs price has not traded back to (naked POCs).
// Klines don't carry volume-at-price, so each bar's volume is spread evenly
// across its range; VWAP is exact (quote volume ÷ base volume).
//
// Adapted from the open-source order-flow-screener by zadescoxp (Apache-2.0).
// ─────────────────────────────────────────────────────────────────────────────

import { fetchJson } from './socket';
import { autoTick } from './catalog';
import type { OfAsset, OfDayLevels, OfLevels } from './types';

const DAY_MS = 86_400_000;
const KLINE_REST = 'https://fapi.binance.com';

export interface Kline {
  openTime: number;
  high: number;
  low: number;
  close: number;
  volume: number; // base
  quoteVolume: number;
}

function utcDay(time: number): number {
  return Math.floor(time / DAY_MS) * DAY_MS;
}

type LevelsCache = { asset: OfAsset; builtAt: number; levels: OfLevels };

const levelCache = new Map<OfAsset, LevelsCache>();
const LEVELS_TTL = 10 * 60_000;

/** Parse Binance kline rows: [openTime, open, high, low, close, volume, closeTime, quoteVolume, …]. */
function parseBinanceKlines(rows: unknown[][]): Kline[] {
  return rows
    .map((r) => ({
      openTime: Number(r[0]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      quoteVolume: Number(r[7]),
    }))
    .filter((k) => Number.isFinite(k.openTime) && k.high > 0 && k.low > 0 && k.volume >= 0);
}

/** Volume by tick index, spreading each bar's volume across its range. */
function distributeVolume(klines: Kline[], tick: number): Map<number, number> {
  const profile = new Map<number, number>();
  for (const k of klines) {
    if (!(k.volume > 0) || !(tick > 0)) continue;
    const lo = Math.round(k.low / tick);
    const hi = Math.round(k.high / tick);
    const span = hi - lo + 1;
    if (span > 20_000) continue; // corrupt row guard
    const share = k.volume / span;
    for (let i = lo; i <= hi; i++) profile.set(i, (profile.get(i) ?? 0) + share);
  }
  return profile;
}

/** POC and value area, expanding from the POC toward the larger neighbour. */
function valueArea(
  profile: Map<number, number>,
  valueAreaPct: number,
): { poc: number; vah: number; val: number } | null {
  if (!profile.size) return null;
  const indices = [...profile.keys()].sort((a, b) => a - b);
  let total = 0;
  let pocAt = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = profile.get(indices[i])!;
    total += v;
    if (v > profile.get(indices[pocAt])!) pocAt = i;
  }
  let lo = pocAt;
  let hi = pocAt;
  let inside = profile.get(indices[pocAt])!;
  while (inside < total * valueAreaPct && (lo > 0 || hi < indices.length - 1)) {
    const below = lo > 0 ? profile.get(indices[lo - 1])! : -1;
    const above = hi < indices.length - 1 ? profile.get(indices[hi + 1])! : -1;
    if (above >= below) inside += profile.get(indices[++hi])!;
    else inside += profile.get(indices[--lo])!;
  }
  return { poc: indices[pocAt], vah: indices[hi], val: indices[lo] };
}

/** Levels for each complete UTC day in the klines, oldest first. */
function dayLevels(klines: Kline[], tick: number, valueAreaPct: number, today: number): OfDayLevels[] {
  const byDay = new Map<number, Kline[]>();
  for (const k of klines) {
    const day = utcDay(k.openTime);
    if (day >= today) continue;
    let list = byDay.get(day);
    if (!list) byDay.set(day, (list = []));
    list.push(k);
  }
  const out: OfDayLevels[] = [];
  for (const [day, bars] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const va = valueArea(distributeVolume(bars, tick), valueAreaPct);
    if (!va) continue;
    let volume = 0;
    let quote = 0;
    let high = -Infinity;
    let low = Infinity;
    for (const b of bars) {
      volume += b.volume;
      quote += b.quoteVolume;
      high = Math.max(high, b.high);
      low = Math.min(low, b.low);
    }
    out.push({
      day,
      poc: va.poc * tick,
      vah: va.vah * tick,
      val: va.val * tick,
      vwap: volume ? quote / volume : 0,
      high,
      low,
      volume,
    });
  }
  return out;
}

/** POCs not revisited since their day (each later day's range — and today's so far — misses them). */
function nakedPocs(days: OfDayLevels[], todayHigh: number, todayLow: number): OfDayLevels[] {
  const out: OfDayLevels[] = [];
  for (let i = 0; i < days.length; i++) {
    const { poc } = days[i];
    let touched =
      Number.isFinite(todayHigh) && Number.isFinite(todayLow) && todayLow <= poc && poc <= todayHigh;
    for (let j = i + 1; j < days.length && !touched; j++) touched = days[j].low <= poc && poc <= days[j].high;
    if (!touched) out.push(days[i]);
  }
  return out.reverse();
}

/** Fetch prior-session levels for an asset (cached ~10 minutes). */
export async function getLevels(asset: OfAsset): Promise<OfLevels> {
  const cached = levelCache.get(asset);
  if (cached && Date.now() - cached.builtAt < LEVELS_TTL) return cached.levels;

  const symbol = `${asset}USDT`;
  const now = Date.now();
  const from = now - 9 * DAY_MS; // 7 naked-POC days + yesterday + margin
  // Binance caps 1500 bars per call — two windows cover the 9 days.
  const fetchWindow = async (startMs: number, endMs: number): Promise<Kline[]> => {
    const rows = await fetchJson<unknown[][]>(
      `${KLINE_REST}/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${startMs}&endTime=${endMs}&limit=1500`,
    );
    return rows ? parseBinanceKlines(rows) : [];
  };
  const mid = from + 4.5 * DAY_MS;
  let klines = await fetchWindow(from, mid);
  klines = klines.concat(await fetchWindow(mid, now));
  if (!klines.length) {
    const fallback: OfLevels = {
      asset,
      builtAt: Date.now(),
      tick: autoTick(1),
      previous: null,
      naked: [],
      today: { high: NaN, low: NaN, poc: null, vwap: null },
    };
    return fallback;
  }

  const today = utcDay(now);
  const last = klines[klines.length - 1];
  const tick = autoTick(last.close);
  const days = dayLevels(klines, tick, 0.7, today);
  const todayBars = klines.filter((k) => utcDay(k.openTime) >= today);
  let todayHigh = NaN;
  let todayLow = NaN;
  let todayVol = 0;
  let todayQuote = 0;
  for (const b of todayBars) {
    todayHigh = Math.max(todayHigh, b.high);
    todayLow = Math.min(todayLow, b.low);
    todayVol += b.volume;
    todayQuote += b.quoteVolume;
  }
  const todayVa = valueArea(distributeVolume(todayBars, tick), 0.7);
  const levels: OfLevels = {
    asset,
    builtAt: Date.now(),
    tick,
    previous: days.length ? days[days.length - 1] : null,
    naked: nakedPocs(days, todayHigh, todayLow).slice(0, 5),
    today: {
      high: todayHigh,
      low: todayLow,
      poc: todayVa ? todayVa.poc * tick : null,
      vwap: todayVol > 0 ? todayQuote / todayVol : null,
    },
  };
  levelCache.set(asset, { asset, builtAt: Date.now(), levels });
  return levels;
}

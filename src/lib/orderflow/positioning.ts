// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — Binance futures positioning data (shared: REST route + copilot)
//
// topLongShortAccountRatio · globalLongShortAccountRatio · takerlongshortRatio
// · openInterestHist — the exchange-native leverage/positioning lens on top
// of our own order-flow truth. Cached 60 s per asset.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchJson } from './socket';
import { isOfAsset } from './catalog';
import type { OfAsset } from './types';

const BINANCE_F = 'https://fapi.binance.com';
const CACHE_MS = 60_000;
const LIMIT = 144; // 12 h of 5-minute points

interface RatioPoint {
  longAccount?: string;
  shortAccount?: string;
  longShortRatio?: string;
  buySellRatio?: string;
  buyVol?: string;
  sellVol?: string;
  timestamp: number;
}

interface OiHistPoint {
  sumOpenInterest?: string;
  sumOpenInterestValue?: string;
  timestamp: number;
}

export interface PositioningData {
  asset: OfAsset;
  topTraderLs: Array<{ t: number; long: number; short: number; ratio: number }>;
  globalLs: Array<{ t: number; long: number; short: number; ratio: number }>;
  takerLs: Array<{ t: number; ratio: number; buyVol: number; sellVol: number }>;
  oiHist: Array<{ t: number; oi: number; oiValue: number }>;
  tsMs: number;
}

const cache = new Map<OfAsset, { at: number; data: PositioningData }>();

async function ratios(asset: OfAsset, endpoint: string): Promise<PositioningData['topTraderLs']> {
  const rows = await fetchJson<RatioPoint[]>(
    `${BINANCE_F}/futures/data/${endpoint}?symbol=${asset}USDT&period=5m&limit=${LIMIT}`,
  );
  const out: PositioningData['topTraderLs'] = [];
  for (const r of rows ?? []) {
    const ratio = parseFloat(r.longShortRatio ?? '');
    if (!Number.isFinite(ratio)) continue;
    out.push({
      t: r.timestamp,
      long: parseFloat(r.longAccount ?? '') || NaN,
      short: parseFloat(r.shortAccount ?? '') || NaN,
      ratio,
    });
  }
  return out;
}

export async function getPositioning(asset: OfAsset): Promise<PositioningData> {
  const hit = cache.get(asset);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const symbol = `${asset}USDT`;
  const [topTraderLs, globalLs, takerRows, oiRows] = await Promise.all([
    ratios(asset, 'topLongShortAccountRatio'),
    ratios(asset, 'globalLongShortAccountRatio'),
    fetchJson<RatioPoint[]>(`${BINANCE_F}/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=${LIMIT}`),
    fetchJson<OiHistPoint[]>(`${BINANCE_F}/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=${LIMIT}`),
  ]);

  const takerLs: PositioningData['takerLs'] = [];
  for (const r of takerRows ?? []) {
    const ratio = parseFloat(r.buySellRatio ?? '');
    if (!Number.isFinite(ratio)) continue;
    takerLs.push({ t: r.timestamp, ratio, buyVol: parseFloat(r.buyVol ?? '') || 0, sellVol: parseFloat(r.sellVol ?? '') || 0 });
  }
  const oiHist: PositioningData['oiHist'] = [];
  for (const r of oiRows ?? []) {
    const oi = parseFloat(r.sumOpenInterest ?? '');
    if (!Number.isFinite(oi)) continue;
    oiHist.push({ t: r.timestamp, oi, oiValue: parseFloat(r.sumOpenInterestValue ?? '') || 0 });
  }

  const data: PositioningData = { asset, topTraderLs, globalLs, takerLs, oiHist, tsMs: Date.now() };
  if (data.topTraderLs.length || data.takerLs.length || data.oiHist.length) {
    cache.set(asset, { at: Date.now(), data });
  }
  return data;
}

export function parsePositioningAsset(raw: string | null | undefined): OfAsset {
  const a = (raw ?? 'BTC').toUpperCase();
  return isOfAsset(a) ? a : 'BTC';
}

/** Compact summary for chat contexts: latest values + 12 h extremes. */
export function positioningSummary(data: PositioningData): Record<string, unknown> {
  const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];
  const top = last(data.topTraderLs);
  const global = last(data.globalLs);
  const taker = last(data.takerLs);
  const oi = last(data.oiHist);
  const oiFirst = data.oiHist[0];
  const takerRatios = data.takerLs.map((t) => t.ratio).filter((r) => Number.isFinite(r));
  const globalRatios = data.globalLs.map((g) => g.ratio).filter((r) => Number.isFinite(r));
  const topRatios = data.topTraderLs.map((t) => t.ratio).filter((r) => Number.isFinite(r));
  const ext = (xs: number[]) =>
    xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null;
  return {
    asset: data.asset,
    topTrader: top
      ? {
          longPct: Number.isFinite(top.long) ? top.long * 100 : null,
          shortPct: Number.isFinite(top.short) ? top.short * 100 : null,
          ratio: top.ratio,
          ratio12hRange: ext(topRatios),
        }
      : null,
    globalAccounts: global
      ? {
          longPct: Number.isFinite(global.long) ? global.long * 100 : null,
          ratio: global.ratio,
          ratio12hRange: ext(globalRatios),
        }
      : null,
    takerFlow: taker
      ? {
          buySellRatio: taker.ratio,
          buyVol: taker.buyVol,
          sellVol: taker.sellVol,
          ratio12hRange: ext(takerRatios),
        }
      : null,
    openInterest: oi
      ? {
          oiBase: oi.oi,
          oiUsd: oi.oiValue,
          change12hPct: oiFirst && oiFirst.oi > 0 ? ((oi.oi - oiFirst.oi) / oiFirst.oi) * 100 : null,
        }
      : null,
    tsMs: data.tsMs,
  };
}

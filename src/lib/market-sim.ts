// Client-side market simulation fallback — mirrors market.rs so the UI
// stays fully alive even if the Rust engine is unreachable.

import type { MarketData } from './types';

const INIT: Record<string, { spot: number; volShift: number; fundingRate: number; oi: number; vol: number }> = {
  BTC: { spot: 97450, volShift: 0.0, fundingRate: 0.091, oi: 4.12e9, vol: 1.87e9 },
  ETH: { spot: 2462, volShift: 0.02, fundingRate: 0.083, oi: 2.31e9, vol: 9.6e8 },
  SOL: { spot: 138.4, volShift: -0.01, fundingRate: 0.104, oi: 6.4e8, vol: 3.1e8 },
};

export class MarketSim {
  private state: MarketData;
  private timer: ReturnType<typeof setInterval> | null = null;
  private targets: Record<string, number> = { BTC: 0, ETH: 0.02, SOL: -0.01 };

  constructor() {
    this.state = {
      source: 'local',
      tick: 0,
      tsMs: Date.now(),
      assets: Object.fromEntries(
        Object.entries(INIT).map(([k, v]) => [
          k,
          {
            spot: v.spot,
            volShift: v.volShift,
            fundingRate: v.fundingRate,
            change24h: 0,
            openInterest: v.oi,
            volume24h: v.vol,
          },
        ]),
      ),
    };
  }

  get snapshot(): MarketData {
    return this.state;
  }

  step(): MarketData {
    const secPerYear = 365 * 24 * 3600;
    for (const [name, a] of Object.entries(this.state.assets)) {
      const atm30d = name === 'BTC' ? 0.52 : name === 'ETH' ? 0.62 : 0.85;
      const sigma = (atm30d * 0.8) / Math.sqrt(secPerYear);
      const z = Math.random() * 2 - 1;
      const amp = Math.random() < 0.004 ? 3 : 1;
      a.spot *= Math.exp(-0.5 * sigma * sigma + sigma * z * amp);
      const target = this.targets[name] ?? 0;
      a.volShift += 0.02 * (target - a.volShift) + 0.004 * (Math.random() * 2 - 1);
      a.volShift = Math.min(Math.max(a.volShift, -0.5), 1.5);
      a.fundingRate += 0.0025 * (Math.random() * 2 - 1) - 0.0008 * (a.fundingRate - 0.085);
      a.fundingRate = Math.min(Math.max(a.fundingRate, -0.6), 0.9);
      a.change24h += sigma * z * 4;
      a.openInterest *= 1 + 0.0002 * (Math.random() * 2 - 1);
      a.volume24h *= 1 + 0.0004 * (Math.random() * 2 - 1);
      if (Math.random() < 0.0025) this.targets[name] = (Math.random() * 2 - 1) * 0.35;
    }
    this.state.tick += 1;
    this.state.tsMs = Date.now();
    return this.state;
  }

  start(onTick: (m: MarketData) => void, intervalMs = 1000) {
    this.stop();
    this.timer = setInterval(() => onTick(this.step()), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

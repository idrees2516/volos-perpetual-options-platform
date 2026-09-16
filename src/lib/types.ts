// Shared domain types for the VolOS strategy builder.

export type LegKind = 'call' | 'put' | 'perp_option' | 'perp' | 'spot';
export type Side = 'buy' | 'sell';
export type UnderlyingId = 'BTC' | 'ETH' | 'SOL';

export interface Leg {
  id: string;
  kind: LegKind;
  side: Side;
  qty: number;
  strike?: number;
  /** Days to expiry for dated legs; undefined for perpetual legs. */
  expiryDays?: number;
  /** Funding period in days for everlasting options. */
  fundingPeriodDays?: number;
}

export interface AssetMarket {
  spot: number;
  volShift: number;
  fundingRate: number;
  change24h: number;
  openInterest: number;
  volume24h: number;
}

export interface MarketData {
  source: 'rust' | 'local';
  assets: Record<string, AssetMarket>;
  tick: number;
  tsMs: number;
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
}

export interface LegAnalytics {
  id: string;
  kind: LegKind;
  side: Side;
  qty: number;
  strike?: number;
  expiryDays?: number;
  fundingPeriodDays?: number;
  iv?: number;
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
  cost: number;
  liquidity: number;
  fundingPerDay?: number;
}

export interface Extreme {
  kind: 'value' | 'unlimited';
  value?: number;
  atPrice?: number;
}

export interface CarryScenario {
  label: string;
  carry7d: number;
}

export interface CarryBudget {
  dailyCarry: number;
  weeklyCarry: number;
  monthlyCarry: number;
  scenarios: CarryScenario[];
}

export interface StrategyAnalysis {
  legs: LegAnalytics[];
  curves: { label: string; pnl: number[] }[];
  spotAxis: number[];
  netPremium: number;
  isCredit: boolean;
  maxProfit: Extreme;
  maxLoss: Extreme;
  breakevens: number[];
  pop: number;
  expectedValue: number;
  riskReward?: number;
  greeks: {
    delta: number;
    gamma: number;
    vega: number;
    theta: number;
    rho: number;
    deltaExposureUsd: number;
  };
  carry?: CarryBudget;
  liquidity: number;
  marginEstimate: number;
  scenarioMatrix: {
    spotShocks: number[];
    ivShocks: number[];
    pnl: number[][];
  };
  horizonDays: number;
}

export interface ViewOverrides {
  spotShiftPct: number;
  ivShiftPct: number;
  daysForward: number;
}

export const ASSETS: UnderlyingId[] = ['BTC', 'ETH', 'SOL'];

export const ASSET_META: Record<UnderlyingId, { name: string; symbol: string; step: number; decimals: number }> = {
  BTC: { name: 'Bitcoin', symbol: '₿', step: 500, decimals: 0 },
  ETH: { name: 'Ethereum', symbol: 'Ξ', step: 25, decimals: 1 },
  SOL: { name: 'Solana', symbol: '◎', step: 1, decimals: 1 },
};

export function kindLabel(kind: LegKind): string {
  switch (kind) {
    case 'call': return 'Call';
    case 'put': return 'Put';
    case 'perp_option': return 'Everlasting Option';
    case 'perp': return 'Perpetual Future';
    case 'spot': return 'Spot';
  }
}

export function legLabel(leg: Leg, spot: number): string {
  const s = leg.strike !== undefined ? fmtStrike(leg.strike) : '';
  switch (leg.kind) {
    case 'call': return `${s}C · ${leg.expiryDays?.toFixed(0)}d`;
    case 'put': return `${s}P · ${leg.expiryDays?.toFixed(0)}d`;
    case 'perp_option': return `${s} Everlasting`;
    case 'perp': return 'Perp';
    case 'spot': return 'Spot';
  }
  void spot;
}

export function fmtStrike(k: number): string {
  if (k >= 10000) return `${(k / 1000).toFixed(k >= 100000 ? 0 : 1)}k`;
  if (k >= 1000) return k.toFixed(0);
  return k.toFixed(k < 10 ? 2 : 1);
}

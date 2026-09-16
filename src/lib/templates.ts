// Strategy template library — editable starting points, not rigid presets.
// Each template generates legs relative to live spot so they are always sane.

import type { Leg, UnderlyingId } from './types';
import { forwardPrice, strikeForDelta, VOL_CONFIG } from './pricing';

export interface Template {
  id: string;
  name: string;
  category: 'direction' | 'income' | 'volatility' | 'protection' | 'perpetual' | 'exotic';
  description: string;
  build: (spot: number, underlying: UnderlyingId) => Leg[];
}

let seq = 0;
function leg(kind: Leg['kind'], side: Leg['side'], qty: number, strike?: number, expiryDays?: number, fp?: number): Leg {
  seq += 1;
  return {
    id: `leg-${Date.now().toString(36)}-${seq}`,
    kind,
    side,
    qty,
    strike,
    expiryDays,
    fundingPeriodDays: fp,
  };
}

function snap(spot: number, frac: number, step: number): number {
  const raw = spot * frac;
  return Math.round(raw / step) * step;
}

function stepFor(spot: number): number {
  if (spot >= 50000) return 500;
  if (spot >= 4000) return 50;
  if (spot >= 400) return 5;
  if (spot >= 40) return 0.5;
  return 0.05;
}

export const TEMPLATES: Template[] = [
  {
    id: 'long-call',
    name: 'Long Call',
    category: 'direction',
    description: 'Bullish with unlimited upside. Premium at risk, no liquidation.',
    build: (s) => [leg('call', 'buy', 1, snap(s, 1.0, stepFor(s)), 30)],
  },
  {
    id: 'long-put',
    name: 'Long Put',
    category: 'direction',
    description: 'Bearish convex exposure. Profits accelerate as price falls.',
    build: (s) => [leg('put', 'buy', 1, snap(s, 1.0, stepFor(s)), 30)],
  },
  {
    id: 'bull-call-spread',
    name: 'Bull Call Spread',
    category: 'direction',
    description: 'Buy ATM call, sell OTM call. Cheaper bullish with capped upside.',
    build: (s) => [
      leg('call', 'buy', 1, snap(s, 1.0, stepFor(s)), 30),
      leg('call', 'sell', 1, snap(s, 1.15, stepFor(s)), 30),
    ],
  },
  {
    id: 'bear-put-spread',
    name: 'Bear Put Spread',
    category: 'direction',
    description: 'Buy ATM put, sell OTM put. Defined-risk bearish.',
    build: (s) => [
      leg('put', 'buy', 1, snap(s, 1.0, stepFor(s)), 30),
      leg('put', 'sell', 1, snap(s, 0.85, stepFor(s)), 30),
    ],
  },
  {
    id: 'covered-call',
    name: 'Covered Call',
    category: 'income',
    description: 'Own spot, sell an upside call. Get paid for your exit price.',
    build: (s) => [
      leg('spot', 'buy', 1),
      leg('call', 'sell', 1, snap(s, 1.12, stepFor(s)), 30),
    ],
  },
  {
    id: 'cash-secured-put',
    name: 'Cash-Secured Put',
    category: 'income',
    description: 'Sell a downside put. Get paid to commit to a buy price.',
    build: (s) => [leg('put', 'sell', 1, snap(s, 0.88, stepFor(s)), 30)],
  },
  {
    id: 'collar',
    name: 'Collar',
    category: 'protection',
    description: 'Spot + protective put + short call. Near-zero-cost insurance.',
    build: (s) => [
      leg('spot', 'buy', 1),
      leg('put', 'buy', 1, snap(s, 0.85, stepFor(s)), 30),
      leg('call', 'sell', 1, snap(s, 1.15, stepFor(s)), 30),
    ],
  },
  {
    id: 'protective-put',
    name: 'Protective Put',
    category: 'protection',
    description: 'Spot + put floor. Insurance against a drawdown.',
    build: (s) => [
      leg('spot', 'buy', 1),
      leg('put', 'buy', 1, snap(s, 0.85, stepFor(s)), 30),
    ],
  },
  {
    id: 'long-straddle',
    name: 'Long Straddle',
    category: 'volatility',
    description: 'ATM call + put. Profit from a big move either way.',
    build: (s) => [
      leg('call', 'buy', 1, snap(s, 1.0, stepFor(s)), 30),
      leg('put', 'buy', 1, snap(s, 1.0, stepFor(s)), 30),
    ],
  },
  {
    id: 'long-strangle',
    name: 'Long Strangle',
    category: 'volatility',
    description: 'OTM call + OTM put. Cheaper move play, needs more movement.',
    build: (s) => [
      leg('call', 'buy', 1, snap(s, 1.12, stepFor(s)), 30),
      leg('put', 'buy', 1, snap(s, 0.88, stepFor(s)), 30),
    ],
  },
  {
    id: 'short-strangle-wings',
    name: 'Iron Condor',
    category: 'income',
    description: 'Sell both sides, buy far wings. Defined-risk premium harvest.',
    build: (s) => [
      leg('put', 'buy', 1, snap(s, 0.75, stepFor(s)), 30),
      leg('put', 'sell', 1, snap(s, 0.88, stepFor(s)), 30),
      leg('call', 'sell', 1, snap(s, 1.12, stepFor(s)), 30),
      leg('call', 'buy', 1, snap(s, 1.25, stepFor(s)), 30),
    ],
  },
  {
    id: 'iron-butterfly',
    name: 'Iron Butterfly',
    category: 'income',
    description: 'Short ATM straddle with protective wings. Max credit at pin.',
    build: (s) => [
      leg('call', 'sell', 1, snap(s, 1.0, stepFor(s)), 30),
      leg('put', 'sell', 1, snap(s, 1.0, stepFor(s)), 30),
      leg('call', 'buy', 1, snap(s, 1.15, stepFor(s)), 30),
      leg('put', 'buy', 1, snap(s, 0.85, stepFor(s)), 30),
    ],
  },
  {
    id: 'calendar-spread',
    name: 'Call Calendar',
    category: 'volatility',
    description: 'Short near call, long far call. Profits from time decay differential.',
    build: (s) => [
      leg('call', 'sell', 1, snap(s, 1.0, stepFor(s)), 14),
      leg('call', 'buy', 1, snap(s, 1.0, stepFor(s)), 60),
    ],
  },
  {
    id: 'diagonal',
    name: 'Diagonal Call',
    category: 'direction',
    description: 'Long far ITM call, short near OTM call. Leased upside.',
    build: (s) => [
      leg('call', 'buy', 1, snap(s, 0.95, stepFor(s)), 60),
      leg('call', 'sell', 1, snap(s, 1.08, stepFor(s)), 14),
    ],
  },
  {
    id: 'ratio-1x2',
    name: 'Ratio Call 1×2',
    category: 'exotic',
    description: 'Buy 1 ATM call, sell 2 OTM calls. Cheap or credit bullish.',
    build: (s) => [
      leg('call', 'buy', 1, snap(s, 1.0, stepFor(s)), 30),
      leg('call', 'sell', 2, snap(s, 1.15, stepFor(s)), 30),
    ],
  },
  {
    id: 'call-backspread',
    name: 'Call Backspread',
    category: 'exotic',
    description: 'Sell 1 ITM, buy 2 OTM. Uncapped upside for credit-like cost.',
    build: (s) => [
      leg('call', 'sell', 1, snap(s, 0.95, stepFor(s)), 30),
      leg('call', 'buy', 2, snap(s, 1.08, stepFor(s)), 30),
    ],
  },
  {
    id: 'put-backspread',
    name: 'Put Backspread',
    category: 'exotic',
    description: 'Sell 1 OTM put, buy 2 far puts. Crash convexity on the cheap.',
    build: (s) => [
      leg('put', 'sell', 1, snap(s, 0.95, stepFor(s)), 30),
      leg('put', 'buy', 2, snap(s, 0.82, stepFor(s)), 30),
    ],
  },
  {
    id: 'jade-lizard',
    name: 'Jade Lizard',
    category: 'income',
    description: 'Short put + short call spread. No upside risk, big credit.',
    build: (s) => [
      leg('put', 'sell', 1, snap(s, 0.88, stepFor(s)), 30),
      leg('call', 'sell', 1, snap(s, 1.12, stepFor(s)), 30),
      leg('call', 'buy', 1, snap(s, 1.25, stepFor(s)), 30),
    ],
  },
  {
    id: 'broken-wing-butterfly',
    name: 'Broken Wing Butterfly',
    category: 'exotic',
    description: 'Asymmetric call fly. Cheap directional structure with skewed risk.',
    build: (s) => [
      leg('call', 'buy', 1, snap(s, 1.0, stepFor(s)), 30),
      leg('call', 'sell', 2, snap(s, 1.10, stepFor(s)), 30),
      leg('call', 'buy', 1, snap(s, 1.25, stepFor(s)), 30),
    ],
  },
  {
    id: 'risk-reversal',
    name: 'Risk Reversal',
    category: 'direction',
    description: 'Sell put, buy call. Synthetic long for credit, downside risk.',
    build: (s) => [
      leg('put', 'sell', 1, snap(s, 0.90, stepFor(s)), 30),
      leg('call', 'buy', 1, snap(s, 1.10, stepFor(s)), 30),
    ],
  },
  {
    id: 'box',
    name: 'Box Spread',
    category: 'exotic',
    description: 'Synthetic lock: bull spread + bear spread. Pure interest play.',
    build: (s) => [
      leg('call', 'buy', 1, snap(s, 0.95, stepFor(s)), 60),
      leg('call', 'sell', 1, snap(s, 1.05, stepFor(s)), 60),
      leg('put', 'buy', 1, snap(s, 1.05, stepFor(s)), 60),
      leg('put', 'sell', 1, snap(s, 0.95, stepFor(s)), 60),
    ],
  },
  {
    id: 'perp-put',
    name: 'Perp + Put (No Liquidation)',
    category: 'protection',
    description: 'Leveraged long with a hard floor — the research blueprint’s defined-risk leverage.',
    build: (s) => [
      leg('perp', 'buy', 1),
      leg('put', 'buy', 1, snap(s, 0.85, stepFor(s)), 30),
    ],
  },
  {
    id: 'everlasting-call',
    name: 'Everlasting Call',
    category: 'perpetual',
    description: 'Perpetual upside with no expiry. Funding = mark − payoff each period.',
    build: (s) => [leg('perp_option', 'buy', 1, snap(s, 1.0, stepFor(s)), undefined, 7)],
  },
  {
    id: 'everlasting-put',
    name: 'Everlasting Put',
    category: 'perpetual',
    description: 'Persistent protection — a hedge that never needs rolling.',
    build: (s) => [leg('perp_option', 'buy', 1, snap(s, 0.9, stepFor(s)), undefined, 7)],
  },
  {
    id: 'everlasting-straddle',
    name: 'Everlasting Vol',
    category: 'perpetual',
    description: 'Persistent long volatility via everlasting call + everlasting put.',
    build: (s) => [
      leg('perp_option', 'buy', 1, snap(s, 1.0, stepFor(s)), undefined, 7),
      leg('perp_option', 'buy', 1, snap(s, 1.0, stepFor(s)), undefined, 7),
    ],
  },
  {
    id: 'covered-everlasting',
    name: 'Covered Everlasting Call',
    category: 'perpetual',
    description: 'Spot + short everlasting call. Continuous income, no roll.',
    build: (s) => [
      leg('spot', 'buy', 1),
      leg('perp_option', 'sell', 1, snap(s, 1.1, stepFor(s)), undefined, 7),
    ],
  },
];

export function templateCategories(): { id: Template['category']; label: string }[] {
  return [
    { id: 'direction', label: 'Direction' },
    { id: 'volatility', label: 'Volatility' },
    { id: 'income', label: 'Income' },
    { id: 'protection', label: 'Protection' },
    { id: 'perpetual', label: 'Perpetual' },
    { id: 'exotic', label: 'Exotic' },
  ];
}

/** Delta-anchored smart template used by the wizard. */
export function deltaTemplate(
  spot: number,
  underlying: UnderlyingId,
  callDelta: number,
  days: number,
): number {
  const cfg = VOL_CONFIG[underlying] ?? VOL_CONFIG.BTC;
  const t = days / 365;
  const f = forwardPrice(cfg, spot, t);
  return Math.round(strikeForDelta({ cfg, asset: { spot, volShift: 0, fundingRate: 0, change24h: 0, openInterest: 0, volume24h: 0 } }, t, callDelta, true) / stepFor(f)) * stepFor(f);
}

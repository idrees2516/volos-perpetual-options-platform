// ---------------------------------------------------------------------------
// backquant/endpoints — the complete BackQuant v2 endpoint registry.
//
// All 70 REST endpoints (mirrors docs.backquant.com openapi-v2 v2.14), each
// with its query-parameter surface. This single registry powers:
//   • the /api/backquant/* proxy (path matching + param forwarding)
//   • the API Catalog browser in the BackQuant workspace UI
//   • the demo engine's generator dispatch
//   • the `bq_catalog` copilot tool (what can the desk pull?)
//
// Path patterns use `:name` for dynamic segments (e.g. greek).
// ---------------------------------------------------------------------------

import type { BqEndpoint, BqGroup, BqGroupMeta } from './types';

export const BQ_GROUPS: BqGroupMeta[] = [
  { id: 'discovery', label: 'Discovery & Meta', blurb: 'Health, symbols, expiries, service status, endpoint catalog, changelog' },
  { id: 'gex', label: 'GEX & Positioning', blurb: 'Levels, walls, strike ladder, heatmaps, dealer + gamma flow, multi-symbol bundle' },
  { id: 'chain', label: 'Chain & OPEX', blurb: 'Filtered chain, cross-venue book, expiry summary, OPEX calendar' },
  { id: 'iv', label: 'IV Analytics', blurb: 'Surface, constant-maturity vol, skew, smiles, IV-RV, VRP, expected move, calibrated range' },
  { id: 'probability', label: 'Probability', blurb: 'Risk-neutral PDF + 3D probability surface' },
  { id: 'greeks', label: 'Greeks & TRACE', blurb: 'DEX, vanna, charm, vega — profiles, surfaces + forward TRACE projections' },
  { id: 'oi', label: 'OI & Flow', blurb: 'OI by expiry, history, PCR, premium tide, futures term structure' },
  { id: 'tape', label: 'Options Tape', blurb: 'Live stream, full history, whale prints, imbalance, strike heat, flow by strike' },
  { id: 'liquidation', label: 'Liquidations', blurb: 'Heatmap + distribution across venues' },
  { id: 'market', label: 'Market Data', blurb: 'Candles, open interest, funding, CVD, perp liquidations, market bundle' },
  { id: 'etf', label: 'Spot ETFs', blurb: 'ETF flows, premium, AUM' },
  { id: 'cot', label: 'COT Positioning', blurb: 'CFTC Commitments of Traders across futures markets' },
  { id: 'filings', label: 'SEC Filings', blurb: 'Form 4 insider trades + 13F institutional holders' },
  { id: 'multi', label: 'Multi-Symbol', blurb: 'Bundle GEX levels for up to 8 symbols in one call' },
];

const POSITIONING = {
  name: 'positioning',
  type: 'string' as const,
  enumValues: ['flow', 'std'],
  default: 'flow',
  description: 'Dealer positioning model: flow (tape-signed) or std (static)',
};
const INTERVAL = {
  name: 'interval',
  type: 'string' as const,
  required: true,
  enumValues: ['1m', '5m', '15m', '1h', '4h', '1d'],
  default: '1h',
  description: 'Bucket interval',
};
const HOURS = { name: 'hours', type: 'number' as const, required: true, default: 72, description: 'Lookback window in hours' };
const GREEK_ENUM = ['gamma', 'vanna', 'charm', 'vega', 'theta', 'delta'];

/** The full v2 registry — 70 GET endpoints. */
export const BQ_ENDPOINTS: BqEndpoint[] = [
  // ── Discovery & Meta (7) ─────────────────────────────────────────────────
  { id: 'health', path: '/health', group: 'discovery', title: 'Health check', summary: 'v2 liveness/readiness probe (no auth)', params: [], cacheTtlMs: 15_000 },
  { id: 'symbols', path: '/symbols', group: 'discovery', title: 'Symbol catalog', summary: 'Supported symbols + per-symbol data availability', params: [], cacheTtlMs: 300_000 },
  { id: 'expiries', path: '/expiries', group: 'discovery', title: 'Active expiries', summary: 'Currently-tradeable expiry tokens with DTE', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT', description: 'Underlying symbol' }], cacheTtlMs: 60_000 },
  { id: 'status', path: '/status', group: 'discovery', title: 'Service status', summary: 'Per symbol, per category freshness', params: [], cacheTtlMs: 30_000 },
  { id: 'meta', path: '/meta', group: 'discovery', title: 'API metadata', summary: 'Static v2 API metadata', params: [], cacheTtlMs: 300_000 },
  { id: 'endpoints', path: '/endpoints', group: 'discovery', title: 'Endpoint catalog', summary: 'Live catalog of every v2 route', params: [], cacheTtlMs: 300_000 },
  { id: 'changelog', path: '/changelog', group: 'discovery', title: 'Changelog', summary: 'API version history with breaking-change flags', params: [], cacheTtlMs: 300_000 },

  // ── GEX (13) ─────────────────────────────────────────────────────────────
  {
    id: 'gex_levels', path: '/gex/levels', group: 'gex', title: 'GEX levels', summary: 'All-expiry HVL/walls + 0DTE levels in one call',
    params: [
      { name: 'symbol', type: 'string', default: 'BTCUSDT', description: 'Underlying symbol' },
      { name: 'exchanges', type: 'csv', description: 'Venue filter, e.g. deribit,bybit' },
      { name: 'include', type: 'csv', description: 'Extra blocks: ranked, max_pain, expected_move, gamma_flip_zones' },
      POSITIONING,
      { name: 'as_of', type: 'string', description: 'Point-in-time ISO timestamp' },
    ],
    cacheTtlMs: 30_000,
  },
  {
    id: 'gex_strike_profile', path: '/gex/strike-profile', group: 'gex', title: 'GEX by strike', summary: 'Gamma exposure aggregated by strike',
    params: [
      { name: 'symbol', type: 'string', default: 'BTCUSDT' },
      { name: 'exchanges', type: 'csv' },
      { name: 'expiry', type: 'string', default: 'all', description: 'all | 0dte | specific expiry token' },
      { name: 'strike_min', type: 'number' }, { name: 'strike_max', type: 'number' },
      { name: 'moneyness_min', type: 'number' }, { name: 'moneyness_max', type: 'number' },
      { name: 'spot_window_pct', type: 'number', default: 15 },
      POSITIONING,
      { name: 'as_of', type: 'string' },
    ],
    cacheTtlMs: 30_000,
  },
  {
    id: 'gex_expiry_profile', path: '/gex/expiry-profile', group: 'gex', title: 'GEX by expiry', summary: 'Net / call / put gamma per expiration with DTE',
    params: [
      { name: 'symbol', type: 'string', default: 'BTCUSDT' },
      { name: 'exchanges', type: 'csv' },
      { name: 'dte_min', type: 'number' }, { name: 'dte_max', type: 'number' },
      { name: 'weekly_only', type: 'boolean', default: false },
      POSITIONING,
    ],
    cacheTtlMs: 60_000,
  },
  {
    id: 'gex_strike_expiry_heatmap', path: '/gex/strike-expiry-heatmap', group: 'gex', title: 'Strike × expiry heatmap', summary: '2D GEX matrix — strikes × expiries',
    params: [
      { name: 'symbol', type: 'string', default: 'BTCUSDT' },
      { name: 'exchanges', type: 'csv' },
      { name: 'dte_min', type: 'number' }, { name: 'dte_max', type: 'number' },
      { name: 'moneyness_min', type: 'number' }, { name: 'moneyness_max', type: 'number' },
      { name: 'max_strikes', type: 'number', default: 24 },
      { name: 'max_expiries', type: 'number', default: 8 },
      POSITIONING,
    ],
    cacheTtlMs: 30_000,
  },
  {
    id: 'gex_ladder', path: '/gex/ladder', group: 'gex', title: 'Strike ladder', summary: 'Dealer exposure by strike × expiry for every greek',
    params: [
      { name: 'symbol', type: 'string', default: 'BTCUSDT' },
      { name: 'metric', type: 'string', enumValues: ['gamma', 'vex', 'dex', 'vanna', 'charm', 'vega', 'theta'], default: 'gamma', description: 'Exposure metric' },
      POSITIONING,
      { name: 'expiry', type: 'string', default: 'all' },
      { name: 'expiries', type: 'number', default: 4, description: 'How many expiry columns' },
      { name: 'span', type: 'string', description: 'Strike window span' },
      { name: 'group', type: 'number', description: 'Strike grouping step' },
    ],
    cacheTtlMs: 30_000,
  },
  {
    id: 'gex_time_heatmap', path: '/gex/time-heatmap', group: 'gex', title: 'Strike × time heatmap', summary: 'Time-series of greek exposures by strike',
    params: [
      { name: 'symbol', type: 'string', default: 'BTCUSDT' },
      { name: 'greek', type: 'string', required: true, enumValues: GREEK_ENUM, default: 'gamma' },
      { name: 'dte_min', type: 'number', required: true, default: 0 },
      { name: 'dte_max', type: 'number', required: true, default: 90 },
      { name: 'min_oi', type: 'number', required: true, default: 0 },
      { name: 'iv_min', type: 'number', required: true, default: 0 },
      { name: 'iv_max', type: 'number', required: true, default: 500 },
      POSITIONING,
    ],
    cacheTtlMs: 60_000,
  },
  { id: 'gex_history', path: '/gex/history', group: 'gex', title: 'GEX history', summary: 'Total GEX time-series (cursor-paginated)', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'limit', type: 'number', default: 200 }, { name: 'before', type: 'string' }], cacheTtlMs: 120_000 },
  { id: 'gex_stress_history', path: '/gex/stress-history', group: 'gex', title: 'Stress history (Postgres)', summary: 'Long-window HVL / walls / net GEX per symbol', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'days', type: 'number', default: 180 }], cacheTtlMs: 300_000 },
  { id: 'gex_max_pain', path: '/gex/max-pain', group: 'gex', title: 'Max pain', summary: 'Strike where option writers profit most, per expiry', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'expiry', type: 'string', required: true, default: 'next', description: '0dte | all | next | expiry token' }], cacheTtlMs: 30_000 },
  { id: 'gex_dealer_flow', path: '/gex/dealer-flow', group: 'gex', title: 'Dealer flow (time series)', summary: 'Dealer hedge flow: gamma + vanna + charm across snapshots', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, POSITIONING, { name: 'as_of', type: 'string' }, { name: 'include', type: 'csv' }], cacheTtlMs: 30_000 },
  { id: 'gex_gamma_flow', path: '/gex/gamma-flow', group: 'gex', title: 'Gamma flow', summary: 'Gamma component of dealer hedge flow only', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, POSITIONING, { name: 'as_of', type: 'string' }], cacheTtlMs: 30_000 },
  { id: 'gex_delta_flow', path: '/gex/delta-flow', group: 'gex', title: 'Delta flow (customer)', summary: 'HIRO-style time-bucketed customer signed delta notional', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'hours', type: 'number', default: 24 }, { name: 'bucket_minutes', type: 'number', default: 60 }, { name: 'min_size', type: 'number', default: 0 }], cacheTtlMs: 30_000 },
  { id: 'gex_dealer_flow_by_level', path: '/gex/dealer-flow/by-level', group: 'gex', title: 'Dealer flow by level', summary: 'Expected dealer hedge $ if spot walks to each strike', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, POSITIONING], cacheTtlMs: 30_000 },

  // ── Chain & OPEX (4) ─────────────────────────────────────────────────────
  {
    id: 'options_chain', path: '/options/chain', group: 'chain', title: 'Options chain', summary: 'Filtered chain: greeks, OI, IV, bid/ask + aggregates',
    params: [
      { name: 'symbol', type: 'string', default: 'BTCUSDT' },
      { name: 'expiries', type: 'number', description: 'Number of expiries to include' },
      { name: 'dte_min', type: 'number' }, { name: 'dte_max', type: 'number', default: 90 },
      { name: 'oi_min', type: 'number' }, { name: 'oi_max', type: 'number' },
      { name: 'delta_min', type: 'number' }, { name: 'delta_max', type: 'number' },
      { name: 'strike_min', type: 'number' }, { name: 'strike_max', type: 'number' },
      { name: 'moneyness_min', type: 'number' }, { name: 'moneyness_max', type: 'number' },
      { name: 'option_type', type: 'string', enumValues: ['call', 'put'] },
      { name: 'max_contracts', type: 'number', default: 120 },
      { name: 'fields', type: 'csv', description: 'Column selection' },
      { name: 'include', type: 'csv', description: 'Extra blocks (aggregates, expiries)' },
      { name: 'as_of', type: 'string' },
    ],
    cacheTtlMs: 20_000,
  },
  { id: 'options_venue_book', path: '/options/venue-book', group: 'chain', title: 'Cross-venue book', summary: 'Consolidated best bid/offer across venues + dispersion', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'expiries', type: 'number' }, { name: 'option_type', type: 'string', enumValues: ['call', 'put'] }, { name: 'crossed_only', type: 'boolean', default: false }, { name: 'sort', type: 'string', default: 'dispersion' }, { name: 'limit', type: 'number', default: 40 }], cacheTtlMs: 20_000 },
  { id: 'options_expiry_summary', path: '/options/expiry-summary', group: 'chain', title: 'Per-expiry summary', summary: 'IV / skew / PCR / OI / GEX per expiry with OPEX enrichment', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }], cacheTtlMs: 30_000 },
  { id: 'options_opex', path: '/options/opex', group: 'chain', title: 'OPEX calendar', summary: 'Upcoming expirations with roll-off context', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'horizon', type: 'number', default: 45, description: 'Days ahead' }, { name: 'types', type: 'csv', description: 'daily,weekly,monthly,quarterly' }], cacheTtlMs: 60_000 },

  // ── IV analytics (10) ────────────────────────────────────────────────────
  { id: 'iv_surface', path: '/options/iv/surface', group: 'iv', title: 'IV surface', summary: 'Fitted vol by tenor and strike with SVI params + fit error', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'as_of', type: 'string' }], cacheTtlMs: 60_000 },
  { id: 'iv_constant_maturity', path: '/options/iv/constant-maturity', group: 'iv', title: 'Constant-maturity vol', summary: 'ATM / 25Δ / 10Δ RR + butterflies at fixed tenors, arb-checked', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }], cacheTtlMs: 60_000 },
  { id: 'iv_term_structure', path: '/options/iv/term-structure', group: 'iv', title: 'Term structure', summary: 'ATM IV by tenor', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'as_of', type: 'string' }, { name: 'exchanges', type: 'csv' }, { name: 'dte_max', type: 'number', default: 180 }, { name: 'historical_compare_days', type: 'number' }], cacheTtlMs: 60_000 },
  { id: 'iv_skew', path: '/options/iv/skew', group: 'iv', title: 'Skew (25Δ / 10Δ)', summary: 'Risk reversal + butterfly per expiry', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'as_of', type: 'string' }], cacheTtlMs: 60_000 },
  { id: 'iv_curves', path: '/options/iv/curves', group: 'iv', title: 'All-expiry smile curves', summary: 'Merged-IV smile per active expiry, sorted by DTE', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }], cacheTtlMs: 60_000 },
  { id: 'iv_smile', path: '/options/iv/smile', group: 'iv', title: 'Single-expiry smile', summary: 'One expiry\'s smile by strike and log-moneyness', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'expiry', type: 'string', description: 'Expiry token, or omit for front' }], cacheTtlMs: 60_000 },
  { id: 'iv_ivrv', path: '/options/iv/iv-rv', group: 'iv', title: 'IV vs realized vol', summary: 'Daily implied (DVOL/ATM-IV) vs 30d realized + spread', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'days', type: 'number', default: 90 }], cacheTtlMs: 300_000 },
  { id: 'iv_vrp', path: '/options/vrp', group: 'iv', title: 'Volatility risk premium', summary: 'Implied − realized vol; positive = options expensive', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'days', type: 'number', default: 90 }], cacheTtlMs: 300_000 },
  { id: 'options_expected_move', path: '/options/expected-move', group: 'iv', title: 'Expected move', summary: 'ATM-straddle 1σ / 2σ expected move (1d horizon)', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'as_of', type: 'string' }, { name: 'exchanges', type: 'csv' }], cacheTtlMs: 30_000 },
  { id: 'options_range', path: '/options/range', group: 'iv', title: 'Calibrated options range', summary: 'Realistic move bands for 1h / 4h / 24h, rescaled + track record', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'include', type: 'csv' }], cacheTtlMs: 60_000 },

  // ── Probability (2) ──────────────────────────────────────────────────────
  { id: 'probability_density', path: '/options/probability/density', group: 'probability', title: 'Probability density', summary: 'Breeden-Litzenberger risk-neutral PDF/CDF per expiry', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'expiry', type: 'string' }, { name: 'dte_max', type: 'number', default: 60 }, { name: 'confidence_band', type: 'string', enumValues: ['68', '90', '95'] }], cacheTtlMs: 60_000 },
  { id: 'probability_surface', path: '/options/probability/surface', group: 'probability', title: 'Probability surface', summary: '3D PDF over the full strike × expiry grid', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }], cacheTtlMs: 60_000 },

  // ── Greeks & TRACE (5) ───────────────────────────────────────────────────
  { id: 'greeks_profile', path: '/options/greeks/:greek', group: 'greeks', title: 'Greek profile', summary: 'Net greek exposure per strike (DEX, vanna, charm, vega…)', params: [{ name: 'greek', type: 'string', required: true, enumValues: GREEK_ENUM, description: 'Path segment' }, { name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'exchanges', type: 'csv' }, { name: 'moneyness_min', type: 'number' }, { name: 'moneyness_max', type: 'number' }, { name: 'dte_max', type: 'number', default: 90 }, POSITIONING], cacheTtlMs: 30_000 },
  { id: 'greeks_surface', path: '/options/greeks/surfaces/:greek', group: 'greeks', title: 'Greek surface (strike × time)', summary: 'Time-evolving surface for charm or vega', params: [{ name: 'greek', type: 'string', required: true, enumValues: GREEK_ENUM, description: 'Path segment' }, { name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'include', type: 'csv' }], cacheTtlMs: 60_000 },
  { id: 'greeks_3d_surface', path: '/options/greeks/3d/surface', group: 'greeks', title: '3D greek surface', summary: 'Z = sum(greek × OI) per (strike, expiry) cell', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'greek', type: 'string', required: true, enumValues: GREEK_ENUM, default: 'gamma' }], cacheTtlMs: 60_000 },
  { id: 'greeks_trace', path: '/options/greeks/trace/:greek', group: 'greeks', title: 'Greek TRACE — forward', summary: 'Forward (time × price) projection of dealer gamma/charm/vanna', params: [{ name: 'greek', type: 'string', required: true, enumValues: ['gamma', 'charm', 'vanna'], description: 'Path segment' }, { name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'expiry', type: 'string', required: true, default: 'next' }, { name: 'time_steps', type: 'number', default: 12 }, { name: 'price_steps', type: 'number', default: 25 }, { name: 'price_range_pct', type: 'number', default: 10 }, { name: 'horizon_hours', type: 'number', default: 48 }, { name: 'vol_shift_pct', type: 'number', default: 0 }, { name: 'min_oi', type: 'number', default: 0 }, POSITIONING], cacheTtlMs: 60_000 },
  { id: 'greeks_trace_summary', path: '/options/greeks/trace/:greek/summary', group: 'greeks', title: 'Greek TRACE summary', summary: 'Pin zones, accel pockets, lean — interpretability summary', params: [{ name: 'greek', type: 'string', required: true, enumValues: ['gamma', 'charm', 'vanna'], description: 'Path segment' }, { name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'expiry', type: 'string', required: true, default: 'next' }, { name: 'time_steps', type: 'number', default: 12 }, { name: 'price_steps', type: 'number', default: 25 }, { name: 'price_range_pct', type: 'number', default: 10 }, { name: 'horizon_hours', type: 'number', default: 48 }, { name: 'vol_shift_pct', type: 'number', default: 0 }, { name: 'min_oi', type: 'number', default: 0 }, POSITIONING], cacheTtlMs: 60_000 },

  // ── OI & flow (5) ────────────────────────────────────────────────────────
  { id: 'oi_by_expiry', path: '/options/oi/by-expiry', group: 'oi', title: 'OI by expiry', summary: 'Call/put open interest per expiration', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'exchanges', type: 'csv' }, { name: 'dte_min', type: 'number' }, { name: 'dte_max', type: 'number' }, { name: 'weekly_only', type: 'boolean', default: false }], cacheTtlMs: 30_000 },
  { id: 'oi_history', path: '/options/oi/history', group: 'oi', title: 'OI history', summary: 'Total / call / put open interest time-series', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'limit', type: 'number', default: 200 }, { name: 'before', type: 'string' }], cacheTtlMs: 120_000 },
  { id: 'options_pcr', path: '/options/pcr', group: 'oi', title: 'Put / call ratio', summary: 'OI-weighted put/call ratio', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'granularity', type: 'string', enumValues: ['total', 'by_expiry', 'daily'], default: 'total' }, { name: 'days', type: 'number', default: 30 }, { name: 'include', type: 'csv' }], cacheTtlMs: 60_000 },
  { id: 'options_premium_tide', path: '/options/premium-tide', group: 'oi', title: 'Premium tide', summary: 'Net premium and notional volume tilt (calls vs puts)', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'horizon', type: 'string', enumValues: ['1d', '1w', '2w'], default: '1d' }], cacheTtlMs: 30_000 },
  { id: 'futures_term_structure', path: '/options/futures/term-structure', group: 'oi', title: 'Futures term structure', summary: 'Dated-futures annualized basis curve vs spot', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }], cacheTtlMs: 60_000 },

  // ── Tape (7) ─────────────────────────────────────────────────────────────
  {
    id: 'tape', path: '/tape', group: 'tape', title: 'Tape — full history', summary: 'Multi-venue options tape, paginated + filterable',
    params: [
      { name: 'symbol', type: 'string', default: 'BTCUSDT' },
      { name: 'venues', type: 'csv' }, { name: 'instrument', type: 'string' },
      { name: 'option_type', type: 'string', enumValues: ['call', 'put'] },
      { name: 'strike_min', type: 'number' }, { name: 'strike_max', type: 'number' },
      { name: 'premium_min_usd', type: 'number' },
      { name: 'tags', type: 'csv', description: 'e.g. whale,block,sweep' },
      { name: 'before', type: 'string' }, { name: 'after', type: 'string' },
      { name: 'order', type: 'string', enumValues: ['asc', 'desc'], default: 'desc' },
      { name: 'limit', type: 'number', default: 100 },
    ],
    cacheTtlMs: 10_000,
  },
  { id: 'tape_recent', path: '/tape/recent', group: 'tape', title: 'Tape — recent trades', summary: 'Newest N trades across all venues', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'venues', type: 'csv' }, { name: 'limit', type: 'number', default: 50 }], cacheTtlMs: 5_000 },
  { id: 'tape_stats', path: '/tape/stats', group: 'tape', title: 'Tape — aggregate stats', summary: 'Aggregate stats over a window (Methix-style scorers)', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'venues', type: 'csv' }, { name: 'hours', type: 'number', default: 24 }, { name: 'premium_min_usd', type: 'number' }], cacheTtlMs: 15_000 },
  { id: 'tape_imbalance', path: '/tape/imbalance', group: 'tape', title: 'Tape imbalance', summary: 'Time-bucketed aggressor imbalance (premium or HIRO delta)', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'hours', type: 'number', default: 24 }, { name: 'bucket_minutes', type: 'number', default: 60 }, { name: 'min_size', type: 'number', default: 0 }, { name: 'weight', type: 'string', enumValues: ['premium', 'delta'], default: 'premium' }, { name: 'venues', type: 'csv' }], cacheTtlMs: 15_000 },
  { id: 'tape_strike_heat', path: '/tape/strike-heat', group: 'tape', title: 'Tape strike heat', summary: 'Net / absolute aggressor premium by strike', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'hours', type: 'number', default: 24 }, { name: 'venues', type: 'csv' }, { name: 'min_size', type: 'number', default: 0 }, { name: 'top', type: 'number', default: 15 }], cacheTtlMs: 15_000 },
  { id: 'tape_whale', path: '/tape/whale', group: 'tape', title: 'Whale prints', summary: 'Largest options prints by premium_usd in the window', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'hours', type: 'number', default: 24 }, { name: 'venues', type: 'csv' }, { name: 'premium_min_usd', type: 'number', default: 100_000 }, { name: 'limit', type: 'number', default: 20 }], cacheTtlMs: 15_000 },
  { id: 'tape_flow_by_strike', path: '/tape/flow-by-strike', group: 'tape', title: 'Flow by strike', summary: 'Cumulative aggressor buying/selling by strike on open contracts', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'expiry', type: 'string' }, { name: 'expiries', type: 'number' }, { name: 'min_premium_usd', type: 'number', default: 25_000 }, { name: 'venues', type: 'csv' }, { name: 'include', type: 'csv' }], cacheTtlMs: 15_000 },

  // ── Liquidations (2) ─────────────────────────────────────────────────────
  { id: 'liquidation_heatmap', path: '/liquidation/heatmap', group: 'liquidation', title: 'Liquidation heatmap', summary: 'Liquidation intensity (price × time), 0–100 scale', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }], cacheTtlMs: 60_000 },
  { id: 'liquidation_distribution', path: '/liquidation/distribution', group: 'liquidation', title: 'Liquidation distribution', summary: 'Per-price-level long/short liquidation volumes + leverage tiers', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }], cacheTtlMs: 60_000 },

  // ── Market data (6) ──────────────────────────────────────────────────────
  { id: 'market_candles', path: '/market/candles', group: 'market', title: 'Candles', summary: 'OHLCV with buy/sell volume split (cross-venue)', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, INTERVAL, HOURS], cacheTtlMs: 60_000 },
  { id: 'market_open_interest', path: '/market/open-interest', group: 'market', title: 'Perp open interest', summary: 'Aggregate perp OI over time on the candle grid', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, INTERVAL, HOURS], cacheTtlMs: 60_000 },
  { id: 'market_funding', path: '/market/funding', group: 'market', title: 'Funding', summary: 'Aggregate perpetual funding rate over time', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, INTERVAL, HOURS], cacheTtlMs: 60_000 },
  { id: 'market_cvd', path: '/market/cvd', group: 'market', title: 'CVD', summary: 'Cumulative volume delta with per-bucket delta', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, { name: 'market', type: 'string', enumValues: ['perp', 'spot'], required: true, default: 'perp' }, INTERVAL, HOURS], cacheTtlMs: 60_000 },
  { id: 'market_bundle', path: '/market/bundle', group: 'market', title: 'Market bundle', summary: 'Price + OI + funding on one aligned time axis', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, INTERVAL, HOURS, { name: 'series', type: 'csv', description: 'Subset of series' }], cacheTtlMs: 60_000 },
  { id: 'market_liquidations', path: '/market/liquidations', group: 'market', title: 'Perp liquidations', summary: 'Long/short liquidation series on the shared grid', params: [{ name: 'symbol', type: 'string', default: 'BTCUSDT' }, INTERVAL, HOURS], cacheTtlMs: 60_000 },

  // ── Spot ETFs (3) ────────────────────────────────────────────────────────
  { id: 'etf_flows', path: '/etf/flows', group: 'etf', title: 'ETF flows', summary: 'Daily creations/redemptions per fund + cumulative', params: [{ name: 'symbol', type: 'string', default: 'BTC' }, { name: 'region', type: 'string', enumValues: ['us', 'hk', 'all'], default: 'us' }], cacheTtlMs: 300_000 },
  { id: 'etf_premium', path: '/etf/premium', group: 'etf', title: 'ETF premium', summary: 'Premium/discount of each ETF to NAV', params: [{ name: 'symbol', type: 'string', default: 'BTC' }], cacheTtlMs: 120_000 },
  { id: 'etf_aum', path: '/etf/aum', group: 'etf', title: 'ETF AUM', summary: 'Assets under management per spot ETF', params: [{ name: 'symbol', type: 'string', default: 'BTC' }], cacheTtlMs: 300_000 },

  // ── COT (3) ──────────────────────────────────────────────────────────────
  { id: 'cot_summary', path: '/cot/summary', group: 'cot', title: 'COT across markets', summary: 'Each market\'s latest CFTC positioning, most extreme first', params: [{ name: 'asset_class', type: 'string', enumValues: ['crypto', 'financial', 'all'] }, { name: 'window', type: 'string', default: '3y' }, { name: 'sort', type: 'string', default: 'extremeness' }, { name: 'limit', type: 'number', default: 12 }, { name: 'extreme_only', type: 'boolean', default: false }], cacheTtlMs: 600_000 },
  { id: 'cot_instrument', path: '/cot/instrument', group: 'cot', title: 'COT by market', summary: 'One futures market\'s positioning by trader category', params: [{ name: 'key', type: 'string', required: true, default: 'cme_btc', description: 'Market key, e.g. cme_btc, cme_eth' }, { name: 'category', type: 'string' }, { name: 'weeks', type: 'number', default: 52 }], cacheTtlMs: 600_000 },
  { id: 'cot_markets', path: '/cot/markets', group: 'cot', title: 'COT markets', summary: 'Futures markets covered + which report each reads', params: [{ name: 'asset_class', type: 'string', enumValues: ['crypto', 'financial', 'all'] }], cacheTtlMs: 3_600_000 },

  // ── SEC filings (2) ──────────────────────────────────────────────────────
  { id: 'filings_insider', path: '/filings/insider', group: 'filings', title: 'Insider trades (Form 4)', summary: 'Officers/directors/10% owners at COIN and HOOD', params: [{ name: 'ticker', type: 'string', required: true, default: 'COIN', enumValues: ['COIN', 'HOOD'] }, { name: 'lookback', type: 'string', default: '90d' }], cacheTtlMs: 600_000 },
  { id: 'filings_holders', path: '/filings/holders', group: 'filings', title: 'Institutional holders (13F)', summary: 'Top holders of MSTR / COIN / HOOD / IBIT with quarterly change', params: [{ name: 'ticker', type: 'string', required: true, default: 'MSTR', enumValues: ['MSTR', 'COIN', 'HOOD', 'IBIT'] }, { name: 'limit', type: 'number', default: 15 }], cacheTtlMs: 600_000 },

  // ── Multi-symbol (1) ─────────────────────────────────────────────────────
  { id: 'multi_gex_levels', path: '/multi/gex/levels', group: 'multi', title: 'Multi-symbol GEX levels', summary: 'GEX levels for up to 8 symbols in one round-trip', params: [{ name: 'symbols', type: 'csv', required: true, default: 'BTCUSDT,ETHUSDT,SOLUSDT' }, { name: 'exchanges', type: 'csv' }, { name: 'include', type: 'csv' }, POSITIONING], cacheTtlMs: 30_000 },
];

// ── registry lookup helpers ─────────────────────────────────────────────────

export const BQ_ENDPOINTS_BY_ID: Record<string, BqEndpoint> = Object.fromEntries(
  BQ_ENDPOINTS.map((e) => [e.id, e]),
);

/**
 * Match a concrete request path (e.g. '/options/greeks/gamma') against the
 * registry. Returns the endpoint plus extracted path params.
 */
export function matchBqEndpoint(path: string): { endpoint: BqEndpoint; pathParams: Record<string, string> } | null {
  const clean = '/' + path.split('/').filter(Boolean).join('/');
  for (const ep of BQ_ENDPOINTS) {
    const patSegs = ep.path.split('/').filter(Boolean);
    const reqSegs = clean.split('/').filter(Boolean);
    if (patSegs.length !== reqSegs.length) continue;
    const pathParams: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < patSegs.length; i++) {
      const p = patSegs[i];
      if (p.startsWith(':')) {
        pathParams[p.slice(1)] = decodeURIComponent(reqSegs[i]);
      } else if (p !== reqSegs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { endpoint: ep, pathParams };
  }
  return null;
}

/** Grouped registry for the catalog browser UI. */
export function bqEndpointsByGroup(): Array<{ group: BqGroupMeta; endpoints: BqEndpoint[] }> {
  return BQ_GROUPS.map((group) => ({
    group,
    endpoints: BQ_ENDPOINTS.filter((e) => e.group === group.id),
  }));
}

export const BQ_ENDPOINT_COUNT = BQ_ENDPOINTS.length;

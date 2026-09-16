// Number and label formatting utilities for the terminal UI.

export function fmtUsd(v: number, opts: { compact?: boolean; sign?: boolean; decimals?: number } = {}): string {
  const { compact = false, sign = false, decimals } = opts;
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  let str: string;
  if (compact && abs >= 1_000_000) str = `${(abs / 1_000_000).toFixed(2)}M`;
  else if (compact && abs >= 10_000) str = `${(abs / 1000).toFixed(1)}k`;
  else if (decimals !== undefined) str = abs.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  else if (abs >= 1000) str = abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
  else if (abs >= 1) str = abs.toFixed(2);
  else if (abs >= 0.01) str = abs.toFixed(4);
  else str = abs.toExponential(2);
  const s = sign ? (v > 0 ? '+' : v < 0 ? '−' : '') : v < 0 ? '−' : '';
  return `${s}$${str}`;
}

export function fmtNum(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return v.toLocaleString('en-US', { maximumFractionDigits: decimals });
  if (abs >= 1) return v.toFixed(decimals);
  if (abs >= 0.001) return v.toFixed(4);
  return v.toExponential(2);
}

export function fmtPct(v: number, decimals = 1): string {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '' : '−'}${Math.abs(v * 100).toFixed(decimals)}%`;
}

export function fmtPctSigned(v: number, decimals = 1): string {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(decimals)}%`;
}

/** Gamma is tiny in absolute terms for BTC-sized underlyings; show per-1% move. */
export function gammaScaled(gamma: number, spot: number): number {
  // P&L impact of a 1% spot move from gamma ≈ 0.5 · Γ · (0.01·S)²
  return 0.5 * gamma * (0.01 * spot) ** 2;
}

export function pnlColor(v: number): string {
  if (v > 0.0001) return 'text-emerald-400';
  if (v < -0.0001) return 'text-rose-400';
  return 'text-zinc-400';
}

export function heatColor(v: number, maxAbs: number): string {
  const t = Math.min(Math.abs(v) / (maxAbs || 1), 1);
  if (v >= 0) {
    // emerald ramp
    const alpha = 0.12 + t * 0.75;
    return `rgba(16, 185, 129, ${alpha.toFixed(3)})`;
  }
  const alpha = 0.12 + t * 0.75;
  return `rgba(244, 63, 94, ${alpha.toFixed(3)})`;
}

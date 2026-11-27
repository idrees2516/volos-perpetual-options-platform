'use client';

// ─────────────────────────────────────────────────────────────────────────────
// LiveNum — a number cell that flashes teal (up) / rose (down) when its value
// changes, with tabular numerals and reserved digit width (no layout shift).
// The single "number animation" primitive for every live price/P&L cell.
//
//   <LiveNum value={spot} format={(v) => fmtNum(v, 0)} className="text-[11px]" />
//
// The flash span is keyed by a change counter so back-to-back moves in the
// same direction restart the CSS animation (remount, not class-toggle).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useRef, useState } from 'react';

export function LiveNum({
  value,
  format,
  className = '',
  flashMs = 700,
  title,
}: {
  value: number;
  format: (v: number) => string;
  className?: string;
  flashMs?: number;
  title?: string;
}) {
  const prev = useRef<number>(value);
  const [flash, setFlash] = useState<{ dir: 'up' | 'down' | null; run: number }>({ dir: null, run: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (Number.isFinite(value) && Number.isFinite(prev.current) && value !== prev.current) {
      setFlash((f) => ({ dir: value > prev.current ? 'up' : 'down', run: f.run + 1 }));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setFlash((f) => ({ ...f, dir: null })), flashMs);
    }
    prev.current = value;
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, flashMs]);

  const cls = flash.dir === 'up' ? 'volos-flash-up' : flash.dir === 'down' ? 'volos-flash-down' : '';
  return (
    <span title={title} className={`tabular font-mono ${className}`}>
      <span key={flash.run} className={`inline-block rounded-sm px-0.5 ${cls}`}>
        {Number.isFinite(value) ? format(value) : '—'}
      </span>
    </span>
  );
}

/** Signed change cell: teal/rose text + flash, e.g. +2.31% / −1.08%. */
export function LivePct({
  value,
  digits = 2,
  className = '',
}: {
  value: number;
  digits?: number;
  className?: string;
}) {
  const tone = !Number.isFinite(value) ? 'text-zinc-500' : value >= 0 ? 'text-emerald-300' : 'text-rose-300';
  return (
    <LiveNum
      value={Number.isFinite(value) ? value : NaN}
      format={(v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`}
      className={`${tone} ${className}`}
    />
  );
}

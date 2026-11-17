'use client';

// ─────────────────────────────────────────────────────────────────────────────
// PanelState — the shared loading / empty / error / ready surface for every
// panel. Skeletons are sized to the content that will replace them (rows ×
// cols), empty states say WHY there is nothing and what to do, error states
// always carry a Retry. Kills silent spinners and bare "no data" strings.
//
//   <PanelState
//     loading={!data}
//     error={fetch.error}
//     onRetry={refresh}
//     skeletonRows={8}
//     empty={data?.rows?.length === 0 && 'no markets matched the filter'}
//   >
//     …ready content…
//   </PanelState>
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

export function PanelSkeleton({ rows = 6, cols = 4, rowH = 18, className = '' }: { rows?: number; cols?: number; rowH?: number; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className}`} aria-busy="true" aria-label="loading">
      {/* header line */}
      <div className="volos-skeleton h-3 w-1/3" />
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-1.5" style={{ height: rowH }}>
          {Array.from({ length: cols }, (_, c) => (
            <div
              key={c}
              className="volos-skeleton flex-1"
              style={{ height: '100%', opacity: Math.max(0.35, 1 - r * 0.09 - c * 0.04) }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function PanelEmpty({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 py-8 text-center">
      <p className="text-[10.5px] text-zinc-400">{children}</p>
      {hint && <p className="max-w-md text-[9px] leading-relaxed text-zinc-600">{hint}</p>}
    </div>
  );
}

export function PanelError({ error, onRetry }: { error: string | null | undefined; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-rose-800/50 bg-rose-950/20 px-3 py-2">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
      <div className="min-w-0 flex-1">
        <p className="text-[9px] font-semibold uppercase tracking-wider text-rose-300">feed error</p>
        <p className="truncate text-[9px] text-rose-300/70" title={error}>{error}</p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1 rounded-md border border-rose-700/50 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-rose-200 transition hover:border-rose-500 hover:bg-rose-900/40"
        >
          <RotateCw className="h-3 w-3" />
          retry
        </button>
      )}
    </div>
  );
}

export function PanelState({
  loading,
  error,
  onRetry,
  skeletonRows = 6,
  skeletonCols = 4,
  empty,
  children,
}: {
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  skeletonRows?: number;
  skeletonCols?: number;
  /** truthy string → renders the empty state with that message */
  empty?: string | false | null | undefined;
  children: React.ReactNode;
}) {
  return (
    <>
      {error ? (
        <PanelError error={error} onRetry={onRetry} />
      ) : loading ? (
        <PanelSkeleton rows={skeletonRows} cols={skeletonCols} />
      ) : empty ? (
        <PanelEmpty>{empty}</PanelEmpty>
      ) : (
        children
      )}
    </>
  );
}

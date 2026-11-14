'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-research — TRACK B: the signal research harness console.
// Runs the factor battery over the STORED history (never live feeds), showing
// per-factor daily-block IC, quintile spreads, top-bucket hit rates and the
// IC-directed composite — plus the persisted run ledger (the track record of
// which factors actually worked, when).
// -----------------------------------------------------------------------------

import React, { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Play, Loader2 } from 'lucide-react';
import { DataTable, EmptyNote, ErrNote, LiveDot, Panel, Pill, Segmented, StatGrid } from './quant-viz';

interface IcStats {
  mean: number;
  tStat: number;
  posDayShare: number;
  days: number;
}

interface FactorResult {
  id: string;
  label: string;
  family: string;
  n: number;
  ic: IcStats | null;
  quintileMeanBps: number[];
  spreadBps: number | null;
  spreadT: number | null;
  hitRateQ5: number | null;
  verdict: 'strong' | 'inverse' | 'weak' | 'flat' | 'insufficient';
}

interface ResearchReport {
  asset: string;
  tfSec: number;
  horizonBars: number;
  lookbackDays: number;
  bars: number;
  from: string | null;
  to: string | null;
  coverage: { fundingBars: number; oiBars: number; microBars: number };
  factors: FactorResult[];
  composite: (FactorResult & { members: string[] }) | null;
  notes: string[];
}

interface RunRow {
  id: string;
  asset: string;
  tfSec: number;
  horizonBars: number;
  lookbackDays: number;
  bars: number;
  createdAt: string;
  topFactors: { id: string; ic: number; verdict: string }[];
  compositeIc: number | null;
}

const VERDICT_TONE: Record<FactorResult['verdict'], 'teal' | 'rose' | 'amber' | 'zinc' | 'violet'> = {
  strong: 'teal',
  inverse: 'violet',
  weak: 'amber',
  flat: 'zinc',
  insufficient: 'zinc',
};

const HORIZONS = [
  { id: '6', label: '30m' },
  { id: '12', label: '1h' },
  { id: '36', label: '3h' },
  { id: '96', label: '8h' },
] as const;

function fmt(v: number | null | undefined, d = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d);
}

function signTone(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'text-zinc-500';
  if (v > 0) return 'text-teal-300';
  if (v < 0) return 'text-rose-300';
  return 'text-zinc-300';
}

export function ResearchPanel({ symbol }: { symbol: string }) {
  const [horizon, setHorizon] = useState<string>('12');
  const [tfSec, setTfSec] = useState<string>('300');
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ranAt, setRanAt] = useState<number | null>(null);
  const [ledger, setLedger] = useState<RunRow[]>([]);

  const loadLedger = useCallback(async () => {
    try {
      const res = await fetch('/api/research/results?limit=8', { cache: 'no-store' });
      const json = (await res.json()) as { runs?: RunRow[] };
      setLedger(json.runs ?? []);
    } catch {
      /* ledger is best-effort */
    }
  }, []);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/research/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ asset: symbol, tfSec: Number(tfSec), horizonBars: Number(horizon) }),
      });
      const json = (await res.json()) as ResearchReport & { error?: string };
      if (json.error) setError(json.error);
      else {
        setReport(json);
        setRanAt(Date.now());
        void loadLedger();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [symbol, horizon, tfSec, loadLedger]);

  const comp = report?.composite ?? null;
  const topFactors = report?.factors ?? [];
  const horizonLabel = report ? `${((report.horizonBars * report.tfSec) / 3600).toFixed(1)}h` : '—';

  const age = ranAt ? `${Math.max(0, Math.round((Date.now() - ranAt) / 1000))}s ago` : '—';

  return (
    <div className="space-y-2">
      <Panel
        title="Signal Research Harness · Stored History"
        sub="daily-block Spearman IC · quintile spreads · hit rates — every run persisted (the track record)"
        right={
          <div className="flex items-center gap-2">
            <LiveDot ok={Boolean(report)} label={report ? `run ${age}` : 'no run yet'} />
            <button
              onClick={() => void run()}
              disabled={running}
              className="flex items-center gap-1 rounded-md border border-teal-800/60 bg-teal-950/40 px-2 py-1 font-mono text-[9.5px] text-teal-300 transition hover:bg-teal-900/40 disabled:opacity-50"
            >
              {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              run {symbol} · {HORIZONS.find((h) => h.id === horizon)?.label}
            </button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={tfSec}
            onChange={setTfSec}
            options={[
              { id: '60', label: '1m bars' },
              { id: '300', label: '5m bars' },
              { id: '1800', label: '30m bars' },
            ]}
          />
          <Segmented value={horizon} onChange={setHorizon} options={HORIZONS.map((h) => ({ id: h.id, label: h.label }))} />
        </div>
        <ErrNote error={error} />
        {!report && !error && (
          <EmptyNote>
            run the harness over the stored klines/funding/OI history — {running ? 'computing…' : 'no run yet for this view'}
          </EmptyNote>
        )}
        {report && (
          <>
            <div className="mt-1.5">
              <StatGrid
                cols={4}
                stats={[
                  { label: 'bars scored', value: report.bars.toLocaleString(), sub: `${report.from?.slice(0, 10)} → ${report.to?.slice(0, 10)}` },
                  { label: 'horizon', value: horizonLabel, sub: `${report.horizonBars} bars · ${report.tfSec}s` },
                  { label: 'composite IC', value: fmt(comp?.ic?.mean ?? null, 4), sub: comp ? `${comp.members.length} factors · ${comp.verdict}` : 'not enough eligible factors', tone: (comp?.ic?.mean ?? 0) >= 0 ? 'teal' : 'rose' },
                  { label: 'composite Q5−Q1', value: `${fmt(comp?.spreadBps ?? null, 1)} bps`, sub: comp?.ic ? `t ${fmt(comp.ic.tStat, 1)} · hit ${fmt(comp.hitRateQ5, 3)}` : null, tone: (comp?.spreadBps ?? 0) >= 0 ? 'teal' : 'rose' },
                ]}
              />
            </div>
            {report.notes.length > 0 && (
              <p className="mt-1.5 font-mono text-[8.5px] leading-relaxed text-zinc-600">{report.notes.join(' · ')}</p>
            )}
            <div className="mt-1.5">
              <DataTable<FactorResult>
                rows={topFactors}
                maxRows={13}
                rowKey={(r) => r.id}
                columns={[
                  { key: 'id', label: 'factor', align: 'l', render: (r) => <span title={r.label}>{r.id}</span> },
                  { key: 'fam', label: 'family', align: 'l', render: (r) => <span className="text-zinc-500">{r.family}</span> },
                  { key: 'ic', label: 'IC', render: (r) => <span className={signTone(r.ic?.mean)}>{fmt(r.ic?.mean ?? null, 4)}</span> },
                  { key: 'ict', label: 'IC t', render: (r) => <span className={signTone(r.ic?.tStat)}>{fmt(r.ic?.tStat ?? null, 1)}</span> },
                  { key: 'posday', label: '+days', render: (r) => fmt(r.ic ? r.ic.posDayShare * 100 : null, 0) + '%' },
                  {
                    key: 'q',
                    label: 'Q1 → Q5 (bps)',
                    align: 'l',
                    render: (r) => (
                      <span className="text-zinc-400">
                        {r.quintileMeanBps.map((q, i) => (
                          <span key={i}>
                            {i > 0 && <span className="text-zinc-700"> → </span>}
                            <span className={signTone(q)}>{fmt(q, 1)}</span>
                          </span>
                        ))}
                      </span>
                    ),
                  },
                  { key: 'spread', label: 'Q5−Q1', render: (r) => <span className={signTone(r.spreadBps)}>{fmt(r.spreadBps, 1)}</span> },
                  { key: 'spt', label: 'spread t', render: (r) => fmt(r.spreadT, 1) },
                  { key: 'hit', label: 'Q5 hit', render: (r) => <span className={signTone((r.hitRateQ5 ?? 0.5) - 0.5)}>{fmt(r.hitRateQ5, 3)}</span> },
                  {
                    key: 'verdict',
                    label: 'verdict',
                    align: 'l',
                    render: (r) => (
                      <Pill tone={VERDICT_TONE[r.verdict]}>{r.verdict}</Pill>
                    ),
                  },
                ]}
              />
            </div>
            <p className="mt-1 font-mono text-[8px] leading-relaxed text-zinc-600">
              IC &gt; 0: higher score → higher forward return; negative = inverse (fade it). Decision-grade at |t| ≥ 2 with same-sign spread. Overlapping horizons inflate t-stats ~√h — screening evidence, not confirmation.
            </p>
          </>
        )}
      </Panel>

      <Panel title="Persisted Run Ledger" sub="every harness run survives restarts — which factors worked, when">
        {ledger.length === 0 ? (
          <EmptyNote>no persisted runs yet — run the harness above</EmptyNote>
        ) : (
          <DataTable<RunRow>
            rows={ledger}
            maxRows={8}
            rowKey={(r) => r.id}
            columns={[
              { key: 't', label: 'run', align: 'l', render: (r) => new Date(r.createdAt).toISOString().slice(5, 16).replace('T', ' ') },
              { key: 'a', label: 'asset', align: 'l', render: (r) => r.asset },
              { key: 'tf', label: 'tf', render: (r) => `${r.tfSec}s` },
              { key: 'h', label: 'horizon', render: (r) => `${((r.horizonBars * r.tfSec) / 3600).toFixed(1)}h` },
              { key: 'bars', label: 'bars', render: (r) => r.bars.toLocaleString() },
              {
                key: 'top',
                label: 'top factors',
                align: 'l',
                render: (r) => (
                  <span className="text-zinc-400">
                    {r.topFactors.map((f, i) => (
                      <span key={i}>
                        {i > 0 && <span className="text-zinc-700"> · </span>}
                        <span className={signTone(f.ic)}>{f.id}</span>
                      </span>
                    ))}
                  </span>
                ),
              },
              { key: 'cic', label: 'composite IC', render: (r) => <span className={signTone(r.compositeIc)}>{fmt(r.compositeIc, 4)}</span> },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}

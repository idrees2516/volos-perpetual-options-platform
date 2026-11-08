'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-macro — ETF & Filings: real daily US spot-ETF flows
// (farside), CFTC COT positioning with history, SEC Form 4 + 13F holders.
// -----------------------------------------------------------------------------

import React, { useState } from 'react';
import { fmtUsd, fmtNum } from '@/lib/format';
import { useQuant } from './use-quant';
import { DataTable, EmptyNote, ErrNote, LineChart, Panel, Pill, Segmented, StatGrid } from './quant-viz';

interface EtfData {
  asset: string;
  latestDate: string | null;
  funds: { fund: string; ticker: string; dailyUsd: number; cumUsd: number }[];
  totalDailyUsd: number | null;
  totalCumUsd: number | null;
  series: { date: string; totalUsd: number }[];
  source: string;
}
interface CotData {
  market: string;
  reportDate: string;
  oi: number;
  nonCommLong: number;
  nonCommShort: number;
  nonCommNet: number;
  commNet: number;
  nonReptNet: number;
  hist: { date: string; nonCommNet: number; oi: number }[];
}
interface Form4Data {
  ticker: string;
  items: { filingDate: string; owner: string; role: string; shares: number; price: number; action: string; valueUsd: number; url: string }[];
}
interface HoldersData {
  ticker: string;
  items: { holder: string; filingDate: string; issuer: string; valueUsd: number; shares: number; putCall: string }[];
}

export function MacroPanel() {
  const [asset, setAsset] = useState<'BTC' | 'ETH'>('BTC');
  const [insider, setInsider] = useState<'COIN' | 'HOOD' | 'MSTR'>('COIN');
  const [holders, setHolders] = useState<'MSTR' | 'COIN' | 'HOOD' | 'IBIT'>('MSTR');
  const etf = useQuant<EtfData>('/macro', { view: 'etf', asset }, { pollMs: 30 * 60_000 });
  const cot = useQuant<CotData>('/macro', { view: 'cot', market: 'BITCOIN' }, { pollMs: 6 * 3600_000 });
  const form4 = useQuant<Form4Data>('/macro', { view: 'form4', ticker: insider }, { pollMs: 3600_000 });
  const h13 = useQuant<HoldersData>('/macro', { view: 'holders13f', ticker: holders }, { pollMs: 6 * 3600_000 });

  const e = etf.data;
  const ts = e?.series?.map((p) => ({ x: new Date(p.date).getTime(), y: p.totalUsd * 1e6 })) ?? [];
  const cum: { x: number; y: number }[] = [];
  let acc = 0;
  for (const p of ts) {
    acc += p.y;
    cum.push({ x: p.x, y: acc });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={asset} onChange={setAsset} options={[{ id: 'BTC', label: 'BTC ETFs' }, { id: 'ETH', label: 'ETH ETFs' }]} />
        <Pill tone="teal">farside.co.uk · real daily creations</Pill>
      </div>

      <ErrNote error={etf.error} />
      {e && (
        <Panel
          title={`US Spot-${asset} ETF Flows`}
          sub={e.source}
          right={<Pill tone={((e.totalDailyUsd ?? 0) >= 0 ? 'emerald' : 'rose')}>{e.latestDate ?? '—'} · {fmtUsd(e.totalDailyUsd ?? 0, { compact: true, sign: true })}</Pill>}
        >
          <StatGrid
            cols={4}
            stats={[
              { label: 'latest daily net', value: fmtUsd(e.totalDailyUsd ?? 0, { compact: true, sign: true }), tone: (e.totalDailyUsd ?? 0) >= 0 ? 'emerald' : 'rose', sub: e.latestDate ?? '—' },
              { label: 'window cumulative', value: fmtUsd(e.totalCumUsd ?? 0, { compact: true, sign: true }), sub: `${e.series.length} sessions` },
              { label: 'funds reporting', value: e.funds.length, sub: 'per-fund split below' },
              { label: 'top flow today', value: e.funds.length ? `${e.funds.reduce((a, f) => (Math.abs(f.dailyUsd) > Math.abs(a.dailyUsd) ? f : a), e.funds[0]).ticker}` : '—', sub: e.funds.length ? fmtUsd(e.funds.reduce((a, f) => (Math.abs(f.dailyUsd) > Math.abs(a.dailyUsd) ? f : a), e.funds[0]).dailyUsd, { compact: true, sign: true }) : '' },
            ]}
          />
          {ts.length > 2 && (
            <div className="mt-2 grid gap-2 lg:grid-cols-2">
              <div>
                <p className="mb-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-zinc-600">daily net flow</p>
                <LineChart height={140} yFormat={(v) => fmtUsd(v, { compact: true })} series={[{ label: 'daily', points: ts }]} xFormat={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} yZero />
              </div>
              <div>
                <p className="mb-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-zinc-600">cumulative (window)</p>
                <LineChart height={140} yFormat={(v) => fmtUsd(v, { compact: true })} series={[{ label: 'cum', points: cum, color: '#a78bfa' }]} xFormat={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} yZero />
              </div>
            </div>
          )}
          <div className="mt-2">
            <DataTable
              rows={e.funds}
              maxRows={12}
              rowKey={(f) => f.ticker}
              columns={[
                { key: 'fund', label: 'fund', align: 'l', render: (f) => <span className="text-zinc-300">{f.fund}</span> },
                { key: 'ticker', label: 'ticker', align: 'l', render: (f) => <span className="font-mono text-teal-300">{f.ticker}</span> },
                { key: 'daily', label: 'daily $', render: (f) => <span className={f.dailyUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{fmtUsd(f.dailyUsd, { compact: true, sign: true })}</span> },
                { key: 'cum', label: 'cum $', render: (f) => fmtUsd(f.cumUsd, { compact: true, sign: true }) },
              ]}
            />
          </div>
          <p className="mt-1 text-[8px] text-zinc-600">settlement lags a business day by design · cumulative covers the visible farside window</p>
        </Panel>
      )}

      <div className="grid gap-2 xl:grid-cols-2">
        <Panel title="CFTC Commitments of Traders · CME Bitcoin" sub={`legacy futures-only · ${cot.data?.reportDate ?? '—'}`} right={<Pill tone="teal">publicreporting.cftc.gov</Pill>}>
          <ErrNote error={cot.error} />
          {cot.data ? (
            <>
              <StatGrid
                cols={4}
                stats={[
                  { label: 'open interest', value: fmtNum(cot.data.oi, 0), sub: 'contracts' },
                  { label: 'non-comm net', value: fmtNum(cot.data.nonCommNet, 0), tone: cot.data.nonCommNet >= 0 ? 'emerald' : 'rose', sub: `L${cot.data.nonCommLong} / S${cot.data.nonCommShort}` },
                  { label: 'commercial net', value: fmtNum(cot.data.commNet, 0), sub: 'dealers/hedgers' },
                  { label: 'non-reportable', value: fmtNum(cot.data.nonReptNet, 0), sub: 'retail residual' },
                ]}
              />
              {cot.data.hist.length > 3 && (
                <div className="mt-2">
                  <LineChart
                    height={130}
                    yFormat={(v) => fmtNum(v, 0)}
                    series={[{ label: 'non-comm net', points: cot.data.hist.map((h) => ({ x: new Date(h.date).getTime(), y: h.nonCommNet })) }]}
                    xFormat={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    yZero
                  />
                </div>
              )}
            </>
          ) : (
            <EmptyNote>{cot.loading ? 'loading…' : '—'}</EmptyNote>
          )}
        </Panel>

        <div className="space-y-2">
          <Panel
            title="SEC Form 4 · Insider Trades"
            sub="data.sec.gov · latest filings"
            right={<Segmented value={insider} onChange={setInsider} options={[{ id: 'COIN', label: 'COIN' }, { id: 'HOOD', label: 'HOOD' }, { id: 'MSTR', label: 'MSTR' }]} />}
          >
            <ErrNote error={form4.error} />
            {form4.data?.items?.length ? (
              <DataTable
                rows={form4.data.items}
                maxRows={7}
                rowKey={(r) => r.url}
                columns={[
                  { key: 'date', label: 'filed', render: (r) => r.filingDate },
                  { key: 'owner', label: 'owner', align: 'l', render: (r) => <a href={r.url} target="_blank" rel="noreferrer" className="text-zinc-300 hover:text-teal-300 hover:underline">{r.owner}</a> },
                  { key: 'action', label: 'action', render: (r) => <span className={r.action === 'acquire' ? 'text-emerald-300' : 'text-rose-300'}>{r.action}</span> },
                  { key: 'shares', label: 'shares', render: (r) => fmtNum(r.shares, 0) },
                  { key: 'value', label: 'value', render: (r) => fmtUsd(r.valueUsd, { compact: true }) },
                ]}
              />
            ) : (
              <EmptyNote>{form4.loading ? 'loading…' : 'no recent filings'}</EmptyNote>
            )}
          </Panel>

          <Panel
            title="SEC 13F · Institutional Holders"
            sub="efts full-text search · latest quarter"
            right={<Segmented value={holders} onChange={setHolders} options={[{ id: 'MSTR', label: 'MSTR' }, { id: 'COIN', label: 'COIN' }, { id: 'HOOD', label: 'HOOD' }, { id: 'IBIT', label: 'IBIT' }]} />}
          >
            <ErrNote error={h13.error} />
            {h13.data?.items?.length ? (
              <DataTable
                rows={h13.data.items}
                maxRows={6}
                rowKey={(r) => r.holder + r.filingDate}
                columns={[
                  { key: 'holder', label: 'holder', align: 'l', render: (r) => <span className="text-zinc-300">{r.holder}</span> },
                  { key: 'value', label: 'position', render: (r) => fmtUsd(r.valueUsd, { compact: true }) },
                  { key: 'shares', label: 'shares', render: (r) => fmtNum(r.shares, 0) },
                  { key: 'date', label: 'filed', render: (r) => r.filingDate },
                ]}
              />
            ) : (
              <EmptyNote>{h13.loading ? 'searching EDGAR…' : 'no holders parsed (SEC rate limits)'}</EmptyNote>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

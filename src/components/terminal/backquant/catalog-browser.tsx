'use client';

// -----------------------------------------------------------------------------
// backquant/catalog-browser — the 70-endpoint API catalog browser.
//
// Renders the full BackQuant v2 registry (grouped, searchable), lets the user
// set params per endpoint and FIRE the request through /api/backquant/* —
// showing the raw envelope (data + meta) exactly as the data plane returns it.
// Also surfaces the MCP surface: the 23 tools + how to connect Claude/Cursor.
// -----------------------------------------------------------------------------

import React, { useMemo, useState } from 'react';
import { Search, Send, Loader2, Plug, BookOpen } from 'lucide-react';
import { BQ_GROUPS, BQ_ENDPOINTS } from '@/lib/backquant/endpoints';
import type { BqEndpoint } from '@/lib/backquant/types';
import { Panel, ModeBadge, fmtTime } from './bq-viz';

export function CatalogBrowser({ symbol }: { symbol: string }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<BqEndpoint | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [response, setResponse] = useState<{ json: string; status: number; mode: string } | null>(null);
  const [firing, setFiring] = useState(false);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    return BQ_GROUPS.map((g) => ({
      group: g,
      endpoints: BQ_ENDPOINTS.filter(
        (e) =>
          e.group === g.id &&
          (!q || e.title.toLowerCase().includes(q) || e.path.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q) || e.id.includes(q)),
      ),
    })).filter((x) => x.endpoints.length > 0);
  }, [query]);

  const concretePath = (ep: BqEndpoint): string =>
    ep.path
      .split('/')
      .map((seg) => {
        if (!seg.startsWith(':')) return seg;
        return paramValues[seg.slice(1)] || 'gamma';
      })
      .join('/');

  const fire = async (ep: BqEndpoint) => {
    setFiring(true);
    setResponse(null);
    try {
      const qs = new URLSearchParams();
      for (const p of ep.params) {
        if (p.name === 'greek' || p.name.startsWith(':')) continue;
        const v = paramValues[p.name];
        if (v) qs.set(p.name, v);
      }
      if (!qs.get('symbol') && !['symbols', 'ticker', 'key', 'kind'].includes(ep.params[0]?.name ?? '')) qs.set('symbol', symbol);
      const res = await fetch(`/api/backquant${concretePath(ep)}?${qs.toString()}`, { cache: 'no-store' });
      const json = JSON.stringify(await res.json(), null, 2);
      setResponse({ json: json.length > 24_000 ? `${json.slice(0, 24_000)}\n… (truncated for display)` : json, status: res.status, mode: res.headers.get('X-BackQuant-Mode') ?? '?' });
    } catch (e) {
      setResponse({ json: String(e), status: 0, mode: '?' });
    } finally {
      setFiring(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[1fr_1.1fr]">
        <Panel
          title="v2 REST Endpoint Catalog"
          subtitle={`${BQ_ENDPOINTS.length} endpoints across ${BQ_GROUPS.length} groups — searchable, every one callable`}
          right={
            <div className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/60 px-1.5">
              <Search className="h-3 w-3 text-zinc-600" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter endpoints…"
                className="w-[130px] bg-transparent text-[10px] text-zinc-200 placeholder-zinc-600 focus:outline-none"
              />
            </div>
          }
        >
          <div className="max-h-[520px] space-y-3 overflow-y-auto pr-1">
            {grouped.map(({ group, endpoints }) => (
              <div key={group.id}>
                <p className="mb-1 text-[8.5px] font-bold uppercase tracking-[0.14em] text-teal-400/80">
                  {group.label} <span className="font-mono text-zinc-600">({endpoints.length})</span>
                </p>
                <p className="mb-1.5 text-[8.5px] text-zinc-600">{group.blurb}</p>
                <div className="space-y-0.5">
                  {endpoints.map((ep) => (
                    <button
                      key={ep.id}
                      onClick={() => {
                        setSelected(ep);
                        setResponse(null);
                        setParamValues(Object.fromEntries(ep.params.filter((p) => p.default != null).map((p) => [p.name, String(p.default)])));
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition ${
                        selected?.id === ep.id ? 'bg-teal-950/40 ring-1 ring-teal-500/30' : 'hover:bg-zinc-900/60'
                      }`}
                    >
                      <code className={`shrink-0 font-mono text-[9px] ${selected?.id === ep.id ? 'text-teal-300' : 'text-zinc-400'}`}>{ep.path}</code>
                      <span className="min-w-0 flex-1 truncate text-[9px] text-zinc-600">{ep.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <div className="space-y-3">
          {selected ? (
            <Panel
              title={selected.title}
              subtitle={`GET /v2${selected.path}`}
              right={
                <button
                  onClick={() => fire(selected)}
                  disabled={firing}
                  className="flex items-center gap-1 rounded-md bg-teal-600/90 px-2 py-1 text-[9px] font-semibold uppercase text-white transition hover:bg-teal-500 disabled:opacity-50"
                >
                  {firing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  try it
                </button>
              }
            >
              <p className="text-[10px] leading-relaxed text-zinc-400">{selected.summary}</p>
              <div className="mt-2 space-y-1">
                <p className="text-[8.5px] font-semibold uppercase tracking-wider text-zinc-500">parameters</p>
                {selected.params.length === 0 ? (
                  <p className="text-[9px] text-zinc-600">none</p>
                ) : (
                  selected.params.map((p) => (
                    <div key={p.name} className="flex items-center gap-2">
                      <code className="w-[110px] shrink-0 truncate font-mono text-[9px] text-zinc-300" title={p.name}>
                        {p.name}
                        {p.required ? <span className="text-rose-400">*</span> : ''}
                      </code>
                      {p.enumValues ? (
                        <select
                          value={paramValues[p.name] ?? p.enumValues[0]}
                          onChange={(e) => setParamValues((v) => ({ ...v, [p.name]: e.target.value }))}
                          className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[9px] text-zinc-200 focus:outline-none"
                        >
                          {p.enumValues.map((ev) => (
                            <option key={ev} value={ev}>{ev}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={paramValues[p.name] ?? ''}
                          onChange={(e) => setParamValues((v) => ({ ...v, [p.name]: e.target.value }))}
                          placeholder={p.default != null ? String(p.default) : p.type}
                          className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[9px] text-zinc-200 placeholder-zinc-700 focus:outline-none"
                        />
                      )}
                    </div>
                  ))
                )}
              </div>
              {response ? (
                <div className="mt-3">
                  <div className="mb-1 flex items-center gap-2 text-[9px] text-zinc-500">
                    <span className={`rounded px-1 font-mono ${response.status === 200 ? 'bg-teal-950/50 text-teal-300' : 'bg-rose-950/50 text-rose-300'}`}>{response.status}</span>
                    <ModeBadge mode={response.mode === 'live' || response.mode === 'demo' ? response.mode : 'unknown'} small />
                    <span className="ml-auto font-mono">{fmtTime(new Date())}</span>
                  </div>
                  <pre className="max-h-[300px] overflow-auto rounded-md border border-zinc-800/60 bg-zinc-950/60 p-2 font-mono text-[8.5px] leading-relaxed text-zinc-300">{response.json}</pre>
                </div>
              ) : null}
            </Panel>
          ) : (
            <Panel title="Endpoint Inspector" subtitle="select an endpoint from the catalog">
              <p className="py-6 text-center text-[10px] text-zinc-600">
                <BookOpen className="mx-auto mb-1 h-4 w-4 text-zinc-700" />
                pick any of the {BQ_ENDPOINTS.length} endpoints to inspect its parameters and fire a live request
              </p>
            </Panel>
          )}

          <Panel title="MCP Surface" subtitle="23 tools · VolOS MCP server at /api/backquant/mcp">
            <div className="space-y-2 text-[10px] leading-relaxed text-zinc-400">
              <p>
                <Plug className="mr-1 inline h-3 w-3 text-violet-400" />
                VolOS mirrors BackQuant&apos;s remote MCP server (<code className="font-mono text-[9px] text-zinc-500">mcp.backquant.com/mcp</code>) — the same 23 conversational tools
                (get_brief, get_gex_levels, get_tape, get_iv, get_probability …) are served at <code className="font-mono text-[9px] text-teal-400">/api/backquant/mcp</code> on this data plane.
              </p>
              <pre className="overflow-x-auto rounded-md border border-zinc-800/60 bg-zinc-950/60 p-2 font-mono text-[8.5px] text-zinc-400">{`// point Claude / Cursor / VS Code at VolOS:
{
  "mcpServers": {
    "volos-backquant": {
      "url": "http://localhost:3000/api/backquant/mcp"
    }
  }
}`}</pre>
              <p className="text-zinc-600">
                The AI Copilot uses the same tools in-chat (bq_* toolbelt) — with a BackQuant API key it can also route through the real mcp.backquant.com (<code className="font-mono">bq_transport=mcp</code>).
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

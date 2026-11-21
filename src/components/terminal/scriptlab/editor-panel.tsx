'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab — EditorPanel. Name/category toolbar, auto-generated settings
// form (from input.* declarations — ints, floats, bools, selects, sources),
// the highlighted code editor, Run / Save / New-template actions and a
// compile status strip with jump-to-error.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useRef, useState } from 'react';
import { Play, Save, FilePlus2, CircleAlert, CircleCheck, Loader2, ChartCandlestick } from 'lucide-react';
import { useScriptLab } from '@/stores/scriptlab-store';
import { SCRIPT_CATEGORIES } from '@/lib/scriptlang/library';
import { pushScriptToChart } from '@/components/terminal/chartdesk/price-chart-view';
import { CodeEditor } from './code-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

const SOURCE_SERIES = [
  'open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4',
  'volume', 'buyvol', 'sellvol', 'delta', 'cvd',
] as const;

export function EditorPanel() {
  const {
    scriptName,
    scriptCode,
    scriptCategory,
    result,
    running,
    inputs,
    setCode,
    setDraftMeta,
    setInput,
    rerun,
    newFromTemplate,
    saveScript,
    bars,
  } = useScriptLab();
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const kindBadge = result?.ok ? result.kind : '—';
  const status = useMemo(() => {
    if (running) return { t: 'compiling…', err: false } as const;
    if (!result) return { t: 'not run yet', err: false } as const;
    if (!result.ok)
      return {
        t: `line ${result.error?.line ?? '?'} · ${result.error?.message ?? 'error'}`,
        err: true,
      } as const;
    const parts = [`${result.plots.length} plot${result.plots.length === 1 ? '' : 's'}`, `${result.runtimeMs} ms`];
    if (result.shapes.length) parts.push(`${result.shapes.length} shapes`);
    if (result.hlines.length) parts.push(`${result.hlines.length} levels`);
    return { t: parts.join(' · '), err: false } as const;
  }, [result, running]);

  const doSave = async () => {
    setSaving(true);
    const err = await saveScript();
    setSaving(false);
    setSaveMsg(err ?? `saved “${scriptName}” to the library`);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setSaveMsg(null), 4000);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2.5">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          value={scriptName}
          onChange={(e) => setDraftMeta({ name: e.target.value })}
          aria-label="Script name"
          className="h-7 w-40 flex-1 min-w-[120px] border-zinc-800 bg-zinc-950 text-[11px]"
          placeholder="script name"
        />
        <Select value={scriptCategory} onValueChange={(v) => setDraftMeta({ category: v })}>
          <SelectTrigger className="h-7 w-[150px] border-zinc-800 bg-zinc-950 text-[10px]" aria-label="Category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {SCRIPT_CATEGORIES.map((c) => (
              <SelectItem key={c.key} value={c.key} className="text-[11px]">
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span
          className={`rounded px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${
            kindBadge === 'strategy' ? 'bg-violet-950/70 text-violet-300 ring-1 ring-violet-500/30' : 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30'
          }`}
        >
          {kindBadge}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 border-zinc-800 bg-zinc-950 px-2 text-[10px]"
          onClick={() => newFromTemplate('indicator')}
          title="Start a fresh indicator from a template"
        >
          <FilePlus2 className="h-3 w-3" /> ind
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 border-zinc-800 bg-zinc-950 px-2 text-[10px]"
          onClick={() => newFromTemplate('strategy')}
          title="Start a fresh strategy from a template"
        >
          <FilePlus2 className="h-3 w-3" /> strat
        </Button>
        <Button
          size="sm"
          className="h-7 gap-1 bg-teal-600 px-2.5 text-[10px] font-semibold text-zinc-950 hover:bg-teal-500"
          onClick={() => rerun()}
          disabled={!bars}
          title="Compile & run — Ctrl/Cmd+Enter"
        >
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          run
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 border-teal-800/60 bg-teal-950/40 px-2 text-[10px] text-teal-300 hover:bg-teal-900/40"
          onClick={() => {
            if (scriptCode) {
              const ok = pushScriptToChart(scriptCode, scriptName);
              setSaveMsg(ok ? (ok === 'queued' ? 'queued — opening the Chart Desk…' : 'pushed onto the Chart Desk price chart') : 'push failed');
              if (saveTimer.current) clearTimeout(saveTimer.current);
              saveTimer.current = setTimeout(() => setSaveMsg(null), 4000);
            }
          }}
          disabled={!result?.ok || !scriptCode}
          title="Register this script as a study on the TradingView-style Chart Desk (candles, 112 built-ins, drawings) — the chart\u2019s SOURCE button brings you back here"
        >
          <ChartCandlestick className="h-3 w-3" /> on price chart
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 border-zinc-800 bg-zinc-950 px-2 text-[10px]"
          onClick={doSave}
          disabled={saving}
          title="Save to the script library (SQLite)"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          save
        </Button>
      </div>

      {/* auto-generated settings form from input.* declarations */}
      {result?.ok && result.inputs.length > 0 && (
        <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5 rounded-md border border-zinc-800/80 bg-zinc-950/50 px-2.5 py-2">
          {result.inputs.map((inp) => (
            <label key={inp.key} className="flex min-w-[86px] flex-col gap-1">
              <span className="text-[8.5px] font-semibold uppercase tracking-wider text-zinc-500">{inp.title}</span>
              {inp.type === 'int' || inp.type === 'float' ? (
                <Input
                  type="number"
                  value={String(inputs[inp.key] ?? inp.def)}
                  min={inp.minval}
                  max={inp.maxval}
                  step={inp.step ?? (inp.type === 'int' ? 1 : 'any')}
                  onChange={(e) => setInput(inp.key, Number(e.target.value))}
                  className="h-6 w-[86px] border-zinc-800 bg-zinc-950 font-mono text-[10.5px]"
                />
              ) : inp.type === 'bool' ? (
                <Switch
                  checked={inputs[inp.key] === true || inputs[inp.key] === 1 || inputs[inp.key] === undefined ? Boolean(inp.def) : false}
                  onCheckedChange={(v) => setInput(inp.key, v)}
                />
              ) : inp.type === 'source' ? (
                <Select value={String(inputs[inp.key] ?? inp.def)} onValueChange={(v) => setInput(inp.key, v)}>
                  <SelectTrigger className="h-6 w-[110px] border-zinc-800 bg-zinc-950 font-mono text-[10.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {SOURCE_SERIES.map((s) => (
                      <SelectItem key={s} value={s} className="font-mono text-[10.5px]">
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Select value={String(inputs[inp.key] ?? inp.def)} onValueChange={(v) => setInput(inp.key, v)}>
                  <SelectTrigger className="h-6 w-[130px] border-zinc-800 bg-zinc-950 text-[10.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {(inp.options ?? [String(inp.def)]).map((o) => (
                      <SelectItem key={o} value={o} className="text-[10.5px]">
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </label>
          ))}
        </div>
      )}

      {/* code */}
      <CodeEditor code={scriptCode} onChange={setCode} onRun={() => rerun()} errorLine={result?.ok ? undefined : result?.error?.line} />

      {/* status strip */}
      <div className="flex min-h-[22px] items-center gap-2 rounded border border-zinc-800/80 bg-zinc-950/50 px-2 font-mono text-[9.5px]">
        {status.err ? (
          <>
            <CircleAlert className="h-3 w-3 shrink-0 text-rose-400" />
            <span className="truncate text-rose-300">{status.t}</span>
          </>
        ) : (
          <>
            <CircleCheck className="h-3 w-3 shrink-0 text-emerald-400" />
            <span className="truncate text-zinc-400">{status.t}</span>
          </>
        )}
        {saveMsg && <span className="ml-auto shrink-0 text-teal-300">{saveMsg}</span>}
        {scriptCode !== undefined && scriptCode.length > 0 && (
          <span className="ml-auto shrink-0 text-zinc-600">{scriptCode.split('\n').length} lines · {scriptCode.length} chars</span>
        )}
      </div>
    </div>
  );
}

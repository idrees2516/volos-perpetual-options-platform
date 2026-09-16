'use client';

// Chart controls: spot/IV/time-travel sliders, decay animation player,
// curve visibility toggles. The "moving" risk profile the user asked for.

import React, { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Play, Pause, RotateCcw, Clock, TrendingUp, Waves } from 'lucide-react';
import { useStrategy } from '@/stores/strategy-store';
import { fmtPctSigned } from '@/lib/format';

interface ChartControlsProps {
  horizonDays: number;
  hasLegs: boolean;
}

export function ChartControls({ horizonDays, hasLegs }: ChartControlsProps) {
  const {
    overrides, setOverrides, resetOverrides, showCone, showDecay, showNow,
    toggle, playing, setPlaying, playMode, setPlayMode,
  } = useStrategy();

  // Time-decay / spot-walk animation loop.
  useEffect(() => {
    if (!playing || !hasLegs) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const ov = useStrategy.getState().overrides;
      if (playMode === 'decay') {
        const next = ov.daysForward + dt * (horizonDays / 6); // full decay in ~6s
        if (next >= horizonDays) {
          setOverrides({ daysForward: horizonDays });
          setPlaying(false);
          return;
        }
        setOverrides({ daysForward: next });
      } else {
        // Spot-walk: gentle oscillation for the "breathing" market view.
        const t = ov.spotShiftPct + dt * 4;
        setOverrides({ spotShiftPct: t > 15 ? -15 : t });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, playMode, horizonDays, hasLegs, setOverrides, setPlaying]);

  const anyOverride = overrides.spotShiftPct !== 0 || overrides.ivShiftPct !== 0 || overrides.daysForward !== 0;

  return (
    <div className="flex flex-col gap-3 border-t border-zinc-800/70 px-4 py-3 lg:flex-row lg:items-center lg:gap-6">
      {/* Player */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!hasLegs}
          onClick={() => setPlaying(!playing)}
          className="h-8 w-8 border-teal-500/40 bg-teal-950/30 p-0 text-teal-300 hover:bg-teal-900/40 hover:text-teal-200"
          title={playMode === 'decay' ? 'Animate time decay to horizon' : 'Animate spot walk'}
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!hasLegs}
          onClick={() => { setPlayMode(playMode === 'decay' ? 'spot' : 'decay'); }}
          className={`h-8 gap-1.5 px-2 text-[10px] font-medium ${playMode === 'decay' ? 'text-amber-400' : 'text-teal-300'}`}
          title="Switch animation mode"
        >
          {playMode === 'decay' ? <Clock className="h-3.5 w-3.5" /> : <Waves className="h-3.5 w-3.5" />}
          {playMode === 'decay' ? 'Time decay' : 'Spot walk'}
        </Button>
        {anyOverride && (
          <Button
            size="sm"
            variant="ghost"
            onClick={resetOverrides}
            className="h-8 gap-1 px-2 text-[10px] text-zinc-400 hover:text-zinc-200"
          >
            <RotateCcw className="h-3 w-3" /> Reset view
          </Button>
        )}
      </div>

      {/* Sliders */}
      <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-3">
        <SliderControl
          icon={<TrendingUp className="h-3 w-3" />}
          label="Spot"
          value={overrides.spotShiftPct}
          min={-30}
          max={30}
          step={0.5}
          display={fmtPctSigned(overrides.spotShiftPct / 100, 1)}
          onChange={(v) => setOverrides({ spotShiftPct: v })}
        />
        <SliderControl
          icon={<Waves className="h-3 w-3" />}
          label="Implied vol"
          value={overrides.ivShiftPct}
          min={-50}
          max={100}
          step={1}
          display={fmtPctSigned(overrides.ivShiftPct / 100, 0)}
          onChange={(v) => setOverrides({ ivShiftPct: v })}
        />
        <SliderControl
          icon={<Clock className="h-3 w-3" />}
          label="Time travel"
          value={overrides.daysForward}
          min={0}
          max={Math.max(horizonDays, 1)}
          step={Math.max(horizonDays / 100, 0.1)}
          display={`${overrides.daysForward.toFixed(1)}d / ${horizonDays.toFixed(0)}d`}
          onChange={(v) => setOverrides({ daysForward: v })}
        />
      </div>

      {/* Toggles */}
      <div className="flex items-center gap-4">
        <ToggleMini label="Now" checked={showNow} onChange={() => toggle('showNow')} color="bg-amber-400" />
        <ToggleMini label="Decay" checked={showDecay} onChange={() => toggle('showDecay')} color="bg-slate-400" />
        <ToggleMini label="Cone" checked={showCone} onChange={() => toggle('showCone')} color="bg-teal-400" />
      </div>
    </div>
  );
}

function SliderControl({
  icon, label, value, min, max, step, display, onChange,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex w-20 shrink-0 items-center gap-1 text-[10px] font-medium text-zinc-500">
        {icon} {label}
      </span>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0])}
        className="flex-1"
      />
      <span className="w-16 shrink-0 text-right font-mono text-[10px] text-zinc-300">{display}</span>
    </div>
  );
}

function ToggleMini({ label, checked, onChange, color }: { label: string; checked: boolean; onChange: () => void; color: string }) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-1.5">
      <Switch checked={checked} onCheckedChange={onChange} className="h-3.5 w-6 data-[state=checked]:bg-teal-600 data-[state=unchecked]:bg-zinc-700" />
      <span className="flex items-center gap-1 text-[10px] text-zinc-400">
        <span className={`h-1.5 w-3 rounded-sm ${checked ? color : 'bg-zinc-700'}`} />
        {label}
      </span>
    </label>
  );
}

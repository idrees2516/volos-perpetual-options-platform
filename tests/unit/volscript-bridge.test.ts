// Chart Desk bridge conformance — a VolScript/Pine script must become a full
// openalgo-charts IndicatorDescriptor: inputs form, plots (incl. candle plots),
// markers (shapes + strategy backtest trades), levels, fills (static), and the
// color/alpha → rgba conversion. Pure: no DOM, no chart, no network.

import { describe, it, expect } from 'vitest';
import { rgba, slugifyScript, volscriptDescriptor, getRegisteredScript, previewScript } from '@/components/terminal/chartdesk/volscript-bridge';
import type { Bar, IndicatorSettings, IndicatorStore } from 'openalgo-charts';

const emptyStore = {} as IndicatorStore;
const emptySettings = {} as IndicatorSettings;

function synthChartBars(n = 240): Bar[] {
  const out: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price *= 1 + Math.sin(i / 19) * 0.004;
    const o = price;
    const c = price * (1 + Math.sin(i / 7) * 0.002);
    out.push({
      time: 1_700_000_000 + i * 3600,
      open: o,
      high: Math.max(o, c) * 1.001,
      low: Math.min(o, c) * 0.999,
      close: c,
      volume: 500 + (i % 90) * 7,
    });
  }
  return out;
}

describe('volscript bridge', () => {
  it('rgba() converts hex + alpha to rgba() strings', () => {
    expect(rgba('#2dd4bf', 0.5)).toBe('rgba(45,212,191,0.5)');
    expect(rgba('#fb7185')).toBe('rgba(251,113,133,1)');
    expect(rgba('transparent')).toBe('rgba(0,0,0,0)');
    expect(rgba('rgb(1,2,3)')).toBe('rgb(1,2,3)');
  });

  it('slugifyScript makes registry-safe descriptor ids', () => {
    expect(slugifyScript('Volatility Squeeze [tanikedev]!')).toBe('volatility-squeeze-tanikedev');
    expect(slugifyScript('===')).toBe('script');
  });

  it('an indicator script becomes a descriptor with inputs, plots and levels', () => {
    const code = [
      'indicator("RSI + Mean", overlay=false)',
      'len = input.int(14, "RSI Length", minval=2, maxval=50)',
      'src = input.source(close, "Source")',
      'r = ta.rsi(src, len)',
      'plot(r, "RSI", color.violet, 2)',
      'plot(ta.sma(r, 50), "RSI mean", color.zinc, 1)',
      'hline(70, "Overbought", color.rose, hline.style_dashed)',
      'hline(30, "Oversold", color.teal, hline.style_dashed)',
    ].join('\n');
    const d = volscriptDescriptor({ id: 'volscript:rsi-mean', name: 'RSI + Mean', code });
    expect(d.id).toBe('volscript:rsi-mean');
    expect(d.placement).toBe('pane');
    expect(d.hasSource).toBe(true);
    expect(d.category).toBe('VolScript');
    expect(d.inputs.map((i) => i.key)).toEqual(['RSI Length', 'Source']);
    expect(d.plots).toHaveLength(2);
    expect(d.plots[0].key).toBe('p0');
    const values = d.calc(synthChartBars(), { 'RSI Length': 14, Source: 'close' } as IndicatorSettings, emptyStore);
    expect(values.p0?.length).toBe(240);
    expect(values.p0?.filter((v) => v != null).length).toBeGreaterThan(200);
    // levels + markers hooks run off the calc's closure state
    const levels = d.levels!({ settings: emptySettings } as never);
    expect(levels.map((l) => l.title)).toEqual(['Overbought', 'Oversold']);
    expect(getRegisteredScript('volscript:rsi-mean')?.code).toBe(code);
  });

  it('overlay studies with shapes produce markers against the price pane', () => {
    const code = [
      'indicator("Squeeze marks", overlay=true)',
      'squeeze = ta.stdev(close, 20) < ta.atr(20)',
      'plot(ta.sma(close, 20), "Basis", color.teal, 2)',
      'plotshape(squeeze, style=shape.circle, location=location.belowbar, color.violet)',
    ].join('\n');
    const d = volscriptDescriptor({ id: 'volscript:sqz', name: 'Squeeze marks', code });
    expect(d.placement).toBe('onchart');
    expect(d.markerAnchor).toBe('price');
    d.calc(synthChartBars(), emptySettings, emptyStore);
    const markers = d.markers!({ bars: synthChartBars(), values: {}, settings: emptySettings } as never);
    expect(markers.length).toBeGreaterThan(0);
    expect(markers[0].shape).toBe('circle');
    expect(markers[0].position).toBe('belowBar');
  });

  it('strategy scripts paint their backtest trades as entry/exit markers', () => {
    const code = [
      'strategy("EMA cross", overlay=true, initial_capital=100000, commission=0.04)',
      'f = ta.ema(close, 12)',
      's = ta.ema(close, 36)',
      'if ta.crossover(f, s)',
      '    strategy.entry("L", strategy.long)',
      '    strategy.exit("L", stop=close - 2 * ta.atr(14))',
      'if ta.crossunder(f, s)',
      '    strategy.close("L")',
      'plot(f, "Fast", color.teal, 2)',
      'plot(s, "Slow", color.amber, 2)',
    ].join('\n');
    const d = volscriptDescriptor({ id: 'volscript:ema-cross', name: 'EMA cross', code });
    const bars = synthChartBars(360);
    const values = d.calc(bars, emptySettings, emptyStore);
    expect(values.p0).toBeDefined();
    const markers = d.markers!({ bars, values: {}, settings: emptySettings } as never);
    const entries = markers.filter((m) => m.shape === 'triangleUp' || m.shape === 'triangleDown');
    expect(entries.length).toBeGreaterThan(0);
  });

  it('fill()/bgcolor()/barcolor() scripts carry static fills + background columns', () => {
    const code = [
      'indicator("BB squeeze", overlay=true)',
      '[b, u, l] = ta.bb(close, 20, 2)',
      'pu = plot(u, "Upper", color.teal)',
      'pl = plot(l, "Lower", color.teal)',
      'fill(pu, pl, color=color.new(color.teal, 85))',
      'bgcolor(close > open ? color.new(color.violet, 88) : na)',
      'barcolor(close > open ? color.teal : color.rose)',
    ].join('\n');
    const d = volscriptDescriptor({ id: 'volscript:bb-sqz', name: 'BB squeeze', code });
    const fills = (d as unknown as { fills?: Array<{ between: [string, string] }> }).fills;
    expect(fills).toHaveLength(1);
    expect(fills![0].between).toEqual(['p0', 'p1']);
    const bars = synthChartBars();
    d.calc(bars, emptySettings, emptyStore);
    const bg = d.background!({ bars, values: {}, settings: emptySettings } as never) as (string | null)[];
    expect(bg.filter(Boolean).length).toBeGreaterThan(100);
    const bc = d.barColors!({ bars, values: {}, settings: emptySettings } as never);
    expect(bc.filter(Boolean).length).toBeGreaterThan(100);
  });

  it('a broken script surfaces a compile error (never a silent chart)', () => {
    const d = volscriptDescriptor({ id: 'volscript:broken', name: 'Broken', code: 'plot(ta.nope(close, 1))\n' });
    expect(() => d.calc(synthChartBars(), emptySettings, emptyStore)).toThrowError(/unknown function/);
    const p = previewScript('indicator("x")\nplot(1)\n');
    expect(p.ok).toBe(true);
    expect(p.title).toBe('x');
  });
});

'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — the unified live chart (canvas)
//
//   x: time (linear, wheel-zoom / drag-pan / follow mode)
//   y: price (auto range from the visible window)
//
// Layers, back to front:
//   1. resting-liquidity heatmap  (one 1 s column per second, blue→cyan→yellow→white)
//   2. footprint cells             (bid×ask volume per price per candle, imbalance-tinted)
//   3. prior-session levels       (pPOC / pVAH / pVAL / pVWAP + naked POCs, edge-pinned)
//   4. session VWAP ± 1σ band
//   5. trade bubbles              (size = notional, ringed when ≥5× average)
//   6. liquidation bubbles        (ringed, tagged L/S)
//   7. absorption bands + iceberg diamonds
//   8. price path + last price + session H/L
//   9. crosshair + tooltip (resting size at price/second, nearest print)
// Click any bubble → order-detail drawer.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { HeatmapRenderer } from './heatmap-render';
import type { OrderFlowStore } from './use-orderflow';
import type { OfWireTrade } from '@/lib/orderflow/types';

export interface FlowChartOptions {
  showHeatmap: boolean;
  showFootprint: boolean;
  showBubbles: boolean;
  showLiquidations: boolean;
  showMarkers: boolean;
  showLevels: boolean;
  follow: boolean;
}

interface Props {
  store: OrderFlowStore | null;
  tf: number;
  options: FlowChartOptions;
  height?: number;
  onPrintClick: (id: string) => void;
  onMarkerClick?: (marker: { kind: 'absorption' | 'iceberg'; price: number; time: number }) => void;
  onFollowChange?: (follow: boolean) => void;
}

interface HitBubble {
  x: number;
  y: number;
  r: number;
  print?: OfWireTrade;
  liq?: { id: string; side: string; price: number; quantity: number; quoteVolume: number; venue: string; timestamp: number };
}

const C = {
  bg: '#06090f',
  grid: '#141b26',
  axis: '#3f4a5a',
  text: '#8b95a5',
  bid: '#34d399',
  ask: '#fb7185',
  teal: '#2dd4bf',
  amber: '#fbbf24',
  violet: '#a78bfa',
  ice: '#7dd3fc',
  white: '#e4eaf2',
};

export function FlowChart({ store, tf, options, height = 460, onPrintClick, onMarkerClick, onFollowChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef(new HeatmapRenderer());
  const dirtyRef = useRef(true);
  const viewRef = useRef({ t1: Date.now(), span: tf * 60, effT0: 0, effT1: 0 });
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const hitsRef = useRef<HitBubble[]>([]);
  const dragRef = useRef<{ x: number; t1: number; moved: boolean } | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const followRef = useRef(options.follow);
  followRef.current = options.follow;
  const storeRef = useRef(store);
  storeRef.current = store;
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const cbRef = useRef({ onPrintClick, onMarkerClick, onFollowChange });
  cbRef.current = { onPrintClick, onMarkerClick, onFollowChange };

  useEffect(() => {
    const unsub = store?.subscribe(() => {
      dirtyRef.current = true;
    });
    return unsub;
  }, [store]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let raf = 0;
    let w = 0;
    let h = 0;

    const draw = () => {
      raf = 0;
      const st = storeRef.current?.state;
      const opts = optionsRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = wrap.getBoundingClientRect();
      const cw = Math.max(320, rect.width);
      const ch = height;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
        canvas.style.width = `${cw}px`;
        canvas.style.height = `${ch}px`;
      }
      w = cw;
      h = ch;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // ── layout ────────────────────────────────────────────────────────
      const axisW = 66;
      const axisH = 20;
      const plotL = 6;
      const plotT = 6;
      const plotR = w - axisW - 6;
      const plotB = h - axisH - 4;
      const plotW = plotR - plotL;
      const plotH = plotB - plotT;
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, w, h);

      // ── time window ───────────────────────────────────────────────────
      const view = viewRef.current;
      if (followRef.current) view.t1 = Date.now();
      const t1 = view.t1;
      // Clamp the left edge to the data we actually have: a fresh session
      // shouldn't show an hour of empty grid — the window grows to `span`.
      let dataStart = Infinity;
      if (st) {
        if (st.heatmapColumns.size) {
          const first = st.heatmapColumns.keys().next();
          if (!first.done) dataStart = Math.min(dataStart, first.value);
        }
        if (st.candles.length) dataStart = Math.min(dataStart, st.candles[0].openTime);
        if (st.prints.length) dataStart = Math.min(dataStart, st.prints[0].timestamp);
      }
      const t0 = Number.isFinite(dataStart)
        ? Math.max(t1 - view.span, Math.min(dataStart - 3000, t1 - 5000))
        : t1 - view.span;
      const xOf = (t: number) => plotL + ((t - t0) / Math.max(1, t1 - t0)) * plotW;

      // ── price range from the visible window ───────────────────────────
      let pMin = Infinity;
      let pMax = -Infinity;
      const consider = (p: number) => {
        if (!Number.isFinite(p)) return;
        if (p < pMin) pMin = p;
        if (p > pMax) pMax = p;
      };
      if (st) {
        for (const c of st.candles) {
          if (c.openTime + tfRef.current >= t0 && c.openTime <= t1) {
            consider(c.high);
            consider(c.low);
          }
        }
        for (const p of st.prints) {
          if (p.timestamp >= t0 && p.timestamp <= t1) consider(p.price);
        }
        if (opts.showLevels && st.levels) {
          const lv = st.levels;
          consider(lv.previous?.poc ?? NaN);
          consider(lv.previous?.vah ?? NaN);
          consider(lv.previous?.val ?? NaN);
          consider(lv.previous?.vwap ?? NaN);
          for (const n of lv.naked) consider(n.poc);
        }
        if (st.session?.high) consider(st.session.high);
        if (st.session?.low) consider(st.session.low);
      }
      if (!Number.isFinite(pMin) || !Number.isFinite(pMax) || pMin === pMax) {
        pMin = 0;
        pMax = 100;
      }
      const pad = (pMax - pMin) * 0.06 || 1;
      pMin -= pad;
      pMax += pad;
      const priceY = (p: number) => plotT + ((pMax - p) / (pMax - pMin)) * plotH;

      // ── grid + axes ───────────────────────────────────────────────────
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const priceTicks = 7;
      for (let i = 0; i <= priceTicks; i++) {
        const y = plotT + (plotH * i) / priceTicks;
        ctx.moveTo(plotL, y + 0.5);
        ctx.lineTo(plotR, y + 0.5);
      }
      for (let i = 0; i <= 6; i++) {
        const x = plotL + (plotW * i) / 6;
        ctx.moveTo(x + 0.5, plotT);
        ctx.lineTo(x + 0.5, plotB);
      }
      ctx.stroke();

      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = C.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const tickDec = pMax > 5000 ? 0 : pMax > 100 ? 1 : 2;
      for (let i = 0; i <= priceTicks; i++) {
        const p = pMax - ((pMax - pMin) * i) / priceTicks;
        ctx.fillText(p.toFixed(tickDec), plotR + 6, plotT + (plotH * i) / priceTicks);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let i = 0; i <= 6; i++) {
        const t = t0 + ((t1 - t0) * i) / 6;
        const d = new Date(t);
        const label = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        ctx.fillText(label, plotL + (plotW * i) / 6, plotB + 4);
      }
      // remember the effective window for pan/zoom math
      viewRef.current.effT0 = t0;
      viewRef.current.effT1 = t1;

      // ── 1. resting-liquidity heatmap ──────────────────────────────────
      if (st && opts.showHeatmap && st.heatmapColumns.size) {
        rendererRef.current.update(st.heatmapColumns.values(), st.tick || 0.01);
        rendererRef.current.draw(ctx, t0, t1, xOf, priceY, 0.72);
      }

      // ── 2. footprint cells ────────────────────────────────────────────
      const hits: HitBubble[] = [];
      if (st && opts.showFootprint && st.candles.length) {
        const tick = st.tick || 0.01;
        const rowH = Math.max(1, (tick * plotH) / (pMax - pMin));
        for (const c of st.candles) {
          if (c.openTime + tfRef.current < t0 || c.openTime > t1) continue;
          const cx0 = xOf(c.openTime);
          const cx1 = xOf(c.openTime + tfRef.current);
          const cw = Math.max(2, cx1 - cx0 - 1);
          const maxLevelVol = Math.max(...c.levels.map((l) => l.bidVolume + l.askVolume), 1);
          for (const l of c.levels) {
            const y = priceY(l.price + tick / 2);
            if (y < plotT || y > plotB) continue;
            const total = l.bidVolume + l.askVolume;
            const ratio = Math.min(1, total / maxLevelVol);
            const imb = l.bidVolume / Math.max(1e-9, l.askVolume);
            const buySide = l.askVolume > l.bidVolume;
            const alpha = 0.1 + 0.4 * ratio;
            ctx.fillStyle = buySide
              ? `rgba(52,211,153,${alpha * (imb < 1 / 3 ? 1.6 : 1)})`
              : `rgba(251,113,133,${alpha * (imb > 3 ? 1.6 : 1)})`;
            ctx.fillRect(cx0, y - rowH / 2, cw, rowH);
            if (cw >= 26 && rowH >= 11) {
              ctx.fillStyle = 'rgba(228,234,242,0.75)';
              ctx.font = '8px ui-monospace, monospace';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(
                `${l.bidVolume >= 100 ? l.bidVolume.toFixed(0) : l.bidVolume.toFixed(2)}×${l.askVolume >= 100 ? l.askVolume.toFixed(0) : l.askVolume.toFixed(2)}`,
                cx0 + cw / 2,
                y,
              );
            }
          }
          // candle wick
          ctx.strokeStyle = 'rgba(160,170,190,0.7)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx0 + 1, priceY(c.high));
          ctx.lineTo(cx0 + 1, priceY(c.low));
          ctx.stroke();
        }
      }

      // ── 3. prior-session levels ───────────────────────────────────────
      const drawHLine = (price: number, color: string, dash: number[], label: string, labelColor?: string) => {
        if (!Number.isFinite(price)) return;
        const y = priceY(price);
        const pinned = y < plotT || y > plotB;
        const yy = pinned ? (y < plotT ? plotT + 8 : plotB - 8) : y;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(plotL, yy + 0.5);
        ctx.lineTo(plotR, yy + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = labelColor ?? color;
        ctx.font = '8px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        if (pinned) {
          // arrow + price pinned at the edge
          ctx.fillText(`${label} ${price.toFixed(tickDec)} ↕`, plotL + 6, yy - 2);
        } else {
          ctx.fillText(label, plotL + 6, yy - 2);
        }
        ctx.restore();
      };
      if (st && opts.showLevels && st.levels) {
        const lv = st.levels;
        if (lv.previous) {
          drawHLine(lv.previous.poc, C.amber, [10, 4], 'pPOC');
          drawHLine(lv.previous.vah, '#64748b', [8, 4], 'pVAH');
          drawHLine(lv.previous.val, '#64748b', [8, 4], 'pVAL');
          drawHLine(lv.previous.vwap, C.violet, [12, 5], 'pVWAP');
        }
        for (const n of lv.naked) {
          const d = new Date(n.day);
          drawHLine(n.poc, 'rgba(251,191,36,0.55)', [2, 4], `nPOC ${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`);
        }
      }

      // ── 4. session VWAP ± 1σ ──────────────────────────────────────────
      if (st && opts.showLevels && st.session && st.session.vwap > 0) {
        const { vwap, vwapStd } = st.session;
        if (vwapStd > 0) {
          ctx.fillStyle = 'rgba(45,212,191,0.06)';
          ctx.fillRect(plotL, priceY(vwap + vwapStd), plotW, priceY(vwap - vwapStd) - priceY(vwap + vwapStd));
        }
        drawHLine(vwap, C.teal, [6, 4], 'VWAP');
      }

      // ── 5. trade bubbles ──────────────────────────────────────────────
      if (st && opts.showBubbles && st.prints.length) {
        const avgNotional =
          st.prints.length > 0
            ? st.prints.reduce((a, p) => a + p.quoteVolume, 0) / st.prints.length
            : 1;
        for (const p of st.prints) {
          if (p.timestamp < t0 || p.timestamp > t1) continue;
          if (p.price < pMin || p.price > pMax) continue;
          const x = xOf(p.timestamp);
          const y = priceY(p.price);
          const r = Math.max(2.5, Math.min(13, 2.5 + Math.sqrt(p.quoteVolume / Math.max(1, avgNotional)) * 4));
          const big = (p.ratio ?? 0) >= 5;
          hits.push({ x, y, r, print: p });
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = p.side === 'buy' ? 'rgba(52,211,153,0.38)' : 'rgba(251,113,133,0.38)';
          ctx.fill();
          ctx.strokeStyle = p.side === 'buy' ? 'rgba(52,211,153,0.9)' : 'rgba(251,113,133,0.9)';
          ctx.lineWidth = big ? 2 : 1;
          ctx.stroke();
          if (big) {
            ctx.fillStyle = C.white;
            ctx.font = '7px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${(p.ratio ?? 0).toFixed(0)}×`, x, y);
          }
        }
      }

      // ── 6. liquidation bubbles ────────────────────────────────────────
      if (st && opts.showLiquidations) {
        for (const l of st.liqs) {
          if (l.timestamp < t0 || l.timestamp > t1) continue;
          const x = xOf(l.timestamp);
          const y = priceY(l.price);
          const r = Math.max(4, Math.min(16, 3 + Math.sqrt(l.quoteVolume / 25_000) * 3));
          hits.push({
            x,
            y,
            r,
            liq: { id: l.id, side: l.side, price: l.price, quantity: l.quantity, quoteVolume: l.quoteVolume, venue: l.venue, timestamp: l.timestamp },
          });
          const isLong = l.side === 'long';
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = isLong ? 'rgba(244,63,94,0.16)' : 'rgba(16,185,129,0.16)';
          ctx.fill();
          ctx.strokeStyle = isLong ? '#f43f5e' : '#10b981';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.fillStyle = isLong ? '#f43f5e' : '#10b981';
          ctx.font = '7px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(isLong ? 'L' : 'S', x, y);
        }
      }

      // ── 7. microstructure markers ─────────────────────────────────────
      if (st && opts.showMarkers) {
        for (const m of st.micro) {
          if (m.time < t0 - 60_000 || m.time > t1) continue;
          const x = xOf(m.time);
          const y = priceY(m.price);
          if (y < plotT - 20 || y > plotB + 20) continue;
          if (m.kind === 'absorption') {
            const bw = Math.max(18, xOf(m.time) - xOf(m.start));
            const bh = Math.max(6, (st.tick || 0.01) * (plotH / (pMax - pMin)));
            ctx.strokeStyle = m.side === 'bid' ? C.bid : C.ask;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x - bw, y - bh / 2, bw, bh);
            ctx.fillStyle = m.side === 'bid' ? C.bid : C.ask;
            ctx.font = '7px ui-monospace, monospace';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText(`ABS ${m.ratio.toFixed(1)}×`, x - 2, y - bh / 2 - 1);
          } else {
            // ice-blue diamond
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(Math.PI / 4);
            ctx.strokeStyle = C.ice;
            ctx.lineWidth = 1.5;
            const s = 5;
            ctx.strokeRect(-s / 2, -s / 2, s, s);
            ctx.fillStyle = 'rgba(125,211,252,0.25)';
            ctx.fillRect(-s / 2, -s / 2, s, s);
            ctx.restore();
            ctx.fillStyle = C.ice;
            ctx.font = '7px ui-monospace, monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText(`ICE ${m.ratio.toFixed(1)}×`, x + 5, y - 5);
          }
        }
      }

      // ── 8. price path + last price + session H/L ─────────────────────
      if (st && st.prints.length) {
        const recent = st.prints.filter((p) => p.timestamp >= t0 && p.timestamp <= t1);
        if (recent.length > 1) {
          const step = Math.max(1, Math.floor(recent.length / 600));
          ctx.strokeStyle = 'rgba(228,234,242,0.8)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < recent.length; i += step) {
            const p = recent[i];
            const x = xOf(p.timestamp);
            const y = priceY(p.price);
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        const last = st.prints[st.prints.length - 1];
        const ly = priceY(last.price);
        if (ly >= plotT && ly <= plotB) {
          ctx.strokeStyle = last.side === 'buy' ? 'rgba(52,211,153,0.7)' : 'rgba(251,113,133,0.7)';
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(plotL, ly + 0.5);
          ctx.lineTo(plotR, ly + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = last.side === 'buy' ? '#34d399' : '#fb7185';
          ctx.fillRect(plotR + 2, ly - 7, axisW - 6, 14);
          ctx.fillStyle = '#05070a';
          ctx.font = 'bold 9px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(last.price.toFixed(tickDec), plotR + axisW / 2, ly);
        }
      }
      if (st && st.session && Number.isFinite(st.session.high)) {
        ctx.fillStyle = 'rgba(52,211,153,0.7)';
        ctx.font = '7px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('H', plotR - 2, priceY(st.session.high) - 1);
        ctx.fillStyle = 'rgba(251,113,133,0.7)';
        ctx.textBaseline = 'top';
        ctx.fillText('L', plotR - 2, priceY(st.session.low) + 1);
      }

      // ── 9. crosshair + tooltip ────────────────────────────────────────
      hitsRef.current = hits;
      const hover = hoverRef.current;
      if (hover && hover.x >= plotL && hover.x <= plotR && hover.y >= plotT && hover.y <= plotB) {
        const t = t0 + ((hover.x - plotL) / plotW) * (t1 - t0);
        const p = pMax - ((hover.y - plotT) / plotH) * (pMax - pMin);
        ctx.strokeStyle = 'rgba(139,149,165,0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(hover.x + 0.5, plotT);
        ctx.lineTo(hover.x + 0.5, plotB);
        ctx.moveTo(plotL, hover.y + 0.5);
        ctx.lineTo(plotR, hover.y + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        // price tag on axis
        ctx.fillStyle = '#1c2530';
        ctx.fillRect(plotR + 2, hover.y - 7, axisW - 6, 14);
        ctx.fillStyle = C.white;
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.toFixed(tickDec), plotR + axisW / 2, hover.y);

        // nearest hit for the tooltip
        let nearest: HitBubble | null = null;
        let bestDist = Infinity;
        for (const hit of hits) {
          const d = (hit.x - hover.x) ** 2 + (hit.y - hover.y) ** 2;
          if (d < bestDist && d < (hit.r + 10) ** 2) {
            bestDist = d;
            nearest = hit;
          }
        }
        const resting =
          st && st.heatmapColumns.size
            ? HeatmapRenderer.sizeAt(st.heatmapColumns, st.tick || 0.01, t, p)
            : null;
        const lines: string[] = [];
        const d = new Date(t);
        lines.push(`⏱ ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} UTC · ${p.toFixed(tickDec)}`);
        if (resting !== null) lines.push(`resting ${(resting * p).toFixed(0)} USD ≈ ${resting.toFixed(3)} ${st?.asset ?? ''}`);
        if (nearest?.print) {
          const pr = nearest.print;
          lines.push(`${pr.side.toUpperCase()} ${pr.quantity.toFixed(3)} @ ${pr.price.toFixed(tickDec)} — ${pr.venue}`);
          lines.push(`$${(pr.quoteVolume / 1000).toFixed(1)}K${pr.ratio ? ` · ${(pr.ratio).toFixed(1)}× avg` : ''} · shown ${(pr.bookSize ?? 0).toFixed(2)}`);
          lines.push('click for full order detail');
        } else if (nearest?.liq) {
          const lq = nearest.liq;
          lines.push(`LIQ ${lq.side.toUpperCase()} ${lq.quantity.toFixed(3)} @ ${lq.price.toFixed(tickDec)} — ${lq.venue}`);
          lines.push(`$${(lq.quoteVolume / 1000).toFixed(1)}K forced ${lq.side === 'long' ? 'sell' : 'buy'}`);
        }
        // tooltip box
        ctx.font = '9px ui-monospace, monospace';
        const boxW = Math.min(300, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16);
        const boxH = lines.length * 13 + 10;
        let bx = hover.x + 14;
        if (bx + boxW > plotR) bx = hover.x - boxW - 14;
        let by = Math.min(plotB - boxH - 4, hover.y + 12);
        if (by < plotT) by = plotT + 4;
        ctx.fillStyle = 'rgba(5,7,10,0.92)';
        ctx.strokeStyle = 'rgba(63,74,90,0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(bx, by, boxW, boxH, 4);
        ctx.fill();
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        lines.forEach((l, i) => {
          ctx.fillStyle = i === 0 ? C.white : C.text;
          ctx.fillText(l, bx + 8, by + 6 + i * 13);
        });
      }
      dirtyRef.current = false;
    };

    const loop = () => {
      if (dirtyRef.current) draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // store tick → mark dirty at ≤ 4 Hz (data already arrives ≤ 4 Hz)
    const tickTimer = setInterval(() => {
      dirtyRef.current = true;
    }, 250);

    // ── interactions ───────────────────────────────────────────────────
    const pos = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onMove = (e: MouseEvent) => {
      hoverRef.current = pos(e);
      dirtyRef.current = true;
    };
    const onLeave = () => {
      hoverRef.current = null;
      dirtyRef.current = true;
    };
    const onDown = (e: MouseEvent) => {
      const p = pos(e);
      dragRef.current = { x: p.x, t1: viewRef.current.t1, moved: false };
    };
    const onDrag = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const p = pos(e);
      const dx = p.x - drag.x;
      if (Math.abs(dx) > 3) {
        drag.moved = true;
        const rect = canvas.getBoundingClientRect();
        const plotW = rect.width - 72;
        const effective = Math.max(1, viewRef.current.effT1 - viewRef.current.effT0);
        const dt = (dx / Math.max(1, plotW)) * effective;
        viewRef.current.t1 = Math.min(Date.now() + 60_000, drag.t1 - dt);
        if (followRef.current) cbRef.current.onFollowChange?.(false);
        dirtyRef.current = true;
      }
    };
    const onUp = (e: MouseEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || drag.moved) return;
      const p = pos(e);
      // click: nearest hit
      let nearest: HitBubble | null = null;
      let best = Infinity;
      for (const hit of hitsRef.current) {
        const d = (hit.x - p.x) ** 2 + (hit.y - p.y) ** 2;
        if (d < best && d < (hit.r + 9) ** 2) {
          best = d;
          nearest = hit;
        }
      }
      if (nearest?.print) cbRef.current.onPrintClick(nearest.print.id);
      else if (nearest?.liq) cbRef.current.onMarkerClick?.({ kind: 'absorption', price: nearest.liq.price, time: nearest.liq.timestamp });
      else {
        // click empty → enable follow (jump to live)
        viewRef.current.t1 = Date.now();
        if (!followRef.current) cbRef.current.onFollowChange?.(true);
        dirtyRef.current = true;
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
      const rect = canvas.getBoundingClientRect();
      const plotW = rect.width - 72;
      const anchor = (e.clientX - rect.left - 6) / Math.max(1, plotW); // 0..1
      const view = viewRef.current;
      const effective = Math.max(1, view.effT1 - view.effT0);
      const tAnchor = view.effT1 - effective * (1 - anchor);
      view.span = Math.max(tfRef.current, Math.min(2 * 3_600_000, view.span * factor));
      if (followRef.current) view.t1 = Date.now();
      else view.t1 = tAnchor + view.span * (1 - anchor);
      dirtyRef.current = true;
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(tickTimer);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onDrag);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [height, tf]);

  return (
    <div ref={wrapRef} className="relative w-full overflow-hidden rounded-lg border border-zinc-800/80 bg-[#06090f]">
      <canvas ref={canvasRef} className="block w-full cursor-crosshair" style={{ height }} />
      {!store && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-zinc-600">
          connecting to venue feeds…
        </div>
      )}
    </div>
  );
}

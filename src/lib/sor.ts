// ─────────────────────────────────────────────────────────────────────────────
// VolOS SMART ORDER ROUTER (SOR)
//
// The routing objective, per the desk's requirement: place ALL legs of a
// strategy on ONE exchange whenever a single venue can fill every leg.
// Single-venue execution preserves cross-margin netting, avoids multi-venue
// fragmentation risk, and slashes operational overhead.
//
// Algorithm (three phases):
//   PHASE 1 — FEASIBILITY  : hard-filter venues that list every leg's asset
//                            class (dated options / perp options / perps / spot).
//   PHASE 2 — SINGLE-VENUE : among feasible venues score each venue PER LEG
//                            (liquidity, fee, spread, connectivity, size depth)
//                            then aggregate with a worst-leg emphasis —
//                            a chain is only as good as its thinnest leg —
//                            and pick the best SINGLE venue for the WHOLE book.
//   PHASE 3 — FALLBACK     : if (and only if) no venue lists every leg, split
//                            greedily per leg so each leg still lands on its
//                            own best venue, flagged as SPLIT routing.
// ─────────────────────────────────────────────────────────────────────────────

import type { Leg, VenueSpec } from './types';
import { venueSupports } from './venues';

export interface LegRouteScore {
  venueId: string;
  feasible: boolean;
  liquidity: number; // normalised depth
  feeBps: number;
  spreadBps: number;
  connectivity: number; // live ? latency-derived : 0
  score: number; // 0..100 composite when feasible, else -1
  reason?: string;
}

export interface VenueRouting {
  venue: VenueSpec;
  allLegsFeasible: boolean;
  legScores: LegRouteScore[]; // aligned with legs[]
  aggregate: number; // 0..100 — worst-leg emphasised mean
  estFeeBps: number; // blended taker fee of the routed legs
  estSpreadCostBps: number;
  ranking: number;
}

export interface SorResult {
  mode: 'SINGLE-VENUE' | 'SPLIT';
  winner: VenueRouting | null;
  routed: { legIndex: number; leg: Leg; venue: VenueSpec; score: number }[];
  venues: VenueRouting[]; // ranked, winner first
  reasoning: string[];
  savingsBps: number; // vs naive worst feasible venue
}

// ── scoring weights (tuned for a 4-leg crypto options book at standard size)
const W = {
  liquidity: 0.34,
  fees: 0.22,
  spread: 0.24,
  connectivity: 0.12,
  depth: 0.08,
};

const SIZE_IMPACT = 25; // contracts — standard clip used for depth stress

function legScore(v: VenueSpec, leg: Leg, dte: number, notionalPerUnit: number): LegRouteScore {
  const feasible = venueSupports(v, leg.kind, dte);
  if (!feasible) {
    return {
      venueId: v.id, feasible: false,
      liquidity: 0, feeBps: v.takerBps, spreadBps: v.spreadBps, connectivity: 0,
      score: -1,
      reason: leg.kind === 'perp_option' ? 'no perpetual options listing'
        : leg.kind === 'perp' ? 'no perp listing'
        : leg.kind === 'spot' ? 'no spot listing'
        : 'no dated options chain',
    };
  }
  // depth stress: liquidity decays with clip size vs venue depth
  const depthDecay = Math.exp(-(SIZE_IMPACT / 400) * (1.15 - v.liquidity));
  const liquidity = Math.max(0, Math.min(1, v.liquidity * depthDecay));
  // fee expressed in bps of leg notional
  const feeBps = v.takerBps;
  const spreadBps = v.spreadBps;
  const connectivity = v.live
    ? Math.max(0.3, 1 - Math.min(v.latencyMs ?? 400, 2000) / 2000)
    : 0.25; // unrouted but reachable-only — usable with caution
  // fee & spread normalised against the venue universe worst case
  const feeN = 1 - Math.min(feeBps / 10, 1);
  const spreadN = 1 - Math.min(spreadBps / 20, 1);
  const depthN = liquidity;
  const score =
    100 *
    (W.liquidity * liquidity +
      W.fees * feeN +
      W.spread * spreadN +
      W.connectivity * connectivity +
      W.depth * depthN);
  void notionalPerUnit;
  return { venueId: v.id, feasible: true, liquidity, feeBps, spreadBps, connectivity, score };
}

export function routeOrder(
  legs: Leg[],
  venues: VenueSpec[],
  spot: number,
): SorResult {
  const legVenues: VenueRouting[] = venues.map((v) => {
    const legScores = legs.map((l) => legScore(v, l, l.dte, spot));
    const allFeasible = legScores.every((s) => s.feasible);
    const feasibleScores = legScores.filter((s) => s.feasible).map((s) => s.score);
    // worst-leg emphasis: 60% min + 40% mean — a book is only as liquid as its
    // thinnest leg, but average execution cost still matters.
    const aggregate = feasibleScores.length
      ? allFeasible
        ? 0.6 * Math.min(...feasibleScores) + 0.4 * (feasibleScores.reduce((a, b) => a + b, 0) / feasibleScores.length)
        : (0.6 * Math.min(...feasibleScores) + 0.4 * (feasibleScores.reduce((a, b) => a + b, 0) / feasibleScores.length)) * 0.5
      : -1;
    const routedLegs = legScores.filter((s) => s.feasible);
    const estFeeBps = routedLegs.length ? routedLegs.reduce((a, s) => a + s.feeBps, 0) / routedLegs.length : 0;
    const estSpreadCostBps = routedLegs.length ? routedLegs.reduce((a, s) => a + s.spreadBps, 0) / routedLegs.length : 0;
    return { venue: v, allLegsFeasible: allFeasible, legScores, aggregate, estFeeBps, estSpreadCostBps, ranking: 0 };
  });

  // rank: single-venue capable first (by aggregate), then split-capable
  const ranked = [...legVenues].sort((a, b) => {
    if (a.allLegsFeasible !== b.allLegsFeasible) return a.allLegsFeasible ? -1 : 1;
    return b.aggregate - a.aggregate;
  });
  ranked.forEach((r, i) => (r.ranking = i + 1));

  const winner = ranked.find((r) => r.allLegsFeasible && r.aggregate > 0) ?? null;

  const routed: SorResult['routed'] = [];
  if (winner) {
    legs.forEach((leg, i) =>
      routed.push({ legIndex: i, leg, venue: winner.venue, score: winner.legScores[i].score }),
    );
  } else {
    // fallback: greedy per-leg best venue
    legs.forEach((leg, i) => {
      let best: { v: VenueRouting; s: number } | null = null;
      for (const rv of legVenues) {
        const s = rv.legScores[i];
        if (!s.feasible) continue;
        if (!best || s.score > best.s) best = { v: rv, s: s.score };
      }
      if (best) routed.push({ legIndex: i, leg, venue: best.v.venue, score: best.s });
    });
  }

  // ── reasoning trace (shown in the UI)
  const reasoning: string[] = [];
  if (winner) {
    const w = winner.venue;
    const worst = Math.min(...winner.legScores.map((s) => s.score));
    reasoning.push(
      `Phase 1 — feasibility: ${legVenues.filter((r) => r.allLegsFeasible).length} of ${legVenues.length} venues list every leg's instrument class (${legs.map((l) => l.kind).join(', ')}).`,
    );
    reasoning.push(
      `Phase 2 — single-venue scan: ${w.name} wins with composite ${winner.aggregate.toFixed(1)}/100 (worst leg ${worst.toFixed(1)}/100) — liquidity ${Math.round(w.liquidity * 100)}%, taker ${w.takerBps}bps, spread ~${w.spreadBps}bps${w.live ? `, live ${w.latencyMs}ms` : ''}.`,
    );
    reasoning.push(
      `Cross-margin netting preserved: all ${legs.length} legs rest on ${w.name} as one book — margin offsets (short premium vs long wings) recognised intra-venue.`,
    );
    const second = ranked.find((r) => r.allLegsFeasible && r.venue.id !== w.id);
    if (second) {
      const save = (second.estFeeBps + second.estSpreadCostBps) - (winner.estFeeBps + winner.estSpreadCostBps);
      reasoning.push(
        `vs runner-up ${second.venue.name}: saves ~${save.toFixed(1)}bps blended cost on the clip.`,
      );
    }
  } else {
    reasoning.push('No single venue lists every leg — falling back to per-leg split routing.');
    const byVenue = new Map<string, number>();
    for (const r of routed) byVenue.set(r.venue.name, (byVenue.get(r.venue.name) ?? 0) + 1);
    reasoning.push(
      `Split map: ${[...byVenue.entries()].map(([n, c]) => `${c}× ${n}`).join(' · ')}.`,
    );
  }

  const savingsBps = winner
    ? Math.max(
        0,
        ...legVenues.filter((r) => r.allLegsFeasible).map((r) => r.estFeeBps + r.estSpreadCostBps),
      ) - (winner.estFeeBps + winner.estSpreadCostBps)
    : 0;

  return { mode: winner ? 'SINGLE-VENUE' : 'SPLIT', winner, routed, venues: ranked, reasoning, savingsBps };
}

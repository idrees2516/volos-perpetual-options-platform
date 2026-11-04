// Smoke test for the Strategy Lab engine — optimizer (with AUTO-BACKTEST on
// real exchange history), alternatives, teaching.
// Runs against the pricing core with live market anchors (degrades gracefully
// without network: backtest stats are simply absent).
import { optimizeStrategyPayload, alternativesPayload, teachingPayload, type VariantBacktest } from '../src/lib/ai/strategy-lab';

function btLine(bt: VariantBacktest): string {
  return `win ${bt.winRate}% · PF ${bt.profitFactor} · CAGR ${bt.cagrPct}% · maxDD ${bt.maxDrawdownPct}% · Sharpe ${bt.sharpe} · P&L $${bt.totalPnl} · ${bt.cycles} cycles`;
}

async function main() {
  // --- 1. OPTIMIZER: increase POP on an iron condor ---
  const optPop = await optimizeStrategyPayload({
    strategyId: 'iron-condor',
    underlying: 'BTC',
    size: 1,
    goal: 'increase_pop',
  });
  if ('error' in optPop) throw new Error(`optimizer pop failed: ${optPop.error}`);
  console.log('═'.repeat(70));
  console.log(`OPTIMIZER · goal=increase_pop · ${optPop.baseline.name} @ BTC ${optPop.spot} (${optPop.source})`);
  console.log(`baseline: POP ${optPop.baseline.popPct}% · maxP ${JSON.stringify(optPop.baseline.maxProfit)} · maxL ${JSON.stringify(optPop.baseline.maxLoss)}`);
  for (const v of optPop.variants) {
    console.log(
      `  ${v.moveId.padEnd(14)} POP ${String(v.popPct).padStart(5)}% (Δ${v.dPop >= 0 ? '+' : ''}${v.dPop}pp) · ΔmaxL ${v.dMaxLoss ?? 'n/a'} · ΔEV ${v.dEv} · legs ${v.legCount}`,
    );
  }
  console.log(`recommendation: ${optPop.recommendation.label} — ${optPop.recommendation.why.slice(0, 110)}…`);
  if (optPop.variants.length === 0) throw new Error('no increase_pop variants produced');
  const popImproved = optPop.variants.some((v) => v.dPop > 0.5);
  if (!popImproved) throw new Error('no variant actually improved POP');
  if (!optPop.variants.every((v) => Array.isArray(v.loadLegs) && v.loadLegs.length > 0)) throw new Error('variants missing loadLegs');

  // --- 1b. AUTO-BACKTEST: baseline + variants validated on real history ----
  if (optPop.backtested) console.log(`auto-backtest: ON (backtested=${optPop.backtested})`);
  else console.log('auto-backtest: degraded (no network / history unavailable)');
  if (optPop.baseline.backtest) {
    console.log(`  baseline  → ${btLine(optPop.baseline.backtest)}`);
  }
  const withBt = optPop.variants.filter((v) => v.backtest);
  console.log(`  variants  → ${withBt.length}/${optPop.variants.length} backtested on 365d real history`);
  for (const v of withBt.slice(0, 3)) {
    const d = v.btDelta;
    console.log(
      `    ${v.moveId.padEnd(14)} ${btLine(v.backtest!)}${d ? ` (Δwin ${d.dWinRate >= 0 ? '+' : ''}${d.dWinRate}pp · ΔPF ${d.dProfitFactor >= 0 ? '+' : ''}${d.dProfitFactor} · ΔP&L ${d.dTotalPnl >= 0 ? '+' : ''}${d.dTotalPnl})` : ''}`,
    );
  }
  if (withBt.length > 0) {
    if (!withBt.every((v) => v.backtest!.cycles > 0 && v.backtest!.windowDays === 365)) throw new Error('attached backtest malformed');
    if (!withBt.every((v) => v.btDelta || optPop.baseline.backtest === undefined)) throw new Error('variant backtest missing deltas vs baseline');
    if (optPop.recommendation.why.includes('Auto-backtest') !== (optPop.baseline.backtest != null && !!withBt[0]?.backtest)) {
      // recommendation should cite historical evidence whenever stats exist
      if (optPop.baseline.backtest && withBt[0]?.backtest) throw new Error('recommendation.why missing auto-backtest evidence');
    }
  }

  // --- 2. OPTIMIZER: reduce risk ---
  const optRisk = await optimizeStrategyPayload({ strategyId: 'iron-condor', underlying: 'BTC', goal: 'reduce_risk' });
  if ('error' in optRisk) throw new Error(`optimizer risk failed: ${optRisk.error}`);
  console.log('═'.repeat(70));
  console.log(`OPTIMIZER · goal=reduce_risk → ${optRisk.variants.length} variants, best: ${optRisk.recommendation.label}`);
  for (const v of optRisk.variants.slice(0, 4)) {
    console.log(`  ${v.moveId.padEnd(14)} maxL ${JSON.stringify(v.maxLoss)} (Δ ${v.dMaxLoss ?? 'defined'}) · ΔPOP ${v.dPop}pp`);
  }

  // --- 3. OPTIMIZER: increase profit ---
  const optProfit = await optimizeStrategyPayload({ strategyId: 'iron-condor', underlying: 'ETH', goal: 'increase_profit' });
  if ('error' in optProfit) throw new Error(`optimizer profit failed: ${optProfit.error}`);
  console.log('═'.repeat(70));
  console.log(`OPTIMIZER · goal=increase_profit (ETH) → ${optProfit.variants.length} variants, best: ${optProfit.recommendation.label}`);

  // --- 4. OPTIMIZER with custom legs (naked short call → should get tail wings) ---
  const optCustom = await optimizeStrategyPayload({
    underlying: 'BTC',
    goal: 'reduce_risk',
    legs: [
      { kind: 'call', side: 'sell', qty: 0.1, strike: 110000, expiryDays: 14 },
    ],
  });
  if ('error' in optCustom) throw new Error(`optimizer custom failed: ${optCustom.error}`);
  console.log('═'.repeat(70));
  const wingVariant = optCustom.variants.find((v) => v.moveId === 'add_tail_wings');
  console.log(`OPTIMIZER · naked short call → baseline maxLoss ${JSON.stringify(optCustom.baseline.maxLoss)}`);
  if (wingVariant) {
    console.log(`  add_tail_wings → maxLoss ${JSON.stringify(wingVariant.maxLoss)} · legs ${wingVariant.legCount}`);
    if (wingVariant.maxLoss.kind !== 'value') throw new Error('tail wings did not define risk');
  }

  // --- 5. ALTERNATIVES ---
  const alts = await alternativesPayload({ strategyId: 'iron-condor', underlying: 'BTC' });
  if ('error' in alts) throw new Error(`alternatives failed: ${alts.error}`);
  console.log('═'.repeat(70));
  console.log(`ALTERNATIVES · vs ${alts.current.name} (POP ${alts.current.popPct}%) → ${alts.alternatives.length} candidates`);
  for (const a of alts.alternatives) {
    console.log(`  ${a.strategyId.padEnd(24)} POP ${String(a.popPct).padStart(5)}% (Δ${a.dPop}pp) · ${a.category} · ${a.why.slice(0, 90)}…`);
  }
  if (alts.alternatives.length === 0) throw new Error('no alternatives produced');

  // --- 6. TEACHING ---
  const teach = await teachingPayload({ underlying: 'BTC', strategyId: 'iron-condor' });
  console.log('═'.repeat(70));
  console.log(`TEACHING · ${teach.lessonCount} lessons · strategy ${teach.strategy?.name} POP ${teach.strategy?.popPct}% · IV ${teach.market.atmIv30dPct}%`);
  for (const l of teach.lessons.slice(0, 6)) {
    console.log(`  [${l.group.padEnd(9)}] ${l.term.padEnd(26)} → ${l.valueNow}`);
  }
  console.log(`  … + ${teach.lessons.length - 6} more · ${teach.combinations.length} combinations`);
  if (teach.lessons.length < 15) throw new Error('teaching pack incomplete');

  // --- 7. Error paths ---
  const bad = await optimizeStrategyPayload({ underlying: 'BTC' });
  if (!('error' in bad)) throw new Error('optimizer should error without legs/strategyId');

  console.log('═'.repeat(70));
  console.log('✅ ALL STRATEGY-LAB SMOKE TESTS PASSED');
}

main().catch((err) => {
  console.error('❌ SMOKE TEST FAILED:', err);
  process.exit(1);
});

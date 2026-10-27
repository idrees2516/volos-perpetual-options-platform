// quick sanity check of the gamma-flow engine
import { buildGammaProfile } from '../src/lib/gamma-flow';

const now = Date.now();
for (const sym of ['SPY', 'SPX', 'NVDA', 'BTC']) {
  const p = buildGammaProfile(sym, now);
  const top = [...p.rows].sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex)).slice(0, 3);
  console.log(`\n${sym}: spot=${p.spot.toFixed(2)} netGEX=${(p.levels.netGexTotal / 1e6).toFixed(1)}M regime=${p.levels.regime}`);
  console.log(`  callWall=${p.levels.callWall} putWall=${p.levels.putWall} flip=${p.levels.gammaFlip.toFixed(1)} maxPain=${p.levels.maxPain}`);
  console.log(`  top strikes: ${top.map((r) => `${r.strike}(net ${(r.netGex / 1e6).toFixed(1)}M, cOI ${r.callOi}, pOI ${r.putOi})`).join(' ')}`);
  // check call/put OI peaks
  const maxCallOi = p.rows.reduce((a, b) => (b.callOi > a.callOi ? b : a));
  const maxPutOi = p.rows.reduce((a, b) => (b.putOi > a.putOi ? b : a));
  console.log(`  max callOI @ ${maxCallOi.strike} (${maxCallOi.callOi}) · max putOI @ ${maxPutOi.strike} (${maxPutOi.putOi})`);
}

// diagnostic: per-asset live klines sweep exactly as correlation liveCloses does
import { candles } from '../src/lib/quant/markets';

const assets = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'LINK', 'AVAX'];

for (const a of assets) {
  try {
    const bars = await candles(a, '30m', 336);
    const first = bars[0]?.ts;
    const last = bars.at(-1)?.ts;
    console.log(`${a}: ${bars.length} bars  first=${first} last=${last}`);
  } catch (e) {
    console.log(`${a}: FAILED — ${e instanceof Error ? e.message : e}`);
  }
}

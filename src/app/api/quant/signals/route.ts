// GET /api/quant/signals?symbol=BTC — the decision-support brief:
// signal battery, composite regime score, strategy playbook, watchlist.
import { decisionBrief } from '@/lib/quant/signals';
import { normalizeSymbol } from '@/lib/quant/quant';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = normalizeSymbol(sp.get('symbol'));
    const data = await decisionBrief(symbol);
    return qOk(data, {
      symbol,
      computeMs: Date.now() - t0,
      sources: ['deribit', 'binance-fapi', 'bybit', 'okx', 'sqlite-history'],
      note: `regime ${data.regimeScore} · ${data.signals.length} signals · ${data.playbook.length} playbook setups`,
    });
  });
}

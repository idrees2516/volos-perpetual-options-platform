// GET /api/quant/macro?view=etf|cot|cot-markets|form4|holders13f — real TradFi data.
import { cot, cotMarkets, etfFlows, form4, holders13f, bustMacroCache } from '@/lib/quant/macro';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const view = sp.get('view') ?? 'etf';
    if (sp.get('refresh') === '1') bustMacroCache();

    switch (view) {
      case 'etf': {
        const asset = sp.get('asset') === 'ETH' ? 'ETH' : 'BTC';
        const data = await etfFlows(asset);
        return qOk(data, { computeMs: Date.now() - t0, sources: ['farside.co.uk'], note: 'settlement lags a business day by design' });
      }
      case 'cot': {
        const market = (['BITCOIN', 'ETHER', 'MICRO BITCOIN'].includes(sp.get('market') ?? '') ? sp.get('market') : 'BITCOIN') as 'BITCOIN' | 'ETHER' | 'MICRO BITCOIN';
        const data = await cot(market);
        return qOk(data, { computeMs: Date.now() - t0, sources: ['publicreporting.cftc.gov'] });
      }
      case 'cot-markets': {
        const data = await cotMarkets();
        return qOk({ markets: data }, { computeMs: Date.now() - t0, sources: ['publicreporting.cftc.gov'] });
      }
      case 'form4': {
        const ticker = (['COIN', 'HOOD', 'MSTR'].includes(sp.get('ticker') ?? '') ? sp.get('ticker') : 'COIN') as 'COIN' | 'HOOD' | 'MSTR';
        const data = await form4(ticker);
        return qOk(data, { computeMs: Date.now() - t0, sources: ['data.sec.gov'] });
      }
      case 'holders13f': {
        const ticker = ['MSTR', 'COIN', 'HOOD', 'IBIT'].includes(sp.get('ticker') ?? '') ? sp.get('ticker')! : 'MSTR';
        const data = await holders13f(ticker);
        return qOk(data, { computeMs: Date.now() - t0, sources: ['efts.sec.gov', 'data.sec.gov'] });
      }
      default:
        return qOk(await etfFlows('BTC'), { computeMs: Date.now() - t0, sources: ['farside.co.uk'] });
    }
  });
}

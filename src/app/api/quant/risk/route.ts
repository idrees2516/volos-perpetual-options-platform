// GET  /api/quant/risk        — portfolio risk for the live paper account
// POST /api/quant/risk        — { legs: [...] } what-if structure analysis
import { portfolioRisk, whatIf, type WhatIfLeg } from '@/lib/quant/risk';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    void searchParams(req);
    const data = await portfolioRisk();
    return qOk(data, {
      computeMs: Date.now() - t0,
      sources: ['deribit', 'paper-account'],
      note: `${data.legs.length} live legs · ${data.scenarios.length} scenario matrices · ${data.openOrders.length} working orders`,
    });
  });
}

export async function POST(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const body = (await req.json().catch(() => ({}))) as { legs?: WhatIfLeg[] };
    const legs = (body.legs ?? []).filter((l) => l && l.symbol && l.expiry && l.strike && l.qty > 0);
    if (!legs.length) {
      return qOk({ error: 'legs[] required: {symbol, expiry (ISO), strike, kind: call|put, side: buy|sell, qty}' }, { computeMs: 0 });
    }
    const data = await whatIf(legs);
    return qOk(data, {
      computeMs: Date.now() - t0,
      sources: ['deribit'],
      note: `what-if: ${legs.length} legs · break-evens ${data.breakEvens.join(', ') || '—'}`,
    });
  });
}

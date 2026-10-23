// GET  /api/paper — paper account view (marks refreshed to live quotes)
// POST /api/paper — { action: 'order' | 'close' | 'cancel' | 'strategy' | 'reset' | 'preview' }

import {
  getPaperAccount,
  placePaperOrder,
  closePaperPosition,
  cancelPaperOrder,
  deployPaperStrategy,
  resetPaperAccount,
  resolveOptionQuote,
  paperVenueCatalog,
  type PaperOrderRequest,
  type DeployRequest,
  type PaperKind,
  type PaperSide,
} from '@/lib/ai/paper';
import { getVenueChain, type FeedAsset, type VenueId } from '@/lib/ai/exchange-feeds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ASSETS = ['BTC', 'ETH', 'SOL'];
const VENUES = ['deribit', 'bybit', 'okx', 'aevo', 'paradex', 'derive'];

export async function GET() {
  try {
    const account = await getPaperAccount();
    return Response.json(
      { ok: true, account, venues: paperVenueCatalog() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : 'paper account unavailable' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const action = String(body.action ?? '');

  try {
    if (action === 'reset') {
      const cash = Number(body.startingCash ?? 100_000);
      resetPaperAccount(Number.isFinite(cash) && cash > 0 ? cash : 100_000);
      return Response.json({ ok: true, reset: true });
    }

    if (action === 'preview') {
      const asset = (ASSETS.includes(String(body.asset)) ? body.asset : 'BTC') as FeedAsset;
      const venueRaw = String(body.venue ?? 'auto');
      const venue = (VENUES.includes(venueRaw) ? venueRaw : 'auto') as VenueId | 'auto';
      const kind = (String(body.kind) === 'put' ? 'put' : 'call') as PaperKind;
      const strike = Number(body.strike);
      const side = (String(body.side) === 'sell' ? 'sell' : 'buy') as PaperSide;
      if (!Number.isFinite(strike) || strike <= 0) return Response.json({ ok: false, error: 'strike required' }, { status: 400 });
      const { quote, alternatives, error } = await resolveOptionQuote(venue, asset, body.expiry ? String(body.expiry) : undefined, strike, kind, side);
      if (!quote?.venue) return Response.json({ ok: false, error: error ?? 'no quote' }, { status: 404 });
      return Response.json({
        ok: true,
        quote,
        alternatives: alternatives.map((a) => ({
          venue: a.venue,
          bid: a.bid,
          ask: a.ask,
          mid: +a.mid.toFixed(2),
          iv: +a.iv.toFixed(1),
          feeBps: a.feeBps,
          quoteSource: a.quoteSource,
        })),
      });
    }

    if (action === 'order') {
      const asset = (ASSETS.includes(String(body.asset)) ? body.asset : 'BTC') as FeedAsset;
      const venueRaw = String(body.venue ?? 'auto');
      const venue = (VENUES.includes(venueRaw) ? venueRaw : 'auto') as VenueId | 'auto';
      const kind = (String(body.kind) === 'put' ? 'put' : 'call') as PaperKind;
      const side = (String(body.side) === 'sell' ? 'sell' : 'buy') as PaperSide;
      const qty = Number(body.qty ?? 1);
      const strike = Number(body.strike);
      const type = body.type === 'limit' ? 'limit' : 'market';
      const limitPrice = body.limitPrice != null ? Number(body.limitPrice) : undefined;
      if (!Number.isFinite(strike) || strike <= 0) return Response.json({ ok: false, error: 'strike required' }, { status: 400 });
      if (!Number.isFinite(qty) || qty <= 0) return Response.json({ ok: false, error: 'qty must be > 0' }, { status: 400 });
      if (type === 'limit' && !(limitPrice && limitPrice > 0)) return Response.json({ ok: false, error: 'limitPrice required for limit orders' }, { status: 400 });

      const orderReq: PaperOrderRequest = {
        venue,
        asset,
        expiry: body.expiry ? String(body.expiry) : undefined,
        strike,
        kind,
        side,
        qty,
        type,
        limitPrice,
        strategyTag: body.strategyTag ? String(body.strategyTag) : undefined,
      };
      const res = await placePaperOrder(orderReq);
      if (!res.ok) return Response.json({ ok: false, error: res.error }, { status: 400 });
      return Response.json({ ok: true, fill: res.fill, rested: res.rested ?? null });
    }

    if (action === 'close') {
      const id = String(body.positionId ?? '');
      const qty = body.qty != null ? Number(body.qty) : undefined;
      const res = await closePaperPosition(id, qty != null && qty > 0 ? qty : undefined);
      if (!res.ok) return Response.json({ ok: false, error: res.error }, { status: 400 });
      return Response.json({ ok: true, fill: res.fill });
    }

    if (action === 'cancel') {
      const res = cancelPaperOrder(String(body.orderId ?? ''));
      if (!res.ok) return Response.json({ ok: false, error: res.error }, { status: 404 });
      return Response.json({ ok: true });
    }

    if (action === 'strategy') {
      const asset = (ASSETS.includes(String(body.asset)) ? body.asset : 'BTC') as FeedAsset;
      const venueRaw = String(body.venue ?? 'auto');
      const venue = (VENUES.includes(venueRaw) ? venueRaw : 'auto') as VenueId | 'auto';
      const legsRaw = Array.isArray(body.legs) ? body.legs : [];
      const usable = legsRaw
        .map((l) => l as Record<string, unknown>)
        .filter((l) => l && (l.kind === 'call' || l.kind === 'put') && Number(l.qty) > 0 && (Number(l.strike) > 0 || Number(l.strikeMult) > 0));
      if (usable.length === 0) return Response.json({ ok: false, error: 'no dated option legs provided' }, { status: 400 });
      // resolve strikeMult → absolute strikes against live spot
      let spot = 0;
      if (usable.some((l) => !(Number(l.strike) > 0) && Number(l.strikeMult) > 0)) {
        const { chain } = await getVenueChain('deribit', asset);
        spot = chain?.spot ?? 0;
        if (!spot) return Response.json({ ok: false, error: 'cannot resolve strikeMult — no live spot' }, { status: 502 });
      }
      const legs = usable.map((l) => {
        let strike = Number(l.strike ?? 0);
        if (!(strike > 0)) {
          const mult = Number(l.strikeMult);
          const step = spot >= 50000 ? 500 : spot >= 4000 ? 50 : 5;
          strike = Math.round((spot * mult) / step) * step;
        }
        return {
          kind: (l.kind === 'put' ? 'put' : 'call') as PaperKind,
          side: (l.side === 'sell' ? 'sell' : 'buy') as PaperSide,
          qty: Number(l.qty),
          strike,
          expiryDays: l.expiryDays != null ? Number(l.expiryDays) : undefined,
          expiry: l.expiry != null ? String(l.expiry) : undefined,
        };
      });
      const deployReq: DeployRequest = {
        name: String(body.name ?? 'Manual Strategy'),
        asset,
        venue,
        sizeMultiplier: body.sizeMultiplier != null ? Number(body.sizeMultiplier) : 1,
        legs,
      };
      const res = await deployPaperStrategy(deployReq);
      if (!res.ok) return Response.json({ ok: false, error: res.error, legs: res.legs }, { status: 400 });
      return Response.json({ ok: true, ...res });
    }

    return Response.json({ ok: false, error: `unknown action '${action}'` }, { status: 400 });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : 'paper action failed' }, { status: 500 });
  }
}

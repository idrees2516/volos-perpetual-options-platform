import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

// ─────────────────────────────────────────────────────────────────────────────
// /api/fills — PERSISTENT paper-desk fills, stored in SQLite via Prisma.
// Every fill written here survives page reloads, new tabs, dev restarts and
// full sessions — this is the desk's blotter of record.
//
//   GET    /api/fills            → all fills (newest first) + position rollup
//   POST   /api/fills            → simulate + persist a routed order (all legs)
//   DELETE /api/fills?groupId=x  → cancel one order group
//   DELETE /api/fills?all=1      → flatten the whole blotter
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

interface PostLeg {
  venue: string;
  venueLabel: string;
  underlying: string;
  symbol: string;
  kind: string;
  side: 'buy' | 'sell';
  strike?: number | null;
  dte?: number | null;
  qty: number;
  refPrice: number; // live quote at click-time — server adds realistic slippage
  feeBps: number; // venue taker fee applied server-side
}

function slippage(kind: string, spreadBps: number): number {
  // fills inside the spread with venue-class-dependent realism
  const base = spreadBps / 2;
  const jitter = (Math.random() - 0.35) * base * 0.8;
  return (base + jitter) / 10_000;
}

export async function GET() {
  try {
    const fills = await (db as import('@prisma/client').PrismaClient).fill.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return NextResponse.json({ ok: true, fills });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      legs: PostLeg[];
      strategyId?: string;
      strategyName?: string;
      spreadBps?: number;
      note?: string;
    };
    if (!Array.isArray(body.legs) || body.legs.length === 0) {
      return NextResponse.json({ ok: false, error: 'legs[] required' }, { status: 400 });
    }
    const groupId = `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const spreadBps = body.spreadBps ?? 8;

    const rows = body.legs.map((l) => {
      const slip = slippage(l.kind, spreadBps);
      const dir = l.side === 'buy' ? 1 : -1;
      const price = Math.max(0.0001, l.refPrice * (1 + dir * slip));
      const fee = (price * l.qty * l.feeBps) / 10_000;
      return {
        groupId,
        venue: l.venue,
        venueLabel: l.venueLabel,
        underlying: l.underlying,
        symbol: l.symbol,
        kind: l.kind,
        side: l.side,
        strike: l.strike ?? null,
        dte: l.dte ?? null,
        qty: l.qty,
        price,
        fee,
        strategyId: body.strategyId ?? null,
        strategyName: body.strategyName ?? null,
        note: body.note ?? null,
      };
    });

    await (db as import('@prisma/client').PrismaClient).fill.createMany({ data: rows });
    const fills = await (db as import('@prisma/client').PrismaClient).fill.findMany({
      where: { groupId },
    });
    return NextResponse.json({ ok: true, groupId, fills });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    if (url.searchParams.get('all') === '1') {
      await (db as import('@prisma/client').PrismaClient).fill.deleteMany({});
      return NextResponse.json({ ok: true, cleared: 'all' });
    }
    const groupId = url.searchParams.get('groupId');
    if (!groupId) return NextResponse.json({ ok: false, error: 'groupId or all=1 required' }, { status: 400 });
    await (db as import('@prisma/client').PrismaClient).fill.deleteMany({ where: { groupId } });
    return NextResponse.json({ ok: true, cleared: groupId });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

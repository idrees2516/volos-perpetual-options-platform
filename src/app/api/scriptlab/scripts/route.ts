// GET/POST /api/scriptlab/scripts — user-authored VolScript library (SQLite).
// GET lists newest-first; POST upserts by name (built-in templates live in
// code and are not stored here — saved scripts are the trader's own).
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[\w\-.: ]{1,60}$/;
const CATEGORY_KEYS = new Set([
  'trend', 'momentum', 'volatility', 'volume_flow', 'structure', 'smc_ict', 'wyckoff',
  'elliott_harmonics', 'patterns', 'levels', 'statistics', 'machine_learning',
  'time_sessions', 'sentiment_breadth', 'risk_exits', 'meta', 'validation',
]);

export async function GET() {
  try {
    const rows = await db.script.findMany({ orderBy: { updatedAt: 'desc' }, take: 200 });
    return Response.json({ ok: true, data: rows });
  } catch (e) {
    return Response.json({ ok: false, error: { message: e instanceof Error ? e.message : 'db error' } }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as {
      name?: string;
      code?: string;
      category?: string;
      description?: string;
      kind?: string;
    };
    const name = (b.name ?? '').trim();
    const code = b.code ?? '';
    if (!NAME_RE.test(name)) return Response.json({ ok: false, error: { message: 'name must be 1-60 word/spacing characters' } }, { status: 400 });
    if (!code.trim() || code.length > 40_000) return Response.json({ ok: false, error: { message: 'code must be 1-40000 characters' } }, { status: 400 });
    const category = b.category && CATEGORY_KEYS.has(b.category) ? b.category : 'trend';
    const kind = b.kind === 'strategy' ? 'strategy' : 'indicator';
    const description = (b.description ?? '').slice(0, 400);

    const saved = await db.script.upsert({
      where: { name },
      create: { name, code, category, kind, description },
      update: { code, category, kind, description },
    });
    return Response.json({ ok: true, data: saved });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'save failed';
    const dup = /unique|P2002/i.test(msg) ? `a script called that name already exists` : msg;
    return Response.json({ ok: false, error: { message: dup } }, { status: 500 });
  }
}

// PUT/DELETE /api/scriptlab/scripts/[id] — edit / remove a saved script.
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const b = (await req.json()) as { name?: string; code?: string; category?: string; description?: string; kind?: string };
    const data: Record<string, string> = {};
    if (b.name?.trim()) data.name = b.name.trim().slice(0, 60);
    if (b.code?.trim()) data.code = b.code.slice(0, 40_000);
    if (b.category) data.category = b.category;
    if (b.description !== undefined) data.description = b.description.slice(0, 400);
    if (b.kind) data.kind = b.kind === 'strategy' ? 'strategy' : 'indicator';
    if (Object.keys(data).length === 0) return Response.json({ ok: false, error: { message: 'nothing to update' } }, { status: 400 });
    const updated = await db.script.update({ where: { id }, data });
    return Response.json({ ok: true, data: updated });
  } catch (e) {
    return Response.json({ ok: false, error: { message: e instanceof Error ? e.message : 'update failed' } }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await db.script.delete({ where: { id } });
    return Response.json({ ok: true, data: { id } });
  } catch (e) {
    return Response.json({ ok: false, error: { message: e instanceof Error ? e.message : 'delete failed' } }, { status: 500 });
  }
}

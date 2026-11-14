// GET|POST /api/positions/autopilot — the auto-rebalance loop control surface.
//
// GET  → settings, live status (running, stats, in-flight) and the journal tail.
// POST → one of:
//        { patch: {...settings} }        — sanitize + apply (interval changes hot-reload)
//        { action: 'run_now' }           — run one cycle immediately (dry-run safe)
//        { action: 'reset_journal' }     — clear the audit trail
//        { action: 'reset_settings' }    — back to safe defaults
// GET also lazily boots the loop if instrumentation somehow didn't.

import {
  autopilotStatus,
  getJournal,
  resetAutopilotSettings,
  resetJournal,
  runAutopilotCycle,
  sanitizeAutopilotPatch,
  startAutopilotLoop,
  updateAutopilotSettings,
} from '@/lib/positions/autopilot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    startAutopilotLoop(); // idempotent — belt and suspenders
    const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') ?? 40) || 40, 200);
    return Response.json(
      { ok: true, ...autopilotStatus(), journal: getJournal(limit) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[positions/autopilot] error:', err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'autopilot unavailable' },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action : null;

    if (action === 'run_now') {
      startAutopilotLoop();
      const cycle = await runAutopilotCycle('manual');
      return Response.json(
        { ok: !cycle.error, cycle, status: autopilotStatus() },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (action === 'reset_journal') {
      const cleared = resetJournal();
      return Response.json({ ok: true, cleared, status: autopilotStatus() });
    }
    if (action === 'reset_settings') {
      const settings = resetAutopilotSettings();
      return Response.json({ ok: true, settings, status: autopilotStatus() });
    }

    const raw = body.patch ?? body.settings ?? body;
    const patch = sanitizeAutopilotPatch(raw as Record<string, unknown>);
    if (Object.keys(patch).length === 0) {
      return Response.json(
        { ok: false, error: 'no valid autopilot settings fields supplied' },
        { status: 400 },
      );
    }
    const settings = updateAutopilotSettings(patch);
    return Response.json(
      { ok: true, settings, status: autopilotStatus() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[positions/autopilot] POST error:', err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'autopilot control unavailable' },
      { status: 500 },
    );
  }
}

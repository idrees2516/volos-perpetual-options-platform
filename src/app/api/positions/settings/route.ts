// GET  /api/positions/settings — the position management settings view
//       (global defaults + presets + per-position overrides).
// POST /api/positions/settings — actions:
//   { action: 'updateGlobal',      settings: {...} }
//   { action: 'updatePosition',    positionId, settings: {...} }
//   { action: 'applyPreset',       profile, positionId? }   (global when no id)
//   { action: 'clearPosition',     positionId }
//   { action: 'reset' }

import {
  getSettingsView,
  presetFor,
  sanitizeSettingsPatch,
  clearPositionSettings,
  resetAllSettings,
  updateGlobalSettings,
  updatePositionSettings,
  type PositionProfile,
} from '@/lib/positions/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(
    { ok: true, ...getSettingsView() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
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
    if (action === 'updateGlobal') {
      const patch = sanitizeSettingsPatch((body.settings ?? {}) as Record<string, unknown>);
      if (Object.keys(patch).length === 0) {
        return Response.json({ ok: false, error: 'no valid settings fields supplied' }, { status: 400 });
      }
      const global = updateGlobalSettings(patch);
      return Response.json({ ok: true, scope: 'global', settings: global, view: getSettingsView() });
    }

    if (action === 'updatePosition') {
      const positionId = String(body.positionId ?? '');
      if (!positionId) return Response.json({ ok: false, error: 'positionId required' }, { status: 400 });
      const patch = sanitizeSettingsPatch((body.settings ?? {}) as Record<string, unknown>);
      if (Object.keys(patch).length === 0) {
        return Response.json({ ok: false, error: 'no valid settings fields supplied' }, { status: 400 });
      }
      const settings = updatePositionSettings(positionId, patch);
      return Response.json({ ok: true, scope: 'position', positionId, settings, view: getSettingsView() });
    }

    if (action === 'applyPreset') {
      const profile = String(body.profile ?? '') as PositionProfile;
      if (!['scalper', 'swing', 'harvester', 'longshot'].includes(profile)) {
        return Response.json({ ok: false, error: 'profile must be scalper | swing | harvester | longshot' }, { status: 400 });
      }
      const preset = presetFor(profile);
      if (body.positionId) {
        const positionId = String(body.positionId);
        const settings = updatePositionSettings(positionId, preset);
        return Response.json({ ok: true, scope: 'position', positionId, settings, view: getSettingsView() });
      }
      const global = updateGlobalSettings(preset);
      return Response.json({ ok: true, scope: 'global', settings: global, view: getSettingsView() });
    }

    if (action === 'clearPosition') {
      const positionId = String(body.positionId ?? '');
      if (!positionId) return Response.json({ ok: false, error: 'positionId required' }, { status: 400 });
      const removed = clearPositionSettings(positionId);
      return Response.json({ ok: true, removed, positionId, view: getSettingsView() });
    }

    if (action === 'reset') {
      resetAllSettings();
      return Response.json({ ok: true, reset: true, view: getSettingsView() });
    }

    return Response.json({ ok: false, error: `unknown action '${action}'` }, { status: 400 });
  } catch (err) {
    console.error('[positions/settings] error:', err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'settings action failed' },
      { status: 500 },
    );
  }
}

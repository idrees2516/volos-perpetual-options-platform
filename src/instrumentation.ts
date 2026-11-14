// Next.js instrumentation hook — runs once when the server process boots
// (dev and production). Boots the AUTO-REBALANCE LOOP + morning-brief roller
// inside the Node runtime so the desk's decision engine is always live.
// Opt out with VOLOS_AUTOPILOT=0 (the UI/API can still start it lazily).

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.VOLOS_AUTOPILOT === '0') {
    console.log('[instrumentation] autopilot loop disabled via VOLOS_AUTOPILOT=0');
    return;
  }
  try {
    const { startAutopilotLoop } = await import('@/lib/positions/autopilot');
    const res = startAutopilotLoop();
    if (res.started) {
      const { getAutopilotSettings } = await import('@/lib/positions/autopilot');
      const s = getAutopilotSettings();
      console.log(
        `[instrumentation] autopilot loop UP — interval ${s.intervalSec}s · enabled=${s.enabled} · dryRun=${s.dryRun} · morning brief ${s.briefHour}:00 ${s.briefTz}`,
      );
    }
  } catch (err) {
    console.error('[instrumentation] autopilot loop failed to start:', err);
  }
}

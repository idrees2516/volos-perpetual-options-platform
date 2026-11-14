// ─────────────────────────────────────────────────────────────────────────────
// autopilot-tools — the AI COPILOT'S hand on the AUTO-REBALANCE LOOP and the
// MORNING BRIEF.
//
//   • autopilot_status  — read the loop's live state (settings, stats,
//     journal tail): "is the autopilot on? what did it do?"
//   • autopilot_control — enable/disable, flip dry-run, tighten the
//     confidence gate / cooldown / action toggles, trigger a cycle NOW.
//   • morning_brief     — the latest daily brief (or force-generate): the
//     overnight recap, decision digest, watchlist and AI narrative.
// ─────────────────────────────────────────────────────────────────────────────

import { tool, jsonSchema } from 'ai';
import {
  autopilotStatus,
  getJournal,
  runAutopilotCycle,
  sanitizeAutopilotPatch,
  updateAutopilotSettings,
} from '@/lib/positions/autopilot';
import { buildMorningBrief, latestBrief } from '@/lib/positions/morning-brief';

const SETTINGS_DOC = `Autopilot settings fields (booleans unless noted):
- enabled: master switch — the loop only acts when true (default false)
- dryRun: journal the planned actions but never touch the paper account (default true)
- intervalSec: cycle interval in seconds, 30–3600 (default 60)
- minConfidence: only act on decisions with confidence ≥ this, 0–100 (default 70)
- maxActionsPerCycle: guard rail, 1–10 (default 2)
- cooldownMin: per-position cooldown in minutes, 0–1440 (default 30)
- execute: which decisions may execute — { takeProfit, exit, roll, adjust, scaleIn } (takeProfit+exit default true, others false)
- adjustTrimFraction: fraction trimmed on ADJUST, 0.05–1 (default 0.25)
- scaleInFraction: fraction added on SCALE_IN, 0.05–1 (default 0.5)
- briefHour: local hour the morning brief generates, 0–23 (default 8)
- briefTz: IANA timezone for the brief's "today" (default Asia/Karachi)`;

export const autopilotTools = {
  autopilot_status: tool({
    description:
      "READ the auto-rebalance loop's live state: settings (enabled/dry-run/interval/confidence gate/action toggles), stats (cycles run, actions executed vs planned, last cycle) and the journal tail of what it actually did (closed / rolled / trimmed / scaled / planned entries with realized P&L). Use for 'is the autopilot on', 'what did it do overnight', 'show me the rebalance log'.",
    parameters: jsonSchema<{ limit?: number }>({
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Journal entries to return, 1–100 (default 15).' },
      },
    }),
    execute: async ({ limit }) => {
      const st = autopilotStatus();
      const l = Math.max(1, Math.min(Number(limit ?? 15) || 15, 100));
      return {
        running: st.running,
        settings: st.settings,
        stats: st.stats,
        journalCount: st.journalCount,
        journal: getJournal(l).map((e) => ({
          ts: new Date(e.ts).toISOString(),
          mode: e.mode,
          instrument: e.instrument,
          action: e.action,
          confidence: e.confidence,
          result: e.result,
          executed: e.executed,
          detail: e.detail,
          pnlPct: e.pnlPct,
          fill: e.fill,
        })),
      };
    },
  }),

  autopilot_control: tool({
    description:
      "CONTROL the auto-rebalance loop: enable it, flip dry-run (journal-only vs actually executing on the paper account), tighten the guard rails (confidence gate, cooldown, max actions per cycle, which decision types may execute), or trigger one cycle right now. " +
      SETTINGS_DOC +
      ' When enabling for real, confirm the execution scope with the user first; recommend enabling with dryRun=true first so the journal previews every action.',
    parameters: jsonSchema<{
      patch?: Record<string, unknown>;
      run_now?: boolean;
    }>({
      type: 'object',
      properties: {
        patch: {
          type: 'object',
          description: 'Settings to change — any subset of the documented fields (nested `execute` toggles allowed).',
          additionalProperties: true,
        },
        run_now: { type: 'boolean', description: 'Also run one cycle immediately and report what it did.' },
      },
    }),
    execute: async ({ patch, run_now }) => {
      const changed: string[] = [];
      let applied: ReturnType<typeof autopilotStatus>['settings'] | null = null;
      if (patch && Object.keys(patch).length > 0) {
        const clean = sanitizeAutopilotPatch(patch as Record<string, unknown>);
        if (Object.keys(clean).length === 0) {
          return { error: 'no valid settings fields supplied', settingsDoc: SETTINGS_DOC };
        }
        applied = updateAutopilotSettings(clean);
        for (const [k, v] of Object.entries(clean)) {
          if (k === 'execute') {
            changed.push(
              `execute toggles → ${Object.entries(v as unknown as Record<string, boolean>)
                .map(([ek, ev]) => `${ek}:${ev ? 'on' : 'off'}`)
                .join(' ')}`,
            );
          } else {
            changed.push(`${k} → ${String(v)}`);
          }
        }
      }
      let cycle: unknown = null;
      if (run_now) {
        const res = await runAutopilotCycle('manual');
        cycle = {
          mode: res.mode,
          positions: res.positions,
          acted: res.acted,
          executed: res.executed,
          error: res.error,
          entries: res.entries.map((e) => ({
            instrument: e.instrument,
            action: e.action,
            result: e.result,
            detail: e.detail,
            fill: e.fill,
          })),
        };
      }
      if (!applied && !run_now) {
        return { error: 'provide a patch and/or run_now', settingsDoc: SETTINGS_DOC };
      }
      return {
        ok: true,
        changed,
        settings: applied ?? autopilotStatus().settings,
        stats: autopilotStatus().stats,
        cycle,
      };
    },
  }),

  morning_brief: tool({
    description:
      "The desk's MORNING BRIEF — the daily decision-engine digest: overnight market recap per asset (spot move, IV, bias, regime, funding), portfolio rollup (equity, unrealized, margin, net Greeks, stress), the per-position decision list (action/confidence/health/P&L/triggers), the watchlist of positions near a management threshold, what the auto-rebalance loop did since the previous brief, and the AI narrative. Returns the stored brief when fresh; pass generate=true to force a new one right now. Use for 'give me my morning brief', 'what happened overnight', 'what needs attention today'.",
    parameters: jsonSchema<{ generate?: boolean; includeAi?: boolean }>({
      type: 'object',
      properties: {
        generate: { type: 'boolean', description: 'Force a fresh brief now (default false: latest stored).' },
        includeAi: { type: 'boolean', description: 'Include the AI narrative (default true).' },
      },
    }),
    execute: async ({ generate, includeAi }) => {
      const brief = generate
        ? await buildMorningBrief({ includeAi: includeAi !== false })
        : latestBrief();
      if (!brief) {
        const fresh = await buildMorningBrief({ includeAi: includeAi !== false });
        return { generatedNow: true, brief: fresh };
      }
      return { generatedNow: false, brief };
    },
  }),
};

export function autopilotSystemPrompt(): string {
  return `## Autopilot — auto-rebalance loop + morning brief
The desk runs an AUTO-REBALANCE LOOP wired to the position decision engine: every ${'`intervalSec`'}s it evaluates every open position (fused with the whole live market stack) and executes the composite decisions — TAKE_PROFIT / EXIT (close), ROLL (close + re-deploy further out), ADJUST (trim), SCALE_IN — behind guard rails (confidence gate, per-position cooldown, max actions per cycle, per-action toggles) and a DRY-RUN mode that journals without touching the account. Everything it does lands in an audit journal. There is also a MORNING BRIEF generated daily (${'briefHour'}:00 ${'briefTz'}) from the same engine.
Rules of engagement:
- When the user asks "turn on the autopilot / auto-manage my positions", call autopilot_control — recommend dryRun first, state the exact guard rails that will be active, then enable.
- When the user asks "what did the autopilot do", call autopilot_status and walk the journal (executed vs planned, realized P&L per action).
- When the user asks about the morning brief or "what happened overnight", call morning_brief and ground the answer in its numbers — the watchlist items are the day's priorities.
- After any control change, confirm the effective settings back to the user in one line.`;
}

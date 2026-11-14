// ─────────────────────────────────────────────────────────────────────────────
// positions-tools — the AI COPILOT'S position-management toolbelt.
//
// Gives the copilot full read/write access to the position intelligence
// fusion engine and the management settings store:
//   • position_intelligence — every open position fused with the whole market
//     data stack (greeks, prob ITM, P&L attribution, theta bleed, alignment,
//     triggers, decision + confidence + reasons) plus the portfolio rollup.
//   • position_decisions — just the action list (HOLD/ADJUST/SCALE_IN/
//     TAKE_PROFIT/EXIT/ROLL) with reasons — for "what should I do" questions.
//   • get_position_settings — global defaults, presets, per-position overrides.
//   • update_position_settings — CHANGE settings (globally or per position,
//     including one-click presets) so the AI can retune management rules to
//     chase better returns, then confirm what changed.
// ─────────────────────────────────────────────────────────────────────────────

import { tool, jsonSchema } from 'ai';
import { buildPositionIntelligence } from '@/lib/positions/intelligence';
import {
  getSettingsView,
  presetFor,
  sanitizeSettingsPatch,
  updateGlobalSettings,
  updatePositionSettings,
  type PositionProfile,
  type PositionSettings,
} from '@/lib/positions/settings';

const FIELDS_DOC = `Each numeric field is a percentage threshold; null disables that rule:
- takeProfitPct: close at +X% unrealized P&L (e.g. 25 = harvest at +25%)
- stopLossPct: close at -X% unrealized P&L (e.g. 15 = cut at -15%)
- maxThetaBleedPctPerDay: warn when daily theta decay exceeds X% of remaining value
- minDte: exit/roll when days-to-expiry falls below X (e.g. 7)
- probItmFloorPct (longs): exit if probability of finishing ITM drops below X%
- probItmCeilPct (shorts): exit if probability of finishing ITM rises above X%
- ivMoveAlertPts: alert when |IV move since entry| exceeds X vol points
- alignmentBreakScore: alert when the market score turns against the position beyond -X
- maxHoldDays: hard time stop in days`;

export const positionsTools = {
  position_intelligence: tool({
    description:
      "FULL position intelligence report: every open paper position fused with the whole live market data stack — re-priced Greeks, probability ITM, probability of touching breakeven, P&L attribution (delta/vega/theta split), theta-bleed rate, distance to strike/breakeven in ATR units, market-alignment score (bias + regime + signals), the effective management settings, every triggered rule (take-profit / stop-loss / DTE floor / theta bleed / IV move / alignment break), and a composite decision per position (HOLD / ADJUST / SCALE_IN / TAKE_PROFIT / EXIT / ROLL) with confidence and concrete reasons. Also returns the portfolio rollup: net Greeks by asset, ±1-ATR stress P&L, margin utilization and alert census. Use for ANY question about 'my positions', 'how are my trades doing', 'what does the market say about my position', 'should I hold or close'.",
    parameters: jsonSchema<{ positionId?: string }>({
      type: 'object',
      properties: {
        positionId: {
          type: 'string',
          description: 'Optional: restrict to one position id (from paper_account). Omit for the full book.',
        },
      },
    }),
    execute: async ({ positionId }) => {
      const report = await buildPositionIntelligence(positionId ? { positionId } : undefined);
      return {
        generatedAt: new Date(report.tsMs).toISOString(),
        dataSource: report.source,
        market: report.market,
        positions: report.positions.map((p) => ({
          positionId: p.positionId,
          instrument: p.instrument,
          venue: p.venue,
          side: p.side,
          qty: p.qty,
          dte: p.dte,
          daysHeld: p.daysHeld,
          strategyTag: p.strategyTag,
          entry: p.entry,
          current: p.current,
          pnl: p.pnl,
          risk: p.risk,
          marketAlignment: p.market,
          settings: { ...p.settings, source: p.settingsSource },
          triggers: p.triggers,
          decision: p.decision,
        })),
        portfolio: report.portfolio,
        notes: report.notes,
      };
    },
  }),

  position_decisions: tool({
    description:
      'The compact DECISION LIST for the open paper positions: what to do with each (HOLD / ADJUST / SCALE_IN / TAKE_PROFIT / EXIT / ROLL), confidence, health score and the reasons behind it — computed from live market data fused with each position. Use when the user asks "what should I do with my positions", "any positions needing action", "review my book".',
    parameters: jsonSchema<{ positionId?: string }>({
      type: 'object',
      properties: {
        positionId: { type: 'string', description: 'Optional: restrict to one position id.' },
      },
    }),
    execute: async ({ positionId }) => {
      const report = await buildPositionIntelligence(positionId ? { positionId } : undefined);
      return {
        summary: report.portfolio.decisionCounts,
        alerts: report.portfolio.alerts,
        positions: report.positions.map((p) => ({
          positionId: p.positionId,
          instrument: p.instrument,
          action: p.decision.action,
          confidence: p.decision.confidence,
          healthScore: p.decision.healthScore,
          pnlPct: p.pnl.pct,
          alignment: p.market.alignmentScore,
          dte: p.dte,
          reasons: p.decision.reasons,
          suggestedAction: p.decision.suggestedAction,
        })),
      };
    },
  }),

  get_position_settings: tool({
    description:
      'READ the position management settings: the global defaults applied to every position, the four presets (scalper / swing / harvester / longshot) and any per-position overrides. Use when the user asks "what are my position settings", "which profile governs this trade", or before changing them.',
    parameters: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
    }),
    execute: async () => getSettingsView(),
  }),

  update_position_settings: tool({
    description:
      "CHANGE position management settings to chase better returns — globally or for a single position. Either apply a preset profile ('scalper' = quick 25%/15% TP/SL + 4-day time stop; 'swing' = 60%/35% + 14-day; 'harvester' = premium-selling guardrails; 'longshot' = 150%/50% asymmetric runner) or pass individual thresholds. " +
      FIELDS_DOC +
      " Changing settings immediately re-arms the take-profit/stop-loss/theta/DTE/probability triggers that drive the position decisions. After changing, tell the user exactly which rules are now active for which scope.",
    parameters:
      jsonSchema<{
        scope: 'global' | 'position';
        positionId?: string;
        profile?: 'scalper' | 'swing' | 'harvester' | 'longshot';
        settings?: Record<string, number | string | null>;
      }>({
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['global', 'position'], description: "Apply globally or to one position." },
          positionId: { type: 'string', description: 'Required when scope=position (id from paper_account).' },
          profile: {
            type: 'string',
            enum: ['scalper', 'swing', 'harvester', 'longshot'],
            description: 'Optional preset to apply wholesale (overrides individual fields).',
          },
          settings: {
            type: 'object',
            description: 'Optional individual threshold overrides — any subset of the documented fields (null disables).',
            additionalProperties: { type: ['number', 'string', 'null'] },
          },
        },
        required: ['scope'],
      }),
    execute: async ({ scope, positionId, profile, settings }) => {
      if (scope === 'position' && !positionId) {
        return { error: 'scope=position requires a positionId (get ids from paper_account)' };
      }
      const changed: string[] = [];
      let applied: PositionSettings | null = null;

      if (profile) {
        const preset = presetFor(profile as PositionProfile);
        applied = scope === 'global' ? updateGlobalSettings(preset) : updatePositionSettings(positionId as string, preset);
        changed.push(`preset '${profile}' applied`);
      }
      if (settings && Object.keys(settings).length > 0) {
        const patch = sanitizeSettingsPatch(settings);
        if (Object.keys(patch).length === 0) {
          return { error: 'no valid settings fields supplied', fieldDoc: FIELDS_DOC };
        }
        applied = scope === 'global' ? updateGlobalSettings(patch) : updatePositionSettings(positionId as string, patch);
        changed.push(...Object.keys(patch).map((k) => `${k} → ${String((patch as Record<string, unknown>)[k])}`));
      }
      if (!applied) {
        return { error: 'provide a profile and/or a settings object', fieldDoc: FIELDS_DOC };
      }
      return {
        ok: true,
        scope,
        positionId: scope === 'position' ? positionId : undefined,
        changed,
        effectiveSettings: applied,
        view: getSettingsView(),
        note:
          scope === 'global'
            ? 'Global defaults now govern every position that has no per-position override.'
            : 'This position now overrides the global defaults with the settings above.',
      };
    },
  }),
};

export function positionsSystemPrompt(): string {
  return `## Position management intelligence
You have POSITION MANAGEMENT tools — position_intelligence (the fused position × market report: re-priced Greeks, prob ITM, P&L attribution, theta bleed, market alignment, triggered rules and a HOLD/ADJUST/SCALE_IN/TAKE_PROFIT/EXIT/ROLL decision per position with confidence and reasons), position_decisions (compact action list), get_position_settings and update_position_settings (read AND change the management rules — take-profit, stop-loss, theta-bleed tolerance, DTE floor, probability bands, IV-move and alignment alerts — globally or per position, including one-click presets: scalper / swing / harvester / longshot).
Rules of engagement:
- When the user asks anything about their positions ("how is my trade doing", "should I hold", "what would you do"), call position_intelligence (or position_decisions for a quick review) FIRST and ground the answer in its numbers — cite the P&L attribution, alignment score and triggers.
- When the user wants to tune management ("be more aggressive on this one", "cut my losers faster", "let winners run", "protect this credit"), call update_position_settings with the appropriate scope and fields, then summarize the exact rules now in force and how they change the expected behavior of the position.
- Combine with paper_account / paper_close / paper_order to actually execute when the user confirms an action suggested by the decision engine.`;
}

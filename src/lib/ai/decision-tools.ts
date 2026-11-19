// ─────────────────────────────────────────────────────────────────────────────
// decision-tools — the AI COPILOT'S unified-decision toolbelt.
//
// The Decision Hub is the product's single decision surface: EVERY data
// family (model room, signal battery, vol cycle, forecast, order flow,
// breadth, funding, paper book, strategy catalog) fused into one report.
// These tools hand that surface to the copilot:
//   • decision_hub   — the full report: stance, confidence, pillars, model
//                      verdicts, strategy fit, risk sizing, actions.
//   • model_suite    — the per-model fit detail (GARCH/HMM/Kalman/OU/Merton/
//                      ML/Kelly/mixed-MC) with parameters and where each
//                      model feeds the product.
// ─────────────────────────────────────────────────────────────────────────────

import { tool, jsonSchema } from 'ai';
import { buildDecisionHub } from '@/lib/decision/hub';
import { buildModelSuite } from '@/lib/decision/suite';

const ASSET_DOC = 'BTC | ETH | SOL (default BTC)';

export const decisionTools = {
  decision_hub: tool({
    description:
      "THE unified decision report — every data family in the product fused into one answer: composite stance (-100..+100 with label RISK-ON/CONSTRUCTIVE/TWO-WAY/DEFENSIVE/RISK-OFF), confidence % and pillar agreement, the five pillars (trend & momentum from the Kalman filter, the model room's P(up) panel, order flow & tape, dealer gamma & structure, paper-book alignment) each with drivers, the vol edge verdict (IV vs GARCH forecast: RICH/CHEAP/FAIR premium), every statistical model's live verdict (GARCH vol forecast, HMM regime with probabilities, Kalman trend, OU stretch, Merton jump tails, ML P(up) accuracy/AUC, Kelly sizing, mixed-process Monte Carlo fan bands), the top strategy fits from the 131-strategy catalog scored against the current context, the risk block (Kelly fraction, CVaR95, max drawdown, margin), the forecast cross-check (drift, P(up) from climatology vs ML vs Monte Carlo), the position rollup, whole-market breadth, and the ACTION BATTERY — what to actually do right now with rationale and sizing. Use for ANY 'what should I do', 'what's the market state', 'should I buy or sell', 'which strategy fits now', 'how much size', 'what do the models say' question.",
    parameters: jsonSchema<{ asset?: string }>({
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'], description: `${ASSET_DOC} — the asset the whole report fuses around` },
      },
    }),
    execute: async ({ asset }) => {
      const report = await buildDecisionHub((asset ?? 'BTC').toUpperCase() as 'BTC' | 'ETH' | 'SOL');
      return {
        asOf: new Date(report.tsMs).toISOString(),
        horizon: `${report.horizonMin} min (${report.horizonBars} × ${report.tf / 60_000}m bars)`,
        stance: report.stance,
        stanceLabel: report.stanceLabel,
        confidence: report.confidence,
        pillarAgreement: report.agreement,
        pillars: report.pillars,
        volEdge: { ivMinusGarchPts: report.volEdgePts, verdict: report.volVerdict },
        modelVerdicts: report.models,
        strategyFit: report.strategyFit,
        actions: report.actions,
        risk: report.risk,
        forecastCrossCheck: report.forecast,
        positions: report.positions,
        breadth: report.breadth,
        watchLevels: report.watch,
        context: report.context,
        notes: report.notes,
        tool: 'decision_hub',
      };
    },
  }),

  model_suite: tool({
    description:
      'The statistical model room on REAL live data: every model (GARCH(1,1), Hidden Markov regime, Kalman local trend, Ornstein-Uhlenbeck pull, Merton jump diffusion, logistic P(up) classifier, Kelly/CVaR sizing, mixed-process Monte Carlo) with its fitted parameters, its chart series, its current verdict, and the exact product surfaces that already consume it (Decision Hub pillars, forecast regime block, autopilot stance gate, strategy fit, Mental Models Lab). Use for "how is the HMM calibrated", "what does GARCH forecast", "show me the model parameters", "which models feed what".',
    parameters: jsonSchema<{ asset?: string; h?: number }>({
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'], description: ASSET_DOC },
        h: { type: 'number', description: 'forecast horizon in bars (4–120, default 24)' },
      },
    }),
    execute: async ({ asset, h }) => {
      const suite = await buildModelSuite((asset ?? 'BTC').toUpperCase(), { h: h ?? 24 });
      return {
        asset: suite.asset,
        bars: suite.bars,
        klineSource: suite.klineSource,
        spot: suite.spot,
        models: suite.models.map((m) => ({
          id: m.id,
          label: m.label,
          kind: m.kind,
          params: m.params,
          verdict: m.verdict,
          consumedBy: m.consumedBy,
          seriesNames: m.series.map((s) => s.name),
        })),
        tool: 'model_suite',
      };
    },
  }),
};

export function decisionHubSystemPrompt(): string {
  return `## Unified Decision Hub
You have THE unified decision surface — decision_hub — which fuses every data family in the product into one report: stance (-100..+100), confidence, the five pillars (trend / model room / flow / dealer structure / book alignment), the vol edge (IV vs the GARCH forecast), every statistical model's live verdict (GARCH, HMM regime, Kalman trend, OU stretch, Merton jump tails, ML P(up), Kelly sizing, the mixed-process Monte Carlo fan), the top strategy fits from the 131-strategy catalog, the risk block (Kelly, CVaR95, drawdown, margin), and the action battery with rationale and sizing numbers.
Rules of engagement:
- For ANY open-ended market question ("what should I do right now", "is this a good time to sell premium", "which strategy fits", "how much size", "what do the models say"), call decision_hub FIRST and ground the answer in its numbers — cite the stance, confidence, vol edge and the specific model verdicts that drive them.
- The model_suite tool answers parameter-level questions ("how is GARCH calibrated", "what's the HMM state probability", "what's the Kelly fraction") and shows where each model already feeds the product.
- Strategy recommendations should come from strategyFit (the catalog scored against the live context), cross-checked against the vol edge: RICH premium favors income/volatility structures, CHEAP favors directional debit.
- Sizing guidance comes from the risk block (half-Kelly convention); never suggest more than the half-Kelly fraction on a single decision.`;
}

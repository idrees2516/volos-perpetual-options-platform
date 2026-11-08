// ---------------------------------------------------------------------------
// cards/catalog — the VolOS generative-UI card catalog, built on
// @json-render/core + @json-render/react's element-tree schema.
//
// The Copilot's `render_card` tool emits a spec { root, elements } whose
// component types and props are constrained to THIS catalog. The frontend
// registry (src/components/terminal/copilot/json-cards.tsx) renders the same
// catalog as real VolOS-styled components — tables, stat grids, charts,
// research digests, action buttons — streamed straight into the chat.
//
// Design rules:
//   • every component is options-domain (metrics, deltas, greeks, sources)
//   • actions wire cards into the REAL platform: load strategies into the
//     builder, paper-deploy variants, open sources
//   • the catalog prompt teaches the model the vocabulary; the catalog
//     validator rejects anything else
// ---------------------------------------------------------------------------

import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { z } from 'zod';

export const cardsCatalog = defineCatalog(schema, {
  components: {
    // ── layout containers ──────────────────────────────────────────────────
    SectionCard: {
      props: z.object({
        title: z.string(),
        description: z.string().nullish(),
        accent: z.enum(['teal', 'amber', 'rose', 'violet', 'zinc']).nullish(),
      }),
      slots: ['default'],
      description: 'Titled card container for one logical block (metric group, digest, verdict). Prefer as the ROOT element of a card.',
    },
    Grid: {
      props: z.object({
        columns: z.number().int().min(1).max(3).nullish(),
        gap: z.enum(['sm', 'md']).nullish(),
      }),
      slots: ['default'],
      description: 'Responsive column layout for arranging 2–3 child cards side by side.',
    },

    // ── data display ───────────────────────────────────────────────────────
    StatGrid: {
      props: z.object({
        stats: z.array(
          z.object({
            label: z.string(),
            value: z.union([z.string(), z.number()]),
            delta: z.string().nullish(),
            deltaPositive: z.boolean().nullish(),
            hint: z.string().nullish(),
          }),
        ),
        columns: z.number().int().min(1).max(4).nullish(),
      }),
      description: 'Row(s) of key metrics: spot, IV, POP, max loss, greeks, win rate… Each stat can carry a delta like "+3.2pp" with deltaPositive=true for green. Hint = one-line meaning (teaching mode).',
    },
    DataTable: {
      props: z.object({
        title: z.string().nullish(),
        columns: z.array(z.object({ key: z.string(), label: z.string(), align: z.enum(['left', 'right']).nullish() })),
        rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
        dense: z.boolean().nullish(),
      }),
      description: 'Comparison table — venues, strategy variants, strikes, backtest stats. Rows are objects keyed by column key. Keep <= 8 rows.',
    },
    LineChart: {
      props: z.object({
        label: z.string().nullish(),
        points: z.array(z.number()),
        height: z.number().int().min(40).max(140).nullish(),
        color: z.enum(['teal', 'amber', 'rose', 'violet']).nullish(),
        baseline: z.number().nullish(),
      }),
      description: 'Sparkline for a numeric series >= 6 points — payoff profile, equity curve, IV trend, funding history.',
    },
    BarChart: {
      props: z.object({
        label: z.string().nullish(),
        items: z.array(z.object({ label: z.string(), value: z.number() })).min(2).max(12),
        color: z.enum(['teal', 'amber', 'rose', 'violet']).nullish(),
      }),
      description: 'Horizontal bars for categorical comparisons — OI by venue, premium by leg, allocation by strike.',
    },

    // ── BackQuant analytics visuals ────────────────────────────────────────
    HeatMatrix: {
      props: z.object({
        title: z.string().nullish(),
        rowLabels: z.array(z.string()).min(2).max(14),
        colLabels: z.array(z.string()).min(2).max(10),
        values: z.array(z.array(z.number())),
        unit: z.string().nullish(),
        diverging: z.boolean().nullish(),
        compact: z.boolean().nullish(),
      }),
      description: 'Numeric heat grid — rowLabels × colLabels with one number per cell (values MUST align: values.length == rowLabels.length, values[i].length == colLabels.length). Use for strike×expiry GEX, IV surface, greek TRACE maps, liquidation intensity. diverging=true colors +/- around zero (teal positive, rose negative — GEX, flow); omit for pure intensity 0–100 (amber — liquidation heat). Round cell values compactly ($M for dollar flows).',
    },
    LevelStrip: {
      props: z.object({
        title: z.string().nullish(),
        spot: z.number(),
        levels: z.array(z.object({
          label: z.string(),
          price: z.number(),
          tone: z.enum(['wall', 'support', 'flip', 'magnet']).nullish(),
        })).min(2).max(8),
      }),
      description: 'Price-level ladder around spot — the dealer-positioning view: spot line plus key levels (HVL/flip, call walls, put support, max pain). tone: wall = resistance (rose), support = floor (teal), flip = gamma flip (amber), magnet = pin/max-pain (violet).',
    },

    // ── research & teaching ────────────────────────────────────────────────
    ResearchDigest: {
      props: z.object({
        title: z.string(),
        summary: z.string(),
        findings: z.array(z.object({ title: z.string(), detail: z.string() })).nullish(),
        sources: z.array(z.object({ label: z.string(), url: z.string() })),
        engine: z.string().nullish(),
      }),
      description: 'Web-research digest card — REQUIRED whenever an answer cites internet sources. Sources carry label + absolute URL (they render as clickable). Findings = 2–4 distilled bullet blocks.',
    },
    InsightList: {
      props: z.object({
        title: z.string().nullish(),
        items: z.array(z.object({ icon: z.enum(['insight', 'risk', 'greek', 'timing', 'flow']).nullish(), title: z.string(), detail: z.string() })),
      }),
      description: 'Teaching/analysis list — one titled insight per item with a short explanatory detail. Icons: insight, risk, greek, timing, flow.',
    },
    Alert: {
      props: z.object({
        tone: z.enum(['info', 'success', 'warning', 'danger']),
        title: z.string(),
        detail: z.string().nullish(),
      }),
      description: 'Short callout — margin warnings, regime alerts, verdicts. Do not overuse.',
    },

    // ── actions ────────────────────────────────────────────────��───────────
    ActionCard: {
      props: z.object({
        title: z.string().nullish(),
        description: z.string().nullish(),
        buttons: z
          .array(
            z.object({
              label: z.string(),
              action: z.enum(['load_strategy', 'paper_deploy', 'open_url']),
              strategyId: z.string().nullish(),
              url: z.string().nullish(),
              variantName: z.string().nullish(),
              primary: z.boolean().nullish(),
            }),
          )
          .min(1)
          .max(4),
      }),
      description: 'Buttons that act on the REAL platform: load_strategy (catalog id into the builder), paper_deploy (deploy a variant to the paper desk), open_url (open a web source). Mark one button primary=true.',
    },
  },

  actions: {
    load_strategy: {
      params: z.object({ strategyId: z.string() }),
      description: 'Load a catalog strategy into the strategy builder workspace',
    },
    paper_deploy: {
      params: z.object({ variantName: z.string().nullish() }),
      description: 'Paper-deploy the recommended strategy variant on the paper desk',
    },
    open_url: {
      params: z.object({ url: z.string() }),
      description: 'Open an external web source in a new tab',
    },
  },
});

/** System-prompt section that teaches the model the card vocabulary + rules.
 *  Derived FROM the catalog definition itself (single source of truth) —
 *  components, prop schemas, actions — in a compact tool-call-friendly form
 *  (~4k chars instead of the 19k JSONL-patch protocol prompt). */
export function cardsSystemPrompt(): string {
  const data = cardsCatalog.data as unknown as {
    components: Record<string, { props: z.ZodType; slots?: string[]; description?: string }>;
    actions: Record<string, { params: z.ZodType; description?: string }>;
  };
  const lines: string[] = [];
  lines.push('## Generative UI cards (render_card tool)');
  lines.push(
    'You can render rich data cards INSIDE the chat by calling the `render_card` tool. It takes a spec: { "root": "<key>", "elements": { "<key>": { "type": "<Component>", "props": {...}, "children": ["<child-key>", ...] } } }. ' +
      'Build the tree bottom-up: every element gets a unique key; the root element should be a SectionCard; children reference other element keys (render in order).',
  );
  lines.push('');
  lines.push('### Available components');
  for (const [name, def] of Object.entries(data.components)) {
    let propsJs = '';
    try {
      const js = z.toJSONSchema(def.props, { io: 'input' }) as Record<string, unknown>;
      const props = (js.properties ?? {}) as Record<string, unknown>;
      const required = new Set((js.required ?? []) as string[]);
      const parts = Object.entries(props).map(([k, v]) => {
        const t = v as { type?: string; anyOf?: unknown[]; enum?: unknown[]; description?: string };
        let ty = t.type ?? 'any';
        if (t.anyOf) {
          const opts = (t.anyOf as Array<{ type?: string; enum?: unknown[] }>).map((o) => (o.enum ? `${o.type || ''} enum` : o.type ?? '?'));
          ty = opts.join('|');
        }
        if (t.enum) ty = `enum(${(t.enum as string[]).join('|')})`;
        return `${k}${required.has(k) ? '' : '?'}: ${ty}`;
      });
      propsJs = parts.join(', ');
    } catch {
      propsJs = '(see description)';
    }
    const slots = def.slots?.length ? ` slots: ${def.slots.join(',')}` : '';
    lines.push(`- **${name}** { ${propsJs} }${slots} — ${def.description ?? ''}`);
  }
  lines.push('');
  lines.push('### Card actions (buttons)');
  for (const [name, def] of Object.entries(data.actions)) {
    lines.push(`- ${name}(${JSON.stringify(z.toJSONSchema(def.params, { io: 'input' })).slice(0, 120)}) — ${def.description ?? ''}`);
  }
  lines.push('');
  lines.push('### Rules');
  for (const rule of CARD_RULES) lines.push(`- ${rule}`);
  lines.push('');
  lines.push('A minimal valid example:');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        root: 'sec',
        elements: {
          sec: { type: 'SectionCard', props: { title: 'BTC Options Snapshot', description: 'Live desk numbers', accent: 'teal' }, children: ['stats'] },
          stats: {
            type: 'StatGrid',
            props: {
              stats: [
                { label: 'Spot', value: '$78,412', delta: '+2.4%', deltaPositive: true, hint: 'Deribit index' },
                { label: 'ATM IV 30d', value: '39.5%', delta: null, deltaPositive: null, hint: 'Annualized' },
              ],
              columns: 2,
            },
          },
        },
      },
      null,
      1,
    ),
  );
  lines.push('```');
  return lines.join('\n');
}

const CARD_RULES = [
  'Cards are for DATA, not prose — keep narrative in chat text, put structure in cards.',
  'Root every card in a SectionCard; use a Grid (2–3 columns) when comparing distinct groups side by side.',
  'StatGrid for numeric metric sets; DataTable when comparing rows of like things (venues, variants, strikes); LineChart for numeric series of 6+ points; BarChart for categorical splits.',
  'HeatMatrix for 2-D numeric grids (strike×expiry GEX, IV surface, TRACE maps — keep ≤ 14×10 cells, values aligned to labels); LevelStrip for spot vs key price levels (HVL, walls, support, max pain).',
  'Whenever an answer cites internet research, ALWAYS include a ResearchDigest card with clickable sources (label + absolute URL).',
  'Prefer ending a recommendation with an ActionCard — buttons like "Load into builder" (load_strategy), "Paper-deploy" (paper_deploy), "Read the research" (open_url).',
  'Keep cards compact: 14 or fewer elements total, 8 or fewer table rows. Numbers formatted like the platform: $78,412 · 39.5% · +3.2pp · 1.25x.',
  'Use warning/danger Alerts only for genuine risk statements (margin, undefined loss, event risk).',
  'Call render_card ONCE per answer with one consolidated spec (root SectionCard can hold a Grid of sub-cards) rather than many small cards.',
];

export interface CardSpec {
  root: string;
  elements: Record<
    string,
    { type: string; props?: Record<string, unknown>; children?: string[]; slots?: Record<string, string[]> }
  >;
}

/** Validate a render_card payload against the catalog. Returns issues (empty = valid). */
export function validateCardSpec(spec: unknown): { valid: boolean; issues: string[] } {
  try {
    const res = cardsCatalog.validate(spec) as {
      success?: boolean;
      error?: { issues?: Array<{ path?: Array<string | number>; message?: string; code?: string }> };
      issues?: unknown;
    };
    if (res?.success === true) return { valid: true, issues: [] };
    const issues: string[] = [];
    const zodIssues = res?.error?.issues;
    if (Array.isArray(zodIssues)) {
      for (const it of zodIssues.slice(0, 8)) {
        issues.push(`${(it.path ?? []).join('.')}: ${it.message ?? it.code ?? 'invalid'}`.replace(/^: /, ''));
      }
    }
    if (issues.length === 0 && !res?.success) issues.push('spec does not match the card catalog');
    return { valid: false, issues };
  } catch (err) {
    return { valid: false, issues: [err instanceof Error ? err.message : String(err)] };
  }
}

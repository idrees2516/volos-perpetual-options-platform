// ---------------------------------------------------------------------------
// cards/render-card-tool — the AI SDK tool that lets the orchestrator paint
// generative-UI cards into the chat, validated against the VolOS card
// catalog (@json-render). The FRONTEND renders the tool args (the spec)
// through the same catalog's React registry — see json-cards.tsx.
// ---------------------------------------------------------------------------

import { tool, jsonSchema } from 'ai';
import { cardsCatalog, validateCardSpec, type CardSpec } from './catalog';
import { z } from 'zod';

/**
 * Deep-normalize + validate a spec:
 *   • default children:[] on every element (leaf components omit it)
 *   • lift nested `payload` objects on ActionCard buttons to flat props
 *     (models like wrapping action params — accept both shapes)
 *   • accept ResearchDigest findings as plain strings → { title, detail: '' }
 *   • deep-validate each element's props against the catalog zod schemas
 *     (the element-tree schema alone does not check props deeply)
 */
function deepNormalize(spec: unknown): { spec: CardSpec | null; issues: string[] } {
  if (!spec || typeof spec !== 'object') return { spec: null, issues: ['spec must be an object'] };
  const s = spec as { root?: unknown; elements?: unknown };
  if (typeof s.root !== 'string' || !s.elements || typeof s.elements !== 'object') {
    return { spec: null, issues: ['spec must be { root: string, elements: object }'] };
  }
  const raw = s.elements as Record<string, { type?: unknown; props?: unknown; children?: unknown }>;
  const elements: CardSpec['elements'] = {};
  const issues: string[] = [];
  const comps = (cardsCatalog.data as unknown as {
    components: Record<string, { props: z.ZodType }>;
  }).components;

  for (const [k, el] of Object.entries(raw)) {
    if (!el || typeof el !== 'object' || typeof (el as { type?: unknown }).type !== 'string') {
      issues.push(`elements.${k}: missing type`);
      continue;
    }
    const type = (el as { type: string }).type;
    let props = ((el as { props?: unknown }).props ?? {}) as Record<string, unknown>;

    // ActionCard buttons: lift `payload` nesting to flat props.
    if (type === 'ActionCard' && Array.isArray(props.buttons)) {
      props = {
        ...props,
        buttons: (props.buttons as Array<Record<string, unknown>>).map((b) => {
          const payload = (b.payload ?? {}) as Record<string, unknown>;
          const flat = { ...b, ...(payload as object) };
          delete flat.payload;
          return flat;
        }),
      };
    }
    // ResearchDigest findings: plain strings → { title, detail: '' }.
    if (type === 'ResearchDigest' && Array.isArray(props.findings)) {
      props = {
        ...props,
        findings: (props.findings as unknown[]).map((f) => (typeof f === 'string' ? { title: f, detail: '' } : f)),
      };
    }
    // DataTable columns: plain strings → { key: slug, label: string }.
    if (type === 'DataTable' && Array.isArray(props.columns)) {
      const seen = new Map<string, number>();
      props = {
        ...props,
        columns: (props.columns as unknown[]).map((c, i) => {
          if (typeof c === 'string') {
            const slug = c.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `c${i}`;
            const n = seen.get(slug) ?? 0;
            seen.set(slug, n + 1);
            return { key: n === 0 ? slug : `${slug}-${n}`, label: c };
          }
          return c;
        }),
      };
      // rows as positional arrays → objects keyed by the (normalized) column keys
      if (Array.isArray(props.rows)) {
        const keys = (props.columns as Array<{ key: string }>).map((c) => c.key);
        props = {
          ...props,
          rows: (props.rows as unknown[]).map((r) => {
            if (Array.isArray(r)) {
              const obj: Record<string, string | number | null> = {};
              keys.forEach((k, i) => (obj[k] = (r[i] ?? null) as string | number | null));
              return obj;
            }
            return r;
          }),
        };
      }
    }

    // Deep props validation against the catalog's zod schemas.
    const comp = comps[type];
    if (comp) {
      const parsed = comp.props.safeParse(props);
      if (!parsed.success) {
        for (const iss of parsed.error.issues.slice(0, 4)) {
          issues.push(`elements.${k}.props.${iss.path.join('.')}: ${iss.message}`);
        }
      } else {
        props = parsed.data as Record<string, unknown>;
      }
    } else {
      issues.push(`elements.${k}: unknown component type "${type}"`);
    }

    elements[k] = {
      type,
      props,
      children: Array.isArray((el as { children?: unknown }).children) ? ((el as { children?: unknown }).children as string[]) : [],
    };
  }

  if (Object.keys(elements).length === 0) {
    return { spec: null, issues: issues.length ? issues : ['spec has no valid elements'] };
  }
  if (!elements[s.root]) {
    issues.push(`root "${s.root}" does not match any element key`);
    return { spec: null, issues };
  }
  // Drop children refs that don't resolve (truncation safety).
  for (const el of Object.values(elements)) {
    if (Array.isArray(el.children)) el.children = el.children.filter((c) => elements[c] !== undefined);
    else el.children = [];
  }
  return { spec: { root: s.root, elements }, issues };
}

export const renderCardTool = tool({
  description:
    'Render a rich data card (stat grids, tables, charts, research digests, action buttons) INSIDE the chat from the VolOS card catalog. The spec is { "root": "<element-key>", "elements": { "<key>": { "type": "<Component>", "props": {…}, "children": ["<child-key>", …] } } }. Follow the component vocabulary and rules from the system prompt exactly. One consolidated card per answer (root SectionCard, optionally holding a Grid of sub-cards). The user SEES this card rendered — do not repeat its full contents in the text; narrate around it.',
  parameters: jsonSchema<{ root: string; elements: Record<string, { type: string; props?: Record<string, unknown>; children?: string[] }> }>({
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Key of the root element (a SectionCard)' },
      elements: {
        type: 'object',
        description: 'Flat map of elements by unique key; children reference other keys',
        additionalProperties: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Component name from the catalog' },
            props: { type: 'object', description: 'Component props (must match the catalog schema)' },
            children: { type: 'array', items: { type: 'string' }, description: 'Child element keys, render order' },
          },
          required: ['type'],
        },
      },
    },
    required: ['root', 'elements'],
  }),
  execute: async (args) => {
    const { spec: normalized, issues } = deepNormalize(args);
    if (!normalized) {
      return { rendered: false, error: 'invalid render_card spec', issues: issues.slice(0, 8) };
    }
    if (issues.length > 0) {
      return { rendered: false, error: 'spec rejected by the card catalog — fix these and call render_card again with the FULL corrected spec', issues: issues.slice(0, 8) };
    }
    const structural = validateCardSpec(normalized);
    if (!structural.valid) {
      return { rendered: false, error: 'spec rejected by the card catalog — fix these and call render_card again with the FULL corrected spec', issues: structural.issues };
    }
    const types = Object.values(normalized.elements).map((e) => e.type);
    const leafCount = Object.keys(normalized.elements).length;
    return {
      rendered: true,
      elements: leafCount,
      componentTypes: [...new Set(types)],
      note: 'Card is now visible to the user. Summarize the takeaway in one short sentence, do not dump the card data again.',
    };
  },
});

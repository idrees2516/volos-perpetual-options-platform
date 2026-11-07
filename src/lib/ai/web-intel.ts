// ---------------------------------------------------------------------------
// web-intel — the internet research engine behind the Copilot's
// `research_web` / `scrape_page` tools.
//
// Provider chain (first available wins, per call):
//   1. FIRECRAWL  — the real Firecrawl Web Data API (search · scrape ·
//                   Alexandria tool discovery & execution) when
//                   FIRECRAWL_API_KEY is configured.
//   2. ZAI-WEB    — the sandbox's z-ai web_search function (real internet
//                   search results, no key needed) + plain-HTTP page digests.
//   3. LOCAL      — graceful synthesis from the platform's own live exchange
//                   feeds, clearly labeled so the model never mistakes it
//                   for internet research.
//
// Every public call is TTL-cached (like exchange-feeds) and normalized into
// the same shapes regardless of provider, so agents and cards never care
// which engine answered.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { routeAlexandriaSources, type AlexandriaSource } from './alexandria-sources';

export type WebIntelProvider = 'firecrawl' | 'zai-web' | 'local';

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  sourceId?: string;
  sourceName?: string;
  publishedDate?: string;
}

export interface PageDigest {
  url: string;
  title: string;
  markdown: string;
  provider: WebIntelProvider;
  chars: number;
}

export interface AlexandriaToolInfo {
  provider: string;
  capability: string;
  description?: string;
}

export interface ResearchResult {
  query: string;
  focus?: string;
  provider: WebIntelProvider;
  routedSources: Array<{ id: string; name: string; domain: string; focus: string }>;
  hits: WebHit[];
  tsMs: number;
  note: string;
}

// --- cache -------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { t: number; v: unknown }>();

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v as T;
  if (hit) cache.delete(key);
  return undefined;
}
function cacheSet(key: string, v: unknown): void {
  if (cache.size > 400) cache.clear();
  cache.set(key, { t: Date.now(), v });
}

// --- Firecrawl client (lazy) ---------------------------------------------------

type AnyFirecrawl = {
  search: (q: string, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  scrape: (urlOrReq: string | Record<string, unknown>, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  findTools?: (opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

let fcPromise: Promise<AnyFirecrawl | null> | null = null;

function firecrawlApiKey(): string | undefined {
  const k = process.env.FIRECRAWL_API_KEY || process.env.NEXT_PUBLIC_FIRECRAWL_API_KEY;
  return k && k.trim().length > 8 ? k.trim() : undefined;
}

async function getFirecrawl(): Promise<AnyFirecrawl | null> {
  if (!firecrawlApiKey()) return null;
  if (!fcPromise) {
    fcPromise = (async () => {
      try {
        const mod = (await import('firecrawl')) as { Firecrawl?: unknown; default?: unknown };
        const Ctor = (mod.Firecrawl ?? mod.default) as new (opts: { apiKey: string }) => AnyFirecrawl;
        return new Ctor({ apiKey: firecrawlApiKey()! });
      } catch (err) {
        console.warn('[web-intel] firecrawl init failed:', err instanceof Error ? err.message : err);
        return null;
      }
    })();
  }
  return fcPromise;
}

// --- z-ai web_search fallback (real internet, no API key) ---------------------

interface ZaiHit { url: string; name: string; snippet: string; host_name: string; date?: string }

function zaiWebSearch(query: string, num: number): Promise<ZaiHit[]> {
  return new Promise((resolve) => {
    const args = JSON.stringify({ query, num });
    const child = spawn('z-ai', ['function', '-n', 'web_search', '-a', args], {
      timeout: 30_000,
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (errOut += String(d)));
    child.on('error', () => resolve([]));
    child.on('close', () => {
      try {
        // The CLI prints a JSON report; the result array may be top-level or under data/results.
        const start = out.indexOf('[');
        const end = out.lastIndexOf(']');
        if (start >= 0 && end > start) {
          const arr = JSON.parse(out.slice(start, end + 1)) as ZaiHit[];
          resolve(Array.isArray(arr) ? arr.slice(0, num) : []);
        } else {
          resolve([]);
        }
      } catch {
        if (errOut) console.warn('[web-intel] zai web_search stderr:', errOut.slice(0, 200));
        resolve([]);
      }
    });
  });
}

// --- plain HTTP page fetch fallback -------------------------------------------

async function fetchPageText(url: string): Promise<{ title: string; text: string } | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; VolOS-Research/1.0; +https://volos.local)',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/|json|xml/.test(type)) return null;
    const html = (await res.text()).slice(0, 900_000);
    const titleMatch = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    return { title: (titleMatch?.[1] ?? '').trim(), text };
  } catch {
    return null;
  }
}

// --- normalization helpers ------------------------------------------------------

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function matchSource(domain: string, routed: AlexandriaSource[]): AlexandriaSource | undefined {
  return routed.find((s) => domain.endsWith(s.domain.replace(/^www\./, '')) || s.domain.replace(/^www\./, '').endsWith(domain));
}

// --- public API ------------------------------------------------------------------

export function webIntelProvider(): WebIntelProvider {
  return firecrawlApiKey() ? 'firecrawl' : 'zai-web';
}

/**
 * Search the options-industry web for a research query.
 * Firecrawl search is domain-boosted with the routed Alexandria sources;
 * the z-ai fallback runs a plain query and tags hits against the catalog.
 */
export async function researchWeb(
  query: string,
  opts: { focus?: string; limit?: number; includeDomains?: string[] } = {},
): Promise<ResearchResult> {
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 10);
  const key = `research:${query}:${opts.focus ?? ''}:${limit}`;
  const cached = cacheGet<ResearchResult>(key);
  if (cached) return cached;

  const routed = routeAlexandriaSources(query, opts.focus, 8);
  const routedBrief = routed.map((s) => ({ id: s.id, name: s.name, domain: s.domain, focus: s.focus }));
  const routedDomains = routed.slice(0, 4).map((s) => s.domain);
  const includeDomains = opts.includeDomains && opts.includeDomains.length > 0 ? opts.includeDomains : undefined;

  const fc = await getFirecrawl();

  // ── provider 1: Firecrawl ──
  if (fc) {
    try {
      const data = (await fc.search(query, {
        limit,
        sources: ['web', 'news'],
        ...(includeDomains ? { includeDomains } : routedDomains.length ? { includeDomains: routedDomains } : {}),
      })) as { web?: Array<{ url?: string; title?: string; description?: string; source?: string; publishedTime?: string }>; news?: Array<{ url?: string; title?: string; description?: string; source?: string; publishedTime?: string }> };
      const raw = [...(data.web ?? []), ...(data.news ?? [])].filter((h) => h.url);
      if (raw.length > 0) {
        const hits: WebHit[] = raw.slice(0, limit).map((h) => {
          const domain = domainOf(h.url!);
          const src = matchSource(domain, routed);
          return {
            title: h.title ?? domain,
            url: h.url!,
            snippet: (h.description ?? '').slice(0, 320),
            domain,
            sourceId: src?.id,
            sourceName: src?.name,
            publishedDate: h.publishedTime,
          };
        });
        const result: ResearchResult = {
          query,
          focus: opts.focus,
          provider: 'firecrawl',
          routedSources: routedBrief,
          hits,
          tsMs: Date.now(),
          note: `Firecrawl web+news search${includeDomains || routedDomains.length ? `, domain-boosted: ${routedDomains.join(', ')}` : ''}.`,
        };
        cacheSet(key, result);
        return result;
      }
    } catch (err) {
      console.warn('[web-intel] firecrawl search failed, falling back:', err instanceof Error ? err.message : err);
    }
  }

  // ── provider 2: z-ai web_search (real internet, no key) ──
  const zai = await zaiWebSearch(query, limit);
  if (zai.length > 0) {
    const hits: WebHit[] = zai.map((h) => {
      const domain = (h.host_name ?? domainOf(h.url)).replace(/^www\./, '');
      const src = matchSource(domain, routed);
      return {
        title: h.name ?? domain,
        url: h.url,
        snippet: (h.snippet ?? '').slice(0, 320),
        domain,
        sourceId: src?.id,
        sourceName: src?.name,
        publishedDate: h.date || undefined,
      };
    });
    const result: ResearchResult = {
      query,
      focus: opts.focus,
      provider: 'zai-web',
      routedSources: routedBrief,
      hits,
      tsMs: Date.now(),
      note:
        'Real internet web search (z-ai web_search fallback — set FIRECRAWL_API_KEY to unlock full Firecrawl Alexandria: domain-boosted search, deep scrapes and structured provider tools).',
    };
    cacheSet(key, result);
    return result;
  }

  // ── provider 3: local synthesis (never pretend it's the web) ──
  const result: ResearchResult = {
    query,
    focus: opts.focus,
    provider: 'local',
    routedSources: routedBrief,
    hits: [],
    tsMs: Date.now(),
    note: 'No web-search provider reachable right now. Ground answers in the platform live exchange feeds instead and say openly that internet research is unavailable.',
  };
  cacheSet(key, result);
  return result;
}

/**
 * Deep-scrape one URL into a markdown digest.
 * Firecrawl scrape (markdown) when configured; plain HTTP fetch otherwise.
 */
export async function scrapePage(url: string, maxChars = 2600): Promise<PageDigest> {
  const key = `scrape:${url}:${maxChars}`;
  const cached = cacheGet<PageDigest>(key);
  if (cached) return cached;

  const fc = await getFirecrawl();
  if (fc) {
    try {
      const doc = (await fc.scrape(url, { formats: ['markdown'] })) as {
        markdown?: string;
        metadata?: { title?: string };
      };
      if (doc?.markdown) {
        const digest: PageDigest = {
          url,
          title: doc.metadata?.title ?? domainOf(url),
          markdown: doc.markdown.slice(0, maxChars),
          provider: 'firecrawl',
          chars: Math.min(doc.markdown.length, maxChars),
        };
        cacheSet(key, digest);
        return digest;
      }
    } catch (err) {
      console.warn('[web-intel] firecrawl scrape failed, falling back:', err instanceof Error ? err.message : err);
    }
  }

  const page = await fetchPageText(url);
  if (page && page.text.length > 200) {
    const digest: PageDigest = {
      url,
      title: page.title || domainOf(url),
      markdown: page.text.slice(0, maxChars),
      provider: 'zai-web',
      chars: Math.min(page.text.length, maxChars),
    };
    cacheSet(key, digest);
    return digest;
  }

  return { url, title: domainOf(url), markdown: '', provider: 'local', chars: 0 };
}

/**
 * Discover Firecrawl Alexandria provider tools (structured data calls) for a
 * research domain. Returns [] unless Firecrawl is configured.
 */
export async function discoverAlexandriaTools(query: string): Promise<AlexandriaToolInfo[]> {
  const fc = await getFirecrawl();
  if (!fc || !fc.findTools) return [];
  const key = `alextools:${query}`;
  const cached = cacheGet<AlexandriaToolInfo[]>(key);
  if (cached) return cached;
  try {
    const data = (await fc.findTools({ level: 'tools', limit: 10 })) as {
      items?: Array<{ provider?: string; capability?: string; name?: string; id?: string }>;
    };
    const tools = (data.items ?? [])
      .filter((t) => t.provider && t.capability)
      .map((t) => ({ provider: t.provider!, capability: t.capability!, description: t.name }));
    cacheSet(key, tools);
    return tools;
  } catch (err) {
    console.warn('[web-intel] findTools failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Execute one Firecrawl Alexandria provider tool (structured data pull).
 * Returns null when Firecrawl is not configured or the call fails.
 */
export async function callAlexandriaTool(provider: string, capability: string, options?: Record<string, unknown>): Promise<unknown | null> {
  const fc = await getFirecrawl();
  if (!fc) return null;
  try {
    const data = (await fc.scrape({ alexandria: { provider, capability, ...(options ? { options } : {}) } })) as {
      alexandria?: Array<{ data?: unknown; error?: unknown }>;
    };
    const first = data.alexandria?.[0];
    if (first && !('error' in first && first.error)) return (first as { data?: unknown }).data ?? first;
    return null;
  } catch (err) {
    console.warn('[web-intel] alexandria call failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

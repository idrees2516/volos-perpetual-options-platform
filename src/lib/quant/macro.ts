// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · macro — real TradFi/corporate data from free public sources:
//   • US spot-crypto ETF daily net flows  → farside.co.uk tables (per fund)
//   • CFTC Commitments of Traders        → publicreporting.cftc.gov Socrata
//   • SEC Form 4 insider trades           → data.sec.gov submissions + XML
//   • SEC 13F institutional holders       → EDGAR full-text search + infotable
// No static fallbacks: if a source is unreachable the module says so.
// ─────────────────────────────────────────────────────────────────────────────

import type { MacroCot, MacroEtf, MacroFiling } from './types';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 VolOS/1.0';

/** curl fallback — some WAFs (farside) block Node's TLS fingerprint but allow curl. */
async function curlGet(url: string, timeoutMs = 15000): Promise<string> {
  const { stdout } = await execFile(
    'curl',
    ['-sS', '-f', '-m', String(Math.ceil(timeoutMs / 1000)), '-A', UA, '-H', 'Accept: text/html,application/json', url],
    { maxBuffer: 20_000_000 },
  );
  return stdout;
}

/** Fetch with retry (SEC transient 403s) + curl fallback (farside WAF). */
const SEC_UA = 'VolOS Research Terminal (research@volos.local)'; // SEC wants declared bot UAs
const BROWSER_UA = UA; // farside & friends want browser UAs

function uaFor(url: string): string {
  return /\.gov/.test(url) ? SEC_UA : BROWSER_UA;
}

async function fetchTextOnce(url: string, accept: string, timeoutMs: number, ua: string): Promise<string> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': ua, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' },
      cache: 'no-store',
    });
    if (res.ok) return await res.text();
    throw Object.assign(new Error(`http ${res.status}`), { status: res.status });
  } finally {
    clearTimeout(to);
  }
}

async function getText(url: string, timeoutMs = 15000): Promise<string> {
  const ua = uaFor(url);
  const accept = 'text/html,application/json,application/xml';
  try {
    return await fetchTextOnce(url, accept, timeoutMs, ua);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status && status >= 400 && status < 500 && status !== 403) throw e;
    // transient 403 / network error → retry once after backoff
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await fetchTextOnce(url, accept, timeoutMs, ua);
    } catch (e2) {
      if ((e2 as { status?: number }).status === 403 && !/\.gov/.test(url)) return curlGet(url, timeoutMs);
      throw e2;
    }
  }
}

async function getJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  const text = await getText(url, timeoutMs);
  return JSON.parse(text) as T;
}

// ── ETF flows (Farside) ──────────────────────────────────────────────────────

const FUNDS: Record<string, string> = {
  IBIT: 'BlackRock',
  FBTC: 'Fidelity',
  ARKB: 'Ark 21Shares',
  BITB: 'Bitwise',
  GBTC: 'Grayscale',
  BTCO: 'Invesco Galaxy',
  EZBC: 'Canary',
  BRRR: 'Valkyrie',
  HODL: 'VanEck',
  BTCW: 'ProShares',
  MSBT: 'Rockefeller',
  BTC: 'Grayscale Mini',
  ETHA: 'BlackRock',
  FETH: 'Fidelity',
  ETHE: 'Grayscale',
  ETHV: 'VanEck',
  QETH: 'Invesco',
  EZET: 'Canary',
  ETHW: 'ProShares',
  ETHT: 'T-Rex',
  ETH: 'Grayscale Mini',
};

const gMacro = globalThis as unknown as { __volquantMacro?: Map<string, { v: unknown; ts: number }> };
const macroCache = gMacro.__volquantMacro ?? new Map();
gMacro.__volquantMacro = macroCache;

async function cached<T>(key: string, maxAgeMs: number, fn: () => Promise<T>): Promise<T> {
  if (bustNext) {
    bustNext = false;
    macroCache.delete(key);
  }
  const hit = macroCache.get(key);
  if (hit && Date.now() - hit.ts < maxAgeMs) return hit.v as T;
  const v = await fn();
  macroCache.set(key, { v, ts: Date.now() });
  return v;
}

let bustNext = false;
/** Debug/dev escape hatch: ?refresh=1 busts the next macro cache read. */
export function bustMacroCache() {
  bustNext = true;
}

/** Parse a Farside ETF flow table: ticker header row + data rows (negatives in parens). */
function parseFarside(html: string): { dates: string[]; funds: string[]; rows: Map<string, (number | null)[]> } {
  const funds: string[] = [];
  const dates: string[] = [];
  const rows = new Map<string, (number | null)[]>();

  // fund names: the th row whose cells are pure tickers (IBIT, FBTC, …)
  const trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  for (const tr of trs) {
    const ths = (tr.match(/<th[\s\S]*?<\/th>/g) ?? []).map((th) => th.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    const tickerCells = ths.filter((t) => /^[A-Z]{3,6}$/.test(t) && t !== 'OI' && t !== 'USD' && t !== 'TOTAL');
    if (tickerCells.length >= 4) {
      funds.push(...tickerCells);
      break;
    }
  }

  const num = (raw: string): number | null => {
    const s = raw.replace(/&nbsp;/g, ' ').trim();
    if (!s || s === '-') return null;
    const neg = /^\(.*\)$/.test(s);
    const v = parseFloat(s.replace(/[(),\s]/g, ''));
    if (!Number.isFinite(v)) return null;
    return neg ? -v : v;
  };

  for (const tr of trs) {
    const tds = (tr.match(/<td[\s\S]*?<\/td>/g) ?? []).map((td) => td.replace(/<[^>]+>/g, '').trim());
    if (!tds.length) continue;
    const date = tds[0];
    if (!/^\d{1,2} \w{3} \d{4}$/.test(date)) continue;
    const vals = tds.slice(1).map(num);
    rows.set(date, vals);
    dates.push(date);
  }
  return { dates, funds, rows };
}

const MONTHS3: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const isoOf = (d: string) => {
  const m = /^(\d{1,2}) (\w{3}) (\d{4})$/.exec(d);
  if (!m) return null;
  const y = +m[3];
  const mo = MONTHS3[m[2]];
  if (mo === undefined) return null;
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
};

export async function etfFlows(asset: 'BTC' | 'ETH'): Promise<MacroEtf> {
  return cached<MacroEtf>(`etf:${asset}`, 30 * 60_000, async () => {
    const html = await getText(`https://farside.co.uk/${asset.toLowerCase()}/`);
    const { dates, funds, rows } = parseFarside(html);
    // Farside lists rows ascending; collect per-fund cumulatives + daily series
    const ordered = dates.slice().sort((a, b) => (isoOf(a) ?? '') < (isoOf(b) ?? '') ? -1 : 1);
    const cum = new Map<string, number>();
    const series: { date: string; totalUsd: number }[] = [];
    const dailyTotals = new Map<string, number>();
    for (const d of ordered) {
      const vals = rows.get(d) ?? [];
      const total = vals.length ? (vals[vals.length - 1] ?? 0) : 0; // last column = Total
      const iso = isoOf(d);
      if (!iso) continue;
      dailyTotals.set(iso, total);
      series.push({ date: iso, totalUsd: total });
      for (let i = 0; i < funds.length && i < vals.length - 1; i++) {
        const v = vals[i] ?? 0;
        cum.set(funds[i], (cum.get(funds[i]) ?? 0) + v);
      }
    }
    const latestDate = series.at(-1)?.date ?? null;
    const latestRaw = latestDate ? ordered.filter((d) => isoOf(d) === latestDate).at(-1) : undefined;
    const latestVals = latestRaw ? (rows.get(latestRaw) ?? []) : [];
    const fundsOut = funds.map((f, i) => ({
      fund: FUNDS[f] ?? f,
      ticker: f,
      dailyUsd: (latestVals[i] ?? 0) * 1e6,
      cumUsd: (cum.get(f) ?? 0) * 1e6,
    }));
    const totalDaily = latestDate ? (dailyTotals.get(latestDate) ?? 0) * 1e6 : null;
    const totalCum = series.reduce((s, p) => s + p.totalUsd, 0) * 1e6;
    return {
      asset,
      asOf: Date.now(),
      latestDate,
      funds: fundsOut,
      totalDailyUsd: totalDaily,
      totalCumUsd: totalCum,
      series: series.slice(-120),
      source: 'farside.co.uk daily US spot-ETF creations/redemptions (USD millions)',
    };
  });
}

// ── COT (CFTC Socrata) ───────────────────────────────────────────────────────

interface CotRow {
  market_and_exchange_names: string;
  report_date_as_yyyy_mm_dd: string;
  open_interest_all: string;
  noncomm_positions_long_all: string;
  noncomm_positions_short_all: string;
  comm_positions_long_all: string;
  comm_positions_short_all: string;
  nonrept_positions_long_all?: string;
  nonrept_positions_sho?: string;
  nonrept_positions_short_all?: string;
}

export async function cot(market: 'BITCOIN' | 'ETHER' | 'MICRO BITCOIN' = 'BITCOIN'): Promise<MacroCot> {
  return cached<MacroCot>(`cot:${market}`, 6 * 3600_000, async () => {
    const base = `https://publicreporting.cftc.gov/resource/6dca-aqww.json?contract_market_name=${encodeURIComponent(market)}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=160`;
    const rows = await getJson<CotRow[]>(base);
    if (!rows.length) throw new Error(`no COT rows for ${market}`);
    const hist = rows
      .slice()
      .reverse()
      .map((r) => ({
        date: r.report_date_as_yyyy_mm_dd.slice(0, 10),
        nonCommNet: +r.noncomm_positions_long_all - +r.noncomm_positions_short_all,
        oi: +r.open_interest_all,
      }));
    const latest = rows[0];
    return {
      market: latest.market_and_exchange_names,
      reportDate: latest.report_date_as_yyyy_mm_dd.slice(0, 10),
      oi: +latest.open_interest_all,
      nonCommLong: +latest.noncomm_positions_long_all,
      nonCommShort: +latest.noncomm_positions_short_all,
      nonCommNet: +latest.noncomm_positions_long_all - +latest.noncomm_positions_short_all,
      commLong: +latest.comm_positions_long_all,
      commShort: +latest.comm_positions_short_all,
      commNet: +latest.comm_positions_long_all - +latest.comm_positions_short_all,
      nonReptNet: +(latest.nonrept_positions_long_all ?? 0) - +(latest.nonrept_positions_short_all ?? 0),
      hist,
    };
  });
}

export async function cotMarkets(): Promise<{ market: string; latest: string; oi: number }[]> {
  return cached('cot:markets', 6 * 3600_000, async () => {
    const rows = await getJson<CotRow[]>(
      'https://publicreporting.cftc.gov/resource/6dca-aqww.json?$order=report_date_as_yyyy_mm_dd%20DESC&$limit=400',
    );
    const seen = new Set<string>();
    const out: { market: string; latest: string; oi: number }[] = [];
    for (const r of rows) {
      if (seen.has(r.market_and_exchange_names)) continue;
      seen.add(r.market_and_exchange_names);
      out.push({ market: r.market_and_exchange_names, latest: r.report_date_as_yyyy_mm_dd.slice(0, 10), oi: +r.open_interest_all });
      if (out.length >= 40) break;
    }
    return out;
  });
}

// ── SEC filings (EDGAR) ──────────────────────────────────────────────────────

const CIKS: Record<string, string> = { COIN: '0001679788', HOOD: '0001783879', MSTR: '0001050446' };

interface SubmissionRecent {
  form: string[];
  filingDate: string[];
  accessionNumber: string[];
  primaryDocument: string[];
}

/** Form 4 insider transactions at COIN/HOOD/MSTR. */
export async function form4(ticker: keyof typeof CIKS = 'COIN'): Promise<MacroFiling> {
  return cached<MacroFiling>(`form4:${ticker}`, 3600_000, async () => {
    const cik = CIKS[ticker];
    const sub = await getJson<{ filings: { recent: SubmissionRecent } }>(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const rec = sub.filings.recent;
    const idxs: number[] = [];
    for (let i = 0; i < rec.form.length && idxs.length < 12; i++) {
      if (rec.form[i] === '4') idxs.push(i);
    }
    const items: Record<string, unknown>[] = [];
    for (const i of idxs) {
      const acc = rec.accessionNumber[i].replace(/-/g, '');
      // strip the XSL view prefix — the RAW Form-4 XML is primary_doc.xml
      const doc = rec.primaryDocument[i].replace(/^xsl[^/]+\//i, '');
      const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${acc}/${doc}`;
      try {
        const xml = await getText(url);
        const owner = /<ownerName>([^<]+)<\/ownerName>/.exec(xml)?.[1] ?? 'unknown';
        const isOfficer = /<officerTitle>([^<]+)<\/officerTitle>/.exec(xml)?.[1] ?? '';
        const txShares = /<transactionShares>[\s\S]*?<value>([\d.]+)<\/value>/.exec(xml)?.[1] ?? '0';
        const txPrice = /<transactionPricePerShare>[\s\S]*?<value>([\d.]+)<\/value>/.exec(xml)?.[1] ?? '0';
        const code = /<transactionAcquiredDisposedCode>[\s\S]*?<value>([AD])<\/value>/.exec(xml)?.[1] ?? '';
        items.push({
          filingDate: rec.filingDate[i],
          owner,
          role: isOfficer || 'director/other',
          shares: +txShares,
          price: +txPrice,
          action: code === 'A' ? 'acquire' : 'dispose',
          valueUsd: +txShares * +txPrice,
          url,
        });
      } catch {
        items.push({ filingDate: rec.filingDate[i], owner: '(document unavailable)', url });
      }
    }
    return { kind: 'form4', ticker, asOf: Date.now(), items, source: 'SEC EDGAR Form 4 (data.sec.gov)' };
  });
}

/** 13F holders of a ticker via EDGAR full-text search + infotable parse. */
export async function holders13f(ticker: string = 'MSTR'): Promise<MacroFiling> {
  return cached<MacroFiling>(`holders13f:${ticker}`, 6 * 3600_000, async () => {
    const q = encodeURIComponent(`"${ticker === 'IBIT' ? 'iShares Bitcoin Trust' : ticker === 'MSTR' ? 'MicroStrategy' : ticker === 'COIN' ? 'Coinbase Global' : ticker}"`);
    const fts = await getJson<{ hits: { hits: { _source: { ciks?: string[]; cik?: string; display_names: string[]; file_date: string; file_type: string }; _id: string }[] } }>(
      `https://efts.sec.gov/LATEST/search-index?q=${q}&forms=13F-HR&dateRange=custom&startdt=2026-08-01&enddt=2026-11-08`,
    );
    const hits = fts.hits?.hits ?? [];
    if (!hits.length) throw new Error('no 13F filings found in window');
    const items: Record<string, unknown>[] = [];
    for (const h of hits.slice(0, 5)) {
      await new Promise((r) => setTimeout(r, 900)); // SEC rate-limit courtesy spacing
      const cikRaw = h._source.ciks?.[0] ?? h._source.cik ?? h._id.split('-')[0];
      const cik = String(cikRaw).padStart(10, '0');
      const name = h._source.display_names?.[0]?.replace(/\s*\(CIK.*\)/, '') ?? `CIK ${cik}`;
      // recent submissions to find the 13F accession
      try {
        const sub = await getJson<{ filings: { recent: SubmissionRecent } }>(`https://data.sec.gov/submissions/CIK${cik}.json`);
        const rec = sub.filings.recent;
        let acc: string | null = null;
        let doc: string | null = null;
        for (let i = 0; i < rec.form.length; i++) {
          if (rec.form[i] === '13F-HR') {
            acc = rec.accessionNumber[i].replace(/-/g, '');
            doc = rec.primaryDocument[i];
            break;
          }
        }
        if (!acc) continue;
        const idxUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${acc}/`;
        const idxJson = await getJson<{ directory: { item: { name: string }[] } }>(`${idxUrl}index.json`);
        const infoTable = idxJson.directory.item.find((f) => /infotable|form13f/i.test(f.name) && /\.xml$/i.test(f.name));
        if (!infoTable) continue;
        const xml = await getText(`${idxUrl}${infoTable.name}`);
        const entries = xml.match(/<infoTable>[\s\S]*?<\/infoTable>/g) ?? [];
        let found: Record<string, unknown> | null = null;
        for (const e of entries) {
          const issuer = /<nameOfIssuer>([^<]+)<\/nameOfIssuer>/.exec(e)?.[1] ?? '';
          const il = issuer.toLowerCase();
          const needle = ticker === 'IBIT' ? 'bitcoin' : ticker === 'COIN' ? 'coinbase' : ticker.toLowerCase();
          if (il.includes(needle) || (ticker === 'MSTR' && /^(micro)?strategy(\s|,|$|inc)/i.test(il)) || (ticker === 'IBIT' && /bitcoin/i.test(il))) {
            found = {
              holder: name,
              filingDate: h._source.file_date,
              issuer,
              valueUsd: (+(/<value>([\d.]+)<\/value>/.exec(e)?.[1] ?? 0)) * 1000,
              shares: +(/<sshPrnamt>([\d.]+)<\/sshPrnamt>/.exec(e)?.[1] ?? 0),
              putCall: /<putCall>([^<]+)<\/putCall>/.exec(e)?.[1] ?? '',
            };
            break;
          }
        }
        if (found) items.push(found);
      } catch (e) {
        console.error('[volquant/macro] 13f holder skipped:', name, cik, e instanceof Error ? e.message : String(e));
      }
    }
    return { kind: 'holders13f', ticker, asOf: Date.now(), items, source: 'SEC EDGAR 13F-HR infotables (efts full-text search)' };
  });
}

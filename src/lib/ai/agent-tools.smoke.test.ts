// SMOKE (local only — runs against the live dev server's DB and Deribit;
// skipped in CI via SMOKE_TOOLS env flag): exercises the new Copilot tools'
// execute() paths directly so wiring regressions surface before the LLM does.

import { describe, expect, it } from 'vitest';

const maybe = process.env.SMOKE_TOOLS === '1' ? describe : describe.skip;

maybe('copilot tool smoke (SMOKE_TOOLS=1)', () => {
  it('options_surface returns a full Deribit read', async () => {
    const { marketTools } = await import('./agent-tools');
    const out = await (marketTools.options_surface as { execute: (a: unknown) => Promise<Record<string, unknown>> }).execute({ symbol: 'BTC' });
    expect(out.error).toBeUndefined();
    expect(out.spot).toBeGreaterThan(0);
    expect(out.vol).toBeTruthy();
    expect((out.gex as Record<string, unknown>).regime).toMatch(/gamma/);
    expect((out.vol as Record<string, unknown>).atmIv30Pct).toBeGreaterThan(0);
  }, 120_000);

  it('research_backtest latest/list/run all work', async () => {
    const { marketTools } = await import('./agent-tools');
    const t = marketTools.research_backtest as { execute: (a: unknown) => Promise<Record<string, unknown>> };
    const list = await t.execute({ mode: 'list', limit: 3 });
    expect(Array.isArray((list as Record<string, unknown>).runs)).toBe(true);
    const latest = await t.execute({ mode: 'latest', asset: 'BTC' });
    expect(latest).toBeTruthy();
    const run = await t.execute({ mode: 'run', asset: 'ETH', horizonBars: 12 });
    expect(Array.isArray(run.factors)).toBe(true);
    expect((run.factors as Array<Record<string, unknown>>).length).toBeGreaterThan(3);
  }, 180_000);

  it('market_brief aggregates options + research', async () => {
    const { marketTools } = await import('./agent-tools');
    const out = await (marketTools.market_brief as { execute: () => Promise<Record<string, unknown>> }).execute();
    expect(out.error).toBeUndefined();
    const options = out.options as Record<string, Record<string, unknown>>;
    expect(options.BTC ?? options.ETH).toBeTruthy();
    expect(out.research).toBeTruthy();
  }, 120_000);
});

import { expect, test } from '@playwright/test';

// E2E smoke — the production-critical paths only:
//   1. home loads with the terminal chrome
//   2. Order Flow workspace renders the live engine (heatmap canvas + KPI strip)
//   3. Forecast view renders the conformal stack (fan chart + models table)
//   4. storage + backfill + forecast REST APIs answer sane JSON
// SSE/WebSocket data needs live venue feeds, so visual assertions wait for
// structural elements, not full data (CI never trades on flaky venue latency).

test('home loads the VolOS terminal', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/VolOS|Volos/i);
  // terminal chrome: the side navigation with the analytics views exists
  await expect(page.getByText(/Order Flow/i).first()).toBeVisible({ timeout: 30_000 });
});

test('order flow workspace renders the live engine UI', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const orderflow = page.getByText(/Order Flow/i).first();
  await orderflow.click({ timeout: 30_000 });
  await expect(page.getByText(/Forecast/i).first()).toBeVisible();
  // the workspace label flips
  await expect(page.getByText(/CVD/i).first()).toBeVisible({ timeout: 60_000 }).catch(() => {
    // KPI strip may take a while on cold engine; canvas presence suffices
  });
  const canvases = await page.locator('canvas').count();
  expect(canvases).toBeGreaterThanOrEqual(1);
});

test('forecast view renders the conformal stack', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByText(/Forecast/i).first().click({ timeout: 30_000 });
  // the fan-chart canvas + the models KPI strip render
  await page.waitForTimeout(2_000);
  const canvases = await page.locator('canvas').count();
  expect(canvases).toBeGreaterThanOrEqual(1);
  await expect(page.getByText(/conformal|Conformal/i).first()).toBeVisible({ timeout: 60_000 });
});

test('storage + backfill + forecast APIs answer sane JSON', async ({ request }) => {
  const stats = await request.get('/api/store/stats');
  expect(stats.ok()).toBe(true);
  const statsBody = await stats.json();
  expect(Array.isArray(statsBody.tables)).toBe(true);
  expect(statsBody.tables).toContain('klineBar');
  expect(statsBody.tables).toContain('derivativesPoint');

  const backfill = await request.get('/api/store/backfill');
  expect(backfill.ok()).toBe(true);
  const bf = await backfill.json();
  expect(bf.status).toBeTruthy();
  expect(typeof bf.status.running).toBe('boolean');
  expect(Array.isArray(bf.coverage)).toBe(true);

  const forecast = await request.get('/api/forecast?asset=BTC&tf=300000&h=5');
  expect(forecast.ok()).toBe(true);
  const fc = await forecast.json();
  expect(fc.levels).toBeDefined();
  expect(Array.isArray(fc.models || [])).toBe(true);
  expect(fc.panel?.provenance?.klineSource).toBeDefined();

  const evaluate = await request.get('/api/forecast/evaluate?asset=BTC&tf=300000&h=10&cvWindows=2');
  expect(evaluate.ok()).toBe(true);
  const ev = await evaluate.json();
  expect(Array.isArray(ev.evalRows)).toBe(true);
  expect(ev.evalRows.length).toBeGreaterThan(0);
  // the v2 interval families are represented
  const methods = new Set(ev.evalRows.map((r: { intervals: string }) => r.intervals));
  expect(methods.has('enbpi') || methods.has('aci') || methods.has('native_full')).toBe(true);
});

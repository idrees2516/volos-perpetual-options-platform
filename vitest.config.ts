import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// Unit tests for the pure analytics core: conformal intervals, statistics,
// backfill planning, and the flow-bar folding engine. No DB / network —
// engine tests drive OrderFlowEngine directly with synthetic trades.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/lib/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});

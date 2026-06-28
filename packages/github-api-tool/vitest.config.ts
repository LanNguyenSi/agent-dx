import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.vitest-cache',
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Thresholds ratcheted to actuals measured 2026-06-28 after adding
      // command-handler tests (74 tests, gaps 1+2 closed). Set 1-2 pp below
      // measured values so the gate holds without immediately failing.
      // Measured: statements 79.89 / branches 60.77 / functions 86.11 / lines 82.9
      thresholds: {
        statements: 79,
        branches: 60,
        functions: 85,
        lines: 82,
      },
    },
  },
});

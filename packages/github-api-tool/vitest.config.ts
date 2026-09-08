import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".vitest-cache",
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      // Thresholds ratcheted to actuals measured 2026-06-28 after adding
      // command-handler tests (74 tests, gaps 1+2 closed). Set 1-2 pp below
      // measured values so the gate holds without immediately failing.
      // Measured 2026-06-28: statements 79.89 / branches 60.77 / functions
      // 86.11 / lines 82.9; re-measured 2026-09-08 after the prettier
      // reformat: lines 81.56 (292/358). The same 74 tests cover one more
      // line, but re-wrapping raised the physical line count (351 to 358),
      // so only the lines value moved, with no behaviour change; lines
      // re-pinned under the same 1-2 pp rule, the other three floors kept.
      thresholds: {
        statements: 79,
        branches: 60,
        functions: 85,
        lines: 81,
      },
    },
  },
});

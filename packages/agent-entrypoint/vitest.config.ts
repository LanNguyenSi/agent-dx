import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      // src/index.ts is the commander CLI wrapper; meaningful coverage
      // there needs a buildProgram-factory refactor like release-prep
      // got (filed as a follow-up). lib.ts holds the testable logic.
      exclude: ["src/index.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});

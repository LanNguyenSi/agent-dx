import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      // Scope coverage strictly to source. CI builds before running
      // tests, so without an explicit include the report counts dist/
      // compiled output too. src/index.ts is the commander CLI wrapper;
      // meaningful coverage there needs a buildProgram-factory refactor
      // like release-prep got (filed as a follow-up).
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/**/*.test.ts", "src/**/__tests__/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});

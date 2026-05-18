import { defineConfig } from "vitest/config";

// Vitest v4 discovers compiled tests in dist/ if a previous build emitted
// them; we exclude dist explicitly to keep test discovery scoped to source.
// tsconfig.json also excludes *.test.ts from the build so this is defensive.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite spawns the built CLI from dist/ as a child process, so
    // dist/ and any future fixture trees under test/fixtures/ must never
    // be picked up as this package's own test files.
    exclude: ["**/node_modules/**", "dist/**", "test/fixtures/**"],
  },
});

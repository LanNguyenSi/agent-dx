import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Later tasks add fixture projects under test/fixtures/ that carry
    // deliberately failing tests (used to exercise the verify runner's
    // detectors against real tool output). Excluding them here keeps
    // those fixtures from ever being picked up as this package's own
    // suite.
    exclude: ["**/node_modules/**", "test/fixtures/**"],
  },
});

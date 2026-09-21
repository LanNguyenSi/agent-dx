import { describe, expect, it } from "vitest";
import { runNodeWithTz } from "./helpers.js";

describe("test helpers: runNodeWithTz", () => {
  it("the child process resolves the TZ it was given (positive control for every cross-timezone CLI test)", () => {
    const script = "Intl.DateTimeFormat().resolvedOptions().timeZone";
    for (const tz of ["UTC", "Asia/Tokyo"]) {
      const result = runNodeWithTz(["-p", script], tz);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(tz);
    }
  });
});

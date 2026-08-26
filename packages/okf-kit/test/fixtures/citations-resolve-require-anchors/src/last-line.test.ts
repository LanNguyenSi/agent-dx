import { describe, expect, it } from "vitest";

describe("whole", () => {
  it("keeps its own last content line", () => {
    const value = 1;
    expect(value).toBe(1);
  });
});

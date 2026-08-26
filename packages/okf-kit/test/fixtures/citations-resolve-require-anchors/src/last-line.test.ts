import { describe, expect, it } from "vitest";

describe("whole", () => {
  it("keeps its own last content line", () => {
    const value = 1;
    expect(value).toBe(1);
  });
});

describe("comment end", () => {
  it("ends with a comment line", () => {
    const marker = 2;
    expect(marker).toBe(2);
    // trailing note
  });
});

import { describe, it, expect } from "vitest";

describe("sample", () => {
  it("adds", () => {
    expect(1 + 1).toBe(2);
  });
  it("is wrong", () => {
    expect(1 + 1).toBe(3);
  });
});

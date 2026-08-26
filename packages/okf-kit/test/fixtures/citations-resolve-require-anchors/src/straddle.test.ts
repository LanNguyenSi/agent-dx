import { describe, expect, it } from "vitest";

describe("outer", () => {
  it("a", () => {
    expect(1).toBe(1);
  });

  it("b", () => {
    expect(2).toBe(2);
  });
});

describe("plain", () => {
  console.log("prelude for plain");
  it("checks something", () => {
    expect(true).toBe(true);
  });
});

it("solo", () => {
  console.log("prelude for solo");
  expect(true).toBe(true);
});

describe("group", () => {
  it("one", () => {
    expect(1).toBe(1);
  });

  it("two", () => {
    expect(2).toBe(2);
  });
});

import { describe, it, expect } from "vitest";
import { escapeRegExp, splitCommand, truncate } from "../src/util.js";

describe("splitCommand", () => {
  it("splits a multi-word command into argv", () => {
    expect(splitCommand("node /abs/cli.js")).toEqual(["node", "/abs/cli.js"]);
  });
  it("trims and collapses surrounding whitespace", () => {
    expect(splitCommand("  opensrc   ")).toEqual(["opensrc"]);
  });
  it("throws on an empty command", () => {
    expect(() => splitCommand("   ")).toThrow();
  });
});

describe("escapeRegExp", () => {
  it("escapes regex metacharacters so the value matches literally", () => {
    const re = new RegExp(escapeRegExp("a.b*c"));
    expect(re.test("a.b*c")).toBe(true);
    expect(re.test("axbxxc")).toBe(false);
  });
});

describe("truncate", () => {
  it("leaves short strings untouched", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });
  it("truncates long strings with an ellipsis", () => {
    expect(truncate("abcdefghij", 8)).toBe("abcde...");
  });
});

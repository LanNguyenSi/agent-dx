import { describe, expect, it } from "vitest";
import { compilePassRegex } from "../src/pass-regex.js";

/**
 * `compilePassRegex` (GitHub issue #225): the
 * one compile both `cli.ts`'s `parsePassRegex` and `probe/plan.ts`'s
 * `validatePlan` use for `--pass-regex`/`passWhen.regex`. The `m` flag
 * it always applies is what lets `^OK \(` match a summary line that is
 * not the very first line of a runner's combined output (phpunit's own
 * version banner ahead of a green suite's summary, the motivating
 * shape) -- without it, `^`/`$` anchor to the whole buffer, not each
 * line, and a header-carrying runner's baseline reads `baseline_failed`
 * despite being green.
 */
describe("compilePassRegex()", () => {
  it("always compiles with exactly the m flag", () => {
    expect(compilePassRegex("^OK \\(").flags).toBe("m");
  });

  it("preserves the source pattern unchanged", () => {
    expect(compilePassRegex("^OK \\(").source).toBe("^OK \\(");
  });

  it("m lets ^ match a line other than the buffer's first, unlike a flagless compile", () => {
    const buffer =
      "PHPUnit 9.6.13 by Sebastian Bergmann and contributors.\nOK (3 tests, 5 assertions)\n";
    expect(compilePassRegex("^OK \\(").test(buffer)).toBe(true);
    expect(new RegExp("^OK \\(").test(buffer)).toBe(false);
  });

  it("an unparseable pattern throws the same SyntaxError new RegExp(...) would", () => {
    expect(() => compilePassRegex("(")).toThrow(SyntaxError);
  });

  // `(?m)` is not "redundant, not a usage
  // error" the way the README once claimed -- JS `RegExp` has no
  // inline-flag syntax at all, so `(?m)` is not valid source and is
  // rejected exactly like any other unparseable pattern, `m` already
  // being always-on notwithstanding.
  it("(?m) is not valid JS RegExp source and throws a usage error, the m flag already being always-on notwithstanding", () => {
    expect(() => compilePassRegex("(?m)^OK")).toThrow(SyntaxError);
  });
});

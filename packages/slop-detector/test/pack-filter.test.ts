import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPath } from "../src/engine.js";
import { defaultConfig } from "../src/config.js";
import {
  allPacks,
  packsByFilter,
  UnknownPackError,
} from "../src/packs/registry.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-packfilter-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("--pack filter enables off-by-default packs", () => {
  it("`--pack code-slop` runs the rule even when config has comment-slop and code-slop off", () => {
    // A file with a clear code-slop hit: async function with no await and no
    // Promise<T> return type.
    fs.writeFileSync(
      path.join(tmp, "x.ts"),
      `async function f() { return 42; }\n`,
    );

    const config = defaultConfig();
    expect(config.packs["code-slop"]).toBe(false); // sanity: still off-by-default.

    const summary = checkPath(tmp, {
      packs: allPacks,
      config,
      packFilter: ["code-slop"],
    });
    expect(summary.violations.length).toBeGreaterThan(0);
    expect(summary.violations.every((v) => v.pack === "code-slop")).toBe(true);
  });

  it("without --pack, off-by-default packs stay silent on the same file", () => {
    fs.writeFileSync(
      path.join(tmp, "x.ts"),
      `async function f() { return 42; }\n`,
    );
    const summary = checkPath(tmp, {
      packs: allPacks,
      config: defaultConfig(),
    });
    expect(
      summary.violations.filter((v) => v.pack === "code-slop"),
    ).toHaveLength(0);
  });

  it("`--pack agent-tics` does not enable off-by-default rules within an enabled pack", () => {
    // agent-tics/coauthored-by-claude is enabledByDefault: false. --pack
    // selects the pack but per-rule enabledByDefault still gates.
    fs.writeFileSync(
      path.join(tmp, "msg.md"),
      `feat: thing\n\nCo-Authored-By: Claude <noreply@example.com>\n`,
    );
    const summary = checkPath(tmp, {
      packs: allPacks,
      config: defaultConfig(),
      packFilter: ["agent-tics"],
    });
    expect(
      summary.violations.some(
        (v) => v.ruleId === "agent-tics/coauthored-by-claude",
      ),
    ).toBe(false);
  });
});

describe("packsByFilter rejects unknown pack ids", () => {
  it("throws naming every unknown id and listing the registry's packs", () => {
    let err: unknown;
    try {
      packsByFilter(["prose-slop", "ui-slp", "nope"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnknownPackError);
    const msg = (err as Error).message;
    expect(msg).toContain('"ui-slp"');
    expect(msg).toContain('"nope"');
    for (const p of allPacks) expect(msg).toContain(p.id);
    expect(msg).not.toContain('"prose-slop"');
  });

  it("still resolves known ids and the empty filter", () => {
    expect(packsByFilter(["prose-slop"]).map((p) => p.id)).toEqual([
      "prose-slop",
    ]);
    expect(packsByFilter([])).toBe(allPacks);
    expect(packsByFilter(undefined)).toBe(allPacks);
  });
});

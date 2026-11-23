import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RULES, lintSpecDir, type LintOptions } from "../../src/lint/index.js";
import { FIXTURES } from "./helpers.js";

interface Expected {
  options?: LintOptions;
  errors: Record<string, unknown>[];
  warnings: Record<string, unknown>[];
  acked: Record<string, unknown>[];
}

/** The listed keys of each actual finding, so an expected entry names only what it pins. */
function pick(
  actual: readonly object[],
  expected: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return actual.map((finding, i) => {
    const keys = Object.keys(expected[i] ?? finding);
    const record = finding as Record<string, unknown>;
    return Object.fromEntries(keys.map((k) => [k, record[k]]));
  });
}

function runFixture(dir: string) {
  const expected = JSON.parse(
    fs.readFileSync(path.join(dir, "expected.json"), "utf8"),
  ) as Expected;
  const result = lintSpecDir(path.join(dir, "spec"), expected.options ?? {});
  if (!result.ok) throw new Error(result.message);
  const { report } = result;
  expect(pick(report.errors, expected.errors)).toEqual(expected.errors);
  expect(pick(report.warnings, expected.warnings)).toEqual(expected.warnings);
  expect(pick(report.acked, expected.acked)).toEqual(expected.acked);
  return { report, expected };
}

describe("lint fixtures", () => {
  it("every registered rule has a positive and a negative fixture", () => {
    for (const rule of RULES) {
      for (const kind of ["pos", "neg"]) {
        const dir = path.join(FIXTURES, `lint-${rule.id}`, kind);
        expect(
          fs.statSync(path.join(dir, "spec", "spec.md")).isFile(),
          `${rule.id} ${kind} spec.md`,
        ).toBe(true);
        expect(
          fs.statSync(path.join(dir, "spec")).isDirectory(),
          `${rule.id} ${kind} spec dir`,
        ).toBe(true);
        expect(
          fs.statSync(path.join(dir, "expected.json")).isFile(),
          `${rule.id} ${kind} expected`,
        ).toBe(true);
      }
    }
  });

  it("no fixture directory names a rule that is not registered", () => {
    const ids = new Set(RULES.map((r) => `lint-${r.id}`));
    for (const name of fs.readdirSync(FIXTURES)) {
      if (!name.startsWith("lint-") || name === "lint-valid") continue;
      expect(ids.has(name), name).toBe(true);
    }
  });

  for (const rule of RULES) {
    it(`${rule.id}: the positive fixture raises no finding of the rule`, () => {
      const dir = path.join(FIXTURES, `lint-${rule.id}`, "pos");
      const { report } = runFixture(dir);
      const ofRule = [...report.errors, ...report.warnings].filter(
        (f) => f.rule === rule.id,
      );
      expect(ofRule).toEqual([]);
    });

    it(`${rule.id}: the negative fixture raises a finding of the rule`, () => {
      const dir = path.join(FIXTURES, `lint-${rule.id}`, "neg");
      const { report, expected } = runFixture(dir);
      const all = [...report.errors, ...report.warnings];
      expect(all.map((f) => f.rule)).toContain(rule.id);
      expect(expected.errors.length + expected.warnings.length).toBeGreaterThan(
        0,
      );
      for (const f of all.filter((x) => x.rule === rule.id)) {
        expect(f.level).toBe(rule.level);
        // an ack matches on the id, so an ackable rule must always name one
        if (rule.ackable) expect(f.id, `${rule.id} finding id`).toBeDefined();
      }
    });
  }

  it("the minimal valid spec directory passes the full profile with no finding", () => {
    const dir = path.join(FIXTURES, "lint-valid", "pos");
    const { report } = runFixture(dir);
    expect(report.ok).toBe(true);
    expect(report.profile).toBe("full");
    expect(report.counts).toEqual({ errors: 0, warnings: 0, acked: 0 });
  });
});

/**
 * `suggested_tests` of the `ow` briefing over a test plan with a row of
 * every kind: each field a row carries reaches the briefing with its
 * value, and the fields come in the one documented key order. The order
 * is written out here a second time on purpose, so the list in the
 * exporter cannot lose or move a field unnoticed.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  parseBindings,
  parseSpec,
  parseTestPlan,
  type TestPlanRow,
} from "../../src/formats/index.js";
import { buildOwExport } from "../../src/exporters/ow.js";
import { FIXTURES as ALL_FIXTURES } from "../lint/helpers.js";
import { SPEC_REL, fixtureText } from "./repo.js";

/** The key order of a `suggested_tests` object, as `docs/export.md` lists it. */
const KEY_ORDER = [
  "id",
  "covers",
  "kind",
  "claim",
  "input",
  "expected",
  "oracle",
  "level",
  "seam",
  "red_reason",
  "fail_match",
  "baseline",
  "threshold",
  "runs",
  "check_command_ref",
  "verifier",
  "evidence_location",
  "check",
  "environment",
  "steps",
  "control",
  "method",
  "probe_hint",
  "notes",
];

function parsed<T>(
  result: { ok: true; value: T } | { ok: false; errors: unknown },
): T {
  if (!result.ok) {
    throw new Error(`fixture does not parse: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/** A test plan with one row of every kind (the digest suite's fixture). */
const EVERY_KIND = parsed(
  parseTestPlan(
    fs.readFileSync(
      path.join(ALL_FIXTURES, "golden-digest", "base", "testplan.yaml"),
      "utf8",
    ),
  ),
);

function suggestedTests(): Record<string, unknown>[] {
  const text = buildOwExport(
    {
      spec: parsed(parseSpec(fixtureText("spec.md"))),
      testPlan: EVERY_KIND,
      bindings: parsed(parseBindings(fixtureText("bindings.yaml"))),
      toplevel: "/repo",
      commit: "0".repeat(40),
      specRel: SPEC_REL,
    },
    "sha256:test",
  );
  const doc = parse(text) as { suggested_tests: Record<string, unknown>[] };
  return doc.suggested_tests;
}

/** The fields a parsed row carries, without the absent ones. */
function carried(row: TestPlanRow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== undefined),
  );
}

describe("suggested_tests of the ow briefing", () => {
  it("uses a test plan that carries every row field", () => {
    const seen = new Set(
      EVERY_KIND.flatMap((row) => Object.keys(carried(row))),
    );
    expect([...seen].sort()).toEqual([...KEY_ORDER].sort());
    expect(KEY_ORDER).toHaveLength(24);
  });

  it("prints every field of every row with its value", () => {
    const rows = suggestedTests();
    expect(rows).toHaveLength(EVERY_KIND.length);
    EVERY_KIND.forEach((row, i) => {
      expect(rows[i], row.id).toEqual(carried(row));
    });
  });

  it("prints the fields of each row in the documented key order", () => {
    for (const row of suggestedTests()) {
      const keys = Object.keys(row);
      expect(keys, String(row["id"])).toEqual(
        KEY_ORDER.filter((key) => keys.includes(key)),
      );
    }
  });

  it("is listed in the same order in docs/export.md", () => {
    const docs = fs.readFileSync(
      path.join(ALL_FIXTURES, "..", "..", "docs", "export.md"),
      "utf8",
    );
    expect(docs).toContain(KEY_ORDER.map((key) => `\`${key}\``).join(", "));
  });
});

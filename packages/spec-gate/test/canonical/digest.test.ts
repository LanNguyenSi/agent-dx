import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DIGEST_FORMAT,
  DigestError,
  PLAN_FIELD_CLASSES,
  buildDigestInput,
  computeDigest,
  loadDigestParts,
  referencedCommandNames,
} from "../../src/canonical/index.js";
import type { DigestParts } from "../../src/canonical/index.js";
import {
  FIELD_LAYERS,
  parseSpec,
  parseTestPlan,
} from "../../src/formats/index.js";
import type { Spec, TestPlan } from "../../src/formats/index.js";

const base = fileURLToPath(
  new URL("../fixtures/golden-digest/base/", import.meta.url),
);

function load(): { spec: Spec; testPlan: TestPlan } {
  const spec = parseSpec(fs.readFileSync(`${base}spec.md`, "utf8"));
  const plan = parseTestPlan(fs.readFileSync(`${base}testplan.yaml`, "utf8"));
  if (!spec.ok || !plan.ok) throw new Error("fixture does not parse");
  return { spec: spec.value, testPlan: plan.value };
}

const COMMANDS = { typecheck: ["npm", "run", "typecheck"] };

function parts(over: Partial<DigestParts> = {}): DigestParts {
  return { ...load(), commands: COMMANDS, ...over };
}

type Obj = Record<string, unknown>;
const input = (p: DigestParts = parts()) => buildDigestInput(p) as Obj;
/** Whitespace at both ends and doubled inside. */
const pad = (text: string) => `  ${text.replace(/ /g, "   ")}\t `;

describe("buildDigestInput", () => {
  it("names its format and holds the frontmatter references", () => {
    const out = input();
    expect(out["format"]).toBe(DIGEST_FORMAT);
    expect(out["id"]).toBe("golden-sample");
    expect(out["base_commit"]).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(out["commands_ref"]).toBe(
      "2bec419bfd7eb7f3e546fee3ee4de72a32494e9c",
    );
    expect(out["retired_ids"]).toEqual(["AC-9", "NG-4"]);
  });

  it("holds no status, superseded_by, source, context or line number", () => {
    const text = JSON.stringify(input());
    for (const word of [
      '"status":"draft"',
      "superseded_by",
      "source/meta.json",
      "Nobody checks",
      '"line"',
      "notes",
    ]) {
      expect(text).not.toContain(word);
    }
  });

  it("sorts rows by the number of their ID, not as text", () => {
    const out = input();
    const ids = (key: string) => (out[key] as Obj[]).map((r) => r["id"]);
    expect(ids("acceptance")).toEqual(["AC-1", "AC-2", "AC-10"]);
    expect(ids("test_plan")).toEqual([
      "TP-1",
      "TP-2",
      "TP-3",
      "TP-4",
      "TP-5",
      "TP-6",
      "TP-7",
      "TP-10",
    ]);
    expect(ids("source_ledger")).toEqual([
      "SL-1",
      "SL-2",
      "SL-3",
      "SL-4",
      "SL-5",
      "SL-6",
    ]);
  });

  it("sorts retired IDs, covers, SL targets and AC sources, but keeps steps in order", () => {
    const p = parts();
    p.spec.frontmatter.retired_ids = ["NG-4", "AC-10", "AC-9"];
    p.spec.acceptance[0]!.source = ["SL-10", "SL-2"];
    p.spec.ledger[1]!.targets = ["NG-1", "AC-1"];
    p.testPlan[0]!.covers = ["AC-10", "AC-1"];
    p.testPlan[5]!.steps = ["b", "a"];
    const out = input(p);
    expect(out["retired_ids"]).toEqual(["AC-9", "AC-10", "NG-4"]);
    expect((out["acceptance"] as Obj[])[0]!["source"]).toEqual([
      "SL-2",
      "SL-10",
    ]);
    expect((out["source_ledger"] as Obj[])[1]!["targets"]).toEqual([
      "AC-1",
      "NG-1",
    ]);
    const rows = out["test_plan"] as Obj[];
    expect(rows[0]!["covers"]).toEqual(["AC-1", "AC-10"]);
    expect(rows.find((r) => r["id"] === "TP-6")!["steps"]).toEqual(["b", "a"]);
  });

  it("keeps exactly the normative fields of each test-plan row", () => {
    const { testPlan } = load();
    const rows = input()["test_plan"] as Obj[];
    for (const row of testPlan) {
      const out = rows.find((r) => r["id"] === row.id)!;
      const expected = Object.keys(row).filter(
        (f) => FIELD_LAYERS[f] === "normative",
      );
      expect(Object.keys(out).sort()).toEqual(expected.sort());
    }
    // The fixture row with `notes` shows the informative field is dropped.
    expect(testPlan.some((r) => r.notes !== undefined)).toBe(true);
  });

  it("keeps every field of every spec line except its line number", () => {
    const { spec } = load();
    const pairs: Array<[string, Obj[], Record<string, string>]> = [
      ["acceptance", spec.acceptance as unknown as Obj[], {}],
      ["non_goals", spec.nonGoals as unknown as Obj[], {}],
      ["defaults", spec.defaults as unknown as Obj[], {}],
      ["decisions", spec.decisions as unknown as Obj[], {}],
      ["residuals", spec.residuals as unknown as Obj[], {}],
      [
        "source_ledger",
        spec.ledger as unknown as Obj[],
        { sourceLine: "source_line" },
      ],
    ];
    const out = input();
    for (const [key, lines, rename] of pairs) {
      const rows = out[key] as Obj[];
      expect(rows).toHaveLength(lines.length);
      // The union of fields over all lines of the section: an optional
      // field (a question, a comment URL, a reason) is present on some.
      const parsedKeys = new Set(
        lines.flatMap((l) => Object.keys(l)).filter((k) => k !== "line"),
      );
      const outKeys = new Set(rows.flatMap((r) => Object.keys(r)));
      expect([...outKeys].sort()).toEqual(
        [...parsedKeys].map((k) => rename[k] ?? k).sort(),
      );
    }
    const goal = out["goal"] as Obj;
    expect(Object.keys(goal).sort()).toEqual(["id", "text"]);
  });

  it("writes a missing GOAL as null", () => {
    const p = parts();
    p.spec.goal = null;
    expect(input(p)["goal"]).toBeNull();
  });

  it("holds the argv of each referenced command exactly, and of no other", () => {
    const out = input(
      parts({ commands: { ...COMMANDS, lint: ["npm", "run", "lint"] } }),
    );
    expect(out["commands"]).toEqual({ typecheck: ["npm", "run", "typecheck"] });
  });

  it("holds no commands when no row refers to one", () => {
    const p = parts();
    p.testPlan = p.testPlan.filter((r) => r.check_command_ref === undefined);
    expect(input({ ...p, commands: {} })["commands"]).toEqual({});
  });

  it("fails with a named error when a referenced command has no argv", () => {
    expect(() => buildDigestInput(parts({ commands: {} }))).toThrow(
      DigestError,
    );
    try {
      buildDigestInput(parts({ commands: {} }));
    } catch (err) {
      expect((err as DigestError).code).toBe("command-ref-unknown");
    }
  });

  it("treats a command name such as constructor as unknown, not as an inherited property", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      const p = parts({ commands: {} });
      p.testPlan[3]!.check_command_ref = name;
      try {
        buildDigestInput(p);
        throw new Error("expected an error");
      } catch (err) {
        expect(err).toBeInstanceOf(DigestError);
        expect((err as DigestError).code).toBe("command-ref-unknown");
        expect((err as DigestError).message).toContain(name);
      }
    }
  });

  it("does not normalise the whitespace of argv elements", () => {
    const a = computeDigest(
      parts({ commands: { typecheck: ["echo", "a b"] } }),
    );
    const b = computeDigest(
      parts({ commands: { typecheck: ["echo", "a  b"] } }),
    );
    expect(a).not.toBe(b);
  });
});

describe("computeDigest", () => {
  it("is sha256: and 64 hex digits, and stable", () => {
    const a = computeDigest(parts());
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeDigest(parts())).toBe(a);
  });

  it("changes with the argv of a referenced command at the same commands_ref", () => {
    const a = computeDigest(parts());
    const b = computeDigest(
      parts({
        commands: { typecheck: ["npm", "run", "typecheck", "--strict"] },
      }),
    );
    const c = computeDigest(
      parts({ commands: { typecheck: ["npm", "run", "other"] } }),
    );
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("ignores commands no row refers to", () => {
    const a = computeDigest(parts());
    const b = computeDigest(
      parts({ commands: { ...COMMANDS, lint: ["x"], unit: ["y"] } }),
    );
    expect(b).toBe(a);
  });

  it("does not depend on the order of the parsed rows", () => {
    const a = computeDigest(parts());
    const p = parts();
    p.spec.acceptance.reverse();
    p.spec.ledger.reverse();
    p.testPlan.reverse();
    expect(computeDigest(p)).toBe(a);
  });

  it("normalises the whitespace of the prose fields of the spec and the plan", () => {
    const a = computeDigest(parts());
    const p = parts();
    const { spec } = p;
    spec.goal!.text = pad(spec.goal!.text);
    for (const l of spec.acceptance) l.text = pad(l.text);
    for (const l of spec.nonGoals) l.text = pad(l.text);
    for (const l of spec.defaults) {
      l.text = pad(l.text);
      l.reason = pad(l.reason);
    }
    for (const l of spec.decisions) l.text = pad(l.text);
    for (const l of spec.residuals) l.text = pad(l.text);
    for (const l of spec.ledger) {
      if (l.reason !== undefined) l.reason = pad(l.reason);
    }
    let padded = 0;
    for (const row of p.testPlan) {
      for (const [field, value] of Object.entries(row)) {
        if (PLAN_FIELD_CLASSES[field] !== "prose") continue;
        const target = row as unknown as Record<string, unknown>;
        if (typeof value === "string") {
          target[field] = pad(value);
          padded += 1;
        } else if (Array.isArray(value)) {
          target[field] = value.map((v: string) => pad(v));
          padded += 1;
        }
      }
    }
    expect(padded).toBeGreaterThan(10);
    expect(computeDigest(p)).toBe(a);
  });

  it("keeps the spec fields that are names, paths and times exactly", () => {
    const a = computeDigest(parts());
    // eslint-disable-next-line no-unused-vars
    const edits: Array<(spec: Spec) => void> = [
      (spec) => (spec.acceptance[0]!.owner = pad(spec.acceptance[0]!.owner)),
      (spec) => (spec.nonGoals[0]!.paths[1] = "src/auth/user  files/**"),
      (spec) =>
        (spec.decisions[0]!.provenance.author = pad(
          spec.decisions[0]!.provenance.author,
        )),
      (spec) =>
        (spec.decisions[0]!.provenance.time = pad(
          spec.decisions[0]!.provenance.time,
        )),
      (spec) =>
        (spec.decisions[0]!.provenance.comment_url = pad(
          spec.decisions[0]!.provenance.comment_url!,
        )),
    ];
    const seen = new Set<string>([a]);
    for (const edit of edits) {
      const p = parts();
      edit(p.spec);
      const d = computeDigest(p);
      expect(seen.has(d)).toBe(false);
      seen.add(d);
    }
  });

  it("keeps IDs exactly: a padded ID is another ID", () => {
    const a = computeDigest(parts());
    // eslint-disable-next-line no-unused-vars
    const edits: Array<(p: DigestParts) => void> = [
      (p) => (p.spec.frontmatter.retired_ids = [pad("AC-9"), "NG-4"]),
      (p) => (p.spec.acceptance[0]!.source = [pad("SL-1"), "SL-2"]),
      (p) => (p.spec.ledger[1]!.targets = [pad("AC-1"), "NG-1"]),
    ];
    const seen = new Set<string>([a]);
    for (const edit of edits) {
      const p = parts();
      edit(p);
      const d = computeDigest(p);
      expect(seen.has(d)).toBe(false);
      seen.add(d);
    }
  });

  it("classifies every normative test-plan field, and nothing else", () => {
    const normative = Object.entries(FIELD_LAYERS)
      .filter(([, layer]) => layer === "normative")
      .map(([field]) => field)
      .sort();
    expect(Object.keys(PLAN_FIELD_CLASSES).sort()).toEqual(normative);
    for (const cls of Object.values(PLAN_FIELD_CLASSES)) {
      expect(["prose", "exact"]).toContain(cls);
    }
  });

  it("keeps every exact test-plan field as the parser returns it", () => {
    const a = computeDigest(parts());
    const seen = new Set<string>([a]);
    let tried = 0;
    const base = parts().testPlan;
    base.forEach((row, index) => {
      for (const [field, value] of Object.entries(row)) {
        if (PLAN_FIELD_CLASSES[field] !== "exact") continue;
        let changed: unknown;
        if (typeof value === "string") changed = pad(value);
        else if (Array.isArray(value)) {
          changed = value.map((v: string) => pad(v));
        } else continue;
        const p = parts({
          // A padded command name must still resolve to the same argv.
          commands: { ...COMMANDS, [pad("typecheck")]: COMMANDS.typecheck },
        });
        (p.testPlan[index] as unknown as Record<string, unknown>)[field] =
          changed;
        const d = computeDigest(p);
        expect(seen.has(d), `${row.id}.${field}`).toBe(false);
        seen.add(d);
        tried += 1;
      }
    });
    // id, covers, kind, expected, fail_match, evidence_location, ... of the fixture.
    expect(tried).toBeGreaterThan(15);
  });

  it("tells inner whitespace apart in a path, a match string and a location", () => {
    const withValue = (field: string, value: string): string => {
      const p = parts();
      const row = p.testPlan.find((r) => field in r)!;
      (row as unknown as Record<string, unknown>)[field] = value;
      return computeDigest(p);
    };
    for (const field of ["fail_match", "evidence_location", "expected"]) {
      expect(withValue(field, "a b"), field).not.toBe(withValue(field, "a  b"));
    }
    const paths = (value: string): string => {
      const p = parts();
      p.spec.nonGoals[0]!.paths = [value];
      return computeDigest(p);
    };
    expect(paths("src/a b")).not.toBe(paths("src/a  b"));
    // A prose field collapses the same difference.
    expect(withValue("claim", "a b")).toBe(withValue("claim", "a  b"));
  });

  it("holds the same digest for any Unicode whitespace at the ends of an item text or an attribute value, because the spec parser trims it", () => {
    const text = fs.readFileSync(`${base}spec.md`, "utf8");
    const spaced = text
      .replace("that user ends.\n", "that user ends.\u2003\u00a0\n")
      .replace("  - owner: alice\n", "  - owner: alice\u00a0\n");
    expect(spaced).not.toBe(text);
    const original = parseSpec(text);
    const padded = parseSpec(spaced);
    if (!original.ok || !padded.ok) throw new Error("spec does not parse");
    expect(padded.value.goal!.text).toBe(original.value.goal!.text);
    expect(padded.value.acceptance[0]!.owner).toBe("alice");
    const { testPlan } = load();
    const digestOf = (spec: Spec) =>
      computeDigest({ spec, testPlan, commands: COMMANDS });
    expect(digestOf(padded.value)).toBe(digestOf(original.value));
  });

  it("does not depend on the line numbers of the parsed lines", () => {
    const a = computeDigest(parts());
    const p = parts();
    for (const l of p.spec.acceptance) l.line += 100;
    expect(computeDigest(p)).toBe(a);
  });
});

describe("referencedCommandNames", () => {
  it("lists each referenced name once, sorted", () => {
    const { testPlan } = load();
    const extra = {
      ...testPlan[3]!,
      id: "TP-20",
      check_command_ref: "lint",
    };
    const again = { ...testPlan[3]!, id: "TP-21" };
    expect(referencedCommandNames([...testPlan, extra, again])).toEqual([
      "lint",
      "typecheck",
    ]);
    expect(referencedCommandNames([])).toEqual([]);
  });
});

describe("loadDigestParts and the spec directory path", () => {
  it("refuses a spec directory that is a symlink, even to a valid spec", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-digest-"));
    try {
      const link = path.join(root, "spec-link");
      fs.symlinkSync(base, link);
      expect(() => loadDigestParts(link)).toThrowError(
        expect.objectContaining({
          code: "spec-dir-invalid",
          message: `${link} is a symlink, refusing to read it`,
        }),
      );
      const missing = path.join(root, "nope");
      expect(() => loadDigestParts(missing)).toThrowError(
        expect.objectContaining({
          code: "spec-dir-invalid",
          message: `${missing} is not a directory`,
        }),
      );
      const file = path.join(root, "file");
      fs.writeFileSync(file, "x");
      expect(() => loadDigestParts(file)).toThrowError(
        expect.objectContaining({
          code: "spec-dir-invalid",
          message: `${file} is not a directory`,
        }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

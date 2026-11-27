/**
 * The evidence rules without git and the loader's `evidence/` scan:
 * `unproven`, `self-reported`, `evidence-unknown-row`, the layout findings,
 * and the documented skip of `stale-evidence` without git inputs. The
 * git-backed causes are covered in `git-rules.test.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_FILE_RE,
  evidenceFileTpId,
} from "../../src/formats/index.js";
import { lintSpecDir, RULES, type LintReport } from "../../src/lint/index.js";
import { EVIDENCE_BINDINGS, EVIDENCE_PLAN } from "./git-helpers.js";
import { specDir } from "./helpers.js";

/** The frontmatter base_commit of the valid fixture spec. */
const BASE = "0123456789abcdef0123456789abcdef01234567";

/** The valid plan extended with a stays-green row (TP-2) and a static row. */
const PLAN_FILES = {
  "testplan.yaml": EVIDENCE_PLAN,
  "bindings.yaml": EVIDENCE_BINDINGS,
};

function run(
  overrides: Record<string, string | null> = {},
  options = {},
): LintReport {
  const result = lintSpecDir(specDir(overrides), options, RULES);
  if (!result.ok) throw new Error(result.message);
  return result.report;
}

function runDir(dir: string, options = {}): LintReport {
  const result = lintSpecDir(dir, options, RULES);
  if (!result.ok) throw new Error(result.message);
  return result.report;
}

const envelope = (over: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    schema_version: 1,
    phase: "baseline",
    producer: "host",
    time: "2000-01-31T12:00:00Z",
    commit: BASE,
    dirty: false,
    commands_digest: "a".repeat(64),
    selector: null,
    command: ["npm", "test"],
    exit: 0,
    result: "pass",
    ...over,
  })}\n`;

const cleanTp2 = envelope({ selector: "login works" });

const ofRule = (report: LintReport, rule: string) =>
  [...report.errors, ...report.warnings].filter((f) => f.rule === rule);

const skipReason = (report: LintReport, rule: string) =>
  report.skipped.find((s) => s.rule === rule)?.reason;

describe("unproven: a stays-green row needs a fresh passing baseline", () => {
  const unproven = (report: LintReport) => ofRule(report, "unproven");
  const expected = expect.objectContaining({
    level: "warning",
    file: "testplan.yaml",
    path: "TP-2.kind",
    id: "TP-2",
  });

  it("no evidence directory at all: one warning naming the row", () => {
    expect(unproven(run(PLAN_FILES))).toEqual([expected]);
  });

  it("a fresh passing baseline envelope proves the row", () => {
    expect(
      unproven(run({ ...PLAN_FILES, "evidence/TP-2.jsonl": cleanTp2 })),
    ).toEqual([]);
  });

  for (const [name, over] of [
    ["a fail envelope", { result: "fail" }],
    ["a skip envelope", { result: "skip" }],
    ["an error envelope", { result: "error" }],
    ["a dirty envelope", { dirty: true }],
    ["an envelope on another commit", { commit: "f".repeat(40) }],
    ["an envelope of another selector", { selector: "login broken" }],
    ["a closure envelope", { phase: "closure" }],
  ] as const) {
    it(`${name} does not prove the row`, () => {
      expect(
        unproven(
          run({
            ...PLAN_FILES,
            "evidence/TP-2.jsonl": envelope({ selector: "login works", ...over }),
          }),
        ),
      ).toEqual([expected]);
    });
  }

  it("an envelope in another row's file does not prove the row", () => {
    const report = run({
      ...PLAN_FILES,
      "evidence/TP-4.jsonl": cleanTp2,
    });
    expect(unproven(report)).toEqual([expected]);
    expect(ofRule(report, "evidence-unknown-row")).toEqual([
      expect.objectContaining({ id: "TP-4" }),
    ]);
  });

  it("a row whose binding has no selector expects a null envelope selector", () => {
    // TP-2 bound without a selector: the fresh envelope is the null one.
    const bindings = "TP-1:\n  status: new\nTP-2:\n  status: existing\n";
    expect(
      unproven(
        run({
          ...PLAN_FILES,
          "bindings.yaml": bindings,
          "evidence/TP-2.jsonl": envelope(),
        }),
      ),
    ).toEqual([]);
    expect(
      unproven(
        run({
          ...PLAN_FILES,
          "bindings.yaml": bindings,
          "evidence/TP-2.jsonl": envelope({ selector: "anything" }),
        }),
      ),
    ).toEqual([expected]);
  });
});

describe("self-reported: a local envelope is judged, ci and host are not", () => {
  const flagged = (report: LintReport) => ofRule(report, "self-reported");
  const expected = expect.objectContaining({
    level: "warning",
    file: "evidence/TP-1.jsonl",
    path: "$",
    id: "TP-1",
  });

  it("producer local is one warning for the row", () => {
    expect(
      flagged(run({ "evidence/TP-1.jsonl": envelope({ producer: "local" }) })),
    ).toEqual([expected]);
  });

  it("producer host is not self-reported", () => {
    expect(flagged(run({ "evidence/TP-1.jsonl": envelope() }))).toEqual([]);
  });

  it("producer ci is not judged by lint: the closing check verifies it through the host", () => {
    expect(
      flagged(
        run({
          "evidence/TP-1.jsonl": envelope({
            producer: "ci",
            ci_run: "https://ci.example/run/1",
          }),
        }),
      ),
    ).toEqual([]);
  });

  it("a closure envelope of producer local is flagged too", () => {
    expect(
      flagged(
        run({
          "evidence/TP-1.jsonl": envelope({
            producer: "local",
            phase: "closure",
          }),
        }),
      ),
    ).toEqual([expected]);
  });

  it("one file is one warning whatever how many local envelopes it holds", () => {
    expect(
      flagged(
        run({
          "evidence/TP-1.jsonl":
            envelope({ producer: "local" }) + envelope({ producer: "local" }),
        }),
      ),
    ).toHaveLength(1);
  });
});

describe("evidence-unknown-row: a file maps to a row that exists", () => {
  it("a well-formed file for an unknown TP ID is one error", () => {
    expect(
      ofRule(run({ "evidence/TP-9.jsonl": envelope() }), "evidence-unknown-row"),
    ).toEqual([
      expect.objectContaining({
        level: "error",
        file: "evidence/TP-9.jsonl",
        path: "$",
        id: "TP-9",
      }),
    ]);
  });

  it("files of live rows are accepted", () => {
    expect(
      ofRule(
        run({
          ...PLAN_FILES,
          "evidence/TP-1.jsonl": envelope(),
          "evidence/TP-3.jsonl": envelope(),
        }),
        "evidence-unknown-row",
      ),
    ).toEqual([]);
  });
});

describe("the loader's evidence/ scan", () => {
  it("a subdirectory is a file finding and the evidence rules skip input-failed", () => {
    const dir = specDir(PLAN_FILES);
    fs.mkdirSync(path.join(dir, "evidence", "old"), { recursive: true });
    const report = runDir(dir);
    expect(ofRule(report, "file")).toEqual([
      expect.objectContaining({
        file: "evidence/old",
        code: "input-not-regular",
      }),
    ]);
    expect(skipReason(report, "unproven")).toBe("input-failed");
    expect(skipReason(report, "self-reported")).toBe("input-failed");
    expect(skipReason(report, "evidence-unknown-row")).toBe("input-failed");
  });

  it("a symlink named like a row file is a file finding, not followed", () => {
    const dir = specDir(PLAN_FILES);
    fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
    fs.writeFileSync(path.join(dir, "victim.jsonl"), cleanTp2);
    fs.symlinkSync("../victim.jsonl", path.join(dir, "evidence", "TP-2.jsonl"));
    const report = runDir(dir);
    expect(ofRule(report, "file")).toEqual([
      expect.objectContaining({
        file: "evidence/TP-2.jsonl",
        code: "input-not-regular",
      }),
    ]);
    // the input failed, so the evidence rules skip rather than follow the link
    expect(skipReason(report, "unproven")).toBe("input-failed");
  });

  it("TP-1.json is a format finding of code evidence-layout", () => {
    const report = run({ "evidence/TP-1.json": envelope() });
    expect(ofRule(report, "format")).toEqual([
      expect.objectContaining({
        file: "evidence/TP-1.json",
        path: "$",
        code: "evidence-layout",
      }),
    ]);
  });

  it("a plain text note under evidence/ is the same format finding", () => {
    expect(
      ofRule(run({ "evidence/notes.txt": "handwritten run notes\n" }), "format"),
    ).toEqual([
      expect.objectContaining({
        file: "evidence/notes.txt",
        code: "evidence-layout",
      }),
    ]);
  });

  it("an evidence entry that is not a directory is a file finding", () => {
    expect(
      ofRule(run({ evidence: "not a directory\n" }), "file"),
    ).toEqual([
      expect.objectContaining({
        file: "evidence",
        code: "input-not-regular",
      }),
    ]);
  });

  it("an envelope file that does not parse gives format findings and skips the rules", () => {
    const report = run({ ...PLAN_FILES, "evidence/TP-2.jsonl": "not json\n" });
    expect(ofRule(report, "format").map((f) => f.file)).toEqual([
      "evidence/TP-2.jsonl",
    ]);
    expect(skipReason(report, "unproven")).toBe("input-failed");
    expect(ofRule(report, "unproven")).toEqual([]);
  });

  it("the layout findings also run in the light profile", () => {
    const report = run({ "evidence/TP-1.json": envelope() }, { profile: "light" });
    expect(ofRule(report, "format")).toEqual([
      expect.objectContaining({ code: "evidence-layout" }),
    ]);
  });
});

describe("stale-evidence without git inputs", () => {
  it("is skipped no-git, and under --final that adds no rule-skipped error", () => {
    const report = run({}, { final: true });
    expect(skipReason(report, "stale-evidence")).toBe("no-git");
    const ruleSkipped = ofRule(report, "rule-skipped").map((f) => f.id);
    expect(ruleSkipped).not.toContain("stale-evidence");
    // the four error rules that need git are still reported as skipped
    expect(ruleSkipped).toContain("spec-changes-config");
  });
});

describe("the layout constants", () => {
  it("accept the one file shape and nothing else", () => {
    for (const name of ["TP-1.jsonl", "TP-123456789.jsonl"]) {
      expect(EVIDENCE_FILE_RE.test(name), name).toBe(true);
    }
    for (const name of [
      "TP-1.JSONL",
      "tp-1.jsonl",
      "TP-0.jsonl",
      "TP-01.jsonl",
      "TP-1.json",
      "TP-1.jsonl.bak",
      "TP-1.jsonl.json",
      "notes.jsonl",
    ]) {
      expect(EVIDENCE_FILE_RE.test(name), name).toBe(false);
    }
  });

  it("evidenceFileTpId names the row of a good file and nothing of another", () => {
    expect(evidenceFileTpId("TP-42.jsonl")).toBe("TP-42");
    expect(evidenceFileTpId("TP-42.json")).toBeUndefined();
  });
});

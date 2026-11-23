import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RULES,
  applyAcks,
  lintSpecDir,
  parseAcks,
  type Finding,
  type LintReport,
} from "../../src/lint/index.js";
import { specDir } from "./helpers.js";

function lint(files: Record<string, string | null>, options = {}): LintReport {
  const result = lintSpecDir(specDir(files), options);
  if (!result.ok) throw new Error(result.message);
  return result.report;
}

const ACK = (rule: string, id: string, reason = "accepted for now") =>
  `- rule: ${JSON.stringify(rule)}\n  id: ${JSON.stringify(id)}\n  reason: ${JSON.stringify(reason)}\n`;

// No triage.json: the run raises the acknowledgeable warning profile-default.
const NO_TRIAGE = { "triage.json": null };

describe("parseAcks", () => {
  it("accepts a list of { rule, id, reason }", () => {
    expect(parseAcks(ACK("a", "b", "c") + ACK("d", "e", "f"))).toEqual({
      ok: true,
      value: [
        { rule: "a", id: "b", reason: "c" },
        { rule: "d", id: "e", reason: "f" },
      ],
    });
    expect(parseAcks("[]")).toEqual({ ok: true, value: [] });
  });

  const codes = (text: string) => {
    const r = parseAcks(text);
    return r.ok ? [] : r.errors.map((e) => `${e.code} ${e.path}`);
  };

  it("rejects what is not a list of objects", () => {
    expect(codes("rule: a")).toEqual(["wrong-type $"]);
    expect(codes("- a")).toEqual(["wrong-type [0]"]);
    expect(codes("")).toEqual(["empty-document $"]);
  });

  it("rejects an unknown key and a missing key", () => {
    expect(codes("- {rule: a, id: b, reason: c, by: me}")).toEqual([
      "unknown-field [0].by",
    ]);
    expect(codes("- {rule: a, id: b}")).toEqual(["missing-field [0].reason"]);
    expect(codes("- {}")).toEqual([
      "missing-field [0].rule",
      "missing-field [0].id",
      "missing-field [0].reason",
    ]);
  });

  it("rejects a value that is not a non-empty single-line string", () => {
    expect(codes("- {rule: a, id: b, reason: 5}")).toEqual([
      "wrong-type [0].reason",
    ]);
    expect(codes('- {rule: a, id: b, reason: ""}')).toEqual([
      "empty-value [0].reason",
    ]);
    expect(codes('- {rule: a, id: b, reason: "   "}')).toEqual([
      "empty-value [0].reason",
    ]);
    expect(codes('- {rule: a, id: "", reason: c}')).toEqual([
      "empty-value [0].id",
    ]);
    expect(codes('- {rule: "", id: b, reason: c}')).toEqual([
      "empty-value [0].rule",
    ]);
    expect(codes('- {rule: a, id: b, reason: "x\\ny"}')).toEqual([
      "forbidden-character [0].reason",
    ]);
    expect(codes('- {rule: a, id: b, reason: "x\\ty"}')).toEqual([
      "forbidden-character [0].reason",
    ]);
  });

  it("rejects an alias, a tag and a duplicate key like every YAML format", () => {
    expect(codes("- &x {rule: a, id: b, reason: c}")).toEqual(["yaml-alias $"]);
    expect(codes("- {rule: a, rule: b, id: b, reason: c}")).toEqual([
      "duplicate-key $",
    ]);
  });
});

describe("acknowledging a warning", () => {
  it("a matching ack moves the warning to acked with its reason and counts it", () => {
    const report = lint({
      ...NO_TRIAGE,
      "acks.yaml": ACK("profile-default", "triage", "triage follows"),
    });
    expect(report.warnings).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.acked).toEqual([
      {
        rule: "profile-default",
        level: "warning",
        file: "triage.json",
        path: "$",
        id: "triage",
        message: expect.any(String),
        reason: "triage follows",
      },
    ]);
    expect(report.counts).toEqual({ errors: 0, warnings: 0, acked: 1 });
  });

  it("an acknowledged warning does not fail --strict, an open one does", () => {
    const acked = lint(
      { ...NO_TRIAGE, "acks.yaml": ACK("profile-default", "triage") },
      { strict: true },
    );
    expect(acked.ok).toBe(true);
    const open = lint(NO_TRIAGE, { strict: true });
    expect(open.ok).toBe(false);
    expect(open.errors).toEqual([]);
    expect(open.warnings).toHaveLength(1);
  });

  it("an ack for another id does not match, and is unused", () => {
    const report = lint({
      ...NO_TRIAGE,
      "acks.yaml": ACK("profile-default", "other"),
    });
    expect(report.acked).toEqual([]);
    expect(report.warnings.map((f) => f.rule).sort()).toEqual([
      "ack-unused",
      "profile-default",
    ]);
  });

  it("an ack for another rule does not match", () => {
    const report = lint({
      ...NO_TRIAGE,
      "acks.yaml": ACK("ack-unused", "triage"),
    });
    expect(report.acked).toEqual([]);
    expect(report.errors.map((f) => f.rule)).toEqual(["ack-invalid"]);
    expect(report.warnings.map((f) => f.rule)).toEqual(["profile-default"]);
  });

  it("an ack that matches no current warning is an ack-unused warning with its id", () => {
    const report = lint({ "acks.yaml": ACK("profile-default", "triage") });
    expect(report.warnings).toEqual([
      expect.objectContaining({
        rule: "ack-unused",
        file: "acks.yaml",
        path: "[0]",
        id: "triage",
        level: "warning",
      }),
    ]);
    expect(report.ok).toBe(true);
    expect(
      lint({ "acks.yaml": ACK("profile-default", "triage") }, { strict: true })
        .ok,
    ).toBe(false);
  });

  it("ack-unused cannot itself be acknowledged", () => {
    const report = lint({
      "acks.yaml":
        ACK("profile-default", "triage") + ACK("ack-unused", "triage"),
    });
    expect(report.errors.map((f) => f.rule)).toEqual(["ack-invalid"]);
    expect(report.errors[0]!.path).toBe("[1]");
    expect(report.warnings.map((f) => f.rule)).toEqual(["ack-unused"]);
  });

  it("an ack for an error rule is ack-invalid, and the error stays", () => {
    const broken = {
      "testplan.yaml":
        "- id: TP-1\n  covers: [NG-1]\n  kind: manual\n  claim: a check\n  verifier: alice\n  evidence_location: review/x.md\n",
      "bindings.yaml": null,
      "acks.yaml": ACK("ac-coverage", "AC-1"),
    };
    const report = lint(broken);
    expect(report.errors.map((f) => f.rule).sort()).toEqual([
      "ac-coverage",
      "ack-invalid",
    ]);
    expect(report.acked).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("an ack for an unknown rule is ack-invalid and not also unused", () => {
    const report = lint({ "acks.yaml": ACK("no-such-rule", "AC-1") });
    expect(report.errors).toEqual([
      expect.objectContaining({
        rule: "ack-invalid",
        file: "acks.yaml",
        path: "[0]",
      }),
    ]);
    expect(report.warnings).toEqual([]);
  });

  it("the second ack with the same (rule, id) is ack-invalid, the first still applies", () => {
    const report = lint({
      ...NO_TRIAGE,
      "acks.yaml":
        ACK("profile-default", "triage", "first") +
        ACK("profile-default", "triage", "second"),
    });
    expect(report.errors).toEqual([
      expect.objectContaining({ rule: "ack-invalid", path: "[1]" }),
    ]);
    expect(report.acked).toEqual([
      expect.objectContaining({ reason: "first" }),
    ]);
    expect(report.warnings).toEqual([]);
  });

  it("an invalid acks.yaml is a format error and the other rules still run without acks", () => {
    const report = lint({
      ...NO_TRIAGE,
      "acks.yaml": "- {rule: profile-default, id: triage}\n",
    });
    expect(report.errors).toEqual([
      expect.objectContaining({
        rule: "format",
        file: "acks.yaml",
        code: "missing-field",
      }),
    ]);
    expect(report.acked).toEqual([]);
    expect(report.warnings.map((f) => f.rule)).toEqual(["profile-default"]);
  });

  it("an unsafe acks.yaml is a file error and acknowledges nothing", () => {
    const dir = specDir(NO_TRIAGE);
    fs.writeFileSync(
      path.join(dir, "real.yaml"),
      ACK("profile-default", "triage"),
    );
    fs.symlinkSync("real.yaml", path.join(dir, "acks.yaml"));
    const result = lintSpecDir(dir);
    if (!result.ok) throw new Error(result.message);
    expect(result.report.errors).toEqual([
      expect.objectContaining({
        rule: "file",
        file: "acks.yaml",
        code: "input-not-regular",
      }),
    ]);
    expect(result.report.acked).toEqual([]);
  });
});

describe("applyAcks", () => {
  const warn = (rule: string, id?: string): Finding => ({
    rule,
    level: "warning",
    file: "x",
    path: "$",
    ...(id !== undefined ? { id } : {}),
    message: "m",
  });

  it("matches by rule and id together, and moves every warning that matches", () => {
    const out = applyAcks(
      [{ rule: "profile-default", id: "triage", reason: "r" }],
      [
        warn("profile-default", "triage"),
        warn("profile-default", "triage"),
        warn("profile-default", "x"),
      ],
      RULES,
    );
    expect(out.acked).toHaveLength(2);
    expect(out.warnings).toHaveLength(1);
    expect(out.findings).toEqual([]);
  });

  it("a warning with no id is never acknowledged", () => {
    const out = applyAcks(
      [{ rule: "profile-default", id: "triage", reason: "r" }],
      [warn("profile-default")],
      RULES,
    );
    expect(out.acked).toEqual([]);
    expect(out.warnings).toHaveLength(1);
    expect(out.findings.map((f) => f.rule)).toEqual(["ack-unused"]);
  });
});

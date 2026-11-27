import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_FIELDS,
  EVIDENCE_FILE_RE,
  EVIDENCE_PHASES,
  EVIDENCE_PRODUCERS,
  EVIDENCE_RESULTS,
  MAX_CI_RUN_LENGTH,
  MAX_INPUT_LENGTH,
  SQUASH_EVIDENCE_RULE,
  evidenceFileTpId,
  evidenceSurvivesSquash,
  expectedCommandsDigest,
  parseEvidenceLines,
  staleEvidenceApplies,
  validateEvidenceEnvelope,
} from "../../src/formats/index.js";
import { COMMIT_RE, ISO_UTC_RE } from "../../src/formats/validate.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const copy = here("../../schemas/evidence-envelope.json");
const reference = here(
  "../../../agent-primitives/schemas/evidence-envelope.json",
);

const envelope = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  phase: "baseline",
  producer: "host",
  time: "2000-01-31T12:00:00Z",
  commit: "0123456789abcdef0123456789abcdef01234567",
  dirty: false,
  commands_digest: "a".repeat(64),
  selector: null,
  command: ["npm", "test"],
  exit: 0,
  result: "pass",
  ...over,
});

function codes(raw: unknown): string[] {
  const r = validateEvidenceEnvelope(raw);
  return r.ok ? [] : r.errors.map((e) => `${e.code} @ ${e.path}`);
}

describe("evidence envelope schema copy", () => {
  it("is byte for byte the reference runner's schema", () => {
    if (!fs.existsSync(reference)) {
      // The reference lives in a sibling package of this monorepo. Without
      // it this guard cannot run; say so instead of passing silently.
      console.warn(
        "skipped: ../agent-primitives/schemas/evidence-envelope.json is absent",
      );
      return;
    }
    expect(fs.readFileSync(copy).equals(fs.readFileSync(reference))).toBe(true);
  });

  it("agrees with the validator on fields, enums and patterns", () => {
    const schema = JSON.parse(fs.readFileSync(copy, "utf8")) as {
      required: string[];
      properties: Record<
        string,
        {
          enum?: string[];
          pattern?: string;
          maxLength?: number;
          const?: number;
        }
      >;
    };
    expect([...EVIDENCE_FIELDS].sort()).toEqual(
      Object.keys(schema.properties).sort(),
    );
    expect(schema.required.sort()).toEqual(
      [...EVIDENCE_FIELDS].filter((f) => f !== "ci_run").sort(),
    );
    expect(schema.properties["phase"]!.enum).toEqual([...EVIDENCE_PHASES]);
    expect(schema.properties["producer"]!.enum).toEqual([
      ...EVIDENCE_PRODUCERS,
    ]);
    expect(schema.properties["result"]!.enum).toEqual([...EVIDENCE_RESULTS]);
    expect(schema.properties["commit"]!.pattern).toBe(COMMIT_RE.source);
    expect(schema.properties["time"]!.pattern).toBe(ISO_UTC_RE.source);
    expect(schema.properties["commands_digest"]!.pattern).toBe(
      "^[0-9a-f]{64}$",
    );
    expect(schema.properties["ci_run"]!.maxLength).toBe(MAX_CI_RUN_LENGTH);
    expect(schema.properties["schema_version"]!.const).toBe(1);
  });
});

describe("evidence envelope validation", () => {
  it("accepts a valid envelope of each phase, producer and result", () => {
    expect(codes(envelope())).toEqual([]);
    for (const phase of EVIDENCE_PHASES)
      expect(codes(envelope({ phase })), phase).toEqual([]);
    for (const result of ["pass", "fail", "error"]) {
      expect(codes(envelope({ result })), result).toEqual([]);
    }
    for (const producer of ["host", "local"])
      expect(codes(envelope({ producer })), producer).toEqual([]);
    expect(codes(envelope({ producer: "ci", ci_run: "run-1" }))).toEqual([]);
  });

  it("returns the envelope with ci_run only when present", () => {
    const a = validateEvidenceEnvelope(envelope());
    expect(a.ok && "ci_run" in a.value).toBe(false);
    const b = validateEvidenceEnvelope(
      envelope({ producer: "ci", ci_run: "r" }),
    );
    expect(b.ok && b.value.ci_run).toBe("r");
  });

  it("requires ci_run for ci and refuses it for every other producer", () => {
    expect(codes(envelope({ producer: "ci" }))).toEqual([
      "ci-run-required @ ci_run",
    ]);
    for (const producer of ["host", "local"]) {
      expect(codes(envelope({ producer, ci_run: "r" })), producer).toEqual([
        "ci-run-not-allowed @ ci_run",
      ]);
    }
  });

  it("bounds ci_run at 1 to 2048 characters", () => {
    expect(
      codes(envelope({ producer: "ci", ci_run: "x".repeat(2048) })),
    ).toEqual([]);
    expect(
      codes(envelope({ producer: "ci", ci_run: "x".repeat(2049) })),
    ).toEqual(["invalid-value @ ci_run"]);
    expect(codes(envelope({ producer: "ci", ci_run: "" }))).toEqual([
      "invalid-value @ ci_run",
    ]);
  });

  it("allows an empty command only for a skipped check", () => {
    expect(
      codes(envelope({ result: "skip", command: [], exit: null })),
    ).toEqual([]);
    for (const result of ["pass", "fail", "error"]) {
      expect(codes(envelope({ result, command: [] })), result).toEqual([
        "command-required @ command",
      ]);
    }
    expect(codes(envelope({ result: "skip", command: ["x"] }))).toEqual([]);
  });

  it("accepts a null selector and a string selector, a null exit and an integer exit", () => {
    expect(codes(envelope({ selector: "a > b", exit: 3 }))).toEqual([]);
    expect(codes(envelope({ selector: null, exit: null }))).toEqual([]);
    expect(codes(envelope({ selector: 1 }))).toEqual(["wrong-type @ selector"]);
    expect(codes(envelope({ exit: 1.5 }))).toEqual(["wrong-type @ exit"]);
  });

  it("refuses an exit integer past the IEEE-754 safe range, both signs", () => {
    for (const v of [2 ** 53, -(2 ** 53)]) {
      expect(codes(envelope({ exit: v })), String(v)).toEqual([
        "wrong-type @ exit",
      ]);
    }
    expect(codes(envelope({ exit: 2 ** 53 - 1 }))).toEqual([]);
  });

  it("accepts sha-1 and sha-256 commits, lower case only", () => {
    expect(codes(envelope({ commit: "a".repeat(64) }))).toEqual([]);
    for (const commit of [
      "a".repeat(41),
      "A".repeat(40),
      "a".repeat(39),
      "g".repeat(40),
    ]) {
      expect(codes(envelope({ commit })), commit).toEqual([
        "invalid-value @ commit",
      ]);
    }
  });

  it("reports several errors at once and prefixes nested paths", () => {
    const r = validateEvidenceEnvelope(
      envelope({ phase: "x", result: "y", extra: 1 }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.path).sort()).toEqual([
      "extra",
      "phase",
      "result",
    ]);
  });

  it("rejects a non-object", () => {
    for (const raw of [null, [], "x", 1])
      expect(codes(raw)).toEqual(["wrong-type @ $"]);
  });
});

describe("evidence JSON Lines", () => {
  const line = (over: Record<string, unknown> = {}) =>
    JSON.stringify(envelope(over));

  it("reads one envelope per line, with or without a final line break", () => {
    for (const text of [
      `${line()}\n${line({ phase: "closure" })}\n`,
      `${line()}\n${line({ phase: "closure" })}`,
    ]) {
      const r = parseEvidenceLines(text);
      expect(r.ok && r.value.map((e) => e.phase)).toEqual([
        "baseline",
        "closure",
      ]);
    }
  });

  it("reads CRLF line breaks", () => {
    const r = parseEvidenceLines(`${line()}\r\n${line()}\r\n`);
    expect(r.ok && r.value).toHaveLength(2);
  });

  it("rejects an input over the size limit as a whole", () => {
    const r = parseEvidenceLines(`${line()}\n${"x".repeat(MAX_INPUT_LENGTH)}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toEqual(["input-too-large"]);
  });

  it("rejects an empty file and a file of one line break, but not one empty line more than the final break", () => {
    expect(parseEvidenceLines("").ok).toBe(false);
    expect(parseEvidenceLines("\n").ok).toBe(false);
    const r = parseEvidenceLines(`${line()}\n\n`);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.map((e) => `${e.code} @ ${e.path}`)).toEqual([
        "blank-line @ [1]",
      ]);
  });

  it("puts the 0-based index in the path and the 1-based line in `line`", () => {
    const r = parseEvidenceLines(`${line()}\n${line({ phase: "x" })}\n`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      expect.objectContaining({
        code: "invalid-value",
        path: "[1].phase",
        line: 2,
      }),
    ]);
  });

  it("keeps good lines' errors apart from bad lines'", () => {
    const r = parseEvidenceLines(`${line({ phase: "x" })}\n${line()}\n{oops\n`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => [e.code, e.line])).toEqual([
      ["invalid-value", 1],
      ["invalid-json", 3],
    ]);
  });
});

describe("evidence phases", () => {
  it("has the two phases", () => {
    expect([...EVIDENCE_PHASES]).toEqual(["baseline", "closure"]);
  });

  it("marks only baseline evidence as able to go stale", () => {
    expect(staleEvidenceApplies("baseline")).toBe(true);
    expect(staleEvidenceApplies("closure")).toBe(false);
  });
});

describe("evidence after a squash merge", () => {
  // [squashed, commitOnDefaultBranch, onPrBranchBeforeSquash, referencedInPrCiRun, valid]
  const TABLE: [boolean, boolean, boolean, boolean, boolean][] = [
    [false, false, false, false, true],
    [false, false, false, true, true],
    [false, false, true, false, true],
    [false, false, true, true, true],
    [false, true, false, false, true],
    [false, true, false, true, true],
    [false, true, true, false, true],
    [false, true, true, true, true],
    [true, false, false, false, false],
    [true, false, false, true, false],
    [true, false, true, false, false],
    [true, false, true, true, true],
    [true, true, false, false, true],
    [true, true, false, true, true],
    [true, true, true, false, true],
    [true, true, true, true, true],
  ];

  it.each(TABLE)(
    "squashed=%s onDefault=%s onPrBranch=%s inCiRun=%s -> valid=%s",
    (
      squashed,
      commitOnDefaultBranch,
      onPrBranchBeforeSquash,
      referencedInPrCiRun,
      valid,
    ) => {
      const r = evidenceSurvivesSquash({
        squashed,
        commitOnDefaultBranch,
        onPrBranchBeforeSquash,
        referencedInPrCiRun,
      });
      expect(r.valid).toBe(valid);
      expect(r.reason.length).toBeGreaterThan(0);
    },
  );

  it("does not depend on the phase: a closure envelope at a pre-squash commit with neither fact does not count", () => {
    const r = evidenceSurvivesSquash({
      squashed: true,
      commitOnDefaultBranch: false,
      onPrBranchBeforeSquash: false,
      referencedInPrCiRun: false,
    });
    expect(r.valid).toBe(false);
  });

  it("says which fact is missing", () => {
    const base = {
      squashed: true,
      commitOnDefaultBranch: false,
      onPrBranchBeforeSquash: true,
      referencedInPrCiRun: false,
    };
    expect(evidenceSurvivesSquash(base).reason).toMatch(
      /CI run does not reference/,
    );
    expect(
      evidenceSurvivesSquash({
        ...base,
        onPrBranchBeforeSquash: false,
        referencedInPrCiRun: true,
      }).reason,
    ).toMatch(/neither on the default branch nor/);
    expect(
      evidenceSurvivesSquash({ ...base, commitOnDefaultBranch: true }).reason,
    ).toMatch(/reachable from the default branch/);
  });

  it("states the rule as data for the closing check", () => {
    expect(SQUASH_EVIDENCE_RULE.requiredFacts).toEqual([
      "commitOnDefaultBranch",
      "onPrBranchBeforeSquash",
      "referencedInPrCiRun",
    ]);
    expect(SQUASH_EVIDENCE_RULE.perSliceEvidencePhase).toBe("closure");
    expect(SQUASH_EVIDENCE_RULE.summary).toMatch(
      /reachable from the default branch/,
    );
  });
});

describe("expectedCommandsDigest", () => {
  const UNIT_TEMPLATE = ["npx", "vitest", "run", "-t", "{selector}"];

  it("equals the reference runner's formula for a run of one check", () => {
    // the runner digests the list of argv lists of a run; a spec-gate check
    // is a run of one command, so the list holds the row's one command
    const template = ["npm", "run", "typecheck"];
    expect(expectedCommandsDigest(template)).toBe(
      createHash("sha256").update(JSON.stringify([template])).digest("hex"),
    );
    expect(expectedCommandsDigest(template)).toBe(
      "0ee47a7219f84f1731be022c31c88b7c58549d44f204e3e2dc45364618084aa4",
    );
  });

  it("is pinned to the reference vector", () => {
    expect(expectedCommandsDigest(UNIT_TEMPLATE)).toBe(
      "4a40e701c107ced85a444c19d8c979921e1e800965f16dad60e59a395bf0e0a4",
    );
  });

  it("digests the selector placeholder unsubstituted", () => {
    expect(expectedCommandsDigest(UNIT_TEMPLATE)).not.toBe(
      // the same run with the selector substituted is a different digest:
      // lint can only name the command set, not the test the run picked
      "aca2195374f51d3f81cd9d27573752ca71195d6964e9218472668719b79e8950",
    );
    expect(
      expectedCommandsDigest(["npx", "vitest", "run", "-t", "login works"]),
    ).toBe("aca2195374f51d3f81cd9d27573752ca71195d6964e9218472668719b79e8950");
  });

  it("is stable under copying and sensitive to the command", () => {
    expect(expectedCommandsDigest([...UNIT_TEMPLATE])).toBe(
      expectedCommandsDigest(UNIT_TEMPLATE),
    );
    expect(expectedCommandsDigest(UNIT_TEMPLATE)).not.toBe(
      expectedCommandsDigest(["npm", "test"]),
    );
  });
});

describe("the evidence file layout", () => {
  it("names every row file shape and no other name", () => {
    for (const name of ["TP-1.jsonl", "TP-123456789.jsonl"]) {
      expect(EVIDENCE_FILE_RE.test(name), name).toBe(true);
    }
    for (const name of [
      "TP-0.jsonl",
      "TP-01.jsonl",
      "tp-1.jsonl",
      "TP-1.JSONL",
      "TP-1.json",
      "TP-1.jsonl.bak",
      "bindings.yaml",
    ]) {
      expect(EVIDENCE_FILE_RE.test(name), name).toBe(false);
    }
  });

  it("maps a row file to its row and every other name to nothing", () => {
    expect(evidenceFileTpId("TP-42.jsonl")).toBe("TP-42");
    for (const name of ["TP-0.jsonl", "TP-1.json", "TP-1.jsonl.bak"]) {
      expect(evidenceFileTpId(name), name).toBeUndefined();
    }
  });
});

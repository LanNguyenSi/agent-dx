import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_FIELDS,
  EVIDENCE_PHASES,
  EVIDENCE_PRODUCERS,
  EVIDENCE_RESULTS,
  MAX_CI_RUN_LENGTH,
  MAX_INPUT_LENGTH,
  SQUASH_EVIDENCE_RULE,
  evidenceSurvivesSquash,
  parseEvidenceLines,
  staleEvidenceApplies,
  validateEvidenceEnvelope,
} from "../../src/formats/index.js";
import type { EvidencePhase } from "../../src/formats/index.js";
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
  const phases: EvidencePhase[] = ["baseline", "closure"];

  it("applies the documented rule for every combination of phase and facts", () => {
    for (const phase of phases) {
      for (const squashed of [false, true]) {
        for (const onPrBranchBeforeSquash of [false, true]) {
          for (const referencedInPrCiRun of [false, true]) {
            const r = evidenceSurvivesSquash(phase, {
              squashed,
              onPrBranchBeforeSquash,
              referencedInPrCiRun,
            });
            const expected =
              !squashed ||
              phase === "closure" ||
              (onPrBranchBeforeSquash && referencedInPrCiRun);
            expect(
              r.valid,
              JSON.stringify({
                phase,
                squashed,
                onPrBranchBeforeSquash,
                referencedInPrCiRun,
              }),
            ).toBe(expected);
            expect(r.reason.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("says which fact is missing", () => {
    const base = {
      squashed: true,
      onPrBranchBeforeSquash: true,
      referencedInPrCiRun: false,
    };
    expect(evidenceSurvivesSquash("baseline", base).reason).toMatch(
      /CI run does not reference/,
    );
    expect(
      evidenceSurvivesSquash("baseline", {
        ...base,
        onPrBranchBeforeSquash: false,
        referencedInPrCiRun: true,
      }).reason,
    ).toMatch(/not on the PR branch/);
  });

  it("states the rule as data for the closing check", () => {
    expect(SQUASH_EVIDENCE_RULE.requiredFacts).toEqual([
      "onPrBranchBeforeSquash",
      "referencedInPrCiRun",
    ]);
    expect(SQUASH_EVIDENCE_RULE.closureUnaffected).toBe(true);
    expect(SQUASH_EVIDENCE_RULE.summary).toMatch(
      /only closure evidence counts/,
    );
  });
});

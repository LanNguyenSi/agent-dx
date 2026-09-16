import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";

import {
  ENUM_VALUES,
  FINDING_FIELDS,
  REPRODUCTION_FIELDS,
  STRUCTURAL_ONLY_NOTE,
  TOP_LEVEL_FIELDS,
  WITHDRAWN_FIELDS,
  extractYamlSource,
  validateReviewReport,
} from "../src/review-report.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES_DIR = join(PACKAGE_DIR, "test/fixtures/review-report");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

/**
 * A fresh parse of `valid.yaml`'s inner document as a plain object, one
 * per call so a test that deletes a key never leaks that mutation into
 * another test. `valid.yaml` carries one fully-populated `findings[0]`
 * and `withdrawn[0]` entry precisely so this doubles as the base fixture
 * for both the `FINDING_FIELDS` and `WITHDRAWN_FIELDS` table-driven
 * checks below.
 */
function validDoc(): Record<string, unknown> {
  const { yamlText } = extractYamlSource(fixture("valid.yaml"));
  return parseYaml(yamlText) as Record<string, unknown>;
}

describe("validateReviewReport: complete valid returns", () => {
  it("passes a fenced, complete reviewer return with no diagnostics or warnings", () => {
    const result = validateReviewReport(fixture("valid.yaml"));
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("passes an unfenced (literal YAML) reviewer return the same way", () => {
    const result = validateReviewReport(fixture("valid-unfenced.yaml"));
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("passes empty findings/missing_tests/residual_risks/withdrawn lists", () => {
    const result = validateReviewReport(fixture("valid-unfenced.yaml"));
    expect(result.valid).toBe(true);
  });
});

describe("validateReviewReport: fence handling", () => {
  it("tolerates prose after the closing fence as a warning, not a failure", () => {
    const result = validateReviewReport(fixture("prose-after.yaml"));
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([
      "prose found after the closing ```yaml fence; only the fenced block was validated",
    ]);
  });

  it("tolerates prose before the opening fence as a warning, not a raw YAML parse error (fix-round, review finding L1)", () => {
    const result = validateReviewReport(fixture("prose-before.yaml"));
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.warnings).toEqual([
      "prose found before the opening ```yaml fence; only the fenced block was validated",
    ]);
  });

  it("extractYamlSource locates a fence anywhere in the input and names the discarded leading prose", () => {
    const { yamlText, warnings } = extractYamlSource(
      "Here is my report:\n```yaml\nstatus: reviewed\n```\n",
    );
    expect(yamlText).toBe("status: reviewed");
    expect(warnings).toEqual([
      "prose found before the opening ```yaml fence; only the fenced block was validated",
    ]);
  });

  it("extractYamlSource strips exactly one leading/trailing fence and names trailing prose", () => {
    const { yamlText, warnings } = extractYamlSource(
      "```yaml\nstatus: reviewed\n```\ntrailing note\n",
    );
    expect(yamlText).toBe("status: reviewed");
    expect(warnings).toEqual([
      "prose found after the closing ```yaml fence; only the fenced block was validated",
    ]);
  });

  it("extractYamlSource treats unfenced input as literal YAML with no warnings", () => {
    const { yamlText, warnings } = extractYamlSource("status: reviewed\n");
    expect(yamlText).toBe("status: reviewed\n");
    expect(warnings).toEqual([]);
  });

  it("strips a language-less bare ``` fence the same way as a ```yaml one (fix-round, review finding L2)", () => {
    const result = validateReviewReport(fixture("valid-bare-fence.yaml"));
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("extractYamlSource strips a bare ``` fence with no language tag", () => {
    const { yamlText, warnings } = extractYamlSource(
      "```\nstatus: reviewed\n```\n",
    );
    expect(yamlText).toBe("status: reviewed");
    expect(warnings).toEqual([]);
  });
});

describe("validateReviewReport: edge-case inputs behave sanely", () => {
  it("reports a root-level diagnostic for a completely empty file rather than throwing", () => {
    const result = validateReviewReport(fixture("empty.yaml"));
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      { path: "<root>", expected: "a YAML mapping (object)", got: "null" },
    ]);
  });

  it("reports a root-level diagnostic for a non-mapping (bare scalar) document", () => {
    const result = validateReviewReport(fixture("non-mapping-scalar.yaml"));
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        path: "<root>",
        expected: "a YAML mapping (object)",
        got: '"just a plain scalar string, not a mapping"',
      },
    ]);
  });

  it("reports a root-level parse diagnostic for multi-document YAML instead of throwing", () => {
    const result = validateReviewReport(fixture("multi-document.yaml"));
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].path).toBe("<root>");
    expect(result.diagnostics[0].expected).toBe("valid YAML");
  });

  it("accepts a complete, correctly fenced return with CRLF line endings throughout", () => {
    const result = validateReviewReport(fixture("valid-crlf.yaml"));
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("validateReviewReport: table-driven required-field coverage (fix-round, review finding M1)", () => {
  it.each(TOP_LEVEL_FIELDS)(
    "flags a missing top-level field %s with exactly one diagnostic at that path",
    (field) => {
      const doc = validDoc();
      delete doc[field];
      const result = validateReviewReport(stringifyYaml(doc));
      expect(result.valid).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].path).toBe(field);
    },
  );

  it.each(FINDING_FIELDS)(
    "flags a missing findings[0].%s with exactly one diagnostic at that path",
    (field) => {
      const doc = validDoc();
      const findings = doc.findings as Record<string, unknown>[];
      delete findings[0][field];
      const result = validateReviewReport(stringifyYaml(doc));
      expect(result.valid).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].path).toBe(`findings[0].${field}`);
    },
  );

  it.each(REPRODUCTION_FIELDS)(
    "flags a missing reproduction.%s with exactly one diagnostic at that path",
    (field) => {
      const doc = validDoc();
      const reproduction = doc.reproduction as Record<string, unknown>;
      delete reproduction[field];
      const result = validateReviewReport(stringifyYaml(doc));
      expect(result.valid).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].path).toBe(`reproduction.${field}`);
    },
  );

  it.each(WITHDRAWN_FIELDS)(
    "flags a missing withdrawn[0].%s with exactly one diagnostic at that path",
    (field) => {
      const doc = validDoc();
      const withdrawn = doc.withdrawn as Record<string, unknown>[];
      delete withdrawn[0][field];
      const result = validateReviewReport(stringifyYaml(doc));
      expect(result.valid).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].path).toBe(`withdrawn[0].${field}`);
    },
  );
});

describe("validateReviewReport: table-driven enum coverage (fix-round, review finding M1)", () => {
  /**
   * Where to mutate `validDoc()` and what diagnostic path to expect, one
   * entry per key in `ENUM_VALUES`. `valid.yaml` carries exactly one
   * `findings[0]` and a filled `reproduction`, so every enum-bearing
   * field it names has a real location to overwrite.
   */
  const ENUM_LOCATIONS: Record<
    string,
    { path: string; set: (doc: Record<string, any>, value: string) => void }
  > = {
    status: {
      path: "status",
      set: (doc, value) => {
        doc.status = value;
      },
    },
    role: {
      path: "role",
      set: (doc, value) => {
        doc.role = value;
      },
    },
    acceptance_recommendation: {
      path: "acceptance_recommendation",
      set: (doc, value) => {
        doc.acceptance_recommendation = value;
      },
    },
    method_applied: {
      path: "method_applied",
      set: (doc, value) => {
        doc.method_applied = value;
      },
    },
    severity: {
      path: "findings[0].severity",
      set: (doc, value) => {
        doc.findings[0].severity = value;
      },
    },
    category: {
      path: "findings[0].category",
      set: (doc, value) => {
        doc.findings[0].category = value;
      },
    },
    recurrence: {
      path: "findings[0].recurrence",
      set: (doc, value) => {
        doc.findings[0].recurrence = value;
      },
    },
    introduced_by_delta: {
      path: "findings[0].introduced_by_delta",
      set: (doc, value) => {
        doc.findings[0].introduced_by_delta = value;
      },
    },
    matches_implementer_claim: {
      path: "reproduction.matches_implementer_claim",
      set: (doc, value) => {
        doc.reproduction.matches_implementer_claim = value;
      },
    },
  };

  it("ENUM_LOCATIONS covers every ENUM_VALUES key exactly (test self-check)", () => {
    expect(Object.keys(ENUM_LOCATIONS).sort()).toEqual(
      Object.keys(ENUM_VALUES).sort(),
    );
  });

  it.each(Object.keys(ENUM_VALUES))(
    "flags an out-of-enum value for %s with exactly one diagnostic naming the enum",
    (key) => {
      const location = ENUM_LOCATIONS[key];
      const doc = validDoc();
      location.set(doc, "not-a-real-enum-value");
      const result = validateReviewReport(stringifyYaml(doc));
      expect(result.valid).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toEqual({
        path: location.path,
        expected: ENUM_VALUES[key].join(" | "),
        got: '"not-a-real-enum-value"',
      });
    },
  );
});

describe("validateReviewReport: table-driven predicate coverage (fix-round, review findings L2/L3)", () => {
  /**
   * Every predicate this validator applies beyond bare presence, type,
   * and enum membership -- both already pinned by the tables above --
   * gets exactly one row here, positive and negative. Today that is
   * `checkNonEmptyStringField`'s non-emptiness (`task_id`) and
   * `checkScalarField`'s "string or number" tolerance
   * (`reproduction.sample_size`). A new predicate helper (a `check*Field`
   * function whose accept/reject rule differs from `checkStringField`'s
   * "present and is a string" or `checkEnumField`'s "present and in the
   * enum") needs a row added here before it counts as covered.
   */
  const PREDICATE_CASES: Array<{
    name: string;
    path: string;
    set: (doc: Record<string, any>, value: unknown) => void;
    invalid: unknown;
    invalidExpected: string;
    invalidGot: string;
    valid: unknown;
  }> = [
    {
      name: "checkNonEmptyStringField: task_id rejects an empty/whitespace-only string, not merely a non-string",
      path: "task_id",
      set: (doc, value) => {
        doc.task_id = value;
      },
      invalid: "",
      invalidExpected: "non-empty string",
      invalidGot: '""',
      valid: "T-009",
    },
    {
      name: "checkScalarField: reproduction.sample_size accepts a number, not only a string",
      path: "reproduction.sample_size",
      set: (doc, value) => {
        (doc.reproduction as Record<string, unknown>).sample_size = value;
      },
      invalid: true,
      invalidExpected: "string",
      invalidGot: "true",
      valid: 5,
    },
  ];

  it.each(PREDICATE_CASES)(
    "$name",
    ({ path, set, invalid, invalidExpected, invalidGot, valid }) => {
      const invalidDoc = validDoc();
      set(invalidDoc, invalid);
      const invalidResult = validateReviewReport(stringifyYaml(invalidDoc));
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.diagnostics).toContainEqual({
        path,
        expected: invalidExpected,
        got: invalidGot,
      });

      const okDoc = validDoc();
      set(okDoc, valid);
      const okResult = validateReviewReport(stringifyYaml(okDoc));
      expect(okResult.valid).toBe(true);
      expect(okResult.diagnostics).toEqual([]);
    },
  );
});

describe("validateReviewReport: missing required fields", () => {
  it("reports a precise diagnostic for a missing acceptance_recommendation", () => {
    const result = validateReviewReport(
      fixture("missing-acceptance-recommendation.yaml"),
    );
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        path: "acceptance_recommendation",
        expected: ENUM_VALUES.acceptance_recommendation.join(" | "),
        got: "missing",
      },
    ]);
  });

  it("reports a precise diagnostic for a missing method_applied", () => {
    const result = validateReviewReport(fixture("missing-method-applied.yaml"));
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        path: "method_applied",
        expected: ENUM_VALUES.method_applied.join(" | "),
        got: "missing",
      },
    ]);
  });

  it("reports a precise diagnostic for a findings entry missing severity", () => {
    const result = validateReviewReport(fixture("missing-severity.yaml"));
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        path: "findings[0].severity",
        expected: ENUM_VALUES.severity.join(" | "),
        got: "missing",
      },
    ]);
  });
});

describe("validateReviewReport: invalid enum values", () => {
  it("reports a precise diagnostic for an invalid severity spelling", () => {
    const result = validateReviewReport(fixture("invalid-enum.yaml"));
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        path: "findings[0].severity",
        expected: ENUM_VALUES.severity.join(" | "),
        got: '"severe"',
      },
    ]);
  });

  it("rejects every field's out-of-enum value with its own diagnostic", () => {
    const base = {
      status: "reviewed",
      role: "reviewer",
      task_id: "T-000",
      summary: [],
      findings: [],
      acceptance_recommendation: "accept",
      missing_tests: [],
      residual_risks: [],
      reproduction: {
        method: "m",
        sample_size: "1",
        result: "r",
        matches_implementer_claim: "matched",
      },
      method_applied: "normal",
      withdrawn: [],
    };

    function toYaml(record: Record<string, unknown>): string {
      // Minimal hand-rolled emitter is unnecessary: reuse the `yaml`
      // package indirectly by round-tripping through JSON-compatible
      // structures is out of scope here; instead compose the handful of
      // top-level scalar overrides directly as YAML text.
      const lines = Object.entries(record).map(([key, value]) => {
        if (typeof value === "object") {
          return `${key}: ${JSON.stringify(value)}`;
        }
        return `${key}: ${String(value)}`;
      });
      return lines.join("\n");
    }

    const statusResult = validateReviewReport(
      toYaml({ ...base, status: "review-in-progress" }),
    );
    expect(statusResult.diagnostics).toContainEqual({
      path: "status",
      expected: "reviewed",
      got: '"review-in-progress"',
    });

    const roleResult = validateReviewReport(
      toYaml({ ...base, role: "implementer" }),
    );
    expect(roleResult.diagnostics).toContainEqual({
      path: "role",
      expected: "reviewer",
      got: '"implementer"',
    });

    const recommendationResult = validateReviewReport(
      toYaml({ ...base, acceptance_recommendation: "looks-fine" }),
    );
    expect(recommendationResult.diagnostics).toContainEqual({
      path: "acceptance_recommendation",
      expected: ENUM_VALUES.acceptance_recommendation.join(" | "),
      got: '"looks-fine"',
    });

    const methodResult = validateReviewReport(
      toYaml({ ...base, method_applied: "thorough" }),
    );
    expect(methodResult.diagnostics).toContainEqual({
      path: "method_applied",
      expected: ENUM_VALUES.method_applied.join(" | "),
      got: '"thorough"',
    });
  });
});

describe("validateReviewReport: never implies acceptance", () => {
  it("STRUCTURAL_ONLY_NOTE names semantic adequacy, waivers, and orchestrator acceptance", () => {
    expect(STRUCTURAL_ONLY_NOTE).toContain("does not judge semantic adequacy");
    expect(STRUCTURAL_ONLY_NOTE).toContain("cannot waive findings");
    expect(STRUCTURAL_ONLY_NOTE).toContain(
      "does not constitute orchestrator acceptance",
    );
  });

  it("passing validation never prints an accepting word (accept/approve/pass the review)", () => {
    const result = validateReviewReport(fixture("valid.yaml"));
    expect(result.valid).toBe(true);
    // The validator's own vocabulary is "structurally valid", never
    // "accepted"/"approved": those verbs belong to the orchestrator.
    expect(JSON.stringify(result).toLowerCase()).not.toMatch(
      /\baccepted\b|\bapproved\b/,
    );
  });
});

describe("validateReviewReport: malformed YAML", () => {
  it("reports a root-level diagnostic for unparsable YAML instead of throwing", () => {
    const result = validateReviewReport("```yaml\nstatus: [reviewed\n```\n");
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0].path).toBe("<root>");
  });

  it("reports a root-level diagnostic when the document is not a mapping", () => {
    const result = validateReviewReport("- just\n- a\n- list\n");
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      path: "<root>",
      expected: "a YAML mapping (object)",
    });
  });
});

describe("CLI: orchestrator-workflow validate-review-report", () => {
  function run(args: string[], input?: string) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "validate-review-report", ...args],
      {
        cwd: PACKAGE_DIR,
        encoding: "utf8",
        timeout: 30_000,
        input,
      },
    );
  }

  it("exits 0 for a valid file, printing the verdict and the structural-only note to the same stream (stdout)", () => {
    const result = run([join(FIXTURES_DIR, "valid.yaml")]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Structurally valid reviewer return.");
    // fix-round, review finding L5: the verdict and its qualifying note
    // must land on the same stream; previously the verdict printed to
    // stdout while the note printed to stderr, splitting one reading in
    // two.
    expect(result.stdout).toContain(STRUCTURAL_ONLY_NOTE);
    expect(result.stderr).toBe("");
  });

  it("exits 1 for a file missing acceptance_recommendation, naming the field and printing the note to the same stream (stdout)", () => {
    const result = run([
      join(FIXTURES_DIR, "missing-acceptance-recommendation.yaml"),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("acceptance_recommendation");
    expect(result.stdout).toContain(STRUCTURAL_ONLY_NOTE);
    expect(result.stderr).toBe("");
  });

  it("reads from stdin when given -", () => {
    const result = run(["-"], fixture("valid.yaml"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Structurally valid reviewer return.");
  });

  it("--format json prints a single JSON object with the diagnostics list", () => {
    const result = run([
      join(FIXTURES_DIR, "invalid-enum.yaml"),
      "--format",
      "json",
    ]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.diagnostics).toEqual([
      {
        path: "findings[0].severity",
        expected: ENUM_VALUES.severity.join(" | "),
        got: '"severe"',
      },
    ]);
    expect(parsed.note).toBe(STRUCTURAL_ONLY_NOTE);
  });

  it("exits 2 for an unreadable file, printing the note too (fix-round, review finding L5)", () => {
    const result = run([join(FIXTURES_DIR, "does-not-exist.yaml")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Could not read");
    expect(result.stderr).toContain(STRUCTURAL_ONLY_NOTE);
  });

  it("exits 2 for an unknown --format value, printing the note too (fix-round, review finding L5)", () => {
    const result = run([join(FIXTURES_DIR, "valid.yaml"), "--format", "xml"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown --format value");
    expect(result.stderr).toContain(STRUCTURAL_ONLY_NOTE);
  });

  it("exits 2 for a missing <file> argument, not 1 (fix-round, review finding L1)", () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing required argument");
  });

  it("exits 2 for an unknown option, the same usage-error code as a missing argument", () => {
    const result = run([join(FIXTURES_DIR, "valid.yaml"), "--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown option");
  });

  it("exits 2 for an excess positional argument instead of silently validating only the first (fix-round, review finding M1)", () => {
    const result = run([
      join(FIXTURES_DIR, "valid.yaml"),
      join(FIXTURES_DIR, "invalid-enum.yaml"),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("too many arguments");
  });

  it("a usage error (missing <file>) prints plain text to stderr and nothing to stdout even with --format json (fix-round, review finding L4: --format governs the validation verdict only, not commander's own usage errors)", () => {
    const result = run(["--format", "json"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing required argument");
    expect(result.stdout).toBe("");
  });
});

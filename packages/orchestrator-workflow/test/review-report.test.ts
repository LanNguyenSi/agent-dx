import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";

import {
  ARRAY_ELEMENT_EXPECTED,
  ENUM_VALUES,
  FIELD_KINDS,
  FINDING_FIELDS,
  MAPPING_LIST_ELEMENT_EXPECTED,
  REPRODUCTION_FIELDS,
  STRUCTURAL_ONLY_NOTE,
  TOP_LEVEL_FIELDS,
  WITHDRAWN_FIELDS,
  expectedTextFor,
  extractYamlSource,
  validateReviewReport,
} from "../src/review-report.js";
import type { FieldKind, SchemaFieldName } from "../src/review-report.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES_DIR = join(PACKAGE_DIR, "test/fixtures/review-report");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

/**
 * A fresh parse of `valid.yaml`'s inner document as a plain object, one
 * per call so a test that deletes a key never leaks that mutation into
 * another test. `valid.yaml` carries one fully-populated `findings[0]`
 * and `withdrawn[0]` entry, and a filled `reproduction`, precisely so
 * this doubles as the base document every generated case below mutates:
 * each field of each of the four contract constants has a real location
 * to delete or overwrite.
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

  it("a fenced snippet inside a description value does not close the block early: the closing fence must start at column 0 (fix-round, review finding L3)", () => {
    const raw = fixture("valid-inner-fence.yaml");
    const { yamlText, warnings } = extractYamlSource(raw);
    // The whole document survives extraction, including the indented
    // inner fence and every field written after it; the pre-fix pattern
    // closed the block at the inner fence and truncated the document
    // mid-value, which surfaced as diagnostics about fields the return
    // actually carried.
    expect(yamlText).toContain("const value = record[key];");
    expect(yamlText).toContain("method_applied: rigorous");
    expect(warnings).toEqual([]);

    const result = validateReviewReport(raw);
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("prefers a later ```yaml fence over an earlier untagged fence, warns the earlier fence was skipped, and does not also call it prose", () => {
    const raw = "```bash\necho not yaml\n```\n```yaml\nstatus: reviewed\n```\n";
    const { yamlText, warnings } = extractYamlSource(raw);
    expect(yamlText).toBe("status: reviewed");
    // Only the skip warning fires: the text preceding the chosen fence
    // is exactly the skipped ```bash fence plus whitespace, so the
    // before-warning (which would otherwise call that same fenced block
    // "prose") is suppressed.
    expect(warnings).toEqual([
      "1 earlier fenced block without a yaml/yml tag was skipped in favor of the later `yaml` fenced block; only that later block was validated",
    ]);
  });

  it("still warns about real prose ahead of a skipped fence, distinct from the skipped fence itself", () => {
    const raw =
      "Some notes first.\n```bash\necho not yaml\n```\n```yaml\nstatus: reviewed\n```\n";
    const { yamlText, warnings } = extractYamlSource(raw);
    expect(yamlText).toBe("status: reviewed");
    expect(warnings).toEqual([
      "1 earlier fenced block without a yaml/yml tag was skipped in favor of the later `yaml` fenced block; only that later block was validated",
      "prose found before the opening ```yaml fence; only the fenced block was validated",
    ]);
  });

  it("names the plural skip warning when two earlier fences are skipped for a yaml fence last (M4)", () => {
    const raw =
      "```bash\necho 1\n```\n```\necho 2\n```\n```yaml\nstatus: reviewed\n```\n";
    const { yamlText, warnings } = extractYamlSource(raw);
    expect(yamlText).toBe("status: reviewed");
    expect(warnings).toEqual([
      "2 earlier fenced blocks without a yaml/yml tag were skipped in favor of the later `yaml` fenced block; only that later block was validated",
    ]);
  });

  it("prefers a later yaml fence over CRLF-terminated skipped fences, with no stray \\r left in the chosen text (M3)", () => {
    const raw =
      "```bash\r\necho not yaml\r\n```\r\n```yaml\r\nstatus: reviewed\r\n```\r\n";
    const { yamlText, warnings } = extractYamlSource(raw);
    expect(yamlText).toBe("status: reviewed");
    expect(yamlText).not.toContain("\r");
    expect(warnings).toEqual([
      "1 earlier fenced block without a yaml/yml tag was skipped in favor of the later `yaml` fenced block; only that later block was validated",
    ]);
  });

  it("recognises a yaml tag followed by attributes (```yaml title=x), which the pre-widening capture matched no fence for at all", () => {
    const raw = "```yaml title=x\nstatus: reviewed\n```\n";
    const { yamlText, warnings } = extractYamlSource(raw);
    expect(yamlText).toBe("status: reviewed");
    expect(warnings).toEqual([]);
  });

  it("prefers a later ```yaml fence over an earlier ```bash title=x fence, recognising the attribute-bearing fence as skipped rather than as unmatched", () => {
    const raw =
      "```bash title=x\necho not yaml\n```\n```yaml\nstatus: reviewed\n```\n";
    const { yamlText, warnings } = extractYamlSource(raw);
    expect(yamlText).toBe("status: reviewed");
    expect(warnings).toEqual([
      "1 earlier fenced block without a yaml/yml tag was skipped in favor of the later `yaml` fenced block; only that later block was validated",
    ]);
  });

  it("prefers a later ```yaml title=x fence over an earlier plain untagged fence: the tag test reads only the first word, not the whole info string", () => {
    const raw =
      "```bash\necho not yaml\n```\n```yaml title=x\nstatus: reviewed\n```\n";
    const { yamlText, warnings } = extractYamlSource(raw);
    expect(yamlText).toBe("status: reviewed");
    expect(warnings).toEqual([
      "1 earlier fenced block without a yaml/yml tag was skipped in favor of the later `yaml` fenced block; only that later block was validated",
    ]);
  });

  it("keeps first-fence behaviour when neither of two fences is tagged yaml/yml", () => {
    const raw = "```\nstatus: reviewed\n```\n```\nrole: reviewer\n```\n";
    const { yamlText, warnings } = extractYamlSource(raw);
    expect(yamlText).toBe("status: reviewed");
    // No skip warning (neither fence is tagged yaml/yml, so the first is
    // kept, as before this task); the second fence still reads as
    // trailing prose after the chosen (first) one, same as any other
    // discarded trailing text.
    expect(warnings).toEqual([
      "prose found after the closing ```yaml fence; only the fenced block was validated",
    ]);
  });

  it("treats a ```yml tag the same as ```yaml", () => {
    const raw = "```yml\nstatus: reviewed\n```\n";
    const { yamlText, warnings } = extractYamlSource(raw);
    expect(yamlText).toBe("status: reviewed");
    expect(warnings).toEqual([]);
  });

  it("prefers a ```yaml fence found after an earlier untagged fence, the same as one found after a differently-tagged fence", () => {
    const raw = "```\nrole: reviewer\n```\n```yaml\nstatus: reviewed\n```\n";
    const { yamlText, warnings } = extractYamlSource(raw);
    expect(yamlText).toBe("status: reviewed");
    expect(warnings).toEqual([
      "1 earlier fenced block without a yaml/yml tag was skipped in favor of the later `yaml` fenced block; only that later block was validated",
    ]);
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

/**
 * Schema-derived coverage. ONE generator, driven by the four contract
 * constants and by the per-field `FIELD_KINDS` descriptor they sit next
 * to in `src/review-report.ts`, produces every case in this block. It
 * replaces the three hand-enumerated tables earlier rounds added (a
 * deletion table, an enum table, a predicate table): each of those
 * enumerated one kind of check, and each time the next kind turned out
 * to be unpinned -- the wrong-type and wrong-shape rejection branches
 * survived a full suite while a comment claimed type was covered.
 * Deriving the cases from the schema is what closes that class: a field
 * cannot sit in a constant without a declared kind (a compile error in
 * `FIELD_KINDS`) or without a checker (a compile error in the dispatch
 * tables), and a kind cannot exist without its own input classes here (a
 * compile error in `REJECTED_VALUES`/`ACCEPTED_VALUES`).
 *
 * What the generated cases pin, for every field of every constant:
 *
 * - presence: a deleted key is exactly one `missing` diagnostic at that
 *   field's path;
 * - type: every JS type the declared kind rejects (a number, a string,
 *   an array, a mapping, a YAML boolean, and a bare `key:` that parses
 *   as null) is exactly one diagnostic at that path;
 * - enum membership: a string outside the enum is rejected, a YAML
 *   boolean is rejected (the `yes`/`no` spellings are strings, not
 *   booleans), and every spelling the enum does list is accepted;
 * - non-emptiness: an empty string and a blank one are both rejected
 *   where the kind is `non-empty-string`, and the empty string is
 *   accepted where the kind is `string`;
 * - scalar tolerance: a number is accepted where the kind is `scalar`
 *   and rejected where it is `string`;
 * - container shape: a non-array `findings`/`withdrawn` and a
 *   non-mapping `reproduction` are rejected at the container's own path,
 *   a scalar or null element at the element's path, and an empty list is
 *   accepted;
 * - array element kind: a non-string element (a number, a mapping) of a
 *   plain `array`-kind field (`summary`, `missing_tests`,
 *   `residual_risks`) is rejected at `<field>[<index>]`, expecting
 *   `string`, while an empty-array field and a string element (including
 *   an empty string) are accepted;
 * - the diagnostic itself: path, `expected` (the schema's own
 *   `expectedTextFor`, never a text retyped here) and `got` are asserted
 *   in full, and a rejecting case must produce exactly one diagnostic,
 *   so a checker that also fires at another path fails as well.
 *
 * What it does not pin: semantic adequacy or any cross-field rule, which
 * this validator deliberately never judges; and a rule added INSIDE an
 * existing checker without a new FieldKind (a length bound on a string,
 * say) is generated for by nothing here and needs its own kind or its
 * own named test to be pinned. Emptiness of a plain `array`-kind
 * field's own string elements is likewise not judged (see
 * {@link checkArrayField}'s own doc comment in `src/review-report.ts`).
 *
 * Where a new field or kind must be declared: a new contract field goes
 * into its constant, into the matching dispatch table, and into
 * `FIELD_KINDS`, which are typed against each other; a new kind goes
 * into `FieldKind`, into `KIND_EXPECTED` (both in `src`), and into
 * `REJECTED_VALUES` and `ACCEPTED_VALUES` below. Nothing else needs a
 * new test: the cases for that field or kind are generated from those
 * declarations.
 */
describe("validateReviewReport: schema-derived coverage of every field and input class", () => {
  /** One input value, with the rendering the validator gives it in `got`. */
  interface ProbeValue {
    label: string;
    value: unknown;
    got: string;
  }

  const NUMBER: ProbeValue = { label: "a number", value: 42, got: "42" };
  const TEXT: ProbeValue = {
    label: "a string",
    value: "a plain string",
    got: '"a plain string"',
  };
  const ARRAY: ProbeValue = {
    label: "an array",
    value: ["x"],
    got: "array(length=1)",
  };
  const MAPPING: ProbeValue = {
    label: "a mapping",
    value: { nested: "v" },
    got: "mapping",
  };
  const BOOLEAN: ProbeValue = {
    label: "a YAML boolean",
    value: true,
    got: "true",
  };
  const NULL: ProbeValue = {
    label: "null (a key written with no value)",
    value: null,
    got: "null",
  };
  const EMPTY_STRING: ProbeValue = {
    label: "an empty string",
    value: "",
    got: '""',
  };
  const BLANK_STRING: ProbeValue = {
    label: "a blank (whitespace-only) string",
    value: "   ",
    got: '"   "',
  };
  const EMPTY_ARRAY: ProbeValue = {
    label: "an empty array",
    value: [],
    got: "array(length=0)",
  };
  const NUMERIC_STRING: ProbeValue = {
    label: "a numeric string",
    value: "5",
    got: '"5"',
  };
  const OUT_OF_ENUM: ProbeValue = {
    label: "a string outside the enum",
    value: "not-a-real-enum-value",
    got: '"not-a-real-enum-value"',
  };

  /**
   * Values every field of that kind must reject. Keyed by `FieldKind`, so
   * a kind added to the schema without its own rejected values fails to
   * typecheck instead of generating no cases.
   */
  const REJECTED_VALUES: Record<FieldKind, readonly ProbeValue[]> = {
    enum: [NUMBER, ARRAY, MAPPING, BOOLEAN, NULL],
    string: [NUMBER, ARRAY, MAPPING, BOOLEAN, NULL],
    "non-empty-string": [
      NUMBER,
      ARRAY,
      MAPPING,
      BOOLEAN,
      NULL,
      EMPTY_STRING,
      BLANK_STRING,
    ],
    scalar: [ARRAY, MAPPING, BOOLEAN, NULL],
    array: [NUMBER, TEXT, MAPPING, BOOLEAN, NULL],
    "mapping-list": [NUMBER, TEXT, MAPPING, BOOLEAN, NULL],
    mapping: [NUMBER, TEXT, ARRAY, BOOLEAN, NULL],
  };

  /**
   * Values every field of that kind must accept, which is what separates
   * one kind from its neighbours: the empty string separates `string`
   * from `non-empty-string`, a number separates `scalar` from `string`,
   * and an empty list separates `array`/`mapping-list` from a checker
   * that demanded content. `enum` is empty here because its accepted
   * values are the enum's own spellings, generated per field below.
   */
  const ACCEPTED_VALUES: Record<FieldKind, readonly ProbeValue[]> = {
    enum: [],
    string: [EMPTY_STRING, TEXT],
    "non-empty-string": [TEXT],
    scalar: [NUMBER, NUMERIC_STRING],
    array: [EMPTY_ARRAY, ARRAY],
    "mapping-list": [EMPTY_ARRAY],
    mapping: [],
  };

  /** Elements a `mapping-list` must reject at the element's own path. */
  const NON_MAPPING_ELEMENTS: readonly ProbeValue[] = [NUMBER, NULL];

  /** Elements a plain `array`-kind field must reject at the element's own path. */
  const NON_STRING_ELEMENTS: readonly ProbeValue[] = [
    NUMBER,
    MAPPING,
    NULL,
    BOOLEAN,
  ];

  /**
   * The four contract constants, each with the validator's own path
   * format for its fields and the record inside a fresh `validDoc()` that
   * owns them. `valid.yaml` carries one fully populated `findings[0]`,
   * one `withdrawn[0]` and a filled `reproduction` precisely so every
   * field of every constant has a real location to mutate.
   */
  interface Level {
    constant: string;
    fields: readonly SchemaFieldName[];
    path: (field: string) => string;
    owner: (doc: Record<string, any>) => Record<string, unknown>;
  }

  const LEVELS: readonly Level[] = [
    {
      constant: "TOP_LEVEL_FIELDS",
      fields: TOP_LEVEL_FIELDS,
      path: (field) => field,
      owner: (doc) => doc,
    },
    {
      constant: "FINDING_FIELDS",
      fields: FINDING_FIELDS,
      path: (field) => `findings[0].${field}`,
      owner: (doc) => doc.findings[0],
    },
    {
      constant: "REPRODUCTION_FIELDS",
      fields: REPRODUCTION_FIELDS,
      path: (field) => `reproduction.${field}`,
      owner: (doc) => doc.reproduction,
    },
    {
      constant: "WITHDRAWN_FIELDS",
      fields: WITHDRAWN_FIELDS,
      path: (field) => `withdrawn[0].${field}`,
      owner: (doc) => doc.withdrawn[0],
    },
  ];

  type CaseClass = "missing" | "wrong-type" | "out-of-enum" | "accepted";

  interface GeneratedCase {
    name: string;
    constant: string;
    field: SchemaFieldName;
    kind: FieldKind;
    klass: CaseClass;
    apply: (doc: Record<string, any>) => void;
    /**
     * The single diagnostic this case must produce, or `undefined` for an
     * accepted case, which must produce none.
     */
    diagnostic?: { path: string; expected: string; got: string };
  }

  function buildCases(): GeneratedCase[] {
    const cases: GeneratedCase[] = [];
    for (const level of LEVELS) {
      for (const field of level.fields) {
        const kind: FieldKind = FIELD_KINDS[field];
        const path = level.path(field);
        const expected = expectedTextFor(field);
        const common = { constant: level.constant, field, kind };
        const setter =
          (value: unknown) =>
          (doc: Record<string, any>): void => {
            level.owner(doc)[field] = value;
          };

        cases.push({
          ...common,
          name: `${path} (${kind}): a deleted key is one missing diagnostic`,
          klass: "missing",
          apply: (doc) => {
            delete level.owner(doc)[field];
          },
          diagnostic: { path, expected, got: "missing" },
        });

        for (const probe of REJECTED_VALUES[kind]) {
          cases.push({
            ...common,
            name: `${path} (${kind}): rejects ${probe.label}`,
            klass: "wrong-type",
            apply: setter(probe.value),
            diagnostic: { path, expected, got: probe.got },
          });
        }

        if (kind === "enum") {
          cases.push({
            ...common,
            name: `${path} (enum): rejects ${OUT_OF_ENUM.label}`,
            klass: "out-of-enum",
            apply: setter(OUT_OF_ENUM.value),
            diagnostic: { path, expected, got: OUT_OF_ENUM.got },
          });
          for (const allowed of ENUM_VALUES[field]) {
            cases.push({
              ...common,
              name: `${path} (enum): accepts the spelling "${allowed}"`,
              klass: "accepted",
              apply: setter(allowed),
            });
          }
        }

        if (kind === "mapping-list") {
          for (const probe of NON_MAPPING_ELEMENTS) {
            cases.push({
              ...common,
              name: `${path} (mapping-list): rejects an element that is ${probe.label}`,
              klass: "wrong-type",
              apply: setter([probe.value]),
              diagnostic: {
                path: `${path}[0]`,
                expected: MAPPING_LIST_ELEMENT_EXPECTED,
                got: probe.got,
              },
            });
          }
        }

        if (kind === "array") {
          for (const probe of NON_STRING_ELEMENTS) {
            cases.push({
              ...common,
              name: `${path} (array): rejects an element that is ${probe.label}`,
              klass: "wrong-type",
              apply: setter([probe.value]),
              diagnostic: {
                path: `${path}[0]`,
                expected: ARRAY_ELEMENT_EXPECTED,
                got: probe.got,
              },
            });
          }
        }

        for (const probe of ACCEPTED_VALUES[kind]) {
          cases.push({
            ...common,
            name: `${path} (${kind}): accepts ${probe.label}`,
            klass: "accepted",
            apply: setter(probe.value),
          });
        }
      }
    }
    return cases;
  }

  const CASES = buildCases();

  function casesFor(level: Level, field: SchemaFieldName): GeneratedCase[] {
    return CASES.filter(
      (entry) => entry.constant === level.constant && entry.field === field,
    );
  }

  it("self-check: every constant entry has at least a missing and a wrong-type case, and no case names a field no constant declares", () => {
    for (const level of LEVELS) {
      for (const field of level.fields) {
        const label = `${level.constant}.${field}`;
        const classes = casesFor(level, field).map((entry) => entry.klass);
        expect(classes, label).toContain("missing");
        expect(classes, label).toContain("wrong-type");
        expect(classes.length, label).toBeGreaterThanOrEqual(2);
      }
    }
    const covered = [
      ...new Set(CASES.map((entry) => `${entry.constant}.${entry.field}`)),
    ].sort();
    const declared = LEVELS.flatMap((level) =>
      level.fields.map((field) => `${level.constant}.${field}`),
    ).sort();
    expect(covered).toEqual(declared);
  });

  it("self-check: every enum-kind field is declared in ENUM_VALUES and gets an out-of-enum case plus one accepted case per spelling", () => {
    const enumFields = Object.entries(FIELD_KINDS)
      .filter(([, kind]) => kind === "enum")
      .map(([field]) => field)
      .sort();
    expect(enumFields).toEqual(Object.keys(ENUM_VALUES).sort());
    for (const level of LEVELS) {
      for (const field of level.fields) {
        if (FIELD_KINDS[field] !== "enum") continue;
        const label = `${level.constant}.${field}`;
        const classes = casesFor(level, field).map((entry) => entry.klass);
        expect(classes, label).toContain("out-of-enum");
        expect(
          classes.filter((klass) => klass === "accepted").length,
          label,
        ).toBe(ENUM_VALUES[field].length);
      }
    }
  });

  it("self-check: the generated case count per constant array", () => {
    const counts: Record<string, number> = {};
    for (const entry of CASES) {
      counts[entry.constant] = (counts[entry.constant] ?? 0) + 1;
    }
    // Fields times input classes, per constant. These numbers move only
    // when the contract gains a field or an enum spelling, or when a kind
    // gains an input class: each is a deliberate change, so update the
    // numbers together with it rather than loosening this to a bound. A
    // generator whose case list was emptied or shortened fails here
    // whatever else it still produces.
    expect(counts).toEqual({
      TOP_LEVEL_FIELDS: 106,
      FINDING_FIELDS: 60,
      REPRODUCTION_FIELDS: 31,
      WITHDRAWN_FIELDS: 16,
    });
  });

  // A plain loop rather than `it.each`, which renders an interpolated
  // `$name` through a truncating inspector: several generated cases for
  // one field then read identically in the report, and a failing case is
  // no longer identifiable by its own title.
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const doc = validDoc();
      testCase.apply(doc);
      const result = validateReviewReport(stringifyYaml(doc));
      if (testCase.diagnostic === undefined) {
        expect(result.diagnostics).toEqual([]);
        expect(result.valid).toBe(true);
        return;
      }
      expect(result.diagnostics).toEqual([testCase.diagnostic]);
      expect(result.valid).toBe(false);
    });
  }

  it("rejects a YAML boolean where the enum spells yes/no, with a diagnostic naming the three spellings", () => {
    const doc = validDoc();
    (doc.findings as Record<string, unknown>[])[0].introduced_by_delta = true;
    const result = validateReviewReport(stringifyYaml(doc));
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        path: "findings[0].introduced_by_delta",
        expected: "yes | no | unknown",
        got: "true",
      },
    ]);
  });

  it("accepts an unknown extra top-level key: the contract's fields are required, additions are not forbidden", () => {
    const doc = validDoc();
    doc.an_extra_key_the_contract_does_not_name = "some value";
    const result = validateReviewReport(stringifyYaml(doc));
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("validateReviewReport: array element-kind edge cases beyond the generated single-element probes", () => {
  it("reports one diagnostic per offending element, each at its own index, alongside untouched valid elements", () => {
    const doc = validDoc();
    doc.summary = ["a real bullet", 42, { nested: "v" }, "another bullet"];
    const result = validateReviewReport(stringifyYaml(doc));
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      { path: "summary[1]", expected: "string", got: "42" },
      { path: "summary[2]", expected: "string", got: "mapping" },
    ]);
  });

  it("accepts an empty string element: emptiness is not judged, only element kind", () => {
    const doc = validDoc();
    doc.missing_tests = ["", "   ", "a real gap"];
    const result = validateReviewReport(stringifyYaml(doc));
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("checks missing_tests and residual_risks independently of summary and of each other", () => {
    const doc = validDoc();
    doc.missing_tests = [7];
    doc.residual_risks = [{ nested: "v" }];
    const result = validateReviewReport(stringifyYaml(doc));
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      { path: "missing_tests[0]", expected: "string", got: "7" },
      { path: "residual_risks[0]", expected: "string", got: "mapping" },
    ]);
  });

  it("rejects a bare blank bullet and a ~ bullet as null, not as an empty string", () => {
    // A bare `- ` or `- ~` bullet parses as YAML null, not as an empty
    // string: only an explicitly quoted placeholder is a string that
    // passes. `stringifyYaml`'s own rendering of a JS `null` element
    // would write `- null`, not a bare bullet, so this is asserted
    // against literal YAML source text instead of a stringified doc, the
    // same way `extractYamlSource`'s own fence tests read raw text.
    const raw = [
      "status: reviewed",
      "role: reviewer",
      "task_id: T-003",
      "summary:",
      "  - ",
      "  - ~",
      '  - ""',
      "findings: []",
      "acceptance_recommendation: accept_with_notes",
      "missing_tests: []",
      "residual_risks: []",
      "reproduction:",
      '  method: ""',
      '  sample_size: ""',
      '  result: ""',
      "  matches_implementer_claim: not_applicable",
      "method_applied: normal",
      "withdrawn: []",
      "",
    ].join("\n");
    const result = validateReviewReport(raw);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      { path: "summary[0]", expected: "string", got: "null" },
      { path: "summary[1]", expected: "string", got: "null" },
    ]);
  });
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

  it("exits 2 for an unreadable file with --format json, emitting the JSON envelope on stdout (the documented exception to plain-text usage errors)", () => {
    const result = run([
      join(FIXTURES_DIR, "does-not-exist.yaml"),
      "--format",
      "json",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      valid: boolean;
      diagnostics: Array<{ path: string; expected: string; got: string }>;
      note: string;
    };
    expect(parsed.valid).toBe(false);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0].path).toBe("<file>");
    expect(parsed.diagnostics[0].expected).toBe("a readable file");
    expect(parsed.diagnostics[0].got).toContain("does-not-exist.yaml");
    expect(parsed.note).toBe(STRUCTURAL_ONLY_NOTE);
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

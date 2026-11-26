/**
 * The invariant of the `ow` briefing, over a cross product: whatever the
 * Non-goal `paths` entry and whatever the binding path, `buildOwExport`
 * either refuses with a named error or prints a briefing in which no entry
 * of `allowed_changes_hint` is covered by an entry of `forbidden_changes`.
 *
 * The table is judged by an oracle written for this file, which shares no
 * code with `src/exporters/paths.ts`: it reads a glob through regular
 * expressions, one per reading of its `**` segments, where the exporter
 * runs a state machine. The refusals are declared by hand per table row,
 * and a list of pinned cells states the expected outcome literally, so the
 * oracle and the exporter cannot be wrong in the same way unnoticed.
 */
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  parseBindings,
  parseSpec,
  parseTestPlan,
  type Bindings,
  type Spec,
  type TestPlan,
} from "../../src/formats/index.js";
import { ExportError } from "../../src/exporters/index.js";
import type { MergedInputs } from "../../src/exporters/merged.js";
import { buildOwExport } from "../../src/exporters/ow.js";
import { SPEC_REL, fixtureText } from "./repo.js";

const SPEC_MD = `${SPEC_REL}/spec.md`;
const TESTPLAN = `${SPEC_REL}/testplan.yaml`;

/** What the exporter adds to the hint whatever the bindings say. */
const BUILT_IN = [
  `${SPEC_REL}/bindings.yaml`,
  `${SPEC_REL}/bindings.log`,
  `${SPEC_REL}/evidence/`,
];

function parsed<T>(
  result: { ok: true; value: T } | { ok: false; errors: unknown },
): T {
  if (!result.ok) {
    throw new Error(`fixture does not parse: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

const SPEC: Spec = parsed(parseSpec(fixtureText("spec.md")));
const TEST_PLAN: TestPlan = parsed(parseTestPlan(fixtureText("testplan.yaml")));
const BINDINGS: Bindings = parsed(parseBindings(fixtureText("bindings.yaml")));

/** The paths the fixture bindings bring, none of them near a table entry. */
const FIXTURE_PATHS = [
  "test/typecheck.spec.ts",
  "test/auth.test.ts",
  "test/fixtures/tokens.json",
  "test/fixtures/users.json",
];

type Verdict = "ok" | "nongoal-path-not-canonical" | "nongoal-glob-unsupported";

/** Non-goal `paths` entries and what export must make of the entry itself. */
const NON_GOALS: readonly (readonly [string, Verdict])[] = [
  // Canonical directories and files.
  ["src/legacy", "ok"],
  ["src/legacy/", "ok"],
  ["src/legacy/a.test.ts", "ok"],
  ["src", "ok"],
  ["src/", "ok"],
  ["test", "ok"],
  ["README.md", "ok"],
  ["specs/s1", "ok"],
  ["specs/s1/evidence", "ok"],
  ["specs/s1/evidence/run.json", "ok"],
  ["specs/s1/evidence/*", "ok"],
  ["specs/s1/bindings.log", "ok"],
  // A glob at the start.
  ["*", "ok"],
  ["**", "ok"],
  ["*/legacy", "ok"],
  ["**/legacy", "ok"],
  ["**/a.test.ts", "ok"],
  ["**/*.test.ts", "ok"],
  ["*.md", "ok"],
  ["s*", "ok"],
  // A glob in the middle.
  ["src/*/a.test.ts", "ok"],
  ["src/**/a.test.ts", "ok"],
  ["src/leg*cy", "ok"],
  ["src/leg**cy", "ok"],
  ["src/*/b", "ok"],
  ["src/**/b", "ok"],
  ["src/**/**/b", "ok"],
  ["specs/*/spec.md", "ok"],
  // A glob at the end, and globs that match a directory.
  ["src/leg*", "ok"],
  ["src/legacy*", "ok"],
  ["src/leg*/", "ok"],
  ["src/*", "ok"],
  ["src/**", "ok"],
  ["src/**/", "ok"],
  ["src/legacy/*", "ok"],
  ["src/legacy/**", "ok"],
  ["src/legacy/*.ts", "ok"],
  ["src/*.gen.ts", "ok"],
  ["src/legacy***", "ok"],
  // Characters that are literal in a Non-goal entry.
  ["src/(legacy)", "ok"],
  ["src/legacy+x", "ok"],
  ["src/legacy.x", "ok"],
  ["!src/legacy", "ok"],
  // Spellings export refuses to read as a path.
  ["./src/legacy", "nongoal-path-not-canonical"],
  ["./src/legacy/", "nongoal-path-not-canonical"],
  ["src/legacy//", "nongoal-path-not-canonical"],
  ["src//legacy", "nongoal-path-not-canonical"],
  ["src/./legacy", "nongoal-path-not-canonical"],
  ["src/legacy/.", "nongoal-path-not-canonical"],
  ["src/legacy/./", "nongoal-path-not-canonical"],
  ["src/x/../legacy", "nongoal-path-not-canonical"],
  ["..", "nongoal-path-not-canonical"],
  ["/src/legacy", "nongoal-path-not-canonical"],
  ["src\\legacy", "nongoal-path-not-canonical"],
  ["/", "nongoal-path-not-canonical"],
  ["", "nongoal-path-not-canonical"],
  ["./src/leg?cy", "nongoal-path-not-canonical"],
  // Glob syntax export does not implement.
  ["src/leg?cy/*", "nongoal-glob-unsupported"],
  ["src/leg?cy", "nongoal-glob-unsupported"],
  ["src/[l]egacy", "nongoal-glob-unsupported"],
  ["src/[legacy", "nongoal-glob-unsupported"],
  ["src/legacy]", "nongoal-glob-unsupported"],
  ["src/{legacy,x}", "nongoal-glob-unsupported"],
  ["src/{legacy", "nongoal-glob-unsupported"],
  ["src/legacy}", "nongoal-glob-unsupported"],
  ["src/leg[ac]y/**", "nongoal-glob-unsupported"],
];

type Field = "file" | "fixtures";
type BindingVerdict = "ok" | "binding-path-not-canonical" | "binding-path-glob";

/** Binding paths, the field that carries them, and what export must make of them. */
const BINDING_PATHS: readonly (readonly [Field, string, BindingVerdict])[] = [
  // Below, equal, beside, above and next to the Non-goal entries.
  ["file", "src/legacy/a.test.ts", "ok"],
  ["file", "src/legacy/b/a.test.ts", "ok"],
  ["file", "src/legacy", "ok"],
  ["fixtures", "src/legacy", "ok"],
  ["fixtures", "src/legacy/", "ok"],
  ["file", "src/legacy-x/a.test.ts", "ok"],
  ["file", "src/legacy-x", "ok"],
  ["file", "src/legacyx.ts", "ok"],
  ["file", "src/legacy.x", "ok"],
  ["file", "src/legacyAx", "ok"],
  ["file", "src/leg/a.test.ts", "ok"],
  ["file", "src/legcy", "ok"],
  ["file", "src/leg/a/cy", "ok"],
  ["file", "src/a.test.ts", "ok"],
  ["file", "src/a.gen.ts", "ok"],
  ["file", "src/sub/a.gen.ts", "ok"],
  ["file", "src/b/a.test.ts", "ok"],
  ["file", "src/b", "ok"],
  ["file", "src/x/b/c.ts", "ok"],
  ["file", "src/x/y/b", "ok"],
  ["file", "src/xb", "ok"],
  ["file", "xa.test.ts", "ok"],
  ["fixtures", "src", "ok"],
  ["fixtures", "src/", "ok"],
  ["file", "srcx/legacy/a.test.ts", "ok"],
  ["file", "lib/legacy/a.test.ts", "ok"],
  ["file", "lib/x/legacy/a.test.ts", "ok"],
  ["file", "a.test.ts", "ok"],
  ["file", "README.md", "ok"],
  ["file", "test/other.test.ts", "ok"],
  // A name git tells apart from the Non-goal path, and literal characters.
  ["file", "src/Legacy/a.test.ts", "ok"],
  ["file", "src/(legacy)/a.test.ts", "ok"],
  ["file", "src/[legacy]/a.test.ts", "ok"],
  ["file", "!src/legacy/a.test.ts", "ok"],
  // The spec directory and its own files.
  ["file", SPEC_MD, "ok"],
  ["fixtures", SPEC_MD, "ok"],
  ["file", TESTPLAN, "ok"],
  ["fixtures", `${TESTPLAN}/`, "ok"],
  ["fixtures", `${SPEC_MD}/x`, "ok"],
  ["fixtures", SPEC_REL, "ok"],
  ["fixtures", `${SPEC_REL}/`, "ok"],
  ["fixtures", "specs", "ok"],
  ["file", `${SPEC_REL}/notes.md`, "ok"],
  ["file", `${SPEC_REL}/spec.mdx`, "ok"],
  ["file", "specs/s10/spec.md", "ok"],
  ["file", "specs/s2/spec.md", "ok"],
  ["fixtures", `${SPEC_REL}/evidence/run.json`, "ok"],
  // Spellings export refuses to read as a path.
  ["file", "./src/legacy/a.test.ts", "binding-path-not-canonical"],
  ["file", "src/legacy//a.test.ts", "binding-path-not-canonical"],
  ["file", "src/./legacy/a.test.ts", "binding-path-not-canonical"],
  ["file", "src/legacy/.", "binding-path-not-canonical"],
  ["file", "src/legacy/a.test.ts/", "binding-path-not-canonical"],
  ["file", "src/x/../legacy/a.test.ts", "binding-path-not-canonical"],
  ["file", "/src/legacy/a.test.ts", "binding-path-not-canonical"],
  ["file", "src\\legacy\\a.test.ts", "binding-path-not-canonical"],
  ["file", "", "binding-path-not-canonical"],
  ["file", `./${SPEC_MD}`, "binding-path-not-canonical"],
  ["file", "specs/s1//spec.md", "binding-path-not-canonical"],
  ["file", `${TESTPLAN}/`, "binding-path-not-canonical"],
  ["fixtures", "./src/legacy/", "binding-path-not-canonical"],
  ["fixtures", "src/legacy//", "binding-path-not-canonical"],
  ["fixtures", "src/legacy/./", "binding-path-not-canonical"],
  ["fixtures", "/", "binding-path-not-canonical"],
  ["fixtures", `${SPEC_REL}//spec.md`, "binding-path-not-canonical"],
  // A binding names one path, never a pattern.
  ["file", "src/*", "binding-path-glob"],
  ["fixtures", "src/**", "binding-path-glob"],
  ["fixtures", "**/", "binding-path-glob"],
  ["file", "src/legac?/a.test.ts", "binding-path-glob"],
  ["fixtures", "test/*.json", "binding-path-glob"],
];

/** The spec with `NG-1` carrying exactly this `paths` entry. */
function specWith(nonGoal: string): Spec {
  return {
    ...SPEC,
    nonGoals: SPEC.nonGoals.map((line) =>
      line.id === "NG-1" ? { ...line, paths: [nonGoal] } : line,
    ),
  };
}

/** The fixture bindings plus a `TP-9` binding that carries the path. */
function bindingsWith(field: Field, value: string): Bindings {
  return {
    ...BINDINGS,
    "TP-9":
      field === "file"
        ? { status: "existing", file: value, fixtures: [] }
        : { status: "existing", file: "test/x.test.ts", fixtures: [value] },
  };
}

function inputs(
  spec: Spec,
  bindings: Bindings,
  specRel = SPEC_REL,
): MergedInputs {
  return {
    spec,
    testPlan: TEST_PLAN,
    bindings,
    toplevel: "/repo",
    commit: "0".repeat(40),
    specRel,
  };
}

interface Briefing {
  forbidden: string[];
  hint: string[];
}

type Outcome =
  { refused: string; message: string } | { refused: null; briefing: Briefing };

function exportOf(spec: Spec, bindings: Bindings, specRel = SPEC_REL): Outcome {
  let text: string;
  try {
    text = buildOwExport(inputs(spec, bindings, specRel), "sha256:test");
  } catch (err) {
    if (!(err instanceof ExportError)) throw err;
    return { refused: err.code, message: err.message };
  }
  const doc = parse(text) as {
    forbidden_changes: string[];
    allowed_changes_hint: string[];
  };
  return {
    refused: null,
    briefing: {
      forbidden: doc.forbidden_changes,
      hint: doc.allowed_changes_hint,
    },
  };
}

// ---------------------------------------------------------------------
// The oracle.
// ---------------------------------------------------------------------

/** A path or pattern without the one `/` that marks a directory. */
const bare = (entry: string): string => entry.replace(/\/$/, "");

/**
 * Every reading of a pattern: a segment that is exactly `**` stands for
 * any run of characters, or for no segment at all (it and one `/` next to
 * it are left out).
 */
function readings(pattern: string): string[] {
  let all: string[][] = [[]];
  for (const segment of pattern.split("/")) {
    all = all.flatMap((prefix) =>
      segment === "**"
        ? [[...prefix, segment], prefix]
        : [[...prefix, segment]],
    );
  }
  return all.filter((segments) => segments.length > 0).map((s) => s.join("/"));
}

/** One reading as a regular expression: `**` any run, `*` any run without `/`. */
function readingRegExp(reading: string): RegExp {
  const literal = (text: string): string =>
    text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  const source = reading
    .split("**")
    .map((part) => part.split("*").map(literal).join("[^/]*"))
    .join("[^]*");
  return new RegExp(`^(?:${source})$`, "u");
}

/** The path itself and every directory above it, longest first. */
function selfAndAncestors(path: string): string[] {
  const out = [path];
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] === "/") out.push(path.slice(0, i));
  }
  return out;
}

/** True when the forbidden entry covers the hint entry, both as printed. */
function oracleCovers(forbidden: string, hint: string): boolean {
  const patterns = readings(bare(forbidden)).map(readingRegExp);
  return selfAndAncestors(bare(hint)).some((path) =>
    patterns.some((pattern) => pattern.test(path)),
  );
}

// ---------------------------------------------------------------------
// The cross product.
// ---------------------------------------------------------------------

type Cell = "dropped" | "kept" | `refused: ${string}`;

/** What the exporter does with one binding path under one Non-goal entry. */
function cellOf(nonGoal: string, field: Field, value: string): Cell {
  const outcome = exportOf(specWith(nonGoal), bindingsWith(field, value));
  if (outcome.refused !== null) return `refused: ${outcome.refused}`;
  const { forbidden, hint } = outcome.briefing;
  // The invariant, on what was printed and nothing else.
  for (const allowed of hint) {
    for (const entry of forbidden) {
      expect(
        oracleCovers(entry, allowed),
        `hint entry ${JSON.stringify(allowed)} is covered by forbidden entry ${JSON.stringify(entry)}`,
      ).toBe(false);
    }
    expect(bare(allowed)).not.toBe(SPEC_MD);
    expect(bare(allowed)).not.toBe(TESTPLAN);
  }
  // The forbidden list is the Non-goal entry as written plus the two
  // normative files: the oracle judges the same entries the reader sees.
  expect(forbidden).toEqual([...new Set([nonGoal, SPEC_MD, TESTPLAN])].sort());
  // Nothing is dropped that no forbidden entry covers: every other
  // candidate is in the hint exactly when the oracle finds it uncovered.
  const others = [
    ...FIXTURE_PATHS,
    ...BUILT_IN,
    ...(field === "fixtures" ? ["test/x.test.ts"] : []),
  ].filter((path) => path !== value);
  for (const candidate of others) {
    expect(
      hint.includes(candidate),
      `candidate ${JSON.stringify(candidate)} under ${JSON.stringify(nonGoal)}`,
    ).toBe(!forbidden.some((entry) => oracleCovers(entry, candidate)));
  }
  return hint.includes(value) ? "kept" : "dropped";
}

/** What the oracle and the declared verdicts expect of the same cell. */
function expectedCell(
  nonGoal: readonly [string, Verdict],
  binding: readonly [Field, string, BindingVerdict],
): Cell {
  if (nonGoal[1] !== "ok") return `refused: ${nonGoal[1]}`;
  if (binding[2] !== "ok") return `refused: ${binding[2]}`;
  const forbidden = [nonGoal[0], SPEC_MD, TESTPLAN];
  return forbidden.some((entry) => oracleCovers(entry, binding[1]))
    ? "dropped"
    : "kept";
}

const label = (binding: readonly [Field, string, BindingVerdict]): string =>
  `${binding[0]} ${JSON.stringify(binding[1])}`;

describe("allowed_changes_hint never holds what forbidden_changes covers", () => {
  const totals: Record<string, number> = {};

  for (const nonGoal of NON_GOALS) {
    it(`Non-goal paths entry ${JSON.stringify(nonGoal[0])} against every binding path`, () => {
      const actual: Record<string, Cell> = {};
      const expected: Record<string, Cell> = {};
      for (const binding of BINDING_PATHS) {
        const cell = cellOf(nonGoal[0], binding[0], binding[1]);
        actual[label(binding)] = cell;
        expected[label(binding)] = expectedCell(nonGoal, binding);
        totals[cell] = (totals[cell] ?? 0) + 1;
      }
      expect(actual).toEqual(expected);
    });
  }

  it("covers every kind of outcome many times over", () => {
    // A table in which nothing is dropped, or nothing kept, proves nothing.
    expect(Object.keys(totals).sort()).toEqual([
      "dropped",
      "kept",
      "refused: binding-path-glob",
      "refused: binding-path-not-canonical",
      "refused: nongoal-glob-unsupported",
      "refused: nongoal-path-not-canonical",
    ]);
    for (const [kind, count] of Object.entries(totals)) {
      expect(count, kind).toBeGreaterThanOrEqual(100);
    }
    expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(
      NON_GOALS.length * BINDING_PATHS.length,
    );
  });
});

/**
 * Cells whose outcome is written down, not computed: the spellings three
 * reviews found, and one cell per rule.
 */
const PINNED: readonly (readonly [string, Field, string, Cell])[] = [
  // A Non-goal entry in another spelling used to cover nothing.
  [
    "./src/legacy",
    "file",
    "src/legacy/a.test.ts",
    "refused: nongoal-path-not-canonical",
  ],
  [
    "src/legacy//",
    "file",
    "src/legacy/a.test.ts",
    "refused: nongoal-path-not-canonical",
  ],
  [
    "src/./legacy",
    "file",
    "src/legacy/a.test.ts",
    "refused: nongoal-path-not-canonical",
  ],
  [
    "src/legacy/.",
    "file",
    "src/legacy/a.test.ts",
    "refused: nongoal-path-not-canonical",
  ],
  // A glob that matches a directory covers what lies below it.
  ["src/leg*", "file", "src/legacy/a.test.ts", "dropped"],
  ["src/leg*", "file", "src/legacy/b/a.test.ts", "dropped"],
  ["src/leg*", "file", "src/a.test.ts", "kept"],
  ["src/legacy*", "file", "src/legacy/a.test.ts", "dropped"],
  ["src/legacy*", "file", "src/legacy-x/a.test.ts", "dropped"],
  ["src/legacy*", "file", "src/leg/a.test.ts", "kept"],
  ["*/legacy", "file", "lib/legacy/a.test.ts", "dropped"],
  ["*/legacy", "file", "lib/x/legacy/a.test.ts", "kept"],
  // Glob syntax export does not implement is refused, not read literally.
  [
    "src/leg?cy/*",
    "file",
    "src/legacy/a.test.ts",
    "refused: nongoal-glob-unsupported",
  ],
  [
    "src/[l]egacy",
    "file",
    "src/legacy/a.test.ts",
    "refused: nongoal-glob-unsupported",
  ],
  [
    "src/{legacy,x}",
    "file",
    "src/legacy/a.test.ts",
    "refused: nongoal-glob-unsupported",
  ],
  // A literal entry covers itself and what lies below, and nothing else.
  ["src/legacy", "file", "src/legacy", "dropped"],
  ["src/legacy", "file", "src/legacy/a.test.ts", "dropped"],
  ["src/legacy", "file", "src/legacy/b/a.test.ts", "dropped"],
  ["src/legacy", "fixtures", "src/legacy/", "dropped"],
  ["src/legacy/", "file", "src/legacy/b/a.test.ts", "dropped"],
  ["src/legacy/", "file", "src/legacy", "dropped"],
  ["src/legacy", "file", "src/legacy-x/a.test.ts", "kept"],
  ["src/legacy", "file", "src/legacyx.ts", "kept"],
  ["src/legacy", "file", "src/Legacy/a.test.ts", "kept"],
  ["src/legacy", "fixtures", "src", "kept"],
  // `*` stays inside a segment, `**` does not.
  ["src/*.gen.ts", "file", "src/a.gen.ts", "dropped"],
  ["src/*.gen.ts", "file", "src/sub/a.gen.ts", "kept"],
  ["src/leg**cy", "file", "src/legacy", "dropped"],
  ["src/leg*cy", "file", "src/legcy", "dropped"],
  ["src/leg*cy", "file", "src/leg/a/cy", "kept"],
  ["src/leg**cy", "file", "src/leg/a/cy", "dropped"],
  ["src/legacy/**", "file", "src/legacy/b/a.test.ts", "dropped"],
  ["src/legacy/*", "file", "src/legacy/b/a.test.ts", "dropped"],
  ["src/legacy/*", "fixtures", "src/legacy/", "kept"],
  ["src/legacy/*", "fixtures", "src/legacy", "kept"],
  ["src/legacy/*.ts", "file", "src/legacy/b/a.test.ts", "kept"],
  // A `**` segment may stand for no directory at all.
  ["src/**/a.test.ts", "file", "src/a.test.ts", "dropped"],
  ["src/**/a.test.ts", "file", "src/legacy/b/a.test.ts", "dropped"],
  ["src/**/a.test.ts", "file", "a.test.ts", "kept"],
  ["src/*/a.test.ts", "file", "src/a.test.ts", "kept"],
  ["**/a.test.ts", "file", "a.test.ts", "dropped"],
  ["**/legacy", "file", "src/legacy/a.test.ts", "dropped"],
  ["src/**", "fixtures", "src", "dropped"],
  ["src/**", "file", "srcx/legacy/a.test.ts", "kept"],
  ["src/**/**/b", "file", "src/b", "dropped"],
  ["src/**/b", "file", "src/x/y/b", "dropped"],
  // A `**` segment that stands for something still needs its `/`.
  ["src/**/b", "file", "src/xb", "kept"],
  ["src/**/b", "file", "src/sub/a.gen.ts", "kept"],
  ["**/a.test.ts", "file", "xa.test.ts", "kept"],
  ["src/**", "file", "src/xb", "dropped"],
  // Every other character stands for itself.
  ["src/(legacy)", "file", "src/(legacy)/a.test.ts", "dropped"],
  ["src/(legacy)", "file", "src/legacy/a.test.ts", "kept"],
  ["src/legacy.x", "file", "src/legacy.x", "dropped"],
  ["src/legacy.x", "file", "src/legacyAx", "kept"],
  ["src/legacy+x", "file", "src/legacyx.ts", "kept"],
  // The spec's own files, whatever the Non-goal says.
  ["test", "file", SPEC_MD, "dropped"],
  ["test", "file", TESTPLAN, "dropped"],
  ["test", "fixtures", `${TESTPLAN}/`, "dropped"],
  ["test", "fixtures", `${SPEC_MD}/x`, "dropped"],
  ["test", "file", "specs/s10/spec.md", "kept"],
  ["test", "file", `${SPEC_REL}/spec.mdx`, "kept"],
  ["test", "fixtures", SPEC_REL, "kept"],
  ["specs/*/spec.md", "file", "specs/s2/spec.md", "dropped"],
  // A binding path in another spelling, or one that is a pattern.
  [
    "src/legacy",
    "file",
    "./src/legacy/a.test.ts",
    "refused: binding-path-not-canonical",
  ],
  [
    "src/legacy",
    "file",
    "src/legacy//a.test.ts",
    "refused: binding-path-not-canonical",
  ],
  [
    "src/legacy",
    "file",
    "src/legacy/a.test.ts/",
    "refused: binding-path-not-canonical",
  ],
  [
    "src/legacy",
    "fixtures",
    "src/legacy//",
    "refused: binding-path-not-canonical",
  ],
  ["src/legacy", "file", `./${SPEC_MD}`, "refused: binding-path-not-canonical"],
  [
    "src/legacy",
    "file",
    "specs/s1//spec.md",
    "refused: binding-path-not-canonical",
  ],
  ["src/legacy", "file", `${TESTPLAN}/`, "refused: binding-path-not-canonical"],
  ["src/legacy", "file", "src/*", "refused: binding-path-glob"],
  ["src/legacy", "fixtures", "src/**", "refused: binding-path-glob"],
  ["src/legacy", "file", "src/legac?/a.test.ts", "refused: binding-path-glob"],
  // The Non-goal entry is judged before the bindings are.
  [
    "./src/legacy",
    "file",
    "./src/legacy/a.test.ts",
    "refused: nongoal-path-not-canonical",
  ],
  ["src/leg?cy", "file", "src/*", "refused: nongoal-glob-unsupported"],
  // An entry with both faults is named by its spelling first.
  [
    "./src/leg?cy",
    "file",
    "src/legacy/a.test.ts",
    "refused: nongoal-path-not-canonical",
  ],
];

describe("pinned cells of the hint rule", () => {
  for (const [nonGoal, field, value, expected] of PINNED) {
    it(`${JSON.stringify(nonGoal)} with ${field} ${JSON.stringify(value)}: ${expected}`, () => {
      expect(cellOf(nonGoal, field, value)).toBe(expected);
    });
  }
});

describe("what the briefing prints around the rule", () => {
  it("keeps the exporter's own entries unless a Non-goal covers them", () => {
    const open = exportOf(specWith("src/legacy"), BINDINGS);
    expect(open.refused).toBeNull();
    if (open.refused !== null) return;
    expect(open.briefing.hint).toEqual([...BUILT_IN, ...FIXTURE_PATHS].sort());

    // The spec directory as a Non-goal covers all three.
    const closed = exportOf(specWith(SPEC_REL), BINDINGS);
    expect(closed.refused).toBeNull();
    if (closed.refused !== null) return;
    expect(closed.briefing.hint).toEqual([...FIXTURE_PATHS].sort());

    // The evidence directory alone, with and without its `/`.
    for (const entry of [`${SPEC_REL}/evidence`, `${SPEC_REL}/evidence/`]) {
      const one = exportOf(specWith(entry), BINDINGS);
      expect(one.refused).toBeNull();
      if (one.refused !== null) return;
      expect(one.briefing.hint).toEqual(
        [...BUILT_IN.slice(0, 2), ...FIXTURE_PATHS].sort(),
      );
    }

    // A file below the evidence directory, or a glob for its contents,
    // leaves the directory in: the rule judges an entry and what lies
    // above it, not what lies below.
    for (const entry of [
      `${SPEC_REL}/evidence/run.json`,
      `${SPEC_REL}/evidence/*`,
    ]) {
      const below = exportOf(specWith(entry), BINDINGS);
      expect(below.refused).toBeNull();
      if (below.refused !== null) return;
      expect(below.briefing.hint, entry).toContain(`${SPEC_REL}/evidence/`);
    }
  });

  it("empties the hint under a Non-goal that covers everything", () => {
    for (const entry of ["**", "*"]) {
      const all = exportOf(specWith(entry), bindingsWith("file", "src/a.ts"));
      expect(all.refused).toBeNull();
      if (all.refused !== null) return;
      expect(all.briefing.hint).toEqual([]);
    }
  });

  it("prints a fixtures directory as the binding spells it", () => {
    const run = exportOf(
      specWith("src/legacy"),
      bindingsWith("fixtures", "test/fixtures/big/"),
    );
    expect(run.refused).toBeNull();
    if (run.refused !== null) return;
    expect(run.briefing.hint).toContain("test/fixtures/big/");
    expect(run.briefing.hint).not.toContain("test/fixtures/big");
  });

  it("prints a Non-goal entry in forbidden_changes as the spec spells it", () => {
    const run = exportOf(specWith("src/legacy/"), BINDINGS);
    expect(run.refused).toBeNull();
    if (run.refused !== null) return;
    expect(run.briefing.forbidden).toEqual([
      "specs/s1/spec.md",
      "specs/s1/testplan.yaml",
      "src/legacy/",
    ]);
  });

  it("names the Non-goal line and the entry in a refusal", () => {
    const spelling = exportOf(specWith("src/legacy//"), BINDINGS);
    expect(spelling.refused).toBe("nongoal-path-not-canonical");
    if (spelling.refused === null) return;
    expect(spelling.message).toContain('NG-1: paths entry "src/legacy//"');

    const glob = exportOf(specWith("src/leg?cy/*"), BINDINGS);
    expect(glob.refused).toBe("nongoal-glob-unsupported");
    if (glob.refused === null) return;
    expect(glob.message).toContain('NG-1: paths entry "src/leg?cy/*"');
  });

  it("names the binding, the field and the path in a refusal", () => {
    const file = exportOf(SPEC, bindingsWith("file", "src/*"));
    expect(file.refused).toBe("binding-path-glob");
    if (file.refused === null) return;
    expect(file.message).toContain('binding TP-9: file "src/*"');

    const fixture = exportOf(SPEC, bindingsWith("fixtures", "a//"));
    expect(fixture.refused).toBe("binding-path-not-canonical");
    if (fixture.refused === null) return;
    expect(fixture.message).toContain('binding TP-9: fixtures[0] "a//"');
  });

  it("judges every paths entry of every Non-goal line", () => {
    const spec: Spec = {
      ...SPEC,
      nonGoals: SPEC.nonGoals.map((line) =>
        line.id === "NG-2" ? { ...line, paths: ["lib", "src/legacy//"] } : line,
      ),
    };
    const bad = exportOf(spec, BINDINGS);
    expect(bad.refused).toBe("nongoal-path-not-canonical");
    if (bad.refused === null) return;
    expect(bad.message).toContain('NG-2: paths entry "src/legacy//"');

    const good: Spec = {
      ...SPEC,
      nonGoals: SPEC.nonGoals.map((line) =>
        line.id === "NG-2" ? { ...line, paths: ["lib", "test/fix*"] } : line,
      ),
    };
    const run = exportOf(good, bindingsWith("file", "lib/a.test.ts"));
    expect(run.refused).toBeNull();
    if (run.refused !== null) return;
    expect(run.briefing.hint).toEqual(
      [...BUILT_IN, "test/auth.test.ts", "test/typecheck.spec.ts"].sort(),
    );
  });

  it("refuses a spec directory it cannot compare paths against", () => {
    for (const specRel of ["./specs/s1", "specs/s1/", "specs//s1", "specs/*"]) {
      const run = exportOf(SPEC, BINDINGS, specRel);
      expect(run.refused, specRel).toBe("spec-dir-invalid");
    }
    expect(exportOf(SPEC, BINDINGS, "specs/s1").refused).toBeNull();
  });

  it("judges a pattern of many stars against a long path", () => {
    // The matcher advances all its states together. One that tries each
    // way to split the path between the stars in turn does not finish
    // this case, so the test ends only for a matcher of the first kind.
    const path = "a".repeat(400);
    const kept = exportOf(
      specWith(`${"*a".repeat(40)}*b`),
      bindingsWith("file", path),
    );
    expect(kept.refused).toBeNull();
    if (kept.refused !== null) return;
    expect(kept.briefing.hint).toContain(path);

    const dropped = exportOf(
      specWith(`${"*a".repeat(40)}*`),
      bindingsWith("file", path),
    );
    expect(dropped.refused).toBeNull();
    if (dropped.refused !== null) return;
    expect(dropped.briefing.hint).not.toContain(path);
  });

  it("reads a long path once, however many directories lie above it", () => {
    // 4 KB of pattern against 4 KB of path with 1000 directories. Read
    // once, that is some twenty million steps and a small fraction of the
    // limit below. Matched again from the start for every directory above
    // the path, it is hundreds of times that and several times the limit.
    const nonGoal = `${"*/".repeat(999)}*a${"*a".repeat(1000)}`;
    const candidate = `${"a/".repeat(1000)}${"a".repeat(2000)}b`;
    expect(nonGoal.length).toBeGreaterThanOrEqual(4000);
    expect(candidate.length).toBeGreaterThanOrEqual(4000);
    const started = performance.now();
    const run = exportOf(specWith(nonGoal), bindingsWith("file", candidate));
    const elapsedMs = performance.now() - started;
    expect(run.refused).toBeNull();
    if (run.refused !== null) return;
    expect(run.briefing.hint).toContain(candidate);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

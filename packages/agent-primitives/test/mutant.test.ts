import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  applyPatchForReal,
  buildBoundedHunkExcerpt,
  computeMutant,
  DEFAULT_GIT_APPLY_TIMEOUT_MS,
  DIFF_EXCERPT_MAX_CHARS,
  DIFF_EXCERPT_MAX_LINES,
  formatMutantSummary,
  formatVerifiedAppliedVia,
  listPatchTouchedPaths,
  parseNumstatPaths,
  reconcileEnvelopeDiffTruncation,
  trimToLastCompleteHunk,
  type MutantComputeResult,
  type MutantDiffField,
} from "../src/probe/mutant.js";
import { runArgv } from "../src/probe/run.js";
import { prepareMutant } from "../src/probe/step.js";
import { buildEnvelope } from "../src/envelope.js";

// Call-through partial mock: every `git apply` really runs unless a test
// overrides one call. The extra-path check below is only a check while it
// sees the whole `--numstat` listing, and the only way to exercise a
// listing that did not fit is to have the runner say so.
vi.mock("../src/probe/run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/probe/run.js")>();
  return { ...actual, runArgv: vi.fn(actual.runArgv) };
});

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-mutant-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ORIGINAL = ["function isPositive(n) {", "  return n > 0;", "}", ""].join(
  "\n",
);

/** Matches `envelope.ts`'s own `stringMarker` suffix (`"...(N more character(s) omitted)"`), the same pattern `reconcileEnvelopeDiffTruncation` looks for. */
const ENVELOPE_MARKER_RE = /\.\.\.\(\d+ more characters? omitted\)$/;

describe("computeMutant: replace form", () => {
  it("replaces the given line and reports before/after and a changed hash", async () => {
    const result = await computeMutant(
      {
        form: "replace",
        file: "/x/fixture.js",
        line: 2,
        replaceText: "  return false;",
      },
      { root: "/x", logDir: makeTmpDir(), originalContent: ORIGINAL },
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.before).toBe("  return n > 0;");
    expect(result.after).toBe("  return false;");
    expect(result.newContent).toContain("  return false;");
    expect(result.newContent).not.toContain("return n > 0;");
    expect(result.mutatedHash).not.toBe("");
  });

  it("is not applicable for a line number out of range, with a one-line reason", async () => {
    const result = await computeMutant(
      { form: "replace", file: "/x/fixture.js", line: 999, replaceText: "x" },
      { root: "/x", logDir: makeTmpDir(), originalContent: ORIGINAL },
    );
    expect(result.applicable).toBe(false);
    if (result.applicable) return;
    expect(result.reason).toContain("out of range");
    expect(result.logPaths).toEqual([]);
  });

  it("is not applicable when the replacement is byte-identical to the original line, with a one-line reason", async () => {
    const result = await computeMutant(
      {
        form: "replace",
        file: "/x/fixture.js",
        line: 2,
        replaceText: "  return n > 0;",
      },
      { root: "/x", logDir: makeTmpDir(), originalContent: ORIGINAL },
    );
    expect(result.applicable).toBe(false);
    if (result.applicable) return;
    expect(result.reason).toContain("identical");
  });
});

describe("computeMutant: match form", () => {
  it("replaces the first occurrence of the match text on the line, found", async () => {
    const result = await computeMutant(
      {
        form: "match",
        file: "/x/fixture.js",
        line: 2,
        matchText: "n > 0",
        withText: "false",
      },
      { root: "/x", logDir: makeTmpDir(), originalContent: ORIGINAL },
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.before).toBe("  return n > 0;");
    expect(result.after).toBe("  return false;");
  });

  it("is not applicable when the substring is not found on the line, with a one-line reason naming the line", async () => {
    const result = await computeMutant(
      {
        form: "match",
        file: "/x/fixture.js",
        line: 2,
        matchText: "zzz-not-there",
        withText: "x",
      },
      { root: "/x", logDir: makeTmpDir(), originalContent: ORIGINAL },
    );
    expect(result.applicable).toBe(false);
    if (result.applicable) return;
    expect(result.reason).toBe("substring not found on line 2");
  });

  it("is not applicable for a line number out of range, with a one-line reason", async () => {
    const result = await computeMutant(
      {
        form: "match",
        file: "/x/fixture.js",
        line: 999,
        matchText: "n",
        withText: "x",
      },
      { root: "/x", logDir: makeTmpDir(), originalContent: ORIGINAL },
    );
    expect(result.applicable).toBe(false);
    if (result.applicable) return;
    expect(result.reason).toContain("out of range");
  });
});

describe("parseNumstatPaths", () => {
  it("takes the last tab-separated field as the path, not a fixed index, for a rename-shaped line", () => {
    // Every `git apply --numstat` line this package has ever observed is
    // exactly 3 tab-separated fields (added, deleted, path), so a fixed
    // `parts[2]` and `parts[parts.length - 1]` happen to agree on real
    // git output. This directly exercises the parser against a line
    // carrying extra tab-separated fields ahead of the path -- the shape
    // a rename-tracking numstat variant could produce -- where a fixed
    // index and "always the last field" diverge.
    const paths = parseNumstatPaths(
      ["3\t1\tsrc/old-name.js\tsrc/new-name.js", "0\t0\tunchanged.js", ""].join(
        "\n",
      ),
    );
    expect(paths).toEqual(["src/new-name.js", "unchanged.js"]);
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

function initRepoWithFile(): {
  root: string;
  relPath: string;
  absFile: string;
  content: string;
} {
  const root = makeTmpDir();
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  const relPath = "fixture.js";
  const absFile = path.join(root, relPath);
  fs.writeFileSync(absFile, ORIGINAL);
  git(root, ["add", "-A"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return { root, relPath, absFile, content: ORIGINAL };
}

describe("computeMutant: patch form", () => {
  it("dry-runs a valid unified diff via git apply and never touches the real file", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "mutant.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -1,3 +1,3 @@",
        " function isPositive(n) {",
        "-  return n > 0;",
        "+  return false;",
        " }",
      ].join("\n") + "\n",
    );
    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.newContent).toContain("return false;");
    // The real file on disk must be completely untouched by the dry run.
    expect(fs.readFileSync(absFile, "utf8")).toBe(content);
  });

  it("is not applicable when the patch does not apply cleanly", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "bad.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -1,3 +1,3 @@",
        " function isPositive(n) {",
        "-  this line does not exist in the original;",
        "+  return false;",
        " }",
      ].join("\n") + "\n",
    );
    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );
    expect(result.applicable).toBe(false);
    if (result.applicable) return;
    expect(result.reason).toContain("did not apply");
    expect(result.logPaths.length).toBeGreaterThan(0);
  });

  it("is not applicable when the patch touches a path other than --file, naming the extra path", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "two-file.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -1,3 +1,3 @@",
        " function isPositive(n) {",
        "-  return n > 0;",
        "+  return false;",
        " }",
        "diff --git a/extra.js b/extra.js",
        "new file mode 100644",
        "index 0000000..0000000",
        "--- /dev/null",
        "+++ b/extra.js",
        "@@ -0,0 +1 @@",
        "+extra file content",
      ].join("\n") + "\n",
    );
    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );
    expect(result.applicable).toBe(false);
    if (result.applicable) return;
    expect(result.reason).toContain("extra.js");
    // The real file on disk is untouched: the dry run only ever wrote
    // into its own scratch copy.
    expect(fs.readFileSync(absFile, "utf8")).toBe(content);
  });

  it("reports the dry-run and numstat exec log paths in logPaths", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "mutant.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -1,3 +1,3 @@",
        " function isPositive(n) {",
        "-  return n > 0;",
        "+  return false;",
        " }",
      ].join("\n") + "\n",
    );
    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );
    expect(result.applicable).toBe(true);
    expect(result.logPaths.length).toBeGreaterThanOrEqual(2);
    for (const logPath of result.logPaths) {
      expect(fs.existsSync(logPath)).toBe(true);
    }
  });
});

describe("computeMutant: the reported line", () => {
  it("replace form reports the line it was asked to mutate", async () => {
    const result = await computeMutant(
      {
        form: "replace",
        file: "/x/fixture.js",
        line: 2,
        replaceText: "  return false;",
      },
      { root: "/x", logDir: makeTmpDir(), originalContent: ORIGINAL },
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.line).toBe(2);
    expect(ORIGINAL.split("\n")[result.line - 1]).toBe(result.before);
  });

  it("match form reports the line it was asked to mutate", async () => {
    const result = await computeMutant(
      {
        form: "match",
        file: "/x/fixture.js",
        line: 2,
        matchText: "n > 0",
        withText: "false",
      },
      { root: "/x", logDir: makeTmpDir(), originalContent: ORIGINAL },
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.line).toBe(2);
    expect(ORIGINAL.split("\n")[result.line - 1]).toBe(result.before);
  });

  it("patch form reports the first line the applied diff changed, not the hunk header's own start line", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "mutant.patch");
    // The hunk starts at line 1 and its first CHANGED line is line 2:
    // a result reporting the header's start would say 1 here.
    writeValidPatch(patchPath, relPath);

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.line).toBe(2);
    expect(content.split("\n")[result.line - 1]).toBe(result.before);
    expect(result.before).toBe("  return n > 0;");
  });

  it("patch form treats a change that only appends trailing whitespace as a real change on that line", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "trailing-space.patch");
    // `git apply` warns about the added trailing whitespace and applies
    // it anyway (exit 0). The comparison that decides `line`/`before`/
    // `after` has to be exact: a trimmed comparison would see the two
    // lines as equal, walk past them, find no other difference, and
    // report this patch as one that "produced no content change".
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -1,3 +1,3 @@",
        " function isPositive(n) {",
        "-  return n > 0;",
        "+  return n > 0; ",
        " }",
      ].join("\n") + "\n",
    );

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.line).toBe(2);
    expect(content.split("\n")[result.line - 1]).toBe(result.before);
    expect(result.before).toBe("  return n > 0;");
    expect(result.after).toBe("  return n > 0; ");
  });
});

/** A repo whose file has `lineCount` distinct, numbered lines -- enough
 * room for several hunks spaced far enough apart that `git diff`'s
 * default context never bridges them. */
function initRepoWithLines(lineCount: number): {
  root: string;
  relPath: string;
  absFile: string;
  content: string;
} {
  const root = makeTmpDir();
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  const relPath = "fixture.js";
  const absFile = path.join(root, relPath);
  const content =
    Array.from(
      { length: lineCount },
      (_, i) => `function fn${String(i + 1)}() { return ${String(i + 1)}; }`,
    ).join("\n") + "\n";
  fs.writeFileSync(absFile, content);
  git(root, ["add", "-A"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return { root, relPath, absFile, content };
}

/** A unified diff (built by hand, `--unified=0` shape) that replaces
 * `changedLines` (1-indexed) each with `<original> -> CHANGED`, one hunk
 * per line, so the number of hunks the patch carries is exactly
 * `changedLines.length`. */
/** `git apply` refuses a context-free hunk outright (`--unidiff-zero` is
 * required for one, and `computePatch`/`applyPatchForReal` never pass
 * it, the same as a real `-p` patch made by `git diff`'s own default):
 * every hunk here carries one line of context on each side it has one,
 * exactly as `git diff` would produce. `changedLines` must be spaced at
 * least 4 apart so no two hunks' one-line context windows ever touch,
 * which would merge them into one hunk instead of the `changedLines.length`
 * this test counts on. */
function writeSparsePatch(
  patchPath: string,
  relPath: string,
  changedLines: number[],
  lineCount: number,
): void {
  const fnLine = (n: number): string =>
    `function fn${String(n)}() { return ${String(n)}; }`;
  const body: string[] = [
    `diff --git a/${relPath} b/${relPath}`,
    "index 0000000..0000000 100644",
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
  ];
  for (const n of changedLines) {
    const hasBefore = n > 1;
    const hasAfter = n < lineCount;
    const oldCount = 1 + (hasBefore ? 1 : 0) + (hasAfter ? 1 : 0);
    const start = hasBefore ? n - 1 : n;
    body.push(
      `@@ -${String(start)},${String(oldCount)} +${String(start)},${String(oldCount)} @@`,
    );
    if (hasBefore) body.push(` ${fnLine(n - 1)}`);
    body.push(`-${fnLine(n)}`);
    body.push(`+function fn${String(n)}() { return ${String(n * 100)}; }`);
    if (hasAfter) body.push(` ${fnLine(n + 1)}`);
  }
  fs.writeFileSync(patchPath, body.join("\n") + "\n");
}

/** A single line of exactly `targetLen` characters, unique per `tag`
 * (`L<n>` for the original, `L<n>M` for its mutation): a fixed prefix
 * naming the tag, padded with `x` out to the requested length, so two
 * lines of the same length never collide and the excerpt's own
 * character accounting (this test's real point) is driven by a known,
 * exact per-line length rather than whatever a fixed source-code
 * template happens to produce. */
function fixedLengthLine(tag: string, targetLen: number): string {
  const prefix = `${tag}:`;
  return (prefix + "x".repeat(Math.max(0, targetLen - prefix.length))).slice(
    0,
    targetLen,
  );
}

/** Builds a repo whose file is `lineCount` lines, each exactly
 * `targetLen` characters (`fixedLengthLine`), and a hand-written patch
 * that replaces every line in `changedLines` (spaced >= 4 apart, same
 * constraint `writeSparsePatch` documents) with its own same-length
 * mutation -- so the REAL applied-diff excerpt this produces has a
 * known, exact character cost per hunk, letting a test target the
 * envelope's own byte budget precisely instead of guessing at it from
 * a source-code fixture's incidental line lengths. */
async function computeFixedLengthMultiHunkDiff(
  lineCount: number,
  targetLen: number,
  changedLines: number[],
): Promise<{ root: string; relPath: string; result: MutantComputeResult }> {
  const root = makeTmpDir();
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  const relPath = "fixture.js";
  const absFile = path.join(root, relPath);
  const lines = Array.from({ length: lineCount }, (_, i) =>
    fixedLengthLine(`L${String(i + 1)}`, targetLen),
  );
  const content = lines.join("\n") + "\n";
  fs.writeFileSync(absFile, content);
  git(root, ["add", "-A"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);

  const patchPath = path.join(root, "fixed-length.patch");
  const body: string[] = [
    `diff --git a/${relPath} b/${relPath}`,
    "index 0000000..0000000 100644",
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
  ];
  for (const n of changedLines) {
    const hasBefore = n > 1;
    const hasAfter = n < lineCount;
    const oldCount = 1 + (hasBefore ? 1 : 0) + (hasAfter ? 1 : 0);
    const start = hasBefore ? n - 1 : n;
    body.push(
      `@@ -${String(start)},${String(oldCount)} +${String(start)},${String(oldCount)} @@`,
    );
    if (hasBefore) body.push(` ${lines[n - 2]}`);
    body.push(`-${lines[n - 1]}`);
    body.push(`+${fixedLengthLine(`L${String(n)}M`, targetLen)}`);
    if (hasAfter) body.push(` ${lines[n]}`);
  }
  fs.writeFileSync(patchPath, body.join("\n") + "\n");

  const result = await computeMutant(
    { form: "patch", file: absFile, patchPath },
    { root, logDir: makeTmpDir(), originalContent: content },
  );
  return { root, relPath, result };
}

/** The `logs` array a real `probe` invocation carries: a handful of
 * absolute exec-log paths under the caller's `-l` directory. Long paths
 * are the realistic case (a run directory under a scratch tree is easily
 * 120 characters) and they compete with the excerpt for the same
 * envelope budget, so an envelope-delivery test that passes `logs: []`
 * is testing a shape the CLI never produces -- nothing gets cut, and the
 * correction under test never runs. */
function realisticLogs(count = 4): string[] {
  const dir =
    "/private/tmp/agent-primitives-probe-logs/2026-09-06-run/" +
    "probe-envelope-delivery-fixture/exec";
  return Array.from(
    { length: count },
    (_, i) => `${dir}/exec-0000000000000-${String(i).padStart(4, "0")}.log`,
  );
}

/** Builds the single-probe envelope shape `cli.ts` builds, for one
 * already-computed mutant, and runs `buildEnvelope` plus
 * `reconcileEnvelopeDiffTruncation` exactly the way the CLI does --
 * including handing the correction the PRE-envelope `mutant` field as
 * evidence. */
function buildProbeEnvelope(
  relPath: string,
  root: string,
  result: {
    line: number;
    before: string;
    after: string;
    diff?: MutantDiffField;
  },
  maxChars: number | undefined,
): Record<string, unknown> {
  const mutantField = {
    file: relPath,
    line: result.line,
    before: result.before,
    after: result.after,
    form: "patch" as const,
    ...(result.diff !== undefined ? { diff: result.diff } : {}),
  };
  const { envelope } = buildEnvelope({
    version: "0.0.0-test",
    command: "probe",
    status: "survived",
    durationMs: 1,
    cwd: root,
    warnings: [],
    logs: realisticLogs(),
    extra: {
      mutant: mutantField,
      mutation_probe: {
        mutant: formatMutantSummary(
          relPath,
          result.line,
          result.before,
          result.after,
          result.diff,
        ),
        verified_applied_via: formatVerifiedAppliedVia(
          relPath,
          result.line,
          result.before,
          result.after,
          result.diff,
        ),
        result: "survived",
        restored_verified: true,
      },
    },
    maxChars,
    logDir: makeTmpDir(),
  });
  reconcileEnvelopeDiffTruncation(envelope, { mutant: mutantField });
  return envelope;
}

/** The delivered `diff` object of a single-probe envelope, whatever the
 * reduction left of it. */
function deliveredDiff(
  envelope: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const mutant = envelope.mutant;
  if (mutant === null || typeof mutant !== "object") return undefined;
  const diff = (mutant as Record<string, unknown>).diff;
  if (diff === null || typeof diff !== "object") return undefined;
  return diff as Record<string, unknown>;
}

function deliveredProbeField(
  envelope: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const probeField = envelope.mutation_probe;
  if (probeField === null || typeof probeField !== "object") return undefined;
  return probeField as Record<string, unknown>;
}

/** The pointer clause `describeExcerptPointer` produces, recomputed here
 * from the DELIVERED flags rather than imported, so "the descriptors
 * agree with the field" is checked against an independent statement of
 * what agreement means. */
function expectedPointer(diff: Record<string, unknown> | undefined): string {
  if (diff === undefined)
    return "mutant.diff omitted from this envelope; see logs";
  const wherePath =
    typeof diff.path === "string" ? "; full diff at mutant.diff.path" : "";
  if (diff.bodyOmitted === true)
    return `see mutant.diff (excerpt omitted)${wherePath}`;
  if (diff.hunkTruncated === true)
    return `see mutant.diff (cut mid-hunk)${wherePath}`;
  if (diff.truncated === true) return `see mutant.diff (truncated)${wherePath}`;
  return `see mutant.diff (whole)${wherePath}`;
}

/** Every clause `describeExcerptPointer` can produce, written out here
 * rather than imported: a descriptor must carry the one the delivered
 * field calls for, and none of the others. */
const ALL_POINTER_CLAUSES = [
  "see mutant.diff (whole)",
  "see mutant.diff (truncated)",
  "see mutant.diff (cut mid-hunk)",
  "see mutant.diff (excerpt omitted)",
  "mutant.diff omitted from this envelope; see logs",
];

/** Both descriptor strings end on the clause the DELIVERED field's own
 * flags call for -- the agreement this whole correction exists to keep
 * -- unless the envelope's own string cap cut the descriptor itself, in
 * which case it must carry no clause at all rather than a stale one
 * (re-inflating it would put back the characters the reduction removed
 * to meet the bound). */
function expectDescriptorsAgree(envelope: Record<string, unknown>): void {
  const probeField = deliveredProbeField(envelope);
  expect(probeField).toBeDefined();
  if (probeField === undefined) return;
  const clause = expectedPointer(deliveredDiff(envelope));
  for (const key of ["mutant", "verified_applied_via"]) {
    expectDescriptorCarriesOnly(String(probeField[key]), clause);
  }
}

function expectDescriptorCarriesOnly(descriptor: string, clause: string): void {
  if (descriptor.includes(clause)) return;
  // Not the clause: then the envelope cut this string, and it may state
  // nothing about the excerpt at all.
  expect(descriptor).toMatch(ENVELOPE_MARKER_RE);
  for (const other of ALL_POINTER_CLAUSES) {
    if (clause.startsWith(other)) continue;
    expect(descriptor).not.toContain(other);
  }
}

/** Walks a delivered excerpt hunk by hunk, from the hunk headers' own
 * declared counts, and reports how it ends. Written out here rather than
 * calling `trimToLastCompleteHunk`, so an assertion about a boundary is
 * never a comparison of the function under test with itself. */
function describeExcerptEnd(text: string): {
  endsAtHunkBoundary: boolean;
  completeHunks: number;
  trailingPartialHunk: boolean;
} {
  const lines = text.split("\n");
  let i = 0;
  while (
    i < lines.length &&
    !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(lines[i])
  ) {
    i++;
  }
  let completeHunks = 0;
  let trailingPartialHunk = false;
  while (i < lines.length) {
    const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]);
    if (match === null) {
      trailingPartialHunk = true;
      break;
    }
    const removed = match[1] === undefined ? 1 : Number(match[1]);
    const added = match[2] === undefined ? 1 : Number(match[2]);
    let wanted = removed + added;
    let j = i + 1;
    while (j < lines.length && wanted > 0) {
      if (!lines[j].startsWith("\\ ")) wanted--;
      j++;
    }
    if (wanted > 0) {
      trailingPartialHunk = true;
      break;
    }
    while (j < lines.length && lines[j].startsWith("\\ ")) j++;
    completeHunks++;
    i = j;
  }
  return {
    endsAtHunkBoundary: !trailingPartialHunk && i === lines.length,
    completeHunks,
    trailingPartialHunk,
  };
}

/** The delivered excerpt is always a line-prefix of the excerpt the
 * probe itself produced -- from its start, or from its first hunk header
 * when the preamble had to go. Nothing is ever added, reordered, or
 * repaired into it. */
function expectPrefixOfOriginal(text: string, originalText: string): void {
  if (text === "") return;
  const fromHunks = originalText.slice(originalText.indexOf("@@ "));
  expect(originalText.startsWith(text) || fromHunks.startsWith(text)).toBe(
    true,
  );
}

describe("mutant.diff delivery through the envelope", () => {
  it("15 hunks of 61-character lines at the default budget: the delivered excerpt is the pre-envelope one, and the descriptors say so", async () => {
    const changedLines = Array.from({ length: 15 }, (_, i) => (i + 1) * 4);
    const { root, relPath, result } = await computeFixedLengthMultiHunkDiff(
      100,
      61,
      changedLines,
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable || result.diff === undefined) return;
    expect(result.diff.hunkCount).toBe(15);
    expect(result.diff.changedLineCount).toBe(30);
    expect(typeof result.diff.path).toBe("string");

    const envelope = buildProbeEnvelope(relPath, root, result, undefined);
    const diff = deliveredDiff(envelope);
    expect(diff?.text).toBe(result.diff.text);
    expect(diff?.truncated).toBe(result.diff.truncated);
    expect(diff?.hunkCount).toBe(15);
    expect(String(diff?.text)).not.toMatch(ENVELOPE_MARKER_RE);
    expectDescriptorsAgree(envelope);
  });

  it("15 hunks of 61-character lines at -m 4000: the envelope cuts, and what is delivered is whole hunks, non-empty, with the descriptors restated", async () => {
    const changedLines = Array.from({ length: 15 }, (_, i) => (i + 1) * 4);
    const { root, relPath, result } = await computeFixedLengthMultiHunkDiff(
      100,
      61,
      changedLines,
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable || result.diff === undefined) return;

    const envelope = buildProbeEnvelope(relPath, root, result, 4000);
    const diff = deliveredDiff(envelope);
    expect(diff).toBeDefined();
    if (diff === undefined) return;
    const text = String(diff.text);
    // Cut: shorter than the pre-envelope excerpt, and never left with
    // the envelope's own character-level omission marker.
    expect(text.length).toBeLessThan(result.diff.text.length);
    expect(text).not.toMatch(ENVELOPE_MARKER_RE);
    expect(diff.truncated).toBe(true);
    expect(diff.hunkCount).toBe(15);
    // Never an empty string behind a "see mutant.diff" pointer: either
    // real hunk content, or `bodyOmitted` saying there is none.
    if (diff.bodyOmitted === true) {
      expect(text).toBe("");
    } else {
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("@@ ");
    }
    const shape = describeExcerptEnd(text);
    if (diff.hunkTruncated === true) {
      expect(shape.trailingPartialHunk).toBe(true);
    } else if (diff.bodyOmitted !== true) {
      expect(shape.endsAtHunkBoundary).toBe(true);
      expect(shape.completeHunks).toBeGreaterThan(0);
    }
    // Every delivered hunk is a prefix of the pre-envelope excerpt: the
    // correction only ever takes away.
    expectPrefixOfOriginal(text, result.diff.text);
    expectDescriptorsAgree(envelope);
  });

  it("20 hunks of 400-character lines: the excerpt's own bound cuts at a hunk boundary and the default envelope delivers that unchanged", async () => {
    const changedLines = Array.from({ length: 20 }, (_, i) => (i + 1) * 4);
    const { root, relPath, result } = await computeFixedLengthMultiHunkDiff(
      120,
      400,
      changedLines,
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable || result.diff === undefined) return;
    expect(result.diff.hunkCount).toBe(20);
    // 20 hunks of 400-character lines is far past the excerpt's own
    // 3,000-character bound: this is the case that bound exists for.
    expect(result.diff.truncated).toBe(true);
    expect(result.diff.hunkTruncated).toBeUndefined();
    expect(result.diff.text.length).toBeLessThanOrEqual(DIFF_EXCERPT_MAX_CHARS);
    expect(describeExcerptEnd(result.diff.text).endsAtHunkBoundary).toBe(true);

    const envelope = buildProbeEnvelope(relPath, root, result, undefined);
    const diff = deliveredDiff(envelope);
    expect(diff?.text).toBe(result.diff.text);
    expect(diff?.truncated).toBe(true);
    expect(diff?.hunkCount).toBe(20);
    expectDescriptorsAgree(envelope);
  });

  it("20 hunks of 400-character lines at -m 2000: what survives is still hunk-shaped, non-empty or explicitly omitted, and named as such", async () => {
    const changedLines = Array.from({ length: 20 }, (_, i) => (i + 1) * 4);
    const { root, relPath, result } = await computeFixedLengthMultiHunkDiff(
      120,
      400,
      changedLines,
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable || result.diff === undefined) return;

    const envelope = buildProbeEnvelope(relPath, root, result, 2000);
    const diff = deliveredDiff(envelope);
    if (diff === undefined) {
      // The reduction dropped the whole field at this budget: the
      // descriptors must stop pointing at it.
      expectDescriptorsAgree(envelope);
      const probeField = deliveredProbeField(envelope);
      expect(String(probeField?.verified_applied_via)).toContain(
        "mutant.diff omitted from this envelope; see logs",
      );
      return;
    }
    const text = String(diff.text);
    expect(text).not.toMatch(ENVELOPE_MARKER_RE);
    expect(diff.truncated).toBe(true);
    if (diff.bodyOmitted === true) {
      expect(text).toBe("");
    } else {
      expect(text).toContain("@@ ");
    }
    expectDescriptorsAgree(envelope);
  });
});

describe("computeMutant: patch form multi-hunk diff excerpt", () => {
  it("reports all three hunks in `diff`, never just the first changed line -- the defect this excerpt fixes", async () => {
    const { root, relPath, absFile, content } = initRepoWithLines(10);
    const patchPath = path.join(root, "three-hunk.patch");
    writeSparsePatch(patchPath, relPath, [2, 6, 10], 10);

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    // `line`/`before`/`after` still name only the FIRST changed line --
    // that alone is not the defect; the defect was `diff` not existing
    // at all, leaving the reader with no way to see the other two hunks.
    expect(result.line).toBe(2);
    expect(result.before).toBe("function fn2() { return 2; }");
    expect(result.after).toBe("function fn2() { return 200; }");
    expect(result.diff).toBeDefined();
    expect(result.diff?.hunkCount).toBe(3);
    expect(result.diff?.truncated).toBe(false);
    expect(result.diff?.text).toContain("function fn2() { return 2; }");
    expect(result.diff?.text).toContain("function fn6() { return 6; }");
    expect(result.diff?.text).toContain("function fn6() { return 600; }");
    expect(result.diff?.text).toContain("function fn10() { return 10; }");
    expect(result.diff?.text).toContain("function fn10() { return 1000; }");

    // Every hunk here is a one-for-one line replace, so removed === added
    // (3 === 3): the pair form survives.
    expect(result.diff?.removed).toBe(3);
    expect(result.diff?.added).toBe(3);

    const summary = formatMutantSummary(
      "fixture.js",
      result.line,
      result.before,
      result.after,
      result.diff,
    );
    expect(summary).toContain("first of 6 changed lines across 3 hunks");
    // The one-line summary still never quotes the second/third hunk --
    // that is `mutant.diff`'s job, not this one's.
    expect(summary).not.toContain("fn6");

    const verifiedVia = formatVerifiedAppliedVia(
      "fixture.js",
      result.line,
      result.before,
      result.after,
      result.diff,
    );
    // `verified_applied_via` is a short descriptor pointing at
    // `mutant.diff`, never a second copy of the excerpt: it names the
    // counts, not the hunks' own content.
    expect(verifiedVia).toContain("3 hunks");
    expect(verifiedVia).toContain("6 changed lines");
    expect(verifiedVia).toContain("3 removed, 3 added");
    expect(verifiedVia).toContain("see mutant.diff");
    expect(verifiedVia).not.toContain("fn2");
    expect(verifiedVia).not.toContain("function fn6() { return 600; }");
    expect(verifiedVia).not.toContain("function fn10() { return 1000; }");
  });

  it("attaches `diff` for a single hunk spanning more than one changed line too, not only for several hunks", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "multi-line-single-hunk.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -1,3 +1,3 @@",
        "-function isPositive(n) {",
        "+function isPositive(n) {  // mutated",
        "-  return n > 0;",
        "+  return false;",
        " }",
      ].join("\n") + "\n",
    );

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.diff).toBeDefined();
    expect(result.diff?.hunkCount).toBe(1);
    expect(result.diff?.text).toContain("return false;");
    expect(result.diff?.text).toContain("mutated");
  });

  it("does NOT attach `diff` for an ordinary single-hunk, single-line patch (every existing fixture stays byte-identical)", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "single-line.patch");
    writeValidPatch(patchPath, relPath);

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.diff).toBeUndefined();
  });

  it("truncates a diff excerpt bigger than the bound, but keeps reporting the true total hunk count", async () => {
    const lineCount = 700;
    const { root, relPath, absFile, content } = initRepoWithLines(lineCount);
    const changedLines = Array.from(
      { length: 100 },
      (_, i) => (i + 1) * 4,
    ).filter((n) => n <= lineCount);
    const patchPath = path.join(root, "many-hunks.patch");
    writeSparsePatch(patchPath, relPath, changedLines, lineCount);

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.diff).toBeDefined();
    expect(result.diff?.hunkCount).toBe(changedLines.length);
    expect(result.diff?.truncated).toBe(true);
    expect(result.diff?.text.length).toBeLessThanOrEqual(
      DIFF_EXCERPT_MAX_CHARS,
    );
    expect(result.diff?.text.split("\n").length).toBeLessThanOrEqual(
      DIFF_EXCERPT_MAX_LINES,
    );
  }, 30000);

  it("attaches `diff` for a one-hunk, pure one-line deletion, and does not misreport an untouched shifted line as `after`", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "one-line-deletion.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -1,3 +1,2 @@",
        " function isPositive(n) {",
        "-  return n > 0;",
        " }",
      ].join("\n") + "\n",
    );

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.diff).toBeDefined();
    expect(result.diff?.hunkCount).toBe(1);
    expect(result.diff?.changedLineCount).toBe(1);
    expect(result.diff?.text).toContain("return n > 0;");
    // The naive line-by-line comparison (`before`/`after`) finds its
    // first disagreement one line early, on `}` -- a line the deletion
    // never touched, only shifted up. `diff` must name the real removed
    // line instead of leaving the reader to trust that misleading quote.
    expect(result.before).toBe("  return n > 0;");
    expect(result.after).toBe("}");
    expect(result.diff?.text).not.toContain("+}");
  });

  it("attaches `diff` for a one-hunk, pure one-line insertion, and does not misreport an untouched shifted line as `before`", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "one-line-insertion.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -1,2 +1,3 @@",
        " function isPositive(n) {",
        "+  console.log(n);",
        "   return n > 0;",
      ].join("\n") + "\n",
    );

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.diff).toBeDefined();
    expect(result.diff?.hunkCount).toBe(1);
    expect(result.diff?.changedLineCount).toBe(1);
    expect(result.diff?.text).toContain("console.log(n);");
    // `before`/`after` alone name the inserted line as the "after" of
    // the original second line, which is wrong: that line still exists,
    // just shifted down -- `diff` is what actually shows the insertion.
    expect(result.before).toBe("  return n > 0;");
    expect(result.after).toBe("  console.log(n);");
    expect(result.diff?.text).not.toContain("-  return n > 0;");
  });

  it("attaches `diff` for a one-hunk, two-line deletion, and does not misreport an untouched shifted line as `after`", async () => {
    const lineCount = 15;
    const { root, relPath, absFile, content } = initRepoWithLines(lineCount);
    const patchPath = path.join(root, "two-line-deletion.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -9,4 +9,2 @@",
        " function fn9() { return 9; }",
        "-function fn10() { return 10; }",
        "-function fn11() { return 11; }",
        " function fn12() { return 12; }",
      ].join("\n") + "\n",
    );

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.diff).toBeDefined();
    expect(result.diff?.hunkCount).toBe(1);
    expect(result.diff?.changedLineCount).toBe(2);
    expect(result.diff?.text).toContain("function fn10() { return 10; }");
    expect(result.diff?.text).toContain("function fn11() { return 11; }");
    // `before`/`after` alone echo the shifted, untouched `fn12` line as
    // if it were what `fn10` became -- exactly the "line10 -> line12"
    // misreport this excerpt exists to correct.
    expect(result.before).toBe("function fn10() { return 10; }");
    expect(result.after).toBe("function fn12() { return 12; }");
  });

  it("attaches `diff` for a one-hunk, two-line insertion, and does not misreport an untouched shifted line as `before`", async () => {
    const lineCount = 10;
    const { root, relPath, absFile, content } = initRepoWithLines(lineCount);
    const patchPath = path.join(root, "two-line-insertion.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -4,3 +4,5 @@",
        " function fn4() { return 4; }",
        " function fn5() { return 5; }",
        "+inserted_a",
        "+inserted_b",
        " function fn6() { return 6; }",
      ].join("\n") + "\n",
    );

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.diff).toBeDefined();
    expect(result.diff?.hunkCount).toBe(1);
    expect(result.diff?.changedLineCount).toBe(2);
    expect(result.diff?.text).toContain("inserted_a");
    expect(result.diff?.text).toContain("inserted_b");
    // `before`/`after` alone echo the untouched `fn6` line as the
    // "after" of `fn6` itself -- the "line6 -> inserted_a" misreport
    // this excerpt exists to correct.
    expect(result.before).toBe("function fn6() { return 6; }");
    expect(result.after).toBe("inserted_a");
  });

  it("counts a removed line starting with `-- ` and an added line starting with `++ ` correctly (header-derived counts, not prefix sniffing)", async () => {
    // A dedicated fixture (not `initRepoWithFile`'s): the point is that
    // the resulting REAL `git diff --no-index --unified=0` -- computed
    // from the applied before/after content, not from this hand-written
    // `-p` patch's own text -- produces a removed line reading
    // `--- odd_before` (marker `-` plus content `-- odd_before`) and an
    // added line reading `+++ odd_after` (marker `+` plus content
    // `++ odd_after`): exactly the shapes a `+++ `/`--- ` prefix filter
    // would misread as the diff's own file-header lines and drop.
    const root = makeTmpDir();
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "test"]);
    const relPath = "fixture.js";
    const absFile = path.join(root, relPath);
    const content = [
      "context1",
      "-- odd_before",
      "normal_before",
      "context2",
      "",
    ].join("\n");
    fs.writeFileSync(absFile, content);
    git(root, ["add", "-A"]);
    git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);

    const patchPath = path.join(root, "dashdash.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -1,4 +1,4 @@",
        " context1",
        "--- odd_before",
        "-normal_before",
        "+++ odd_after",
        "+normal_after",
        " context2",
      ].join("\n") + "\n",
    );

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.diff).toBeDefined();
    // The hunk header (from the real applied-diff, unified=0) declares
    // 2 removed, 2 added; a prefix-sniffing count would instead read
    // the `+++ `/`--- ` lines as non-content and undercount both sides.
    expect(result.diff?.hunkCount).toBe(1);
    expect(result.diff?.changedLineCount).toBe(4);
    expect(result.diff?.text).toContain("odd_before");
    expect(result.diff?.text).toContain("odd_after");
  });

  it("does not leave the before/after scratch content behind once the excerpt has been read", async () => {
    const { root, relPath, absFile, content } = initRepoWithLines(10);
    const patchPath = path.join(root, "cleanup.patch");
    writeSparsePatch(patchPath, relPath, [2, 6], 10);
    const logDir = makeTmpDir();

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir, originalContent: content },
    );

    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.diff).toBeDefined();
    const diffDirs = fs
      .readdirSync(logDir)
      .filter((name) => name.startsWith("mutant-diff-"));
    expect(diffDirs.length).toBeGreaterThan(0);
    for (const dirName of diffDirs) {
      const scratchDir = path.join(logDir, dirName);
      // The `before/`/`after/` scratch content is removed once `git
      // diff` has read it back; only the exec log (whatever else
      // `runArgv` left in the same scratch directory) may remain, since
      // `result.logPaths` still points into it.
      expect(fs.existsSync(path.join(scratchDir, "before"))).toBe(false);
      expect(fs.existsSync(path.join(scratchDir, "after"))).toBe(false);
    }
  });

  it("pins ambient git config for the applied-diff excerpt's own `git diff --no-index` (diff.external cannot make it vanish silently)", async () => {
    const { root, relPath, absFile, content } = initRepoWithLines(10);
    const patchPath = path.join(root, "hostile-config.patch");
    writeSparsePatch(patchPath, relPath, [2, 6], 10);

    const prevConfigCount = process.env.GIT_CONFIG_COUNT;
    const prevConfigKey0 = process.env.GIT_CONFIG_KEY_0;
    const prevConfigValue0 = process.env.GIT_CONFIG_VALUE_0;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "diff.external";
    process.env.GIT_CONFIG_VALUE_0 = "/bin/echo";
    try {
      const result = await computeMutant(
        { form: "patch", file: absFile, patchPath },
        { root, logDir: makeTmpDir(), originalContent: content },
      );

      expect(result.applicable).toBe(true);
      if (!result.applicable) return;
      // `--no-ext-diff` on the call means the hostile `diff.external`
      // never gets a say: the excerpt is still produced in full, not
      // silently dropped with an empty `warnings`.
      expect(result.diff).toBeDefined();
      expect(result.diff?.text).toContain("function fn2()");
      expect(result.diffWarning).toBeUndefined();
    } finally {
      if (prevConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = prevConfigCount;
      if (prevConfigKey0 === undefined) delete process.env.GIT_CONFIG_KEY_0;
      else process.env.GIT_CONFIG_KEY_0 = prevConfigKey0;
      if (prevConfigValue0 === undefined) delete process.env.GIT_CONFIG_VALUE_0;
      else process.env.GIT_CONFIG_VALUE_0 = prevConfigValue0;
    }
  });

  it("pins ambient git config for the applied-diff excerpt's own `git diff --no-index` (a `core.attributesFile`-assigned `textconv` cannot fabricate hunks either)", async () => {
    const { root, relPath, absFile, content } = initRepoWithLines(10);
    const patchPath = path.join(root, "hostile-textconv.patch");
    writeSparsePatch(patchPath, relPath, [2, 6], 10);

    // A `core.attributesFile` mapping every path to a driver, plus a
    // `diff.<driver>.textconv` that ignores its actual input and always
    // emits a fixed marker: without `--no-textconv`, this converts
    // `before/`/`after/`'s content before the comparison, and the
    // excerpt would report the CONVERTED (fabricated) content rather
    // than what `git apply` actually wrote -- silently, since `git
    // diff` still exits 1 ("differences found") either way.
    const attributesFile = path.join(makeTmpDir(), "attributes");
    fs.writeFileSync(attributesFile, "* diff=customdriver\n");

    const prevConfigCount = process.env.GIT_CONFIG_COUNT;
    const prevConfigKey0 = process.env.GIT_CONFIG_KEY_0;
    const prevConfigValue0 = process.env.GIT_CONFIG_VALUE_0;
    const prevConfigKey1 = process.env.GIT_CONFIG_KEY_1;
    const prevConfigValue1 = process.env.GIT_CONFIG_VALUE_1;
    process.env.GIT_CONFIG_COUNT = "2";
    process.env.GIT_CONFIG_KEY_0 = "core.attributesFile";
    process.env.GIT_CONFIG_VALUE_0 = attributesFile;
    process.env.GIT_CONFIG_KEY_1 = "diff.customdriver.textconv";
    process.env.GIT_CONFIG_VALUE_1 = "/bin/echo FABRICATED";
    try {
      const result = await computeMutant(
        { form: "patch", file: absFile, patchPath },
        { root, logDir: makeTmpDir(), originalContent: content },
      );

      expect(result.applicable).toBe(true);
      if (!result.applicable) return;
      expect(result.diff).toBeDefined();
      expect(result.diff?.text).toContain("function fn2()");
      expect(result.diff?.text).not.toContain("FABRICATED");
      expect(result.diffWarning).toBeUndefined();
    } finally {
      if (prevConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = prevConfigCount;
      if (prevConfigKey0 === undefined) delete process.env.GIT_CONFIG_KEY_0;
      else process.env.GIT_CONFIG_KEY_0 = prevConfigKey0;
      if (prevConfigValue0 === undefined) delete process.env.GIT_CONFIG_VALUE_0;
      else process.env.GIT_CONFIG_VALUE_0 = prevConfigValue0;
      if (prevConfigKey1 === undefined) delete process.env.GIT_CONFIG_KEY_1;
      else process.env.GIT_CONFIG_KEY_1 = prevConfigKey1;
      if (prevConfigValue1 === undefined) delete process.env.GIT_CONFIG_VALUE_1;
      else process.env.GIT_CONFIG_VALUE_1 = prevConfigValue1;
    }
  });

  it("surfaces a `diffWarning` (and no `diff`) when the applied-diff excerpt's own `git diff --no-index` fails, and `step.ts` folds it into `warnings`", async () => {
    const { root, relPath, absFile, content } = initRepoWithLines(10);
    const patchPath = path.join(root, "warning-path.patch");
    writeSparsePatch(patchPath, relPath, [2, 6], 10);

    // Every OTHER `git` call this dry run makes (`--numstat`, the real
    // `apply`) must still run for real; only the excerpt's own `diff
    // --no-index` call is made to fail, by rejecting the specific argv
    // shape `computeAppliedDiffExcerpt` builds.
    const mockedRunArgv = vi.mocked(runArgv);
    const realRunArgv = (
      await vi.importActual<typeof import("../src/probe/run.js")>(
        "../src/probe/run.js",
      )
    ).runArgv;
    mockedRunArgv.mockImplementation(async (cmd, args, opts) => {
      if (
        cmd === "git" &&
        args.includes("diff") &&
        args.includes("--no-index")
      ) {
        return {
          exitCode: 128,
          durationMs: 0,
          stdout: "",
          stderr: "fatal: forced failure for the diffWarning test",
          logPath: path.join(opts.logDir, "forced-failure.log"),
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          logWriteFailed: false,
          stdioClosed: true,
        };
      }
      return realRunArgv(cmd, args, opts);
    });

    try {
      const result = await computeMutant(
        { form: "patch", file: absFile, patchPath },
        { root, logDir: makeTmpDir(), originalContent: content },
      );
      expect(result.applicable).toBe(true);
      if (!result.applicable) return;
      // The defect this test kills: without a test forcing this path,
      // deleting `step.ts`'s `warnings.push(computed.diffWarning)`
      // survives the whole suite. `diff` must be absent (never both
      // `diff` and `diffWarning` at once) and `diffWarning` must name
      // the failure.
      expect(result.diff).toBeUndefined();
      expect(result.diffWarning).toBeDefined();
      expect(result.diffWarning).toContain("exited 128 unexpectedly");

      // Exercise `step.ts`'s own wiring end to end: `prepareMutant` is
      // what folds `computed.diffWarning` into the caller's `warnings`.
      const abortController = new AbortController();
      const rt: Parameters<typeof prepareMutant>[0] = {
        root,
        logDir: makeTmpDir(),
        applyRoot: root,
        execEnv: {
          cwd: root,
          logDir: makeTmpDir(),
          signal: abortController.signal,
        },
        gitApplyTimeoutMs: DEFAULT_GIT_APPLY_TIMEOUT_MS,
        effectiveIsolation: "inplace",
        testCommand: "true",
        signal: abortController.signal,
        track: async (started) => started,
        crashHandlers: {
          remove: () => undefined,
          isHandling: () => false,
          handled: Promise.resolve(null),
        },
        exitOnSignal: false,
        setRestoreState: () => undefined,
      };
      const target: Parameters<typeof prepareMutant>[1] = {
        displayFile: absFile,
        absFile,
        mutationFilePath: absFile,
        preHash: "",
        originalContent: content,
        session: {} as Parameters<typeof prepareMutant>[1]["session"],
        restoreOnce: async () => ({ ok: true, verified: true }),
        discardBackup: () => undefined,
      };
      const warnings: string[] = [];
      const prepared = await prepareMutant(
        rt,
        target,
        { form: "patch", patchPath, expect: "fail" },
        warnings,
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.mutant.diff).toBeUndefined();
      expect(warnings.some((w) => w.includes("exited 128 unexpectedly"))).toBe(
        true,
      );
    } finally {
      mockedRunArgv.mockImplementation(realRunArgv);
    }
  });

  /** Builds the `probe --plan` envelope shape `cli.ts`'s own
   * `runProbePlanCommand` builds, for one already-computed mutant, and
   * runs it through `buildEnvelope` plus `reconcileEnvelopeDiffTruncation`
   * exactly the way the CLI does -- so these tests exercise the real
   * mechanism, not a hand-rolled approximation of it. */
  function buildPlanEnvelope(
    relPath: string,
    root: string,
    result: {
      line: number;
      before: string;
      after: string;
      diff?: MutantDiffField;
    },
    maxChars: number | undefined,
  ): Record<string, unknown> {
    const mutantField = {
      file: relPath,
      line: result.line,
      before: result.before,
      after: result.after,
      form: "patch" as const,
      diff: result.diff,
    };
    const { envelope } = buildEnvelope({
      version: "0.0.0-test",
      command: "probe",
      status: "survived",
      durationMs: 1,
      cwd: root,
      warnings: [],
      logs: realisticLogs(),
      extra: {
        plan: {
          results: [
            {
              index: 0,
              file: relPath,
              expect: "fail",
              status: "survived",
              mutant: mutantField,
              mutation_probe: {
                mutant: formatMutantSummary(
                  relPath,
                  result.line,
                  result.before,
                  result.after,
                  result.diff,
                ),
                verified_applied_via: formatVerifiedAppliedVia(
                  relPath,
                  result.line,
                  result.before,
                  result.after,
                  result.diff,
                ),
              },
              warnings: [],
              logs: [],
            },
          ],
          summary: {
            total: 1,
            killed: 0,
            survived: 1,
            not_run: 0,
            inconclusive: 0,
          },
        },
      },
      keepWhole: ["plan.summary"],
      maxChars,
      logDir: makeTmpDir(),
    });
    reconcileEnvelopeDiffTruncation(envelope, {
      planResults: [{ mutant: mutantField }],
    });
    return envelope;
  }

  function planDiff(
    envelope: Record<string, unknown>,
  ): { text?: unknown; truncated?: unknown; hunkCount?: unknown } | undefined {
    const plan = envelope.plan as
      { results?: Array<Record<string, unknown>> } | undefined;
    const mutant = plan?.results?.[0]?.mutant as
      | { diff?: { text?: unknown; truncated?: unknown; hunkCount?: unknown } }
      | undefined;
    return mutant?.diff;
  }

  function planVerifiedAppliedVia(envelope: Record<string, unknown>): unknown {
    const plan = envelope.plan as
      { results?: Array<Record<string, unknown>> } | undefined;
    const probeField = plan?.results?.[0]?.mutation_probe as
      { verified_applied_via?: unknown } | undefined;
    return probeField?.verified_applied_via;
  }

  it("the diff excerpt is carried exactly once: `verified_applied_via` never repeats it, at the envelope's default budget", async () => {
    const lineCount = 700;
    const { root, relPath, absFile, content } = initRepoWithLines(lineCount);
    const changedLines = Array.from(
      { length: 100 },
      (_, i) => (i + 1) * 4,
    ).filter((n) => n <= lineCount);
    const patchPath = path.join(root, "many-hunks-envelope.patch");
    writeSparsePatch(patchPath, relPath, changedLines, lineCount);

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    // This fixture's own excerpt is already cut by `DIFF_EXCERPT_MAX_LINES`/
    // `DIFF_EXCERPT_MAX_CHARS`, the worst case a single `mutation_probe`
    // entry's diff excerpt can be.
    expect(result.diff?.truncated).toBe(true);
    if (result.diff === undefined) return;

    // `maxChars` omitted deliberately: this exercises the real default
    // (8,000), the shape every `probe --plan` invocation gets unless the
    // caller passes `-m`/`--max-chars`.
    const envelope = buildPlanEnvelope(relPath, root, result, undefined);

    const deliveredDiff = planDiff(envelope);
    // No further cut happened at this size: the delivered text matches
    // the excerpt's own (already-truncated-to-its-own-bound) text byte
    // for byte, and `truncated` still names only that pre-existing cut.
    expect(deliveredDiff?.text).toBe(result.diff.text);
    expect(deliveredDiff?.truncated).toBe(true);
    expect(deliveredDiff?.hunkCount).toBe(result.diff.hunkCount);

    const deliveredVerifiedAppliedVia = planVerifiedAppliedVia(envelope);
    // The short descriptor, not a second copy of the excerpt.
    expect(deliveredVerifiedAppliedVia).toBe(
      formatVerifiedAppliedVia(
        relPath,
        result.line,
        result.before,
        result.after,
        result.diff,
      ),
    );
    expect(String(deliveredVerifiedAppliedVia)).not.toContain("function fn");
  }, 30000);

  it("--plan batch of three multi-hunk mutants: every delivered excerpt is hunk-shaped, never empty behind a pointer, and its descriptors restate it", async () => {
    const mutants = await Promise.all(
      [0, 1, 2].map(async (n) => {
        const lineCount = 200;
        const { root, relPath, absFile, content } =
          initRepoWithLines(lineCount);
        const changedLines = Array.from(
          { length: 10 },
          (_, i) => (i + 1) * 4 + n,
        ).filter((line) => line >= 1 && line <= lineCount);
        const patchPath = path.join(root, `plan-mutant-${String(n)}.patch`);
        writeSparsePatch(patchPath, relPath, changedLines, lineCount);
        const result = await computeMutant(
          { form: "patch", file: absFile, patchPath },
          { root, logDir: makeTmpDir(), originalContent: content },
        );
        if (!result.applicable)
          throw new Error("expected an applicable mutant");
        return { root, relPath, result };
      }),
    );

    // The pre-envelope `mutant` fields, kept by reference: these are the
    // evidence the correction compares the delivered entries against,
    // exactly as `cli.ts` passes `result.results`.
    const originalMutantFields = mutants.map(({ relPath, result }) => ({
      file: relPath,
      line: result.line,
      before: result.before,
      after: result.after,
      form: "patch" as const,
      diff: result.diff,
    }));

    const { envelope } = buildEnvelope({
      version: "0.0.0-test",
      command: "probe",
      status: "survived",
      durationMs: 1,
      cwd: mutants[0].root,
      warnings: [],
      logs: realisticLogs(),
      extra: {
        plan: {
          results: mutants.map(({ relPath, result }, index) => ({
            index,
            file: relPath,
            expect: "fail",
            status: "survived",
            mutant: originalMutantFields[index],
            mutation_probe: {
              mutant: formatMutantSummary(
                relPath,
                result.line,
                result.before,
                result.after,
                result.diff,
              ),
              verified_applied_via: formatVerifiedAppliedVia(
                relPath,
                result.line,
                result.before,
                result.after,
                result.diff,
              ),
            },
            warnings: [],
            logs: [],
          })),
          summary: {
            total: 3,
            killed: 0,
            survived: 3,
            not_run: 0,
            inconclusive: 0,
          },
        },
      },
      keepWhole: ["plan.summary"],
      logDir: makeTmpDir(),
    });
    reconcileEnvelopeDiffTruncation(envelope, {
      planResults: originalMutantFields.map((mutant) => ({ mutant })),
    });

    const plan = envelope.plan as { results?: Array<Record<string, unknown>> };
    expect(plan.results).toHaveLength(3);
    for (const [index, entry] of (plan.results ?? []).entries()) {
      const mutant = entry.mutant as { diff?: MutantDiffField } | undefined;
      const diff = mutant?.diff;
      expect(diff).toBeDefined();
      if (diff === undefined) continue;
      const original = mutants[index].result;
      if (!original.applicable || original.diff === undefined) continue;
      // The envelope's own character-level cut never survives into the
      // delivered text, whichever way `truncated` fell.
      expect(diff.text).not.toMatch(ENVELOPE_MARKER_RE);
      // Never an empty string behind a "see mutant.diff" pointer.
      if (diff.bodyOmitted === true) {
        expect(diff.text).toBe("");
      } else {
        expect(diff.text.length).toBeGreaterThan(0);
        expect(diff.text).toContain("@@ ");
      }
      const shape = describeExcerptEnd(diff.text);
      if (diff.hunkTruncated === true) {
        expect(shape.trailingPartialHunk).toBe(true);
      } else if (diff.bodyOmitted !== true) {
        expect(shape.endsAtHunkBoundary).toBe(true);
      }
      // Only ever a prefix of what the probe itself produced.
      expectPrefixOfOriginal(diff.text, original.diff.text);
      expect(diff.hunkCount).toBe(original.diff.hunkCount);
      const probeField = entry.mutation_probe as Record<string, unknown>;
      const clause = expectedPointer(
        diff as unknown as Record<string, unknown>,
      );
      expectDescriptorCarriesOnly(String(probeField.mutant), clause);
      expectDescriptorCarriesOnly(
        String(probeField.verified_applied_via),
        clause,
      );
    }
  }, 30000);

  it("at `-m 2000`, a truncated `diff.text` never carries the envelope's own omission marker and ends at a hunk boundary", async () => {
    const lineCount = 700;
    const { root, relPath, absFile, content } = initRepoWithLines(lineCount);
    const changedLines = Array.from(
      { length: 100 },
      (_, i) => (i + 1) * 4,
    ).filter((n) => n <= lineCount);
    const patchPath = path.join(root, "many-hunks-tight.patch");
    writeSparsePatch(patchPath, relPath, changedLines, lineCount);
    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.diff).toBeDefined();
    if (result.diff === undefined) return;

    const envelope = buildPlanEnvelope(relPath, root, result, 2000);
    const diff = planDiff(envelope) as Record<string, unknown> | undefined;
    expect(diff).toBeDefined();
    if (diff === undefined) return;
    const text = String(diff.text ?? "");
    expect(ENVELOPE_MARKER_RE.test(text)).toBe(false);
    // What is delivered is a prefix of what the probe produced, cut at a
    // hunk boundary (or, when even the first hunk did not fit, at a line
    // boundary inside it, flagged `hunkTruncated`, or omitted entirely
    // and flagged `bodyOmitted`) -- never an empty string behind a
    // "see mutant.diff" pointer with nothing saying so.
    expectPrefixOfOriginal(text, result.diff.text);
    const shape = describeExcerptEnd(text);
    if (diff.bodyOmitted === true) {
      expect(text).toBe("");
    } else if (diff.hunkTruncated === true) {
      expect(shape.trailingPartialHunk).toBe(true);
      expect(text).toContain("@@ ");
    } else {
      expect(shape.endsAtHunkBoundary).toBe(true);
      expect(shape.completeHunks).toBeGreaterThan(0);
    }
    expect(diff.hunkCount).toBe(result.diff.hunkCount);
    const plan = envelope.plan as { results?: Array<Record<string, unknown>> };
    const probeField = plan.results?.[0]?.mutation_probe as Record<
      string,
      unknown
    >;
    const clause = expectedPointer(diff);
    expectDescriptorCarriesOnly(String(probeField.mutant), clause);
    expectDescriptorCarriesOnly(
      String(probeField.verified_applied_via),
      clause,
    );
  }, 30000);
});

describe("computeMutant: CRLF terminator preservation", () => {
  const CRLF_ORIGINAL = "function isPositive(n) {\r\n  return n > 0;\r\n}\r\n";

  it("replace form preserves the CRLF terminator of the replaced line", async () => {
    const result = await computeMutant(
      {
        form: "replace",
        file: "/x/fixture.js",
        line: 2,
        replaceText: "  return false;",
      },
      { root: "/x", logDir: makeTmpDir(), originalContent: CRLF_ORIGINAL },
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.after).toBe("  return false;\r");
    expect(result.newContent).toBe(
      "function isPositive(n) {\r\n  return false;\r\n}\r\n",
    );
  });

  it("match form preserves the CRLF terminator (the tail slice already carries it)", async () => {
    const result = await computeMutant(
      {
        form: "match",
        file: "/x/fixture.js",
        line: 2,
        matchText: "n > 0",
        withText: "false",
      },
      { root: "/x", logDir: makeTmpDir(), originalContent: CRLF_ORIGINAL },
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.newContent).toBe(
      "function isPositive(n) {\r\n  return false;\r\n}\r\n",
    );
  });
});

describe("formatMutantSummary / formatVerifiedAppliedVia", () => {
  it("formats the mutation_probe.mutant string verbatim as <file>:<line>: <before> -> <after>", () => {
    expect(formatMutantSummary("/a/b.js", 3, "x", "y")).toBe(
      "/a/b.js:3: x -> y",
    );
  });

  it("formats a 3-line before/after snippet", () => {
    const snippet = formatVerifiedAppliedVia("/a/b.js", 3, "x", "y");
    expect(snippet.split("\n")).toEqual(["/a/b.js:3", "- x", "+ y"]);
  });

  it("caps a very long file path (e.g. a long -l/-C path) with the envelope's own truncation-marker wording, naming the true omitted-character count, instead of pasting it whole into mutant/verified_applied_via", () => {
    const longFile = `/tmp/${"x".repeat(300)}/fixture.js`;

    const summary = formatMutantSummary(longFile, 3, "x", "y");
    const [filePart] = summary.split(":3: ");
    expect(filePart.length).toBeLessThan(240);
    expect(filePart.endsWith("...(116 more characters omitted)")).toBe(true);
    expect(filePart.startsWith(longFile.slice(0, 200))).toBe(true);
    expect(summary.endsWith(": x -> y")).toBe(true);

    const via = formatVerifiedAppliedVia(longFile, 3, "x", "y");
    const [viaFilePart] = via.split("\n")[0].split(":3");
    expect(viaFilePart.length).toBeLessThan(240);
    expect(viaFilePart.endsWith("...(116 more characters omitted)")).toBe(true);
    expect(via.split("\n").slice(1)).toEqual(["- x", "+ y"]);
  });

  it("leaves a short file path byte-identical (no marker) so every existing fixture is unaffected", () => {
    expect(formatMutantSummary("src/probe/mutant.ts", 1, "x", "y")).toBe(
      "src/probe/mutant.ts:1: x -> y",
    );
  });

  it("caps exactly at the 200-character bound: a 200-character path passes through byte-identical, a 201-character path gets the marker naming one omitted character", () => {
    const atBound = "p".repeat(200);
    const overBound = "p".repeat(201);
    expect(formatMutantSummary(atBound, 1, "x", "y")).toBe(
      `${atBound}:1: x -> y`,
    );
    expect(formatMutantSummary(overBound, 1, "x", "y")).toBe(
      `${atBound}...(1 more character omitted):1: x -> y`,
    );
    expect(formatVerifiedAppliedVia(atBound, 1, "x", "y").split("\n")[0]).toBe(
      `${atBound}:1`,
    );
    expect(
      formatVerifiedAppliedVia(overBound, 1, "x", "y").split("\n")[0],
    ).toBe(`${atBound}...(1 more character omitted):1`);
  });
});

describe("computeMutant: a --numstat listing that did not fit", () => {
  it("is not applicable, naming the log, rather than checking the paths against a fragment", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "mutant.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -1,3 +1,3 @@",
        " function isPositive(n) {",
        "-  return n > 0;",
        "+  return false;",
        " }",
      ].join("\n") + "\n",
    );

    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    // The first call is the --numstat check: a patch whose listing was
    // cut could hide the very path that makes it unsafe, so the whole
    // patch is refused instead of half-checked.
    vi.mocked(runArgv).mockImplementationOnce(async (file, args, options) => {
      const result = await actualRun.runArgv(file, args, options);
      return { ...result, outputTruncated: true };
    });

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(false);
    if (result.applicable) return;
    expect(result.reason).toContain("more output than can be checked");
    expect(result.logPaths.length).toBe(1);
    expect(fs.readFileSync(absFile, "utf8")).toBe(content);
  });
});

/** Writes a single-file unified diff for `relPath`'s line 2. */
function writeValidPatch(patchPath: string, relPath: string): void {
  fs.writeFileSync(
    patchPath,
    [
      `diff --git a/${relPath} b/${relPath}`,
      "index 0000000..0000000 100644",
      `--- a/${relPath}`,
      `+++ b/${relPath}`,
      "@@ -1,3 +1,3 @@",
      " function isPositive(n) {",
      "-  return n > 0;",
      "+  return false;",
      " }",
    ].join("\n") + "\n",
  );
}

describe("git apply invocations", () => {
  it("puts `--` before the patch path in every git apply argv, so a patch file whose name begins with a dash is a path and not an option", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "mutant.patch");
    writeValidPatch(patchPath, relPath);
    const runner = vi.mocked(runArgv);

    runner.mockClear();
    const computed = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );
    expect(computed.applicable).toBe(true);
    expect(runner.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["git", ["apply", "--numstat", "--", patchPath]],
      // The apply that actually writes the scratch file pins
      // `core.autocrlf=false` and `apply.whitespace=nowarn` (see the
      // comment at its call site in mutant.ts): the scratch directory
      // has no `.git` of its own, so without this it would otherwise
      // inherit the machine's ambient global/system config.
      [
        "git",
        [
          "-c",
          "core.autocrlf=false",
          "-c",
          "apply.whitespace=nowarn",
          "apply",
          "--",
          patchPath,
        ],
      ],
    ]);

    runner.mockClear();
    await applyPatchForReal(patchPath, root, makeTmpDir());
    expect(runner.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [
        "git",
        [
          "-c",
          "core.autocrlf=false",
          "-c",
          "apply.whitespace=nowarn",
          "apply",
          "--",
          patchPath,
        ],
      ],
    ]);
  });

  it("bounds every git apply at the caller's timeout, and at the fixed default when there is none", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "mutant.patch");
    writeValidPatch(patchPath, relPath);
    const runner = vi.mocked(runArgv);

    runner.mockClear();
    await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );
    await applyPatchForReal(patchPath, root, makeTmpDir());
    expect(runner.mock.calls.map((c) => c[2].timeoutMs)).toEqual([
      DEFAULT_GIT_APPLY_TIMEOUT_MS,
      DEFAULT_GIT_APPLY_TIMEOUT_MS,
      DEFAULT_GIT_APPLY_TIMEOUT_MS,
    ]);

    runner.mockClear();
    await computeMutant(
      { form: "patch", file: absFile, patchPath },
      {
        root,
        logDir: makeTmpDir(),
        originalContent: content,
        timeoutMs: 4321,
      },
    );
    await applyPatchForReal(patchPath, root, makeTmpDir(), {
      timeoutMs: 4321,
    });
    expect(runner.mock.calls.map((c) => c[2].timeoutMs)).toEqual([
      4321, 4321, 4321,
    ]);
  });

  it("hands the caller's abort signal to every git apply, so an interrupted apply is killed rather than left to land later", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "mutant.patch");
    writeValidPatch(patchPath, relPath);
    const controller = new AbortController();
    const runner = vi.mocked(runArgv);

    runner.mockClear();
    await computeMutant(
      { form: "patch", file: absFile, patchPath },
      {
        root,
        logDir: makeTmpDir(),
        originalContent: content,
        signal: controller.signal,
      },
    );
    await applyPatchForReal(patchPath, root, makeTmpDir(), {
      signal: controller.signal,
    });
    expect(runner.mock.calls.map((c) => c[2].signal)).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
  });

  it("names a dry run killed by its own bound as a timeout, not as a patch that failed to parse or to apply", async () => {
    const { root, relPath, absFile, content } = initRepoWithFile();
    const patchPath = path.join(root, "mutant.patch");
    writeValidPatch(patchPath, relPath);

    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    // The --numstat call, killed by the bound: a non-zero exit with
    // `timedOut`, exactly what run.ts reports for one.
    vi.mocked(runArgv).mockImplementationOnce(async (file, args, options) => {
      const result = await actualRun.runArgv(file, args, options);
      return { ...result, exitCode: null, timedOut: true };
    });

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );

    expect(result.applicable).toBe(false);
    if (result.applicable) return;
    expect(result.reasonCode).toBe("git_apply_timeout");
    expect(result.reason).toContain("hit its timeout");
    expect(result.reason).not.toContain("failed to parse");
  });
});

describe("listPatchTouchedPaths", () => {
  it("lists the single path a one-file patch touches", async () => {
    const { root, relPath } = initRepoWithFile();
    const patchPath = path.join(root, "mutant.patch");
    writeValidPatch(patchPath, relPath);

    const result = await listPatchTouchedPaths(patchPath, makeTmpDir(), {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths).toEqual([relPath]);
  });

  it("lists every path a multi-file patch touches, in numstat order", async () => {
    const { root, relPath } = initRepoWithFile();
    const patchPath = path.join(root, "two-file.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${relPath} b/${relPath}`,
        "index 0000000..0000000 100644",
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        "@@ -1,3 +1,3 @@",
        " function isPositive(n) {",
        "-  return n > 0;",
        "+  return false;",
        " }",
        "diff --git a/extra.js b/extra.js",
        "new file mode 100644",
        "index 0000000..0000000",
        "--- /dev/null",
        "+++ b/extra.js",
        "@@ -0,0 +1 @@",
        "+extra file content",
      ].join("\n") + "\n",
    );

    const result = await listPatchTouchedPaths(patchPath, makeTmpDir(), {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths).toEqual([relPath, "extra.js"]);
  });

  it("reports a not-ok result naming the log path when the patch does not parse", async () => {
    const patchPath = path.join(makeTmpDir(), "garbage.patch");
    fs.writeFileSync(patchPath, "not a real patch\n");

    const result = await listPatchTouchedPaths(patchPath, makeTmpDir(), {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("failed to parse");
    expect(fs.existsSync(result.logPath)).toBe(true);
  });
});

/**
 * The bound rule and the completeness walk, pinned against LITERAL
 * expected output at small, hand-checkable bounds.
 *
 * Every expectation below is a string written out in full, never a
 * re-application of the function under test to its own result: an
 * assertion of the shape `expect(f(x)).toBe(f(f(x)))` holds for any `f`
 * that is idempotent, including one that does the wrong thing, and is
 * what let a trim-to-the-last-complete-LINE defect sit unnoticed under a
 * green suite.
 */
describe("trimToLastCompleteHunk", () => {
  const PREAMBLE = ["--- a/before/f.txt", "+++ b/after/f.txt"];
  const TWO_HUNKS = [
    ...PREAMBLE,
    "@@ -1 +1 @@",
    "-a",
    "+A",
    "@@ -5,2 +5,2 @@",
    "-b",
    "-c",
    "+B",
    "+C",
  ].join("\n");

  it("returns a diff whose every hunk is complete unchanged", () => {
    expect(trimToLastCompleteHunk(TWO_HUNKS)).toBe(TWO_HUNKS);
  });

  it("drops a trailing hunk whose declared body is not fully present", () => {
    const cut = [
      ...PREAMBLE,
      "@@ -1 +1 @@",
      "-a",
      "+A",
      "@@ -5,2 +5,2 @@",
      "-b",
      "-c",
      "+B",
    ].join("\n");
    expect(trimToLastCompleteHunk(cut)).toBe(
      "--- a/before/f.txt\n+++ b/after/f.txt\n@@ -1 +1 @@\n-a\n+A",
    );
  });

  it("a cut landing exactly on a hunk boundary is already complete: unchanged", () => {
    const cut = [...PREAMBLE, "@@ -1 +1 @@", "-a", "+A"].join("\n");
    expect(trimToLastCompleteHunk(cut)).toBe(
      "--- a/before/f.txt\n+++ b/after/f.txt\n@@ -1 +1 @@\n-a\n+A",
    );
  });

  it("counts a character-level cut's trailing partial line as a body line, which is why a caller handling one drops it first", () => {
    // The documented contract: this function verifies hunks by their
    // headers' declared LINE counts, and a partial line is still a line.
    // `reconcileEnvelopeDiffTruncation` never hands it cut text for
    // exactly this reason -- it re-bounds the pre-envelope original
    // instead -- but a caller that does must drop the last line itself.
    const midLine = [
      ...PREAMBLE,
      "@@ -1 +1 @@",
      "-a",
      "+A",
      "@@ -5,2 +5,2 @@",
      "-b",
      "-c",
      "+B",
      "+", // "+C" cut mid-line
    ].join("\n");
    expect(trimToLastCompleteHunk(midLine)).toBe(midLine);
    const withPartialDropped = midLine.split("\n").slice(0, -1).join("\n");
    expect(trimToLastCompleteHunk(withPartialDropped)).toBe(
      "--- a/before/f.txt\n+++ b/after/f.txt\n@@ -1 +1 @@\n-a\n+A",
    );
  });

  it("returns the empty string when not even the first hunk is complete", () => {
    const cut = [...PREAMBLE, "@@ -1,2 +1,2 @@", "-a"].join("\n");
    expect(trimToLastCompleteHunk(cut)).toBe("");
  });

  it("returns the empty string for a preamble with no hunk behind it at all", () => {
    expect(trimToLastCompleteHunk(PREAMBLE.join("\n"))).toBe("");
  });

  it("reads a zero-count header (`@@ -5,0 +6,2 @@`, a pure insertion) as 0 removed plus 2 added", () => {
    const complete = [...PREAMBLE, "@@ -5,0 +6,2 @@", "+one", "+two"].join(
      "\n",
    );
    expect(trimToLastCompleteHunk(complete)).toBe(complete);
    const short = [...PREAMBLE, "@@ -5,0 +6,2 @@", "+one"].join("\n");
    expect(trimToLastCompleteHunk(short)).toBe("");
  });

  it("reads a count-omitted header (`@@ -5 +5 @@`) as one line on each side", () => {
    const complete = [...PREAMBLE, "@@ -5 +5 @@", "-old", "+new"].join("\n");
    expect(trimToLastCompleteHunk(complete)).toBe(complete);
    const short = [...PREAMBLE, "@@ -5 +5 @@", "-old"].join("\n");
    expect(trimToLastCompleteHunk(short)).toBe("");
  });

  it("treats `\\ No newline at end of file` as body the header does not count: a complete end-of-file hunk stays whole", () => {
    const eof = [
      ...PREAMBLE,
      "@@ -3 +3 @@",
      "-old last line",
      "\\ No newline at end of file",
      "+new last line",
      "\\ No newline at end of file",
    ].join("\n");
    expect(trimToLastCompleteHunk(eof)).toBe(eof);
  });

  it("does not abort the walk at a marker line between two hunks", () => {
    const twoWithEofFirst = [
      ...PREAMBLE,
      "@@ -1 +1 @@",
      "-a",
      "\\ No newline at end of file",
      "+A",
      "@@ -9 +9 @@",
      "-old",
      "+new",
    ].join("\n");
    expect(trimToLastCompleteHunk(twoWithEofFirst)).toBe(twoWithEofFirst);
  });

  it("still drops an end-of-file hunk whose added line was cut, keeping the hunk before it", () => {
    const cut = [
      ...PREAMBLE,
      "@@ -1 +1 @@",
      "-a",
      "+A",
      "@@ -9 +9 @@",
      "-old",
      "\\ No newline at end of file",
    ].join("\n");
    expect(trimToLastCompleteHunk(cut)).toBe(
      "--- a/before/f.txt\n+++ b/after/f.txt\n@@ -1 +1 @@\n-a\n+A",
    );
  });
});

describe("buildBoundedHunkExcerpt", () => {
  // preamble: 15 characters joined, 2 lines. Each hunk: 3 lines, 21
  // characters joined. The bound accounting is therefore
  // 16 (preamble + its joining newline) + 21 per hunk + 1 per join.
  const PREAMBLE = ["--- a/x", "+++ b/x"];
  const HUNK_1 = ["@@ -1 +1 @@", "-aaa", "+bbb"];
  const HUNK_2 = ["@@ -5 +5 @@", "-ccc", "+ddd"];

  it("keeps every hunk when they all fit", () => {
    const out = buildBoundedHunkExcerpt(PREAMBLE, [HUNK_1, HUNK_2], 100, 100);
    expect(out.text).toBe(
      "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-aaa\n+bbb\n@@ -5 +5 @@\n-ccc\n+ddd",
    );
    expect(out.text.length).toBe(59);
    expect(out).toMatchObject({
      truncated: false,
      hunkTruncated: false,
      bodyOmitted: false,
      keptHunks: 2,
    });
  });

  it("drops a whole hunk that does not fit the character bound", () => {
    const out = buildBoundedHunkExcerpt(PREAMBLE, [HUNK_1, HUNK_2], 100, 50);
    expect(out.text).toBe("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-aaa\n+bbb");
    expect(out.text.length).toBe(37);
    expect(out).toMatchObject({
      truncated: true,
      hunkTruncated: false,
      bodyOmitted: false,
      keptHunks: 1,
    });
  });

  it("drops a whole hunk that does not fit the line bound", () => {
    const out = buildBoundedHunkExcerpt(PREAMBLE, [HUNK_1, HUNK_2], 5, 1000);
    expect(out.text).toBe("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-aaa\n+bbb");
    expect(out).toMatchObject({ truncated: true, keptHunks: 1 });
  });

  it("cuts the FIRST hunk at a line boundary when it alone exceeds the bound", () => {
    const big = [
      "@@ -1,3 +1,3 @@",
      "-aaaa",
      "-bbbb",
      "-cccc",
      "+AAAA",
      "+BBBB",
      "+CCCC",
    ];
    const out = buildBoundedHunkExcerpt(PREAMBLE, [big], 100, 40);
    // The preamble goes first: it names only the comparison's own
    // scratch paths, and every character it costs is a line of the
    // actual change that cannot be shown.
    expect(out.text).toBe("@@ -1,3 +1,3 @@\n-aaaa\n-bbbb\n-cccc\n+AAAA");
    expect(out.text.length).toBe(39);
    expect(out.text.length).toBeLessThanOrEqual(40);
    expect(out).toMatchObject({
      truncated: true,
      hunkTruncated: true,
      bodyOmitted: false,
      keptHunks: 0,
    });
  });

  it("drops the preamble rather than hunk content once no whole hunk fits beside it", () => {
    const out = buildBoundedHunkExcerpt(PREAMBLE, [HUNK_1], 100, 20);
    expect(out.text).toBe("@@ -1 +1 @@\n-aaa");
    expect(out.text.length).toBe(16);
    expect(out).toMatchObject({
      truncated: true,
      hunkTruncated: true,
      bodyOmitted: false,
      keptHunks: 0,
    });
  });

  it("reports a whole hunk delivered without its preamble as truncated, never as the complete excerpt", () => {
    // 21 characters is exactly HUNK_1; the 16-character preamble does
    // not fit beside it.
    const out = buildBoundedHunkExcerpt(PREAMBLE, [HUNK_1], 100, 21);
    expect(out.text).toBe("@@ -1 +1 @@\n-aaa\n+bbb");
    expect(out).toMatchObject({
      truncated: true,
      hunkTruncated: false,
      bodyOmitted: false,
      keptHunks: 1,
    });
  });

  it("delivers an empty text WITH `bodyOmitted` when not even the first hunk's header fits", () => {
    const out = buildBoundedHunkExcerpt(PREAMBLE, [HUNK_1], 100, 8);
    expect(out.text).toBe("");
    expect(out).toMatchObject({
      truncated: true,
      hunkTruncated: false,
      bodyOmitted: true,
      keptHunks: 0,
    });
  });

  it("returns the preamble untruncated when there are no hunks at all", () => {
    const out = buildBoundedHunkExcerpt(PREAMBLE, [], 100, 100);
    expect(out.text).toBe("--- a/x\n+++ b/x");
    expect(out).toMatchObject({ truncated: false, keptHunks: 0 });
  });

  it("bounds the preamble like any other content for a zero-hunk input, rather than shipping it whole regardless of either bound", () => {
    // A character bound that fits the first preamble line but not both:
    // never a mid-line cut, so the second line is dropped whole.
    const oneLine = buildBoundedHunkExcerpt(PREAMBLE, [], 100, 10);
    expect(oneLine.text).toBe("--- a/x");
    expect(oneLine).toMatchObject({ truncated: true, keptHunks: 0 });

    // A line bound of 1 behaves the same way, from the other bound.
    const lineBounded = buildBoundedHunkExcerpt(PREAMBLE, [], 1, 1000);
    expect(lineBounded.text).toBe("--- a/x");
    expect(lineBounded).toMatchObject({ truncated: true, keptHunks: 0 });

    // Not even the first line fits: an empty string, with `bodyOmitted`
    // saying so -- never a silent empty excerpt behind a "whole" or
    // "truncated: false" claim.
    const nothing = buildBoundedHunkExcerpt(PREAMBLE, [], 100, 3);
    expect(nothing.text).toBe("");
    expect(nothing).toMatchObject({
      truncated: true,
      hunkTruncated: false,
      bodyOmitted: true,
      keptHunks: 0,
    });
  });

  it("returns a value rather than throwing for a zero-hunk input, which is what the dedicated hunks.length === 0 branch exists to guarantee (see the function's own docblock: folding it into boundHunksUnder's shared fallback would index hunks[0] of an empty array and throw instead)", () => {
    expect(() => buildBoundedHunkExcerpt(PREAMBLE, [], 100, 100)).not.toThrow();
    expect(() => buildBoundedHunkExcerpt([], [], 100, 100)).not.toThrow();
  });
});

describe("reconcileEnvelopeDiffTruncation", () => {
  const DIFF_PATH = "/tmp/probe-logs/mutant-diff-abc123/mutant-diff.patch";
  const ORIGINAL_TEXT =
    "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-aaa\n+bbb\n@@ -5 +5 @@\n-ccc\n+ddd";
  const HUNK_1_ONLY = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-aaa\n+bbb";

  function originalDiff(
    overrides: Partial<MutantDiffField> = {},
  ): MutantDiffField {
    return {
      text: ORIGINAL_TEXT,
      path: DIFF_PATH,
      hunkCount: 2,
      removed: 2,
      added: 2,
      changedLineCount: 4,
      truncated: false,
      ...overrides,
    };
  }

  function originalMutant(diff: MutantDiffField | undefined): {
    file: string;
    line: number;
    before: string;
    after: string;
    diff?: MutantDiffField;
  } {
    return {
      file: "fixture.js",
      line: 2,
      before: "old line",
      after: "new line",
      ...(diff !== undefined ? { diff } : {}),
    };
  }

  /** The envelope shape `cli.ts` hands the correction for a single
   * probe, with `diff` already in whatever state the reduction left it. */
  function envelopeWith(
    deliveredDiff: unknown,
    descriptors: { mutant: string; verified_applied_via: string },
  ): Record<string, unknown> {
    return {
      mutant: {
        file: "fixture.js",
        line: 2,
        before: "old line",
        after: "new line",
        form: "patch",
        ...(deliveredDiff !== undefined ? { diff: deliveredDiff } : {}),
      },
      mutation_probe: {
        ...descriptors,
        result: "survived",
        restored_verified: true,
      },
    };
  }

  const WHOLE_SUMMARY =
    "fixture.js:2: old line -> new line (first of 4 changed lines across " +
    "2 hunks; see mutant.diff (whole); full diff at mutant.diff.path)";
  const WHOLE_VIA =
    "git diff --no-index of the before/after scratch copies: 2 hunks, 4 " +
    "changed lines (2 removed, 2 added); see mutant.diff (whole); full " +
    "diff at mutant.diff.path";

  it("rebuilds a cut excerpt from the pre-envelope original and restates both descriptors", () => {
    // What `buildEnvelope`'s own generic string cap produces: a prefix
    // of the excerpt (mid-line, mid-hunk) plus its omission marker.
    const deliveredText =
      ORIGINAL_TEXT.slice(0, 45) + "...(14 more characters omitted)";
    expect(deliveredText).toMatch(ENVELOPE_MARKER_RE);
    const envelope = envelopeWith(
      {
        text: deliveredText,
        path: DIFF_PATH,
        hunkCount: 2,
        removed: 2,
        added: 2,
        changedLineCount: 4,
        truncated: false,
      },
      { mutant: WHOLE_SUMMARY, verified_applied_via: WHOLE_VIA },
    );

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(originalDiff()),
    });

    const diff = (envelope.mutant as Record<string, unknown>).diff as Record<
      string,
      unknown
    >;
    // Rebuilt from the ORIGINAL under the delivered text's own budget:
    // whole hunks, no marker, never a repair of the cut string.
    expect(diff.text).toBe(HUNK_1_ONLY);
    expect(diff.truncated).toBe(true);
    expect(diff.hunkTruncated).toBeUndefined();
    expect(diff.bodyOmitted).toBeUndefined();
    // Never revised: they name the true totals, fixed before any bound.
    expect(diff.hunkCount).toBe(2);
    expect(diff.removed).toBe(2);
    expect(diff.added).toBe(2);
    expect(diff.changedLineCount).toBe(4);
    expect(diff.path).toBe(DIFF_PATH);
    // Never longer than the string it replaced.
    expect(String(diff.text).length).toBeLessThanOrEqual(deliveredText.length);

    const probeField = envelope.mutation_probe as Record<string, unknown>;
    expect(probeField.mutant).toBe(
      "fixture.js:2: old line -> new line (first of 4 changed lines across " +
        "2 hunks; see mutant.diff (truncated); full diff at mutant.diff.path)",
    );
    expect(probeField.verified_applied_via).toBe(
      "git diff --no-index of the before/after scratch copies: 2 hunks, 4 " +
        "changed lines (2 removed, 2 added); see mutant.diff (truncated); " +
        "full diff at mutant.diff.path",
    );
    // The four contract fields around them are untouched.
    expect(probeField.result).toBe("survived");
    expect(probeField.restored_verified).toBe(true);
  });

  it("leaves an untouched excerpt alone even when its own last line ends in the envelope's omission-marker literal", () => {
    // A mutant that adds a line quoting the marker text is legitimate
    // content, not evidence of a cut. Deciding on the suffix alone
    // emptied the whole excerpt here and set a false `truncated`.
    const text =
      "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+log.warn: ...(12 more characters omitted)";
    expect(text).toMatch(ENVELOPE_MARKER_RE);
    const diffField: MutantDiffField = {
      text,
      path: DIFF_PATH,
      hunkCount: 1,
      removed: 1,
      added: 1,
      changedLineCount: 2,
      truncated: false,
    };
    const summary =
      "fixture.js:2: old line -> new line (first of 2 changed lines across " +
      "1 hunk; see mutant.diff (whole); full diff at mutant.diff.path)";
    const via =
      "git diff --no-index of the before/after scratch copies: 1 hunk, 2 " +
      "changed lines (1 removed, 1 added); see mutant.diff (whole); full " +
      "diff at mutant.diff.path";
    const delivered = { ...diffField };
    const envelope = envelopeWith(delivered, {
      mutant: summary,
      verified_applied_via: via,
    });

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(diffField),
    });

    expect(delivered).toEqual(diffField);
    const probeField = envelope.mutation_probe as Record<string, unknown>;
    expect(probeField.mutant).toBe(summary);
    expect(probeField.verified_applied_via).toBe(via);
  });

  it("stops the descriptors pointing at a `diff` the envelope dropped, and puts nothing back", () => {
    const envelope = envelopeWith(undefined, {
      mutant: WHOLE_SUMMARY,
      verified_applied_via: WHOLE_VIA,
    });

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(originalDiff()),
    });

    expect((envelope.mutant as Record<string, unknown>).diff).toBeUndefined();
    const probeField = envelope.mutation_probe as Record<string, unknown>;
    expect(probeField.mutant).toBe(
      "fixture.js:2: old line -> new line (first of 4 changed lines across " +
        "2 hunks; mutant.diff omitted from this envelope; see logs)",
    );
    expect(probeField.verified_applied_via).toBe(
      "git diff --no-index of the before/after scratch copies: 2 hunks, 4 " +
        "changed lines (2 removed, 2 added); mutant.diff omitted from this " +
        "envelope; see logs",
    );
  });

  it("treats a depth-pruned placeholder in place of `diff` as an omission too", () => {
    const envelope = envelopeWith("...(subtree pruned at depth 5)", {
      mutant: WHOLE_SUMMARY,
      verified_applied_via: WHOLE_VIA,
    });

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(originalDiff()),
    });

    expect((envelope.mutant as Record<string, unknown>).diff).toBe(
      "...(subtree pruned at depth 5)",
    );
    expect(
      String((envelope.mutation_probe as Record<string, unknown>).mutant),
    ).toContain("mutant.diff omitted from this envelope; see logs");
  });

  it("treats a `mutant` field the reduction replaced wholesale as an omission", () => {
    const envelope: Record<string, unknown> = {
      mutant: "...(subtree pruned at depth 4)",
      mutation_probe: {
        mutant: WHOLE_SUMMARY,
        verified_applied_via: WHOLE_VIA,
        result: "survived",
        restored_verified: true,
      },
    };

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(originalDiff()),
    });

    expect(envelope.mutant).toBe("...(subtree pruned at depth 4)");
    expect(
      String((envelope.mutation_probe as Record<string, unknown>).mutant),
    ).toContain("mutant.diff omitted from this envelope; see logs");
  });

  it("does nothing for a mutant that never had an excerpt", () => {
    const envelope: Record<string, unknown> = {
      mutant: {
        file: "fixture.js",
        line: 2,
        before: "old line",
        after: "new line",
        form: "replace",
      },
      mutation_probe: {
        mutant: "fixture.js:2: old line -> new line",
        verified_applied_via: "fixture.js:2\n- old line\n+ new line",
        result: "killed",
        restored_verified: true,
      },
    };

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(undefined),
    });

    expect(envelope.mutation_probe).toEqual({
      mutant: "fixture.js:2: old line -> new line",
      verified_applied_via: "fixture.js:2\n- old line\n+ new line",
      result: "killed",
      restored_verified: true,
    });
  });

  it("never re-delivers a mid-hunk tail the excerpt's own bound had already left, as if it were whole", () => {
    // The pre-envelope excerpt was itself cut inside its only hunk.
    const midHunkOriginal: MutantDiffField = {
      text: "--- a/x\n+++ b/x\n@@ -1,4 +1,4 @@\n-aaa\n-bbb",
      path: DIFF_PATH,
      hunkCount: 1,
      removed: 4,
      added: 4,
      changedLineCount: 8,
      truncated: true,
      hunkTruncated: true,
    };
    const delivered = {
      ...midHunkOriginal,
      text:
        midHunkOriginal.text.slice(0, 30) + "...(12 more characters omitted)",
      truncated: false,
      hunkTruncated: false,
    };
    const envelope = envelopeWith(delivered, {
      mutant: "unused",
      verified_applied_via: "unused",
    });

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(midHunkOriginal),
    });

    const diff = (envelope.mutant as Record<string, unknown>).diff as Record<
      string,
      unknown
    >;
    expect(diff.truncated).toBe(true);
    // Still a cut hunk, never relabelled complete.
    expect(diff.hunkTruncated === true || diff.bodyOmitted === true).toBe(true);
    expect(String(diff.text).startsWith("--- a/x\n+++ b/x")).toBe(
      diff.bodyOmitted !== true,
    );
    expect(midHunkOriginal.text.startsWith(String(diff.text))).toBe(true);
  });

  it("stops the corrected excerpt at the last complete hunk, never re-including a malformed trailing hunk fragment past it, even when the original is itself flagged hunkTruncated", () => {
    // `EnvelopeDiffOriginals`/`MutantOriginal` are structurally typed on
    // purpose (see their own docblocks): nothing stops a library caller
    // composing its own envelope from handing this a `hunkTruncated:
    // true` original whose text nonetheless carries one complete hunk
    // followed by a second, malformed one (a header whose declared
    // count does not match what actually follows it) -- a shape this
    // module's own producer (`buildBoundedHunkExcerpt`) never emits
    // itself (`hunkTruncated` there only ever describes a lone, partial
    // FIRST hunk, never a later one behind an already-complete prefix),
    // but the type does not forbid it. `rebuildDeliveredExcerpt`'s
    // `completePrefix` rule has to stop the rebuilt excerpt at the last
    // hunk `trimToLastCompleteHunk` can actually vouch for, rather than
    // reusing the whole original text regardless of what its own
    // `hunkTruncated` flag says.
    const completeHunk = "@@ -1,1 +1,1 @@\n-x\n+y";
    const malformedTrailingHunk = "@@ -3,5 +3,5 @@\n-p";
    const original: MutantDiffField = {
      text: `${completeHunk}\n${malformedTrailingHunk}`,
      path: DIFF_PATH,
      hunkCount: 2,
      removed: 6,
      added: 6,
      changedLineCount: 12,
      truncated: true,
      hunkTruncated: true,
    };
    // Premise check: the last hunk genuinely is not one
    // `trimToLastCompleteHunk` can vouch for (its header declares 10
    // body lines; only one follows), so the complete prefix really does
    // stop before it.
    expect(trimToLastCompleteHunk(original.text)).toBe(completeHunk);

    // Long and different from `original.text`, so case 2 runs with a
    // generous budget -- comfortably large enough to fit BOTH hunks,
    // which is what makes this discriminate: a correction that used
    // `original.text` outright (ignoring `completePrefix`) would have
    // room to re-include the malformed trailing hunk whole.
    const deliveredDiff: Record<string, unknown> = {
      ...original,
      text: "y".repeat(300),
    };
    const envelope = envelopeWith(deliveredDiff, {
      mutant: "unused",
      verified_applied_via: "unused",
    });

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(original),
    });

    const diff = (envelope.mutant as Record<string, unknown>).diff as Record<
      string,
      unknown
    >;
    expect(diff.text).toBe(completeHunk);
    expect(String(diff.text)).not.toContain("-p");
  });

  it("matches a plan's delivered entries to the originals by index, leaving the array marker alone", () => {
    const cutText =
      ORIGINAL_TEXT.slice(0, 45) + "...(14 more characters omitted)";
    const entry = (deliveredText: string): Record<string, unknown> => ({
      index: 0,
      mutant: {
        file: "fixture.js",
        line: 2,
        before: "old line",
        after: "new line",
        form: "patch",
        diff: {
          text: deliveredText,
          path: DIFF_PATH,
          hunkCount: 2,
          removed: 2,
          added: 2,
          changedLineCount: 4,
          truncated: false,
        },
      },
      mutation_probe: {
        mutant: WHOLE_SUMMARY,
        verified_applied_via: WHOLE_VIA,
        result: "survived",
        restored_verified: true,
      },
    });
    const envelope: Record<string, unknown> = {
      plan: {
        results: [
          entry(ORIGINAL_TEXT),
          entry(cutText),
          "...(3 more items omitted)",
        ],
      },
    };

    reconcileEnvelopeDiffTruncation(envelope, {
      planResults: [
        { mutant: originalMutant(originalDiff()) },
        { mutant: originalMutant(originalDiff()) },
      ],
    });

    const results = (envelope.plan as { results: unknown[] }).results;
    const first = (results[0] as Record<string, unknown>).mutant as Record<
      string,
      unknown
    >;
    const second = (results[1] as Record<string, unknown>).mutant as Record<
      string,
      unknown
    >;
    // Untouched: it was delivered whole.
    expect((first.diff as Record<string, unknown>).text).toBe(ORIGINAL_TEXT);
    expect((first.diff as Record<string, unknown>).truncated).toBe(false);
    // Corrected: it was cut.
    expect((second.diff as Record<string, unknown>).text).toBe(HUNK_1_ONLY);
    expect((second.diff as Record<string, unknown>).truncated).toBe(true);
    expect(results[2]).toBe("...(3 more items omitted)");
  });

  it("drops the `; full diff at mutant.diff.path` clause when the delivered `path` value itself was capped by the envelope's own string cap", () => {
    const cutText =
      ORIGINAL_TEXT.slice(0, 45) + "...(14 more characters omitted)";
    // What the envelope's own generic string cap does to a long `-l`
    // path: a prefix plus its own omission marker, no longer the real
    // path at all.
    const cutPath = DIFF_PATH.slice(0, 6) + "...(40 more characters omitted)";
    const envelope = envelopeWith(
      {
        text: cutText,
        path: cutPath,
        hunkCount: 2,
        removed: 2,
        added: 2,
        changedLineCount: 4,
        truncated: false,
      },
      { mutant: WHOLE_SUMMARY, verified_applied_via: WHOLE_VIA },
    );

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(originalDiff()),
    });

    const probeField = envelope.mutation_probe as Record<string, unknown>;
    expect(probeField.mutant).not.toContain("mutant.diff.path");
    expect(probeField.mutant).toContain("see mutant.diff (truncated)");
    expect(probeField.verified_applied_via).not.toContain("mutant.diff.path");
    expect(probeField.verified_applied_via).toContain(
      "see mutant.diff (truncated)",
    );
    // The delivered `path` field itself is left exactly as the envelope
    // capped it: `path` is not in `CORRECTABLE_DIFF_KEYS`, so this
    // correction never touches it either way.
    const diff = (envelope.mutant as Record<string, unknown>).diff as Record<
      string,
      unknown
    >;
    expect(diff.path).toBe(cutPath);
  });

  it("drops the pointer's path half when the reduction dropped the `path` key entirely (only `text` survived)", () => {
    const cutText =
      ORIGINAL_TEXT.slice(0, 45) + "...(14 more characters omitted)";
    const envelope = envelopeWith(
      {
        text: cutText,
        // No `path` at all: the object's own key cap dropped it while
        // `text` (needed for case 2 to run at all) survived.
        hunkCount: 2,
        removed: 2,
        added: 2,
        changedLineCount: 4,
        truncated: false,
      },
      { mutant: WHOLE_SUMMARY, verified_applied_via: WHOLE_VIA },
    );

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(originalDiff()),
    });

    const probeField = envelope.mutation_probe as Record<string, unknown>;
    expect(probeField.mutant).not.toContain("mutant.diff.path");
    expect(probeField.verified_applied_via).not.toContain("mutant.diff.path");
    expect(probeField.mutant).toContain("see mutant.diff (truncated)");
  });

  it("keeps the pointer's path half when the delivered `path` still matches the original's", () => {
    const cutText =
      ORIGINAL_TEXT.slice(0, 45) + "...(14 more characters omitted)";
    const envelope = envelopeWith(
      {
        text: cutText,
        path: DIFF_PATH,
        hunkCount: 2,
        removed: 2,
        added: 2,
        changedLineCount: 4,
        truncated: false,
      },
      { mutant: WHOLE_SUMMARY, verified_applied_via: WHOLE_VIA },
    );

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(originalDiff()),
    });

    const probeField = envelope.mutation_probe as Record<string, unknown>;
    expect(probeField.mutant).toContain("full diff at mutant.diff.path");
    expect(probeField.verified_applied_via).toContain(
      "full diff at mutant.diff.path",
    );
  });

  it("decrements a diff object's own omitted-key marker only for a key that genuinely existed before any capping ran", () => {
    // The pristine excerpt was already hunk-truncated (unrelated to the
    // envelope: the module's own bound had already cut its one hunk
    // before `buildEnvelope` ever ran), so `hunkTruncated` is a real key
    // of the TRUE original -- one the object's own key cap can genuinely
    // drop and this correction can genuinely un-drop.
    const alreadyHunkTruncated: MutantDiffField = {
      text: "@@ -1,4 +1,4 @@\n-aaa\n-bbb\n-ccc\n-ddd",
      path: DIFF_PATH,
      hunkCount: 1,
      removed: 4,
      added: 4,
      changedLineCount: 8,
      truncated: true,
      hunkTruncated: true,
    };
    const deliveredDiff: Record<string, unknown> = {
      // Cut further still by the envelope's own string cap; differs
      // from the original so case 2 runs.
      text: "@@ -1,4 +1,4 @@\n-aaa",
      path: DIFF_PATH,
      hunkCount: 1,
      removed: 4,
      added: 4,
      truncated: true,
      // `hunkTruncated` and `changedLineCount` both dropped by the
      // object's own key cap.
      "...": "2 more keys omitted",
    };
    const envelope = envelopeWith(deliveredDiff, {
      mutant: "unused",
      verified_applied_via: "unused",
    });

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(alreadyHunkTruncated),
    });

    const diff = (envelope.mutant as Record<string, unknown>).diff as Record<
      string,
      unknown
    >;
    // `hunkTruncated` is un-dropped (the cut still lands inside the same
    // hunk), so the marker's own count decrements by exactly the one key
    // this wrote back -- `changedLineCount` is still genuinely missing.
    expect(diff.hunkTruncated).toBe(true);
    expect(diff["..."]).toBe("1 more key omitted");
  });

  it("does not decrement the marker for a flag this correction introduces fresh, never present in the pristine excerpt before any capping", () => {
    // The pristine excerpt was whole (no `hunkTruncated`/`bodyOmitted` at
    // all): a tiny delivered budget forces a NEW mid-hunk (or
    // header-only) cut this correction introduces on its own, which
    // never existed for the object's own key cap to have dropped.
    const deliveredDiff: Record<string, unknown> = {
      text: ORIGINAL_TEXT.slice(0, 10),
      path: DIFF_PATH,
      hunkCount: 2,
      removed: 2,
      added: 2,
      truncated: false,
      // `changedLineCount` dropped by the cap -- unrelated to anything
      // this correction ever writes back.
      "...": "1 more key omitted",
    };
    const envelope = envelopeWith(deliveredDiff, {
      mutant: WHOLE_SUMMARY,
      verified_applied_via: WHOLE_VIA,
    });

    reconcileEnvelopeDiffTruncation(envelope, {
      mutant: originalMutant(originalDiff()),
    });

    const diff = (envelope.mutant as Record<string, unknown>).diff as Record<
      string,
      unknown
    >;
    // Whichever of `hunkTruncated`/`bodyOmitted` this introduced, the
    // marker's count is untouched: it never named either of them.
    expect(diff["..."]).toBe("1 more key omitted");
  });

  it("re-measures and shrinks the corrected excerpt further when writing its flags back pushed a REAL buildEnvelope-built envelope past `maxChars` (the measured -m 4200 defect: a 1-hunk/1000-changed-line patch)", () => {
    // Built through the actual `buildEnvelope`, exactly as `cli.ts` does,
    // so the pre-correction envelope handed to `reconcileEnvelopeDiffTruncation`
    // genuinely satisfies the invariant this correction's own budget
    // arithmetic relies on (`serializedLength <= max(maxChars,
    // skeletonFloor)`) rather than an invariant this test merely asserts.
    const bigHunkLines = Array.from(
      { length: 1000 },
      (_, i) => `-old wide line ${String(i)} ${"x".repeat(40)}`,
    );
    const bigOriginal: MutantDiffField = {
      text: [
        "--- a/wide.txt",
        "+++ b/wide.txt",
        "@@ -1,1000 +1,1000 @@",
        ...bigHunkLines,
      ].join("\n"),
      path: "/tmp/probe-logs/mutant-diff-wide/mutant-diff.patch",
      hunkCount: 1,
      removed: 1000,
      added: 0,
      changedLineCount: 1000,
      truncated: false,
    };
    const originalMutantField = {
      file: "wide.txt",
      line: 1,
      before: "old wide line 0",
      after: "",
      diff: bigOriginal,
    };
    const summary = formatMutantSummary(
      "wide.txt",
      1,
      "old wide line 0",
      "",
      bigOriginal,
    );
    const via = formatVerifiedAppliedVia(
      "wide.txt",
      1,
      "old wide line 0",
      "",
      bigOriginal,
    );
    const maxChars = 4200;

    const { envelope } = buildEnvelope({
      version: "test",
      command: "probe",
      status: "survived",
      durationMs: 1,
      cwd: "/tmp",
      warnings: [],
      logs: [],
      extra: {
        mutant: {
          file: "wide.txt",
          line: 1,
          before: "old wide line 0",
          after: "",
          form: "patch",
          diff: bigOriginal,
        },
        mutation_probe: {
          mutant: summary,
          verified_applied_via: via,
          result: "survived",
          restored_verified: true,
        },
      },
      maxChars,
    });
    // `buildEnvelope`'s own guarantee, restated as a premise check: if
    // this ever failed, the rest of the test would be exercising an
    // envelope shape `buildEnvelope` itself would never actually produce.
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);

    reconcileEnvelopeDiffTruncation(
      envelope,
      { mutant: originalMutantField },
      maxChars,
    );

    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
  });

  it("does not duplicate the overrun warning when the whole envelope is still over `maxChars` after every target has been shrunk to nothing", () => {
    // An unrelated fixed field this correction never touches, sized so
    // the envelope stays past `maxChars` no matter how far the one
    // target's excerpt is shrunk -- the shape that reaches
    // `pushBudgetOverrunWarning` a SECOND time (`buildEnvelope`'s own
    // reduction already appended one, simulated here directly rather
    // than through a real `buildEnvelope` call, since only the dedup
    // behaviour of the second append is under test).
    const padding = "z".repeat(5000);
    const alreadyHunkTruncated: MutantDiffField = {
      text: "@@ -1,4 +1,4 @@\n-aaa\n-bbb\n-ccc\n-ddd",
      path: DIFF_PATH,
      hunkCount: 1,
      removed: 4,
      added: 4,
      changedLineCount: 8,
      truncated: true,
      hunkTruncated: true,
    };
    // Delivered short with dropped keys, so restoring them (`writeCorrectableDiffKeys`)
    // and restating the descriptors (`unused` -> the real formatted
    // summary/via strings) both grow the envelope past its
    // pre-correction length, entering `enforceEnvelopeBudget`'s shrink
    // search.
    const deliveredDiff: Record<string, unknown> = {
      text: "@@ -1,4 +1,4 @@\n-aaa",
      path: DIFF_PATH,
      hunkCount: 1,
      removed: 4,
      added: 4,
      truncated: true,
      "...": "2 more keys omitted",
    };
    const envelope = envelopeWith(deliveredDiff, {
      mutant: "unused",
      verified_applied_via: "unused",
    });
    envelope.warnings = [
      "envelope is 12345 characters; requested max-chars 10 could not be met",
    ];
    envelope.padding = padding;

    reconcileEnvelopeDiffTruncation(
      envelope,
      { mutant: originalMutant(alreadyHunkTruncated) },
      10,
    );

    const overrunWarnings = (envelope.warnings as string[]).filter((w) =>
      /could not be met/.test(w),
    );
    expect(overrunWarnings.length).toBe(1);
    // The one warning that survives states the TRUE final length, not
    // the stale one the pre-existing warning named.
    expect(overrunWarnings[0]).not.toBe(
      "envelope is 12345 characters; requested max-chars 10 could not be met",
    );
  });

  it("leaves a non-array `warnings` field untouched, rather than overwriting it, when the envelope is still over `maxChars` after correction", () => {
    const padding = "z".repeat(5000);
    const alreadyHunkTruncated: MutantDiffField = {
      text: "@@ -1,4 +1,4 @@\n-aaa\n-bbb\n-ccc\n-ddd",
      path: DIFF_PATH,
      hunkCount: 1,
      removed: 4,
      added: 4,
      changedLineCount: 8,
      truncated: true,
      hunkTruncated: true,
    };
    const deliveredDiff: Record<string, unknown> = {
      text: "@@ -1,4 +1,4 @@\n-aaa",
      path: DIFF_PATH,
      hunkCount: 1,
      removed: 4,
      added: 4,
      truncated: true,
      "...": "2 more keys omitted",
    };
    const envelope = envelopeWith(deliveredDiff, {
      mutant: "unused",
      verified_applied_via: "unused",
    });
    const nonArrayWarnings = "not an array; left alone rather than clobbered";
    envelope.warnings = nonArrayWarnings;
    envelope.padding = padding;

    reconcileEnvelopeDiffTruncation(
      envelope,
      { mutant: originalMutant(alreadyHunkTruncated) },
      10,
    );

    expect(envelope.warnings).toBe(nonArrayWarnings);
  });

  it("re-measures and warns after a case-3 correction grows a REAL buildEnvelope-built envelope past `maxChars`, even though no target was ever pushed to shrink (task e82f341a)", () => {
    // The pre-envelope evidence: a real diff with NO `path` (the probe
    // could not write the full diff to disk), which is exactly what makes
    // case 3's rewritten descriptors longer than the ones they replace
    // (`describeExcerptPointer`'s omission clause has no `; full diff at
    // mutant.diff.path` to offset against).
    const noPathDiff: MutantDiffField = {
      text: "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-aaa\n-bbb\n-ccc\n+ddd\n+eee\n+fff",
      hunkCount: 1,
      removed: 3,
      added: 3,
      changedLineCount: 6,
      truncated: false,
    };
    const summary = formatMutantSummary(
      "fixture.js",
      2,
      "old line",
      "new line",
      noPathDiff,
    );
    const via = formatVerifiedAppliedVia(
      "fixture.js",
      2,
      "old line",
      "new line",
      noPathDiff,
    );
    const originalMutantField = {
      file: "fixture.js",
      line: 2,
      before: "old line",
      after: "new line",
      diff: noPathDiff,
    };

    // A REAL `buildEnvelope` call (a generous `maxChars` so it is a pure
    // pass-through here, not a fabricated shape): the case-3 precondition
    // -- `diff` already gone from `mutant`, both descriptors still the
    // pristine strings the probe produced -- is exactly what a caller
    // composing this envelope from a prior, harsher reduction pass would
    // hand in, and is the one shape `reconcileOneMutant`'s case 3 exists
    // to correct.
    const buildCase3Envelope = () =>
      buildEnvelope({
        version: "test",
        command: "probe",
        status: "survived",
        durationMs: 1,
        cwd: "/tmp",
        warnings: [],
        logs: [],
        extra: {
          mutant: {
            file: "fixture.js",
            line: 2,
            before: "old line",
            after: "new line",
            form: "patch",
            // `diff` omitted: what a prior reduction pass left behind.
          },
          mutation_probe: {
            mutant: summary,
            verified_applied_via: via,
            result: "survived",
            restored_verified: true,
          },
        },
      });

    const { envelope: uncut } = buildCase3Envelope();
    const preLen = JSON.stringify(uncut).length;

    // Learn the correction's own natural, unshrunk length: a huge budget
    // that can never itself trigger `pushBudgetOverrunWarning`, so the
    // only thing this measures is how long the case-3 rewrite makes the
    // envelope on its own.
    const { envelope: reference } = buildCase3Envelope();
    reconcileEnvelopeDiffTruncation(
      reference,
      { mutant: originalMutantField },
      preLen * 10,
    );
    const correctedLength = JSON.stringify(reference).length;
    // Premise check: the correction actually grew the envelope past its
    // pre-correction length, which is what makes this fixture a real
    // exercise of case 3's own growth rather than a no-op.
    expect(correctedLength).toBeGreaterThan(preLen);

    // The budget under test: a few characters BELOW the corrected
    // length, so the envelope is genuinely over budget once the
    // descriptors are rewritten and `enforceEnvelopeBudget` has nothing
    // to shrink (case 3 never pushes a target).
    const budget = correctedLength - 3;

    const { envelope } = buildCase3Envelope();
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(budget);

    reconcileEnvelopeDiffTruncation(
      envelope,
      { mutant: originalMutantField },
      budget,
    );

    const finalLength = JSON.stringify(envelope).length;
    // The bound contract: either the envelope came back within `budget`,
    // or it is over and a warning names the TRUE final length -- never
    // silently over budget with no warning at all, which is what the
    // `targets.length === 0` early return in `enforceEnvelopeBudget`
    // used to allow for a case-3-only correction.
    const warnings = Array.isArray(envelope.warnings)
      ? (envelope.warnings as unknown[])
      : [];
    // Pin which arm this fixture actually takes: `budget` is set 3
    // characters below the case-3 correction's own natural length, and
    // case 3 never pushes a target for `enforceEnvelopeBudget` to
    // shrink, so this fixture must land over budget with a warning --
    // never silently within it. Asserting that here, before the
    // disjunction below, keeps a change that moved this fixture onto
    // the other arm from passing on the disjunction's tautological else
    // (`finalLength <= budget` proving itself).
    expect(finalLength).toBeGreaterThan(budget);
    const overrunBefore = warnings.find(
      (w) => typeof w === "string" && /could not be met/.test(w),
    );
    expect(overrunBefore).toBeDefined();
    if (finalLength > budget) {
      const overrun = warnings.find(
        (w) => typeof w === "string" && /could not be met/.test(w),
      );
      expect(overrun).toBeDefined();
      expect(overrun).toContain(`${String(finalLength)} characters`);
    } else {
      expect(finalLength).toBeLessThanOrEqual(budget);
    }
  });

  it("replaces a prior-pass overrun warning already on the envelope with one naming the case-3-grown final length, rather than appending a second one (task e82f341a)", () => {
    // The pre-envelope evidence: same no-path diff shape as the sibling
    // fixture above -- case 3's own precondition (`diff` already gone
    // from `mutant`, both descriptors still pristine) needs no `targets`
    // pushed to exercise the newly reachable empty-targets branch.
    //
    // A sweep of `buildEnvelope`'s OWN reduction at this fixture's size
    // (see the round-2 review's F1) never lands both preconditions this
    // fixture needs at once: below the size where its own cap search can
    // no longer keep the descriptors byte-identical to the pristine
    // format (`rewriteProbeDescriptors`'s `wasIntact` check), the search
    // does not shrink gracefully to an over-budget-but-populated shape --
    // it drops the WHOLE payload in one step once no candidate structure
    // fits, so `mutation_probe` is gone by the time an overrun warning
    // would appear, and there is nothing left for case 3 to grow. What
    // this fixture builds instead -- a real `buildEnvelope` call that is
    // a pure pass-through (`maxChars` generous enough that nothing is
    // cut) whose caller supplies a `warnings` entry already shaped like
    // an overrun warning -- is `buildEnvelope`'s own documented, real
    // behavior (caller-supplied `warnings` entries are carried through
    // unchanged, see `EnvelopeInput.warnings`), and stands in for the
    // "prior harsher reduction pass" the round-1 fixture's own docblock
    // already names as case 3's real precondition: that prior pass's own
    // output is exactly an envelope carrying its own stale overrun
    // warning alongside pristine, not-yet-corrected descriptors.
    const noPathDiff: MutantDiffField = {
      text: "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-aaa\n-bbb\n-ccc\n+ddd\n+eee\n+fff",
      hunkCount: 1,
      removed: 3,
      added: 3,
      changedLineCount: 6,
      truncated: false,
    };
    const originalMutantField = {
      file: "fixture.js",
      line: 2,
      before: "old line",
      after: "new line",
      diff: noPathDiff,
    };
    const summary = formatMutantSummary(
      "fixture.js",
      2,
      "old line",
      "new line",
      noPathDiff,
    );
    const via = formatVerifiedAppliedVia(
      "fixture.js",
      2,
      "old line",
      "new line",
      noPathDiff,
    );
    const staleOverrunWarning =
      "envelope is 1 characters; requested max-chars 1 could not be met";

    const buildCase3Envelope = (warnings: string[]) =>
      buildEnvelope({
        version: "test",
        command: "probe",
        status: "survived",
        durationMs: 1,
        cwd: "/tmp",
        warnings,
        logs: [],
        extra: {
          mutant: {
            file: "fixture.js",
            line: 2,
            before: "old line",
            after: "new line",
            form: "patch",
            // `diff` omitted: what a prior reduction pass left behind.
          },
          mutation_probe: {
            mutant: summary,
            verified_applied_via: via,
            result: "survived",
            restored_verified: true,
          },
        },
      }).envelope;

    // Learn the case-3 correction's own natural, unshrunk length (no
    // stale warning in play here, so the reference measurement is not
    // itself contaminated by the fixture's premise).
    const reference = buildCase3Envelope([]);
    const refPreLen = JSON.stringify(reference).length;
    reconcileEnvelopeDiffTruncation(
      reference,
      { mutant: originalMutantField },
      refPreLen * 10,
    );
    const correctedLength = JSON.stringify(reference).length;
    expect(correctedLength).toBeGreaterThan(refPreLen);

    const budget = correctedLength - 3;

    const envelope = buildCase3Envelope([staleOverrunWarning]);
    // Premise check: the envelope already carries a "could not be met"
    // warning before `reconcileEnvelopeDiffTruncation` ever runs, and its
    // pre-correction size already exceeds `budget` (the stale warning's
    // own bytes are why): `preCorrectionLength > maxChars` is exactly the
    // precondition the round-1 review asked this fixture to cover.
    const preWarnings = envelope.warnings as unknown[];
    expect(
      preWarnings.some(
        (w) => typeof w === "string" && /could not be met/.test(w),
      ),
    ).toBe(true);
    const preLen = JSON.stringify(envelope).length;
    expect(preLen).toBeGreaterThan(budget);

    reconcileEnvelopeDiffTruncation(
      envelope,
      { mutant: originalMutantField },
      budget,
    );

    const finalLength = JSON.stringify(envelope).length;
    // Premise check: the case-3 rewrite grew the envelope further, past
    // the length the stale warning already named and past `budget`.
    expect(finalLength).toBeGreaterThan(preLen);
    expect(finalLength).toBeGreaterThan(budget);

    const finalWarnings = envelope.warnings as unknown[];
    const overrunWarnings = finalWarnings.filter(
      (w) => typeof w === "string" && /could not be met/.test(w),
    );
    // The pin: exactly one "could not be met" warning survives, and it
    // names the NEW, larger final length -- `pushBudgetOverrunWarning`
    // replaces the stale warning rather than appending a second one
    // alongside it.
    expect(overrunWarnings).toHaveLength(1);
    expect(overrunWarnings[0]).toContain(`${String(finalLength)} characters`);
    expect(overrunWarnings[0]).not.toBe(staleOverrunWarning);
  });
});

describe("reconcileEnvelopeDiffTruncation: stays within maxChars across a sweep of budgets (REAL buildEnvelope-built envelopes)", () => {
  // 15 two-line hunks of a fixed, generous width -- the same shape a
  // reviewer's own sweep across a range of `-m` values exercised through
  // the built CLI; this pins the same invariant as a fast, in-process
  // unit test over the exported function directly.
  const hunk = (n: number): string =>
    `@@ -${String(n)} +${String(n)} @@\n-old line ${String(n)} ${"x".repeat(20)}\n+new line ${String(n)} ${"y".repeat(20)}`;
  const FULL_TEXT = [
    "--- before/t.txt",
    "+++ after/t.txt",
    ...Array.from({ length: 15 }, (_, i) => hunk(i + 1)),
  ].join("\n");
  const ORIGINAL_WIDE: MutantDiffField = {
    text: FULL_TEXT,
    path: "/tmp/probe-logs/mutant-diff-wide/mutant-diff.patch",
    hunkCount: 15,
    removed: 15,
    added: 15,
    changedLineCount: 30,
    truncated: false,
  };
  const originalMutantField = {
    file: "t.txt",
    line: 1,
    before: "old line 1",
    after: "new line 1",
    diff: ORIGINAL_WIDE,
  };
  const summary = formatMutantSummary(
    "t.txt",
    1,
    "old line 1",
    "new line 1",
    ORIGINAL_WIDE,
  );
  const via = formatVerifiedAppliedVia(
    "t.txt",
    1,
    "old line 1",
    "new line 1",
    ORIGINAL_WIDE,
  );

  it.each([300, 400, 500, 600, 700, 800, 1000, 1500, 2000])(
    "at maxChars=%i: a REAL buildEnvelope-built envelope stays within it after correction",
    (maxChars) => {
      const { envelope } = buildEnvelope({
        version: "test",
        command: "probe",
        status: "killed",
        durationMs: 1,
        cwd: "/tmp",
        warnings: [],
        logs: [],
        extra: {
          mutant: {
            file: "t.txt",
            line: 1,
            before: "old line 1",
            after: "new line 1",
            form: "patch",
            diff: ORIGINAL_WIDE,
          },
          mutation_probe: {
            mutant: summary,
            verified_applied_via: via,
            result: "killed",
            restored_verified: true,
          },
        },
        maxChars,
      });
      // Premise check: this is what `buildEnvelope` itself guarantees,
      // before this correction ever touches the result.
      expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);

      reconcileEnvelopeDiffTruncation(
        envelope,
        { mutant: originalMutantField },
        maxChars,
      );

      expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    },
  );

  it("shrinks the excerpt with the larger CURRENT length first, at exact, measured byte counts that pin the order (largest-excerpt-first), rather than the array order `plan.results` happens to list them in", () => {
    // Two single-hunk `--plan` mutants of very different TRUE size (400
    // wide lines vs. 80 narrow ones), the smaller one listed FIRST in
    // `plan.results` -- the opposite of size order, so a rule that
    // processed entries in array/index order rather than by excerpt
    // size could not produce the numbers asserted below by accident.
    // `buildEnvelope`'s own uniform string-length reduction caps both
    // excerpts down to a similar SMALL size regardless of their true
    // size (a shared scale search, not one aware of which original was
    // bigger), which is what makes the post-`buildEnvelope` "current"
    // excerpt lengths close enough for order to matter, while the two
    // different line widths (60 vs. 2 characters) keep their hunk-
    // boundary rounding from coinciding, so the two are never tied.
    // The exact byte counts below were measured against this build:
    // reversing `enforceEnvelopeBudget`'s sort comparator (so the
    // SMALLER excerpt is shrunk first instead) changes them to
    // `postSmall: 111, postBig: 19` -- a different, and wrong, division
    // of the budget between the two mutants that still fits `maxChars`,
    // which is exactly the "the reduction's incidental order decides,
    // not a documented rule" failure mode this pins against.
    const bigLines = 400;
    const bigWidth = 60;
    const smallLines = 80;
    const smallWidth = 2;
    const wideDiff = (
      lines: number,
      width: number,
      name: string,
    ): MutantDiffField => ({
      text: [
        `--- a/${name}`,
        `+++ b/${name}`,
        `@@ -1,${String(lines)} +1,${String(lines)} @@`,
        ...Array.from(
          { length: lines },
          (_, i) => `-l${String(i)} ${"x".repeat(width)}`,
        ),
      ].join("\n"),
      path: `/tmp/probe-logs/mutant-diff-${name}/mutant-diff.patch`,
      hunkCount: 1,
      removed: lines,
      added: 0,
      changedLineCount: lines,
      truncated: false,
    });
    const bigOriginal = wideDiff(bigLines, bigWidth, "big.txt");
    const smallOriginal = wideDiff(smallLines, smallWidth, "small.txt");
    const bigSummary = formatMutantSummary(
      "big.txt",
      1,
      "old",
      "",
      bigOriginal,
    );
    const bigVia = formatVerifiedAppliedVia(
      "big.txt",
      1,
      "old",
      "",
      bigOriginal,
    );
    const smallSummary = formatMutantSummary(
      "small.txt",
      1,
      "old",
      "",
      smallOriginal,
    );
    const smallVia = formatVerifiedAppliedVia(
      "small.txt",
      1,
      "old",
      "",
      smallOriginal,
    );
    const bigEntry = {
      status: "survived",
      mutant: {
        file: "big.txt",
        line: 1,
        before: "old",
        after: "",
        form: "patch",
        diff: bigOriginal,
      },
      mutation_probe: {
        mutant: bigSummary,
        verified_applied_via: bigVia,
        result: "survived",
        restored_verified: true,
      },
    };
    const smallEntry = {
      status: "survived",
      mutant: {
        file: "small.txt",
        line: 1,
        before: "old",
        after: "",
        form: "patch",
        diff: smallOriginal,
      },
      mutation_probe: {
        mutant: smallSummary,
        verified_applied_via: smallVia,
        result: "survived",
        restored_verified: true,
      },
    };

    const maxChars = 1600;
    const { envelope } = buildEnvelope({
      version: "test",
      command: "probe",
      status: "survived",
      durationMs: 1,
      cwd: "/tmp",
      warnings: [],
      logs: [],
      extra: { plan: { results: [smallEntry, bigEntry], summary: {} } },
      maxChars,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);

    reconcileEnvelopeDiffTruncation(
      envelope,
      {
        planResults: [
          { mutant: smallEntry.mutant },
          { mutant: bigEntry.mutant },
        ],
      },
      maxChars,
    );

    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    const results = (envelope.plan as Record<string, unknown>)
      .results as Record<string, unknown>[];
    const smallDiff = (results[0].mutant as Record<string, unknown>)
      .diff as Record<string, unknown>;
    const bigDiff = (results[1].mutant as Record<string, unknown>)
      .diff as Record<string, unknown>;
    expect((smallDiff.text as string).length).toBe(95);
    expect((bigDiff.text as string).length).toBe(84);
  });
});

describe("probe --plan envelope: never over maxChars without a warning naming the true length (sweep of budgets, REAL buildEnvelope-built envelopes)", () => {
  // A two-mutant `--plan` result, each carrying 15 single-line hunks of a
  // fixed 61-character width. The invariant: across a sweep of `-m`
  // budgets the envelope is either within the bound (and then carries no
  // could-not-be-met warning) or over it with a warning naming its exact
  // final length; never silently over. Two mutants, not one, so
  // `plan.results[]` is exercised as an array (the shape `keepWhole`
  // cannot reach into) and the combined payload needs real reduction
  // across the swept range. The CLI sweep that motivated this pin is
  // recorded in the CHANGELOG.
  const buildWideLine = (n: number): string =>
    `line ${String(n).padStart(4, "0")} ${"x".repeat(51)}`;
  const buildMutatedLine = (n: number): string =>
    `  M${String(n).padStart(3, "0")} ${"y".repeat(54)}`;
  const hunk = (n: number): string =>
    `@@ -${String(n)},1 +${String(n)},1 @@\n-${buildWideLine(n)}\n+${buildMutatedLine(n)}`;
  const FULL_TEXT = [
    "--- a/wide.txt",
    "+++ b/wide.txt",
    ...Array.from({ length: 15 }, (_, i) => hunk(i * 5)),
  ].join("\n");
  const WIDE_DIFF: MutantDiffField = {
    text: FULL_TEXT,
    path: "/tmp/probe-logs/mutant-diff-wide/mutant-diff.patch",
    hunkCount: 15,
    removed: 15,
    added: 15,
    changedLineCount: 30,
    truncated: false,
  };
  const wideMutantField = {
    file: "wide.txt",
    line: 1,
    before: buildWideLine(0),
    after: buildMutatedLine(0),
    diff: WIDE_DIFF,
  };
  const summary = formatMutantSummary(
    "wide.txt",
    1,
    buildWideLine(0),
    buildMutatedLine(0),
    WIDE_DIFF,
  );
  const via = formatVerifiedAppliedVia(
    "wide.txt",
    1,
    buildWideLine(0),
    buildMutatedLine(0),
    WIDE_DIFF,
  );
  const planResultEntry = (index: number): Record<string, unknown> => ({
    index,
    file: "wide.txt",
    expect: "pass",
    status: "killed",
    warnings: [],
    mutant: {
      file: "wide.txt",
      line: 1,
      before: buildWideLine(0),
      after: buildMutatedLine(0),
      form: "patch",
      diff: WIDE_DIFF,
    },
    mutation_probe: {
      mutant: summary,
      verified_applied_via: via,
      result: "killed",
      restored_verified: true,
    },
    logs: [],
  });

  /** Builds the plan envelope exactly as `runProbePlanCommand` does
   * (fixed fields, `plan.{baseline is absent here, results, summary}`,
   * `keepWhole: ["plan.summary"]`), then runs the same
   * `reconcileEnvelopeDiffTruncation` pass `cli.ts` runs against it, at
   * `maxChars`. */
  function buildPlanEnvelope(maxChars: number): Record<string, unknown> {
    const { envelope } = buildEnvelope({
      version: "test",
      command: "probe",
      status: "killed",
      durationMs: 1,
      cwd: "/tmp",
      warnings: [],
      logs: [],
      extra: {
        plan: {
          results: [planResultEntry(0), planResultEntry(1)],
          summary: {
            total: 2,
            killed: 2,
            survived: 0,
            inconclusive: 0,
            not_run: 0,
          },
        },
        isolation: "worktree",
      },
      keepWhole: ["plan.summary"],
      maxChars,
    });
    reconcileEnvelopeDiffTruncation(
      envelope,
      {
        planResults: [wideMutantField, wideMutantField].map((m) => ({
          mutant: m,
        })),
      },
      maxChars,
    );
    return envelope;
  }

  /** The contract: `buildEnvelope`/`reconcileEnvelopeDiffTruncation`
   * together never ship an envelope longer than `maxChars` without a
   * warning stating that EXACT final length -- never a stale or
   * approximate one -- so a caller can always tell "bounded as
   * requested" from "bounded, but bigger than asked for, honestly
   * reported" apart from a silent overrun. */
  function assertNeverOverWithoutHonestWarning(
    envelope: Record<string, unknown>,
    maxChars: number,
  ): void {
    const finalLength = JSON.stringify(envelope).length;
    const warnings = Array.isArray(envelope.warnings)
      ? (envelope.warnings as unknown[])
      : [];
    const expected = `envelope is ${String(finalLength)} characters; requested max-chars ${String(maxChars)} could not be met`;
    if (finalLength <= maxChars) {
      // In bound: the reduction did its job and must not ALSO claim it
      // could not meet the request. Asserting this half keeps a budget
      // that fits from passing vacuously (a reduction that is abandoned
      // entirely ships the whole payload over the bound and fails the
      // branch below; a reduction that meets the bound must say nothing).
      expect(
        warnings.some(
          (w) => typeof w === "string" && w.includes("could not be met"),
        ),
        `envelope is ${String(finalLength)} chars, within maxChars=${String(maxChars)}, but carries a could-not-be-met warning: ${JSON.stringify(warnings)}`,
      ).toBe(false);
      return;
    }
    expect(
      warnings,
      `envelope is ${String(finalLength)} chars, over maxChars=${String(maxChars)}, but warnings do not name the true length: ${JSON.stringify(warnings)}`,
    ).toContain(expected);
  }

  // `mustFit` marks the budgets the real reduction is known to meet for
  // this fixture (measured: every budget from 300 up fits; 50 to 250 sit
  // below the fixed skeleton's floor and are honestly reported as over).
  // A budget marked `mustFit` is asserted in bound outright, so a
  // reduction that gives up and ships the whole payload with an honest
  // warning still fails here: the contract has two halves, "never
  // silently over" and "reduced to fit whenever the payload allows it".
  it.each([
    [50, false],
    [100, false],
    [150, false],
    [200, false],
    [250, false],
    [300, true],
    [400, true],
    [500, true],
    [700, true],
    [1000, true],
    [1500, true],
    [2000, true],
    [3000, true],
    [3650, true],
    [4300, true],
  ] as const)(
    "at maxChars=%i (mustFit=%s): never over the bound without a warning naming the true length, and in bound whenever the reduction can get there",
    (maxChars, mustFit) => {
      const envelope = buildPlanEnvelope(maxChars);
      assertNeverOverWithoutHonestWarning(envelope, maxChars);
      if (mustFit) {
        expect(
          JSON.stringify(envelope).length,
          `the reduction is known to fit this fixture at maxChars=${String(maxChars)}, but the envelope shipped over the bound`,
        ).toBeLessThanOrEqual(maxChars);
      }
    },
  );
});

describe("mutant.diff.path: the whole applied diff on disk", () => {
  it("writes the full diff beside the excerpt, names it in `diff.path` and in the mutant's log paths", async () => {
    const { root, relPath, absFile, content } = initRepoWithLines(10);
    const patchPath = path.join(root, "three-hunk-path.patch");
    writeSparsePatch(patchPath, relPath, [2, 6, 10], 10);

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable || result.diff === undefined) return;

    const diffPath = result.diff.path;
    expect(typeof diffPath).toBe("string");
    if (diffPath === undefined) return;
    expect(fs.existsSync(diffPath)).toBe(true);
    expect(result.logPaths).toContain(diffPath);

    const full = fs.readFileSync(diffPath, "utf8");
    // The whole change, not the excerpt: every hunk, and the excerpt is
    // a prefix of it.
    expect(full.split("\n").filter((l) => l.startsWith("@@ "))).toHaveLength(3);
    expect(full).toContain("function fn2() { return 200; }");
    expect(full).toContain("function fn6() { return 600; }");
    expect(full).toContain("function fn10() { return 1000; }");
    expect(full.startsWith(result.diff.text)).toBe(true);
    expect(full).not.toContain("diff --git ");
  });

  it("a single oversized hunk is cut inside itself, within the bound, with the whole hunk still on disk", async () => {
    // 40 contiguous changed lines of 60 characters is one hunk of about
    // 4,900 characters: past DIFF_EXCERPT_MAX_CHARS on its own, which
    // used to ship whole with `truncated: false`.
    const root = makeTmpDir();
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "test"]);
    const relPath = "target.txt";
    const absFile = path.join(root, relPath);
    const lineCount = 42;
    const lines = Array.from({ length: lineCount }, (_, i) =>
      fixedLengthLine(`  L${String(i + 1)}`, 60),
    );
    const content = lines.join("\n") + "\n";
    fs.writeFileSync(absFile, content);
    git(root, ["add", "-A"]);
    git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);

    const changed = Array.from({ length: 40 }, (_, i) => i + 2);
    const body: string[] = [
      `diff --git a/${relPath} b/${relPath}`,
      "index 0000000..0000000 100644",
      `--- a/${relPath}`,
      `+++ b/${relPath}`,
      `@@ -1,${String(lineCount)} +1,${String(lineCount)} @@`,
      ` ${lines[0]}`,
    ];
    for (const n of changed) body.push(`-${lines[n - 1]}`);
    for (const n of changed) {
      body.push(`+${fixedLengthLine(`  M${String(n)}`, 60)}`);
    }
    body.push(` ${lines[lineCount - 1]}`);
    const patchPath = path.join(root, "one-big-hunk.patch");
    fs.writeFileSync(patchPath, body.join("\n") + "\n");

    const result = await computeMutant(
      { form: "patch", file: absFile, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable || result.diff === undefined) return;

    expect(result.diff.hunkCount).toBe(1);
    expect(result.diff.changedLineCount).toBe(80);
    expect(result.diff.truncated).toBe(true);
    expect(result.diff.hunkTruncated).toBe(true);
    expect(result.diff.bodyOmitted).toBeUndefined();
    // The bound actually holds now, first hunk included.
    expect(result.diff.text.length).toBeLessThanOrEqual(DIFF_EXCERPT_MAX_CHARS);
    expect(result.diff.text.split("\n").length).toBeLessThanOrEqual(
      DIFF_EXCERPT_MAX_LINES,
    );

    const diffPath = result.diff.path;
    expect(typeof diffPath).toBe("string");
    if (diffPath === undefined) return;
    const full = fs.readFileSync(diffPath, "utf8");
    // Cut at a LINE boundary, and maximally so: the next line of the
    // full diff would not have fit. The two preamble lines are dropped
    // before hunk content is, so the comparison starts at the header.
    expectPrefixOfOriginal(result.diff.text, full);
    const keptLines = result.diff.text.split("\n");
    const fullLines = full.slice(full.indexOf("@@ ")).split("\n");
    expect(fullLines.slice(0, keptLines.length)).toEqual(keptLines);
    const nextLine = fullLines[keptLines.length];
    expect(nextLine).toBeDefined();
    expect(`${result.diff.text}\n${nextLine}`.length).toBeGreaterThan(
      DIFF_EXCERPT_MAX_CHARS,
    );
    // The header survives, so the reader still sees which lines moved.
    expect(keptLines[0]).toMatch(/^@@ /);
    // And the whole hunk is on disk regardless.
    expect(full).toContain(fixedLengthLine("  M41", 60));

    // The descriptors say "cut mid-hunk", not "whole".
    const summary = formatMutantSummary(
      relPath,
      result.line,
      result.before,
      result.after,
      result.diff,
    );
    expect(summary).toContain("see mutant.diff (cut mid-hunk)");
    expect(summary).toContain("full diff at mutant.diff.path");
    expect(
      formatVerifiedAppliedVia(
        relPath,
        result.line,
        result.before,
        result.after,
        result.diff,
      ),
    ).toContain("see mutant.diff (cut mid-hunk)");
  }, 30000);
});

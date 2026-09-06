import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  applyPatchForReal,
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

describe("computeMutant: patch form multi-hunk diff excerpt, envelope-delivery invariant (T-004 round 3)", () => {
  it("15 hunks of 61-char lines (the round-2 reviewer's own repro shape): the invariant holds at the default budget", async () => {
    const changedLines = Array.from({ length: 15 }, (_, i) => (i + 1) * 4);
    const { root, relPath, result } = await computeFixedLengthMultiHunkDiff(
      100,
      61,
      changedLines,
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.diff).toBeDefined();
    if (result.diff === undefined) return;
    expect(result.diff.hunkCount).toBe(15);
    expect(result.diff.changedLineCount).toBe(30);
    // Git's own hunk header carries a variable-length "section context"
    // snippet this module does not control, so whether this particular
    // size crosses the excerpt's own 3,000-character bound is not fixed
    // by the fixture's own line count/length alone; either way, the
    // invariant holds: no omission marker while `truncated` is false, a
    // hunk-boundary-safe cut when it is true.
    if (!result.diff.truncated) {
      expect(result.diff.text).not.toMatch(ENVELOPE_MARKER_RE);
    } else {
      expect(result.diff.text).toBe(trimToLastCompleteHunk(result.diff.text));
    }

    const { envelope } = buildEnvelope({
      version: "0.0.0-test",
      command: "probe",
      status: "survived",
      durationMs: 1,
      cwd: root,
      warnings: [],
      logs: [],
      extra: {
        mutant: {
          file: relPath,
          line: result.line,
          before: result.before,
          after: result.after,
          form: "patch",
          diff: result.diff,
        },
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
      },
      logDir: makeTmpDir(),
    });
    reconcileEnvelopeDiffTruncation(envelope);

    const mutant = envelope.mutant as { diff?: MutantDiffField } | undefined;
    // The excerpt's own text is well under the default envelope budget
    // regardless of which way `truncated` fell above, so nothing here
    // should have cut it further.
    expect(mutant?.diff?.text).toBe(result.diff.text);
    expect(mutant?.diff?.truncated).toBe(result.diff.truncated);
    expect(mutant?.diff?.hunkCount).toBe(15);
    expect(String(mutant?.diff?.text)).not.toMatch(ENVELOPE_MARKER_RE);
  });

  it("20 hunks of 400-char lines: the excerpt's own bound truncates at a hunk boundary, and the envelope delivers that unmodified at the default budget", async () => {
    const changedLines = Array.from({ length: 20 }, (_, i) => (i + 1) * 4);
    const { root, relPath, result } = await computeFixedLengthMultiHunkDiff(
      120,
      400,
      changedLines,
    );
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.diff).toBeDefined();
    if (result.diff === undefined) return;
    expect(result.diff.hunkCount).toBe(20);
    // 20 hunks of 400-char removed/added lines each is far past the
    // excerpt's own 3,000-character bound: this is the case that bound
    // exists for.
    expect(result.diff.truncated).toBe(true);
    expect(result.diff.text.length).toBeLessThanOrEqual(DIFF_EXCERPT_MAX_CHARS);
    // Never mid-hunk, even from the excerpt's OWN truncation.
    expect(result.diff.text).toBe(trimToLastCompleteHunk(result.diff.text));

    const { envelope } = buildEnvelope({
      version: "0.0.0-test",
      command: "probe",
      status: "survived",
      durationMs: 1,
      cwd: root,
      warnings: [],
      logs: [],
      extra: {
        mutant: {
          file: relPath,
          line: result.line,
          before: result.before,
          after: result.after,
          form: "patch",
          diff: result.diff,
        },
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
      },
      logDir: makeTmpDir(),
    });
    reconcileEnvelopeDiffTruncation(envelope);

    const mutant = envelope.mutant as { diff?: MutantDiffField } | undefined;
    // The excerpt's own bound already produced a hunk-boundary-safe cut
    // well under the envelope's default budget: nothing further to do.
    expect(mutant?.diff?.text).toBe(result.diff.text);
    expect(mutant?.diff?.truncated).toBe(true);
    expect(mutant?.diff?.hunkCount).toBe(20);
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
    const { envelope } = buildEnvelope({
      version: "0.0.0-test",
      command: "probe",
      status: "survived",
      durationMs: 1,
      cwd: root,
      warnings: [],
      logs: [],
      extra: {
        plan: {
          results: [
            {
              index: 0,
              file: relPath,
              expect: "fail",
              status: "survived",
              mutant: {
                file: relPath,
                line: result.line,
                before: result.before,
                after: result.after,
                form: "patch",
                diff: result.diff,
              },
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
    reconcileEnvelopeDiffTruncation(envelope);
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

  it("--plan batch of three multi-hunk mutants: every excerpt's `truncated` stays honest at the default budget", async () => {
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

    const { envelope } = buildEnvelope({
      version: "0.0.0-test",
      command: "probe",
      status: "survived",
      durationMs: 1,
      cwd: mutants[0].root,
      warnings: [],
      logs: [],
      extra: {
        plan: {
          results: mutants.map(({ relPath, result }, index) => ({
            index,
            file: relPath,
            expect: "fail",
            status: "survived",
            mutant: {
              file: relPath,
              line: result.line,
              before: result.before,
              after: result.after,
              form: "patch",
              diff: result.diff,
            },
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
    reconcileEnvelopeDiffTruncation(envelope);

    const plan = envelope.plan as { results?: Array<Record<string, unknown>> };
    expect(plan.results).toHaveLength(3);
    for (const [index, entry] of (plan.results ?? []).entries()) {
      const mutant = entry.mutant as { diff?: MutantDiffField } | undefined;
      const diff = mutant?.diff;
      expect(diff).toBeDefined();
      if (diff === undefined) continue;
      const markerFree = !ENVELOPE_MARKER_RE.test(diff.text);
      // The invariant: `truncated: false` never sits beside text the
      // envelope itself cut (a trailing omission marker); when
      // `truncated` is true, the text ends at a hunk boundary.
      if (!diff.truncated) {
        expect(markerFree).toBe(true);
      } else {
        expect(diff.text).toBe(trimToLastCompleteHunk(diff.text));
      }
      expect(diff.hunkCount).toBe(mutants[index].result.diff?.hunkCount);
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
    const diff = planDiff(envelope);
    expect(diff).toBeDefined();
    if (diff === undefined) return;
    const text = String(diff.text ?? "");
    expect(ENVELOPE_MARKER_RE.test(text)).toBe(false);
    if (diff.truncated) {
      // Ends at a hunk boundary: re-running the boundary trim on the
      // delivered text reproduces it byte for byte -- nothing partial
      // was left in.
      expect(text).toBe(trimToLastCompleteHunk(text));
    }
    expect(diff.hunkCount).toBe(result.diff.hunkCount);
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

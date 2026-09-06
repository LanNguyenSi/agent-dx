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
} from "../src/probe/mutant.js";
import { runArgv } from "../src/probe/run.js";
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

    const summary = formatMutantSummary(
      "fixture.js",
      result.line,
      result.before,
      result.after,
      result.diff,
    );
    expect(summary).toContain("first of 6 changed lines across 3 hunks");
    // The one-line summary still never quotes the second/third hunk --
    // that is `verified_applied_via`'s job, not this one's.
    expect(summary).not.toContain("fn6");

    const verifiedVia = formatVerifiedAppliedVia(
      "fixture.js",
      result.line,
      result.before,
      result.after,
      result.diff,
    );
    expect(verifiedVia).toContain("3 hunks");
    expect(verifiedVia).toContain("function fn6() { return 600; }");
    expect(verifiedVia).toContain("function fn10() { return 1000; }");
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

  it("the excerpt's own bound leaves room in the envelope's default budget: `verified_applied_via` survives `buildEnvelope` unmodified at the default max-chars", async () => {
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

    const verifiedAppliedVia = formatVerifiedAppliedVia(
      relPath,
      result.line,
      result.before,
      result.after,
      result.diff,
    );

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
                verified_applied_via: verifiedAppliedVia,
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
      // `maxChars` omitted deliberately: this exercises the real
      // default (8,000), the shape every `probe`/`probe --plan`
      // invocation gets unless the caller passes `-m`/`--max-chars`.
      logDir: makeTmpDir(),
    });

    const deliveredResults = (
      envelope as { plan?: { results?: Array<Record<string, unknown>> } }
    ).plan?.results;
    expect(deliveredResults).toBeDefined();
    const deliveredEntry = deliveredResults?.[0] as
      { mutation_probe?: { verified_applied_via?: unknown } } | undefined;
    const delivered = deliveredEntry?.mutation_probe?.verified_applied_via;
    // The excerpt's own `truncated: true` must be the ONLY truncation a
    // reader ever sees: if the envelope's own generic string reduction
    // cut this further, `delivered` would end in the envelope's own
    // "...(N more characters omitted)" marker instead of matching the
    // fully formatted string byte for byte -- silently disagreeing with
    // `diff.truncated`.
    expect(delivered).toBe(verifiedAppliedVia);
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

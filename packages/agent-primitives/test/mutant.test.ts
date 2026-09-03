import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  computeMutant,
  formatMutantSummary,
  formatVerifiedAppliedVia,
} from "../src/probe/mutant.js";

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

  it("is not applicable for a line number out of range", async () => {
    const result = await computeMutant(
      { form: "replace", file: "/x/fixture.js", line: 999, replaceText: "x" },
      { root: "/x", logDir: makeTmpDir(), originalContent: ORIGINAL },
    );
    expect(result.applicable).toBe(false);
  });

  it("is not applicable when the replacement is byte-identical to the original line", async () => {
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

  it("is not applicable when the substring is not found on the line", async () => {
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
  });

  it("is not applicable for a line number out of range", async () => {
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
      { form: "patch", file: absFile, line: 0, patchPath },
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
      { form: "patch", file: absFile, line: 0, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );
    expect(result.applicable).toBe(false);
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
      { form: "patch", file: absFile, line: 0, patchPath },
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
      { form: "patch", file: absFile, line: 0, patchPath },
      { root, logDir: makeTmpDir(), originalContent: content },
    );
    expect(result.applicable).toBe(true);
    expect(result.logPaths.length).toBeGreaterThanOrEqual(2);
    for (const logPath of result.logPaths) {
      expect(fs.existsSync(logPath)).toBe(true);
    }
  });
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

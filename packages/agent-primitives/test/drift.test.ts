import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { drift, type DriftResult } from "../src/drift/index.js";
import { UsageError } from "../src/envelope.js";
import { parseRemovedIdentifiers } from "../src/drift/parseDiff.js";
import {
  globToRegExp,
  historicalPhraseMatch,
  historicalPhraseNearIdentifier,
  matchesAnyGlob,
  nearestHeading,
  parseHeadings,
} from "../src/drift/allowlist.js";
import { classifyLine, parseGrepOutput } from "../src/drift/scan.js";
import { spawnCli } from "./helpers/spawn-cli.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-drift-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function writeFile(repo: string, rel: string, content: string): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** A fresh git repo, pinned against the ambient global git config the
 * same way `probe.test.ts`'s own fixtures are (see its `initRepo`): a
 * `diff --no-prefix`/`autocrlf` on the host would otherwise change the
 * `a/`/`b/` header shape and line endings `parseDiff.ts` assumes. */
function initRepo(): string {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "diff.noprefix", "false"]);
  git(repo, ["config", "diff.mnemonicPrefix", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  return repo;
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
  return gitOutput(repo, ["rev-parse", "HEAD"]).trim();
}

function findSite(
  sites: DriftResult["sites"],
  filePath: string,
  line: number,
): DriftResult["sites"][number] | undefined {
  return sites.find((s) => s.path === filePath && s.line === line);
}

// ---------------------------------------------------------------------
// parseDiff.ts: pure parsing, no git repo needed.
// ---------------------------------------------------------------------

describe("parseRemovedIdentifiers", () => {
  it("reports a removed TS declaration", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-export type RuntimeError = { message: string };",
      "+export type RunError = { message: string };",
      "",
    ].join("\n");
    const result = parseRemovedIdentifiers(diff);
    expect(result.removed).toEqual([
      { name: "RuntimeError", kind: "declaration", file: "src/a.ts", line: 1 },
    ]);
    expect(result.movedNames).toEqual([]);
  });

  it("treats a same-named declaration added elsewhere in the diff as moved, not removed", () => {
    const diff = [
      "diff --git a/src/movedFrom.ts b/src/movedFrom.ts",
      "index 1111111..2222222 100644",
      "--- a/src/movedFrom.ts",
      "+++ b/src/movedFrom.ts",
      "@@ -1 +0,0 @@",
      "-export type MovedThing = { a: number };",
      "diff --git a/src/movedTo.ts b/src/movedTo.ts",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/src/movedTo.ts",
      "@@ -0,0 +1 @@",
      "+export type MovedThing = { a: number };",
      "",
    ].join("\n");
    const result = parseRemovedIdentifiers(diff);
    expect(result.removed).toEqual([]);
    expect(result.movedNames).toEqual(["MovedThing"]);
  });

  it("reports a wholly deleted file's basename (without extension) as a removed identifier", () => {
    const diff = [
      "diff --git a/src/oldModule.ts b/src/oldModule.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/oldModule.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const oldModuleValue = 1;",
      "",
    ].join("\n");
    const result = parseRemovedIdentifiers(diff);
    expect(result.removed).toContainEqual({
      name: "oldModuleValue",
      kind: "declaration",
      file: "src/oldModule.ts",
      line: 1,
    });
    expect(result.removed).toContainEqual({
      name: "oldModule",
      kind: "file",
      file: "src/oldModule.ts",
      line: 1,
    });
    expect(result.removed).toHaveLength(2);
  });

  it("does not report a deleted file's basename when the same basename is a newly added file", () => {
    const diff = [
      "diff --git a/src/Foo.ts b/src/Foo.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/Foo.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const fooValue = 1;",
      "diff --git a/src/Foo.tsx b/src/Foo.tsx",
      "new file mode 100644",
      "index 0000000..2222222",
      "--- /dev/null",
      "+++ b/src/Foo.tsx",
      "@@ -0,0 +1 @@",
      "+export const fooValue = 2;",
      "",
    ].join("\n");
    const result = parseRemovedIdentifiers(diff);
    expect(result.removed.some((r) => r.kind === "file")).toBe(false);
  });

  it("reports a removed top-level JSON config key, ignoring an indented (non-top-level) one", () => {
    const diff = [
      "diff --git a/config.json b/config.json",
      "index 1111111..2222222 100644",
      "--- a/config.json",
      "+++ b/config.json",
      "@@ -2,2 +2 @@",
      '-  "featureFlag": true,',
      '-    "nested": { "x": 1 },',
      '+  "otherFlag": true,',
      "",
    ].join("\n");
    const result = parseRemovedIdentifiers(diff);
    expect(result.removed).toEqual([
      { name: "featureFlag", kind: "config_key", file: "config.json", line: 2 },
    ]);
  });

  it("reports a removed top-level YAML key, ignoring an indented (non-top-level) one", () => {
    const diff = [
      "diff --git a/config.yml b/config.yml",
      "index 1111111..2222222 100644",
      "--- a/config.yml",
      "+++ b/config.yml",
      "@@ -1,2 +0,0 @@",
      "-timeout: 30",
      "-  nested: value",
      "",
    ].join("\n");
    const result = parseRemovedIdentifiers(diff);
    expect(result.removed).toEqual([
      { name: "timeout", kind: "config_key", file: "config.yml", line: 1 },
    ]);
  });

  it("recognizes export async function, export abstract class, function*, and export async function*", () => {
    const diff = [
      "diff --git a/src/b.ts b/src/b.ts",
      "index 1111111..2222222 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,4 +0,0 @@",
      "-export async function loadThing() {}",
      "-export abstract class BaseThing {}",
      "-function* genThing() {}",
      "-export async function* streamThing() {}",
      "",
    ].join("\n");
    const result = parseRemovedIdentifiers(diff);
    expect(result.removed).toEqual([
      { name: "loadThing", kind: "declaration", file: "src/b.ts", line: 1 },
      { name: "BaseThing", kind: "declaration", file: "src/b.ts", line: 2 },
      { name: "genThing", kind: "declaration", file: "src/b.ts", line: 3 },
      { name: "streamThing", kind: "declaration", file: "src/b.ts", line: 4 },
    ]);
  });

  it("does not report a deleted file's basename when its extension is not a recognized source extension, or the basename does not look like an identifier, and names each skipped basename", () => {
    const diff = [
      "diff --git a/docs/setup.md b/docs/setup.md",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/docs/setup.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old setup notes",
      "diff --git a/logo.png b/logo.png",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/logo.png",
      "+++ /dev/null",
      "diff --git a/src/index.ts b/src/index.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/index.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-console.log('bye');",
      "",
    ].join("\n");
    const result = parseRemovedIdentifiers(diff);
    expect(result.removed.some((r) => r.kind === "file")).toBe(false);
    expect(result.skippedFileBasenames).toEqual([
      { path: "docs/setup.md", basename: "setup" },
      { path: "logo.png", basename: "logo" },
      { path: "src/index.ts", basename: "index" },
    ]);
  });

  it("still reports a deleted file's basename when it looks like an identifier and has a recognized source extension", () => {
    const diff = [
      "diff --git a/src/OldModule.ts b/src/OldModule.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/OldModule.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const x = 1;",
      "",
    ].join("\n");
    const result = parseRemovedIdentifiers(diff);
    expect(result.removed).toContainEqual({
      name: "OldModule",
      kind: "file",
      file: "src/OldModule.ts",
      line: 1,
    });
    expect(result.skippedFileBasenames).toEqual([]);
  });

  it("treats --- /+++ as file headers only before a file's first hunk, so a removed line whose own content starts with '-- ' is parsed as content, not a header", () => {
    const diff = [
      "diff --git a/src/thing.ts b/src/thing.ts",
      "index 1111111..2222222 100644",
      "--- a/src/thing.ts",
      "+++ b/src/thing.ts",
      "@@ -1,2 +0,0 @@",
      "--- legacy comment marker",
      "-export const OldThing = 1;",
      "",
    ].join("\n");
    const result = parseRemovedIdentifiers(diff);
    expect(result.removed).toEqual([
      { name: "OldThing", kind: "declaration", file: "src/thing.ts", line: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------
// allowlist.ts: pure helpers.
// ---------------------------------------------------------------------

describe("allowlist helpers", () => {
  it("globToRegExp / matchesAnyGlob: ** crosses segments, * stays within one", () => {
    expect(matchesAnyGlob("docs/a/b.md", ["docs/**"])).toBe("docs/**");
    expect(matchesAnyGlob("docs/a/b.md", ["docs/*.md"])).toBeUndefined();
    expect(matchesAnyGlob("docs/b.md", ["docs/*.md"])).toBe("docs/*.md");
    expect(globToRegExp("a.b").test("aXb")).toBe(false);
  });

  it("historicalPhraseMatch finds the first listed phrase, case-insensitively", () => {
    expect(historicalPhraseMatch("RuntimeError was replaced")).toBe("replaced");
    expect(historicalPhraseMatch("still current")).toBeUndefined();
  });

  it("nearestHeading finds the closest heading at or before a line, honoring maxLevel", () => {
    const content = ["# Notes", "", "## Migration", "", "text"].join("\n");
    const headings = parseHeadings(content);
    expect(nearestHeading(headings, 5, 2)?.text).toBe("Migration");
    expect(nearestHeading(headings, 1, 2)?.text).toBe("Notes");
  });

  it("parseHeadings never reads a '#' line inside a fenced code block as a heading", () => {
    const content = [
      "# Real Heading",
      "",
      "```",
      "#!/bin/sh",
      "# a shell comment, not a heading",
      "```",
      "",
      "~~~",
      "# also not a heading, tilde-fenced",
      "~~~",
      "",
      "## Migration",
    ].join("\n");
    const headings = parseHeadings(content);
    expect(headings.map((h) => h.text)).toEqual(["Real Heading", "Migration"]);
  });

  it("historicalPhraseNearIdentifier: modeled on the real triologue f6c0f244 pair - an unrelated historical phrase far from the identifier's own mention does not allowlist it, but one right next to the mention does", () => {
    // Models the real case: "no longer" (about a different identifier,
    // `runError`) sits ~180 chars before "mirroring FilesPage's
    // RuntimeError" on the same long line - too far to allowlist a
    // present-tense mention of RuntimeError.
    const longLine =
      "runError is no longer part of the public error-handling surface " +
      "after the refactor collapsed every old boundary component into " +
      "one shared handler that each page now imports directly instead " +
      "of wiring its own, mirroring FilesPage's RuntimeError for local display.";
    expect(
      historicalPhraseNearIdentifier(longLine, "RuntimeError"),
    ).toBeUndefined();

    // "former" sits right before the identifier's own mention, so it
    // still allowlists it.
    const nearbyLine =
      "FilesPage's former `RuntimeError` type is referenced here for context.";
    expect(historicalPhraseNearIdentifier(nearbyLine, "RuntimeError")).toBe(
      "former",
    );
  });
});

// ---------------------------------------------------------------------
// scan.ts: pure helpers.
// ---------------------------------------------------------------------

describe("scan helpers", () => {
  it("classifyLine: doc extension is always doc; source extension only when the line is a comment", () => {
    expect(classifyLine("README.md", "anything")).toBe("doc");
    expect(classifyLine("a.ts", "// a comment")).toBe("comment");
    expect(classifyLine("a.ts", " * continuation")).toBe("comment");
    expect(classifyLine("a.ts", "const x = 1;")).toBeUndefined();
    expect(classifyLine("a.py", "# comment")).toBe("comment");
    expect(classifyLine("a.rb", "# comment")).toBeUndefined();
  });

  it("parseGrepOutput strips the rev prefix and skips an unparseable (e.g. binary) line", () => {
    const output = [
      "abc123:src/a.ts:4:hit here",
      "Binary file abc123:src/bin.dat matches",
      "",
    ].join("\n");
    expect(parseGrepOutput(output, "abc123")).toEqual([
      { path: "src/a.ts", line: 4, text: "hit here" },
    ]);
  });
});

// ---------------------------------------------------------------------
// drift(): usage errors.
// ---------------------------------------------------------------------

describe("drift usage errors", () => {
  it("throws UsageError when cwd is not inside a git work tree", async () => {
    const dir = makeTmpDir();
    await expect(
      drift({ cwd: dir, base: "HEAD~1", head: "HEAD" }),
    ).rejects.toThrow(UsageError);
  });

  it("throws UsageError for a base revision that does not exist", async () => {
    const repo = initRepo();
    writeFile(repo, "a.txt", "x\n");
    const head = commit(repo, "base");
    await expect(drift({ cwd: repo, base: "not-a-rev", head })).rejects.toThrow(
      /--base revision not found/,
    );
  });

  it("throws UsageError for a head revision that does not exist", async () => {
    const repo = initRepo();
    writeFile(repo, "a.txt", "x\n");
    const base = commit(repo, "base");
    await expect(
      drift({
        cwd: repo,
        base,
        head: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    ).rejects.toThrow(/--head revision not found/);
  });
});

// ---------------------------------------------------------------------
// drift(): the synthetic repo modeling the real triologue RuntimeError
// case (README, a comment, a released vs. an unreleased CHANGELOG
// section, a historical phrase, a migration doc by path and by heading,
// a moved declaration, a deleted file's basename, and a word-boundary
// trap).
// ---------------------------------------------------------------------

const README_MD = [
  "# Readme",
  "",
  "FilesPage's RuntimeError is used for local error display.",
  "MovedThing is documented here.",
  "oldModule was the old helper.",
  "",
].join("\n");

const UTIL_TS = [
  "// mirrors FilesPage's RuntimeError",
  "export const helper = 1;",
  "",
].join("\n");

const CONSUMER_TS = [
  "// calls setRuntimeError with a default error",
  "export function useIt() {",
  "  return 1;",
  "}",
  "",
].join("\n");

const CHANGELOG_MD = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- still references RuntimeError in runError.ts",
  "- still uses oldModule somewhere",
  "- RuntimeError was replaced by RunError",
  "",
  "## 1.2.0",
  "",
  "- documents RuntimeError as the primary error type",
  "",
].join("\n");

const MIGRATION_GUIDE_MD = [
  "# Migration Guide",
  "",
  "RuntimeError appears here for reference.",
  "",
].join("\n");

const NOTES_MD = [
  "# Notes",
  "",
  "## Migration",
  "",
  "RuntimeError needs to be swapped manually.",
  "",
].join("\n");

const NOTES2_MD = [
  "# Notes 2",
  "",
  "RuntimeError is still shown to users.",
  "",
].join("\n");

const RUN_ERROR_TS_BASE = [
  "/**",
  " * declares FilesPage's RuntimeError type",
  " */",
  "export type RuntimeError = { message: string };",
  "export const helperValue = 1;",
  "",
].join("\n");

const RUN_ERROR_TS_HEAD = [
  "export type RunError = { message: string };",
  "export const helperValue = 1;",
  "",
].join("\n");

function buildSyntheticRepo(): { repo: string; base: string; head: string } {
  const repo = initRepo();
  writeFile(repo, "README.md", README_MD);
  writeFile(repo, "src/util.ts", UTIL_TS);
  writeFile(repo, "src/consumer.ts", CONSUMER_TS);
  writeFile(repo, "CHANGELOG.md", CHANGELOG_MD);
  writeFile(repo, "docs/migration-guide.md", MIGRATION_GUIDE_MD);
  writeFile(repo, "docs/notes.md", NOTES_MD);
  writeFile(repo, "notes2.md", NOTES2_MD);
  writeFile(repo, "src/runError.ts", RUN_ERROR_TS_BASE);
  writeFile(repo, "src/oldModule.ts", "export const oldModuleValue = 1;\n");
  writeFile(
    repo,
    "src/movedFrom.ts",
    "export type MovedThing = { a: number };\n",
  );
  const base = commit(repo, "base");

  writeFile(repo, "src/runError.ts", RUN_ERROR_TS_HEAD);
  fs.rmSync(path.join(repo, "src/oldModule.ts"));
  writeFile(repo, "src/movedFrom.ts", "");
  writeFile(
    repo,
    "src/movedTo.ts",
    "export type MovedThing = { a: number };\n",
  );
  const head = commit(repo, "head");

  return { repo, base, head };
}

describe("drift (synthetic repo)", () => {
  it("removes MovedThing from removed_identifiers and pins the rest", async () => {
    const { repo, base, head } = buildSyntheticRepo();
    const result = await drift({ cwd: repo, base, head });

    expect(result.removedIdentifiers).toContainEqual({
      name: "RuntimeError",
      kind: "declaration",
      file: "src/runError.ts",
      line: 4,
    });
    expect(result.removedIdentifiers).toContainEqual({
      name: "oldModuleValue",
      kind: "declaration",
      file: "src/oldModule.ts",
      line: 1,
    });
    expect(result.removedIdentifiers).toContainEqual({
      name: "oldModule",
      kind: "file",
      file: "src/oldModule.ts",
      line: 1,
    });
    expect(result.removedIdentifiers.some((r) => r.name === "MovedThing")).toBe(
      false,
    );
    expect(result.removedIdentifiers).toHaveLength(3);
  });

  it("pins the exact reported sites for RuntimeError and oldModule", async () => {
    const { repo, base, head } = buildSyntheticRepo();
    const result = await drift({ cwd: repo, base, head });

    // Reported (not allowlisted): present-tense mentions.
    expect(findSite(result.sites, "README.md", 3)?.identifier).toBe(
      "RuntimeError",
    );
    expect(findSite(result.sites, "src/util.ts", 1)?.identifier).toBe(
      "RuntimeError",
    );
    expect(findSite(result.sites, "CHANGELOG.md", 5)?.identifier).toBe(
      "RuntimeError",
    );
    expect(findSite(result.sites, "notes2.md", 3)?.identifier).toBe(
      "RuntimeError",
    );
    expect(findSite(result.sites, "CHANGELOG.md", 6)?.identifier).toBe(
      "oldModule",
    );

    // A word-boundary trap: setRuntimeError must never match RuntimeError.
    expect(findSite(result.sites, "src/consumer.ts", 1)).toBeUndefined();
    expect(findSite(result.allowlisted, "src/consumer.ts", 1)).toBeUndefined();

    // MovedThing was never a removed identifier, so its own mention is
    // never even queried.
    expect(result.sites.some((s) => s.identifier === "MovedThing")).toBe(false);

    expect(result.sites).toHaveLength(5);
    expect(result.counts).toEqual({ removed: 3, sites: 5, allowlisted: 5 });
    expect(result.status).toBe("fail");
  });

  it("pins the exact allowlisted sites and reasons", async () => {
    const { repo, base, head } = buildSyntheticRepo();
    const result = await drift({ cwd: repo, base, head });

    const replaced = findSite(result.allowlisted, "CHANGELOG.md", 7);
    expect(replaced?.identifier).toBe("RuntimeError");
    expect(replaced?.allowlistReason).toMatch(/historical phrase "replaced"/);

    const released = findSite(result.allowlisted, "CHANGELOG.md", 11);
    expect(released?.identifier).toBe("RuntimeError");
    expect(released?.allowlistReason).toMatch(
      /released changelog section "1\.2\.0"/,
    );

    const migrationByPath = findSite(
      result.allowlisted,
      "docs/migration-guide.md",
      3,
    );
    expect(migrationByPath?.identifier).toBe("RuntimeError");
    expect(migrationByPath?.allowlistReason).toMatch(/migration doc path/);

    const migrationByHeading = findSite(result.allowlisted, "docs/notes.md", 5);
    expect(migrationByHeading?.identifier).toBe("RuntimeError");
    expect(migrationByHeading?.allowlistReason).toMatch(
      /under migration heading "Migration"/,
    );

    const historicalOldModule = findSite(result.allowlisted, "README.md", 5);
    expect(historicalOldModule?.identifier).toBe("oldModule");
    expect(historicalOldModule?.allowlistReason).toMatch(
      /historical phrase "was"/,
    );

    // The still-current Unreleased line must NOT be allowlisted by the
    // changelog rule: only a released section (not Unreleased) exempts.
    expect(findSite(result.allowlisted, "CHANGELOG.md", 5)).toBeUndefined();
  });

  it("--allow allowlists an otherwise-reported site, with the glob named in the reason", async () => {
    const { repo, base, head } = buildSyntheticRepo();
    const withoutAllow = await drift({ cwd: repo, base, head });
    expect(findSite(withoutAllow.sites, "notes2.md", 3)).toBeDefined();

    const withAllow = await drift({
      cwd: repo,
      base,
      head,
      allow: ["notes2.md"],
    });
    expect(findSite(withAllow.sites, "notes2.md", 3)).toBeUndefined();
    const allowlisted = findSite(withAllow.allowlisted, "notes2.md", 3);
    expect(allowlisted?.allowlistReason).toMatch(
      /matched --allow glob "notes2\.md"/,
    );
  });

  it("--strict also reports allowlisted sites in sites[], flagged", async () => {
    const { repo, base, head } = buildSyntheticRepo();
    const strict = await drift({ cwd: repo, base, head, strict: true });

    const flagged = findSite(strict.sites, "CHANGELOG.md", 11);
    expect(flagged?.allowlisted).toBe(true);
    expect(flagged?.allowlistReason).toMatch(/released changelog section/);
    // Every non-strict site is still present too.
    expect(findSite(strict.sites, "README.md", 3)).toBeDefined();
    // sites now includes both the 5 reported and the 5 allowlisted.
    expect(strict.sites).toHaveLength(10);
    expect(strict.allowlisted).toHaveLength(5);
  });

  it("reports zero sites (and status ok) once every mention is fixed or allowlisted", async () => {
    const repo = initRepo();
    writeFile(repo, "README.md", "# Readme\n\nRunError is used now.\n");
    writeFile(repo, "src/runError.ts", RUN_ERROR_TS_BASE);
    const base = commit(repo, "base");
    writeFile(repo, "src/runError.ts", RUN_ERROR_TS_HEAD);
    const head = commit(repo, "head");

    const result = await drift({ cwd: repo, base, head });
    expect(result.sites).toEqual([]);
    expect(result.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------
// drift(): the windowed historical-phrase check, end to end (see the
// `historicalPhraseNearIdentifier` unit tests above for the pure-function
// pinning of the same real-shaped pair).
// ---------------------------------------------------------------------

describe("drift (windowed historical-phrase check, end to end)", () => {
  it("reports a long line whose historical phrase is far from the identifier, but allowlists one whose phrase sits right next to it", async () => {
    const repo = initRepo();
    const longLine =
      "- runError is no longer part of the public error-handling surface " +
      "after the refactor collapsed every old boundary component into " +
      "one shared handler that each page now imports directly instead " +
      "of wiring its own, mirroring FilesPage's RuntimeError for local display.";
    const nearbyLine =
      "- FilesPage's former RuntimeError type is referenced here for context.";
    writeFile(
      repo,
      "CHANGELOG.md",
      ["# Changelog", "", "## [Unreleased]", "", longLine, nearbyLine, ""].join(
        "\n",
      ),
    );
    writeFile(repo, "src/runError.ts", RUN_ERROR_TS_BASE);
    const base = commit(repo, "base");
    writeFile(repo, "src/runError.ts", RUN_ERROR_TS_HEAD);
    const head = commit(repo, "head");

    const result = await drift({ cwd: repo, base, head });

    expect(findSite(result.sites, "CHANGELOG.md", 5)?.identifier).toBe(
      "RuntimeError",
    );
    const nearby = findSite(result.allowlisted, "CHANGELOG.md", 6);
    expect(nearby?.identifier).toBe("RuntimeError");
    expect(nearby?.allowlistReason).toMatch(/historical phrase "former"/);
    expect(findSite(result.sites, "CHANGELOG.md", 6)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// drift(): a deleted file's basename is only reported as a removed
// identifier when it looks like one and has a recognized source
// extension; otherwise it is skipped with a warning naming it.
// ---------------------------------------------------------------------

describe("drift (deleted-file basename guard)", () => {
  it("deleting src/index.ts reports zero sites and one warning naming it", async () => {
    const repo = initRepo();
    writeFile(repo, "src/index.ts", "console.log('startup');\n");
    writeFile(repo, "README.md", "# Readme\n\nSome unrelated notes.\n");
    const base = commit(repo, "base");
    fs.rmSync(path.join(repo, "src/index.ts"));
    const head = commit(repo, "head");

    const result = await drift({ cwd: repo, base, head });

    expect(result.sites).toEqual([]);
    expect(result.status).toBe("ok");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/src\/index\.ts/);
    expect(result.warnings[0]).toMatch(/basename skipped/);
  });
});

// ---------------------------------------------------------------------
// drift(): the migration-doc-path check requires an actual `docs/**`
// subtree, not merely both substrings "docs/" and "migration" anywhere in
// the path.
// ---------------------------------------------------------------------

describe("drift (migration path tightened)", () => {
  it("does not allowlist a path with 'docs/' and 'migration' out of order (migration/docs/x.md)", async () => {
    const repo = initRepo();
    writeFile(
      repo,
      "migration/docs/note.md",
      "# Note\n\nOldThing is still mentioned here.\n",
    );
    writeFile(repo, "src/old.ts", "export const OldThing = 1;\n");
    const base = commit(repo, "base");
    fs.rmSync(path.join(repo, "src/old.ts"));
    const head = commit(repo, "head");

    const result = await drift({ cwd: repo, base, head });
    const site = findSite(result.sites, "migration/docs/note.md", 3);
    expect(site?.identifier).toBe("OldThing");
    expect(
      findSite(result.allowlisted, "migration/docs/note.md", 3),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// drift(): every git call is resolved against the work tree's root, not
// the caller's `cwd`, so running from a subdirectory still reports
// root-relative paths and reads the right file for a heading/released-
// section decision.
// ---------------------------------------------------------------------

describe("drift (cwd as a subdirectory of the work tree)", () => {
  function buildRootAndSubdirRepo(): {
    repo: string;
    subdir: string;
    base: string;
    head: string;
  } {
    const repo = initRepo();
    writeFile(
      repo,
      "CHANGELOG.md",
      [
        "# Changelog",
        "",
        "## 1.2.0",
        "",
        "- documents RuntimeError today",
        "",
      ].join("\n"),
    );
    writeFile(
      repo,
      "sub/CHANGELOG.md",
      [
        "# Sub Changelog",
        "",
        "## [Unreleased]",
        "",
        "- still references RuntimeError here",
        "",
      ].join("\n"),
    );
    writeFile(repo, "sub/src/runError.ts", RUN_ERROR_TS_BASE);
    const base = commit(repo, "base");
    writeFile(repo, "sub/src/runError.ts", RUN_ERROR_TS_HEAD);
    const head = commit(repo, "head");
    return { repo, subdir: path.join(repo, "sub"), base, head };
  }

  it("reports root-relative paths and the correct allowlist reason when cwd is a subdirectory", async () => {
    const { subdir, base, head } = buildRootAndSubdirRepo();
    const result = await drift({ cwd: subdir, base, head });

    // The nested CHANGELOG's mention is reported at its root-relative
    // path, not a cwd-relative "CHANGELOG.md" or a malformed one.
    const nested = findSite(result.sites, "sub/CHANGELOG.md", 5);
    expect(nested?.identifier).toBe("RuntimeError");

    // The root CHANGELOG's mention is allowlisted for the right reason
    // (its released "1.2.0" section), which requires reading ITS
    // headings from the correct, root-relative path.
    const rootSite = findSite(result.allowlisted, "CHANGELOG.md", 5);
    expect(rootSite?.identifier).toBe("RuntimeError");
    expect(rootSite?.allowlistReason).toMatch(
      /released changelog section "1\.2\.0"/,
    );
  });
});

// ---------------------------------------------------------------------
// CLI: envelope shape and exit codes.
// ---------------------------------------------------------------------

describe("drift CLI", () => {
  it("exits 2 with status usage_error for a bad --head", async () => {
    const repo = initRepo();
    writeFile(repo, "a.txt", "x\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo });
    const run = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      "HEAD",
      "--head",
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(parsed.status).toBe("usage_error");
    expect(parsed.tool).toBe("agent-primitives");
    expect(parsed.command).toBe("unknown");
  });

  it("exits 1 with status fail and the documented envelope shape when sites are found", async () => {
    const { repo, base, head } = buildSyntheticRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
    ]);
    expect(run.code).toBe(1);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(parsed.status).toBe("fail");
    expect(parsed.command).toBe("drift");
    expect(Array.isArray(parsed.removed_identifiers)).toBe(true);
    expect(Array.isArray(parsed.sites)).toBe(true);
    expect(Array.isArray(parsed.allowlisted)).toBe(true);
    expect(parsed.counts).toEqual({ removed: 3, sites: 5, allowlisted: 5 });
  });

  it("exits 0 with status ok when no site is reported", async () => {
    const repo = initRepo();
    writeFile(repo, "README.md", "# Readme\n\nRunError is used now.\n");
    writeFile(repo, "src/runError.ts", RUN_ERROR_TS_BASE);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo });
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    writeFile(repo, "src/runError.ts", RUN_ERROR_TS_HEAD);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "head"], { cwd: repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    const run = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
    ]);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(parsed.status).toBe("ok");
  });

  function buildAllAllowlistedRepo(): {
    repo: string;
    base: string;
    head: string;
  } {
    const repo = initRepo();
    writeFile(
      repo,
      "README.md",
      "# Readme\n\nOldThing was renamed for clarity.\n",
    );
    writeFile(repo, "src/old.ts", "export const OldThing = 1;\n");
    const base = commit(repo, "base");
    fs.rmSync(path.join(repo, "src/old.ts"));
    const head = commit(repo, "head");
    return { repo, base, head };
  }

  it("--strict flips the exit code from 0 to 1 when every site would otherwise be allowlisted", async () => {
    const { repo, base, head } = buildAllAllowlistedRepo();

    const withoutStrict = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
    ]);
    expect(withoutStrict.code).toBe(0);
    const withoutStrictParsed = JSON.parse(withoutStrict.stdout) as Record<
      string,
      unknown
    >;
    expect(withoutStrictParsed.status).toBe("ok");

    const withStrict = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
      "--strict",
    ]);
    expect(withStrict.code).toBe(1);
    const withStrictParsed = JSON.parse(withStrict.stdout) as Record<
      string,
      unknown
    >;
    expect(withStrictParsed.status).toBe("fail");
    const sites = withStrictParsed.sites as Array<Record<string, unknown>>;
    expect(sites).toHaveLength(1);
    expect(sites[0]?.allowlisted).toBe(true);
  });

  it("--allow moves an otherwise-reported site into allowlisted, with the glob named in the reason", async () => {
    const { repo, base, head } = buildSyntheticRepo();

    const withoutAllow = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
    ]);
    const withoutAllowParsed = JSON.parse(withoutAllow.stdout) as Record<
      string,
      unknown
    >;
    const sitesBefore = withoutAllowParsed.sites as Array<
      Record<string, unknown>
    >;
    expect(sitesBefore.some((s) => s.path === "notes2.md")).toBe(true);

    const withAllow = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
      "--allow",
      "notes2.md",
    ]);
    const withAllowParsed = JSON.parse(withAllow.stdout) as Record<
      string,
      unknown
    >;
    const sitesAfter = withAllowParsed.sites as Array<Record<string, unknown>>;
    expect(sitesAfter.some((s) => s.path === "notes2.md")).toBe(false);
    const allowlistedAfter = withAllowParsed.allowlisted as Array<
      Record<string, unknown>
    >;
    const moved = allowlistedAfter.find((s) => s.path === "notes2.md");
    expect(moved?.allowlistReason).toMatch(/matched --allow glob "notes2\.md"/);
  });

  it("-f text renders a path:line:identifier line per site and the counts summary line", async () => {
    const { repo, base, head } = buildSyntheticRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-f",
      "text",
      "drift",
      "--base",
      base,
      "--head",
      head,
    ]);
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/README\.md:3: RuntimeError\b/);
    expect(run.stdout).toMatch(
      /3 removed identifier\(s\), 5 site\(s\) reported, 5 allowlisted/,
    );
  });

  it("names the moved identifier in warnings on the synthetic repo", async () => {
    const { repo, base, head } = buildSyntheticRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
    ]);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    const warnings = parsed.warnings as string[];
    expect(warnings.some((w) => w.includes("MovedThing"))).toBe(true);
  });

  it("keeps counts whole under a tight --max-chars even though sites/allowlisted are cut", async () => {
    const { repo, base, head } = buildSyntheticRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-m",
      "1200",
      "drift",
      "--base",
      base,
      "--head",
      head,
    ]);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(parsed.truncated).toBe(true);
    expect(parsed.counts).toEqual({ removed: 3, sites: 5, allowlisted: 5 });
  });
});

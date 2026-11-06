import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  DECLARATION_KEYWORDS,
  HEAD_KEYWORD_MODIFIERS,
  HEAD_KEYWORD_OPENERS,
  LOCAL_BINDING_COMMENT_PREFIXES,
  NAME_CONTINUATION_CHARACTER,
  drift,
  headDeclarationPattern,
  isAnchoredBefore,
  isLiveHeadDeclaration,
  type DriftResult,
} from "../src/drift/index.js";
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
import {
  classifyLine,
  HEAD_SOURCE_PATHSPECS,
  parseGrepOutput,
} from "../src/drift/scan.js";
import { mergeBase } from "../src/drift/git.js";
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
      {
        name: "RuntimeError",
        kind: "declaration",
        file: "src/a.ts",
        line: 1,
        exported: true,
        indented: false,
      },
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
      exported: true,
      indented: false,
    });
    // A deleted file has no declaration line, so neither shape fact is set.
    expect(result.removed).toContainEqual({
      name: "oldModule",
      kind: "file",
      file: "src/oldModule.ts",
      line: 1,
      exported: false,
      indented: false,
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
      {
        name: "featureFlag",
        kind: "config_key",
        file: "config.json",
        line: 2,
        // A config key's format has no `export`, and the indentation of a
        // JSON top-level key is nesting, not scope.
        exported: false,
        indented: true,
      },
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
      {
        name: "timeout",
        kind: "config_key",
        file: "config.yml",
        line: 1,
        exported: false,
        indented: false,
      },
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
      {
        name: "loadThing",
        kind: "declaration",
        file: "src/b.ts",
        line: 1,
        exported: true,
        indented: false,
      },
      {
        name: "BaseThing",
        kind: "declaration",
        file: "src/b.ts",
        line: 2,
        exported: true,
        indented: false,
      },
      {
        name: "genThing",
        kind: "declaration",
        file: "src/b.ts",
        line: 3,
        exported: false,
        indented: false,
      },
      {
        name: "streamThing",
        kind: "declaration",
        file: "src/b.ts",
        line: 4,
        exported: true,
        indented: false,
      },
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
      exported: false,
      indented: false,
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
      {
        name: "OldThing",
        kind: "declaration",
        file: "src/thing.ts",
        line: 2,
        exported: true,
        indented: false,
      },
    ]);
  });

  it("treats an added line whose content starts with '++ ' as content too (not a header), so the added declaration right after it is still attributed to the right file, even across a real rename", () => {
    // "++ note..." as file content becomes the diff line
    // "+++ note..." once prefixed with the diff's own leading "+" - the
    // `+++ ` counterpart of the "-- " trap above. Gated on the same
    // `!sawHunk`, it must be read as content, not as a `+++ b/<path>`
    // header that would overwrite `newPath`.
    //
    // A real rename (`old path !== new path` in the `---`/`+++`
    // headers, unlike a same-path in-place edit) is what actually
    // exercises that gate: a compound mutant that disables the whole
    // `!sawHunk && raw.startsWith("+++ ")` branch (not merely its
    // `!sawHunk` guard) makes `newPath` never get set from the file's
    // own real `+++ b/<path>` header either, so every added line falls
    // back to `oldPath` (`newPath ?? oldPath`) instead. With a same-path
    // edit that fallback lands on the SAME file and is unobservable; a
    // same-extension rename (`.ts` -> `.tsx`) still is not observable,
    // since both land in the same `SOURCE_EXTENSIONS` bucket and
    // `extractIdentifier` classifies purely by extension. Renaming across
    // buckets -- here a YAML config key becoming a TS declaration -- is
    // what makes the two paths disagree on classification: under correct
    // code the added `export const OldThing = 2;` line is read against
    // the real new path's `.ts` extension and recognized as a
    // declaration (so `OldThing` counts as "moved"); under the mutant it
    // is wrongly read against the old path's `.yaml` extension instead,
    // `OldThing` never lands in `addedNames`, and it wrongly stays
    // "removed".
    const diff = [
      "diff --git a/src/old-thing.yaml b/src/new-thing.ts",
      "similarity index 40%",
      "rename from src/old-thing.yaml",
      "rename to src/new-thing.ts",
      "index 1111111..2222222 100644",
      "--- a/src/old-thing.yaml",
      "+++ b/src/new-thing.ts",
      "@@ -1,1 +1,2 @@",
      "-OldThing: 1",
      "+++ note: trailing comment marker",
      "+export const OldThing = 2;",
      "",
    ].join("\n");
    const result = parseRemovedIdentifiers(diff);
    expect(result.movedNames).toEqual(["OldThing"]);
    expect(result.removed).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// parseDiff.ts: PHP declaration lines, and the extensions that are
// scanned for sites without having a declaration extractor.
// ---------------------------------------------------------------------

interface PhpDeclRow {
  label: string;
  line: string;
  expect?: { name: string; exported: boolean; indented: boolean };
  /** The line declares a name that does not clear the identifier bar:
   * nothing is extracted, and the name is recorded in
   * `skippedPhpNames` instead. */
  skipBar?: string;
}

const PHP_DECL_ROWS: readonly PhpDeclRow[] = [
  // top-level declarations, bare and with each legal modifier form
  {
    label: "top-level class",
    line: "class Widget {}",
    expect: { name: "Widget", exported: true, indented: false },
  },
  {
    label: "abstract class",
    line: "abstract class Widget {}",
    expect: { name: "Widget", exported: true, indented: false },
  },
  {
    label: "final class",
    line: "final class Widget {}",
    expect: { name: "Widget", exported: true, indented: false },
  },
  {
    label: "final readonly class",
    line: "final readonly class Widget {}",
    expect: { name: "Widget", exported: true, indented: false },
  },
  {
    label: "interface",
    line: "interface Widget {}",
    expect: { name: "Widget", exported: true, indented: false },
  },
  {
    label: "trait",
    line: "trait Widget {}",
    expect: { name: "Widget", exported: true, indented: false },
  },
  {
    label: "enum with a backing type",
    line: "enum Widget: string {}",
    expect: { name: "Widget", exported: true, indented: false },
  },
  // methods at indentation 4: each visibility, with and without static,
  // and the unspecified (PHP-default-public) form
  {
    label: "public method",
    line: "    public function doThing() {}",
    expect: { name: "doThing", exported: true, indented: true },
  },
  {
    label: "protected method",
    line: "    protected function doThing() {}",
    expect: { name: "doThing", exported: false, indented: true },
  },
  {
    label: "private method",
    line: "    private function doThing() {}",
    expect: { name: "doThing", exported: false, indented: true },
  },
  {
    label: "private static method",
    line: "    private static function doThing() {}",
    expect: { name: "doThing", exported: false, indented: true },
  },
  {
    label: "public static method",
    line: "    public static function doThing() {}",
    expect: { name: "doThing", exported: true, indented: true },
  },
  {
    label: "method with no visibility (PHP defaults to public)",
    line: "    function doThing() {}",
    expect: { name: "doThing", exported: true, indented: true },
  },
  {
    label: "function at indentation 0",
    line: "function doThing() {}",
    expect: { name: "doThing", exported: true, indented: false },
  },
  {
    label: "by-reference method",
    line: "    private function &doThing() {}",
    expect: { name: "doThing", exported: false, indented: true },
  },
  // constants: class constants with and without visibility, and top level
  // (the names clear the identifier bar; a name that does not is a
  // `skipBar` row below)
  {
    label: "class const, no visibility",
    line: "    const MAX_SIZE = 1;",
    expect: { name: "MAX_SIZE", exported: true, indented: true },
  },
  {
    label: "private class const",
    line: "    private const MAX_SIZE = 1;",
    expect: { name: "MAX_SIZE", exported: false, indented: true },
  },
  {
    label: "final public class const",
    line: "    final public const MAX_SIZE = 1;",
    expect: { name: "MAX_SIZE", exported: true, indented: true },
  },
  {
    label: "top-level const",
    line: "const MAX_SIZE = 1;",
    expect: { name: "MAX_SIZE", exported: true, indented: false },
  },
  // PHP keywords are case-insensitive; the name keeps the line's case
  {
    label: "case-variant keywords keep the name's case",
    line: "    PUBLIC FUNCTION DoThing() {}",
    expect: { name: "DoThing", exported: true, indented: true },
  },
  {
    label: "uppercase CLASS",
    line: "CLASS Widget {}",
    expect: { name: "Widget", exported: true, indented: false },
  },
  {
    label: "case-variant Final and Class",
    line: "Final Class Widget {}",
    expect: { name: "Widget", exported: true, indented: false },
  },
  // a comment line that quotes a declaration is not one
  { label: "// comment", line: "    // function widgetLoader() {" },
  { label: "# comment", line: "# function widgetLoader() {" },
  { label: "docblock continuation", line: " * function widgetLoader()" },
  { label: "/* comment */", line: "/* function widgetLoader() */" },
  // a string literal is not a declaration either (single-line case)
  {
    label: "string literal",
    line: '    $code = "function widgetLoader() {";',
  },
  // a name that does not clear the identifier bar (4+ characters with an
  // uppercase letter, hyphen or underscore - the bar a deleted file's
  // basename faces) is recorded, not extracted: a framework method name
  // is an ordinary prose word that would be scanned against every doc
  {
    label: "framework method up (identifier bar)",
    line: "    public function up() {}",
    skipBar: "up",
  },
  {
    label: "framework method down (identifier bar)",
    line: "    public function down() {}",
    skipBar: "down",
  },
  {
    label: "framework method show (identifier bar)",
    line: "    public function show()",
    skipBar: "show",
  },
  {
    label: "reserved word method function (identifier bar)",
    line: "    public function function() {}",
    skipBar: "function",
  },
  {
    label: "lowercase class name widget (identifier bar)",
    line: "class widget {}",
    skipBar: "widget",
  },
  {
    label: "three-letter const MAX (identifier bar)",
    line: "const MAX = 1;",
    skipBar: "MAX",
  },
  // a name that does clear the bar still extracts (positive control)
  {
    label: "framework-shaped method with a bar-clearing name",
    line: "    public function createUsersTable() {}",
    expect: { name: "createUsersTable", exported: true, indented: true },
  },
  // anonymous shapes contribute nothing
  {
    label: "anonymous closure",
    line: "    $cb = function ($x) { return $x; };",
  },
  { label: "inline new class", line: "    $obj = new class extends Base {};" },
  // define() is not a const declaration (documented limitation)
  { label: "define() call", line: "define('MAX_THING', 1);" },
];

describe("parseRemovedIdentifiers (PHP declarations)", () => {
  it.each(PHP_DECL_ROWS)(
    "removes $label only if it is a declaration",
    (row) => {
      const diff = [
        "diff --git a/src/Foo.php b/src/Foo.php",
        "index 1111111..2222222 100644",
        "--- a/src/Foo.php",
        "+++ b/src/Foo.php",
        "@@ -1 +1 @@",
        `-${row.line}`,
        "+// replaced",
        "",
      ].join("\n");
      const result = parseRemovedIdentifiers(diff);
      if (row.skipBar !== undefined) {
        expect(result.removed).toEqual([]);
        expect(result.skippedPhpNames).toEqual([row.skipBar]);
        return;
      }
      if (row.expect === undefined) {
        expect(result.removed).toEqual([]);
        expect(result.skippedPhpNames).toEqual([]);
        return;
      }
      expect(result.removed).toEqual([
        {
          name: row.expect.name,
          kind: "declaration",
          file: "src/Foo.php",
          line: 1,
          exported: row.expect.exported,
          indented: row.expect.indented,
        },
      ]);
      expect(result.skippedPhpNames).toEqual([]);
      expect(result.movedNames).toEqual([]);
    },
  );
});

/** `diff --git` blocks for the identifier bar: each removes or adds one
 * line of one file, in the given order. */
function barDiff(...blocks: readonly string[]): string {
  return [...blocks, ""].join("\n");
}

function phpFileDiff(
  file: string,
  removedLine: string | undefined,
  addedLine: string | undefined,
): string {
  const hunk = `-1 +1`;
  return [
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${hunk} @@`,
    ...(removedLine === undefined ? [] : [`-${removedLine}`]),
    ...(addedLine === undefined ? [] : [`+${addedLine}`]),
  ].join("\n");
}

describe("parseRemovedIdentifiers (PHP identifier bar)", () => {
  it("records one bar-failing name removed from two files once", () => {
    const result = parseRemovedIdentifiers(
      barDiff(
        phpFileDiff("src/First.php", "    public function up() {}", undefined),
        phpFileDiff("src/Second.php", "    public function up() {}", undefined),
      ),
    );
    expect(result.removed).toEqual([]);
    expect(result.skippedPhpNames).toEqual(["up"]);
  });

  it("drops a bar-failing name the same diff declares again on an added line (a signature edit, not a removal)", () => {
    const result = parseRemovedIdentifiers(
      barDiff(
        phpFileDiff(
          "src/Migration.php",
          "    public function up() {}",
          "    public function up(): void {}",
        ),
      ),
    );
    expect(result.removed).toEqual([]);
    expect(result.skippedPhpNames).toEqual([]);
    expect(result.movedNames).toEqual([]);
  });

  it("keeps a same-spelled name removed in another language reported when a bar-failing PHP declaration is added", () => {
    const result = parseRemovedIdentifiers(
      barDiff(
        [
          "diff --git a/config.yml b/config.yml",
          "index 1111111..2222222 100644",
          "--- a/config.yml",
          "+++ b/config.yml",
          "@@ -1 +0,0 @@",
          "-show: true",
        ].join("\n"),
        phpFileDiff(
          "src/Controller.php",
          undefined,
          "    public function show() {}",
        ),
      ),
    );
    expect(result.removed).toEqual([
      {
        name: "show",
        kind: "config_key",
        file: "config.yml",
        line: 1,
        exported: false,
        indented: false,
      },
    ]);
    expect(result.movedNames).toEqual([]);
    expect(result.skippedPhpNames).toEqual([]);
  });
});

describe("parseRemovedIdentifiers (extractor gaps)", () => {
  it("records one entry per scanned extension without an extractor, with the distinct removed-line file count, sorted by extension", () => {
    const diff = [
      "diff --git a/tools.py b/tools.py",
      "index 1111111..2222222 100644",
      "--- a/tools.py",
      "+++ b/tools.py",
      "@@ -1,2 +1 @@",
      "-def helperThing():",
      "-    return 1",
      "+# rewritten",
      "diff --git a/inner/more.py b/inner/more.py",
      "index 1111111..2222222 100644",
      "--- a/inner/more.py",
      "+++ b/inner/more.py",
      "@@ -1 +1 @@",
      "-def otherThing(): ...",
      "+# rewritten",
      "diff --git a/run.sh b/run.sh",
      "index 1111111..2222222 100644",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1,2 +1 @@",
      "-run_thing() {",
      "-  echo hi",
      "+# rewritten",
      "diff --git a/src/Foo.php b/src/Foo.php",
      "index 1111111..2222222 100644",
      "--- a/src/Foo.php",
      "+++ b/src/Foo.php",
      "@@ -1 +1 @@",
      "-function legacyThing() {}",
      "+// replaced",
      "diff --git a/notes.md b/notes.md",
      "index 1111111..2222222 100644",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1 +1 @@",
      "-an old paragraph",
      "+a new paragraph",
      "diff --git a/exotic.rb b/exotic.rb",
      "index 1111111..2222222 100644",
      "--- a/exotic.rb",
      "+++ b/exotic.rb",
      "@@ -1 +1 @@",
      "-def legacy_thing; end",
      "+# rewritten",
      "",
    ].join("\n");
    const result = parseRemovedIdentifiers(diff);
    // .py and .sh are scanned for sites but have no declaration
    // extractor; .php has one now, .md is a doc, and .rb is out of
    // scope entirely (never scanned, so no gap to warn about).
    expect(result.extractorGaps).toEqual([
      { ext: "py", files: 2 },
      { ext: "sh", files: 1 },
    ]);
    // and the extractor still collected the PHP declaration
    expect(result.removed.map((r) => r.name)).toEqual(["legacyThing"]);
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

  it("historicalPhraseNearIdentifier: an unrelated historical phrase far from the identifier's own mention does not allowlist it, but one right next to the mention does", () => {
    // Models a real, motivating case: "no longer" (about a different
    // identifier, `runError`) sits well before "mirroring FilesPage's
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

  it("historicalPhraseNearIdentifier: pins the window geometry against a real, motivating 996-character changelog line - an unrelated historical word 69 characters before the mention, and a second one 128 characters after it, both stay outside the default window", () => {
    // Built to exact offsets, not eyeballed: identifier mention starts at
    // 155; an unrelated "was " sits at 86 (69 chars before the mention);
    // an unrelated "no longer" sits at 295 (128 chars after the
    // mention's own end at 167). Both are well past the default 60
    // chars before / 20 chars after window, so neither allowlists it.
    const identifier = "RuntimeError";
    let text = "x".repeat(86);
    expect(text.length).toBe(86);
    text += "was ";
    text += "x".repeat(64) + " "; // pads to just before the mention, offset 155
    expect(text.length).toBe(155);
    text += identifier;
    expect(text.length).toBe(167);
    text += " " + "x".repeat(127); // pads to offset 295
    expect(text.length).toBe(295);
    text += "no longer";
    text += "x".repeat(996 - text.length);
    expect(text.length).toBe(996);

    expect(historicalPhraseNearIdentifier(text, identifier)).toBeUndefined();
  });

  it("historicalPhraseNearIdentifier: a historical phrase inside the 60-char lookback but behind a sentence boundary does not allowlist the mention", () => {
    // "removed" sits at offset 30, well within the 60-char lookback from
    // the mention at offset 90 (floor = 30), but a ". " sentence
    // boundary at offset 37 cuts the span short before it, so the span
    // actually checked never reaches back far enough to see it.
    const identifier = "RuntimeError";
    let text = "x".repeat(30);
    text += "removed";
    text += ". ";
    text += "x".repeat(50) + " "; // pads to just before the mention, offset 90
    expect(text.length).toBe(90);
    text += identifier;
    text += " " + "x".repeat(10);

    expect(historicalPhraseNearIdentifier(text, identifier)).toBeUndefined();
  });

  it("historicalPhraseNearIdentifier finds a $-prefixed identifier's own occurrence rather than falling back to a whole-line scan, which would falsely allowlist it on a distant, unrelated phrase", () => {
    const text =
      "$store still drives every read here without exception in current code, " +
      "and elsewhere in this same file an unrelated helper was removed a while " +
      "back and is no longer referenced by anything at all.";
    expect(historicalPhraseNearIdentifier(text, "$store")).toBeUndefined();
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

  it("classifyLine: a.php recognizes all four comment forms (// , # , /* ... */, and docblock ' * ' continuation), never a code line", () => {
    expect(classifyLine("a.php", "// a comment")).toBe("comment");
    expect(classifyLine("a.php", "# a comment")).toBe("comment");
    expect(classifyLine("a.php", "/* a comment */")).toBe("comment");
    expect(classifyLine("a.php", " * a docblock continuation line")).toBe(
      "comment",
    );
    expect(classifyLine("a.php", "$x = 1;")).toBeUndefined();
    expect(classifyLine("a.php", "class Foo {}")).toBeUndefined();
  });

  it("classifyLine: a.php does NOT classify a PHP 8 attribute (`#[...]`) as a comment (negative control; round-1 review finding)", () => {
    expect(classifyLine("a.php", "#[Test]")).toBeUndefined();
    expect(classifyLine("a.php", "#[Route('/x')]")).toBeUndefined();
    expect(classifyLine("a.php", "    #[Test]")).toBeUndefined();
    // A real `#` line comment right next to an attribute is still
    // recognized: the exclusion is scoped to `#[`, not to every line
    // starting with `#`.
    expect(classifyLine("a.php", "# not an attribute")).toBe("comment");
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
// drift(): the synthetic repo modeling a real, motivating RuntimeError
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
      exported: true,
      indented: false,
    });
    expect(result.removedIdentifiers).toContainEqual({
      name: "oldModuleValue",
      kind: "declaration",
      file: "src/oldModule.ts",
      line: 1,
      exported: true,
      indented: false,
    });
    expect(result.removedIdentifiers).toContainEqual({
      name: "oldModule",
      kind: "file",
      file: "src/oldModule.ts",
      line: 1,
      exported: false,
      indented: false,
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
// drift(): a matched line longer than 300 characters is capped, with a
// trailing "..." marker, so a single dense line never dominates the
// envelope's size budget.
// ---------------------------------------------------------------------

describe("drift (site text capped at 300 chars)", () => {
  it("caps a long matched line's site text at 300 chars with a trailing '...' marker", async () => {
    const repo = initRepo();
    const longLine = "OldThing " + "z".repeat(400);
    writeFile(repo, "NOTES.md", ["# Notes", "", longLine, ""].join("\n"));
    writeFile(repo, "src/old.ts", "export const OldThing = 1;\n");
    const base = commit(repo, "base");
    writeFile(repo, "src/old.ts", "export const NewThing = 1;\n");
    const head = commit(repo, "head");

    const result = await drift({ cwd: repo, base, head });
    const site = findSite(result.sites, "NOTES.md", 3);
    expect(site).toBeDefined();
    expect(site?.text).toHaveLength(303);
    expect(site?.text.endsWith("...")).toBe(true);
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

describe("drift (ambient GIT_*_PATHSPECS switches)", () => {
  // Without the env strip, GLOB, NOGLOB and LITERAL make `git grep` miss the
  // cited doc and drift report ok; ICASE still matches. The ICASE case is a
  // regression net only, it does not pin the defect.
  it.each([
    "GIT_GLOB_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS",
    "GIT_ICASE_PATHSPECS",
    "GIT_LITERAL_PATHSPECS",
  ])(
    "still reports a removed identifier a doc cites when %s is set, never ok with zero sites",
    async (name) => {
      const repo = initRepo();
      writeFile(repo, "src/a.ts", "export function fooBarBaz() {}\n");
      writeFile(repo, "docs/a.md", "Call `fooBarBaz` to start.\n");
      const base = commit(repo, "base");
      writeFile(repo, "src/a.ts", "export function other() {}\n");
      const head = commit(repo, "head");

      const saved = process.env[name];
      process.env[name] = "1";
      try {
        const result = await drift({ cwd: repo, base, head });
        expect(result.warnings).toEqual([]);
        expect(result.status).toBe("fail");
        expect(result.sites.map((s) => `${s.path}:${s.identifier}`)).toEqual([
          "docs/a.md:fooBarBaz",
        ]);
      } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    },
  );
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
// drift(): .php comment sites (`//`, `#`, `/* ... */`, docblock ` * `
// continuation lines) are scanned the same way a .ts/.py comment is.
// ---------------------------------------------------------------------

const LEGACY_HELPER_PHP = [
  "<?php",
  "",
  "// LegacyHelper computes the old way",
  "# LegacyHelper is deprecated",
  "/* LegacyHelper still referenced here */",
  "/**",
  " * LegacyHelper continuation line in a docblock",
  " */",
  "function currentHelper() {",
  "    return 1;",
  "}",
  "",
].join("\n");

describe("drift (.php comment sites)", () => {
  it("a removed identifier still named in each of the four PHP comment forms is reported at its own line, kind comment", async () => {
    const repo = initRepo();
    writeFile(repo, "src/legacy.ts", "export const LegacyHelper = 1;\n");
    writeFile(repo, "src/Helper.php", LEGACY_HELPER_PHP);
    const base = commit(repo, "base");
    fs.rmSync(path.join(repo, "src/legacy.ts"));
    const head = commit(repo, "head");

    const result = await drift({ cwd: repo, base, head });
    expect(result.removedIdentifiers).toContainEqual({
      name: "LegacyHelper",
      kind: "declaration",
      file: "src/legacy.ts",
      line: 1,
      exported: true,
      indented: false,
    });

    const slashSlash = findSite(result.sites, "src/Helper.php", 3);
    expect(slashSlash?.identifier).toBe("LegacyHelper");
    expect(slashSlash?.kind).toBe("comment");

    const hash = findSite(result.sites, "src/Helper.php", 4);
    expect(hash?.identifier).toBe("LegacyHelper");
    expect(hash?.kind).toBe("comment");

    const slashStar = findSite(result.sites, "src/Helper.php", 5);
    expect(slashStar?.identifier).toBe("LegacyHelper");
    expect(slashStar?.kind).toBe("comment");

    const docblockContinuation = findSite(result.sites, "src/Helper.php", 7);
    expect(docblockContinuation?.identifier).toBe("LegacyHelper");
    expect(docblockContinuation?.kind).toBe("comment");

    expect(result.status).toBe("fail");
  });

  it("a PHP code line mentioning the removed identifier's name only in an identifier token (not a comment) is not reported", async () => {
    const repo = initRepo();
    writeFile(repo, "src/legacy.ts", "export const LegacyHelper = 1;\n");
    writeFile(
      repo,
      "src/Consumer.php",
      [
        "<?php",
        "",
        "function useLegacyHelper() {",
        "    return 1;",
        "}",
        "",
      ].join("\n"),
    );
    const base = commit(repo, "base");
    fs.rmSync(path.join(repo, "src/legacy.ts"));
    const head = commit(repo, "head");

    const result = await drift({ cwd: repo, base, head });
    // `useLegacyHelper` is one identifier token, not a whole-word match
    // for `LegacyHelper` (the same word-boundary trap the synthetic
    // repo's `setRuntimeError`/`RuntimeError` pair pins in TS).
    expect(findSite(result.sites, "src/Consumer.php", 3)).toBeUndefined();
    expect(result.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------
// drift(): a removed PHP declaration (the issue #619 repro: a public
// method removed from src/Foo.php while README.md and a docblock still
// name it), and the local-binding rule over PHP removals.
// ---------------------------------------------------------------------

const FOO_PHP_BASE = [
  "<?php",
  "",
  "class Foo {",
  "    /**",
  "     * legacyName returns the legacy value.",
  "     */",
  "    public function legacyName() {",
  "        return 1;",
  "    }",
  "}",
  "",
].join("\n");

const FOO_PHP_HEAD = [
  "<?php",
  "",
  "class Foo {",
  "    /**",
  "     * legacyName returns the legacy value.",
  "     */",
  "}",
  "",
].join("\n");

/** The issue repro repo: `main` at base, `HEAD` with `legacyName()`
 * removed from src/Foo.php, README.md line 2 and the docblock line in
 * src/Foo.php (line 5) both still naming it. */
function buildPhpReproRepo(): { repo: string; base: string; head: string } {
  const repo = initRepo();
  writeFile(repo, "src/Foo.php", FOO_PHP_BASE);
  writeFile(
    repo,
    "README.md",
    "# Readme\nCall legacyName() to get the value.\n",
  );
  const base = commit(repo, "base");
  // `main` must stay at the base commit while HEAD moves: rename the
  // (now existing) initial branch out of the way, then name the base.
  git(repo, ["branch", "-m", "work"]);
  git(repo, ["branch", "main", base]);
  writeFile(repo, "src/Foo.php", FOO_PHP_HEAD);
  const head = commit(repo, "head");
  return { repo, base, head };
}

describe("drift (removed PHP declarations)", () => {
  it("collects the removed public method and reports both remaining sites", async () => {
    const { repo, base, head } = buildPhpReproRepo();
    const result = await drift({ cwd: repo, base, head });
    expect(result.removedIdentifiers).toEqual([
      {
        name: "legacyName",
        kind: "declaration",
        file: "src/Foo.php",
        line: 7,
        exported: true,
        indented: true,
      },
    ]);
    expect(result.counts).toEqual({ removed: 1, sites: 2, allowlisted: 0 });
    expect(findSite(result.sites, "README.md", 2)?.kind).toBe("doc");
    expect(findSite(result.sites, "src/Foo.php", 5)?.kind).toBe("comment");
    expect(result.status).toBe("fail");
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// The PHP identifier bar: a removed PHP declaration name that does not
// clear `looksLikeIdentifier` (the bar a deleted file's basename faces)
// is not scanned. Repro (issue #619 review): a deleted Laravel-style
// migration declaring `public function up()` / `public function down()`,
// with README/docs prose using those very words ("set up", "scroll
// down", "look up") - without the bar every "up"/"down" in the repo
// reads as a stale mention of a removed declaration.
// ---------------------------------------------------------------------

describe("drift (PHP identifier bar)", () => {
  const MIGRATION_PHP = [
    "<?php",
    "",
    "return new class extends Migration {",
    "    public function up(): void",
    "    {",
    "        Schema::create('users', function (Blueprint $table) {});",
    "    }",
    "",
    "    public function down(): void",
    "    {",
    "        Schema::dropIfExists('users');",
    "    }",
    "};",
    "",
  ].join("\n");

  function migrationRepo(): { repo: string; base: string; head: string } {
    const repo = initRepo();
    writeFile(repo, "database/migrations/2024_create_users.php", MIGRATION_PHP);
    writeFile(
      repo,
      "README.md",
      "# App\n\nTo set up the app, run make.\nScroll down for the rest.\n",
    );
    writeFile(
      repo,
      "docs/guide.md",
      "# Guide\n\nLook up the config file first.\n",
    );
    const base = commit(repo, "base");
    fs.rmSync(path.join(repo, "database/migrations/2024_create_users.php"));
    const head = commit(repo, "head");
    return { repo, base, head };
  }

  it("scans nothing for up/down from a deleted migration, warns once per name, reports no site", async () => {
    const { repo, base, head } = migrationRepo();
    const result = await drift({ cwd: repo, base, head });
    expect(result.removedIdentifiers).toEqual([]);
    expect(result.sites).toEqual([]);
    expect(result.counts).toMatchObject({ removed: 0, sites: 0 });
    expect(result.status).toBe("ok");
    expect(result.warnings.filter((w) => w.includes(" not scanned: "))).toEqual(
      [
        'removed PHP declaration "up" not scanned: does not look like an identifier',
        'removed PHP declaration "down" not scanned: does not look like an identifier',
      ],
    );
  });

  it("--summary on the migration repro: removed=0 sites=0, both bar warnings, exit 0", async () => {
    const { repo, base, head } = migrationRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
      "--summary",
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      'warning: removed PHP declaration "up" not scanned: does not look like an identifier',
    );
    expect(run.stdout).toContain(
      'warning: removed PHP declaration "down" not scanned: does not look like an identifier',
    );
    // The third warning is the pre-existing deleted-file basename rule:
    // `2024_create_users.php` is deleted, so its basename is a skipped
    // candidate too.
    expect(run.stdout).toMatch(
      /totals: status=ok removed=0 sites=0 allowlisted=0 warnings=3 ignored=0/,
    );
  });

  it("extracts nothing and warns for `public function function()` (a PHP 8 method name)", async () => {
    const repo = initRepo();
    writeFile(
      repo,
      "src/Callable.php",
      [
        "<?php",
        "",
        "class Callable_ {",
        "    public function function() {}",
        "}",
        "",
      ].join("\n"),
    );
    const base = commit(repo, "base");
    writeFile(
      repo,
      "src/Callable.php",
      ["<?php", "", "class Callable_ {", "}", ""].join("\n"),
    );
    const head = commit(repo, "head");
    const result = await drift({ cwd: repo, base, head });
    expect(result.removedIdentifiers).toEqual([]);
    expect(result.warnings).toEqual([
      'removed PHP declaration "function" not scanned: does not look like an identifier',
    ]);
    expect(result.status).toBe("ok");
  });

  it("still extracts and reports a method name that clears the bar (createUsersTable)", async () => {
    const repo = initRepo();
    writeFile(
      repo,
      "src/Schema.php",
      [
        "<?php",
        "",
        "class Schema {",
        "    public function createUsersTable() {}",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(
      repo,
      "README.md",
      "# Readme\n\ncreateUsersTable builds the users table.\n",
    );
    const base = commit(repo, "base");
    writeFile(
      repo,
      "src/Schema.php",
      ["<?php", "", "class Schema {", "}", ""].join("\n"),
    );
    const head = commit(repo, "head");
    const result = await drift({ cwd: repo, base, head });
    expect(result.removedIdentifiers).toEqual([
      {
        name: "createUsersTable",
        kind: "declaration",
        file: "src/Schema.php",
        line: 4,
        exported: true,
        indented: true,
      },
    ]);
    expect(findSite(result.sites, "README.md", 3)?.identifier).toBe(
      "createUsersTable",
    );
    expect(result.status).toBe("fail");
    expect(result.warnings).toEqual([]);
  });
});

/** `src/A.php` loses its `private function legacyThing()` between base
 * and head; `src/B.php` (unchanged across the range, so never a "moved"
 * added line) declares the name in the row's shape at head. */
const PHP_LOCAL_A_BASE = [
  "<?php",
  "",
  "class A {",
  "    private function legacyThing() {",
  "        return 1;",
  "    }",
  "}",
  "",
].join("\n");

const PHP_LOCAL_A_HEAD = "<?php\n\nclass A {\n}\n";

const PHP_HEAD_DECL_ROWS: readonly {
  label: string;
  headDecl: string;
  expect: "reported" | "suppressed";
}[] = [
  {
    label: "re-declared as a method",
    headDecl: "    private function legacyThing() {}",
    expect: "suppressed",
  },
  {
    label: "re-declared as a class constant",
    headDecl: "    private const legacyThing = 1;",
    expect: "suppressed",
  },
  {
    label:
      "re-declared with case-variant keywords (case-insensitive PHP head grep)",
    headDecl: "    PRIVATE FUNCTION legacyThing() {}",
    expect: "suppressed",
  },
  {
    label: "re-declared as an interface (PHP keyword in the derived grep)",
    headDecl: "interface legacyThing {}",
    expect: "suppressed",
  },
  {
    label: "re-declared as a trait (PHP keyword in the derived grep)",
    headDecl: "trait legacyThing {}",
    expect: "suppressed",
  },
  {
    label: "re-declared as an enum (PHP keyword in the derived grep)",
    headDecl: "enum legacyThing: string {}",
    expect: "suppressed",
  },
  {
    label: "only mentioned at head (negative control)",
    headDecl: "$x = legacyThing();",
    expect: "reported",
  },
  {
    label:
      "re-declared with a case-variant NAME (PHP's own case-insensitivity is a limit)",
    headDecl: "FUNCTION LegacyThing() {}",
    expect: "reported",
  },
];

describe("drift (local-binding rule, PHP)", () => {
  it("the head grep pattern is derived from DECLARATION_KEYWORDS and carries the PHP keywords", () => {
    const pattern = headDeclarationPattern("legacyName");
    expect(pattern).toBe(`(${DECLARATION_KEYWORDS.join("|")}) legacyName`);
    for (const keyword of ["interface", "trait", "enum"]) {
      expect(DECLARATION_KEYWORDS).toContain(keyword);
    }
    expect(headDeclarationPattern("a$b")).toContain("\\$b");
  });

  it.each(PHP_HEAD_DECL_ROWS)(
    "a private method removed in src/A.php is $expect when src/B.php $label",
    async (row) => {
      const repo = initRepo();
      writeFile(repo, "src/A.php", PHP_LOCAL_A_BASE);
      writeFile(repo, "src/B.php", `<?php\n\n${row.headDecl}\n`);
      writeFile(
        repo,
        "notes.md",
        "# Notes\n\nlegacyThing is the helper this module uses.\n",
      );
      const base = commit(repo, "base");
      writeFile(repo, "src/A.php", PHP_LOCAL_A_HEAD);
      const head = commit(repo, "head");

      const result = await drift({ cwd: repo, base, head });
      const localBinding = {
        name: "legacyThing",
        source: "local-binding",
      } as const;
      if (row.expect === "reported") {
        expect(findSite(result.sites, "notes.md", 3)?.identifier).toBe(
          "legacyThing",
        );
        expect(result.ignoredIdentifiers).not.toContainEqual(localBinding);
      } else {
        expect(result.sites.filter((s) => s.path === "notes.md")).toEqual([]);
        expect(findSite(result.allowlisted, "notes.md", 3)).toMatchObject({
          identifier: "legacyThing",
          allowlisted: true,
          allowlistReason: 'local binding "legacyThing" still declared at head',
        });
        expect(result.ignoredIdentifiers).toContainEqual(localBinding);
      }
    },
  );
});

describe("drift (extractor-gap warning)", () => {
  /** base: a `.py`, a second `.py` and a `.sh` each with content lines,
   * plus a doc; head: all three rewritten (their lines all removed). */
  function gapRepo(): { repo: string; base: string; head: string } {
    const repo = initRepo();
    writeFile(repo, "tools.py", "def helperThing():\n    return 1\n");
    writeFile(repo, "inner/more.py", "def otherThing():\n    return 2\n");
    writeFile(repo, "run.sh", "run_thing() {\n  echo hi\n}\n");
    writeFile(repo, "docs/a.md", "# A\n\nNothing about helpers.\n");
    const base = commit(repo, "base");
    writeFile(repo, "tools.py", "# rewritten\n");
    writeFile(repo, "inner/more.py", "# rewritten\n");
    writeFile(repo, "run.sh", "# rewritten\n");
    const head = commit(repo, "head");
    return { repo, base, head };
  }

  it("warns once per extension, naming it and the file count, in extension order, with no other warning", async () => {
    const { repo, base, head } = gapRepo();
    const result = await drift({ cwd: repo, base, head });
    expect(result.warnings).toEqual([
      "no declaration extractor for .py; removed identifiers from 2 files not collected",
      "no declaration extractor for .sh; removed identifiers from 1 files not collected",
    ]);
  });

  it("does not warn for a diff that only removed lines from .md files", async () => {
    const repo = initRepo();
    writeFile(repo, "docs/a.md", "# A\n\nAn old paragraph.\n");
    const base = commit(repo, "base");
    writeFile(repo, "docs/a.md", "# A\n\nA new paragraph.\n");
    const head = commit(repo, "head");
    const result = await drift({ cwd: repo, base, head });
    expect(result.warnings).toEqual([]);
  });

  it("does not warn for a diff that removed lines from .php files (PHP has an extractor now)", async () => {
    const repo = initRepo();
    writeFile(repo, "src/Foo.php", FOO_PHP_BASE);
    const base = commit(repo, "base");
    writeFile(repo, "src/Foo.php", FOO_PHP_HEAD);
    const head = commit(repo, "head");
    const result = await drift({ cwd: repo, base, head });
    expect(result.warnings).toEqual([]);
    expect(result.removedIdentifiers.map((r) => r.name)).toEqual([
      "legacyName",
    ]);
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
    // The refusal comes from inside the `drift` action (the library's
    // own unresolvable-rev `UsageError`), so the envelope names the
    // subcommand whose parsing was in flight.
    expect(parsed.command).toBe("drift");
  });

  it("--head is optional and defaults to HEAD: without it the run resolves head to HEAD and says so", async () => {
    const { repo, base, head } = buildSyntheticRepo();
    const without = await spawnCli(["-C", repo, "drift", "--base", base]);
    const given = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      "HEAD",
    ]);
    expect(without.code).toBe(given.code);
    const parsedWithout = JSON.parse(without.stdout) as Record<string, unknown>;
    const parsedGiven = JSON.parse(given.stdout) as Record<string, unknown>;
    expect(parsedWithout.status).toBe("fail");
    expect(parsedWithout.head).toBe("HEAD");
    expect(parsedWithout.head_sha).toBe(head);
    expect(parsedWithout.counts).toEqual(parsedGiven.counts);
    // The `--summary` view runs the same way with `--head` absent.
    const summary = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--summary",
    ]);
    expect(summary.code).toBe(without.code);
    expect(summary.stdout).toContain("totals: status=fail");
  });

  it("a given --head wins over the HEAD default: a rev behind HEAD is the range that runs", async () => {
    const { repo, base, head } = buildSyntheticRepo();
    // A third commit on top: HEAD is now past the synthetic range's
    // head, so `--base base` alone measures a different (larger) range.
    fs.rmSync(path.join(repo, "notes2.md"));
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "later"], { cwd: repo });
    const atHead = await spawnCli(["-C", repo, "drift", "--base", base]);
    const atGiven = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
    ]);
    const parsedHead = JSON.parse(atHead.stdout) as Record<string, unknown>;
    const parsedGiven = JSON.parse(atGiven.stdout) as Record<string, unknown>;
    expect(parsedGiven.head).toBe(head);
    expect(parsedGiven.head_sha).toBe(head);
    expect(parsedHead.head).toBe("HEAD");
    expect(parsedHead.head_sha).not.toBe(head);
    // The counts differ between the two ranges: the given rev, not the
    // default, decided what ran.
    expect(parsedGiven.counts).not.toEqual(parsedHead.counts);
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

  it("drift --base main --head HEAD --summary on the PHP repro: removed=1 sites=2, exit 1", async () => {
    const { repo } = buildPhpReproRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      "main",
      "--head",
      "HEAD",
      "--summary",
    ]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      "README.md:2 | legacyName | doc | Call legacyName() to get the value.",
    );
    expect(run.stdout).toContain(
      "src/Foo.php:5 | legacyName | comment | * legacyName returns the legacy value.",
    );
    expect(run.stdout).toMatch(
      /totals: status=fail removed=1 sites=2 allowlisted=0 warnings=0 ignored=0/,
    );
  });

  it("drift --summary counts extractor-gap warnings in warnings= and prints one line each", async () => {
    const repo = initRepo();
    writeFile(repo, "tools.py", "def helperThing():\n    return 1\n");
    writeFile(repo, "run.sh", "run_thing() {\n  echo hi\n}\n");
    writeFile(repo, "README.md", "# Readme\n\nAll current here.\n");
    const base = commit(repo, "base");
    writeFile(repo, "tools.py", "# rewritten\n");
    writeFile(repo, "run.sh", "# rewritten\n");
    const head = commit(repo, "head");
    const run = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
      "--summary",
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      "warning: no declaration extractor for .py; removed identifiers from 1 files not collected",
    );
    expect(run.stdout).toContain(
      "warning: no declaration extractor for .sh; removed identifiers from 1 files not collected",
    );
    expect(run.stdout).toMatch(
      /totals: status=ok removed=0 sites=0 allowlisted=0 warnings=2 ignored=0/,
    );
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

// ---------------------------------------------------------------------
// A symbolic --base that moved after the branch point.
// ---------------------------------------------------------------------
describe("drift (symbolic base that moved after the branch point)", () => {
  /** A repo whose `origin/master` remote-tracking ref gained a declaration
   * after `feat` branched off; `feat` lives in a linked worktree and only
   * adds a note that mentions the name. */
  function buildMovedBaseFixture(): {
    worktree: string;
    branchPoint: string;
    movedTip: string;
  } {
    const parent = makeTmpDir();
    const bare = path.join(parent, "origin.git");
    const main = path.join(parent, "main");
    const worktree = path.join(parent, "wt");
    fs.mkdirSync(bare);
    git(bare, ["init", "-q", "--bare", "-b", "master"]);
    fs.mkdirSync(main);
    git(main, ["init", "-q", "-b", "master"]);
    git(main, ["config", "user.email", "test@example.com"]);
    git(main, ["config", "user.name", "test"]);
    git(main, ["config", "diff.noprefix", "false"]);
    git(main, ["config", "diff.mnemonicPrefix", "false"]);
    git(main, ["config", "core.autocrlf", "false"]);
    git(main, ["remote", "add", "origin", bare]);
    writeFile(main, "src/a.ts", "export function keep() {}\n");
    const branchPoint = commit(main, "base");
    git(main, ["push", "-q", "origin", "HEAD:master"]);
    git(main, ["fetch", "-q", "origin"]);
    git(main, [
      "worktree",
      "add",
      "-q",
      "-b",
      "feat",
      worktree,
      "origin/master",
    ]);
    writeFile(worktree, "notes.md", "see addedLater in these notes\n");
    commit(worktree, "feat");
    writeFile(
      main,
      "src/a.ts",
      "export function keep() {}\nexport function addedLater() {}\n",
    );
    const movedTip = commit(main, "master adds addedLater");
    git(main, ["push", "-q", "origin", "HEAD:master"]);
    git(main, ["fetch", "-q", "origin"]);
    return { worktree, branchPoint, movedTip };
  }

  it("reports the same result for the ref and for its merge-base SHA", async () => {
    const { worktree, branchPoint, movedTip } = buildMovedBaseFixture();
    const byRef = await drift({
      cwd: worktree,
      base: "origin/master",
      head: "HEAD",
    });
    const bySha = await drift({
      cwd: worktree,
      base: branchPoint,
      head: "HEAD",
    });
    expect(byRef.removedIdentifiers).toEqual([]);
    expect(byRef.sites).toEqual([]);
    expect(byRef.status).toBe("ok");
    expect(byRef.counts).toEqual(bySha.counts);
    expect(byRef.status).toBe(bySha.status);
    expect(byRef.baseSha).toBe(movedTip);
    expect(byRef.mergeBase).toBe(branchPoint);
    expect(bySha.baseSha).toBe(branchPoint);
    expect(bySha.mergeBase).toBe(branchPoint);
  });

  it("matches --base <SHA origin/master resolves to> with --base origin/master", async () => {
    const { worktree, movedTip } = buildMovedBaseFixture();
    const resolved = gitOutput(worktree, ["rev-parse", "origin/master"]).trim();
    expect(resolved).toBe(movedTip);
    const byRef = await drift({
      cwd: worktree,
      base: "origin/master",
      head: "HEAD",
    });
    const bySha = await drift({ cwd: worktree, base: resolved, head: "HEAD" });
    expect(bySha.removedIdentifiers).toEqual(byRef.removedIdentifiers);
    expect(bySha.sites).toEqual(byRef.sites);
    expect(bySha.counts).toEqual(byRef.counts);
    expect(bySha.mergeBase).toBe(byRef.mergeBase);
  });

  it("falls back to diffing the trees when base and head share no history", async () => {
    const repo = initRepo();
    git(repo, ["checkout", "-q", "-b", "main"]);
    writeFile(
      repo,
      "src/a.ts",
      "export function keep() {}\nexport function dropped() {}\n",
    );
    const baseSha = commit(repo, "base");
    git(repo, ["checkout", "-q", "--orphan", "orphan"]);
    git(repo, ["rm", "-rf", "-q", "."]);
    writeFile(repo, "src/a.ts", "export function keep() {}\n");
    writeFile(repo, "notes.md", "see dropped in these notes\n");
    const orphanSha = commit(repo, "orphan");
    const result = await drift({ cwd: repo, base: baseSha, head: "orphan" });
    expect(result.baseSha).toBe(baseSha);
    expect(result.headSha).toBe(orphanSha);
    expect(result.mergeBase).toBe(baseSha);
    expect(result.warnings).toContain(
      `no merge-base between ${baseSha} and ${orphanSha} (no common ancestor): diffing the two trees directly`,
    );
    expect(result.removedIdentifiers.map((r) => r.name)).toContain("dropped");
  });

  it("names a shallow clone as the likely cause when no merge-base is found", async () => {
    const parent = makeTmpDir();
    const origin = path.join(parent, "origin");
    const clone = path.join(parent, "clone");
    fs.mkdirSync(origin);
    git(origin, ["init", "-q", "-b", "master"]);
    git(origin, ["config", "user.email", "test@example.com"]);
    git(origin, ["config", "user.name", "test"]);
    writeFile(origin, "src/a.ts", "export function keep() {}\n");
    commit(origin, "one");
    git(origin, ["checkout", "-q", "-b", "feat"]);
    writeFile(origin, "src/b.ts", "export function other() {}\n");
    commit(origin, "two");
    git(origin, ["checkout", "-q", "master"]);
    writeFile(origin, "src/c.ts", "export function third() {}\n");
    commit(origin, "three");
    git(parent, [
      "clone",
      "-q",
      "--depth",
      "1",
      "--no-single-branch",
      `file://${origin}`,
      clone,
    ]);
    const result = await drift({
      cwd: clone,
      base: "origin/master",
      head: "origin/feat",
    });
    const warning = result.warnings.find((w) => w.includes("no merge-base"));
    expect(warning).toBeDefined();
    expect(warning).toContain("shallow clone");
  });

  it("names the resolved SHAs in the CLI envelope", async () => {
    const { worktree, branchPoint, movedTip } = buildMovedBaseFixture();
    const run = await spawnCli([
      "-C",
      worktree,
      "drift",
      "--base",
      "origin/master",
      "--head",
      "HEAD",
    ]);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(parsed.base).toBe("origin/master");
    expect(parsed.base_sha).toBe(movedTip);
    expect(parsed.merge_base).toBe(branchPoint);
    expect(parsed.head_sha).toBe(
      gitOutput(worktree, ["rev-parse", "HEAD"]).trim(),
    );
    expect(parsed.counts).toEqual({ removed: 0, sites: 0, allowlisted: 0 });
  });
});

describe("mergeBase: failure causes", () => {
  it("reports a git failure other than exit 1 as an error, not as no common ancestor", () => {
    const repo = fs.mkdtempSync(
      path.join(os.tmpdir(), "drift-merge-base-err-"),
    );
    try {
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      execFileSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.com",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "init",
        ],
        { cwd: repo },
      );
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
        .toString()
        .trim();
      const missing = "0123456789abcdef0123456789abcdef01234567";
      const r = mergeBase(repo, missing, head);
      if (!("reason" in r)) throw new Error(`expected a failure, got ${r.sha}`);
      expect(r.reason).toBe("error");
      expect(r.detail).toMatch(/^git exited \d+: /);
      expect(r.detail).not.toMatch(/^git exited 1: /);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------
// drift(): the local-binding rule (a removed indented, non-exported
// declaration whose name is still declared locally at head is not drift)
// and the `--ignore-identifier` / `--ignore-identifier-file` ignore.
// ---------------------------------------------------------------------

/** `[base, head]` content of `src/a.ts`: an indented, non-exported `const
 * <name>` inside `removedHolder`, and (when `headDeclares`) a second
 * function that keeps declaring the same name as a plain local. Head
 * removes the first function and leaves the rest untouched, so the name is
 * a removed identifier whose binding may well still exist. */
function localDeclPair(name: string, headDeclares: boolean): [string, string] {
  const keep = [
    "export function keep() {",
    `  const ${name} = new Error("kept");`,
    `  return ${name};`,
    "}",
  ];
  const base = [
    "export function removedHolder() {",
    `  const ${name} = new Error("x");`,
    `  return ${name};`,
    "}",
    ...(headDeclares ? keep : []),
    "",
  ].join("\n");
  const head = headDeclares
    ? `${keep.join("\n")}\n`
    : "export const placeholder = 1;\n";
  return [base, head];
}

/** A repo whose `src/a.ts` goes from `baseSource` to `headSource` and whose
 * `notes.md` names `identifier` as though it were still current (line 3). */
function buildRemovalRepo(
  identifier: string,
  baseSource: string,
  headSource: string,
): { repo: string; base: string; head: string } {
  const repo = initRepo();
  writeFile(repo, "src/a.ts", baseSource);
  writeFile(
    repo,
    "notes.md",
    `# Notes\n\n${identifier} is the helper this module uses.\n`,
  );
  const base = commit(repo, "base");
  writeFile(repo, "src/a.ts", headSource);
  const head = commit(repo, "head");
  return { repo, base, head };
}

describe("drift (local-binding rule)", () => {
  it("suppresses a removed indented local whose name is still declared locally at head, and shows it under --strict", async () => {
    for (const name of ["err", "now", "result", "event"]) {
      const [baseSource, headSource] = localDeclPair(name, true);
      const { repo, base, head } = buildRemovalRepo(
        name,
        baseSource,
        headSource,
      );

      const result = await drift({ cwd: repo, base, head });
      expect(result.sites).toEqual([]);
      expect(result.status).toBe("ok");
      expect(result.allowlisted).toEqual([
        {
          path: "notes.md",
          line: 3,
          identifier: name,
          kind: "doc",
          text: `${name} is the helper this module uses.`,
          allowlisted: true,
          allowlistReason: `local binding "${name}" still declared at head`,
        },
      ]);
      expect(result.counts).toEqual({ removed: 2, sites: 0, allowlisted: 1 });
      expect(result.ignoredIdentifiers).toContainEqual({
        name,
        source: "local-binding",
      });

      const strict = await drift({ cwd: repo, base, head, strict: true });
      expect(strict.sites).toHaveLength(1);
      expect(strict.sites[0]).toMatchObject({
        path: "notes.md",
        identifier: name,
        allowlisted: true,
        allowlistReason: `local binding "${name}" still declared at head`,
      });
      expect(strict.status).toBe("fail");
      expect(strict.ignoredIdentifiers).toContainEqual({
        name,
        source: "local-binding",
      });
    }
  });

  it("reports the same removed local when nothing declares the name at head", async () => {
    const [baseSource, headSource] = localDeclPair("err", false);
    const { repo, base, head } = buildRemovalRepo(
      "err",
      baseSource,
      headSource,
    );
    const result = await drift({ cwd: repo, base, head });
    expect(findSite(result.sites, "notes.md", 3)?.identifier).toBe("err");
    expect(result.status).toBe("fail");
    expect(result.allowlisted).toEqual([]);
    expect(result.ignoredIdentifiers).toEqual([]);
  });

  it("never lets the local-binding reason overwrite a glob or released-section reason, and still echoes the local binding", async () => {
    // The documented precedence: the local-binding rule is a default that
    // only speaks up when nothing else allowlisted the site, so its reason
    // never overwrites a CHANGELOG or glob reason on an ignored-shaped
    // name, while the name is echoed with source `local-binding` all the
    // same.
    const [baseSource, headSource] = localDeclPair("err", true);
    const { repo, base } = buildRemovalRepo("err", baseSource, headSource);
    writeFile(
      repo,
      "CHANGELOG.md",
      "# Changelog\n\n## 1.2.0\n\n- err is documented as the error type.\n",
    );
    const head = commit(repo, "released changelog entry");
    const strict = await drift({
      cwd: repo,
      base,
      head,
      allow: ["notes.md"],
      strict: true,
    });
    const globSite = findSite(strict.sites, "notes.md", 3);
    expect(globSite?.allowlistReason).toMatch(
      /matched --allow glob "notes\.md"/,
    );
    const sectionSite = findSite(strict.sites, "CHANGELOG.md", 5);
    expect(sectionSite?.allowlistReason).toMatch(
      /released changelog section "1\.2\.0"/,
    );
    expect(strict.ignoredIdentifiers).toContainEqual({
      name: "err",
      source: "local-binding",
    });
  });

  it("does not see a head-side declaration of a longer name sharing the prefix (the -w boundary)", async () => {
    // The word boundary `git grep -w` promises: a head-side `const errFoo`
    // is never a declaration of `err`, so the local-binding rule stays off
    // a name whose only head-side "declaration" is a longer identifier.
    const repo = initRepo();
    writeFile(
      repo,
      "src/a.ts",
      [
        "export function removedHolder() {",
        '  const err = new Error("x");',
        "  return err;",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(
      repo,
      "notes.md",
      "# Notes\n\nerr is the helper this module uses.\n",
    );
    const base = commit(repo, "base");
    writeFile(
      repo,
      "src/a.ts",
      [
        "export function keep() {",
        '  const errFoo = new Error("kept");',
        "  return errFoo;",
        "}",
        "",
      ].join("\n"),
    );
    const head = commit(repo, "head");
    const result = await drift({ cwd: repo, base, head });
    expect(findSite(result.sites, "notes.md", 3)?.identifier).toBe("err");
    expect(result.status).toBe("fail");
    expect(result.allowlisted).toEqual([]);
    expect(result.ignoredIdentifiers).toEqual([]);
  });

  it("does not count a comment-shaped head-side grep hit as a live declaration", async () => {
    // `git grep -w -E` matches any line CARRYING the declaration shape, so
    // a comment `// const stamp = old approach` greps as a hit; the
    // consumer filters it out, and the site is reported as usual.
    const repo = initRepo();
    writeFile(
      repo,
      "src/a.ts",
      [
        "export function removedHolder() {",
        "  const stamp = pick();",
        "  return stamp;",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(
      repo,
      "notes.md",
      "# Notes\n\nstamp is the helper this module uses.\n",
    );
    const base = commit(repo, "base");
    writeFile(
      repo,
      "src/a.ts",
      "// const stamp = old approach\nexport const placeholder = 1;\n",
    );
    const head = commit(repo, "head");
    const result = await drift({ cwd: repo, base, head });
    expect(findSite(result.sites, "notes.md", 3)?.identifier).toBe("stamp");
    expect(result.allowlisted).toEqual([]);
    expect(result.ignoredIdentifiers).toEqual([]);
  });

  it("does not count a head-side hit whose name is followed by a $ as a live declaration", async () => {
    // git's `-w` reads `$` as a non-word character, so `let retired$old`
    // greps as a `(let) retired` hit; the consumer's own trailing-character
    // check filters it out, and the site is reported as usual.
    const repo = initRepo();
    writeFile(
      repo,
      "src/a.ts",
      [
        "export function removedHolder() {",
        "  const retired = pick();",
        "  return retired;",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(
      repo,
      "notes.md",
      "# Notes\n\nretired is the helper this module uses.\n",
    );
    const base = commit(repo, "base");
    writeFile(
      repo,
      "src/a.ts",
      "let retired$old = 1;\nexport const placeholder = 1;\n",
    );
    const head = commit(repo, "head");
    const result = await drift({ cwd: repo, base, head });
    expect(findSite(result.sites, "notes.md", 3)?.identifier).toBe("retired");
    expect(result.allowlisted).toEqual([]);
    expect(result.ignoredIdentifiers).toEqual([]);
  });

  it("still counts a real head-side declaration as a live one (positive control)", async () => {
    const repo = initRepo();
    writeFile(
      repo,
      "src/a.ts",
      [
        "export function removedHolder() {",
        "  const retired = pick();",
        "  return retired;",
        "}",
        "",
      ].join("\n"),
    );
    // Untouched by the range (a re-added declaration in the range would
    // read as moved, not removed, and keep the rule off the name).
    writeFile(repo, "src/keep.ts", "const retired = 1;\n");
    writeFile(
      repo,
      "notes.md",
      "# Notes\n\nretired is the helper this module uses.\n",
    );
    const base = commit(repo, "base");
    writeFile(repo, "src/a.ts", "export const placeholder = 1;\n");
    const head = commit(repo, "head");
    const result = await drift({ cwd: repo, base, head });
    expect(findSite(result.sites, "notes.md", 3)).toBeUndefined();
    expect(findSite(result.allowlisted, "notes.md", 3)?.allowlistReason).toBe(
      'local binding "retired" still declared at head',
    );
    expect(result.ignoredIdentifiers).toContainEqual({
      name: "retired",
      source: "local-binding",
    });
  });

  it("does not touch an exported removed declaration even with a local of the name at head", async () => {
    const { repo, base, head } = buildRemovalRepo(
      "now",
      [
        "export const now = new Date();",
        "export function keep() {",
        "  const now = new Date();",
        "  return now;",
        "}",
        "",
      ].join("\n"),
      [
        "export function keep() {",
        "  const now = new Date();",
        "  return now;",
        "}",
        "",
      ].join("\n"),
    );
    const result = await drift({ cwd: repo, base, head });
    expect(result.removedIdentifiers).toContainEqual(
      expect.objectContaining({ name: "now", exported: true, indented: false }),
    );
    expect(findSite(result.sites, "notes.md", 3)?.identifier).toBe("now");
    expect(result.status).toBe("fail");
    expect(result.ignoredIdentifiers).toEqual([]);

    // An indented `export` (a declaration inside a module block) is still an
    // export: it is the exported fact, not the indentation, that keeps the
    // local-binding rule away, so this removal is reported too even though
    // the name survives as a plain local at head.
    const block = buildRemovalRepo(
      "now",
      [
        'declare module "legacy" {',
        "  export const now: () => Date;",
        "}",
        "export function keep() {",
        "  const now = new Date();",
        "  return now;",
        "}",
        "",
      ].join("\n"),
      [
        'declare module "legacy" {',
        "}",
        "export function keep() {",
        "  const now = new Date();",
        "  return now;",
        "}",
        "",
      ].join("\n"),
    );
    const blocked = await drift({
      cwd: block.repo,
      base: block.base,
      head: block.head,
    });
    expect(blocked.removedIdentifiers).toContainEqual(
      expect.objectContaining({ name: "now", exported: true, indented: true }),
    );
    expect(findSite(blocked.sites, "notes.md", 3)?.identifier).toBe("now");
    expect(blocked.status).toBe("fail");
    expect(blocked.ignoredIdentifiers).toEqual([]);
  });

  it("does not touch a column-0 non-exported declaration", async () => {
    const { repo, base, head } = buildRemovalRepo(
      "result",
      [
        "const result = compute();",
        "export function keep() {",
        "  const result = compute();",
        "  return result;",
        "}",
        "",
      ].join("\n"),
      [
        "export function keep() {",
        "  const result = compute();",
        "  return result;",
        "}",
        "",
      ].join("\n"),
    );
    const result = await drift({ cwd: repo, base, head });
    expect(result.removedIdentifiers).toContainEqual(
      expect.objectContaining({
        name: "result",
        exported: false,
        indented: false,
      }),
    );
    expect(findSite(result.sites, "notes.md", 3)?.identifier).toBe("result");
    expect(result.status).toBe("fail");
    expect(result.ignoredIdentifiers).toEqual([]);
  });

  it("leaves a removed config key alone", async () => {
    const repo = initRepo();
    writeFile(repo, "config.json", '{\n  "featureFlag": true\n}\n');
    // Untouched by the range, and a head-side declaration shape of the very
    // name: only the candidate's kind keeps the local-binding rule off this
    // removal, so a config key whose key file simply changed is still drift.
    writeFile(repo, "src/keep.ts", "export const featureFlag = 1;\n");
    writeFile(
      repo,
      "notes.md",
      "# Notes\n\nfeatureFlag controls the beta UI.\n",
    );
    const base = commit(repo, "base");
    writeFile(repo, "config.json", '{\n  "otherFlag": true\n}\n');
    const head = commit(repo, "head");
    const result = await drift({ cwd: repo, base, head });
    expect(result.removedIdentifiers).toContainEqual(
      expect.objectContaining({
        name: "featureFlag",
        kind: "config_key",
        indented: true,
      }),
    );
    expect(findSite(result.sites, "notes.md", 3)?.identifier).toBe(
      "featureFlag",
    );
    expect(result.status).toBe("fail");
    expect(result.ignoredIdentifiers).toEqual([]);
  });

  it("still reports the three true-positive shapes over a local-binding-shaped removal", async () => {
    // A dated log entry that describes a removed name as current.
    const log = buildRemovalRepo(
      "OldParser",
      "export const OldParser = 1;\n",
      "export const NewParser = 1;\n",
    );
    writeFile(
      log.repo,
      "CHANGELOG.md",
      "# Changelog\n\n## [Unreleased]\n\n- 2024-05-01: OldParser handles the front matter\n",
    );
    const amended = commit(log.repo, "log entry");
    const logResult = await drift({
      cwd: log.repo,
      base: log.base,
      head: amended,
    });
    expect(findSite(logResult.sites, "CHANGELOG.md", 5)?.identifier).toBe(
      "OldParser",
    );

    // A relocated exported helper whose old comment still names the old name.
    const relocated = buildRemovalRepo(
      "formatThing",
      "export function formatThing() {}\n",
      "export function formatThingV2() {}\n",
    );
    writeFile(
      relocated.repo,
      "src/caller.ts",
      "// calls formatThing with the raw value\nexport const x = 1;\n",
    );
    const relocatedHead = commit(relocated.repo, "caller comment");
    const relocatedResult = await drift({
      cwd: relocated.repo,
      base: relocated.base,
      head: relocatedHead,
    });
    expect(
      findSite(relocatedResult.sites, "src/caller.ts", 1)?.identifier,
    ).toBe("formatThing");

    // A comment naming a removed regex constant.
    const regex = buildRemovalRepo(
      "DATE_RE",
      "const DATE_RE = /\\d{4}/;\n",
      "export const placeholder = 1;\n",
    );
    writeFile(
      regex.repo,
      "src/match.ts",
      "// DATE_RE matches the header date\nexport const y = 1;\n",
    );
    const regexHead = commit(regex.repo, "matcher comment");
    const regexResult = await drift({
      cwd: regex.repo,
      base: regex.base,
      head: regexHead,
    });
    expect(findSite(regexResult.sites, "src/match.ts", 1)?.identifier).toBe(
      "DATE_RE",
    );
    expect(regexResult.ignoredIdentifiers).toEqual([]);
  });

  // The head-side filter, enumerated. Every row is one head-side file whose
  // only occurrence of `err` is `headLine`, against a base that removed an
  // indented declaration of `err`; `reported` keeps the doc site,
  // `suppressed` allowlists it as a local binding. Rows are derived from
  // `isLiveHeadDeclaration` (each comment prefix, each trailing character
  // class, each declaration keyword, the "no character after the name"
  // case, the keyword anchor and its modifiers, and the case-insensitive
  // judgment for a `.php` hit) and from the `-w` of
  // `headDeclarationGrep` (the boundary BEFORE the keyword). `rejectedBy:
  // "grep"` marks a row only the grep flag can reject: the filter alone
  // would accept its text, so the direct filter table skips it. A row whose
  // `file` ends in `.php` is judged case-insensitively by the filter alone
  // (it is what the `.php`-only case-insensitive grep passes to it).
  interface HeadLineRow {
    label: string;
    headLine: string;
    file?: string;
    keyword?: string;
    /** Overrides the default base-side declaration of `err` for this
     * row's keyword - needed where that keyword is not one the TS/JS
     * extractor reads (PHP's `trait`), so the removal candidate still
     * extracts. */
    baseDecl?: string;
    prefix?: string;
    trailing?: string;
    rejectedBy?: "grep";
    expect: "reported" | "suppressed";
  }

  const HEAD_LINE_ROWS: readonly HeadLineRow[] = [
    // comment prefixes: the text before the keyword, trimmed
    {
      label: "// comment",
      headLine: "  // const err = 1",
      prefix: "//",
      expect: "reported",
    },
    {
      label: "/* comment",
      headLine: "  /* const err = 1 */",
      prefix: "/*",
      expect: "reported",
    },
    {
      label: "* continuation",
      headLine: " * const err = 1",
      prefix: "*",
      expect: "reported",
    },
    {
      label: "# comment (.py)",
      headLine: "  # const err = 1",
      file: "src/b.py",
      prefix: "#",
      expect: "reported",
    },
    {
      label: "comment with text before the keyword",
      headLine: "  // note: const err = 1",
      prefix: "//",
      expect: "reported",
    },
    // trailing character: one per class of the name-continuation character
    {
      label: "trailing letter",
      headLine: "  const errFoo = 1",
      trailing: "F",
      expect: "reported",
    },
    {
      label: "trailing $",
      headLine: "  const err$ = 1",
      trailing: "$",
      expect: "reported",
    },
    {
      label: "trailing _",
      headLine: "  const err_1 = 1",
      trailing: "_",
      expect: "reported",
    },
    {
      label: "trailing digit",
      headLine: "  const err2 = 1",
      trailing: "2",
      expect: "reported",
    },
    // the boundary BEFORE the keyword is git grep -w's
    {
      label: "keyword inside a longer word (string)",
      headLine: 'export const label = "superclass err";',
      rejectedBy: "grep",
      expect: "reported",
    },
    {
      label: "keyword inside a longer word (const)",
      headLine: '  const x = "myconst err";',
      rejectedBy: "grep",
      expect: "reported",
    },
    // one per keyword
    {
      label: "const",
      headLine: "  const err = 1",
      keyword: "const",
      expect: "suppressed",
    },
    {
      label: "let",
      headLine: "  let err = 1",
      keyword: "let",
      expect: "suppressed",
    },
    {
      label: "var",
      headLine: "  var err = 1",
      keyword: "var",
      expect: "suppressed",
    },
    {
      label: "function",
      headLine: "  function err() {}",
      keyword: "function",
      expect: "suppressed",
    },
    {
      label: "class",
      headLine: "  class err {}",
      keyword: "class",
      expect: "suppressed",
    },
    // the keywords DECLARATION_KEYWORDS gained alongside PHP's: a head-side
    // `type`, `interface` or `enum` declaration suppresses too, and `trait`
    // (PHP's keyword, matched as a shape only) suppresses a TS removal
    {
      label: "type",
      headLine: "  type err = string;",
      keyword: "type",
      expect: "suppressed",
    },
    {
      label: "interface",
      headLine: "  interface err { x: 1 }",
      keyword: "interface",
      expect: "suppressed",
    },
    {
      label: "enum",
      headLine: "  enum err { A }",
      keyword: "enum",
      expect: "suppressed",
    },
    {
      label: "trait (base-side removal via a TS keyword)",
      headLine: "  trait err;",
      keyword: "trait",
      baseDecl: "  interface err {}",
      expect: "suppressed",
    },
    // the character after the name: absent, or outside the continuation class
    {
      label: "type annotation after the name",
      headLine: "  const err: number = 1",
      expect: "suppressed",
    },
    {
      label: "no space around =",
      headLine: "  const err=1",
      expect: "suppressed",
    },
    {
      label: "name ends the line",
      headLine: "  const err",
      expect: "suppressed",
    },
    // the scan goes past a rejected occurrence; the anchor then accepts the
    // second one, which stands after a statement boundary
    {
      label: "longer name first, second occurrence after a semicolon",
      headLine: "  const errFoo = 1; const err = 2;",
      expect: "suppressed",
    },
    // the keyword anchor: only whitespace and modifiers, or an opener, may
    // stand before the keyword, so a keyword behind other code or inside a
    // string never counts
    {
      label: "comment that does not start the line (anchor)",
      headLine: "  const x = 1; // const err = 1",
      expect: "reported",
    },
    {
      label: "shape inside a string (anchor)",
      headLine: '  const s = "const err";',
      expect: "reported",
    },
    {
      label: "type inside a string literal (anchor)",
      headLine: '  throw new Error("unexpected type err payload");',
      keyword: "type",
      expect: "reported",
    },
    {
      label: "open single-quote string before the keyword (parity)",
      headLine: "  label = 'unexpected const err",
      expect: "reported",
    },
    {
      label: "opener inside an open single-quoted string (parity)",
      headLine: "  x = 'a; const err = 1",
      expect: "reported",
    },
    {
      label: "opener inside an open template literal (parity)",
      headLine: "  x = `a; const err = 1",
      expect: "reported",
    },
    {
      label: "opener inside an open double-quoted string (parity)",
      headLine: '  x = "a; const err = 1',
      expect: "reported",
    },
    {
      label: "escaped quote inside a closed string (escape stripping)",
      headLine: '  const q = "a\\"b"; const err = 1;',
      expect: "suppressed",
    },
    {
      label: "escaped backslash before the closing quote (escape stripping)",
      headLine: '  const p = "C:\\\\"; const err = 1;',
      expect: "suppressed",
    },
    {
      label: "escaped apostrophe in a single-quoted string (escape stripping)",
      headLine: "  const s = 'it\\'s'; const err = 1;",
      expect: "suppressed",
    },
    {
      label: "prose string whose own colon would anchor it (parity)",
      headLine: '  throw new Error("bad value: const err is missing");',
      expect: "reported",
    },
    {
      label: "mid-line comment after a rejected longer name (anchor)",
      headLine: "  const errFoo = 1; // const err = 2;",
      expect: "reported",
    },
    // ...and an opener before the keyword keeps it anchored too: a loop
    // head, a block body, an arrow body, a statement after a `;`, a `case`
    // label
    {
      label: "for-of loop head (opener)",
      headLine: "  for (const err of counts) {}",
      expect: "suppressed",
    },
    {
      label: "block body (opener)",
      headLine: "  if (counts) { const err = 1; }",
      expect: "suppressed",
    },
    {
      label: "arrow body (opener)",
      headLine: "  const f = () => { const err = 1; };",
      expect: "suppressed",
    },
    {
      label: "statement after a semicolon, quotes balanced (opener)",
      headLine: '  x = "a"; const err = 1;',
      expect: "suppressed",
    },
    {
      label: "case label (opener)",
      headLine: "  case 1: const err = 1;",
      expect: "suppressed",
    },
    // ...and a modifier standing before the keyword keeps it anchored
    {
      label: "export type (modifier before the keyword)",
      headLine: "  export type err = string;",
      keyword: "type",
      expect: "suppressed",
    },
    {
      label: "async function (modifier the extraction regex also accepts)",
      headLine: "  async function err() {}",
      keyword: "function",
      expect: "suppressed",
    },
    // the `.php`-only case-insensitive head grep: PHP keywords are
    // case-insensitive, so the filter must match them case-insensitively
    {
      label: "case-variant PHP keyword (.php)",
      headLine: "    PRIVATE FUNCTION err() {}",
      file: "src/b.php",
      expect: "suppressed",
    },
  ];

  it("pins the table to the prefixes, keywords and trailing characters the source checks", () => {
    expect(
      new Set(HEAD_LINE_ROWS.flatMap((r) => (r.prefix ? [r.prefix] : []))),
    ).toEqual(new Set(LOCAL_BINDING_COMMENT_PREFIXES));
    expect(
      new Set(HEAD_LINE_ROWS.flatMap((r) => (r.keyword ? [r.keyword] : []))),
    ).toEqual(new Set(DECLARATION_KEYWORDS));
    expect(NAME_CONTINUATION_CHARACTER.source).toBe("[A-Za-z0-9_$]");
    const classes = new Set(
      HEAD_LINE_ROWS.flatMap((r) => (r.trailing ? [r.trailing] : [])),
    );
    for (const sample of ["F", "$", "_", "2"])
      expect(classes).toContain(sample);
    for (const row of HEAD_LINE_ROWS) {
      if (row.trailing) {
        expect(NAME_CONTINUATION_CHARACTER.test(row.trailing)).toBe(true);
      }
    }
  });

  it.each(HEAD_LINE_ROWS)(
    "head line `$headLine` is $expect ($label)",
    async (row) => {
      const keyword = row.keyword ?? "const";
      const baseDecl =
        row.baseDecl ??
        (keyword === "function"
          ? "  function err() {}"
          : keyword === "class"
            ? "  class err {}"
            : `  ${keyword} err = new Error("x");`);
      const repo = initRepo();
      writeFile(
        repo,
        "src/a.ts",
        ["export function removedHolder() {", baseDecl, "}", ""].join("\n"),
      );
      writeFile(
        repo,
        "notes.md",
        "# Notes\n\nerr is the helper this module uses.\n",
      );
      // The head-side file exists unchanged on both sides, so its line is
      // never an added declaration (which would make `err` a moved name).
      writeFile(repo, row.file ?? "src/b.ts", `${row.headLine}\n`);
      const base = commit(repo, "base");
      writeFile(repo, "src/a.ts", "export const placeholder = 1;\n");
      const head = commit(repo, "head");

      const result = await drift({ cwd: repo, base, head });
      const localBinding = {
        name: "err",
        source: "local-binding",
      } as const;
      if (row.expect === "reported") {
        expect(findSite(result.sites, "notes.md", 3)?.identifier).toBe("err");
        expect(result.ignoredIdentifiers).not.toContainEqual(localBinding);
        expect(result.allowlisted.filter((s) => s.path === "notes.md")).toEqual(
          [],
        );
      } else {
        expect(result.sites.filter((s) => s.path === "notes.md")).toEqual([]);
        expect(findSite(result.allowlisted, "notes.md", 3)).toMatchObject({
          identifier: "err",
          allowlisted: true,
          allowlistReason: 'local binding "err" still declared at head',
        });
        expect(result.ignoredIdentifiers).toContainEqual(localBinding);
      }
    },
  );

  it.each(HEAD_LINE_ROWS.filter((r) => r.rejectedBy !== "grep"))(
    "the head-line filter alone judges `$headLine` $expect ($label)",
    (row) => {
      // A `.php` hit reaches the filter through the `.php`-only
      // case-insensitive grep, which is what its third argument says.
      expect(
        isLiveHeadDeclaration(
          row.headLine,
          "err",
          (row.file ?? "").endsWith(".php"),
        ),
      ).toBe(row.expect === "suppressed");
    },
  );

  // The anchor alone, on the text before a keyword occurrence: quote
  // parity, then either only whitespace and modifiers or a trailing
  // opener. `opener` is the opener the row is the test for; the table must
  // cover every entry of HEAD_KEYWORD_OPENERS.
  interface AnchoredBeforeRow {
    label: string;
    before: string;
    opener?: string;
    expect: boolean;
  }

  const ANCHORED_BEFORE_ROWS: readonly AnchoredBeforeRow[] = [
    { label: "indentation only", before: "  ", expect: true },
    {
      label: "PHP modifiers",
      before: "    private static ",
      expect: true,
    },
    {
      label: "async (the modifier the extraction regex accepts)",
      before: "  async ",
      expect: true,
    },
    {
      label: "TS modifiers",
      before: "  export default ",
      expect: true,
    },
    {
      label: "after a loop head's paren",
      before: "  for (",
      opener: "(",
      expect: true,
    },
    {
      label: "after a block's brace",
      before: "  if (counts) { ",
      opener: "{",
      expect: true,
    },
    {
      label: "after an arrow",
      before: "  const f = () => ",
      opener: "=>",
      expect: true,
    },
    {
      label: "after a semicolon, quotes balanced",
      before: '  x = "a"; ',
      opener: ";",
      expect: true,
    },
    {
      label: "after a case label's colon",
      before: "  case 1: ",
      opener: ":",
      expect: true,
    },
    { label: "a word before it", before: "  throw ", expect: false },
    { label: "an assignment", before: "  x = ", expect: false },
    { label: "a line-start comment", before: "  // ", expect: false },
    {
      label: "a mid-line comment",
      before: "  const x = 1; // ",
      expect: false,
    },
    {
      label: "an unterminated double-quoted string",
      before: '  throw new Error("unexpected ',
      expect: false,
    },
    {
      label: "an unterminated single-quoted string",
      before: "  label = '",
      expect: false,
    },
    {
      label: "an unterminated template literal",
      before: "  const t = `unclosed ",
      expect: false,
    },
    {
      label: "an opener inside an unterminated single-quoted string",
      before: "  x = 'a; ",
      expect: false,
    },
    {
      label: "an opener inside an unterminated template literal",
      before: "  x = `a; ",
      expect: false,
    },
    {
      label: "an opener inside an unterminated double-quoted string",
      before: '  x = "a; ',
      expect: false,
    },
    {
      label: "an escaped quote does not count toward parity",
      before: '  const q = "a\\"b"; ',
      expect: true,
    },
    {
      label: "an escaped backslash before the closing quote",
      before: '  const p = "C:\\\\"; ',
      expect: true,
    },
    {
      label: "an escaped apostrophe in a single-quoted string",
      before: "  const s = 'it\\'s'; ",
      expect: true,
    },
    {
      label: "an opener standing inside an unterminated string",
      before: '  throw new Error("bad value: ',
      expect: false,
    },
  ];

  it("covers every opener the anchor accepts", () => {
    const tested = new Set(
      ANCHORED_BEFORE_ROWS.flatMap((r) => (r.opener ? [r.opener] : [])),
    );
    expect(tested).toEqual(new Set(HEAD_KEYWORD_OPENERS));
    expect(HEAD_KEYWORD_MODIFIERS).toContain("async");
  });

  it.each(ANCHORED_BEFORE_ROWS)(
    "the anchor $expect the text before a keyword in `$before` ($label)",
    (row) => {
      expect(isAnchoredBefore(row.before)).toBe(row.expect);
    },
  );
});

describe("drift (head-side binding grep languages)", () => {
  function rowCountRepo(headFile: string, headLine: string) {
    const repo = initRepo();
    writeFile(
      repo,
      "src/a.ts",
      [
        "export function removedHolder() {",
        "  const rowCount = 1;",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(
      repo,
      "notes.md",
      "# Notes\n\nrowCount is the count this module shows.\n",
    );
    // The head-side file exists unchanged on both sides, so its line is
    // never an added declaration (which would make `rowCount` a moved name).
    writeFile(repo, headFile, `${headLine}\n`);
    const base = commit(repo, "base");
    writeFile(repo, "src/a.ts", "export const placeholder = 1;\n");
    const head = commit(repo, "head");
    return { repo, base, head };
  }

  it("a head-side config.yml line `key: type <name>` does not suppress a stale site", async () => {
    const { repo, base, head } = rowCountRepo(
      "config.yml",
      "summary: type rowCount is shown",
    );
    const result = await drift({ cwd: repo, base, head });
    expect(result.status).toBe("fail");
    expect(result.sites.filter((s) => s.path === "notes.md")).toHaveLength(1);
    expect(result.ignoredIdentifiers).not.toContainEqual({
      name: "rowCount",
      source: "local-binding",
    });
  });

  it("the same name declared in a head .ts file suppresses (control)", async () => {
    const { repo, base, head } = rowCountRepo(
      "src/b.ts",
      "  const rowCount = 2;",
    );
    const result = await drift({ cwd: repo, base, head });
    expect(result.sites.filter((s) => s.path === "notes.md")).toEqual([]);
    expect(result.ignoredIdentifiers).toContainEqual({
      name: "rowCount",
      source: "local-binding",
    });
  });

  it("HEAD_SOURCE_PATHSPECS holds the TS/JS and PHP pathspecs only", () => {
    expect([...HEAD_SOURCE_PATHSPECS].sort()).toEqual(
      ["*.cjs", "*.js", "*.jsx", "*.mjs", "*.php", "*.ts", "*.tsx"].sort(),
    );
    for (const spec of ["*.yml", "*.yaml", "*.sh", "*.py", "*.json", "*.md"]) {
      expect(HEAD_SOURCE_PATHSPECS).not.toContain(spec);
    }
  });
});

describe("drift (ignored identifiers)", () => {
  function oldThingRepo(): { repo: string; base: string; head: string } {
    return buildRemovalRepo(
      "OldThing",
      "export const OldThing = 1;\n",
      "export const NewThing = 1;\n",
    );
  }

  it("allowlists an ignored identifier's sites by default and shows them under --strict", async () => {
    const { repo, base, head } = oldThingRepo();
    const result = await drift({
      cwd: repo,
      base,
      head,
      ignoreIdentifiers: [{ name: "OldThing", source: "flag" }],
    });
    expect(result.sites).toEqual([]);
    expect(result.status).toBe("ok");
    expect(result.allowlisted).toEqual([
      {
        path: "notes.md",
        line: 3,
        identifier: "OldThing",
        kind: "doc",
        text: "OldThing is the helper this module uses.",
        allowlisted: true,
        allowlistReason: 'ignored identifier "OldThing"',
      },
    ]);
    expect(result.counts).toEqual({ removed: 1, sites: 0, allowlisted: 1 });
    expect(result.ignoredIdentifiers).toEqual([
      { name: "OldThing", source: "flag" },
    ]);

    const strict = await drift({
      cwd: repo,
      base,
      head,
      strict: true,
      ignoreIdentifiers: [{ name: "OldThing", source: "flag" }],
    });
    expect(strict.sites).toHaveLength(1);
    expect(strict.sites[0]).toMatchObject({
      allowlisted: true,
      allowlistReason: 'ignored identifier "OldThing"',
    });
    expect(strict.status).toBe("fail");
  });

  it("echoes an ignored name that produced no site, and keeps the reported ones", async () => {
    const { repo, base, head } = oldThingRepo();
    const result = await drift({
      cwd: repo,
      base,
      head,
      ignoreIdentifiers: [
        { name: "nothing-like-this", source: "file" },
        { name: "OldThing", source: "file" },
      ],
    });
    expect(result.ignoredIdentifiers).toEqual([
      { name: "nothing-like-this", source: "file" },
      { name: "OldThing", source: "file" },
    ]);
    expect(result.sites).toEqual([]);
    expect(result.status).toBe("ok");
  });

  it("outranks the path-shaped reasons for an ignored name", async () => {
    const { repo, base, head } = oldThingRepo();
    const result = await drift({
      cwd: repo,
      base,
      head,
      allow: ["notes.md"],
      ignoreIdentifiers: [{ name: "OldThing", source: "flag" }],
    });
    expect(result.allowlisted[0]?.allowlistReason).toBe(
      'ignored identifier "OldThing"',
    );
  });

  it("rejects an empty identifier name", async () => {
    const { repo, base, head } = oldThingRepo();
    await expect(
      drift({
        cwd: repo,
        base,
        head,
        ignoreIdentifiers: [{ name: "   ", source: "flag" }],
      }),
    ).rejects.toThrow(/--ignore-identifier needs an identifier name/);
  });
});

describe("drift ignored identifiers CLI", () => {
  function oldThingRepo(): { repo: string; base: string; head: string } {
    return buildRemovalRepo(
      "OldThing",
      "export const OldThing = 1;\n",
      "export const NewThing = 1;\n",
    );
  }

  it("reads --ignore-identifier-file, blank and # lines ignored, resolved against -C", async () => {
    const { repo, base, head } = oldThingRepo();
    writeFile(repo, "ignore.txt", "# names this task keeps\n\nOldThing\n");
    const run = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
      "--ignore-identifier-file",
      "ignore.txt",
    ]);
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout) as {
      ignored_identifiers: { name: string; source: string }[];
      allowlisted: { allowlistReason: string }[];
      counts: { allowlisted: number };
    };
    expect(out.ignored_identifiers).toEqual([
      { name: "OldThing", source: "file" },
    ]);
    expect(out.allowlisted[0]?.allowlistReason).toBe(
      'ignored identifier "OldThing"',
    );
    expect(out.counts.allowlisted).toBe(1);
  });

  it("takes both forms, echoes each name once, and a missing file is a usage error", async () => {
    const { repo, base, head } = oldThingRepo();
    writeFile(repo, "ignore.txt", "OldThing\nlegacyName\n");
    const run = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
      "--ignore-identifier",
      "OldThing",
      "--ignore-identifier",
      "flagOnly",
      "--ignore-identifier-file",
      "ignore.txt",
    ]);
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout) as {
      ignored_identifiers: { name: string; source: string }[];
    };
    // A name given by both forms is echoed once, with the source it
    // arrived on first: the flags, which the CLI passes before the file.
    expect(out.ignored_identifiers).toEqual([
      { name: "OldThing", source: "flag" },
      { name: "flagOnly", source: "flag" },
      { name: "legacyName", source: "file" },
    ]);
    const missing = await spawnCli([
      "-C",
      repo,
      "drift",
      "--base",
      base,
      "--head",
      head,
      "--ignore-identifier-file",
      "no-such-file.txt",
    ]);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stdout).status).toBe("usage_error");
  });
});

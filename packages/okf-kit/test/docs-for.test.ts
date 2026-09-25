import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../src/errors.js";
import { runDocsFor } from "../src/docs-for.js";
import type { RunGit } from "../src/types.js";
import { FIXTURES_DIR } from "./helpers.js";
import { writeDoc } from "./git-helpers.js";

const REPO_ROOT = path.join(FIXTURES_DIR, "docs-for-bundle");
const BUNDLE_DIR = path.join(REPO_ROOT, "docs");

describe("runDocsFor", () => {
  it("matches a doc whose sources list the exact given path", () => {
    const result = runDocsFor(BUNDLE_DIR, ["src/foo.ts"], {
      repoRoot: REPO_ROOT,
    });
    expect(result.matches).toEqual([
      { doc: "exact.md", sources: ["src/foo.ts"] },
      { doc: "multi.md", sources: ["src/foo.ts"] },
    ]);
  });

  it("matches a doc via a directory source containing the given path", () => {
    const result = runDocsFor(BUNDLE_DIR, ["src/dir/nested.ts"], {
      repoRoot: REPO_ROOT,
    });
    expect(result.matches).toEqual([
      { doc: "dirsrc.md", sources: ["src/dir"] },
      { doc: "multi.md", sources: ["src/dir"] },
    ]);
  });

  it("matches a doc via a directory source containing a deeply nested given path", () => {
    const result = runDocsFor(BUNDLE_DIR, ["src/dir/deep/deeper.ts"], {
      repoRoot: REPO_ROOT,
    });
    expect(result.matches.map((m) => m.doc)).toEqual(["dirsrc.md", "multi.md"]);
  });

  it("does not match a directory source against itself only by prefix-string coincidence", () => {
    // src/dir vs src/dir2.ts: a naive string-prefix check ("src/dir/nested.ts".startsWith("src/dir"))
    // would wrongly match "src/dir2.ts" too; path.relative-based containment must not.
    const result = runDocsFor(BUNDLE_DIR, ["src/dir2.ts"], {
      repoRoot: REPO_ROOT,
    });
    expect(result.matches).toEqual([]);
  });

  it("returns an empty match list, no error, when no doc claims the given path", () => {
    const result = runDocsFor(BUNDLE_DIR, ["src/nope.ts"], {
      repoRoot: REPO_ROOT,
    });
    expect(result.matches).toEqual([]);
  });

  it("deduplicates and sorts matched sources per doc, and sorts docs", () => {
    const result = runDocsFor(BUNDLE_DIR, ["src/foo.ts", "src/dir/nested.ts"], {
      repoRoot: REPO_ROOT,
    });
    expect(result.matches).toEqual([
      { doc: "dirsrc.md", sources: ["src/dir"] },
      { doc: "exact.md", sources: ["src/foo.ts"] },
      { doc: "multi.md", sources: ["src/dir", "src/foo.ts"] },
    ]);
  });

  it("throws a UsageError for an unknown bundle dir", () => {
    expect(() =>
      runDocsFor(path.join(FIXTURES_DIR, "does-not-exist"), ["src/foo.ts"], {
        repoRoot: REPO_ROOT,
      }),
    ).toThrow(UsageError);
  });

  it("throws a UsageError when no paths are given", () => {
    expect(() => runDocsFor(BUNDLE_DIR, [], { repoRoot: REPO_ROOT })).toThrow(
      UsageError,
    );
  });

  it("throws a UsageError when no repo root can be determined", () => {
    expect(() =>
      runDocsFor(BUNDLE_DIR, ["src/foo.ts"], {
        repoRoot: undefined,
        runGit: () => null,
      }),
    ).toThrow(UsageError);
  });
});

// Normalization pinning (round 2): a temp bundle per test, so each case can
// pick the exact `sources` spelling and given-path spelling under test
// without disturbing the static docs-for-bundle fixture's own assertions.
describe("runDocsFor path normalization", () => {
  let bundleDir: string;
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-docsfor-root-"));
    bundleDir = path.join(repoRoot, "docs");
    fs.mkdirSync(bundleDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("resolves a leading-slash sources entry as repo-relative, exactly as check does", () => {
    // check's sources-shape resolves a sources entry with path.join, which
    // treats a leading slash as repo-relative, not filesystem-absolute.
    // docs-for must agree, or the same frontmatter spelling would pass
    // `check` while never matching `docs-for`.
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "foo.ts"), "export {};\n");
    writeDoc(bundleDir, "leading-slash.md", {
      type: "concept",
      sources: ["/src/foo.ts"],
    });

    const result = runDocsFor(bundleDir, ["src/foo.ts"], { repoRoot });
    expect(result.matches).toEqual([
      { doc: "leading-slash.md", sources: ["/src/foo.ts"] },
    ]);
  });

  it("normalizes a ./-prefixed given path the same as its plain spelling", () => {
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "foo.ts"), "export {};\n");
    writeDoc(bundleDir, "exact.md", {
      type: "concept",
      sources: ["src/foo.ts"],
    });

    const result = runDocsFor(bundleDir, ["./src/foo.ts"], { repoRoot });
    expect(result.matches).toEqual([
      { doc: "exact.md", sources: ["src/foo.ts"] },
    ]);
  });

  it("normalizes a trailing slash on a given path the same as its plain spelling", () => {
    fs.mkdirSync(path.join(repoRoot, "src", "dir"), { recursive: true });
    writeDoc(bundleDir, "dirsrc.md", { type: "concept", sources: ["src/dir"] });

    const result = runDocsFor(bundleDir, ["src/dir/"], { repoRoot });
    expect(result.matches).toEqual([
      { doc: "dirsrc.md", sources: ["src/dir"] },
    ]);
  });

  it("normalizes a trailing slash on a directory sources entry, containment still matches", () => {
    fs.mkdirSync(path.join(repoRoot, "src", "dir"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "src", "dir", "nested.ts"),
      "export {};\n",
    );
    writeDoc(bundleDir, "dirsrc.md", {
      type: "concept",
      sources: ["src/dir/"],
    });

    const result = runDocsFor(bundleDir, ["src/dir/nested.ts"], { repoRoot });
    expect(result.matches).toEqual([
      { doc: "dirsrc.md", sources: ["src/dir/"] },
    ]);
  });

  it("does not match a path underneath a directory-shaped sources entry that does not exist on disk", () => {
    // A missing sources entry (already flagged by sources-shape) can only
    // match by exact string equality, never by directory containment --
    // there is nothing to fs.statSync to know it is a directory at all.
    writeDoc(bundleDir, "missing.md", {
      type: "concept",
      sources: ["src/missingdir"],
    });

    const result = runDocsFor(bundleDir, ["src/missingdir/foo.ts"], {
      repoRoot,
    });
    expect(result.matches).toEqual([]);
  });

  it("matches a child path whose own name starts with ..", () => {
    // isWithinDirectory used to reject any relative path starting with
    // "..", including a legitimate child file literally named "..b.ts".
    fs.mkdirSync(path.join(repoRoot, "src", "dir"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "src", "dir", "..b.ts"),
      "export {};\n",
    );
    writeDoc(bundleDir, "dirsrc.md", { type: "concept", sources: ["src/dir"] });

    const result = runDocsFor(bundleDir, ["src/dir/..b.ts"], { repoRoot });
    expect(result.matches).toEqual([
      { doc: "dirsrc.md", sources: ["src/dir"] },
    ]);
  });

  it("accepts an absolute given path that lies under repoRoot, relativizing it before matching", () => {
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "foo.ts"), "export {};\n");
    writeDoc(bundleDir, "exact.md", {
      type: "concept",
      sources: ["src/foo.ts"],
    });

    const result = runDocsFor(
      bundleDir,
      [path.join(repoRoot, "src", "foo.ts")],
      { repoRoot },
    );
    expect(result.matches).toEqual([
      { doc: "exact.md", sources: ["src/foo.ts"] },
    ]);
  });

  it("rejects an absolute given path that lies outside repoRoot", () => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-kit-docsfor-outside-"),
    );
    try {
      writeDoc(bundleDir, "exact.md", {
        type: "concept",
        sources: ["src/foo.ts"],
      });

      expect(() =>
        runDocsFor(bundleDir, [path.join(outside, "src", "foo.ts")], {
          repoRoot,
        }),
      ).toThrow(UsageError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("fills repoRoot from an injected runGit stub for a real match, not just the absent-repo-root error path", () => {
    const stubRunGit: RunGit = (args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
        return repoRoot;
      return null;
    };
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "foo.ts"), "export {};\n");
    writeDoc(bundleDir, "exact.md", {
      type: "concept",
      sources: ["src/foo.ts"],
    });

    const result = runDocsFor(bundleDir, ["src/foo.ts"], {
      runGit: stubRunGit,
    });
    expect(result.matches).toEqual([
      { doc: "exact.md", sources: ["src/foo.ts"] },
    ]);
  });
});

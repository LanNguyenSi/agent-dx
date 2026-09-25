import path from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "../src/errors.js";
import { runDocsFor } from "../src/docs-for.js";
import { FIXTURES_DIR } from "./helpers.js";

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

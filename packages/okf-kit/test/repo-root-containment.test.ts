import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { runDocsFor } from "../src/docs-for.js";
import { sourcesShapeRule } from "../src/rules/sources-shape.js";
import { isWithinRepoRoot } from "../src/util.js";
import { writeDoc } from "./git-helpers.js";

describe("repo-root containment of sources and applies_to", () => {
  let base: string;
  let repoRoot: string;

  beforeEach(() => {
    base = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "okf-contain-")),
    );
    repoRoot = path.join(base, "repo");
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "a.ts"), "a\n");
    // Files that exist outside the repo root, one in a sibling directory
    // whose name starts with the root's name.
    fs.writeFileSync(path.join(base, "outside.txt"), "x\n");
    fs.mkdirSync(path.join(base, "repo-evil"));
    fs.writeFileSync(path.join(base, "repo-evil", "b.ts"), "b\n");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const bundleDir = () => path.join(repoRoot, "bundle");
  const run = () => sourcesShapeRule.run(loadBundle(bundleDir(), repoRoot));

  for (const field of ["sources", "applies_to"] as const) {
    describe(field, () => {
      it.each(["../outside.txt", "../repo-evil/b.ts", "src/../../outside.txt"])(
        "flags an existing escaping entry %s, naming the field",
        (entry) => {
          writeDoc(repoRoot, "bundle/d.md", {
            type: "note",
            timestamp: "2025-06-01T00:00:00Z",
            [field]: [entry],
          });
          const findings = run();
          expect(findings).toHaveLength(1);
          expect(findings[0].severity).toBe("error");
          expect(findings[0].message).toBe(
            `\`${field}\` path escapes the repo root: \`${entry}\``,
          );
        },
      );

      it("accepts an in-root entry, including a leading-slash one", () => {
        writeDoc(repoRoot, "bundle/d.md", {
          type: "note",
          timestamp: "2025-06-01T00:00:00Z",
          [field]: ["src/a.ts", "/src/a.ts", "src/../src"],
        });
        expect(run()).toEqual([]);
      });

      it("flags a nonexistent escaping entry with the escape message, not the missing-path one", () => {
        writeDoc(repoRoot, "bundle/d.md", {
          type: "note",
          timestamp: "2025-06-01T00:00:00Z",
          [field]: ["../does-not-exist.txt"],
        });
        const findings = run();
        expect(findings.map((f) => f.message)).toEqual([
          `\`${field}\` path escapes the repo root: \`../does-not-exist.txt\``,
        ]);
      });
    });
  }

  it("docs-for never matches an escaping entry", () => {
    // `..` resolves to the directory holding the repo, which lexically
    // contains the given in-repo path, so only the containment filter keeps
    // these from matching.
    writeDoc(repoRoot, "bundle/d.md", {
      type: "note",
      timestamp: "2025-06-01T00:00:00Z",
      sources: ["../outside.txt", ".."],
      applies_to: ["..", "../outside.txt"],
    });
    expect(runDocsFor(bundleDir(), ["src/a.ts"], { repoRoot }).matches).toEqual(
      [],
    );
    // An in-root entry still matches, so the filter is not dropping everything.
    writeDoc(repoRoot, "bundle/e.md", {
      type: "note",
      timestamp: "2025-06-01T00:00:00Z",
      applies_to: ["src"],
    });
    expect(
      runDocsFor(bundleDir(), ["src/a.ts"], { repoRoot }).matches.map(
        (m) => m.doc,
      ),
    ).toEqual(["e.md"]);
  });

  it("isWithinRepoRoot accepts the root itself", () => {
    expect(isWithinRepoRoot(repoRoot, ".")).toBe(true);
    expect(isWithinRepoRoot(repoRoot, "..")).toBe(false);
  });
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { runGit } from "../src/git.js";
import { sourcesFreshRule } from "../src/rules/sources-fresh.js";
import type { RunGit } from "../src/types.js";
import {
  createTmpGitRepo,
  docContent,
  writeDoc,
  type TmpGitRepo,
} from "./git-helpers.js";

describe("sources-fresh", () => {
  let repo: TmpGitRepo;

  beforeEach(() => {
    repo = createTmpGitRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("flags a source committed after the doc's timestamp as STALE", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-01T00:00:00Z",
    );
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2025-12-01T00:00:00Z",
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "warning",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("STALE");
    expect(findings[0].message).toContain("source.ts");
  });

  it("does not flag a source when the doc timestamp is after the source's last commit", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2026-01-01T00:00:00Z",
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("bumping the doc timestamp above the commit time makes the STALE finding disappear", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-01T00:00:00Z",
    );

    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2025-12-01T00:00:00Z",
      sources: ["source.ts"],
    });
    const staleCtx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(staleCtx)).toHaveLength(1);

    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2026-06-01T00:00:00Z",
      sources: ["source.ts"],
    });
    const freshCtx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(freshCtx)).toEqual([]);
  });

  it("does not flag a source committed at exactly the doc's timestamp second (pins > over >=)", () => {
    const boundary = "2026-03-15T12:00:00Z";
    repo.commitFile("source.ts", "export const a = 1;\n", boundary);
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: boundary,
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("flags an untracked source path as a notice, not STALE", () => {
    fs.writeFileSync(path.join(repo.dir, "source.ts"), "export const a = 1;\n");
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2026-01-01T00:00:00Z",
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "notice",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("untracked");
  });

  it("flags a missing or unparseable timestamp as a notice, not STALE, exactly once per doc", () => {
    repo.commitFile("a.ts", "export const a = 1;\n", "2026-01-01T00:00:00Z");
    repo.commitFile("b.ts", "export const b = 1;\n", "2026-01-01T00:00:00Z");
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "not-a-date",
      sources: ["a.ts", "b.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "notice",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("no valid timestamp");
  });

  it("leaves a missing source path on disk to sources-shape (no S1 finding)", () => {
    repo.commitFile("real.ts", "export const a = 1;\n", "2025-01-01T00:00:00Z");
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2026-01-01T00:00:00Z",
      sources: ["does-not-exist.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("emits exactly one bundle-level notice when repoRoot is not a git work tree", () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-plain-"));
    try {
      writeDoc(plainDir, "doc.md", {
        type: "concept",
        timestamp: "2026-01-01T00:00:00Z",
        sources: ["source.ts"],
      });

      const ctx = loadBundle(plainDir, undefined);
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0].ruleId).toBe("sources-fresh");
      expect(findings[0].severity).toBe("notice");
      expect(findings[0].message).toContain("not inside a git work tree");
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it("finds zero violations when no doc declares sources", () => {
    writeDoc(repo.dir, "bundle/doc.md", { type: "concept" });
    const ctx = loadBundle(path.join(repo.dir, "bundle"), undefined);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("does not flag a source that landed in the same commit as the doc (squash-merge case)", () => {
    // Frontmatter timestamp predates the commit: before the doc-commit
    // comparison existed, this was exactly the stale-on-arrival squash-merge
    // false positive.
    repo.commitFiles(
      [
        {
          relPath: "bundle/doc.md",
          content: docContent({
            type: "concept",
            timestamp: "2026-01-01T00:00:00Z",
            sources: ["source.ts"],
          }),
        },
        { relPath: "source.ts", content: "export const a = 2;\n" },
      ],
      "2026-02-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("does not flag a source when the doc was committed strictly after it (stamp older than both)", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 2;\n",
      "2026-02-01T00:00:00Z",
    );
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2026-01-01T00:00:00Z",
        sources: ["source.ts"],
      }),
      "2026-03-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("applies the doc-commit comparison to docs in bundle subdirectories", () => {
    repo.commitFiles(
      [
        {
          relPath: "bundle/sub/doc.md",
          content: docContent({
            type: "concept",
            timestamp: "2026-01-01T00:00:00Z",
            sources: ["source.ts"],
          }),
        },
        { relPath: "source.ts", content: "export const a = 2;\n" },
      ],
      "2026-02-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  /**
   * The committed co-commit rescue under a `--repo-root` naming a
   * SUBDIRECTORY of the repository. Everything the rescue reads from git
   * past the doc's own `git log` is in the TOP-LEVEL path frame: the
   * `diff-tree --name-status` entries it matches the doc against, and the
   * `<rev>:<path>` spelling both `git show` blob reads take (git resolves
   * a bare `<rev>:<path>` against the top level, never the cwd). The rule's
   * own doc path is relative to the passed root, so spelled bare under a
   * subdirectory root the blob reads failed (every rescue collapsed to a
   * not-assessable notice) or, with a same-named doc at the top level,
   * read that doc's stamps instead. The rule respells the path via `git
   * rev-parse --show-prefix`, read once per run; these pin each shape.
   */
  describe("with --repo-root naming a subdirectory of the repository", () => {
    const subDoc = (timestamp: string): string =>
      docContent({ type: "concept", timestamp, sources: ["source.ts"] });

    function runSub(): ReturnType<typeof sourcesFreshRule.run> {
      const subRoot = path.join(repo.dir, "sub");
      return sourcesFreshRule.run(
        loadBundle(path.join(subRoot, "bundle"), subRoot),
      );
    }

    it("a source edit co-committed with a doc re-stamp reads clean, exactly as under the top-level root", () => {
      repo.commitFile(
        "sub/source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      repo.commitFile(
        "sub/bundle/doc.md",
        subDoc("2025-02-01T00:00:00Z"),
        "2025-02-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          { relPath: "sub/source.ts", content: "export const a = 2;\n" },
          {
            relPath: "sub/bundle/doc.md",
            content: subDoc("2025-09-01T00:00:00Z"),
          },
        ],
        "2025-10-01T00:00:00Z",
      );

      expect(runSub()).toEqual([]);
    });

    it("a source edit co-committed with a doc edit that did NOT re-stamp it stays STALE, never a not-assessable notice", () => {
      repo.commitFile(
        "sub/source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      const committedDoc = subDoc("2025-02-01T00:00:00Z");
      repo.commitFile(
        "sub/bundle/doc.md",
        committedDoc,
        "2025-02-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          { relPath: "sub/source.ts", content: "export const a = 2;\n" },
          {
            relPath: "sub/bundle/doc.md",
            content: committedDoc.replace("# Doc\n", "# Doc\n\nprose\n"),
          },
        ],
        "2025-10-01T00:00:00Z",
      );

      const findings = runSub();
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("warning");
      expect(findings[0].message).toContain("STALE");
    });

    it("a doc CREATED by the commit that also changed its source reads clean (the diff-tree entry is matched in the top-level frame)", () => {
      repo.commitFile(
        "sub/source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          { relPath: "sub/source.ts", content: "export const a = 2;\n" },
          {
            relPath: "sub/bundle/doc.md",
            content: subDoc("2025-09-01T00:00:00Z"),
          },
        ],
        "2025-10-01T00:00:00Z",
      );

      expect(runSub()).toEqual([]);
    });

    it("a same-named doc at the TOP LEVEL re-stamped in that same commit does not shadow the subdirectory doc, which stays STALE", () => {
      repo.commitFile(
        "sub/source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      const committedDoc = subDoc("2025-02-01T00:00:00Z");
      repo.commitFile(
        "sub/bundle/doc.md",
        committedDoc,
        "2025-02-01T00:00:00Z",
      );
      repo.commitFile("bundle/doc.md", committedDoc, "2025-02-01T00:00:00Z");
      // One commit: the source changes, the top-level doc IS re-stamped,
      // the subdirectory doc gets a body-only edit. A bare `<rev>:bundle/doc.md`
      // read would compare the top-level doc's two stamps and rescue the
      // wrong doc.
      repo.commitFiles(
        [
          { relPath: "sub/source.ts", content: "export const a = 2;\n" },
          { relPath: "bundle/doc.md", content: subDoc("2025-09-01T00:00:00Z") },
          {
            relPath: "sub/bundle/doc.md",
            content: committedDoc.replace("# Doc\n", "# Doc\n\nprose\n"),
          },
        ],
        "2025-10-01T00:00:00Z",
      );

      const findings = runSub();
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("warning");
      expect(findings[0].message).toContain("STALE");
    });
  });

  it("suppresses only sources at/before the doc's last commit, newer ones stay STALE", () => {
    // Pins the accepted >= semantics for multi-source docs: committing the
    // doc silences drift for every source older than that commit (documented
    // limitation), while a source changed afterwards still warns.
    repo.commitFiles(
      [
        {
          relPath: "bundle/doc.md",
          content: docContent({
            type: "concept",
            timestamp: "2026-01-01T00:00:00Z",
            sources: ["a.ts", "b.ts"],
          }),
        },
        { relPath: "a.ts", content: "export const a = 1;\n" },
        { relPath: "b.ts", content: "export const b = 1;\n" },
      ],
      "2026-02-01T00:00:00Z",
    );
    repo.commitFile("b.ts", "export const b = 2;\n", "2026-03-01T00:00:00Z");

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("STALE");
    expect(findings[0].message).toContain("b.ts");
    expect(findings[0].message).not.toContain("a.ts");
  });

  it("keeps the frontmatter-only comparison for a doc without git history", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 2;\n",
      "2026-02-01T00:00:00Z",
    );
    // writeDoc does not commit: the doc has no git history, so the doc-commit
    // comparison must stay out of the way and the stamp alone decides.
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2026-01-01T00:00:00Z",
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("STALE");
  });

  it("still flags STALE when the source changed after the doc's last commit", () => {
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2026-01-01T00:00:00Z",
        sources: ["source.ts"],
      }),
      "2026-02-01T00:00:00Z",
    );
    repo.commitFile(
      "source.ts",
      "export const a = 3;\n",
      "2026-03-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "warning",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("STALE");
  });

  it("uses an injected runGit stub instead of a real git process when supplied", () => {
    const stubEpoch = Math.floor(Date.parse("2025-06-01T00:00:00Z") / 1000);
    const docEpoch = Math.floor(Date.parse("2025-01-01T00:00:00Z") / 1000);
    // The doc's own last-commit epoch must be OLDER than the source's, or the
    // doc-commit freshness comparison would legitimately suppress the STALE
    // finding this test asserts.
    const stubRunGit: RunGit = (args) => {
      if (args[0] !== "log") return null;
      return args[args.length - 1] === "doc.md"
        ? String(docEpoch)
        : String(stubEpoch);
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-stub-"));
    try {
      fs.writeFileSync(path.join(dir, "source.ts"), "export const a = 1;\n");
      writeDoc(dir, "doc.md", {
        type: "concept",
        timestamp: "2020-01-01T00:00:00Z",
        sources: ["source.ts"],
      });

      const ctx = loadBundle(dir, dir, stubRunGit);
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: "sources-fresh",
        severity: "warning",
      });
      expect(findings[0].message).toContain("STALE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("co-commit exception is narrowed to a commit that actually re-stamps the doc", () => {
    // Frontmatter blocks kept byte-identical except for the timestamp line,
    // so a real `git log -p` diff between the two commits below contains
    // (fixture a) no `+timestamp:` line at all, or (fixture b) exactly one.
    const stampV1 =
      "---\ntype: concept\ntimestamp: 2026-01-01T00:00:00Z\nsources:\n  - source.ts\n---\n\n";
    const stampV2Rewritten =
      "---\ntype: concept\ntimestamp: 2026-01-01T00:00:01Z\nsources:\n  - source.ts\n---\n\n";

    it("(a) source + doc prose co-committed, stamp line untouched -> STALE", () => {
      repo.commitFiles(
        [
          { relPath: "bundle/doc.md", content: `${stampV1}# Doc\n` },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T10:00:00Z",
      );

      // Second commit changes the doc's PROSE and co-commits a source
      // change, but the frontmatter `timestamp:` line is byte-identical to
      // the prior commit -- exactly the review class this rule exists to
      // close: a co-commit that carries no verification claim must not
      // silently suppress staleness.
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${stampV1}# Doc\n\nExtra prose, unrelated to the source.\n`,
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-08-20T12:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("STALE");
      expect(findings[0].message).toContain("source.ts");
    });

    it("(b) negative control: source + doc co-committed WITH the stamp rewritten in that commit -> passes", () => {
      repo.commitFiles(
        [
          { relPath: "bundle/doc.md", content: `${stampV1}# Doc\n` },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T10:00:00Z",
      );

      // Same shape as fixture (a), except this commit's frontmatter
      // `timestamp:` line differs from the prior commit's, so the diff
      // carries a `+timestamp:` line: a real (if imperfect) re-stamp.
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${stampV2Rewritten}# Doc\n\nExtra prose, unrelated to the source.\n`,
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-08-20T12:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });

    it("(c) doc CREATED in the same commit as its source -> passes (new file counts as stamped)", () => {
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: docContent({
              type: "concept",
              timestamp: "2020-01-01T00:00:00Z",
              sources: ["source.ts"],
            }),
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-05-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });

    it("(d) source-only change after the stamp, no co-commit at all -> STALE (existing behaviour)", () => {
      repo.commitFile(
        "bundle/doc.md",
        docContent({
          type: "concept",
          timestamp: "2026-01-01T00:00:00Z",
          sources: ["source.ts"],
        }),
        "2026-01-01T00:00:00Z",
      );
      repo.commitFile(
        "source.ts",
        "export const a = 2;\n",
        "2026-02-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const findings = sourcesFreshRule.run(ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("STALE");
    });
  });
  describe("re-stamp detection compares frontmatter timestamp VALUES, not diff text", () => {
    // Every fixture below is a shape a `git log -p` TEXT scan gets wrong.
    // The frontmatter blocks are byte-identical except where a fixture
    // deliberately changes the stamp, so "the stamp value changed" is the
    // only signal separating a pass from a STALE.
    const fm = (stamp: string): string =>
      `---\ntype: concept\ntimestamp: ${stamp}\nsources:\n  - source.ts\n---\n`;
    const STAMP = "2026-01-01T00:00:00Z";

    it("a body-level `timestamp:` line in a fenced YAML example is not a re-stamp -> STALE", () => {
      // The doc's BODY gains a fenced YAML example whose `timestamp:` line
      // is unindented, co-committed with a source change, while the
      // frontmatter stamp is untouched. Under the previous `^\+timestamp:`
      // diff scan that body line read as a re-stamp and silently suppressed
      // staleness -- the exact review class this rule exists to close.
      repo.commitFiles(
        [
          { relPath: "bundle/doc.md", content: `${fm(STAMP)}\n# Doc\n` },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T10:00:00Z",
      );
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm(STAMP)}\n# Doc\n\nExample frontmatter:\n\n\`\`\`yaml\ntype: concept\ntimestamp: 2026-08-20T12:00:00Z\n\`\`\`\n`,
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-08-20T12:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("warning");
      expect(findings[0].message).toContain("STALE");
      expect(findings[0].message).toContain("source.ts");
    });

    it("a rename with an unchanged stamp is not a re-stamp -> STALE", () => {
      // `git mv` makes a single-path `git log -p` print `new file mode`,
      // which fired the "created counts as stamped" branch and suppressed
      // staleness. The rename-aware name-status lookup reads the doc's real
      // previous path instead, so the stamp comparison is against the
      // doc's own earlier revision.
      repo.commitFiles(
        [
          {
            relPath: "bundle/old.md",
            content: `${fm(STAMP)}\n# Doc\n\nBody line one.\nBody line two.\nBody line three.\n`,
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFile(
        "source.ts",
        "export const a = 2;\n",
        "2026-02-01T00:00:00Z",
      );
      repo.gitAt(
        ["mv", "bundle/old.md", "bundle/doc.md"],
        "2026-03-01T00:00:00Z",
      );
      repo.gitAt(
        ["commit", "--quiet", "-m", "rename doc"],
        "2026-03-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("warning");
      expect(findings[0].message).toContain("STALE");
    });

    it("negative control: a rename that also rewrites the stamp IS a re-stamp -> passes", () => {
      repo.commitFiles(
        [
          {
            relPath: "bundle/old.md",
            content: `${fm(STAMP)}\n# Doc\n\nBody line one.\nBody line two.\nBody line three.\n`,
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFile(
        "source.ts",
        "export const a = 2;\n",
        "2026-02-01T00:00:00Z",
      );
      repo.gitAt(
        ["mv", "bundle/old.md", "bundle/doc.md"],
        "2026-03-01T00:00:00Z",
      );
      fs.writeFileSync(
        path.join(repo.dir, "bundle/doc.md"),
        `${fm("2026-02-20T00:00:00Z")}\n# Doc\n\nBody line one.\nBody line two.\nBody line three.\n`,
      );
      repo.gitAt(["add", "bundle/doc.md"], "2026-03-01T00:00:00Z");
      repo.gitAt(
        ["commit", "--quiet", "-m", "rename + re-stamp"],
        "2026-03-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });

    it("a rename with a NON-ASCII doc name and an unchanged stamp is not a re-stamp -> STALE", () => {
      // git's default `--name-status` C-quotes a non-ASCII path
      // (`core.quotePath` defaults to true), so `previousPathIn`'s plain
      // string match against `repoRelDocPath` never matched a quoted
      // `"bundle/\303\266lt.md"` row -- the doc fell through to the `same`
      // fallback, which returns the doc's real (unquoted) current path
      // unchanged. But this commit was a rename, so the doc was NOT at
      // that path in the first parent (it lived under the old name
      // there), and the ensuing `git show <parent>:<doc>` blob read
      // failed, turning this into a `not assessable` notice rather than
      // the STALE it should have been. `-z` prints the path verbatim;
      // this fixture pins that a non-ASCII rename is still read
      // correctly end to end.
      repo.commitFiles(
        [
          {
            relPath: "bundle/ölt.md",
            content: `${fm(STAMP)}\n# Doc\n\nBody line one.\nBody line two.\nBody line three.\n`,
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFile(
        "source.ts",
        "export const a = 2;\n",
        "2026-02-01T00:00:00Z",
      );
      repo.gitAt(
        ["mv", "bundle/ölt.md", "bundle/nöu.md"],
        "2026-03-01T00:00:00Z",
      );
      repo.gitAt(
        ["commit", "--quiet", "-m", "rename doc (non-ascii)"],
        "2026-03-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("warning");
      expect(findings[0].message).toContain("STALE");
    });

    it("a NON-ASCII doc name created (not renamed) by a non-root commit -> passes", () => {
      // Same C-quoting hazard, the `created` branch of previousPathIn: an
      // "A" (added) row for a non-ASCII path is quoted the same way a
      // rename row's paths are. A prior unrelated commit keeps the doc's
      // own last commit from being the repo's ROOT commit, so this
      // exercises previousPathIn's real "A" row parsing, not the
      // root-commit shortcut in restampedByOwnLastCommit.
      repo.commitFile("unrelated.txt", "x\n", "2026-01-01T00:00:00Z");
      repo.commitFiles(
        [
          {
            relPath: "bundle/nöu.md",
            content: docContent({
              type: "concept",
              timestamp: "2020-01-01T00:00:00Z",
              sources: ["source.ts"],
            }),
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-05-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });

    // A merge commit prints NO patch under `git log -p` (git's default
    // combined-diff suppression), so the previous detector saw an empty
    // diff and called a genuine re-stamp "not re-stamped" -- a
    // false-positive STALE on exactly the `refs/pull/N/merge` ref CI checks
    // out. Reading both trees with `git show` works merge or not.
    const HUNK_DOC = (stamp: string, a: string, b: string): string =>
      `${fm(stamp)}\n# Doc\n\n${a}\n\nmiddle filler\n\n${b}\n`;

    it("(merge i) clean auto-merge whose merged-in side carries the re-stamp -> passes", () => {
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: HUNK_DOC(STAMP, "HUNK-A base", "HUNK-B base"),
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.gitAt(["branch", "feature"], "2026-01-01T00:00:00Z");
      // main side: prose only, no re-stamp.
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: HUNK_DOC(STAMP, "HUNK-A main edit", "HUNK-B base"),
          },
        ],
        "2026-02-01T00:00:00Z",
      );
      repo.gitAt(["checkout", "--quiet", "feature"], "2026-01-01T00:00:00Z");
      // feature side: a real re-stamp (to an instant BEFORE the commit that
      // carries it, the ordinary "verified, then committed" gap) plus the
      // source change that makes the doc a staleness candidate at all.
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: HUNK_DOC(
              "2026-02-15T00:00:00Z",
              "HUNK-A base",
              "HUNK-B feature edit",
            ),
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-03-01T00:00:00Z",
      );
      repo.gitAt(["checkout", "--quiet", "main"], "2026-01-01T00:00:00Z");
      repo.gitAt(
        ["merge", "--quiet", "--no-edit", "feature"],
        "2026-04-01T00:00:00Z",
      );

      // Both sides touched the doc, so the merge result is TREESAME to
      // neither parent and IS the doc's last commit.
      expect(
        repo.git(["log", "-1", "--format=%H", "--", "bundle/doc.md"]),
      ).toBe(repo.git(["rev-parse", "HEAD"]));
      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });

    it("(merge ii) conflict-resolution merge that re-stamps -> passes", () => {
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: HUNK_DOC(STAMP, "HUNK-A base", "HUNK-B base"),
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.gitAt(["branch", "feature"], "2026-01-01T00:00:00Z");
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: HUNK_DOC(STAMP, "HUNK-A main version", "HUNK-B base"),
          },
        ],
        "2026-02-01T00:00:00Z",
      );
      repo.gitAt(["checkout", "--quiet", "feature"], "2026-01-01T00:00:00Z");
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: HUNK_DOC(STAMP, "HUNK-A feature version", "HUNK-B base"),
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-03-01T00:00:00Z",
      );
      repo.gitAt(["checkout", "--quiet", "main"], "2026-01-01T00:00:00Z");
      // Both sides rewrote the same line: git cannot auto-merge, so the
      // merge stops with a conflict and the resolution below is a real
      // human-shaped commit.
      expect(() =>
        repo.gitAt(
          ["merge", "--quiet", "--no-edit", "feature"],
          "2026-04-01T00:00:00Z",
        ),
      ).toThrow();
      fs.writeFileSync(
        path.join(repo.dir, "bundle/doc.md"),
        HUNK_DOC("2026-02-20T00:00:00Z", "HUNK-A merged", "HUNK-B base"),
      );
      repo.gitAt(["add", "bundle/doc.md"], "2026-04-01T00:00:00Z");
      repo.gitAt(["commit", "--quiet", "--no-edit"], "2026-04-01T00:00:00Z");

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });

    it("(merge iii) merge that does NOT re-stamp while a source changed on a side -> STALE", () => {
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: HUNK_DOC(STAMP, "HUNK-A base", "HUNK-B base"),
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.gitAt(["branch", "feature"], "2026-01-01T00:00:00Z");
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: HUNK_DOC(STAMP, "HUNK-A main edit", "HUNK-B base"),
          },
        ],
        "2026-02-01T00:00:00Z",
      );
      repo.gitAt(["checkout", "--quiet", "feature"], "2026-01-01T00:00:00Z");
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: HUNK_DOC(STAMP, "HUNK-A base", "HUNK-B feature edit"),
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-03-01T00:00:00Z",
      );
      repo.gitAt(["checkout", "--quiet", "main"], "2026-01-01T00:00:00Z");
      repo.gitAt(
        ["merge", "--quiet", "--no-edit", "feature"],
        "2026-04-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("warning");
      expect(findings[0].message).toContain("STALE");
    });

    it("(merge iv) octopus merge (three parents) as the doc's last commit, without a re-stamp -> STALE", () => {
      // An octopus merge (`git merge b1 b2 b3` from a single starting
      // point) commits with THREE parents in one commit, not two -- a
      // shape `firstParent = parents[0]` must still handle correctly (it
      // does: it only ever looks at parents[0], regardless of how many
      // there are). Three independent hunks so the three branches merge
      // cleanly with no conflict.
      const OCTO_DOC = (
        stamp: string,
        a: string,
        b: string,
        c: string,
      ): string =>
        `${fm(stamp)}\n# Doc\n\n${a}\n\nfiller-ab\n\n${b}\n\nfiller-bc\n\n${c}\n`;

      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: OCTO_DOC(
              STAMP,
              "HUNK-A base",
              "HUNK-B base",
              "HUNK-C base",
            ),
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.gitAt(["branch", "b1"], "2026-01-01T00:00:00Z");
      repo.gitAt(["branch", "b2"], "2026-01-01T00:00:00Z");
      repo.gitAt(["branch", "b3"], "2026-01-01T00:00:00Z");

      repo.gitAt(["checkout", "--quiet", "b1"], "2026-01-01T00:00:00Z");
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: OCTO_DOC(
              STAMP,
              "HUNK-A one",
              "HUNK-B base",
              "HUNK-C base",
            ),
          },
        ],
        "2026-02-01T00:00:00Z",
      );

      repo.gitAt(["checkout", "--quiet", "b2"], "2026-01-01T00:00:00Z");
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: OCTO_DOC(
              STAMP,
              "HUNK-A base",
              "HUNK-B two",
              "HUNK-C base",
            ),
          },
        ],
        "2026-02-02T00:00:00Z",
      );

      repo.gitAt(["checkout", "--quiet", "b3"], "2026-01-01T00:00:00Z");
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: OCTO_DOC(
              STAMP,
              "HUNK-A base",
              "HUNK-B base",
              "HUNK-C three",
            ),
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-03-01T00:00:00Z",
      );

      repo.gitAt(["checkout", "--quiet", "main"], "2026-01-01T00:00:00Z");
      repo.gitAt(
        ["merge", "--quiet", "--no-edit", "b1", "b2", "b3"],
        "2026-04-01T00:00:00Z",
      );

      const parents = repo.git(["log", "-1", "--format=%P"]).split(" ");
      expect(parents).toHaveLength(3);
      expect(
        repo.git(["log", "-1", "--format=%H", "--", "bundle/doc.md"]),
      ).toBe(repo.git(["rev-parse", "HEAD"]));

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("warning");
      expect(findings[0].message).toContain("STALE");
    });

    it("a cosmetic timestamp rewrite (same instant, different representation) is NOT a re-stamp -> stays STALE + same-instant notice (D-004, D-009)", () => {
      // D-004: the direction check compares PARSED INSTANTS, not raw
      // strings. A rewrite from `...00Z` to `...00.000Z` is a different raw
      // string but names the SAME instant, so it is neither a forward nor a
      // backward move -- nothing was certified strictly newer, so it is
      // `not-restamped` (and, since the instant did not move EARLIER
      // either, it is not reported as a backwards move: only a genuine
      // backwards move gets that extra warning). D-009: it IS reported as
      // its own NOTICE (not a warning, so --strict is unaffected) naming
      // both values, so this is not a silent no-op. Before D-004,
      // getTimestampIdentity's raw-string comparison alone counted this as
      // a re-stamp; pinned here to the corrected outcome.
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm(STAMP)}\n# Doc\n`,
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("2026-01-01T00:00:00.000Z")}\n# Doc\n`,
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-03-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const findings = sourcesFreshRule.run(ctx);
      expect(findings).toHaveLength(2);
      const stale = findings.find((f) => f.message.includes("STALE"));
      const sameInstant = findings.find((f) =>
        f.message.includes("did not move the timestamp forward"),
      );
      expect(stale).toMatchObject({
        ruleId: "sources-fresh",
        severity: "warning",
      });
      expect(stale?.message).not.toContain("moved backwards");
      expect(sameInstant).toMatchObject({
        ruleId: "sources-fresh",
        severity: "notice",
      });
      // The notice names BOTH raw values, which is the only thing that
      // distinguishes the two sides here (their instants are identical by
      // construction), plus the one instant and the path it happened on.
      // Asserted as one exact string so a notice that printed one value
      // twice -- what two ISO fields could only ever produce -- cannot
      // satisfy it.
      expect(sameInstant?.message).toBe(
        're-stamp did not move the timestamp forward: "2026-01-01T00:00:00Z" was rewritten as "2026-01-01T00:00:00.000Z" in the doc\'s last commit, but both name the same instant (2026-01-01T00:00:00.000Z), so this is not a re-verification',
      );
    });

    it("a forward re-stamp of less than a second still counts as restamped -> passes, at millisecond resolution (D-008)", () => {
      // D-008: compareRestampDirection compares at MILLISECOND resolution
      // (getTimestampEpochMs), not the whole-second floor getTimestampEpoch
      // uses elsewhere. .000Z -> .500Z is a real forward move even though
      // both floor to the SAME second; without D-008 this would misread as
      // the D-009 same-instant case and stay STALE instead of passing.
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("2026-01-01T00:00:00.000Z")}\n# Doc\n`,
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("2026-01-01T00:00:00.500Z")}\n# Doc\n`,
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-02-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });

    it("a first parent with an unparseable timestamp falls back to raw-identity comparison -> a changed value still counts as restamped (D-004 fallback)", () => {
      // The first parent's frontmatter timestamp does not parse
      // (getTimestampEpochMs returns undefined for it), so
      // compareRestampDirection cannot judge direction and falls back to
      // getTimestampIdentity: the raw value changed ("not-a-date" -> a real
      // ISO string), so this still counts as restamped, exactly as before
      // D-004 existed for this unparseable-either-side case (AC-002).
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("not-a-date")}\n# Doc\n`,
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("2026-04-01T00:00:00Z")}\n# Doc\n`,
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-05-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });

    it("a re-stamp that moves the frontmatter timestamp BACKWARDS is not a re-verification -> stays STALE + backwards warning (D-004)", () => {
      // The doc is stamped 2026-03-01, then a later commit changes the
      // source AND re-stamps the doc to the EARLIER 2026-02-01 -- a
      // backwards move never certifies anything, so the source stays STALE
      // and the doc additionally gets one "moved backwards" warning naming
      // both instants (AC-002).
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("2026-03-01T00:00:00Z")}\n# Doc\n`,
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("2026-02-01T00:00:00Z")}\n# Doc\n`,
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-04-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(2);
      const stale = findings.find((f) => f.message.includes("STALE"));
      const backwards = findings.find((f) =>
        f.message.includes("moved backwards"),
      );
      expect(stale).toMatchObject({
        ruleId: "sources-fresh",
        severity: "warning",
      });
      expect(stale?.message).toContain("source.ts");
      expect(backwards).toMatchObject({
        ruleId: "sources-fresh",
        severity: "warning",
      });
      expect(backwards?.message).toContain("2026-03-01T00:00:00.000Z");
      expect(backwards?.message).toContain("2026-02-01T00:00:00.000Z");
      expect(backwards?.message).toContain("in the doc's last commit");
    });

    it("a re-stamp that moves the frontmatter timestamp strictly FORWARD still counts as a re-stamp -> passes (D-004)", () => {
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("2026-03-01T00:00:00Z")}\n# Doc\n`,
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("2026-04-01T00:00:00Z")}\n# Doc\n`,
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-05-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });

    it("the backwards warning fires at most ONCE per doc, however many of its sources hit the backwards move (D-004)", () => {
      // Two sources, both stale, one doc whose last commit moved the
      // timestamp backwards: exactly one "moved backwards" warning, not
      // one per source, PLUS one STALE finding per source.
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("2026-03-01T00:00:00Z")}\n# Doc\n`.replace(
              "sources:\n  - source.ts",
              "sources:\n  - a.ts\n  - b.ts",
            ),
          },
          { relPath: "a.ts", content: "export const a = 1;\n" },
          { relPath: "b.ts", content: "export const b = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("2026-02-01T00:00:00Z")}\n# Doc\n`.replace(
              "sources:\n  - source.ts",
              "sources:\n  - a.ts\n  - b.ts",
            ),
          },
          { relPath: "a.ts", content: "export const a = 2;\n" },
          { relPath: "b.ts", content: "export const b = 2;\n" },
        ],
        "2026-04-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const findings = sourcesFreshRule.run(ctx);

      const stale = findings.filter((f) => f.message.includes("STALE"));
      const backwards = findings.filter((f) =>
        f.message.includes("moved backwards"),
      );
      expect(stale).toHaveLength(2);
      expect(backwards).toHaveLength(1);
      expect(findings).toHaveLength(3);
    });

    it("the same-instant notice fires at most ONCE per doc, however many of its sources hit the same-instant rewrite (D-009)", () => {
      // Two sources, both stale, one doc whose last commit rewrote the
      // timestamp to the SAME instant in a different representation:
      // exactly one same-instant notice, not one per source, PLUS one
      // STALE finding per source.
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm(STAMP)}\n# Doc\n`.replace(
              "sources:\n  - source.ts",
              "sources:\n  - a.ts\n  - b.ts",
            ),
          },
          { relPath: "a.ts", content: "export const a = 1;\n" },
          { relPath: "b.ts", content: "export const b = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("2026-01-01T00:00:00.000Z")}\n# Doc\n`.replace(
              "sources:\n  - source.ts",
              "sources:\n  - a.ts\n  - b.ts",
            ),
          },
          { relPath: "a.ts", content: "export const a = 2;\n" },
          { relPath: "b.ts", content: "export const b = 2;\n" },
        ],
        "2026-03-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const findings = sourcesFreshRule.run(ctx);

      const stale = findings.filter((f) => f.message.includes("STALE"));
      const sameInstant = findings.filter((f) =>
        f.message.includes("did not move the timestamp forward"),
      );
      expect(stale).toHaveLength(2);
      expect(sameInstant).toHaveLength(1);
      expect(findings).toHaveLength(3);
    });

    it("a last commit that REMOVED the timestamp line reports the no-valid-timestamp notice", () => {
      repo.commitFiles(
        [
          { relPath: "bundle/doc.md", content: `${fm(STAMP)}\n# Doc\n` },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content:
              "---\ntype: concept\nsources:\n  - source.ts\n---\n\n# Doc\n",
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-03-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: "sources-fresh",
        severity: "notice",
        file: "doc.md",
      });
      expect(findings[0].message).toContain("no valid timestamp");
    });

    it("a git failure on the re-stamp path is a not-assessable notice, never STALE and never a silent pass", () => {
      repo.commitFiles(
        [
          { relPath: "bundle/doc.md", content: `${fm(STAMP)}\n# Doc\n` },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm(STAMP)}\n# Doc\n\nmore\n`,
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-03-01T00:00:00Z",
      );

      // Real git for everything except the blob read, which fails the way a
      // corrupt object or an oversized output does.
      const failingShow: RunGit = (args, cwd) =>
        args[0] === "show" ? null : runGit(args, cwd);

      const ctx = loadBundle(
        path.join(repo.dir, "bundle"),
        repo.dir,
        failingShow,
      );
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: "sources-fresh",
        severity: "notice",
        file: "doc.md",
      });
      expect(findings[0].message).toContain("not assessable");
      expect(findings[0].message).not.toContain("STALE");
    });

    it("reads a doc larger than node's default 1 MiB child-process output cap", () => {
      // `git show <sha>:<doc>` streams the whole blob. Without an explicit
      // maxBuffer (see src/git.ts) node kills the call at 1 MiB and RunGit
      // reports it as a git failure, which would turn a perfectly healthy
      // large doc into a permanent "not assessable" notice.
      const body =
        "lorem ipsum filler line for a deliberately large doc\n".repeat(30000);
      expect(body.length).toBeGreaterThan(1024 * 1024);
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm(STAMP)}\n# Doc\n\n${body}`,
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `${fm("2026-02-20T00:00:00Z")}\n# Doc\n\n${body}`,
          },
          { relPath: "source.ts", content: "export const a = 2;\n" },
        ],
        "2026-03-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });

    it("spends at most five git processes per doc per run, however many sources it declares", () => {
      // Pins the GIT PROCESS BUDGET comment in src/rules/sources-fresh.ts:
      // one shared epoch lookup plus at most four on the re-stamp path,
      // memoized per doc -- a doc's git cost must not scale with its
      // `sources` list. The counting runner delegates to real git so the
      // count is of real invocations, not of a fake's expectations.
      const calls: string[][] = [];
      const countingGit: RunGit = (args, cwd) => {
        calls.push(args);
        return runGit(args, cwd);
      };
      const sources = ["a.ts", "b.ts", "c.ts"];
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `---\ntype: concept\ntimestamp: ${STAMP}\nsources:\n${sources.map((s) => `  - ${s}`).join("\n")}\n---\n\n# Doc\n`,
          },
          ...sources.map((relPath) => ({
            relPath,
            content: "export const v = 1;\n",
          })),
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFiles(
        sources.map((relPath) => ({
          relPath,
          content: "export const v = 2;\n",
        })),
        "2026-02-01T00:00:00Z",
      );
      // Doc touched last, WITHOUT a re-stamp: the longest path through the
      // re-stamp lookup (no early return for "created" or a root commit).
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: `---\ntype: concept\ntimestamp: ${STAMP}\nsources:\n${sources.map((s) => `  - ${s}`).join("\n")}\n---\n\n# Doc\n\nprose\n`,
          },
        ],
        "2026-03-01T00:00:00Z",
      );

      const ctx = loadBundle(
        path.join(repo.dir, "bundle"),
        repo.dir,
        countingGit,
      );
      const findings = sourcesFreshRule.run(ctx);
      expect(findings).toHaveLength(3);

      const perSourceCalls = calls.filter((args) =>
        sources.some((s) => args[args.length - 1] === s),
      );
      // Per RUN, not per doc: the top-level path frame (`git rev-parse
      // --show-prefix`) is read once and cached on the context, so it is
      // counted separately from the per-doc budget.
      const perRunCalls = calls.filter(
        (args) => args[0] === "rev-parse" && args[1] === "--show-prefix",
      );
      const perDocCalls = calls.filter(
        (args) => !perSourceCalls.includes(args) && !perRunCalls.includes(args),
      );
      expect(perSourceCalls).toHaveLength(sources.length);
      expect(perRunCalls).toHaveLength(1);
      expect(perDocCalls).toHaveLength(5);
      expect(perDocCalls.map((args) => args[0])).toEqual([
        "log",
        "log",
        "diff-tree",
        "show",
        "show",
      ]);
      expect(calls).toHaveLength(sources.length + 5 + 1);
    });

    it("reads the top-level path frame (`git rev-parse --show-prefix`) once per RUN, not once per doc", () => {
      // Two docs, each with its own sources and each driven down the
      // longest re-stamp path (touched last without a re-stamp), so a
      // per-doc read of the show prefix would show up as 2 while the
      // per-doc budget of 5 holds for each; a one-doc fixture cannot tell
      // the two apart.
      const calls: string[][] = [];
      const countingGit: RunGit = (args, cwd) => {
        calls.push(args);
        return runGit(args, cwd);
      };
      const docs = [
        { relPath: "bundle/one.md", source: "one.ts" },
        { relPath: "bundle/two.md", source: "two.ts" },
      ];
      const docText = (source: string, body: string): string =>
        `---\ntype: concept\ntimestamp: ${STAMP}\nsources:\n  - ${source}\n---\n\n# Doc\n${body}`;
      repo.commitFiles(
        docs.flatMap(({ relPath, source }) => [
          { relPath, content: docText(source, "") },
          { relPath: source, content: "export const v = 1;\n" },
        ]),
        "2026-01-01T00:00:00Z",
      );
      repo.commitFiles(
        docs.map(({ source }) => ({
          relPath: source,
          content: "export const v = 2;\n",
        })),
        "2026-02-01T00:00:00Z",
      );
      repo.commitFiles(
        docs.map(({ relPath, source }) => ({
          relPath,
          content: docText(source, "\nprose\n"),
        })),
        "2026-03-01T00:00:00Z",
      );

      const ctx = loadBundle(
        path.join(repo.dir, "bundle"),
        repo.dir,
        countingGit,
      );
      const findings = sourcesFreshRule.run(ctx);
      expect(findings).toHaveLength(docs.length);

      const perRunCalls = calls.filter(
        (args) => args[0] === "rev-parse" && args[1] === "--show-prefix",
      );
      const perSourceCalls = calls.filter((args) =>
        docs.some(({ source }) => args[args.length - 1] === source),
      );
      expect(perRunCalls).toHaveLength(1);
      expect(perSourceCalls).toHaveLength(docs.length);
      expect(calls).toHaveLength(docs.length + docs.length * 5 + 1);
    });

    it("a failed rev-parse on a parentless doc commit -> not assessable, never a silent pass", () => {
      // Pins the "a failed git call ... is treated as shallow" branch in
      // isShallowRepoShared (`out === null ? true : ...`): stubs ONLY the
      // shared `rev-parse --is-shallow-repository` call to fail (as a real
      // process failure would -- corrupt object, missing binary), while
      // every other call goes to real git. The doc's last commit here is
      // the repo's genuine root commit (empty parent list), so without the
      // "failure counts as shallow" branch, a failed rev-parse would fall
      // through to "not shallow", trust the root commit as a real one, and
      // silently pass a source this run could never actually verify.
      const stubGit: RunGit = (args, cwd) => {
        if (
          args[0] === "rev-parse" &&
          args.includes("--is-shallow-repository")
        ) {
          return null;
        }
        return runGit(args, cwd);
      };
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: docContent({
              type: "concept",
              timestamp: "2025-12-01T00:00:00Z",
              sources: ["source.ts"],
            }),
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir, stubGit);
      const findings = sourcesFreshRule.run(ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("notice");
      expect(findings[0].message).toContain("not assessable");
      expect(findings[0].message).not.toContain("STALE");
    });

    it("caches the shared is-shallow-repository lookup across docs: at most one rev-parse call per run", () => {
      // Pins the WeakMap cache in isShallowRepoShared: three docs, each
      // with a parentless last commit (a genuine root commit), each reach
      // the root-commit branch that consults isShallowRepo(). Without the
      // cache (a lookup that never hits, e.g. always returning `undefined`),
      // this would spend one `rev-parse --is-shallow-repository` PER doc
      // instead of one for the whole run.
      const calls: string[][] = [];
      const countingGit: RunGit = (args, cwd) => {
        calls.push(args);
        return runGit(args, cwd);
      };
      const docs = ["doc1", "doc2", "doc3"];
      repo.commitFiles(
        [
          ...docs.map((name) => ({
            relPath: `bundle/${name}.md`,
            content: docContent({
              type: "concept",
              timestamp: "2025-12-01T00:00:00Z",
              sources: [`${name}-source.ts`],
            }),
          })),
          ...docs.map((name) => ({
            relPath: `${name}-source.ts`,
            content: "export const a = 1;\n",
          })),
        ],
        "2026-01-01T00:00:00Z",
      );

      const ctx = loadBundle(
        path.join(repo.dir, "bundle"),
        repo.dir,
        countingGit,
      );
      sourcesFreshRule.run(ctx);

      const revParseCalls = calls.filter(
        (args) =>
          args[0] === "rev-parse" && args.includes("--is-shallow-repository"),
      );
      expect(revParseCalls).toHaveLength(1);
    });
  });

  describe("shallow clone: a grafted boundary commit must not be trusted as a real root commit", () => {
    it("a shallow clone (--depth 1) reports 'not assessable', never a silent pass; a full clone of the same repo still reports STALE", () => {
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: docContent({
              type: "concept",
              timestamp: "2026-01-01T00:00:00Z",
              sources: ["source.ts"],
            }),
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFile(
        "source.ts",
        "export const a = 2;\n",
        "2026-02-01T00:00:00Z",
      );

      // Full (non-shallow) clone of the same history: STALE, exactly as
      // every other fixture in this file.
      const fullCtx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      const fullFindings = sourcesFreshRule.run(fullCtx);
      expect(fullFindings).toHaveLength(1);
      expect(fullFindings[0].severity).toBe("warning");
      expect(fullFindings[0].message).toContain("STALE");

      // Shallow clone: `--depth` is silently ignored for a plain local
      // path clone, so this goes through a `file://` URL to get a real
      // grafted boundary commit. That boundary commit (== the "change
      // source only" commit above) reports an EMPTY parent list for
      // bundle/doc.md too, indistinguishable from a real root commit by
      // `git log -1 --format=%H%n%P` alone -- even though the doc
      // manifestly existed before, just outside the depth-1 window.
      const shallowDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "okf-kit-shallow-"),
      );
      try {
        execFileSync(
          "git",
          [
            "clone",
            "--quiet",
            "--depth",
            "1",
            `file://${repo.dir}`,
            shallowDir,
          ],
          { encoding: "utf8" },
        );
        const isShallow = execFileSync(
          "git",
          ["rev-parse", "--is-shallow-repository"],
          { cwd: shallowDir, encoding: "utf8" },
        ).trim();
        expect(isShallow).toBe("true");

        const shallowCtx = loadBundle(
          path.join(shallowDir, "bundle"),
          shallowDir,
        );
        const shallowFindings = sourcesFreshRule.run(shallowCtx);

        expect(shallowFindings).toHaveLength(1);
        expect(shallowFindings[0]).toMatchObject({
          ruleId: "sources-fresh",
          severity: "notice",
          file: "doc.md",
        });
        expect(shallowFindings[0].message).toContain("not assessable");
        expect(shallowFindings[0].message).toContain("shallow");
        expect(shallowFindings[0].message).not.toContain("STALE");
      } finally {
        fs.rmSync(shallowDir, { recursive: true, force: true });
      }
    });

    it("a shallow clone whose doc last commit has an in-window parent is still assessed normally, not gated as unassessable", () => {
      // A shallow clone is not automatically "not assessable" for every
      // doc: the root-commit shortcut (and its shallow guard) only fires
      // when the doc's OWN last commit reports an empty parent list. Here
      // that commit's parent is still inside the depth-2 window, so
      // `restampedByOwnLastCommit` takes the ordinary (non-root) path and
      // this must resolve to a ordinary STALE, exactly like a full clone
      // -- pinning that the shallow gate does not over-trigger.
      repo.commitFiles(
        [
          {
            relPath: "bundle/doc.md",
            content: docContent({
              type: "concept",
              timestamp: "2026-01-01T00:00:00Z",
              sources: ["source.ts"],
            }),
          },
          { relPath: "source.ts", content: "export const a = 1;\n" },
        ],
        "2026-01-01T00:00:00Z",
      );
      repo.commitFile(
        "source.ts",
        "export const a = 2;\n",
        "2026-02-01T00:00:00Z",
      );
      repo.commitFile(
        "bundle/doc.md",
        docContent({
          type: "concept",
          timestamp: "2026-01-01T00:00:00Z",
          sources: ["source.ts"],
        }) + "\nbody edit, no re-stamp\n",
        "2026-03-01T00:00:00Z",
      );

      const shallowDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "okf-kit-shallow-inwindow-"),
      );
      try {
        execFileSync(
          "git",
          [
            "clone",
            "--quiet",
            "--depth",
            "2",
            `file://${repo.dir}`,
            shallowDir,
          ],
          { encoding: "utf8" },
        );
        const isShallow = execFileSync(
          "git",
          ["rev-parse", "--is-shallow-repository"],
          { cwd: shallowDir, encoding: "utf8" },
        ).trim();
        expect(isShallow).toBe("true");

        const shallowCtx = loadBundle(
          path.join(shallowDir, "bundle"),
          shallowDir,
        );
        const shallowFindings = sourcesFreshRule.run(shallowCtx);

        expect(shallowFindings).toHaveLength(1);
        expect(shallowFindings[0]).toMatchObject({
          ruleId: "sources-fresh",
          severity: "warning",
          file: "doc.md",
        });
        expect(shallowFindings[0].message).toContain("STALE");
        expect(shallowFindings[0].message).not.toContain("not assessable");
      } finally {
        fs.rmSync(shallowDir, { recursive: true, force: true });
      }
    });
  });
});

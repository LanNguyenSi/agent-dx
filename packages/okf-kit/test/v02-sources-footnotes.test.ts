import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/cli.js";
import type { Finding } from "../src/types.js";
import { FIXTURES_DIR } from "./helpers.js";
import { createTmpGitRepo, type TmpGitRepo } from "./git-helpers.js";

// The OKF v0.2 migration path end to end, through the real `check` pipeline
// against a real git history: a bundle with `generated.at`, mapping
// `sources` and `[^id]` footnotes is clean, and each defect class produces
// exactly one finding from the rule that owns it.

const FIXTURE = path.join(FIXTURES_DIR, "v02-mappings-footnotes");

function fixtureFile(rel: string): string {
  return fs.readFileSync(path.join(FIXTURE, rel), "utf8");
}

const SRC_DATE = "2026-05-01T00:00:00Z";
const DOC_DATE = "2026-06-02T00:00:00Z";

describe("v0.2 sources mappings + footnotes, end to end", () => {
  let repo: TmpGitRepo;

  beforeEach(() => {
    repo = createTmpGitRepo();
    repo.commitFiles(
      [
        { relPath: "src/client.ts", content: fixtureFile("src/client.ts") },
        { relPath: "src/helper.ts", content: fixtureFile("src/helper.ts") },
      ],
      SRC_DATE,
    );
  });

  afterEach(() => {
    repo.cleanup();
  });

  function commitBundle(clientDoc: string = fixtureFile("docs/client.md")) {
    repo.commitFiles(
      [
        { relPath: "docs/index.md", content: fixtureFile("docs/index.md") },
        { relPath: "docs/client.md", content: clientDoc },
      ],
      DOC_DATE,
    );
  }

  function check(): Finding[] {
    return runCheck(path.join(repo.dir, "docs"), { repoRoot: repo.dir })
      .findings;
  }

  function ruleIds(findings: Finding[]): string[] {
    return findings.map((f) => f.ruleId).sort();
  }

  /** Makes src/client.ts newer than the doc's stamp and its own last commit. */
  function touchClientSource(): void {
    repo.commitFile(
      "src/client.ts",
      `${fixtureFile("src/client.ts")}// later edit\n`,
      "2026-06-03T00:00:00Z",
    );
  }

  const NO_RESOURCE = "  - title: entry without a resource\n";
  const withExtraSource = (entry: string): string =>
    fixtureFile("docs/client.md").replace(
      "---\n\n# Client",
      `${entry}---\n\n# Client`,
    );
  const withDanglingFootnote = (doc: string): string =>
    doc.replace("[^retry]: Retry", "Extra claim.[^ghost]\n\n[^retry]: Retry");

  it("checks clean: generated.at, mapping sources, footnotes, a line citation, a URL resource", () => {
    commitBundle();
    const result = runCheck(path.join(repo.dir, "docs"), {
      repoRoot: repo.dir,
    });
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("(a) a stale mapping source gives exactly one STALE finding", () => {
    commitBundle();
    touchClientSource();
    const findings = check();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "warning",
      file: "client.md",
    });
    expect(findings[0].message).toContain("STALE: `src/client.ts`");
  });

  it("(b) a mapping entry without resource gives exactly one finding", () => {
    commitBundle(withExtraSource(NO_RESOURCE));
    const findings = check();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-shape",
      severity: "error",
      file: "client.md",
    });
  });

  it("(c) a dangling footnote gives exactly one finding", () => {
    commitBundle(withDanglingFootnote(fixtureFile("docs/client.md")));
    const findings = check();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "footnotes-resolve",
      severity: "error",
      file: "client.md",
    });
    expect(findings[0].message).toContain("[^ghost]");
  });

  it("an unreferenced sources entry with an id gives exactly one warning", () => {
    commitBundle(
      withExtraSource("  - id: spare\n    resource: src/helper.ts\n"),
    );
    const findings = check();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "footnotes-resolve",
      severity: "warning",
      file: "client.md",
    });
    expect(findings[0].message).toContain("[^spare]");
  });

  it("(a)+(b)+(c) together give one finding per rule, none hiding another", () => {
    commitBundle(withDanglingFootnote(withExtraSource(NO_RESOURCE)));
    touchClientSource();
    const findings = check();
    expect(ruleIds(findings)).toEqual([
      "footnotes-resolve",
      "sources-fresh",
      "sources-shape",
    ]);
  });

  it("a doc that re-stamps in the same commit as the source edit is fresh (historical blobs resolve mapping entries)", () => {
    commitBundle();
    repo.commitFiles(
      [
        {
          relPath: "src/client.ts",
          content: `${fixtureFile("src/client.ts")}// later edit\n`,
        },
        {
          relPath: "docs/client.md",
          content: fixtureFile("docs/client.md").replace(
            "2026-06-01T00:00:00Z",
            "2026-06-03T00:00:00Z",
          ),
        },
      ],
      "2026-06-03T00:00:00Z",
    );
    expect(check()).toEqual([]);
  });

  it("the same co-commit WITHOUT a re-stamp stays stale for a mapping source", () => {
    commitBundle();
    repo.commitFiles(
      [
        {
          relPath: "src/client.ts",
          content: `${fixtureFile("src/client.ts")}// later edit\n`,
        },
        {
          relPath: "docs/client.md",
          content: `${fixtureFile("docs/client.md")}\nA touched-up sentence.\n`,
        },
      ],
      "2026-06-03T00:00:00Z",
    );
    const findings = check();
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("STALE: `src/client.ts`");
  });

  it("a doc whose only source is a URL resource raises no existence, staleness or untracked finding", () => {
    repo.commitFiles(
      [
        {
          relPath: "docs/index.md",
          content: fixtureFile("docs/index.md").replace("client.md", "web.md"),
        },
        {
          relPath: "docs/web.md",
          content:
            "---\ntype: concept\ngenerated:\n  by: okf-kit/0.19.0\n  at: 2026-06-01T00:00:00Z\nsources:\n  - id: spec\n    resource: https://example.com/spec\n---\n\n# Web\n\nClaim.[^spec]\n\n[^spec]: The spec.\n",
        },
      ],
      DOC_DATE,
    );
    expect(check()).toEqual([]);
  });
});

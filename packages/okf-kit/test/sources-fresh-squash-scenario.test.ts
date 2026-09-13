import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { sourcesFreshRule } from "../src/rules/sources-fresh.js";
import {
  createTmpGitRepo,
  docContent,
  type TmpGitRepo,
} from "./git-helpers.js";

const BASE = "2026-01-01T00:00:00Z";
const SQUASH = "2026-03-01T00:00:00Z";
const DOC = "bundle/doc.md";

function document(timestamp: string, body = ""): string {
  return (
    docContent({
      type: "concept",
      timestamp,
      sources: ["src/one.ts", "src/two.ts"],
    }) + body
  );
}

function squashFixture(): { repo: TmpGitRepo; squash: string } {
  const repo = createTmpGitRepo();
  repo.commitFiles(
    [
      { relPath: DOC, content: document(BASE) },
      { relPath: "src/one.ts", content: "export const one = 1;\n" },
      { relPath: "src/two.ts", content: "export const two = 1;\n" },
    ],
    BASE,
  );
  repo.gitAt(["branch", "b"], BASE);
  repo.gitAt(["checkout", "--quiet", "-b", "a"], BASE);
  repo.commitFiles(
    [
      { relPath: DOC, content: document("2026-02-01T00:00:00Z") },
      { relPath: "src/one.ts", content: "export const one = 2;\n" },
    ],
    "2026-02-15T00:00:00Z",
  );
  repo.gitAt(["checkout", "--quiet", "main"], BASE);
  repo.gitAt(["merge", "--squash", "a"], SQUASH);
  repo.gitAt(["commit", "--quiet", "-m", "S"], SQUASH);
  return { repo, squash: repo.git(["rev-parse", "HEAD"]) };
}

function mergeMain(repo: TmpGitRepo, at: string): void {
  repo.gitAt(["merge", "--no-ff", "--no-commit", "main"], at);
}

function assertFindings(repo: TmpGitRepo, name: string, stale: string[]): void {
  const findings = sourcesFreshRule.run(
    loadBundle(path.join(repo.dir, "bundle"), repo.dir),
  );
  if (stale.length === 0) {
    expect(findings, name).toEqual([]);
    return;
  }

  expect(findings, name).toHaveLength(stale.length);
  expect(
    findings.every(
      (finding) =>
        finding.ruleId === "sources-fresh" &&
        finding.severity === "warning" &&
        finding.file === "doc.md" &&
        finding.message.startsWith("STALE:"),
    ),
    name,
  ).toBe(true);
  expect(
    findings
      .map(
        (finding) => finding.message.match(/STALE: `?([^`\s]+)`? changed/)?.[1],
      )
      .filter((source): source is string => source !== undefined)
      .sort(),
    name,
  ).toEqual(stale);
}

describe("sources-fresh: documented two-branch squash scenario", () => {
  it("pins S, all branch verdicts, their resolved doc commits, and the re-stamp rescue", () => {
    const scenarios: Array<{
      name: string;
      repo: TmpGitRepo;
      docCommit: string;
      stale: string[];
    }> = [];

    try {
      // B1: B never touched the doc, so history simplification resolves it to S.
      {
        const { repo, squash } = squashFixture();
        repo.gitAt(["checkout", "--quiet", "b"], BASE);
        repo.gitAt(
          ["merge", "--no-ff", "--no-edit", "main"],
          "2026-04-01T00:00:00Z",
        );
        scenarios.push({ name: "B1", repo, docCommit: squash, stale: [] });
      }

      // B2 and B2late retain B's own stamp across the merge. B2late's doc
      // commit is after S but its stamp is before S, so only the epoch-gated
      // value-level re-stamp exception can make it clean.
      for (const [name, editAt, stamp, stale] of [
        ["B2", "2026-02-01T00:00:00Z", "2026-01-15T00:00:00Z", ["src/one.ts"]],
        ["B2late", "2026-04-01T00:00:00Z", "2026-01-15T00:00:00Z", []],
      ] as const) {
        const { repo } = squashFixture();
        repo.gitAt(["checkout", "--quiet", "b"], BASE);
        repo.commitFile(
          DOC,
          document(stamp, `${name} owns this edit.\n`),
          editAt,
        );
        const ownDocCommit = repo.git(["rev-parse", "HEAD"]);
        expect(() => mergeMain(repo, "2026-05-01T00:00:00Z")).toThrow();
        repo.gitAt(["checkout", "--theirs", DOC], "2026-05-01T00:00:00Z");
        repo.gitAt(["checkout", "--ours", DOC], "2026-05-01T00:00:00Z");
        repo.gitAt(["add", DOC], "2026-05-01T00:00:00Z");
        repo.gitAt(["commit", "--quiet", "--no-edit"], "2026-05-01T00:00:00Z");
        scenarios.push({
          name,
          repo,
          docCommit: ownDocCommit,
          stale: [...stale],
        });
      }

      // B2a resolves to S's re-stamped doc; B2b creates a third doc value
      // with B's unchanged stamp, making the merge itself the resolved commit.
      {
        const { repo, squash } = squashFixture();
        repo.gitAt(["checkout", "--quiet", "b"], BASE);
        repo.commitFile(
          DOC,
          document("2026-01-15T00:00:00Z", "B2a edit.\n"),
          "2026-02-01T00:00:00Z",
        );
        expect(() => mergeMain(repo, "2026-05-01T00:00:00Z")).toThrow();
        repo.gitAt(["checkout", "--theirs", DOC], "2026-05-01T00:00:00Z");
        repo.gitAt(["add", DOC], "2026-05-01T00:00:00Z");
        repo.gitAt(["commit", "--quiet", "--no-edit"], "2026-05-01T00:00:00Z");
        scenarios.push({ name: "B2a", repo, docCommit: squash, stale: [] });
      }
      {
        const { repo } = squashFixture();
        repo.gitAt(["checkout", "--quiet", "b"], BASE);
        repo.commitFile(
          DOC,
          document("2026-01-15T00:00:00Z", "B2b edit.\n"),
          "2026-02-01T00:00:00Z",
        );
        expect(() => mergeMain(repo, "2026-05-01T00:00:00Z")).toThrow();
        repo.commitFile(
          DOC,
          document("2026-01-15T00:00:00Z", "B2b resolution.\n"),
          "2026-05-01T00:00:00Z",
        );
        const mergeCommit = repo.git(["rev-parse", "HEAD"]);
        scenarios.push({
          name: "B2b",
          repo,
          docCommit: mergeCommit,
          stale: ["src/one.ts"],
        });
      }

      // B3 changes only the second source after S. N1 changes the doc after
      // S without moving its stamp; N3 proves the timestamp comparison still
      // wins when a source is newer than that doc commit.
      {
        const { repo, squash } = squashFixture();
        repo.gitAt(["checkout", "--quiet", "b"], BASE);
        repo.gitAt(
          ["merge", "--no-ff", "--no-edit", "main"],
          "2026-04-01T00:00:00Z",
        );
        repo.commitFile(
          "src/two.ts",
          "export const two = 2;\n",
          "2026-06-01T00:00:00Z",
        );
        scenarios.push({
          name: "B3",
          repo,
          docCommit: squash,
          stale: ["src/two.ts"],
        });
      }
      {
        const { repo } = squashFixture();
        repo.gitAt(["checkout", "--quiet", "b"], BASE);
        repo.gitAt(
          ["merge", "--no-ff", "--no-edit", "main"],
          "2026-04-01T00:00:00Z",
        );
        repo.commitFile(
          DOC,
          document("2026-02-01T00:00:00Z", "N1 prose only.\n"),
          "2026-05-01T00:00:00Z",
        );
        scenarios.push({
          name: "N1",
          repo,
          docCommit: repo.git(["rev-parse", "HEAD"]),
          stale: ["src/one.ts"],
        });
      }
      {
        const { repo } = squashFixture();
        repo.gitAt(["checkout", "--quiet", "b"], BASE);
        repo.gitAt(
          ["merge", "--no-ff", "--no-edit", "main"],
          "2026-04-01T00:00:00Z",
        );
        repo.commitFile(
          DOC,
          document("2026-07-01T00:00:00Z", "N3 prose only.\n"),
          "2026-05-01T00:00:00Z",
        );
        const docCommit = repo.git(["rev-parse", "HEAD"]);
        repo.commitFile(
          "src/two.ts",
          "export const two = 2;\n",
          "2026-06-01T00:00:00Z",
        );
        scenarios.push({ name: "N3", repo, docCommit, stale: [] });
      }

      for (const scenario of scenarios) {
        expect(
          scenario.repo.git(["log", "-1", "--format=%H", "--", DOC]),
          scenario.name,
        ).toBe(scenario.docCommit);
        assertFindings(scenario.repo, scenario.name, scenario.stale);

        if (scenario.stale.length > 0) {
          scenario.repo.commitFile(
            DOC,
            document("2026-12-01T00:00:00Z", `${scenario.name} re-verified.\n`),
            "2026-12-15T00:00:00Z",
          );
          const rescuedDocCommit = scenario.repo.git(["rev-parse", "HEAD"]);
          expect(
            scenario.repo.git(["log", "-1", "--format=%H", "--", DOC]),
            `${scenario.name} rescue`,
          ).toBe(rescuedDocCommit);
          assertFindings(scenario.repo, `${scenario.name} rescue`, []);
        }
      }
    } finally {
      for (const scenario of scenarios) scenario.repo.cleanup();
    }
  }, 15_000);
});

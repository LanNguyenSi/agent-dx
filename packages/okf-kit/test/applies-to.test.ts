import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { runDocsFor } from "../src/docs-for.js";
import {
  sourcesFreshFutureRule,
  sourcesFreshRule,
} from "../src/rules/sources-fresh.js";
import { runbookTemplate } from "../src/templates.js";
import { sourcesShapeRule } from "../src/rules/sources-shape.js";
import { CLI_PATH, runCli } from "./helpers.js";
import {
  createTmpGitRepo,
  docContent,
  writeDoc,
  type TmpGitRepo,
} from "./git-helpers.js";

describe("applies_to", () => {
  let repo: TmpGitRepo;

  beforeEach(() => {
    repo = createTmpGitRepo();
    repo.commitFile("templates/a.md", "template a\n", "2025-01-01T00:00:00Z");
  });

  afterEach(() => {
    repo.cleanup();
  });

  const bundleDir = () => path.join(repo.dir, "bundle");

  it("docs-for returns a doc whose applies_to directory contains the given file, via applies_to", () => {
    writeDoc(repo.dir, "bundle/runbook.md", {
      type: "runbook",
      timestamp: "2025-06-01T00:00:00Z",
      applies_to: ["templates"],
    });
    const result = runDocsFor(bundleDir(), ["templates/a.md"], {
      repoRoot: repo.dir,
    });
    expect(result.matches).toEqual([
      {
        doc: "runbook.md",
        sources: [],
        appliesTo: ["templates"],
        via: ["applies_to"],
      },
    ]);
  });

  it("docs-for does not match an applies_to directory against a sibling sharing its name prefix", () => {
    repo.commitFile("templates2/b.md", "b\n", "2025-01-01T00:00:00Z");
    writeDoc(repo.dir, "bundle/runbook.md", {
      type: "runbook",
      timestamp: "2025-06-01T00:00:00Z",
      applies_to: ["templates"],
    });
    const result = runDocsFor(bundleDir(), ["templates2/b.md"], {
      repoRoot: repo.dir,
    });
    expect(result.matches).toEqual([]);
  });

  it("docs-for reports a doc matching through both fields once, with both entries and both vias", () => {
    repo.commitFile("src/x.ts", "x\n", "2025-01-01T00:00:00Z");
    writeDoc(repo.dir, "bundle/both.md", {
      type: "runbook",
      timestamp: "2025-06-01T00:00:00Z",
      sources: ["src/x.ts"],
      applies_to: ["src"],
    });
    const result = runDocsFor(bundleDir(), ["src/x.ts"], {
      repoRoot: repo.dir,
    });
    expect(result.matches).toEqual([
      {
        doc: "both.md",
        sources: ["src/x.ts"],
        appliesTo: ["src"],
        via: ["sources", "applies_to"],
      },
    ]);
  });

  it("docs-for --json carries via and the matched applies_to entries", () => {
    writeDoc(repo.dir, "bundle/runbook.md", {
      type: "runbook",
      timestamp: "2025-06-01T00:00:00Z",
      applies_to: ["templates"],
    });
    expect(fs.existsSync(CLI_PATH)).toBe(true);
    const result = runCli([
      "docs-for",
      bundleDir(),
      "templates/a.md",
      "--repo-root",
      repo.dir,
      "--json",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      matches: Array<{ doc: string; via: string[]; appliesTo?: string[] }>;
    };
    expect(parsed.matches).toEqual([
      {
        doc: "runbook.md",
        sources: [],
        appliesTo: ["templates"],
        via: ["applies_to"],
      },
    ]);
    const text = runCli([
      "docs-for",
      bundleDir(),
      "templates/a.md",
      "--repo-root",
      repo.dir,
    ]);
    expect(text.stdout).toBe("runbook.md: applies_to: templates\n");
  });

  it("docs-for text output joins sources and applies_to entries with a semicolon", () => {
    repo.commitFile("src/x.ts", "x\n", "2025-01-01T00:00:00Z");
    writeDoc(repo.dir, "bundle/both.md", {
      type: "runbook",
      timestamp: "2025-06-01T00:00:00Z",
      sources: ["src/x.ts"],
      applies_to: ["src"],
    });
    const text = runCli([
      "docs-for",
      bundleDir(),
      "src/x.ts",
      "--repo-root",
      repo.dir,
    ]);
    expect(text.status).toBe(0);
    expect(text.stdout).toBe("both.md: src/x.ts; applies_to: src\n");
  });

  describe("a doc with fresh sources and an applies_to directory changed after its timestamp", () => {
    // sources are unchanged since the doc timestamp; only the applies_to
    // directory moved on. applies_to must never feed the staleness rules.
    const writeBoth = (): void => {
      repo.commitFile("src/x.ts", "x\n", "2025-01-01T00:00:00Z");
      repo.commitFile(
        "templates/a.md",
        "template a, edited\n",
        "2026-01-01T00:00:00Z",
      );
      repo.commitFile(
        "bundle/both.md",
        docContent({
          type: "runbook",
          timestamp: "2025-06-01T00:00:00Z",
          sources: ["src/x.ts"],
          applies_to: ["templates"],
        }),
        "2025-06-01T00:00:00Z",
      );
    };

    it("sources-fresh does not flag it STALE", () => {
      writeBoth();
      const findings = sourcesFreshRule.run(loadBundle(bundleDir(), repo.dir));
      expect(findings).toEqual([]);
    });

    it("sources-fresh-future does not flag it", () => {
      writeBoth();
      const findings = sourcesFreshFutureRule.run(
        loadBundle(bundleDir(), repo.dir),
      );
      expect(findings).toEqual([]);
    });

    it("sources-fresh does not flag it with --dirty-as-now and an uncommitted edit in the applies_to directory", () => {
      writeBoth();
      fs.writeFileSync(
        path.join(repo.dir, "templates/a.md"),
        "template a, dirty\n",
      );
      const ctx = loadBundle(bundleDir(), repo.dir);
      ctx.dirtyAsNow = true;
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });
  });

  it("a change inside an applies_to directory after the doc timestamp does NOT make the doc stale", () => {
    repo.commitFile(
      "templates/a.md",
      "template a, edited\n",
      "2026-01-01T00:00:00Z",
    );
    writeDoc(repo.dir, "bundle/runbook.md", {
      type: "runbook",
      timestamp: "2025-06-01T00:00:00Z",
      applies_to: ["templates"],
    });
    const findings = sourcesFreshRule.run(loadBundle(bundleDir(), repo.dir));
    expect(findings.filter((f) => f.message.includes("STALE"))).toEqual([]);
  });

  it("the same directory under sources DOES make the doc stale (control for the test above)", () => {
    repo.commitFile(
      "templates/a.md",
      "template a, edited\n",
      "2026-01-01T00:00:00Z",
    );
    writeDoc(repo.dir, "bundle/runbook.md", {
      type: "runbook",
      timestamp: "2025-06-01T00:00:00Z",
      sources: ["templates"],
    });
    const findings = sourcesFreshRule.run(loadBundle(bundleDir(), repo.dir));
    expect(findings.filter((f) => f.message.includes("STALE"))).toHaveLength(1);
  });

  it("sources-shape flags a missing applies_to path as an error, like a missing source", () => {
    writeDoc(repo.dir, "bundle/runbook.md", {
      type: "runbook",
      applies_to: ["templates", "does/not/exist"],
    });
    writeDoc(repo.dir, "bundle/other.md", {
      type: "concept",
      sources: ["does/not/exist"],
    });
    const findings = sourcesShapeRule.run(loadBundle(bundleDir(), repo.dir));
    const forRunbook = findings.filter((f) => f.file === "runbook.md");
    const forOther = findings.filter((f) => f.file === "other.md");
    expect(forRunbook).toHaveLength(1);
    expect(forRunbook[0]).toMatchObject({
      ruleId: "sources-shape",
      severity: "error",
    });
    expect(forRunbook[0].message).toContain("does/not/exist");
    expect(forRunbook[0].message).toContain("applies_to");
    expect(forOther).toHaveLength(1);
    expect(forOther[0].severity).toBe(forRunbook[0].severity);
  });

  it.each([
    ["a string instead of an array", "templates"],
    ["an empty array", []],
    ["an empty-string entry", ["templates", ""]],
    ["a non-string entry", [3]],
  ])("sources-shape flags a malformed applies_to (%s)", (_name, value) => {
    writeDoc(repo.dir, "bundle/runbook.md", {
      type: "runbook",
      applies_to: value,
    });
    const findings = sourcesShapeRule.run(loadBundle(bundleDir(), repo.dir));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-shape",
      severity: "error",
      file: "runbook.md",
    });
    expect(findings[0].message).toContain("`applies_to`");
  });

  it("an applies_to entry escaping the repo root is judged exactly like an escaping sources entry", () => {
    const escaping = "../okf-kit-applies-to-no-such-path.ts";
    writeDoc(repo.dir, "bundle/via-sources.md", {
      type: "concept",
      sources: [escaping],
    });
    writeDoc(repo.dir, "bundle/via-applies-to.md", {
      type: "runbook",
      applies_to: [escaping],
    });
    const findings = sourcesShapeRule.run(loadBundle(bundleDir(), repo.dir));
    const fromSources = findings.filter((f) => f.file === "via-sources.md");
    const fromAppliesTo = findings.filter(
      (f) => f.file === "via-applies-to.md",
    );
    expect(fromSources).toHaveLength(1);
    expect(fromAppliesTo).toHaveLength(1);
    expect(fromAppliesTo[0].severity).toBe(fromSources[0].severity);
    expect(fromAppliesTo[0].message).toContain(escaping);
  });

  it("an existing escaping entry gets the same verdict from both fields (no finding), pinning parity", () => {
    const outside = path.join(
      path.dirname(repo.dir),
      "okf-kit-applies-to-outside.txt",
    );
    fs.writeFileSync(outside, "x\n");
    try {
      const escaping = `../${path.basename(outside)}`;
      writeDoc(repo.dir, "bundle/via-sources.md", {
        type: "concept",
        sources: [escaping],
      });
      writeDoc(repo.dir, "bundle/via-applies-to.md", {
        type: "runbook",
        applies_to: [escaping],
      });
      const findings = sourcesShapeRule.run(loadBundle(bundleDir(), repo.dir));
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("a bundle without applies_to yields docs-for entries with only doc, sources and via", () => {
    repo.commitFile("src/y.ts", "y\n", "2025-01-01T00:00:00Z");
    writeDoc(repo.dir, "bundle/plain.md", {
      type: "concept",
      timestamp: "2025-06-01T00:00:00Z",
      sources: ["src/y.ts"],
    });
    const result = runDocsFor(bundleDir(), ["src/y.ts"], {
      repoRoot: repo.dir,
    });
    expect(result.matches).toEqual([
      { doc: "plain.md", sources: ["src/y.ts"], via: ["sources"] },
    ]);
  });

  it("the runbook scaffold wires paths through applies_to and explains when to use sources", () => {
    const content = runbookTemplate("2026-01-01T00:00:00Z");
    expect(content).toContain("applies_to:\n  - path/to/covered/source");
    expect(content).not.toMatch(/^sources:/m);
    expect(content).toContain("Use \`sources\` instead");
  });
});

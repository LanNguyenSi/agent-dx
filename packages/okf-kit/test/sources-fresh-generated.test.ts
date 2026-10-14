import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { runCheck } from "../src/cli.js";
import {
  sourcesFreshFutureRule,
  sourcesFreshRule,
} from "../src/rules/sources-fresh.js";
import {
  createTmpGitRepo,
  docContent,
  writeDoc,
  type TmpGitRepo,
} from "./git-helpers.js";

// The OKF v0.2 `generated: { by, at }` stamp against the freshness rules:
// `generated.at` is the effective stamp when present, `timestamp` remains
// the fallback, and a re-stamp that MOVES BETWEEN the two keys must be
// judged by the same effective stamp on BOTH sides of the commit boundary
// (the historical-blob side of the re-stamp check parses old blobs, so a
// helper that only learned `generated.at` on the current-file path would
// misjudge exactly the cases pinned below).

function writeV02Index(repo: TmpGitRepo): void {
  writeDoc(repo.dir, "bundle/index.md", { okf_version: "0.2" });
}

function bundleDirOf(repo: TmpGitRepo): string {
  return path.join(repo.dir, "bundle");
}

describe("v0.2 generated.at freshness", () => {
  let repo: TmpGitRepo;

  beforeEach(() => {
    repo = createTmpGitRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("a v0.2 bundle with okf_version and generated.at checks clean", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-01T00:00:00Z",
    );
    writeV02Index(repo);
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      sources: ["source.ts"],
      generated: { by: "okf-kit/0.19.0", at: "2026-01-05T00:00:00Z" },
    });

    const result = runCheck(bundleDirOf(repo), { repoRoot: repo.dir });
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("the same bundle checked with --spec v0.1 reports the version block again", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-01T00:00:00Z",
    );
    writeV02Index(repo);
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      sources: ["source.ts"],
      generated: { by: "okf-kit/0.19.0", at: "2026-01-05T00:00:00Z" },
    });

    const result = runCheck(bundleDirOf(repo), {
      repoRoot: repo.dir,
      spec: "v0.1",
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: "reserved-files-bare",
      severity: "error",
      file: "index.md",
    });
  });

  it("a stale generated.at gives exactly one STALE finding", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-06T00:00:00Z",
    );
    writeV02Index(repo);
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      sources: ["source.ts"],
      generated: { by: "okf-kit/0.19.0", at: "2026-01-05T00:00:00Z" },
    });

    const findings = sourcesFreshRule.run(
      loadBundle(bundleDirOf(repo), repo.dir),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "warning",
    });
    expect(findings[0].message).toContain("STALE");
  });

  it("a future generated.at gives exactly one FUTURE-DATED finding", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-12-15T00:00:00Z",
    );
    writeV02Index(repo);
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        sources: ["source.ts"],
        generated: { by: "okf-kit/0.19.0", at: "2026-01-02T00:00:00Z" },
      }),
      "2026-01-01T00:00:00Z",
    );

    const findings = sourcesFreshFutureRule.run(
      loadBundle(bundleDirOf(repo), repo.dir),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh-future",
      severity: "warning",
    });
    expect(findings[0].message).toContain("FUTURE-DATED");
  });

  it("a generated.at without an offset under v0.2 is exactly one finding (the error, not the skip notice too)", () => {
    // The doc's source was committed at the very instant the designator-less
    // stamp resolves to (UTC-forced), so neither freshness rule adds
    // anything and the full runCheck must report the single generated-shape
    // error: the future rule's designator-less skip notice is suppressed
    // precisely because the error already names the same value.
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-05T00:00:00Z",
    );
    writeV02Index(repo);
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      sources: ["source.ts"],
      generated: { by: "okf-kit/0.19.0", at: "2026-01-05T00:00:00" },
    });

    const result = runCheck(bundleDirOf(repo), { repoRoot: repo.dir });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: "generated-shape",
      severity: "error",
      file: "doc.md",
    });
  });

  it("differing timestamp and generated.at give exactly one finding, and generated.at is the stamp the rules read", () => {
    // The source predates generated.at (Jan 5) but NOT timestamp (Jan 10 is
    // even newer), so a fresh verdict under generated.at is fresh full
    // stop; the only finding is the divergence warning.
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-12-20T00:00:00Z",
    );
    writeV02Index(repo);
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      sources: ["source.ts"],
      timestamp: "2026-01-10T00:00:00Z",
      generated: { by: "okf-kit/0.19.0", at: "2026-01-05T00:00:00Z" },
    });

    const result = runCheck(bundleDirOf(repo), { repoRoot: repo.dir });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: "generated-shape",
      severity: "warning",
    });
    expect(result.findings[0].message).toContain("name different instants");
  });

  it("a re-stamp from timestamp to a LATER generated.at counts as a re-stamp on the co-commit path", () => {
    // Doc commit 1 stamps Jan 2 (timestamp), the source lands Jan 5, doc
    // commit 2 migrates the stamp to generated.at Jan 3 -- strictly later
    // than Jan 2 (a real forward move) but still before the source. The
    // re-stamp check must read Jan 3 from the CURRENT blob's generated.at
    // and Jan 2 from the PARENT blob's timestamp -- one effective stamp per
    // side, read from different keys -- and call it re-stamped.
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-05T00:00:00Z",
    );
    writeV02Index(repo);
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        sources: ["source.ts"],
        timestamp: "2026-01-02T00:00:00Z",
      }),
      "2026-01-04T00:00:00Z",
    );
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        sources: ["source.ts"],
        generated: { by: "okf-kit/0.19.0", at: "2026-01-03T00:00:00Z" },
      }),
      "2026-01-06T00:00:00Z",
    );

    const findings = sourcesFreshRule.run(
      loadBundle(bundleDirOf(repo), repo.dir),
    );
    expect(findings).toEqual([]);
  });

  it("a re-stamp from timestamp to an EARLIER generated.at is a backwards move, not a re-stamp", () => {
    // Without generated.at support on the historical-blob side the current
    // value would read as "no timestamp at all" and the doc would get a
    // no-valid-timestamp notice instead of its STALE + backwards verdict.
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-03T00:00:00Z",
    );
    writeV02Index(repo);
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        sources: ["source.ts"],
        timestamp: "2026-01-05T00:00:00Z",
      }),
      "2026-01-04T00:00:00Z",
    );
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        sources: ["source.ts"],
        generated: { by: "okf-kit/0.19.0", at: "2026-01-02T00:00:00Z" },
      }),
      "2026-01-06T00:00:00Z",
    );

    const findings = sourcesFreshRule.run(
      loadBundle(bundleDirOf(repo), repo.dir),
    );
    expect(findings).toHaveLength(2);
    const messages = findings.map((f) => f.message).join("\n");
    expect(messages).toContain("STALE");
    expect(messages).toContain("re-stamp moved backwards");
  });

  it("a same-instant rewrite from timestamp into generated.at is a rewrite, not a re-stamp", () => {
    // Same instant, different key: the timestamp identity carries the
    // generated-at provenance prefix, so this is the D-009 same-instant
    // notice (the stamp was touched but never moved), not "restamped".
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-02T00:00:00Z",
    );
    writeV02Index(repo);
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        sources: ["source.ts"],
        timestamp: "2026-01-01T00:00:00Z",
      }),
      "2026-01-01T12:00:00Z",
    );
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        sources: ["source.ts"],
        generated: { by: "okf-kit/0.19.0", at: "2026-01-01T00:00:00Z" },
      }),
      "2026-01-03T00:00:00Z",
    );

    const findings = sourcesFreshRule.run(
      loadBundle(bundleDirOf(repo), repo.dir),
    );
    expect(findings).toHaveLength(2);
    const messages = findings.map((f) => f.message).join("\n");
    expect(messages).toContain("STALE");
    expect(messages).toContain("re-stamp did not move the timestamp forward");
  });

  it("falls back to timestamp when generated.at is absent (v0.2 bundle, timestamp-only doc)", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-06T00:00:00Z",
    );
    writeV02Index(repo);
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      sources: ["source.ts"],
      timestamp: "2026-01-05T00:00:00Z",
    });

    const findings = sourcesFreshRule.run(
      loadBundle(bundleDirOf(repo), repo.dir),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("STALE");
  });
});

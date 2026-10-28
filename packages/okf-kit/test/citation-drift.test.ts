import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck, UsageError } from "../src/cli.js";
import {
  hunkTouchesRange,
  judge,
  lineShiftAbove,
  parseHunks,
} from "../src/citation-drift.js";
import type { ResolvedCitation } from "../src/rules/citations-resolve.js";
import { renderRepointText, runRepoint } from "../src/repoint.js";
import { createTmpGitRepo, type TmpGitRepo } from "./git-helpers.js";
import { runCli } from "./helpers.js";

const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";

/** `export const v01 = 1;` ... one distinct, non-blank, non-brace line each. */
function sourceLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return `export const v${n} = ${i + 1};`;
  });
}

const FRONTMATTER = "---\ntype: concept\n---\n\n";

const DOC_BODY = [
  "# Doc",
  "",
  "Alpha is `src/a.ts:6-8` and again `:10`.",
  "",
  "Beta is `src/a.ts:9`-`11`.",
  "",
  "Gamma is `src/a.ts:1-2`, and :6-7 here.",
  "",
  'Delta is `src/a.ts:5#"v05"` anchored.',
  "",
  "Epsilon is `src/b.ts:3` in an untouched file.",
  "",
  "Zeta is `src/a.ts:12` on an edited line.",
  "",
].join("\n");

const DOC = FRONTMATTER + DOC_BODY;

let repo: TmpGitRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

/** A repo whose base commit holds the doc, src/a.ts (12 lines) and src/b.ts. */
function baseRepo(): TmpGitRepo {
  repo = createTmpGitRepo();
  repo.commitFiles(
    [
      { relPath: "docs/okf/doc.md", content: DOC },
      { relPath: "src/a.ts", content: sourceLines(12).join("\n") + "\n" },
      { relPath: "src/b.ts", content: sourceLines(5).join("\n") + "\n" },
    ],
    T0,
  );
  return repo;
}

/** Inserts three lines after line 2 of src/a.ts and edits its line 12. */
function insertAboveAndEditLast(r: TmpGitRepo): void {
  const lines = sourceLines(12);
  lines[11] = "export const v12 = 'edited';";
  lines.splice(2, 0, "export const ins1 = 0;", "export const ins2 = 0;");
  lines.splice(4, 0, "export const ins3 = 0;");
  fs.writeFileSync(path.join(r.dir, "src/a.ts"), lines.join("\n") + "\n");
}

const bundle = (r: TmpGitRepo) => path.join(r.dir, "docs/okf");
const docPath = (r: TmpGitRepo) => path.join(r.dir, "docs/okf/doc.md");

function drift(r: TmpGitRepo, base = "HEAD") {
  return runCheck(bundle(r), {
    repoRoot: r.dir,
    base,
    rules: ["citation-drift"],
  }).findings;
}

const labelOf = (message: string): string => /^`([^`]+)`/.exec(message)![1];

describe("hunk mapping", () => {
  it("parses hunk headers, defaulting an omitted count to 1", () => {
    expect(
      parseHunks("@@ -5 +5,2 @@\n+a\n@@ -9,0 +11,3 @@\n+b\n@@ -20,2 +22,0 @@"),
    ).toEqual([
      { oldStart: 5, oldCount: 1, newStart: 5, newCount: 2 },
      { oldStart: 9, oldCount: 0, newStart: 11, newCount: 3 },
      { oldStart: 20, oldCount: 2, newStart: 22, newCount: 0 },
    ]);
  });

  it("an insertion touches a range only between two of its lines", () => {
    const insertAfter = (n: number) => ({
      oldStart: n,
      oldCount: 0,
      newStart: n + 1,
      newCount: 2,
    });
    expect(hunkTouchesRange(insertAfter(5), 6, 8)).toBe(false); // just before
    expect(hunkTouchesRange(insertAfter(6), 6, 8)).toBe(true);
    expect(hunkTouchesRange(insertAfter(7), 6, 8)).toBe(true);
    expect(hunkTouchesRange(insertAfter(8), 6, 8)).toBe(false); // just after
    expect(hunkTouchesRange(insertAfter(6), 6, 6)).toBe(false); // single line
  });

  it("a replaced or removed line touches a range that contains it", () => {
    const at = (start: number, count: number) => ({
      oldStart: start,
      oldCount: count,
      newStart: start,
      newCount: 0,
    });
    expect(hunkTouchesRange(at(5, 1), 6, 8)).toBe(false);
    expect(hunkTouchesRange(at(5, 2), 6, 8)).toBe(true); // 5-6 reaches line 6
    expect(hunkTouchesRange(at(8, 1), 6, 8)).toBe(true);
    expect(hunkTouchesRange(at(9, 1), 6, 8)).toBe(false);
  });

  it("shifts down for insertions above, up for removals above, and ignores hunks below", () => {
    const hunks = [
      { oldStart: 2, oldCount: 0, newStart: 3, newCount: 3 }, // +3 after line 2
      { oldStart: 10, oldCount: 4, newStart: 13, newCount: 0 }, // -4 at 10-13
    ];
    expect(lineShiftAbove(hunks, 1)).toBe(0);
    expect(lineShiftAbove(hunks, 3)).toBe(3);
    expect(lineShiftAbove(hunks, 10)).toBe(3);
    expect(lineShiftAbove(hunks, 14)).toBe(-1);
  });
});

describe("verdict", () => {
  const citation = (startLine: number, endLine: number): ResolvedCitation => ({
    docRelPath: "doc.md",
    kind: "full",
    label: `a.ts:${startLine}-${endLine}`,
    resolvedPath: "/repo/a.ts",
    startLine,
    endLine,
    startSpan: { offset: 0, length: 1 },
    endSpan: null,
  });
  const base = { ref: "base", sha: "0".repeat(40) };
  const oldLines = sourceLines(10);

  it("refuses a shift whose text does not match, even though no hunk touches the range", () => {
    // the hunks claim three lines were inserted above line 6, but the file
    // does not contain the cited text three lines further down
    const info = {
      oldLines,
      newLines: sourceLines(10).map((line, i) =>
        i === 5 || i === 6 ? "unrelated" : line,
      ),
      hunks: [{ oldStart: 2, oldCount: 0, newStart: 3, newCount: 3 }],
    };
    const verdict = judge(citation(6, 7), "a.ts", info, base);
    expect(verdict.status).toBe("changed");
    expect(verdict.reason).toContain("not found at the lines it should have");
  });

  it("accepts the shift once the text is there", () => {
    const newLines = [...oldLines];
    newLines.splice(2, 0, "x1", "x2", "x3");
    const info = {
      oldLines,
      newLines,
      hunks: [{ oldStart: 2, oldCount: 0, newStart: 3, newCount: 3 }],
    };
    const verdict = judge(citation(6, 7), "a.ts", info, base);
    expect(verdict).toMatchObject({
      status: "moved",
      newStartLine: 9,
      newEndLine: 10,
    });
  });

  it("skips a range that was not valid at the ref", () => {
    const info = { oldLines, newLines: oldLines, hunks: [] };
    expect(judge(citation(9, 12), "a.ts", info, base).status).toBe("skipped");
    expect(judge(citation(7, 6), "a.ts", info, base).status).toBe("skipped");
  });
});

describe("check --base", () => {
  it("reports every moved citation in primary, continuation, extension and short form, and the one an edit touched", () => {
    const r = baseRepo();
    insertAboveAndEditLast(r);
    const findings = drift(r);

    const byLabel = new Map(findings.map((f) => [labelOf(f.message), f]));
    expect([...byLabel.keys()].sort()).toEqual(
      [
        'src/a.ts:5#"v05"',
        "src/a.ts:6-8",
        "src/a.ts:10 (continuation)",
        "src/a.ts:9",
        "src/a.ts:9-11 (continuation)",
        "src/a.ts:6-7 (short-form)",
        "src/a.ts:12",
      ].sort(),
    );
    const moved = (label: string) => byLabel.get(label)!.message;
    expect(moved("src/a.ts:6-8")).toContain("now at lines 9-11");
    expect(moved("src/a.ts:6-8")).toContain("[citation-moved]");
    expect(moved("src/a.ts:10 (continuation)")).toContain("now at line 13");
    expect(moved("src/a.ts:9")).toContain("now at line 12");
    expect(moved("src/a.ts:9-11 (continuation)")).toContain(
      "now at lines 12-14",
    );
    expect(moved("src/a.ts:6-7 (short-form)")).toContain("now at lines 9-10");
    expect(moved('src/a.ts:5#"v05"')).toContain("now at line 8");

    const changed = byLabel.get("src/a.ts:12")!;
    expect(changed.message).toContain("[citation-content-changed]");
    expect(changed.message).toContain("edited, removed or interleaved");
    expect(findings.every((f) => f.ruleId === "citation-drift")).toBe(true);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
    expect(findings.every((f) => f.file === "doc.md")).toBe(true);
  });

  it("leaves a citation above the edit and a citation into an unchanged file alone", () => {
    const r = baseRepo();
    insertAboveAndEditLast(r);
    const labels = drift(r).map((f) => labelOf(f.message));
    expect(labels).not.toContain("src/a.ts:1-2");
    expect(labels).not.toContain("src/b.ts:3");
  });

  it("follows lines removed above a range (shift up)", () => {
    const r = baseRepo();
    const lines = sourceLines(12);
    lines.splice(1, 2); // drop v02, v03
    fs.writeFileSync(path.join(r.dir, "src/a.ts"), lines.join("\n") + "\n");
    const byLabel = new Map(
      drift(r).map((f) => [labelOf(f.message), f.message]),
    );
    expect(byLabel.get("src/a.ts:6-8")).toContain("now at lines 4-6");
    expect(byLabel.get("src/a.ts:10 (continuation)")).toContain(
      "now at line 8",
    );
    // line 1-2 lost line 2's neighbour? its range 1-2 is touched by the removal at 2-3
    expect(byLabel.get("src/a.ts:1-2")).toContain("[citation-content-changed]");
  });

  it("compares the committed edit against a tag or HEAD~1 the same way", () => {
    const r = baseRepo();
    r.git(["tag", "docs-written"]);
    insertAboveAndEditLast(r);
    r.commitFile(
      "src/a.ts",
      fs.readFileSync(path.join(r.dir, "src/a.ts"), "utf8"),
      T1,
    );
    expect(drift(r, "docs-written")).toHaveLength(7);
    expect(drift(r, "HEAD~1")).toHaveLength(7);
    // against HEAD itself nothing differs
    expect(drift(r, "HEAD")).toEqual([]);
  });

  it("reports nothing when no cited file changed", () => {
    const r = baseRepo();
    expect(drift(r)).toEqual([]);
  });

  it("does not judge a citation whose cited file did not exist at the ref", () => {
    const r = baseRepo();
    // the doc already cites src/c.ts:4, but the file only arrives later
    fs.writeFileSync(docPath(r), DOC + "\nTheta is `src/c.ts:4`.\n");
    r.commitFile("docs/okf/doc.md", fs.readFileSync(docPath(r), "utf8"), T1);
    r.git(["tag", "with-theta"]);
    fs.writeFileSync(
      path.join(r.dir, "src/c.ts"),
      sourceLines(6).join("\n") + "\n",
    );
    r.commitFile("src/c.ts", sourceLines(6).join("\n") + "\n", T1);
    expect(drift(r, "with-theta")).toEqual([]);
    const plan = runRepoint(bundle(r), { base: "with-theta", repoRoot: r.dir });
    expect(plan.skipped).toEqual([
      { reason: "src/c.ts did not exist at with-theta", count: 1 },
    ]);
    expect(plan.rewrites).toEqual([]);
  });

  it("does not judge a citation the doc did not carry at the ref", () => {
    const r = baseRepo();
    insertAboveAndEditLast(r);
    // written after the source edit, against the current file: valid as is
    fs.writeFileSync(
      docPath(r),
      DOC.replace("`src/a.ts:6-8`", "`src/a.ts:9-11`"),
    );
    const labels = drift(r).map((f) => labelOf(f.message));
    expect(labels).not.toContain("src/a.ts:9-11");
    expect(labels).not.toContain("src/a.ts:6-8");
  });

  it("still judges a citation whose sentence was reworded since the ref but kept its numbers", () => {
    const r = baseRepo();
    insertAboveAndEditLast(r);
    fs.writeFileSync(
      docPath(r),
      DOC.replace(
        "Beta is `src/a.ts:9`-`11`.",
        "Beta, reworded, is `src/a.ts:9`-`11`.",
      ),
    );
    const labels = drift(r).map((f) => labelOf(f.message));
    expect(labels).toContain("src/a.ts:9");
    expect(labels).toContain("src/a.ts:9-11 (continuation)");
  });

  it("does not judge reserved docs (log.md narrates past line numbers)", () => {
    const r = baseRepo();
    r.commitFile(
      "docs/okf/log.md",
      "# Log\n\n## 2026-01-01\n\n- cited `src/a.ts:6-8` back then\n",
      T1,
    );
    r.git(["tag", "with-log"]);
    insertAboveAndEditLast(r);
    const files = new Set(drift(r, "with-log").map((f) => f.file));
    expect(files).toEqual(new Set(["doc.md"]));
  });

  it("an unchanged doc that is new since the ref is not judged", () => {
    const r = baseRepo();
    insertAboveAndEditLast(r);
    fs.writeFileSync(path.join(bundle(r), "new.md"), DOC);
    const files = new Set(drift(r).map((f) => f.file));
    expect(files).toEqual(new Set(["doc.md"]));
  });

  it("does not follow a rename of a file the doc names by its old path (citations-resolve reports it as missing)", () => {
    const r = baseRepo();
    r.gitAt(["mv", "src/b.ts", "src/moved.ts"], T1);
    const result = runCheck(bundle(r), { repoRoot: r.dir, base: "HEAD" });
    expect(result.findings.some((f) => f.ruleId === "citation-drift")).toBe(
      false,
    );
    expect(
      result.findings.some(
        (f) =>
          f.ruleId === "citations-resolve" &&
          f.message.includes("[missing-file]"),
      ),
    ).toBe(true);
  });

  it("follows a rename for a citation that still resolves (bare basename)", () => {
    repo = createTmpGitRepo();
    const r = repo;
    r.commitFiles(
      [
        {
          relPath: "docs/okf/doc.md",
          content: FRONTMATTER + "Mover is `mover.ts:5-6`.\n",
        },
        { relPath: "src/mover.ts", content: sourceLines(8).join("\n") + "\n" },
      ],
      T0,
    );
    fs.mkdirSync(path.join(r.dir, "lib"), { recursive: true });
    r.gitAt(["mv", "src/mover.ts", "lib/mover.ts"], T1);
    const lines = sourceLines(8);
    lines.unshift("// header 1", "// header 2");
    fs.writeFileSync(path.join(r.dir, "lib/mover.ts"), lines.join("\n") + "\n");
    const findings = drift(r);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("`mover.ts:5-6`");
    expect(findings[0].message).toContain("now at lines 7-8");
  });

  it("without --base the rule is silent and the other findings are identical", () => {
    const r = baseRepo();
    insertAboveAndEditLast(r);
    const without = runCheck(bundle(r), { repoRoot: r.dir });
    const withBase = runCheck(bundle(r), { repoRoot: r.dir, base: "HEAD" });
    expect(
      without.findings.filter((f) => f.ruleId === "citation-drift"),
    ).toEqual([]);
    expect(
      withBase.findings.filter((f) => f.ruleId !== "citation-drift"),
    ).toEqual(without.findings);
  });

  it("an unknown ref is a usage error", () => {
    const r = baseRepo();
    expect(() =>
      runCheck(bundle(r), { repoRoot: r.dir, base: "no-such-ref" }),
    ).toThrow(UsageError);
    expect(() =>
      runCheck(bundle(r), { repoRoot: r.dir, base: "no-such-ref" }),
    ).toThrow(/not a commit/);
    expect(() => runCheck(bundle(r), { repoRoot: r.dir, base: "" })).toThrow(
      UsageError,
    );
    expect(() =>
      runCheck(bundle(r), { repoRoot: r.dir, base: "--all" }),
    ).toThrow(UsageError);
  });

  it("exits 2 with a clear error from the CLI on an invalid ref, for check and repoint", () => {
    const r = baseRepo();
    const check = runCli([
      "check",
      bundle(r),
      "--repo-root",
      r.dir,
      "--base",
      "no-such-ref",
    ]);
    expect(check.status).toBe(2);
    expect(check.stderr).toContain("`no-such-ref` is not a commit");
    const repoint = runCli([
      "repoint",
      bundle(r),
      "--repo-root",
      r.dir,
      "--base",
      "no-such-ref",
    ]);
    expect(repoint.status).toBe(2);
    expect(repoint.stderr).toContain("`no-such-ref` is not a commit");
  });

  it("surfaces the findings through the CLI (exit 0: warnings only)", () => {
    const r = baseRepo();
    insertAboveAndEditLast(r);
    const out = runCli([
      "check",
      bundle(r),
      "--repo-root",
      r.dir,
      "--base",
      "HEAD",
      "--rule",
      "citation-drift",
      "--json",
    ]);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout) as {
      findings: Array<{ ruleId: string }>;
    };
    expect(parsed.findings).toHaveLength(7);
  });
});

describe("repoint", () => {
  it("is a dry run by default: prints the plan and writes nothing", () => {
    const r = baseRepo();
    insertAboveAndEditLast(r);
    const result = runRepoint(bundle(r), { base: "HEAD", repoRoot: r.dir });
    expect(result.written).toBe(false);
    expect(result.rewrites).toHaveLength(6);
    expect(result.refused).toHaveLength(1);
    expect(fs.readFileSync(docPath(r), "utf8")).toBe(DOC);
    const text = renderRepointText(result);
    expect(text).toContain(
      "would re-point doc.md: `src/a.ts:6-8` lines 6-8 -> lines 9-11",
    );
    expect(text).toContain("MANUAL doc.md: `src/a.ts:12`");
    expect(result.exitCode).toBe(1);
  });

  it("--write re-points primary, continuation, extension and short-form citations and refuses the touched one", () => {
    const r = baseRepo();
    insertAboveAndEditLast(r);
    const result = runRepoint(bundle(r), {
      base: "HEAD",
      repoRoot: r.dir,
      write: true,
    });
    expect(result.written).toBe(true);
    expect(fs.readFileSync(docPath(r), "utf8")).toBe(
      FRONTMATTER +
        [
          "# Doc",
          "",
          "Alpha is `src/a.ts:9-11` and again `:13`.",
          "",
          "Beta is `src/a.ts:12`-`14`.",
          "",
          "Gamma is `src/a.ts:1-2`, and :9-10 here.",
          "",
          'Delta is `src/a.ts:8#"v05"` anchored.',
          "",
          "Epsilon is `src/b.ts:3` in an untouched file.",
          "",
          "Zeta is `src/a.ts:12` on an edited line.",
          "",
        ].join("\n"),
    );
    expect(result.refused).toEqual([
      expect.objectContaining({
        doc: "doc.md",
        citation: "src/a.ts:12",
        file: "src/a.ts",
      }),
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("is idempotent: a second run finds nothing to re-point and check --base reports only the touched citation", () => {
    const r = baseRepo();
    insertAboveAndEditLast(r);
    runRepoint(bundle(r), { base: "HEAD", repoRoot: r.dir, write: true });
    const afterFirst = fs.readFileSync(docPath(r), "utf8");
    const second = runRepoint(bundle(r), {
      base: "HEAD",
      repoRoot: r.dir,
      write: true,
    });
    expect(second.rewrites).toEqual([]);
    expect(fs.readFileSync(docPath(r), "utf8")).toBe(afterFirst);
    expect(drift(r).map((f) => labelOf(f.message))).toEqual(["src/a.ts:12"]);
  });

  it("re-points a shift up (lines removed above)", () => {
    const r = baseRepo();
    const lines = sourceLines(12);
    lines.splice(1, 2);
    fs.writeFileSync(path.join(r.dir, "src/a.ts"), lines.join("\n") + "\n");
    runRepoint(bundle(r), { base: "HEAD", repoRoot: r.dir, write: true });
    const doc = fs.readFileSync(docPath(r), "utf8");
    expect(doc).toContain("Alpha is `src/a.ts:4-6` and again `:8`.");
    expect(doc).toContain("Beta is `src/a.ts:7`-`9`.");
    expect(doc).toContain('Delta is `src/a.ts:3#"v05"` anchored.');
  });

  it("exits 0 when everything could be re-pointed, and never touches the frontmatter", () => {
    const r = baseRepo();
    const lines = sourceLines(12);
    lines.unshift("// one", "// two");
    fs.writeFileSync(path.join(r.dir, "src/a.ts"), lines.join("\n") + "\n");
    const out = runCli([
      "repoint",
      bundle(r),
      "--repo-root",
      r.dir,
      "--base",
      "HEAD",
      "--write",
    ]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("re-pointed doc.md");
    const doc = fs.readFileSync(docPath(r), "utf8");
    expect(doc.startsWith(FRONTMATTER)).toBe(true);
    expect(doc).toContain("Zeta is `src/a.ts:14` on an edited line.");
  });

  it("reports an unreadable plan as JSON", () => {
    const r = baseRepo();
    insertAboveAndEditLast(r);
    const out = runCli([
      "repoint",
      bundle(r),
      "--repo-root",
      r.dir,
      "--base",
      "HEAD",
      "--json",
    ]);
    expect(out.status).toBe(1);
    const parsed = JSON.parse(out.stdout) as {
      written: boolean;
      rewrites: unknown[];
      refused: unknown[];
    };
    expect(parsed.written).toBe(false);
    expect(parsed.rewrites).toHaveLength(6);
    expect(parsed.refused).toHaveLength(1);
  });

  it("requires --base", () => {
    const r = baseRepo();
    const out = runCli(["repoint", bundle(r), "--repo-root", r.dir]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("--base");
  });
});

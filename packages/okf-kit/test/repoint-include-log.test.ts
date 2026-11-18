import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRepoint } from "../src/repoint.js";
import { createTmpGitRepo, type TmpGitRepo } from "./git-helpers.js";
import { runCli } from "./helpers.js";

const T0 = "2026-01-01T00:00:00Z";

/** `export const v01 = 1;` ... one distinct, non-blank, non-brace line each. */
function sourceLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return `export const v${n} = ${i + 1};`;
  });
}

const DOC = "---\ntype: concept\n---\n\n# Doc\n\nAlpha is `src/a.ts:6-8`.\n";

const LOG_BULLET = "- 2026-01-01T00:00:00Z,";
const LOG = [
  "# Log",
  "",
  "## 2026-01-01",
  "",
  `${LOG_BULLET} guard at \`src/a.ts:6-8\` verified.`,
  "",
  `${LOG_BULLET} moved \`src/a.ts:9\` -> \`src/a.ts:12\` after an edit.`,
  "",
  `${LOG_BULLET} was \`src/a.ts:6-8\` => now \`src/a.ts:9-11\`, unchanged since.`,
  "",
  `${LOG_BULLET} the old line \`src/gone.ts:3\` was removed; \`src/b.ts:3\` still holds.`,
  "",
  `${LOG_BULLET} from \`src/a.ts:6\` → \`src/a.ts:7\`, and \`src/a.ts:6-8\` -> \`:9-11\` for the range.`,
  "",
].join("\n");

const INDEX = "# Index\n\n- [Doc](doc.md) - see `src/a.ts:6-8`.\n";

let repo: TmpGitRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

/** The base commit holds the doc, two logs, an index, src/a.ts and src/b.ts; then src/a.ts gains three lines above line 3. */
function driftedRepo(): TmpGitRepo {
  const r = createTmpGitRepo();
  repo = r;
  r.commitFiles(
    [
      { relPath: "docs/okf/doc.md", content: DOC },
      { relPath: "docs/okf/log.md", content: LOG },
      { relPath: "docs/okf/sub/log.md", content: LOG_NESTED() },
      { relPath: "docs/okf/index.md", content: INDEX },
      { relPath: "src/a.ts", content: sourceLines(12).join("\n") + "\n" },
      { relPath: "src/b.ts", content: sourceLines(5).join("\n") + "\n" },
    ],
    T0,
  );
  const lines = sourceLines(12);
  lines.splice(2, 0, "export const ins1 = 0;", "export const ins2 = 0;");
  lines.splice(4, 0, "export const ins3 = 0;");
  fs.writeFileSync(path.join(r.dir, "src/a.ts"), lines.join("\n") + "\n");
  return r;
}

function LOG_NESTED(): string {
  return `# Log\n\n## 2026-01-01\n\n${LOG_BULLET} nested guard at \`src/a.ts:6-8\`.\n`;
}

const bundle = (r: TmpGitRepo) => path.join(r.dir, "docs/okf");
const read = (r: TmpGitRepo, rel: string) =>
  fs.readFileSync(path.join(r.dir, rel), "utf8");

describe("repoint --include-log", () => {
  it("default: log.md is not read, whatever drifted in it", () => {
    const r = driftedRepo();
    // includeLog: false spelled out is the same as absent
    const explicit = runRepoint(bundle(r), {
      base: "HEAD",
      repoRoot: r.dir,
      includeLog: false,
    });
    expect(explicit.rewrites.map((w) => w.doc)).toEqual(["doc.md"]);
    const result = runRepoint(bundle(r), {
      base: "HEAD",
      repoRoot: r.dir,
      write: true,
    });
    expect(result.rewrites.map((w) => w.doc)).toEqual(["doc.md"]);
    expect(read(r, "docs/okf/log.md")).toBe(LOG);
    expect(read(r, "docs/okf/sub/log.md")).toBe(LOG_NESTED());
  });

  it("moves a live citation of log.md, and only that one, in a log at any depth", () => {
    const r = driftedRepo();
    const dry = runRepoint(bundle(r), {
      base: "HEAD",
      repoRoot: r.dir,
      includeLog: true,
    });
    expect(dry.written).toBe(false);
    expect(read(r, "docs/okf/log.md")).toBe(LOG);
    expect(
      dry.rewrites
        .filter((w) => w.doc.endsWith("log.md"))
        .map((w) => [w.doc, w.citation, w.toStartLine, w.toEndLine]),
    ).toEqual([
      ["log.md", "src/a.ts:6-8", 9, 11],
      ["sub/log.md", "src/a.ts:6-8", 9, 11],
    ]);

    runRepoint(bundle(r), {
      base: "HEAD",
      repoRoot: r.dir,
      includeLog: true,
      write: true,
    });
    // exactly the digits of the one live citation changed
    expect(read(r, "docs/okf/log.md")).toBe(
      LOG.replace(
        "guard at `src/a.ts:6-8` verified",
        "guard at `src/a.ts:9-11` verified",
      ),
    );
    expect(read(r, "docs/okf/sub/log.md")).toBe(
      LOG_NESTED().replace("6-8", "9-11"),
    );
  });

  it("leaves narrated old -> new pairs, citations of missing files and index.md untouched", () => {
    const r = driftedRepo();
    const result = runRepoint(bundle(r), {
      base: "HEAD",
      repoRoot: r.dir,
      includeLog: true,
      write: true,
    });
    const after = read(r, "docs/okf/log.md");
    for (const kept of [
      "moved `src/a.ts:9` -> `src/a.ts:12` after an edit.",
      "was `src/a.ts:6-8` => now `src/a.ts:9-11`, unchanged since.",
      "the old line `src/gone.ts:3` was removed; `src/b.ts:3` still holds.",
      "from `src/a.ts:6` → `src/a.ts:7`, and `src/a.ts:6-8` -> `:9-11` for the range.",
    ]) {
      expect(after).toContain(kept);
    }
    expect(read(r, "docs/okf/index.md")).toBe(INDEX);
    expect(result.refused).toEqual([]);
    // 2 + 2 + 2 + 2 citations written as a pair, reported as skipped
    const narrated = result.skipped.find((s) => s.reason.includes("narrated"));
    expect(narrated?.count).toBe(8);
  });

  it("a citation written since the ref stays untouched in log.md as in any doc", () => {
    const r = driftedRepo();
    fs.writeFileSync(
      path.join(r.dir, "docs/okf/log.md"),
      LOG.replace("guard at `src/a.ts:6-8`", "guard at `src/a.ts:9-11`"),
    );
    const result = runRepoint(bundle(r), {
      base: "HEAD",
      repoRoot: r.dir,
      includeLog: true,
    });
    expect(result.rewrites.filter((w) => w.doc === "log.md")).toEqual([]);
  });

  it("the CLI flag selects it", () => {
    const r = driftedRepo();
    const without = runCli([
      "repoint",
      bundle(r),
      "--base",
      "HEAD",
      "--repo-root",
      r.dir,
    ]);
    expect(without.stdout).not.toContain("log.md");
    const withFlag = runCli([
      "repoint",
      bundle(r),
      "--base",
      "HEAD",
      "--repo-root",
      r.dir,
      "--include-log",
    ]);
    expect(withFlag.status).toBe(0);
    expect(withFlag.stdout).toContain(
      "would re-point log.md: `src/a.ts:6-8` lines 6-8 -> lines 9-11",
    );
  });
});

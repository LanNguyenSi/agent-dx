import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  escapeData,
  escapeProperty,
  exceedsThreshold,
  formatAnnotation,
  parseNulList,
  parseSummary,
  repoRelativeScanPath,
  runAction,
  type ActionDeps,
  type SpawnResult,
  parseThreshold,
  selectChangedFiles,
} from "../src/action/run.js";
import type { Severity, Violation } from "../src/types.js";
import { ensureBuilt } from "./built-cli.js";

function violation(
  severity: Severity,
  over: Partial<Violation> = {},
): Violation {
  return {
    ruleId: "some-rule",
    pack: "agent-tics",
    severity,
    path: "docs/a.md",
    line: 3,
    column: 5,
    endLine: 3,
    endColumn: 9,
    message: "bad thing",
    rationale: "because",
    matched: "x",
    ...over,
  };
}

const summaryOf = (...sev: Severity[]) => ({
  violations: sev.map((s) => violation(s)),
});

describe("formatAnnotation", () => {
  it("maps each severity to its own workflow command", () => {
    expect(formatAnnotation(violation("block"))).toBe(
      "::error file=docs/a.md,line=3,col=5,endLine=3,endColumn=9,title=agent-tics/some-rule::bad thing",
    );
    expect(formatAnnotation(violation("warn"))).toBe(
      "::warning file=docs/a.md,line=3,col=5,endLine=3,endColumn=9,title=agent-tics/some-rule::bad thing",
    );
    expect(formatAnnotation(violation("info"))).toBe(
      "::notice file=docs/a.md,line=3,col=5,endLine=3,endColumn=9,title=agent-tics/some-rule::bad thing",
    );
  });

  it("does not double the pack prefix of a qualified rule id", () => {
    const out = formatAnnotation(
      violation("block", { ruleId: "agent-tics/leak" }),
    );
    expect(out).toContain("title=agent-tics/leak::");
  });

  it("omits absent end positions", () => {
    const out = formatAnnotation(
      violation("block", { endLine: undefined, endColumn: undefined }),
    );
    expect(out).toBe(
      "::error file=docs/a.md,line=3,col=5,title=agent-tics/some-rule::bad thing",
    );
  });

  it("escapes properties and message", () => {
    const out = formatAnnotation(
      violation("warn", { path: "a,b:c.md", message: "50%\nnext" }),
    );
    expect(out).toContain("file=a%2Cb%3Ac.md,");
    expect(out.endsWith("::50%25%0Anext")).toBe(true);
  });

  it("makes absolute paths repo-relative", () => {
    const out = formatAnnotation(
      violation("block", { path: "/work/repo/src/x.md" }),
      "/work/repo",
    );
    expect(out).toContain("file=src/x.md,");
  });
});

describe("escaping", () => {
  it("escapeData handles percent, CR and LF", () => {
    expect(escapeData("a%b\r\nc")).toBe("a%25b%0D%0Ac");
    expect(escapeData("line1\nline2")).toBe("line1%0Aline2");
  });

  it("escapeProperty also handles colon and comma", () => {
    expect(escapeProperty("a:b,c%\n")).toBe("a%3Ab%2Cc%25%0A");
  });
});

describe("exceedsThreshold", () => {
  it("block-only summary trips every threshold", () => {
    const s = summaryOf("block");
    expect(exceedsThreshold(s, "block")).toBe(true);
    expect(exceedsThreshold(s, "warn")).toBe(true);
    expect(exceedsThreshold(s, "info")).toBe(true);
  });

  it("warn-only summary does not trip block, trips warn and info", () => {
    const s = summaryOf("warn");
    expect(exceedsThreshold(s, "block")).toBe(false);
    expect(exceedsThreshold(s, "warn")).toBe(true);
    expect(exceedsThreshold(s, "info")).toBe(true);
  });

  it("info-only summary trips only the info threshold", () => {
    const s = summaryOf("info");
    expect(exceedsThreshold(s, "block")).toBe(false);
    expect(exceedsThreshold(s, "warn")).toBe(false);
    expect(exceedsThreshold(s, "info")).toBe(true);
  });

  it("an empty summary never trips", () => {
    expect(exceedsThreshold(summaryOf(), "info")).toBe(false);
  });

  it("rejects an unknown threshold with a clear message", () => {
    expect(() => parseThreshold("error")).toThrow(/invalid severity-threshold/);
    expect(() => exceedsThreshold(summaryOf("block"), "nope")).toThrow(
      /expected one of block, warn, info/,
    );
  });
});

describe("parseSummary", () => {
  it("parses a CheckSummary", () => {
    const s = parseSummary(JSON.stringify({ filesScanned: 1, violations: [] }));
    expect(s.violations).toEqual([]);
  });

  it("rejects non-JSON output", () => {
    expect(() => parseSummary("Error: boom")).toThrow(/not valid JSON/);
  });

  it("rejects JSON without violations", () => {
    expect(() => parseSummary("{}")).toThrow(/no violations array/);
  });

  it("rejects a violation missing its fields", () => {
    expect(() => parseSummary('{"violations":[{}]}')).toThrow(
      /malformed violation at index 0/,
    );
  });

  it("rejects an unknown severity, a non-string path, a non-numeric line, a non-string message", () => {
    const bad: Partial<Record<keyof Violation, unknown>>[] = [
      { severity: "fatal" },
      { severity: "toString" },
      { path: 3 },
      { line: "3" },
      { message: null },
    ];
    for (const over of bad) {
      const json = JSON.stringify({
        violations: [{ ...violation("block"), ...over }],
      });
      expect(() => parseSummary(json)).toThrow(/malformed violation/);
    }
  });

  it("rejects warnings that are not an array of strings", () => {
    for (const warnings of ["w", [1], [null]]) {
      const json = JSON.stringify({ violations: [], warnings });
      expect(() => parseSummary(json)).toThrow(/malformed warnings/);
    }
  });
});

describe("selectChangedFiles", () => {
  const present = new Set(["a.md", "docs/b.md", "src/c.ts"]);
  const exists = (f: string) => present.has(f);

  it("drops files that no longer exist", () => {
    expect(
      selectChangedFiles(["a.md", "gone.md", "docs/b.md"], exists),
    ).toEqual(["a.md", "docs/b.md"]);
  });

  it("restricts to the scan path", () => {
    expect(selectChangedFiles(["a.md", "docs/b.md"], exists, "docs")).toEqual([
      "docs/b.md",
    ]);
    expect(selectChangedFiles(["docs2/x.md"], () => true, "docs")).toEqual([]);
  });

  it("de-duplicates and skips blanks", () => {
    expect(selectChangedFiles(["a.md", "", "a.md", "./a.md"], exists)).toEqual([
      "a.md",
    ]);
  });
});

describe("parseNulList", () => {
  it("splits on NUL, keeps non-ASCII names and leading spaces", () => {
    expect(parseNulList("docs/café.md\0 lead.md\0a b.md\0")).toEqual([
      "docs/café.md",
      " lead.md",
      "a b.md",
    ]);
    expect(parseNulList("")).toEqual([]);
  });

  it("selectChangedFiles keeps a leading-space name intact", () => {
    expect(selectChangedFiles([" lead.md"], () => true)).toEqual([" lead.md"]);
  });
});

describe("repoRelativeScanPath", () => {
  it("makes absolute and dotted paths repo-relative", () => {
    expect(repoRelativeScanPath("/w/repo/docs", "/w/repo")).toBe("docs");
    expect(repoRelativeScanPath("./docs/", "/w/repo")).toBe("docs");
    expect(repoRelativeScanPath("/w/repo", "/w/repo")).toBe(".");
  });

  it("filters changed files against an absolute path input", () => {
    const scan = repoRelativeScanPath("/w/repo/docs", "/w/repo");
    expect(
      selectChangedFiles(["docs/a.md", "src/b.ts"], () => true, scan),
    ).toEqual(["docs/a.md"]);
  });
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

interface Harness {
  deps: ActionDeps;
  out: string[];
  calls: { cmd: string; args: string[] }[];
}

function harness(opts: {
  cli?: Partial<SpawnResult>;
  git?: Partial<SpawnResult>;
  event?: string | Error;
}): Harness {
  const out: string[] = [];
  const calls: { cmd: string; args: string[] }[] = [];
  const deps: ActionDeps = {
    cliPath: "/cli.js",
    write: (t) => out.push(t),
    exists: () => true,
    readFile: () => {
      if (opts.event instanceof Error) throw opts.event;
      return opts.event ?? "{}";
    },
    spawn: (cmd, args) => {
      calls.push({ cmd, args });
      const r = cmd === "git" ? opts.git : opts.cli;
      return { status: 0, stdout: "", stderr: "", ...r };
    },
  };
  return { deps, out, calls };
}

const cleanJson = JSON.stringify({
  filesScanned: 1,
  blockCount: 0,
  warnCount: 0,
  infoCount: 0,
  violations: [],
});

const prEvent = (base: string, head: string) =>
  JSON.stringify({
    pull_request: { base: { sha: base }, head: { sha: head } },
  });

const prEnv = {
  GITHUB_WORKSPACE: "/w/repo",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: "/event.json",
  INPUT_CHANGED_FILES_ONLY: "true",
};

describe("runAction exit codes", () => {
  it("clean fixture gives 0", () => {
    const h = harness({ cli: { stdout: cleanJson } });
    expect(runAction({ GITHUB_WORKSPACE: "/w/repo" }, h.deps)).toBe(0);
  });

  it("block fixture gives 1 and an ::error annotation", () => {
    const stdout = JSON.stringify({
      filesScanned: 1,
      blockCount: 1,
      warnCount: 0,
      infoCount: 0,
      violations: [violation("block")],
    });
    const h = harness({ cli: { status: 1, stdout } });
    expect(runAction({ GITHUB_WORKSPACE: "/w/repo" }, h.deps)).toBe(1);
    expect(h.out.join("")).toContain("::error file=docs/a.md");
  });

  it("CLI exit 2 gives 2 with an ::error, even with valid JSON on stdout", () => {
    const h = harness({
      cli: { status: 2, stdout: cleanJson, stderr: "no such config" },
    });
    expect(runAction({ GITHUB_WORKSPACE: "/w/repo" }, h.deps)).toBe(2);
    expect(h.out.join("")).toMatch(/^::error title=slop-detector::.*exit 2/);
  });

  it("unparseable CLI stdout gives 2", () => {
    const h = harness({ cli: { stdout: "boom" } });
    expect(runAction({ GITHUB_WORKSPACE: "/w/repo" }, h.deps)).toBe(2);
    expect(h.out.join("")).toMatch(
      /^::error title=slop-detector::slop-detector output is not valid JSON$/m,
    );
  });

  it("invalid threshold gives 2 without running the CLI", () => {
    const h = harness({ cli: { stdout: cleanJson } });
    const env = { GITHUB_WORKSPACE: "/w/repo", INPUT_SEVERITY_THRESHOLD: "x" };
    expect(runAction(env, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.out.join("")).toContain("::error");
  });

  it("a malformed violation in the CLI summary gives 2 with an ::error", () => {
    const h = harness({ cli: { stdout: '{"violations":[{}]}' } });
    expect(runAction({ GITHUB_WORKSPACE: "/w/repo" }, h.deps)).toBe(2);
    expect(h.out.join("")).toMatch(
      /^::error title=slop-detector::slop-detector output has a malformed violation at index 0$/m,
    );
  });

  it("an unexpected error gives 2 with an ::error instead of throwing", () => {
    const h = harness({});
    h.deps.spawn = () => {
      throw new Error("spawn exploded");
    };
    expect(runAction({ GITHUB_WORKSPACE: "/w/repo" }, h.deps)).toBe(2);
    expect(h.out.join("")).toBe(
      "::error title=slop-detector::unexpected error: spawn exploded\n",
    );
  });

  it("de-duplicates repeated warnings", () => {
    const stdout = JSON.stringify({
      ...JSON.parse(cleanJson),
      warnings: ["w1", "w1", "w2"],
    });
    const h = harness({ cli: { stdout } });
    runAction({ GITHUB_WORKSPACE: "/w/repo" }, h.deps);
    expect(h.out.filter((l) => l.startsWith("::warning"))).toHaveLength(2);
  });
});

describe("runAction changed-files-only", () => {
  it("passes -z and quotePath=false to git and scans the listed files", () => {
    const h = harness({
      event: prEvent(SHA_A, SHA_B),
      git: { stdout: "café.md\0 lead.md\0" },
      cli: { stdout: cleanJson },
    });
    expect(runAction(prEnv, h.deps)).toBe(0);
    expect(h.calls[0].args).toEqual([
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      "-z",
      "--end-of-options",
      `${SHA_A}...${SHA_B}`,
    ]);
    const cli = h.calls[1].args;
    expect(cli.slice(cli.indexOf("--") + 1)).toEqual(["café.md", " lead.md"]);
  });

  it("rejects a non-sha base with 2 and never calls git", () => {
    const h = harness({ event: prEvent("--output=x", SHA_B) });
    expect(runAction(prEnv, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.out.join("")).toContain("::error");
  });

  it("rejects a non-sha head with 2", () => {
    const h = harness({ event: prEvent(SHA_A, "--output=x") });
    expect(runAction(prEnv, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it("an unreadable event file gives 2 with an ::error", () => {
    const h = harness({ event: new Error("ENOENT") });
    expect(runAction(prEnv, h.deps)).toBe(2);
    expect(h.out.join("")).toContain("cannot read event file");
  });

  it("an unparseable event file gives 2", () => {
    const h = harness({ event: "not json" });
    expect(runAction(prEnv, h.deps)).toBe(2);
  });

  it("a failing git diff gives 2", () => {
    const h = harness({
      event: prEvent(SHA_A, SHA_B),
      git: { status: 128, stderr: "bad object" },
    });
    expect(runAction(prEnv, h.deps)).toBe(2);
    expect(h.out.join("")).toContain("git diff failed");
  });

  it("resolves an absolute path input against the repo root", () => {
    const h = harness({
      event: prEvent(SHA_A, SHA_B),
      git: { stdout: "docs/a.md\0src/b.ts\0" },
      cli: { stdout: cleanJson },
    });
    runAction({ ...prEnv, INPUT_PATH: "/w/repo/docs" }, h.deps);
    const cli = h.calls[1].args;
    expect(cli.slice(cli.indexOf("--") + 1)).toEqual(["docs/a.md"]);
  });
});

// The action step runs the built entrypoint (`node dist/action/run.js`, see
// action/action.yml), and only the built tree resolves the CLI it spawns
// (`dist/cli.js`), so these tests run that built file as a subprocess and
// check the process exit code, not just runAction's return value.
describe("action entrypoint subprocess", () => {
  const packageRoot = path.dirname(
    path.dirname(fileURLToPath(import.meta.url)),
  );
  const entry = path.join(packageRoot, "dist", "action", "run.js");
  let workspace: string;

  beforeAll(() => {
    ensureBuilt();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slop-action-"));
    fs.writeFileSync(
      path.join(workspace, "AGENTS.md"),
      "# Agents\n\nThe checkout lives at /Users/someone/git/repo for now.\n",
    );
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function runEntry(extra: Record<string, string>) {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ["PATH", "HOME", "SYSTEMROOT"]) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    return spawnSync(process.execPath, [entry], {
      cwd: workspace,
      encoding: "utf8",
      env: { ...env, GITHUB_WORKSPACE: workspace, ...extra },
    });
  }

  it("exits 2 with an ::error for an invalid severity-threshold", () => {
    const r = runEntry({ INPUT_SEVERITY_THRESHOLD: "bogus" });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(
      /^::error title=slop-detector::invalid severity-threshold/m,
    );
  });

  it("exits 1 with an ::error annotation for a block finding", () => {
    const r = runEntry({ INPUT_PACK: "placement-slop" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^::error file=AGENTS\.md,line=3,/m);
  });
});

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { probe, probePlan, type ProbeOptions } from "../src/probe/index.js";
import { matchLineNumbers } from "../src/probe/mutant.js";
import { parsePlanFile } from "../src/probe/plan.js";
import { expectNoIsolationLeftovers } from "./helpers/no-leftovers.js";
import { CLI_PATH, spawnCli } from "./helpers/spawn-cli.js";

/**
 * The `-n/--line` a `-M/--match` run derives from its own `-M` text:
 * unique occurrence -> derived line, no occurrence -> `match_not_found`,
 * several -> `match_ambiguous`. `src/probe/index.ts` runs the derivation
 * between `--file` resolution and the `line_required` check, so every
 * branch here also decides whether the run reaches the mutation at all;
 * the refusal branches assert the no-leftover trio (worktree, marker,
 * lock) the other pre-setup refusals assert (see
 * `test/helpers/no-leftovers.ts`). Explicit `-n` (and `-r`'s untouched
 * requirement of it) is pinned too, because "unchanged" is only proven
 * by asserting the old behavior is still the observed one.
 *
 * The derivation's own read guard is pinned by the same method: the
 * search runs only for a regular file within the containment root and
 * at most `MATCH_DERIVATION_MAX_BYTES` bytes, and every file shape it
 * declines (outside the root, a FIFO, a directory, missing) must answer
 * exactly what the same run with an explicit `-n` answers, never a
 * derivation refusal that read the file to get there -- a FIFO without
 * `-n` must hit the not-a-regular-file refusal instead of hanging, an
 * outside-root file must hit `file_outside_root` without its line
 * numbers being disclosed, and over the cap the refusal must name the
 * file and say to pass `-n`. An empty `-M` is never searched: the
 * existing "must not be empty" refusal answers.
 */

// Every case here runs real probes (git, node, one process per baseline
// and per mutant; a worktree run adds a `git worktree add`), and the
// rows that compare a run without `-n` to the same run with it run two.
// On a loaded machine one of them can run past vitest's 5 s default, so
// the file sets its own bound; a test that names a timeout keeps it.
vi.setConfig({ testTimeout: 60_000 });

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-derivation-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

let savedLockDir: string | undefined;
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (savedLockDir === undefined) delete process.env.AGENT_PRIMITIVES_LOCK_DIR;
  else process.env.AGENT_PRIMITIVES_LOCK_DIR = savedLockDir;
  savedLockDir = undefined;
});

function useLockDir(): string {
  savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
  const dir = makeTmpDir();
  process.env.AGENT_PRIMITIVES_LOCK_DIR = dir;
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

const FIXTURE_JS = [
  "function isPositive(n) {",
  "  return n > 0;",
  "}",
  "function unused(n) {",
  "  return n * 2;",
  "}",
  "module.exports = { isPositive };",
  "",
].join("\n");

const FIXTURE_TEST_JS = [
  "const assert = require('node:assert');",
  "const { isPositive } = require('./fixture.js');",
  "assert.strictEqual(isPositive(5), true);",
  "assert.strictEqual(isPositive(-5), false);",
  "",
].join("\n");

/** The shared fixture: `n > 0` sits on exactly one line (2), `return `
 * on two (2 and 5). */
function initRepo(): string {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "fixture.js"), FIXTURE_JS);
  fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return repo;
}

function matchOptions(
  repo: string,
  overrides: Partial<ProbeOptions> = {},
): ProbeOptions {
  return {
    file: "fixture.js",
    form: "match",
    matchText: "n > 0",
    withText: "true",
    testCommand: "node fixture.test.js",
    isolation: "inplace",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

type Answer = { status: string; reason?: string; text: string };

/** Blanks what differs between two otherwise identical runs: the uuid a
 * worktree run puts into its scratch and log paths. */
function blankRunIds(text: string): string {
  return text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    "<uuid>",
  );
}

/** What a probe call answers, throw or result, reduced to what the
 * derivation guard decides -- the outcome, the reason and the refusal
 * text -- so that two calls differing only in `line` can be compared
 * with `toEqual`. */
async function answerOf(options: ProbeOptions): Promise<Answer> {
  try {
    const r = await probe(options);
    return {
      status: r.status,
      reason: r.reason,
      text: blankRunIds(r.warnings.join("\n")),
    };
  } catch (e) {
    return { status: "threw", text: blankRunIds((e as Error).message) };
  }
}

/** Runs the built CLI as a child in its own process group and kills the
 * whole group after `ms`: for a `--file` (a FIFO) whose read would
 * block forever under the regression such a test guards. The child
 * blocks inside one `readFileSync` in that case and has spawned nothing
 * by then, but the group kill makes sure a regression can never leave
 * anything behind. */
async function runCliBounded(
  args: string[],
  ms = 8000,
): Promise<{ timedOut: boolean; stdout: string }> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString("utf8");
  });
  child.stderr.resume();
  const timedOut = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        // already gone
      }
      resolve(true);
    }, ms);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  return { timedOut, stdout };
}

const SUB_FIXTURE_JS = "// one\n// two\nconst positive = (n) => n > 0;\n";
const TWO_HITS = "n > 0 a\nn > 0 b\n";

interface Layered {
  /** A git repository (see the list below). */
  repo: string;
  /** A directory outside the repository. */
  outside: string;
}

/**
 * The fixture for the rows that reach the derivation guard through a
 * layer in front of it (isolation mode, path resolution, links). On top
 * of `initRepo()` (`n > 0` on line 2 of `fixture.js`), all committed
 * unless noted:
 *
 * - `sub/fixture.js` (`n > 0` on line 3) and `sub/deep.js` (line 4);
 * - `dirty.js`, committed with `n > 0` on line 1 and rewritten in the
 *   working tree with it on line 3; `untracked.js` (line 4, untracked);
 * - links to in-repo targets: `link-in.js` -> `fixture.js` (relative),
 *   `link-in-abs.js` (absolute target), `chain2.js` -> `chain1.js` ->
 *   `link-in.js`, `link-dir` -> `sub`;
 * - links that leave the repository: `link-out.js` -> `outside/two.js`
 *   (two lines carry the text, so a derivation that read it would
 *   answer `match_ambiguous` and name them), `link-out1.js` ->
 *   `outside/one.js` (line 3), `chain-out.js` -> `link-out.js`,
 *   `link-outdir` -> `outside/odir` (holding `f.js`, two hits);
 * - links that resolve to nothing: `link-dangling.js` (in-repo target),
 *   `link-dangling-out.js` (outside target), `loop-a.js` <-> `loop-b.js`;
 * - `link-null` -> `/dev/null`, a character device: outside the
 *   repository and not a regular file, and unlike a FIFO or `/dev/zero`
 *   safe to have in a library call, because a regression that read it
 *   would get an empty file back at once instead of blocking.
 */
function initLayeredRepo(): Layered {
  const repo = initRepo();
  const outside = makeTmpDir();
  fs.writeFileSync(path.join(outside, "one.js"), "a\nb\nn > 0\n");
  fs.writeFileSync(path.join(outside, "two.js"), TWO_HITS);
  fs.mkdirSync(path.join(outside, "odir"));
  fs.writeFileSync(path.join(outside, "odir", "f.js"), TWO_HITS);
  fs.mkdirSync(path.join(repo, "sub"));
  fs.writeFileSync(path.join(repo, "sub", "fixture.js"), SUB_FIXTURE_JS);
  fs.writeFileSync(path.join(repo, "sub", "deep.js"), "a\nb\nc\nn > 0\n");
  fs.writeFileSync(path.join(repo, "dirty.js"), "n > 0\nfiller\nfiller\n");
  const link = (target: string, name: string): void => {
    fs.symlinkSync(target, path.join(repo, name));
  };
  link("fixture.js", "link-in.js");
  link(path.join(repo, "fixture.js"), "link-in-abs.js");
  link("link-in.js", "chain1.js");
  link("chain1.js", "chain2.js");
  link("sub", "link-dir");
  link(path.join(outside, "two.js"), "link-out.js");
  link(path.join(outside, "one.js"), "link-out1.js");
  link("link-out.js", "chain-out.js");
  link(path.join(outside, "odir"), "link-outdir");
  link("nowhere.js", "link-dangling.js");
  link(path.join(outside, "gone.js"), "link-dangling-out.js");
  link("loop-b.js", "loop-a.js");
  link("loop-a.js", "loop-b.js");
  link("/dev/null", "link-null");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "layers"]);
  fs.writeFileSync(path.join(repo, "dirty.js"), "filler\nfiller\nn > 0\n");
  fs.writeFileSync(path.join(repo, "untracked.js"), "u\nu\nu\nn > 0\n");
  return { repo, outside };
}

describe("matchLineNumbers (the derivation's line search)", () => {
  it("returns the one 1-indexed line whose text contains the substring", () => {
    expect(matchLineNumbers("a\nbb\nccc", "cc")).toEqual([3]);
  });

  it("counts LINES, not occurrences: a substring twice on one line is one hit", () => {
    expect(matchLineNumbers("a\nxx xx\nccc", "xx")).toEqual([2]);
  });

  it("a substring containing a newline can never match a line", () => {
    // The very content whose JOINED form contains the text: the split
    // into lines destroys the newline, so the search sees zero hits.
    expect(matchLineNumbers("ab\ncd", "ab\ncd")).toEqual([]);
  });

  it("keeps a CRLF file's \\r as part of the line (the same split computeMatch uses)", () => {
    expect(matchLineNumbers("a\r\nb\r\r\nc", "b")).toEqual([2]);
    // The `\r` is searchable: a split that swallowed it would not find
    // a text that ends in one.
    expect(matchLineNumbers("a\r\nb\r\nc", "b\r")).toEqual([2]);
  });

  it("the empty substring counts as contained in every line", () => {
    expect(matchLineNumbers("a\nb", "")).toEqual([1, 2]);
  });
});

describe("probe(): -M without -n derives the unique line", () => {
  it("runs the probe as if -n had named that line: killed, mutant.line = the derived line, a warning says it was derived", async () => {
    useLockDir();
    const repo = initRepo();
    const result = await probe(matchOptions(repo));
    expect(result.status).toBe("killed");
    expect(result.mutant).toBeDefined();
    expect(result.mutant?.line).toBe(2);
    expect(result.mutant?.before).toBe("  return n > 0;");
    expect(result.mutant?.after).toBe("  return true;");
    expect(
      result.warnings.some((w) =>
        w.includes(
          `-n/--line derived from the unique -M/--match occurrence: line 2 of ${path.join(repo, "fixture.js")}`,
        ),
      ),
    ).toBe(true);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
      FIXTURE_JS,
    );
  });

  it("derives the line even when the text occurs twice on it (one line is the unit)", async () => {
    useLockDir();
    const repo = initRepo();
    fs.writeFileSync(
      path.join(repo, "twice.js"),
      "const a = 1; const b = a + 1;\n",
    );
    const result = await probe(
      matchOptions(repo, {
        file: "twice.js",
        matchText: "const ",
        withText: "let ",
      }),
    );
    // No test could fail on this file, but the mutant must still be
    // computed against the derived line before the verdict question:
    // `survived` with the line-1 record is that proof.
    expect(result.status).toBe("survived");
    expect(result.mutant?.line).toBe(1);
  });

  it("a -M text containing a newline matches no line: match_not_found", async () => {
    useLockDir();
    const repo = initRepo();
    const lockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR as string;
    const result = await probe(matchOptions(repo, { matchText: "n > 0;\n}" }));
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("match_not_found");
    expectNoIsolationLeftovers(repo, lockDir);
  });
});

describe("probe(): -M without -n refuses match_not_found and match_ambiguous", () => {
  it("no line contains the text: usage_error/match_not_found naming the file and the text, nothing mutated, no leftovers", async () => {
    useLockDir();
    const repo = initRepo();
    const lockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR as string;
    const result = await probe(matchOptions(repo, { matchText: "n > 999" }));
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("match_not_found");
    const warning = result.warnings.join("\n");
    expect(warning).toContain(path.join(repo, "fixture.js"));
    expect(warning).toContain("n > 999");
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
      FIXTURE_JS,
    );
    expectNoIsolationLeftovers(repo, lockDir);
  });

  it("several lines contain the text: usage_error/match_ambiguous listing the line numbers and asking for -n", async () => {
    useLockDir();
    const repo = initRepo();
    const lockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR as string;
    const result = await probe(matchOptions(repo, { matchText: "return" }));
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("match_ambiguous");
    const warning = result.warnings.join("\n");
    expect(warning).toContain(": 2, 5");
    expect(warning).toContain("-n/--line");
    expect(warning).toContain(path.join(repo, "fixture.js"));
    // The full count is under the list cap, so there is no "and N more"
    // tail to append: a `more >= 0` mutant would print ", and 0 more".
    expect(warning).not.toContain("more");
    // The refusal quotes the `-M` text itself, JSON-quoted: a mutant
    // that drops it from the message leaves the caller's own text
    // unquoted and unnamed.
    expect(warning).toContain(JSON.stringify("return"));
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
      FIXTURE_JS,
    );
    expectNoIsolationLeftovers(repo, lockDir);
  });

  it("the ambiguous list is capped at 20 numbers plus the rest as a count", async () => {
    useLockDir();
    const repo = initRepo();
    const lockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR as string;
    // 25 lines, one hit each: the listed run must be the FIRST 20,
    // with the remaining 5 named only as a count.
    fs.writeFileSync(
      path.join(repo, "many.js"),
      Array.from({ length: 25 }, (_, i) => `hit${i}`).join("\n") + "\n",
    );
    const result = await probe(
      matchOptions(repo, { file: "many.js", matchText: "hit" }),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("match_ambiguous");
    const warning = result.warnings.join("\n");
    expect(warning).toContain("occurs on 25 lines");
    expect(warning).toContain(
      "1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20",
    );
    expect(warning).toContain(", and 5 more");
    expect(warning).not.toContain(", 21");
    expect(warning).toContain("-n/--line");
    expectNoIsolationLeftovers(repo, lockDir);
  });

  it("a missing --file is NOT answered by the derivation: file_not_found, the same answer explicit -n gives", async () => {
    useLockDir();
    const repo = initRepo();
    const lockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR as string;
    const result = await probe(
      matchOptions(repo, { file: "missing.js", matchText: "anything" }),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("file_not_found");
    expect(result.warnings.join("\n")).toContain(
      `--file not found: ${path.join(repo, "missing.js")}`,
    );
    expectNoIsolationLeftovers(repo, lockDir);
  });
});

describe("probe(): the -M-without--n read guard matches the explicit -n answers", () => {
  it("a FIFO --file without -n hits the non-regular-file refusal instead of hanging on the read", async () => {
    useLockDir();
    const repo = initRepo();
    const lockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR as string;
    // `mkfifo` under the repo (itself an `mkdtemp` directory inside
    // `os.tmpdir()`, never the worktree): in-root, so what answers is
    // the regular-file check, not containment. A derivation that read
    // the FIFO before checking would block `readFileSync` forever (no
    // writer), so the probe runs as a child with its own hard kill
    // (`SIGKILL` on timeout -- a synchronously blocked process ignores
    // nothing); the run must finish well inside this test's own bound
    // and report the not-a-regular-file refusal, never the FIFO's
    // content.
    const fifo = path.join(repo, "fifo.pipe");
    execFileSync("mkfifo", [fifo]);
    const run = await runCliBounded([
      "-C",
      repo,
      "probe",
      "--file",
      "fifo.pipe",
      "-M",
      "anything",
      "-w",
      "true",
      "-t",
      "node fixture.test.js",
      "-i",
      "inplace",
    ]);
    expect(run.timedOut).toBe(false);
    expect(run.stdout).toContain("not a regular file");
    expect(run.stdout).toContain(fifo);
    expectNoIsolationLeftovers(repo, lockDir);
  }, 10000);

  it("a directory --file without -n hits the non-regular-file refusal, the same throw explicit -n gives", async () => {
    useLockDir();
    const repo = initRepo();
    const lockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR as string;
    fs.mkdirSync(path.join(repo, "adir"));
    const result = probe(
      matchOptions(repo, { file: "adir", matchText: "anything" }),
    );
    await expect(result).rejects.toThrow(/not a regular file/);
    await expect(result).rejects.toThrow(path.join(repo, "adir"));
    expectNoIsolationLeftovers(repo, lockDir);
  });

  it("a --file outside the root without -n answers file_outside_root, never a derivation refusal naming its lines", async () => {
    useLockDir();
    const repo = initRepo();
    const lockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR as string;
    // Two lines carry the text: had the derivation read the file, the
    // answer would be `match_ambiguous` with those line numbers, a
    // disclosure the same call with `-n` never makes.
    const outside = path.join(makeTmpDir(), "outside.js");
    fs.writeFileSync(outside, "n > 0 a\nn > 0 b\n");
    const result = await probe(
      matchOptions(repo, { file: outside, matchText: "n > 0" }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("file_outside_root");
    const warning = result.warnings.join("\n");
    expect(warning).toContain(outside);
    expect(warning).not.toContain("occurs on");
    expect(warning).not.toContain(": 1, 2");
    expectNoIsolationLeftovers(repo, lockDir);
  });

  it("a --file over the derivation size cap without -n refuses as a usage error naming the file and -n", async () => {
    useLockDir();
    const repo = initRepo();
    const lockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR as string;
    // One byte over the 8 MiB `MATCH_DERIVATION_MAX_BYTES`: a unique
    // `n > 0` inside it, so a missing cap check would derive line 1 and
    // run the probe instead of refusing.
    const buf = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20);
    buf.write("n > 0", 100);
    fs.writeFileSync(path.join(repo, "big.js"), buf);
    const result = await probe(
      matchOptions(repo, { file: "big.js", matchText: "n > 0" }),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("line_required");
    const warning = result.warnings.join("\n");
    expect(warning).toContain(path.join(repo, "big.js"));
    expect(warning).toContain("8388609");
    expect(warning).toContain("cap");
    expect(warning).toContain("-n/--line");
    expectNoIsolationLeftovers(repo, lockDir);
  });

  it("an empty -M without -n is never searched: the existing must-not-be-empty refusal answers", async () => {
    useLockDir();
    const repo = initRepo();
    const result = await probe(matchOptions(repo, { matchText: "" }));
    // Every line of any file contains the empty text, so a search would
    // answer `match_ambiguous` listing them all (plus a phantom line
    // after the trailing newline); the refusal is content-free.
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_not_applicable");
    expect(result.warnings.join("\n")).toContain(
      "-M/--match text must not be empty",
    );
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
      FIXTURE_JS,
    );
  });
});

describe("probe(): the derivation guard's decision table, each row against the same call with -n", () => {
  const CAP = 8 * 1024 * 1024;

  /** A file of exactly `size` bytes with `n > 0` once, on line 1. */
  function sizedFile(dir: string, name: string, size: number): string {
    const buf = Buffer.alloc(size, 0x20);
    buf.write("n > 0", 0);
    const file = path.join(dir, name);
    fs.writeFileSync(file, buf);
    return file;
  }

  /** What a probe call answers, throw or result, reduced to what the
   * guard decides: the outcome, the reason, and the refusal text. */
  async function answer(
    options: ProbeOptions,
  ): Promise<{ status: string; reason?: string; text: string }> {
    try {
      const r = await probe(options);
      return {
        status: r.status,
        reason: r.reason,
        text: r.warnings.join("\n"),
      };
    } catch (e) {
      return { status: "threw", text: (e as Error).message };
    }
  }

  it("an outside regular file with --allow-outside (inplace) derives its unique line and mutates it", async () => {
    useLockDir();
    const repo = initRepo();
    const outside = path.join(makeTmpDir(), "outside.js");
    fs.writeFileSync(outside, "a\nn > 0\nc\n");
    const result = await probe(
      matchOptions(repo, {
        file: outside,
        allowOutside: true,
        testCommand: "true",
      }),
    );
    // Neutralised `--allow-outside` handling would defer and surface
    // "line 0 is out of range"; a derived line 2 is the feature.
    expect(result.mutant?.line).toBe(2);
    expect(result.warnings.join("\n")).toContain(`line 2 of ${outside}`);
    expect(result.warnings.join("\n")).not.toContain("line 0");
    expect(fs.readFileSync(outside, "utf8")).toBe("a\nn > 0\nc\n");
  });

  it("the same outside file WITHOUT --allow-outside is file_outside_root and never derives", async () => {
    useLockDir();
    const repo = initRepo();
    const outside = path.join(makeTmpDir(), "outside.js");
    fs.writeFileSync(outside, "a\nn > 0\nc\n");
    const without = await answer(matchOptions(repo, { file: outside }));
    const withN = await answer(matchOptions(repo, { file: outside, line: 2 }));
    expect(without.reason).toBe("file_outside_root");
    expect(without.reason).toBe(withN.reason);
    expect(without.status).toBe(withN.status);
    expect(without.text).not.toContain("derived");
  });

  it("--allow-outside with an outside file of several matches refuses match_ambiguous (the search ran), count rows 0 and 2 included", async () => {
    useLockDir();
    const repo = initRepo();
    const dir = makeTmpDir();
    const two = path.join(dir, "two.js");
    fs.writeFileSync(two, "n > 0 a\nn > 0 b\n");
    const r2 = await probe(
      matchOptions(repo, { file: two, allowOutside: true }),
    );
    expect(r2.reason).toBe("match_ambiguous");
    expect(r2.warnings.join("\n")).toContain(": 1, 2");
    const none = path.join(dir, "none.js");
    fs.writeFileSync(none, "nothing here\n");
    const r0 = await probe(
      matchOptions(repo, { file: none, allowOutside: true }),
    );
    expect(r0.reason).toBe("match_not_found");
  });

  it("--allow-outside with an outside directory or missing file answers exactly what -n answers", async () => {
    useLockDir();
    const repo = initRepo();
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, "adir"));
    for (const target of [path.join(dir, "adir"), path.join(dir, "gone.js")]) {
      const without = await answer(
        matchOptions(repo, { file: target, allowOutside: true }),
      );
      const withN = await answer(
        matchOptions(repo, { file: target, allowOutside: true, line: 1 }),
      );
      expect(without).toEqual(withN);
    }
  });

  it("-i worktree with --allow-outside defers to worktree_allow_outside_unsupported without reading, same as -n", async () => {
    useLockDir();
    const repo = initRepo();
    const lockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR as string;
    const outside = path.join(makeTmpDir(), "outside.js");
    // Two matching lines: a derivation that read the file would answer
    // match_ambiguous and disclose "1, 2".
    fs.writeFileSync(outside, "n > 0 a\nn > 0 b\n");
    const base = {
      file: outside,
      allowOutside: true,
      isolation: "worktree" as const,
    };
    const without = await answer(matchOptions(repo, base));
    const withN = await answer(matchOptions(repo, { ...base, line: 1 }));
    expect(without.reason).toBe("worktree_allow_outside_unsupported");
    expect(without).toEqual(withN);
    expect(without.text).not.toContain("occurs on");
    // A CONTAINED file under the same flag pair is refused the same way.
    const contained = await answer(
      matchOptions(repo, {
        allowOutside: true,
        isolation: "worktree",
        matchText: "return",
      }),
    );
    expect(contained.reason).toBe("worktree_allow_outside_unsupported");
    expectNoIsolationLeftovers(repo, lockDir);
  });

  it("-i worktree with --allow-outside outside a git work tree falls back to inplace, so the derivation runs", async () => {
    useLockDir();
    const plain = makeTmpDir();
    fs.writeFileSync(path.join(plain, "t.js"), "x\n");
    const outside = path.join(makeTmpDir(), "outside.js");
    fs.writeFileSync(outside, "a\nn > 0\nc\n");
    const result = await probe(
      matchOptions(plain, {
        file: outside,
        allowOutside: true,
        isolation: "worktree",
        testCommand: "true",
      }),
    );
    expect(result.reason).not.toBe("worktree_allow_outside_unsupported");
    expect(result.mutant?.line).toBe(2);
  });

  it("a file of exactly the cap derives; one byte more refuses (the boundary is `>`)", async () => {
    useLockDir();
    const repo = initRepo();
    sizedFile(repo, "exact.js", CAP);
    const exact = await probe(
      matchOptions(repo, {
        file: "exact.js",
        matchText: "n > 0",
        testCommand: "true",
      }),
    );
    expect(exact.mutant?.line).toBe(1);
    expect(exact.reason).not.toBe("line_required");
    sizedFile(repo, "over.js", CAP + 1);
    const over = await probe(
      matchOptions(repo, { file: "over.js", matchText: "n > 0" }),
    );
    expect(over.reason).toBe("line_required");
    expect(over.warnings.join("\n")).toContain(String(CAP + 1));
  }, 30000);

  it("the over-cap refusal needs a stat-able regular file: an outside over-cap file without --allow-outside is file_outside_root, with it refuses line_required", async () => {
    useLockDir();
    const repo = initRepo();
    const big = sizedFile(makeTmpDir(), "big.js", CAP + 1);
    const without = await answer(matchOptions(repo, { file: big }));
    expect(without.reason).toBe("file_outside_root");
    const withFlag = await answer(
      matchOptions(repo, { file: big, allowOutside: true }),
    );
    expect(withFlag.reason).toBe("line_required");
  }, 30000);

  it("an unreadable regular file (mode 000) answers the failed read, exactly as the same call with -n, never line_required", async () => {
    if (process.getuid?.() === 0) return;
    useLockDir();
    const repo = initRepo();
    const secret = path.join(repo, "secret.js");
    fs.writeFileSync(secret, "n > 0\n");
    fs.chmodSync(secret, 0o000);
    try {
      const options = matchOptions(repo, {
        file: "secret.js",
        matchText: "n > 0",
      });
      const without = await answer(options);
      const withN = await answer({ ...options, line: 1 });
      expect(without).toEqual(withN);
      expect(without.status).toBe("threw");
      expect(without.text).toContain("EACCES");
      expect(without.text).toContain(secret);
      expect(without.text).not.toContain("-n/--line is required");
    } finally {
      fs.chmodSync(secret, 0o644);
    }
  });
});

describe("probe(): the layers in front of the derivation guard (isolation, path resolution, links)", () => {
  type Mode = "inplace" | "worktree";
  const MODES: Mode[] = ["inplace", "worktree"];

  /** A symlink, in a directory of its own, that points at `target`. */
  function linkTo(target: string): string {
    const link = path.join(makeTmpDir(), "link");
    fs.symlinkSync(target, link);
    return link;
  }

  interface DeriveRow {
    name: string;
    /** The line the unique `n > 0` (or the row's own text) sits on. */
    line: number;
    options: (fx: Layered) => Partial<ProbeOptions>;
    modes?: Mode[];
  }

  const deriveRows: DeriveRow[] = [
    {
      name: "a contained file with allowOutside left unset",
      line: 2,
      options: () => ({}),
    },
    {
      name: "a contained file with allowOutside false",
      line: 2,
      options: () => ({ allowOutside: false }),
    },
    {
      name: "an absolute --file inside the repository",
      line: 2,
      options: (fx) => ({ file: path.join(fx.repo, "fixture.js") }),
    },
    {
      name: "a --file with `..` segments that stays inside",
      line: 2,
      options: () => ({ file: "sub/../fixture.js" }),
    },
    {
      name: "a --file relative to a cwd below the repository root (resolved against the cwd, not the root)",
      line: 3,
      options: (fx) => ({ cwd: path.join(fx.repo, "sub"), file: "fixture.js" }),
    },
    {
      name: "a `../` --file from a cwd below the root that stays inside",
      line: 2,
      options: (fx) => ({
        cwd: path.join(fx.repo, "sub"),
        file: "../fixture.js",
      }),
    },
    {
      name: "a cwd reached through a symlink to the repository",
      line: 2,
      options: (fx) => ({ cwd: linkTo(fx.repo) }),
    },
    {
      name: "a symlink to an in-repo file (relative target)",
      line: 2,
      options: () => ({ file: "link-in.js" }),
    },
    {
      name: "a symlink to an in-repo file (absolute target)",
      line: 2,
      options: () => ({ file: "link-in-abs.js" }),
    },
    {
      name: "a chain of symlinks ending at an in-repo file",
      line: 2,
      options: () => ({ file: "chain2.js" }),
    },
    {
      name: "a file below a symlinked in-repo directory",
      line: 4,
      options: () => ({ file: "link-dir/deep.js" }),
    },
    {
      name: "a tracked file whose working-tree content differs from HEAD (the working tree is read and mutated)",
      line: 3,
      options: () => ({ file: "dirty.js" }),
    },
    {
      name: "an untracked file",
      line: 4,
      options: () => ({ file: "untracked.js" }),
    },
    {
      name: "a -M text with non-ASCII characters",
      line: 2,
      options: (fx) => {
        fs.writeFileSync(
          path.join(fx.repo, "uni.js"),
          "const a = 1;\nconst s = 'größe ≥ 0';\n",
        );
        return { file: "uni.js", matchText: "größe ≥ 0", withText: "x" };
      },
    },
    {
      name: "--allow-outside: a symlink to an outside file",
      line: 3,
      options: () => ({ file: "link-out1.js", allowOutside: true }),
      modes: ["inplace"],
    },
    {
      name: "--allow-outside: a relative --file that leaves the repository",
      line: 3,
      options: (fx) => ({
        file: path.relative(fx.repo, path.join(fx.outside, "one.js")),
        allowOutside: true,
      }),
      modes: ["inplace"],
    },
  ];

  for (const row of deriveRows) {
    for (const mode of row.modes ?? MODES) {
      it(`derives under ${mode} isolation: ${row.name}`, async () => {
        useLockDir();
        const fx = initLayeredRepo();
        const options = matchOptions(fx.repo, {
          testCommand: "true",
          isolation: mode,
          ...row.options(fx),
        });
        const displayFile = path.resolve(options.cwd, options.file as string);
        const derived = await probe(options);
        expect(derived.mutant?.line).toBe(row.line);
        expect(derived.warnings).toContain(
          `-n/--line derived from the unique -M/--match occurrence: line ${String(row.line)} of ${displayFile}`,
        );
        // A run the guard wrongly declined reaches the mutation with no
        // line at all and reports this instead.
        expect(derived.warnings.join("\n")).not.toContain("line 0");
        // The derived run IS the run with that `-n`: same verdict, same
        // mutant record, same isolation.
        const explicit = await probe({ ...options, line: row.line });
        expect(explicit.mutant?.line).toBe(row.line);
        expect({
          status: derived.status,
          reason: derived.reason,
          mutant: derived.mutant,
          isolation: derived.isolation.mode,
        }).toEqual({
          status: explicit.status,
          reason: explicit.reason,
          mutant: explicit.mutant,
          isolation: explicit.isolation.mode,
        });
        expect(derived.status).toBe("survived");
        expect(derived.isolation.mode).toBe(mode);
      });
    }
  }

  interface SameRow {
    name: string;
    options: (fx: Layered) => Partial<ProbeOptions>;
    /** The `reason` both calls answer with ... */
    reason?: string;
    /** ... or the message both throw. */
    threw?: RegExp;
    modes?: Mode[];
  }

  const sameRows: SameRow[] = [
    {
      name: "a symlink to an outside file",
      options: () => ({ file: "link-out.js" }),
      reason: "file_outside_root",
    },
    {
      name: "a chain of symlinks ending outside",
      options: () => ({ file: "chain-out.js" }),
      reason: "file_outside_root",
    },
    {
      name: "a file below a symlinked outside directory",
      options: () => ({ file: "link-outdir/f.js" }),
      reason: "file_outside_root",
    },
    {
      name: "a symlink to an outside directory",
      options: () => ({ file: "link-outdir" }),
      reason: "file_outside_root",
    },
    {
      name: "a relative --file that leaves the repository",
      options: (fx) => ({
        file: path.relative(fx.repo, path.join(fx.outside, "two.js")),
      }),
      reason: "file_outside_root",
    },
    {
      name: "a `../` --file from a cwd below the root that leaves the repository",
      options: (fx) => ({
        cwd: path.join(fx.repo, "sub"),
        file: path.relative(
          path.join(fx.repo, "sub"),
          path.join(fx.outside, "two.js"),
        ),
      }),
      reason: "file_outside_root",
    },
    {
      name: "a symlink to an in-repo directory",
      options: () => ({ file: "link-dir" }),
      threw: /not a regular file/,
    },
    {
      name: "a directory",
      options: () => ({ file: "sub" }),
      threw: /not a regular file/,
    },
    {
      name: "a dangling symlink (in-repo target)",
      options: () => ({ file: "link-dangling.js" }),
      reason: "file_not_found",
    },
    {
      name: "a dangling symlink (outside target)",
      options: () => ({ file: "link-dangling-out.js" }),
      reason: "file_not_found",
    },
    {
      // Not placed at all: the walk ran out of its link budget, and a
      // path past that budget is refused rather than judged where it sits.
      name: "a symlink loop",
      options: () => ({ file: "loop-a.js" }),
      reason: "file_outside_root",
    },
    {
      name: "a missing file",
      options: () => ({ file: "missing.js" }),
      reason: "file_not_found",
    },
    {
      name: "a symlink to a character device",
      options: () => ({ file: "link-null" }),
      reason: "file_outside_root",
    },
    {
      name: "--allow-outside: a character device",
      options: () => ({ file: "/dev/null", allowOutside: true }),
      threw: /not a regular file/,
      modes: ["inplace"],
    },
    {
      name: "--allow-outside: a symlink to a character device",
      options: () => ({ file: "link-null", allowOutside: true }),
      threw: /not a regular file/,
      modes: ["inplace"],
    },
    {
      name: "--allow-outside: a symlink to an outside directory",
      options: () => ({ file: "link-outdir", allowOutside: true }),
      threw: /not a regular file/,
      modes: ["inplace"],
    },
    {
      name: "--allow-outside: a dangling symlink",
      options: () => ({ file: "link-dangling-out.js", allowOutside: true }),
      reason: "file_not_found",
      modes: ["inplace"],
    },
    {
      name: "--allow-outside: a symlink to an outside file",
      options: () => ({ file: "link-out.js", allowOutside: true }),
      reason: "worktree_allow_outside_unsupported",
      modes: ["worktree"],
    },
    {
      name: "--allow-outside: a symlink to an in-repo file",
      options: () => ({ file: "link-in.js", allowOutside: true }),
      reason: "worktree_allow_outside_unsupported",
      modes: ["worktree"],
    },
    {
      name: "--allow-outside: a missing file",
      options: () => ({ file: "missing.js", allowOutside: true }),
      reason: "worktree_allow_outside_unsupported",
      modes: ["worktree"],
    },
    {
      name: "--allow-outside: an empty -M",
      options: () => ({ matchText: "", allowOutside: true }),
      reason: "worktree_allow_outside_unsupported",
      modes: ["worktree"],
    },
    {
      name: "an empty -M on a multi-line file",
      options: () => ({ matchText: "" }),
      reason: "mutant_not_applicable",
    },
    {
      name: "an empty -M on a one-line file",
      options: (fx) => {
        fs.writeFileSync(path.join(fx.repo, "single.js"), "n > 0");
        return { file: "single.js", matchText: "" };
      },
      reason: "mutant_not_applicable",
    },
    {
      name: "an empty -M on an empty file",
      options: (fx) => {
        fs.writeFileSync(path.join(fx.repo, "empty.js"), "");
        return { file: "empty.js", matchText: "" };
      },
      reason: "mutant_not_applicable",
    },
    {
      name: "an empty -M on a missing file",
      options: () => ({ file: "missing.js", matchText: "" }),
      reason: "file_not_found",
    },
    {
      name: "an empty -M on a symlink to an outside file",
      options: () => ({ file: "link-out.js", matchText: "" }),
      reason: "file_outside_root",
    },
  ];

  /** Runs the row without a line and with `line: 1` and asserts both
   * answer the same thing, which is the row's own named answer, and that
   * nothing in it comes from a search of the file. */
  async function expectSameAsExplicitLine(
    options: ProbeOptions,
    row: Pick<SameRow, "reason" | "threw">,
  ): Promise<void> {
    const without = await answerOf(options);
    const withLine = await answerOf({ ...options, line: 1 });
    expect(without).toEqual(withLine);
    if (row.threw !== undefined) {
      expect(without.status).toBe("threw");
      expect(without.text).toMatch(row.threw);
    } else {
      expect(without.reason).toBe(row.reason);
    }
    expect(without.text).not.toContain("occurs on");
    expect(without.text).not.toContain("derived from");
    expect(without.text).not.toContain("-n/--line is required");
  }

  for (const row of sameRows) {
    for (const mode of row.modes ?? MODES) {
      it(`answers as with -n under ${mode} isolation, nothing read: ${row.name}`, async () => {
        useLockDir();
        const lockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR as string;
        const fx = initLayeredRepo();
        const options = matchOptions(fx.repo, {
          isolation: mode,
          ...row.options(fx),
        });
        await expectSameAsExplicitLine(options, row);
        expectNoIsolationLeftovers(fx.repo, lockDir);
      });
    }
  }

  for (const mode of MODES) {
    it.skipIf(process.getuid?.() === 0)(
      `answers as with -n under ${mode} isolation: a regular file that cannot be read (mode 000)`,
      async () => {
        useLockDir();
        const fx = initLayeredRepo();
        const secret = path.join(fx.repo, "secret.js");
        fs.writeFileSync(secret, "n > 0\n");
        fs.chmodSync(secret, 0o000);
        try {
          // The metadata checks pass (a regular file under the cap); only
          // the read fails. The answer is the failed read the mutation
          // itself runs into, never a request for a `-n` that would end
          // in that same failure.
          await expectSameAsExplicitLine(
            matchOptions(fx.repo, { file: "secret.js", isolation: mode }),
            mode === "inplace"
              ? { threw: /EACCES/ }
              : { reason: "worktree_sync_failed" },
          );
        } finally {
          fs.chmodSync(secret, 0o644);
        }
      },
    );
  }

  it.skipIf(process.getuid?.() === 0)(
    "answers as with -n: an outside regular file that cannot be read, with --allow-outside",
    async () => {
      useLockDir();
      const fx = initLayeredRepo();
      const secret = path.join(fx.outside, "secret.js");
      fs.writeFileSync(secret, "n > 0\n");
      fs.chmodSync(secret, 0o000);
      try {
        await expectSameAsExplicitLine(
          matchOptions(fx.repo, { file: secret, allowOutside: true }),
          { threw: /EACCES/ },
        );
      } finally {
        fs.chmodSync(secret, 0o644);
      }
    },
  );

  for (const mode of MODES) {
    it(`outside a git work tree, ${mode} isolation (worktree falls back to inplace): a contained file derives, an outside one answers as with -n`, async () => {
      useLockDir();
      const plain = makeTmpDir();
      fs.writeFileSync(path.join(plain, "t.js"), "a\nn > 0\n");
      const options = matchOptions(plain, {
        file: "t.js",
        testCommand: "true",
        isolation: mode,
      });
      const derived = await probe(options);
      expect(derived.mutant?.line).toBe(2);
      expect(derived.status).toBe("survived");
      expect(derived.isolation.mode).toBe("inplace");
      const outside = path.join(makeTmpDir(), "two.js");
      fs.writeFileSync(outside, TWO_HITS);
      await expectSameAsExplicitLine(
        { ...options, file: outside },
        { reason: "file_outside_root" },
      );
    });
  }

  it("the ambiguous list at exactly the cap (20 lines) has no count tail; one line more names it as `and 1 more`", async () => {
    useLockDir();
    const repo = initRepo();
    const lines = (n: number): string =>
      Array.from({ length: n }, (_, i) => `hit${String(i)}`).join("\n") + "\n";
    fs.writeFileSync(path.join(repo, "twenty.js"), lines(20));
    const twenty = await probe(
      matchOptions(repo, { file: "twenty.js", matchText: "hit" }),
    );
    expect(twenty.reason).toBe("match_ambiguous");
    expect(twenty.warnings.join("\n")).toContain("occurs on 20 lines");
    expect(twenty.warnings.join("\n")).toContain("19, 20; pass -n/--line");
    fs.writeFileSync(path.join(repo, "twentyone.js"), lines(21));
    const twentyOne = await probe(
      matchOptions(repo, { file: "twentyone.js", matchText: "hit" }),
    );
    expect(twentyOne.warnings.join("\n")).toContain(
      "19, 20, and 1 more; pass -n/--line",
    );
  });
});

describe("probe(): which calls reach the derivation at all (the form and its texts)", () => {
  it("the match form with no -M text and no line has nothing to derive from: line_required", async () => {
    useLockDir();
    const repo = initRepo();
    const result = await probe(matchOptions(repo, { matchText: undefined }));
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("line_required");
    expect(result.warnings).toContain("-n/--line is required");
  });

  it("the replace form never derives, even with a stray matchText that is unique in the file", async () => {
    useLockDir();
    const repo = initRepo();
    const result = await probe(
      matchOptions(repo, {
        form: "replace",
        replaceText: "  return false;",
        matchText: "n > 0",
        withText: undefined,
      }),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("line_required");
    expect(result.warnings.join("\n")).not.toContain("derived");
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
      FIXTURE_JS,
    );
  });

  it("the patch form never derives: a stray matchText that is on no line does not refuse the run", async () => {
    useLockDir();
    const repo = initRepo();
    const patch = path.join(makeTmpDir(), "m.patch");
    fs.writeFileSync(
      patch,
      [
        "--- a/fixture.js",
        "+++ b/fixture.js",
        "@@ -1,3 +1,3 @@",
        " function isPositive(n) {",
        "-  return n > 0;",
        "+  return true;",
        " }",
        "",
      ].join("\n"),
    );
    const result = await probe(
      matchOptions(repo, {
        file: undefined,
        form: "patch",
        patchPath: patch,
        matchText: "on no line of the file",
        withText: undefined,
      }),
    );
    expect(result.status).toBe("killed");
    expect(result.mutant?.line).toBe(2);
    expect(result.warnings.join("\n")).not.toContain("derived");
  });

  it("a plan entry is untouched: a match mutant with no line is still refused by the plan's own validation", () => {
    const planPath = path.join(makeTmpDir(), "plan.json");
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        test: "node fixture.test.js",
        mutants: [{ file: "fixture.js", match: "n > 0", with: "true" }],
      }),
    );
    const parsed = parsePlanFile(planPath);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("plan_invalid");
    expect(parsed.message).toContain("plan.mutants[0].line");
  });
});

describe("cli: a FIFO --file without -n never blocks, whatever leads to it", () => {
  interface FifoRow {
    name: string;
    /** Creates the FIFO and returns the `--file` value and extra args. */
    setup: (repo: string) => { file: string; extra: string[] };
    /** What both runs must say: an envelope `reason`, or a message part. */
    reason?: string;
    message?: string;
  }

  const rows: FifoRow[] = [
    {
      name: "under the default isolation (worktree)",
      setup: (repo) => {
        execFileSync("mkfifo", [path.join(repo, "fifo.pipe")]);
        return { file: "fifo.pipe", extra: [] };
      },
      reason: "target_not_synced",
    },
    {
      name: "through a symlink, -i inplace",
      setup: (repo) => {
        execFileSync("mkfifo", [path.join(repo, "fifo.pipe")]);
        fs.symlinkSync("fifo.pipe", path.join(repo, "link-fifo"));
        return { file: "link-fifo", extra: ["-i", "inplace"] };
      },
      message: "not a regular file",
    },
    {
      name: "outside the repository with --allow-outside, -i inplace",
      setup: () => {
        const fifo = path.join(makeTmpDir(), "fifo.pipe");
        execFileSync("mkfifo", [fifo]);
        return { file: fifo, extra: ["-i", "inplace", "--allow-outside"] };
      },
      message: "not a regular file",
    },
  ];

  for (const row of rows) {
    it(`${row.name}: the same answer as with -n, well inside the bound`, async () => {
      useLockDir();
      const repo = initRepo();
      const { file, extra } = row.setup(repo);
      const args = (line: string[]): string[] => [
        "-C",
        repo,
        "probe",
        "--file",
        file,
        ...line,
        "-M",
        "anything",
        "-w",
        "true",
        "-t",
        "node fixture.test.js",
        ...extra,
      ];
      const without = await runCliBounded(args([]));
      expect(without.timedOut).toBe(false);
      const withLine = await runCliBounded(args(["-n", "1"]));
      expect(withLine.timedOut).toBe(false);
      const a = JSON.parse(without.stdout);
      const b = JSON.parse(withLine.stdout);
      expect({
        status: a.status,
        reason: a.reason,
        message: a.message,
      }).toEqual({ status: b.status, reason: b.reason, message: b.message });
      if (row.reason !== undefined) expect(a.reason).toBe(row.reason);
      if (row.message !== undefined) {
        expect(without.stdout).toContain(row.message);
      }
      expect(without.stdout).not.toContain("-n/--line is required");
    }, 20000);
  }
});

describe("cli: probe -M without -n under the CLI's own defaults", () => {
  function cliArgs(
    cwd: string,
    file: string,
    testCommand: string,
    extra: string[] = [],
  ): string[] {
    return [
      "-C",
      cwd,
      "probe",
      "--file",
      file,
      "-M",
      "n > 0",
      "-w",
      "true",
      "-t",
      testCommand,
      ...extra,
    ];
  }

  for (const isolationArgs of [[], ["-i", "worktree"]]) {
    it(`${isolationArgs.length === 0 ? "no -i (the default isolation, worktree)" : "-i worktree"} and no --allow-outside in a git repository: the line is derived and the mutant is killed in the worktree`, async () => {
      const fx = initLayeredRepo();
      const run = await spawnCli(
        cliArgs(fx.repo, "fixture.js", "node fixture.test.js", isolationArgs),
      );
      expect(run.code).toBe(0);
      const envelope = JSON.parse(run.stdout);
      expect(envelope.status).toBe("killed");
      expect(envelope.isolation.mode).toBe("worktree");
      expect(envelope.mutant.line).toBe(2);
      expect(JSON.stringify(envelope.warnings)).toContain(
        `derived from the unique -M/--match occurrence: line 2 of ${path.join(fx.repo, "fixture.js")}`,
      );
      expect(JSON.stringify(envelope.warnings)).not.toContain("line 0");
      // The working tree itself was never the mutation target.
      expect(fs.readFileSync(path.join(fx.repo, "fixture.js"), "utf8")).toBe(
        FIXTURE_JS,
      );
    });
  }

  it("no -i: --report mutation-probes carries the derived line as the item's anchor", async () => {
    const fx = initLayeredRepo();
    const run = await spawnCli(
      cliArgs(fx.repo, "fixture.js", "node fixture.test.js", [
        "--report",
        "mutation-probes",
      ]),
    );
    expect(run.code).toBe(0);
    const items = JSON.parse(run.stdout);
    expect(items).toHaveLength(1);
    expect(items[0].anchor).toBe(2);
    expect(items[0].result).toBe("killed");
  });

  it("no -i: a symlink to an in-repo file derives, a symlink to an outside file answers file_outside_root as with -n and names no line of it", async () => {
    const fx = initLayeredRepo();
    const inRepo = await spawnCli(
      cliArgs(fx.repo, "link-in.js", "node fixture.test.js"),
    );
    expect(inRepo.code).toBe(0);
    expect(JSON.parse(inRepo.stdout).mutant.line).toBe(2);
    const without = await spawnCli(
      cliArgs(fx.repo, "link-out.js", "node -e 0"),
    );
    const withLine = await spawnCli(
      cliArgs(fx.repo, "link-out.js", "node -e 0", ["-n", "1"]),
    );
    const a = JSON.parse(without.stdout);
    const b = JSON.parse(withLine.stdout);
    expect(a.reason).toBe("file_outside_root");
    expect({ code: without.code, status: a.status, reason: a.reason }).toEqual({
      code: withLine.code,
      status: b.status,
      reason: b.reason,
    });
    expect(a.warnings).toEqual(b.warnings);
    expect(without.stdout).not.toContain("occurs on");
  });

  it("no -i with --allow-outside in a git repository: worktree_allow_outside_unsupported as with -n, the outside file is not searched", async () => {
    const fx = initLayeredRepo();
    const outside = path.join(fx.outside, "two.js");
    const without = await spawnCli(
      cliArgs(fx.repo, outside, "node -e 0", ["--allow-outside"]),
    );
    const withLine = await spawnCli(
      cliArgs(fx.repo, outside, "node -e 0", ["--allow-outside", "-n", "1"]),
    );
    const a = JSON.parse(without.stdout);
    const b = JSON.parse(withLine.stdout);
    expect(a.reason).toBe("worktree_allow_outside_unsupported");
    expect({ code: without.code, status: a.status, reason: a.reason }).toEqual({
      code: withLine.code,
      status: b.status,
      reason: b.reason,
    });
    expect(a.warnings).toEqual(b.warnings);
    expect(without.stdout).not.toContain("occurs on");
  });

  it("no -i outside a git work tree: the default falls back to inplace and the line is derived", async () => {
    const plain = makeTmpDir();
    fs.writeFileSync(path.join(plain, "t.js"), "a\nn > 0\n");
    const run = await spawnCli(cliArgs(plain, "t.js", "node -e 0"));
    const envelope = JSON.parse(run.stdout);
    expect(envelope.status).toBe("survived");
    expect(envelope.isolation.mode).toBe("inplace");
    expect(envelope.mutant.line).toBe(2);
    expect(fs.readFileSync(path.join(plain, "t.js"), "utf8")).toBe(
      "a\nn > 0\n",
    );
  });

  it("-C below the repository root: a relative --file resolves against -C, and the line is derived from THAT file", async () => {
    const fx = initLayeredRepo();
    // `fixture.js` exists at the root too, with the text on line 2.
    const run = await spawnCli(
      cliArgs(path.join(fx.repo, "sub"), "fixture.js", "node -e 0"),
    );
    const envelope = JSON.parse(run.stdout);
    expect(envelope.status).toBe("survived");
    expect(envelope.mutant.line).toBe(3);
    expect(JSON.stringify(envelope.warnings)).toContain(
      `line 3 of ${path.join(fx.repo, "sub", "fixture.js")}`,
    );
  });
});

describe("probe(): explicit -n and -r are unchanged by the derivation", () => {
  it("explicit -n still wins, and still refuses mutant_not_applicable when the text is not on that line", async () => {
    useLockDir();
    const repo = initRepo();
    const result = await probe(
      matchOptions(repo, { line: 5, matchText: "n > 0" }),
    );
    // Line 5 is `return n * 2;`: no derivation jumps to line 2 just
    // because the text is unique there.
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_not_applicable");
    expect(result.warnings.join("\n")).toContain(
      "substring not found on line 5",
    );
    expect(result.line_content).toBe("return n * 2;");
    expect(result.mutant).toBeUndefined();
  });

  it("explicit -n on the line that DOES contain the text mutates that line, no derived-from warning", async () => {
    useLockDir();
    const repo = initRepo();
    const result = await probe(matchOptions(repo, { line: 2 }));
    expect(result.status).toBe("killed");
    expect(result.mutant?.line).toBe(2);
    expect(result.warnings.join("\n")).not.toContain("derived");
  });

  it("-r without a line is still line_required: -r has nothing to derive from", async () => {
    useLockDir();
    const repo = initRepo();
    const result = await probe(
      matchOptions(repo, {
        line: undefined,
        form: "replace",
        replaceText: "  return false;",
        matchText: undefined,
        withText: undefined,
      }),
    );
    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("line_required");
  });
});

describe("cli: probe -M without -n", () => {
  const tmpDirs2: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs2.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRepo(): string {
    const repo = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-primitives-derivation-cli-"),
    );
    tmpDirs2.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "fixture.js"), FIXTURE_JS);
    fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
    return repo;
  }

  it("unique occurrence: exit 0, envelope mutant.line is the derived line, warnings name the derivation", async () => {
    const repo = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "fixture.js",
      "-M",
      "n > 0",
      "-w",
      "true",
      "-t",
      "node fixture.test.js",
      "-i",
      "inplace",
    ]);
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.status).toBe("killed");
    expect(envelope.mutant.line).toBe(2);
    expect(JSON.stringify(envelope.warnings)).toContain(
      "derived from the unique -M/--match occurrence",
    );
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
      FIXTURE_JS,
    );
  });

  it("no occurrence: exit 2, reason match_not_found naming file and text, nothing mutated", async () => {
    const repo = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "fixture.js",
      "-M",
      "n > 999",
      "-w",
      "true",
      "-t",
      "node fixture.test.js",
      "-i",
      "inplace",
    ]);
    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.status).toBe("usage_error");
    expect(envelope.reason).toBe("match_not_found");
    expect(JSON.stringify(envelope.warnings)).toContain("n > 999");
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
      FIXTURE_JS,
    );
  });

  it("several occurrences: exit 2, reason match_ambiguous listing the numbers", async () => {
    const repo = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "fixture.js",
      "-M",
      "return",
      "-w",
      "throw",
      "-t",
      "node fixture.test.js",
      "-i",
      "inplace",
    ]);
    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.status).toBe("usage_error");
    expect(envelope.reason).toBe("match_ambiguous");
    expect(JSON.stringify(envelope.warnings)).toContain("2, 5");
  });

  it("explicit -n still takes precedence over the derivation: the named line without the text still refuses mutant_not_applicable", async () => {
    const repo = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "fixture.js",
      "-n",
      "5",
      "-M",
      "n > 0",
      "-w",
      "true",
      "-t",
      "node fixture.test.js",
      "-i",
      "inplace",
    ]);
    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.status).toBe("inconclusive");
    expect(envelope.reason).toBe("mutant_not_applicable");
  });

  it("-r without -n is STILL a CLI usage error naming -n/--line (only -M defers to the derivation)", async () => {
    const repo = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "fixture.js",
      "-r",
      "  return false;",
      "-t",
      "node fixture.test.js",
    ]);
    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.status).toBe("usage_error");
    expect(envelope.message).toContain("-n/--line is required");
  });

  it("-M without --file is still a CLI usage error naming --file", async () => {
    const repo = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "-M",
      "n > 0",
      "-w",
      "true",
      "-t",
      "node fixture.test.js",
    ]);
    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.status).toBe("usage_error");
    expect(envelope.message).toContain("--file is required");
  });

  it("a -M derivation followed by a defaults-file refusal: --summary's note is the refusal, not the derivation notice", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".agent-primitives.json"), "{ not json");
    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "fixture.js",
      "-M",
      "n > 0",
      "-w",
      "true",
      "-t",
      "node fixture.test.js",
      "-i",
      "inplace",
      "--summary",
    ]);
    expect(run.code).toBe(2);
    // The derivation reached line 2 (the unique `n > 0`) and pushed its
    // notice; the invalid repo defaults file refused right after the
    // `line_required` guard. The note must name THAT refusal.
    expect(run.stdout).toContain("reason=defaults_file_invalid");
    const noteLine = run.stdout
      .trimEnd()
      .split("\n")
      .find((line) => line.startsWith("note: "));
    expect(noteLine).toBeDefined();
    expect(noteLine).toContain(".agent-primitives.json");
    expect(noteLine).toContain("not valid JSON");
    expect(noteLine).not.toContain("derived from the unique");
  });

  it("the same defaults-file refusal with no derivation (a -r/-n run): --summary's note is unchanged", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".agent-primitives.json"), "{ not json");
    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "fixture.js",
      "-n",
      "2",
      "-r",
      "  return false;",
      "-t",
      "node fixture.test.js",
      "-i",
      "inplace",
      "--summary",
    ]);
    expect(run.code).toBe(2);
    expect(run.stdout).toContain("reason=defaults_file_invalid");
    const noteLine = run.stdout
      .trimEnd()
      .split("\n")
      .find((line) => line.startsWith("note: "));
    expect(noteLine).toBeDefined();
    expect(noteLine).toContain(".agent-primitives.json");
    expect(noteLine).toContain("not valid JSON");
    expect(noteLine).not.toContain("derived from the unique");
  });
});

// A symlink whose OWN mode is 000 (`lchmod`, macOS only: Linux has no
// symlink modes) makes `fs.realpathSync` fail with EACCES while the
// kernel still follows the link for `stat` and `open`. Judging such a
// link by the parent's realpath plus its own name read it as an in-repo
// file, so the `-M` derivation read the outside file behind it and a run
// with `-n` mutated it. Skipped under uid 0 (root reads everything, so
// the mode changes nothing) and off darwin.
describe.skipIf(process.platform !== "darwin" || process.getuid?.() === 0)(
  "probe(): an in-repo mode-000 symlink to an outside file is never inside the root",
  () => {
    type Mode = "inplace" | "worktree";
    const MODES: Mode[] = ["inplace", "worktree"];

    /** The layered repository plus `link-000.js` -> `outside/two.js`
     * (two lines carry the `-M` text) with the link's own mode set to
     * 000. Untracked, so the committed fixture stays as it is. */
    function withMode000Link(): Layered & {
      link: string;
      outsideFile: string;
      before: string;
    } {
      const fx = initLayeredRepo();
      const outsideFile = path.join(fx.outside, "two.js");
      const link = path.join(fx.repo, "link-000.js");
      fs.symlinkSync(outsideFile, link);
      fs.lchmodSync(link, 0o000);
      return {
        ...fx,
        link,
        outsideFile,
        before: fs.readFileSync(outsideFile, "utf8"),
      };
    }

    for (const mode of MODES) {
      for (const line of [undefined, 1]) {
        it(`${mode} isolation, ${line === undefined ? "without -n" : "-n 1"}: answers file_outside_root and touches nothing outside the root`, async () => {
          const lockDir = useLockDir();
          const fx = withMode000Link();
          const result = await probe(
            matchOptions(fx.repo, {
              file: "link-000.js",
              isolation: mode,
              ...(line === undefined ? {} : { line }),
            }),
          );
          expect(result.status).toBe("inconclusive");
          expect(result.reason).toBe("file_outside_root");
          const text = result.warnings.join("\n");
          expect(text).toContain("link-000.js");
          // Never the derivation's own answers: the outside file's line
          // numbers are not disclosed, nothing was searched.
          expect(text).not.toContain("occurs on");
          expect(text).not.toContain("derived from");
          expect(fs.readFileSync(fx.outsideFile, "utf8")).toBe(fx.before);
          expectNoIsolationLeftovers(fx.repo, lockDir);
        });
      }
    }

    it("answers the same with and without -n", async () => {
      useLockDir();
      const fx = withMode000Link();
      for (const mode of MODES) {
        const options = matchOptions(fx.repo, {
          file: "link-000.js",
          isolation: mode,
        });
        const without = await answerOf(options);
        const withLine = await answerOf({ ...options, line: 1 });
        expect(without).toEqual(withLine);
        expect(without.reason).toBe("file_outside_root");
      }
    });

    it("--allow-outside does not make it a placed path: still file_outside_root, nothing written", async () => {
      useLockDir();
      const fx = withMode000Link();
      const result = await probe(
        matchOptions(fx.repo, {
          file: "link-000.js",
          line: 1,
          allowOutside: true,
        }),
      );
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("file_outside_root");
      expect(fs.readFileSync(fx.outsideFile, "utf8")).toBe(fx.before);
    });

    it("a file below a mode-000 symlinked directory is refused: -M without -n derives nothing from it", async () => {
      useLockDir();
      const fx = initLayeredRepo();
      const dirLink = path.join(fx.repo, "dir-000");
      fs.symlinkSync(fx.outside, dirLink);
      fs.lchmodSync(dirLink, 0o000);
      const outsideFile = path.join(fx.outside, "two.js");
      const before = fs.readFileSync(outsideFile, "utf8");
      const options = matchOptions(fx.repo, { file: "dir-000/two.js" });
      const without = await answerOf(options);
      const withLine = await answerOf({ ...options, line: 1 });
      expect(without).toEqual(withLine);
      expect(without.reason).toBe("file_outside_root");
      expect(fs.readFileSync(outsideFile, "utf8")).toBe(before);
    });

    it("an auto-discovered node_modules that is a mode-000 symlink is skipped with a warning, the run goes on and links nothing", async () => {
      const lockDir = useLockDir();
      const fx = initLayeredRepo();
      fs.writeFileSync(path.join(fx.repo, ".gitignore"), "node_modules\n");
      const nm = path.join(fx.repo, "node_modules");
      fs.symlinkSync(fx.outside, nm);
      fs.lchmodSync(nm, 0o000);
      const result = await probe(
        matchOptions(fx.repo, { isolation: "worktree", line: 2 }),
      );
      expect(result.reason).not.toBe("file_outside_root");
      expect(result.status).toBe("killed");
      expect(result.isolation.linked).toEqual([]);
      expect(result.warnings.join("\n")).toMatch(
        /skipped linking .*node_modules: its target cannot be resolved \(EACCES\)/,
      );
      expectNoIsolationLeftovers(fx.repo, lockDir);
    });

    it("a mode-000 symlink to a file INSIDE the repo is refused too: where it points cannot be placed", async () => {
      useLockDir();
      const fx = initLayeredRepo();
      const inside = path.join(fx.repo, "link-000-in.js");
      fs.symlinkSync("fixture.js", inside);
      fs.lchmodSync(inside, 0o000);
      const result = await probe(
        matchOptions(fx.repo, { file: "link-000-in.js", line: 2 }),
      );
      expect(result.reason).toBe("file_outside_root");
    });

    for (const mode of MODES) {
      it(`a plan naming it answers file_outside_root under ${mode} isolation and writes nothing`, async () => {
        const lockDir = useLockDir();
        const fx = withMode000Link();
        const result = await probePlan({
          mutants: [
            {
              file: "link-000.js",
              line: 1,
              form: "replace",
              replaceText: "x",
            },
          ],
          testCommand: "node fixture.test.js",
          isolation: mode,
          expect: "fail",
          cwd: fx.repo,
          logDir: makeTmpDir(),
        });
        expect(result.status).toBe("usage_error");
        expect(result.reason).toBe("file_outside_root");
        expect(fs.readFileSync(fx.outsideFile, "utf8")).toBe(fx.before);
        expectNoIsolationLeftovers(fx.repo, lockDir);
      });
    }

    it("a regular file with mode 000 is unchanged: -M without -n still derives its refusal from the failed read", async () => {
      useLockDir();
      const fx = initLayeredRepo();
      const secret = path.join(fx.repo, "secret-000.js");
      fs.writeFileSync(secret, "n > 0\n");
      fs.chmodSync(secret, 0o000);
      try {
        const without = await answerOf(
          matchOptions(fx.repo, { file: "secret-000.js" }),
        );
        const withLine = await answerOf(
          matchOptions(fx.repo, { file: "secret-000.js", line: 1 }),
        );
        expect(without).toEqual(withLine);
        expect(without.status).toBe("threw");
        expect(without.text).toMatch(/EACCES/);
      } finally {
        fs.chmodSync(secret, 0o644);
      }
    });
  },
);

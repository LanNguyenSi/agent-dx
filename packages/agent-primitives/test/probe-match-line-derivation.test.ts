import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { probe, type ProbeOptions } from "../src/probe/index.js";
import { matchLineNumbers } from "../src/probe/mutant.js";
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
    const run = spawnSync(
      process.execPath,
      [
        CLI_PATH,
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
      ],
      { encoding: "utf8", timeout: 8000, killSignal: "SIGKILL" },
    );
    expect(run.error).toBeUndefined();
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
});

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, afterEach } from "vitest";
import { CommanderError } from "commander";
import {
  boundText,
  classifyStdoutError,
  mapTopLevelError,
  writeAndExitTo,
  parseExecOverride,
  writeFullVerifyResult,
  type ResolvedGlobal,
  type StdoutSink,
} from "../src/cli.js";
import { UsageError } from "../src/envelope.js";
import type { VerifyResult, CheckResult } from "../src/verify/index.js";
import {
  assertArgvWithinLimit,
  buildSpawnEnv,
  CLI_PATH,
  FIXED_BINARIES,
  FIXED_BIN_DIR,
  FIXED_TMPDIR,
  MAX_ARGV_ELEMENT_BYTES,
  resolveBinary,
  spawnCli,
} from "./helpers/spawn-cli.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-cli-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

/** Names that are certain not to resolve to anything on any PATH, used to
 * inflate a doctor result to a chosen size without depending on what the
 * host has installed. Deliberately short: doctor's per-tool JSON overhead
 * (`{"name":...,"required":false,"found":false}`) dwarfs the name itself,
 * so a long, large-`count` list stays well under the fixture argv limit
 * (Linux's `MAX_ARG_STRLEN`, see spawn-cli.ts) while still producing an
 * envelope far past the 64 KiB pipe buffer. */
function absentNames(count: number): string {
  return Array.from({ length: count }, (_, i) => `nb${i}`).join(",");
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cli test environment", () => {
  it("hands every spawned CLI a PATH of exactly the four fixed binaries, not the host's", () => {
    const env = buildSpawnEnv();
    expect(env.PATH?.split(path.delimiter)).toEqual([FIXED_BIN_DIR]);
    expect(fs.readdirSync(FIXED_BIN_DIR).sort()).toEqual([...FIXED_BINARIES]);
    // Nothing from this process's own environment leaks into the child:
    // an AGENT_PRIMITIVES_* variable in a developer's shell would
    // otherwise silently redirect the log directory under test.
    expect(
      Object.keys(env).filter((key) => key.startsWith("AGENT_PRIMITIVES_")),
    ).toEqual([]);
  });
});

describe("cli", () => {
  it("prints parseable JSON with status: usage_error on stdout and exits 2 for a mistyped flag", async () => {
    const run = await spawnCli(["doctor", "--no-such-flag"]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("usage_error");
    expect(parsed.tool).toBe("agent-primitives");
  });

  it("exits 0 for --help", async () => {
    const run = await spawnCli(["--help"]);
    expect(run.code).toBe(0);
  });

  it("exits 0 for doctor --help", async () => {
    const run = await spawnCli(["doctor", "--help"]);
    expect(run.code).toBe(0);
  });

  it("exits 2 with usage_error for an invalid --format value", async () => {
    const run = await spawnCli(["doctor", "-f", "yaml"]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("usage_error");
  });

  it("reports a missing required tool as status: missing with exit 1", async () => {
    const run = await spawnCli([
      "doctor",
      "-r",
      "node,definitely-not-a-binary-xyz",
      "-o",
      "",
    ]);
    expect(run.code).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("missing");
    const tool = parsed.tools.find(
      (t: { name: string }) => t.name === "definitely-not-a-binary-xyz",
    );
    expect(tool.found).toBe(false);
  });

  it("exits 0 with status ok when every required binary is on the fixed PATH", async () => {
    const run = await spawnCli(["doctor", "-r", "node,npm,git,sh", "-o", ""]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).status).toBe("ok");
  });

  it("returns not_implemented usage_error for the init stub", async () => {
    // `probe` and `verify` are both implemented (see their own describe
    // blocks below), so `init` is the only stub left. `verify` would in
    // any case be excluded here: running it with no `-C` would target
    // this package's own real cwd and its real `test` script, re-invoking
    // this very test suite from inside itself.
    for (const sub of ["init"]) {
      const run = await spawnCli([sub]);
      expect(run.code).toBe(2);
      const parsed = JSON.parse(run.stdout);
      expect(parsed.status).toBe("usage_error");
      expect(parsed.reason).toBe("not_implemented");
    }
  });

  it("probe is no longer a stub: missing required flags is a normal commander usage_error", async () => {
    const run = await spawnCli(["probe"]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("usage_error");
    expect(parsed.reason).not.toBe("not_implemented");
  });

  it("rejects a -r entry shaped like a path traversal as usage_error (never resolved as a real binary)", async () => {
    const run = await spawnCli(["doctor", "-r", "../../x"]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("usage_error");
  });

  it("rejects -C at a nonexistent directory as usage_error, exit 2", async () => {
    const run = await spawnCli([
      "-C",
      "/definitely/does/not/exist/xyz",
      "doctor",
    ]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("usage_error");
  });

  it("rejects -C pointing at a file (not a directory) as usage_error, exit 2", async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "a-file");
    fs.writeFileSync(filePath, "x");
    const run = await spawnCli(["-C", filePath, "doctor"]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("usage_error");
  });

  it("reports doctor's real status under a tight -m for a binary whose --version prints nothing", async () => {
    // A found binary with no version output used to leave `version:
    // undefined` as an own property of the result; measuring that property
    // while reducing the envelope threw, and the command reported
    // `command: unknown`, `status: error` instead of its real verdict. -m
    // 500 is small enough that the reduction actually runs.
    const dir = makeTmpDir();
    const stubPath = path.join(dir, "quiet-tool");
    fs.writeFileSync(stubPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(stubPath, 0o755);
    const run = await spawnCli(
      ["-m", "500", "doctor", "-r", "quiet-tool,node", "-o", ""],
      { env: { PATH: `${dir}${path.delimiter}${FIXED_BIN_DIR}` } },
    );
    const parsed = JSON.parse(run.stdout);
    expect(parsed.command).toBe("doctor");
    expect(parsed.status).not.toBe("error");
    expect(parsed.status).toBe("ok");
    expect(run.code).toBe(0);
  });

  it("keeps a 2,000-tool doctor result under the default -m with an honest array marker", async () => {
    const run = await spawnCli(["doctor", "-r", absentNames(2000), "-o", ""]);
    expect(run.code).toBe(1);
    const body = run.stdout.trim();
    expect(body.length).toBeLessThanOrEqual(8000);
    const parsed = JSON.parse(body);
    expect(parsed.command).toBe("doctor");
    expect(parsed.status).toBe("missing");
    expect(parsed.truncated).toBe(true);
    const tools = parsed.tools as unknown[];
    const marker = tools[tools.length - 1];
    expect(typeof marker).toBe("string");
    const omitted = Number(
      /^\.\.\.\((\d+) more items? omitted\)$/.exec(marker as string)?.[1],
    );
    // Honest: what is reported missing plus what is reported kept has to
    // account for every tool that was actually checked.
    expect(omitted + (tools.length - 1)).toBe(2000);
    expect(tools.length - 1).toBeGreaterThan(0);
  });

  it("writes the full result under the helper's fixed TMPDIR, not the host's, when a run truncates", async () => {
    const run = await spawnCli(["doctor", "-r", absentNames(2000), "-o", ""]);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.truncated).toBe(true);
    const logs = parsed.logs as string[];
    expect(logs.length).toBeGreaterThan(0);
    // The child resolves its default log directory from TMPDIR; if the
    // helper's TMPDIR did not reach it, this path lands in the host's temp
    // directory instead.
    expect(logs[0].startsWith(FIXED_TMPDIR)).toBe(true);
    expect(path.basename(logs[0])).toMatch(/^result-full-.+\.json$/);
  });

  it("prints a bounded pretty-JSON fallback for -f text on a command with no dedicated text renderer", async () => {
    const run = await spawnCli(["-f", "text", "probe"]);
    expect(run.code).toBe(2);
    // Pretty-printed (multi-line, 2-space indented), unlike the single-line
    // compact JSON the default `-f json` path emits.
    expect(run.stdout).toContain('"status": "usage_error"');
    expect(run.stdout.split("\n").length).toBeGreaterThan(1);
    expect(JSON.parse(run.stdout).status).toBe("usage_error");
  });

  it("bounds -f text output to -m exactly and names the full length in the marker", async () => {
    const run = await spawnCli(["-f", "text", "-m", "80", "doctor"]);
    expect(run.stdout.length).toBeLessThanOrEqual(80);
    expect(run.stdout).toContain("truncated");
    expect(run.stdout).toMatch(/truncated, \d+ characters total/);
  });

  it("never emits more than -m characters of text even below the truncation marker's own length", async () => {
    const run = await spawnCli([
      "-f",
      "text",
      "-m",
      "5",
      "doctor",
      "-r",
      "node",
      "-o",
      "",
    ]);
    expect(run.stdout.length).toBeLessThanOrEqual(5);
  });

  it("-f text -m 80 still prints the real tool name (renders from the untouched doctor result, never a reduced/mutated envelope)", async () => {
    const run = await spawnCli([
      "-f",
      "text",
      "-m",
      "80",
      "doctor",
      "-r",
      "node",
      "-o",
      "",
    ]);
    expect(run.stdout).toContain("node");
  });

  it("refuses an oversized argv element instead of risking spawn E2BIG on CI", () => {
    const oversized = "x".repeat(MAX_ARGV_ELEMENT_BYTES + 1);
    expect(() => spawnCli(["doctor", "-r", oversized])).toThrow(
      /MAX_ARG_STRLEN/,
    );
  });

  it("delivers an envelope larger than the pipe buffer intact through a piped stdout", async () => {
    // Regression test for the write-then-exit race: process.exit()
    // immediately after stdout.write() can truncate output larger than the
    // pipe buffer (64 KiB on most platforms) before the reader has drained
    // it. A long -o list of never-found names pushes the envelope well
    // past that; -m 900000 keeps the envelope module from truncating it
    // back down first. The helper attaches its readers before returning
    // and resolves on the child's own `close`, so this asserts the CLI's
    // output, not a timing window.
    const run = await spawnCli([
      "doctor",
      "-m",
      "900000",
      "-r",
      "node",
      "-o",
      absentNames(5000),
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout.length).toBeGreaterThan(64 * 1024);
    expect(() => JSON.parse(run.stdout)).not.toThrow();
    expect(JSON.parse(run.stdout).tool).toBe("agent-primitives");
  });

  it("exits with its own success code and empty stderr on a real EPIPE (reader closes early through | head -c 100)", async () => {
    // The reader has to close the pipe while the CLI still has output
    // queued, so the payload must exceed the pipe buffer: below it the
    // whole envelope lands in the buffer, the write completes, and no
    // EPIPE is ever raised. The CLI's own exit code is recorded inside the
    // pipeline's left-hand side (`$?` into a file) rather than read off
    // the pipeline, whose exit code is `head`'s and is 0 no matter what
    // the CLI did. `head -c` and `{ ...; } | ...` are plain POSIX, not a
    // dash-vs-bash difference; the CLI itself still runs on the fixed
    // PATH, and `head` is the one host binary this suite reaches for
    // outside those four, by absolute path.
    const shPath = resolveBinary("sh");
    const headPath = resolveBinary("head");
    if (!shPath || !headPath) {
      throw new Error("this test needs a POSIX sh and head on the host");
    }
    const dir = makeTmpDir();
    const statusFile = path.join(dir, "cli-exit");
    const script =
      `{ ${shQuote(process.execPath)} ${shQuote(CLI_PATH)} doctor -m 900000 ` +
      `-r node -o ${shQuote(absentNames(5000))}; echo $? > ${shQuote(statusFile)}; } ` +
      `| ${shQuote(headPath)} -c 100`;
    // This spawn goes straight to node:child_process, not through
    // spawnCli/spawnCliRaw, so it does not get that helper's automatic
    // argv guard; assert it here explicitly.
    assertArgvWithinLimit(["-c", script]);
    const shell = spawn(shPath, ["-c", script], {
      env: buildSpawnEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    shell.stderr.setEncoding("utf8");
    shell.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      shell.on("error", reject);
      shell.on("close", () => resolve());
    });
    expect(stderr).toBe("");
    expect(fs.readFileSync(statusFile, "utf8").trim()).toBe("0");
  });
});

describe("boundText", () => {
  it("leaves text at or below maxChars untouched", () => {
    expect(boundText("hello", 5)).toBe("hello");
    expect(boundText("hello", 50)).toBe("hello");
  });

  it("cuts to exactly maxChars and states the full length in the marker", () => {
    const text = "y".repeat(500);
    const out = boundText(text, 120);
    expect(out.length).toBe(120);
    expect(out).toContain("truncated, 500 characters total");
  });

  it("slices the marker itself rather than exceeding a maxChars below the marker's length", () => {
    const text = "y".repeat(500);
    for (const maxChars of [1, 5, 17, 30]) {
      const out = boundText(text, maxChars);
      expect(out.length).toBeLessThanOrEqual(maxChars);
    }
  });
});

describe("cli verify", () => {
  // Every case here passes an explicit -C to a fresh, empty tmp dir (never
  // the package's own real cwd): `verify` with no package.json and no `-x`
  // override for a default check name just skips it, so these never touch
  // this package's own real build/typecheck/lint/test scripts.
  it("-x mycheck='exit 1' is a fail with one synthetic failure, status fail, exit 1", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "verify",
      "-x",
      "mycheck=exit 1",
    ]);
    expect(run.code).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    const check = parsed.checks.find(
      (c: { name: string }) => c.name === "mycheck",
    );
    expect(check.status).toBe("fail");
    expect(check.failures).toHaveLength(1);
  });

  it("-x mycheck='exit 0' is a pass, exit 0", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "verify",
      "-x",
      "mycheck=exit 0",
    ]);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("pass");
  });

  it("-x nope=nonexistent-binary-xyz is a check error, status error, exit 2", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "verify",
      "-x",
      "nope=nonexistent-binary-xyz",
    ]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("error");
    const check = parsed.checks.find(
      (c: { name: string }) => c.name === "nope",
    );
    expect(check.status).toBe("error");
  });

  it("a FAILING check printing a multi-megabyte single line stays within --max-chars and is marked truncated", async () => {
    // A passing check carries no output in the envelope at all, so a
    // multi-megabyte line on a passing check never touches the reduction
    // logic (the earlier version of this test was inert for exactly that
    // reason). Failing forces the synthetic failure entry's message to
    // carry the (still large) output tail, which does exercise it.
    const cwd = makeTmpDir();
    const scriptPath = path.join(cwd, "big.js");
    fs.writeFileSync(
      scriptPath,
      "process.stdout.write('y'.repeat(5 * 1000 * 1000));" +
        "process.stderr.write('z'.repeat(5 * 1000 * 1000));" +
        "process.exitCode = 1;\n",
    );
    const logDir = makeTmpDir();
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "-m",
      "8000",
      "verify",
      "-x",
      `big=node ${scriptPath}`,
    ]);
    expect(run.code).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(JSON.stringify(parsed).length).toBeLessThanOrEqual(8000);
    expect(parsed.status).toBe("fail");
    expect(parsed.truncated).toBe(true);
  }, 20000);

  it("rejects a -c name carrying shell metacharacters as usage_error, never executed (no side-effect file appears)", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const sentinel = path.join(cwd, "pwned");
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "verify",
      "-c",
      `test; touch ${sentinel}`,
    ]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("usage_error");
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("--fail-fast on a package missing `build` runs typecheck, lint, and test", async () => {
    const cwd = makeTmpDir();
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "0.0.0",
        scripts: { typecheck: "exit 0", lint: "exit 0", test: "exit 0" },
      }),
    );
    const logDir = makeTmpDir();
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "verify",
      "--fail-fast",
    ]);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("pass");
    const names = parsed.checks.map((c: { name: string }) => c.name);
    expect(names).toEqual(["build", "typecheck", "lint", "test"]);
    expect(
      parsed.checks.find((c: { name: string }) => c.name === "build").status,
    ).toBe("skipped");
    for (const name of ["typecheck", "lint", "test"]) {
      expect(
        parsed.checks.find((c: { name: string }) => c.name === name).status,
      ).toBe("pass");
    }
  });

  it("a package.json with none of the requested scripts is status error, reason nothing_verified, exit 2", async () => {
    const cwd = makeTmpDir();
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.0.0", scripts: {} }),
    );
    const logDir = makeTmpDir();
    const run = await spawnCli(["-C", cwd, "-l", logDir, "verify"]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("error");
    expect(parsed.reason).toBe("nothing_verified");
  });

  it("--timeout above the millisecond ceiling (2147483647ms) is a usage_error, exit 2", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "verify",
      "--timeout",
      "3000000",
    ]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("usage_error");
  });

  it("--max-failures 0 is a usage_error, exit 2", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "verify",
      "--max-failures",
      "0",
    ]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("usage_error");
  });

  it("--timeout 1 -x a busy-looping check times out: check status error, one synthetic failure naming timedOut, summary.errors 1, exit 2", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    // `sleep` is not on the fixed four-binary PATH spawnCli hands the
    // child (git, node, npm, sh), so the work being timed out has to come
    // from the shell itself. A `while true; do :; done` loop is a shell
    // builtin: dash runs it in the `sh` process with no fork, so the
    // fixture behaves the same whether or not the shell exec-replaces
    // itself for a trailing simple command (macOS's sh does, dash forks).
    // exec.ts signals the command's whole process group, so a forked
    // grandchild would be reached too (see exec.test.ts's stdio-holding
    // descendant case); the builtin keeps this fixture independent of
    // that and of what the host has installed.
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "verify",
      "--timeout",
      "1",
      "-x",
      "slow=while true; do :; done",
    ]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("error");
    const check = parsed.checks.find(
      (c: { name: string }) => c.name === "slow",
    );
    expect(check.status).toBe("error");
    expect(check.failures).toHaveLength(1);
    expect(check.failures[0].message).toContain("timedOut");
    expect(check.summary.errors).toBe(1);
  }, 15000);

  it("--max-failures 1 is accepted (a positive integer) and plumbs through to a real run", async () => {
    // The only detector shipped in v0 (generic) never parses more than
    // the failures invariant's single synthetic entry per check, so
    // `--max-failures 1` can never itself be the thing that trips
    // truncatedByMaxFailures through the real CLI (that cap is exercised
    // directly against `verify()` with a stub multi-failure detector, see
    // verify.test.ts). This asserts the flag is accepted and wired
    // through to a real run without changing its outcome; the
    // envelope-level `truncated`/full-result-in-`logs` behavior for a
    // large payload is covered by the "FAILING check printing a
    // multi-megabyte single line" case above.
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "verify",
      "--max-failures",
      "1",
      "-x",
      "one=exit 1",
    ]);
    expect(run.code).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("fail");
    const check = parsed.checks.find((c: { name: string }) => c.name === "one");
    expect(check.failures).toHaveLength(1);
  });

  it("-c '' resolves to an empty check list: status error, reason nothing_verified, exit 2", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const run = await spawnCli(["-C", cwd, "-l", logDir, "verify", "-c", ""]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("error");
    expect(parsed.reason).toBe("nothing_verified");
    expect(parsed.checks).toEqual([]);
  });

  it("-c ',,,' resolves to an empty check list: status error, reason nothing_verified, exit 2", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "verify",
      "-c",
      ",,,",
    ]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("error");
    expect(parsed.reason).toBe("nothing_verified");
    expect(parsed.checks).toEqual([]);
  });

  it("one exit-1 check and one exit-127 check: status error (error wins over fail), exit 2", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "verify",
      "-x",
      "f=exit 1",
      "-x",
      "e=exit 127",
    ]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("error");
  });

  it("checks[].logPath all nest under one verify/<id>/ parent whose <id> is the same run id embedded in the default log dir", async () => {
    const cwd = makeTmpDir();
    // No -l: the default log dir is <tmpdir>/agent-primitives/<runId>, and
    // verify() nests its own logs under <logDir>/verify/<runId> using
    // that same run id, so the id appears twice in each check's logPath.
    const run = await spawnCli([
      "-C",
      cwd,
      "verify",
      "-x",
      "a=exit 0",
      "-x",
      "b=exit 0",
      "-c",
      "a,b",
    ]);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout);
    const logPaths = parsed.checks.map((c: { logPath: string }) => c.logPath);
    expect(logPaths).toHaveLength(2);
    const parents = logPaths.map((p: string) => path.dirname(p));
    expect(parents[0]).toBe(parents[1]);
    expect(path.basename(path.dirname(parents[0]))).toBe("verify");
    const idFromVerifyNesting = path.basename(parents[0]);
    const idFromDefaultLogDir = path.basename(
      path.dirname(path.dirname(parents[0])),
    );
    expect(idFromVerifyNesting).toBe(idFromDefaultLogDir);
  });

  it("an unwritable log directory parent still yields an envelope with per-check errors, not a crash", async () => {
    const cwd = makeTmpDir();
    const parentDir = makeTmpDir();
    const logDir = path.join(parentDir, "logs");
    fs.chmodSync(parentDir, 0o500);
    try {
      const run = await spawnCli([
        "-C",
        cwd,
        "-l",
        logDir,
        "verify",
        "-x",
        "mycheck=exit 0",
      ]);
      const parsed = JSON.parse(run.stdout);
      expect(Array.isArray(parsed.checks)).toBe(true);
      const check = parsed.checks.find(
        (c: { name: string }) => c.name === "mycheck",
      );
      expect(check.status).toBe("error");
      expect(check.failures.length).toBeGreaterThan(0);
    } finally {
      fs.chmodSync(parentDir, 0o700);
    }
  });
});

describe("parseExecOverride", () => {
  it("splits name=command at the first `=` only, preserving an `=` inside the command", () => {
    const result = parseExecOverride("e=FOO=bar cmd", {});
    expect(result).toEqual({ e: "FOO=bar cmd" });
  });

  it("accumulates repeated -x flags into one object, keyed by name", () => {
    const first = parseExecOverride("a=echo 1", {});
    const second = parseExecOverride("b=echo 2", first);
    expect(second).toEqual({ a: "echo 1", b: "echo 2" });
  });

  it("rejects a value with an empty name (leading `=`)", () => {
    expect(() => parseExecOverride("=x", {})).toThrow();
  });

  it("rejects a value with no `=` at all", () => {
    expect(() => parseExecOverride("noequals", {})).toThrow();
  });
});

describe("classifyStdoutError", () => {
  it("maps EPIPE to the pending success exit code, with no stderr line", () => {
    const result = classifyStdoutError(
      { name: "Error", message: "EPIPE", code: "EPIPE" },
      0,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderrLine).toBeUndefined();
  });

  it("maps a non-EPIPE stdout error to exit 2 with one stderr line naming the code", () => {
    const result = classifyStdoutError(
      { name: "Error", message: "permission denied", code: "EACCES" },
      0,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderrLine).toContain("EACCES");
    expect(
      result.stderrLine?.split("\n").filter((l) => l.length > 0).length,
    ).toBe(1);
  });
});

describe("writeAndExitTo", () => {
  function fakeSink(err?: NodeJS.ErrnoException): {
    sink: StdoutSink;
    written: string[];
  } {
    const written: string[] = [];
    return {
      written,
      sink: {
        write(data, callback) {
          written.push(data);
          callback(err ?? null);
          return true;
        },
      },
    };
  }

  it("exits 2 and names the code on stderr when the write callback reports a non-EPIPE failure", () => {
    const err: NodeJS.ErrnoException = Object.assign(
      new Error("permission denied"),
      { code: "EACCES" },
    );
    const { sink, written } = fakeSink(err);
    const exits: number[] = [];
    const stderr: string[] = [];
    writeAndExitTo(
      "payload",
      0,
      sink,
      (code) => exits.push(code),
      (line) => stderr.push(line),
    );
    expect(written).toEqual(["payload"]);
    expect(exits).toEqual([2]);
    expect(stderr.join("")).toContain("EACCES");
  });

  it("keeps the command's own exit code and says nothing on stderr when the write callback reports EPIPE", () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error("EPIPE"), {
      code: "EPIPE",
    });
    const { sink } = fakeSink(err);
    const exits: number[] = [];
    const stderr: string[] = [];
    writeAndExitTo(
      "payload",
      1,
      sink,
      (code) => exits.push(code),
      (line) => stderr.push(line),
    );
    expect(exits).toEqual([1]);
    expect(stderr).toEqual([]);
  });

  it("exits with the command's own code when the write succeeds", () => {
    const { sink } = fakeSink();
    const exits: number[] = [];
    writeAndExitTo(
      "payload",
      1,
      sink,
      (code) => exits.push(code),
      () => {},
    );
    expect(exits).toEqual([1]);
  });
});

describe("mapTopLevelError", () => {
  const global: ResolvedGlobal = {
    format: "json",
    cwd: "/tmp",
    maxChars: 8000,
    logDir: "",
  };

  it("maps a plain Error to status: error, exit 2", () => {
    const { envelope, exitCode } = mapTopLevelError(
      new Error("boom"),
      global,
      Date.now(),
    );
    expect(envelope.status).toBe("error");
    expect(exitCode).toBe(2);
    expect((envelope as { message?: string }).message).toBe("boom");
  });

  it("maps a UsageError to status: usage_error, exit 2", () => {
    const { envelope, exitCode } = mapTopLevelError(
      new UsageError("bad flag"),
      global,
      Date.now(),
    );
    expect(envelope.status).toBe("usage_error");
    expect(exitCode).toBe(2);
    expect((envelope as { message?: string }).message).toBe("bad flag");
  });

  it("maps a CommanderError to status: usage_error, exit 2", () => {
    const err = new CommanderError(
      1,
      "commander.unknownOption",
      "unknown option",
    );
    const { envelope, exitCode } = mapTopLevelError(err, global, Date.now());
    expect(envelope.status).toBe("usage_error");
    expect(exitCode).toBe(2);
    expect((envelope as { message?: string }).message).toBe("unknown option");
  });
});

describe("writeFullVerifyResult", () => {
  function makeResult(overrides: Partial<VerifyResult> = {}): VerifyResult {
    const fullFailures = Array.from({ length: 30 }, (_, i) => ({
      message: `f${i}`,
    }));
    const fullChecks: CheckResult[] = [
      {
        name: "test",
        status: "fail",
        exitCode: 1,
        durationMs: 1,
        timedOut: false,
        summary: { passed: 0, failed: 30, skipped: 0, errors: 0, warnings: 0 },
        failures: fullFailures,
      },
    ];
    return {
      status: "fail",
      checks: [{ ...fullChecks[0], failures: fullFailures.slice(0, 20) }],
      totalDurationMs: 1,
      warnings: [],
      logs: [],
      truncatedByMaxFailures: true,
      fullChecks,
      ...overrides,
    };
  }

  it("writes the uncapped checks to verify-full-<runId>.json, pushes its path onto logs, and sets envelopePatch.truncated", () => {
    const logDir = makeTmpDir();
    const result = makeResult();
    const logs: string[] = [];
    const warnings: string[] = [];
    const envelopePatch: { truncated?: true } = {};

    writeFullVerifyResult(
      result,
      envelopePatch,
      logs,
      warnings,
      logDir,
      "run-a",
    );

    expect(envelopePatch.truncated).toBe(true);
    expect(logs).toHaveLength(1);
    const fullResultPath = logs[0];
    expect(fullResultPath).toContain("verify-full-run-a.json");
    expect(fs.existsSync(fullResultPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(fullResultPath, "utf8")) as {
      checks: CheckResult[];
    };
    expect(written.checks[0].failures).toHaveLength(30);
    expect(warnings).toEqual([]);
  });

  it("is a no-op when nothing was truncated", () => {
    const logDir = makeTmpDir();
    const result = makeResult({ truncatedByMaxFailures: false });
    const logs: string[] = [];
    const warnings: string[] = [];
    const envelopePatch: { truncated?: true } = {};

    writeFullVerifyResult(
      result,
      envelopePatch,
      logs,
      warnings,
      logDir,
      "run-a",
    );

    expect(envelopePatch.truncated).toBeUndefined();
    expect(logs).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("two calls with different run ids produce different paths, each holding its own checks", () => {
    const logDir = makeTmpDir();
    const resultA = makeResult();
    const resultB = makeResult({
      fullChecks: [
        {
          name: "lint",
          status: "fail",
          exitCode: 1,
          durationMs: 1,
          timedOut: false,
          summary: {
            passed: 0,
            failed: 5,
            skipped: 0,
            errors: 0,
            warnings: 0,
          },
          failures: Array.from({ length: 5 }, (_, i) => ({
            message: `lint-f${i}`,
          })),
        },
      ],
    });
    const logsA: string[] = [];
    const logsB: string[] = [];
    const warningsA: string[] = [];
    const warningsB: string[] = [];
    const patchA: { truncated?: true } = {};
    const patchB: { truncated?: true } = {};

    writeFullVerifyResult(resultA, patchA, logsA, warningsA, logDir, "run-a");
    writeFullVerifyResult(resultB, patchB, logsB, warningsB, logDir, "run-b");

    expect(logsA[0]).not.toBe(logsB[0]);
    const writtenA = JSON.parse(fs.readFileSync(logsA[0], "utf8")) as {
      checks: CheckResult[];
    };
    const writtenB = JSON.parse(fs.readFileSync(logsB[0], "utf8")) as {
      checks: CheckResult[];
    };
    expect(writtenA.checks[0].name).toBe("test");
    expect(writtenB.checks[0].name).toBe("lint");
    expect(writtenB.checks[0].failures).toHaveLength(5);
  });

  it("an unwritable log directory never swallows the write failure: truncated is still set and a warning names the directory and error", () => {
    const parentDir = makeTmpDir();
    const logDir = path.join(parentDir, "unwritable");
    fs.mkdirSync(logDir);
    fs.chmodSync(logDir, 0o500);
    try {
      const result = makeResult();
      const logs: string[] = [];
      const warnings: string[] = [];
      const envelopePatch: { truncated?: true } = {};

      writeFullVerifyResult(
        result,
        envelopePatch,
        logs,
        warnings,
        path.join(logDir, "nested"),
        "run-a",
      );

      expect(envelopePatch.truncated).toBe(true);
      expect(logs).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(path.join(logDir, "nested"));
    } finally {
      fs.chmodSync(logDir, 0o700);
    }
  });
});

describe("cli: probe", () => {
  function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd });
  }

  function initRepo(): string {
    const repo = makeTmpDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    return repo;
  }

  function commitAll(repo: string): void {
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "x"]);
  }

  it("-i worktree is usage_error/not_implemented, exit 2, for the probe command specifically", async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, "fixture.js"), "x\n");
    commitAll(repo);
    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "fixture.js",
      "-n",
      "1",
      "-r",
      "y",
      "-t",
      "node -e 1",
      "-i",
      "worktree",
    ]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.command).toBe("probe");
    expect(parsed.status).toBe("usage_error");
    expect(parsed.reason).toBe("not_implemented");
  });

  it("reports killed, exit 0, for a fixture whose test catches the mutant (the acceptance-criterion CLI shape)", async () => {
    const repo = initRepo();
    fs.writeFileSync(
      path.join(repo, "fixture.js"),
      [
        "function isPositive(n) {",
        "  return n > 0;",
        "}",
        "module.exports = { isPositive };",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const assert = require('node:assert');",
        "const { isPositive } = require('./fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "assert.strictEqual(isPositive(-5), false);",
        "",
      ].join("\n"),
    );
    commitAll(repo);
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

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
    ]);

    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("killed");
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it("reports survived, exit 1, for a fixture whose test does not catch the mutant", async () => {
    const repo = initRepo();
    fs.writeFileSync(
      path.join(repo, "fixture.js"),
      [
        "function isPositive(n) {",
        "  return n > 0;",
        "}",
        "function unused(n) {",
        "  return n * 2;",
        "}",
        "module.exports = { isPositive };",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const assert = require('node:assert');",
        "const { isPositive } = require('./fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "assert.strictEqual(isPositive(-5), false);",
        "",
      ].join("\n"),
    );
    commitAll(repo);
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "fixture.js",
      "-n",
      "5",
      "-r",
      "  return n * 3;",
      "-t",
      "node fixture.test.js",
      "-i",
      "inplace",
    ]);

    expect(run.code).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.status).toBe("survived");
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it("a --file that does not exist is usage_error/file_not_found under command probe, with the path in a warning", async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, "placeholder.js"), "x\n");
    commitAll(repo);
    const missing = path.join(repo, "does-not-exist.js");
    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "does-not-exist.js",
      "-n",
      "1",
      "-r",
      "y",
      "-t",
      "node -e 1",
    ]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.command).toBe("probe");
    expect(parsed.status).toBe("usage_error");
    expect(parsed.reason).toBe("file_not_found");
    expect((parsed.warnings as string[]).some((w) => w.includes(missing))).toBe(
      true,
    );
  });

  it("exactly one mutant form is required: none given is usage_error, exit 2", async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, "fixture.js"), "x\n");
    commitAll(repo);
    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "fixture.js",
      "-n",
      "1",
      "-t",
      "node -e 1",
    ]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("usage_error");
  });

  it("-p's dry-run exec log paths (the git apply dry run and its --numstat check) are folded into the envelope's logs", async () => {
    const repo = initRepo();
    fs.writeFileSync(
      path.join(repo, "fixture.js"),
      ["function isPositive(n) {", "  return n > 0;", "}", ""].join("\n"),
    );
    commitAll(repo);
    const patchPath = path.join(repo, "mutant.patch");
    fs.writeFileSync(
      patchPath,
      [
        "diff --git a/fixture.js b/fixture.js",
        "index 0000000..0000000 100644",
        "--- a/fixture.js",
        "+++ b/fixture.js",
        "@@ -1,3 +1,3 @@",
        " function isPositive(n) {",
        "-  return n > 0;",
        "+  return false;",
        " }",
      ].join("\n") + "\n",
    );

    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "fixture.js",
      "-n",
      "1",
      "-p",
      patchPath,
      "-t",
      "node -e 1",
    ]);

    const parsed = JSON.parse(run.stdout);
    const logs: string[] = parsed.logs;
    // At least the dry-run apply and its --numstat check, both under the
    // run's log dir, neither of them the baseline/test's own logPath.
    expect(logs.length).toBeGreaterThanOrEqual(2);
    for (const logPath of logs) {
      expect(fs.existsSync(logPath)).toBe(true);
    }
  });

  it("exactly one mutant form is required: two given (-r and -p) is usage_error, exit 2", async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, "fixture.js"), "x\n");
    commitAll(repo);
    const run = await spawnCli([
      "-C",
      repo,
      "probe",
      "--file",
      "fixture.js",
      "-n",
      "1",
      "-r",
      "y",
      "-p",
      "/dev/null",
      "-t",
      "node -e 1",
    ]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("usage_error");
  });
});

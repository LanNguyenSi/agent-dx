import { spawn } from "node:child_process";
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
  type ResolvedGlobal,
  type StdoutSink,
} from "../src/cli.js";
import { UsageError } from "../src/envelope.js";
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

  it("returns not_implemented usage_error for the probe and init stubs", async () => {
    // `verify` is implemented (see the "verify" describe block below) and
    // is deliberately excluded here: running it with no `-C` would target
    // this package's own real cwd and its real `test` script, re-invoking
    // this very test suite from inside itself.
    for (const sub of ["probe", "init"]) {
      const run = await spawnCli([sub]);
      expect(run.code).toBe(2);
      const parsed = JSON.parse(run.stdout);
      expect(parsed.status).toBe("usage_error");
      expect(parsed.reason).toBe("not_implemented");
    }
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

  it("--timeout 1 -x 'slow=sleep 30' times out: check status error, one synthetic failure naming timedOut, summary.errors 1, exit 2", async () => {
    const cwd = makeTmpDir();
    const logDir = makeTmpDir();
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      logDir,
      "verify",
      "--timeout",
      "1",
      "-x",
      "slow=sleep 30",
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

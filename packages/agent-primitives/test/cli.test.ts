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

  it("returns not_implemented usage_error for probe, verify, and init stubs", async () => {
    for (const sub of ["probe", "verify", "init"]) {
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

import { exec, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import { CommanderError } from "commander";
import {
  classifyStdoutError,
  mapTopLevelError,
  type ResolvedGlobal,
} from "../src/cli.js";
import { UsageError } from "../src/envelope.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "dist", "cli.js");

function runCli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-cli-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cli", () => {
  it("prints parseable JSON with status: usage_error on stdout and exits 2 for a mistyped flag", () => {
    const result = runCli(["doctor", "--no-such-flag"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("usage_error");
    expect(parsed.tool).toBe("agent-primitives");
  });

  it("exits 0 for --help", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
  });

  it("exits 0 for doctor --help", () => {
    const result = runCli(["doctor", "--help"]);
    expect(result.status).toBe(0);
  });

  it("exits 2 with usage_error for an invalid --format value", () => {
    const result = runCli(["doctor", "-f", "yaml"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("usage_error");
  });

  it("reports a missing required tool as status: missing with exit 1", () => {
    const result = runCli([
      "doctor",
      "-r",
      "git,node,npm,rg,definitely-not-a-binary-xyz",
    ]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("missing");
    const tool = parsed.tools.find(
      (t: { name: string }) => t.name === "definitely-not-a-binary-xyz",
    );
    expect(tool.found).toBe(false);
  });

  it("exits 0 with status ok for a required/optional list that does not depend on host tooling beyond node and npm", () => {
    // Deliberately not `doctor` with its defaults (which include `rg`): a
    // CI runner image is not guaranteed to carry ripgrep, so a test that
    // asserts status: ok against the default required list is really
    // asserting something about the host, not about this CLI. node and npm
    // are the two binaries this very test process is already running
    // under, so they are always present; the empty optional list keeps
    // any other (also possibly-missing) optional tool out of the picture.
    const result = runCli(["doctor", "-r", "node,npm", "-o", ""]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("ok");
  });

  it("returns not_implemented usage_error for probe, verify, and init stubs", () => {
    for (const sub of ["probe", "verify", "init"]) {
      const result = runCli([sub]);
      expect(result.status).toBe(2);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe("usage_error");
      expect(parsed.reason).toBe("not_implemented");
    }
  });

  it("rejects a -r entry shaped like a path traversal as usage_error (never resolved as a real binary)", () => {
    const result = runCli(["doctor", "-r", "../../x"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("usage_error");
  });

  it("rejects -C at a nonexistent directory as usage_error, exit 2", () => {
    const result = runCli(["-C", "/definitely/does/not/exist/xyz", "doctor"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("usage_error");
  });

  it("rejects -C pointing at a file (not a directory) as usage_error, exit 2", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "a-file");
    fs.writeFileSync(filePath, "x");
    const result = runCli(["-C", filePath, "doctor"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("usage_error");
  });

  it("prints a bounded pretty-JSON fallback for -f text on a command with no dedicated text renderer", () => {
    const result = runCli(["-f", "text", "probe"]);
    expect(result.status).toBe(2);
    // Pretty-printed (multi-line, 2-space indented), unlike the single-line
    // compact JSON the default `-f json` path emits.
    expect(result.stdout).toContain('"status": "usage_error"');
    expect(result.stdout.split("\n").length).toBeGreaterThan(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("usage_error");
  });

  it("bounds -f text output by -m and appends a truncation marker", () => {
    const result = runCli(["-f", "text", "-m", "80", "doctor"]);
    expect(result.stdout.length).toBeLessThanOrEqual(80 + 40);
    expect(result.stdout).toContain("truncated");
  });

  it("-f text -m 80 still prints the real tool name (renders from the untouched doctor result, never a reduced/mutated envelope)", () => {
    const result = runCli([
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
    expect(result.stdout).toContain("node");
  });

  it("parses a large envelope received through a pipe with a delayed reader", async () => {
    // Regression test for the write-then-exit race: process.exit()
    // immediately after stdout.write() can truncate output larger than
    // the pipe buffer before the reader has drained it. Spawn with piped
    // stdio and read only after a delay, the way a slow subagent reader
    // would, to reproduce the race the previous implementation lost. A
    // long -r list (each a plain, never-found name) pushes the envelope
    // comfortably past the ~64 KiB pipe buffer so the race is reachable
    // at all; -m 900000 keeps the envelope module from truncating it back
    // down first.
    const longRequiredList = Array.from(
      { length: 5000 },
      (_, i) => `definitely-not-a-binary-${i}`,
    ).join(",");
    const child = spawn(
      "node",
      [CLI_PATH, "doctor", "-m", "900000", "-r", longRequiredList],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    expect(() => JSON.parse(stdout)).not.toThrow();
    const parsed = JSON.parse(stdout);
    expect(parsed.tool).toBe("agent-primitives");
  });

  it("exits 0 with empty stderr on a real EPIPE (reader closes early via | head -c 100), instead of an unhandled-error crash", async () => {
    // A long -r list guarantees the default-format JSON envelope is well
    // over 100 bytes, so `head -c 100` is certain to close the read end
    // of the pipe before this process has finished writing, forcing a
    // real EPIPE on a subsequent stdout write. `head -c` is portable
    // POSIX (GNU coreutils and BSD/macOS both support it) and the pipe
    // itself is plain POSIX shell syntax, not a dash-vs-bash difference.
    const names = Array.from(
      { length: 200 },
      (_, i) => `definitely-not-a-binary-${i}`,
    ).join(",");
    const { code, stderr } = await new Promise<{
      code: number;
      stderr: string;
    }>((resolve, reject) => {
      exec(
        `node ${JSON.stringify(CLI_PATH)} doctor -r ${JSON.stringify(names)} -o "" | head -c 100`,
        (err, _stdout, stderrOut) => {
          if (
            err &&
            typeof (err as NodeJS.ErrnoException).code !== "number" &&
            err.signal
          ) {
            reject(err);
            return;
          }
          const exitCode = err && typeof err.code === "number" ? err.code : 0;
          resolve({ code: exitCode, stderr: stderrOut });
        },
      );
    });
    expect(code).toBe(0);
    expect(stderr).toBe("");
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

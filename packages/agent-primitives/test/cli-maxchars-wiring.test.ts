import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";

// Call-through partial mock, the same shape `plan.test.ts` uses: the real
// `reconcileEnvelopeDiffTruncation` runs, and the spy records what
// `cli.ts` handed it. This is what lets a test pin the CLI's OWN pass of
// `global.maxChars` as the third argument (at both call sites) without
// measuring bytes: a spawned-CLI test can only observe the envelope's
// final length, and the few bytes the argument is worth at a given `-m`
// sit inside the envelope's own run-to-run noise (a timing digit, a
// temp-dir name), which is what made the byte-calibrated shape of this
// test fail on CI while passing locally.
vi.mock("../src/probe/mutant.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/probe/mutant.js")>();
  return {
    ...actual,
    reconcileEnvelopeDiffTruncation: vi.fn(
      actual.reconcileEnvelopeDiffTruncation,
    ),
  };
});

type MutantModule = typeof import("../src/probe/mutant.js");
type CliModule = typeof import("../src/cli.js");

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-wiring-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A one-file repository with one committed line and a patch that
 * mutates it: enough for the probe to run end to end (`true` as the
 * test command) so both call sites are reached with a real envelope. */
function initRepo(): { repo: string; patchPath: string } {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "alpha\nbeta\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  const patchPath = path.join(repo, "a.patch");
  fs.writeFileSync(
    patchPath,
    [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      "-alpha",
      "+ALPHA",
      " beta",
      "",
    ].join("\n"),
  );
  return { repo, patchPath };
}

/** Drives the exported commander `program` in this process. `emit` ends
 * in `process.exit` once the stdout write drains, and writes the envelope
 * to the real stdout; both are stubbed here so the test process survives
 * and the envelope is captured instead of landing in the reporter.
 *
 * Commander keeps parsed option values on the (module-level) `program`
 * across `parseAsync` calls, so a second parse in the same module would
 * see the first one's `--file`/`-p`/`-t` and trip the `--plan`
 * exclusivity check. The module graph is reset and re-imported per run
 * instead; the spy is read from that same fresh graph. */
async function runInProcess(argv: string[]): Promise<{
  stdout: string;
  calls: Parameters<MutantModule["reconcileEnvelopeDiffTruncation"]>[];
}> {
  vi.resetModules();
  const mutant = (await import("../src/probe/mutant.js")) as MutantModule;
  const { program } = (await import("../src/cli.js")) as CliModule;
  const spy = vi.mocked(mutant.reconcileEnvelopeDiffTruncation);
  spy.mockClear();
  let captured = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: unknown,
    ...rest: unknown[]
  ) => {
    captured += String(chunk);
    const callback = rest.find((arg) => typeof arg === "function");
    if (typeof callback === "function") {
      (callback as (err?: Error | null) => void)(null);
    }
    return true;
  }) as typeof process.stdout.write);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as typeof process.exit);
  // `emit` also installs the CLI's EPIPE guard, a real `'error'` listener
  // on `process.stdout`; its once-only flag lives in the module instance
  // the reset above just discarded, so every run would add another one
  // for the rest of the worker's life. Snapshot and remove what the run
  // added.
  const errorListenersBefore = new Set(process.stdout.listeners("error"));
  try {
    await program.parseAsync(["node", "agent-primitives", ...argv]);
    // `writeAndExit` resolves the exit through the stdout write callback,
    // which the stub above invokes synchronously, so by here the
    // envelope has been written in full.
    return { stdout: captured, calls: spy.mock.calls };
  } finally {
    exit.mockRestore();
    write.mockRestore();
    for (const listener of process.stdout.listeners("error")) {
      if (!errorListenersBefore.has(listener)) {
        process.stdout.removeListener(
          "error",
          listener as (...args: unknown[]) => void,
        );
      }
    }
  }
}

function lastCall(
  calls: Parameters<MutantModule["reconcileEnvelopeDiffTruncation"]>[],
): Parameters<MutantModule["reconcileEnvelopeDiffTruncation"]> {
  expect(calls.length).toBe(1);
  const call = calls[0];
  if (call === undefined) throw new Error("unreachable: asserted above");
  return call;
}

describe("cli: reconcileEnvelopeDiffTruncation is called with the CLI's own --max-chars", () => {
  const stdoutErrorListenersAtStart = process.stdout.listenerCount("error");

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // The in-process run must not leave the CLI's EPIPE guard behind on
    // the worker's real stdout (see `runInProcess`).
    expect(process.stdout.listenerCount("error")).toBe(
      stdoutErrorListenersAtStart,
    );
  });

  it("single probe: the third argument is the parsed -m value (not undefined), against the pre-envelope mutant", async () => {
    const { repo, patchPath } = initRepo();
    const logDir = makeTmpDir();
    const { stdout, calls } = await runInProcess([
      "-C",
      repo,
      "-m",
      "4321",
      "-l",
      logDir,
      "probe",
      "--file",
      "a.txt",
      "-p",
      patchPath,
      "-t",
      "true",
      "-i",
      "inplace",
      "--expect",
      "pass",
    ]);
    expect(() => JSON.parse(stdout)).not.toThrow();
    const [, originals, maxChars] = lastCall(calls);
    expect(maxChars).toBe(4321);
    expect(originals).toHaveProperty("mutant");
  });

  it("--plan: the third argument is the parsed -m value (not undefined), against the pre-envelope plan results", async () => {
    const { repo, patchPath } = initRepo();
    const logDir = makeTmpDir();
    const planPath = path.join(repo, "plan.json");
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        test: "true",
        isolation: "inplace",
        mutants: [
          { file: "a.txt", patch: patchPath, expect: "pass" },
          { file: "a.txt", patch: patchPath, expect: "pass" },
        ],
      }),
    );
    const { stdout, calls } = await runInProcess([
      "-C",
      repo,
      "-m",
      "5432",
      "-l",
      logDir,
      "probe",
      "--plan",
      planPath,
    ]);
    expect(() => JSON.parse(stdout)).not.toThrow();
    const [, originals, maxChars] = lastCall(calls);
    expect(maxChars).toBe(5432);
    expect(originals).toHaveProperty("planResults");
  });
});

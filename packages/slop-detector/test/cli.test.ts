import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Exercises the real CLI end to end: `node --import tsx src/cli.ts`,
// not the built `dist/cli.js`, so the suite doesn't depend on a prior
// `npm run build` having run. `--import tsx` is the same mechanism the
// package's own `npm run dev` script already uses.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliEntry = path.join(packageRoot, "src", "cli.ts");

function runCli(
  args: string[],
  opts: { input?: string; stdinFromDevNull?: boolean } = {},
): { stdout: string; stderr: string; status: number | null } {
  // `stdinFromDevNull` is the `< /dev/null` shape: `stdio: "ignore"` on fd 0
  // is exactly that redirect, and it is NOT the same as an empty pipe
  // (`input: ""`), which is why both are pinned separately below.
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliEntry, ...args],
    {
      cwd: packageRoot,
      encoding: "utf8",
      ...(opts.stdinFromDevNull
        ? { stdio: ["ignore", "pipe", "pipe"] as const }
        : { input: opts.input ?? "" }),
    },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

/**
 * Runs the CLI with an stdin pipe that is opened and then never written to
 * and never closed -- the inherited-non-TTY-stdin-with-no-writer shape a CI
 * step or an agent harness hands it. `spawnSync` cannot express it (it
 * always ends stdin), so this one is async.
 */
function runCliWithOpenStdin(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliEntry, ...args],
      {
        cwd: packageRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          SLOP_DETECTOR_STDIN_TIMEOUT_MS: String(timeoutMs),
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ stdout, stderr, status }));
  });
}

/**
 * Sibling of `runCliWithOpenStdin` that drives stdin with a `script`
 * callback instead of leaving it untouched, so a caller can pin the
 * data-then-stall shape: write something, wait past the first-byte bound,
 * then end stdin. `script` gets `write`/`end` once the child is spawned; nothing
 * here waits for it, so a script that itself awaits a `setTimeout` before
 * calling `end` is what actually produces the stall.
 */
function runCliWithStdinScript(
  args: string[],
  timeoutMs: number,
  script: (write: (chunk: string) => void, end: () => void) => void,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliEntry, ...args],
      {
        cwd: packageRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          SLOP_DETECTOR_STDIN_TIMEOUT_MS: String(timeoutMs),
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ stdout, stderr, status }));
    script(
      (chunk) => child.stdin.write(chunk),
      () => child.stdin.end(),
    );
  });
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cli-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("cli check [paths...]", () => {
  it("scans two positional paths, both counted", () => {
    fs.writeFileSync(path.join(tmp, "a.md"), "F1 landed in review round 2.\n");
    fs.writeFileSync(path.join(tmp, "b.md"), "F2a fixed per review.\n");
    const { stdout, status } = runCli([
      "check",
      path.join(tmp, "a.md"),
      path.join(tmp, "b.md"),
      "--pack",
      "review-slop",
    ]);
    expect(stdout).toMatch(/2 files scanned/);
    expect(stdout).toContain("F1");
    expect(stdout).toContain("F2a");
    expect(status).toBe(1); // block findings present
  });

  it("scans two positional paths when --pack comes first (pack-first ordering)", () => {
    fs.writeFileSync(path.join(tmp, "a.md"), "F1 landed in review round 2.\n");
    fs.writeFileSync(path.join(tmp, "b.md"), "F2a fixed per review.\n");
    const { stdout, status } = runCli([
      "check",
      "--pack",
      "review-slop",
      path.join(tmp, "a.md"),
      path.join(tmp, "b.md"),
    ]);
    expect(stdout).toMatch(/2 files scanned/);
    expect(stdout).toContain("F1");
    expect(stdout).toContain("F2a");
    expect(status).toBe(1);
  });

  it("a single positional path still works (pre-existing behavior)", () => {
    fs.writeFileSync(path.join(tmp, "a.md"), "no tokens here.\n");
    const { stdout, status } = runCli([
      "check",
      path.join(tmp, "a.md"),
      "--pack",
      "review-slop",
    ]);
    expect(stdout).toMatch(/1 files scanned/);
    expect(status).toBe(0);
  });

  it("errors with exit 2 when --stdin-path is given alongside a real path", () => {
    fs.writeFileSync(path.join(tmp, "a.md"), "no tokens here.\n");
    const { stderr, status } = runCli([
      "check",
      path.join(tmp, "a.md"),
      "--stdin-path",
      "COMMIT_MSG",
      "--pack",
      "review-slop",
    ]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/--stdin-path only applies when reading stdin/);
  });

  it("reads stdin and scans it when no path is given", () => {
    const { stdout, status } = runCli(
      ["check", "--stdin-path", "COMMIT_MSG", "--pack", "review-slop"],
      { input: "Fixes F1 and F2a from review round 2.\n" },
    );
    expect(stdout).toMatch(/1 files scanned/);
    expect(stdout).toContain("F1");
    expect(status).toBe(1);
  });

  it("de-duplicates the same file listed twice instead of doubling its counts", () => {
    const file = path.join(tmp, "a.md");
    fs.writeFileSync(file, "F1 landed in review round 2.\n");
    const once = runCli(["check", file, "--pack", "review-slop"]);
    const twice = runCli(["check", file, file, "--pack", "review-slop"]);
    expect(once.stdout).toMatch(/1 files scanned/);
    expect(twice.stdout).toMatch(/1 files scanned/);
    expect(twice.stdout).toBe(once.stdout);
    expect(twice.status).toBe(once.status);
  });

  it("de-duplicates two spellings of one path (`a.md` and `./a.md`)", () => {
    fs.writeFileSync(path.join(tmp, "a.md"), "F1 landed in review round 2.\n");
    const { stdout } = runCli([
      "check",
      path.join(tmp, "a.md"),
      `${tmp}${path.sep}.${path.sep}a.md`,
      "--pack",
      "review-slop",
    ]);
    expect(stdout).toMatch(/1 files scanned/);
  });
});

// Nothing piped in used to be a green no-op: `check --stdin-path COMMIT_MSG`
// with an empty or absent stdin printed a clean report and exited 0, which
// reads as "checked, no findings" rather than "nothing was checked". The
// predicate is emptiness, not TTY-ness -- none of the four shapes below is a
// TTY, and every one of them must be a loud usage error naming
// `--stdin-path`.
describe("cli check with nothing piped in on stdin", () => {
  const STDIN_CASES: Array<{
    label: string;
    opts: { input?: string; stdinFromDevNull?: boolean };
  }> = [
    {
      label: "stdin redirected from /dev/null",
      opts: { stdinFromDevNull: true },
    },
    { label: "an empty pipe", opts: { input: "" } },
    { label: "a whitespace-only pipe", opts: { input: "  \n\t\n" } },
  ];

  for (const { label, opts } of STDIN_CASES) {
    it(`${label} is a usage error (exit 2) naming --stdin-path, not a clean report`, () => {
      const { stdout, stderr, status } = runCli(
        ["check", "--stdin-path", "COMMIT_MSG", "--pack", "review-slop"],
        opts,
      );
      expect(status).toBe(2);
      expect(stderr).toContain("--stdin-path");
      expect(stderr).toMatch(/nothing was scanned/);
      expect(stdout).not.toMatch(/files scanned/);
    });
  }

  it("the same holds with no --stdin-path at all (bare `check` on a closed non-TTY stdin)", () => {
    const { stdout, stderr, status } = runCli(
      ["check", "--pack", "review-slop"],
      {
        stdinFromDevNull: true,
      },
    );
    expect(status).toBe(2);
    expect(stderr).toContain("--stdin-path");
    expect(stdout).not.toMatch(/files scanned/);
  });

  it("a stdin that is opened but never written to and never closed is bounded, not a hang", async () => {
    const { stderr, status } = await runCliWithOpenStdin(
      ["check", "--stdin-path", "COMMIT_MSG", "--pack", "review-slop"],
      400,
    );
    expect(status).toBe(2);
    expect(stderr).toMatch(/produced no data for 400ms and never ended/);
    expect(stderr).toContain("--stdin-path");
  }, 20_000);

  it("data then a stall past the bound is still scanned once stdin ends (arm-once, not re-armed on every chunk)", async () => {
    const { stdout, status } = await runCliWithStdinScript(
      ["check", "--stdin-path", "COMMIT_MSG", "--pack", "review-slop"],
      300,
      (write, end) => {
        // The stall (3000ms) needs a wide margin over the bound (300ms) so
        // this still discriminates re-arm-on-every-chunk on a loaded
        // runner, where the child's startup and first `readStdin` call can
        // themselves eat a few hundred ms.
        write("Fixed per finding F5 in review round 2.\n");
        setTimeout(end, 3000);
      },
    );
    expect(stdout).toMatch(/1 files scanned/);
    expect(stdout).toContain("F5");
    expect(status).toBe(1);
  }, 20_000);

  it("a non-empty pipe is still scanned (the bound never truncates real input)", () => {
    const { stdout, status } = runCli(
      ["check", "--stdin-path", "COMMIT_MSG", "--pack", "review-slop"],
      { input: "Fixed per finding F5 in review round 2.\n" },
    );
    expect(stdout).toMatch(/1 files scanned/);
    expect(stdout).toContain("F5");
    expect(status).toBe(1);
  });
});

// The two argv shapes `orchestrator-workflow`'s installed implementer prompt
// (`assets/agents/implementer.md`, its pre-return review-slop bullet)
// prescribes verbatim, run here end to end so a change to this CLI's arity or
// flags fails a test in this package instead of only leaving that prompt
// stale in another one.
describe("the argv shapes the orchestrator-workflow implementer prompt prescribes", () => {
  it("`check <changed file> [<changed file> ...] --pack review-slop` scans every named file", () => {
    const changed = ["one.md", "two.md", "three.ts"];
    fs.writeFileSync(path.join(tmp, "one.md"), "Fixed per finding F5 above.\n");
    fs.writeFileSync(path.join(tmp, "two.md"), "Landed in review round 2.\n");
    fs.writeFileSync(
      path.join(tmp, "three.ts"),
      'it("F2a: keeps the earlier fix", () => {});\n',
    );
    const { stdout, status } = runCli([
      "check",
      ...changed.map((f) => path.join(tmp, f)),
      "--pack",
      "review-slop",
    ]);
    expect(stdout).toMatch(/3 files scanned/);
    expect(stdout).toContain("F5");
    expect(stdout).toContain("round 2");
    expect(stdout).toContain("F2a");
    expect(status).toBe(1);
  });

  it("`git log -1 --format=%B | check --stdin-path COMMIT_MSG --pack review-slop` scans the piped message", () => {
    const { stdout, status } = runCli(
      ["check", "--stdin-path", "COMMIT_MSG", "--pack", "review-slop"],
      {
        input:
          "fix(pack): address F1 and F2a\n\nCarried over from review round 2.\n",
      },
    );
    expect(stdout).toMatch(/^COMMIT_MSG$/m);
    expect(stdout).toMatch(/1 files scanned/);
    expect(stdout).toContain("F1");
    expect(stdout).toContain("round 2");
    expect(status).toBe(1);
  });
});

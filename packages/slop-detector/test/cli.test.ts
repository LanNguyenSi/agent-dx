import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "./built-cli.js";

// Exercises the real CLI end to end: `node --import tsx src/cli.ts`,
// not the built `dist/cli.js`, so most of the suite doesn't depend on a
// prior `npm run build` having run. `--import tsx` is the same mechanism
// the package's own `npm run dev` script already uses. The pipe tests at the
// end spawn the built `dist/cli.js` and rebuild it first when it is missing
// or stale (`./built-cli.ts`).
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliEntry = path.join(packageRoot, "src", "cli.ts");
// The early-close stress test took about 6 s for its 100 runs on an idle
// macOS machine; the limit leaves a wide margin for a loaded one.
const STRESS_TIMEOUT_MS = 180_000;

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
  it("exits 2 for an unknown --pack, naming it and the known packs", () => {
    fs.writeFileSync(path.join(tmp, "a.md"), "plain text\n");
    const { stderr, stdout, status } = runCli([
      "check",
      path.join(tmp, "a.md"),
      "--pack",
      "ui-slp",
    ]);
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain('unknown pack "ui-slp"');
    expect(stderr).toContain("ui-slop");
    expect(stderr).toContain("review-slop");
  });

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

  it("whitespace-only data then a stall past the bound is still a usage error, not a scan (disarm needs real data)", async () => {
    const { stderr, status } = await runCliWithStdinScript(
      ["check", "--stdin-path", "COMMIT_MSG", "--pack", "review-slop"],
      300,
      (write, end) => {
        // Same wide margin as the sibling data-then-stall case above: the
        // written chunk is whitespace-only, so it must not disarm the
        // bound (disarm needs real data, per the emptiness predicate), and
        // the read should still end in the usual "no content" usage error
        // once stdin closes, not hang or scan an empty document.
        write(" \n");
        setTimeout(end, 3000);
      },
    );
    expect(status).toBe(2);
    expect(stderr).toContain("--stdin-path");
    expect(stderr).toMatch(/non-whitespace content/);
    expect(stderr).toMatch(/nothing was scanned/);
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

// A payload larger than the pipe buffer, written to a real pipe whose reader
// starts late, is delivered whole: the CLI must not exit before its stdout
// has drained. Runs the built `dist/cli.js`, since the cut-off comes from the
// process exiting right after the write, which `--import tsx` also does but
// which the shipped entry point is the contract for.
describe("cli check -f json into a pipe", () => {
  const builtEntry = path.join(packageRoot, "dist", "cli.js");

  beforeAll(() => {
    ensureBuilt();
  }, 180_000);

  function runBuiltIntoPipe(
    args: string[],
  ): Promise<{ stdout: string; status: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [builtEntry, ...args], {
        cwd: packageRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      // Hold the reader back so the child fills the pipe buffer first.
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), 500);
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.on("error", reject);
      child.on("close", (status) =>
        resolve({ stdout: Buffer.concat(chunks).toString("utf8"), status }),
      );
    });
  }

  it("delivers the full JSON output when it exceeds 64 KiB", async () => {
    const file = path.join(tmp, "big.md");
    const count = 1000;
    fs.writeFileSync(file, "F1 landed in review round 2.\n".repeat(count));
    const { stdout, status } = await runBuiltIntoPipe([
      "check",
      file,
      "--pack",
      "review-slop",
      "-f",
      "json",
    ]);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(65536);
    const parsed = JSON.parse(stdout);
    expect(parsed.violations.length).toBeGreaterThanOrEqual(count);
    expect(status).toBe(1);
  }, 30_000);

  // A reader that closes right after its first chunk (`| head -c 10`) is not
  // a failure of the scan: the CLI exits with the verdict code and prints
  // nothing on stderr. Which errno the write to the gone reader raises
  // (EPIPE, ENOTCONN, ECONNRESET) depends on the platform and on what the
  // reader is; a Node parent gets a socketpair on macOS, so this spawn shape
  // is the one that exercises that family.
  const warnConfig = () => {
    const configPath = path.join(tmp, "warn.yml");
    fs.writeFileSync(
      configPath,
      "rules:\n  review-slop/finding-id:\n    severity: warn\n  review-slop/round-reference:\n    severity: warn\n",
    );
    return configPath;
  };

  function runEarlyClose(
    configPath: string | null,
  ): Promise<{ stderr: string; status: number | null }> {
    const file = path.join(tmp, "big-early-close.md");
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, "F1 landed in review round 2.\n".repeat(1000));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          builtEntry,
          "check",
          file,
          "--pack",
          "review-slop",
          ...(configPath === null ? [] : ["-c", configPath]),
          "-f",
          "json",
        ],
        { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      const errChunks: Buffer[] = [];
      child.stderr.on("data", (c: Buffer) => errChunks.push(c));
      child.stdout.once("data", () => child.stdout.destroy());
      child.on("error", reject);
      child.on("close", (status) =>
        resolve({ stderr: Buffer.concat(errChunks).toString("utf8"), status }),
      );
    });
  }

  it("exits 0 with empty stderr when the reader closes early on a warn verdict", async () => {
    const result = await runEarlyClose(warnConfig());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 30_000);

  it("exits 1 with empty stderr when the reader closes early on a block verdict", async () => {
    const result = await runEarlyClose(null);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
  }, 30_000);

  // The errno of a write to a gone reader is a race between the reader's
  // close and the child's write, so one clean run proves little: every one of
  // the runs must be clean, in batches so that the load varies.
  it(
    "stays clean over repeated early closes",
    async () => {
      const configPath = warnConfig();
      const runs = 100;
      const batch = 10;
      const bad: string[] = [];
      for (let done = 0; done < runs; done += batch) {
        const results = await Promise.all(
          Array.from({ length: batch }, () => runEarlyClose(configPath)),
        );
        for (const r of results) {
          if (r.status !== 0 || r.stderr !== "") {
            bad.push(`status=${r.status} stderr=${r.stderr.slice(0, 200)}`);
          }
        }
      }
      expect(bad).toEqual([]);
    },
    STRESS_TIMEOUT_MS,
  );

  // A stdout error that is not the reader going away is a failure of this
  // run: one stderr line naming the code, no stack, exit 2. A descriptor
  // opened read-only and handed over as stdout makes every write fail with
  // EBADF on Linux and macOS alike, with no test-only hook in the CLI.
  it("reports a non-reader stdout error on one stderr line and exits 2", async () => {
    const file = path.join(tmp, "small.md");
    fs.writeFileSync(file, "F1 landed in review round 2.\n");
    const readOnly = path.join(tmp, "read-only-stdout.txt");
    fs.writeFileSync(readOnly, "");
    const fd = fs.openSync(readOnly, "r");
    try {
      const result = spawnSync(
        process.execPath,
        [builtEntry, "check", file, "--pack", "review-slop", "-f", "json"],
        { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", fd, "pipe"] },
      );
      expect(result.status).toBe(2);
      expect(result.stderr.trimEnd().split("\n")).toEqual([
        "slop-detector: could not write the report to stdout (EBADF)",
      ]);
    } finally {
      fs.closeSync(fd);
    }
  }, 30_000);
});

describe("cli check escapes terminal control characters in text output", () => {
  let dir: string;
  let file: string;
  const raw = '<invoke name="a\x1b]52;c;aGk=\x07">';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cli-esc-"));
    file = path.join(dir, "note.md");
    fs.writeFileSync(file, `${raw}\n`);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("text output carries a visible escape, no ESC or BEL byte", () => {
    const r = runCli(["check", file, "--pack", "agent-tics"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("\\x1b]52;c;aGk=\\x07");
    expect(r.stdout).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });

  it("json output keeps the raw match", () => {
    const r = runCli(["check", file, "--pack", "agent-tics", "-f", "json"]);
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout) as {
      violations: Array<{ matched: string; message: string }>;
    };
    expect(parsed.violations[0]!.matched).toBe(raw);
    expect(parsed.violations[0]!.message).toContain(raw);
  });
});

// Explicit targets and symbolic links, through the built CLI with a working
// directory under os.tmpdir(): on macOS that directory is spelled
// /var/folders/... while the process working directory (and every real
// path) starts with /private, so containment must compare real paths.
describe("cli check explicit targets and symbolic links", () => {
  const builtEntry = path.join(packageRoot, "dist", "cli.js");
  const marker = "The checkout lives at /Users/someone/git/repo for now.\n";
  let base: string;
  let work: string;
  let outside: string;

  beforeAll(() => {
    ensureBuilt();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cli-link-"));
    work = path.join(base, "work");
    outside = path.join(base, "outside");
    fs.mkdirSync(path.join(work, "real"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "AGENTS.md"), `# Out\n\n${marker}`);
    fs.writeFileSync(path.join(work, "AGENTS.md"), `# In\n\n${marker}`);
    fs.writeFileSync(path.join(work, "real", "AGENTS.md"), `# In\n\n${marker}`);
    fs.symlinkSync(
      path.join(outside, "AGENTS.md"),
      path.join(work, "out-file.md"),
    );
    fs.symlinkSync(outside, path.join(work, "out-dir"));
    fs.symlinkSync("AGENTS.md", path.join(work, "CLAUDE.md"));
    fs.symlinkSync("real", path.join(work, "in-dir"));
  }, 180_000);

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function runBuilt(args: string[]): {
    summary: {
      filesScanned: number;
      blockCount: number;
      warnings?: string[];
      violations: { path: string }[];
    };
    status: number | null;
    stderr: string;
  } {
    const r = spawnSync(
      process.execPath,
      [
        builtEntry,
        "check",
        "--format",
        "json",
        "--pack",
        "placement-slop",
        ...args,
      ],
      { cwd: work, encoding: "utf8" },
    );
    return {
      summary: JSON.parse(r.stdout),
      status: r.status,
      stderr: r.stderr,
    };
  }

  it("a file spelled inside that resolves outside is skipped with a warning, exit 0", () => {
    const r = runBuilt(["out-file.md"]);
    expect(r.status).toBe(0);
    expect(r.summary.filesScanned).toBe(0);
    expect(r.summary.violations).toEqual([]);
    expect(r.summary.warnings).toEqual([
      "skipped out-file.md: resolves outside the working directory (symbolic link)",
    ]);
  });

  it("a directory spelled inside that resolves outside is skipped with a warning, exit 0", () => {
    const r = runBuilt(["out-dir"]);
    expect(r.status).toBe(0);
    expect(r.summary.filesScanned).toBe(0);
    expect(r.summary.warnings).toEqual([
      "skipped out-dir: resolves outside the working directory (symbolic link)",
    ]);
  });

  it("a file below a symlinked directory that leads outside is skipped", () => {
    const r = runBuilt(["out-dir/AGENTS.md"]);
    expect(r.status).toBe(0);
    expect(r.summary.filesScanned).toBe(0);
    expect(r.summary.warnings).toEqual([
      "skipped out-dir/AGENTS.md: resolves outside the working directory (symbolic link)",
    ]);
  });

  it("a skipped target leaves the other targets and their verdict alone", () => {
    const r = runBuilt(["out-file.md", "AGENTS.md"]);
    expect(r.status).toBe(1);
    expect(r.summary.filesScanned).toBe(1);
    expect(r.summary.blockCount).toBe(1);
    expect(r.summary.warnings).toEqual([
      "skipped out-file.md: resolves outside the working directory (symbolic link)",
    ]);
  });

  it("a file spelled inside that resolves inside (AGENTS.md -> CLAUDE.md style) is scanned", () => {
    const r = runBuilt(["CLAUDE.md"]);
    expect(r.status).toBe(1);
    expect(r.summary.filesScanned).toBe(1);
    expect(r.summary.warnings).toBeUndefined();
  });

  it("a directory spelled inside that resolves inside is scanned", () => {
    const r = runBuilt(["in-dir"]);
    expect(r.status).toBe(1);
    expect(r.summary.filesScanned).toBe(1);
    expect(r.summary.warnings).toBeUndefined();
  });

  it("a file spelled outside (absolute or `..`) is the caller's choice and is scanned", () => {
    for (const target of [
      path.join(outside, "AGENTS.md"),
      path.join("..", "outside", "AGENTS.md"),
    ]) {
      const r = runBuilt([target]);
      expect(r.status).toBe(1);
      expect(r.summary.filesScanned).toBe(1);
      expect(r.summary.warnings).toBeUndefined();
    }
  });

  it("a directory spelled outside (absolute or `..`) is the caller's choice and is scanned", () => {
    for (const target of [outside, path.join("..", "outside")]) {
      const r = runBuilt([target]);
      expect(r.status).toBe(1);
      expect(r.summary.filesScanned).toBe(1);
      expect(r.summary.warnings).toBeUndefined();
    }
  });

  it("a directory walk still never follows a symlink entry", () => {
    const r = runBuilt(["."]);
    // AGENTS.md and real/AGENTS.md; CLAUDE.md, out-file.md, out-dir and
    // in-dir are symlink entries the walk skips, as before.
    expect(r.summary.filesScanned).toBe(2);
    expect(r.summary.warnings).toBeUndefined();
    expect(r.summary.violations.every((v) => !v.path.includes("outside"))).toBe(
      true,
    );
  });
});

// `--config` through a symbolic link, built CLI, working directory under
// os.tmpdir() (an alias of its real path on macOS).
describe("cli check --config and symbolic links", () => {
  const builtEntry = path.join(packageRoot, "dist", "cli.js");
  const fragment = "SECRET-FRAGMENT-QX7";
  let base: string;
  let work: string;
  let outside: string;

  beforeAll(() => {
    ensureBuilt();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cli-cfg-"));
    work = path.join(base, "work");
    outside = path.join(base, "outside");
    fs.mkdirSync(work);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(work, "a.md"), "# A\n\nPlain text.\n");
    fs.writeFileSync(
      path.join(work, "real.yml"),
      "packs:\n  agent-tics: true\n",
    );
    fs.writeFileSync(path.join(outside, "secret.yml"), `packs: [${fragment}\n`);
    fs.writeFileSync(path.join(outside, "secret.json"), `{"${fragment}": `);
    fs.writeFileSync(
      path.join(outside, "ok.yml"),
      "packs:\n  agent-tics: true\n",
    );
    fs.symlinkSync(
      path.join(outside, "secret.yml"),
      path.join(work, "slop.config.yml"),
    );
    fs.symlinkSync(
      path.join(outside, "secret.json"),
      path.join(work, "slop.config.json"),
    );
    fs.symlinkSync("real.yml", path.join(work, "alias.yml"));
  }, 180_000);

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function runBuilt(args: string[]) {
    return spawnSync(
      process.execPath,
      [builtEntry, "check", "--format", "json", ...args, "a.md"],
      { cwd: work, encoding: "utf8" },
    );
  }

  for (const name of ["slop.config.yml", "slop.config.json"]) {
    it(`a ${name} spelled inside that resolves outside is refused (exit 2) without quoting it`, () => {
      const r = runBuilt(["--config", name]);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(
        `slop-detector: refusing --config ${name}: resolves outside the working directory (symbolic link)\n`,
      );
      expect(r.stderr).not.toContain(fragment);
    });
  }

  it("an in-tree config symlink is loaded as before", () => {
    const r = runBuilt(["--config", "alias.yml"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).filesScanned).toBe(1);
  });

  it("a config spelled outside the working directory is the caller's choice and is read", () => {
    const ok = runBuilt(["--config", path.join("..", "outside", "ok.yml")]);
    expect(ok.status).toBe(0);
    const bad = runBuilt(["--config", path.join(outside, "secret.yml")]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).not.toContain("refusing");
  });

  it("a missing config still reports not found", () => {
    const r = runBuilt(["--config", "nope.yml"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Config file not found");
  });
});

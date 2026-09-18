import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { doctor, parseGitVersion } from "../src/doctor/index.js";
import { doctor as doctorFromIndex } from "../src/index.js";
import { lockKey } from "../src/lock.js";
import {
  containmentRoot,
  resolveDeepestExisting,
} from "../src/probe/containment.js";
import {
  SCRATCH_OWNER_FILE,
  SCRATCH_OWNER_MAX_AGE_HOURS,
  scratchOwnerPath,
} from "../src/probe/isolation.js";
import { DELETED_FILE_HASH } from "../src/probe/mutant.js";
import { writeGitShim } from "./helpers/git-shim.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-doctor-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

/** A directory symlink pointing at `target`, removed in `afterEach`
 * before the directories are, and by `unlink` (never a recursive
 * remove), so the cleanup can never reach through the link into what it
 * points at. */
const tmpLinks: string[] = [];
function makeTmpLink(target: string, name: string): string {
  const link = path.join(makeTmpDir(), name);
  fs.symlinkSync(target, link, "dir");
  tmpLinks.push(link);
  return link;
}

/** The same digest probe records in a marker, so a fixture marker can
 * describe a state doctor's recovery check actually accepts instead of
 * placeholder hashes that match nothing. */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Whether python3 is on this test process's own real PATH: the
 * `python-bytecode-cache` check's real-resolution branch needs a real
 * CPython to resolve against, so tests exercising it are skipped
 * through `it.skipIf` (rather than silently exercising only the
 * fallback, or returning early into a pass that asserted nothing)
 * where none is present, the same idiom `probe-pycache.test.ts`
 * already uses. A skip is visible in the run's own output; the cases
 * that only need SOME `python3` on PATH, rather than a real CPython's
 * own answers, use `writePython3Stub` below and never skip. */
const HAS_PYTHON3 = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The aggregate spawn deadline every `python-bytecode-cache` case that
 * needs the resolution to actually happen pins, rather than inheriting
 * the 3000ms default. That default is shared with doctor's own
 * `--version` captures, which run BEFORE the target loop: on a cold
 * cache their measured overhead reaches 181ms, and under a loaded
 * machine (a full suite in parallel) it can reach the default itself,
 * at which point the target loop skips its `python3` resolution
 * entirely and these cases fail on a missing call log or a detail
 * naming the deadline instead of the branch they are about. Sixty
 * seconds is far past anything that overhead can reach while staying
 * finite, and every case that pins it also asserts the deadline clause
 * is absent, so a spent deadline fails by name rather than opaquely.
 * The cases that put the deadline itself under test pin their own,
 * deliberately small, value instead. */
const GENEROUS_DEADLINE_MS = 60_000;

/** A `python3` stand-in written into `binDir`, for the cases that turn
 * on WHETHER doctor spawns its cache-path resolution, on WHAT it asks
 * about, and on what it does with an answer it does not get, rather
 * than on a real CPython's own resolution: doctor looks `python3` up on
 * the `pathEnv` it is handed and runs a plain `python3 -c ...`, so a
 * stub pins all three on any host, one with no CPython included. Every
 * call appends its own arguments to `callLog` (a path outside
 * `binDir`), so a test can assert the spawn did not happen at all, or
 * assert which source path it was asked about; `printsPath`, when
 * given, is echoed as the resolved cache path the way the real
 * resolver's one line of stdout is. */
function writePython3Stub(
  binDir: string,
  callLog: string,
  opts: { exitStatus: number; printsPath?: string; sleepMs?: number },
): void {
  const script = [
    "#!/bin/sh",
    "# Test stub; see writePython3Stub in doctor.test.ts.",
    `printf '%s\\n' "$*" >> '${callLog}'`,
    // Fractional-second `sleep` is supported by both BSD (macOS) and
    // GNU (Linux) coreutils, so this stub's timing behavior is portable
    // across both platforms `writePython3Stub`'s own callers run on.
    ...(opts.sleepMs !== undefined
      ? [`sleep ${String(opts.sleepMs / 1000)}`]
      : []),
    ...(opts.printsPath !== undefined
      ? [`printf '%s\\n' '${opts.printsPath}'`]
      : []),
    `exit ${String(opts.exitStatus)}`,
    "",
  ].join("\n");
  const stubPath = path.join(binDir, "python3");
  fs.writeFileSync(stubPath, script);
  fs.chmodSync(stubPath, 0o755);
}

/** The exact cache path THIS host's real python3 (real `process.env`
 * included, so an already-set `PYTHONPYCACHEPREFIX` is honoured the
 * same way doctor's own child invocation honours it) would use for
 * `target` under `cwd`: what `doctor`'s own `python-bytecode-cache`
 * check resolves internally, computed independently here so a test can
 * plant a fixture cache file at the one path the check will actually
 * look for. */
function resolveCachePathViaPython3(cwd: string, target: string): string {
  const realCwd = fs.realpathSync(cwd);
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import importlib.util, sys; print(importlib.util.cache_from_source(sys.argv[1]))",
      path.resolve(realCwd, target),
    ],
    { cwd: realCwd, encoding: "utf8" },
  );
  const resolved = result.stdout?.trim();
  if (result.status !== 0 || !resolved) {
    throw new Error(
      `could not resolve ${target}'s own cache path via python3: ${result.stderr}`,
    );
  }
  // Real, absolute, both ways, for the two reasons
  // `resolvePyCacheTarget`'s own docblock gives (an unset prefix
  // answering relatively, a set prefix joining the source's own real
  // directory). This helper has to resolve exactly as the check does,
  // since a test plants a fixture cache at the one path the check will
  // look for. Where the helper and the implementation shared the
  // unresolved spelling, the assertions passed while both looked at the
  // wrong place.
  return path.resolve(realCwd, resolved);
}

afterEach(() => {
  for (const link of tmpLinks.splice(0)) {
    try {
      fs.unlinkSync(link);
    } catch {
      // Already gone with its parent fixture directory.
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("doctor", () => {
  it("finds node and npm on the real process.env.PATH", async () => {
    const result = await doctor({ required: ["node", "npm"], optional: [] });
    expect(result.status).toBe("ok");
    const node = result.tools.find((t) => t.name === "node");
    const npm = result.tools.find((t) => t.name === "npm");
    expect(node?.found).toBe(true);
    expect(node?.path).toBeTruthy();
    expect(npm?.found).toBe(true);
  });

  it("finds a stub binary on a fake PATH directory and captures its version", async () => {
    const dir = makeTmpDir();
    const stubPath = path.join(dir, "definitely-a-stub");
    fs.writeFileSync(
      stubPath,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo \'stub-tool 9.9.9\'; fi\n',
    );
    fs.chmodSync(stubPath, 0o755);
    const result = await doctor({
      required: ["definitely-a-stub"],
      optional: [],
      pathEnv: dir,
    });
    const tool = result.tools.find((t) => t.name === "definitely-a-stub");
    expect(tool?.found).toBe(true);
    expect(tool?.path).toBe(stubPath);
    expect(tool?.version).toBe("stub-tool 9.9.9");
    expect(result.status).toBe("ok");
  });

  it("ships no version key at all for a binary that runs but prints nothing", async () => {
    const dir = makeTmpDir();
    const stubPath = path.join(dir, "quiet-tool");
    fs.writeFileSync(stubPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(stubPath, 0o755);
    const result = await doctor({
      required: ["quiet-tool"],
      optional: [],
      pathEnv: dir,
    });
    const tool = result.tools.find((t) => t.name === "quiet-tool");
    expect(tool?.found).toBe(true);
    // Not `version: undefined` as an own property: a shipped result must
    // carry no undefined-valued own properties, which `in` sees and
    // `toBeUndefined()` would not.
    expect(tool && "version" in tool).toBe(false);
    expect(tool?.versionCheck).toBeUndefined();
  });

  it("reports status missing and found: false for a binary that does not exist anywhere on PATH", async () => {
    const result = await doctor({
      required: ["git", "definitely-not-a-binary-xyz"],
      optional: [],
    });
    const tool = result.tools.find(
      (t) => t.name === "definitely-not-a-binary-xyz",
    );
    expect(tool?.found).toBe(false);
    expect(result.status).toBe("missing");
  });

  it("finds ast-grep via its sg alias", async () => {
    const dir = makeTmpDir();
    const stubPath = path.join(dir, "sg");
    fs.writeFileSync(stubPath, "#!/bin/sh\necho 'ast-grep 0.0.0-stub'\n");
    fs.chmodSync(stubPath, 0o755);
    const result = await doctor({
      required: [],
      optional: ["ast-grep"],
      pathEnv: dir,
    });
    const tool = result.tools.find((t) => t.name === "ast-grep");
    expect(tool?.found).toBe(true);
    expect(tool?.path).toBe(stubPath);
  });

  it("re-exports doctor from ../src/index.js with identical behavior", async () => {
    const result = await doctorFromIndex({ required: ["node"], optional: [] });
    expect(result.tools.find((t) => t.name === "node")?.found).toBe(true);
  });
});

describe("doctor: binary name validation", () => {
  it("rejects a required entry shaped like a path traversal, before looking anything up", async () => {
    await expect(
      doctor({ required: ["../../x"], optional: [] }),
    ).rejects.toThrow(/plain binary name/);
  });

  it("rejects an optional entry containing a path separator", async () => {
    await expect(doctor({ required: [], optional: ["a/b"] })).rejects.toThrow(
      /plain binary name/,
    );
  });

  it('rejects "." and ".." as entries', async () => {
    await expect(doctor({ required: ["."], optional: [] })).rejects.toThrow();
    await expect(doctor({ required: [], optional: [".."] })).rejects.toThrow();
  });
});

describe("doctor: version capture timeout", () => {
  it("records versionCheck: timed_out and a warning when --version does not return in time", async () => {
    const dir = makeTmpDir();
    const stubPath = path.join(dir, "slow-tool");
    fs.writeFileSync(stubPath, "#!/bin/sh\nsleep 2\n");
    fs.chmodSync(stubPath, 0o755);
    const result = await doctor({
      required: ["slow-tool"],
      optional: [],
      pathEnv: dir,
      versionTimeoutMs: 100,
    });
    const tool = result.tools.find((t) => t.name === "slow-tool");
    expect(tool?.found).toBe(true);
    expect(tool?.versionCheck).toBe("timed_out");
    expect(result.warnings.some((w) => w.includes("slow-tool"))).toBe(true);
  }, 10000);
});

describe("doctor: aggregate version-capture deadline", () => {
  it("skips remaining --version captures once the aggregate deadline is spent, warning once with a count", async () => {
    const dir = makeTmpDir();
    // Each stub sleeps 150ms before printing its version, with a generous
    // per-tool timeout (5000ms) so the per-tool timeout never fires on its
    // own. The aggregate deadline (100ms) is spent well before the first
    // capture (150ms) even returns, so the first tool's capture -- already
    // in flight when the deadline check runs, at the start of each tool --
    // still completes normally, and every tool after it is skipped
    // outright without ever spawning.
    const names = ["stub-a", "stub-b", "stub-c"];
    for (const name of names) {
      const stubPath = path.join(dir, name);
      fs.writeFileSync(
        stubPath,
        `#!/bin/sh\nsleep 0.15\necho '${name} 1.0.0'\n`,
      );
      fs.chmodSync(stubPath, 0o755);
    }
    const result = await doctor({
      required: names,
      optional: [],
      pathEnv: dir,
      versionTimeoutMs: 5000,
      versionDeadlineMs: 100,
    });
    const tools = names.map((name) =>
      result.tools.find((t) => t.name === name),
    );
    expect(tools.every((t) => t?.found)).toBe(true);
    expect(tools[0]?.versionCheck).not.toBe("skipped_deadline");
    expect(tools[0]?.version).toBe("stub-a 1.0.0");
    const skipped = tools.filter((t) => t?.versionCheck === "skipped_deadline");
    expect(skipped.length).toBeGreaterThan(0);
    expect(
      result.warnings.some(
        (w) => w.includes("deadline") && w.includes(String(skipped.length)),
      ),
    ).toBe(true);
  }, 10000);
});

describe("doctor: checks, in both states", () => {
  it("node_modules: ok when present, not ok when absent", async () => {
    const withoutModules = makeTmpDir();
    const resultWithout = await doctor({
      required: [],
      optional: [],
      cwd: withoutModules,
    });
    const checkWithout = resultWithout.checks.find(
      (c) => c.name === "node_modules",
    );
    expect(checkWithout?.ok).toBe(false);

    const withModules = makeTmpDir();
    fs.mkdirSync(path.join(withModules, "node_modules"));
    const resultWith = await doctor({
      required: [],
      optional: [],
      cwd: withModules,
    });
    const checkWith = resultWith.checks.find((c) => c.name === "node_modules");
    expect(checkWith?.ok).toBe(true);
  });

  it("git-work-tree: ok inside a git work tree, not ok outside one", async () => {
    const outsideDir = makeTmpDir();
    const resultOutside = await doctor({
      required: [],
      optional: [],
      cwd: outsideDir,
    });
    const checkOutside = resultOutside.checks.find(
      (c) => c.name === "git-work-tree",
    );
    expect(checkOutside?.ok).toBe(false);

    // A fixture built in mkdtemp, not an assertion on the real checkout:
    // isInsideGitWorkTree only checks for a `.git` entry (file or
    // directory) at the cwd or an ancestor, so a bare `.git` directory is
    // enough to exercise the "inside" branch without depending on this
    // package's own directory being inside a real git work tree.
    const insideDir = makeTmpDir();
    fs.mkdirSync(path.join(insideDir, ".git"));
    const resultInside = await doctor({
      required: [],
      optional: [],
      cwd: insideDir,
    });
    const checkInside = resultInside.checks.find(
      (c) => c.name === "git-work-tree",
    );
    expect(checkInside?.ok).toBe(true);
  });

  it("BASH_MAX_OUTPUT_LENGTH: reports the value when set, restoring env afterward", async () => {
    const before = process.env.BASH_MAX_OUTPUT_LENGTH;
    process.env.BASH_MAX_OUTPUT_LENGTH = "12345";
    try {
      const result = await doctor({ required: [], optional: [] });
      const check = result.checks.find(
        (c) => c.name === "BASH_MAX_OUTPUT_LENGTH",
      );
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("12345");
    } finally {
      if (before === undefined) delete process.env.BASH_MAX_OUTPUT_LENGTH;
      else process.env.BASH_MAX_OUTPUT_LENGTH = before;
    }
  });

  it("BASH_MAX_OUTPUT_LENGTH: reports not set when absent, restoring env afterward", async () => {
    const before = process.env.BASH_MAX_OUTPUT_LENGTH;
    delete process.env.BASH_MAX_OUTPUT_LENGTH;
    try {
      const result = await doctor({ required: [], optional: [] });
      const check = result.checks.find(
        (c) => c.name === "BASH_MAX_OUTPUT_LENGTH",
      );
      expect(check?.detail).toBe("BASH_MAX_OUTPUT_LENGTH is not set");
    } finally {
      if (before !== undefined) process.env.BASH_MAX_OUTPUT_LENGTH = before;
    }
  });

  it("dist-next-to-src: ok with no src/ directory", async () => {
    const dir = makeTmpDir();
    const result = await doctor({ required: [], optional: [], cwd: dir });
    const check = result.checks.find((c) => c.name === "dist-next-to-src");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toBe("no src/ directory in cwd");
  });

  it("dist-next-to-src: not ok when src/ exists without dist/", async () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    const result = await doctor({ required: [], optional: [], cwd: dir });
    const check = result.checks.find((c) => c.name === "dist-next-to-src");
    expect(check?.ok).toBe(false);
  });

  it("dist-next-to-src: ok when both src/ and dist/ exist", async () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "dist"));
    const result = await doctor({ required: [], optional: [], cwd: dir });
    const check = result.checks.find((c) => c.name === "dist-next-to-src");
    expect(check?.ok).toBe(true);
  });

  it("python-bytecode-cache: absent from checks entirely when no --target is given", async () => {
    const dir = makeTmpDir();
    const result = await doctor({ required: [], optional: [], cwd: dir });
    expect(
      result.checks.find((c) => c.name === "python-bytecode-cache"),
    ).toBeUndefined();
  });

  it("python-bytecode-cache: absent when the only --target given is not a .py file", async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "fixture.js"), "");
    const result = await doctor({
      required: [],
      optional: [],
      cwd: dir,
      targets: ["fixture.js"],
    });
    expect(
      result.checks.find((c) => c.name === "python-bytecode-cache"),
    ).toBeUndefined();
  });

  it("python-bytecode-cache: ok, no cache found, when a .py target has no cache anywhere", async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "fixture.py"), "");
    const result = await doctor({
      required: [],
      optional: [],
      cwd: dir,
      targets: ["fixture.py"],
      versionDeadlineMs: GENEROUS_DEADLINE_MS,
    });
    const check = result.checks.find((c) => c.name === "python-bytecode-cache");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("no Python bytecode cache found");
    expect(check?.detail).toContain("fixture.py");
    expect(check?.detail).not.toContain("already spent");
  });

  it.skipIf(!HAS_PYTHON3)(
    "python-bytecode-cache: ok, names the target's real resolved cache path when python3 is on PATH and a cache exists there",
    async () => {
      const dir = makeTmpDir();
      fs.writeFileSync(path.join(dir, "fixture.py"), "");
      // The exact path THIS host's python3 would use for fixture.py,
      // resolved the same way doctor's own check does
      // (`importlib.util.cache_from_source`), never assumed to be a
      // co-located `__pycache__`: this host's own python3 may redirect it
      // elsewhere by default (macOS's system python3 does).
      const cachePath = resolveCachePathViaPython3(dir, "fixture.py");
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, "");
      // No `pathEnv` override: the real PATH is what makes doctor's own
      // `findOnPath(["python3"], dirs)` find the same python3 this test
      // just resolved the path with.
      const result = await doctor({
        required: [],
        optional: [],
        cwd: dir,
        targets: ["fixture.py"],
        versionDeadlineMs: GENEROUS_DEADLINE_MS,
      });
      const check = result.checks.find(
        (c) => c.name === "python-bytecode-cache",
      );
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("fixture.py");
      expect(check?.detail).toContain(cachePath);
      expect(check?.detail).toContain("PYTHONPYCACHEPREFIX");
      expect(check?.detail).not.toContain("already spent");
    },
  );

  it.skipIf(!HAS_PYTHON3)(
    "python-bytecode-cache: ok, still finds a cache that PYTHONPYCACHEPREFIX redirects elsewhere",
    async () => {
      const dir = makeTmpDir();
      const redirectDir = makeTmpDir();
      fs.writeFileSync(path.join(dir, "fixture.py"), "");
      const before = process.env.PYTHONPYCACHEPREFIX;
      process.env.PYTHONPYCACHEPREFIX = redirectDir;
      try {
        // Resolved WITH the same redirect this process now carries, so
        // this matches whatever doctor's own child `python3` invocation
        // (which inherits `process.env`) resolves to.
        const cachePath = resolveCachePathViaPython3(dir, "fixture.py");
        expect(cachePath.startsWith(redirectDir)).toBe(true);
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, "");
        const result = await doctor({
          required: [],
          optional: [],
          cwd: dir,
          targets: ["fixture.py"],
          versionDeadlineMs: GENEROUS_DEADLINE_MS,
        });
        const check = result.checks.find(
          (c) => c.name === "python-bytecode-cache",
        );
        expect(check?.ok).toBe(true);
        expect(check?.detail).toContain(cachePath);
        expect(check?.detail).not.toContain("already spent");
      } finally {
        if (before === undefined) delete process.env.PYTHONPYCACHEPREFIX;
        else process.env.PYTHONPYCACHEPREFIX = before;
      }
    },
  );

  it("python-bytecode-cache: ok, falls back to a co-located __pycache__ and says so when python3 is not on PATH", async () => {
    const dir = makeTmpDir();
    const emptyPath = makeTmpDir();
    fs.writeFileSync(path.join(dir, "fixture.py"), "");
    fs.mkdirSync(path.join(dir, "__pycache__"));
    const result = await doctor({
      required: [],
      optional: [],
      cwd: dir,
      targets: ["fixture.py"],
      pathEnv: emptyPath,
      versionDeadlineMs: GENEROUS_DEADLINE_MS,
    });
    const check = result.checks.find((c) => c.name === "python-bytecode-cache");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("fixture.py");
    expect(check?.detail).toContain("python3 not found on PATH");
    expect(check?.detail).not.toContain("already spent");
  });

  it.skipIf(!HAS_PYTHON3)(
    "python-bytecode-cache: names the cache path the interpreter ITSELF uses when the given cwd is a symlink",
    async () => {
      // The end-to-end form of the same resolution, against the one
      // authority on where a cache file goes: the interpreter's own
      // `__cached__` after it really imported the module. This one
      // discriminates wherever a symlink is involved rather than only
      // where the host's temp directory happens to be one, since it
      // creates the link itself, and it holds under both cache shapes
      // (a redirected `sys.pycache_prefix` and none), because the
      // interpreter resolves the cwd to its real path either way.
      const real = makeTmpDir();
      const link = makeTmpLink(real, "link-to-fixture-dir");
      fs.writeFileSync(
        path.join(real, "fixture.py"),
        ["def positive(n):", "    return n > 0", ""].join("\n"),
      );
      const imported = spawnSync(
        "python3",
        ["-c", "import fixture; print(fixture.__cached__)"],
        { cwd: link, encoding: "utf8" },
      );
      expect(imported.status).toBe(0);
      const cachedPath = imported.stdout.trim();
      // The import really wrote it, so this is the live file, not a
      // string the test made up.
      expect(fs.existsSync(cachedPath)).toBe(true);
      const result = await doctor({
        required: [],
        optional: [],
        cwd: link,
        targets: ["fixture.py"],
        versionDeadlineMs: GENEROUS_DEADLINE_MS,
      });
      const check = result.checks.find(
        (c) => c.name === "python-bytecode-cache",
      );
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain(cachedPath);
      expect(check?.detail).not.toContain("already spent");
    },
  );

  it("python-bytecode-cache: a cwd that does not exist resolves nothing and is reported as a fallback, not as a cache", async () => {
    // The `realDirOf` catch: a directory that cannot be resolved is
    // used as given rather than swapped for some other directory, so
    // the resolution fails for that target and the detail says so. A
    // fallback to any EXISTING directory would instead resolve happily
    // and report that directory's cache situation as the target's.
    const binDir = makeTmpDir();
    const callLog = path.join(makeTmpDir(), "python3-calls.txt");
    // A stub rather than the real PATH: only so the check reaches its
    // resolution at all on a host with no CPython (`python3` absent
    // reports its own fallback clause instead). The spawn never runs,
    // since its cwd does not exist.
    writePython3Stub(binDir, callLog, {
      exitStatus: 0,
      printsPath: path.join(binDir, "unrelated.pyc"),
    });
    const result = await doctor({
      required: [],
      optional: [],
      cwd: path.join(os.tmpdir(), `agent-primitives-absent-${randomUUID()}`),
      targets: ["fixture.py"],
      pathEnv: binDir,
      versionDeadlineMs: GENEROUS_DEADLINE_MS,
    });
    const check = result.checks.find((c) => c.name === "python-bytecode-cache");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain(
      "python3 did not resolve a cache path for fixture.py",
    );
    expect(check?.detail).not.toContain("python3 not found on PATH");
    expect(check?.detail).not.toContain("already spent");
  });

  it("python-bytecode-cache: asks python3 about the target's real absolute path, not the spelling the caller used", async () => {
    // The other half of the same resolution: `cache_from_source` joins
    // the prefix with the SOURCE's own directory, and for a relative
    // source that directory is `os.getcwd()`, which is always the real
    // path. A directory reached through a symlink therefore has two
    // spellings that answer differently on a host whose python3
    // redirects its cache (macOS's own, where every mkdtemp path is
    // reached through `/var -> /private/var`), and only the real one
    // names the file the interpreter's own imports write. Pinned here
    // through the stub's argument log, which needs no CPython at all;
    // the assertion is exact on every host, and discriminates on any
    // host whose temp directory is reached through a symlink, this one
    // included.
    const dir = makeTmpDir();
    const binDir = makeTmpDir();
    const callLog = path.join(makeTmpDir(), "python3-calls.txt");
    fs.writeFileSync(path.join(dir, "fixture.py"), "");
    writePython3Stub(binDir, callLog, { exitStatus: 0, printsPath: "" });
    const result = await doctor({
      required: [],
      optional: [],
      cwd: dir,
      targets: ["fixture.py"],
      pathEnv: binDir,
      versionDeadlineMs: GENEROUS_DEADLINE_MS,
    });
    // Asserted before the call log is read: a deadline spent before the
    // target loop would leave no log at all, and the resulting ENOENT
    // names the file rather than the cause.
    const check = result.checks.find((c) => c.name === "python-bytecode-cache");
    expect(check?.detail).not.toContain("already spent");
    const asked = fs.readFileSync(callLog, "utf8");
    expect(asked).toContain(path.join(fs.realpathSync(dir), "fixture.py"));
  });

  it("python-bytecode-cache: resolves a RELATIVE cache path from python3 against the given cwd, not this process's own", async () => {
    // `cache_from_source` is a pure string transform, so a python3 with
    // no `sys.pycache_prefix` set (every ordinary host but macOS's own
    // system python3) answers a relative source path with an equally
    // relative cache path. Checked against the wrong base, that reports
    // a cache belonging to whatever directory the caller's process
    // happens to sit in, or none where the target really has one. The
    // stub answers relatively on purpose; the planted cache sits in the
    // fixture directory, which is the `cwd` the caller named and the
    // only place the answer may be read against.
    const dir = makeTmpDir();
    const binDir = makeTmpDir();
    const callLog = path.join(makeTmpDir(), "python3-calls.txt");
    fs.writeFileSync(path.join(dir, "fixture.py"), "");
    const relativeAnswer = path.join("__pycache__", "fixture.cpython-312.pyc");
    // The expectation is spelled with the REAL directory, the one the
    // check resolves against: a mkdtemp path is reached through a
    // symlink on macOS, and the same file then has two spellings.
    const plantedCache = path.join(fs.realpathSync(dir), relativeAnswer);
    fs.mkdirSync(path.dirname(plantedCache), { recursive: true });
    fs.writeFileSync(plantedCache, "");
    writePython3Stub(binDir, callLog, {
      exitStatus: 0,
      printsPath: relativeAnswer,
    });
    const result = await doctor({
      required: [],
      optional: [],
      cwd: dir,
      targets: ["fixture.py"],
      pathEnv: binDir,
      versionDeadlineMs: GENEROUS_DEADLINE_MS,
    });
    const check = result.checks.find((c) => c.name === "python-bytecode-cache");
    expect(check?.ok).toBe(true);
    expect(check?.detail).not.toContain("already spent");
    expect(fs.existsSync(callLog)).toBe(true);
    // Found, and named by its absolute path under the given cwd. Read
    // against this process's cwd instead, the same answer names nothing
    // that exists, and the check reports no cache at all.
    expect(check?.detail).toContain(plantedCache);
    expect(check?.detail).not.toContain("no Python bytecode cache found");
    // The fallback clauses are for a target that could not be resolved;
    // this one was.
    expect(check?.detail).not.toContain("did not resolve a cache path");
  });

  it("python-bytecode-cache: ok, names the target it fell back for when python3 IS on PATH but resolves no cache path for it", async () => {
    // The third way into the co-located guess, distinct from the
    // python3-absent case above and from the deadline case below: a
    // `python3` that was asked and did not come back with a path (a
    // non-zero exit, no output, its own timeout). The detail must say
    // which targets that happened for, rather than reporting the
    // guess's answer as though python3 had given it.
    const dir = makeTmpDir();
    const binDir = makeTmpDir();
    const callLog = path.join(makeTmpDir(), "python3-calls.txt");
    fs.writeFileSync(path.join(dir, "fixture.py"), "");
    fs.mkdirSync(path.join(dir, "__pycache__"));
    writePython3Stub(binDir, callLog, { exitStatus: 3 });
    const result = await doctor({
      required: [],
      optional: [],
      cwd: dir,
      targets: ["fixture.py"],
      pathEnv: binDir,
      versionDeadlineMs: GENEROUS_DEADLINE_MS,
    });
    const check = result.checks.find((c) => c.name === "python-bytecode-cache");
    expect(check?.ok).toBe(true);
    expect(check?.detail).not.toContain("already spent");
    // python3 really was asked: this is the resolution-failed path, not
    // the python3-absent one.
    expect(fs.existsSync(callLog)).toBe(true);
    expect(check?.detail).toContain(
      "python3 did not resolve a cache path for fixture.py",
    );
    expect(check?.detail).not.toContain("python3 not found on PATH");
    // The guess was actually used, not merely announced, and is spelled
    // with the real directory, the same one the resolved branch
    // reports: one detail line never mixes two spellings of one
    // directory.
    expect(check?.detail).toContain(
      path.join(fs.realpathSync(dir), "__pycache__"),
    );
  });

  it("python-bytecode-cache: spawns no python3 at all once doctor's aggregate deadline is spent, names the deadline, and falls back to the co-located guess", async () => {
    // The resolution is a spawn per target, so a `--target` list of any
    // length is bound by the same aggregate deadline the `--version`
    // captures are, not only by its own per-target timeout. Pinned
    // through the stub's call log rather than by timing: with the
    // deadline already spent, the stub must never run, even though it
    // would resolve successfully (to a path nothing exists at, so a
    // spawn that did happen would replace the co-located hit below with
    // "no cache found").
    const dir = makeTmpDir();
    const binDir = makeTmpDir();
    const callLog = path.join(makeTmpDir(), "python3-calls.txt");
    fs.writeFileSync(path.join(dir, "first.py"), "");
    fs.writeFileSync(path.join(dir, "second.py"), "");
    fs.mkdirSync(path.join(dir, "__pycache__"));
    writePython3Stub(binDir, callLog, {
      exitStatus: 0,
      printsPath: path.join(dir, "no-such-cache", "fixture.pyc"),
    });
    const result = await doctor({
      required: [],
      optional: [],
      cwd: dir,
      targets: ["first.py", "second.py"],
      pathEnv: binDir,
      versionDeadlineMs: 0,
    });
    const check = result.checks.find((c) => c.name === "python-bytecode-cache");
    expect(check?.ok).toBe(true);
    expect(fs.existsSync(callLog)).toBe(false);
    expect(check?.detail).toContain(
      "doctor's aggregate spawn deadline (0ms) was already spent",
    );
    expect(check?.detail).toContain("first.py");
    expect(check?.detail).toContain("second.py");
    expect(check?.detail).toContain(
      path.join(fs.realpathSync(dir), "__pycache__"),
    );
  });

  it("python-bytecode-cache: a deadline spent WHILE the first target's own resolution is in flight lets that target resolve through python3 and pushes only the second into the deadline clause", async () => {
    // Same margin the aggregate `--version`-deadline test above uses in
    // spirit (a stub sleep well past the deadline, with a generous
    // 5000ms per-item timeout so that timeout never fires on its own),
    // but with a wider absolute gap than that test's own 100ms/150ms:
    // measured pre-loop overhead on this suite runs 4-18ms warm but as
    // high as 181ms on a cold-cache sample, which would eat a 100ms
    // deadline before the loop even starts and make target 1 land in
    // the deadline-skipped clause too -- turning this test's own
    // readFileSync(resolvedCache) assumption false and failing loudly
    // rather than silently passing. A 300ms deadline against a 400ms
    // stub sleep keeps the same invariant (sleep > deadline, so target 2
    // is always deadline-skipped) with headroom past that cold-cache
    // overhead. The deadline check runs at the TOP of each target's own
    // turn (see the `python-bytecode-cache` loop in
    // src/doctor/index.ts), so the first target's resolution -- already
    // in flight when its own check ran, before the deadline was spent
    // -- completes normally, and only the second target's turn finds
    // the deadline already spent. Pinned through the stub's call log
    // and the resolved cache path, never through wall-clock timing
    // assertions, so this is deterministic on both macOS and Linux.
    const dir = makeTmpDir();
    const binDir = makeTmpDir();
    const callLog = path.join(makeTmpDir(), "python3-calls.txt");
    fs.writeFileSync(path.join(dir, "first.py"), "");
    fs.writeFileSync(path.join(dir, "second.py"), "");
    const resolvedCache = path.join(dir, "resolved-by-stub.pyc");
    fs.writeFileSync(resolvedCache, "");
    writePython3Stub(binDir, callLog, {
      exitStatus: 0,
      printsPath: resolvedCache,
      sleepMs: 400,
    });
    const result = await doctor({
      required: [],
      optional: [],
      cwd: dir,
      targets: ["first.py", "second.py"],
      pathEnv: binDir,
      versionTimeoutMs: 5000,
      versionDeadlineMs: 300,
    });
    const check = result.checks.find((c) => c.name === "python-bytecode-cache");
    expect(check?.ok).toBe(true);
    // Exactly one call: python3 was spawned for first.py, and never for
    // second.py, whose turn found the deadline already spent.
    expect(fs.readFileSync(callLog, "utf8").trim().split("\n").length).toBe(1);
    expect(check?.detail).toContain(`first.py (${resolvedCache})`);
    expect(check?.detail).toContain(
      "doctor's aggregate spawn deadline (300ms) was already spent",
    );
    expect(check?.detail).toContain("second.py");
    // first.py resolved cleanly through the stub: it must not also be
    // folded into either fallback clause, which name only second.py.
    expect(check?.detail).not.toContain("python3 not found on PATH");
    expect(check?.detail).not.toContain("did not resolve a cache path");
    const deadlineClauseStart = check!.detail!.indexOf(
      "doctor's aggregate spawn deadline",
    );
    expect(check!.detail!.slice(deadlineClauseStart)).not.toContain("first.py");
  }, 10000);

  it("python-bytecode-cache: a detail can carry both the unresolved and the deadline-spent fallback clauses at once, joined by '; '", async () => {
    // The first target is asked and fails to resolve (a non-zero exit,
    // consuming 400ms before returning -- see the deadline-spent test
    // above for why this margin is 300ms/400ms rather than 100ms/150ms:
    // measured pre-loop overhead runs 4-18ms warm but up to 181ms on a
    // cold-cache sample), landing it in the `unresolved` fallback; by
    // the time the loop reaches the second target the 300ms aggregate
    // deadline is already spent, landing it in the `deadlineSkipped`
    // fallback instead. One run, one target in each of the two
    // remaining fallback reasons, so the joined text this asserts is
    // the one no other test in this file exercises: both clauses
    // present together, in the order the code pushes them
    // (`unresolved` first, `deadlineSkipped` second), joined by the
    // exact `"; "` the check's own `fallbackNotes.join("; ")` uses.
    const dir = makeTmpDir();
    const binDir = makeTmpDir();
    const callLog = path.join(makeTmpDir(), "python3-calls.txt");
    fs.writeFileSync(path.join(dir, "first.py"), "");
    fs.writeFileSync(path.join(dir, "second.py"), "");
    writePython3Stub(binDir, callLog, { exitStatus: 3, sleepMs: 400 });
    const result = await doctor({
      required: [],
      optional: [],
      cwd: dir,
      targets: ["first.py", "second.py"],
      pathEnv: binDir,
      versionTimeoutMs: 5000,
      versionDeadlineMs: 300,
    });
    const check = result.checks.find((c) => c.name === "python-bytecode-cache");
    expect(check?.ok).toBe(true);
    expect(fs.readFileSync(callLog, "utf8").trim().split("\n").length).toBe(1);
    const unresolvedClause =
      "python3 did not resolve a cache path for first.py; checked only for a co-located __pycache__ there";
    const deadlineClause =
      "doctor's aggregate spawn deadline (300ms) was already spent, so the python3 cache-path resolution was skipped for second.py; checked only for a co-located __pycache__ there";
    expect(check?.detail).toContain(`${unresolvedClause}; ${deadlineClause}`);
  }, 10000);

  it("python-bytecode-cache: resolves a --target relative to an absolute cwd, not the process cwd, in the co-located fallback", async () => {
    const dir = makeTmpDir();
    const emptyPath = makeTmpDir();
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "fixture.py"), "");
    fs.mkdirSync(path.join(sub, "__pycache__"));
    const result = await doctor({
      required: [],
      optional: [],
      cwd: sub,
      targets: ["fixture.py"],
      pathEnv: emptyPath,
      versionDeadlineMs: GENEROUS_DEADLINE_MS,
    });
    const check = result.checks.find((c) => c.name === "python-bytecode-cache");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain(
      path.join(fs.realpathSync(sub), "__pycache__"),
    );
    expect(check?.detail).not.toContain("already spent");
  });
});

describe("doctor: hints", () => {
  it("is non-empty when a required tool with a generic hint is missing", async () => {
    const dir = makeTmpDir();
    const result = await doctor({
      required: ["git"],
      optional: [],
      pathEnv: dir,
    });
    expect(result.hints.length).toBeGreaterThan(0);
    expect(result.hints.some((h) => h.includes("git-scm.com"))).toBe(true);
  });

  it("is empty when no required tool is missing", async () => {
    // Unlike every other case in this file, this assertion is exact
    // (`toBe(0)`, not `toBeGreaterThan(0)`), so it is the one case a
    // stray extra hint from unrelated ambient state would actually
    // break, and it is a reproduced failure, not a hypothetical one:
    // with a concurrent real `agent-primitives probe -i worktree` run
    // against this same checkout, a pre-fix call that left `cwd` and
    // `lockDir` at their real defaults returned `hints.length === 1` in
    // every poll, because `doctor`'s `stale-worktree` check reads `git
    // worktree list` for `containmentRoot(cwd)` (`process.cwd()` here)
    // and finds that live scratch worktree registered, regardless of
    // `lockDir` (see `describe("doctor: stale-worktree check")` above
    // for the check itself). The shared lock directory (the uid-scoped
    // tmp dir every `agent-primitives` invocation on this machine
    // shares) is a second, weaker channel through the same check's
    // worktree-marker lookup. Pinning both `cwd` and `lockDir` to
    // fresh, empty fixtures (as every sibling test in this file already
    // does) removes both channels.
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const result = await doctor({
      required: ["node"],
      optional: [],
      cwd,
      lockDir,
    });
    expect(result.hints.length).toBe(0);
  });
});

describe("doctor: stale-probe-marker check", () => {
  it("ok when there are no markers at all", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-probe-marker");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("no stale probe markers");
  });

  it("ok when a marker exists but its pid is still alive", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const target = path.join(cwd, "target.js");
    fs.writeFileSync(target, "x");
    fs.writeFileSync(
      path.join(lockDir, "abc.marker.json"),
      JSON.stringify({
        targetPath: target,
        backupPath: `${target}.backup`,
        preHash: "a".repeat(64),
        mutatedHash: "b".repeat(64),
        pid: process.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-probe-marker");
    expect(check?.ok).toBe(true);
  });

  it("not ok when a marker's target is inside cwd, its pid is dead, and its backup is missing: names the marker file, never promises auto-recovery", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const target = path.join(cwd, "target.js");
    fs.writeFileSync(target, "x");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const markerPath = path.join(lockDir, "abc.marker.json");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        targetPath: target,
        // Never created on disk: simulates a backup that did not
        // survive (its per-run log dir was cleaned up, or never
        // existed on this machine at all).
        backupPath: `${target}.backup`,
        preHash: "a".repeat(64),
        mutatedHash: "b".repeat(64),
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-probe-marker");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(markerPath);
    expect(check?.detail).toContain("auto-recovery is not possible");
    expect(check?.detail).not.toContain("auto-recover,");
  });

  it("not ok, and names the backup path with an auto-recovery hint, when a stale marker describes a state the next probe would really recover", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const original = "original content";
    const mutated = "mutated content";
    const target = path.join(cwd, "target.js");
    // The state probe requires before it restores anything: the target
    // still carries exactly the mutation the marker records, and the
    // backup still hashes to the pre-mutation content.
    fs.writeFileSync(target, mutated);
    const backupPath = path.join(lockDir, "backup-target.js");
    fs.writeFileSync(backupPath, original);
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    fs.writeFileSync(
      path.join(lockDir, "abc.marker.json"),
      JSON.stringify({
        targetPath: target,
        backupPath,
        preHash: sha256(original),
        mutatedHash: sha256(mutated),
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-probe-marker");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(backupPath);
    expect(check?.detail).toContain("auto-recover");
  });

  it("ok to promise auto-recovery for a marker whose target is already back at its recorded pre-mutation hash: probe clears such a marker and continues", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const original = "original content";
    const target = path.join(cwd, "target.js");
    fs.writeFileSync(target, original);
    const backupPath = path.join(lockDir, "backup-target.js");
    fs.writeFileSync(backupPath, original);
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    fs.writeFileSync(
      path.join(lockDir, "abc.marker.json"),
      JSON.stringify({
        targetPath: target,
        backupPath,
        preHash: sha256(original),
        mutatedHash: sha256("mutated content"),
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-probe-marker");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("auto-recover");
  });

  it("promises auto-recovery for a deletion marker: the target is genuinely absent, mutatedHash is the deletion sentinel, and the backup still hashes to preHash", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const original = "original content";
    // Exactly what a SIGKILL between a deletion mutant's real apply and
    // the marker's own removal leaves behind, and exactly what probe's
    // own stale-marker branch recovers: no target at all, a marker
    // whose mutatedHash is the sentinel rather than any real digest,
    // and a backup that still hashes to the pre-mutation content.
    const target = path.join(cwd, "target.js");
    const backupPath = path.join(lockDir, "backup-target.js");
    fs.writeFileSync(backupPath, original);
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    fs.writeFileSync(
      path.join(lockDir, "abc.marker.json"),
      JSON.stringify({
        targetPath: target,
        backupPath,
        preHash: sha256(original),
        mutatedHash: DELETED_FILE_HASH,
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-probe-marker");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(backupPath);
    expect(check?.detail).toContain("auto-recover");
    expect(check?.detail).not.toContain("auto-recovery is not possible");
  });

  it("not ok for a deletion marker whose backup does not hash to preHash: the deletion sentinel alone is not enough, and never promises auto-recovery", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const original = "original content";
    // Absent target and the deletion sentinel match the recoverable
    // shape, but the backup itself is not what the marker's preHash
    // says it should be (truncated, half-written, or some other run's):
    // there is nothing safe to copy back, so this must still refuse.
    const target = path.join(cwd, "target.js");
    const backupPath = path.join(lockDir, "backup-target.js");
    fs.writeFileSync(backupPath, "not the pre-mutation content");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const markerPath = path.join(lockDir, "abc.marker.json");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        targetPath: target,
        backupPath,
        preHash: sha256(original),
        mutatedHash: DELETED_FILE_HASH,
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-probe-marker");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("auto-recovery is not possible");
    expect(check?.detail).not.toContain("auto-recover,");
    expect(check?.detail).toContain(markerPath);
    expect(check?.detail).toContain(backupPath);
  });

  it("not ok for an absent target under any other mutatedHash, and names the backup beside the marker so an operator never deletes the only pointer to it", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const original = "original content";
    // The target is gone, but nothing recorded says its absence is what
    // the mutant produced: probe refuses this one, and the backup is
    // the only remaining copy of the target's content.
    const target = path.join(cwd, "target.js");
    const backupPath = path.join(lockDir, "backup-target.js");
    fs.writeFileSync(backupPath, original);
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const markerPath = path.join(lockDir, "abc.marker.json");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        targetPath: target,
        backupPath,
        preHash: sha256(original),
        mutatedHash: sha256("mutated content"),
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-probe-marker");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("auto-recovery is not possible");
    expect(check?.detail).not.toContain("auto-recover,");
    expect(check?.detail).toContain(`${markerPath} (backup: ${backupPath})`);
  });

  it("not ok, and names the marker file instead of promising auto-recovery, when a stale marker's backup exists but does not hash to the pre-mutation content it records", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const original = "original content";
    const mutated = "mutated content";
    const target = path.join(cwd, "target.js");
    fs.writeFileSync(target, mutated);
    const backupPath = path.join(lockDir, "backup-target.js");
    // A backup that exists but is not this target's pre-mutation
    // content (truncated, half-written, or some other run's). probe
    // refuses to copy it over the target, so doctor must not point at a
    // recovery that will not happen.
    fs.writeFileSync(backupPath, "not the pre-mutation content");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const markerPath = path.join(lockDir, "abc.marker.json");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        targetPath: target,
        backupPath,
        preHash: sha256(original),
        mutatedHash: sha256(mutated),
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-probe-marker");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(markerPath);
    expect(check?.detail).toContain("auto-recovery is not possible");
    expect(check?.detail).not.toContain("auto-recover,");
  });

  it("not ok, and names the marker file instead of promising auto-recovery, when a stale marker's target is in neither the pre- nor the post-mutation state it records", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const target = path.join(cwd, "target.js");
    // Edited by hand since the crash: neither preHash nor mutatedHash.
    fs.writeFileSync(target, "something else entirely");
    const backupPath = path.join(lockDir, "backup-target.js");
    fs.writeFileSync(backupPath, "original content");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const markerPath = path.join(lockDir, "abc.marker.json");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        targetPath: target,
        backupPath,
        preHash: sha256("original content"),
        mutatedHash: sha256("mutated content"),
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-probe-marker");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(markerPath);
    expect(check?.detail).toContain("auto-recovery is not possible");
    expect(check?.detail).not.toContain("auto-recover,");
  });

  it("not ok when cwd reaches the marker's target through a symlinked ancestor: the same directory under two spellings is one repository", async () => {
    const lockDir = makeTmpDir();
    // Two spellings of one directory: `<parent>/real` and the symlink
    // `<parent>/link` pointing at it, the way macOS's `/tmp` and
    // `/private/tmp` name the same place. A marker records the target
    // resolved; doctor may well be invoked under the other spelling.
    const parent = makeTmpDir();
    const realDir = path.join(parent, "real");
    const linkDir = path.join(parent, "link");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir);
    const original = "original content";
    const mutated = "mutated content";
    const target = path.join(realDir, "target.js");
    fs.writeFileSync(target, mutated);
    const backupPath = path.join(lockDir, "backup-target.js");
    fs.writeFileSync(backupPath, original);
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    fs.writeFileSync(
      path.join(lockDir, "abc.marker.json"),
      JSON.stringify({
        // Recorded the way probe() records it: fully resolved.
        targetPath: fs.realpathSync(target),
        backupPath,
        preHash: sha256(original),
        mutatedHash: sha256(mutated),
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );

    const result = await doctor({
      required: [],
      optional: [],
      cwd: linkDir,
      lockDir,
    });
    const check = result.checks.find((c) => c.name === "stale-probe-marker");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(backupPath);
  });

  it("ok when a dead-pid marker's target is outside cwd (a different repository)", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const elsewhere = makeTmpDir();
    const target = path.join(elsewhere, "target.js");
    fs.writeFileSync(target, "x");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    fs.writeFileSync(
      path.join(lockDir, "abc.marker.json"),
      JSON.stringify({
        targetPath: target,
        backupPath: `${target}.backup`,
        preHash: "a".repeat(64),
        mutatedHash: "b".repeat(64),
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-probe-marker");
    expect(check?.ok).toBe(true);
  });
});

describe("doctor: stale-worktree check", () => {
  it("ok when there is no worktree marker for this repository", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("no stale worktree marker");
  });

  it("ok when a worktree marker exists but its pid is still alive", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const root = resolveDeepestExisting(containmentRoot(cwd));
    const worktreePath = path.join(makeTmpDir(), "wt");
    fs.writeFileSync(
      path.join(lockDir, `${lockKey(root)}.marker.json`),
      JSON.stringify({
        targetPath: worktreePath,
        backupPath: root,
        preHash: "",
        mutatedHash: "",
        pid: process.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(true);
  });

  it("not ok when a worktree marker's pid is dead: names the leftover worktree path and a manual recovery command", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const root = resolveDeepestExisting(containmentRoot(cwd));
    const worktreePath = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    fs.writeFileSync(
      path.join(lockDir, `${lockKey(root)}.marker.json`),
      JSON.stringify({
        targetPath: worktreePath,
        backupPath: root,
        preHash: "",
        mutatedHash: "",
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(worktreePath);
    expect(check?.detail).toContain(
      `worktree remove --force --force -- ${worktreePath}`,
    );
  });

  it("not ok when a worktree marker's pid is alive but recycled: a marker dated past the owner bound names the leftover and the manual command whatever its pid says", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const root = resolveDeepestExisting(containmentRoot(cwd));
    const worktreePath = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
    fs.writeFileSync(
      path.join(lockDir, `${lockKey(root)}.marker.json`),
      JSON.stringify({
        targetPath: worktreePath,
        backupPath: root,
        preHash: "",
        mutatedHash: "",
        pid: process.pid,
        timestamp: "2020-01-01T00:00:00.000Z",
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(worktreePath);
    expect(check?.detail).toContain(
      `worktree remove --force --force -- ${worktreePath}`,
    );
    expect(check?.detail).toContain("was interrupted");
  });

  it("not ok when a worktree marker has no timestamp field at all (an older marker shape): stale by definition, whatever its pid says, never read as fresh", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const root = resolveDeepestExisting(containmentRoot(cwd));
    const worktreePath = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
    fs.writeFileSync(
      path.join(lockDir, `${lockKey(root)}.marker.json`),
      // No `timestamp` field: an older marker shape predating it.
      // `isTimestampPastBound` treats this as stale by an explicit
      // `undefined` check, not merely because `Date.parse(undefined)`
      // happens to yield `NaN`.
      JSON.stringify({
        targetPath: worktreePath,
        backupPath: root,
        preHash: "",
        mutatedHash: "",
        pid: process.pid,
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(worktreePath);
    expect(check?.detail).toContain(
      `worktree remove --force --force -- ${worktreePath}`,
    );
    expect(check?.detail).toContain("was interrupted");
  });

  it("ok when a worktree marker's pid is alive and its own timestamp is fresh, even though the target it names is not registered", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const root = resolveDeepestExisting(containmentRoot(cwd));
    const worktreePath = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
    fs.writeFileSync(
      path.join(lockDir, `${lockKey(root)}.marker.json`),
      JSON.stringify({
        targetPath: worktreePath,
        backupPath: root,
        preHash: "",
        mutatedHash: "",
        pid: process.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(true);
    expect(check?.detail).not.toContain(worktreePath);
  });

  it("a dead marker naming a path that is not of the probe's scratch shape is reported as a marker to inspect and delete, never with a removal command for that path", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const root = resolveDeepestExisting(containmentRoot(cwd));
    const notScratch = path.join(makeTmpDir(), "somebody-elses-directory");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const markerPath = path.join(lockDir, `${lockKey(root)}.marker.json`);
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        targetPath: notScratch,
        backupPath: root,
        preHash: "",
        mutatedHash: "",
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(notScratch);
    expect(check?.detail).toContain("delete the marker file");
    expect(check?.detail).toContain(markerPath);
    expect(check?.detail).not.toContain(
      `worktree remove --force --force -- ${notScratch}`,
    );
  });

  it("does not confuse a same-key stale-probe-marker check for a different repository's worktree marker", async () => {
    const lockDir = makeTmpDir();
    const cwd = makeTmpDir();
    const elsewhereRoot = resolveDeepestExisting(containmentRoot(makeTmpDir()));
    const worktreePath = path.join(makeTmpDir(), "wt");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    fs.writeFileSync(
      path.join(lockDir, `${lockKey(elsewhereRoot)}.marker.json`),
      JSON.stringify({
        targetPath: worktreePath,
        backupPath: elsewhereRoot,
        preHash: "",
        mutatedHash: "",
        pid: dead.pid,
        timestamp: new Date().toISOString(),
      }),
    );
    const result = await doctor({ required: [], optional: [], cwd, lockDir });
    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(true);
  });

  describe("from git's own registry, marker or not", () => {
    function git(cwd: string, args: string[]): void {
      execFileSync("git", args, { cwd });
    }

    function initRepo(): string {
      const repo = makeTmpDir();
      git(repo, ["init", "-q"]);
      git(repo, ["config", "user.email", "test@example.com"]);
      git(repo, ["config", "user.name", "test"]);
      fs.writeFileSync(path.join(repo, "fixture.js"), "module.exports = {};\n");
      git(repo, ["add", "-A"]);
      git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
      return repo;
    }

    function writeWorktreeMarker(
      lockDir: string,
      root: string,
      targetPath: string,
      pid: number,
    ): void {
      fs.writeFileSync(
        path.join(lockDir, `${lockKey(root)}.marker.json`),
        JSON.stringify({
          targetPath,
          backupPath: root,
          preHash: "",
          mutatedHash: "",
          pid,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    it("not ok for a registered worktree of the scratch shape with no marker at all: names the path and the manual command", async () => {
      const lockDir = makeTmpDir();
      const repo = initRepo();
      const worktreePath = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      git(repo, ["worktree", "add", "--detach", "--", worktreePath, "HEAD"]);
      const resolved = resolveDeepestExisting(worktreePath);

      const result = await doctor({
        required: [],
        optional: [],
        cwd: repo,
        lockDir,
      });

      const check = result.checks.find((c) => c.name === "stale-worktree");
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain(resolved);
      expect(check?.detail).toContain(
        `worktree remove --force --force -- ${resolved}`,
      );
    });

    it("ok, with a hint, for a registered scratch worktree that a live probe's marker and owner record name", async () => {
      // A live probe writes its owner record before the add and its
      // marker at the same moment; the marker's pid alone vouches for
      // nothing (it may have been recycled), the owner record does.
      const lockDir = makeTmpDir();
      const repo = initRepo();
      const root = resolveDeepestExisting(containmentRoot(repo));
      const worktreePath = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      git(repo, ["worktree", "add", "--detach", "--", worktreePath, "HEAD"]);
      const alivePid = 1;
      fs.writeFileSync(
        path.join(path.dirname(worktreePath), SCRATCH_OWNER_FILE),
        JSON.stringify({
          pid: alivePid,
          timestamp: new Date().toISOString(),
          logDir: path.dirname(path.dirname(worktreePath)),
        }),
      );
      writeWorktreeMarker(lockDir, root, worktreePath, alivePid);

      const result = await doctor({
        required: [],
        optional: [],
        cwd: repo,
        lockDir,
      });

      const check = result.checks.find((c) => c.name === "stale-worktree");
      expect(check?.ok).toBe(true);
      expect(result.hints).toHaveLength(1);
      expect(result.hints[0]).toContain(String(alivePid));
    });

    it("ok for an operator's own registered worktree, whatever it is called", async () => {
      const lockDir = makeTmpDir();
      const repo = initRepo();
      const own = path.join(makeTmpDir(), "feature-branch");
      git(repo, ["worktree", "add", "--detach", "--", own, "HEAD"]);

      const result = await doctor({
        required: [],
        optional: [],
        cwd: repo,
        lockDir,
      });

      const check = result.checks.find((c) => c.name === "stale-worktree");
      expect(check?.ok).toBe(true);
      expect(check?.detail).not.toContain(own);
    });

    it("reports a dead marker's leftover once even though the registry lists it too", async () => {
      const lockDir = makeTmpDir();
      const repo = initRepo();
      const root = resolveDeepestExisting(containmentRoot(repo));
      const worktreePath = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      git(repo, ["worktree", "add", "--detach", "--", worktreePath, "HEAD"]);
      const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      writeWorktreeMarker(lockDir, root, worktreePath, dead.pid);

      const result = await doctor({
        required: [],
        optional: [],
        cwd: repo,
        lockDir,
      });

      const check = result.checks.find((c) => c.name === "stale-worktree");
      expect(check?.ok).toBe(false);
      expect(check?.detail?.split("was interrupted")).toHaveLength(2);
      expect(check?.detail).not.toContain("has no live probe behind it");
    });
  });
});

describe("doctor: git-version check", () => {
  /** A fake PATH directory whose only binary is a `git` printing
   * `versionLine` for `--version`. */
  function stubGitDir(versionLine: string): string {
    const dir = makeTmpDir();
    const stub = path.join(dir, "git");
    fs.writeFileSync(
      stub,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${versionLine}'; fi\n`,
    );
    fs.chmodSync(stub, 0o755);
    return dir;
  }

  /** doctor with no tools requested and a cwd outside any git work tree,
   * so the only git it touches is the one on `pathEnv`. */
  function run(pathEnv: string) {
    return doctor({
      required: [],
      optional: [],
      cwd: makeTmpDir(),
      pathEnv,
      lockDir: makeTmpDir(),
    });
  }

  it("parseGitVersion reads the numeric version and ignores a vendor suffix", () => {
    expect(parseGitVersion("git version 2.36.1")).toEqual({
      major: 2,
      minor: 36,
      patch: 1,
    });
    expect(parseGitVersion("git version 2.50.1 (Apple Git-155)")).toEqual({
      major: 2,
      minor: 50,
      patch: 1,
    });
    expect(parseGitVersion("git version 2.7")).toEqual({
      major: 2,
      minor: 7,
      patch: 0,
    });
    expect(parseGitVersion("something else")).toBeUndefined();
  });

  it("not ok, with a warning, for a git older than 2.35: names the sync it cannot run and the listing fallback", async () => {
    const result = await run(stubGitDir("git version 2.30.2"));
    const check = result.checks.find((c) => c.name === "git-version");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("git 2.30.2");
    expect(check?.detail).toContain("older than 2.35");
    expect(check?.detail).toContain("worktree_sync_failed");
    expect(check?.detail).toContain("newline-separated");
    expect(result.warnings.some((w) => w.includes("older than 2.35"))).toBe(
      true,
    );
  });

  it("not ok, with a warning naming the newline-separated listing fallback, for a git at 2.35 but older than 2.36", async () => {
    const result = await run(stubGitDir("git version 2.35.8"));
    const check = result.checks.find((c) => c.name === "git-version");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("git 2.35.8");
    expect(check?.detail).toContain("older than 2.36");
    expect(check?.detail).toContain("newline-separated");
    expect(check?.detail).not.toContain("worktree_sync_failed");
    expect(result.warnings.some((w) => w.includes("older than 2.36"))).toBe(
      true,
    );
  });

  it("ok, with no git warning, for a git at or above 2.36", async () => {
    for (const line of [
      "git version 2.36.0",
      "git version 2.50.1 (Apple Git-155)",
    ]) {
      const result = await run(stubGitDir(line));
      const check = result.checks.find((c) => c.name === "git-version");
      expect(check?.ok, line).toBe(true);
      expect(check?.detail, line).toContain("meets the 2.36 minimum");
      expect(
        result.warnings.filter((w) => w.includes("older than")),
        line,
      ).toEqual([]);
    }
  });

  it("not ok when the version line cannot be read, and when git is not on PATH at all", async () => {
    const unreadable = await run(stubGitDir("not a version"));
    const unreadableCheck = unreadable.checks.find(
      (c) => c.name === "git-version",
    );
    expect(unreadableCheck?.ok).toBe(false);
    expect(unreadableCheck?.detail).toContain("could not determine");
    expect(unreadableCheck?.detail).toContain("not a version");

    const absent = await run(makeTmpDir());
    const absentCheck = absent.checks.find((c) => c.name === "git-version");
    expect(absentCheck?.ok).toBe(false);
    expect(absentCheck?.detail).toContain("git not found on PATH");
  });

  it("takes the version from the tool loop when git is among the checked tools", async () => {
    const result = await doctor({
      required: ["git"],
      optional: [],
      cwd: makeTmpDir(),
      pathEnv: stubGitDir("git version 2.30.2"),
      lockDir: makeTmpDir(),
    });
    expect(result.tools.find((t) => t.name === "git")?.version).toBe(
      "git version 2.30.2",
    );
    const check = result.checks.find((c) => c.name === "git-version");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("git 2.30.2");
  });
});

describe("doctor: stale-worktree check on a git that rejects -z, and on one whose listing cannot run", () => {
  function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd });
  }

  function initRepo(): string {
    const repo = makeTmpDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repo, "fixture.js"), "module.exports = {};\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    return repo;
  }

  function addScratchWorktree(repo: string): string {
    const worktreePath = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, ["worktree", "add", "--detach", "--", worktreePath, "HEAD"]);
    return resolveDeepestExisting(worktreePath);
  }

  it("still reports a registered scratch worktree with no marker, through the newline-separated fallback", async () => {
    const lockDir = makeTmpDir();
    const repo = initRepo();
    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "reject-z");
    const resolved = addScratchWorktree(repo);

    const result = await doctor({
      required: [],
      optional: [],
      cwd: repo,
      pathEnv: shimDir,
      lockDir,
    });

    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(resolved);
    expect(check?.detail).toContain(
      `worktree remove --force --force -- ${resolved}`,
    );
    expect(result.warnings.filter((w) => w.includes("could not run"))).toEqual(
      [],
    );
    // The shim is the git doctor ran, not the host's.
    expect(
      result.checks.find((c) => c.name === "git-version")?.detail,
    ).toContain(path.join(shimDir, "git"));
  });

  it("still reports a registered scratch worktree through the fallback when git rejects -z with the usage-error status alone, nothing on stderr", async () => {
    const lockDir = makeTmpDir();
    const repo = initRepo();
    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "reject-z-silent");
    const resolved = addScratchWorktree(repo);

    const result = await doctor({
      required: [],
      optional: [],
      cwd: repo,
      pathEnv: shimDir,
      lockDir,
    });

    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(
      `worktree remove --force --force -- ${resolved}`,
    );
    expect(result.warnings.filter((w) => w.includes("could not run"))).toEqual(
      [],
    );
  });

  it("warns that the registry could not be read, and does not answer from the fallback, when the -z listing dies with a fatal message that names no option", async () => {
    const lockDir = makeTmpDir();
    const repo = initRepo();
    const root = resolveDeepestExisting(containmentRoot(repo));
    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "fail-z");
    addScratchWorktree(repo);

    const result = await doctor({
      required: [],
      optional: [],
      cwd: repo,
      pathEnv: shimDir,
      lockDir,
    });

    expect(
      result.warnings.some(
        (w) =>
          w.includes(`git worktree list could not run for ${root}`) &&
          w.includes("git worktree list --porcelain -z exited 128") &&
          // Anchors the AC6 limitation clause: this synchronous
          // listing has no gitdir-files fallback the way `probe`'s own
          // async listing does, so deleting that clause fails this.
          w.includes("gitdir-files"),
      ),
    ).toBe(true);
    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(true);
  });

  it("warns that the registry could not be read, instead of a silently clean check, when no listing form runs", async () => {
    const lockDir = makeTmpDir();
    const repo = initRepo();
    const root = resolveDeepestExisting(containmentRoot(repo));
    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "no-worktree-list");
    addScratchWorktree(repo);

    const result = await doctor({
      required: [],
      optional: [],
      cwd: repo,
      pathEnv: shimDir,
      lockDir,
    });

    expect(
      result.warnings.some(
        (w) =>
          w.includes(`git worktree list could not run for ${root}`) &&
          w.includes("exited 128") &&
          // Anchors the AC6 limitation clause; see the same assertion
          // in the -z-dies test above.
          w.includes("gitdir-files"),
      ),
    ).toBe(true);
    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(true);
  });
});

describe("doctor: stale-worktree check and the scratch owner record", () => {
  function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd });
  }

  function initRepo(): string {
    const repo = makeTmpDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repo, "fixture.js"), "module.exports = {};\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    return repo;
  }

  function addScratchWorktree(repo: string): string {
    const worktreePath = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, ["worktree", "add", "--detach", "--", worktreePath, "HEAD"]);
    return resolveDeepestExisting(worktreePath);
  }

  function writeOwner(
    worktreePath: string,
    pid: number | undefined,
    timestamp: string = new Date().toISOString(),
  ): void {
    fs.writeFileSync(
      path.join(path.dirname(worktreePath), SCRATCH_OWNER_FILE),
      JSON.stringify({
        pid,
        timestamp,
        logDir: path.dirname(path.dirname(worktreePath)),
      }),
    );
  }

  const FAR_PAST = "2020-01-01T00:00:00.000Z";

  /** A pid that is alive from any user's point of view: pid 1 always
   * exists, and the liveness check reads the EPERM a non-root user gets
   * from signalling it as alive. */
  const ALIVE_PID = 1;

  it("ok, naming the live probe, for a registered scratch worktree whose owner record names a live process; not ok once that process is gone", async () => {
    const lockDir = makeTmpDir();
    const repo = initRepo();
    const resolved = addScratchWorktree(repo);
    const sleeper = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      { stdio: "ignore" },
    );
    const exited = new Promise<void>((resolve) => {
      sleeper.once("exit", () => resolve());
    });
    try {
      writeOwner(resolved, sleeper.pid);

      const live = await doctor({
        required: [],
        optional: [],
        cwd: repo,
        lockDir,
      });

      const check = live.checks.find((c) => c.name === "stale-worktree");
      expect(check?.ok).toBe(true);
      expect(check?.detail).not.toContain(resolved);
      expect(check?.detail).not.toContain("worktree remove");
      // The live worktree is a hint, naming what holds it and for how
      // long, never part of the check's own detail.
      expect(live.hints).toHaveLength(1);
      expect(live.hints[0]).toContain(
        `a live probe (pid ${String(sleeper.pid)}) owns the scratch worktree at ${resolved};`,
      );
      expect(live.hints[0]).toContain(scratchOwnerPath(resolved));
      expect(live.hints[0]).toContain(
        `${String(SCRATCH_OWNER_MAX_AGE_HOURS)} hours`,
      );
    } finally {
      sleeper.kill("SIGKILL");
    }
    await exited;

    const dead = await doctor({
      required: [],
      optional: [],
      cwd: repo,
      lockDir,
    });

    const check = dead.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(
      `worktree remove --force --force -- ${resolved}`,
    );
    expect(dead.hints).toEqual([]);
  });

  it("not ok, with the manual command and no hint, for a registered scratch worktree whose owner record names an alive pid under a timestamp past the bound", async () => {
    const lockDir = makeTmpDir();
    const repo = initRepo();
    const resolved = addScratchWorktree(repo);
    writeOwner(resolved, ALIVE_PID, FAR_PAST);

    const result = await doctor({
      required: [],
      optional: [],
      cwd: repo,
      lockDir,
    });

    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("has no live probe behind it");
    expect(check?.detail).toContain(
      `worktree remove --force --force -- ${resolved}`,
    );
    expect(result.hints).toEqual([]);
  });

  it("ok, with a hint naming the pid, the path, the record, and the bound, for the same worktree under a fresh record naming the same alive pid", async () => {
    const lockDir = makeTmpDir();
    const repo = initRepo();
    const resolved = addScratchWorktree(repo);
    writeOwner(resolved, ALIVE_PID);

    const result = await doctor({
      required: [],
      optional: [],
      cwd: repo,
      lockDir,
    });

    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(true);
    expect(check?.detail).not.toContain(resolved);
    expect(result.hints).toHaveLength(1);
    expect(result.hints[0]).toContain(
      `a live probe (pid ${String(ALIVE_PID)}) owns the scratch worktree at ${resolved};`,
    );
    expect(result.hints[0]).toContain(scratchOwnerPath(resolved));
    expect(result.hints[0]).toContain(
      `${String(SCRATCH_OWNER_MAX_AGE_HOURS)} hours`,
    );
    expect(result.hints[0]).not.toContain(
      "named by this repository's worktree marker",
    );
  });

  it("not ok, with the manual command, for a registered scratch worktree named by a marker whose pid is alive but whose owner record is past the bound: an alive marker pid vouches for nothing", async () => {
    // A marker whose pid was recycled by an unrelated process must not
    // hide a registered leftover: the path is judged by its own owner
    // record like any other registered scratch worktree.
    const lockDir = makeTmpDir();
    const repo = initRepo();
    const root = resolveDeepestExisting(containmentRoot(repo));
    const resolved = addScratchWorktree(repo);
    fs.writeFileSync(
      path.join(lockDir, `${lockKey(root)}.marker.json`),
      JSON.stringify({
        targetPath: resolved,
        backupPath: root,
        preHash: "",
        mutatedHash: "",
        pid: ALIVE_PID,
        timestamp: new Date().toISOString(),
      }),
    );
    writeOwner(resolved, ALIVE_PID, FAR_PAST);

    const result = await doctor({
      required: [],
      optional: [],
      cwd: repo,
      lockDir,
    });

    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("has no live probe behind it");
    expect(check?.detail).toContain(
      `worktree remove --force --force -- ${resolved}`,
    );
    expect(result.hints).toEqual([]);
  });

  it("not ok, as the interrupted probe's leftover with the manual command, for a dead marker naming a scratch worktree whose owner record is past the bound", async () => {
    const lockDir = makeTmpDir();
    const repo = initRepo();
    const root = resolveDeepestExisting(containmentRoot(repo));
    const resolved = addScratchWorktree(repo);
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    fs.writeFileSync(
      path.join(lockDir, `${lockKey(root)}.marker.json`),
      JSON.stringify({
        targetPath: resolved,
        backupPath: root,
        preHash: "",
        mutatedHash: "",
        pid: deadPid,
        timestamp: new Date().toISOString(),
      }),
    );
    writeOwner(resolved, ALIVE_PID, FAR_PAST);

    const result = await doctor({
      required: [],
      optional: [],
      cwd: repo,
      lockDir,
    });

    const check = result.checks.find((c) => c.name === "stale-worktree");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("was interrupted");
    expect(check?.detail).toContain(
      `worktree remove --force --force -- ${resolved}`,
    );
    expect(result.hints).toEqual([]);
  });

  it("ok, naming the live probe, for a dead marker whose worktree's owner record names a live process", async () => {
    const lockDir = makeTmpDir();
    const repo = initRepo();
    const root = resolveDeepestExisting(containmentRoot(repo));
    const resolved = addScratchWorktree(repo);
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    fs.writeFileSync(
      path.join(lockDir, `${lockKey(root)}.marker.json`),
      JSON.stringify({
        targetPath: resolved,
        backupPath: root,
        preHash: "",
        mutatedHash: "",
        pid: deadPid,
        timestamp: new Date().toISOString(),
      }),
    );
    const sleeper = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      { stdio: "ignore" },
    );
    const exited = new Promise<void>((resolve) => {
      sleeper.once("exit", () => resolve());
    });
    try {
      writeOwner(resolved, sleeper.pid);

      const result = await doctor({
        required: [],
        optional: [],
        cwd: repo,
        lockDir,
      });

      const check = result.checks.find((c) => c.name === "stale-worktree");
      expect(check?.ok).toBe(true);
      expect(check?.detail).not.toContain(resolved);
      expect(result.hints).toHaveLength(1);
      expect(result.hints[0]).toContain(
        `a live probe (pid ${String(sleeper.pid)}) owns the scratch worktree at ${resolved}, named by this repository's worktree marker;`,
      );
    } finally {
      sleeper.kill("SIGKILL");
    }
    await exited;
  });
});

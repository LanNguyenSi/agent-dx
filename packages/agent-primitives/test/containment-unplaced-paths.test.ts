import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { doctor } from "../src/doctor/index.js";
import { InitFsUsageError, init } from "../src/init/index.js";
import {
  lockKey,
  markerFilePathFor,
  readMarkerFor,
  writeMarker,
} from "../src/lock.js";
import {
  resolveDeepestExisting,
  resolveDeepestExistingLenient,
  UnresolvablePathError,
} from "../src/probe/containment.js";
import {
  beginInplace,
  cleanupWorktree,
  listRegisteredWorktrees,
} from "../src/probe/isolation.js";
import { probe, probePlan, type ProbeOptions } from "../src/probe/index.js";
import { withPathPrepended, writeGitShim } from "./helpers/git-shim.js";
import { expectNoIsolationLeftovers } from "./helpers/no-leftovers.js";

/**
 * What the callers of `resolveDeepestExisting` do with a path this
 * process cannot place physically (`realpath` fails with something other
 * than `ENOENT` or `ENOTDIR`):
 *
 * - the callers that decide what a run may read, write or delete refuse
 *   it (probe, probe --plan, init, the worktree cleanup gate);
 * - the callers that only report on or list a path (doctor, the
 *   registered-worktree listings, the leftover dedupe) never throw on it.
 *
 * The cross-platform rows put the path below a directory whose mode is
 * 000 (`EACCES` on Linux and macOS); the macOS-only rows use a symlink
 * whose own mode is 000 (`lchmod`). All of them are skipped under uid 0,
 * which opens every directory whatever its mode.
 */

vi.setConfig({ testTimeout: 60_000 });

const notRoot = process.getuid?.() !== 0;
const canLchmod = process.platform === "darwin" && notRoot;

const tmpDirs: string[] = [];
/** Directories whose mode this file set to 000, restored before cleanup
 * (a mode-000 directory cannot be emptied, so it could not be removed). */
const closedDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-unplaced-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

function close(dir: string): void {
  closedDirs.push(dir);
  fs.chmodSync(dir, 0o000);
}

function reopenAll(): void {
  for (const dir of closedDirs.splice(0).reverse()) {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      // Already gone.
    }
  }
}

let savedLockDir: string | undefined;
afterEach(() => {
  reopenAll();
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const FIXTURE_JS = [
  "function isPositive(n) {",
  "  return n > 0;",
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

function initRepo(): string {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["config", "maintenance.auto", "false"]);
  git(repo, ["config", "gc.auto", "0"]);
  fs.writeFileSync(path.join(repo, "fixture.js"), FIXTURE_JS);
  fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return repo;
}

function probeOptions(
  repo: string,
  overrides: Partial<ProbeOptions> = {},
): ProbeOptions {
  return {
    file: "fixture.js",
    line: 2,
    form: "replace",
    replaceText: "  return false;",
    testCommand: "node fixture.test.js",
    isolation: "worktree",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

function worktreeCount(repo: string): number {
  return git(repo, ["worktree", "list", "--porcelain"])
    .split("\n\n")
    .filter((b) => b.trim().length > 0).length;
}

/** A dead pid, for a marker no live probe owns. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
  if (!pid) throw new Error("failed to obtain a dead pid for the test");
  return pid;
}

function plantWorktreeMarker(
  repo: string,
  targetPath: string,
  scratchRoot: string,
): string {
  const realRoot = resolveDeepestExisting(repo);
  writeMarker(realRoot, {
    targetPath,
    backupPath: realRoot,
    preHash: "",
    mutatedHash: "",
    pid: deadPid(),
    timestamp: new Date().toISOString(),
    scratchRoot,
  });
  return realRoot;
}

describe.skipIf(!notRoot)(
  "a file below a mode-000 directory: probe and probe --plan refuse it, init refuses its target",
  () => {
    type Mode = "inplace" | "worktree";
    const MODES: Mode[] = ["inplace", "worktree"];

    /** A repository holding `closed/two.js` (two lines carry the `-M`
     * text, so a derivation that read it would answer `match_ambiguous`
     * and name them), the directory then closed. */
    function withClosedDir(): { repo: string; file: string } {
      const repo = initRepo();
      const dir = path.join(repo, "closed");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "two.js"), "n > 0 a\nn > 0 b\n");
      close(dir);
      return { repo, file: "closed/two.js" };
    }

    for (const mode of MODES) {
      for (const line of [undefined, 1]) {
        it(`probe(), ${mode} isolation, ${line === undefined ? "-M without -n" : "-n 1"}: file_outside_root naming the path and EACCES, nothing read, nothing left behind`, async () => {
          const lockDir = useLockDir();
          const { repo, file } = withClosedDir();
          const result = await probe(
            probeOptions(repo, {
              file,
              form: "match",
              matchText: "n > 0",
              withText: "true",
              isolation: mode,
              ...(line === undefined ? { line: undefined } : { line }),
            }),
          );
          expect(result.status).toBe("inconclusive");
          expect(result.reason).toBe("file_outside_root");
          const text = result.warnings.join("\n");
          expect(text).toContain("two.js");
          expect(text).toContain("EACCES");
          expect(text).not.toContain("occurs on");
          reopenAll();
          expectNoIsolationLeftovers(repo, lockDir);
        });
      }

      it(`probePlan(), ${mode} isolation: usage_error file_outside_root, nothing left behind`, async () => {
        const lockDir = useLockDir();
        const { repo, file } = withClosedDir();
        const result = await probePlan({
          mutants: [{ file, line: 1, form: "replace", replaceText: "x" }],
          testCommand: "node fixture.test.js",
          isolation: mode,
          expect: "fail",
          cwd: repo,
          logDir: makeTmpDir(),
        });
        expect(result.status).toBe("usage_error");
        expect(result.reason).toBe("file_outside_root");
        expect(result.warnings.join("\n")).toContain("EACCES");
        reopenAll();
        expectNoIsolationLeftovers(repo, lockDir);
      });
    }

    it("the refusal text names the path and the code, and explains a symlink only for EACCES: an over-long name (ENAMETOOLONG) gets the bare refusal", async () => {
      useLockDir();
      const repo = initRepo();
      const tooLong = `${"a".repeat(300)}.js`;
      const result = await probe(
        probeOptions(repo, { file: tooLong, isolation: "inplace" }),
      );
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("file_outside_root");
      const text = result.warnings.join("\n");
      expect(text).toContain("ENAMETOOLONG");
      expect(text).toContain(tooLong);
      expect(text).not.toContain("symlink");

      const { repo: repo2, file } = withClosedDir();
      const closed = await probe(
        probeOptions(repo2, { file, isolation: "inplace" }),
      );
      expect(closed.warnings.join("\n")).toContain("EACCES");
      expect(closed.warnings.join("\n")).toContain("symlink");
    });

    // `init` lstats its target before it resolves it, and an lstat below a
    // directory that cannot be traversed fails first (EACCES), so the
    // resolve-and-refuse branch (`target_escapes_directory`) is only
    // reachable through a symlink with its own mode 000, in the macOS
    // block of `containment.test.ts`. What holds everywhere is that the
    // run answers with an `init` refusal, never a raw error, and writes
    // nothing.
    it("init answers a target below it with its own refusal and writes nothing", () => {
      const targetDir = makeTmpDir();
      const closed = path.join(targetDir, ".claude");
      fs.mkdirSync(closed);
      close(closed);
      let thrown: unknown;
      try {
        init({ targetDir, content: "x\n" });
      } catch (err) {
        thrown = err;
      }
      reopenAll();
      expect(thrown).toBeInstanceOf(InitFsUsageError);
      expect((thrown as InitFsUsageError).reason).toBe("target_not_writable");
      expect(fs.readdirSync(closed)).toEqual([]);
    });

    it("init with a --target-dir that is itself below one answers with its own refusal, never a raw error from resolving the directory", () => {
      const parent = makeTmpDir();
      const sub = path.join(parent, "sub");
      fs.mkdirSync(sub);
      close(parent);
      let thrown: unknown;
      try {
        init({ targetDir: sub, content: "x\n" });
      } catch (err) {
        thrown = err;
      }
      reopenAll();
      expect(thrown).toBeInstanceOf(InitFsUsageError);
      expect(fs.readdirSync(sub)).toEqual([]);
      expect((thrown as InitFsUsageError).reason).toBe("target_not_writable");
    });
  },
);

describe.skipIf(!notRoot)(
  "the lenient sites never throw on a registered or leftover path they cannot place",
  () => {
    /** A scratch-shaped worktree `<logDir>/wt-<uuid>/wt` registered with
     * git, its holder directory then closed: git still lists it, this
     * process cannot place it. */
    function registerUnplaceable(repo: string): {
      logDir: string;
      holder: string;
      worktree: string;
    } {
      const logDir = makeTmpDir();
      const holder = path.join(logDir, `wt-${randomUUID()}`);
      const worktree = path.join(holder, "wt");
      fs.mkdirSync(holder);
      git(repo, ["worktree", "add", "--detach", "--", worktree, "HEAD"]);
      close(holder);
      return { logDir, holder, worktree };
    }

    it("the registered-worktree listing through git keeps the path under its own spelling", async () => {
      const repo = initRepo();
      const { logDir, worktree } = registerUnplaceable(repo);
      const listing = await listRegisteredWorktrees(repo, logDir);
      expect(listing.ok).toBe(true);
      expect(listing.form).not.toBe("gitdir-files");
      expect(listing.paths).toContain(
        path.join(
          resolveDeepestExisting(path.dirname(path.dirname(worktree))),
          path.basename(path.dirname(worktree)),
          "wt",
        ),
      );
    });

    it("the gitdir-files listing (git worktree list unusable) keeps it too, as a target gone from disk", async () => {
      const repo = initRepo();
      const { logDir, worktree } = registerUnplaceable(repo);
      const shimDir = makeTmpDir();
      writeGitShim(shimDir, "no-worktree-list");
      const listing = await withPathPrepended(shimDir, () =>
        listRegisteredWorktrees(repo, logDir),
      );
      expect(listing.ok).toBe(true);
      expect(listing.form).toBe("gitdir-files");
      const expected = path.join(
        resolveDeepestExisting(path.dirname(path.dirname(worktree))),
        path.basename(path.dirname(worktree)),
        "wt",
      );
      expect([...listing.paths, ...(listing.goneTargets ?? [])]).toContain(
        expected,
      );
    });

    it("the half-written-entry repair passes over another entry it cannot place and still removes the run's own", async () => {
      const repo = initRepo();
      const other = registerUnplaceable(repo);
      // git created the other worktree's `commondir` before it wrote the
      // content: empty, and `locked`, the shape the repair looks at.
      const adminDir = path.join(repo, ".git", "worktrees");
      const [entry] = fs.readdirSync(adminDir);
      fs.writeFileSync(path.join(adminDir, entry, "commondir"), "");
      fs.writeFileSync(path.join(adminDir, entry, "locked"), "initializing");
      const logDir = makeTmpDir();
      const ours = path.join(logDir, `wt-${randomUUID()}`, "wt");
      fs.mkdirSync(ours, { recursive: true });

      const cleanup = await cleanupWorktree(repo, ours, logDir, {
        scratchRoot: logDir,
      });

      expect(cleanup.refused).toBe(false);
      expect(cleanup.ok).toBe(true);
      expect(fs.existsSync(ours)).toBe(false);
      // The other entry names a path that is not ours: left alone.
      expect(fs.existsSync(path.join(adminDir, entry, "gitdir"))).toBe(true);
      expect(other.logDir).not.toBe(logDir);
    });

    it("a probe whose leftover marker and registered worktree are the same unplaceable path dedupes them and answers stale_worktree, not a thrown error", async () => {
      const lockDir = useLockDir();
      void lockDir;
      const repo = initRepo();
      const { holder, worktree } = registerUnplaceable(repo);
      const logDir = path.dirname(holder);
      const realRoot = plantWorktreeMarker(repo, worktree, logDir);

      const result = await probe(probeOptions(repo));

      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("stale_worktree");
      const text = result.warnings.join("\n");
      expect(text).toContain(markerFilePathFor(realRoot));
      expect(text).toContain("cannot be placed physically");
      expect(readMarkerFor(realRoot)).toBeDefined();
      reopenAll();
      expect(fs.existsSync(path.join(worktree, ".git"))).toBe(true);
      expect(worktreeCount(repo)).toBe(2);
    });

    it("doctor does not throw on a registered scratch worktree it cannot place", async () => {
      const repo = initRepo();
      registerUnplaceable(repo);
      const lockDir = makeTmpDir();
      const result = await doctor({
        required: [],
        optional: [],
        cwd: repo,
        lockDir,
      });
      expect(result.checks.length).toBeGreaterThan(0);
    });

    it("doctor does not throw on a stale marker whose target sits below a directory it cannot traverse", async () => {
      const lockDir = makeTmpDir();
      const cwd = makeTmpDir();
      const root = resolveDeepestExisting(cwd);
      const closed = path.join(cwd, "closed");
      fs.mkdirSync(closed);
      close(closed);
      fs.writeFileSync(
        path.join(lockDir, `${lockKey(root)}.marker.json`),
        JSON.stringify({
          targetPath: path.join(closed, "f.js"),
          backupPath: path.join(root, "f.js.bak"),
          preHash: "",
          mutatedHash: "",
          pid: 2 ** 30,
          timestamp: new Date().toISOString(),
        }),
      );
      const result = await doctor({
        required: [],
        optional: [],
        cwd,
        lockDir,
      });
      expect(result.checks.length).toBeGreaterThan(0);
    });

    it("beginInplace does not throw when the bound root is a path it cannot place: the ancestor-mode capture records the parent and stops", () => {
      const dir = makeTmpDir();
      const target = path.join(dir, "f.js");
      fs.writeFileSync(target, "x\n");
      const closedParent = makeTmpDir();
      fs.mkdirSync(path.join(closedParent, "root"));
      close(closedParent);
      const session = beginInplace(
        target,
        makeTmpDir(),
        path.join(closedParent, "root"),
      );
      expect(session.restore()).toBe(true);
    });

    it("doctor does not throw when the cwd sits below an ancestor it cannot traverse", async () => {
      const parent = makeTmpDir();
      const cwd = path.join(parent, "work");
      fs.mkdirSync(cwd);
      close(parent);
      const lockDir = makeTmpDir();
      const result = await doctor({
        required: [],
        optional: [],
        cwd,
        lockDir,
      });
      expect(result.checks.length).toBeGreaterThan(0);
    });
  },
);

describe.skipIf(!notRoot)(
  "the worktree cleanup gate refuses a marker target it cannot place and deletes nothing",
  () => {
    /** `<logDir>/wt-<uuid>` closed, holding a `wt` that is the very
     * name a recovery would delete. */
    function closedScratch(): {
      logDir: string;
      holder: string;
      target: string;
    } {
      const logDir = makeTmpDir();
      const holder = path.join(logDir, `wt-${randomUUID()}`);
      const target = path.join(holder, "wt");
      fs.mkdirSync(path.join(target, "precious"), { recursive: true });
      fs.writeFileSync(path.join(target, "precious", "data.txt"), "keep me\n");
      close(holder);
      return { logDir, holder, target };
    }

    it("cleanupWorktree: a target below a directory it cannot traverse is refused, not read as inside the scratch root", async () => {
      const repo = initRepo();
      const { logDir, holder, target } = closedScratch();
      const cleanup = await cleanupWorktree(repo, target, logDir, {
        scratchRoot: logDir,
      });
      expect(cleanup.ok).toBe(false);
      expect(cleanup.refused).toBe(true);
      expect(cleanup.detail).toContain(`refusing to remove ${target}`);
      expect(cleanup.detail).toContain("EACCES");
      reopenAll();
      expect(
        fs.readFileSync(
          path.join(holder, "wt", "precious", "data.txt"),
          "utf8",
        ),
      ).toBe("keep me\n");
    });

    it("cleanupWorktree: a repository root it cannot place refuses a healthy scratch target instead of deleting it", async () => {
      const closedParent = makeTmpDir();
      fs.mkdirSync(path.join(closedParent, "repo"));
      close(closedParent);
      const logDir = makeTmpDir();
      const target = path.join(logDir, `wt-${randomUUID()}`, "wt");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "data.txt"), "keep me\n");

      const cleanup = await cleanupWorktree(
        path.join(closedParent, "repo"),
        target,
        logDir,
        { scratchRoot: logDir },
      );

      expect(cleanup.refused).toBe(true);
      expect(cleanup.detail).toContain("EACCES");
      expect(fs.readFileSync(path.join(target, "data.txt"), "utf8")).toBe(
        "keep me\n",
      );
    });

    it("cleanupWorktree: a scratch root it cannot place refuses a target git registers instead of removing it", async () => {
      const repo = initRepo();
      const logDir = makeTmpDir();
      const target = path.join(logDir, `wt-${randomUUID()}`, "wt");
      fs.mkdirSync(path.dirname(target));
      git(repo, ["worktree", "add", "--detach", "--", target, "HEAD"]);
      const closedParent = makeTmpDir();
      fs.mkdirSync(path.join(closedParent, "logs"));
      close(closedParent);

      const cleanup = await cleanupWorktree(repo, target, logDir, {
        scratchRoot: path.join(closedParent, "logs"),
      });

      expect(cleanup.refused).toBe(true);
      expect(cleanup.detail).toContain("EACCES");
      expect(fs.existsSync(path.join(target, ".git"))).toBe(true);
      expect(worktreeCount(repo)).toBe(2);
    });

    it("probe: a marker naming it answers stale_worktree, keeps the marker and deletes nothing", async () => {
      useLockDir();
      const repo = initRepo();
      const { logDir, holder, target } = closedScratch();
      const realRoot = plantWorktreeMarker(repo, target, logDir);

      const result = await probe(probeOptions(repo));

      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("stale_worktree");
      expect(readMarkerFor(realRoot)).toBeDefined();
      expect(worktreeCount(repo)).toBe(1);
      reopenAll();
      expect(
        fs.readFileSync(
          path.join(holder, "wt", "precious", "data.txt"),
          "utf8",
        ),
      ).toBe("keep me\n");
    });
  },
);

describe.skipIf(!canLchmod)(
  "the worktree cleanup gate and a scratch directory that is a symlink with its own mode 000 (macOS)",
  () => {
    function linkedScratch(): {
      logDir: string;
      victimParent: string;
      target: string;
    } {
      const logDir = makeTmpDir();
      const victimParent = makeTmpDir();
      fs.mkdirSync(path.join(victimParent, "wt", "precious"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(victimParent, "wt", "precious", "data.txt"),
        "keep me\n",
      );
      const holder = path.join(logDir, `wt-${randomUUID()}`);
      fs.symlinkSync(victimParent, holder);
      fs.lchmodSync(holder, 0o000);
      return { logDir, victimParent, target: path.join(holder, "wt") };
    }

    it("probe: a marker naming <log-dir>/wt-<uuid>/wt behind it answers stale_worktree and the directory it points at survives", async () => {
      useLockDir();
      const repo = initRepo();
      const { logDir, victimParent, target } = linkedScratch();
      const realRoot = plantWorktreeMarker(repo, target, logDir);

      const result = await probe(probeOptions(repo));

      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("stale_worktree");
      expect(readMarkerFor(realRoot)).toBeDefined();
      expect(
        fs.readFileSync(
          path.join(victimParent, "wt", "precious", "data.txt"),
          "utf8",
        ),
      ).toBe("keep me\n");
    });

    it("beginInplace does not throw on a target whose ancestor is a mode-000 symlink: the capture stops at the level it cannot place", () => {
      const real = makeTmpDir();
      fs.mkdirSync(path.join(real, "sub"));
      fs.writeFileSync(path.join(real, "sub", "f.js"), "x\n");
      const root = makeTmpDir();
      const link = path.join(root, "link");
      fs.symlinkSync(real, link);
      fs.lchmodSync(link, 0o000);
      const session = beginInplace(
        path.join(link, "sub", "f.js"),
        makeTmpDir(),
        root,
      );
      expect(session.restore()).toBe(true);
    });

    it("cleanupWorktree: a symlink named wt in the directory it points at is not unlinked as the probe's own scratch link", async () => {
      const repo = initRepo();
      const { logDir, victimParent, target } = linkedScratch();
      fs.rmSync(path.join(victimParent, "wt"), { recursive: true });
      const elsewhere = makeTmpDir();
      fs.symlinkSync(elsewhere, path.join(victimParent, "wt"));

      const cleanup = await cleanupWorktree(repo, target, logDir, {
        scratchRoot: logDir,
      });

      expect(cleanup.refused).toBe(true);
      expect(fs.lstatSync(path.join(victimParent, "wt")).isSymbolicLink()).toBe(
        true,
      );
    });

    it("cleanupWorktree: refused with the path and the code, the directory it points at survives", async () => {
      const repo = initRepo();
      const { logDir, victimParent, target } = linkedScratch();
      const cleanup = await cleanupWorktree(repo, target, logDir, {
        scratchRoot: logDir,
      });
      expect(cleanup.refused).toBe(true);
      expect(cleanup.detail).toContain("EACCES");
      expect(
        fs.readFileSync(
          path.join(victimParent, "wt", "precious", "data.txt"),
          "utf8",
        ),
      ).toBe("keep me\n");
    });
  },
);

/**
 * A link the kernel follows although the walk finds nothing behind it,
 * or follows to another file than the one the walk placed: the strict
 * resolver asks the kernel and refuses on the disagreement, so every
 * caller that acts on the path refuses it, and the lenient resolver
 * answers what it always did.
 */
describe("a link the kernel follows where the walk finds nothing, or another file", () => {
  type Mode = "inplace" | "worktree";
  const MODES: Mode[] = ["inplace", "worktree"];
  /** Two lines carry the `-M` text, so a derivation that read the file
   * would answer `match_ambiguous` and name them. */
  const TWO_LINES = "n > 0 a\nn > 0 b\n";

  /** Whether this volume gives a file a resource fork under
   * `<file>/..namedfork/rsrc` (macOS, on a filesystem that has forks). */
  const hasNamedForks = (() => {
    if (process.platform !== "darwin") return false;
    const probeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-primitives-fork-probe-"),
    );
    try {
      const file = path.join(probeDir, "f");
      fs.writeFileSync(file, "data\n");
      fs.writeFileSync(path.join(file, "..namedfork", "rsrc"), "fork\n");
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  })();
  const onLinux = process.platform === "linux";

  const openFds: number[] = [];
  afterEach(() => {
    for (const fd of openFds.splice(0)) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  });

  /** `/proc/<pid>/fd/<n>` for a descriptor of this process, held open
   * until the test ends. */
  function procFd(fd: number): string {
    openFds.push(fd);
    return `/proc/${String(process.pid)}/fd/${String(fd)}`;
  }

  /** `/proc/<pid>/fd/<n>` of a directory that is removed once it is
   * open. */
  function removedDirectory(dir: string): string {
    fs.mkdirSync(dir);
    const target = procFd(
      fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY),
    );
    fs.rmdirSync(dir);
    return target;
  }

  /** `/proc/<pid>/fd/<n>` of a file that is unlinked once it is open. */
  function unlinkedFile(file: string): string {
    fs.writeFileSync(file, TWO_LINES);
    const target = procFd(fs.openSync(file, "r+"));
    fs.unlinkSync(file);
    return target;
  }

  interface Live {
    /** What the in-repository link points at. */
    target: string;
    /** Where the walk alone places `<repo>/<name>`: the lenient
     * resolver's answer, and the strict one's before it asked the
     * kernel. */
    walkPlacement: (repo: string, name: string) => string;
    /** Throws unless what the kernel reaches is as it was built. */
    expectUntouched: () => void;
  }

  /**
   * What a run answers when the link is a `link` value instead of the
   * `--file`:
   *
   * - `not_a_directory`: `link_source_not_found`, as for any link value
   *   the kernel does not reach a directory through;
   * - `skipped`: the link policy's strict resolve refuses the candidate,
   *   the run goes on without the link and says so;
   * - `outside`: the link-source walk reports the far end outside the
   *   root (`file_outside_root`);
   * - `walk_placement`: the far end the link-source walk reports is
   *   inside the root, and that spelling, never the link the kernel
   *   follows by handle, is what the copy is given.
   */
  type OperatorAnswer = "not_a_directory" | "skipped";
  type ContentAnswer = "not_a_directory" | "outside" | "walk_placement";

  interface Shape {
    label: string;
    runs: boolean;
    build: (repo: string) => Live;
    operatorLink: OperatorAnswer;
    contentLink: ContentAnswer;
  }

  const whereItSits = (repo: string, name: string): string =>
    path.join(fs.realpathSync.native(repo), name);

  const SHAPES: Shape[] = [
    {
      label:
        "macOS, the resource fork of a file outside the root (<file>/..namedfork/rsrc)",
      runs: hasNamedForks,
      build: () => {
        const victim = path.join(makeTmpDir(), "victim.js");
        fs.writeFileSync(victim, "data\n");
        const fork = path.join(victim, "..namedfork", "rsrc");
        fs.writeFileSync(fork, TWO_LINES);
        return {
          target: fork,
          walkPlacement: whereItSits,
          expectUntouched: () => {
            expect(fs.readFileSync(fork, "utf8")).toBe(TWO_LINES);
            expect(fs.readFileSync(victim, "utf8")).toBe("data\n");
          },
        };
      },
      // A fork is a file, and `lstat` of `<file>/..namedfork/rsrc`
      // succeeds, so the link-source walk ends on the outside fork.
      operatorLink: "not_a_directory",
      contentLink: "outside",
    },
    {
      label: "Linux, /proc/<pid>/fd/<n> of an unlinked file outside the root",
      runs: onLinux,
      build: () => {
        const gone = path.join(makeTmpDir(), "gone.js");
        const target = unlinkedFile(gone);
        expect(fs.readlinkSync(target)).toBe(`${gone} (deleted)`);
        return {
          target,
          walkPlacement: whereItSits,
          expectUntouched: () => {
            expect(fs.readFileSync(target, "utf8")).toBe(TWO_LINES);
          },
        };
      },
      operatorLink: "not_a_directory",
      contentLink: "outside",
    },
    {
      label:
        "Linux, /proc/<pid>/fd/<n> of a removed directory outside the root",
      runs: onLinux,
      build: () => {
        const gone = path.join(makeTmpDir(), "gone-dir");
        const target = removedDirectory(gone);
        expect(fs.readlinkSync(target)).toBe(`${gone} (deleted)`);
        return {
          target,
          walkPlacement: whereItSits,
          expectUntouched: () => {
            expect(fs.statSync(target).isDirectory()).toBe(true);
          },
        };
      },
      operatorLink: "skipped",
      contentLink: "outside",
    },
    {
      // The text `readlink` returns names a file that exists, so the
      // walk places the link in full, at that other file.
      label:
        "Linux, /proc/<pid>/fd/<n> of an unlinked file whose readlink text names another file inside the root",
      runs: onLinux,
      build: (repo) => {
        const gone = whereItSits(repo, "was-here.js");
        const target = unlinkedFile(gone);
        const decoy = `${gone} (deleted)`;
        fs.writeFileSync(decoy, "the decoy\n");
        expect(fs.readlinkSync(target)).toBe(decoy);
        return {
          target,
          walkPlacement: () => decoy,
          expectUntouched: () => {
            expect(fs.readFileSync(target, "utf8")).toBe(TWO_LINES);
            expect(fs.readFileSync(decoy, "utf8")).toBe("the decoy\n");
          },
        };
      },
      operatorLink: "not_a_directory",
      contentLink: "not_a_directory",
    },
    {
      label:
        "Linux, /proc/<pid>/fd/<n> of a removed directory whose readlink text names another directory inside the root",
      runs: onLinux,
      build: (repo) => {
        const gone = whereItSits(repo, "was-here");
        const target = removedDirectory(gone);
        const decoy = `${gone} (deleted)`;
        fs.mkdirSync(decoy);
        fs.writeFileSync(path.join(decoy, "marker.txt"), "the decoy\n");
        expect(fs.readlinkSync(target)).toBe(decoy);
        return {
          target,
          walkPlacement: () => decoy,
          expectUntouched: () => {
            expect(fs.readdirSync(target)).toEqual([]);
            expect(fs.readdirSync(decoy)).toEqual(["marker.txt"]);
          },
        };
      },
      operatorLink: "skipped",
      contentLink: "walk_placement",
    },
  ];

  /** A test command that leaves a trace of every run: no trace means no
   * baseline (and no mutant) ever ran. */
  function tracingCommand(trace: string): string {
    return `echo ran >> '${trace}'; node fixture.test.js`;
  }

  for (const shape of SHAPES) {
    describe.skipIf(!shape.runs)(shape.label, () => {
      function linked(name: string): { repo: string; live: Live } {
        const repo = initRepo();
        const live = shape.build(repo);
        fs.symlinkSync(live.target, path.join(repo, name));
        // The shape is live: the kernel reaches something through it.
        expect(() => fs.statSync(path.join(repo, name))).not.toThrow();
        return { repo, live };
      }

      it("the strict resolver refuses the link, and the lenient one answers the walk's placement unchanged", () => {
        const { repo, live } = linked("live-link.js");
        const link = path.join(repo, "live-link.js");
        let thrown: unknown;
        try {
          resolveDeepestExisting(link);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(UnresolvablePathError);
        expect((thrown as UnresolvablePathError).path).toBe(link);
        expect((thrown as UnresolvablePathError).code).toBeUndefined();
        expect(resolveDeepestExistingLenient(link)).toBe(
          live.walkPlacement(repo, "live-link.js"),
        );
        live.expectUntouched();
      });

      for (const mode of MODES) {
        for (const line of [undefined, 1]) {
          it(`probe(), --file, ${mode} isolation, ${line === undefined ? "-M without -n" : "-n 1"}: file_outside_root, nothing read or written, nothing left behind`, async () => {
            const lockDir = useLockDir();
            const { repo, live } = linked("live-link.js");
            const trace = path.join(makeTmpDir(), "trace");
            const result = await probe(
              probeOptions(repo, {
                file: "live-link.js",
                form: "match",
                matchText: "n > 0",
                withText: "true",
                testCommand: tracingCommand(trace),
                isolation: mode,
                ...(line === undefined ? { line: undefined } : { line }),
              }),
            );
            expect(result.status).toBe("inconclusive");
            expect(result.reason).toBe("file_outside_root");
            const text = result.warnings.join("\n");
            expect(text).toContain("live-link.js");
            expect(text).toContain(
              "refusing to treat it as inside the containment root",
            );
            expect(text).not.toContain("occurs on");
            expect(fs.existsSync(trace)).toBe(false);
            live.expectUntouched();
            expectNoIsolationLeftovers(repo, lockDir);
          });
        }

        it(`probePlan(), mutant file, ${mode} isolation: usage_error file_outside_root, nothing read or written, nothing left behind`, async () => {
          const lockDir = useLockDir();
          const { repo, live } = linked("live-link.js");
          const trace = path.join(makeTmpDir(), "trace");
          const result = await probePlan({
            mutants: [
              {
                file: "live-link.js",
                line: 1,
                form: "match",
                matchText: "n > 0",
                withText: "true",
              },
            ],
            testCommand: tracingCommand(trace),
            isolation: mode,
            expect: "fail",
            cwd: repo,
            logDir: makeTmpDir(),
          });
          expect(result.status).toBe("usage_error");
          expect(result.reason).toBe("file_outside_root");
          expect(fs.existsSync(trace)).toBe(false);
          live.expectUntouched();
          expectNoIsolationLeftovers(repo, lockDir);
        });
      }

      it(`the link as an operator --link value (worktree isolation): ${shape.operatorLink}, never linked into the copy`, async () => {
        useLockDir();
        const { repo, live } = linked("live-link");
        const trace = path.join(makeTmpDir(), "trace");
        const result = await probe(
          probeOptions(repo, {
            links: ["live-link"],
            testCommand: tracingCommand(trace),
          }),
        );
        expect(result.isolation.linked).toEqual([]);
        const text = result.warnings.join("\n");
        if (shape.operatorLink === "not_a_directory") {
          expect(result.status).toBe("usage_error");
          expect(result.reason).toBe("link_source_not_found");
          expect(text).toContain("is not a directory");
          expect(fs.existsSync(trace)).toBe(false);
        } else {
          expect(result.status).toBe("killed");
          expect(text).toContain("skipped linking");
          expect(text).toContain("its target cannot be resolved");
        }
        live.expectUntouched();
      });

      for (const lane of ["plan", "defaults-file"] as const) {
        it(`the link as a ${lane} link value (worktree isolation): ${shape.contentLink}, the copy never reaches what the kernel follows the link to`, async () => {
          useLockDir();
          const { repo, live } = linked("live-link");
          const trace = path.join(makeTmpDir(), "trace");
          const testCommand = tracingCommand(trace);
          let result: {
            status: string;
            reason?: string;
            warnings: string[];
            isolation: { linked: string[] };
          };
          if (lane === "plan") {
            result = await probePlan({
              mutants: [
                {
                  file: "fixture.js",
                  line: 2,
                  form: "replace",
                  replaceText: "  return false;",
                },
              ],
              testCommand,
              isolation: "worktree",
              expect: "fail",
              cwd: repo,
              logDir: makeTmpDir(),
              planLinks: ["live-link"],
              planPath: path.join(repo, "plan.json"),
            });
          } else {
            fs.writeFileSync(
              path.join(repo, ".agent-primitives.json"),
              JSON.stringify({ link: ["live-link"] }),
            );
            result = await probe(probeOptions(repo, { testCommand }));
          }
          const text = result.warnings.join("\n");
          const refusedStatus =
            lane === "plan" ? "usage_error" : "inconclusive";
          if (shape.contentLink === "outside") {
            expect(result.status).toBe(refusedStatus);
            expect(result.reason).toBe("file_outside_root");
            expect(text).toContain("does not resolve inside the root");
            expect(result.isolation.linked).toEqual([]);
            expect(fs.existsSync(trace)).toBe(false);
          } else if (shape.contentLink === "not_a_directory") {
            expect(result.status).toBe("usage_error");
            expect(result.reason).toBe("link_source_not_found");
            expect(result.isolation.linked).toEqual([]);
            expect(fs.existsSync(trace)).toBe(false);
          } else {
            // The far end the walk reports is the in-root directory the
            // readlink text names, and that directory, under its own
            // name, is the one the run links into the copy.
            expect(result.status).toBe("killed");
            expect(result.isolation.linked).toEqual([
              live.walkPlacement(repo, "live-link"),
            ]);
          }
          live.expectUntouched();
        });
      }
    });
  }
});

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { doctor } from "../src/doctor/index.js";
import { doctor as doctorFromIndex } from "../src/index.js";
import { lockKey } from "../src/lock.js";
import {
  containmentRoot,
  resolveDeepestExisting,
} from "../src/probe/containment.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-doctor-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

/** The same digest probe records in a marker, so a fixture marker can
 * describe a state doctor's recovery check actually accepts instead of
 * placeholder hashes that match nothing. */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

afterEach(() => {
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
    const result = await doctor({ required: ["node"], optional: [] });
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

    it("ok for a registered scratch worktree that a live probe's marker names", async () => {
      const lockDir = makeTmpDir();
      const repo = initRepo();
      const root = resolveDeepestExisting(containmentRoot(repo));
      const worktreePath = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      git(repo, ["worktree", "add", "--detach", "--", worktreePath, "HEAD"]);
      writeWorktreeMarker(lockDir, root, worktreePath, process.pid);

      const result = await doctor({
        required: [],
        optional: [],
        cwd: repo,
        lockDir,
      });

      const check = result.checks.find((c) => c.name === "stale-worktree");
      expect(check?.ok).toBe(true);
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

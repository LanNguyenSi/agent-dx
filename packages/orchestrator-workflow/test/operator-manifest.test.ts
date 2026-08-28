import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LOCK_POLL_MS,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  OPERATOR_HOME_ENV,
  OperatorManifestLockTimeoutError,
  applyRegistrationFailureMessage,
  createOperatorManifest,
  operatorManifestState,
  readOperatorManifest,
  resolveOperatorHome,
  safeRealpath,
  updateOperatorManifest,
  upsertOperatorTarget,
  withOperatorManifestLock,
} from "../src/operator-manifest.js";
import type {
  OperatorManifest,
  OperatorManifestDefaults,
} from "../src/operator-manifest.js";

/** Writes `manifest` through the module's sole write path
 * (`updateOperatorManifest`), for tests that need to seed or overwrite the
 * file directly rather than through a `mutate` callback of their own. No
 * test in this file calls a raw, unlocked writer: production code has none
 * to call either. */
function writeOperatorManifest(home: string, manifest: OperatorManifest): void {
  const result = updateOperatorManifest(home, () => manifest);
  if (!result.written) {
    throw new Error("writeOperatorManifest test helper: unexpectedly a no-op");
  }
}

let home: string;
let targetDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "operator-home-"));
  targetDir = mkdtempSync(join(tmpdir(), "operator-target-"));
  savedEnv = process.env[OPERATOR_HOME_ENV];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(targetDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env[OPERATOR_HOME_ENV];
  else process.env[OPERATOR_HOME_ENV] = savedEnv;
});

const defaults = (): OperatorManifestDefaults => ({
  harnesses: ["claude"],
  profile: "full",
  tiers: false,
  models: { implementer: "sonnet" },
});

describe("resolveOperatorHome", () => {
  it("defaults to ~/.orchestrator-workflow", () => {
    delete process.env[OPERATOR_HOME_ENV];
    expect(resolveOperatorHome()).toBe(
      join(homedir(), ".orchestrator-workflow"),
    );
  });

  it("env var wins over the default", () => {
    process.env[OPERATOR_HOME_ENV] = "/tmp/env-home";
    expect(resolveOperatorHome()).toBe("/tmp/env-home");
  });

  it("explicit argument wins over env var and default", () => {
    process.env[OPERATOR_HOME_ENV] = "/tmp/env-home";
    expect(resolveOperatorHome("/tmp/explicit-home")).toBe(
      "/tmp/explicit-home",
    );
  });

  it("an empty ORCHESTRATOR_WORKFLOW_HOME falls through to the default", () => {
    const previous = process.env.ORCHESTRATOR_WORKFLOW_HOME;
    process.env.ORCHESTRATOR_WORKFLOW_HOME = "";
    try {
      expect(resolveOperatorHome()).toBe(
        join(homedir(), ".orchestrator-workflow"),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.ORCHESTRATOR_WORKFLOW_HOME;
      } else {
        process.env.ORCHESTRATOR_WORKFLOW_HOME = previous;
      }
    }
  });

  it("relative values become absolute", () => {
    delete process.env[OPERATOR_HOME_ENV];
    expect(resolveOperatorHome("relative-home")).toBe(
      join(process.cwd(), "relative-home"),
    );

    process.env[OPERATOR_HOME_ENV] = "relative-env-home";
    expect(resolveOperatorHome()).toBe(
      join(process.cwd(), "relative-env-home"),
    );
  });
});

describe("createOperatorManifest", () => {
  it("produces the expected shape", () => {
    const manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    expect(manifest).toEqual({
      kit: "orchestrator-workflow",
      schemaVersion: 1,
      defaults: defaults(),
      targets: [],
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("defaults `now` to the current time when omitted", () => {
    const manifest = createOperatorManifest(defaults());
    expect(manifest.createdAt).toBe(manifest.updatedAt);
    expect(() => new Date(manifest.createdAt).toISOString()).not.toThrow();
  });
});

describe("readOperatorManifest", () => {
  it("returns undefined when the file is missing", () => {
    expect(readOperatorManifest(home)).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    writeFileSync(join(home, "manifest.json"), "{not json", "utf8");
    expect(readOperatorManifest(home)).toBeUndefined();
  });

  it("returns undefined for the wrong kit", () => {
    writeFileSync(
      join(home, "manifest.json"),
      JSON.stringify({ kit: "something-else", schemaVersion: 1 }),
      "utf8",
    );
    expect(readOperatorManifest(home)).toBeUndefined();
  });

  it("returns undefined for the wrong schemaVersion", () => {
    writeFileSync(
      join(home, "manifest.json"),
      JSON.stringify({ kit: "orchestrator-workflow", schemaVersion: 2 }),
      "utf8",
    );
    expect(readOperatorManifest(home)).toBeUndefined();
  });

  it("degrades each field independently on a tampered manifest", () => {
    writeFileSync(
      join(home, "manifest.json"),
      JSON.stringify({
        kit: "orchestrator-workflow",
        schemaVersion: 1,
        defaults: {
          harnesses: ["claude", "not-a-harness"],
          models: { implementer: "sonnet", reviewer: 'bad"id' },
          profile: "not-a-profile",
          tiers: "yes",
        },
        targets: [
          { path: targetDir, lastAppliedVersion: "1.0.0", lastAppliedAt: "t" },
          {
            path: "relative/path",
            lastAppliedVersion: "1.0.0",
            lastAppliedAt: "t",
          },
          { path: 42, lastAppliedVersion: "1.0.0", lastAppliedAt: "t" },
        ],
        createdAt: 123,
        updatedAt: "2026-08-28T00:00:00.000Z",
      }),
      "utf8",
    );

    const manifest = readOperatorManifest(home);
    expect(manifest).toBeDefined();
    expect(manifest!.defaults.harnesses).toEqual(["claude"]);
    expect(manifest!.defaults.models).toEqual({ implementer: "sonnet" });
    expect(manifest!.defaults.profile).toBe("full");
    expect(manifest!.defaults.tiers).toBe(false);
    expect(manifest!.targets).toEqual([
      { path: targetDir, lastAppliedVersion: "1.0.0", lastAppliedAt: "t" },
    ]);
    expect(manifest!.createdAt).toBe("");
    expect(manifest!.updatedAt).toBe("2026-08-28T00:00:00.000Z");
  });
});

describe("writeOperatorManifest / round-trip", () => {
  it("creates a nonexistent home recursively", () => {
    const nestedHome = join(home, "nested", "deeper");
    const manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    writeOperatorManifest(nestedHome, manifest);
    expect(readOperatorManifest(nestedHome)).toEqual(manifest);
  });

  it("writes two-space JSON with exactly one trailing newline", () => {
    writeOperatorManifest(
      home,
      createOperatorManifest(defaults(), "2026-01-01T00:00:00.000Z"),
    );
    const raw = readFileSync(join(home, "manifest.json"), "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw.endsWith("\n\n")).toBe(false);
    expect(raw).toContain('\n  "kit": "orchestrator-workflow",\n');
  });

  it("round-trips a manifest with 0 targets", () => {
    const manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    writeOperatorManifest(home, manifest);
    expect(readOperatorManifest(home)).toEqual(manifest);
  });

  it("round-trips a manifest with 1 target", () => {
    let manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    manifest = upsertOperatorTarget(
      manifest,
      targetDir,
      "1.0.0",
      "2026-08-28T00:00:00.000Z",
    ).manifest;
    writeOperatorManifest(home, manifest);
    expect(readOperatorManifest(home)).toEqual(manifest);
  });

  it("round-trips a manifest with 2+ targets", () => {
    const targetDir2 = mkdtempSync(join(tmpdir(), "operator-target2-"));
    try {
      let manifest = createOperatorManifest(
        defaults(),
        "2026-08-28T00:00:00.000Z",
      );
      manifest = upsertOperatorTarget(
        manifest,
        targetDir,
        "1.0.0",
        "2026-08-28T00:00:00.000Z",
      ).manifest;
      manifest = upsertOperatorTarget(
        manifest,
        targetDir2,
        "1.0.0",
        "2026-08-28T00:00:00.000Z",
      ).manifest;
      writeOperatorManifest(home, manifest);
      expect(readOperatorManifest(home)).toEqual(manifest);
    } finally {
      rmSync(targetDir2, { recursive: true, force: true });
    }
  });
});

describe("upsertOperatorTarget", () => {
  it("first insert yields exactly one entry and reports it as new", () => {
    const manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    const { manifest: updated, alreadyRegistered } = upsertOperatorTarget(
      manifest,
      targetDir,
      "1.0.0",
      "2026-08-28T00:00:00.000Z",
    );
    expect(alreadyRegistered).toBe(false);
    expect(updated.targets).toHaveLength(1);
    expect(updated.targets[0]).toEqual({
      path: updated.targets[0].path,
      lastAppliedVersion: "1.0.0",
      lastAppliedAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("a second call for the same realpath updates in place (length stays 1) and reports alreadyRegistered", () => {
    let manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    manifest = upsertOperatorTarget(
      manifest,
      targetDir,
      "1.0.0",
      "2026-08-28T00:00:00.000Z",
    ).manifest;
    const second = upsertOperatorTarget(
      manifest,
      targetDir,
      "1.1.0",
      "2026-08-29T00:00:00.000Z",
    );
    expect(second.alreadyRegistered).toBe(true);
    expect(second.manifest.targets).toHaveLength(1);
    expect(second.manifest.targets[0].lastAppliedVersion).toBe("1.1.0");
    expect(second.manifest.targets[0].lastAppliedAt).toBe(
      "2026-08-29T00:00:00.000Z",
    );
  });

  it("still upserts when a previously recorded target directory no longer exists", () => {
    const gone = mkdtempSync(join(tmpdir(), "ow-op-gone-"));
    const first = upsertOperatorTarget(
      createOperatorManifest(defaults(), "2026-01-01T00:00:00.000Z"),
      gone,
      "0.25.0",
      "2026-01-01T00:00:00.000Z",
    ).manifest;
    rmSync(gone, { recursive: true, force: true });
    const second = upsertOperatorTarget(
      first,
      targetDir,
      "0.25.0",
      "2026-01-02T00:00:00.000Z",
    ).manifest;
    expect(second.targets).toHaveLength(2);
    expect(second.targets[0].path).toBe(first.targets[0].path);
    expect(second.targets[1].path).toBe(realpathSync(targetDir));
  });

  it("does not throw when the target itself no longer exists (deleted mid-lock)", () => {
    const gone = mkdtempSync(join(tmpdir(), "ow-op-gone-target-"));
    rmSync(gone, { recursive: true, force: true });
    const manifest = createOperatorManifest(
      defaults(),
      "2026-01-01T00:00:00.000Z",
    );
    expect(() =>
      upsertOperatorTarget(
        manifest,
        gone,
        "0.25.0",
        "2026-01-01T00:00:00.000Z",
      ),
    ).not.toThrow();
    const { manifest: updated } = upsertOperatorTarget(
      manifest,
      gone,
      "0.25.0",
      "2026-01-01T00:00:00.000Z",
    );
    expect(updated.targets[0].path).toBe(gone);
  });

  it("dedupes against a stored path that is a symlink to the same directory", () => {
    const link = join(home, "target-link");
    symlinkSync(targetDir, link);
    const first = upsertOperatorTarget(
      createOperatorManifest(defaults(), "2026-01-01T00:00:00.000Z"),
      link,
      "0.25.0",
      "2026-01-01T00:00:00.000Z",
    ).manifest;
    const second = upsertOperatorTarget(
      first,
      targetDir,
      "0.25.1",
      "2026-01-02T00:00:00.000Z",
    );
    expect(second.alreadyRegistered).toBe(true);
    expect(second.manifest.targets).toHaveLength(1);
    expect(second.manifest.targets[0].lastAppliedVersion).toBe("0.25.1");
  });

  it("normalizes a stored non-realpath path to the realpath on update", () => {
    const link = join(home, "target-link-normalize");
    symlinkSync(targetDir, link);
    // Seed a target entry with the raw symlink path, as a hand-written or
    // pre-normalization manifest might carry (bypassing the realpath the
    // insert branch itself would have used).
    const seeded: OperatorManifest = {
      ...createOperatorManifest(defaults(), "2026-01-01T00:00:00.000Z"),
      targets: [
        { path: link, lastAppliedVersion: "0.1.0", lastAppliedAt: "t" },
      ],
    };
    const { manifest: updated, alreadyRegistered } = upsertOperatorTarget(
      seeded,
      targetDir,
      "0.25.1",
      "2026-01-02T00:00:00.000Z",
    );
    expect(alreadyRegistered).toBe(true);
    expect(updated.targets).toHaveLength(1);
    expect(updated.targets[0].path).toBe(realpathSync(targetDir));
    expect(updated.targets[0].path).not.toBe(link);
  });

  it("does not mutate the input manifest or its nested arrays/objects", () => {
    const manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    const before = JSON.parse(JSON.stringify(manifest)) as OperatorManifest;
    const { manifest: updated } = upsertOperatorTarget(
      manifest,
      targetDir,
      "1.0.0",
      "2026-08-28T00:00:00.000Z",
    );
    expect(manifest).toEqual(before);
    expect(updated).not.toBe(manifest);
    expect(updated.targets).not.toBe(manifest.targets);
    expect(updated.defaults).not.toBe(manifest.defaults);
    expect(updated.defaults.models).not.toBe(manifest.defaults.models);
  });
});

describe("writeOperatorManifest atomicity", () => {
  it("leaves no .tmp sibling behind after a successful write", () => {
    writeOperatorManifest(
      home,
      createOperatorManifest(defaults(), "2026-08-28T00:00:00.000Z"),
    );
    const entries = readdirSync(home);
    expect(entries).toEqual(["manifest.json"]);
  });

  it("a second write replaces the file's content wholesale (no merge of stale tmp bytes)", () => {
    writeOperatorManifest(
      home,
      createOperatorManifest(defaults(), "2026-01-01T00:00:00.000Z"),
    );
    const second = upsertOperatorTarget(
      createOperatorManifest(defaults(), "2026-01-02T00:00:00.000Z"),
      targetDir,
      "1.0.0",
      "2026-01-02T00:00:00.000Z",
    ).manifest;
    writeOperatorManifest(home, second);
    expect(readOperatorManifest(home)).toEqual(second);
    expect(readdirSync(home)).toEqual(["manifest.json"]);
  });
});

describe("operatorManifestState", () => {
  it("reports absent when no manifest file exists", () => {
    expect(operatorManifestState(home)).toEqual({ kind: "absent" });
  });

  it("reports unreadable for corrupt JSON, distinct from absent", () => {
    writeFileSync(join(home, "manifest.json"), "{not json", "utf8");
    expect(operatorManifestState(home)).toEqual({ kind: "unreadable" });
  });

  it("reports unreadable for an unrecognized envelope (wrong kit)", () => {
    writeFileSync(
      join(home, "manifest.json"),
      JSON.stringify({ kit: "something-else", schemaVersion: 1 }),
      "utf8",
    );
    expect(operatorManifestState(home)).toEqual({ kind: "unreadable" });
  });

  it("reports ok with the parsed manifest for a valid file", () => {
    const manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    writeOperatorManifest(home, manifest);
    expect(operatorManifestState(home)).toEqual({
      kind: "ok",
      manifest,
    });
  });
});

/** Spawns a short-lived, detached child process that removes `path` after
 * `delayMs`. Needed instead of `setTimeout` in the same process: the
 * production acquire loop's poll delay (`sleepSync`) blocks the whole JS
 * thread synchronously via `Atomics.wait`, so nothing scheduled on this
 * process's own event loop (a `setTimeout`, a `setImmediate`) can run
 * while a test's own call into `withOperatorManifestLock` is polling. A
 * separate OS process is unaffected by that block, so it can genuinely
 * release the lock out from under an in-progress, synchronously-polling
 * acquire attempt in this process. */
function releaseLockAfterDelay(path: string, delayMs: number) {
  return spawn(
    process.execPath,
    [
      "-e",
      `setTimeout(()=>{try{require("fs").rmdirSync(process.argv[1]);}catch{}},${delayMs});`,
      path,
    ],
    { stdio: "ignore" },
  );
}

describe("withOperatorManifestLock", () => {
  const lockPath = () => join(home, ".manifest.lock");

  it("runs fn and returns its result when the lock is free", () => {
    const result = withOperatorManifestLock(home, () => 42);
    expect(result).toBe(42);
  });

  it("releases the lock directory after fn returns", () => {
    withOperatorManifestLock(home, () => undefined);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("releases the lock directory after fn throws, and the error propagates", () => {
    expect(() =>
      withOperatorManifestLock(home, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("a second acquire waits while the lock is held, and times out with OperatorManifestLockTimeoutError", () => {
    mkdirSync(lockPath());
    try {
      expect(() =>
        withOperatorManifestLock(home, () => "should not run", {
          timeoutMs: 60,
          pollMs: 10,
        }),
      ).toThrow(OperatorManifestLockTimeoutError);
    } finally {
      rmSync(lockPath(), { recursive: true, force: true });
    }
  });

  it("succeeds once the held lock is released by another process, without needing a stale-lock reclaim", () => {
    mkdirSync(lockPath());
    const child = releaseLockAfterDelay(lockPath(), 100);
    try {
      const result = withOperatorManifestLock(home, () => "done", {
        timeoutMs: 3_000,
        pollMs: 20,
      });
      expect(result).toBe("done");
    } finally {
      child.kill();
    }
  });

  it("treats a lock directory older than staleMs as abandoned and reclaims it", () => {
    mkdirSync(lockPath());
    const sixtySecondsAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath(), sixtySecondsAgo, sixtySecondsAgo);

    const result = withOperatorManifestLock(home, () => "reclaimed", {
      staleMs: 30_000,
      timeoutMs: 5_000,
      pollMs: 10,
    });
    expect(result).toBe("reclaimed");
  });

  it("does not reclaim a lock directory younger than staleMs (fresh lock still times out)", () => {
    mkdirSync(lockPath());
    try {
      expect(() =>
        withOperatorManifestLock(home, () => "should not run", {
          timeoutMs: 50,
          staleMs: 30_000,
          pollMs: 10,
        }),
      ).toThrow(OperatorManifestLockTimeoutError);
    } finally {
      rmSync(lockPath(), { recursive: true, force: true });
    }
  });

  it("pins the default timeout/stale/poll windows, and the timeout stays above the stale threshold", () => {
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBe(40_000);
    expect(DEFAULT_LOCK_STALE_MS).toBe(30_000);
    expect(DEFAULT_LOCK_POLL_MS).toBe(20);
    // A caller starting anywhere from 0ms to DEFAULT_LOCK_STALE_MS after a
    // killed holder left its lock behind must still be alive, polling, when
    // that lock crosses the staleness threshold; the timeout must outlast
    // the stale threshold for that to hold (L9).
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBeGreaterThan(DEFAULT_LOCK_STALE_MS);
  });

  it("writes a fresh owner token on each acquisition", () => {
    const ownerPath = join(lockPath(), "owner");
    const tokens: string[] = [];
    withOperatorManifestLock(home, () => {
      tokens.push(readFileSync(ownerPath, "utf8"));
    });
    withOperatorManifestLock(home, () => {
      tokens.push(readFileSync(ownerPath, "utf8"));
    });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("does not remove the lock directory in `finally` if another process's owner token has since taken it over (M2)", () => {
    const result = withOperatorManifestLock(home, () => {
      // Simulate a stale-lock reclaim by another process happening while
      // this call still holds what it believes is the lock: overwrite the
      // owner file with a foreign token.
      writeFileSync(join(lockPath(), "owner"), "someone-elses-token", "utf8");
      return "ok";
    });
    expect(result).toBe("ok");
    // The lock directory must survive: removing it here would tear down a
    // critical section this call no longer actually owns.
    expect(existsSync(lockPath())).toBe(true);
    expect(readFileSync(join(lockPath(), "owner"), "utf8")).toBe(
      "someone-elses-token",
    );
    rmSync(lockPath(), { recursive: true, force: true });
  });

  it("re-evaluates staleness on every failed acquire attempt, not just once per call (L9)", () => {
    // A lock created fresh, then aged past staleMs only after the first
    // failed mkdir attempt, must still be reclaimed by a caller already
    // polling: the pre-fix code only ever checked staleness once per call.
    mkdirSync(lockPath());
    utimesSync(lockPath(), new Date(0), new Date(0));
    const result = withOperatorManifestLock(home, () => "reclaimed-again", {
      staleMs: 10,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    expect(result).toBe("reclaimed-again");
  });
});

/** Spawns a short-lived child process (via `tsx`, same pattern the rest of
 * this repo's test suites use to run TypeScript sources directly) that
 * acquires the operator-manifest lock, holds it for `holdMs`, and records
 * the wall-clock interval it held it for to `outFile`. Used by the
 * two-waiter race test below: unlike an in-process call, two of these can
 * genuinely run at the same time. */
const LOCK_PROBE_SCRIPT = (() => {
  const scriptPath = join(
    mkdtempSync(join(tmpdir(), "lock-probe-script-")),
    "probe.mjs",
  );
  const modulePath = fileURLToPath(
    new URL("../src/operator-manifest.ts", import.meta.url),
  );
  writeFileSync(
    scriptPath,
    [
      `import { writeFileSync } from "node:fs";`,
      `import { withOperatorManifestLock } from ${JSON.stringify(modulePath)};`,
      `const [, , home, outFile, holdMsRaw] = process.argv;`,
      `const holdMs = Number(holdMsRaw);`,
      `withOperatorManifestLock(home, () => {`,
      `  const start = Date.now();`,
      `  const sharedBuffer = new SharedArrayBuffer(4);`,
      `  Atomics.wait(new Int32Array(sharedBuffer), 0, 0, holdMs);`,
      `  const end = Date.now();`,
      `  writeFileSync(outFile, JSON.stringify({ start, end }), "utf8");`,
      `});`,
      "",
    ].join("\n"),
    "utf8",
  );
  return scriptPath;
})();

function spawnLockProbe(
  homeDir: string,
  outFile: string,
  holdMs: number,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", LOCK_PROBE_SCRIPT, homeDir, outFile, String(holdMs)],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stderr }));
  });
}

describe("withOperatorManifestLock: two real waiters on a stale lock (M2)", () => {
  it("never both hold the lock at once, across 5 repeats", async () => {
    for (let i = 0; i < 5; i++) {
      // A lock directory well past the default 30s staleMs, simulating one
      // left behind by a process that crashed or was killed mid-critical-
      // section, contended for by two genuinely concurrent processes.
      const lockPath = join(home, ".manifest.lock");
      mkdirSync(lockPath);
      const sixtyOneSecondsAgo = new Date(Date.now() - 61_000);
      utimesSync(lockPath, sixtyOneSecondsAgo, sixtyOneSecondsAgo);

      const outA = join(home, `probe-a-${i}.json`);
      const outB = join(home, `probe-b-${i}.json`);
      const [a, b] = await Promise.all([
        spawnLockProbe(home, outA, 200),
        spawnLockProbe(home, outB, 200),
      ]);
      expect(a.status, a.stderr).toBe(0);
      expect(b.status, b.stderr).toBe(0);

      const markerA = JSON.parse(readFileSync(outA, "utf8")) as {
        start: number;
        end: number;
      };
      const markerB = JSON.parse(readFileSync(outB, "utf8")) as {
        start: number;
        end: number;
      };
      const noOverlap =
        markerA.end <= markerB.start || markerB.end <= markerA.start;
      expect(noOverlap, JSON.stringify({ markerA, markerB })).toBe(true);

      rmSync(outA, { force: true });
      rmSync(outB, { force: true });
      rmSync(lockPath, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("updateOperatorManifest", () => {
  it("creates a fresh manifest when none exists, reporting state absent and written true", () => {
    const result = updateOperatorManifest(home, (current) => {
      expect(current).toBeUndefined();
      return createOperatorManifest(defaults(), "2026-08-28T00:00:00.000Z");
    });
    expect(result.state).toEqual({ kind: "absent" });
    expect(result.written).toBe(true);
    expect(result.manifest?.defaults).toEqual(defaults());
    expect(readOperatorManifest(home)?.defaults).toEqual(defaults());
  });

  it("mutate returning undefined writes nothing and reports written: false", () => {
    const seeded = createOperatorManifest(
      defaults(),
      "2026-01-01T00:00:00.000Z",
    );
    writeOperatorManifest(home, seeded);

    const result = updateOperatorManifest(home, () => undefined);
    expect(result.written).toBe(false);
    expect(result.state).toEqual({ kind: "ok", manifest: seeded });
    expect(readOperatorManifest(home)).toEqual(seeded);
  });

  it("hands mutate the manifest re-read inside the lock, not a caller's earlier read", () => {
    const seeded = createOperatorManifest(
      defaults(),
      "2026-01-01T00:00:00.000Z",
    );
    writeOperatorManifest(home, seeded);

    // Simulate another process's own locked write landing between this
    // caller's own earlier read and its call into updateOperatorManifest:
    // updateOperatorManifest must still see the newer file, since it
    // re-reads inside its own lock rather than trusting anything read
    // beforehand.
    const registered = upsertOperatorTarget(
      seeded,
      targetDir,
      "1.2.3",
      "2026-01-02T00:00:00.000Z",
    ).manifest;
    writeOperatorManifest(home, registered);

    const result = updateOperatorManifest(home, (current) => {
      expect(current?.targets).toHaveLength(1);
      return current;
    });
    expect(result.written).toBe(true);
    expect(result.manifest?.targets).toHaveLength(1);
  });

  it("distinguishes an unreadable manifest from an absent one via `state`, both handing mutate `current: undefined`", () => {
    writeFileSync(join(home, "manifest.json"), "{not valid json", "utf8");
    const result = updateOperatorManifest(home, (current, state) => {
      expect(current).toBeUndefined();
      expect(state.kind).toBe("unreadable");
      return undefined;
    });
    expect(result.written).toBe(false);
    expect(result.state).toEqual({ kind: "unreadable" });
  });

  it("serializes concurrent updateOperatorManifest calls via the same lock (no lost update)", async () => {
    writeOperatorManifest(
      home,
      createOperatorManifest(defaults(), "2026-01-01T00:00:00.000Z"),
    );
    const targetA = mkdtempSync(join(tmpdir(), "update-om-a-"));
    const targetB = mkdtempSync(join(tmpdir(), "update-om-b-"));
    try {
      const runUpdate = (targetPath: string) =>
        new Promise<void>((resolvePromise) => {
          setImmediate(() => {
            updateOperatorManifest(home, (current) => {
              if (!current) return undefined;
              return upsertOperatorTarget(
                current,
                targetPath,
                "1.0.0",
                "2026-01-02T00:00:00.000Z",
              ).manifest;
            });
            resolvePromise();
          });
        });
      await Promise.all([runUpdate(targetA), runUpdate(targetB)]);

      const after = readOperatorManifest(home);
      const paths = after?.targets.map((t) => t.path) ?? [];
      expect(paths).toContain(realpathSync(targetA));
      expect(paths).toContain(realpathSync(targetB));
    } finally {
      rmSync(targetA, { recursive: true, force: true });
      rmSync(targetB, { recursive: true, force: true });
    }
  });
});

describe("applyRegistrationFailureMessage", () => {
  it("says the kit was installed and only registration failed for an unreadable manifest (L8)", () => {
    const message = applyRegistrationFailureMessage(
      "unreadable",
      "/home/op/.orchestrator-workflow/manifest.json",
      "/repo/target",
    );
    expect(message).toContain("was installed into /repo/target");
    expect(message).toContain("could not be registered");
    expect(message).not.toContain("if this is not the repo you meant");
  });

  it("keeps the distinct gone-mid-lock wording for an absent manifest", () => {
    const message = applyRegistrationFailureMessage(
      "absent",
      "/home/op/.orchestrator-workflow/manifest.json",
      "/repo/target",
    );
    expect(message).toContain("is gone");
    expect(message).toContain(
      "/repo/target was installed but could not be registered",
    );
  });
});

describe("safeRealpath", () => {
  it("resolves an existing path to its realpath", () => {
    expect(safeRealpath(targetDir)).toBe(realpathSync(targetDir));
  });

  it("returns the candidate unchanged for a path that does not exist, rather than throwing", () => {
    const gone = join(targetDir, "does-not-exist");
    expect(() => safeRealpath(gone)).not.toThrow();
    expect(safeRealpath(gone)).toBe(gone);
  });
});

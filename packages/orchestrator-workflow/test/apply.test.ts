import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PACKAGE_VERSION } from "../src/assets.js";
import { OPERATOR_HOME_ENV } from "../src/operator-manifest.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let home: string;
let target: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "apply-operator-home-"));
  target = mkdtempSync(join(tmpdir(), "apply-target-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

const operatorManifestPath = () => join(home, "manifest.json");
const repoManifestPath = (dir: string) =>
  join(dir, ".ai", "workflow", "manifest.json");

function run(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, [OPERATOR_HOME_ENV]: home },
    },
  );
}

function runSetup(...args: string[]) {
  return run("setup", ...args);
}

function runApply(...args: string[]) {
  return run("apply", ...args);
}

function runInitCli(dir: string, ...args: string[]) {
  return run("init", dir, ...args);
}

/** Async counterpart of `run`, needed by the concurrency tests below:
 * `spawnSync` blocks this process until the child exits, so two calls can
 * never overlap in wall-clock time no matter how they are sequenced. `spawn`
 * lets several commands (`apply`/`apply`, or `setup`/`apply`) genuinely run
 * at the same time. */
function runAsync(
  command: string,
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", command, ...args],
      {
        cwd: PACKAGE_DIR,
        env: { ...process.env, [OPERATOR_HOME_ENV]: home },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolvePromise({ status: code, stdout, stderr }),
    );
  });
}

function runApplyAsync(...args: string[]) {
  return runAsync("apply", ...args);
}

function runSetupAsync(...args: string[]) {
  return runAsync("setup", ...args);
}

function readOperatorManifest() {
  return JSON.parse(readFileSync(operatorManifestPath(), "utf8"));
}

function readRepoManifest(dir: string) {
  return JSON.parse(readFileSync(repoManifestPath(dir), "utf8"));
}

/** Snapshot of every file under `dir`, keyed by absolute path, for a
 * byte-for-byte before/after comparison of the target's installed files. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(full, readFileSync(full, "utf8"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

describe("apply", () => {
  it("exits 1 and touches nothing when no operator setup exists", () => {
    const before = existsSync(target) ? readdirSync(target) : [];
    const result = runApply("--target", target, "--yes");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "No operator setup found; run `orchestrator-workflow setup` first.",
    );
    expect(existsSync(operatorManifestPath())).toBe(false);
    expect(readdirSync(target)).toEqual(before);
  });

  it("errors and writes nothing when the target directory does not exist", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const beforeManifest = readFileSync(operatorManifestPath(), "utf8");

    const missing = join(target, "does-not-exist");
    const result = runApply("--target", missing, "--yes");
    expect(result.status).not.toBe(0);
    expect(existsSync(missing)).toBe(false);
    expect(readFileSync(operatorManifestPath(), "utf8")).toBe(beforeManifest);
  });

  it("a fresh target installs with operator defaults and registers it", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const result = runApply("--target", target, "--yes");
    expect(result.status, result.stderr).toBe(0);
    // The printed path is the realpath (L10 review finding), not the raw
    // --target argument, so this matches even on a platform whose temp
    // directory is itself reached through a symlink (e.g. macOS's
    // /var -> /private/var).
    expect(result.stdout).toContain(
      `Registered ${realpathSync(target)} in the operator manifest`,
    );

    const repoManifest = readRepoManifest(target);
    expect(repoManifest.harnesses).toEqual(["claude"]);
    expect(repoManifest.profile).toBe("full");
    expect(repoManifest.tiers).toBe(false);

    const operatorManifest = readOperatorManifest();
    expect(operatorManifest.targets).toHaveLength(1);
    expect(operatorManifest.targets[0].lastAppliedVersion).toBe(
      PACKAGE_VERSION,
    );
    expect(operatorManifest.targets[0].lastAppliedAt).toBeTruthy();
  });

  it("a second identical apply is a byte-for-byte no-op on target files, updating only the registry entry's lastAppliedAt", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const first = runApply("--target", target, "--yes");
    expect(first.status, first.stderr).toBe(0);

    const before = snapshot(target);
    const beforeTarget = readOperatorManifest().targets[0];

    // A microtask tick is not enough to guarantee a distinct ISO timestamp;
    // the assertion below only requires the version and target set to stay
    // put, not that the timestamp necessarily changed.
    const second = runApply("--target", target, "--yes");
    expect(second.status, second.stderr).toBe(0);

    const after = snapshot(target);
    expect(after).toEqual(before);

    const afterManifest = readOperatorManifest();
    expect(afterManifest.targets).toHaveLength(1);
    expect(afterManifest.targets[0].lastAppliedVersion).toBe(
      beforeTarget.lastAppliedVersion,
    );

    const refreshed = runApply("--target", target, "--yes");
    expect(refreshed.stdout).toContain(
      `Refreshed the registry entry for ${realpathSync(target)}`,
    );
  });

  it("advances lastAppliedAt on a no-op re-apply from a deliberately old seeded timestamp", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const first = runApply("--target", target, "--yes");
    expect(first.status, first.stderr).toBe(0);

    const oldTimestamp = "2000-01-01T00:00:00.000Z";
    const manifest = readOperatorManifest();
    manifest.targets[0].lastAppliedAt = oldTimestamp;
    writeFileSync(
      operatorManifestPath(),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const second = runApply("--target", target, "--yes");
    expect(second.status, second.stderr).toBe(0);

    const after = readOperatorManifest();
    expect(after.targets).toHaveLength(1);
    expect(after.targets[0].lastAppliedAt).not.toBe(oldTimestamp);
    expect(new Date(after.targets[0].lastAppliedAt).getTime()).toBeGreaterThan(
      new Date(oldTimestamp).getTime(),
    );
  });

  it("a plain apply keeps a target's own recorded profile when it diverges from the operator default, and --sync moves it to the operator default", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const init = runInitCli(target, "--profile", "minimal", "--yes");
    expect(init.status, init.stderr).toBe(0);
    expect(readRepoManifest(target).profile).toBe("minimal");

    const plain = runApply("--target", target, "--yes");
    expect(plain.status, plain.stderr).toBe(0);
    expect(readRepoManifest(target).profile).toBe("minimal");

    const synced = runApply("--target", target, "--sync", "--yes");
    expect(synced.status, synced.stderr).toBe(0);
    expect(readRepoManifest(target).profile).toBe("full");
  });

  it("an explicit --profile wins over both the recorded value and --sync", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const init = runInitCli(target, "--profile", "minimal", "--yes");
    expect(init.status, init.stderr).toBe(0);

    // Operator default is "full" (setup's fallback); --sync alone would move
    // the target to "full", but an explicit --profile minimal must still win.
    const result = runApply(
      "--target",
      target,
      "--sync",
      "--profile",
      "minimal",
      "--yes",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readRepoManifest(target).profile).toBe("minimal");
  });

  it("a plain apply keeps the target's own recorded model, --sync moves it to the operator default, and --models wins over both", () => {
    const setup = runSetup("--models", "implementer=opus", "--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const init = runInitCli(target, "--models", "implementer=haiku", "--yes");
    expect(init.status, init.stderr).toBe(0);
    expect(readRepoManifest(target).models.implementer).toBe("haiku");

    const plain = runApply("--target", target, "--yes");
    expect(plain.status, plain.stderr).toBe(0);
    expect(readRepoManifest(target).models.implementer).toBe("haiku");

    const synced = runApply("--target", target, "--sync", "--yes");
    expect(synced.status, synced.stderr).toBe(0);
    expect(readRepoManifest(target).models.implementer).toBe("opus");

    const overridden = runApply(
      "--target",
      target,
      "--sync",
      "--models",
      "implementer=haiku",
      "--yes",
    );
    expect(overridden.status, overridden.stderr).toBe(0);
    expect(readRepoManifest(target).models.implementer).toBe("haiku");
  });

  it("--sync leaves the target's own recorded harnesses alone (repo codex, operator claude), and an explicit --harness wins over --sync", () => {
    const setup = runSetup("--harness", "claude", "--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const init = runInitCli(target, "--harness", "codex", "--yes");
    expect(init.status, init.stderr).toBe(0);
    expect(readRepoManifest(target).harnesses).toEqual(["codex"]);

    const synced = runApply("--target", target, "--sync", "--yes");
    expect(synced.status, synced.stderr).toBe(0);
    expect(readRepoManifest(target).harnesses).toEqual(["codex"]);

    const overridden = runApply(
      "--target",
      target,
      "--sync",
      "--harness",
      "claude",
      "--yes",
    );
    expect(overridden.status, overridden.stderr).toBe(0);
    expect(readRepoManifest(target).harnesses).toEqual(["claude"]);
  });

  it("an explicit --harness none on a fresh apply resolves to templates-only, matching init (CHANGELOG's 'apply shares the same option parsing' claim)", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const result = runApply("--target", target, "--yes", "--harness", "none");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("templates only");
    expect(result.stdout).not.toContain("installed for: ");

    const repoManifest = readRepoManifest(target);
    expect(repoManifest.harnesses).toEqual([]);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(target, ".claude"))).toBe(false);
  });

  it("a recorded harnesses: [] target stays templates-only on a flagless apply even when the operator default names a harness and .claude/ exists on disk, but --harness claude still upgrades it", () => {
    // Operator defaults name a harness (setup's own default is claude).
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    // Records harnesses: [] on the target, same as the fresh-apply test
    // above.
    const first = runApply("--target", target, "--yes", "--harness", "none");
    expect(first.status, first.stderr).toBe(0);
    expect(readRepoManifest(target).harnesses).toEqual([]);

    // A stray CLAUDE.md on disk here is incidental: the sticky gate in
    // `resolveApplyHarnesses` short-circuits on `previousIsRecordedManifest
    // && harnessesRecordedEmpty` before the operator-default/detection
    // fallback chain (and detectHarnesses) ever runs, so this file does not
    // exercise the detection leg. See the dedicated detection-leg test
    // below ("...even when detection would report a harness") for that.
    writeFileSync(join(target, "CLAUDE.md"), "stray, not kit-managed\n");

    const second = runApply("--target", target, "--yes");
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("templates only");
    expect(second.stdout).not.toContain("installed for: ");
    // The "Found existing install" line must distinguish a real recorded
    // harnesses: [] from a missing/malformed/all-unknown harnesses field
    // (both otherwise print the same "none recorded"); this target's
    // manifest was recorded empty by the `first` apply above.
    expect(second.stdout).toContain(
      "harnesses: none (recorded templates-only)",
    );
    expect(readRepoManifest(target).harnesses).toEqual([]);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(target, ".claude"))).toBe(false);

    // An explicit --harness on this run still overrides the stickiness,
    // the same override-vs-persist rule --profile/--models/--tiers use.
    const third = runApply("--target", target, "--yes", "--harness", "claude");
    expect(third.status, third.stderr).toBe(0);
    expect(third.stdout).toContain("installed for: claude");
    expect(readRepoManifest(target).harnesses).toEqual(["claude"]);
    expect(existsSync(join(target, ".claude"))).toBe(true);
  });

  it("a recorded harnesses: [] target stays templates-only on a flagless apply even when detection would report a harness (operator default also empty, so resolveApplyHarnesses actually calls detectHarnesses)", () => {
    // Operator defaults are also harnesses: [] here (unlike the sticky test
    // above, whose non-empty operator default short-circuits
    // resolveApplyHarnesses before it ever calls detectHarnesses). With
    // both the target's recorded harnesses and the operator default empty,
    // resolveApplyHarnesses's fallback chain actually reaches
    // detectHarnesses(targetDir), which the stray CLAUDE.md below makes
    // report ["claude"] -- so this is the case that actually exercises the
    // detection leg, and proves the sticky gate wins over it, not just
    // over a non-empty operator default.
    const setup = runSetup("--harness", "none", "--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const first = runApply("--target", target, "--yes", "--harness", "none");
    expect(first.status, first.stderr).toBe(0);
    expect(readRepoManifest(target).harnesses).toEqual([]);

    writeFileSync(join(target, "CLAUDE.md"), "stray, not kit-managed\n");

    const second = runApply("--target", target, "--yes");
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("templates only");
    expect(second.stdout).not.toContain("installed for: ");
    expect(readRepoManifest(target).harnesses).toEqual([]);
    expect(existsSync(join(target, ".claude"))).toBe(false);
  });

  it("a hand-written manifest naming only unknown harnesses (e.g. cursor) sanitizes to harnesses: [] but harnessesRecordedEmpty: false, so it is not sticky and the fallback chain runs", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    // The raw `harnesses` array is non-empty (["cursor"]), so
    // `harnessesRecordedEmpty` sanitizes to false even though every entry
    // fails the known-harness filter and `readInstalledManifest` reports
    // `harnesses: []` -- see the `Manifest.harnessesRecordedEmpty` doc
    // comment in init.ts.
    mkdirSync(join(target, ".ai", "workflow"), { recursive: true });
    writeFileSync(
      repoManifestPath(target),
      JSON.stringify(
        {
          kit: "orchestrator-workflow",
          version: PACKAGE_VERSION,
          harnesses: ["cursor"],
        },
        null,
        2,
      ),
    );

    const result = runApply("--target", target, "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("installed for: claude");
    expect(readRepoManifest(target).harnesses).toEqual(["claude"]);
    expect(existsSync(join(target, ".claude"))).toBe(true);
  });

  it("--sync on a recorded harnesses: [] target still stays templates-only (--sync only affects profile/tiers/models, never harnesses)", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const first = runApply("--target", target, "--yes", "--harness", "none");
    expect(first.status, first.stderr).toBe(0);
    expect(readRepoManifest(target).harnesses).toEqual([]);

    const synced = runApply("--target", target, "--sync", "--yes");
    expect(synced.status, synced.stderr).toBe(0);
    expect(synced.stdout).toContain("templates only");
    expect(synced.stdout).not.toContain("installed for: ");
    expect(readRepoManifest(target).harnesses).toEqual([]);
    expect(existsSync(join(target, ".claude"))).toBe(false);
  });

  it("a target with a missing harnesses field keeps today's fallback chain on a flagless apply (operator default wins)", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    // A hand-written manifest with no `harnesses` field at all: not a
    // recorded empty set, so `harnessesRecordedEmpty` sanitizes to false
    // and the sticky gate must not fire; the fallback chain
    // (operator default, then detection, then "claude") must still run.
    mkdirSync(join(target, ".ai", "workflow"), { recursive: true });
    writeFileSync(
      repoManifestPath(target),
      JSON.stringify(
        { kit: "orchestrator-workflow", version: PACKAGE_VERSION },
        null,
        2,
      ),
    );

    const result = runApply("--target", target, "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("installed for: claude");
    expect(readRepoManifest(target).harnesses).toEqual(["claude"]);
    expect(existsSync(join(target, ".claude"))).toBe(true);
  });

  it("--pin trims surrounding whitespace and applies", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const result = runApply("--target", target, "--pin", "  1.2.3  ", "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(readRepoManifest(target).pin).toBe("1.2.3");
  });

  it("rejects a --pin value containing internal whitespace, writing nothing", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const result = runApply("--target", target, "--pin", "1 2", "--yes");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid --pin value");
    expect(existsSync(repoManifestPath(target))).toBe(false);
  });

  // M3: a whitespace-only --pin trims to an empty string, the one branch of
  // apply's own pin-trim/validate logic init.ts's own trim can never reach
  // (init.ts only ever sees the already-trimmed, already-non-empty value),
  // so this is the only test that actually exercises apply's own trim
  // rather than init's.
  it("rejects a whitespace-only --pin value, writing nothing", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const result = runApply("--target", target, "--pin", "   ", "--yes");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid --pin value");
    expect(existsSync(repoManifestPath(target))).toBe(false);
  });

  it("registers the target and records PACKAGE_VERSION even when local edits conflict (the apply ran; edits were kept)", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const first = runApply("--target", target, "--yes");
    expect(first.status, first.stderr).toBe(0);

    const skillPath = join(
      target,
      ".claude",
      "skills",
      "orchestrator-workflow",
      "SKILL.md",
    );
    const original = readFileSync(skillPath, "utf8");
    writeFileSync(skillPath, `${original}\nlocal edit\n`, "utf8");

    const second = runApply("--target", target, "--yes");
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("Conflicts");

    const manifest = readOperatorManifest();
    expect(manifest.targets).toHaveLength(1);
    expect(manifest.targets[0].lastAppliedVersion).toBe(PACKAGE_VERSION);
  });

  it("prints a git-root note for a target that is not a git repository root, matching init's wording", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const result = runApply("--target", target, "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Note: the target is not a git repository root.",
    );
  });

  it("does not print 'Installing into' or the git-root note when the pin gate skips the run", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const seeded = runApply("--target", target, "--pin", "0.0.1", "--yes");
    expect(seeded.status, seeded.stderr).toBe(0);

    const result = runApply("--target", target, "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Skipping");
    expect(result.stdout).not.toContain("Installing into");
    expect(result.stdout).not.toContain(
      "Note: the target is not a git repository root.",
    );
  });

  it("warns and proceeds when the repo manifest's raw pin is malformed (non-string), and the pin gate does not run against it", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const first = runApply("--target", target, "--yes");
    expect(first.status, first.stderr).toBe(0);

    const manifestPath = repoManifestPath(target);
    const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    rawManifest.pin = 42;
    writeFileSync(
      manifestPath,
      `${JSON.stringify(rawManifest, null, 2)}\n`,
      "utf8",
    );

    const result = runApply("--target", target, "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Ignoring a malformed pin in");
    expect(result.stderr).toContain("the pin gate did not run");
  });

  it("registers a target reached through a symlink under its realpath, and the printed line matches the stored path", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const link = join(tmpdir(), `apply-target-link-${process.pid}`);
    symlinkSync(target, link);
    try {
      const result = runApply("--target", link, "--yes");
      expect(result.status, result.stderr).toBe(0);

      const realTarget = realpathSync(target);
      expect(result.stdout).toContain(
        `Registered ${realTarget} in the operator manifest`,
      );

      const manifest = readOperatorManifest();
      expect(manifest.targets).toHaveLength(1);
      expect(manifest.targets[0].path).toBe(realTarget);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it("normalizes a target stored under a raw symlink path to its realpath on re-apply, and reports Refreshed (L6/L7)", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const first = runApply("--target", target, "--yes");
    expect(first.status, first.stderr).toBe(0);

    // Overwrite the stored entry with a raw, non-realpath value, as a
    // hand-edited or pre-normalization manifest might carry.
    const link = join(tmpdir(), `apply-target-stored-link-${process.pid}`);
    symlinkSync(target, link);
    try {
      const manifest = readOperatorManifest();
      manifest.targets[0].path = link;
      writeFileSync(
        operatorManifestPath(),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );

      const result = runApply("--target", target, "--yes");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `Refreshed the registry entry for ${realpathSync(target)}`,
      );

      const after = readOperatorManifest();
      expect(after.targets).toHaveLength(1);
      expect(after.targets[0].path).toBe(realpathSync(target));
    } finally {
      rmSync(link, { force: true });
    }
  });

  it("reports an unreadable operator manifest distinctly from an absent one, and touches nothing", () => {
    writeFileSync(operatorManifestPath(), "{not valid json", "utf8");
    const before = existsSync(target) ? readdirSync(target) : [];

    const result = runApply("--target", target, "--yes");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Operator manifest at ${operatorManifestPath()} is unreadable; back it up and repair it, or remove it and run \`orchestrator-workflow setup\` again.`,
    );
    expect(readdirSync(target)).toEqual(before);
  });

  describe("concurrent applies against the same operator home", () => {
    // Protects the upsert path against silently dropping an unrelated,
    // already-registered target on a sequential re-apply. See docs/okf/log.md
    // for the fix-round history (fix-round-1's re-read, fix-round-2's lock,
    // fix-round-3's setup/apply interleave and lock-hardening tests below).
    it("a target registered directly in the manifest between two sequential applies is not clobbered by the second apply's own registration", () => {
      const setup = runSetup("--yes");
      expect(setup.status, setup.stderr).toBe(0);
      const first = runApply("--target", target, "--yes");
      expect(first.status, first.stderr).toBe(0);

      const other = mkdtempSync(join(tmpdir(), "apply-target-other-"));
      try {
        const manifest = readOperatorManifest();
        manifest.targets.push({
          path: realpathSync(other),
          lastAppliedVersion: "9.9.9",
          lastAppliedAt: "2020-01-01T00:00:00.000Z",
        });
        writeFileSync(
          operatorManifestPath(),
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        );

        const second = runApply("--target", target, "--yes");
        expect(second.status, second.stderr).toBe(0);

        const after = readOperatorManifest();
        const paths = after.targets.map((t: { path: string }) => t.path);
        expect(paths).toContain(realpathSync(target));
        expect(paths).toContain(realpathSync(other));
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it("all N simultaneously-started applies register their own target, across several iterations, with the manifest lock in place", async () => {
      const setup = runSetup("--yes");
      expect(setup.status, setup.stderr).toBe(0);

      const TARGET_COUNT = 4;
      const ITERATIONS = 3;

      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const targets = Array.from({ length: TARGET_COUNT }, () =>
          mkdtempSync(join(tmpdir(), `apply-target-race-${iteration}-`)),
        );
        try {
          const results = await Promise.all(
            targets.map((t) => runApplyAsync("--target", t, "--yes")),
          );
          for (const result of results) {
            expect(result.status, result.stderr).toBe(0);
          }

          const manifest = readOperatorManifest();
          expect(manifest.kit).toBe("orchestrator-workflow");
          const registeredPaths = new Set(
            manifest.targets.map((t: { path: string }) => t.path),
          );
          for (const t of targets) {
            expect(registeredPaths.has(realpathSync(t))).toBe(true);
          }
          for (const t of manifest.targets) {
            expect(t.lastAppliedVersion).toBe(PACKAGE_VERSION);
          }
        } finally {
          for (const t of targets) rmSync(t, { recursive: true, force: true });
        }
      }
    }, 60_000);

    // H1 (fix-round-3): `setup` used to write `{...existing, ...}` back
    // unlocked, `existing` being a plain, unlocked read taken before its own
    // prompts/resolution ran; a target `apply` registered in that window
    // was silently dropped by setup's own write. `setup` now goes through
    // `updateOperatorManifest` like `apply` does, merging its new defaults
    // onto a manifest re-read inside the same lock. This asserts both a
    // concurrently-registered target and a concurrently-changed default
    // survive, across 5 iterations.
    it("setup running concurrently with apply preserves both the target apply registers and setup's own default change", async () => {
      const setup0 = runSetup("--yes");
      expect(setup0.status, setup0.stderr).toBe(0);

      for (let iteration = 0; iteration < 5; iteration++) {
        const targetA = mkdtempSync(
          join(tmpdir(), `apply-target-h1-a-${iteration}-`),
        );
        const targetB = mkdtempSync(
          join(tmpdir(), `apply-target-h1-b-${iteration}-`),
        );
        try {
          const firstA = runApply("--target", targetA, "--yes");
          expect(firstA.status, firstA.stderr).toBe(0);

          const [setupResult, applyBResult] = await Promise.all([
            runSetupAsync("--profile", "minimal", "--yes"),
            runApplyAsync("--target", targetB, "--yes"),
          ]);
          expect(setupResult.status, setupResult.stderr).toBe(0);
          expect(applyBResult.status, applyBResult.stderr).toBe(0);

          const manifest = readOperatorManifest();
          const paths = manifest.targets.map((t: { path: string }) => t.path);
          expect(paths).toContain(realpathSync(targetA));
          expect(paths).toContain(realpathSync(targetB));
          expect(manifest.defaults.profile).toBe("minimal");
        } finally {
          rmSync(targetA, { recursive: true, force: true });
          rmSync(targetB, { recursive: true, force: true });
        }
      }
    }, 60_000);
  });

  describe("pin gate", () => {
    function seedPinnedTarget(pin: string) {
      const setup = runSetup("--yes");
      expect(setup.status, setup.stderr).toBe(0);
      const seeded = runApply("--target", target, "--pin", pin, "--yes");
      expect(seeded.status, seeded.stderr).toBe(0);
      expect(readRepoManifest(target).pin).toBe(pin);
    }

    it("skips a target pinned to a different version, leaving files and the registry untouched", () => {
      seedPinnedTarget("0.0.1");
      const before = snapshot(target);
      const beforeTarget = readOperatorManifest().targets[0];

      const result = runApply("--target", target, "--yes");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Skipping");

      expect(snapshot(target)).toEqual(before);
      expect(readOperatorManifest().targets[0]).toEqual(beforeTarget);
    });

    it("--force-pin proceeds and advances the pin to PACKAGE_VERSION", () => {
      seedPinnedTarget("0.0.1");

      const result = runApply("--target", target, "--force-pin", "--yes");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("Skipping");
      expect(readRepoManifest(target).pin).toBe(PACKAGE_VERSION);
    });

    it("--force-pin on an unpinned target proceeds normally and does not create a pin", () => {
      const setup = runSetup("--yes");
      expect(setup.status, setup.stderr).toBe(0);

      const result = runApply("--target", target, "--force-pin", "--yes");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("Skipping");
      expect(readRepoManifest(target).pin).toBeUndefined();
    });

    it("--pin <version> proceeds and sets the pin to that version", () => {
      seedPinnedTarget("0.0.1");

      const result = runApply("--target", target, "--pin", "1.2.3", "--yes");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("Skipping");
      expect(readRepoManifest(target).pin).toBe("1.2.3");
    });

    it("--unpin proceeds and clears the pin", () => {
      seedPinnedTarget("0.0.1");

      const result = runApply("--target", target, "--unpin", "--yes");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("Skipping");
      expect(readRepoManifest(target).pin).toBeUndefined();
    });

    it("rejects --pin combined with --unpin as a usage error", () => {
      const setup = runSetup("--yes");
      expect(setup.status, setup.stderr).toBe(0);

      const result = runApply(
        "--target",
        target,
        "--pin",
        "1.2.3",
        "--unpin",
        "--yes",
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "--pin and --unpin cannot be used together",
      );
      expect(existsSync(repoManifestPath(target))).toBe(false);
    });
  });
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256File } from "../src/hash.js";
import { readMarkerFor, writeMarker } from "../src/lock.js";
import { beginInplace } from "../src/probe/isolation.js";
import { probe } from "../src/probe/index.js";
import { recoverTargetMarker } from "../src/probe/setup.js";

const posix = process.platform !== "win32";
const maybe = posix ? describe : describe.skip;

const roots: string[] = [];
function temp(): string {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "stale-marker-mode-")),
  );
  roots.push(d);
  return d;
}
const savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
afterEach(() => {
  if (savedLockDir === undefined) delete process.env.AGENT_PRIMITIVES_LOCK_DIR;
  else process.env.AGENT_PRIMITIVES_LOCK_DIR = savedLockDir;
  for (const d of roots.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function mode(p: string): number {
  return fs.statSync(p).mode & 0o7777;
}

const ORIGINAL = "original content\n";
const MUTATED = "mutated content\n";

/** A target left mutated by a killed probe, with a private (0600) backup
 * holding the original, as `beginInplace` makes it. `recordMode` is the
 * mode the marker carries (`false`: an old-format marker without it). */
async function leftBehind(
  targetMode: number,
  recordMode: boolean,
  mutatedMode = targetMode,
): Promise<{ file: string; key: string }> {
  process.env.AGENT_PRIMITIVES_LOCK_DIR = temp();
  const dir = temp();
  const file = path.join(dir, "fixture.js");
  fs.writeFileSync(file, ORIGINAL);
  fs.chmodSync(file, targetMode);
  const session = beginInplace(file, temp(), dir);
  expect(mode(session.backupPath)).toBe(0o600);
  const preHash = await sha256File(file);
  fs.writeFileSync(file, MUTATED);
  fs.chmodSync(file, mutatedMode);
  const mutatedHash = await sha256File(file);
  writeMarker(file, {
    targetPath: file,
    backupPath: session.backupPath,
    preHash,
    mutatedHash,
    pid: 999_999,
    timestamp: new Date().toISOString(),
    ...(recordMode ? { targetMode: session.targetMode } : {}),
  });
  return { file, key: file };
}

maybe("stale-marker recovery restores the target's mode", () => {
  for (const wanted of [0o644, 0o755]) {
    it(`recovers a ${wanted.toString(8)} target as ${wanted.toString(8)}, not as the 0600 backup`, async () => {
      const { file, key } = await leftBehind(wanted, true);
      const warnings: string[] = [];
      const res = await recoverTargetMarker(file, key, warnings);
      expect(res).toBeUndefined();
      expect(warnings).toContain("recovered_stale_probe");
      expect(fs.readFileSync(file, "utf8")).toBe(ORIGINAL);
      expect(mode(file)).toBe(wanted);
    });
  }

  it("the recorded mode wins over the mutated file's current mode", async () => {
    const { file, key } = await leftBehind(0o755, true, 0o640);
    await recoverTargetMarker(file, key, []);
    expect(mode(file)).toBe(0o755);
  });

  it("an old-format marker without a mode falls back to the target's current mode", async () => {
    const { file, key } = await leftBehind(0o755, false);
    expect(readMarkerFor(key)?.targetMode).toBeUndefined();
    await recoverTargetMarker(file, key, []);
    expect(fs.readFileSync(file, "utf8")).toBe(ORIGINAL);
    expect(mode(file)).toBe(0o755);
  });

  it("an old-format marker for a deleted target falls back to the default new-file mode", async () => {
    const { file, key } = await leftBehind(0o755, false);
    const marker = readMarkerFor(key)!;
    fs.rmSync(file);
    const { DELETED_FILE_HASH } = await import("../src/probe/mutant.js");
    writeMarker(key, { ...marker, mutatedHash: DELETED_FILE_HASH });
    const warnings: string[] = [];
    await recoverTargetMarker(file, key, warnings);
    expect(warnings).toContain("recovered_stale_probe");
    const umask = process.umask();
    expect(mode(file)).toBe(0o666 & ~umask);
  });

  it("a recorded mode restores a deleted target too", async () => {
    const { file, key } = await leftBehind(0o755, true);
    const marker = readMarkerFor(key)!;
    fs.rmSync(file);
    const { DELETED_FILE_HASH } = await import("../src/probe/mutant.js");
    writeMarker(key, { ...marker, mutatedHash: DELETED_FILE_HASH });
    await recoverTargetMarker(file, key, []);
    expect(mode(file)).toBe(0o755);
  });
});

maybe("an inplace probe records the target's mode in its marker", () => {
  it("writes targetMode for a 0755 target while the mutant runs", async () => {
    process.env.AGENT_PRIMITIVES_LOCK_DIR = temp();
    const lockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
    const repo = temp();
    const run = (args: string[]): void => {
      execFileSync("git", args, { cwd: repo });
    };
    run(["init", "-q"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "t"]);
    const target = path.join(repo, "a.txt");
    fs.writeFileSync(target, "one\ntwo\n");
    fs.chmodSync(target, 0o755);
    run(["add", "-A"]);
    run(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    const out = path.join(temp(), "marker.json");
    await probe({
      file: "a.txt",
      line: 1,
      form: "replace",
      replaceText: "uno",
      testCommand: `cp "${lockDir}"/*.marker.json "${out}" 2>/dev/null; exit 0`,
      isolation: "inplace",
      expect: "pass",
      cwd: repo,
      logDir: temp(),
    });
    const marker = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(marker.targetMode).toBe(0o755);
    expect(mode(target)).toBe(0o755);
  });
});

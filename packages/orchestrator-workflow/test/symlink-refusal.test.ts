import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readInstalledManifest, runInit } from "../src/init.js";
import { DEFAULT_MODELS } from "../src/models.js";
import { OPERATOR_HOME_ENV } from "../src/operator-manifest.js";
import { SymlinkRefusedError, TargetFs } from "../src/target-fs.js";
import { runUninstall } from "../src/uninstall.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

const VICTIM_CONTENT = "# not the kit's file\n\nsecret local content\n";

let base: string;
let repo: string;
let outside: string;
let victim: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "orchestrator-symlink-"));
  repo = join(base, "repo");
  outside = join(base, "outside");
  mkdirSync(repo);
  mkdirSync(outside);
  victim = join(outside, "victim.txt");
  writeFileSync(victim, VICTIM_CONTENT);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const initOptions = (
  harnesses: ("claude" | "codex" | "opencode")[] = ["claude"],
  extra: { force?: boolean; tiers?: boolean } = {},
) => ({
  targetDir: repo,
  harnesses,
  models: { ...DEFAULT_MODELS },
  ...extra,
});

const ALL_HARNESSES: ("claude" | "codex" | "opencode")[] = [
  "claude",
  "codex",
  "opencode",
];

/** Every entry below `dir`, relative, links not followed. */
function entries(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : join(prefix, entry.name);
    out.push(rel);
    if (entry.isDirectory()) out.push(...entries(join(dir, entry.name), rel));
  }
  return out.sort();
}

function expectVictimUntouched(): void {
  expect(readFileSync(victim, "utf8")).toBe(VICTIM_CONTENT);
  expect(entries(outside)).toEqual(["victim.txt"]);
}

describe("TargetFs", () => {
  it("assertSafe accepts a regular tree, missing paths, and a symlinked root", () => {
    mkdirSync(join(repo, "a"));
    writeFileSync(join(repo, "a", "f.txt"), "x");
    const fs = new TargetFs(repo);
    expect(() => fs.assertSafe(join(repo, "a", "f.txt"))).not.toThrow();
    expect(() =>
      fs.assertSafe(join(repo, "missing", "deep", "f")),
    ).not.toThrow();
    expect(() => fs.assertSafe(repo)).not.toThrow();

    const rootLink = join(base, "root-link");
    symlinkSync(repo, rootLink);
    const linked = new TargetFs(rootLink);
    expect(() => linked.assertSafe(join(rootLink, "a", "f.txt"))).not.toThrow();
    expect(linked.readText(join(rootLink, "a", "f.txt"))).toBe("x");
  });

  it("assertSafe throws SymlinkRefusedError for a file link, a dangling link, and a parent link", () => {
    const fs = new TargetFs(repo);
    symlinkSync(victim, join(repo, "file-link"));
    symlinkSync(join(outside, "nope"), join(repo, "dangling"));
    symlinkSync(outside, join(repo, "dir-link"));

    expect(() => fs.assertSafe(join(repo, "file-link"))).toThrow(
      SymlinkRefusedError,
    );
    expect(() => fs.assertSafe(join(repo, "dangling"))).toThrow(
      SymlinkRefusedError,
    );
    expect(() => fs.assertSafe(join(repo, "dir-link", "x", "y"))).toThrow(
      SymlinkRefusedError,
    );
  });

  it("the error names the link, what it points to, and the way out", () => {
    const fs = new TargetFs(repo);
    symlinkSync(outside, join(repo, "dir-link"));
    let error: unknown;
    try {
      fs.assertSafe(join(repo, "dir-link", "AGENTS.md"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SymlinkRefusedError);
    const refused = error as SymlinkRefusedError;
    expect(refused.linkPath).toBe(join(repo, "dir-link"));
    expect(refused.requestedPath).toBe(join(repo, "dir-link", "AGENTS.md"));
    expect(refused.message).toContain(join(repo, "dir-link"));
    expect(refused.message).toContain(outside);
    expect(refused.message).toContain("Replace the link with a regular file");
  });

  it("assertSafe refuses a path outside the target", () => {
    const fs = new TargetFs(repo);
    expect(() => fs.assertSafe(victim)).toThrow(/outside the target/);
    expect(() =>
      fs.assertSafe(join(repo, "..", "outside", "victim.txt")),
    ).toThrow(/outside the target/);
  });

  it("exists refuses a link and reports real entries and absent ones", () => {
    writeFileSync(join(repo, "real.txt"), "x");
    symlinkSync(victim, join(repo, "link.txt"));
    symlinkSync(join(outside, "nope"), join(repo, "dangling.txt"));
    const fs = new TargetFs(repo);
    expect(fs.exists(join(repo, "real.txt"))).toBe(true);
    expect(fs.exists(join(repo, "absent.txt"))).toBe(false);
    expect(() => fs.exists(join(repo, "link.txt"))).toThrow(
      SymlinkRefusedError,
    );
    expect(() => fs.exists(join(repo, "dangling.txt"))).toThrow(
      SymlinkRefusedError,
    );
  });

  it("kind refuses a link and classifies real entries", () => {
    writeFileSync(join(repo, "real.txt"), "x");
    mkdirSync(join(repo, "dir"));
    symlinkSync(victim, join(repo, "link.txt"));
    const fs = new TargetFs(repo);
    expect(fs.kind(join(repo, "real.txt"))).toBe("file");
    expect(fs.kind(join(repo, "dir"))).toBe("directory");
    expect(fs.kind(join(repo, "absent"))).toBeUndefined();
    expect(() => fs.kind(join(repo, "link.txt"))).toThrow(SymlinkRefusedError);
  });

  it("readText refuses a link and never returns the outside content", () => {
    symlinkSync(victim, join(repo, "link.txt"));
    const fs = new TargetFs(repo);
    expect(() => fs.readText(join(repo, "link.txt"))).toThrow(
      SymlinkRefusedError,
    );
  });

  it("writeText refuses a file link, a dangling link, and a linked parent, leaving the outside untouched", () => {
    symlinkSync(victim, join(repo, "link.txt"));
    symlinkSync(join(outside, "created"), join(repo, "dangling.txt"));
    symlinkSync(outside, join(repo, "dir-link"));
    const fs = new TargetFs(repo);
    expect(() => fs.writeText(join(repo, "link.txt"), "kit")).toThrow(
      SymlinkRefusedError,
    );
    expect(() => fs.writeText(join(repo, "dangling.txt"), "kit")).toThrow(
      SymlinkRefusedError,
    );
    expect(() =>
      fs.writeText(join(repo, "dir-link", "new", "f"), "kit"),
    ).toThrow(SymlinkRefusedError);
    expectVictimUntouched();
  });

  it("writeText creates missing parents and the file in a normal tree", () => {
    const fs = new TargetFs(repo);
    fs.writeText(join(repo, "a", "b", "f.txt"), "kit");
    expect(readFileSync(join(repo, "a", "b", "f.txt"), "utf8")).toBe("kit");
  });

  it("writeText in dry-run mode checks and writes nothing", () => {
    symlinkSync(victim, join(repo, "link.txt"));
    const dry = new TargetFs(repo, { dryRun: true });
    dry.writeText(join(repo, "a", "f.txt"), "kit");
    expect(existsSync(join(repo, "a"))).toBe(false);
    expect(() => dry.writeText(join(repo, "link.txt"), "kit")).toThrow(
      SymlinkRefusedError,
    );
  });

  it("removeFile and removeDir in dry-run mode check and remove nothing", () => {
    writeFileSync(join(repo, "real.txt"), "x");
    mkdirSync(join(repo, "empty"));
    symlinkSync(victim, join(repo, "link.txt"));
    const dry = new TargetFs(repo, { dryRun: true });
    dry.removeFile(join(repo, "real.txt"));
    dry.removeDir(join(repo, "empty"));
    expect(existsSync(join(repo, "real.txt"))).toBe(true);
    expect(existsSync(join(repo, "empty"))).toBe(true);
    expect(() => dry.removeFile(join(repo, "link.txt"))).toThrow(
      SymlinkRefusedError,
    );
    expect(() => dry.removeDir(join(repo, "link.txt"))).toThrow(
      SymlinkRefusedError,
    );
  });

  it("removeFile refuses a file link and a file below a linked directory", () => {
    writeFileSync(join(outside, "inner.txt"), "keep");
    symlinkSync(outside, join(repo, "dir-link"));
    symlinkSync(victim, join(repo, "link.txt"));
    const fs = new TargetFs(repo);
    expect(() => fs.removeFile(join(repo, "dir-link", "inner.txt"))).toThrow(
      SymlinkRefusedError,
    );
    expect(() => fs.removeFile(join(repo, "link.txt"))).toThrow(
      SymlinkRefusedError,
    );
    expect(readFileSync(join(outside, "inner.txt"), "utf8")).toBe("keep");
    expect(lstatSync(join(repo, "link.txt")).isSymbolicLink()).toBe(true);
  });

  it("removeDir refuses a directory below a link and removes an empty real one", () => {
    mkdirSync(join(outside, "empty"));
    symlinkSync(outside, join(repo, "dir-link"));
    mkdirSync(join(repo, "real-empty"));
    const fs = new TargetFs(repo);
    expect(() => fs.removeDir(join(repo, "dir-link", "empty"))).toThrow(
      SymlinkRefusedError,
    );
    expect(existsSync(join(outside, "empty"))).toBe(true);
    fs.removeDir(join(repo, "real-empty"));
    expect(existsSync(join(repo, "real-empty"))).toBe(false);
  });

  it("opens with O_NOFOLLOW even when the walk is bypassed (a link planted after the check)", () => {
    // Simulates the race between the lstat walk and the open: the walk is
    // overridden to pass, so only the open flags stand between the link and
    // the outside file.
    class Unchecked extends TargetFs {
      override assertSafe(): void {}
    }
    symlinkSync(victim, join(repo, "link.txt"));
    const fs = new Unchecked(repo);
    expect(() => fs.writeText(join(repo, "link.txt"), "kit")).toThrow(/ELOOP/);
    expect(() => fs.readText(join(repo, "link.txt"))).toThrow(/ELOOP/);
    expectVictimUntouched();
  });
});

describe("init refuses symlinked targets", () => {
  it("AGENTS.md linked to an existing outside file: outside byte-identical, nothing else written", () => {
    symlinkSync(victim, join(repo, "AGENTS.md"));
    expect(() => runInit(initOptions())).toThrow(SymlinkRefusedError);
    expectVictimUntouched();
    expect(entries(repo)).toEqual(["AGENTS.md"]);
    expect(lstatSync(join(repo, "AGENTS.md")).isSymbolicLink()).toBe(true);
  });

  it("CLAUDE.md linked to an existing outside file: outside byte-identical, nothing else written", () => {
    symlinkSync(victim, join(repo, "CLAUDE.md"));
    expect(() => runInit(initOptions())).toThrow(SymlinkRefusedError);
    expectVictimUntouched();
    expect(entries(repo)).toEqual(["CLAUDE.md"]);
  });

  it("AGENTS.md linked to a dangling path: nothing is created at the link target", () => {
    const created = join(outside, "created-through-link.txt");
    symlinkSync(created, join(repo, "AGENTS.md"));
    expect(() => runInit(initOptions())).toThrow(SymlinkRefusedError);
    expect(existsSync(created)).toBe(false);
    expectVictimUntouched();
    expect(entries(repo)).toEqual(["AGENTS.md"]);
  });

  it("CLAUDE.md linked to a dangling path: nothing is created at the link target", () => {
    const created = join(outside, "created-through-link.txt");
    symlinkSync(created, join(repo, "CLAUDE.md"));
    expect(() => runInit(initOptions())).toThrow(SymlinkRefusedError);
    expect(existsSync(created)).toBe(false);
    expect(entries(repo)).toEqual(["CLAUDE.md"]);
  });

  it("CLAUDE.md linked to the repo's own AGENTS.md is refused too (no self-import is appended)", () => {
    writeFileSync(join(repo, "AGENTS.md"), "# House rules\n");
    symlinkSync("AGENTS.md", join(repo, "CLAUDE.md"));
    expect(() => runInit(initOptions())).toThrow(SymlinkRefusedError);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(
      "# House rules\n",
    );
  });

  it.each([
    ["claude", ".claude"],
    ["codex", ".codex"],
    ["codex", ".agents"],
    ["opencode", ".opencode"],
  ] as const)(
    "a symlinked %s directory (%s) refuses the whole run before the first write",
    (harness, dir) => {
      symlinkSync(outside, join(repo, dir));
      expect(() => runInit(initOptions([harness]))).toThrow(
        SymlinkRefusedError,
      );
      expectVictimUntouched();
      // Whole-run refusal: not even the templates, AGENTS.md or the
      // manifest, which a per-file refusal would already have written.
      expect(entries(repo)).toEqual([dir]);
    },
  );

  it("a symlinked .ai directory refuses the run", () => {
    symlinkSync(outside, join(repo, ".ai"));
    expect(() => runInit(initOptions())).toThrow(SymlinkRefusedError);
    expectVictimUntouched();
    expect(entries(repo)).toEqual([".ai"]);
  });

  it("a symlinked subdirectory deep in the chain refuses the whole run", () => {
    mkdirSync(join(repo, ".claude"));
    symlinkSync(outside, join(repo, ".claude", "agents"));
    expect(() => runInit(initOptions())).toThrow(SymlinkRefusedError);
    expectVictimUntouched();
    expect(entries(repo)).toEqual([".claude", ".claude/agents"]);
  });

  it("a link at the last harness refuses the run before the earlier harnesses write anything", () => {
    symlinkSync(outside, join(repo, ".opencode"));
    expect(() => runInit(initOptions(ALL_HARNESSES))).toThrow(
      SymlinkRefusedError,
    );
    expect(entries(repo)).toEqual([".opencode"]);
    expectVictimUntouched();
  });

  it("a kit file linked to an outside file is refused, also with force", () => {
    runInit(initOptions());
    const kitFile = join(repo, ".claude", "agents", "implementer.md");
    rmSync(kitFile);
    symlinkSync(victim, kitFile);
    expect(() => runInit(initOptions(["claude"], { force: true }))).toThrow(
      SymlinkRefusedError,
    );
    expectVictimUntouched();
  });

  it("a linked skill file is refused", () => {
    runInit(initOptions());
    const skill = join(
      repo,
      ".claude",
      "skills",
      "orchestrator-workflow",
      "SKILL.md",
    );
    rmSync(skill);
    symlinkSync(victim, skill);
    expect(() => runInit(initOptions())).toThrow(SymlinkRefusedError);
    expectVictimUntouched();
  });

  it("a linked manifest is refused instead of read as the install record", () => {
    runInit(initOptions());
    const manifest = join(repo, ".ai", "workflow", "manifest.json");
    const real = readFileSync(manifest, "utf8");
    rmSync(manifest);
    writeFileSync(join(outside, "manifest.json"), real);
    symlinkSync(join(outside, "manifest.json"), manifest);
    expect(() => readInstalledManifest(repo)).toThrow(SymlinkRefusedError);
    expect(() => runInit(initOptions())).toThrow(SymlinkRefusedError);
    expect(readFileSync(join(outside, "manifest.json"), "utf8")).toBe(real);
  });

  it("a symlinked target root works and installs into the real directory", () => {
    const rootLink = join(base, "repo-link");
    symlinkSync(repo, rootLink);
    const report = runInit({ ...initOptions(), targetDir: rootLink });
    expect(report.written.length).toBeGreaterThan(5);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "agents", "implementer.md"))).toBe(
      true,
    );
    expect(lstatSync(rootLink).isSymbolicLink()).toBe(true);
    expect(() => readInstalledManifest(rootLink)).not.toThrow();
  });

  it("links the kit does not touch are left alone", () => {
    symlinkSync(outside, join(repo, "docs"));
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
    symlinkSync(outside, join(repo, ".claude", "skills", "my-own-skill"));
    const report = runInit(initOptions());
    expect(report.written.length).toBeGreaterThan(5);
    expectVictimUntouched();
  });

  it("a normal repository installs, is idempotent, and merges an existing AGENTS.md as before", () => {
    writeFileSync(join(repo, "AGENTS.md"), "# Repo\n\nHouse rules.\n");
    const first = runInit(initOptions(ALL_HARNESSES));
    expect(first.conflicted).toEqual([]);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toContain(
      "House rules.",
    );
    const second = runInit(initOptions(ALL_HARNESSES));
    expect(second.written).toEqual([]);
    expect(second.updated).toEqual([]);
  });
});

describe("uninstall refuses symlinked targets", () => {
  beforeEach(() => {
    runInit(initOptions(ALL_HARNESSES));
  });

  const kitSnapshot = () => entries(repo);

  it("AGENTS.md replaced by a link to an outside file: outside untouched, nothing removed", () => {
    const before = kitSnapshot();
    rmSync(join(repo, "AGENTS.md"));
    writeFileSync(
      victim,
      `${VICTIM_CONTENT}<!-- orchestrator-workflow:begin -->\nx\n<!-- orchestrator-workflow:end -->\n`,
    );
    const victimBytes = readFileSync(victim, "utf8");
    symlinkSync(victim, join(repo, "AGENTS.md"));

    expect(() => runUninstall({ targetDir: repo })).toThrow(
      SymlinkRefusedError,
    );
    expect(readFileSync(victim, "utf8")).toBe(victimBytes);
    // Refused before the first removal: every kit file is still there.
    expect(kitSnapshot()).toEqual(before);
  });

  it("CLAUDE.md replaced by a dangling link: refused, nothing removed", () => {
    const before = kitSnapshot();
    rmSync(join(repo, "CLAUDE.md"));
    symlinkSync(join(outside, "nope"), join(repo, "CLAUDE.md"));
    expect(() => runUninstall({ targetDir: repo })).toThrow(
      SymlinkRefusedError,
    );
    expect(kitSnapshot()).toEqual(before);
    expectVictimUntouched();
  });

  it("a ledger file replaced by a link: refused before any removal, outside untouched", () => {
    const before = kitSnapshot();
    // The last file the install records, so a per-file refusal would already
    // have removed everything recorded before it.
    const kitFile = join(repo, ".opencode", "agents", "implementer.md");
    rmSync(kitFile);
    symlinkSync(victim, kitFile);
    expect(kitSnapshot()).toEqual(before);

    expect(() => runUninstall({ targetDir: repo, force: true })).toThrow(
      SymlinkRefusedError,
    );
    expect(kitSnapshot()).toEqual(before);
    expectVictimUntouched();
  });

  it("a directory of the kit replaced by a link: refused, files below it are never removed through it", () => {
    // Move the real .opencode tree out of the repo and link it back in: the
    // ledger paths now lie below a link that points at a real kit tree.
    const moved = join(outside, "moved-opencode");
    renameSync(join(repo, ".opencode"), moved);
    symlinkSync(moved, join(repo, ".opencode"));
    const before = kitSnapshot();
    const movedBefore = entries(moved);

    expect(() => runUninstall({ targetDir: repo, force: true })).toThrow(
      SymlinkRefusedError,
    );
    expect(entries(moved)).toEqual(movedBefore);
    expect(kitSnapshot()).toEqual(before);
  });

  it("a linked runs directory no ledger entry lies below is left alone and does not abort the run", () => {
    const runsDir = join(repo, ".ai", "runs");
    const manifestPath = join(repo, ".ai", "workflow", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.files[join(".ai", "runs", ".gitkeep")];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    rmSync(runsDir, { recursive: true });
    mkdirSync(join(outside, "runs-target"));
    symlinkSync(join(outside, "runs-target"), runsDir);

    const report = runUninstall({ targetDir: repo });
    expect(lstatSync(runsDir).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, "runs-target"))).toBe(true);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
    expect(
      report.notes.some(
        (note) => note.includes("runs") && note.includes("symbolic link"),
      ),
    ).toBe(true);
  });

  it("a linked manifest is refused", () => {
    const manifest = join(repo, ".ai", "workflow", "manifest.json");
    const real = readFileSync(manifest, "utf8");
    rmSync(manifest);
    writeFileSync(join(outside, "manifest.json"), real);
    symlinkSync(join(outside, "manifest.json"), manifest);
    expect(() => runUninstall({ targetDir: repo })).toThrow(
      SymlinkRefusedError,
    );
    expect(readFileSync(join(outside, "manifest.json"), "utf8")).toBe(real);
  });

  it("works through a symlinked root and removes the kit from the real directory", () => {
    const rootLink = join(base, "repo-link");
    symlinkSync(repo, rootLink);
    const report = runUninstall({ targetDir: rootLink });
    expect(report.removed.length).toBeGreaterThan(10);
    expect(readdirSync(repo)).toEqual([]);
  });

  it("a linked, empty prune candidate is skipped with a note and the outside directory survives", () => {
    runUninstall({ targetDir: repo });
    // A fresh claude-only install, then a link where the kit never wrote.
    runInit(initOptions(["claude"]));
    mkdirSync(join(outside, "agents-dir"));
    symlinkSync(join(outside, "agents-dir"), join(repo, ".opencode"));

    const report = runUninstall({ targetDir: repo });
    expect(existsSync(join(outside, "agents-dir"))).toBe(true);
    expect(lstatSync(join(repo, ".opencode")).isSymbolicLink()).toBe(true);
    expect(
      report.notes.some(
        (note) => note.includes(".opencode") && note.includes("symbolic link"),
      ),
    ).toBe(true);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
  });

  it("a normal uninstall is unchanged", () => {
    const report = runUninstall({ targetDir: repo });
    expect(report.kept).toEqual([]);
    expect(readdirSync(repo)).toEqual([]);
  });
});

describe("cli entry points", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "orchestrator-symlink-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const runCli = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, [OPERATOR_HOME_ENV]: home },
    });

  it("init exits non-zero naming the link, and writes nothing", () => {
    symlinkSync(victim, join(repo, "AGENTS.md"));
    const result = runCli("init", repo, "--yes", "--harness", "claude");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(repo, "AGENTS.md"));
    expect(result.stderr).toContain("symbolic link");
    expect(result.stderr).toContain("Replace the link with a regular file");
    expectVictimUntouched();
    expect(entries(repo)).toEqual(["AGENTS.md"]);
  });

  it("init through a dangling CLAUDE.md creates nothing at the link target", () => {
    const created = join(outside, "created-through-link.txt");
    symlinkSync(created, join(repo, "CLAUDE.md"));
    const result = runCli("init", repo, "--yes", "--harness", "claude");
    expect(result.status).toBe(1);
    expect(existsSync(created)).toBe(false);
    expect(entries(repo)).toEqual(["CLAUDE.md"]);
  });

  it("init on a symlinked checkout root works", () => {
    const rootLink = join(base, "repo-link");
    symlinkSync(repo, rootLink);
    const result = runCli("init", rootLink, "--yes", "--harness", "claude");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(repo, ".claude", "agents", "implementer.md"))).toBe(
      true,
    );
  });

  it("apply exits non-zero naming the link, and writes nothing", () => {
    expect(runCli("setup", "--yes").status).toBe(0);
    symlinkSync(victim, join(repo, "AGENTS.md"));
    const result = runCli("apply", "--target", repo, "--yes");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(join(repo, "AGENTS.md"));
    expect(result.stderr).toContain("symbolic link");
    expectVictimUntouched();
    expect(entries(repo)).toEqual(["AGENTS.md"]);
  });

  it("apply through a linked parent directory writes nothing outside", () => {
    expect(runCli("setup", "--yes").status).toBe(0);
    mkdirSync(join(repo, ".claude"));
    symlinkSync(outside, join(repo, ".claude", "agents"));
    const result = runCli("apply", "--target", repo, "--yes");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("symbolic link");
    expectVictimUntouched();
    expect(existsSync(join(repo, ".ai"))).toBe(false);
  });

  it("uninstall exits non-zero naming the link, and removes nothing", () => {
    expect(runCli("init", repo, "--yes", "--harness", "claude").status).toBe(0);
    const before = entries(repo);
    rmSync(join(repo, "AGENTS.md"));
    symlinkSync(victim, join(repo, "AGENTS.md"));
    const result = runCli("uninstall", repo, "--yes");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(repo, "AGENTS.md"));
    expect(result.stderr).toContain("symbolic link");
    expectVictimUntouched();
    expect(entries(repo)).toEqual(before);
  });

  it("adopt reports a linked manifest as a usage error and registers nothing", () => {
    runInit(initOptions());
    const manifest = join(repo, ".ai", "workflow", "manifest.json");
    const real = readFileSync(manifest, "utf8");
    rmSync(manifest);
    writeFileSync(join(outside, "manifest.json"), real);
    symlinkSync(join(outside, "manifest.json"), manifest);

    const result = runCli("adopt", repo, "--json");
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error).toBe("symlinked-repo-manifest");
    expect(parsed.message).toContain("symbolic link");
    expect(existsSync(join(home, "manifest.json"))).toBe(false);
  });
});

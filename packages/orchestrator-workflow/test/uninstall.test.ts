import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInit } from "../src/init.js";
import { runUninstall } from "../src/uninstall.js";
import { DEFAULT_MODELS } from "../src/models.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let target: string;

beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), "orchestrator-uninstall-"));
});

afterEach(() => {
  rmSync(target, { recursive: true, force: true });
});

const initAll = () =>
  runInit({
    targetDir: target,
    harnesses: ["claude", "codex", "opencode"],
    models: { ...DEFAULT_MODELS },
  });

describe("init-uninstall roundtrip", () => {
  it("leaves an empty directory behind on a fresh target", () => {
    initAll();
    const report = runUninstall({ targetDir: target });

    expect(readdirSync(target)).toEqual([]);
    expect(report.kept).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.removed.length).toBeGreaterThan(10);
  });

  it("preserves user AGENTS.md and CLAUDE.md content, removing only section and import", () => {
    writeFileSync(join(target, "AGENTS.md"), "# Repo\n\nHouse rules stay.\n");
    writeFileSync(join(target, "CLAUDE.md"), "# Notes\n\nKeep me.\n");
    initAll();
    runUninstall({ targetDir: target });

    const agentsMd = readFileSync(join(target, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("House rules stay.");
    expect(agentsMd).not.toContain("orchestrator-workflow:begin");
    const claudeMd = readFileSync(join(target, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("Keep me.");
    expect(claudeMd).not.toContain("@AGENTS.md");
    // Kit dirs are gone, the two user files remain.
    expect(readdirSync(target).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("keeps run history and the directories above it", () => {
    initAll();
    const runDir = join(target, ".ai", "runs", "2026-06-12-demo");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "00-goal.md"), "# Goal\n");

    const report = runUninstall({ targetDir: target });
    expect(readFileSync(join(runDir, "00-goal.md"), "utf8")).toBe("# Goal\n");
    expect(report.notes.join("\n")).toContain("run history kept");
    // .ai survives because runs/ is non-empty; workflow/ is gone.
    expect(existsSync(join(target, ".ai", "workflow"))).toBe(false);
  });
});

describe("edited kit files", () => {
  it("keeps a locally edited file without --force and reports it", () => {
    initAll();
    const template = join(target, ".ai", "workflow", "templates", "00-goal.md");
    writeFileSync(template, "user edit\n");

    const report = runUninstall({ targetDir: target });
    expect(readFileSync(template, "utf8")).toBe("user edit\n");
    expect(report.kept).toContain(template);
    // The directory chain above the kept file survives the prune.
    expect(existsSync(join(target, ".ai", "workflow", "templates"))).toBe(true);
  });

  it("removes the edited file with --force", () => {
    initAll();
    const template = join(target, ".ai", "workflow", "templates", "00-goal.md");
    writeFileSync(template, "user edit\n");

    runUninstall({ targetDir: target, force: true });
    expect(existsSync(template)).toBe(false);
  });
});

describe("damaged fences and missing installs", () => {
  it("leaves a duplicated fence alone and reports it", () => {
    initAll();
    const agentsPath = join(target, "AGENTS.md");
    const content = readFileSync(agentsPath, "utf8");
    writeFileSync(
      agentsPath,
      `${content}\n<!-- orchestrator-workflow:begin -->\nstale\n<!-- orchestrator-workflow:end -->\n`,
    );

    const report = runUninstall({ targetDir: target });
    expect(report.kept).toContain(agentsPath);
    expect(readFileSync(agentsPath, "utf8")).toContain("stale");
  });

  it("throws a clear error when nothing is installed", () => {
    expect(() => runUninstall({ targetDir: target })).toThrow(
      /No orchestrator-workflow install found/,
    );
  });
});

describe("cli", () => {
  const runCli = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      timeout: 60_000,
    });

  it("init announces the target directory and the missing git root", () => {
    const result = runCli("init", target, "--yes", "--harness", "claude");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Installing into ${target}`);
    expect(result.stdout).toContain("not a git repository root");
  });

  it("uninstall refuses without --yes when non-interactive", () => {
    runCli("init", target, "--yes", "--harness", "claude");
    const result = runCli("uninstall", target);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pass --yes");
    expect(existsSync(join(target, ".ai", "workflow", "manifest.json"))).toBe(
      true,
    );
  });

  it("uninstall --yes removes the install", () => {
    runCli("init", target, "--yes", "--harness", "claude");
    const result = runCli("uninstall", target, "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Uninstalling from ${target}`);
    expect(readdirSync(target)).toEqual([]);
  });
});

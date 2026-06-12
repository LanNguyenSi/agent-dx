import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInit } from "../src/init.js";
import { DEFAULT_MODELS } from "../src/models.js";
import { detectHarnesses } from "../src/detect.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let target: string;

beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), "orchestrator-workflow-"));
});

afterEach(() => {
  rmSync(target, { recursive: true, force: true });
});

function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(full, readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return files;
}

const defaultOptions = () => ({
  targetDir: target,
  harnesses: ["claude" as const],
  models: { ...DEFAULT_MODELS },
});

describe("fresh install", () => {
  it("creates run state, AGENTS.md section, and claude adapter files", () => {
    const report = runInit(defaultOptions());

    const templates = readdirSync(
      join(target, ".ai", "workflow", "templates"),
    ).sort();
    expect(templates).toEqual([
      "00-goal.md",
      "01-plan.md",
      "02-tasks.md",
      "03-decisions.md",
      "04-implementation-summary.md",
      "05-review-findings.md",
      "06-handoff.md",
    ]);
    expect(existsSync(join(target, ".ai", "runs", ".gitkeep"))).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
    );
    expect(manifest.kit).toBe("orchestrator-workflow");
    expect(manifest.harnesses).toEqual(["claude"]);
    expect(manifest.models).toEqual(DEFAULT_MODELS);
    expect(manifest.installedAt).toBeTruthy();

    const agentsMd = readFileSync(join(target, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("<!-- orchestrator-workflow:begin -->");
    expect(agentsMd).toContain("<!-- orchestrator-workflow:end -->");
    expect(agentsMd).toContain("## Agentic Coding Workflow");

    const claudeMd = readFileSync(join(target, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("@AGENTS.md");

    expect(
      existsSync(
        join(target, ".claude", "skills", "orchestrator-workflow", "SKILL.md"),
      ),
    ).toBe(true);

    const slicer = readFileSync(
      join(target, ".claude", "agents", "task-slicer.md"),
      "utf8",
    );
    expect(slicer).toContain("name: task-slicer");
    expect(slicer).toContain("model: sonnet");
    const reviewer = readFileSync(
      join(target, ".claude", "agents", "reviewer.md"),
      "utf8",
    );
    expect(reviewer).toContain("model: opus");
    expect(reviewer).not.toContain("{{MODEL}}");

    expect(report.conflicted).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.written.length).toBeGreaterThan(0);
  });

  it("does not install codex or opencode adapters unless selected", () => {
    runInit(defaultOptions());
    expect(existsSync(join(target, ".agents"))).toBe(false);
    expect(existsSync(join(target, ".opencode"))).toBe(false);
  });
});

describe("idempotence", () => {
  it("a second run changes no file", () => {
    runInit(defaultOptions());
    const before = snapshot(target);

    const report = runInit(defaultOptions());
    const after = snapshot(target);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, content] of after) {
      expect(content, path).toBe(before.get(path));
    }
    expect(report.written).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.conflicted).toEqual([]);
  });
});

describe("AGENTS.md merging", () => {
  it("preserves existing content outside the markers", () => {
    writeFileSync(
      join(target, "AGENTS.md"),
      "# My repo\n\nLocal conventions stay.\n",
    );
    runInit(defaultOptions());

    const agentsMd = readFileSync(join(target, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("Local conventions stay.");
    expect(agentsMd).toContain("<!-- orchestrator-workflow:begin -->");
  });

  it("restores a locally edited section on re-run, touching nothing else", () => {
    writeFileSync(join(target, "AGENTS.md"), "# My repo\n\nKeep me.\n");
    runInit(defaultOptions());

    const installed = readFileSync(join(target, "AGENTS.md"), "utf8");
    const mangled = installed.replace(
      "## Agentic Coding Workflow",
      "## Mangled Heading",
    );
    writeFileSync(join(target, "AGENTS.md"), mangled);

    runInit(defaultOptions());
    const restored = readFileSync(join(target, "AGENTS.md"), "utf8");
    expect(restored).toContain("## Agentic Coding Workflow");
    expect(restored).not.toContain("## Mangled Heading");
    expect(restored).toContain("Keep me.");
  });

  it("reports a conflict on a half-broken fence instead of guessing", () => {
    writeFileSync(
      join(target, "AGENTS.md"),
      "# Repo\n\n<!-- orchestrator-workflow:begin -->\nno end marker\n",
    );
    const report = runInit(defaultOptions());
    expect(report.conflicted).toContain(join(target, "AGENTS.md"));
    expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toContain(
      "no end marker",
    );
  });
});

describe("CLAUDE.md import", () => {
  it("appends the import to an existing CLAUDE.md exactly once", () => {
    writeFileSync(join(target, "CLAUDE.md"), "# Claude notes\n");
    runInit(defaultOptions());
    runInit(defaultOptions());

    const claudeMd = readFileSync(join(target, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("# Claude notes");
    const importCount = claudeMd
      .split("\n")
      .filter((line) => line.trim() === "@AGENTS.md").length;
    expect(importCount).toBe(1);
  });
});

describe("harness selection and model mapping", () => {
  it("installs all three adapters with mapped model ids", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude", "codex", "opencode"],
      models: {
        "task-slicer": "haiku",
        implementer: "sonnet",
        reviewer: "opus",
      },
    });

    expect(
      existsSync(
        join(target, ".agents", "skills", "orchestrator-workflow", "SKILL.md"),
      ),
    ).toBe(true);

    const slicer = readFileSync(
      join(target, ".opencode", "agents", "task-slicer.md"),
      "utf8",
    );
    expect(slicer).toContain("mode: subagent");
    expect(slicer).toContain("model: anthropic/claude-haiku-4-5");

    const claudeSlicer = readFileSync(
      join(target, ".claude", "agents", "task-slicer.md"),
      "utf8",
    );
    expect(claudeSlicer).toContain("model: haiku");
  });

  it("passes custom model ids through, qualifying bare ids for opencode", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude", "opencode"],
      models: {
        "task-slicer": "sonnet",
        implementer: "claude-sonnet-4-6",
        reviewer: "openrouter/some-model",
      },
    });
    const implementer = readFileSync(
      join(target, ".opencode", "agents", "implementer.md"),
      "utf8",
    );
    expect(implementer).toContain("model: anthropic/claude-sonnet-4-6");
    const reviewer = readFileSync(
      join(target, ".opencode", "agents", "reviewer.md"),
      "utf8",
    );
    expect(reviewer).toContain("model: openrouter/some-model");
  });
});

describe("kit-owned file conflicts", () => {
  it("keeps local edits without --force and reports them", () => {
    runInit(defaultOptions());
    const template = join(target, ".ai", "workflow", "templates", "00-goal.md");
    writeFileSync(template, "locally changed\n");

    const report = runInit(defaultOptions());
    expect(report.conflicted).toContain(template);
    expect(readFileSync(template, "utf8")).toBe("locally changed\n");
  });

  it("overwrites local edits with --force", () => {
    runInit(defaultOptions());
    const template = join(target, ".ai", "workflow", "templates", "00-goal.md");
    writeFileSync(template, "locally changed\n");

    const report = runInit({ ...defaultOptions(), force: true });
    expect(report.updated).toContain(template);
    expect(readFileSync(template, "utf8")).toContain("# Goal");
  });
});

describe("harness detection", () => {
  it("detects harnesses from their marker files and dirs", () => {
    expect(detectHarnesses(target)).toEqual([]);
    writeFileSync(join(target, "CLAUDE.md"), "x\n");
    writeFileSync(join(target, "opencode.json"), "{}\n");
    expect(detectHarnesses(target)).toEqual(["claude", "opencode"]);
  });
});

describe("cli smoke", () => {
  it("init --yes runs non-interactively and installs", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "init",
        target,
        "--yes",
        "--harness",
        "claude",
      ],
      { cwd: PACKAGE_DIR, encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No existing harness configs detected");
    expect(result.stdout).toContain("installed for: claude");
    expect(existsSync(join(target, ".ai", "workflow", "manifest.json"))).toBe(
      true,
    );
    expect(statSync(join(target, ".claude", "agents")).isDirectory()).toBe(
      true,
    );
  });
});

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { DEFAULT_MODELS, parseModelsSpec } from "../src/models.js";
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

  it("ignores marker text mentioned inline in user prose", () => {
    runInit(defaultOptions());
    const installed = readFileSync(join(target, "AGENTS.md"), "utf8");
    const withMention = installed.replace(
      "# Agent instructions\n",
      "# Agent instructions\n\nThe fence starts at <!-- orchestrator-workflow:begin --> below.\nNever deploy on Fridays.\n",
    );
    writeFileSync(join(target, "AGENTS.md"), withMention);

    const report = runInit(defaultOptions());
    const after = readFileSync(join(target, "AGENTS.md"), "utf8");
    expect(after).toContain("Never deploy on Fridays.");
    expect(after).toContain(
      "The fence starts at <!-- orchestrator-workflow:begin --> below.",
    );
    expect(report.conflicted).toEqual([]);
  });

  it("reports a conflict on a duplicated fence instead of picking one", () => {
    runInit(defaultOptions());
    const installed = readFileSync(join(target, "AGENTS.md"), "utf8");
    writeFileSync(
      join(target, "AGENTS.md"),
      `${installed}\n<!-- orchestrator-workflow:begin -->\nstale copy\n<!-- orchestrator-workflow:end -->\n`,
    );

    const report = runInit(defaultOptions());
    expect(report.conflicted).toContain(join(target, "AGENTS.md"));
    expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toContain(
      "stale copy",
    );
  });

  it("appends to an empty AGENTS.md without leading blank lines", () => {
    writeFileSync(join(target, "AGENTS.md"), "");
    runInit(defaultOptions());
    const agentsMd = readFileSync(join(target, "AGENTS.md"), "utf8");
    expect(agentsMd.startsWith("<!-- orchestrator-workflow:begin -->")).toBe(
      true,
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

  it("recognizes an existing inline import", () => {
    writeFileSync(join(target, "CLAUDE.md"), "Rules: see @AGENTS.md first.\n");
    runInit(defaultOptions());
    const claudeMd = readFileSync(join(target, "CLAUDE.md"), "utf8");
    expect(claudeMd).toBe("Rules: see @AGENTS.md first.\n");
  });
});

describe("upgrades via the manifest hash ledger", () => {
  it("updates an unedited kit file whose shipped content changed", () => {
    runInit(defaultOptions());
    const manifestPath = join(target, ".ai", "workflow", "manifest.json");
    const templateRel = join(".ai", "workflow", "templates", "00-goal.md");
    const templatePath = join(target, templateRel);

    // Simulate a previous kit version: the installed file and its recorded
    // hash agree, but both differ from the currently shipped asset.
    const oldContent = "# Goal (older kit version)\n";
    writeFileSync(templatePath, oldContent);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files[templateRel] = createHash("sha256")
      .update(oldContent, "utf8")
      .digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const report = runInit(defaultOptions());
    expect(report.updated).toContain(templatePath);
    expect(report.conflicted).toEqual([]);
    expect(readFileSync(templatePath, "utf8")).toContain("# Goal");
  });

  it("survives a malformed hand-written manifest without crashing", () => {
    runInit(defaultOptions());
    const manifestPath = join(target, ".ai", "workflow", "manifest.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          kit: "orchestrator-workflow",
          version: "0.1.0",
          harnesses: "claude",
          models: { reviewer: 'opus: "x"', implementer: "haiku" },
          files: null,
        },
        null,
        2,
      )}\n`,
    );

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "init", target, "--yes"],
      { cwd: PACKAGE_DIR, encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status, result.stderr).toBe(0);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.harnesses).toEqual(["claude"]);
    // The invalid reviewer id is dropped (back to default), the valid
    // implementer override survives.
    expect(manifest.models.reviewer).toBe("opus");
    expect(manifest.models.implementer).toBe("haiku");
  });

  it("keeps a user-edited kit file as a conflict and preserves the record", () => {
    runInit(defaultOptions());
    const templateRel = join(".ai", "workflow", "templates", "00-goal.md");
    const templatePath = join(target, templateRel);
    writeFileSync(templatePath, "user edit\n");

    runInit(defaultOptions());
    const manifest = JSON.parse(
      readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
    );
    expect(readFileSync(templatePath, "utf8")).toBe("user edit\n");
    // The record still points at the original install, so a later upgrade
    // still sees this file as edited.
    expect(manifest.files[templateRel]).toBeTruthy();
    expect(manifest.files[templateRel]).not.toBe(
      createHash("sha256").update("user edit\n", "utf8").digest("hex"),
    );
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

describe("input validation", () => {
  it("rejects unknown roles and unsafe model ids in --models", () => {
    expect(() => parseModelsSpec("builder=sonnet", DEFAULT_MODELS)).toThrow(
      /Unknown role/,
    );
    expect(() => parseModelsSpec('reviewer="opus: x"', DEFAULT_MODELS)).toThrow(
      /Invalid model id/,
    );
  });

  it("rejects a target that is a file, with a precise message", () => {
    const file = join(target, "somefile");
    writeFileSync(file, "x\n");
    expect(() => runInit({ ...defaultOptions(), targetDir: file })).toThrow(
      /Target is not a directory/,
    );
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

  it("a plain re-run keeps the previously chosen models", () => {
    const run = (...extra: string[]) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "init", target, "--yes", ...extra],
        { cwd: PACKAGE_DIR, encoding: "utf8", timeout: 60_000 },
      );
    expect(run("--models", "implementer=haiku").status).toBe(0);
    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("Found existing install");
    expect(second.stdout).not.toContain("Conflicts");

    const manifest = JSON.parse(
      readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
    );
    expect(manifest.models.implementer).toBe("haiku");
    expect(
      readFileSync(join(target, ".claude", "agents", "implementer.md"), "utf8"),
    ).toContain("model: haiku");
  });
});

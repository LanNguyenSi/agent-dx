import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
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
import {
  DEFAULT_MODELS,
  DEFAULT_TIER,
  ROLES,
  ROLE_TIERS,
  parseModelsSpec,
  parseProfile,
  rolesForProfile,
} from "../src/models.js";
import { detectHarnesses } from "../src/detect.js";
import { runUninstall } from "../src/uninstall.js";

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

describe("read-only roles (explorer, reviewer)", () => {
  it("installs the explorer with a read-only posture on both harnesses", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude", "opencode"],
      models: { ...DEFAULT_MODELS },
    });

    const claudeExplorer = readFileSync(
      join(target, ".claude", "agents", "explorer.md"),
      "utf8",
    );
    expect(claudeExplorer).toContain("name: explorer");
    expect(claudeExplorer).toContain("model: sonnet");
    expect(claudeExplorer).toContain(
      "disallowedTools: Edit, Write, NotebookEdit",
    );

    const opencodeExplorer = readFileSync(
      join(target, ".opencode", "agents", "explorer.md"),
      "utf8",
    );
    expect(opencodeExplorer).toContain("mode: subagent");
    expect(opencodeExplorer).toContain("permission:");
    expect(opencodeExplorer).toContain("edit: deny");
    // Default alias with no opencodeModels → no model: line
    expect(opencodeExplorer).not.toContain("model:");

    // The mutating roles must NOT carry the read-only marker.
    const claudeImplementer = readFileSync(
      join(target, ".claude", "agents", "implementer.md"),
      "utf8",
    );
    expect(claudeImplementer).not.toContain("disallowedTools");
  });

  it("pins the Bash no-mutation guard in both installed read-only agents", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude", "opencode"],
      models: { ...DEFAULT_MODELS },
    });

    // Bash cannot be tool-disallowed (the roles must run tests), so the
    // guard is instruction-level and lives in the agent prompt body. This
    // test is the mutation tripwire: removing the guard from either asset
    // fails it for every install target.
    const GUARD =
      "Bash is for running tests, linters, and read-only inspection ONLY";
    for (const harnessDir of [".claude", ".opencode"]) {
      for (const role of ["explorer", "reviewer"]) {
        const installed = readFileSync(
          join(target, harnessDir, "agents", `${role}.md`),
          "utf8",
        );
        expect(installed, `${harnessDir}/agents/${role}.md`).toContain(GUARD);
        // The forbidden-command list must stay explicit, not a vague
        // "read-only" claim. Pin both git-discard siblings and the
        // file-mutation escape hatch.
        for (const token of ["`git checkout`", "`git reset`", "`sed -i`"]) {
          expect(installed, `${harnessDir}/agents/${role}.md`).toContain(token);
        }
        // The escalation rule must survive too: report, never repair.
        expect(installed, `${harnessDir}/agents/${role}.md`).toContain(
          "leave the tree",
        );
      }
      // The implementer is the mutating role and must NOT carry the guard.
      const implementer = readFileSync(
        join(target, harnessDir, "agents", "implementer.md"),
        "utf8",
      );
      expect(implementer).not.toContain(GUARD);
    }
  });

  it("installs the reviewer with a read-only posture on both harnesses", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude", "opencode"],
      models: { ...DEFAULT_MODELS },
    });

    // The reviewer judges work without changing it, so it must carry the
    // same read-only posture as the explorer (no file-mutation tools).
    const claudeReviewer = readFileSync(
      join(target, ".claude", "agents", "reviewer.md"),
      "utf8",
    );
    expect(claudeReviewer).toContain("name: reviewer");
    expect(claudeReviewer).toContain(
      "disallowedTools: Edit, Write, NotebookEdit",
    );

    const opencodeReviewer = readFileSync(
      join(target, ".opencode", "agents", "reviewer.md"),
      "utf8",
    );
    expect(opencodeReviewer).toContain("permission:");
    expect(opencodeReviewer).toContain("edit: deny");

    // The implementer (a mutating role) must still NOT carry the marker.
    const claudeImplementer = readFileSync(
      join(target, ".claude", "agents", "implementer.md"),
      "utf8",
    );
    expect(claudeImplementer).not.toContain("disallowedTools");

    const opencodeImplementer = readFileSync(
      join(target, ".opencode", "agents", "implementer.md"),
      "utf8",
    );
    expect(opencodeImplementer).not.toContain("edit: deny");
  });

  it("opencode-only install writes .opencode/skills/orchestrator-workflow/SKILL.md", () => {
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
    });
    expect(
      existsSync(
        join(
          target,
          ".opencode",
          "skills",
          "orchestrator-workflow",
          "SKILL.md",
        ),
      ),
    ).toBe(true);
    expect(existsSync(join(target, ".claude"))).toBe(false);
  });
});

describe("harness selection and model mapping", () => {
  it("installs all four adapters; opencode agents omit model: when aliases given without catalog", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude", "codex", "opencode"],
      models: {
        explorer: "sonnet",
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

    // opencode skill is now installed for the opencode harness too
    expect(
      existsSync(
        join(
          target,
          ".opencode",
          "skills",
          "orchestrator-workflow",
          "SKILL.md",
        ),
      ),
    ).toBe(true);

    const slicer = readFileSync(
      join(target, ".opencode", "agents", "task-slicer.md"),
      "utf8",
    );
    expect(slicer).toContain("mode: subagent");
    // Bare alias without opencodeModels → no model: line (inherits session model)
    expect(slicer).not.toContain("model:");

    const claudeSlicer = readFileSync(
      join(target, ".claude", "agents", "task-slicer.md"),
      "utf8",
    );
    expect(claudeSlicer).toContain("model: haiku");
  });

  it("passes FQ model ids through for opencode; bare ids without provider are omitted", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude", "opencode"],
      models: {
        explorer: "sonnet",
        "task-slicer": "sonnet",
        implementer: "claude-sonnet-4-6",
        reviewer: "openrouter/some-model",
      },
    });
    const implementer = readFileSync(
      join(target, ".opencode", "agents", "implementer.md"),
      "utf8",
    );
    // Bare id without `/` → undefined → no model: line
    expect(implementer).not.toContain("model:");
    const reviewer = readFileSync(
      join(target, ".opencode", "agents", "reviewer.md"),
      "utf8",
    );
    // FQ id passes through unchanged
    expect(reviewer).toContain("model: openrouter/some-model");
  });

  it("emits model: line when opencodeModels provides a FQ id", () => {
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
      opencodeModels: {
        explorer: "github-copilot/claude-sonnet-4.6",
        "task-slicer": "github-copilot/claude-sonnet-4.6",
        implementer: "github-copilot/claude-sonnet-4.6",
        reviewer: "github-copilot/claude-opus-4.8",
      },
    });
    const explorer = readFileSync(
      join(target, ".opencode", "agents", "explorer.md"),
      "utf8",
    );
    expect(explorer).toContain("model: github-copilot/claude-sonnet-4.6");
    expect(explorer).toContain("mode: subagent");
    const reviewer = readFileSync(
      join(target, ".opencode", "agents", "reviewer.md"),
      "utf8",
    );
    expect(reviewer).toContain("model: github-copilot/claude-opus-4.8");
  });
});

describe("profile selection", () => {
  it("minimal installs only implementer and reviewer agent files, for both claude and opencode", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude", "opencode"],
      models: { ...DEFAULT_MODELS },
      profile: "minimal",
    });

    for (const harnessDir of [".claude", ".opencode"]) {
      expect(
        existsSync(join(target, harnessDir, "agents", "implementer.md")),
        `${harnessDir}/agents/implementer.md`,
      ).toBe(true);
      expect(
        existsSync(join(target, harnessDir, "agents", "reviewer.md")),
        `${harnessDir}/agents/reviewer.md`,
      ).toBe(true);
      expect(
        existsSync(join(target, harnessDir, "agents", "task-slicer.md")),
        `${harnessDir}/agents/task-slicer.md`,
      ).toBe(false);
      expect(
        existsSync(join(target, harnessDir, "agents", "explorer.md")),
        `${harnessDir}/agents/explorer.md`,
      ).toBe(false);
    }
    // The skill itself is not role-scoped and still installs under minimal.
    expect(
      existsSync(
        join(target, ".claude", "skills", "orchestrator-workflow", "SKILL.md"),
      ),
    ).toBe(true);
  });

  it("full installs the exact same agent file set whether the profile is explicit or omitted (today's unconditional behavior)", () => {
    const explicitTarget = mkdtempSync(
      join(tmpdir(), "orchestrator-workflow-profile-"),
    );
    try {
      runInit({
        targetDir: target,
        harnesses: ["claude"],
        models: { ...DEFAULT_MODELS },
      }); // profile omitted
      runInit({
        targetDir: explicitTarget,
        harnesses: ["claude"],
        models: { ...DEFAULT_MODELS },
        profile: "full",
      });

      const listAgents = (dir: string) =>
        readdirSync(join(dir, ".claude", "agents")).sort();
      expect(listAgents(target)).toEqual(listAgents(explicitTarget));
      expect(listAgents(target)).toEqual([
        "explorer.md",
        "implementer.md",
        "reviewer.md",
        "task-slicer.md",
      ]);
    } finally {
      rmSync(explicitTarget, { recursive: true, force: true });
    }
  });

  it("records the chosen profile in the manifest", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
      profile: "minimal",
    });
    const manifest = JSON.parse(
      readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
    );
    expect(manifest.profile).toBe("minimal");
  });

  it("defaults the manifest profile to full when the option is omitted", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
    });
    const manifest = JSON.parse(
      readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
    );
    expect(manifest.profile).toBe("full");
  });

  it("rolesForProfile: minimal is implementer+reviewer, full is every role, in ROLES order", () => {
    expect(rolesForProfile("minimal")).toEqual(["implementer", "reviewer"]);
    expect(rolesForProfile("full")).toEqual(ROLES);
  });

  it("parseProfile rejects an unknown value", () => {
    expect(() => parseProfile("bogus")).toThrow(/Unknown --profile "bogus"/);
    expect(parseProfile("minimal")).toBe("minimal");
    expect(parseProfile("full")).toBe("full");
  });

  describe("CLI re-run semantics", () => {
    const run = (...extra: string[]) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "init", target, "--yes", ...extra],
        { cwd: PACKAGE_DIR, encoding: "utf8", timeout: 60_000 },
      );

    it("a plain re-run without --profile keeps the previously installed profile", () => {
      expect(run("--profile", "minimal").status).toBe(0);
      const second = run();
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("profile: minimal");
      expect(
        existsSync(join(target, ".claude", "agents", "task-slicer.md")),
      ).toBe(false);
      const manifest = JSON.parse(
        readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
      );
      expect(manifest.profile).toBe("minimal");
    });

    it("an explicit --profile overrides the previously installed profile", () => {
      expect(run("--profile", "minimal").status).toBe(0);
      const second = run("--profile", "full");
      expect(second.status, second.stderr).toBe(0);
      expect(
        existsSync(join(target, ".claude", "agents", "task-slicer.md")),
      ).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
      );
      expect(manifest.profile).toBe("full");
    });

    it("rejects an unknown --profile value non-zero, with a clear message on stderr", () => {
      const result = run("--profile", "bogus");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Unknown --profile "bogus"');
    });
  });
});

/**
 * A manifest written before profiles existed (or hand-corrupted to drop the
 * field) must fall back to `full`, not `minimal` — a pre-profile install
 * always put down every role, so silently narrowing it on the next re-run
 * would delete-by-omission roles the operator never asked to drop. This is
 * the CLI-path counterpart to the "survives a malformed hand-written
 * manifest" test above: that test never checks which profile got installed
 * (its pre-fix baseline already has all four agent files on disk from an
 * earlier good run, so a wrong `minimal` fallback would go undetected — the
 * loop over `rolesForProfile` only adds files, it never deletes one for a
 * role that fell out of profile). This test starts from a target that has
 * never been through a real `full` install, so the fallback's chosen
 * profile is the only thing that can explain which agent files appear.
 */
describe("manifest missing the profile field (pre-profile-era manifest)", () => {
  it("falls back to full, not minimal, installing all four agent files on re-run without --profile", () => {
    const manifestPath = join(target, ".ai", "workflow", "manifest.json");
    mkdirSync(join(target, ".ai", "workflow"), { recursive: true });
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          kit: "orchestrator-workflow",
          version: "0.14.0",
          harnesses: ["claude"],
          models: DEFAULT_MODELS,
          files: {},
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
    expect(result.stdout).toContain("profile: full");

    for (const role of ROLES) {
      expect(
        existsSync(join(target, ".claude", "agents", `${role}.md`)),
        `${role}.md should exist under the full-profile fallback`,
      ).toBe(true);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.profile).toBe("full");
  });
});

describe("profile downgrade (full -> minimal) leaves a note about untracked role files", () => {
  it("reports a note naming the now-untracked task-slicer/explorer files and how to remove them", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
    });

    const report = runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
      profile: "minimal",
    });

    const claudeTaskSlicer = join(".claude", "agents", "task-slicer.md");
    const claudeExplorer = join(".claude", "agents", "explorer.md");
    expect(report.notes.some((note) => note.includes(claudeTaskSlicer))).toBe(
      true,
    );
    expect(report.notes.some((note) => note.includes(claudeExplorer))).toBe(
      true,
    );
    expect(
      report.notes.some((note) =>
        note.includes("orchestrator-workflow uninstall"),
      ),
    ).toBe(true);

    // The files themselves are untouched (not deleted), only untracked.
    expect(existsSync(join(target, claudeTaskSlicer))).toBe(true);
    expect(existsSync(join(target, claudeExplorer))).toBe(true);
  });

  it("does not repeat the note on a later no-op re-run at the same (minimal) profile", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
    });
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
      profile: "minimal",
    });
    const again = runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
      profile: "minimal",
    });
    expect(again.notes).toEqual([]);
  });

  it("uninstall after a downgrade completes without error; the untracked leftovers survive it", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
    });
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
      profile: "minimal",
    });

    expect(() => runUninstall({ targetDir: target })).not.toThrow();
    // task-slicer.md/explorer.md are no longer in the manifest's file
    // ledger, so uninstall (which only removes what it can still find
    // there) leaves them in place.
    expect(
      existsSync(join(target, ".claude", "agents", "task-slicer.md")),
    ).toBe(true);
    expect(existsSync(join(target, ".claude", "agents", "explorer.md"))).toBe(
      true,
    );
  });

  it("with tiers on, the downgrade note also covers the dropped roles' variant files", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
      tiers: true,
    });

    const report = runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
      profile: "minimal",
      tiers: true,
    });

    // explorer and task-slicer each get one note for their base file plus
    // one note per non-default tier (low, high — medium is their own
    // DEFAULT_TIER and never gets a variant file): 1 + 2 notes per role,
    // 2 dropped roles, 1 harness = 6 notes total.
    expect(report.notes.length).toBe(6);
    for (const role of ["explorer", "task-slicer"] as const) {
      const basePath = join(".claude", "agents", `${role}.md`);
      expect(report.notes.some((note) => note.includes(basePath))).toBe(true);
      for (const tier of ROLE_TIERS[role]) {
        if (tier === DEFAULT_TIER[role]) continue;
        const variantPath = join(".claude", "agents", `${role}-${tier}.md`);
        expect(
          report.notes.some((note) => note.includes(variantPath)),
          variantPath,
        ).toBe(true);
      }
    }

    // The variant files themselves are untouched, only untracked, same as
    // the base files above.
    expect(
      existsSync(join(target, ".claude", "agents", "explorer-low.md")),
    ).toBe(true);
  });
});

/**
 * Review round 2 (R2-M2): both leftover-note loops above previously derived
 * their note set from `ROLE_TIERS`/`options.harnesses` rather than from what
 * the previous install actually wrote (`previous.files`/`previous.harnesses`).
 * That produced two distinct wrong outcomes the profile-downgrade tests above
 * never exercised (they never combine tiers with an unresolved opencode
 * catalog, and never change the harness selection between runs): a phantom
 * note for a variant file that was never written (opencode + an unresolved
 * tier-class catalog, where the M1 guard already skips the write), and a
 * missing note for a real leftover whose harness was dropped from
 * `options.harnesses` this run even though its files are still on disk. Both
 * cases are exercised directly here.
 */
describe("leftover notes are ledger-driven, not enumeration-driven (review round 2, R2-M2)", () => {
  it("opencode + unresolved tier-class models (0 variant files ever written): turning tiers off emits exactly 0 leftover notes", () => {
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
      tiers: true,
      // opencodeClassModels omitted entirely: every class is unresolved,
      // so the M1 unresolved-class guard writes zero tier-variant files and
      // records zero of them in the manifest's file ledger.
    });

    const report = runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
      tiers: false,
    });

    expect(report.notes).toEqual([]);
  });

  it("a claude install with tiers on, then a re-run switching to --harness opencode --no-tiers: the real .claude variant leftovers are named (not the never-installed .opencode harness)", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
      tiers: true,
    });

    const report = runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
      tiers: false,
    });

    for (const role of ["explorer", "task-slicer"] as const) {
      for (const tier of ["low", "high"] as const) {
        const variantPath = join(".claude", "agents", `${role}-${tier}.md`);
        expect(
          report.notes.some((note) => note.includes(variantPath)),
          variantPath,
        ).toBe(true);
      }
    }
    for (const tier of ["low", "high", "xhigh"] as const) {
      const variantPath = join(".claude", "agents", `implementer-${tier}.md`);
      expect(
        report.notes.some((note) => note.includes(variantPath)),
        variantPath,
      ).toBe(true);
    }
    for (const tier of ["medium", "xhigh"] as const) {
      const variantPath = join(".claude", "agents", `reviewer-${tier}.md`);
      expect(
        report.notes.some((note) => note.includes(variantPath)),
        variantPath,
      ).toBe(true);
    }
    // The .opencode harness was only just added this run and was never
    // previously installed, so it must not contribute any leftover note.
    expect(report.notes.every((note) => !note.includes(".opencode"))).toBe(
      true,
    );
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

describe("tier variants (`--tiers`)", () => {
  it("a legacy manifest with no tiers field defaults to false and renders like the no-tiers baseline", () => {
    const manifestPath = join(target, ".ai", "workflow", "manifest.json");
    mkdirSync(join(target, ".ai", "workflow"), { recursive: true });
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          kit: "orchestrator-workflow",
          version: "0.18.0",
          harnesses: ["claude"],
          models: DEFAULT_MODELS,
          profile: "full",
          files: {},
        },
        null,
        2,
      )}\n`,
    );

    runInit(defaultOptions());

    const agents = readdirSync(join(target, ".claude", "agents")).sort();
    expect(agents).toEqual([
      "explorer.md",
      "implementer.md",
      "reviewer.md",
      "task-slicer.md",
    ]);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.tiers).toBe(false);

    // Content assertion, not just the file-set check above: pins the exact
    // pre-0.19.0 frontmatter shape (four lines, no `effort:`) so a change to
    // composeClaudeAgent cannot silently alter the legacy (tiers-off) render
    // path without failing here.
    const explorer = readFileSync(
      join(target, ".claude", "agents", "explorer.md"),
      "utf8",
    );
    const frontmatterMatch = explorer.match(/^---\n([\s\S]*?)\n---\n/);
    expect(
      frontmatterMatch,
      "explorer.md has no frontmatter block",
    ).toBeTruthy();
    const frontmatterLines = (frontmatterMatch as RegExpMatchArray)[1].split(
      "\n",
    );
    expect(frontmatterLines).toEqual([
      "name: explorer",
      expect.stringMatching(/^description: "/),
      "model: sonnet",
      "disallowedTools: Edit, Write, NotebookEdit",
    ]);
  });

  it("tiers=true, claude, full profile: exactly 13 agent files with the right model/effort per variant", () => {
    runInit({ ...defaultOptions(), profile: "full", tiers: true });

    const agents = readdirSync(join(target, ".claude", "agents")).sort();
    expect(agents.length).toBe(13);

    // Dedicated anti-downgrade check: the reviewer default file must still
    // be opus, unaffected by tiers being on.
    const reviewer = readFileSync(
      join(target, ".claude", "agents", "reviewer.md"),
      "utf8",
    );
    expect(reviewer).toContain("model: opus");
    expect(reviewer).not.toContain("effort:");

    const explorerLow = readFileSync(
      join(target, ".claude", "agents", "explorer-low.md"),
      "utf8",
    );
    expect(explorerLow).toContain("model: haiku");
    expect(explorerLow).toContain("effort: low");
    expect(explorerLow).toContain("disallowedTools: Edit, Write, NotebookEdit");

    const implementerXhigh = readFileSync(
      join(target, ".claude", "agents", "implementer-xhigh.md"),
      "utf8",
    );
    expect(implementerXhigh).toContain("model: opus");
    expect(implementerXhigh).toContain("effort: xhigh");
  });

  it("never renders a <role>-<defaultTier>.md variant; the file set is collision-free", () => {
    runInit({ ...defaultOptions(), profile: "full", tiers: true });
    const agents = new Set(readdirSync(join(target, ".claude", "agents")));

    expect(agents.has("explorer-medium.md")).toBe(false);
    expect(agents.has("task-slicer-medium.md")).toBe(false);
    expect(agents.has("implementer-medium.md")).toBe(false);
    expect(agents.has("reviewer-high.md")).toBe(false);
    // 4 default files + 9 variants (explorer/task-slicer: 2 each,
    // implementer: 3, reviewer: 2), no duplicates.
    expect(agents.size).toBe(13);
  });

  it("opencode: an anthropic-resolved class id gets variant: high/max on the high/xhigh tiers, none on low", () => {
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
      tiers: true,
      opencodeClassModels: {
        small: "anthropic/claude-haiku-4-5",
        medium: "anthropic/claude-sonnet-4-6",
        large: "anthropic/claude-opus-4-8",
      },
    });

    const reviewerXhigh = readFileSync(
      join(target, ".opencode", "agents", "reviewer-xhigh.md"),
      "utf8",
    );
    expect(reviewerXhigh).toContain("model: anthropic/claude-opus-4-8");
    expect(reviewerXhigh).toContain("variant: max");

    const implementerHigh = readFileSync(
      join(target, ".opencode", "agents", "implementer-high.md"),
      "utf8",
    );
    expect(implementerHigh).toContain("model: anthropic/claude-sonnet-4-6");
    expect(implementerHigh).toContain("variant: high");

    const implementerLow = readFileSync(
      join(target, ".opencode", "agents", "implementer-low.md"),
      "utf8",
    );
    expect(implementerLow).toContain("model: anthropic/claude-haiku-4-5");
    expect(implementerLow).not.toContain("variant:");
    expect(implementerLow).not.toContain("reasoningEffort");
  });

  it("opencode: an ollama-resolved class id gets no effort field", () => {
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
      tiers: true,
      opencodeClassModels: {
        small: "ollama/llama3",
        medium: "ollama/llama3",
        large: "ollama/llama3",
      },
    });

    const implementerHigh = readFileSync(
      join(target, ".opencode", "agents", "implementer-high.md"),
      "utf8",
    );
    expect(implementerHigh).toContain("model: ollama/llama3");
    expect(implementerHigh).not.toContain("variant:");
    expect(implementerHigh).not.toContain("reasoningEffort");
  });

  it("opencode: a non-anthropic, non-ollama resolved class id gets reasoningEffort", () => {
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
      tiers: true,
      opencodeClassModels: {
        small: "openrouter/some-small-model",
        medium: "openrouter/some-model",
        large: "openrouter/some-large-model",
      },
    });

    const implementerHigh = readFileSync(
      join(target, ".opencode", "agents", "implementer-high.md"),
      "utf8",
    );
    expect(implementerHigh).toContain("reasoningEffort: high");
    expect(implementerHigh).not.toContain("variant:");
  });

  it("opencode: a claude-family model behind a non-anthropic provider (github-copilot) still gets the variant: rule, not reasoningEffort", () => {
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
      tiers: true,
      opencodeClassModels: {
        small: "github-copilot/claude-haiku-4.5",
        medium: "github-copilot/claude-sonnet-4.6",
        large: "github-copilot/claude-opus-4.8",
      },
    });

    const implementerHigh = readFileSync(
      join(target, ".opencode", "agents", "implementer-high.md"),
      "utf8",
    );
    expect(implementerHigh).toContain(
      "model: github-copilot/claude-sonnet-4.6",
    );
    expect(implementerHigh).toContain("variant: high");
    expect(implementerHigh).not.toContain("reasoningEffort");
  });

  it("opencode: a claude-family model behind a nested-path provider (openrouter/anthropic/claude-*) still gets the variant: rule", () => {
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
      tiers: true,
      opencodeClassModels: {
        small: "openrouter/anthropic/claude-haiku-4.5",
        medium: "openrouter/anthropic/claude-sonnet-4.6",
        large: "openrouter/anthropic/claude-opus-4.8",
      },
    });

    const reviewerXhigh = readFileSync(
      join(target, ".opencode", "agents", "reviewer-xhigh.md"),
      "utf8",
    );
    expect(reviewerXhigh).toContain(
      "model: openrouter/anthropic/claude-opus-4.8",
    );
    expect(reviewerXhigh).toContain("variant: max");
    expect(reviewerXhigh).not.toContain("reasoningEffort");
  });

  it("opencode: an unresolved class model (undefined) renders no variant file at all, not a no-op file with neither model: nor an effort line", () => {
    const report = runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
      tiers: true,
      // opencodeClassModels omitted entirely: every class resolves to
      // undefined, the same shape as an empty live catalog or a set of
      // fully-qualified --models that never triggered class resolution.
    });

    const agents = readdirSync(join(target, ".opencode", "agents"));
    // Only the 4 default per-role files; none of the 9 tier variants were
    // written, since every one of them would have carried neither model:
    // nor an effort line.
    expect(agents.sort()).toEqual([
      "explorer.md",
      "implementer.md",
      "reviewer.md",
      "task-slicer.md",
    ]);
    expect(report.written.some((path) => path.includes("-low.md"))).toBe(false);
    expect(report.written.some((path) => path.includes("-high.md"))).toBe(
      false,
    );
    expect(report.written.some((path) => path.includes("-xhigh.md"))).toBe(
      false,
    );

    // No ledger entry for the skipped files either.
    const manifest = JSON.parse(
      readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
    );
    expect(
      Object.keys(manifest.files).some((path) => path.includes("-low.md")),
    ).toBe(false);
  });

  it("tier data invariant: DEFAULT_TIER[role] is always a member of ROLE_TIERS[role]", () => {
    for (const role of ROLES) {
      expect(ROLE_TIERS[role], role).toContain(DEFAULT_TIER[role]);
    }
  });

  it("a second run with tiers=true changes no file (idempotent)", () => {
    runInit({ ...defaultOptions(), profile: "full", tiers: true });
    const before = snapshot(target);

    const report = runInit({
      ...defaultOptions(),
      profile: "full",
      tiers: true,
    });
    const after = snapshot(target);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, content] of after) {
      expect(content, path).toBe(before.get(path));
    }
    expect(report.written).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.conflicted).toEqual([]);
  });

  it("uninstall removes the tier-variant files it installed (ledger tracking via installKitFile)", () => {
    runInit({ ...defaultOptions(), profile: "full", tiers: true });
    const explorerLowPath = join(
      target,
      ".claude",
      "agents",
      "explorer-low.md",
    );
    expect(existsSync(explorerLowPath)).toBe(true);

    runUninstall({ targetDir: target });
    expect(existsSync(explorerLowPath)).toBe(false);
  });

  it("records tiers:true in the manifest", () => {
    runInit({ ...defaultOptions(), profile: "full", tiers: true });
    const manifest = JSON.parse(
      readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
    );
    expect(manifest.tiers).toBe(true);
  });

  describe("CLI --tiers override-vs-persist", () => {
    const run = (...extra: string[]) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "init", target, "--yes", ...extra],
        { cwd: PACKAGE_DIR, encoding: "utf8", timeout: 60_000 },
      );

    it("a plain re-run without --tiers keeps the previously installed tiers value", () => {
      expect(run("--tiers").status).toBe(0);
      expect(
        existsSync(join(target, ".claude", "agents", "explorer-low.md")),
      ).toBe(true);

      const second = run();
      expect(second.status, second.stderr).toBe(0);
      expect(
        existsSync(join(target, ".claude", "agents", "explorer-low.md")),
      ).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
      );
      expect(manifest.tiers).toBe(true);
    });

    it("a flagless init on a fresh target renders exactly the 4 default agent files and writes tiers: false", () => {
      const result = run();
      expect(result.status, result.stderr).toBe(0);

      const agents = readdirSync(join(target, ".claude", "agents")).sort();
      expect(agents).toEqual([
        "explorer.md",
        "implementer.md",
        "reviewer.md",
        "task-slicer.md",
      ]);
      const manifest = JSON.parse(
        readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
      );
      expect(manifest.tiers).toBe(false);
    });

    it("--no-tiers turns the feature off on a fresh install (no previous manifest to persist)", () => {
      const result = run("--no-tiers");
      expect(result.status, result.stderr).toBe(0);
      expect(
        existsSync(join(target, ".claude", "agents", "explorer-low.md")),
      ).toBe(false);
      const manifest = JSON.parse(
        readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
      );
      expect(manifest.tiers).toBe(false);
    });

    it("--no-tiers overrides a previously installed --tiers value (true -> false transition), leaving a leftover note for the variant files", () => {
      expect(run("--tiers").status).toBe(0);
      expect(
        existsSync(join(target, ".claude", "agents", "explorer-low.md")),
      ).toBe(true);

      const second = run("--no-tiers");
      expect(second.status, second.stderr).toBe(0);
      // The transition itself does not delete the file (same leftover
      // pattern as the profile downgrade), only stops tracking it.
      expect(
        existsSync(join(target, ".claude", "agents", "explorer-low.md")),
      ).toBe(true);
      expect(second.stdout).toContain(
        join(".claude", "agents", "explorer-low.md"),
      );
      expect(second.stdout).toContain(
        "now untracked after tiers were turned off",
      );

      const manifest = JSON.parse(
        readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
      );
      expect(manifest.tiers).toBe(false);
    });

    it("prints the tiers status in both the 'Found existing install' line and the closing summary", () => {
      expect(run("--tiers").status).toBe(0);
      const second = run();
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("Found existing install");
      expect(second.stdout).toMatch(/Found existing install.*tiers: true/);
      expect(second.stdout).toMatch(/installed for: claude.*tiers: true/);
    });
  });
});

describe("cli smoke — opencode harness", () => {
  // Each test gets a fresh empty bin dir that the spawned process uses as its
  // PATH. This ensures `opencode` cannot be found regardless of the host
  // environment, making the catalog-empty path hermetic. The spawn itself
  // uses process.execPath (full path to node) and resolves tsx from the
  // package's node_modules, so restricting PATH does not break compilation.
  let emptyBinDir: string;

  beforeEach(() => {
    emptyBinDir = mkdtempSync(join(tmpdir(), "no-opencode-"));
  });

  afterEach(() => {
    rmSync(emptyBinDir, { recursive: true, force: true });
  });

  const runOpencodeCli = (
    args: string[],
    envOverrides: Record<string, string> = {},
  ) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "init",
        target,
        "--yes",
        "--harness",
        "opencode",
        ...args,
      ],
      {
        cwd: PACKAGE_DIR,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, ...envOverrides },
      },
    );

  it("exits 0 and creates .opencode/agents/explorer.md", () => {
    // PATH unrestricted — `opencode` may or may not be present, but the
    // install must succeed either way.
    const result = runOpencodeCli([]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(target, ".opencode", "agents", "explorer.md"))).toBe(
      true,
    );
  });

  it("omits model: from all agent files when opencode binary is unavailable", () => {
    const result = runOpencodeCli([], { PATH: emptyBinDir });
    expect(result.status, result.stderr).toBe(0);
    for (const role of ROLES) {
      const content = readFileSync(
        join(target, ".opencode", "agents", `${role}.md`),
        "utf8",
      );
      expect(content, `${role}.md must not contain model:`).not.toContain(
        "model:",
      );
    }
  });

  it("writes the --opencode-provider hint to STDERR (not stdout) when catalog is empty", () => {
    const result = runOpencodeCli([], { PATH: emptyBinDir });
    expect(result.status, result.stderr).toBe(0);
    // The combined warning from resolveOpencodeModels is forwarded to stderr
    // by the CLI; it must not bleed onto stdout.
    expect(result.stderr).toContain("--opencode-provider");
    expect(result.stdout).not.toContain("--opencode-provider");
  });

  it("accepts --opencode-provider as a valid flag and exits 0", () => {
    // With an empty catalog the provider is found but has no matching models,
    // so models fall back to undefined (no model: line). The important
    // assertion is that the flag is recognised — not "unknown option".
    const result = runOpencodeCli(["--opencode-provider", "github-copilot"], {
      PATH: emptyBinDir,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("--tiers with an empty catalog warns once per unresolved model class on stderr, states the real effect (no file, not a missing model: line) and the real scope (opencode only), and renders no variant files", () => {
    const result = runOpencodeCli(["--tiers"], { PATH: emptyBinDir });
    expect(result.status, result.stderr).toBe(0);
    // Full-wording assertion (review round 2, R2-M3): the message must
    // state the real rendering effect (no opencode variant file at all,
    // not "model: will be omitted") and the real scope (opencode only;
    // Claude Code variants are unaffected), not just name the model class.
    const classToAlias: Record<string, string> = {
      small: "haiku",
      medium: "sonnet",
      large: "opus",
    };
    for (const [modelClass, alias] of Object.entries(classToAlias)) {
      expect(result.stderr, modelClass).toContain(
        `Warning: Tier model class "${modelClass}" (alias "${alias}") could not be resolved to an opencode model id (no provider offering Claude models found in the live catalog); no opencode effort-tier variant files will be rendered for this class (Claude Code variants are unaffected).`,
      );
    }
    expect(result.stdout).not.toContain(`Tier model class`);

    const agents = readdirSync(join(target, ".opencode", "agents"));
    expect(agents.sort()).toEqual([
      "explorer.md",
      "implementer.md",
      "reviewer.md",
      "task-slicer.md",
    ]);
  });

  it("--tiers with fully-qualified --models but still no live catalog: same warning + no variant files (FQ role models do not bypass class resolution)", () => {
    const result = runOpencodeCli(
      [
        "--tiers",
        "--models",
        "explorer=openrouter/some-model,task-slicer=openrouter/some-model,implementer=openrouter/some-model,reviewer=openrouter/some-model",
      ],
      { PATH: emptyBinDir },
    );
    expect(result.status, result.stderr).toBe(0);
    const classToAlias: Record<string, string> = {
      small: "haiku",
      medium: "sonnet",
      large: "opus",
    };
    for (const [modelClass, alias] of Object.entries(classToAlias)) {
      expect(result.stderr, modelClass).toContain(
        `Warning: Tier model class "${modelClass}" (alias "${alias}") could not be resolved to an opencode model id (no provider offering Claude models found in the live catalog); no opencode effort-tier variant files will be rendered for this class (Claude Code variants are unaffected).`,
      );
    }
    const agents = readdirSync(join(target, ".opencode", "agents"));
    expect(agents.sort()).toEqual([
      "explorer.md",
      "implementer.md",
      "reviewer.md",
      "task-slicer.md",
    ]);
  });
});

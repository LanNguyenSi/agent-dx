import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  PACKAGE_VERSION,
  listTemplateNames,
  readAgentAsset,
  readAsset,
} from "./assets.js";
import type { Harness } from "./detect.js";
import type { Role } from "./models.js";
import { ROLES, claudeModelValue, opencodeModelValue } from "./models.js";
import type { Report } from "./writers.js";
import {
  emptyReport,
  ensureClaudeImport,
  installFile,
  upsertMarkerSection,
} from "./writers.js";

export interface InitOptions {
  targetDir: string;
  harnesses: Harness[];
  models: Record<Role, string>;
  force?: boolean;
}

const SKILL_NAME = "orchestrator-workflow";

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function composeClaudeAgent(role: Role, model: string): string {
  const asset = readAgentAsset(role);
  return [
    "---",
    `name: ${asset.name}`,
    `description: ${yamlQuote(asset.description)}`,
    `model: ${claudeModelValue(model)}`,
    "---",
    "",
    asset.body.trimEnd(),
    "",
  ].join("\n");
}

function composeOpencodeAgent(role: Role, model: string): string {
  const asset = readAgentAsset(role);
  return [
    "---",
    `description: ${yamlQuote(asset.description)}`,
    "mode: subagent",
    `model: ${opencodeModelValue(model)}`,
    "---",
    "",
    asset.body.trimEnd(),
    "",
  ].join("\n");
}

interface Manifest {
  kit: string;
  version: string;
  harnesses: Harness[];
  models: Record<Role, string>;
  installedAt: string;
}

/**
 * The manifest is only rewritten when version, harnesses, or models actually
 * change, so a plain re-run stays a byte-for-byte no-op.
 */
function upsertManifest(
  report: Report,
  path: string,
  options: InitOptions,
): void {
  const desired = {
    kit: SKILL_NAME,
    version: PACKAGE_VERSION,
    harnesses: [...options.harnesses].sort(),
    models: options.models,
  };
  let existing: Manifest | undefined;
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    } catch {
      existing = undefined;
    }
  }
  if (
    existing &&
    JSON.stringify({
      kit: existing.kit,
      version: existing.version,
      harnesses: existing.harnesses,
      models: existing.models,
    }) === JSON.stringify(desired)
  ) {
    report.skipped.push(path);
    return;
  }
  const manifest: Manifest = {
    ...desired,
    installedAt: existing?.installedAt ?? new Date().toISOString(),
  };
  installFile(report, path, `${JSON.stringify(manifest, null, 2)}\n`, {
    force: true,
  });
}

export function runInit(options: InitOptions): Report {
  const { targetDir } = options;
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    throw new Error(`Target directory does not exist: ${targetDir}`);
  }
  const force = options.force ?? false;
  const report = emptyReport();

  for (const name of listTemplateNames()) {
    installFile(
      report,
      join(targetDir, ".ai", "workflow", "templates", name),
      readAsset(join("templates", name)),
      { force },
    );
  }
  installFile(report, join(targetDir, ".ai", "runs", ".gitkeep"), "", {
    force,
  });
  upsertManifest(
    report,
    join(targetDir, ".ai", "workflow", "manifest.json"),
    options,
  );

  // Codex and opencode read AGENTS.md natively; Claude Code gets it via the
  // CLAUDE.md import. The policy section is therefore installed regardless of
  // the harness selection.
  upsertMarkerSection(
    report,
    join(targetDir, "AGENTS.md"),
    readAsset("agents-md-section.md"),
  );

  const skill = readAsset(join("skill", "SKILL.md"));

  if (options.harnesses.includes("claude")) {
    installFile(
      report,
      join(targetDir, ".claude", "skills", SKILL_NAME, "SKILL.md"),
      skill,
      { force },
    );
    for (const role of ROLES) {
      installFile(
        report,
        join(targetDir, ".claude", "agents", `${role}.md`),
        composeClaudeAgent(role, options.models[role]),
        { force },
      );
    }
    ensureClaudeImport(report, join(targetDir, "CLAUDE.md"));
  }

  if (options.harnesses.includes("codex")) {
    installFile(
      report,
      join(targetDir, ".agents", "skills", SKILL_NAME, "SKILL.md"),
      skill,
      { force },
    );
  }

  if (options.harnesses.includes("opencode")) {
    for (const role of ROLES) {
      installFile(
        report,
        join(targetDir, ".opencode", "agents", `${role}.md`),
        composeOpencodeAgent(role, options.models[role]),
        { force },
      );
    }
  }

  return report;
}

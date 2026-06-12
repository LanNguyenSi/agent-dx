import { createHash } from "node:crypto";
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
const MANIFEST_PATH = join(".ai", "workflow", "manifest.json");

export interface Manifest {
  kit: string;
  version: string;
  harnesses: Harness[];
  models: Record<Role, string>;
  /**
   * sha256 of every kit-owned file as installed. This is how a re-run tells
   * "upstream changed, safe to update" apart from "user edited, conflict".
   */
  files: Record<string, string>;
  installedAt: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Reads the manifest of a previous install, if any. */
export function readInstalledManifest(targetDir: string): Manifest | undefined {
  const path = join(targetDir, MANIFEST_PATH);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

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

export function runInit(options: InitOptions): Report {
  const { targetDir } = options;
  if (!existsSync(targetDir)) {
    throw new Error(`Target directory does not exist: ${targetDir}`);
  }
  if (!statSync(targetDir).isDirectory()) {
    throw new Error(`Target is not a directory: ${targetDir}`);
  }
  const force = options.force ?? false;
  const report = emptyReport();

  const previous = readInstalledManifest(targetDir);
  const installedFiles: Record<string, string> = {};

  /**
   * Installs a kit-owned file. An unedited file (it still matches the hash
   * recorded at install time) is updated in place when the kit content
   * changed; a locally edited file is only overwritten with --force.
   */
  const installKitFile = (relativePath: string, content: string): void => {
    const path = join(targetDir, relativePath);
    const recorded = previous?.files?.[relativePath];
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8");
      const unedited = recorded !== undefined && sha256(existing) === recorded;
      installFile(report, path, content, { force: force || unedited });
      if (readFileSync(path, "utf8") === content) {
        installedFiles[relativePath] = sha256(content);
      } else if (recorded !== undefined) {
        // Conflicted: the user's edit stays, and so does the original record.
        installedFiles[relativePath] = recorded;
      }
      return;
    }
    installFile(report, path, content, { force });
    installedFiles[relativePath] = sha256(content);
  };

  for (const name of listTemplateNames()) {
    installKitFile(
      join(".ai", "workflow", "templates", name),
      readAsset(join("templates", name)),
    );
  }
  installKitFile(join(".ai", "runs", ".gitkeep"), "");

  // Codex and opencode read AGENTS.md natively; Claude Code gets it via the
  // CLAUDE.md import. The policy section is therefore installed regardless of
  // the harness selection. AGENTS.md and CLAUDE.md are user-owned: only the
  // fenced section and the import line are ever touched.
  upsertMarkerSection(
    report,
    join(targetDir, "AGENTS.md"),
    readAsset("agents-md-section.md"),
  );

  const skill = readAsset(join("skill", "SKILL.md"));

  if (options.harnesses.includes("claude")) {
    installKitFile(join(".claude", "skills", SKILL_NAME, "SKILL.md"), skill);
    for (const role of ROLES) {
      installKitFile(
        join(".claude", "agents", `${role}.md`),
        composeClaudeAgent(role, options.models[role]),
      );
    }
    ensureClaudeImport(report, join(targetDir, "CLAUDE.md"));
  }

  if (options.harnesses.includes("codex")) {
    installKitFile(join(".agents", "skills", SKILL_NAME, "SKILL.md"), skill);
  }

  if (options.harnesses.includes("opencode")) {
    for (const role of ROLES) {
      installKitFile(
        join(".opencode", "agents", `${role}.md`),
        composeOpencodeAgent(role, options.models[role]),
      );
    }
  }

  // The manifest records applied state, so it is written last and only when
  // something actually differs; a plain re-run stays a byte-for-byte no-op.
  const desired = {
    kit: SKILL_NAME,
    version: PACKAGE_VERSION,
    harnesses: [...options.harnesses].sort(),
    models: options.models,
    files: installedFiles,
  };
  const manifestPath = join(targetDir, MANIFEST_PATH);
  if (
    previous &&
    JSON.stringify({
      kit: previous.kit,
      version: previous.version,
      harnesses: previous.harnesses,
      models: previous.models,
      files: previous.files,
    }) === JSON.stringify(desired)
  ) {
    report.skipped.push(manifestPath);
  } else {
    const manifest: Manifest = {
      ...desired,
      installedAt: previous?.installedAt ?? new Date().toISOString(),
    };
    installFile(
      report,
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        force: true,
      },
    );
  }

  return report;
}

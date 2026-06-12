#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { Command } from "commander";
import inquirer from "inquirer";

import { PACKAGE_VERSION } from "./assets.js";
import type { Harness } from "./detect.js";
import { HARNESSES, detectHarnesses, parseHarnessList } from "./detect.js";
import type { Role } from "./models.js";
import {
  DEFAULT_MODELS,
  MODEL_ALIASES,
  ROLES,
  assertValidModelId,
  parseModelsSpec,
} from "./models.js";
import { readInstalledManifest, runInit } from "./init.js";
import type { UninstallReport } from "./uninstall.js";
import { runUninstall } from "./uninstall.js";

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function showPaths(label: string, paths: string[]): void {
  if (paths.length === 0) return;
  console.log(`${label}:`);
  for (const path of paths) console.log(`  ${path}`);
}

function requireDirectory(dir: string): string | undefined {
  const targetDir = resolve(dir);
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    console.error(`Target is not a directory: ${targetDir}`);
    process.exitCode = 1;
    return undefined;
  }
  return targetDir;
}

async function promptHarnesses(
  detected: Harness[],
  installed: Harness[],
): Promise<Harness[]> {
  const known = [...new Set([...detected, ...installed])];
  const preselected = known.length > 0 ? known : ["claude" as Harness];
  const { harnesses } = await inquirer.prompt<{ harnesses: Harness[] }>([
    {
      type: "checkbox",
      name: "harnesses",
      message: "Install adapters for which harnesses?",
      choices: HARNESSES.map((harness) => ({
        name: harness + (detected.includes(harness) ? " (detected)" : ""),
        value: harness,
        checked: preselected.includes(harness),
      })),
      validate: (selection: unknown[]) =>
        selection.length > 0 || "Select at least one harness",
    },
  ]);
  return harnesses;
}

async function promptModels(
  base: Record<Role, string>,
): Promise<Record<Role, string>> {
  const models = { ...base };
  for (const role of ROLES) {
    const { choice } = await inquirer.prompt<{ choice: string }>([
      {
        type: "list",
        name: "choice",
        message: `Model for the ${role} subagent:`,
        default: models[role],
        choices: [
          ...MODEL_ALIASES.map((alias) => ({
            name: alias === DEFAULT_MODELS[role] ? `${alias} (default)` : alias,
            value: alias,
          })),
          { name: "custom model id", value: "__custom__" },
        ],
      },
    ]);
    if (choice === "__custom__") {
      const { custom } = await inquirer.prompt<{ custom: string }>([
        {
          type: "input",
          name: "custom",
          message: `Custom model id for ${role}:`,
          validate: (value: string) => {
            try {
              assertValidModelId(value.trim());
              return true;
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          },
        },
      ]);
      models[role] = custom.trim();
    } else {
      models[role] = choice;
    }
  }
  return models;
}

const program = new Command();

program
  .name("orchestrator-workflow")
  .description(
    "Install an orchestrator-led agent workflow into a repository: .ai/ run state, an AGENTS.md policy section, and per-harness subagent definitions",
  )
  .version(PACKAGE_VERSION);

program
  .command("init")
  .description("Install or refresh the workflow kit in a target repository")
  .argument("[dir]", "target repository directory", ".")
  .option("-y, --yes", "accept all defaults and skip prompts")
  .option("-f, --force", "overwrite kit-owned files that have local edits")
  .option(
    "--harness <list>",
    `comma-separated harnesses (${HARNESSES.join(", ")}); default: detected`,
  )
  .option(
    "--models <spec>",
    'per-role model overrides, e.g. "implementer=sonnet,reviewer=opus"',
  )
  .action(
    async (
      dir: string,
      opts: {
        yes?: boolean;
        force?: boolean;
        harness?: string;
        models?: string;
      },
    ) => {
      const targetDir = requireDirectory(dir);
      if (!targetDir) return;
      const interactive = !opts.yes && isInteractive();

      // Say where files will land BEFORE anything is written; an accidental
      // cwd (e.g. $HOME) is the most likely operator mistake.
      console.log(`Installing into ${targetDir}`);
      if (!existsSync(join(targetDir, ".git"))) {
        console.log(
          "Note: the target is not a git repository root. Pass a directory argument (init <dir>) if this is not the repo you meant.",
        );
      }

      const detected = detectHarnesses(targetDir);
      console.log(
        detected.length > 0
          ? `Detected harness configs: ${detected.join(", ")}`
          : "No existing harness configs detected",
      );
      // A previous install is the baseline; re-runs refresh it instead of
      // resetting harnesses and models to the shipped defaults.
      const previous = readInstalledManifest(targetDir);
      if (previous) {
        const version = previous.version || "unknown version";
        const installedFor =
          previous.harnesses.length > 0
            ? previous.harnesses.join(", ")
            : "none recorded";
        console.log(
          `Found existing install (${version.startsWith("unknown") ? version : `v${version}`}, harnesses: ${installedFor})`,
        );
      }

      let harnesses: Harness[];
      if (opts.harness) {
        harnesses = parseHarnessList(opts.harness);
      } else {
        const installed = previous?.harnesses ?? [];
        const fallback = [...new Set([...detected, ...installed])];
        harnesses = interactive
          ? await promptHarnesses(detected, installed)
          : fallback.length > 0
            ? fallback
            : ["claude"];
      }

      let models: Record<Role, string> = {
        ...DEFAULT_MODELS,
        ...(previous?.models ?? {}),
      };
      if (opts.models) models = parseModelsSpec(opts.models, models);
      if (interactive && !opts.models) models = await promptModels(models);

      const report = runInit({
        targetDir,
        harnesses,
        models,
        force: opts.force,
      });

      showPaths("Created", report.written);
      showPaths("Updated", report.updated);
      showPaths("Unchanged", report.skipped);
      showPaths(
        "Conflicts (local edits kept, re-run with --force to overwrite)",
        report.conflicted,
      );
      console.log(
        `\norchestrator-workflow v${PACKAGE_VERSION} installed for: ${harnesses.join(", ")}`,
      );
    },
  );

program
  .command("uninstall")
  .description(
    "Remove everything init installed from a target repository; run history under .ai/runs/ is kept",
  )
  .argument("[dir]", "target repository directory", ".")
  .option("-y, --yes", "do not ask for confirmation")
  .option("-f, --force", "also remove kit files that have local edits")
  .action(async (dir: string, opts: { yes?: boolean; force?: boolean }) => {
    const targetDir = requireDirectory(dir);
    if (!targetDir) return;
    console.log(`Uninstalling from ${targetDir}`);

    if (!opts.yes) {
      if (!isInteractive()) {
        console.error(
          "Refusing to uninstall without confirmation in a non-interactive session; pass --yes.",
        );
        process.exitCode = 1;
        return;
      }
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
        {
          type: "confirm",
          name: "confirmed",
          message: `Remove the orchestrator-workflow kit from ${targetDir}?`,
          default: false,
        },
      ]);
      if (!confirmed) {
        console.log("Aborted.");
        return;
      }
    }

    let report: UninstallReport;
    try {
      report = runUninstall({ targetDir, force: opts.force });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      return;
    }
    showPaths("Removed", report.removed);
    showPaths("Kept (local edits or damaged fence)", report.kept);
    showPaths("Already absent", report.missing);
    for (const note of report.notes) console.log(note);
    console.log(`\norchestrator-workflow uninstalled from ${targetDir}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

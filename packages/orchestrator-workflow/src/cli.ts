#!/usr/bin/env node
import { resolve } from "node:path";

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
  parseModelsSpec,
} from "./models.js";
import { runInit } from "./init.js";

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptHarnesses(detected: Harness[]): Promise<Harness[]> {
  const preselected = detected.length > 0 ? detected : ["claude" as Harness];
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
          validate: (value: string) =>
            value.trim().length > 0 || "Model id must not be empty",
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
      const targetDir = resolve(dir);
      const interactive = !opts.yes && isInteractive();

      const detected = detectHarnesses(targetDir);
      console.log(
        detected.length > 0
          ? `Detected harness configs: ${detected.join(", ")}`
          : "No existing harness configs detected",
      );

      let harnesses: Harness[];
      if (opts.harness) {
        harnesses = parseHarnessList(opts.harness);
      } else {
        harnesses = interactive
          ? await promptHarnesses(detected)
          : detected.length > 0
            ? detected
            : ["claude"];
      }

      let models: Record<Role, string> = { ...DEFAULT_MODELS };
      if (opts.models) models = parseModelsSpec(opts.models, models);
      if (interactive && !opts.models) models = await promptModels(models);

      const report = runInit({
        targetDir,
        harnesses,
        models,
        force: opts.force,
      });

      const show = (label: string, paths: string[]) => {
        if (paths.length === 0) return;
        console.log(`${label}:`);
        for (const path of paths) console.log(`  ${path}`);
      };
      show("Created", report.written);
      show("Updated", report.updated);
      show("Unchanged", report.skipped);
      show(
        "Conflicts (local edits kept, re-run with --force to overwrite)",
        report.conflicted,
      );
      console.log(
        `\norchestrator-workflow v${PACKAGE_VERSION} installed for: ${harnesses.join(", ")}`,
      );
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

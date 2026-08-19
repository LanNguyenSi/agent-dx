#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { Command } from "commander";
import inquirer from "inquirer";

import { PACKAGE_VERSION } from "./assets.js";
import type { Harness } from "./detect.js";
import { HARNESSES, detectHarnesses, parseHarnessList } from "./detect.js";
import type { ModelClass, Profile, Role } from "./models.js";
import {
  CLASS_MODELS,
  DEFAULT_MODELS,
  DEFAULT_PROFILE,
  MODEL_ALIASES,
  MODEL_CLASSES,
  PROFILES,
  assertValidModelId,
  parseModelsSpec,
  parseProfile,
  rolesForProfile,
} from "./models.js";
import {
  detectProvider,
  loadOpencodeCatalog,
  resolveAlias,
  resolveOpencodeModels,
} from "./opencode.js";
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

async function promptProfile(base: Profile): Promise<Profile> {
  const { profile } = await inquirer.prompt<{ profile: Profile }>([
    {
      type: "list",
      name: "profile",
      message: "Which subagent roles should be installed?",
      default: base,
      choices: [
        {
          name: "full — explorer, task-slicer, implementer, reviewer (default)",
          value: "full",
        },
        {
          name: "minimal — implementer, reviewer only (reviewer is never optional)",
          value: "minimal",
        },
      ],
    },
  ]);
  return profile;
}

async function promptModels(
  base: Record<Role, string>,
  roles: Role[],
): Promise<Record<Role, string>> {
  const models = { ...base };
  for (const role of roles) {
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
  .option(
    "--profile <profile>",
    `subagent role profile (${PROFILES.join(", ")}); default: full, or the previously installed profile on a re-run`,
  )
  .option(
    "--opencode-provider <id>",
    "opencode provider id for alias resolution (e.g. github-copilot); auto-detected when omitted",
  )
  .option(
    "--tiers",
    "also render per-role effort-tier subagent variants (<role>-<tier>.md); default: off, or the previously installed value on a re-run",
  )
  .option(
    "--no-tiers",
    "explicitly turn effort-tier subagent variants off, overriding a previously installed --tiers value",
  )
  .action(
    async (
      dir: string,
      opts: {
        yes?: boolean;
        force?: boolean;
        harness?: string;
        models?: string;
        profile?: string;
        opencodeProvider?: string;
        tiers?: boolean;
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
          `Found existing install (${version.startsWith("unknown") ? version : `v${version}`}, harnesses: ${installedFor}, profile: ${previous.profile}, tiers: ${previous.tiers})`,
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

      // Explicit --profile always overrides; a plain re-run keeps the
      // profile from the previous install (same override-vs-persist rule as
      // --harness/--models above); a fresh install with no prior manifest
      // defaults to full.
      let profile: Profile;
      if (opts.profile) {
        profile = parseProfile(opts.profile);
      } else {
        profile = previous?.profile ?? DEFAULT_PROFILE;
        if (interactive) profile = await promptProfile(profile);
      }

      let models: Record<Role, string> = {
        ...DEFAULT_MODELS,
        ...(previous?.models ?? {}),
      };
      if (opts.models) models = parseModelsSpec(opts.models, models);
      if (interactive && !opts.models)
        models = await promptModels(models, rolesForProfile(profile));

      // Explicit --tiers/--no-tiers always override; a plain re-run (neither
      // flag passed) keeps whatever the previous install had (default false
      // for a fresh install), same override-vs-persist rule as
      // --profile/--models above. commander's negatable-option pairing
      // (--tiers / --no-tiers declared under the same "tiers" option name)
      // resolves opts.tiers to `true` when --tiers is passed, `false` when
      // --no-tiers is passed, and `undefined` when neither is passed; the
      // CLI re-run test below verifies this against the installed commander
      // version rather than assuming it. No interactive prompt: tiers is
      // opt-in/off via the flags only.
      const tiers = opts.tiers ?? previous?.tiers ?? false;

      // Resolve opencode model aliases against the live catalog when the opencode
      // harness is selected. The shell-out stays here in the CLI so runInit
      // remains pure.
      let opencodeModels: Record<Role, string | undefined> | undefined;
      let opencodeClassModels:
        | Record<ModelClass, string | undefined>
        | undefined;
      if (harnesses.includes("opencode")) {
        const catalog = loadOpencodeCatalog();
        const { resolved, warnings } = resolveOpencodeModels(models, {
          catalog,
          explicitProvider: opts.opencodeProvider,
        });
        opencodeModels = resolved;
        for (const w of warnings) {
          process.stderr.write(`Warning: ${w}\n`);
        }
        if (tiers) {
          const providerResult = detectProvider({
            catalog,
            explicit: opts.opencodeProvider,
          });
          opencodeClassModels = {} as Record<ModelClass, string | undefined>;
          for (const modelClass of MODEL_CLASSES) {
            const alias = CLASS_MODELS[modelClass];
            const resolved = providerResult.provider
              ? resolveAlias(providerResult.provider, alias, catalog)
              : undefined;
            opencodeClassModels[modelClass] = resolved;
            if (resolved !== undefined) continue;
            // One warning per unresolved model class: without it, every
            // effort-tier variant keyed to this class silently rendered
            // with no model: line (init.ts now additionally skips a
            // variant that would also carry no effort line at all).
            const reason = providerResult.provider
              ? `provider "${providerResult.provider}" has no "${alias}" model in the catalog`
              : providerResult.ambiguous
                ? `multiple providers offer Claude models in the live catalog; cannot auto-detect`
                : `no provider offering Claude models found in the live catalog`;
            process.stderr.write(
              `Warning: Tier model class "${modelClass}" (alias "${alias}"): ${reason}; model: will be omitted for its effort-tier variants.\n`,
            );
          }
        }
      }

      const report = runInit({
        targetDir,
        harnesses,
        models,
        profile,
        force: opts.force,
        opencodeModels,
        tiers,
        opencodeClassModels,
      });

      showPaths("Created", report.written);
      showPaths("Updated", report.updated);
      showPaths("Unchanged", report.skipped);
      showPaths(
        "Conflicts (local edits kept, re-run with --force to overwrite)",
        report.conflicted,
      );
      for (const note of report.notes) console.log(note);
      console.log(
        `\norchestrator-workflow v${PACKAGE_VERSION} installed for: ${harnesses.join(", ")} (profile: ${profile}, tiers: ${tiers})`,
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

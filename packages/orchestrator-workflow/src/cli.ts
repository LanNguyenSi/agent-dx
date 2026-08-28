#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { Command } from "commander";
import inquirer from "inquirer";

import { PACKAGE_VERSION } from "./assets.js";
import { resolveInitInputs } from "./cli-inputs.js";
import { HARNESSES, detectHarnesses } from "./detect.js";
import type { Harness } from "./detect.js";
import { DEFAULT_MODELS, PROFILES } from "./models.js";
import { readInstalledManifest, runInit } from "./init.js";
import type { Manifest } from "./init.js";
import {
  createOperatorManifest,
  operatorManifestState,
  readOperatorManifest,
  resolveOperatorHome,
  upsertOperatorTarget,
  writeOperatorManifest,
} from "./operator-manifest.js";
import type {
  OperatorManifest,
  OperatorManifestDefaults,
} from "./operator-manifest.js";
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

/**
 * `resolveInitInputs` was extracted from `init` and typed against `init`'s
 * per-repo `Manifest` (kit/version/files/installedAt included), since that
 * is the only "previous install" shape it existed to read before this
 * command. `setup` has no repository and no such record; it only has the
 * operator manifest's `defaults` (harnesses/profile/models/tiers). The
 * function only ever reads those four fields off `previous`, so this maps
 * `defaults` into a `Manifest`-shaped value with harmless placeholders for
 * the unused fields, rather than changing `resolveInitInputs`'s signature
 * or semantics.
 */
function defaultsAsManifest(
  defaults: OperatorManifestDefaults | undefined,
): Manifest | undefined {
  if (!defaults) return undefined;
  return {
    kit: "orchestrator-workflow",
    version: PACKAGE_VERSION,
    harnesses: defaults.harnesses,
    models: { ...DEFAULT_MODELS, ...defaults.models },
    profile: defaults.profile,
    tiers: defaults.tiers,
    files: {},
    installedAt: "",
  };
}

/**
 * Order- and completeness-insensitive comparison of two operator defaults
 * sets, used to decide whether `setup` needs to rewrite the manifest at
 * all (a plain re-run that resolves to the same values must not touch
 * `updatedAt` or the file).
 */
function defaultsEqual(
  a: OperatorManifestDefaults,
  b: OperatorManifestDefaults,
): boolean {
  const normalize = (d: OperatorManifestDefaults) =>
    JSON.stringify({
      harnesses: [...d.harnesses].sort(),
      profile: d.profile,
      tiers: d.tiers,
      models: Object.fromEntries(
        Object.entries(d.models).sort(([x], [y]) => x.localeCompare(y)),
      ),
    });
  return normalize(a) === normalize(b);
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

      const {
        harnesses,
        profile,
        models,
        tiers,
        opencodeModels,
        opencodeClassModels,
        warnings,
      } = await resolveInitInputs({
        detected,
        interactive,
        previous,
        opts,
      });
      for (const w of warnings) {
        process.stderr.write(`${w}\n`);
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
  .command("setup")
  .description(
    "Write or update this operator's default install options (harnesses, profile, models, tiers), used as the baseline for future installs; touches no repository",
  )
  .option("-y, --yes", "accept all defaults and skip prompts")
  .option(
    "--harness <list>",
    `comma-separated harnesses (${HARNESSES.join(", ")}); default: previously stored, or claude`,
  )
  .option(
    "--models <spec>",
    'per-role model overrides, e.g. "implementer=sonnet,reviewer=opus"',
  )
  .option(
    "--profile <profile>",
    `subagent role profile (${PROFILES.join(", ")}); default: full, or the previously stored profile on a re-run`,
  )
  .option(
    "--opencode-provider <id>",
    "opencode provider id for alias resolution (e.g. github-copilot); auto-detected when omitted",
  )
  .option(
    "--tiers",
    "select per-role effort-tier subagent variants by default; default: off, or the previously stored value on a re-run",
  )
  .option(
    "--no-tiers",
    "explicitly turn effort-tier subagent variants off, overriding a previously stored --tiers value",
  )
  .action(
    async (opts: {
      yes?: boolean;
      harness?: string;
      models?: string;
      profile?: string;
      opencodeProvider?: string;
      tiers?: boolean;
    }) => {
      const interactive = !opts.yes && isInteractive();
      const home = resolveOperatorHome();
      console.log(`Operator home: ${home}`);

      const existing = readOperatorManifest(home);
      if (existing) {
        const installedFor =
          existing.defaults.harnesses.length > 0
            ? existing.defaults.harnesses.join(", ")
            : "none recorded";
        console.log(
          `Found existing operator defaults (harnesses: ${installedFor}, profile: ${existing.defaults.profile}, tiers: ${existing.defaults.tiers})`,
        );
      }

      // No target repository exists to detect harnesses against; "claude"
      // is the same shipped fallback `init` uses for a fresh install with
      // nothing detected and nothing previously recorded.
      const { harnesses, profile, models, tiers, warnings } =
        await resolveInitInputs({
          // No target directory exists to detect against: the stored
          // harnesses are the baseline, and only a first-ever setup falls
          // back to claude, so a codex-only default is not widened silently.
          detected: existing?.defaults.harnesses.length
            ? existing.defaults.harnesses
            : ["claude"],
          interactive,
          previous: defaultsAsManifest(existing?.defaults),
          opts,
        });
      for (const w of warnings) {
        process.stderr.write(`${w}\n`);
      }

      const newDefaults: OperatorManifestDefaults = {
        harnesses,
        profile,
        tiers,
        models,
      };

      let status: "created" | "updated" | "unchanged";
      if (!existing) {
        const manifest = createOperatorManifest(newDefaults);
        writeOperatorManifest(home, manifest);
        status = "created";
      } else if (defaultsEqual(existing.defaults, newDefaults)) {
        status = "unchanged";
      } else {
        const manifest: OperatorManifest = {
          ...existing,
          defaults: newDefaults,
          updatedAt: new Date().toISOString(),
        };
        writeOperatorManifest(home, manifest);
        status = "updated";
      }

      console.log(`Harnesses: ${harnesses.join(", ")}`);
      console.log(`Profile: ${profile}`);
      console.log(
        `Models: ${Object.entries(models)
          .map(([role, model]) => `${role}=${model}`)
          .join(", ")}`,
      );
      console.log(`Tiers: ${tiers}`);
      console.log(
        status === "created"
          ? "Created operator defaults."
          : status === "updated"
            ? "Updated operator defaults."
            : "Unchanged.",
      );
      console.log("Next: orchestrator-workflow apply --target <repo>");
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

/**
 * Realpath that never throws, `apply`'s own copy of the same-purpose
 * helper in operator-manifest.ts (not exported from there): a target that
 * vanished between `requireDirectory`'s existence check and this
 * resolution must not crash the whole apply, so the path is compared,
 * stored, and printed as written when it can no longer be resolved.
 */
function safeRealpathForApply(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/**
 * Detects a repo manifest whose raw JSON carries a `pin` key that
 * `readInstalledManifest` (init.ts) silently dropped rather than surfacing:
 * a non-string value, or a string that is empty or whitespace-only after
 * trimming. `readInstalledManifest` already re-parses the file itself and
 * applies this exact degradation rule for `pin` specifically; this helper
 * duplicates just that one check against a second, independent parse of
 * the same file, rather than changing `readInstalledManifest`'s return
 * shape to also report which fields it dropped. Read failures (missing
 * file, invalid JSON, non-object) are not this helper's concern: they are
 * already `readInstalledManifest`'s "no record" case, with no pin to warn
 * about either way.
 */
function repoManifestHasMalformedPin(targetDir: string): boolean {
  const path = join(targetDir, ".ai", "workflow", "manifest.json");
  if (!existsSync(path)) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (typeof raw !== "object" || raw === null) return false;
  const candidate = raw as Record<string, unknown>;
  if (!("pin" in candidate)) return false;
  return !(typeof candidate.pin === "string" && candidate.pin.trim() !== "");
}

/**
 * Resolves `apply`'s harnesses ahead of `resolveInitInputs`, per the
 * fallback chain an explicit `--harness` does not need: the target's own
 * recorded harnesses, else the operator manifest's default harnesses, else
 * (only when both are empty) `detectHarnesses(targetDir)` or `["claude"]`,
 * the same shipped fallback `init` uses. The result is handed to
 * `resolveInitInputs` as `detected`, and mirrored into the synthetic
 * `previous.harnesses` field built by `buildApplyPrevious` below, so
 * `resolveInitInputs`'s own union-of-detected-and-installed fallback
 * resolves to exactly this value rather than widening it further.
 */
function resolveApplyHarnesses(
  targetDir: string,
  repoManifest: Manifest | undefined,
  operatorDefaults: OperatorManifestDefaults,
): Harness[] {
  if (repoManifest && repoManifest.harnesses.length > 0) {
    return repoManifest.harnesses;
  }
  if (operatorDefaults.harnesses.length > 0) {
    return operatorDefaults.harnesses;
  }
  const detected = detectHarnesses(targetDir);
  return detected.length > 0 ? detected : ["claude"];
}

/**
 * Builds the synthetic `previous` manifest handed to `resolveInitInputs`,
 * implementing `apply`'s profile/tiers/models precedence: operator defaults
 * are the floor; when the target has its own recorded manifest, that
 * recording overrides the operator default for profile/tiers/models UNLESS
 * `--sync` is passed, in which case the operator default overrides the
 * recording instead (an explicit CLI flag still wins over either, handled
 * inside `resolveInitInputs` itself). `harnesses` on the returned value is
 * always the target's own recorded harnesses (never the operator default),
 * since `--sync` only affects profile/tiers/models per the rule above; the
 * full harnesses fallback chain is `resolveApplyHarnesses`'s job, not this
 * function's.
 */
function buildApplyPrevious(
  repoManifest: Manifest | undefined,
  operatorDefaults: OperatorManifestDefaults,
  sync: boolean,
): Manifest {
  const harnesses = repoManifest?.harnesses ?? [];
  const models = sync
    ? { ...DEFAULT_MODELS, ...operatorDefaults.models }
    : {
        ...DEFAULT_MODELS,
        ...operatorDefaults.models,
        ...repoManifest?.models,
      };
  const profile = sync
    ? operatorDefaults.profile
    : (repoManifest?.profile ?? operatorDefaults.profile);
  const tiers = sync
    ? operatorDefaults.tiers
    : (repoManifest?.tiers ?? operatorDefaults.tiers);
  return {
    kit: "orchestrator-workflow",
    version: PACKAGE_VERSION,
    harnesses,
    models,
    profile,
    tiers,
    files: {},
    installedAt: "",
  };
}

program
  .command("apply")
  .description(
    "Project this operator's install onto a target repository, sourced from the operator manifest's defaults and the target's previously recorded settings; registers the target in the operator manifest",
  )
  .requiredOption(
    "--target <repo>",
    "target repository directory to apply the kit to",
  )
  .option("-y, --yes", "accept all defaults and skip prompts")
  .option("-f, --force", "overwrite kit-owned files that have local edits")
  .option(
    "--harness <list>",
    `comma-separated harnesses (${HARNESSES.join(", ")}); default: the target's recorded harnesses, else the operator defaults, else detected`,
  )
  .option(
    "--models <spec>",
    'per-role model overrides, e.g. "implementer=sonnet,reviewer=opus"',
  )
  .option(
    "--profile <profile>",
    `subagent role profile (${PROFILES.join(", ")}); default: the target's recorded profile, else the operator default`,
  )
  .option(
    "--opencode-provider <id>",
    "opencode provider id for alias resolution (e.g. github-copilot); auto-detected when omitted",
  )
  .option(
    "--tiers",
    "also render per-role effort-tier subagent variants (<role>-<tier>.md); default: the target's recorded value, else the operator default",
  )
  .option(
    "--no-tiers",
    "explicitly turn effort-tier subagent variants off, overriding a recorded or operator-default --tiers value",
  )
  .option(
    "--sync",
    "let the operator defaults for profile/tiers/models override the target's own recorded values, instead of the other way around",
  )
  .option(
    "--force-pin",
    "proceed past an existing pin that differs from this operator install's version, advancing it to this version; has no effect on a target with no pin recorded (it stays unpinned)",
  )
  .option(
    "--pin <version>",
    "set or replace the target's recorded kit-version pin and apply this operator install regardless of any existing pin",
  )
  .option(
    "--unpin",
    "clear the target's recorded kit-version pin and apply this operator install",
  )
  .action(
    async (opts: {
      target: string;
      yes?: boolean;
      force?: boolean;
      harness?: string;
      models?: string;
      profile?: string;
      opencodeProvider?: string;
      tiers?: boolean;
      sync?: boolean;
      forcePin?: boolean;
      pin?: string;
      unpin?: boolean;
    }) => {
      // --pin and --unpin express opposite intents (set a pin vs clear it);
      // accepting both silently would make the effective pin depend on
      // internal option-resolution order, so this is a usage error rather
      // than an implicit precedence rule.
      if (opts.pin !== undefined && opts.unpin) {
        console.error("--pin and --unpin cannot be used together");
        process.exitCode = 2;
        return;
      }
      let pinArg: string | undefined;
      if (opts.pin !== undefined) {
        const trimmed = opts.pin.trim();
        if (trimmed === "" || /\s/.test(trimmed)) {
          console.error(
            `Invalid --pin value: ${JSON.stringify(opts.pin)}; must be non-empty with no internal whitespace`,
          );
          process.exitCode = 2;
          return;
        }
        pinArg = trimmed;
      }

      const home = resolveOperatorHome();
      // `state.manifest` (the "early copy") is used only for the pin-gate
      // guard just below and for `chosenHarnesses`/`previous`'s defaults;
      // the upsert at the end re-reads the manifest again immediately
      // before writing, rather than reusing this copy, so a target another
      // concurrent `apply` registered in between is not lost. See that
      // re-read's own comment for why the window is narrowed, not closed.
      const state = operatorManifestState(home);
      if (state.kind === "unreadable") {
        console.error(
          `Operator manifest at ${join(home, "manifest.json")} is unreadable; back it up and repair it, or remove it and run \`orchestrator-workflow setup\` again.`,
        );
        process.exitCode = 1;
        return;
      }
      if (state.kind === "absent") {
        console.error(
          "No operator setup found; run `orchestrator-workflow setup` first.",
        );
        process.exitCode = 1;
        return;
      }
      const operatorManifest = state.manifest;

      const targetDir = requireDirectory(opts.target);
      if (!targetDir) return;
      const interactive = !opts.yes && isInteractive();

      const repoManifest = readInstalledManifest(targetDir);
      if (repoManifest) {
        const version = repoManifest.version || "unknown version";
        const installedFor =
          repoManifest.harnesses.length > 0
            ? repoManifest.harnesses.join(", ")
            : "none recorded";
        console.log(
          `Found existing install (${version.startsWith("unknown") ? version : `v${version}`}, harnesses: ${installedFor}, profile: ${repoManifest.profile}, tiers: ${repoManifest.tiers})`,
        );
      }

      // A hand-written or damaged repo manifest may carry a `pin` key that
      // `readInstalledManifest` silently dropped (non-string, or
      // empty/whitespace after trimming) rather than throwing, the same
      // per-field-degradation style it uses for every other field; that
      // also means the pin gate just below never sees it. Warn once so the
      // operator knows the gate did not run rather than concluding the
      // target is simply unpinned.
      if (repoManifestHasMalformedPin(targetDir)) {
        process.stderr.write(
          `Ignoring a malformed pin in ${join(targetDir, ".ai", "workflow", "manifest.json")}; the pin gate did not run\n`,
        );
      }

      // Pin gate: a recorded pin that differs from this operator install's
      // kit version blocks a plain apply (the repo asked to stay put)
      // unless the operator explicitly overrides it, either by advancing to
      // the current kit version (--force-pin) or by setting an explicit pin
      // decision of its own (--pin/--unpin); either override is itself an
      // explicit instruction to proceed, so it takes priority over the gate.
      const repoPin = repoManifest?.pin;
      const pinOverridden = Boolean(
        opts.forcePin || pinArg !== undefined || opts.unpin,
      );
      if (repoPin && repoPin !== PACKAGE_VERSION && !pinOverridden) {
        console.log(
          `Repository is pinned at ${repoPin}; this operator install is v${PACKAGE_VERSION}. Skipping.`,
        );
        return;
      }

      // Say where files will land only once it is certain the apply is
      // actually going to run (the pin gate above may have already
      // returned): an accidental cwd read as `--target` is the most likely
      // operator mistake, and a skipped run must not claim an install is
      // starting. Mirrors `init`'s own "Installing into"/git-root note.
      console.log(`Installing into ${targetDir}`);
      if (!existsSync(join(targetDir, ".git"))) {
        console.log(
          "Note: the target is not a git repository root. Pass a different --target if this is not the repo you meant.",
        );
      }

      const chosenHarnesses = resolveApplyHarnesses(
        targetDir,
        repoManifest,
        operatorManifest.defaults,
      );
      const previous = buildApplyPrevious(
        repoManifest,
        operatorManifest.defaults,
        Boolean(opts.sync),
      );

      const {
        harnesses,
        profile,
        models,
        tiers,
        opencodeModels,
        opencodeClassModels,
        warnings,
      } = await resolveInitInputs({
        detected: chosenHarnesses,
        interactive,
        previous,
        opts,
      });
      for (const w of warnings) {
        process.stderr.write(`${w}\n`);
      }

      // `--unpin` clears; an explicit `--pin <version>` sets or replaces
      // (even when it equals the target's existing pin but differs from
      // PACKAGE_VERSION, since the operator asked for this kit version
      // explicitly, the pin gate above already let this call through);
      // `--force-pin` advances the pin to this operator install's version,
      // but only when `repoPin` already held one: it is a "proceed past the
      // gate and catch this target up" instruction, not a "pin this target
      // for the first time" one, so on an unpinned target it must leave the
      // target unpinned rather than pinning it to PACKAGE_VERSION as a side
      // effect; otherwise the pin carries forward unchanged (runInit's own
      // `undefined` semantics).
      const pin: string | null | undefined = opts.unpin
        ? null
        : pinArg !== undefined
          ? pinArg
          : opts.forcePin && repoPin
            ? PACKAGE_VERSION
            : undefined;

      const report = runInit({
        targetDir,
        harnesses,
        models,
        profile,
        force: opts.force,
        opencodeModels,
        tiers,
        opencodeClassModels,
        pin,
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

      // Re-read the operator manifest immediately before the upsert rather
      // than reusing `operatorManifest` (the copy read at the top, before
      // `runInit` did its file writes): a concurrent `apply` against the
      // same operator home may have registered its own target in the
      // meantime, and writing back the stale early copy would silently
      // lose that registration (last writer wins on the whole file, not a
      // per-target merge). This narrows the lost-update window to the gap
      // between this read and `writeOperatorManifest`'s rename, it does
      // not close it: two applies whose re-read both land before either
      // one's rename can still race. A vanished or newly-corrupt manifest
      // in that gap is reported and left unwritten rather than silently
      // recreated, since guessing its intended prior content is not this
      // command's call to make.
      const latestState = operatorManifestState(home);
      if (latestState.kind !== "ok") {
        const manifestPath = join(home, "manifest.json");
        console.error(
          latestState.kind === "unreadable"
            ? `Operator manifest at ${manifestPath} is unreadable; back it up and repair it, or remove it and run \`orchestrator-workflow setup\` again.`
            : `Operator manifest at ${manifestPath} is gone; ${targetDir} was installed but could not be registered. Run \`orchestrator-workflow setup\` and re-apply to register it.`,
        );
        process.exitCode = 1;
        return;
      }

      // A run with local edits that conflicted still registers the target
      // and records PACKAGE_VERSION here: the apply itself ran (the
      // conflicting files were left as the operator's local edits, not
      // skipped or aborted), so the registry should reflect that a
      // vPACKAGE_VERSION apply was attempted against this target, the same
      // as any other non-force-pin-gated run. Only the pin gate above
      // returns before reaching this point without registering.
      const resolvedTargetPath = safeRealpathForApply(targetDir);
      const alreadyRegistered = latestState.manifest.targets.some(
        (t) => t.path === resolvedTargetPath,
      );
      const updatedOperatorManifest = upsertOperatorTarget(
        latestState.manifest,
        resolvedTargetPath,
        PACKAGE_VERSION,
        new Date().toISOString(),
      );
      writeOperatorManifest(home, updatedOperatorManifest);
      console.log(
        alreadyRegistered
          ? `Refreshed the registry entry for ${resolvedTargetPath}`
          : `Registered ${resolvedTargetPath} in the operator manifest`,
      );
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

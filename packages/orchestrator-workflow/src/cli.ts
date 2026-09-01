#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { Command } from "commander";
import inquirer from "inquirer";

import { PACKAGE_VERSION } from "./assets.js";
import { resolveInitInputs } from "./cli-inputs.js";
import { HARNESSES, detectHarnesses } from "./detect.js";
import type { Harness } from "./detect.js";
import { DEFAULT_MODELS, PROFILES } from "./models.js";
import { MANIFEST_PATH, readInstalledManifest, runInit } from "./init.js";
import type { Manifest } from "./init.js";
import {
  OPERATOR_MANIFEST_FILENAME,
  OperatorManifestLockTimeoutError,
  applyRegistrationFailureMessage,
  createOperatorManifest,
  operatorManifestState,
  readOperatorManifest,
  resolveOperatorHome,
  safeRealpath,
  updateOperatorManifest,
  upsertOperatorTarget,
} from "./operator-manifest.js";
import type {
  OperatorManifest,
  OperatorManifestDefaults,
} from "./operator-manifest.js";
import type { UninstallReport } from "./uninstall.js";
import { runUninstall } from "./uninstall.js";
import {
  adoptExitCodeForStatus,
  adoptJsonExtras,
  inspectTarget,
  runDoctor,
  statOrClassify,
  suppressSuccessLine,
  targetReportToJson,
} from "./doctor.js";
import type { DoctorReport, TargetReport } from "./doctor.js";

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function showPaths(label: string, paths: string[]): void {
  if (paths.length === 0) return;
  console.log(`${label}:`);
  for (const path of paths) console.log(`  ${path}`);
}

/**
 * Formats the "installed for: ..." clause of `init`/`apply`'s final summary
 * line. An empty `harnesses` list is templates-only mode (`--harness none`):
 * "installed for: " with nothing after the colon reads as broken output, so
 * that case prints "templates only" instead.
 */
function installedForClause(harnesses: Harness[]): string {
  return harnesses.length > 0
    ? `installed for: ${harnesses.join(", ")}`
    : "templates only";
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
    `comma-separated harnesses (${HARNESSES.join(", ")}), or "none" alone for templates-only mode (.ai/workflow/** and .ai/runs/.gitkeep only, no AGENTS.md/CLAUDE.md/harness files); default: detected`,
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
        // `previous` here is `readInstalledManifest(targetDir)` (undefined,
        // or the target's own actually-recorded manifest), unlike `apply`'s
        // synthetic operator-defaults "floor" object: an empty harnesses
        // array is a real recorded --harness none install here.
        previousIsRecordedManifest: true,
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
        `\norchestrator-workflow v${PACKAGE_VERSION} ${installedForClause(harnesses)} (profile: ${profile}, tiers: ${tiers})`,
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

      // The prompts and resolution above ran against `existing`, an
      // unlocked read taken before this point; another process (an
      // `apply` registering a target, most plausibly) may have already
      // written a newer manifest by the time this reaches the lock. The
      // mutate callback below re-reads inside the lock (`current`) and
      // merges only the newly computed defaults onto that fresh copy, so
      // `current.targets`/`current.createdAt` are what survive into the
      // write, never `existing`'s (`updateOperatorManifest` is this
      // module's sole write path; nothing here calls the raw writer
      // directly). The unchanged/created/updated decision is likewise
      // made against `current.defaults`, not `existing.defaults`. A
      // manifest that re-reads as `unreadable` inside the lock (damaged or
      // hand-edited since the unlocked `existing` read above) must not be
      // silently replaced with a fresh one: that would discard whatever
      // targets survive in the damaged file. `mutate` returns `undefined`
      // in that case (no write), and the caller below reports it and exits
      // non-zero instead of ever printing a created/updated status.
      const result = updateOperatorManifest(home, (current, state) => {
        if (state.kind === "unreadable") {
          return undefined;
        }
        if (!current) {
          return createOperatorManifest(newDefaults);
        }
        if (defaultsEqual(current.defaults, newDefaults)) {
          return undefined;
        }
        // `updatedAt` is no longer set here: `updateOperatorManifest`
        // stamps it centrally on any write that refreshes an existing
        // manifest (`current` is truthy in this branch), the same way it
        // now does for `apply`'s and `adopt`'s own refreshes (fix-round,
        // review finding L10).
        const manifest: OperatorManifest = {
          ...current,
          defaults: newDefaults,
        };
        return manifest;
      });

      if (result.state.kind === "unreadable") {
        process.stderr.write(
          `Operator manifest at ${join(home, "manifest.json")} is unreadable; back it up and repair it (any recorded targets would be lost by overwriting it), or remove it and run setup again.\n`,
        );
        process.exitCode = 1;
        return;
      }

      const status: "created" | "updated" | "unchanged" = !result.written
        ? "unchanged"
        : result.state.kind === "ok"
          ? "updated"
          : "created";

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
 *
 * This chain is not the last word for a target whose own manifest recorded
 * a real `harnesses: []` (a deliberate `--harness none` install):
 * `resolveInitInputs`'s harnesses-stickiness gate (fed by
 * `previousIsRecordedManifest` and `previous.harnessesRecordedEmpty`, both
 * set by the caller below from `repoManifest`) overrides whatever this
 * function returns and keeps a non-interactive re-run templates-only. This
 * function's own fallback chain still runs first and its result is still
 * used as `detected` for any target whose manifest is missing or malformed
 * rather than deliberately empty, and for the normal (non-sticky) branch's
 * interactive prompt pre-check on a target with real recorded harnesses.
 * It is deliberately NOT reused as the sticky branch's own interactive
 * pre-check: that branch reads `resolveInitInputs`'s separate
 * `filesystemDetected` field instead, which the caller below fills with a
 * fresh `detectHarnesses(targetDir)` call, because this function's result
 * is never empty (it falls through the operator default and `["claude"]`
 * fallbacks) and would otherwise pre-check that fallback on a deliberately
 * templates-only target, letting a bare Enter re-widen the install
 * (agent-tasks fe834823).
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
 * function's. `harnessesRecordedEmpty` is carried straight from
 * `repoManifest` too (`undefined` when there is no repo manifest), so the
 * harnesses-stickiness gate in `resolveInitInputs` can see whether an empty
 * `harnesses` here was really a recorded `--harness none` or just the
 * "no repo manifest at all" case.
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
    // Carried straight from the target's own recorded manifest (when it
    // has one) so `resolveInitInputs`'s harnesses-stickiness gate can tell
    // a deliberate recorded `--harness none` install apart from a
    // missing/malformed `harnesses` field, exactly as it already does for
    // `init`'s own re-run. Left `undefined` when there is no repo manifest
    // at all, which the gate treats the same as "not recorded".
    harnessesRecordedEmpty: repoManifest?.harnessesRecordedEmpty,
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
        // Distinguish a real recorded `harnesses: []` (a deliberate
        // `--harness none` install, sticky on a flagless apply below) from
        // a missing/malformed/all-unknown `harnesses` field, which also
        // filters down to an empty array but is NOT sticky -- see
        // `Manifest.harnessesRecordedEmpty`'s doc comment in init.ts. The
        // printed phrase must not conflate the two cases.
        const installedFor =
          repoManifest.harnesses.length > 0
            ? repoManifest.harnesses.join(", ")
            : repoManifest.harnessesRecordedEmpty
              ? "none (recorded templates-only)"
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
        // Real on-disk detection, separate from `chosenHarnesses` above:
        // only read by `resolveInitInputs`'s harnesses-stickiness branch,
        // whose interactive prompt must pre-check what is actually on disk,
        // not `resolveApplyHarnesses`'s fallback-chain result (which is
        // never empty and would re-widen a deliberate templates-only
        // install on a bare Enter; agent-tasks fe834823).
        filesystemDetected: detectHarnesses(targetDir),
        interactive,
        previous,
        opts,
        // `previous` is always defined here (`buildApplyPrevious` returns a
        // synthetic object even for a target with no manifest of its own),
        // so `previousIsRecordedManifest` cannot be `Boolean(previous)`;
        // it has to track whether the target itself actually has a
        // recorded manifest, since only that manifest's own
        // `harnessesRecordedEmpty` (carried into `previous` by
        // `buildApplyPrevious`) can mean a deliberate `--harness none`
        // install. A target with no manifest at all never sets this, and
        // the stickiness gate in `resolveInitInputs` requires both flags
        // together, so this alone does not by itself make anything sticky.
        // This does overlap with `harnessesRecordedEmpty` today (both
        // ultimately trace back to the same repo manifest being present),
        // but the two are kept as separate flags on purpose, as defence in
        // depth: `previousIsRecordedManifest` guards against a future
        // caller of `resolveInitInputs` synthesizing a `previous` with
        // `harnessesRecordedEmpty` set but no real repo manifest behind it.
        previousIsRecordedManifest: Boolean(repoManifest),
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
        `\norchestrator-workflow v${PACKAGE_VERSION} ${installedForClause(harnesses)} (profile: ${profile}, tiers: ${tiers})`,
      );

      // The re-read, upsert, and write below all run inside
      // `updateOperatorManifest`'s single locked critical section, so no
      // other locked writer against this same `home` can interleave its
      // own read-modify-write in between: that closes the operator-
      // manifest lost-update window. The re-read itself is still
      // necessary even under the lock: `operatorManifest` (the copy read
      // at the top, before `runInit` did its file writes, and before this
      // lock was even acquired) may already be stale by the time the lock
      // is granted, since a previous holder's own locked write could have
      // landed in between. `resolvedTargetPath` and `alreadyRegistered`
      // are captured from inside the `mutate` callback (it only returns
      // an `OperatorManifest | undefined`) since both are needed for the
      // messages printed after the lock is released.
      let resolvedTargetPath = "";
      let alreadyRegistered = false;
      let result: ReturnType<typeof updateOperatorManifest>;
      try {
        result = updateOperatorManifest(home, (current, state) => {
          if (state.kind !== "ok" || !current) {
            return undefined;
          }

          // A run with local edits that conflicted still registers the
          // target and records PACKAGE_VERSION here: the apply itself ran
          // (the conflicting files were left as the operator's local
          // edits, not skipped or aborted), so the registry should
          // reflect that a vPACKAGE_VERSION apply was attempted against
          // this target, the same as any other non-force-pin-gated run.
          // Only the pin gate above returns before reaching this point
          // without registering.
          const upserted = upsertOperatorTarget(
            current,
            targetDir,
            PACKAGE_VERSION,
            new Date().toISOString(),
          );
          resolvedTargetPath = safeRealpath(targetDir);
          alreadyRegistered = upserted.alreadyRegistered;
          return upserted.manifest;
        });
      } catch (error) {
        if (error instanceof OperatorManifestLockTimeoutError) {
          const manifestPath = join(home, "manifest.json");
          console.error(
            `Could not lock the operator manifest at ${manifestPath} (another orchestrator-workflow command holds it); the kit was installed but the target was not registered. Re-run \`apply\` to register it.`,
          );
          process.exitCode = 1;
          return;
        }
        throw error;
      }

      if (result.state.kind !== "ok") {
        const manifestPath = join(home, "manifest.json");
        console.error(
          applyRegistrationFailureMessage(
            result.state.kind,
            manifestPath,
            targetDir,
          ),
        );
        process.exitCode = 1;
        return;
      }

      console.log(
        alreadyRegistered
          ? `Refreshed the registry entry for ${resolvedTargetPath}`
          : `Registered ${resolvedTargetPath} in the operator manifest`,
      );
    },
  );
program
  .command("doctor")
  .description(
    "Report each operator-registered target's status: clean, divergent from the operator defaults, version-lagging, hash-drifted, missing, without a repo manifest, or unverifiable (could not be checked at all)",
  )
  .option(
    "--json",
    "print a single JSON report to stdout and suppress human output",
  )
  .option(
    "--prune",
    "remove missing and no-manifest targets from the operator registry before reporting; rewrites the whole manifest file in its normalized form (a hand-edited or legacy entry that readOperatorManifest could not parse is dropped from the file, not just left alone)",
  )
  .action(async (opts: { json?: boolean; prune?: boolean }) => {
    const home = resolveOperatorHome();

    // Test-only escape hatch: shrinks `--prune`'s lock-acquire timeout so a
    // test can force `OperatorManifestLockTimeoutError` (a foreign holder
    // sitting on the lock) without waiting out the production
    // `DEFAULT_LOCK_TIMEOUT_MS`. Unset in every real invocation, and
    // effective only when `--prune` is also passed (only `--prune` ever
    // takes the operator-manifest lock).
    const testLockTimeoutMs = process.env.OW_DOCTOR_TEST_LOCK_TIMEOUT_MS;
    const lockOptions =
      opts.prune && testLockTimeoutMs
        ? { timeoutMs: Number(testLockTimeoutMs), pollMs: 10 }
        : undefined;

    let report: DoctorReport;
    try {
      report = runDoctor(home, { prune: opts.prune, lockOptions });
    } catch (error) {
      // `runDoctor`'s `--prune` path runs its read-modify-write through
      // `updateOperatorManifest`, which can throw instead of returning:
      // `OperatorManifestLockTimeoutError` when another
      // orchestrator-workflow command already holds the operator-manifest
      // lock past the timeout, or any other error raised while acquiring
      // it (most commonly `EACCES` creating the lock directory itself,
      // e.g. a read-only operator home). Either way the manifest was left
      // untouched; report the failure directly instead of letting an
      // uncaught exception crash the CLI with a raw stack trace.
      const isLockTimeout = error instanceof OperatorManifestLockTimeoutError;
      const doctorError:
        | "operator-manifest-locked"
        | "operator-manifest-write-failed" = isLockTimeout
        ? "operator-manifest-locked"
        : "operator-manifest-write-failed";
      const message = error instanceof Error ? error.message : String(error);

      if (opts.json) {
        console.log(
          JSON.stringify({
            operatorHome: home,
            operatorVersion: PACKAGE_VERSION,
            targets: [],
            pruned: [],
            exitCode: 2,
            error: doctorError,
            message,
          }),
        );
      } else {
        console.error(
          isLockTimeout
            ? `Could not acquire the operator manifest lock at ${home} (another orchestrator-workflow command holds it): ${message}`
            : `Could not update the operator manifest at ${home}: ${message}`,
        );
      }
      process.exitCode = 2;
      return;
    }

    if (opts.json) {
      console.log(
        JSON.stringify({
          operatorHome: report.operatorHome,
          operatorVersion: report.operatorVersion,
          targets: report.targets.map(targetReportToJson),
          pruned: report.pruned,
          exitCode: report.exitCode,
          unvalidatedDropped: report.unvalidatedDropped,
          ...(report.error ? { error: report.error } : {}),
        }),
      );
      process.exitCode = report.exitCode;
      return;
    }

    if (report.error === "no-operator-manifest") {
      console.error(
        "No operator setup found; run `orchestrator-workflow setup` first.",
      );
      process.exitCode = report.exitCode;
      return;
    }

    if (report.error === "operator-manifest-unreadable") {
      const manifestPath = join(
        report.operatorHome,
        OPERATOR_MANIFEST_FILENAME,
      );
      console.error(
        `Operator manifest at ${manifestPath} is unreadable; back it up and repair it, or remove it and run \`orchestrator-workflow setup\` again.`,
      );
      process.exitCode = report.exitCode;
      return;
    }

    console.log(
      `Operator home: ${report.operatorHome} (kit v${report.operatorVersion})`,
    );

    const counts = new Map<string, number>();
    for (const target of report.targets) {
      printTargetDetail(target, report.operatorVersion);
      counts.set(target.status, (counts.get(target.status) ?? 0) + 1);
    }

    const summary = [...counts.entries()]
      .map(([status, count]) => `${count} ${status}`)
      .join(", ");
    const targetCount = report.targets.length;
    console.log(
      `${targetCount} target${targetCount === 1 ? "" : "s"}: ${summary === "" ? "none" : summary}`,
    );
    if (opts.prune) {
      console.log(
        `pruned: ${report.pruned.length > 0 ? report.pruned.join(", ") : "(none)"}`,
      );
      // Printed only when the file actually held a raw target entry the
      // parser could not validate (fix-round-2, review finding M3): the
      // note used to print unconditionally whenever anything at all was
      // pruned, even when every dropped entry was a validly-shaped
      // missing/no-manifest target and the file held no unvalidatable
      // entry to report.
      if (report.unvalidatedDropped > 0) {
        console.log(
          `note: the operator manifest was rewritten in normalized form; ${report.unvalidatedDropped} raw target ${report.unvalidatedDropped === 1 ? "entry" : "entries"} the parser could not validate ${report.unvalidatedDropped === 1 ? "was" : "were"} dropped from the file along with the pruned targets above.`,
        );
      }
    }
    process.exitCode = report.exitCode;
  });

/**
 * Prints one target's doctor-style status line and detail lines. Factored
 * out of `doctor`'s own per-target loop above so `adopt` below can print
 * the exact same format for the single target it just registered, rather
 * than hand-duplicating it; `doctor`'s own output is unchanged (same
 * lines, same order, same content), only the printing code moved into
 * this function. (A function declaration, not a `const`, so it is hoisted
 * above its one call site inside `doctor`'s action, further up this file.)
 */
function printTargetDetail(
  target: TargetReport,
  operatorVersion: string,
): void {
  console.log(`${target.status}  ${target.path}`);
  if (target.status === "unverifiable" && target.reason) {
    console.log(`  ${target.reason}`);
  }
  // Divergence and version-lag detail lines print for both `divergent`
  // and `drift` status lines (fix-round-2, review finding L6): a drift
  // target can also be divergent and/or version-lagging (see
  // doctor.ts's status-precedence doc comment), and before this fix
  // its `divergent`/`version-lag` facts were silently dropped from the
  // human output whenever `drift` won the status field.
  if (
    (target.status === "divergent" || target.status === "drift") &&
    target.divergence
  ) {
    if (target.divergence.profile) {
      console.log(
        `  profile: repo=${target.repoProfile}, operator=${target.operatorProfile}`,
      );
    }
    if (target.divergence.tiers) {
      console.log(
        `  tiers: repo=${target.repoTiers}, operator=${target.operatorTiers}`,
      );
    }
    if (target.divergence.models) {
      console.log(`  models: ${target.divergentModelRoles.join(", ")}`);
    }
  }
  const showsVersionLagDetail =
    (target.status === "version-lag" ||
      ((target.status === "divergent" || target.status === "drift") &&
        target.versionLag)) &&
    target.installedVersion !== null;
  if (showsVersionLagDetail) {
    // A pinned target that is still version-lag (the pin no longer
    // matches the installed version, see doctor.ts's `versionLag`)
    // shows what it is pinned at instead of the operator's running
    // version, which is not the relevant comparison for a pinned
    // target.
    console.log(
      target.pin
        ? `  installed ${target.installedVersion}, pinned at ${target.pin}`
        : `  installed ${target.installedVersion}, operator ${operatorVersion}`,
    );
  }
  if (target.status === "drift" && target.driftFiles) {
    for (const file of target.driftFiles) {
      console.log(`  ${file}`);
    }
  }
  if (target.pin && !showsVersionLagDetail) {
    console.log(`  pinned at ${target.pin}`);
  }
}

/**
 * Builds this operator's bootstrap defaults from a target's own recorded
 * manifest, used only when `adopt` finds no operator manifest at all: the
 * freshly created operator manifest's `defaults` become exactly what this
 * repository was already installed with (harnesses/profile/tiers/models),
 * rather than the shipped defaults `setup` would otherwise fall back to.
 */
function operatorDefaultsFromRepoManifest(
  repoManifest: Manifest,
): OperatorManifestDefaults {
  return {
    harnesses: repoManifest.harnesses,
    profile: repoManifest.profile,
    tiers: repoManifest.tiers,
    models: { ...repoManifest.models },
  };
}

/**
 * True when the already-parsed repo manifest `raw` is a JSON object whose
 * `kit` field is a string that is not `"orchestrator-workflow"`: a manifest
 * written by some other tool at this well-known path, not a damaged or
 * hand-edited orchestrator-workflow one. Takes the already-parsed value
 * (rather than re-reading the file itself) so its caller controls exactly
 * how a read failure on that file is classified (fix-round-2: reading the
 * file here too, and swallowing any error into "not foreign", previously
 * folded an `EACCES` on the manifest file into the reinstall-advising
 * `unreadable-repo-manifest` branch instead of `unverifiable-repo-manifest`).
 * `readInstalledManifest` (init.ts) already treats any `kit` mismatch,
 * missing or otherwise, as "no record" (`undefined`); this needs its own
 * independent check to tell a genuinely foreign manifest apart from
 * `adopt`'s other `!repoManifest` causes (missing file, invalid JSON, a
 * manifest with `kit` absent or some other invalid field), the same way
 * `repoManifestHasMalformedPin` above re-parses independently for its own,
 * different question (fix-round, review finding L8).
 */
function repoManifestIsForeign(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const candidate = raw as Record<string, unknown>;
  return (
    typeof candidate.kit === "string" &&
    candidate.kit !== "orchestrator-workflow"
  );
}

program
  .command("adopt")
  .description(
    "Register an already-installed repository into the operator manifest verbatim, touching nothing in the repository; bootstraps the operator manifest from the repository's own recorded settings when none exists yet, then prints this one target's doctor report",
  )
  .argument("[dir]", "target repository directory", ".")
  .option(
    "--json",
    "print a single JSON report to stdout and suppress human output",
  )
  .action(async (dir: string, opts: { json?: boolean }) => {
    // `targetDir` is only `resolve(dir)` here, not yet verified: unlike
    // every other command, `adopt` cannot reuse `requireDirectory` for this
    // precondition, since that helper is `--json`-unaware (`console.error`
    // and a bare `process.exitCode = 1`) and every other failure this
    // command reports goes through `reportUsageError` at exit code 2, not
    // 1 (fix-round, review finding M1). `init`/`uninstall`/`apply` keep
    // using `requireDirectory` unchanged.
    const targetDir = resolve(dir);
    const home = resolveOperatorHome();

    // Every failure this command can report before it has anything to put
    // in a `TargetReportJson` is a usage/precondition error, and the
    // decisions this task is scoped to fix that at exit code 2 (contrast
    // `apply`, which uses 1 for its own precondition failures); this
    // helper centralizes that one shape for both `--json` and human mode
    // rather than repeating it at each of this action's several failure
    // points.
    function reportUsageError(error: string, message: string): void {
      if (opts.json) {
        console.log(
          JSON.stringify({
            operatorHome: home,
            operatorVersion: PACKAGE_VERSION,
            targetDir,
            target: null,
            registered: null,
            bootstrapped: null,
            error,
            message,
            exitCode: 2,
          }),
        );
      } else {
        console.error(message);
      }
      process.exitCode = 2;
    }

    const targetStat = statOrClassify(targetDir);
    if (targetStat.kind !== "ok" || !targetStat.stat.isDirectory()) {
      reportUsageError(
        "target-not-a-directory",
        `Target is not a directory: ${targetDir}`,
      );
      return;
    }

    const repoManifest = readInstalledManifest(targetDir);
    if (!repoManifest) {
      const repoManifestPath = join(targetDir, MANIFEST_PATH);
      // `statOrClassify` distinguishes "no such file" from every other
      // stat failure (most commonly `EACCES` on `.ai/workflow` itself), the
      // same distinction `doctor.ts`'s own `inspectTarget` relies on:
      // plain `existsSync` swallows both alike and reports `false` either
      // way, which previously misreported an inaccessible-but-installed
      // repo as `no-repo-manifest` and advised `init`/`apply`, which would
      // have overwritten it (fix-round, review finding M2).
      const manifestStat = statOrClassify(repoManifestPath);
      if (manifestStat.kind === "enoent") {
        reportUsageError(
          "no-repo-manifest",
          `No orchestrator-workflow install found in ${targetDir}; run 'orchestrator-workflow init' or 'orchestrator-workflow apply --target ${targetDir}' first.`,
        );
      } else if (manifestStat.kind === "error") {
        reportUsageError(
          "unverifiable-repo-manifest",
          `Could not verify the repository manifest at ${repoManifestPath} (its directory is not accessible); check its permissions and try again.`,
        );
      } else {
        // `manifestStat.kind === "ok"`: the manifest file itself stats
        // fine (stat only needs search access on its ancestor directories,
        // not read access on the file), so a mode-000 manifest file lands
        // here too. Read its bytes once, ourselves, so an `EACCES`/`EPERM`
        // (or any other non-`ENOENT` read failure) is told apart from a
        // parse failure: `readInstalledManifest` and the old
        // `repoManifestIsForeign` each re-read this same file and swallow
        // that distinction, which previously folded an unreadable file into
        // the reinstall-advising `unreadable-repo-manifest` branch instead
        // of `unverifiable-repo-manifest` (fix-round-2).
        let bytes: string | undefined;
        try {
          bytes = readFileSync(repoManifestPath, "utf8");
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            reportUsageError(
              "unverifiable-repo-manifest",
              `Could not verify the repository manifest at ${repoManifestPath} (its directory is not accessible); check its permissions and try again.`,
            );
            return;
          }
        }
        let raw: unknown;
        let parseError = bytes === undefined;
        if (bytes !== undefined) {
          try {
            raw = JSON.parse(bytes);
          } catch {
            parseError = true;
          }
        }
        if (!parseError && repoManifestIsForeign(raw)) {
          // Distinct from the generic "unreadable" case below (fix-round,
          // review finding L8): this is not a damaged or hand-edited
          // orchestrator-workflow manifest to repair, it is a different
          // tool's manifest that happens to live at the same well-known
          // path, and "repair it, or reinstall" is the wrong advice either
          // way.
          reportUsageError(
            "foreign-manifest",
            `${repoManifestPath} is not an orchestrator-workflow manifest; nothing was registered.`,
          );
        } else {
          reportUsageError(
            "unreadable-repo-manifest",
            `Unreadable repository manifest at ${repoManifestPath}; repair it, or run \`orchestrator-workflow apply --target ${targetDir}\` to reinstall.`,
          );
        }
      }
      return;
    }

    // `resolvedTargetPath`, `alreadyRegistered`, and `bootstrapped` are
    // captured from inside the `mutate` callback (mirroring `apply`'s own
    // capture of `resolvedTargetPath`/`alreadyRegistered`) since `mutate`
    // can only return an `OperatorManifest | undefined`. `mutate` re-reads
    // `current`/`state` fresh inside the lock rather than relying on any
    // earlier unlocked read (there is none here: unlike `apply`, `adopt`
    // never reads the operator manifest before this call), so a concurrent
    // writer's own read-modify-write cannot be lost. The manifest object
    // itself is read back from `result.manifest` below rather than a
    // `mutate`-captured local (fix-round-2): `updateOperatorManifest` may
    // re-stamp `updatedAt` on the value `mutate` returned before writing it
    // (its "refreshing write" case), so `mutate`'s own return value can be
    // stale by the time the lock releases; `result.manifest` is always the
    // bytes actually written.
    let resolvedTargetPath = "";
    let alreadyRegistered = false;
    let bootstrapped = false;
    let result: ReturnType<typeof updateOperatorManifest>;
    try {
      result = updateOperatorManifest(home, (current, state) => {
        if (state.kind === "unreadable") {
          return undefined;
        }
        const appliedAt = new Date().toISOString();
        const base =
          current ??
          createOperatorManifest(
            operatorDefaultsFromRepoManifest(repoManifest),
            appliedAt,
          );
        bootstrapped = !current;
        const upserted = upsertOperatorTarget(
          base,
          targetDir,
          repoManifest.version,
          appliedAt,
        );
        resolvedTargetPath = safeRealpath(targetDir);
        alreadyRegistered = upserted.alreadyRegistered;
        return upserted.manifest;
      });
    } catch (error) {
      const manifestPath = join(home, OPERATOR_MANIFEST_FILENAME);
      const isLockTimeout = error instanceof OperatorManifestLockTimeoutError;
      const message = isLockTimeout
        ? `Could not lock the operator manifest at ${manifestPath} (another orchestrator-workflow command holds it); nothing was changed. Re-run \`orchestrator-workflow adopt\` to register ${targetDir}.`
        : `Could not update the operator manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`;
      reportUsageError(
        isLockTimeout
          ? "operator-manifest-locked"
          : "operator-manifest-write-failed",
        message,
      );
      return;
    }

    const writtenManifest = result.manifest;
    if (result.state.kind === "unreadable" || !writtenManifest) {
      const manifestPath = join(home, OPERATOR_MANIFEST_FILENAME);
      reportUsageError(
        "operator-manifest-unreadable",
        `Operator manifest at ${manifestPath} is unreadable; back it up and repair it, or remove it and run \`orchestrator-workflow setup\` again.`,
      );
      return;
    }

    const registeredTarget = writtenManifest.targets.find(
      (candidate) => candidate.path === resolvedTargetPath,
    );
    if (!registeredTarget) {
      // Unreachable in practice: `upsertOperatorTarget` always writes an
      // entry at `safeRealpath(targetDir)`, which is exactly
      // `resolvedTargetPath`. Reported rather than assumed away, matching
      // the "never guess" posture the rest of this command takes with
      // every other unreachable-in-practice branch.
      reportUsageError(
        "target-not-registered",
        `Internal error: ${resolvedTargetPath} was not found in the operator manifest immediately after registering it.`,
      );
      return;
    }

    const targetReport = inspectTarget(
      registeredTarget,
      writtenManifest,
      PACKAGE_VERSION,
    );

    const registered: "new" | "refreshed" = alreadyRegistered
      ? "refreshed"
      : "new";

    // The target directory and its manifest were just read successfully
    // above, so `missing`/`no-manifest`/`unverifiable` should not recur a
    // moment later; if one nonetheless does (a race with something else
    // removing or damaging the target in between), that is reported as an
    // error rather than folded into the normal 0/1 exit-code contract. The
    // mapping itself is `doctor.ts`'s exported `adoptExitCodeForStatus`
    // (fix-round, review findings M3/L5), not an inline ternary chain here,
    // so all seven statuses are pinned by a direct unit test rather than
    // only the subset a live `adopt` run can actually reach.
    const exitCode = adoptExitCodeForStatus(targetReport.status);
    const unexpectedStatus = suppressSuccessLine(targetReport.status);

    if (opts.json) {
      console.log(
        JSON.stringify({
          operatorHome: home,
          operatorVersion: PACKAGE_VERSION,
          target: targetReportToJson(targetReport),
          registered,
          bootstrapped,
          exitCode,
          // Only this genuinely-unreachable-in-practice case gets an
          // `error` key (`doctor.ts`'s exported, unit-tested
          // `adoptJsonExtras`); a `--json` consumer previously had no way
          // to tell this apart from a normal (if unlucky) result at the
          // same exit code (fix-round, review finding M3).
          ...adoptJsonExtras(targetReport.status),
        }),
      );
      process.exitCode = exitCode;
      return;
    }

    if (unexpectedStatus) {
      // The success line ("Adopted ...") must not print here: the target
      // was not cleanly adopted, only registered before an unexplained
      // status turned up immediately after (fix-round, review finding M3;
      // before this fix the success line printed unconditionally, ahead of
      // the detail lines and the stderr note below).
      printTargetDetail(targetReport, PACKAGE_VERSION);
      console.error(
        `Unexpected status ${targetReport.status} for a target whose directory and manifest were just verified; treat this as a bug.`,
      );
      process.exitCode = exitCode;
      return;
    }

    console.log(
      `Adopted ${resolvedTargetPath} (registered: ${registered}; operator defaults ${
        bootstrapped ? "bootstrapped from this repository" : "kept"
      })`,
    );
    printTargetDetail(targetReport, PACKAGE_VERSION);
    process.exitCode = exitCode;
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

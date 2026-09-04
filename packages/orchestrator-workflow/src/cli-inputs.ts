import inquirer from "inquirer";

import type { Harness } from "./detect.js";
import { HARNESSES, parseHarnessOption } from "./detect.js";
import type { Manifest } from "./init.js";
import type { ModelClass, Profile, Role } from "./models.js";
import {
  CLASS_MODELS,
  DEFAULT_MODELS,
  DEFAULT_PROFILE,
  MODEL_ALIASES,
  MODEL_CLASSES,
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

export async function promptHarnesses(
  detected: Harness[],
  installed: Harness[],
  fallbackToClaude = true,
  // Drives only the checkbox's " (detected)" label suffix, independent of
  // `detected`'s role in pre-checking; see `stickyAnnotateDetected` below.
  annotateDetected: Harness[] = detected,
): Promise<Harness[]> {
  const known = [...new Set([...detected, ...installed])];
  // The templates-only branch disables this first-run fallback; see
  // `ResolveInitInputsParams.stickyPreChecked` for the sticky rule.
  const preselected =
    known.length > 0 ? known : fallbackToClaude ? ["claude" as Harness] : [];
  const { harnesses } = await inquirer.prompt<{ harnesses: Harness[] }>([
    {
      type: "checkbox",
      name: "harnesses",
      message:
        "Install adapters for which harnesses? (deselect all for templates only, no harness)",
      choices: HARNESSES.map((harness) => ({
        name:
          harness + (annotateDetected.includes(harness) ? " (detected)" : ""),
        value: harness,
        checked: preselected.includes(harness),
      })),
      // An empty selection is a supported state
      // (`--harness none`, templates-only mode): it used to be rejected
      // here because every install always wrote at least one harness
      // adapter; there is no longer a reason to require one.
    },
  ]);
  return harnesses;
}

export async function promptProfile(base: Profile): Promise<Profile> {
  // Labels are derived from rolesForProfile so a future role addition (like
  // the advisor role) shows up here automatically instead of silently
  // falling out of sync with the roles the profile actually installs.
  const fullRoles = rolesForProfile("full").join(", ");
  const minimalRoles = rolesForProfile("minimal").join(", ");
  const { profile } = await inquirer.prompt<{ profile: Profile }>([
    {
      type: "list",
      name: "profile",
      message: "Which subagent roles should be installed?",
      default: base,
      choices: [
        {
          name: `full — ${fullRoles} (default)`,
          value: "full",
        },
        {
          name: `minimal — ${minimalRoles} only (reviewer is never optional)`,
          value: "minimal",
        },
      ],
    },
  ]);
  return profile;
}

export async function promptModels(
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

/** The subset of `init`'s commander options that feed input resolution. */
export interface InitResolutionOptions {
  harness?: string;
  models?: string;
  profile?: string;
  opencodeProvider?: string;
  tiers?: boolean;
}

export interface ResolveInitInputsParams {
  /** Result of `detectHarnesses(targetDir)`; passed in so the caller can
   * print it before resolution starts, matching `init`'s existing output
   * order, without this function reading the filesystem a second time. */
  detected: Harness[];
  interactive: boolean;
  /** The previously installed manifest, if any (`readInstalledManifest`). */
  previous: Manifest | undefined;
  opts: InitResolutionOptions;
  /**
   * True when `previous` is backed by the target's own actually-recorded
   * manifest, as opposed to a wholly synthetic object with no repo
   * manifest behind it at all. `init` sets this whenever it has a
   * `previous` (`readInstalledManifest(targetDir)` returned one). `apply`
   * always hands `resolveInitInputs` a non-`undefined` `previous` (its
   * `buildApplyPrevious` synthesizes one even for a target with no
   * manifest of its own, to carry the operator-defaults floor), so it sets
   * this flag from whether the target actually has a repo manifest
   * (`Boolean(repoManifest)`), not from whether `previous` itself is
   * defined. Only consulted for the harnesses-stickiness rule below,
   * together with `previous.harnessesRecordedEmpty` (which `apply`'s
   * `buildApplyPrevious` carries straight through from that repo
   * manifest): a real recorded `harnesses: []` means a deliberate
   * `--harness none` install, and a plain re-run (init or apply, no
   * `--harness` flag) must not silently widen it via detection or the
   * operator manifest's default harnesses. This flag alone does not
   * distinguish a deliberate `harnesses: []` from a damaged/legacy
   * manifest whose raw `harnesses` field was missing, malformed, or an
   * array whose every entry failed the known-harness filter (all of which
   * also sanitize to `harnesses: []`) -- that distinction is
   * `harnessesRecordedEmpty`'s job; both must hold for the stickiness gate
   * to fire, so a target with no repo manifest at all, or one with a
   * missing/malformed `harnesses` field, still falls through to the
   * fallback chain below unchanged.
   */
  previousIsRecordedManifest?: boolean;
  /**
   * The entries pre-checked in the interactive prompt when the target
   * recorded `harnesses: []` (the harnesses-stickiness gate's branch,
   * gated on `previousIsRecordedManifest && previous.
   * harnessesRecordedEmpty`). Defaults to `[]` when omitted, so `init` and
   * `apply` share this semantics. A fresh
   * interactive re-run on a templates-only target starts with nothing
   * pre-checked, because the recorded `harnesses: []` is the intent that
   * matters, not a `.claude/`-style directory the harness itself left on
   * disk, which is a weak signal and must not re-widen a deliberate
   * `--harness none` install just because a bare Enter is pressed. `apply`'s
   * call site still passes `[]` explicitly, as defence
   * in depth (see `buildApplyInitInputs`'s doc comment). Only the sticky
   * branch reads this field; the normal (non-recorded-empty) branch still
   * prompts from `detected` unchanged, matching `apply`'s existing
   * pre-check behaviour on a normal target.
   */
  stickyPreChecked?: Harness[];
  /**
   * The sticky branch's own `promptHarnesses` " (detected)" label source,
   * independent of `stickyPreChecked` (which drives what is actually
   * pre-checked, not what is merely labelled). Defaults to `detected`
   * when omitted: even though nothing is pre-checked (see
   * `stickyPreChecked`'s doc comment), the operator still sees which
   * harness is actually on disk, because labelling is a hint, not an
   * intent signal, so it is safe to annotate what the pre-check itself
   * must not read. `init`'s call site
   * omits this field and gets its own `detectHarnesses(targetDir)` result
   * via this default; `apply`'s call site passes a fresh
   * `detectHarnesses(targetDir)` call explicitly, since its own
   * `detected` parameter is `resolveApplyHarnesses`'s chosen-harnesses
   * result, not real on-disk detection, and would mislabel the checkbox
   * if relied on as the default here.
   */
  stickyAnnotateDetected?: Harness[];
}

export interface ResolvedInitInputs {
  harnesses: Harness[];
  profile: Profile;
  models: Record<Role, string>;
  tiers: boolean;
  opencodeModels?: Record<Role, string | undefined>;
  opencodeClassModels?: Record<ModelClass, string | undefined>;
  /**
   * Warning lines to print, in order, exactly as `init` printed them to
   * stderr before this extraction (each written as `${line}\n`). Returned
   * as data rather than printed here so the caller decides where/whether to
   * print them.
   */
  warnings: string[];
}

/**
 * Resolves everything `runInit` needs (harnesses, profile, models, tiers,
 * the opencode model resolutions) from the CLI-parsed options, the target
 * directory, whether the session is interactive, and the previously
 * installed manifest. Used by `init`'s action today, and reusable by a
 * later `apply --target` command without duplicating this logic.
 *
 * Every override-vs-persist rule below matches `init`'s pre-extraction
 * behaviour: an explicit flag always overrides; a plain re-run (flag
 * omitted) keeps the previously installed value; a fresh install with no
 * prior manifest falls back to the shipped default.
 *
 * `params.detected` is the non-sticky fallback-chain input; see
 * `ResolveInitInputsParams.stickyPreChecked` for the sticky rule.
 */
export async function resolveInitInputs(
  params: ResolveInitInputsParams,
): Promise<ResolvedInitInputs> {
  const {
    detected,
    interactive,
    previous,
    opts,
    previousIsRecordedManifest,
    stickyPreChecked,
    stickyAnnotateDetected,
  } = params;

  let harnesses: Harness[];
  if (opts.harness) {
    harnesses = parseHarnessOption(opts.harness);
  } else if (
    previousIsRecordedManifest &&
    previous &&
    previous.harnessesRecordedEmpty
  ) {
    // A recorded previous manifest with harnesses: [] was an explicit
    // --harness none (templates-only) install. A plain non-interactive
    // re-run (no --harness flag) must stay templates-only rather than
    // falling back to filesystem detection and silently installing a
    // harness (e.g. claude) the operator never asked for; adding one back
    // requires an explicit --harness on this run, the same
    // override-vs-persist rule --profile/--models/--tiers already use,
    // just applied to the "no harnesses" case specifically.
    // `harnessesRecordedEmpty` gates this on the raw JSON's `harnesses`
    // field having actually been an empty array: a missing/malformed field,
    // or an array whose every entry failed the known-harness filter (e.g.
    // ["cursor"], all-unknown names), also sanitizes to
    // `harnesses.length === 0` (readInstalledManifest in init.ts) but must
    // fall through to detection below instead, the same as any other
    // damaged manifest (see CHANGELOG).
    //
    // An interactive re-run is different: stickiness only protects a
    // non-interactive call (`--yes`, or any other flow with no prompt) from
    // silently widening an explicit "none" back out; an interactive session
    // can already ask and let the operator decide, so it still prompts here
    // instead of skipping straight to templates-only. `installed` is passed
    // as `[]` (not the recorded `previous.harnesses`) so nothing is
    // pre-checked from the previous install, unlike the "else" branch
    // below's normal re-run prompt.
    // See `ResolveInitInputsParams.stickyPreChecked` for the shared sticky rule.
    // `stickyAnnotateDetected ?? detected` is passed through as the fourth
    // argument so the checkbox's " (detected)" label still points at what
    // is actually on disk even though nothing is pre-checked from it: the
    // label is a hint, not an intent signal, so `init`'s call site (which
    // omits `stickyAnnotateDetected`) still labels from its own
    // `detectHarnesses(targetDir)` result via this default, and `apply`'s
    // call site still passes a fresh `detectHarnesses(targetDir)` call
    // explicitly, since its own `detected` parameter is
    // `resolveApplyHarnesses`'s chosen-harnesses result, not real on-disk
    // detection.
    harnesses = interactive
      ? await promptHarnesses(
          stickyPreChecked ?? [],
          [],
          false,
          stickyAnnotateDetected ?? detected,
        )
      : [];
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
  // CLI re-run test verifies this against the installed commander
  // version rather than assuming it. No interactive prompt: tiers is
  // opt-in/off via the flags only.
  const tiers = opts.tiers ?? previous?.tiers ?? false;

  // Resolve opencode model aliases against the live catalog when the opencode
  // harness is selected. The shell-out stays reachable only from this
  // resolution step, keeping runInit pure.
  let opencodeModels: Record<Role, string | undefined> | undefined;
  let opencodeClassModels: Record<ModelClass, string | undefined> | undefined;
  const warnings: string[] = [];
  if (harnesses.includes("opencode")) {
    const catalog = loadOpencodeCatalog();
    const { resolved, warnings: modelWarnings } = resolveOpencodeModels(
      models,
      {
        catalog,
        explicitProvider: opts.opencodeProvider,
      },
    );
    opencodeModels = resolved;
    for (const w of modelWarnings) {
      warnings.push(`Warning: ${w}`);
    }
    if (tiers) {
      const providerResult = detectProvider({
        catalog,
        explicit: opts.opencodeProvider,
      });
      opencodeClassModels = {} as Record<ModelClass, string | undefined>;
      for (const modelClass of MODEL_CLASSES) {
        const alias = CLASS_MODELS[modelClass];
        const resolvedModel = providerResult.provider
          ? resolveAlias(providerResult.provider, alias, catalog)
          : undefined;
        opencodeClassModels[modelClass] = resolvedModel;
        if (resolvedModel !== undefined) continue;
        // One warning per unresolved model class: without it, every
        // effort-tier variant keyed to this class is silently skipped
        // (init.ts skips the variant write entirely when the class
        // model is unresolved), with nothing on stderr saying why.
        const reason = providerResult.provider
          ? `provider "${providerResult.provider}" has no "${alias}" model in the catalog`
          : providerResult.ambiguous
            ? `multiple providers offer Claude models in the live catalog; cannot auto-detect`
            : `no provider offering Claude models found in the live catalog`;
        // States the real effect (no variant file at all, not just a
        // missing model: line, since init.ts skips the write entirely
        // when the class never resolves) and the real scope (opencode
        // only: Claude Code variants resolve model: from a plain alias
        // and need no live catalog lookup, so they are unaffected).
        warnings.push(
          `Warning: Tier model class "${modelClass}" (alias "${alias}") could not be resolved to an opencode model id (${reason}); no opencode effort-tier variant files will be rendered for this class (Claude Code variants are unaffected).`,
        );
      }
    }
  }

  return {
    harnesses,
    profile,
    models,
    tiers,
    opencodeModels,
    opencodeClassModels,
    warnings,
  };
}

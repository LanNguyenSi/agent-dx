import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

import {
  PACKAGE_VERSION,
  listTemplateNames,
  readAgentAsset,
  readAsset,
} from "./assets.js";
import type { Harness } from "./detect.js";
import { HARNESSES } from "./detect.js";
import type { ModelClass, Profile, Role, Tier } from "./models.js";
import {
  CLASS_MODELS,
  DEFAULT_PROFILE,
  DEFAULT_TIER,
  READ_ONLY_ROLES,
  ROLES,
  ROLE_TIERS,
  TIER_DEFS,
  assertValidModelId,
  claudeModelValue,
  isProfile,
  opencodeModelValue,
  rolesForProfile,
} from "./models.js";
import { composeCodexAgent } from "./codex.js";
import { parseRouting } from "./routing.js";
import type { HarnessRouting, ModelSelection } from "./routing.js";
import {
  codexCatalogWarnings,
  normalizeRoutingState,
  legacyOpencodeFallbacks,
  parseOpencodeModelMaps,
} from "./routing-state.js";
import type { OpencodeModelMaps } from "./routing-state.js";
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
  /**
   * Which subagent roles to install. Defaults to `"full"` (every role,
   * today's unconditional behavior) when omitted, so existing callers that
   * do not pass this field see no change.
   */
  profile?: Profile;
  force?: boolean;
  /**
   * Resolved fully-qualified opencode model ids per role, or `undefined` to
   * omit the `model:` frontmatter line (subagent inherits the session model).
   * Qualified values persist in routing; legacy bare IDs persist in the
   * manifest compatibility map of the same name. A present map records
   * inheritance for missing keys unless routing supplies that selection.
   * When absent, prior
   * selections survive; otherwise `opencodeModelValue(models[role])` passes
   * through a qualified id or leaves bare aliases inheriting the session model.
   */
  opencodeModels?: Partial<Record<Role, string | undefined>>;
  /**
   * Renders additional per-role effort-tier subagent variants
   * (`<role>-<tier>.md`) alongside the default agent file. Defaults to
   * `false` (today's unconditional behavior: only the default file), so
   * existing callers that do not pass this field see no change.
   */
  tiers?: boolean;
  /**
   * Resolved fully-qualified opencode model ids per tier's model class
   * (`small`/`medium`/`large`), or `undefined` to omit the `model:` line for
   * that variant. Only consulted when `tiers` is true and the `opencode`
   * harness is selected; mirrors `opencodeModels` but keyed by model class
   * instead of role, since a tier variant's model is chosen by class, not
   * by the role's own preselected model. Resolved ids are persisted per tier
   * and retained on a later install that omits this field. Legacy bare IDs
   * persist in the manifest compatibility map of the same name.
   */
  opencodeClassModels?: Partial<Record<ModelClass, string | undefined>>;
  /**
   * Per-harness role/tier selections. This is an additive, partial map: the
   * installer preserves previous leaves and fills remaining omissions from
   * deterministic harness defaults. An explicit leaf wins over legacy inputs.
   */
  routing?: HarnessRouting;
  /**
   * "patch" (default) preserves previous routing leaves. "replace" accepts
   * an authoritative resolved map and excludes all previous routing, as used
   * by CLI resolution and apply --sync. Omitted leaves still use defaults.
   */
  routingMode?: "patch" | "replace";
  /**
   * Optional, explicitly supplied Codex capability catalog. The installer
   * never contacts a live service; when this is present it is validated
   * before any kit-owned file is written.
   */
  codexCatalog?: unknown;
  /**
   * Repo kit-version pin (distinct from the actually-installed `version`),
   * so a later `apply` command can gate on it. A `string` sets a new
   * recorded kit-version pin; `null` clears an existing pin; `undefined`
   * (the default, omitted) carries the previous manifest's pin forward
   * unchanged. An empty or whitespace-only string is normalized to a clear
   * too, the same as `null`.
   */
  pin?: string | null;
}

const SKILL_NAME = "orchestrator-workflow";
export const MANIFEST_PATH = join(".ai", "workflow", "manifest.json"); // shared with doctor.ts/cli.ts (L9); see readInstalledManifest below

export interface Manifest extends OpencodeModelMaps {
  kit: string;
  version: string;
  harnesses: Harness[];
  models: Record<Role, string>;
  /** Which subagent roles were installed: `"minimal"` or `"full"`. */
  profile: Profile;
  /** Whether per-role effort-tier subagent variants were rendered. */
  tiers: boolean;
  /** Exact resolved harness/role/tier selections from the install. */
  routing?: HarnessRouting;
  /**
   * sha256 of every kit-owned file as installed. This is how a re-run tells
   * "upstream changed, safe to update" apart from "user edited, conflict".
   */
  files: Record<string, string>;
  installedAt: string;
  /**
   * Optional kit-version pin recorded for this repo (distinct from
   * `version`, the actually-installed kit version). Absent when no pin was
   * ever recorded or an existing one was cleared.
   */
  pin?: string;
  /**
   * True only when the raw manifest JSON's `harnesses` field was itself an
   * array AND that raw array had zero elements -- i.e. the operator
   * recorded an explicit empty harness set (a real `--harness none`
   * install). An array with entries that all fail the known-harness filter
   * (e.g. `["cursor"]`, or `["Claude"]` with the wrong case) also filters
   * down to `harnesses: []` but must NOT set this flag: the raw field was
   * never actually recorded as empty, it just failed to name anything this
   * kit recognizes, and treating that the same as a deliberate `none` would
   * silently degrade a live install to templates-only on a plain re-run
   * (see CHANGELOG). A missing/malformed `harnesses` field (not an array at
   * all) is the same "not a recorded empty set" case and also leaves this
   * `false`. Only `readInstalledManifest` ever sets this from an actual
   * on-disk manifest. A synthetic previous
   * (e.g. `apply`'s `buildApplyPrevious` in cli.ts) leaves it `undefined`,
   * which the harnesses-stickiness gate in `cli-inputs.ts` treats as "not
   * recorded" and therefore never sticky.
   */
  harnessesRecordedEmpty?: boolean;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * A manifest can be hand-written or tampered with, and uninstall deletes by
 * these paths. Only relative paths that stay inside the target are accepted;
 * an absolute path or one that normalizes to a `..` escape is rejected so it
 * can never reach an unlink.
 */
export function isContainedRelativePath(relativePath: string): boolean {
  if (relativePath === "" || isAbsolute(relativePath)) return false;
  const normalized = normalize(relativePath);
  return normalized !== ".." && !normalized.startsWith(`..${sep}`);
}

/**
 * Reads the manifest of a previous install, if any. Manifests can be written
 * by hand (manual agent installs) or damaged, so every field is sanitized;
 * anything invalid degrades to "no record" instead of crashing or leaking
 * unvalidated values into generated frontmatter.
 */
export function readInstalledManifest(targetDir: string): Manifest | undefined {
  const path = join(targetDir, MANIFEST_PATH);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (candidate.kit !== SKILL_NAME) return undefined;

  // Captured before filtering, and deliberately on the RAW array's own
  // length, not the filtered one: an invalid array element (a string, an
  // unknown harness name) also filters down to `harnesses: []` below, but
  // must not be mistaken for a deliberate recorded `harnesses: []` -- see
  // the `Manifest.harnessesRecordedEmpty` doc comment above for why.
  const rawHarnessesIsArray = Array.isArray(candidate.harnesses);
  const rawHarnesses = rawHarnessesIsArray
    ? (candidate.harnesses as unknown[])
    : [];
  const harnessesRecordedEmpty =
    rawHarnessesIsArray && rawHarnesses.length === 0;
  const harnesses = rawHarnesses.filter((value): value is Harness =>
    (HARNESSES as string[]).includes(value as string),
  );
  const models: Partial<Record<Role, string>> = {};
  if (typeof candidate.models === "object" && candidate.models !== null) {
    for (const role of ROLES) {
      const value = (candidate.models as Record<string, unknown>)[role];
      if (typeof value !== "string") continue;
      try {
        assertValidModelId(value);
        models[role] = value;
      } catch {
        // Invalid model ids are dropped; the role falls back to defaults.
      }
    }
  }
  const files: Record<string, string> = {};
  if (typeof candidate.files === "object" && candidate.files !== null) {
    for (const [key, value] of Object.entries(
      candidate.files as Record<string, unknown>,
    )) {
      // Drop absolute or directory-escaping keys: uninstall deletes by these
      // paths, so a tampered key must never enter the record.
      if (typeof value === "string" && isContainedRelativePath(key)) {
        files[key] = value;
      }
    }
  }
  // A manifest written before profiles existed carries no `profile` field;
  // that install always put down every role, so it degrades to "full" here
  // rather than to some notional "no roles" state.
  const profile: Profile =
    typeof candidate.profile === "string" && isProfile(candidate.profile)
      ? candidate.profile
      : DEFAULT_PROFILE;

  // A manifest written before tiers existed carries no `tiers` field; that
  // install never rendered variant files, so it degrades to `false` here
  // (the same per-field-degradation style as `profile` above) rather than
  // throwing on a legacy manifest.
  const tiers = typeof candidate.tiers === "boolean" ? candidate.tiers : false;

  // Routing is intentionally stricter than the legacy per-role `models`
  // map. A malformed routing record must stop a re-install instead of
  // silently replacing the operator's explicit selections with new defaults.
  const opencodeMaps = parseOpencodeModelMaps(candidate);
  let routing: HarnessRouting | undefined;
  if ("routing" in candidate) {
    routing = parseRouting(candidate.routing);
  }

  // A hand-written or damaged manifest may carry a non-string `pin`; that
  // degrades to "no recorded pin" here (the same per-field-degradation
  // style as `profile`/`tiers` above) rather than throwing. An empty or
  // whitespace-only stored `pin` degrades the same way: it can never
  // usefully name a kit version to gate on, so it is dropped rather than
  // carried forward as a value nothing can act on.
  return {
    kit: SKILL_NAME,
    version: typeof candidate.version === "string" ? candidate.version : "",
    harnesses,
    harnessesRecordedEmpty,
    models: models as Record<Role, string>,
    profile,
    tiers,
    ...(routing !== undefined ? { routing } : {}),
    ...opencodeMaps,
    files,
    installedAt:
      typeof candidate.installedAt === "string" ? candidate.installedAt : "",
    // The kit-version pin is deliberately free-form here: unlike the
    // fields above it never reaches generated frontmatter, a shell, or a
    // path, and the command that gates on it validates the value itself.
    ...(typeof candidate.pin === "string" && candidate.pin.trim() !== ""
      ? { pin: candidate.pin.trim() }
      : {}),
  };
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlModelScalar(value: string): string {
  // Keep ordinary legacy aliases and provider ids byte-compatible, but quote
  // values YAML would otherwise coerce when they originate in routing JSON.
  if (
    /^(?:true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^[-+]?\d+(?:\.\d+)?$/.test(value) ||
    value.includes(":") ||
    value.includes("#")
  ) {
    return yamlQuote(value);
  }
  return value;
}

/**
 * Composes the unsuffixed default agent file. It carries a pinned
 * `effort: <TIER_DEFS[DEFAULT_TIER[role]].effort>` line unconditionally
 * (medium for explorer/task-slicer/implementer, high for reviewer/advisor),
 * regardless of whether `--tiers` is on: this is the deterministic tier
 * ladder's floor, not a tier-variant feature, so a default spawn no longer
 * silently inherits the orchestrator session's effort. Since the pin does
 * not depend on the `tiers` flag, the default file's content still stays
 * byte-identical whether or not tier variants are also rendered, the same
 * invariant `composeClaudeAgentVariant`'s own doc comment below describes.
 * Computed inline here rather than passed in like `composeOpencodeAgent`'s
 * `effortLine`: `TIER_DEFS[DEFAULT_TIER[role]].effort` is a pure function of
 * `role` alone, with no model-dependent dispatch on Claude Code the way
 * opencode's family-based `opencodeEffortLine` has, so there is no second,
 * potentially-diverging computation here to guard against.
 */
function composeClaudeAgent(
  role: Role,
  model: string,
  selection?: ModelSelection,
): string {
  const asset = readAgentAsset(role);
  const frontmatter = [
    "---",
    `name: ${asset.name}`,
    `description: ${yamlQuote(asset.description)}`,
    `model: ${selection ? yamlModelScalar(selection.model) : claudeModelValue(model)}`,
    `effort: ${selection?.effort ?? TIER_DEFS[DEFAULT_TIER[role]].effort}`,
  ];
  // Read-only roles keep every read/search tool but cannot mutate files.
  if (READ_ONLY_ROLES.has(role)) {
    frontmatter.push("disallowedTools: Edit, Write, NotebookEdit");
  }
  frontmatter.push("---");
  return [...frontmatter, "", asset.body.trimEnd(), ""].join("\n");
}

/**
 * Composes the unsuffixed default opencode agent file. `effortLine` is the
 * same pinned-default-effort line a tier variant would carry, decided once
 * by the caller via `opencodeEffortLine(DEFAULT_TIER[role], modelValue)`
 * (single source of truth, the same pattern `composeOpencodeAgentVariant`
 * already uses for its own effort line) and passed in rather than
 * recomputed here.
 */
function composeOpencodeAgent(
  role: Role,
  modelValue: string | undefined,
  effortLine: string | undefined,
): string {
  const asset = readAgentAsset(role);
  const frontmatter = [
    "---",
    `description: ${yamlQuote(asset.description)}`,
    "mode: subagent",
  ];
  // Only emit `model:` when a resolved, non-empty FQ id is available.
  // Omitting it lets the subagent inherit the session/default model.
  if (modelValue) {
    frontmatter.push(`model: ${yamlModelScalar(modelValue)}`);
  }
  if (effortLine) {
    frontmatter.push(effortLine);
  }
  if (READ_ONLY_ROLES.has(role)) {
    frontmatter.push("permission:", "  edit: deny");
  }
  frontmatter.push("---");
  return [...frontmatter, "", asset.body.trimEnd(), ""].join("\n");
}

function routingSelection(
  routing: HarnessRouting,
  harness: "claude" | "codex" | "opencode",
  role: Role,
  tier: Tier,
): ModelSelection | undefined {
  return routing[harness]?.[role]?.[tier];
}

function tierDescriptionSuffix(
  asset: { description: string },
  tier: Tier,
): string {
  return `${asset.description} (Effort tier: ${tier}.)`;
}

/**
 * Composes a tier-variant sibling of `composeClaudeAgent` (`<role>-<tier>.md`).
 * The default-tier file is never rendered here (callers skip it via
 * `DEFAULT_TIER`), so `composeClaudeAgent`'s own output (pinned default
 * effort included) stays byte-identical whether or not tiers are on.
 */
function composeClaudeAgentVariant(
  role: Role,
  tier: Tier,
  selection?: ModelSelection,
): string {
  const asset = readAgentAsset(role);
  const def = TIER_DEFS[tier];
  const frontmatter = [
    "---",
    `name: ${asset.name}-${tier}`,
    `description: ${yamlQuote(tierDescriptionSuffix(asset, tier))}`,
    `model: ${selection ? yamlModelScalar(selection.model) : claudeModelValue(CLASS_MODELS[def.modelClass])}`,
    `effort: ${selection?.effort ?? def.effort}`,
  ];
  if (READ_ONLY_ROLES.has(role)) {
    frontmatter.push("disallowedTools: Edit, Write, NotebookEdit");
  }
  frontmatter.push("---");
  return [...frontmatter, "", asset.body.trimEnd(), ""].join("\n");
}

/**
 * Whether a resolved opencode model id belongs to the Claude family,
 * regardless of which provider is fronting it (`anthropic/claude-...`,
 * `github-copilot/claude-...`, `openrouter/anthropic/claude-...`, ...): the
 * segment after the provider prefix contains `claude-`, or the id starts
 * with `anthropic/` outright. Dispatch on family rather than provider id
 * because the `variant:` effort surface is a property of the model being
 * served, not of which provider happens to front it.
 */
function isClaudeFamilyModel(modelValue: string): boolean {
  if (modelValue.startsWith("anthropic/")) return true;
  const slash = modelValue.indexOf("/");
  const remainder = slash === -1 ? "" : modelValue.slice(slash + 1);
  return remainder.includes("claude-");
}

/**
 * The opencode effort surface is keyed by model family, not provider id:
 * Claude-family models' `variant:` option only distinguishes `high` and
 * `max` (mapped from the `high`/`xhigh` tiers; `low`/`medium` collapse to no
 * effort field), Ollama and ids without a provider prefix have no known
 * effort passthrough, and every other model accepts a plain
 * `reasoningEffort:` value. An unresolved (`undefined`) model gets no
 * effort field either, since there is then no model to key the decision on.
 * Shared by both the default (unsuffixed) agent file, keyed by the role's
 * own `DEFAULT_TIER`, and the tier-variant files, keyed by the variant's own
 * suffix tier: the dispatch rule is identical either way, only which tier
 * gets passed in differs.
 */
function opencodeEffortLine(
  tier: Tier,
  modelValue: string | undefined,
): string | undefined {
  if (!modelValue) return undefined;
  if (isClaudeFamilyModel(modelValue)) {
    if (tier === "high") return "variant: high";
    if (tier === "xhigh") return "variant: max";
    return undefined;
  }
  const slash = modelValue.indexOf("/");
  const provider = slash === -1 ? undefined : modelValue.slice(0, slash);
  if (provider === undefined || provider === "ollama") return undefined;
  return `reasoningEffort: ${TIER_DEFS[tier].effort}`;
}

/**
 * Composes a tier-variant sibling of `composeOpencodeAgent`. `effortLine` is
 * decided once, at the single call site in the opencode tier loop of
 * `runInit` (via `opencodeEffortLine`), and passed in rather than
 * recomputed here, so there is exactly one place that decides it instead
 * of a second, independent source of truth for the same value.
 */
function composeOpencodeAgentVariant(
  role: Role,
  tier: Tier,
  modelValue: string | undefined,
  effortLine: string | undefined,
): string {
  const asset = readAgentAsset(role);
  const frontmatter = [
    "---",
    `description: ${yamlQuote(tierDescriptionSuffix(asset, tier))}`,
    "mode: subagent",
  ];
  if (modelValue) {
    frontmatter.push(`model: ${yamlModelScalar(modelValue)}`);
  }
  if (effortLine) {
    frontmatter.push(effortLine);
  }
  if (READ_ONLY_ROLES.has(role)) {
    frontmatter.push("permission:", "  edit: deny");
  }
  frontmatter.push("---");
  return [...frontmatter, "", asset.body.trimEnd(), ""].join("\n");
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
  const profile: Profile = options.profile ?? DEFAULT_PROFILE;
  const tiers = options.tiers ?? false;
  const report = emptyReport();

  const previous = readInstalledManifest(targetDir);
  const suppliedMaps = parseOpencodeModelMaps(options);
  const previousMaps =
    options.routingMode === "replace"
      ? {}
      : parseOpencodeModelMaps(previous ?? {});
  const opencodeModels =
    suppliedMaps.opencodeModels ??
    (previousMaps.opencodeModels !== undefined
      ? { ...previousMaps.opencodeModels }
      : undefined);
  if (opencodeModels && options.opencodeModels === undefined && previous) {
    for (const role of ROLES) {
      if (options.models[role] !== previous.models[role])
        opencodeModels[role] = opencodeModelValue(options.models[role]);
    }
  }
  const opencodeClassModels =
    suppliedMaps.opencodeClassModels ?? previousMaps.opencodeClassModels;
  const compatibility = legacyOpencodeFallbacks({
    opencodeModels,
    opencodeClassModels,
  });
  const routing = normalizeRoutingState({
    harnesses: options.harnesses,
    models: options.models,
    opencodeModels,
    opencodeClassModels,
    previousRouting: previous?.routing,
    routing: options.routing,
    routingMode: options.routingMode,
    legacyOverrideRoles: previous
      ? ROLES.filter((role) => options.models[role] !== previous.models[role])
      : [],
    updateOpencodeModels: options.opencodeModels !== undefined,
    updateOpencodeClassModels: options.opencodeClassModels !== undefined,
  });
  // Check only rendered selections before the first mutation.
  for (const warning of codexCatalogWarnings(
    routing,
    { harnesses: options.harnesses, profile, tiers },
    options.codexCatalog,
  )) {
    report.notes.push(`Codex catalog: ${warning}`);
  }
  // `null` clears an existing pin, a string sets a new one, and omitted
  // (`undefined`) carries the previous manifest's pin forward unchanged. An
  // empty or whitespace-only string is normalized to a clear as well: it can
  // never usefully name a kit version to gate on, so treating it as a
  // sticky value would let a stray empty input linger unnoticed instead of
  // clearing the pin the caller most likely meant.
  const normalizedPin =
    typeof options.pin === "string"
      ? options.pin.trim() === ""
        ? null
        : options.pin.trim()
      : options.pin;
  const pin =
    normalizedPin === null ? undefined : (normalizedPin ?? previous?.pin);
  const installedFiles: Record<string, string> = {};

  // Both leftover-note loops below are ledger-driven, not enumeration-
  // driven: they only ever push a note for a relative path that the
  // *previous* install actually recorded in `previous.files`, and only ever
  // iterate `previous.harnesses` (the harnesses that install actually wrote
  // files for), never `ROLE_TIERS`/`options.harnesses` as a source of truth.
  // Deriving the note set from ROLE_TIERS/options.harnesses instead would
  // (a) claim a leftover for a variant file that was never written in the
  // first place (e.g. an opencode install whose tier-class models never
  // resolved, so the unresolved-class guard skipped every variant write),
  // and (b) miss a real leftover whose harness was dropped from
  // options.harnesses this run, since that harness's files are still
  // sitting on disk and still becoming untracked either way. The ledger
  // (`previous.files`/`previous.harnesses`) is the only source of truth for
  // "what did the previous install actually put on disk."
  const previousHarnessDirs = (previous?.harnesses ?? [])
    .map((harness) =>
      harness === "claude"
        ? { dir: ".claude", extension: ".md" }
        : harness === "opencode"
          ? { dir: ".opencode", extension: ".md" }
          : harness === "codex"
            ? { dir: ".codex", extension: ".toml" }
            : undefined,
    )
    .filter(
      (entry): entry is { dir: string; extension: ".md" | ".toml" } =>
        entry !== undefined,
    );

  // A full -> minimal downgrade drops explorer/task-slicer from the roles
  // installed, but (like dropping a harness from --harness) existing role
  // files are never deleted: they simply fall out of the manifest's file
  // ledger. Surface that as a note so it is reported instead of silently
  // left as an unexplained, untracked leftover on disk.
  if (previous && previous.profile === "full" && profile !== previous.profile) {
    const droppedRoles = rolesForProfile(previous.profile).filter(
      (role) => !rolesForProfile(profile).includes(role),
    );
    for (const harnessDir of previousHarnessDirs) {
      for (const role of droppedRoles) {
        const relativePath = join(
          harnessDir.dir,
          "agents",
          `${role}${harnessDir.extension}`,
        );
        if (previous.files[relativePath] !== undefined) {
          report.notes.push(
            `${relativePath}: now untracked after the full -> ${profile} profile downgrade; run \`orchestrator-workflow uninstall\` first next time, or remove it by hand.`,
          );
        }
        // A dropped role that also had tiers on previously left behind its
        // own <role>-<tier>.md variant files, not just its base file; the
        // note above only knows about <role>.md, so those variants would go
        // unmentioned even though they are equally untracked now. ROLE_TIERS
        // only supplies the candidate tier suffixes to probe; the ledger
        // check above/below is what decides whether a note is actually due.
        for (const tier of ROLE_TIERS[role]) {
          if (tier === DEFAULT_TIER[role]) continue;
          const variantPath = join(
            harnessDir.dir,
            "agents",
            `${role}-${tier}${harnessDir.extension}`,
          );
          if (previous.files[variantPath] !== undefined) {
            report.notes.push(
              `${variantPath}: now untracked after the full -> ${profile} profile downgrade; run \`orchestrator-workflow uninstall\` first next time, or remove it by hand.`,
            );
          }
        }
      }
    }
  }

  // A tiers on -> off transition leaves each still-installed role's
  // <role>-<tier>.md variant files behind on disk, the same untracked-
  // leftover shape as the full -> minimal profile downgrade above (a role
  // dropped from the profile is handled by the block above instead, so
  // there is no overlap between the two loops). Surface it the same way:
  // a note per file instead of a silent, unexplained leftover.
  if (previous && previous.tiers && !tiers) {
    for (const harnessDir of previousHarnessDirs) {
      for (const role of rolesForProfile(profile)) {
        for (const tier of ROLE_TIERS[role]) {
          if (tier === DEFAULT_TIER[role]) continue;
          const relativePath = join(
            harnessDir.dir,
            "agents",
            `${role}-${tier}${harnessDir.extension}`,
          );
          if (previous.files[relativePath] !== undefined) {
            report.notes.push(
              `${relativePath}: now untracked after tiers were turned off; run \`orchestrator-workflow uninstall\` first next time, or remove it by hand.`,
            );
          }
        }
      }
    }
  }

  // Dropping a harness this run (a previously installed harness no longer
  // in options.harnesses -- including the whole set collapsing to
  // `--harness none`) leaves that harness's files on disk but out of the
  // manifest's file ledger, the same untracked-leftover shape as the two
  // note loops above; surface it the same way instead of a silent leftover
  // for `uninstall` to trip over later. Unlike the two loops above (which
  // only ever touch claude/opencode agent files), this one also covers
  // codex's SKILL.md under `.agents/`, since codex has no per-role agent
  // files but its skill file is still a ledger-tracked kit-owned file.
  //
  // Deliberately keyed off `HARNESSES` (every known harness) and
  // `previous.files` (the raw file ledger) rather than `previous.harnesses`
  // (the sanitized, filtered harness list): a damaged/hand-edited manifest
  // whose raw `harnesses` field lists a valid harness under an unrecognized
  // name (e.g. `["cursor"]` where it once said `["claude"]`) filters that
  // harness's name out of `previous.harnesses` entirely, but its files are
  // still sitting in `previous.files` under `.claude/`; deriving the
  // dropped-harness set from `previous.harnesses` would silently miss those
  // notes (see CHANGELOG). Checking each
  // known harness's own file-ledger prefix directly is immune to that: a
  // harness with no files in the ledger under its prefix produces no notes
  // either way, whether or not `previous.harnesses` ever named it.
  if (previous) {
    const harnessDirs: Record<Harness, string[]> = {
      claude: [".claude"],
      codex: [".agents", ".codex"],
      opencode: [".opencode"],
    };
    for (const harness of HARNESSES) {
      if (options.harnesses.includes(harness)) continue;
      for (const relativePath of Object.keys(previous.files)) {
        if (
          harnessDirs[harness].some((dir) => relativePath.startsWith(dir + sep))
        ) {
          report.notes.push(
            `${relativePath}: now untracked after --harness dropped ${harness}; run \`orchestrator-workflow uninstall\` first next time, or remove it by hand.`,
          );
        }
      }
    }
    // AGENTS.md/CLAUDE.md are never ledger-tracked in the first place
    // (upsertMarkerSection/ensureClaudeImport below write them directly,
    // not through installKitFile, so they never enter previous.files);
    // when the harness set collapses to none this run, this install skips
    // writing them (see the `options.harnesses.length > 0` guard below),
    // so note them by on-disk existence instead of a ledger lookup -- the
    // same untracked signal for a file the ledger never recorded. Gated on
    // ledger evidence (any known harness's file prefix present in
    // `previous.files`), not on the sanitized `previous.harnesses`, for the
    // same reason as the loop above: a damaged manifest can filter a valid
    // harness out of `previous.harnesses` while its files remain recorded.
    const hadTrackedHarnessFiles = Object.keys(previous.files).some(
      (relativePath) =>
        HARNESSES.some((harness) =>
          harnessDirs[harness].some((dir) =>
            relativePath.startsWith(dir + sep),
          ),
        ),
    );
    if (hadTrackedHarnessFiles && options.harnesses.length === 0) {
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        if (existsSync(join(targetDir, name))) {
          report.notes.push(
            `${name}: now untracked after --harness dropped to none; run \`orchestrator-workflow uninstall\` first next time, or remove it by hand.`,
          );
        }
      }
    }
  }

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
  // CLAUDE.md import. The policy section is therefore installed whenever any
  // harness is selected, regardless of which one. AGENTS.md and CLAUDE.md
  // are user-owned: only the fenced section and the import line are ever
  // touched. `options.harnesses.length === 0` is templates-only mode
  // (`--harness none`): only `.ai/workflow/**` and `.ai/runs/.gitkeep` are
  // written, so AGENTS.md is left untouched (and never created) too.
  if (options.harnesses.length > 0) {
    upsertMarkerSection(
      report,
      join(targetDir, "AGENTS.md"),
      readAsset("agents-md-section.md"),
    );
  }

  const skill = readAsset(join("skill", "SKILL.md"));

  if (options.harnesses.includes("claude")) {
    installKitFile(join(".claude", "skills", SKILL_NAME, "SKILL.md"), skill);
    for (const role of rolesForProfile(profile)) {
      installKitFile(
        join(".claude", "agents", `${role}.md`),
        composeClaudeAgent(
          role,
          options.models[role],
          routingSelection(routing, "claude", role, DEFAULT_TIER[role]),
        ),
      );
      if (tiers) {
        for (const tier of ROLE_TIERS[role]) {
          if (tier === DEFAULT_TIER[role]) continue;
          installKitFile(
            join(".claude", "agents", `${role}-${tier}.md`),
            composeClaudeAgentVariant(
              role,
              tier,
              routingSelection(routing, "claude", role, tier),
            ),
          );
        }
      }
    }
    ensureClaudeImport(report, join(targetDir, "CLAUDE.md"));
  }

  if (options.harnesses.includes("codex")) {
    installKitFile(join(".agents", "skills", SKILL_NAME, "SKILL.md"), skill);
    for (const role of rolesForProfile(profile)) {
      const defaultSelection = routingSelection(
        routing,
        "codex",
        role,
        DEFAULT_TIER[role],
      );
      // `defaultCodexRouting` makes every default-tier selection complete;
      // retain this guard so a hand-constructed partial routing object cannot
      // produce an invalid native agent file through the public runInit API.
      if (!defaultSelection) {
        throw new Error(
          `Missing Codex routing for ${role}/${DEFAULT_TIER[role]}`,
        );
      }
      installKitFile(
        join(".codex", "agents", `${role}.toml`),
        composeCodexAgent(role, defaultSelection),
      );
      if (tiers) {
        for (const tier of ROLE_TIERS[role]) {
          if (tier === DEFAULT_TIER[role]) continue;
          const selection = routingSelection(routing, "codex", role, tier);
          if (!selection) {
            throw new Error(`Missing Codex routing for ${role}/${tier}`);
          }
          installKitFile(
            join(".codex", "agents", `${role}-${tier}.toml`),
            composeCodexAgent(role, selection, tier),
          );
        }
      }
    }
  }

  if (options.harnesses.includes("opencode")) {
    installKitFile(join(".opencode", "skills", SKILL_NAME, "SKILL.md"), skill);
    for (const role of rolesForProfile(profile)) {
      const modelValue =
        routingSelection(routing, "opencode", role, DEFAULT_TIER[role])
          ?.model ??
        (opencodeModels !== undefined
          ? opencodeModels[role]
          : opencodeModelValue(options.models[role]));
      const defaultEffortLine = opencodeEffortLine(
        routingSelection(routing, "opencode", role, DEFAULT_TIER[role])
          ?.effort ?? DEFAULT_TIER[role],
        modelValue,
      );
      installKitFile(
        join(".opencode", "agents", `${role}.md`),
        composeOpencodeAgent(role, modelValue, defaultEffortLine),
      );
      if (tiers) {
        for (const tier of ROLE_TIERS[role]) {
          if (tier === DEFAULT_TIER[role]) continue;
          const selection = routingSelection(routing, "opencode", role, tier);
          const modelClass = TIER_DEFS[tier].modelClass;
          const variantModelValue =
            selection?.model ?? opencodeClassModels?.[modelClass];
          if (variantModelValue === undefined) {
            // No model resolved for this class: opencodeEffortLine always
            // returns undefined too when its modelValue argument is
            // undefined (it short-circuits on that first), so this variant
            // would carry neither a model: nor an effort line, a silent
            // no-op duplicate of the base file's own (possibly also
            // unresolved) model line, with no ledger entry to compare it
            // against. Skip it entirely rather than write that
            // indistinguishable file. A *resolved* model with no effort line
            // (e.g. a low/medium tier on a Claude-family model, or any
            // Ollama model) is NOT skipped by this check: it still renders
            // with just its model: line, see the effort-field dispatch
            // rules in opencodeEffortLine above.
            continue;
          }
          const effortLine = opencodeEffortLine(
            selection?.effort ?? tier,
            variantModelValue,
          );
          installKitFile(
            join(".opencode", "agents", `${role}-${tier}.md`),
            composeOpencodeAgentVariant(
              role,
              tier,
              variantModelValue,
              effortLine,
            ),
          );
        }
      }
    }
  }

  // The manifest records applied state, so it is written last and only when
  // something actually differs; a plain re-run stays a byte-for-byte no-op.
  const desired = {
    kit: SKILL_NAME,
    version: PACKAGE_VERSION,
    harnesses: [...options.harnesses].sort(),
    models: options.models,
    profile,
    tiers,
    routing,
    ...compatibility,
    files: installedFiles,
    ...(pin !== undefined ? { pin } : {}),
  };
  const manifestPath = join(targetDir, MANIFEST_PATH);
  if (
    previous &&
    JSON.stringify({
      kit: previous.kit,
      version: previous.version,
      harnesses: previous.harnesses,
      models: previous.models,
      profile: previous.profile,
      tiers: previous.tiers,
      ...(previous.routing !== undefined ? { routing: previous.routing } : {}),
      ...legacyOpencodeFallbacks(previous),
      files: previous.files,
      ...(previous.pin !== undefined ? { pin: previous.pin } : {}),
    }) === JSON.stringify(desired)
  ) {
    report.skipped.push(manifestPath);
  } else {
    const manifest: Manifest = {
      ...desired,
      installedAt: previous?.installedAt || new Date().toISOString(),
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

export type Role =
  | "explorer"
  | "task-slicer"
  | "implementer"
  | "reviewer"
  | "advisor";

export const ROLES: Role[] = [
  "explorer",
  "task-slicer",
  "implementer",
  "reviewer",
  "advisor",
];

/**
 * Roles that map the terrain or judge work without changing it. They are
 * installed with a read-only posture (no file-mutation tools). The advisor
 * escalation role joins this set for the same reason as explorer/reviewer:
 * it reads and recommends but never edits.
 */
export const READ_ONLY_ROLES: ReadonlySet<Role> = new Set<Role>([
  "explorer",
  "reviewer",
  "advisor",
]);

/**
 * A profile selects which subagent roles init installs. `full` is every
 * role (today's unconditional behavior); `minimal` drops the planning
 * (task-slicer), discovery (explorer), and escalation (advisor) roles and
 * keeps only the write+check pair. The reviewer is never omitted from
 * either profile (Standing Rule: always review), so `minimal` is not "just
 * implementer".
 */
export type Profile = "minimal" | "full";

export const PROFILES: Profile[] = ["minimal", "full"];

export const DEFAULT_PROFILE: Profile = "full";

const MINIMAL_PROFILE_ROLES: ReadonlySet<Role> = new Set<Role>([
  "implementer",
  "reviewer",
]);

/** Roles installed for a given profile, in the same order as `ROLES`. */
export function rolesForProfile(profile: Profile): Role[] {
  return profile === "minimal"
    ? ROLES.filter((role) => MINIMAL_PROFILE_ROLES.has(role))
    : ROLES;
}

export function isProfile(value: string): value is Profile {
  return (PROFILES as string[]).includes(value);
}

/**
 * Parses a `--profile` value. Unknown values throw rather than silently
 * falling back to a default, matching `parseHarnessList`'s validation style.
 */
export function parseProfile(value: string): Profile {
  const trimmed = value.trim();
  if (!isProfile(trimmed)) {
    throw new Error(
      `Unknown --profile "${value}"; valid values: ${PROFILES.join(", ")}`,
    );
  }
  return trimmed;
}

export type ModelAlias = "sonnet" | "opus" | "haiku";

export const MODEL_ALIASES: ModelAlias[] = ["sonnet", "opus", "haiku"];

/**
 * Per-role defaults. The orchestrator itself runs on the session model and is
 * deliberately not configured here.
 */
export const DEFAULT_MODELS: Record<Role, string> = {
  explorer: "sonnet",
  "task-slicer": "sonnet",
  implementer: "sonnet",
  reviewer: "opus",
  advisor: "opus",
};

export function isModelAlias(value: string): value is ModelAlias {
  return (MODEL_ALIASES as string[]).includes(value);
}

/**
 * Claude Code subagent frontmatter accepts the aliases directly as well as
 * full model ids, so the chosen value passes through unchanged.
 */
export function claudeModelValue(model: string): string {
  return model;
}

/**
 * opencode requires fully qualified `provider/model-id` strings. Returns the
 * value unchanged when it already contains a provider prefix, or `undefined`
 * for bare aliases and bare ids that cannot be resolved without a live
 * catalog. A `undefined` return means the `model:` frontmatter line should be
 * omitted so the subagent inherits the session model.
 */
export function opencodeModelValue(model: string): string | undefined {
  return model.includes("/") ? model : undefined;
}

/**
 * Model values are interpolated into YAML frontmatter as plain scalars;
 * reject anything that could break out of that position.
 */
export function assertValidModelId(model: string): void {
  if (model.length === 0) {
    throw new Error("Model id must not be empty");
  }
  if (/[:"'#\n\\]/.test(model) || model !== model.trim()) {
    throw new Error(
      `Invalid model id "${model}"; expected an alias (${MODEL_ALIASES.join(", ")}) or a plain id like anthropic/claude-opus-4-8`,
    );
  }
}

/**
 * Parses a `--models` spec like `implementer=haiku,reviewer=opus` on top of
 * the given base mapping. Unknown roles and empty values are rejected.
 */
export function parseModelsSpec(
  spec: string,
  base: Record<Role, string>,
): Record<Role, string> {
  const result = { ...base };
  for (const pair of spec.split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) {
      throw new Error(
        `Invalid --models entry "${trimmed}"; expected role=model`,
      );
    }
    const role = trimmed.slice(0, eq).trim();
    const model = trimmed.slice(eq + 1).trim();
    if (!(ROLES as string[]).includes(role)) {
      throw new Error(
        `Unknown role "${role}" in --models; valid roles: ${ROLES.join(", ")}`,
      );
    }
    assertValidModelId(model);
    result[role as Role] = model;
  }
  return result;
}

/**
 * Effort tiers: additional per-role subagent variants rendered alongside the
 * default (unsuffixed) agent file when the `tiers` feature is on. Default
 * off; see `install-fence-mechanics.md` for the default-off pack rationale.
 */
export type Tier = "low" | "medium" | "high" | "xhigh";

/**
 * Which tiers each role gets a variant file for. A tier outside a role's
 * list is never rendered for that role (e.g. explorer/task-slicer never get
 * an `xhigh` variant, reviewer never gets a `low` variant).
 */
export const ROLE_TIERS: Record<Role, Tier[]> = {
  explorer: ["low", "medium", "high"],
  "task-slicer": ["low", "medium", "high"],
  implementer: ["low", "medium", "high", "xhigh"],
  reviewer: ["medium", "high", "xhigh"],
  advisor: ["high", "xhigh"],
};

/**
 * The tier each role's default (unsuffixed) agent file already corresponds
 * to. No variant file is ever rendered for this tier: rendering one would
 * both collide with the default file's name and duplicate it.
 */
export const DEFAULT_TIER: Record<Role, Tier> = {
  explorer: "medium",
  "task-slicer": "medium",
  implementer: "medium",
  reviewer: "high",
  advisor: "high",
};

export type ModelClass = "small" | "medium" | "large";

export const MODEL_CLASSES: ModelClass[] = ["small", "medium", "large"];

interface TierDef {
  modelClass: ModelClass;
  /** Effort value requested from the harness for this tier. */
  effort: Tier;
}

export const TIER_DEFS: Record<Tier, TierDef> = {
  low: { modelClass: "small", effort: "low" },
  medium: { modelClass: "medium", effort: "medium" },
  high: { modelClass: "medium", effort: "high" },
  xhigh: { modelClass: "large", effort: "xhigh" },
};

/** Which model alias backs each tier's model class. */
export const CLASS_MODELS: Record<ModelClass, ModelAlias> = {
  small: "haiku",
  medium: "sonnet",
  large: "opus",
};

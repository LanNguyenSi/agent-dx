export type Role = "explorer" | "task-slicer" | "implementer" | "reviewer";

export const ROLES: Role[] = [
  "explorer",
  "task-slicer",
  "implementer",
  "reviewer",
];

/**
 * Roles that map the terrain or judge work without changing it. They are
 * installed with a read-only posture (no file-mutation tools).
 */
export const READ_ONLY_ROLES: ReadonlySet<Role> = new Set<Role>([
  "explorer",
  "reviewer",
]);

/**
 * A profile selects which subagent roles init installs. `full` is every
 * role (today's unconditional behavior); `minimal` drops the planning
 * (task-slicer) and discovery (explorer) roles and keeps only the
 * write+check pair. The reviewer is never omitted from either profile
 * (Standing Rule: always review), so `minimal` is not "just implementer".
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

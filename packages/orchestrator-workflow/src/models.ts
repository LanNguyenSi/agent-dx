export type Role = "task-slicer" | "implementer" | "reviewer";

export const ROLES: Role[] = ["task-slicer", "implementer", "reviewer"];

export type ModelAlias = "sonnet" | "opus" | "haiku";

export const MODEL_ALIASES: ModelAlias[] = ["sonnet", "opus", "haiku"];

/**
 * Per-role defaults. The orchestrator itself runs on the session model and is
 * deliberately not configured here.
 */
export const DEFAULT_MODELS: Record<Role, string> = {
  "task-slicer": "sonnet",
  implementer: "sonnet",
  reviewer: "opus",
};

/**
 * opencode expects fully qualified `provider/model-id` strings (models.dev
 * ids). These are the current Anthropic ids for the three aliases; targets
 * with a different provider setup can pass a custom id instead.
 */
const OPENCODE_MODEL_IDS: Record<ModelAlias, string> = {
  sonnet: "anthropic/claude-sonnet-4-6",
  opus: "anthropic/claude-opus-4-8",
  haiku: "anthropic/claude-haiku-4-5",
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

export function opencodeModelValue(model: string): string {
  if (isModelAlias(model)) return OPENCODE_MODEL_IDS[model];
  return model.includes("/") ? model : `anthropic/${model}`;
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

import { HARNESSES } from "./detect.js";
import { readAsset } from "./assets.js";
import { MODEL_ALIASES, ROLE_TIERS, ROLES } from "./models.js";

import type { Harness } from "./detect.js";
import type { Role, Tier } from "./models.js";

export interface ModelSelection {
  model: string;
  effort: Tier;
}

export type CodexModelAlias = "small" | "balanced" | "strong";

/** The Codex alias classes, ordered from the weakest to the strongest. */
export const CODEX_MODEL_ALIASES: readonly CodexModelAlias[] = [
  "small",
  "balanced",
  "strong",
];

/**
 * The ordered model ids of each Codex alias class. The first entry is the
 * intended model of the class; the later entries are only ever used as
 * substitutes for it (see `codex-fallback.ts`).
 */
export type CodexModelCandidates = Record<CodexModelAlias, string[]>;

/**
 * A sparse harness-specific model-routing patch. Later layers supplied to
 * mergeRouting replace a selection leaf while preserving unrelated entries.
 */
export type HarnessRouting = Partial<
  Record<Harness, Partial<Record<Role, Partial<Record<Tier, ModelSelection>>>>>
>;

const TIERS: readonly Tier[] = ["low", "medium", "high", "xhigh"];
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CLAUDE_ALIASES = new Set<string>(MODEL_ALIASES);
const YAML_IMPLICIT_SCALARS = new Set([
  "true",
  "false",
  "null",
  "yes",
  "no",
  "on",
  "off",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeKeys(
  value: Record<string, unknown>,
  location: string,
): void {
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`Dangerous key "${key}" at ${location}`);
    }
  }
}

function assertKnownKey<T extends string>(
  key: string,
  known: readonly T[],
  location: string,
): asserts key is T {
  if (!(known as readonly string[]).includes(key)) {
    throw new Error(
      `Unknown ${location} "${key}"; valid values: ${known.join(", ")}`,
    );
  }
}

function assertModelId(
  model: unknown,
  harness: Harness,
  location: string,
): string {
  if (
    typeof model !== "string" ||
    model.length === 0 ||
    model !== model.trim()
  ) {
    throw new Error(`${location}.model must be a non-empty trimmed string`);
  }
  if (/\s|[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error(
      `${location}.model must not contain whitespace or control characters`,
    );
  }
  const idPattern =
    harness === "opencode"
      ? /^[A-Za-z][A-Za-z0-9._/@+-]*(?::[A-Za-z0-9][A-Za-z0-9._/@+-]*)*$/
      : /^[A-Za-z][A-Za-z0-9._/@+-]*$/;
  if (!idPattern.test(model)) {
    throw new Error(
      `${location}.model must be a plain model id using letters, numbers, dots, underscores, slashes, at signs, pluses, hyphens, and (for opencode) version colons`,
    );
  }
  if (YAML_IMPLICIT_SCALARS.has(model.toLowerCase())) {
    throw new Error(`${location}.model must not be a YAML implicit scalar`);
  }
  if (harness === "codex" && CLAUDE_ALIASES.has(model)) {
    throw new Error(
      `${location}.model must be a Codex model id, not Claude alias "${model}"`,
    );
  }
  if (
    harness === "opencode" &&
    (!model.includes("/") || model.startsWith("/") || model.endsWith("/"))
  ) {
    throw new Error(
      `${location}.model must be a qualified provider/model id for explicit opencode routing`,
    );
  }
  return model;
}

function assertConcreteCodexModelId(model: unknown, location: string): string {
  const value = assertModelId(model, "codex", location);
  if (CODEX_MODEL_ALIASES.includes(value as CodexModelAlias)) {
    throw new Error(`${location}.model must not use an internal Codex alias`);
  }
  return value;
}

/**
 * One alias value: a model id (a list of one) or a non-empty array of
 * distinct model ids, the first being the intended model of the class.
 */
function parseCodexAliasCandidates(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) {
    return [assertConcreteCodexModelId(value, location)];
  }
  if (value.length === 0) {
    throw new Error(`${location} must list at least one model id`);
  }
  const candidates: string[] = [];
  for (const [index, entry] of value.entries()) {
    const model = assertConcreteCodexModelId(entry, `${location}[${index}]`);
    if (candidates.includes(model)) {
      throw new Error(`${location} lists "${model}" more than once`);
    }
    candidates.push(model);
  }
  return candidates;
}

function loadBundledCodexModelCandidates(): CodexModelCandidates {
  let value: unknown;
  try {
    value = JSON.parse(readAsset("codex-models.json"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read bundled Codex model aliases: ${reason}`);
  }
  if (!isRecord(value)) {
    throw new Error("Bundled Codex model aliases must be an object");
  }
  assertSafeKeys(value, "bundled Codex model aliases");
  const result = {} as CodexModelCandidates;
  for (const alias of CODEX_MODEL_ALIASES) {
    if (!(alias in value)) {
      throw new Error(`Bundled Codex model aliases must contain "${alias}"`);
    }
    result[alias] = parseCodexAliasCandidates(
      value[alias],
      `bundled Codex model alias "${alias}"`,
    );
  }
  for (const key of Object.keys(value)) {
    assertKnownKey(key, CODEX_MODEL_ALIASES, "bundled Codex model alias");
  }
  return result;
}

/** The first candidate of each list: the intended model of the class. */
function intendedCodexModels<Models extends Partial<CodexModelCandidates>>(
  candidates: Models,
): { [Alias in keyof Models]: string } {
  return Object.fromEntries(
    Object.entries(candidates).map(([alias, models]) => [
      alias,
      (models as string[])[0],
    ]),
  ) as { [Alias in keyof Models]: string };
}

function loadBundledCodexModels(): Record<CodexModelAlias, string> {
  return intendedCodexModels(loadBundledCodexModelCandidates());
}

/**
 * Parses a sparse Codex alias map into the ordered candidate list of each
 * supplied alias. A string value is a list of one.
 */
export function parseCodexModelCandidates(
  value: unknown,
): Partial<CodexModelCandidates> {
  if (!isRecord(value)) {
    throw new Error("Codex model aliases must be an object");
  }
  assertSafeKeys(value, "Codex model aliases");
  const result: Partial<CodexModelCandidates> = {};
  for (const [alias, models] of Object.entries(value)) {
    assertKnownKey(alias, CODEX_MODEL_ALIASES, "Codex model alias");
    result[alias] = parseCodexAliasCandidates(
      models,
      `Codex model alias "${alias}"`,
    );
  }
  return result;
}

/** The intended model (the first candidate) of each supplied alias. */
export function parseCodexModels(
  value: unknown,
): Partial<Record<CodexModelAlias, string>> {
  return intendedCodexModels(parseCodexModelCandidates(value));
}

/**
 * The complete candidate lists a substitution works with: the bundled list of
 * each alias, replaced whole by a supplied list for that alias.
 */
export function codexModelCandidates(
  overrides: unknown = {},
): CodexModelCandidates {
  return {
    ...loadBundledCodexModelCandidates(),
    ...parseCodexModelCandidates(overrides),
  };
}

function parseSelection(
  value: unknown,
  harness: Harness,
  location: string,
): ModelSelection {
  if (!isRecord(value)) {
    throw new Error(`${location} must be a selection object`);
  }
  assertSafeKeys(value, location);
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "model" && key !== "effort") {
      throw new Error(
        `Unknown ${location} field "${key}"; expected model, effort`,
      );
    }
  }
  if (!("model" in value) || !("effort" in value)) {
    throw new Error(`${location} must contain both model and effort`);
  }
  const model = assertModelId(value.model, harness, location);
  if (typeof value.effort !== "string") {
    throw new Error(`${location}.effort must be one of ${TIERS.join(", ")}`);
  }
  assertKnownKey(value.effort, TIERS, `${location}.effort`);
  return { model, effort: value.effort };
}

/**
 * Parses one strict, sparse routing layer. It deliberately never drops
 * unrecognised data: a typo in a harness, role, tier, or selection is an
 * error so configuration can be fixed before an installation changes files.
 */
export function parseRouting(value: unknown): HarnessRouting {
  if (!isRecord(value)) {
    throw new Error("Routing must be an object");
  }
  assertSafeKeys(value, "routing");
  const result: HarnessRouting = {};

  for (const [harnessName, harnessValue] of Object.entries(value)) {
    assertKnownKey(harnessName, HARNESSES, "harness");
    if (!isRecord(harnessValue)) {
      throw new Error(`Routing for harness "${harnessName}" must be an object`);
    }
    assertSafeKeys(harnessValue, `routing.${harnessName}`);
    const roleRouting: Partial<
      Record<Role, Partial<Record<Tier, ModelSelection>>>
    > = {};

    for (const [roleName, roleValue] of Object.entries(harnessValue)) {
      assertKnownKey(roleName, ROLES, `role for harness "${harnessName}"`);
      if (!isRecord(roleValue)) {
        throw new Error(
          `Routing for ${harnessName}.${roleName} must be an object`,
        );
      }
      assertSafeKeys(roleValue, `routing.${harnessName}.${roleName}`);
      const tierRouting: Partial<Record<Tier, ModelSelection>> = {};

      for (const [tierName, selection] of Object.entries(roleValue)) {
        assertKnownKey(tierName, TIERS, `tier for ${harnessName}.${roleName}`);
        if (!ROLE_TIERS[roleName].includes(tierName)) {
          throw new Error(
            `Tier "${tierName}" is not allowed for role "${roleName}"; allowed tiers: ${ROLE_TIERS[roleName].join(", ")}`,
          );
        }
        tierRouting[tierName] = parseSelection(
          selection,
          harnessName,
          `routing.${harnessName}.${roleName}.${tierName}`,
        );
      }
      roleRouting[roleName] = tierRouting;
    }
    result[harnessName] = roleRouting;
  }
  return result;
}

/** Deeply merges sparse routing layers without mutating any input layer. */
export function mergeRouting(
  ...layers: (HarnessRouting | undefined)[]
): HarnessRouting {
  const result: HarnessRouting = {};
  for (const layer of layers) {
    if (layer === undefined) continue;
    for (const harness of HARNESSES) {
      const harnessLayer = layer[harness];
      if (harnessLayer === undefined) continue;
      const resultHarness = (result[harness] ??= {});
      for (const role of ROLES) {
        const roleLayer = harnessLayer[role];
        if (roleLayer === undefined) continue;
        const resultRole = (resultHarness[role] ??= {});
        for (const tier of ROLE_TIERS[role]) {
          const selection = roleLayer[tier];
          if (selection !== undefined) {
            resultRole[tier] = { ...selection };
          }
        }
      }
    }
  }
  return result;
}

interface CodexDefault {
  alias: CodexModelAlias;
  effort: Tier;
}

/**
 * Default Codex routing: per role and tier, the internal model alias and the
 * effort. The effort is not always the tier name: the small model runs the
 * narrow low tiers at `high`, and the implementer's `xhigh` variant runs the
 * strong model at `high`.
 */
const CODEX_DEFAULT_ALIASES = {
  explorer: {
    low: { alias: "small", effort: "high" },
    medium: { alias: "balanced", effort: "medium" },
    high: { alias: "balanced", effort: "high" },
  },
  "task-slicer": {
    low: { alias: "balanced", effort: "low" },
    medium: { alias: "balanced", effort: "medium" },
    high: { alias: "balanced", effort: "high" },
  },
  implementer: {
    low: { alias: "small", effort: "high" },
    medium: { alias: "balanced", effort: "medium" },
    high: { alias: "balanced", effort: "high" },
    xhigh: { alias: "strong", effort: "high" },
  },
  reviewer: {
    medium: { alias: "balanced", effort: "medium" },
    high: { alias: "strong", effort: "high" },
    xhigh: { alias: "strong", effort: "xhigh" },
  },
  advisor: {
    high: { alias: "strong", effort: "high" },
    xhigh: { alias: "strong", effort: "xhigh" },
  },
} satisfies Record<Role, Partial<Record<Tier, CodexDefault>>>;

/** The default Codex model alias and effort of one role and tier. */
export function codexDefault(role: Role, tier: Tier): CodexDefault | undefined {
  return (CODEX_DEFAULT_ALIASES[role] as Partial<Record<Tier, CodexDefault>>)[
    tier
  ];
}

/**
 * The Codex alias per role and tier that installs recorded before per-role
 * routing existed (the effort equals the tier name). It is only used to
 * materialize the routing of a manifest that records none, so such an install
 * keeps its Codex leaves like its Claude Code and opencode leaves; the alias
 * to model id mapping is the same one the current table uses.
 */
const PRE_ROUTING_CODEX_ALIASES = {
  explorer: { low: "small", medium: "balanced", high: "balanced" },
  "task-slicer": { low: "balanced", medium: "balanced", high: "balanced" },
  implementer: {
    low: "small",
    medium: "balanced",
    high: "balanced",
    xhigh: "strong",
  },
  reviewer: { medium: "balanced", high: "strong", xhigh: "strong" },
  advisor: { high: "strong", xhigh: "strong" },
} satisfies Record<Role, Partial<Record<Tier, CodexModelAlias>>>;

function preRoutingCodexDefault(
  role: Role,
  tier: Tier,
): CodexDefault | undefined {
  const alias = (
    PRE_ROUTING_CODEX_ALIASES[role] as Partial<Record<Tier, CodexModelAlias>>
  )[tier];
  return alias === undefined ? undefined : { alias, effort: tier };
}

function codexRoutingForAliases(
  models: Partial<Record<CodexModelAlias, string>>,
  lookup: (role: Role, tier: Tier) => CodexDefault | undefined = codexDefault,
): HarnessRouting {
  const routing: HarnessRouting = { codex: {} };
  for (const role of ROLES) {
    for (const tier of ROLE_TIERS[role]) {
      const entry = lookup(role, tier);
      if (entry === undefined) continue;
      const model = models[entry.alias];
      if (model === undefined) continue;
      routing.codex![role] ??= {};
      routing.codex![role]![tier] = { model, effort: entry.effort };
    }
  }
  return routing;
}

export function codexModelsRoutingPatch(value: unknown): HarnessRouting {
  return codexRoutingForAliases(parseCodexModels(value));
}

type CodexDefaultRoleRouting<
  AliasRouting extends Partial<Record<Tier, CodexDefault>>,
> = {
  [TierName in keyof AliasRouting]: TierName extends Tier
    ? {
        model: string;
        effort: AliasRouting[TierName] extends { effort: infer E } ? E : never;
      }
    : never;
};

export type CodexDefaultRouting = HarnessRouting & {
  codex: {
    [RoleName in Role]: CodexDefaultRoleRouting<
      (typeof CODEX_DEFAULT_ALIASES)[RoleName]
    >;
  };
};

/**
 * The Codex routing of a manifest that records none: the frozen pre-routing
 * alias table mapped to the bundled model ids.
 */
export function preRoutingCodexRouting(): HarnessRouting {
  return codexRoutingForAliases(
    loadBundledCodexModels(),
    preRoutingCodexDefault,
  );
}

/** Returns a fresh complete Codex routing layer, including each default tier. */
export function defaultCodexRouting(): CodexDefaultRouting {
  return codexRoutingForAliases(
    loadBundledCodexModels(),
  ) as CodexDefaultRouting;
}

export interface CatalogModel {
  slug: string;
  supportedEfforts?: Set<string>;
  supportWarning?: string;
}

export function normalizeCodexCatalog(
  catalog: unknown,
): Map<string, CatalogModel> {
  const modelsValue = Array.isArray(catalog)
    ? catalog
    : isRecord(catalog)
      ? catalog.models
      : undefined;
  if (!Array.isArray(modelsValue)) {
    throw new Error(
      "Codex catalog must be an array of models or an object with a models array",
    );
  }

  const models = new Map<string, CatalogModel>();
  for (const [index, modelValue] of modelsValue.entries()) {
    if (
      !isRecord(modelValue) ||
      typeof modelValue.slug !== "string" ||
      modelValue.slug.trim() === ""
    ) {
      throw new Error(
        `Codex catalog model at index ${index} must have a non-empty slug`,
      );
    }
    if (models.has(modelValue.slug)) {
      throw new Error(
        `Codex catalog contains duplicate model slug "${modelValue.slug}"`,
      );
    }

    const support = modelValue.supported_reasoning_levels;
    if (support === undefined) {
      models.set(modelValue.slug, {
        slug: modelValue.slug,
        supportWarning: `Codex catalog does not provide reasoning-effort support for "${modelValue.slug}"; its selected effort could not be validated.`,
      });
      continue;
    }
    if (!Array.isArray(support)) {
      throw new Error(
        `Codex catalog model "${modelValue.slug}" has malformed supported_reasoning_levels`,
      );
    }
    const efforts = new Set<string>();
    for (const level of support) {
      if (!isRecord(level) || typeof level.effort !== "string") {
        throw new Error(
          `Codex catalog model "${modelValue.slug}" has malformed reasoning-effort support`,
        );
      }
      efforts.add(level.effort);
    }
    models.set(modelValue.slug, {
      slug: modelValue.slug,
      supportedEfforts: efforts,
    });
  }
  return models;
}

/**
 * Validates the selected Codex leaves against a caller-provided debug-model
 * catalog. This helper makes no CLI or network call; callers decide how to
 * acquire the catalog and which installed roles and tiers to pass in.
 */
export function validateCodexCatalog(
  routing: HarnessRouting,
  catalog: unknown,
): string[] {
  const codexRouting = routing.codex;
  if (codexRouting === undefined) return [];
  const models = normalizeCodexCatalog(catalog);
  const warnings = new Set<string>();

  for (const role of ROLES) {
    const roleRouting = codexRouting[role];
    if (roleRouting === undefined) continue;
    for (const tier of ROLE_TIERS[role]) {
      const selection = roleRouting[tier];
      if (selection === undefined) continue;
      const model = models.get(selection.model);
      if (model === undefined) {
        throw new Error(
          `Codex model "${selection.model}" selected for ${role}/${tier} is unavailable in the supplied catalog`,
        );
      }
      const warning = codexLeafEffortWarning(model, selection, role, tier);
      if (warning !== undefined) warnings.add(warning);
    }
  }
  return [...warnings];
}

/**
 * Checks the effort of a leaf whose model the catalog offers: the warning of
 * a model without effort data, or `undefined`; an effort the model does not
 * list throws.
 */
export function codexLeafEffortWarning(
  model: CatalogModel,
  selection: ModelSelection,
  role: Role,
  tier: Tier,
): string | undefined {
  if (model.supportWarning !== undefined) return model.supportWarning;
  if (!model.supportedEfforts?.has(selection.effort)) {
    throw new Error(
      `Codex model "${selection.model}" does not support reasoning effort "${selection.effort}" selected for ${role}/${tier}`,
    );
  }
  return undefined;
}

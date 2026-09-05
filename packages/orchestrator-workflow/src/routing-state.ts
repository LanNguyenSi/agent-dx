import type { Harness } from "./detect.js";
import { HARNESSES } from "./detect.js";
import type { ModelClass, Profile, Role, Tier } from "./models.js";
import {
  CLASS_MODELS,
  DEFAULT_MODELS,
  DEFAULT_TIER,
  MODEL_CLASSES,
  ROLE_TIERS,
  ROLES,
  TIER_DEFS,
  opencodeModelValue,
  rolesForProfile,
} from "./models.js";
import {
  defaultCodexRouting,
  mergeRouting,
  parseRouting,
  validateCodexCatalog,
} from "./routing.js";
import type { HarnessRouting } from "./routing.js";

/** Legacy API resolution state: absent is unknown; present missing keys inherit. */
export interface OpencodeModelMaps {
  opencodeModels?: Partial<Record<Role, string | undefined>>;
  opencodeClassModels?: Partial<Record<ModelClass, string | undefined>>;
}

/** Validate compatibility maps independently of strict explicit routing. */
export function parseOpencodeModelMaps(value: {
  opencodeModels?: unknown;
  opencodeClassModels?: unknown;
}): OpencodeModelMaps {
  const parse = <K extends string>(
    raw: unknown,
    keys: readonly K[],
    name: string,
  ): Partial<Record<K, string | undefined>> | undefined => {
    if (raw === undefined) return undefined;
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    ) {
      throw new Error(`${name} must be a model map`);
    }
    const result: Partial<Record<K, string | undefined>> = {};
    for (const [key, model] of Object.entries(raw)) {
      if (!keys.includes(key as K))
        throw new Error(`Unknown ${name} key "${key}"`);
      if (model === undefined) {
        result[key as K] = undefined;
        continue;
      }
      if (typeof model !== "string")
        throw new Error(`${name}.${key} must be a model id`);
      // A synthetic provider checks the same safe ID grammar while retaining
      // the bare legacy value, without relaxing parseRouting for user patches.
      parseRouting({
        opencode: {
          implementer: {
            medium: {
              model: model.includes("/") ? model : `legacy/${model}`,
              effort: "medium",
            },
          },
        },
      });
      result[key as K] = model;
    }
    return result;
  };
  const opencodeModels = parse(value.opencodeModels, ROLES, "opencodeModels");
  const opencodeClassModels = parse(
    value.opencodeClassModels,
    MODEL_CLASSES,
    "opencodeClassModels",
  );
  return {
    ...(opencodeModels !== undefined ? { opencodeModels } : {}),
    ...(opencodeClassModels !== undefined ? { opencodeClassModels } : {}),
  };
}

/** Persist only the compatibility values that cannot live in strict routing. */
export function legacyOpencodeFallbacks(
  value: OpencodeModelMaps,
): OpencodeModelMaps {
  const parsed = parseOpencodeModelMaps(value);
  const result: OpencodeModelMaps = {};
  for (const field of ["opencodeModels", "opencodeClassModels"] as const) {
    const bare = Object.fromEntries(
      Object.entries(parsed[field] ?? {}).filter(
        ([, model]) => model !== undefined && !model.includes("/"),
      ),
    );
    const keys = field === "opencodeModels" ? ROLES : MODEL_CLASSES;
    const map = parsed[field] as
      | Partial<Record<Role | ModelClass, string | undefined>>
      | undefined;
    // Complete qualified maps are represented entirely by routing. Otherwise
    // presence (including {}) records inheritance for missing map keys.
    if (map !== undefined && !keys.every((key) => map[key]?.includes("/")))
      result[field] = bare;
  }
  return result;
}

/** Strip compatibility-only leaves before saving or parsing strict routing. */
export function persistableRouting(routing: HarnessRouting): HarnessRouting {
  const result = mergeRouting(routing);
  for (const role of ROLES) {
    for (const tier of ROLE_TIERS[role]) {
      const model = result.opencode?.[role]?.[tier]?.model;
      if (model !== undefined && !model.includes("/"))
        delete result.opencode?.[role]?.[tier];
    }
  }
  return result;
}

export interface RoutingScope {
  harnesses: Harness[];
  profile: Profile;
  tiers: boolean;
}

export function selectedTiers(role: Role, tiers: boolean): Tier[] {
  return tiers ? ROLE_TIERS[role] : [DEFAULT_TIER[role]];
}

/** Selects only leaves that the requested adapters actually install. */
export function selectedRouting(
  routing: HarnessRouting,
  scope: RoutingScope,
): HarnessRouting {
  const result: HarnessRouting = {};
  for (const harness of scope.harnesses) {
    for (const role of rolesForProfile(scope.profile)) {
      for (const tier of selectedTiers(role, scope.tiers)) {
        const selection = routing[harness]?.[role]?.[tier];
        if (!selection) continue;
        result[harness] ??= {};
        result[harness]![role] ??= {};
        result[harness]![role]![tier] = { ...selection };
      }
    }
  }
  return result;
}

/** One shared, offline catalog check for setup and installation. */
export function codexCatalogWarnings(
  routing: HarnessRouting,
  scope: RoutingScope,
  catalog?: unknown,
): string[] {
  if (!scope.harnesses.includes("codex")) return [];
  if (catalog === undefined) {
    return [
      "Codex model availability and reasoning-effort support were not validated: no capability catalog supplied. The requested selections are used without capability validation.",
    ];
  }
  return validateCodexCatalog(
    selectedRouting(routing, { ...scope, harnesses: ["codex"] }),
    catalog,
  );
}

export function legacyRouting(
  harnesses: Harness[],
  models: Record<Role, string>,
  opencodeModels: OpencodeModelMaps["opencodeModels"],
  opencodeClassModels: OpencodeModelMaps["opencodeClassModels"],
): HarnessRouting {
  const routing: HarnessRouting = {};
  if (harnesses.includes("claude")) {
    routing.claude = {};
    for (const role of rolesForProfile("full")) {
      routing.claude[role] = {
        [DEFAULT_TIER[role]]: {
          model: models[role],
          effort: DEFAULT_TIER[role],
        },
      };
      for (const tier of ROLE_TIERS[role]) {
        if (tier === DEFAULT_TIER[role]) continue;
        routing.claude[role]![tier] = {
          model: CLASS_MODELS[TIER_DEFS[tier].modelClass],
          effort: tier,
        };
      }
    }
  }
  if (harnesses.includes("opencode")) {
    routing.opencode = {};
    for (const role of rolesForProfile("full")) {
      const defaultModel =
        opencodeModels !== undefined
          ? opencodeModels[role]
          : opencodeModelValue(models[role]);
      if (defaultModel) {
        routing.opencode[role] = {
          [DEFAULT_TIER[role]]: {
            model: defaultModel,
            effort: DEFAULT_TIER[role],
          },
        };
      }
      for (const tier of ROLE_TIERS[role]) {
        if (tier === DEFAULT_TIER[role]) continue;
        const model = opencodeClassModels?.[TIER_DEFS[tier].modelClass];
        if (!model) continue;
        routing.opencode[role] ??= {};
        routing.opencode[role]![tier] = { model, effort: tier };
      }
    }
  }
  return routing;
}

export interface RoutingStateInput extends OpencodeModelMaps {
  harnesses: Harness[];
  models: Record<Role, string>;
  previousRouting?: HarnessRouting;
  routing?: HarnessRouting;
  routingMode?: "patch" | "replace";
  /** Explicit legacy default-role updates; unrelated selections remain sticky. */
  legacyOverrideRoles?: Role[];
  /** Resolved opencode inputs supplied directly to the installer are updates. */
  updateOpencodeModels?: boolean;
  updateOpencodeClassModels?: boolean;
}

/** Materializes legacy inputs and preserves leaves unless explicitly replaced. */
export function normalizeRoutingState(
  input: RoutingStateInput,
): HarnessRouting {
  const mode = input.routingMode === undefined ? "patch" : input.routingMode;
  if (mode !== "patch" && mode !== "replace") {
    throw new Error('routingMode must be "patch" or "replace"');
  }
  // Validate every caller-supplied layer before merge can drop unknown keys.
  const patch =
    input.routing === undefined ? undefined : parseRouting(input.routing);
  const previous =
    input.previousRouting === undefined
      ? undefined
      : parseRouting(input.previousRouting);
  parseOpencodeModelMaps(input);
  const legacy = legacyRouting(
    input.harnesses,
    input.models,
    input.opencodeModels,
    input.opencodeClassModels,
  );
  const result = mergeRouting(
    defaultCodexRouting(),
    legacy,
    mode === "patch" ? previous : undefined,
  );
  if (mode === "patch") {
    for (const harness of ["claude", "opencode"] as const) {
      if (!input.harnesses.includes(harness)) continue;
      for (const role of ROLES) {
        for (const tier of ROLE_TIERS[role]) {
          const defaultTier = tier === DEFAULT_TIER[role];
          const updatesLegacy =
            defaultTier && input.legacyOverrideRoles?.includes(role);
          const updatesResolved =
            harness === "opencode" &&
            (defaultTier
              ? input.updateOpencodeModels
              : input.updateOpencodeClassModels);
          if (!updatesLegacy && !updatesResolved) continue;
          const selection = legacy[harness]?.[role]?.[tier];
          if (selection) {
            result[harness] ??= {};
            result[harness]![role] ??= {};
            result[harness]![role]![tier] = { ...selection };
          } else {
            // Explicitly unresolved legacy inputs restore session inheritance.
            delete result[harness]?.[role]?.[tier];
          }
        }
      }
    }
  }
  return persistableRouting(mergeRouting(result, patch));
}

interface ComparableRoutingState extends OpencodeModelMaps {
  models: Partial<Record<Role, string>>;
  routing?: HarnessRouting;
}

/** Materialize each precedence layer before a higher layer overrides it. */
export function routingStateLayer(
  state: ComparableRoutingState & RoutingScope,
): HarnessRouting {
  const maps = parseOpencodeModelMaps(state);
  const routing =
    state.routing === undefined ? undefined : parseRouting(state.routing);
  return mergeRouting(
    selectedRouting(
      legacyRouting(
        state.harnesses,
        { ...DEFAULT_MODELS, ...state.models },
        maps.opencodeModels,
        maps.opencodeClassModels,
      ),
      state,
    ),
    // Supplied resolutions also record dormant roles and tiers for later use.
    maps.opencodeModels !== undefined || maps.opencodeClassModels !== undefined
      ? legacyRouting(
          ["opencode"],
          DEFAULT_MODELS,
          maps.opencodeModels,
          maps.opencodeClassModels,
        )
      : undefined,
    routing,
  );
}

/** Whether a missing concrete leaf has an explicit legacy inheritance record. */
export function recordedOpencodeInheritance(
  maps: OpencodeModelMaps,
  role: Role,
  tier: Tier,
): boolean {
  return tier === DEFAULT_TIER[role]
    ? maps.opencodeModels !== undefined &&
        maps.opencodeModels[role] === undefined
    : maps.opencodeClassModels !== undefined &&
        maps.opencodeClassModels[TIER_DEFS[tier].modelClass] === undefined;
}

/** Merge recorded resolution state independently of the active render scope. */
export function mergeRoutingStateLayers(
  ...states: (ComparableRoutingState & RoutingScope)[]
): { routing: HarnessRouting } & OpencodeModelMaps {
  let routing: HarnessRouting = {};
  const maps: OpencodeModelMaps = {};
  for (const state of states) {
    const nextMaps = parseOpencodeModelMaps(state);
    // A present map records every slot, including missing keys (inheritance).
    // Replace it whole: inactive harnesses, roles, and tiers retain that intent.
    if (nextMaps.opencodeModels !== undefined)
      maps.opencodeModels = { ...nextMaps.opencodeModels };
    if (nextMaps.opencodeClassModels !== undefined)
      maps.opencodeClassModels = { ...nextMaps.opencodeClassModels };
    for (const role of ROLES) {
      for (const tier of ROLE_TIERS[role]) {
        if (recordedOpencodeInheritance(nextMaps, role, tier))
          delete routing.opencode?.[role]?.[tier];
      }
    }
    // The layer's concrete map entries and explicit routing win after masks.
    routing = mergeRouting(routing, routingStateLayer(state));
  }
  return {
    routing: persistableRouting(routing),
    ...legacyOpencodeFallbacks(maps),
  };
}

/** Compares installed scope without consulting a live opencode catalog. */
export function compareRoutingState(
  repo: ComparableRoutingState,
  operator: ComparableRoutingState,
  scope: RoutingScope,
): { differs: boolean; gaps: string[] } {
  const effective = (state: ComparableRoutingState) =>
    mergeRouting(
      defaultCodexRouting(),
      routingStateLayer({ ...state, ...scope }),
    );
  const actual = effective(repo);
  const expected = effective(operator);
  const actualLegacy = effective({ models: repo.models });
  const expectedLegacy = effective({ models: operator.models });
  const same = (
    left: { model: string; effort: Tier } | undefined,
    right: { model: string; effort: Tier } | undefined,
  ) => left?.model === right?.model && left?.effort === right?.effort;
  let differs = false;
  const gaps: string[] = [];
  for (const harness of HARNESSES) {
    if (!scope.harnesses.includes(harness)) continue;
    for (const role of rolesForProfile(scope.profile)) {
      for (const tier of selectedTiers(role, scope.tiers)) {
        const left = actual[harness]?.[role]?.[tier];
        const right = expected[harness]?.[role]?.[tier];
        if (
          harness === "opencode" &&
          ((!left && !recordedOpencodeInheritance(repo, role, tier)) ||
            (!right && !recordedOpencodeInheritance(operator, role, tier)))
        ) {
          gaps.push(
            `opencode/${role}/${tier}: a legacy model lacks a recorded provider id; routing comparison requires an explicit selection.`,
          );
          continue;
        }
        if (!same(left, right)) {
          // A legacy model difference is already reported in divergence.models.
          // Reserve divergence.routing for a difference in the routing layer.
          const explainedByLegacy =
            same(left, actualLegacy[harness]?.[role]?.[tier]) &&
            same(right, expectedLegacy[harness]?.[role]?.[tier]);
          if (!explainedByLegacy) differs = true;
        }
      }
    }
  }
  return { differs, gaps };
}

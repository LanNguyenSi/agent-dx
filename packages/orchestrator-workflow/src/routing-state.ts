import type { Harness } from "./detect.js";
import { HARNESSES } from "./detect.js";
import type { ModelClass, Profile, Role, Tier, TierDef } from "./models.js";
import {
  CLASS_MODELS,
  DEFAULT_MODELS,
  PRE_ROLE_TIER_DEFS,
  belowRoleFloor,
  DEFAULT_TIER,
  MODEL_CLASSES,
  ROLE_TIERS,
  ROLE_TIER_DEFS,
  ROLES,
  opencodeModelValue,
  rolesForProfile,
  tierDef,
} from "./models.js";
import {
  DEFAULT_CODEX_FALLBACK,
  buildRoutingResolution,
  codexFallbackError,
  formatCodexFallbackRow,
  planCodexFallback,
  resolutionEntries,
} from "./codex-fallback.js";
import type {
  CodexFallbackMode,
  CodexFallbackPlan,
  RoutingResolution,
} from "./codex-fallback.js";
import {
  codexModelCandidates,
  defaultCodexRouting,
  mergeRouting,
  parseRouting,
  preRoutingCodexRouting,
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

const NO_CODEX_CATALOG_NOTE =
  "Codex model availability and reasoning-effort support were not validated: no capability catalog supplied. The requested selections are used without capability validation.";

export interface CodexFallbackOptions {
  /** Defaults to `stop`. Has no effect without a catalog. */
  fallback?: CodexFallbackMode;
  /** Sparse alias map replacing bundled candidate lists, as `--codex-models`. */
  candidates?: unknown;
}

/**
 * Plans the installed Codex leaves against a catalog and throws the
 * substitution table unless every affected leaf may be substituted: the mode
 * is `degrade` and each has a substitute.
 */
function plannedCodexFallback(
  routing: HarnessRouting,
  scope: RoutingScope,
  catalog: unknown,
  options: CodexFallbackOptions,
): CodexFallbackPlan {
  const mode = options.fallback ?? DEFAULT_CODEX_FALLBACK;
  const plan = planCodexFallback(
    selectedRouting(routing, { ...scope, harnesses: ["codex"] }),
    catalog,
    codexModelCandidates(options.candidates),
  );
  if (
    plan.rows.length > 0 &&
    (mode !== "degrade" || plan.rows.some((row) => row.used === undefined))
  ) {
    throw codexFallbackError(plan.rows, mode);
  }
  return plan;
}

/**
 * One shared, offline catalog check for stored defaults (`setup`). Defaults
 * hold the intended routing and no resolution, so under `degrade` a missing
 * model is only announced with the substitute an install would use.
 */
export function codexCatalogWarnings(
  routing: HarnessRouting,
  scope: RoutingScope,
  catalog?: unknown,
  options: CodexFallbackOptions = {},
): string[] {
  if (!scope.harnesses.includes("codex")) return [];
  if (catalog === undefined) return [NO_CODEX_CATALOG_NOTE];
  const plan = plannedCodexFallback(routing, scope, catalog, options);
  return [
    ...plan.warnings,
    ...plan.rows.map(
      (row) =>
        `Codex fallback: ${formatCodexFallbackRow(row)}. The stored defaults keep the intended model ${row.intended.model}; an install substitutes ${row.used!.model} only with a catalog and --codex-fallback degrade.`,
    ),
  ];
}

export interface CodexInstallResolution {
  /** The routing to render: the intended routing with each substitute applied. */
  rendered: HarnessRouting;
  /** The record to store; absent when no leaf is substituted. */
  resolution?: RoutingResolution;
  /** Lines to print: every substitution, return and dropped record, then warnings. */
  notes: string[];
}

/**
 * Resolves what an install renders for Codex. `routing` is the intended
 * routing and is never changed. A recorded substitution is carried only while
 * its leaf's intended selection is unchanged. Without a catalog (or without
 * Codex among the harnesses) nothing is checked and the carried record is
 * applied as it is. With a catalog every installed Codex leaf is resolved
 * anew from its intended selection: a leaf whose intended model is offered
 * returns to it and loses its record; a leaf whose model is missing is
 * substituted under `degrade`, and otherwise stops the install with the
 * substitution table before anything is written.
 */
export function resolveCodexInstall(
  routing: HarnessRouting,
  scope: RoutingScope,
  catalog: unknown,
  previous: RoutingResolution | undefined,
  options: CodexFallbackOptions = {},
): CodexInstallResolution {
  const notes: string[] = [];
  const describe = (selection: { model: string; effort: Tier }) =>
    `${selection.model} (${selection.effort})`;
  const installsCodex = scope.harnesses.includes("codex");
  const installed = selectedRouting(routing, {
    ...scope,
    harnesses: ["codex"],
  });
  const isInstalled = (role: Role, tier: Tier) =>
    installsCodex && installed.codex?.[role]?.[tier] !== undefined;

  let entries = resolutionEntries(previous).filter(({ role, tier, entry }) => {
    const intended = routing.codex?.[role]?.[tier];
    if (
      intended !== undefined &&
      intended.model === entry.intended.model &&
      intended.effort === entry.intended.effort
    ) {
      return true;
    }
    notes.push(
      `Codex fallback: the recorded substitution of ${role}/${tier} (${describe(entry.used)} for intended ${describe(entry.intended)}) is dropped, because the intended routing of that leaf changed${intended === undefined ? "" : ` to ${describe(intended)}`}.`,
    );
    return false;
  });

  if (!installsCodex || catalog === undefined) {
    for (const { role, tier, entry } of entries) {
      if (!isInstalled(role, tier)) continue;
      notes.push(
        `Codex fallback: ${role}/${tier} keeps the recorded substitute ${describe(entry.used)} for intended ${describe(entry.intended)} [${entry.reason}]; no catalog was supplied, so availability was not checked again.`,
      );
    }
    if (installsCodex) notes.push(`Codex catalog: ${NO_CODEX_CATALOG_NOTE}`);
  } else {
    const plan = plannedCodexFallback(routing, scope, catalog, options);
    for (const { role, tier, entry } of entries) {
      if (
        isInstalled(role, tier) &&
        !plan.rows.some((row) => row.role === role && row.tier === tier)
      ) {
        notes.push(
          `Codex fallback: ${role}/${tier} returns to its intended model ${describe(entry.intended)}, which the catalog offers again; the substitute ${describe(entry.used)} is no longer used.`,
        );
      }
    }
    // Every installed leaf was resolved anew; a leaf that is not installed
    // keeps its carried record.
    entries = entries.filter(({ role, tier }) => !isInstalled(role, tier));
    for (const row of plan.rows) {
      notes.push(
        `Codex fallback: ${row.role}/${row.tier} uses ${describe(row.used!)} instead of intended ${describe(row.intended)} [${row.reason!}].`,
      );
      entries.push({
        role: row.role,
        tier: row.tier,
        entry: { intended: row.intended, used: row.used!, reason: row.reason! },
      });
    }
    for (const warning of plan.warnings) {
      notes.push(`Codex catalog: ${warning}`);
    }
  }

  const resolution = buildRoutingResolution(entries);
  const rendered = mergeRouting(routing);
  for (const { role, tier, entry } of resolutionEntries(resolution)) {
    if (rendered.codex?.[role]?.[tier] === undefined) continue;
    rendered.codex[role]![tier] = { ...entry.used };
  }
  return {
    rendered,
    ...(resolution !== undefined ? { resolution } : {}),
    notes,
  };
}

/**
 * The opencode model of a tier-variant leaf taken from the class map, or
 * `undefined` when the class has none or the model sits below the role's
 * class floor (the leaf is then omitted and inherits the session model).
 */
export function opencodeClassLeafModel(
  role: Role,
  modelClass: ModelClass,
  classModels: OpencodeModelMaps["opencodeClassModels"],
): string | undefined {
  const model = classModels?.[modelClass];
  if (!model || belowRoleFloor(role, model, classModels)) return undefined;
  return model;
}

/**
 * The routing of a manifest that records none (written before routing
 * existed): derived once from its legacy inputs with the tier-uniform table
 * of that time, so a re-install keeps the routing that install was running
 * instead of adopting the current per-role defaults for its non-default
 * tiers, and its Codex leaves from the Codex aliases and efforts of that time
 * (every version that knows routing records them, also on an install that
 * does not use Codex, so they are derived whichever harnesses are selected).
 */
export function materializePreRoutingRouting(
  harnesses: Harness[],
  models: Partial<Record<Role, string>>,
  maps: OpencodeModelMaps,
): HarnessRouting {
  return persistableRouting(
    mergeRouting(
      preRoutingCodexRouting(),
      legacyRouting(
        harnesses,
        { ...DEFAULT_MODELS, ...models },
        maps.opencodeModels,
        maps.opencodeClassModels,
        PRE_ROLE_TIER_DEFS,
      ),
    ),
  );
}

/**
 * Derives the Claude Code and opencode routing from the legacy inputs: the
 * default tier takes the per-role model (`models`), every other tier takes the
 * model of its class in `defs`, and the effort comes from `defs`. `defs`
 * defaults to the current per-role table; a manifest that records no routing
 * is materialized once with the table it was installed under instead (see
 * `PRE_ROLE_TIER_DEFS`).
 */
export function legacyRouting(
  harnesses: Harness[],
  models: Record<Role, string>,
  opencodeModels: OpencodeModelMaps["opencodeModels"],
  opencodeClassModels: OpencodeModelMaps["opencodeClassModels"],
  defs: Record<Role, Partial<Record<Tier, TierDef>>> = ROLE_TIER_DEFS,
): HarnessRouting {
  const routing: HarnessRouting = {};
  if (harnesses.includes("claude")) {
    routing.claude = {};
    for (const role of rolesForProfile("full")) {
      routing.claude[role] = {
        [DEFAULT_TIER[role]]: {
          model: models[role],
          effort: tierDef(role, DEFAULT_TIER[role], defs).effort,
        },
      };
      for (const tier of ROLE_TIERS[role]) {
        if (tier === DEFAULT_TIER[role]) continue;
        const def = tierDef(role, tier, defs);
        routing.claude[role]![tier] = {
          model: CLASS_MODELS[def.modelClass],
          effort: def.effort,
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
            effort: tierDef(role, DEFAULT_TIER[role], defs).effort,
          },
        };
      }
      for (const tier of ROLE_TIERS[role]) {
        if (tier === DEFAULT_TIER[role]) continue;
        const def = tierDef(role, tier, defs);
        const model = opencodeClassLeafModel(
          role,
          def.modelClass,
          opencodeClassModels,
        );
        if (!model) continue;
        routing.opencode[role] ??= {};
        routing.opencode[role]![tier] = { model, effort: def.effort };
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
        opencodeClassLeafModel(
          role,
          tierDef(role, tier).modelClass,
          maps.opencodeClassModels,
        ) === undefined;
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

import type { Role, Tier } from "./models.js";
import { ROLES, ROLE_TIERS } from "./models.js";
import {
  CODEX_MODEL_ALIASES,
  codexLeafEffortWarning,
  normalizeCodexCatalog,
  parseRouting,
} from "./routing.js";
import type {
  CatalogModel,
  CodexModelAlias,
  CodexModelCandidates,
  HarnessRouting,
  ModelSelection,
} from "./routing.js";

/**
 * What an install does when a supplied catalog lacks a selected Codex model:
 * `stop` ends it before any file is written, `degrade` substitutes an
 * available model by the fixed rule of {@link planCodexFallback}.
 */
export type CodexFallbackMode = "stop" | "degrade";

export const CODEX_FALLBACK_MODES: readonly CodexFallbackMode[] = [
  "stop",
  "degrade",
];

export const DEFAULT_CODEX_FALLBACK: CodexFallbackMode = "stop";

/** Parses a `--codex-fallback` value; an unknown value throws. */
export function parseCodexFallbackMode(value: unknown): CodexFallbackMode {
  const mode = CODEX_FALLBACK_MODES.find((known) => known === value);
  if (mode === undefined) {
    throw new Error(
      `Unknown --codex-fallback ${JSON.stringify(value)}; valid values: ${CODEX_FALLBACK_MODES.join(", ")}`,
    );
  }
  return mode;
}

/**
 * Why a substitute was chosen: a later candidate of the leaf's own alias
 * class, or a candidate of a lower class.
 */
export type CodexFallbackReason = "class-candidate" | "lower-class";

const CODEX_FALLBACK_REASONS: readonly CodexFallbackReason[] = [
  "class-candidate",
  "lower-class",
];

/** One substituted leaf: the routing asked for and the routing rendered. */
export interface CodexLeafResolution {
  intended: ModelSelection;
  used: ModelSelection;
  reason: CodexFallbackReason;
}

/**
 * The manifest's `routingResolution` record: the substituted Codex leaves by
 * role and tier. A leaf that renders its intended routing has no entry, and
 * a record without entries is never written.
 */
export interface RoutingResolution {
  codex?: Partial<Record<Role, Partial<Record<Tier, CodexLeafResolution>>>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The entries of a record in role and tier order. */
export function resolutionEntries(
  resolution: RoutingResolution | undefined,
): { role: Role; tier: Tier; entry: CodexLeafResolution }[] {
  const entries: { role: Role; tier: Tier; entry: CodexLeafResolution }[] = [];
  for (const role of ROLES) {
    for (const tier of ROLE_TIERS[role]) {
      const entry = resolution?.codex?.[role]?.[tier];
      if (entry !== undefined) entries.push({ role, tier, entry });
    }
  }
  return entries;
}

/**
 * Builds a record from entries, in role and tier order with a fixed field
 * order so two equal records serialize to the same bytes; `undefined` when
 * there is no entry.
 */
export function buildRoutingResolution(
  entries: { role: Role; tier: Tier; entry: CodexLeafResolution }[],
): RoutingResolution | undefined {
  const codex: NonNullable<RoutingResolution["codex"]> = {};
  for (const role of ROLES) {
    for (const tier of ROLE_TIERS[role]) {
      const found = entries.find(
        (candidate) => candidate.role === role && candidate.tier === tier,
      );
      if (found === undefined) continue;
      const { intended, used, reason } = found.entry;
      (codex[role] ??= {})[tier] = {
        intended: { model: intended.model, effort: intended.effort },
        used: { model: used.model, effort: used.effort },
        reason,
      };
    }
  }
  return Object.keys(codex).length > 0 ? { codex } : undefined;
}

/**
 * Parses a stored `routingResolution` strictly: the record decides what a
 * re-install without a catalog renders, so a malformed one is an error
 * instead of a silent return to models the account may not offer. Returns
 * `undefined` for a record without entries.
 */
export function parseRoutingResolution(
  value: unknown,
): RoutingResolution | undefined {
  const location = "routingResolution";
  if (!isPlainObject(value)) {
    throw new Error(`${location} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "codex") {
      throw new Error(`Unknown ${location} harness "${key}"; expected codex`);
    }
  }
  const codex = value.codex;
  if (codex === undefined) return undefined;
  if (!isPlainObject(codex)) {
    throw new Error(`${location}.codex must be an object`);
  }
  const entries: { role: Role; tier: Tier; entry: CodexLeafResolution }[] = [];
  for (const [role, tiers] of Object.entries(codex)) {
    if (!isPlainObject(tiers)) {
      throw new Error(`${location}.codex.${role} must be an object`);
    }
    for (const [tier, entry] of Object.entries(tiers)) {
      const at = `${location}.codex.${role}.${tier}`;
      if (!isPlainObject(entry)) throw new Error(`${at} must be an object`);
      for (const key of Object.keys(entry)) {
        if (key !== "intended" && key !== "used" && key !== "reason") {
          throw new Error(
            `Unknown ${at} field "${key}"; expected intended, used, reason`,
          );
        }
      }
      // The routing parser validates the role, the tier and each selection.
      const selection = (field: "intended" | "used"): ModelSelection => {
        try {
          const parsed = parseRouting({
            codex: { [role]: { [tier]: entry[field] } },
          });
          return parsed.codex![role as Role]![tier as Tier]!;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`${at}.${field} is invalid: ${reason}`);
        }
      };
      const reason = CODEX_FALLBACK_REASONS.find(
        (known) => known === entry.reason,
      );
      if (reason === undefined) {
        throw new Error(
          `${at}.reason must be one of ${CODEX_FALLBACK_REASONS.join(", ")}`,
        );
      }
      entries.push({
        role: role as Role,
        tier: tier as Tier,
        entry: {
          intended: selection("intended"),
          used: selection("used"),
          reason,
        },
      });
    }
  }
  return buildRoutingResolution(entries);
}

/** One leaf whose intended model the catalog lacks. */
export interface CodexFallbackRow {
  role: Role;
  tier: Tier;
  intended: ModelSelection;
  /** The substitute; absent when the leaf has none. */
  used?: ModelSelection;
  reason?: CodexFallbackReason;
  /** Why the leaf has no substitute; set exactly when `used` is absent. */
  problem?: string;
}

export interface CodexFallbackPlan {
  /** The leaves whose intended model the catalog lacks, in role and tier order. */
  rows: CodexFallbackRow[];
  /** Catalog warnings of the leaves that keep or receive a model. */
  warnings: string[];
}

const EFFORTS: readonly Tier[] = ["low", "medium", "high", "xhigh"];

/** The effort a leaf that dropped to a lower class runs at, at least. */
const LOWER_CLASS_EFFORT_FLOOR: Tier = "high";

/**
 * The lowest alias class a role's substitute may come from. Roles that judge
 * or advise never run on a substitute below their floor; a role without an
 * entry may drop as far as the lowest class.
 */
const ROLE_ALIAS_FLOOR: Partial<Record<Role, CodexModelAlias>> = {
  reviewer: "balanced",
  advisor: "balanced",
};

/**
 * The alias class a model belongs to: the class whose candidate list contains
 * it. When several lists do, the list naming it earliest wins, and among
 * those the stronger class. `undefined` for a model in no list.
 */
function modelAliasClass(
  model: string,
  candidates: CodexModelCandidates,
): CodexModelAlias | undefined {
  let best: { alias: CodexModelAlias; index: number } | undefined;
  for (const alias of CODEX_MODEL_ALIASES) {
    const index = candidates[alias].indexOf(model);
    if (index === -1) continue;
    if (best === undefined || index <= best.index) best = { alias, index };
  }
  return best?.alias;
}

/**
 * The effort a substituted leaf runs at, or why the model cannot serve it.
 * A leaf that dropped to a lower class asks for at least `high`. The result
 * is clamped to the levels the catalog lists for the model: the wanted level
 * when listed, else the next lower listed one, else the lowest listed one. A
 * model without effort data keeps the wanted effort and warns.
 */
function substituteEffort(
  intended: Tier,
  model: CatalogModel,
  lowerClass: boolean,
): { effort: Tier; warning?: string } | { unusable: string } {
  const floor = EFFORTS.indexOf(LOWER_CLASS_EFFORT_FLOOR);
  const wanted =
    lowerClass && EFFORTS.indexOf(intended) < floor
      ? LOWER_CLASS_EFFORT_FLOOR
      : intended;
  if (model.supportedEfforts === undefined) {
    return { effort: wanted, warning: model.supportWarning };
  }
  const listed = EFFORTS.filter((effort) =>
    model.supportedEfforts!.has(effort),
  );
  const clamped =
    listed
      .filter((effort) => EFFORTS.indexOf(effort) <= EFFORTS.indexOf(wanted))
      .at(-1) ?? listed[0];
  if (clamped === undefined) {
    return { unusable: `lists none of the efforts ${EFFORTS.join(", ")}` };
  }
  if (lowerClass && EFFORTS.indexOf(clamped) < floor) {
    return {
      unusable: `lists no effort of ${LOWER_CLASS_EFFORT_FLOOR} or above, which a lower-class substitute needs`,
    };
  }
  return { effort: clamped };
}

function substituteFor(
  role: Role,
  tier: Tier,
  intended: ModelSelection,
  models: Map<string, CatalogModel>,
  candidates: CodexModelCandidates,
  warnings: Set<string>,
): CodexFallbackRow {
  const leafClass = modelAliasClass(intended.model, candidates);
  if (leafClass === undefined) {
    return {
      role,
      tier,
      intended,
      problem: `"${intended.model}" is in no candidate list, and an explicitly selected model is never replaced`,
    };
  }
  const floor = ROLE_ALIAS_FLOOR[role] ?? CODEX_MODEL_ALIASES[0];
  const floorIndex = CODEX_MODEL_ALIASES.indexOf(floor);
  const tried: CodexModelAlias[] = [];
  const unusable: string[] = [];
  for (
    let index = CODEX_MODEL_ALIASES.indexOf(leafClass);
    index >= floorIndex;
    index -= 1
  ) {
    const alias = CODEX_MODEL_ALIASES[index];
    const lowerClass = alias !== leafClass;
    tried.push(alias);
    // Same class: only the candidates after the intended model. Lower class:
    // the whole list in order.
    const list = lowerClass
      ? candidates[alias]
      : candidates[alias].slice(candidates[alias].indexOf(intended.model) + 1);
    for (const candidate of list) {
      const model = models.get(candidate);
      if (model === undefined) continue;
      const effort = substituteEffort(intended.effort, model, lowerClass);
      if ("unusable" in effort) {
        unusable.push(`${candidate} ${effort.unusable}`);
        continue;
      }
      if (effort.warning !== undefined) warnings.add(effort.warning);
      return {
        role,
        tier,
        intended,
        used: { model: candidate, effort: effort.effort },
        reason: lowerClass ? "lower-class" : "class-candidate",
      };
    }
  }
  const floorNote =
    ROLE_ALIAS_FLOOR[role] === undefined
      ? ""
      : ` (the ${role} is never substituted below the ${floor} class)`;
  const problem =
    tried.length === 0
      ? `the ${leafClass} class is below the ${floor} class, and the ${role} is never substituted below it`
      : `the catalog offers no usable candidate of the ${tried.join(" or ")} class${floorNote}`;
  return {
    role,
    tier,
    intended,
    problem:
      unusable.length > 0 ? `${problem}; ${unusable.join("; ")}` : problem,
  };
}

/**
 * Plans the substitution of every Codex leaf in `routing` whose model the
 * catalog lacks. Per leaf, in this order: the first later candidate of the
 * leaf's own alias class that the catalog offers; else the first offered
 * candidate of the next lower class, down to the role's floor; else no
 * substitute. A leaf whose model is in no candidate list is never
 * substituted. A leaf whose model the catalog offers is checked as before
 * (an effort it does not list throws). This helper makes no CLI or network
 * call and writes nothing; callers pass only the installed leaves.
 */
export function planCodexFallback(
  routing: HarnessRouting,
  catalog: unknown,
  candidates: CodexModelCandidates,
): CodexFallbackPlan {
  const codexRouting = routing.codex;
  if (codexRouting === undefined) return { rows: [], warnings: [] };
  const models = normalizeCodexCatalog(catalog);
  const warnings = new Set<string>();
  const rows: CodexFallbackRow[] = [];
  for (const role of ROLES) {
    for (const tier of ROLE_TIERS[role]) {
      const selection = codexRouting[role]?.[tier];
      if (selection === undefined) continue;
      const model = models.get(selection.model);
      if (model === undefined) {
        rows.push(
          substituteFor(role, tier, selection, models, candidates, warnings),
        );
        continue;
      }
      const warning = codexLeafEffortWarning(model, selection, role, tier);
      if (warning !== undefined) warnings.add(warning);
    }
  }
  return { rows, warnings: [...warnings] };
}

function describeSelection(selection: ModelSelection): string {
  return `${selection.model} (${selection.effort})`;
}

/** One table line: role, tier, intended model and effort, and the outcome. */
export function formatCodexFallbackRow(row: CodexFallbackRow): string {
  const outcome =
    row.used === undefined
      ? `no substitute: ${row.problem}`
      : `${describeSelection(row.used)} [${row.reason}]`;
  return `${row.role}/${row.tier}: ${describeSelection(row.intended)} -> ${outcome}`;
}

/**
 * The error of an install that stops over unavailable models: the models,
 * then the substitution table `degrade` would apply, one line per leaf.
 */
export function codexFallbackError(
  rows: CodexFallbackRow[],
  mode: CodexFallbackMode,
): Error {
  const missing = [...new Set(rows.map((row) => row.intended.model))];
  const blocked = rows.filter((row) => row.used === undefined);
  const heading =
    mode === "degrade"
      ? `--codex-fallback degrade cannot proceed: ${blocked.length} of ${rows.length} affected leaves have no substitute.`
      : blocked.length > 0
        ? `--codex-fallback degrade would not proceed either: ${blocked.length} of ${rows.length} affected leaves have no substitute.`
        : "--codex-fallback degrade would apply these substitutions:";
  return new Error(
    [
      `Codex ${missing.length === 1 ? "model" : "models"} ${missing.map((model) => `"${model}"`).join(", ")} selected for ${rows.length === 1 ? "an installed leaf" : `${rows.length} installed leaves`} ${missing.length === 1 ? "is" : "are"} unavailable in the supplied catalog. Nothing was written.`,
      heading,
      ...rows.map((row) => `  ${formatCodexFallbackRow(row)}`),
    ].join("\n"),
  );
}

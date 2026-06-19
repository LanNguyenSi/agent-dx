import { execFileSync } from "node:child_process";

import type { ModelAlias, Role } from "./models.js";
import { isModelAlias } from "./models.js";

// ---------------------------------------------------------------------------
// Pure catalog helpers (unit-testable without shell access)
// ---------------------------------------------------------------------------

/**
 * Splits raw `opencode models` stdout into a list of trimmed non-empty lines,
 * each of the form `provider/model-id`.
 */
export function parseOpencodeCatalog(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Returns the provider id: the substring before the first `/`.
 * e.g. `github-copilot/claude-sonnet-4.6` → `github-copilot`
 *      `openrouter/anthropic/claude-sonnet-4.6` → `openrouter`
 */
export function providerOf(modelLine: string): string {
  return modelLine.slice(0, modelLine.indexOf("/"));
}

/**
 * Infers which provider to use for alias resolution.
 *
 * - If `explicit` is given, it is returned as-is (no catalog check).
 * - Otherwise the catalog is scanned for providers that offer at least one
 *   model whose id segment (the part after `provider/`) starts with `claude-`.
 *   Exactly one such provider → use it.
 *   More than one → `{ provider: undefined, ambiguous: true }`.
 *   None → `{ provider: undefined, ambiguous: false }`.
 */
export function detectProvider(opts: {
  catalog: string[];
  explicit?: string;
}): { provider?: string; ambiguous: boolean } {
  if (opts.explicit !== undefined) {
    return { provider: opts.explicit, ambiguous: false };
  }

  const providers = new Set<string>();
  for (const line of opts.catalog) {
    if (line.indexOf("/") <= 0) continue;
    const provider = providerOf(line);
    const remainder = line.slice(provider.length + 1);
    if (remainder.startsWith("claude-")) {
      providers.add(provider);
    }
  }

  if (providers.size === 1) {
    return { provider: [...providers][0], ambiguous: false };
  }
  if (providers.size > 1) {
    return { provider: undefined, ambiguous: true };
  }
  return { provider: undefined, ambiguous: false };
}

// Tags that mark non-canonical variants to skip when better options exist.
const NON_CANONICAL_MARKERS = ["-fast", "-thinking", "-mini", "-latest"];

function isNonCanonical(idSegment: string): boolean {
  return NON_CANONICAL_MARKERS.some(
    (marker) => idSegment.endsWith(marker) || idSegment.includes(marker + "-"),
  );
}

/** Parses the numeric version from a model id after removing the family token prefix. */
function parseVersion(idSegment: string, familyToken: string): number[] {
  const suffix = idSegment.slice(familyToken.length);
  // Split on `.` and `-`, keep only numeric parts.
  return suffix
    .split(/[.\-]/)
    .filter((p) => /^\d+$/.test(p))
    .map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

const FAMILY_TOKENS: Record<ModelAlias, string> = {
  sonnet: "claude-sonnet",
  opus: "claude-opus",
  haiku: "claude-haiku",
};

/**
 * Finds the best fully-qualified `provider/model-id` line for a given alias
 * from the live catalog.
 *
 * Selection rules:
 * 1. Only lines starting with `${provider}/` whose remainder starts with the
 *    family token are candidates.
 * 2. Non-canonical variants (`-fast`, `-thinking`, `-mini`, `-latest`) are
 *    excluded unless no canonical candidates remain.
 * 3. Among remaining candidates, the one with the highest parsed version wins.
 *
 * Returns `undefined` when no matching line exists.
 */
export function resolveAlias(
  provider: string,
  alias: ModelAlias,
  catalog: string[],
): string | undefined {
  const familyToken = FAMILY_TOKENS[alias];
  const prefix = `${provider}/`;

  const allCandidates = catalog.filter((line) => {
    if (!line.startsWith(prefix)) return false;
    const remainder = line.slice(prefix.length);
    return remainder.startsWith(familyToken);
  });

  if (allCandidates.length === 0) return undefined;

  const canonical = allCandidates.filter(
    (line) => !isNonCanonical(line.slice(prefix.length)),
  );
  const candidates = canonical.length > 0 ? canonical : allCandidates;

  let best: string | undefined;
  let bestVersion: number[] = [];

  for (const line of candidates) {
    const remainder = line.slice(prefix.length);
    const version = parseVersion(remainder, familyToken);
    if (best === undefined || compareVersions(version, bestVersion) > 0) {
      best = line;
      bestVersion = version;
    }
  }

  return best;
}

/**
 * Resolves each role's model string to a fully-qualified opencode id or
 * `undefined` (meaning: omit `model:` and inherit the session model).
 *
 * - Already fully-qualified values (contain `/`) pass through unchanged.
 * - Known aliases are resolved via the live catalog + provider detection.
 * - Unknown bare strings (not an alias, no `/`) → `undefined` + warning.
 * - When provider detection is ambiguous or yields nothing → `undefined` +
 *   one combined warning asking the user to pass `--opencode-provider <id>`
 *   or fully-qualified `--models`.
 */
export function resolveOpencodeModels(
  roleModels: Record<Role, string>,
  opts: { catalog: string[]; explicitProvider?: string },
): { resolved: Record<Role, string | undefined>; warnings: string[] } {
  const { catalog, explicitProvider } = opts;
  const resolved = {} as Record<Role, string | undefined>;
  const warnings: string[] = [];

  // Lazily detect provider once, shared across all roles.
  let providerResult: { provider?: string; ambiguous: boolean } | undefined;

  for (const [role, model] of Object.entries(roleModels) as [Role, string][]) {
    if (model.includes("/")) {
      // Already fully qualified — pass through.
      resolved[role] = model;
      continue;
    }

    if (!isModelAlias(model)) {
      resolved[role] = undefined;
      warnings.push(
        `Role "${role}": "${model}" is not a known alias and has no provider prefix; model: will be omitted (inherits session model).`,
      );
      continue;
    }

    // Known alias — need provider.
    if (providerResult === undefined) {
      providerResult = detectProvider({
        catalog,
        explicit: explicitProvider,
      });
    }

    if (providerResult.provider === undefined) {
      // Warning will be added once after the loop.
      resolved[role] = undefined;
      continue;
    }

    const fq = resolveAlias(
      providerResult.provider,
      model as ModelAlias,
      catalog,
    );
    if (fq === undefined) {
      resolved[role] = undefined;
      warnings.push(
        `Role "${role}": provider "${providerResult.provider}" has no "${model}" model in the catalog; model: will be omitted.`,
      );
    } else {
      resolved[role] = fq;
    }
  }

  // Emit one combined warning for ambiguous / no-provider cases.
  if (providerResult !== undefined && providerResult.provider === undefined) {
    const msg = providerResult.ambiguous
      ? `Multiple providers offer Claude models in the live catalog; cannot auto-detect. Pass --opencode-provider <id> or use fully-qualified --models (e.g. provider/model-id) per role to resolve aliases.`
      : `No provider offering Claude models found in the live catalog. Pass --opencode-provider <id> or use fully-qualified --models (e.g. provider/model-id) per role to resolve aliases.`;
    warnings.push(msg);
  }

  return { resolved, warnings };
}

// ---------------------------------------------------------------------------
// Impure shell-out (kept tiny and free of logic so tests avoid it)
// ---------------------------------------------------------------------------

/**
 * Runs `opencode models` and returns the parsed catalog. Returns an empty
 * array on any error (binary absent, non-zero exit, timeout, etc.).
 */
export function loadOpencodeCatalog(): string[] {
  try {
    const stdout = execFileSync("opencode", ["models"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseOpencodeCatalog(stdout);
  } catch {
    return [];
  }
}

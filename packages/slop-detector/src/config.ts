import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type {
  PackId,
  ResolvedConfig,
  RuleOverride,
  Severity,
} from "./types.js";

const SeveritySchema = z.enum(["block", "warn", "info"]);
const PackIdSchema = z.enum([
  "agent-tics",
  "prose-slop",
  "comment-slop",
  "code-slop",
  "ui-slop",
  "placement-slop",
  "workflow-slop",
  "review-slop",
]);

const RuleOverrideSchema = z.object({
  severity: SeveritySchema.optional(),
  enabled: z.boolean().optional(),
});

// `entrypointGlobs` is matched against a path already made relative to the
// scan root (see `_resolveEntrypointGlobs` in engine.ts) — a leading "/"
// can never match that relative path, so it's always a misconfiguration
// (someone assuming absolute-path matching) rather than a valid pattern.
// Reject it at parse time instead of letting it silently match nothing.
const EntrypointGlobSchema = z.string().refine((g) => !g.startsWith("/"), {
  message:
    'entrypointGlobs patterns are matched relative to the scan root (or the nearest package.json directory), not as absolute paths — remove the leading "/"',
});

// `placement.markers` and `placement.allow` are regex pattern strings the
// placement-slop pack compiles at check time (`new RegExp(pattern, ...)`).
// A pattern that can't compile would otherwise fail silently way downstream
// inside a rule's `check`, so reject it here, at config parse time, with a
// message that names the bad pattern. A pattern that compiles but matches
// the empty string (e.g. "a*") is rejected too: `org-marker` runs these
// patterns against every line of every instruction file, and a zero-width
// match would match at every character position (unbounded, meaningless
// violations). For `allow`, a zero-width match is simply useless: an allow
// span only excuses the match it covers, and a zero-width span can never
// cover (start < end of) anything, so it could never suppress a real
// finding.
const RegexPatternSchema = z
  .string()
  .refine(
    (pattern) => {
      try {
        new RegExp(pattern);
        return true;
      } catch {
        return false;
      }
    },
    (pattern) => ({
      message: `Invalid regular expression in placement config: "${pattern}"`,
    }),
  )
  .refine(
    (pattern) => {
      try {
        return !new RegExp(pattern).test("");
      } catch {
        // Already reported by the first `.refine` above; don't double-report.
        return true;
      }
    },
    (pattern) => ({
      message: `Regular expression in placement config matches the empty string, which would match every position in every scanned line: "${pattern}"`,
    }),
  );

// `placement.instructionGlobs` is matched against a path already made
// relative to the scan root (see `isInstructionFile` in
// packs/placement-slop.ts and `_resolveEntrypointGlobs` in engine.ts for
// the sibling mechanism) — same reasoning as `EntrypointGlobSchema` above:
// a leading "/" can never match that relative path.
const InstructionGlobSchema = z.string().refine((g) => !g.startsWith("/"), {
  message:
    'placement.instructionGlobs patterns are matched relative to the scan root (or the nearest package.json directory), not as absolute paths — remove the leading "/"',
});

const PlacementConfigSchema = z.object({
  markers: z.array(RegexPatternSchema).optional(),
  instructionGlobs: z.array(InstructionGlobSchema).optional(),
  allow: z.array(RegexPatternSchema).optional(),
});

// `workflow.allowExpressions` entries are the bare expression body only
// (e.g. "matrix.node"), matched against the trimmed text already stripped
// of its `${{`/`}}` wrapper (see `isAllowedExpression` in
// packs/workflow-slop.ts) — an entry that still carries the wrapper can
// never match anything, which would otherwise fail silently exactly like
// the other misconfigurations this file rejects at load time.
const AllowExpressionSchema = z.string().refine(
  (e) => !e.includes("${{") && !e.includes("}}"),
  (e) => ({
    message: `workflow.allowExpressions entries are the bare expression body only (e.g. "matrix.node"), not the "\${{ ... }}" wrapper, remove the "\${{"/"}}" from "${e}"`,
  }),
);

// `workflow.node20Majors`/`node20MajorsIgnore` entries are the exact
// `owner/repo@vN` match key `workflow-slop/node20-action-major` compares a
// `uses:` value's resolved `owner/repo@major` against (see
// `packs/workflow-slop.ts` and `data/node20-actions.ts`). Reject anything
// that cannot possibly be that shape at config-load time, the same
// fail-fast treatment `AllowExpressionSchema` gives a malformed
// `allowExpressions` entry.
const Node20MajorSchema = z.string().refine(
  (e) => /^[^/\s@]+\/[^/\s@]+@v\d+$/.test(e),
  (e) => ({
    message: `workflow.node20Majors/node20MajorsIgnore entries are "owner/repo@vN" (e.g. "actions/checkout@v4"), got "${e}"`,
  }),
);

// A `workflow.auditGateTemplates` entry registers one exact npm-audit
// gate block as recognised by `workflow-slop/audit-gate-shape` (see that
// rule in `packs/workflow-slop.ts`). The digest it compares against is
// the sha256 of the block's normalised statements, so an entry that
// carries neither a `sha256` nor a `statements` list can never match
// anything, and one that carries both leaves it ambiguous which the
// operator meant to be authoritative. Both are rejected at config-load
// time rather than failing silently, the same fail-fast treatment
// `AllowExpressionSchema` gives a malformed `allowExpressions` entry.
const AuditGateTemplateSchema = z
  .object({
    name: z.string().min(1),
    sha256: z
      .string()
      .regex(
        /^[0-9a-fA-F]{64}$/,
        "workflow.auditGateTemplates[].sha256 is a 64-character hex sha256 digest",
      )
      .optional(),
    statements: z.array(z.string()).min(1).optional(),
  })
  .refine(
    (t) => (t.sha256 === undefined) !== (t.statements === undefined),
    (t) => ({
      message: `workflow.auditGateTemplates entries carry exactly one of "sha256" or "statements", got ${
        t.sha256 === undefined && t.statements === undefined
          ? "neither"
          : "both"
      } for "${t.name}"`,
    }),
  );

// `workflow.executedActionInputs` entries are the exact `owner/repo:input`
// match key `workflow-slop/run-expression` compares a `uses:` step's
// resolved `owner/repo` plus a `with:` input name against (see
// `packs/workflow-slop.ts` and `data/executed-action-inputs.ts`). No `@vN`
// component: unlike `Node20MajorSchema`, this list matches independent of
// ref, so a version suffix here can never match anything and is rejected
// at config-load time, the same fail-fast treatment `AllowExpressionSchema`
// gives a malformed `allowExpressions` entry. The FIRST colon after
// `owner/repo` is the separator between it and the input name, so an
// input name can never itself contain a colon (the input half's own
// character class excludes `:` for exactly that reason -- there would be
// no way to tell which colon separates from which is part of the name).
// The input half also excludes a literal space: `workflow-slop/run-expression`
// folds a matched input name case- and space/underscore-insensitively
// (`normalizeExecutedInputName`, mirroring how the Actions runner itself
// folds a `with:` input name into `INPUT_<NAME>`), so a config entry
// names the input with an underscore where a workflow author might write
// a literal space (`acme/run-code:my_input` still matches a workflow step
// written `with: my input:`), and any casing matches any other.
const ExecutedActionInputSchema = z.string().refine(
  (e) => /^[^/\s:@]+\/[^/\s:@]+:[^\s:@]+$/.test(e),
  (e) => ({
    message: `workflow.executedActionInputs entries are "owner/repo:input" (e.g. "actions/github-script:script"), no "@ref" (matching is ref-independent); the first colon after owner/repo separates it from the input name, so the input name cannot itself contain a colon or a space (write "_" for a literal space; matching folds case and space/underscore), got "${e}"`,
  }),
);

const WorkflowConfigSchema = z.object({
  allowExpressions: z.array(AllowExpressionSchema).optional(),
  node20Majors: z.array(Node20MajorSchema).optional(),
  node20MajorsIgnore: z.array(Node20MajorSchema).optional(),
  auditGateTemplates: z.array(AuditGateTemplateSchema).optional(),
  executedActionInputs: z.array(ExecutedActionInputSchema).optional(),
});

// `review.allowPaths` is matched against a path already made relative to
// the scan root (mirrors `InstructionGlobSchema`/`EntrypointGlobSchema`
// above) -- a leading "/" can never match that relative path.
const ReviewAllowPathSchema = z.string().refine((g) => !g.startsWith("/"), {
  message:
    'review.allowPaths patterns are matched relative to the scan root (or the nearest package.json directory), not as absolute paths: remove the leading "/"',
});

const ReviewConfigSchema = z.object({
  allow: z.array(RegexPatternSchema).optional(),
  allowPaths: z.array(ReviewAllowPathSchema).optional(),
});

// A pattern written as `./foo/**/*.md` means the same thing as `foo/**/*.md`
// once it's matched against an already-relativized path (`path.relative`
// never produces a leading "./"), but users naturally type the "./" prefix.
// Normalize it away at merge time so both `isInstructionFile` and the
// zero-match warning in `checkFiles` compile the exact same pattern string.
function stripLeadingDotSlash(glob: string): string {
  return glob.startsWith("./") ? glob.slice(2) : glob;
}

const ConfigFileSchema = z.object({
  packs: z.record(PackIdSchema, z.boolean()).optional(),
  rules: z.record(z.string(), RuleOverrideSchema).optional(),
  ignorePaths: z.array(z.string()).optional(),
  treatAsProse: z.array(z.string()).optional(),
  treatAsCode: z.array(z.string()).optional(),
  corpus: z.boolean().optional(),
  entrypointGlobs: z.array(EntrypointGlobSchema).optional(),
  placement: PlacementConfigSchema.optional(),
  workflow: WorkflowConfigSchema.optional(),
  review: ReviewConfigSchema.optional(),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

const DEFAULT_PACKS: Record<PackId, boolean> = {
  "agent-tics": true,
  "prose-slop": true,
  "comment-slop": false,
  "code-slop": false,
  "ui-slop": false,
  "placement-slop": false,
  "workflow-slop": false,
  "review-slop": false,
};

/**
 * Exported so `review-slop.ts`'s `isAllowedPath` can fall back to the exact
 * same array (rather than a second, drift-prone `["**\/CHANGELOG.md"]`
 * literal) when it receives a hand-built `ResolvedConfig` that omits
 * `review` entirely -- the same defensive fallback `defaultConfig`'s own
 * `placement`/`workflow` fields document.
 */
export const DEFAULT_REVIEW_ALLOW_PATHS = ["**/CHANGELOG.md"];

const DEFAULT_IGNORES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.git/**",
  "**/*.lock",
  "**/package-lock.json",
];

export function loadConfig(configPath?: string): ResolvedConfig {
  if (!configPath) return defaultConfig();

  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }

  const raw = fs.readFileSync(abs, "utf8");
  const parsed = abs.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config at ${abs}: ${result.error.message}`);
  }

  return mergeConfig(result.data);
}

export function defaultConfig(): ResolvedConfig {
  return {
    packs: { ...DEFAULT_PACKS },
    ruleOverrides: {},
    ignorePaths: [...DEFAULT_IGNORES],
    treatAsProse: [],
    treatAsCode: [],
    entrypointGlobs: [],
    placement: { markers: [], instructionGlobs: [], allow: [] },
    workflow: {
      allowExpressions: [],
      node20Majors: [],
      node20MajorsIgnore: [],
      auditGateTemplates: [],
      executedActionInputs: [],
    },
    review: { allow: [], allowPaths: [...DEFAULT_REVIEW_ALLOW_PATHS] },
  };
}

export function mergeConfig(file: ConfigFile): ResolvedConfig {
  const base = defaultConfig();
  const packs: Record<PackId, boolean> = {
    ...base.packs,
    ...(file.packs ?? {}),
  };
  const ruleOverrides: Record<string, RuleOverride> = { ...(file.rules ?? {}) };
  return {
    packs,
    ruleOverrides,
    ignorePaths: [...base.ignorePaths, ...(file.ignorePaths ?? [])],
    treatAsProse: file.treatAsProse ?? [],
    treatAsCode: file.treatAsCode ?? [],
    corpus: file.corpus,
    entrypointGlobs: file.entrypointGlobs ?? [],
    placement: {
      markers: file.placement?.markers ?? [],
      instructionGlobs: (file.placement?.instructionGlobs ?? []).map(
        stripLeadingDotSlash,
      ),
      allow: file.placement?.allow ?? [],
    },
    workflow: {
      allowExpressions: file.workflow?.allowExpressions ?? [],
      node20Majors: file.workflow?.node20Majors ?? [],
      node20MajorsIgnore: file.workflow?.node20MajorsIgnore ?? [],
      auditGateTemplates: file.workflow?.auditGateTemplates ?? [],
      executedActionInputs: file.workflow?.executedActionInputs ?? [],
    },
    review: {
      allow: file.review?.allow ?? [],
      // Same `./`-stripping `placement.instructionGlobs` gets above --
      // `review.allowPaths` is matched against an already-relativized path
      // (see `relativizeToScanRoot` in review-slop.ts), so a user-typed
      // `./foo/**` prefix must normalize to `foo/**` or it silently never
      // matches.
      allowPaths: (
        file.review?.allowPaths ?? [...DEFAULT_REVIEW_ALLOW_PATHS]
      ).map(stripLeadingDotSlash),
    },
  };
}

export function effectiveSeverity(
  ruleId: string,
  defaultSeverity: Severity,
  config: ResolvedConfig,
): Severity {
  return config.ruleOverrides[ruleId]?.severity ?? defaultSeverity;
}

export function isRuleEnabled(
  ruleId: string,
  _pack: PackId,
  enabledByDefault: boolean,
  config: ResolvedConfig,
): boolean {
  // Pack-level gating is the engine's job (so `--pack` can override the
  // config). This function only owns the per-rule override layer:
  //   1. explicit `rules.<id>.enabled: true|false` in slop.config.yml
  //   2. otherwise the rule's own `enabledByDefault`
  const override = config.ruleOverrides[ruleId]?.enabled;
  if (override !== undefined) return override;
  return enabledByDefault;
}

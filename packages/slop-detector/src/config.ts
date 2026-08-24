import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { PackId, ResolvedConfig, RuleOverride, Severity } from "./types.js";

const SeveritySchema = z.enum(["block", "warn", "info"]);
const PackIdSchema = z.enum([
  "agent-tics",
  "prose-slop",
  "comment-slop",
  "code-slop",
  "ui-slop",
  "placement-slop",
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
// message that names the bad pattern.
const RegexPatternSchema = z.string().refine(
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
);

const PlacementConfigSchema = z.object({
  markers: z.array(RegexPatternSchema).optional(),
  instructionGlobs: z.array(z.string()).optional(),
  allow: z.array(RegexPatternSchema).optional(),
});

const ConfigFileSchema = z.object({
  packs: z.record(PackIdSchema, z.boolean()).optional(),
  rules: z.record(z.string(), RuleOverrideSchema).optional(),
  ignorePaths: z.array(z.string()).optional(),
  treatAsProse: z.array(z.string()).optional(),
  treatAsCode: z.array(z.string()).optional(),
  corpus: z.boolean().optional(),
  entrypointGlobs: z.array(EntrypointGlobSchema).optional(),
  placement: PlacementConfigSchema.optional(),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

const DEFAULT_PACKS: Record<PackId, boolean> = {
  "agent-tics": true,
  "prose-slop": true,
  "comment-slop": false,
  "code-slop": false,
  "ui-slop": false,
  "placement-slop": false,
};

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
  };
}

export function mergeConfig(file: ConfigFile): ResolvedConfig {
  const base = defaultConfig();
  const packs: Record<PackId, boolean> = { ...base.packs, ...(file.packs ?? {}) };
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
      instructionGlobs: file.placement?.instructionGlobs ?? [],
      allow: file.placement?.allow ?? [],
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

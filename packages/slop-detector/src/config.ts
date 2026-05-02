import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { PackId, ResolvedConfig, RuleOverride, Severity } from "./types.js";

const SeveritySchema = z.enum(["block", "warn", "info"]);
const PackIdSchema = z.enum(["agent-tics", "prose-slop", "comment-slop", "code-slop", "ui-slop"]);

const RuleOverrideSchema = z.object({
  severity: SeveritySchema.optional(),
  enabled: z.boolean().optional(),
});

const ConfigFileSchema = z.object({
  packs: z.record(PackIdSchema, z.boolean()).optional(),
  rules: z.record(z.string(), RuleOverrideSchema).optional(),
  ignorePaths: z.array(z.string()).optional(),
  treatAsProse: z.array(z.string()).optional(),
  treatAsCode: z.array(z.string()).optional(),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

const DEFAULT_PACKS: Record<PackId, boolean> = {
  "agent-tics": true,
  "prose-slop": true,
  "comment-slop": false,
  "code-slop": false,
  "ui-slop": false,
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

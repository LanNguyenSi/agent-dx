import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { defaultConfigPath } from './paths.js';

export type SinkConfig = Record<string, unknown>;

export interface FrictionLogConfig {
  sinks: Record<string, SinkConfig>;
}

const EMPTY_CONFIG: FrictionLogConfig = { sinks: {} };

export function loadConfig(path: string = defaultConfigPath()): FrictionLogConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // ENOENT is the common case: the user has not created a config file. Any
    // other error (permission, bad symlink) is worth surfacing so we don't
    // silently fall back to defaults when the user thinks they have a config.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return EMPTY_CONFIG;
    }
    throw new Error(`friction-log: failed to read config file ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`friction-log: failed to parse YAML in ${path}: ${(err as Error).message}`);
  }
  if (parsed == null) return EMPTY_CONFIG;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`friction-log: config at ${path} must be a YAML mapping at the top level`);
  }
  const sinks = (parsed as { sinks?: unknown }).sinks;
  if (sinks == null) return EMPTY_CONFIG;
  if (typeof sinks !== 'object' || Array.isArray(sinks)) {
    throw new Error(`friction-log: config at ${path} has a non-mapping "sinks" value`);
  }
  const out: Record<string, SinkConfig> = {};
  for (const [name, value] of Object.entries(sinks as Record<string, unknown>)) {
    if (value == null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`friction-log: config sinks.${name} must be a YAML mapping`);
    }
    out[name] = value as SinkConfig;
  }
  return { sinks: out };
}

/**
 * Merge per-sink config with CLI overrides. CLI wins on key collision so a
 * one-off `--sink-opt repo=other/repo` overrides the config's default repo.
 */
export function mergeSinkOpts(
  configSection: SinkConfig | undefined,
  cliOverrides: SinkConfig | undefined
): SinkConfig {
  return { ...(configSection ?? {}), ...(cliOverrides ?? {}) };
}

const KV_PATTERN = /^([A-Za-z0-9_.-]+)=(.*)$/s;

/**
 * Parse repeated `--sink-opt key=value` CLI flags into a SinkConfig.
 * Values are coerced from string with cheap heuristics: comma-separated lists
 * become arrays, "true"/"false" become booleans, integers become numbers. To
 * keep a literal that looks like a list/number, prefix with `s:`.
 */
export function parseSinkOpts(pairs: string[]): SinkConfig {
  const out: SinkConfig = {};
  for (const pair of pairs) {
    const m = KV_PATTERN.exec(pair);
    if (!m) {
      throw new Error(`friction-log: --sink-opt expected key=value, got "${pair}"`);
    }
    const key = m[1];
    const rawValue = m[2];
    out[key] = coerceValue(rawValue);
  }
  return out;
}

function coerceValue(raw: string): unknown {
  if (raw.startsWith('s:')) return raw.slice(2);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.includes(',')) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return raw;
}

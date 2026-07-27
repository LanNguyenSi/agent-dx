import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { defaultConfigPath, syncExportOriginOverride, syncExportPathOverride } from './paths.js';

export type SinkConfig = Record<string, unknown>;

/**
 * Config-gated write-through + read-only peer merge. Absent this block,
 * `sync-export` and the per-mutation write-through are exact no-ops (see
 * commands/sync-export.ts). `peerPaths` are files written by OTHER machines'
 * own `sync_export.path` (or write-through); `digest --include-peers` reads
 * them read-only. Transport between machines (Dropbox, iCloud,
 * agent-memory-sync, ...) is out of scope for this package.
 */
export interface SyncExportConfig {
  path: string;
  origin: string;
  peerPaths: string[];
}

export interface FrictionLogConfig {
  sinks: Record<string, SinkConfig>;
  syncExport?: SyncExportConfig;
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
      return applySyncExportEnvOverrides(EMPTY_CONFIG);
    }
    throw new Error(`friction-log: failed to read config file ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`friction-log: failed to parse YAML in ${path}: ${(err as Error).message}`);
  }
  if (parsed == null) return applySyncExportEnvOverrides(EMPTY_CONFIG);
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`friction-log: config at ${path} must be a YAML mapping at the top level`);
  }
  const root = parsed as Record<string, unknown>;

  const sinksRaw = root.sinks;
  const sinks: Record<string, SinkConfig> = {};
  if (sinksRaw != null) {
    if (typeof sinksRaw !== 'object' || Array.isArray(sinksRaw)) {
      throw new Error(`friction-log: config at ${path} has a non-mapping "sinks" value`);
    }
    for (const [name, value] of Object.entries(sinksRaw as Record<string, unknown>)) {
      if (value == null) continue;
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`friction-log: config sinks.${name} must be a YAML mapping`);
      }
      sinks[name] = value as SinkConfig;
    }
  }

  const syncExport = parseSyncExportBlock(root.sync_export, path);
  return applySyncExportEnvOverrides({ sinks, syncExport });
}

function parseSyncExportBlock(raw: unknown, configPath: string): SyncExportConfig | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`friction-log: config at ${configPath} has a non-mapping "sync_export" value`);
  }
  const obj = raw as Record<string, unknown>;
  const rawPath = obj.path;
  const rawOrigin = obj.origin;
  const rawPeers = obj.peer_paths;
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error(`friction-log: config sync_export.path at ${configPath} must be a non-empty string`);
  }
  if (typeof rawOrigin !== 'string' || !rawOrigin.trim()) {
    throw new Error(`friction-log: config sync_export.origin at ${configPath} must be a non-empty string`);
  }
  let peerPaths: string[] = [];
  if (rawPeers != null) {
    if (!Array.isArray(rawPeers) || !rawPeers.every((p) => typeof p === 'string')) {
      throw new Error(`friction-log: config sync_export.peer_paths at ${configPath} must be a list of strings`);
    }
    peerPaths = rawPeers as string[];
  }
  return { path: rawPath, origin: rawOrigin, peerPaths };
}

/**
 * FRICTION_LOG_SYNC_EXPORT_PATH / FRICTION_LOG_SYNC_EXPORT_ORIGIN win over
 * the YAML `sync_export` block when set (paths.ts env-var convention), so a
 * config.yml can be shared across machines (e.g. via dotfiles) while each
 * machine supplies its own path/origin via env. Either var alone, with no
 * counterpart resolvable from config or env, is a config error rather than
 * a silent partial activation.
 */
function applySyncExportEnvOverrides(config: FrictionLogConfig): FrictionLogConfig {
  const envPath = syncExportPathOverride();
  const envOrigin = syncExportOriginOverride();
  if (envPath === undefined && envOrigin === undefined) return config;
  const path = envPath ?? config.syncExport?.path;
  const origin = envOrigin ?? config.syncExport?.origin;
  if (!path || !origin) {
    throw new Error(
      'friction-log: FRICTION_LOG_SYNC_EXPORT_PATH / FRICTION_LOG_SYNC_EXPORT_ORIGIN require both a path and an origin ' +
        '(from the env vars or the config sync_export block) to activate sync-export'
    );
  }
  return { ...config, syncExport: { path, origin, peerPaths: config.syncExport?.peerPaths ?? [] } };
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

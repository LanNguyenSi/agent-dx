import { homedir } from 'node:os';
import { join } from 'node:path';

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
}

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}

export function defaultDbPath(): string {
  return process.env.FRICTION_LOG_DB ?? join(xdgDataHome(), 'friction-log', 'db.sqlite');
}

export function defaultConfigPath(): string {
  return process.env.FRICTION_LOG_CONFIG ?? join(xdgConfigHome(), 'friction-log', 'config.yml');
}

export function defaultMarkdownSinkDir(): string {
  return process.env.FRICTION_LOG_MARKDOWN_DIR ?? join(xdgDataHome(), 'friction-log', 'frictions');
}

/**
 * sync_export has no XDG-style fallback location (it is opt-in only), so
 * unlike the `default*Path` helpers above these return `undefined` when the
 * env var is unset rather than falling back to a computed default. Callers
 * (config.ts) treat `undefined` as "no override" and fall through to the
 * config-file value, if any.
 */
export function syncExportPathOverride(): string | undefined {
  return process.env.FRICTION_LOG_SYNC_EXPORT_PATH || undefined;
}

export function syncExportOriginOverride(): string | undefined {
  return process.env.FRICTION_LOG_SYNC_EXPORT_ORIGIN || undefined;
}

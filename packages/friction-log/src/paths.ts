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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, type FrictionLogConfig, type SyncExportConfig } from '../config.js';
import { FrictionDb } from '../db.js';
import { defaultDbPath } from '../paths.js';
import { frictionToExport, type ExportRecord } from './export.js';

export interface SyncExportCommandInput {
  dbPath?: string;
  configPath?: string;
}

export interface SyncExportCommandOutput {
  path: string;
  origin: string;
  count: number;
}

/**
 * `friction-log sync-export`: explicit, on-demand write of the full
 * deterministic export. Throws (CLI exits non-zero) when `sync_export` is
 * not configured, since the whole point of calling this verb is to produce
 * the file; unlike the write-through helper below, silence would be
 * surprising here.
 */
export function runSyncExport(input: SyncExportCommandInput = {}): SyncExportCommandOutput {
  const config = loadConfig(input.configPath);
  if (!config.syncExport) {
    throw new Error(
      'friction-log: sync-export requires a "sync_export" block (path + origin) in config.yml, or the ' +
        'FRICTION_LOG_SYNC_EXPORT_PATH / FRICTION_LOG_SYNC_EXPORT_ORIGIN env vars'
    );
  }
  const dbPath = input.dbPath ?? defaultDbPath();
  const count = writeSyncExportFile(dbPath, config.syncExport);
  return { path: config.syncExport.path, origin: config.syncExport.origin, count };
}

/**
 * Write-through helper: called after a successful mutation from each of the
 * six mutating commands (log, scan, import, update, rm, file). Config-gated
 * exact no-op when `sync_export` is not configured, so existing users see
 * zero behavior change.
 *
 * Config loading happens INSIDE this function's own try/catch, not at the
 * call site: the friction row is already committed by the time any of the
 * six commands calls this, so a config-load failure (a malformed
 * config.yml, even one with no `sync_export` block at all; or a half-set
 * FRICTION_LOG_SYNC_EXPORT_* env pair) must degrade to the same stderr
 * warning as a write failure, never propagate and crash the command. A
 * crash here previously meant the mutation had already succeeded but the
 * CLI reported failure, inviting a retry that would duplicate the row.
 *
 * Two ways to call it: pass `configPath` (log, scan, import, update, rm,
 * none of which need the config for anything else) or an already-loaded
 * `config` (file.ts, which needs it beforehand anyway to merge sink
 * options, and would otherwise load it twice).
 */
export function maybeSyncExport(params: { dbPath: string; configPath?: string }): void;
export function maybeSyncExport(params: { dbPath: string; config: FrictionLogConfig }): void;
export function maybeSyncExport(params: {
  dbPath: string;
  configPath?: string;
  config?: FrictionLogConfig;
}): void {
  const { dbPath } = params;
  try {
    const config = params.config ?? loadConfig(params.configPath);
    if (!config.syncExport) return;
    writeSyncExportFile(dbPath, config.syncExport);
  } catch (err) {
    process.stderr.write(`friction-log: warning: sync-export write-through failed: ${(err as Error).message}\n`);
  }
}

function writeSyncExportFile(dbPath: string, cfg: SyncExportConfig): number {
  const db = new FrictionDb(dbPath);
  try {
    const frictions = db.listAllFrictionsForSyncExport();
    const records: ExportRecord[] = frictions.map((f) => ({ ...frictionToExport(f), tags: db.tagsFor(f.id) }));
    // Fixed key order ({ origin, records }, ExportRecord fields always built
    // in the same order by frictionToExport) and no exportedAt/timestamp
    // field: two runs with no intervening mutation produce byte-identical
    // JSON, which is exploited immediately below to skip the write (and the
    // mtime bump) entirely when nothing actually changed.
    const payload = { origin: cfg.origin, records };
    const json = JSON.stringify(payload, null, 2) + '\n';

    let existing: string | null = null;
    try {
      existing = readFileSync(cfg.path, 'utf8');
    } catch {
      existing = null;
    }
    if (existing !== json) {
      mkdirSync(dirname(cfg.path), { recursive: true });
      // Atomic write: write to a same-directory tmp file, then rename over
      // the real path, so a reader (or a sync tool) never observes a
      // partially-written file.
      const tmpPath = `${cfg.path}.tmp`;
      writeFileSync(tmpPath, json, 'utf8');
      renameSync(tmpPath, cfg.path);
    }
    return records.length;
  } finally {
    db.close();
  }
}

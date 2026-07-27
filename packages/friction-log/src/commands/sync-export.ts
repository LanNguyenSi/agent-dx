import { mkdirSync, writeFileSync } from 'node:fs';
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
 * the file — unlike the write-through helper below, silence would be
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
 * zero behavior change. Write failures are swallowed to a stderr warning
 * rather than thrown, so a broken sync-export destination (e.g. an
 * unmounted sync folder) never fails the primary mutation, whose data is
 * already safely committed to the local db by the time this runs.
 */
export function maybeSyncExport({ dbPath, config }: { dbPath: string; config: FrictionLogConfig }): void {
  if (!config.syncExport) return;
  try {
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
    // field: two runs with no intervening mutation are byte-identical.
    const payload = { origin: cfg.origin, records };
    const json = JSON.stringify(payload, null, 2) + '\n';
    mkdirSync(dirname(cfg.path), { recursive: true });
    writeFileSync(cfg.path, json, 'utf8');
    return records.length;
  } finally {
    db.close();
  }
}

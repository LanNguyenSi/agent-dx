import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from '../config.js';
import { FrictionDb, type DigestGroupBy, type DigestRow } from '../db.js';
import { defaultDbPath } from '../paths.js';
import type { ExportRecord } from './export.js';
import type { FrictionSource, FrictionStatus, Severity } from '../types.js';
import { parseAge } from './list.js';

export interface DigestCommandInput {
  groupBy: DigestGroupBy;
  last?: string;
  dbPath?: string;
  configPath?: string;
  includePeers?: boolean;
}

/**
 * One peer's contribution to `digest --include-peers`. `rows` is always
 * computed with the identical GROUP BY SQL as the local digest (see
 * buildPeerSection), so the two are directly comparable; a missing/corrupt
 * peer file degrades to an empty, error-annotated section rather than
 * throwing.
 */
export interface DigestPeerSection {
  origin: string;
  sourcePath: string;
  rows: DigestRow[];
  error?: string;
}

export interface DigestCommandOutput {
  groupBy: DigestGroupBy;
  sinceIso: string | null;
  rows: DigestRow[];
  peers?: DigestPeerSection[];
}

export function runDigest(input: DigestCommandInput): DigestCommandOutput {
  const db = new FrictionDb(input.dbPath ?? defaultDbPath());
  try {
    const sinceIso = parseAge(input.last) ?? null;
    const rows = db.digest(input.groupBy, sinceIso ?? undefined);
    const out: DigestCommandOutput = { groupBy: input.groupBy, sinceIso, rows };
    if (input.includePeers) {
      const config = loadConfig(input.configPath);
      const peerPaths = config.syncExport?.peerPaths ?? [];
      out.peers = peerPaths.map((p) => buildPeerSection(p, input.groupBy, sinceIso));
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Reads one peer's sync-export JSON (read-only; never mutates it), replays
 * its records into a throwaway :memory: FrictionDb via insertFriction, and
 * reuses db.digest() so peer numbers are computed with exactly the same SQL
 * as the local digest (same GROUP BY, same avg-hours-to-triage formula).
 * `tasks` is never populated for peer data (the export payload carries no
 * task history), so avgHoursToTriage is always null for peer rows — expected,
 * not a bug.
 *
 * recurrence_of_id is deliberately NOT copied from the peer record: friction
 * ids are per-machine AUTOINCREMENT, so a peer's numeric id is meaningless
 * (and would either dangle or point at the wrong row) once replayed into a
 * different database. insertFriction's own open-root heuristic recomputes an
 * equivalent recurrence linkage from title+toolSurface within the peer's own
 * record set instead, matching how the peer's own auto-derived recurrences
 * were computed in the first place.
 */
function buildPeerSection(peerPath: string, groupBy: DigestGroupBy, sinceIso: string | null): DigestPeerSection {
  const fallbackOrigin = basename(peerPath);
  let raw: string;
  try {
    raw = readFileSync(peerPath, 'utf8');
  } catch (err) {
    return { origin: fallbackOrigin, sourcePath: peerPath, rows: [], error: `could not read peer file: ${(err as Error).message}` };
  }
  let payload: { origin?: unknown; records?: unknown };
  try {
    payload = JSON.parse(raw) as { origin?: unknown; records?: unknown };
  } catch (err) {
    return { origin: fallbackOrigin, sourcePath: peerPath, rows: [], error: `could not parse peer file as JSON: ${(err as Error).message}` };
  }
  const origin = typeof payload.origin === 'string' && payload.origin.trim() ? payload.origin : fallbackOrigin;
  if (!Array.isArray(payload.records)) {
    return { origin, sourcePath: peerPath, rows: [], error: 'peer file is missing a "records" array' };
  }

  const scratch = new FrictionDb(':memory:');
  try {
    for (const raw of payload.records as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Partial<ExportRecord>;
      if (typeof rec.title !== 'string') continue;
      const inserted = scratch.insertFriction({
        toolSurface: typeof rec.toolSurface === 'string' ? rec.toolSurface : null,
        title: rec.title,
        description: typeof rec.description === 'string' ? rec.description : null,
        capturedAt: typeof rec.capturedAt === 'string' ? rec.capturedAt : undefined,
        severity: isSeverity(rec.severity) ? rec.severity : null,
        category: typeof rec.category === 'string' ? rec.category : null,
        source: isFrictionSource(rec.source) ? rec.source : 'import',
      });
      if (isFrictionStatus(rec.status) && rec.status !== 'open') {
        scratch.updateFrictionStatus(inserted.id, rec.status);
      }
    }
    const rows = scratch.digest(groupBy, sinceIso ?? undefined);
    return { origin, sourcePath: peerPath, rows };
  } catch (err) {
    return { origin, sourcePath: peerPath, rows: [], error: `could not replay peer records: ${(err as Error).message}` };
  } finally {
    scratch.close();
  }
}

const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high', 'critical'];
const SOURCES: readonly FrictionSource[] = ['scan', 'manual', 'import'];
const STATUSES: readonly FrictionStatus[] = ['open', 'filed', 'resolved', 'wontfix'];

function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v);
}

function isFrictionSource(v: unknown): v is FrictionSource {
  return typeof v === 'string' && (SOURCES as readonly string[]).includes(v);
}

function isFrictionStatus(v: unknown): v is FrictionStatus {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}

export function formatDigest(output: DigestCommandOutput): string {
  const { groupBy, sinceIso, rows, peers } = output;
  const window = sinceIso ? `since ${sinceIso}` : 'all-time';
  const parts: string[] = [];
  if (rows.length === 0) {
    parts.push(`digest by ${groupBy} (${window}): no frictions match`);
  } else {
    parts.push(`digest by ${groupBy} (${window})`, '', renderDigestTable(rows));
  }
  if (peers) {
    for (const peer of peers) {
      parts.push('', `peer origin=${peer.origin} (${peer.sourcePath}):`);
      if (peer.error) {
        parts.push(`  WARNING: ${peer.error}`);
      } else if (peer.rows.length === 0) {
        parts.push('  no frictions match');
      } else {
        parts.push(indent(renderDigestTable(peer.rows), '  '));
      }
    }
  }
  return parts.join('\n');
}

function renderDigestTable(rows: DigestRow[]): string {
  const header = ['group', 'total', 'open', 'filed', 'resolved', 'wontfix', 'open%', 'recurrences', 'avg-h-triage'];
  const body = rows.map((r) => [
    r.group,
    String(r.total),
    String(r.open),
    String(r.filed),
    String(r.resolved),
    String(r.wontfix),
    r.total > 0 ? `${Math.round((r.open / r.total) * 100)}%` : '-',
    String(r.recurrences),
    r.avgHoursToTriage == null ? '-' : r.avgHoursToTriage.toFixed(1),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const fmt = (row: string[]): string => row.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [fmt(header), sep, ...body.map(fmt)].join('\n');
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

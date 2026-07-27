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
 * buildPeerSection), so the two are directly comparable, except for the
 * `recurrences` column which is patched in from the raw export data (see
 * countPeerRecurrences). A missing/corrupt peer file degrades to an empty,
 * error-annotated section rather than throwing; a peer file with some
 * malformed individual records degrades those specific records only,
 * reported via `skipped`.
 */
export interface DigestPeerSection {
  origin: string;
  sourcePath: string;
  rows: DigestRow[];
  /** Count of raw entries in the peer's `records` array that failed
   * validation (missing/non-string title, unknown status, unparseable
   * capturedAt) and were dropped rather than silently miscounted. */
  skipped: number;
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

/** A peer's export record, validated and normalized to safe, typed values. */
interface NormalizedPeerRecord {
  toolSurface: string | null;
  title: string;
  description: string | null;
  capturedAt: string;
  severity: Severity | null;
  category: string | null;
  status: FrictionStatus;
  source: FrictionSource;
  recurrenceOfId: number | null;
}

/**
 * Validates one raw JSON array entry from a peer's `records`. Returns null
 * (caller counts it as `skipped`) rather than silently defaulting a bad
 * field, because a wrong default here would otherwise corrupt the digest
 * numbers without any visible sign: an unknown/missing `status` used to
 * fall through to the db's default of 'open', and a non-ISO `capturedAt`
 * used to pass a `--last` window check unpredictably (it is compared as a
 * plain string against another ISO string, and most garbage strings sort
 * after any real date).
 */
function normalizePeerRecord(raw: unknown): NormalizedPeerRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Partial<ExportRecord>;
  if (typeof rec.title !== 'string' || rec.title.trim() === '') return null;
  if (!isFrictionStatus(rec.status)) return null;
  if (typeof rec.capturedAt !== 'string' || Number.isNaN(Date.parse(rec.capturedAt))) return null;
  return {
    toolSurface: typeof rec.toolSurface === 'string' ? rec.toolSurface : null,
    title: rec.title,
    description: typeof rec.description === 'string' ? rec.description : null,
    capturedAt: rec.capturedAt,
    severity: isSeverity(rec.severity) ? rec.severity : null,
    category: typeof rec.category === 'string' ? rec.category : null,
    status: rec.status,
    // Unlike status/capturedAt/title, an invalid severity or source
    // degrades gracefully to a legitimate "unknown" value instead of
    // dropping the whole record: severity is already nullable in the
    // schema, and 'import' is a real, meaningful "unclassified" source.
    source: isFrictionSource(rec.source) ? rec.source : 'import',
    recurrenceOfId: typeof rec.recurrenceOfId === 'number' ? rec.recurrenceOfId : null,
  };
}

/**
 * Reads one peer's sync-export JSON (read-only; never mutates it), replays
 * its valid records into a throwaway :memory: FrictionDb via insertFriction,
 * and reuses db.digest() so peer totals/open/filed/resolved/wontfix/
 * avg-hours numbers are computed with exactly the same SQL as the local
 * digest. `tasks` is never populated for peer data (the export payload
 * carries no task history), so avgHoursToTriage is always null for peer
 * rows: expected, not a bug.
 *
 * `recurrences` is the one column NOT taken from the scratch db's own
 * recurrence_of_id (see countPeerRecurrences for why) and is patched onto
 * the rows afterward.
 */
function buildPeerSection(peerPath: string, groupBy: DigestGroupBy, sinceIso: string | null): DigestPeerSection {
  const fallbackOrigin = basename(peerPath);
  let raw: string;
  try {
    raw = readFileSync(peerPath, 'utf8');
  } catch (err) {
    return {
      origin: fallbackOrigin,
      sourcePath: peerPath,
      rows: [],
      skipped: 0,
      error: `could not read peer file: ${(err as Error).message}`,
    };
  }
  let payload: { origin?: unknown; records?: unknown };
  try {
    payload = JSON.parse(raw) as { origin?: unknown; records?: unknown };
  } catch (err) {
    return {
      origin: fallbackOrigin,
      sourcePath: peerPath,
      rows: [],
      skipped: 0,
      error: `could not parse peer file as JSON: ${(err as Error).message}`,
    };
  }
  const origin = typeof payload.origin === 'string' && payload.origin.trim() ? payload.origin : fallbackOrigin;
  if (!Array.isArray(payload.records)) {
    return { origin, sourcePath: peerPath, rows: [], skipped: 0, error: 'peer file is missing a "records" array' };
  }

  let skipped = 0;
  const validRecords: NormalizedPeerRecord[] = [];
  for (const rawRecord of payload.records as unknown[]) {
    const normalized = normalizePeerRecord(rawRecord);
    if (!normalized) {
      skipped++;
      continue;
    }
    validRecords.push(normalized);
  }

  const scratch = new FrictionDb(':memory:');
  try {
    for (const rec of validRecords) {
      const inserted = scratch.insertFriction({
        toolSurface: rec.toolSurface,
        title: rec.title,
        description: rec.description,
        capturedAt: rec.capturedAt,
        severity: rec.severity,
        category: rec.category,
        source: rec.source,
      });
      if (rec.status !== 'open') {
        scratch.updateFrictionStatus(inserted.id, rec.status);
      }
    }
    const rows = scratch.digest(groupBy, sinceIso ?? undefined);
    const recurrenceCounts = countPeerRecurrences(validRecords, groupBy, sinceIso);
    const withRecurrences = rows.map((r) => ({ ...r, recurrences: recurrenceCounts.get(r.group) ?? 0 }));
    return { origin, sourcePath: peerPath, rows: withRecurrences, skipped };
  } catch (err) {
    return { origin, sourcePath: peerPath, rows: [], skipped, error: `could not replay peer records: ${(err as Error).message}` };
  } finally {
    scratch.close();
  }
}

/**
 * Derives the `recurrences` count directly from the exported records' own
 * `recurrenceOfId !== null` flag, grouped exactly like db.digest()'s SQL
 * (`coalesce(column, '(unset)')`) and filtered by the same `--last` window.
 *
 * This does NOT read the scratch db's recurrence_of_id column, and
 * deliberately never re-derives or dereferences one. Two independent
 * reasons: (1) a peer's numeric recurrenceOfId is a different machine's
 * AUTOINCREMENT id, meaningless (and possibly FK-invalid) once replayed
 * into another database; (2) recomputing it via insertFriction's own
 * open-root heuristic against the replayed subset actively disagrees with
 * the origin's real bookkeeping (a friction the origin explicitly linked as
 * a recurrence can fail to re-derive as one once replayed with a different
 * insertion order or status mix, silently changing the count). Counting the
 * boolean flag from the source data sidesteps both problems.
 */
function countPeerRecurrences(
  records: NormalizedPeerRecord[],
  groupBy: DigestGroupBy,
  sinceIso: string | null
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rec of records) {
    if (sinceIso && rec.capturedAt < sinceIso) continue;
    if (rec.recurrenceOfId == null) continue;
    const group = groupValueFor(rec, groupBy);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return counts;
}

function groupValueFor(rec: NormalizedPeerRecord, groupBy: DigestGroupBy): string {
  switch (groupBy) {
    case 'tool':
      return rec.toolSurface ?? '(unset)';
    case 'category':
      return rec.category ?? '(unset)';
    case 'severity':
      return rec.severity ?? '(unset)';
    case 'source':
      return rec.source;
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
      const skippedNote = peer.skipped > 0 ? `, ${peer.skipped} record(s) skipped as malformed` : '';
      parts.push('', `peer origin=${peer.origin} (${peer.sourcePath})${skippedNote}:`);
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

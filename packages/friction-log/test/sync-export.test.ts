import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDigest, runDigest } from '../src/commands/digest.js';
import { runFile } from '../src/commands/file.js';
import { runImport } from '../src/commands/import.js';
import { runLog } from '../src/commands/log.js';
import { runRm } from '../src/commands/rm.js';
import { runScan } from '../src/commands/scan.js';
import { runSyncExport } from '../src/commands/sync-export.js';
import { runUpdate } from '../src/commands/update.js';
import { FrictionDb } from '../src/db.js';

function writeScanTranscript(path: string): void {
  writeFileSync(
    path,
    [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Exit code 1', is_error: true }],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  );
}

let tmp: string;
let dbPath: string;
let configPath: string;
let syncExportPath: string;

// loadConfig honors FRICTION_LOG_SYNC_EXPORT_PATH/_ORIGIN as overrides; clear
// them so a developer's real shell env can never leak into these tests.
const ENV_KEYS = ['FRICTION_LOG_SYNC_EXPORT_PATH', 'FRICTION_LOG_SYNC_EXPORT_ORIGIN'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'friction-log-sync-export-'));
  dbPath = join(tmp, 'db.sqlite');
  configPath = join(tmp, 'config.yml');
  syncExportPath = join(tmp, 'export', 'friction-log.json');
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function writeSyncExportConfig(extraYaml = ''): void {
  writeFileSync(
    configPath,
    `sync_export:\n  path: ${JSON.stringify(syncExportPath)}\n  origin: test-machine\n${extraYaml}`
  );
}

function readPayload(): { origin: string; records: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(syncExportPath, 'utf8')) as {
    origin: string;
    records: Array<Record<string, unknown>>;
  };
}

describe('runSyncExport', () => {
  it('throws a clear error when sync_export is not configured', () => {
    writeFileSync(configPath, 'sinks: {}\n');
    expect(() => runSyncExport({ dbPath, configPath })).toThrow(/sync_export/);
  });

  it('writes every friction with no cap (>100 rows), sorted captured_at asc with an id tiebreaker', () => {
    const db = new FrictionDb(dbPath);
    try {
      // Insert 120 frictions in reverse chronological order so ascending
      // output order is a real assertion, not an artifact of insertion order.
      for (let i = 120; i >= 1; i--) {
        db.insertFriction({
          title: `friction-${i}`,
          source: 'manual',
          capturedAt: new Date(2026, 0, 1, 0, 0, 0, i).toISOString(),
        });
      }
      // Two rows sharing the exact same captured_at to exercise the id tiebreaker.
      const tieAt = new Date(2026, 0, 2).toISOString();
      const tieA = db.insertFriction({ title: 'tie-a', source: 'manual', capturedAt: tieAt });
      const tieB = db.insertFriction({ title: 'tie-b', source: 'manual', capturedAt: tieAt });
      expect(tieA.id).toBeLessThan(tieB.id);
    } finally {
      db.close();
    }
    writeSyncExportConfig();
    const out = runSyncExport({ dbPath, configPath });
    expect(out.count).toBe(122);
    expect(out.origin).toBe('test-machine');
    const payload = readPayload();
    expect(payload.origin).toBe('test-machine');
    expect(payload.records).toHaveLength(122);
    expect(payload.records[0].title).toBe('friction-1');
    expect(payload.records[119].title).toBe('friction-120');
    expect(payload.records[120].title).toBe('tie-a');
    expect(payload.records[121].title).toBe('tie-b');
  });

  it('two runs without an intervening mutation are byte-identical', () => {
    const db = new FrictionDb(dbPath);
    try {
      db.insertFriction({ title: 'a', source: 'manual' });
      db.insertFriction({ title: 'b', source: 'manual', description: 'x' });
    } finally {
      db.close();
    }
    writeSyncExportConfig();
    runSyncExport({ dbPath, configPath });
    const first = readFileSync(syncExportPath);
    runSyncExport({ dbPath, configPath });
    const second = readFileSync(syncExportPath);
    expect(Buffer.compare(first, second)).toBe(0);
    expect(first.toString('utf8')).not.toContain('exportedAt');
  });
});

describe('write-through: maybeSyncExport wired into all 6 mutating commands', () => {
  it('log: writes sync-export after a successful log', () => {
    writeSyncExportConfig();
    const out = runLog({ title: 'wired', dbPath, configPath });
    const payload = readPayload();
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0].id).toBe(out.id);
  });

  it('log: is a no-op when sync_export is not configured', () => {
    const missingConfig = join(tmp, 'no-such-config.yml');
    runLog({ title: 'unwired', dbPath, configPath: missingConfig });
    expect(existsSync(syncExportPath)).toBe(false);
  });

  it('scan: writes sync-export after inserting scan candidates', async () => {
    writeSyncExportConfig();
    const transcript = join(tmp, 's1.jsonl');
    writeFileSync(
      transcript,
      [
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Exit code 1', is_error: true }],
          },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n'
    );
    const out = await runScan({ transcriptPath: transcript, sessionId: 's1', dbPath, configPath });
    expect(out.inserted).toBe(1);
    const payload = readPayload();
    expect(payload.records).toHaveLength(1);
  });

  it('import: writes sync-export after importing markdown files', () => {
    writeSyncExportConfig();
    const importDir = join(tmp, 'memory');
    mkdirSync(importDir, { recursive: true });
    writeFileSync(join(importDir, 'a.md'), '---\ntitle: imported friction\n---\nbody\n');
    const out = runImport({ format: 'markdown-frontmatter', path: importDir, dbPath, configPath });
    expect(out.imported).toBe(1);
    const payload = readPayload();
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0].title).toBe('imported friction');
  });

  it('update: sync-export reflects the new status', () => {
    writeSyncExportConfig();
    const logged = runLog({ title: 'to-update', dbPath, configPath });
    const out = runUpdate({ frictionId: logged.id, status: 'wontfix', dbPath, configPath });
    const payload = readPayload();
    expect(payload.records[0].status).toBe('wontfix');
    expect(out.status).toBe('wontfix');
  });

  it('rm: sync-export drops the removed friction', () => {
    writeSyncExportConfig();
    const a = runLog({ title: 'keep', dbPath, configPath });
    const b = runLog({ title: 'drop', dbPath, configPath });
    runRm({ frictionId: b.id, dbPath, configPath });
    const payload = readPayload();
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0].id).toBe(a.id);
  });

  it('file: sync-export reflects status=filed alongside the sink write', async () => {
    writeSyncExportConfig();
    const logged = runLog({ title: 'to-file', dbPath, configPath });
    const sinkDir = join(tmp, 'sink');
    await runFile({ frictionId: logged.id, sink: 'markdown-file', sinkTarget: sinkDir, dbPath, configPath });
    const payload = readPayload();
    expect(payload.records[0].status).toBe('filed');
  });

  it('is a no-op across all 6 commands when sync_export is not configured', async () => {
    const missingConfig = join(tmp, 'absent.yml');
    const logged = runLog({ title: 'a', dbPath, configPath: missingConfig });
    runUpdate({ frictionId: logged.id, status: 'open', dbPath, configPath: missingConfig });
    const importDir = join(tmp, 'memory2');
    mkdirSync(importDir, { recursive: true });
    writeFileSync(join(importDir, 'a.md'), '---\ntitle: x\n---\nbody\n');
    runImport({ format: 'markdown-frontmatter', path: importDir, dbPath, configPath: missingConfig });
    const logged2 = runLog({ title: 'b', dbPath, configPath: missingConfig });
    const sinkDir = join(tmp, 'sink2');
    await runFile({ frictionId: logged2.id, sink: 'markdown-file', sinkTarget: sinkDir, dbPath, configPath: missingConfig });
    runRm({ frictionId: logged.id, dbPath, configPath: missingConfig });
    expect(existsSync(syncExportPath)).toBe(false);
  });
});

describe('write-through hardening', () => {
  it('(HIGH regression) a config.yml with no sync_export block but otherwise malformed does not fail any mutating command', async () => {
    // Non-mapping `sinks` value: loadConfig(configPath) throws when this is
    // loaded, with a message that has nothing to do with sync_export at
    // all. Before the fix, log/scan/import/update/rm called loadConfig
    // directly at the call site (outside maybeSyncExport's try/catch),
    // AFTER their own mutation had already committed, so this would crash
    // the command with the row already written (a retry would duplicate).
    writeFileSync(configPath, 'sinks: hello\n');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => runLog({ title: 'a', dbPath, configPath })).not.toThrow();
      const logged = runLog({ title: 'b', dbPath, configPath });
      expect(() => runUpdate({ frictionId: logged.id, status: 'wontfix', dbPath, configPath })).not.toThrow();

      const importDir = join(tmp, 'memory-regression');
      mkdirSync(importDir, { recursive: true });
      writeFileSync(join(importDir, 'a.md'), '---\ntitle: imported under broken config\n---\nbody\n');
      expect(() => runImport({ format: 'markdown-frontmatter', path: importDir, dbPath, configPath })).not.toThrow();

      const transcript = join(tmp, 'regression.jsonl');
      writeScanTranscript(transcript);
      await expect(
        runScan({ transcriptPath: transcript, sessionId: 'regression', dbPath, configPath })
      ).resolves.toMatchObject({ inserted: 1 });

      const toRemove = runLog({ title: 'c', dbPath, configPath });
      expect(() => runRm({ frictionId: toRemove.id, dbPath, configPath })).not.toThrow();

      // All the mutations actually landed: a broken config degraded the
      // write-through, it did not degrade the primary command.
      const db = new FrictionDb(dbPath);
      try {
        expect(db.listFrictions({ limit: 100 }).length).toBeGreaterThanOrEqual(4);
      } finally {
        db.close();
      }
      expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('sync-export write-through failed'))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('a write failure (unwritable target directory) warns but does not throw, and the mutation is not rolled back', () => {
    const readonlyDir = join(tmp, 'readonly-target');
    mkdirSync(readonlyDir, { recursive: true });
    writeFileSync(
      configPath,
      `sync_export:\n  path: ${JSON.stringify(join(readonlyDir, 'export.json'))}\n  origin: test-machine\n`
    );
    chmodSync(readonlyDir, 0o500); // r-x: cannot create the .tmp file inside it
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = runLog({ title: 'survives write failure', dbPath, configPath });
      expect(out.id).toBeGreaterThan(0);
      const db = new FrictionDb(dbPath);
      try {
        expect(db.getFriction(out.id)?.title).toBe('survives write failure');
      } finally {
        db.close();
      }
      expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('sync-export write-through failed'))).toBe(true);
      expect(existsSync(join(readonlyDir, 'export.json.tmp'))).toBe(false);
    } finally {
      stderrSpy.mockRestore();
      chmodSync(readonlyDir, 0o700); // restore so afterEach's rmSync can clean up
    }
  });

  it('does not leave a .tmp file behind after a successful write', () => {
    writeSyncExportConfig();
    runLog({ title: 'atomic', dbPath, configPath });
    expect(existsSync(syncExportPath)).toBe(true);
    expect(existsSync(`${syncExportPath}.tmp`)).toBe(false);
  });
});

describe('digest --include-peers', () => {
  it('local rows are identical with and without the flag when peer_paths is empty', () => {
    writeSyncExportConfig();
    const db = new FrictionDb(dbPath);
    try {
      db.insertFriction({ title: 'a', toolSurface: 'tool-x', source: 'manual' });
      db.insertFriction({ title: 'b', toolSurface: 'tool-x', source: 'scan' });
    } finally {
      db.close();
    }
    const without = runDigest({ groupBy: 'tool', dbPath });
    const withFlag = runDigest({ groupBy: 'tool', dbPath, configPath, includePeers: true });
    expect(withFlag.rows).toEqual(without.rows);
    expect(withFlag.peers).toEqual([]);
  });

  it('renders a separate origin-labeled section per configured peer file, without touching local numbers', () => {
    const peerPath = join(tmp, 'peer-machine.json');
    writeFileSync(
      peerPath,
      JSON.stringify({
        origin: 'peer-machine',
        records: [
          {
            id: 1,
            sessionId: null,
            toolSurface: 'tool-y',
            title: 'peer friction',
            description: null,
            capturedAt: '2026-01-01T00:00:00.000Z',
            severity: null,
            category: null,
            status: 'open',
            recurrenceOfId: null,
            source: 'manual',
            tags: [],
          },
        ],
      })
    );
    writeSyncExportConfig(`  peer_paths:\n    - ${JSON.stringify(peerPath)}\n`);
    const db = new FrictionDb(dbPath);
    try {
      db.insertFriction({ title: 'local friction', toolSurface: 'tool-x', source: 'manual' });
    } finally {
      db.close();
    }

    const localOnly = runDigest({ groupBy: 'tool', dbPath });
    const out = runDigest({ groupBy: 'tool', dbPath, configPath, includePeers: true });
    expect(out.rows).toEqual(localOnly.rows);
    expect(out.peers).toHaveLength(1);
    expect(out.peers?.[0].origin).toBe('peer-machine');
    expect(out.peers?.[0].error).toBeUndefined();
    expect(out.peers?.[0].rows.map((r) => r.group)).toEqual(['tool-y']);
    expect(out.peers?.[0].rows[0].total).toBe(1);
    // tasks are never replayed into the peer scratch db, so this is always null.
    expect(out.peers?.[0].rows[0].avgHoursToTriage).toBeNull();

    const rendered = formatDigest(out);
    expect(rendered).toContain('peer origin=peer-machine');
    expect(rendered).toContain('tool-y');
  });

  it('degrades to a warning section instead of crashing on a missing or corrupt peer file', () => {
    const missingPeer = join(tmp, 'does-not-exist.json');
    const corruptPeer = join(tmp, 'corrupt.json');
    writeFileSync(corruptPeer, '{ not valid json');
    writeSyncExportConfig(
      `  peer_paths:\n    - ${JSON.stringify(missingPeer)}\n    - ${JSON.stringify(corruptPeer)}\n`
    );
    const out = runDigest({ groupBy: 'tool', dbPath, configPath, includePeers: true });
    expect(out.peers).toHaveLength(2);
    expect(out.peers?.[0].error).toMatch(/could not read/);
    expect(out.peers?.[1].error).toMatch(/could not parse/);
    expect(out.peers?.every((p) => p.rows.length === 0)).toBe(true);
    expect(() => formatDigest(out)).not.toThrow();
    expect(formatDigest(out)).toContain('WARNING');
  });

  it('hostile peer file: malformed records are skipped and counted, valid-but-odd fields degrade gracefully', () => {
    const peerPath = join(tmp, 'hostile-peer.json');
    writeFileSync(
      peerPath,
      JSON.stringify({
        origin: 'hostile-machine',
        records: [
          {
            title: 'valid one',
            toolSurface: 'demo-tool',
            capturedAt: '2026-01-01T00:00:00.000Z',
            status: 'open',
            severity: 'high',
            source: 'manual',
            recurrenceOfId: null,
          },
          // unknown status: must be skipped, not silently coerced to 'open'.
          {
            title: 'bad status',
            toolSurface: 'demo-tool',
            capturedAt: '2026-01-01T00:00:00.000Z',
            status: 'archived',
            severity: 'high',
            source: 'manual',
          },
          // non-string title: must be skipped.
          {
            title: 12345,
            toolSurface: 'demo-tool',
            capturedAt: '2026-01-01T00:00:00.000Z',
            status: 'open',
            severity: 'high',
            source: 'manual',
          },
          // non-ISO capturedAt: must be skipped (not silently included in
          // every --last window via string comparison).
          {
            title: 'bad date',
            toolSurface: 'demo-tool',
            capturedAt: 'not-a-date',
            status: 'open',
            severity: 'high',
            source: 'manual',
          },
          // invalid severity/source: NOT skipped, degrades to null/'import'.
          {
            title: 'coerced fields',
            toolSurface: 'demo-tool',
            capturedAt: '2026-01-02T00:00:00.000Z',
            status: 'open',
            severity: 'nonsense',
            source: 'bogus',
          },
        ],
      })
    );
    writeSyncExportConfig(`  peer_paths:\n    - ${JSON.stringify(peerPath)}\n`);
    const out = runDigest({ groupBy: 'tool', dbPath, configPath, includePeers: true });
    expect(out.peers).toHaveLength(1);
    const peer = out.peers![0];
    expect(peer.error).toBeUndefined();
    expect(peer.skipped).toBe(3);
    expect(peer.rows).toHaveLength(1);
    expect(peer.rows[0].group).toBe('demo-tool');
    expect(peer.rows[0].total).toBe(2);
    expect(peer.rows[0].open).toBe(2);

    const rendered = formatDigest(out);
    expect(rendered).toContain('3 record(s) skipped as malformed');
  });

  it('non-ISO but Date.parse-able capturedAt is normalized to ISO, not string-compared into every --last window', () => {
    // Date.parse accepts 'Jan 1 1999'; stored verbatim it would sort
    // ABOVE every ISO timestamp in the plain string compare and land a
    // 27-year-old record inside every --last window.
    const peerPath = join(tmp, 'lenient-date-peer.json');
    writeFileSync(
      peerPath,
      JSON.stringify({
        origin: 'lenient-machine',
        records: [
          {
            title: 'ancient non-iso',
            toolSurface: 'ancient-tool',
            capturedAt: 'Jan 1 1999 00:00:00 GMT',
            status: 'open',
            severity: 'high',
            source: 'manual',
            recurrenceOfId: null,
          },
          {
            title: 'recent iso',
            toolSurface: 'recent-tool',
            capturedAt: new Date().toISOString(),
            status: 'open',
            severity: 'high',
            source: 'manual',
            recurrenceOfId: null,
          },
        ],
      })
    );
    writeSyncExportConfig(`  peer_paths:\n    - ${JSON.stringify(peerPath)}\n`);
    const out = runDigest({ groupBy: 'tool', dbPath, configPath, includePeers: true, last: '7d' });
    const peer = out.peers![0];
    expect(peer.error).toBeUndefined();
    // The ancient record is valid (skipped=0) but must fall OUTSIDE the
    // 7-day window once normalized to ISO; only the recent one remains.
    expect(peer.skipped).toBe(0);
    expect(peer.rows.map((r) => r.group)).toEqual(['recent-tool']);
  });

  it('no-op runs leave the export file mtime untouched (content-compare skip)', () => {
    writeSyncExportConfig();
    const logged = runLog({ title: 'mtime probe', dbPath, configPath });
    const before = statSync(syncExportPath).mtimeMs;
    // A mutation-free re-export must compare-and-skip, not rewrite.
    runSyncExport({ dbPath, configPath });
    expect(statSync(syncExportPath).mtimeMs).toBe(before);
    // An update to the same status is a no-op mutation: no write-through.
    runUpdate({ frictionId: logged.id, status: 'open', dbPath, configPath });
    expect(statSync(syncExportPath).mtimeMs).toBe(before);
  });

  it('peer recurrence fidelity: an explicit recurrenceOfId in the export data is counted even when replay-order heuristics would miss it', () => {
    // Reproduces the reviewer's proof: record 2 is exported with
    // recurrenceOfId=1 (the origin's own bookkeeping), but by the time it
    // replays into the scratch db, record 1's status has already been
    // flipped to 'resolved', so insertFriction's own open-root heuristic
    // (which requires the root to still be 'open') would fail to re-derive
    // the link and report 0 recurrences instead of 1.
    const peerPath = join(tmp, 'recurrence-peer.json');
    writeFileSync(
      peerPath,
      JSON.stringify({
        origin: 'peer-machine',
        records: [
          {
            title: 'flaky test fails',
            toolSurface: 'ci',
            capturedAt: '2026-01-01T00:00:00.000Z',
            status: 'resolved',
            recurrenceOfId: null,
            source: 'manual',
          },
          {
            title: 'flaky test fails',
            toolSurface: 'ci',
            capturedAt: '2026-01-05T00:00:00.000Z',
            status: 'open',
            recurrenceOfId: 1,
            source: 'manual',
          },
        ],
      })
    );
    writeSyncExportConfig(`  peer_paths:\n    - ${JSON.stringify(peerPath)}\n`);
    const out = runDigest({ groupBy: 'tool', dbPath, configPath, includePeers: true });
    const peer = out.peers![0];
    expect(peer.skipped).toBe(0);
    expect(peer.rows).toHaveLength(1);
    expect(peer.rows[0].group).toBe('ci');
    expect(peer.rows[0].total).toBe(2);
    expect(peer.rows[0].recurrences).toBe(1);
  });
});

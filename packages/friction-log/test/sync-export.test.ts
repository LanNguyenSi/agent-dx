import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatDigest, runDigest } from '../src/commands/digest.js';
import { runFile } from '../src/commands/file.js';
import { runImport } from '../src/commands/import.js';
import { runLog } from '../src/commands/log.js';
import { runRm } from '../src/commands/rm.js';
import { runScan } from '../src/commands/scan.js';
import { runSyncExport } from '../src/commands/sync-export.js';
import { runUpdate } from '../src/commands/update.js';
import { FrictionDb } from '../src/db.js';

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
});

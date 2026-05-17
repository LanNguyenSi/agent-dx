import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBilanz, formatBilanz } from '../src/commands/bilanz.js';
import { runFile } from '../src/commands/file.js';
import { runLog } from '../src/commands/log.js';
import { runRm } from '../src/commands/rm.js';
import { payloadToScanInput, runScan } from '../src/commands/scan.js';
import { runUpdate } from '../src/commands/update.js';
import { FrictionDb } from '../src/db.js';

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'friction-log-m2-'));
  dbPath = join(tmp, 'db.sqlite');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: object[]): string {
  const p = join(tmp, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

describe('runScan', () => {
  it('upserts session and inserts unique candidates with source=scan', async () => {
    const transcript = writeTranscript('s1.jsonl', [
      { type: 'user', timestamp: '2026-05-17T10:00:00Z', cwd: '/x', message: { role: 'user', content: 'hi' } },
      {
        type: 'assistant',
        timestamp: '2026-05-17T10:01:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }],
        },
      },
      {
        type: 'user',
        timestamp: '2026-05-17T10:01:02Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Exit code 2\nboom', is_error: true }],
        },
      },
    ]);

    const out = await runScan({ transcriptPath: transcript, sessionId: 's1', dbPath });
    expect(out.candidatesFound).toBe(1);
    expect(out.inserted).toBe(1);
    expect(out.skippedDuplicates).toBe(0);

    const db = new FrictionDb(dbPath);
    try {
      const session = db.getSession('s1');
      expect(session?.transcriptPath).toBe(transcript);
      expect(session?.adapter).toBe('claude-code');
      const frictions = db.listFrictionsForSession('s1');
      expect(frictions).toHaveLength(1);
      expect(frictions[0].source).toBe('scan');
      expect(frictions[0].title).toBe('Bash exited with code 2');
    } finally {
      db.close();
    }
  });

  it('is idempotent: re-running scan skips duplicates', async () => {
    const transcript = writeTranscript('s2.jsonl', [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Exit code 1', is_error: true }] },
      },
    ]);

    const first = await runScan({ transcriptPath: transcript, sessionId: 's2', dbPath });
    expect(first.inserted).toBe(1);
    const second = await runScan({ transcriptPath: transcript, sessionId: 's2', dbPath });
    expect(second.inserted).toBe(0);
    expect(second.skippedDuplicates).toBe(1);
  });
});

describe('payloadToScanInput', () => {
  it('honors snake_case keys', () => {
    expect(payloadToScanInput({ session_id: 's', transcript_path: '/p' })).toEqual({
      sessionId: 's',
      transcriptPath: '/p',
      adapter: undefined,
    });
  });
  it('honors camelCase keys', () => {
    expect(payloadToScanInput({ sessionId: 's', transcriptPath: '/p' })).toEqual({
      sessionId: 's',
      transcriptPath: '/p',
      adapter: undefined,
    });
  });
});

describe('runBilanz', () => {
  it('formats a session with frictions and filed tasks', async () => {
    const transcript = writeTranscript('s3.jsonl', [
      { type: 'user', timestamp: '2026-05-17T10:00:00Z', cwd: '/x', message: { role: 'user', content: 'hi' } },
      {
        type: 'assistant',
        timestamp: '2026-05-17T10:01:00Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
      },
      {
        type: 'user',
        timestamp: '2026-05-17T10:01:02Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Exit code 1', is_error: true }] },
      },
    ]);
    await runScan({ transcriptPath: transcript, sessionId: 's3', dbPath });
    const frictions = (() => {
      const db = new FrictionDb(dbPath);
      try {
        return db.listFrictionsForSession('s3');
      } finally {
        db.close();
      }
    })();
    const sinkDir = join(tmp, 'sink');
    await runFile({ frictionId: frictions[0].id, sinkTarget: sinkDir, dbPath });

    const out = await runBilanz({ sessionId: 's3', dbPath });
    expect(out.session.id).toBe('s3');
    expect(out.formatted).toContain('Dogfood bilanz');
    expect(out.formatted).toContain('Tools exercised');
    expect(out.formatted).toContain('bash');
    expect(out.formatted).toContain('Frictions noticed');
    expect(out.formatted).toContain('Bash exited');
    expect(out.formatted).toContain('Tasks filed');
    expect(out.formatted).toContain('markdown-file');
  });

  it('highlights frictions without a filed task', async () => {
    const transcript = writeTranscript('s4.jsonl', [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Exit code 1', is_error: true }] },
      },
    ]);
    await runScan({ transcriptPath: transcript, sessionId: 's4', dbPath });
    const out = await runBilanz({ sessionId: 's4', dbPath });
    expect(out.formatted).toContain('Open frictions without a filed task');
    expect(out.formatted).toContain('friction-log file <id>');
  });

  it('throws when the requested session is not in the db', async () => {
    await expect(runBilanz({ sessionId: 'nope', dbPath })).rejects.toThrow(/not found/);
  });

  it('throws when no sessions exist and no id given', async () => {
    await expect(runBilanz({ dbPath })).rejects.toThrow(/no sessions/);
  });
});

describe('runRm', () => {
  it('removes a friction and any task rows pointing at it', async () => {
    const f = runLog({ title: 'tmp', dbPath });
    const sinkDir = join(tmp, 'sink');
    await runFile({ frictionId: f.id, sinkTarget: sinkDir, dbPath });
    const out = runRm({ frictionId: f.id, dbPath });
    expect(out.removed).toBe(true);
    const db = new FrictionDb(dbPath);
    try {
      expect(db.getFriction(f.id)).toBeNull();
      expect(db.listTasksForFriction(f.id)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('throws on missing friction', () => {
    expect(() => runRm({ frictionId: 9999, dbPath })).toThrow(/not found/);
  });
});

describe('runUpdate', () => {
  it('changes status', () => {
    const f = runLog({ title: 'tmp', dbPath });
    const out = runUpdate({ frictionId: f.id, status: 'wontfix', dbPath });
    expect(out.status).toBe('wontfix');
    const db = new FrictionDb(dbPath);
    try {
      expect(db.getFriction(f.id)?.status).toBe('wontfix');
    } finally {
      db.close();
    }
  });

  it('throws on missing friction', () => {
    expect(() => runUpdate({ frictionId: 9999, status: 'open', dbPath })).toThrow(/not found/);
  });
});

describe('formatBilanz', () => {
  it('handles the empty case gracefully', () => {
    const txt = formatBilanz({
      session: {
        id: 's',
        startedAt: '2026-05-17T10:00:00Z',
        endedAt: null,
        projectPaths: null,
        transcriptPath: null,
        adapter: 'claude-code',
      },
      toolsExercised: [],
      frictions: [],
    });
    expect(txt).toContain('Dogfood bilanz');
    expect(txt).toContain('_none captured');
    expect(txt).toContain('_none recorded');
    expect(txt).toContain('_none yet_');
  });
});

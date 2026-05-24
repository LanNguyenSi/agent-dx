import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrictionDb } from '../src/db.js';
import { runFile } from '../src/commands/file.js';
import { runList, parseAge, formatTable } from '../src/commands/list.js';
import { runLog } from '../src/commands/log.js';

let tmp: string;
let dbPath: string;
let sinkDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'friction-log-cmd-'));
  dbPath = join(tmp, 'db.sqlite');
  sinkDir = join(tmp, 'sink');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('runLog', () => {
  it('persists a manual friction and returns the new id', () => {
    const out = runLog({ title: 'something broke', tool: 'foo', dbPath });
    expect(out.id).toBeGreaterThan(0);
    const db = new FrictionDb(dbPath);
    try {
      const f = db.getFriction(out.id);
      expect(f?.source).toBe('manual');
      expect(f?.toolSurface).toBe('foo');
    } finally {
      db.close();
    }
  });

  it('upserts a sessions row for an unknown --session id so the FK never fires', () => {
    // Pre-task-a44a7f53 repro: passing a fresh session id (e.g. the live
    // $CLAUDE_CODE_SESSION_ID from inside an agent shell) blew up with
    // `friction-log: FOREIGN KEY constraint failed` because
    // frictions.session_id references sessions(id) and the row was
    // never created. runLog now ensures the row exists before insert.
    const freshSessionId = '2019227f-ce4e-4142-879c-6628d3efbd2a';
    const out = runLog({
      title: 'live-session friction',
      sessionId: freshSessionId,
      dbPath,
    });
    expect(out.id).toBeGreaterThan(0);
    const db = new FrictionDb(dbPath);
    try {
      const f = db.getFriction(out.id);
      expect(f?.sessionId).toBe(freshSessionId);
      // The session placeholder row was created with adapter='manual'
      // (mirrors frictions.source='manual' for log-path rows).
      const s = db.getSession(freshSessionId);
      expect(s?.id).toBe(freshSessionId);
      expect(s?.adapter).toBe('manual');
      expect(s?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      db.close();
    }
  });

  it('preserves a pre-existing session row instead of clobbering it (INSERT OR IGNORE)', () => {
    // If a session was already imported with full metadata (adapter:
    // 'claude-code', project_paths, transcript_path), a subsequent
    // `friction-log log --session <same-id>` must not downgrade those
    // fields to the log-path placeholder defaults.
    const sessionId = 'aaaa1111-bbbb-2222-cccc-333344445555';
    const importedAt = '2026-05-01T08:00:00.000Z';
    {
      const db = new FrictionDb(dbPath);
      try {
        db.upsertSession({
          id: sessionId,
          startedAt: importedAt,
          endedAt: null,
          projectPaths: ['/home/lan/git/pandora/harness'],
          transcriptPath: '/transcripts/foo.jsonl',
          adapter: 'claude-code',
        });
      } finally {
        db.close();
      }
    }
    runLog({ title: 'something else', sessionId, dbPath });
    const db = new FrictionDb(dbPath);
    try {
      const s = db.getSession(sessionId);
      expect(s?.adapter).toBe('claude-code');
      expect(s?.startedAt).toBe(importedAt);
      expect(s?.transcriptPath).toBe('/transcripts/foo.jsonl');
    } finally {
      db.close();
    }
  });

  it('does not create a sessions row when --session is omitted or empty', () => {
    // Backwards-compatible: the original sessionless path must not
    // silently populate the sessions table with anonymous rows. Empty
    // string is treated as omitted too.
    const out1 = runLog({ title: 'no-session friction', dbPath });
    const out2 = runLog({ title: 'empty-string-session', sessionId: '', dbPath });
    const db = new FrictionDb(dbPath);
    try {
      expect(db.getFriction(out1.id)?.sessionId).toBeNull();
      expect(db.getFriction(out2.id)?.sessionId).toBeNull();
      // The all-sessions accessor stays empty; no anonymous placeholder
      // rows leaked through.
      expect(db.getMostRecentSession()).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('runList', () => {
  it('returns inserted frictions, newest first', () => {
    runLog({ title: 'first', dbPath });
    runLog({ title: 'second', dbPath });
    const out = runList({ dbPath });
    expect(out.frictions).toHaveLength(2);
    expect(out.frictions[0].title).toBe('second');
  });

  it('filters by status', () => {
    runLog({ title: 'a', dbPath });
    const out = runList({ status: 'filed', dbPath });
    expect(out.frictions).toHaveLength(0);
  });
});

describe('parseAge', () => {
  it('parses days, weeks, hours', () => {
    const now = new Date('2026-05-17T12:00:00Z');
    expect(parseAge('1d', now)).toBe('2026-05-16T12:00:00.000Z');
    expect(parseAge('2w', now)).toBe('2026-05-03T12:00:00.000Z');
    expect(parseAge('6h', now)).toBe('2026-05-17T06:00:00.000Z');
  });

  it('rejects bad input', () => {
    expect(() => parseAge('garbage')).toThrow(/invalid --age/);
  });

  it('passes undefined through', () => {
    expect(parseAge(undefined)).toBeUndefined();
  });
});

describe('formatTable', () => {
  it('formats the empty case', () => {
    expect(formatTable([])).toBe('(no frictions match)');
  });
});

describe('runFile', () => {
  it('writes a markdown file and records a task row, status transitions to filed', async () => {
    const logged = runLog({
      title: 'tasks_list overflows context',
      tool: 'mcp:agent-tasks/tasks_list',
      category: 'output-overflow',
      severity: 'high',
      dbPath,
    });

    const out = await runFile({
      frictionId: logged.id,
      sink: 'markdown-file',
      sinkTarget: sinkDir,
      dbPath,
    });

    expect(out.sinkName).toBe('markdown-file');
    expect(out.sinkTarget.startsWith(sinkDir)).toBe(true);
    const content = readFileSync(out.sinkTarget, 'utf8');
    expect(content).toContain('mcp:agent-tasks/tasks_list');
    expect(content).toContain('priority: HIGH');

    const db = new FrictionDb(dbPath);
    try {
      const f = db.getFriction(logged.id);
      expect(f?.status).toBe('filed');
      const tasks = db.listTasksForFriction(logged.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].sinkTarget).toBe(out.sinkTarget);
    } finally {
      db.close();
    }
  });

  it('throws on missing friction', async () => {
    await expect(runFile({ frictionId: 9999, dbPath })).rejects.toThrow(/not found/);
  });

  it('throws on unknown sink', async () => {
    const logged = runLog({ title: 't', dbPath });
    await expect(
      runFile({ frictionId: logged.id, sink: 'does-not-exist', dbPath })
    ).rejects.toThrow(/unknown sink/);
  });
});

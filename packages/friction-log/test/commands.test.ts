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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, mergeSinkOpts, parseSinkOpts } from '../src/config.js';
import { runFile } from '../src/commands/file.js';
import { runLog } from '../src/commands/log.js';
import { availableSinks, loadSink, registerSinkFactory } from '../src/sinks/index.js';
import { AgentTasksSink } from '../src/sinks/agent-tasks.js';
import { GithubIssuesSink } from '../src/sinks/github-issues.js';
import { LinearSink } from '../src/sinks/linear.js';
import { StdoutJsonSink } from '../src/sinks/stdout-json.js';
import type { Friction, RenderedTemplate } from '../src/types.js';

let workDir: string;
let dbPath: string;
let configPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'friction-log-m4-'));
  dbPath = join(workDir, 'db.sqlite');
  configPath = join(workDir, 'config.yml');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const fakeFriction: Friction = {
  id: 42,
  sessionId: 'sess',
  toolSurface: 'mcp:foo/bar',
  title: 'something broke',
  description: 'longer description',
  capturedAt: '2026-05-18T10:00:00.000Z',
  severity: 'high',
  category: 'tool-error',
  status: 'open',
  recurrenceOfId: null,
  source: 'manual',
};

const fakeRendered: RenderedTemplate = {
  title: 'something broke',
  body: 'a body',
  labels: ['friction', 'agent-dx'],
  priority: 'MEDIUM',
};

describe('config loader', () => {
  it('returns an empty config when the file is missing', () => {
    expect(loadConfig(configPath)).toEqual({ sinks: {} });
  });

  it('reads sinks.* mappings from YAML', () => {
    writeFileSync(
      configPath,
      'sinks:\n  github-issues:\n    repo: o/r\n    labels: [bug, friction]\n'
    );
    const cfg = loadConfig(configPath);
    expect(cfg.sinks['github-issues']).toEqual({ repo: 'o/r', labels: ['bug', 'friction'] });
  });

  it('throws on YAML at top level that is not a mapping', () => {
    writeFileSync(configPath, '- a\n- b\n');
    expect(() => loadConfig(configPath)).toThrow(/mapping at the top level/);
  });

  it('throws on a non-mapping sinks value', () => {
    writeFileSync(configPath, 'sinks: hello\n');
    expect(() => loadConfig(configPath)).toThrow(/non-mapping "sinks"/);
  });
});

describe('mergeSinkOpts + parseSinkOpts', () => {
  it('CLI overrides win over config defaults', () => {
    const merged = mergeSinkOpts({ repo: 'a/b', extra: 1 }, { repo: 'c/d' });
    expect(merged).toEqual({ repo: 'c/d', extra: 1 });
  });

  it('coerces key=value pairs through cheap heuristics', () => {
    const out = parseSinkOpts(['repo=o/r', 'labels=bug,friction', 'count=3', 'flag=true', 'note=s:literal,1,2']);
    expect(out).toEqual({
      repo: 'o/r',
      labels: ['bug', 'friction'],
      count: 3,
      flag: true,
      note: 'literal,1,2',
    });
  });

  it('rejects malformed pairs', () => {
    expect(() => parseSinkOpts(['no-equals'])).toThrow(/key=value/);
  });
});

describe('sink registry', () => {
  it('exposes all five sink names', () => {
    expect([...availableSinks].sort()).toEqual(
      ['agent-tasks', 'github-issues', 'linear', 'markdown-file', 'stdout-json'].sort()
    );
  });

  it('lazy-loads modules on first request and caches via factory swap', async () => {
    const fake = { name: 'agent-tasks', file: vi.fn(async () => ({ ok: true, sinkTarget: 'stub' })) };
    const restore = registerSinkFactory('agent-tasks', async () => fake as unknown as InstanceType<typeof AgentTasksSink>);
    try {
      const sink = await loadSink('agent-tasks');
      expect(sink).toBe(fake);
    } finally {
      restore();
    }
  });

  it('rejects unknown sink names', async () => {
    await expect(loadSink('whatever')).rejects.toThrow(/unknown sink/);
  });
});

describe('stdout-json sink', () => {
  it('writes a single JSON line with friction + rendered fields', async () => {
    const lines: string[] = [];
    const sink = new StdoutJsonSink((line) => lines.push(line));
    const result = await sink.file(fakeFriction, fakeRendered, {});
    expect(result.ok).toBe(true);
    expect(result.sinkTarget).toBe('stdout');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.sink).toBe('stdout-json');
    expect((parsed.friction as Record<string, unknown>).id).toBe(42);
    expect((parsed.rendered as Record<string, unknown>).body).toBe('a body');
  });
});

describe('github-issues sink', () => {
  it('builds gh args from sinkOpts + rendered labels, passes body on stdin', async () => {
    const runner = vi.fn(() => ({
      status: 0,
      signal: null,
      output: [],
      pid: 0,
      stdout: 'https://github.com/o/r/issues/123\n',
      stderr: '',
    } as never));
    const sink = new GithubIssuesSink(runner as never);
    const result = await sink.file(fakeFriction, fakeRendered, {
      sinkOpts: { repo: 'o/r', labels: ['bug'], assignee: 'lavaclawdbot' },
    });
    expect(runner).toHaveBeenCalledTimes(1);
    const firstCall = runner.mock.calls[0] as unknown as [string[], string];
    const callArgs = firstCall[0];
    const callInput = firstCall[1];
    expect(callArgs).toEqual([
      'issue',
      'create',
      '--repo',
      'o/r',
      '--title',
      'something broke',
      '--body-file',
      '-',
      '--label',
      'bug',
      '--label',
      'friction',
      '--label',
      'agent-dx',
      '--assignee',
      'lavaclawdbot',
    ]);
    expect(callInput).toContain('a body');
    expect(callInput).toContain('friction-log id 42');
    expect(result.externalRef).toBe('https://github.com/o/r/issues/123');
    expect(result.sinkTarget).toBe('o/r');
  });

  it('throws a friendly error when "repo" is missing', async () => {
    const sink = new GithubIssuesSink(((() => {
      throw new Error('runner should not have been called');
    }) as never));
    await expect(sink.file(fakeFriction, fakeRendered, { sinkOpts: {} })).rejects.toThrow(/requires "repo"/);
  });

  it('surfaces gh stderr when it exits non-zero', async () => {
    const runner = vi.fn(() => ({
      status: 1,
      signal: null,
      output: [],
      pid: 0,
      stdout: '',
      stderr: 'gh: bad credentials\n',
    } as never));
    const sink = new GithubIssuesSink(runner as never);
    await expect(
      sink.file(fakeFriction, fakeRendered, { sinkOpts: { repo: 'o/r' } })
    ).rejects.toThrow(/gh issue create failed.*bad credentials/);
  });
});

describe('agent-tasks sink', () => {
  it('emits an MCP intent JSON when mode=mcp-emit, no network call', async () => {
    const lines: string[] = [];
    const fetchSpy = vi.fn(async () => new Response('', { status: 500 }));
    const sink = new AgentTasksSink(fetchSpy, (line) => lines.push(line));
    const result = await sink.file(fakeFriction, fakeRendered, {
      sinkOpts: { mode: 'mcp-emit', projectId: 'proj-uuid' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    const intent = JSON.parse(lines[0]) as { tool: string; params: { projectId: string; title: string } };
    expect(intent.tool).toBe('mcp__agent-tasks__task_create');
    expect(intent.params.projectId).toBe('proj-uuid');
    expect(intent.params.title).toBe('something broke');
    expect(result.message).toContain('MCP task_create intent');
    expect(result.sinkTarget).toContain('mcp-emit');
  });

  it('POSTs to the REST endpoint with bearer auth and returns the new task id', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ task: { id: 'task-uuid-1' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );
    const sink = new AgentTasksSink(fetchSpy, () => {});
    const result = await sink.file(fakeFriction, fakeRendered, {
      sinkOpts: {
        mode: 'rest',
        projectId: 'proj-uuid',
        apiBase: 'https://api.example.test',
        token: 'TOKEN',
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const restCall = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(restCall[0]).toBe('https://api.example.test/api/projects/proj-uuid/tasks');
    expect((restCall[1].headers as Record<string, string>).authorization).toBe('Bearer TOKEN');
    const body = JSON.parse((restCall[1].body as string)) as { title: string; priority: string };
    expect(body.title).toBe('something broke');
    expect(body.priority).toBe('MEDIUM');
    expect(result.externalRef).toBe('task-uuid-1');
  });

  it('rejects without projectId regardless of mode', async () => {
    const sink = new AgentTasksSink(vi.fn(), () => {});
    await expect(
      sink.file(fakeFriction, fakeRendered, { sinkOpts: { mode: 'rest', apiBase: 'x', token: 'y' } })
    ).rejects.toThrow(/requires "projectId"/);
  });

  it('rejects an unknown mode rather than silently defaulting to rest', async () => {
    const sink = new AgentTasksSink(vi.fn(), () => {});
    await expect(
      sink.file(fakeFriction, fakeRendered, { sinkOpts: { mode: 'rst', projectId: 'p' } })
    ).rejects.toThrow(/"mode" must be "rest" or "mcp-emit"/);
  });

  it('surfaces REST error bodies on non-2xx', async () => {
    const fetchSpy = vi.fn(async () => new Response('upstream said no', { status: 502 }));
    const sink = new AgentTasksSink(fetchSpy, () => {});
    await expect(
      sink.file(fakeFriction, fakeRendered, {
        sinkOpts: { mode: 'rest', projectId: 'p', apiBase: 'https://x.test', token: 'T' },
      })
    ).rejects.toThrow(/returned 502.*upstream said no/);
  });
});

describe('linear sink', () => {
  it('skips the state lookup when no state is given and posts a minimal issueCreate', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { issueCreate: { success: true, issue: { id: 'iid', identifier: 'TEAM-1', url: 'https://linear.app/.../TEAM-1' } } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const sink = new LinearSink(fetchSpy);
    const result = await sink.file(fakeFriction, fakeRendered, {
      sinkOpts: { teamId: 'team-uuid', apiKey: 'lin_xxx' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const linearCall = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse((linearCall[1].body as string)) as { query: string; variables: { input: Record<string, unknown> } };
    expect(body.query).toContain('issueCreate');
    expect(body.variables.input.teamId).toBe('team-uuid');
    expect(body.variables.input.stateId).toBeUndefined();
    expect(result.externalRef).toBe('https://linear.app/.../TEAM-1');
  });

  it('resolves a named state via a workflow-states lookup, then posts with stateId', async () => {
    const fetchSpy = vi.fn(async (_url, init) => {
      const body = JSON.parse((init.body as string)) as { query: string };
      if (body.query.includes('WorkflowStates')) {
        return new Response(
          JSON.stringify({
            data: { team: { states: { nodes: [{ id: 'state-1', name: 'Backlog' }, { id: 'state-2', name: 'In Progress' }] } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          data: { issueCreate: { success: true, issue: { id: 'iid', identifier: 'TEAM-7', url: 'https://linear.app/x/TEAM-7' } } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const sink = new LinearSink(fetchSpy);
    await sink.file(fakeFriction, fakeRendered, {
      sinkOpts: { teamId: 'team-uuid', state: 'backlog', apiKey: 'k' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const createCall = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
    const createBody = JSON.parse((createCall[1].body as string)) as { variables: { input: Record<string, unknown> } };
    expect(createBody.variables.input.stateId).toBe('state-1');
  });

  it('fails fast when LINEAR_API_KEY is not set and no apiKey opt provided', async () => {
    const previous = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      const sink = new LinearSink(vi.fn());
      await expect(
        sink.file(fakeFriction, fakeRendered, { sinkOpts: { teamId: 't' } })
      ).rejects.toThrow(/requires an API key/);
    } finally {
      if (previous !== undefined) process.env.LINEAR_API_KEY = previous;
    }
  });

  it('skips the workflow-states lookup when state is already a UUID', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { issueCreate: { success: true, issue: { id: 'i', identifier: 'TEAM-2', url: 'https://linear.app/x/TEAM-2' } } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const sink = new LinearSink(fetchSpy);
    await sink.file(fakeFriction, fakeRendered, {
      sinkOpts: { teamId: 't', state: '01234567-1234-1234-1234-123456789abc', apiKey: 'k' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const onlyCall = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse((onlyCall[1].body as string)) as { variables: { input: Record<string, unknown> } };
    expect(body.variables.input.stateId).toBe('01234567-1234-1234-1234-123456789abc');
  });

  it('surfaces a named state that does not exist on the team', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { team: { states: { nodes: [{ id: 's', name: 'Done' }] } } } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const sink = new LinearSink(fetchSpy);
    await expect(
      sink.file(fakeFriction, fakeRendered, { sinkOpts: { teamId: 't', state: 'Backlog', apiKey: 'k' } })
    ).rejects.toThrow(/no state matching "Backlog"/);
  });
});

describe('runFile integration with widened sinkOpts', () => {
  it('merges config-file defaults with CLI overrides and routes to the sink', async () => {
    writeFileSync(
      configPath,
      'sinks:\n  stdout-json: {}\n  github-issues:\n    repo: from-config/repo\n'
    );
    const stdoutLines: string[] = [];
    const restore = registerSinkFactory(
      'stdout-json',
      async () => new StdoutJsonSink((line) => stdoutLines.push(line))
    );
    try {
      const logged = runLog({ title: 'wired-through', dbPath });
      const out = await runFile({
        frictionId: logged.id,
        sink: 'stdout-json',
        configPath,
        dbPath,
      });
      expect(out.sinkName).toBe('stdout-json');
      expect(stdoutLines).toHaveLength(1);
      expect(JSON.parse(stdoutLines[0])).toMatchObject({ sink: 'stdout-json' });
    } finally {
      restore();
    }
  });

  it('CLI --sink-opt key=value wins over config defaults inside runFile', async () => {
    writeFileSync(configPath, 'sinks:\n  github-issues:\n    repo: config-default/repo\n');
    const seen: Array<{ args: string[]; input: string }> = [];
    const fakeRunner = vi.fn((args: string[], input: string) => {
      seen.push({ args, input });
      return {
        status: 0,
        signal: null,
        output: [],
        pid: 0,
        stdout: 'https://github.com/cli-override/repo/issues/9\n',
        stderr: '',
      } as never;
    });
    const restore = registerSinkFactory(
      'github-issues',
      async () => new GithubIssuesSink(fakeRunner as never)
    );
    try {
      const logged = runLog({ title: 'override', dbPath });
      const out = await runFile({
        frictionId: logged.id,
        sink: 'github-issues',
        sinkOpts: { repo: 'cli-override/repo' },
        configPath,
        dbPath,
      });
      expect(out.externalRef).toBe('https://github.com/cli-override/repo/issues/9');
      const repoArgIdx = seen[0].args.indexOf('--repo');
      expect(seen[0].args[repoArgIdx + 1]).toBe('cli-override/repo');
    } finally {
      restore();
    }
  });
});

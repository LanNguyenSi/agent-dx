import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/scanners/claude-code.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'friction-log-scanner-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: object[]): string {
  const p = join(tmp, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

describe('ClaudeCodeAdapter', () => {
  it('parses session bounds and cwds from message timestamps', async () => {
    const path = writeTranscript('s1.jsonl', [
      { type: 'permission-mode', sessionId: 's1' },
      { type: 'user', timestamp: '2026-05-17T10:00:00Z', cwd: '/x', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', timestamp: '2026-05-17T10:05:00Z', cwd: '/x', message: { role: 'assistant', content: 'hello' } },
    ]);
    const out = await new ClaudeCodeAdapter().scan({ transcriptPath: path });
    expect(out.session.id).toBe('s1');
    expect(out.session.startedAt).toBe('2026-05-17T10:00:00Z');
    expect(out.session.endedAt).toBe('2026-05-17T10:05:00Z');
    expect(out.session.projectPaths).toEqual(['/x']);
    expect(out.session.transcriptPath).toBe(path);
  });

  it('extracts a tool-error candidate from is_error tool_result', async () => {
    const path = writeTranscript('s2.jsonl', [
      {
        type: 'assistant',
        timestamp: '2026-05-17T10:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'false' } }],
        },
      },
      {
        type: 'user',
        timestamp: '2026-05-17T10:00:01Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Exit code 1\nsome stderr', is_error: true }],
        },
      },
    ]);
    const out = await new ClaudeCodeAdapter().scan({ transcriptPath: path, sessionId: 's2' });
    expect(out.frictionCandidates).toHaveLength(1);
    const c = out.frictionCandidates[0];
    expect(c.toolSurface).toBe('bash');
    expect(c.title).toBe('Bash exited with code 1');
    expect(c.category).toBe('tool-error');
    expect(c.severity).toBe('medium');
  });

  it('extracts an MCP tool-error candidate with the tool name as surface', async () => {
    const path = writeTranscript('s3.jsonl', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__agent-tasks__tasks_list', input: {} }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Backend returned 500', is_error: true }],
        },
      },
    ]);
    const out = await new ClaudeCodeAdapter().scan({ transcriptPath: path, sessionId: 's3' });
    expect(out.frictionCandidates).toHaveLength(1);
    expect(out.frictionCandidates[0].toolSurface).toBe('mcp__agent-tasks__tasks_list');
    expect(out.frictionCandidates[0].title).toContain('returned an error');
  });

  it('extracts a friction-phrase candidate from a short assistant paragraph', async () => {
    const path = writeTranscript('s4.jsonl', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Funktioniert nicht, der gate blockt wieder.',
            },
          ],
        },
      },
    ]);
    const out = await new ClaudeCodeAdapter().scan({ transcriptPath: path, sessionId: 's4' });
    const phraseCandidate = out.frictionCandidates.find((c) => c.category === 'workflow-friction');
    expect(phraseCandidate).toBeDefined();
    expect(phraseCandidate?.toolSurface).toBeNull();
    expect(phraseCandidate?.severity).toBe('low');
  });

  it('ignores a friction-phrase that appears in a long paragraph (likely analysis, not admission)', async () => {
    const longProse = 'This is a very long paragraph that mentions doesn\'t work but only as part of a much longer analysis. '.repeat(5);
    const path = writeTranscript('s5.jsonl', [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: longProse }] },
      },
    ]);
    const out = await new ClaudeCodeAdapter().scan({ transcriptPath: path, sessionId: 's5' });
    expect(out.frictionCandidates).toHaveLength(0);
  });

  it('ignores a friction-phrase that appears in a question', async () => {
    const path = writeTranscript('s6.jsonl', [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Does this not work for you?' }] },
      },
    ]);
    const out = await new ClaudeCodeAdapter().scan({ transcriptPath: path, sessionId: 's6' });
    expect(out.frictionCandidates).toHaveLength(0);
  });

  it('dedupes identical candidates within one scan', async () => {
    const path = writeTranscript('s7.jsonl', [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Exit code 1', is_error: true }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: {} }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'Exit code 1', is_error: true }] },
      },
    ]);
    const out = await new ClaudeCodeAdapter().scan({ transcriptPath: path, sessionId: 's7' });
    expect(out.frictionCandidates).toHaveLength(1);
  });

  it('survives malformed JSONL lines without throwing', async () => {
    const path = writeTranscript('s8.jsonl', [{ type: 'user', message: { role: 'user', content: 'ok' } }]);
    writeFileSync(path, '{not json}\n' + 'partial line', { flag: 'a', encoding: 'utf8' });
    const out = await new ClaudeCodeAdapter().scan({ transcriptPath: path, sessionId: 's8' });
    expect(out.frictionCandidates).toHaveLength(0);
    expect(out.session.id).toBe('s8');
  });

  it('throws when transcript path is missing', async () => {
    await expect(new ClaudeCodeAdapter().scan({})).rejects.toThrow(/requires --transcript/);
  });

  it('throws when transcript file does not exist', async () => {
    await expect(
      new ClaudeCodeAdapter().scan({ transcriptPath: join(tmp, 'nope.jsonl') })
    ).rejects.toThrow(/not found/);
  });
});

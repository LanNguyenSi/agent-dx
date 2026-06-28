import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatISO, subDays } from 'date-fns';
import { registerStandupCommands } from '../commands/standup.js';

vi.mock('../github.js', () => ({
  getOctokit: vi.fn(),
  parseRepo: vi.fn(),
  withRetry: vi.fn(),
}));

vi.mock('../utils/output.js', () => ({
  output: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { getOctokit, withRetry } from '../github.js';
import { output, error as outputError } from '../utils/output.js';

function makeProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerStandupCommands(p);
  return p;
}

const makeCommit = (sha = 'abc1234567', msg = 'fix: bug', date = '2024-01-01T10:00:00Z') => ({
  sha,
  commit: { author: { name: 'Alice', date }, message: `${msg}\n\nmore details` },
  html_url: `https://gh/c/${sha}`,
});

describe('standup — with explicit repos', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockOctokit = {
      rest: {
        repos: {
          listCommits: vi.fn().mockResolvedValue({ data: [makeCommit()] }),
        },
      },
    };
    vi.mocked(getOctokit).mockResolvedValue(mockOctokit as never);
    vi.mocked(withRetry).mockImplementation(<T>(fn: () => Promise<T>) => fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('passes the --since date boundary to the API with days=1', async () => {
    const frozenNow = new Date('2024-06-15T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(frozenNow);

    // Keep a direct reference to the spy
    const listCommitsSpy = vi.fn().mockResolvedValue({ data: [makeCommit()] });
    const octokit = { rest: { repos: { listCommits: listCommitsSpy } } };
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'standup', '--owner', 'o', '--repos', 'repo1', '--days', '1',
    ]);

    const call = listCommitsSpy.mock.calls[0]?.[0] as { since: string } | undefined;
    expect(call?.since).toBe(formatISO(subDays(frozenNow, 1)));

    vi.useRealTimers();
  });

  it('passes the --since date boundary correctly for days=7 (off-by-one check)', async () => {
    const frozenNow = new Date('2024-06-15T08:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(frozenNow);

    const listCommitsSpy = vi.fn().mockResolvedValue({ data: [makeCommit()] });
    const octokit = { rest: { repos: { listCommits: listCommitsSpy } } };
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'standup', '--owner', 'o', '--repos', 'repo1', '--days', '7',
    ]);

    const call = listCommitsSpy.mock.calls[0]?.[0] as { since: string } | undefined;
    expect(call?.since).toBe(formatISO(subDays(frozenNow, 7)));

    vi.useRealTimers();
  });

  it('shows commit details in human-readable output', async () => {
    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'standup', '--owner', 'o', '--repos', 'my-repo',
    ]);

    const logged = consoleSpy.mock.calls.flat().join('\n');
    expect(logged).toContain('my-repo');
    expect(logged).toContain('abc1234'); // sha truncated to 7
    expect(logged).toContain('fix: bug'); // first line only
  });

  it('shows "No commits found" when all repos have empty results', async () => {
    const emptyOctokit = {
      rest: { repos: { listCommits: vi.fn().mockResolvedValue({ data: [] }) } },
    };
    vi.mocked(getOctokit).mockResolvedValue(emptyOctokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'standup', '--owner', 'o', '--repos', 'empty-repo',
    ]);

    const logged = consoleSpy.mock.calls.flat().join('\n');
    expect(logged).toContain('No commits found');
  });

  it('outputs JSON when --json flag is set', async () => {
    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'standup', '--owner', 'o', '--repos', 'repo1', '--json',
    ]);

    expect(output).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ repo: 'repo1', commits: expect.any(Array) }),
      ]),
      expect.objectContaining({ json: true }),
    );
    // human-mode console.log should NOT have been called (json mode returns early)
    // but console.log from standup is checked — we just verify output() was called
  });

  it('filters commits by --author when specified', async () => {
    const listCommitsSpy = vi.fn().mockResolvedValue({ data: [makeCommit()] });
    const octokit = { rest: { repos: { listCommits: listCommitsSpy } } };
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'standup', '--owner', 'o', '--repos', 'repo1', '--author', 'alice',
    ]);

    const call = listCommitsSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call?.author).toBe('alice');
  });
});

describe('standup — error handling', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(withRetry).mockImplementation(<T>(fn: () => Promise<T>) => fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('shows per-repo error message when a single repo API call fails', async () => {
    const errorOctokit = {
      rest: { repos: { listCommits: vi.fn().mockRejectedValue(new Error('rate limited')) } },
    };
    vi.mocked(getOctokit).mockResolvedValue(errorOctokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'standup', '--owner', 'o', '--repos', 'fail-repo',
    ]);

    const logged = consoleSpy.mock.calls.flat().join('\n');
    expect(logged).toContain('fail-repo');
    expect(logged).toContain('rate limited');
    // process should NOT exit — per-repo errors are not fatal
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('calls outputError and process.exit(1) when getOctokit itself throws', async () => {
    vi.mocked(getOctokit).mockRejectedValue(new Error('No token'));

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'standup', '--owner', 'o', '--repos', 'repo1',
    ]);

    expect(outputError).toHaveBeenCalledWith('Standup failed', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

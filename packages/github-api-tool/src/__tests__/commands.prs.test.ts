import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPRCommands } from '../commands/prs.js';

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

import { getOctokit, parseRepo, withRetry } from '../github.js';
import { output, success, error as outputError } from '../utils/output.js';

function makeProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerPRCommands(p);
  return p;
}

function makeOctokit() {
  return {
    rest: {
      pulls: {
        list: vi.fn(),
        createReview: vi.fn(),
        merge: vi.fn(),
      },
      issues: {
        createComment: vi.fn(),
      },
    },
  };
}

describe('pr list', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(parseRepo).mockReturnValue({ owner: 'o', repo: 'r' });
    vi.mocked(withRetry).mockImplementation(<T>(fn: () => Promise<T>) => fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('lists PRs and maps them to output format', async () => {
    const mockPR = {
      number: 11, title: 'Fix bug', state: 'open',
      user: { login: 'alice' }, created_at: '2024-01-01', html_url: 'https://gh/pr/11',
    };
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.pulls.list).mockResolvedValue({ data: [mockPR] } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'pr', 'list', '--repo', 'o/r']);

    expect(octokit.rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'o', repo: 'r', state: 'open', per_page: 30 }),
    );
    expect(output).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ number: 11, author: 'alice' })]),
      expect.anything(),
    );
  });

  it('calls process.exit(1) on API failure', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.pulls.list).mockRejectedValue(new Error('list failed'));
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'pr', 'list', '--repo', 'o/r']);

    expect(outputError).toHaveBeenCalledWith('Failed to list PRs', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('pr comment', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(parseRepo).mockReturnValue({ owner: 'o', repo: 'r' });
    vi.mocked(withRetry).mockImplementation(<T>(fn: () => Promise<T>) => fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('adds a comment to a PR', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.createComment).mockResolvedValue({
      data: { id: 55, html_url: 'https://gh/c/55', created_at: '2024-01-02' },
    } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'pr', 'comment', '--repo', 'o/r', '--pr', '11', '--body', 'LGTM',
    ]);

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 11, body: 'LGTM' }),
    );
    expect(success).toHaveBeenCalledWith('Comment added to PR #11');
  });

  it('calls process.exit(1) on API failure', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.createComment).mockRejectedValue(new Error('fail'));
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'pr', 'comment', '--repo', 'o/r', '--pr', '11', '--body', 'x',
    ]);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('pr review', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(parseRepo).mockReturnValue({ owner: 'o', repo: 'r' });
    vi.mocked(withRetry).mockImplementation(<T>(fn: () => Promise<T>) => fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('submits an APPROVE review successfully', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.pulls.createReview).mockResolvedValue({
      data: { id: 77, state: 'APPROVED', submitted_at: '2024-01-01', html_url: 'u' },
    } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'pr', 'review', '--repo', 'o/r', '--pr', '5',
      '--event', 'APPROVE', '--body', 'looks good',
    ]);

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 5, event: 'APPROVE', body: 'looks good' }),
    );
    expect(success).toHaveBeenCalledWith('Review submitted for PR #5 (APPROVE)');
  });

  it('rejects an invalid review event and calls process.exit(1)', async () => {
    const octokit = makeOctokit();
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'pr', 'review', '--repo', 'o/r', '--pr', '5',
      '--event', 'INVALID', '--body', 'x',
    ]);

    // Should not call the API
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) on API failure', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.pulls.createReview).mockRejectedValue(new Error('review failed'));
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'pr', 'review', '--repo', 'o/r', '--pr', '5',
      '--event', 'APPROVE', '--body', 'x',
    ]);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('pr merge', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(parseRepo).mockReturnValue({ owner: 'o', repo: 'r' });
    vi.mocked(withRetry).mockImplementation(<T>(fn: () => Promise<T>) => fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('merges a PR successfully and outputs merged info', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.pulls.merge).mockResolvedValue({
      data: { merged: true, sha: 'abc1234', message: 'Merged PR #3' },
    } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'pr', 'merge', '--repo', 'o/r', '--pr', '3']);

    expect(octokit.rest.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 3, merge_method: 'merge' }),
    );
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ merged: true, sha: 'abc1234' }),
      expect.anything(),
    );
    expect(success).toHaveBeenCalledWith('PR #3 merged successfully');
  });

  it('calls outputError (not success) when PR was not merged', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.pulls.merge).mockResolvedValue({
      data: { merged: false, sha: null, message: 'Not merged' },
    } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'pr', 'merge', '--repo', 'o/r', '--pr', '3']);

    expect(success).not.toHaveBeenCalled();
    expect(outputError).toHaveBeenCalledWith('PR merge failed');
  });

  it('rejects an invalid merge method and calls process.exit(1)', async () => {
    const octokit = makeOctokit();
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'pr', 'merge', '--repo', 'o/r', '--pr', '3', '--method', 'fast-forward',
    ]);

    expect(octokit.rest.pulls.merge).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) on API failure', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.pulls.merge).mockRejectedValue(new Error('merge failed'));
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'pr', 'merge', '--repo', 'o/r', '--pr', '3']);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

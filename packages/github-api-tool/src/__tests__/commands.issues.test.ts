import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIssueCommands } from '../commands/issues.js';

// Mock github utilities
vi.mock('../github.js', () => ({
  getOctokit: vi.fn(),
  parseRepo: vi.fn(),
  withRetry: vi.fn(),
}));

// Mock output utilities
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
  registerIssueCommands(p);
  return p;
}

function makeOctokit(overrides: Record<string, unknown> = {}) {
  return {
    rest: {
      issues: {
        create: vi.fn(),
        listForRepo: vi.fn(),
        addAssignees: vi.fn(),
        createComment: vi.fn(),
        update: vi.fn(),
        ...overrides,
      },
    },
  };
}

describe('issue create', () => {
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

  it('creates an issue and outputs result + success message', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.create).mockResolvedValue({
      data: { number: 42, title: 'Bug', state: 'open', html_url: 'https://gh/42', created_at: '2024-01-01' },
    } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'issue', 'create', '--repo', 'o/r', '--title', 'Bug']);

    expect(parseRepo).toHaveBeenCalledWith('o/r');
    expect(octokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'o', repo: 'r', title: 'Bug' }),
    );
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ number: 42, title: 'Bug', state: 'open' }),
      expect.objectContaining({ json: undefined }),
    );
    expect(success).toHaveBeenCalledWith('Issue #42 created');
  });

  it('splits labels and assignee correctly', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.create).mockResolvedValue({
      data: { number: 7, title: 'T', state: 'open', html_url: 'u', created_at: 'd' },
    } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'issue', 'create',
      '--repo', 'o/r', '--title', 'T',
      '--labels', 'bug, enhancement', '--assignee', 'alice',
    ]);

    expect(octokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['bug', 'enhancement'], assignees: ['alice'] }),
    );
  });

  it('does not call success when --json is set', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.create).mockResolvedValue({
      data: { number: 1, title: 'T', state: 'open', html_url: 'u', created_at: 'd' },
    } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'issue', 'create', '--repo', 'o/r', '--title', 'T', '--json']);

    expect(success).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ json: true }));
  });

  it('calls outputError and process.exit(1) when API throws', async () => {
    const apiError = new Error('API failure');
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.create).mockRejectedValue(apiError);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'issue', 'create', '--repo', 'o/r', '--title', 'T']);

    expect(outputError).toHaveBeenCalledWith('Failed to create issue', apiError);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('issue list', () => {
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

  const mockIssue = {
    number: 1, title: 'Issue 1', state: 'open',
    labels: [{ name: 'bug' }], assignees: [{ login: 'alice' }],
    created_at: '2024-01-01', html_url: 'https://gh/1',
  };

  it('lists issues and outputs them', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.listForRepo).mockResolvedValue({ data: [mockIssue] } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'issue', 'list', '--repo', 'o/r']);

    expect(octokit.rest.issues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'o', repo: 'r', state: 'open', per_page: 30 }),
    );
    expect(output).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ number: 1, title: 'Issue 1' })]),
      expect.anything(),
    );
  });

  it('passes labels filter when provided', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.listForRepo).mockResolvedValue({ data: [] } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'issue', 'list', '--repo', 'o/r', '--labels', 'bug',
    ]);

    expect(octokit.rest.issues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ labels: 'bug' }),
    );
  });

  it('calls outputError and process.exit(1) on API failure', async () => {
    const apiError = new Error('list failed');
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.listForRepo).mockRejectedValue(apiError);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'issue', 'list', '--repo', 'o/r']);

    expect(outputError).toHaveBeenCalledWith('Failed to list issues', apiError);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('issue assign', () => {
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

  it('assigns an issue and outputs assignees', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.addAssignees).mockResolvedValue({
      data: { number: 5, assignees: [{ login: 'bob' }] },
    } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'issue', 'assign', '--repo', 'o/r', '--issue', '5', '--assignee', 'bob',
    ]);

    expect(octokit.rest.issues.addAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 5, assignees: ['bob'] }),
    );
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ number: 5, assignees: ['bob'] }),
      expect.anything(),
    );
    expect(success).toHaveBeenCalledWith('Issue #5 assigned to bob');
  });

  it('calls process.exit(1) on API failure', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.addAssignees).mockRejectedValue(new Error('assign failed'));
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'issue', 'assign', '--repo', 'o/r', '--issue', '5', '--assignee', 'bob',
    ]);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('issue comment', () => {
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

  it('adds a comment and outputs the comment info', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.createComment).mockResolvedValue({
      data: { id: 99, html_url: 'https://gh/c/99', created_at: '2024-01-02' },
    } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'issue', 'comment', '--repo', 'o/r', '--issue', '3', '--body', 'LGTM',
    ]);

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 3, body: 'LGTM' }),
    );
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ id: 99 }),
      expect.anything(),
    );
    expect(success).toHaveBeenCalledWith('Comment added to issue #3');
  });

  it('calls process.exit(1) on API failure', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.createComment).mockRejectedValue(new Error('fail'));
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'issue', 'comment', '--repo', 'o/r', '--issue', '3', '--body', 'x',
    ]);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('issue close', () => {
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

  it('closes an issue and outputs the updated state', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.update).mockResolvedValue({
      data: { number: 10, state: 'closed', closed_at: '2024-01-03' },
    } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'issue', 'close', '--repo', 'o/r', '--issue', '10']);

    expect(octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 10, state: 'closed' }),
    );
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ number: 10, state: 'closed' }),
      expect.anything(),
    );
    expect(success).toHaveBeenCalledWith('Issue #10 closed');
  });

  it('calls process.exit(1) on API failure', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.issues.update).mockRejectedValue(new Error('close failed'));
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'issue', 'close', '--repo', 'o/r', '--issue', '10']);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

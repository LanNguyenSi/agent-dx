import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRepoCommands } from '../commands/repos.js';

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
import { output, error as outputError } from '../utils/output.js';

function makeProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerRepoCommands(p);
  return p;
}

function makeOctokit() {
  return {
    rest: {
      repos: {
        listCommits: vi.fn(),
        listContributors: vi.fn(),
        get: vi.fn(),
      },
    },
  };
}

describe('repo commits', () => {
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

  it('lists commits and maps them to output format', async () => {
    const mockCommit = {
      sha: 'abc1234567',
      commit: { author: { name: 'Alice', date: '2024-01-01' }, message: 'fix: bug\nmore details' },
      html_url: 'https://gh/c/abc',
    };
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.repos.listCommits).mockResolvedValue({ data: [mockCommit] } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'repo', 'commits', '--repo', 'o/r']);

    expect(octokit.rest.repos.listCommits).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'o', repo: 'r', per_page: 10 }),
    );
    expect(output).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          sha: 'abc1234', // first 7 chars
          author: 'Alice',
          message: 'fix: bug', // only first line
        }),
      ]),
      expect.anything(),
    );
  });

  it('calls process.exit(1) on API failure', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.repos.listCommits).mockRejectedValue(new Error('commits failed'));
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'repo', 'commits', '--repo', 'o/r']);

    expect(outputError).toHaveBeenCalledWith('Failed to list commits', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('repo contributors', () => {
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

  it('lists contributors and maps them to output format', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.repos.listContributors).mockResolvedValue({
      data: [{ login: 'alice', contributions: 42, html_url: 'https://gh/alice' }],
    } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'repo', 'contributors', '--repo', 'o/r']);

    expect(output).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ login: 'alice', contributions: 42 }),
      ]),
      expect.anything(),
    );
  });

  it('calls process.exit(1) on API failure', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.repos.listContributors).mockRejectedValue(new Error('fail'));
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'repo', 'contributors', '--repo', 'o/r']);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('repo info', () => {
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

  it('fetches and outputs repository info', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.repos.get).mockResolvedValue({
      data: {
        name: 'my-repo', full_name: 'o/my-repo', description: 'A test repo',
        private: false, default_branch: 'main', stargazers_count: 10,
        forks_count: 2, open_issues_count: 3, language: 'TypeScript',
        created_at: '2023-01-01', updated_at: '2024-01-01', html_url: 'https://gh/o/my-repo',
      },
    } as never);
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'repo', 'info', '--repo', 'o/r']);

    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'my-repo', full_name: 'o/my-repo', stars: 10, forks: 2,
      }),
      expect.anything(),
    );
  });

  it('calls process.exit(1) on API failure', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.rest.repos.get).mockRejectedValue(new Error('not found'));
    vi.mocked(getOctokit).mockResolvedValue(octokit as never);

    const program = makeProgram();
    await program.parseAsync(['node', 'gh', 'repo', 'info', '--repo', 'o/r']);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

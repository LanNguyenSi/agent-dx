import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBugReportCommands } from '../commands/bug-report.js';

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
import { success, error as outputError } from '../utils/output.js';

function makeProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerBugReportCommands(p);
  return p;
}

describe('bug-report (non-interactive, all flags supplied)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(parseRepo).mockReturnValue({ owner: 'o', repo: 'r' });
    vi.mocked(withRetry).mockImplementation(<T>(fn: () => Promise<T>) => fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('creates a structured bug report issue with all fields provided', async () => {
    const mockOctokit = {
      rest: { issues: { create: vi.fn().mockResolvedValue({ data: { number: 99, html_url: 'https://gh/99' } }) } },
    };
    vi.mocked(getOctokit).mockResolvedValue(mockOctokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'bug-report',
      '--repo', 'o/r',
      '--title', 'Login fails silently',
      '--observed', 'Clicking login does nothing',
      '--expected', 'User should be redirected',
      '--reproduce', 'curl -X POST /login',
      '--hypothesis', 'JWT secret is missing',
      '--labels', 'bug,urgent',
    ]);

    expect(mockOctokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'o', repo: 'r',
        title: 'Login fails silently',
        labels: ['bug', 'urgent'],
        body: expect.stringContaining('Clicking login does nothing'),
      }),
    );
    // body should also contain expected, reproduce, hypothesis
    const call = vi.mocked(mockOctokit.rest.issues.create).mock.calls[0]?.[0];
    expect(call?.body).toContain('User should be redirected');
    expect(call?.body).toContain('curl -X POST /login');
    expect(call?.body).toContain('JWT secret is missing');
    expect(success).toHaveBeenCalledWith('Bug report created: #99');
  });

  it('outputs JSON when --json flag is set', async () => {
    const mockOctokit = {
      rest: { issues: { create: vi.fn().mockResolvedValue({ data: { number: 5, html_url: 'https://gh/5' } }) } },
    };
    vi.mocked(getOctokit).mockResolvedValue(mockOctokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'bug-report',
      '--repo', 'o/r',
      '--title', 'T',
      '--observed', 'O', '--expected', 'E', '--reproduce', 'R',
      '--json',
    ]);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      JSON.stringify({ number: 5, url: 'https://gh/5' }),
    );
    expect(success).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) when the API throws', async () => {
    const mockOctokit = {
      rest: { issues: { create: vi.fn().mockRejectedValue(new Error('API error')) } },
    };
    vi.mocked(getOctokit).mockResolvedValue(mockOctokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'bug-report',
      '--repo', 'o/r',
      '--title', 'T',
      '--observed', 'O', '--expected', 'E', '--reproduce', 'R',
    ]);

    expect(outputError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to create bug report'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('uses default label "bug" when --labels is not provided', async () => {
    const mockOctokit = {
      rest: { issues: { create: vi.fn().mockResolvedValue({ data: { number: 1, html_url: 'u' } }) } },
    };
    vi.mocked(getOctokit).mockResolvedValue(mockOctokit as never);

    const program = makeProgram();
    await program.parseAsync([
      'node', 'gh', 'bug-report',
      '--repo', 'o/r', '--title', 'T',
      '--observed', 'O', '--expected', 'E', '--reproduce', 'R',
    ]);

    expect(mockOctokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['bug'] }),
    );
  });
});

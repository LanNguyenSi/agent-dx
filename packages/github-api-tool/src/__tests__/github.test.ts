import { describe, expect, it } from 'vitest';
import { parseRepo, withRetry } from '../github.js';

class HttpError extends Error {
  status?: number;
}

describe('parseRepo', () => {
  it('parses owner/repo format', () => {
    expect(parseRepo('openai/codex')).toEqual({
      owner: 'openai',
      repo: 'codex',
    });
  });

  it('trims whitespace around owner and repo', () => {
    expect(parseRepo(' openai / codex ')).toEqual({
      owner: 'openai',
      repo: 'codex',
    });
  });

  it('throws for invalid repository strings', () => {
    expect(() => parseRepo('openai')).toThrow(
      'Invalid repository format: "openai". Expected format: owner/repo'
    );
    expect(() => parseRepo('openai/')).toThrow(
      'Invalid repository format: "openai/". Expected format: owner/repo'
    );
    expect(() => parseRepo('/codex')).toThrow(
      'Invalid repository format: "/codex". Expected format: owner/repo'
    );
    expect(() => parseRepo('openai/codex/extra')).toThrow(
      'Invalid repository format: "openai/codex/extra". Expected format: owner/repo'
    );
  });
});

describe('withRetry', () => {
  it('does not retry for client errors except rate limiting', async () => {
    const err = new HttpError('not found');
    err.status = 404;
    let calls = 0;

    await expect(
      withRetry(async () => {
        calls += 1;
        throw err;
      })
    ).rejects.toThrow('not found');

    expect(calls).toBe(1);
  });

  it('retries transient errors and eventually succeeds', async () => {
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          const err = new HttpError('server error');
          err.status = 500;
          throw err;
        }
        return 'ok';
      },
      3,
      0
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });
});

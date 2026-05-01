import { Octokit } from '@octokit/rest';
import { getToken } from './utils/config.js';

let octokitInstance: Octokit | null = null;

/**
 * Get authenticated Octokit client (singleton)
 */
export async function getOctokit(): Promise<Octokit> {
  if (octokitInstance) {
    return octokitInstance;
  }

  const token = await getToken();
  octokitInstance = new Octokit({
    auth: token,
    retry: {
      enabled: true,
      retries: 3,
    },
    request: {
      timeout: 10000,
    },
  });

  return octokitInstance;
}

/**
 * Parse repository string (owner/repo) into parts
 */
export function parseRepo(repoString: string): { owner: string; repo: string } {
  const parts = repoString.split('/').map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid repository format: "${repoString}". Expected format: owner/repo`
    );
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Handle GitHub API errors with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry on auth errors or client errors (4xx)
      if (error instanceof Error && 'status' in error) {
        const status = (error as { status?: number }).status;
        if (status && status >= 400 && status < 500 && status !== 429) {
          throw error;
        }
      }

      // Exponential backoff
      if (i < retries - 1) {
        const delay = Math.pow(2, i) * baseDelayMs;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Operation failed after retries');
}

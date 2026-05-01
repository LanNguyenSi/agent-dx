import { Command } from 'commander';
import { getOctokit, parseRepo, withRetry } from '../github.js';
import { parsePositiveInteger } from '../utils/args.js';
import { output, error as outputError } from '../utils/output.js';

export function registerRepoCommands(program: Command): void {
  const repo = program.command('repo').description('Repository operations');

  interface RepoListOptions {
    repo: string;
    limit: string;
    json?: boolean;
  }

  interface RepoInfoOptions {
    repo: string;
    json?: boolean;
  }

  // List commits
  repo
    .command('commits')
    .description('List recent commits')
    .requiredOption('-r, --repo <owner/repo>', 'Repository')
    .option('--limit <number>', 'Maximum number of results', '10')
    .option('--json', 'Output as JSON')
    .action(async (options: RepoListOptions) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const limit = parsePositiveInteger(options.limit, '--limit');
        const octokit = await getOctokit();

        const result = await withRetry(async () =>
          octokit.rest.repos.listCommits({
            owner,
            repo,
            per_page: limit,
          })
        );

        const commits = result.data.map((commit) => ({
          sha: commit.sha.substring(0, 7),
          author: commit.commit.author?.name,
          date: commit.commit.author?.date,
          message: commit.commit.message.split('\n')[0], // First line only
          url: commit.html_url,
        }));

        output(commits, { json: options.json });
      } catch (err) {
        outputError('Failed to list commits', err as Error);
        process.exit(1);
      }
    });

  // List contributors
  repo
    .command('contributors')
    .description('List repository contributors')
    .requiredOption('-r, --repo <owner/repo>', 'Repository')
    .option('--limit <number>', 'Maximum number of results', '30')
    .option('--json', 'Output as JSON')
    .action(async (options: RepoListOptions) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const limit = parsePositiveInteger(options.limit, '--limit');
        const octokit = await getOctokit();

        const result = await withRetry(async () =>
          octokit.rest.repos.listContributors({
            owner,
            repo,
            per_page: limit,
          })
        );

        const contributors = result.data.map((contributor) => ({
          login: contributor.login,
          contributions: contributor.contributions,
          url: contributor.html_url,
        }));

        output(contributors, { json: options.json });
      } catch (err) {
        outputError('Failed to list contributors', err as Error);
        process.exit(1);
      }
    });

  // Repository info
  repo
    .command('info')
    .description('Get repository information')
    .requiredOption('-r, --repo <owner/repo>', 'Repository')
    .option('--json', 'Output as JSON')
    .action(async (options: RepoInfoOptions) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const octokit = await getOctokit();

        const result = await withRetry(async () =>
          octokit.rest.repos.get({
            owner,
            repo,
          })
        );

        const info = {
          name: result.data.name,
          full_name: result.data.full_name,
          description: result.data.description,
          private: result.data.private,
          default_branch: result.data.default_branch,
          stars: result.data.stargazers_count,
          forks: result.data.forks_count,
          open_issues: result.data.open_issues_count,
          language: result.data.language,
          created_at: result.data.created_at,
          updated_at: result.data.updated_at,
          url: result.data.html_url,
        };

        output(info, { json: options.json });
      } catch (err) {
        outputError('Failed to get repository info', err as Error);
        process.exit(1);
      }
    });
}

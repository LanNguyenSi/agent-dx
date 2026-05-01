import { Command } from 'commander';
import { getOctokit, parseRepo, withRetry } from '../github.js';
import { parsePositiveInteger } from '../utils/args.js';
import { output, success, error as outputError } from '../utils/output.js';

export function registerPRCommands(program: Command): void {
  const pr = program.command('pr').description('Manage pull requests');

  interface PRListOptions {
    repo: string;
    state: 'open' | 'closed' | 'all';
    limit: string;
    json?: boolean;
  }

  interface PRCommentOptions {
    repo: string;
    pr: string;
    body: string;
    json?: boolean;
  }

  interface PRReviewOptions {
    repo: string;
    pr: string;
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
    body: string;
    json?: boolean;
  }

  interface PRMergeOptions {
    repo: string;
    pr: string;
    method: 'merge' | 'squash' | 'rebase';
    json?: boolean;
  }

  // List PRs
  pr.command('list')
    .description('List pull requests')
    .requiredOption('-r, --repo <owner/repo>', 'Repository')
    .option('-s, --state <state>', 'PR state (open, closed, all)', 'open')
    .option('--limit <number>', 'Maximum number of results', '30')
    .option('--json', 'Output as JSON')
    .action(async (options: PRListOptions) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const limit = parsePositiveInteger(options.limit, '--limit');
        const octokit = await getOctokit();

        const result = await withRetry(async () =>
          octokit.rest.pulls.list({
            owner,
            repo,
            state: options.state,
            per_page: limit,
          })
        );

        const pullRequests = result.data.map((pullRequest) => ({
          number: pullRequest.number,
          title: pullRequest.title,
          state: pullRequest.state,
          author: pullRequest.user?.login,
          created_at: pullRequest.created_at,
          url: pullRequest.html_url,
        }));

        output(pullRequests, { json: options.json });
      } catch (err) {
        outputError('Failed to list PRs', err as Error);
        process.exit(1);
      }
    });

  // Comment on PR
  pr.command('comment')
    .description('Add a comment to a pull request')
    .requiredOption('-r, --repo <owner/repo>', 'Repository')
    .requiredOption('-p, --pr <number>', 'PR number')
    .requiredOption('-b, --body <body>', 'Comment body')
    .option('--json', 'Output as JSON')
    .action(async (options: PRCommentOptions) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const pullRequestNumber = parsePositiveInteger(options.pr, '--pr');
        const octokit = await getOctokit();

        const result = await withRetry(async () =>
          octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pullRequestNumber,
            body: options.body,
          })
        );

        output({
          id: result.data.id,
          url: result.data.html_url,
          created_at: result.data.created_at,
        }, { json: options.json });

        if (!options.json) {
          success(`Comment added to PR #${options.pr}`);
        }
      } catch (err) {
        outputError('Failed to add comment', err as Error);
        process.exit(1);
      }
    });

  // Review PR
  pr.command('review')
    .description('Submit a pull request review')
    .requiredOption('-r, --repo <owner/repo>', 'Repository')
    .requiredOption('-p, --pr <number>', 'PR number')
    .requiredOption('-e, --event <event>', 'Review event (APPROVE, REQUEST_CHANGES, COMMENT)')
    .requiredOption('-b, --body <body>', 'Review body')
    .option('--json', 'Output as JSON')
    .action(async (options: PRReviewOptions) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const pullRequestNumber = parsePositiveInteger(options.pr, '--pr');
        const octokit = await getOctokit();

        const validEvents = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];
        if (!validEvents.includes(options.event)) {
          throw new Error(`Invalid review event: ${options.event}. Must be one of: ${validEvents.join(', ')}`);
        }

        const result = await withRetry(async () =>
          octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: pullRequestNumber,
            event: options.event,
            body: options.body,
          })
        );

        output({
          id: result.data.id,
          state: result.data.state,
          submitted_at: result.data.submitted_at,
          url: result.data.html_url,
        }, { json: options.json });

        if (!options.json) {
          success(`Review submitted for PR #${options.pr} (${options.event})`);
        }
      } catch (err) {
        outputError('Failed to submit review', err as Error);
        process.exit(1);
      }
    });

  // Merge PR
  pr.command('merge')
    .description('Merge a pull request')
    .requiredOption('-r, --repo <owner/repo>', 'Repository')
    .requiredOption('-p, --pr <number>', 'PR number')
    .option('-m, --method <method>', 'Merge method (merge, squash, rebase)', 'merge')
    .option('--json', 'Output as JSON')
    .action(async (options: PRMergeOptions) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const pullRequestNumber = parsePositiveInteger(options.pr, '--pr');
        const octokit = await getOctokit();

        const validMethods = ['merge', 'squash', 'rebase'];
        if (!validMethods.includes(options.method)) {
          throw new Error(`Invalid merge method: ${options.method}. Must be one of: ${validMethods.join(', ')}`);
        }

        const result = await withRetry(async () =>
          octokit.rest.pulls.merge({
            owner,
            repo,
            pull_number: pullRequestNumber,
            merge_method: options.method,
          })
        );

        output({
          merged: result.data.merged,
          sha: result.data.sha,
          message: result.data.message,
        }, { json: options.json });

        if (!options.json) {
          if (result.data.merged) {
            success(`PR #${options.pr} merged successfully`);
          } else {
            outputError('PR merge failed');
          }
        }
      } catch (err) {
        outputError('Failed to merge PR', err as Error);
        process.exit(1);
      }
    });
}

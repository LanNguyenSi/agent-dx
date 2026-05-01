import { Command } from 'commander';
import { getOctokit, parseRepo, withRetry } from '../github.js';
import { parsePositiveInteger } from '../utils/args.js';
import { output, success, error as outputError } from '../utils/output.js';

export function registerIssueCommands(program: Command): void {
  const issue = program
    .command('issue')
    .description('Manage GitHub issues');

  interface IssueCreateOptions {
    repo: string;
    title: string;
    body?: string;
    labels?: string;
    assignee?: string;
    json?: boolean;
  }

  interface IssueListOptions {
    repo: string;
    state: 'open' | 'closed' | 'all';
    labels?: string;
    limit: string;
    json?: boolean;
  }

  interface IssueAssignOptions {
    repo: string;
    issue: string;
    assignee: string;
    json?: boolean;
  }

  interface IssueCommentOptions {
    repo: string;
    issue: string;
    body: string;
    json?: boolean;
  }

  interface IssueCloseOptions {
    repo: string;
    issue: string;
    json?: boolean;
  }

  // Create issue
  issue
    .command('create')
    .description('Create a new issue')
    .requiredOption('-r, --repo <owner/repo>', 'Repository')
    .requiredOption('-t, --title <title>', 'Issue title')
    .option('-b, --body <body>', 'Issue body/description')
    .option('-l, --labels <labels>', 'Comma-separated labels')
    .option('-a, --assignee <username>', 'Assignee username')
    .option('--json', 'Output as JSON')
    .action(async (options: IssueCreateOptions) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const octokit = await getOctokit();

        const labels = options.labels ? options.labels.split(',').map((l: string) => l.trim()) : undefined;
        const assignees = options.assignee ? [options.assignee] : undefined;

        const result = await withRetry(async () =>
          octokit.rest.issues.create({
            owner,
            repo,
            title: options.title,
            body: options.body,
            labels,
            assignees,
          })
        );

        output({
          number: result.data.number,
          title: result.data.title,
          state: result.data.state,
          url: result.data.html_url,
          created_at: result.data.created_at,
        }, { json: options.json });

        if (!options.json) {
          success(`Issue #${result.data.number} created`);
        }
      } catch (err) {
        outputError('Failed to create issue', err as Error);
        process.exit(1);
      }
    });

  // List issues
  issue
    .command('list')
    .description('List issues')
    .requiredOption('-r, --repo <owner/repo>', 'Repository')
    .option('-s, --state <state>', 'Issue state (open, closed, all)', 'open')
    .option('-l, --labels <labels>', 'Filter by comma-separated labels')
    .option('--limit <number>', 'Maximum number of results', '30')
    .option('--json', 'Output as JSON')
    .action(async (options: IssueListOptions) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const limit = parsePositiveInteger(options.limit, '--limit');
        const octokit = await getOctokit();

        const labels = options.labels ? options.labels : undefined;

        const result = await withRetry(async () =>
          octokit.rest.issues.listForRepo({
            owner,
            repo,
            state: options.state,
            labels,
            per_page: limit,
          })
        );

        const issues = result.data.map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          labels: issue.labels.map((l: string | { name?: string | null }) => typeof l === 'string' ? l : l.name).filter(Boolean),
          assignees: issue.assignees?.map((a: { login?: string | null }) => a?.login).filter(Boolean) || [],
          created_at: issue.created_at,
          url: issue.html_url,
        }));

        output(issues, { json: options.json });
      } catch (err) {
        outputError('Failed to list issues', err as Error);
        process.exit(1);
      }
    });

  // Assign issue
  issue
    .command('assign')
    .description('Assign an issue to a user')
    .requiredOption('-r, --repo <owner/repo>', 'Repository')
    .requiredOption('-i, --issue <number>', 'Issue number')
    .requiredOption('-a, --assignee <username>', 'Assignee username')
    .option('--json', 'Output as JSON')
    .action(async (options: IssueAssignOptions) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const issueNumber = parsePositiveInteger(options.issue, '--issue');
        const octokit = await getOctokit();

        const result = await withRetry(async () =>
          octokit.rest.issues.addAssignees({
            owner,
            repo,
            issue_number: issueNumber,
            assignees: [options.assignee],
          })
        );

        output({
          number: result.data.number,
          assignees: result.data.assignees?.map((a: { login?: string | null }) => a?.login).filter(Boolean) || [],
        }, { json: options.json });

        if (!options.json) {
          success(`Issue #${options.issue} assigned to ${options.assignee}`);
        }
      } catch (err) {
        outputError('Failed to assign issue', err as Error);
        process.exit(1);
      }
    });

  // Comment on issue
  issue
    .command('comment')
    .description('Add a comment to an issue')
    .requiredOption('-r, --repo <owner/repo>', 'Repository')
    .requiredOption('-i, --issue <number>', 'Issue number')
    .requiredOption('-b, --body <body>', 'Comment body')
    .option('--json', 'Output as JSON')
    .action(async (options: IssueCommentOptions) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const issueNumber = parsePositiveInteger(options.issue, '--issue');
        const octokit = await getOctokit();

        const result = await withRetry(async () =>
          octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: issueNumber,
            body: options.body,
          })
        );

        output({
          id: result.data.id,
          url: result.data.html_url,
          created_at: result.data.created_at,
        }, { json: options.json });

        if (!options.json) {
          success(`Comment added to issue #${options.issue}`);
        }
      } catch (err) {
        outputError('Failed to add comment', err as Error);
        process.exit(1);
      }
    });

  // Close issue
  issue
    .command('close')
    .description('Close an issue')
    .requiredOption('-r, --repo <owner/repo>', 'Repository')
    .requiredOption('-i, --issue <number>', 'Issue number')
    .option('--json', 'Output as JSON')
    .action(async (options: IssueCloseOptions) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const issueNumber = parsePositiveInteger(options.issue, '--issue');
        const octokit = await getOctokit();

        const result = await withRetry(async () =>
          octokit.rest.issues.update({
            owner,
            repo,
            issue_number: issueNumber,
            state: 'closed',
          })
        );

        output({
          number: result.data.number,
          state: result.data.state,
          closed_at: result.data.closed_at,
        }, { json: options.json });

        if (!options.json) {
          success(`Issue #${options.issue} closed`);
        }
      } catch (err) {
        outputError('Failed to close issue', err as Error);
        process.exit(1);
      }
    });
}

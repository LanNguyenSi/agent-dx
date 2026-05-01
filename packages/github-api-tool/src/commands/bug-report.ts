import { Command } from 'commander';
import { getOctokit, parseRepo, withRetry } from '../github.js';
import { success, error as outputError } from '../utils/output.js';
import * as readline from 'readline';

const BUG_TEMPLATE = (
  observed: string,
  expected: string,
  reproduce: string,
  hypothesis: string,
) => `## Observed Behavior
${observed}

## Expected Behavior
${expected}

## Steps to Reproduce
${reproduce}

## Minimal Reproduce Case
<!-- curl command, test snippet, or screenshot -->

## Hypothesis
${hypothesis || 'TBD'}

## Root Cause
<!-- Fill in after diagnosis -->
`;

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

export function registerBugReportCommands(program: Command): void {
  program
    .command('bug-report')
    .description('Create a structured bug report issue (per ENGINEERING.md)')
    .requiredOption('-r, --repo <owner/repo>', 'Repository (e.g. LanNguyenSi/telerithm)')
    .option('-t, --title <title>', 'Issue title')
    .option('--observed <text>', 'What actually happens')
    .option('--expected <text>', 'What should happen')
    .option('--reproduce <text>', 'Steps or curl command to reproduce')
    .option('--hypothesis <text>', 'Initial hypothesis (optional)')
    .option('-l, --labels <labels>', 'Comma-separated labels (default: bug)', 'bug')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const { owner, repo } = parseRepo(options.repo);
        const octokit = await getOctokit();

        let { title, observed, expected, reproduce, hypothesis } = options;

        // Interactive mode if fields missing
        if (!title || !observed || !expected || !reproduce) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          if (!title) title = await prompt(rl, 'Title: ');
          if (!observed) observed = await prompt(rl, 'Observed behavior: ');
          if (!expected) expected = await prompt(rl, 'Expected behavior: ');
          if (!reproduce) reproduce = await prompt(rl, 'Steps to reproduce (or curl): ');
          if (!hypothesis) hypothesis = await prompt(rl, 'Hypothesis (optional, Enter to skip): ');
          rl.close();
        }

        const body = BUG_TEMPLATE(observed, expected, reproduce, hypothesis || '');
        const labels = options.labels.split(',').map((l: string) => l.trim());

        const result = await withRetry(async () =>
          octokit.rest.issues.create({
            owner,
            repo,
            title,
            body,
            labels,
          })
        );

        if (options.json) {
          console.log(JSON.stringify({ number: result.data.number, url: result.data.html_url }));
        } else {
          success(`Bug report created: #${result.data.number}`);
          console.log(`  ${result.data.html_url}`);
        }
      } catch (err) {
        outputError(`Failed to create bug report: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

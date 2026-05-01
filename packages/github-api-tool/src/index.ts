#!/usr/bin/env node
import { Command } from 'commander';
import { registerIssueCommands } from './commands/issues.js';
import { registerBugReportCommands } from './commands/bug-report.js';
import { registerCoverageCheckCommands } from './commands/coverage-check.js';
import { registerPRCommands } from './commands/prs.js';
import { registerStandupCommands } from './commands/standup.js';
import { registerRepoCommands } from './commands/repos.js';
import { saveConfig } from './utils/config.js';
import { success, error as outputError } from './utils/output.js';

const program = new Command();

program
  .name('github')
  .description('GitHub API CLI tool for OpenClaw agents')
  .version('0.1.0');

// Config command
program
  .command('config')
  .description('Configure GitHub API tool')
  .command('set-token')
  .description('Set GitHub personal access token')
  .argument('<token>', 'GitHub PAT with repo access')
  .action(async (token: string) => {
    try {
      await saveConfig({ token });
      success('GitHub token saved successfully');
      console.log('Token stored in:', '~/.github-api-tool/config.json');
    } catch (err) {
      outputError('Failed to save token', err as Error);
      process.exit(1);
    }
  });

// Register command groups
registerIssueCommands(program);
registerPRCommands(program);
registerRepoCommands(program);
registerBugReportCommands(program);
registerCoverageCheckCommands(program);
registerStandupCommands(program);

// Parse arguments
program.parse();

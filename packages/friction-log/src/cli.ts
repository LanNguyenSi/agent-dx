#!/usr/bin/env node
import { Command } from 'commander';
import { runFile } from './commands/file.js';
import { formatTable, runList } from './commands/list.js';
import { runLog } from './commands/log.js';
import type { FrictionSource, FrictionStatus, Severity } from './types.js';

const program = new Command();

program
  .name('friction-log')
  .description('Capture, query, and infer agent-workflow frictions.')
  .version('0.1.0');

program
  .command('log')
  .description('Manually record a friction.')
  .requiredOption('--title <title>', 'Short title describing the friction')
  .option('--description <text>', 'Longer description / reproduction notes')
  .option('--tool <surface>', 'Tool surface that caused the friction (e.g. mcp:agent-tasks/tasks_list)')
  .option('--category <name>', 'Category (e.g. output-overflow, tool-error)')
  .option('--severity <level>', 'low | medium | high | critical')
  .option('--session <id>', 'Session id to associate with this friction')
  .option('--db <path>', 'Override database path (default: XDG)')
  .action((opts: Record<string, string>) => {
    const out = runLog({
      title: opts.title,
      description: opts.description,
      tool: opts.tool,
      category: opts.category,
      severity: opts.severity as Severity | undefined,
      sessionId: opts.session,
      dbPath: opts.db,
    });
    process.stdout.write(`friction id=${out.id} captured_at=${out.capturedAt}\n`);
  });

program
  .command('list')
  .description('List frictions with optional filters.')
  .option('--status <status>', 'open | filed | resolved | wontfix')
  .option('--tool <surface>', 'Filter by tool surface')
  .option('--category <name>', 'Filter by category')
  .option('--source <source>', 'scan | manual | import')
  .option('--age <span>', 'Only frictions newer than e.g. 14d, 4w, 12h')
  .option('--limit <n>', 'Max rows (default 100)', (v) => Number(v))
  .option('--json', 'Emit JSON instead of a table')
  .option('--db <path>', 'Override database path')
  .action((opts: Record<string, unknown>) => {
    const out = runList({
      status: opts.status as FrictionStatus | undefined,
      tool: opts.tool as string | undefined,
      category: opts.category as string | undefined,
      source: opts.source as FrictionSource | undefined,
      age: opts.age as string | undefined,
      limit: typeof opts.limit === 'number' ? opts.limit : undefined,
      dbPath: opts.db as string | undefined,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(out.frictions, null, 2) + '\n');
    } else {
      process.stdout.write(formatTable(out.frictions) + '\n');
    }
  });

program
  .command('file <frictionId>')
  .description('Push a friction to a configured sink. Default sink: markdown-file.')
  .option('--sink <name>', 'Sink to use (M1: markdown-file)')
  .option('--template <name>', 'Template override (defaults to friction.category match)')
  .option('--sink-target <value>', 'Sink-specific target (e.g. directory path for markdown-file)')
  .option('--db <path>', 'Override database path')
  .action(async (frictionId: string, opts: Record<string, string>) => {
    const id = Number(frictionId);
    if (!Number.isInteger(id) || id <= 0) {
      process.stderr.write(`friction-log: <frictionId> must be a positive integer, got "${frictionId}"\n`);
      process.exit(2);
    }
    try {
      const out = await runFile({
        frictionId: id,
        sink: opts.sink,
        template: opts.template,
        sinkTarget: opts.sinkTarget,
        dbPath: opts.db,
      });
      process.stdout.write(
        `filed friction id=${id} via sink=${out.sinkName} target=${out.sinkTarget}\n${out.message}\n`
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`friction-log: ${err.message}\n`);
  process.exit(1);
});

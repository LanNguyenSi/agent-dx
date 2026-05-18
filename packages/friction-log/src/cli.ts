#!/usr/bin/env node
import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBilanz } from './commands/bilanz.js';
import { formatDigest, runDigest } from './commands/digest.js';
import { runExport, type ExportFormat } from './commands/export.js';
import { runFile } from './commands/file.js';
import { formatTable, runList } from './commands/list.js';
import { runLog } from './commands/log.js';
import { runRm } from './commands/rm.js';
import {
  payloadToScanInput,
  runScan,
  summarize,
  type StopHookPayload,
} from './commands/scan.js';
import { runSearch } from './commands/search.js';
import { runUpdate } from './commands/update.js';
import type { DigestGroupBy } from './db.js';
import type { FrictionSource, FrictionStatus, Severity } from './types.js';

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SEVERITY_CHOICES = ['low', 'medium', 'high', 'critical'] as const;
const STATUS_CHOICES = ['open', 'filed', 'resolved', 'wontfix'] as const;
const SOURCE_CHOICES = ['scan', 'manual', 'import'] as const;
const SCANNER_CHOICES = ['claude-code'] as const;
const DIGEST_GROUP_CHOICES = ['tool', 'category', 'severity', 'source'] as const;
const EXPORT_FORMAT_CHOICES = ['json', 'csv', 'md'] as const;

const program = new Command();

program
  .name('friction-log')
  .description('Capture, query, and infer agent-workflow frictions.')
  .version(readPackageVersion());

program
  .command('log')
  .description('Manually record a friction.')
  .requiredOption('--title <title>', 'Short title describing the friction')
  .option('--description <text>', 'Longer description / reproduction notes')
  .option('--tool <surface>', 'Tool surface that caused the friction (e.g. mcp:agent-tasks/tasks_list)')
  .option('--category <name>', 'Category (e.g. output-overflow, tool-error)')
  .addOption(new Option('--severity <level>', 'Severity level').choices([...SEVERITY_CHOICES]))
  .option('--session <id>', 'Session id to associate with this friction')
  .option('--recurrence-of <id>', 'Mark this friction as a recurrence of an existing one', (v) => Number(v))
  .option('--db <path>', 'Override database path (default: XDG)')
  .action((opts: Record<string, unknown>) => {
    const recurrenceOfRaw = opts.recurrenceOf;
    let recurrenceOfId: number | undefined;
    if (recurrenceOfRaw !== undefined) {
      if (typeof recurrenceOfRaw !== 'number' || !Number.isInteger(recurrenceOfRaw) || recurrenceOfRaw <= 0) {
        process.stderr.write(`friction-log: --recurrence-of must be a positive integer, got "${String(recurrenceOfRaw)}"\n`);
        process.exit(2);
      }
      recurrenceOfId = recurrenceOfRaw;
    }
    const out = runLog({
      title: opts.title as string,
      description: opts.description as string | undefined,
      tool: opts.tool as string | undefined,
      category: opts.category as string | undefined,
      severity: opts.severity as Severity | undefined,
      sessionId: opts.session as string | undefined,
      recurrenceOfId,
      dbPath: opts.db as string | undefined,
    });
    const recurrenceTag = out.recurrenceOfId != null ? ` recurrence_of=${out.recurrenceOfId}` : '';
    process.stdout.write(`friction id=${out.id} captured_at=${out.capturedAt}${recurrenceTag}\n`);
  });

program
  .command('list')
  .description('List frictions with optional filters.')
  .addOption(new Option('--status <status>', 'Filter by status').choices([...STATUS_CHOICES]))
  .option('--tool <surface>', 'Filter by tool surface')
  .option('--category <name>', 'Filter by category')
  .addOption(new Option('--source <source>', 'Filter by source').choices([...SOURCE_CHOICES]))
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

program
  .command('scan')
  .description('Scan a transcript for candidate frictions and store them.')
  .option('--session <id>', 'Session id (defaults to derivation from --transcript filename)')
  .option('--transcript <path>', 'Path to the transcript file (e.g. ~/.claude/projects/.../<id>.jsonl)')
  .addOption(new Option('--adapter <name>', 'Scanner adapter').choices([...SCANNER_CHOICES]))
  .option('--silent', 'Never throw, exit 0 always (Stop-hook mode)')
  .option('--stdin-payload', 'Read a JSON Stop-hook payload from stdin to derive session+transcript')
  .option('--db <path>', 'Override database path')
  .action(async (opts: Record<string, unknown>) => {
    try {
      let baseInput = {
        sessionId: opts.session as string | undefined,
        transcriptPath: opts.transcript as string | undefined,
        adapter: opts.adapter as string | undefined,
        dbPath: opts.db as string | undefined,
      };
      if (opts.stdinPayload) {
        const payload = await readStdinPayload();
        const derived = payloadToScanInput(payload, baseInput.adapter);
        baseInput = {
          sessionId: derived.sessionId ?? baseInput.sessionId,
          transcriptPath: derived.transcriptPath ?? baseInput.transcriptPath,
          adapter: derived.adapter ?? baseInput.adapter,
          dbPath: baseInput.dbPath,
        };
      }
      const out = await runScan(baseInput);
      if (!opts.silent) {
        process.stdout.write(summarize(out, out.sessionId) + '\n');
      }
    } catch (err) {
      if (opts.silent) {
        process.stderr.write(`friction-log scan (silent): ${(err as Error).message}\n`);
        process.exit(0);
      }
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command('bilanz')
  .description('Format a session-boundary bilanz: tools, frictions, tasks.')
  .option('--session <id>', 'Session id (defaults to most-recent in db)')
  .option('--db <path>', 'Override database path')
  .action(async (opts: Record<string, string>) => {
    try {
      const out = await runBilanz({ sessionId: opts.session, dbPath: opts.db });
      process.stdout.write(out.formatted);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command('rm <frictionId>')
  .description('Delete a friction (and any task rows pointing at it) from the local store.')
  .option('--db <path>', 'Override database path')
  .action((frictionId: string, opts: Record<string, string>) => {
    const id = Number(frictionId);
    if (!Number.isInteger(id) || id <= 0) {
      process.stderr.write(`friction-log: <frictionId> must be a positive integer, got "${frictionId}"\n`);
      process.exit(2);
    }
    try {
      const out = runRm({ frictionId: id, dbPath: opts.db });
      process.stdout.write(`removed friction id=${id} (${out.removed ? 'ok' : 'no-op'})\n`);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command('update <frictionId>')
  .description('Update a friction (status only in M2; more fields in later milestones).')
  .addOption(new Option('--status <status>', 'New status').choices([...STATUS_CHOICES]).makeOptionMandatory(true))
  .option('--db <path>', 'Override database path')
  .action((frictionId: string, opts: Record<string, string>) => {
    const id = Number(frictionId);
    if (!Number.isInteger(id) || id <= 0) {
      process.stderr.write(`friction-log: <frictionId> must be a positive integer, got "${frictionId}"\n`);
      process.exit(2);
    }
    try {
      const out = runUpdate({ frictionId: id, status: opts.status as FrictionStatus, dbPath: opts.db });
      process.stdout.write(`updated friction id=${out.id} status=${out.status}\n`);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command('search <query>')
  .description('Full-text search over title + description (FTS5).')
  .addOption(new Option('--status <status>', 'Filter by status').choices([...STATUS_CHOICES]))
  .option('--tool <surface>', 'Filter by tool surface')
  .option('--category <name>', 'Filter by category')
  .addOption(new Option('--source <source>', 'Filter by source').choices([...SOURCE_CHOICES]))
  .option('--age <span>', 'Only frictions newer than e.g. 14d, 4w, 12h')
  .option('--limit <n>', 'Max rows (default 100)', (v) => Number(v))
  .option('--json', 'Emit JSON instead of a table')
  .option('--db <path>', 'Override database path')
  .action((query: string, opts: Record<string, unknown>) => {
    try {
      const out = runSearch({
        query,
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
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command('digest')
  .description('Aggregations over frictions: counts, open-vs-filed, recurrences, avg hours to triage.')
  .addOption(
    new Option('--group-by <field>', 'Group by field')
      .choices([...DIGEST_GROUP_CHOICES])
      .makeOptionMandatory(true)
  )
  .option('--last <span>', 'Restrict to frictions newer than e.g. 30d, 4w, 12h')
  .option('--json', 'Emit JSON instead of a table')
  .option('--db <path>', 'Override database path')
  .action((opts: Record<string, unknown>) => {
    try {
      const out = runDigest({
        groupBy: opts.groupBy as DigestGroupBy,
        last: opts.last as string | undefined,
        dbPath: opts.db as string | undefined,
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      } else {
        process.stdout.write(formatDigest(out) + '\n');
      }
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command('export')
  .description('Export frictions as JSON, CSV, or Markdown.')
  .addOption(
    new Option('--format <fmt>', 'Output format')
      .choices([...EXPORT_FORMAT_CHOICES])
      .default('json')
  )
  .option('--out <path>', 'Write to a file instead of stdout')
  .option('--query <text>', 'Only export frictions matching an FTS5 query')
  .addOption(new Option('--status <status>', 'Filter by status').choices([...STATUS_CHOICES]))
  .option('--tool <surface>', 'Filter by tool surface')
  .option('--category <name>', 'Filter by category')
  .addOption(new Option('--source <source>', 'Filter by source').choices([...SOURCE_CHOICES]))
  .option('--age <span>', 'Only frictions newer than e.g. 14d, 4w, 12h')
  .option('--limit <n>', 'Max rows (default 100)', (v) => Number(v))
  .option('--db <path>', 'Override database path')
  .action((opts: Record<string, unknown>) => {
    try {
      const out = runExport({
        format: opts.format as ExportFormat,
        out: opts.out as string | undefined,
        query: opts.query as string | undefined,
        status: opts.status as FrictionStatus | undefined,
        tool: opts.tool as string | undefined,
        category: opts.category as string | undefined,
        source: opts.source as FrictionSource | undefined,
        age: opts.age as string | undefined,
        limit: typeof opts.limit === 'number' ? opts.limit : undefined,
        dbPath: opts.db as string | undefined,
      });
      if (out.out) {
        process.stderr.write(`exported ${out.count} records (${out.format}) to ${out.out}\n`);
      } else {
        process.stdout.write(out.rendered);
      }
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

async function readStdinPayload(): Promise<StopHookPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as StopHookPayload;
  } catch {
    return {};
  }
}

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`friction-log: ${err.message}\n`);
  process.exit(1);
});

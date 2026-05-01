import { Command } from 'commander';
import * as fs from 'fs';
import { success, error as outputError } from '../utils/output.js';

interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

interface CoverageSummary {
  total: {
    lines?: CoverageMetric;
    statements?: CoverageMetric;
    functions?: CoverageMetric;
    branches?: CoverageMetric;
  };
}

export interface CoverageResult {
  pct: number;
  lines?: number;
  statements?: number;
  functions?: number;
  branches?: number;
  passed: boolean;
}

export function parseCoverageSummary(json: string, threshold: number): CoverageResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON in coverage file');
  }

  if (!parsed['total']) {
    throw new Error('Coverage file missing "total" key');
  }

  const total = parsed['total'] as CoverageSummary['total'];
  const statements = total.statements?.pct;
  const lines = total.lines?.pct;
  const functions = total.functions?.pct;
  const branches = total.branches?.pct;

  const pct = statements ?? lines;
  if (pct === undefined) {
    throw new Error('Cannot determine coverage percentage (missing statements and lines)');
  }

  return {
    pct,
    lines,
    statements,
    functions,
    branches,
    passed: pct >= threshold,
  };
}

export function registerCoverageCheckCommands(program: Command): void {
  program
    .command('coverage-check')
    .description('Check test coverage against a minimum threshold (per ENGINEERING.md)')
    .option(
      '-i, --input <path>',
      'Path to Vitest coverage-summary.json',
      'coverage/coverage-summary.json',
    )
    .option('-t, --threshold <number>', 'Minimum coverage % required', '80')
    .option('-l, --label <name>', 'Label for output', 'Coverage')
    .option('--json', 'Output as JSON')
    .action((options) => {
      try {
        const threshold = parseFloat(options.threshold);
        if (isNaN(threshold) || threshold < 0 || threshold > 100) {
          outputError('Threshold must be a number between 0 and 100');
          process.exit(1);
        }

        if (!fs.existsSync(options.input)) {
          outputError(`Coverage file not found: ${options.input}`);
          outputError('Run: npm run test:coverage -- --coverage.reporter=json-summary');
          process.exit(1);
        }

        const json = fs.readFileSync(options.input, 'utf-8');
        const result = parseCoverageSummary(json, threshold);

        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          const icon = result.passed ? '✅' : '❌';
          console.log(`\n${icon} ${options.label}: ${result.pct.toFixed(1)}% (threshold: ${threshold}%)`);
          if (result.statements !== undefined) console.log(`   Statements : ${result.statements.toFixed(1)}%`);
          if (result.lines !== undefined)      console.log(`   Lines      : ${result.lines.toFixed(1)}%`);
          if (result.functions !== undefined)  console.log(`   Functions  : ${result.functions.toFixed(1)}%`);
          if (result.branches !== undefined)   console.log(`   Branches   : ${result.branches.toFixed(1)}%`);
          console.log('');
          if (result.passed) {
            success(`${options.label} passes minimum threshold of ${threshold}%`);
          } else {
            outputError(`${options.label} ${result.pct.toFixed(1)}% is below required ${threshold}%`);
          }
        }

        if (!result.passed) process.exit(1);
      } catch (err) {
        outputError(`coverage-check failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

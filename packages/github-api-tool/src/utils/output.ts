import chalk from 'chalk';

export interface OutputOptions {
  json?: boolean;
}

/**
 * Format output as JSON or human-readable table
 */
export function output(data: unknown, options: OutputOptions = {}): void {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    // Human-readable output
    if (Array.isArray(data)) {
      outputTable(data);
    } else if (typeof data === 'object' && data !== null) {
      outputObject(data);
    } else {
      console.log(data);
    }
  }
}

function outputTable(rows: unknown[]): void {
  if (rows.length === 0) {
    console.log(chalk.gray('(no results)'));
    return;
  }

  rows.forEach((row, index) => {
    if (index > 0) console.log(''); // Blank line between rows
    outputObject(row);
  });
}

function outputObject(obj: unknown): void {
  if (typeof obj !== 'object' || obj === null) {
    console.log(obj);
    return;
  }

  const record = obj as Record<string, unknown>;
  Object.entries(record).forEach(([key, value]) => {
    const formattedKey = chalk.cyan(`${key}:`);
    const formattedValue = formatValue(value);
    console.log(`  ${formattedKey} ${formattedValue}`);
  });
}

function formatValue(value: unknown): string {
  if (value === null) return chalk.gray('null');
  if (value === undefined) return chalk.gray('undefined');
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return chalk.yellow(String(value));
  if (typeof value === 'boolean') return chalk.yellow(String(value));
  if (Array.isArray(value)) {
    if (value.length === 0) return chalk.gray('[]');
    return value.map(formatValue).join(', ');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Output success message
 */
export function success(message: string): void {
  console.log(chalk.green('✓'), message);
}

/**
 * Output error message
 */
export function error(message: string, err?: Error): void {
  console.error(chalk.red('✗'), message);
  if (err && err.message) {
    console.error(chalk.gray(err.message));
  }
}

/**
 * Output warning message
 */
export function warn(message: string): void {
  console.log(chalk.yellow('⚠'), message);
}

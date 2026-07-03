import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./errors.js";
import {
  benchmarkTemplate,
  indexTemplate,
  invariantTemplate,
  logTemplate,
  moduleTemplate,
  overviewTemplate,
  runbookTemplate,
} from "./templates.js";

export interface InitOptions {
  force?: boolean;
  /** Test-only override for "now"; production code uses the real clock. */
  now?: () => Date;
}

export interface InitResult {
  targetDir: string;
  filesWritten: string[];
}

/** The exact set of filenames `init` owns: with --force, only these are overwritten, nothing else in the directory is touched. */
const SCAFFOLD_FILENAMES = [
  "index.md",
  "log.md",
  "overview-template.md",
  "module-template.md",
  "invariant-template.md",
  "runbook-template.md",
  "benchmark-template.md",
] as const;

export function runInit(
  targetDir: string,
  options: InitOptions = {},
): InitResult {
  const resolvedDir = path.resolve(targetDir);
  const now = options.now ?? (() => new Date());
  const timestamp = now().toISOString();

  if (fs.existsSync(resolvedDir)) {
    if (!fs.statSync(resolvedDir).isDirectory()) {
      throw new UsageError(
        `Target path exists and is not a directory: ${resolvedDir}`,
      );
    }
    const isNonEmpty = fs.readdirSync(resolvedDir).length > 0;
    if (isNonEmpty && !options.force) {
      throw new UsageError(
        `Target directory is not empty: ${resolvedDir}. Re-run with --force to overwrite the scaffold ` +
          "files okf-kit owns (index.md, log.md, and the *-template.md docs); any other existing files " +
          "are left alone.",
      );
    }
  }

  fs.mkdirSync(resolvedDir, { recursive: true });

  const contentByFilename: Record<(typeof SCAFFOLD_FILENAMES)[number], string> =
    {
      "index.md": indexTemplate(),
      "log.md": logTemplate(timestamp),
      "overview-template.md": overviewTemplate(timestamp),
      "module-template.md": moduleTemplate(timestamp),
      "invariant-template.md": invariantTemplate(timestamp),
      "runbook-template.md": runbookTemplate(timestamp),
      "benchmark-template.md": benchmarkTemplate(timestamp),
    };

  const filesWritten: string[] = [];
  for (const filename of SCAFFOLD_FILENAMES) {
    fs.writeFileSync(
      path.join(resolvedDir, filename),
      contentByFilename[filename],
    );
    filesWritten.push(filename);
  }

  return { targetDir: resolvedDir, filesWritten };
}

export function formatInitSummary(result: InitResult): string {
  const lines = [
    `Scaffolded OKF bundle at ${result.targetDir}:`,
    ...result.filesWritten.map((f) => `  ${f}`),
    "",
    "Next steps:",
    "  - Fill in each *-template.md placeholder and rename it to a real doc name.",
    "  - Replace the `path/to/covered/source` placeholder in each doc's `sources:` list with the",
    "    real repo-root-relative path(s) it describes.",
    "  - Until you do, `okf-kit check` will report those placeholders as missing source paths",
    "    (`sources-shape` errors) whenever it has a repo root to check against (inside a git repo, or",
    "    with --repo-root); that is intentional, not a bug, it flags unwritten sources so you don't",
    "    forget them.",
  ];
  return lines.join("\n") + "\n";
}

import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./errors.js";
import {
  assertNoSymlinkBelow,
  assertRegularOrMissing,
  ensureDirectories,
  findWalkRoot,
  writeFileNoFollow,
} from "./safe-fs.js";
import type { SpecVersion } from "./types.js";
import {
  benchmarkTemplate,
  incidentTemplate,
  indexTemplate,
  invariantTemplate,
  logTemplate,
  moduleTemplate,
  overviewTemplate,
  runbookTemplate,
} from "./templates.js";

export interface InitOptions {
  force?: boolean;
  /**
   * The OKF spec version to scaffold for (CLI: `init --spec v0.1|v0.2`).
   * Undefined means `v0.1`, and a `v0.1` run writes byte-identical output
   * to every okf-kit release before the `--spec` flag existed. `v0.2`
   * additionally declares `okf_version: "0.2"` in the bundle-root index.md
   * and writes a `generated: {by, at}` block instead of `timestamp` in
   * every template doc.
   */
  spec?: SpecVersion;
  /** Test-only override for "now"; production code uses the real clock. */
  now?: () => Date;
  /** Test-only override for the working directory the symlink walk starts from; production code uses `process.cwd()`. */
  cwd?: string;
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
  "incident-template.md",
  "benchmark-template.md",
] as const;

export function runInit(
  targetDir: string,
  options: InitOptions = {},
): InitResult {
  const resolvedDir = path.resolve(targetDir);
  const now = options.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const spec: SpecVersion = options.spec ?? "v0.1";

  // Nothing below is written until every check has passed. The walk refuses a
  // symbolic link at the target or any component below the walk root (the
  // nearest .git ancestor, else the working directory when the target lies
  // under it, else the target's parent), and at every scaffold file; see
  // docs/init.md.
  const walkRoot = findWalkRoot(
    resolvedDir,
    path.resolve(options.cwd ?? process.cwd()),
  );
  assertNoSymlinkBelow(walkRoot, resolvedDir, true);

  if (fs.existsSync(resolvedDir)) {
    if (!fs.statSync(resolvedDir).isDirectory()) {
      throw new UsageError(
        `Target path exists and is not a directory: ${resolvedDir}`,
      );
    }
    for (const filename of SCAFFOLD_FILENAMES) {
      const file = path.join(resolvedDir, filename);
      assertNoSymlinkBelow(walkRoot, file);
      assertRegularOrMissing(file);
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

  ensureDirectories(resolvedDir);

  const contentByFilename: Record<(typeof SCAFFOLD_FILENAMES)[number], string> =
    {
      "index.md": indexTemplate(spec),
      "log.md": logTemplate(timestamp),
      "overview-template.md": overviewTemplate(timestamp, spec),
      "module-template.md": moduleTemplate(timestamp, spec),
      "invariant-template.md": invariantTemplate(timestamp, spec),
      "runbook-template.md": runbookTemplate(timestamp, spec),
      "incident-template.md": incidentTemplate(timestamp, spec),
      "benchmark-template.md": benchmarkTemplate(timestamp, spec),
    };

  const filesWritten: string[] = [];
  for (const filename of SCAFFOLD_FILENAMES) {
    writeFileNoFollow(
      path.join(resolvedDir, filename),
      contentByFilename[filename],
      options.force === true,
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
    "    real repo-root-relative path(s) it describes (the runbook template uses `applies_to:` for",
    "    the same placeholder).",
    "  - Until you do, `okf-kit check` will report those placeholders as missing source paths",
    "    (`sources-shape` errors) whenever it has a repo root to check against (inside a git repo, or",
    "    with --repo-root); that is intentional, not a bug, it flags unwritten sources so you don't",
    "    forget them.",
  ];
  return lines.join("\n") + "\n";
}

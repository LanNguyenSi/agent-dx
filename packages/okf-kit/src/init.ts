import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./errors.js";
import {
  assertScaffoldFileWritable,
  createDirectories,
  resolvePhysicalTarget,
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

  // Nothing below is written until every check has passed. The walk goes
  // from the filesystem root down to the target and refuses a symbolic link at
  // any component (only a link directly in the POSIX root is followed); it
  // returns the physical location, which every later check and write uses. See
  // docs/init.md.
  const located = resolvePhysicalTarget(resolvedDir);
  const physicalDir = located.physical;

  if (located.kind === "other") {
    throw new UsageError(
      `Target path exists and is not a directory: ${resolvedDir}`,
    );
  }
  if (located.kind === "directory") {
    for (const filename of SCAFFOLD_FILENAMES) {
      assertScaffoldFileWritable(path.join(physicalDir, filename));
    }
    const isNonEmpty = fs.readdirSync(physicalDir).length > 0;
    if (isNonEmpty && !options.force) {
      throw new UsageError(
        `Target directory is not empty: ${resolvedDir}. Re-run with --force to overwrite the scaffold ` +
          "files okf-kit owns (index.md, log.md, and the *-template.md docs); any other existing files " +
          "are left alone.",
      );
    }
  }

  createDirectories(located.missing);

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
      path.join(physicalDir, filename),
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

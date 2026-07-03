#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command, CommanderError } from "commander";
import { loadBundle } from "./bundle.js";
import { detectRepoRoot } from "./git.js";
import { allRules } from "./rules/index.js";
import { renderJson, renderText, summarize } from "./report.js";
import type { Finding, RunGit } from "./types.js";

export class UsageError extends Error {}

export interface CheckOptions {
  repoRoot?: string;
  strict?: boolean;
  /** Test-only override for git access; production code shells out to the real `git` binary. */
  runGit?: RunGit;
}

export interface CheckResult {
  bundleDir: string;
  findings: Finding[];
  exitCode: number;
}

export function runCheck(
  bundleDir: string,
  options: CheckOptions = {},
): CheckResult {
  if (!fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) {
    throw new UsageError(`Bundle directory does not exist: ${bundleDir}`);
  }
  const resolvedBundleDir = path.resolve(bundleDir);
  // When --repo-root is omitted, try to find the enclosing git work tree so
  // sources-shape's existence check and sources-fresh's staleness check are
  // active by default for any bundle that lives inside a git repo. A bundle
  // outside any git work tree falls back to the pre-detection behavior
  // (existence check skipped; sources-fresh reports one skip notice).
  const repoRoot = options.repoRoot
    ? path.resolve(options.repoRoot)
    : detectRepoRoot(resolvedBundleDir, options.runGit);
  const ctx = loadBundle(resolvedBundleDir, repoRoot, options.runGit);

  const findings = allRules.flatMap((rule) => rule.run(ctx));
  const summary = summarize(findings);
  const exitCode =
    summary.errors > 0 || (Boolean(options.strict) && summary.warnings > 0)
      ? 1
      : 0;
  return { bundleDir: resolvedBundleDir, findings, exitCode };
}

const program = new Command();

// Route commander's own usage errors (unknown option, missing argument, no
// matching command, ...) through a thrown CommanderError instead of an
// implicit process.exit(1), so they can be told apart from "the bundle has
// findings" (also 1) below. Must be called before `.command()` so the
// subcommand inherits it via copyInheritedSettings; also set explicitly on
// the subcommand for clarity.
program.exitOverride();

program
  .name("okf-kit")
  .description("Validate OKF v0.1 knowledge bundles")
  .version(readVersion());

program
  .command("check <bundleDir>")
  .description("Check a knowledge bundle for OKF structural violations")
  .option(
    "-r, --repo-root <path>",
    "Repo root to verify frontmatter `sources` paths exist under and assess staleness against " +
      "(auto-detected via `git rev-parse --show-toplevel` from the bundle dir when omitted)",
  )
  .option("-j, --json", "Output findings as JSON")
  .option("-s, --strict", "Also fail (exit 1) when warnings are present")
  .exitOverride()
  .action(
    (
      bundleDir: string,
      opts: { repoRoot?: string; json?: boolean; strict?: boolean },
    ) => {
      try {
        const result = runCheck(bundleDir, {
          repoRoot: opts.repoRoot,
          strict: opts.strict,
        });
        const output = opts.json
          ? renderJson(result.bundleDir, result.findings)
          : renderText(result.bundleDir, result.findings);
        process.stdout.write(output);
        process.exit(result.exitCode);
      } catch (err) {
        if (err instanceof UsageError) {
          process.stderr.write(`okf-kit: ${err.message}\n`);
          process.exit(2);
        }
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`okf-kit: ${msg}\n`);
        process.exit(2);
      }
    },
  );

// Commander codes for an explicit `-h`/`--help` or `-V`/`--version` flag:
// keep commander's own exit code (0) for these. Note `commander.help` is
// deliberately NOT in this set: in this commander version that code only
// fires for the "subcommands exist, none given, no action handler" path
// (Command.prototype._parseCommand calling `this.help({ error: true })`),
// which is itself a usage error and must fall through to exit 2 below, not
// be passed through as 0 or 1.
const PASSTHROUGH_EXIT_CODES = new Set([
  "commander.helpDisplayed",
  "commander.version",
]);

program.parseAsync().catch((err) => {
  if (err instanceof CommanderError) {
    if (PASSTHROUGH_EXIT_CODES.has(err.code)) {
      process.exit(err.exitCode);
    }
    // Commander already wrote its own error message to stderr before
    // throwing; a usage error (unknown option, missing argument, missing
    // command, ...) is exit 2, distinct from exit 1 (bundle has findings).
    process.exit(2);
  }
  process.stderr.write(
    `okf-kit: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(2);
});

function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const text = fs.readFileSync(url, "utf8");
    const pkg = JSON.parse(text) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { loadBundle } from "./bundle.js";
import { allRules } from "./rules/index.js";
import { renderJson, renderText, summarize } from "./report.js";
import type { Finding } from "./types.js";

export class UsageError extends Error {}

export interface CheckOptions {
  repoRoot?: string;
  strict?: boolean;
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
  const repoRoot = options.repoRoot
    ? path.resolve(options.repoRoot)
    : undefined;
  const ctx = loadBundle(resolvedBundleDir, repoRoot);

  const findings = allRules.flatMap((rule) => rule.run(ctx));
  const summary = summarize(findings);
  const exitCode =
    summary.errors > 0 || (Boolean(options.strict) && summary.warnings > 0)
      ? 1
      : 0;
  return { bundleDir: resolvedBundleDir, findings, exitCode };
}

const program = new Command();

program
  .name("okf-kit")
  .description("Validate OKF v0.1 knowledge bundles")
  .version(readVersion());

program
  .command("check <bundleDir>")
  .description("Check a knowledge bundle for OKF structural violations")
  .option(
    "-r, --repo-root <path>",
    "Repo root to verify frontmatter `sources` paths exist under",
  )
  .option("-j, --json", "Output findings as JSON")
  .option("-s, --strict", "Also fail (exit 1) when warnings are present")
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

program.parseAsync().catch((err) => {
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

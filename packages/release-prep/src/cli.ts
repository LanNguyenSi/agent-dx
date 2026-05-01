#!/usr/bin/env node
/**
 * Release Prep - Automated Release Preparation Tool
 * Generates changelogs, suggests version bumps, creates releases
 */

import { Command } from "commander";
import chalk from "chalk";
import { runPrep } from "./commands/prep.js";
import { generateChangelog } from "./commands/changelog.js";
import { suggestVersion } from "./commands/version.js";

const program = new Command();

program
  .name("release-prep")
  .description(
    "Automate release preparation with changelog generation and version management",
  )
  .version("0.1.0");

program
  .command("prep")
  .description("Full release preparation (changelog + version + tag + release)")
  .option("-t, --type <type>", "Version bump type (major|minor|patch)")
  .option("-v, --version <version>", "Explicit version (overrides --type)")
  .option("--no-tag", "Don't create git tag")
  .option("--no-release", "Don't create GitHub release")
  .option("-d, --dry-run", "Show what would be done without doing it")
  .action(async (options) => {
    try {
      await runPrep(options);
    } catch (error) {
      console.error(
        chalk.red("✗ Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("changelog")
  .description("Generate changelog only (from last tag to HEAD)")
  .option("-o, --output <file>", "Write to file (default: stdout)")
  .option("-f, --format <format>", "Format: markdown|json", "markdown")
  .action(async (options) => {
    try {
      await generateChangelog(options);
    } catch (error) {
      console.error(
        chalk.red("✗ Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("version")
  .description("Suggest next version based on commits")
  .action(async () => {
    try {
      await suggestVersion();
    } catch (error) {
      console.error(
        chalk.red("✗ Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

await program.parseAsync();

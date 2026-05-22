#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { renderSummary } from "./render.js";
import { federatedSearch } from "./search.js";
import { runSetup } from "./setup.js";

const program = new Command();

program
  .name("pattern-scout")
  .description(
    "Federated pattern search across opensrc-cached exemplar repos and your codebase-oracle index",
  )
  .version(readVersion());

program
  .command("search <query>")
  .description("Search exemplar repos and your codebase in parallel")
  .option(
    "-p, --pattern <regex>",
    "Regex for the exemplar side (default: the query as a literal)",
  )
  .option("-k, --limit <n>", "Max results per source", "15")
  .option("-r, --repo <name>", "Restrict to repos whose name contains this substring")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .option("-c, --config <file>", "Path to a pattern-scout.config.json")
  .option("--exemplars-only", "Skip the codebase-oracle source")
  .action(async (query: string, opts: unknown) => {
    try {
      await runSearch(query, opts);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("setup")
  .description("Fetch the default exemplar repos into the opensrc cache")
  .option("-c, --config <file>", "Path to a pattern-scout.config.json")
  .action(async (opts: unknown) => {
    try {
      await runSetupCommand(opts);
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync().catch(fail);

interface SearchOpts {
  pattern?: string;
  limit: string;
  repo?: string;
  format: string;
  config?: string;
  exemplarsOnly?: boolean;
}

async function runSearch(query: string, raw: unknown): Promise<void> {
  const opts = raw as SearchOpts;
  const config = loadConfig(opts.config);
  const limit = Number.parseInt(opts.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive integer, got "${opts.limit}"`);
  }
  const summary = await federatedSearch(config, {
    query,
    pattern: opts.pattern,
    limit,
    repo: opts.repo,
    exemplarsOnly: Boolean(opts.exemplarsOnly),
  });
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write(renderSummary(summary) + "\n");
  }
}

async function runSetupCommand(raw: unknown): Promise<void> {
  const opts = raw as { config?: string };
  const config = loadConfig(opts.config);
  process.stdout.write(
    `pattern-scout: fetching ${config.defaultRepos.length} exemplar repo(s)...\n`,
  );
  const results = await runSetup(config);
  for (const result of results) {
    const flag = result.ok ? "ok  " : "FAIL";
    process.stdout.write(`  ${flag} ${result.spec}: ${result.detail}\n`);
  }
  const failed = results.filter((r) => !r.ok).length;
  const fetched = results.length - failed;
  process.stdout.write(
    `\n${fetched}/${results.length} fetched` +
      (failed > 0 ? `, ${failed} failed\n` : "\n"),
  );
  // Non-zero exit so a CI step or harness invoking `setup` can detect that
  // some specs did not fetch, without parsing stdout.
  if (failed > 0) {
    process.exitCode = 1;
  }
}

function fail(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pattern-scout: ${msg}\n`);
  process.exit(1);
}

function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(url, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { Command } from "commander";
import { checkPath, checkText, summarize } from "./engine.js";
import { defaultConfig, loadConfig } from "./config.js";
import { allPacks, packsByFilter } from "./packs/registry.js";
import { renderText } from "./cli-render.js";
import type { CheckSummary } from "./types.js";

const program = new Command();

program
  .name("slop-detector")
  .description("Configurable AI-slop linter for PRs and content")
  .version(readVersion());

program
  .command("check [paths...]")
  .description(
    "Scan one or more files/directories, or stdin (use '-' or omit every path), for slop",
  )
  .option("-c, --config <file>", "Path to slop.config.yml / .json")
  .option(
    "-p, --pack <pack>",
    // Repeatable single-value option, not a variadic
    // `<packs...>`: a variadic option greedily consumes every
    // following bare token, including this same command's positional
    // `[paths...]`, so `check --pack review-slop fileA fileB` would
    // swallow `fileA`/`fileB` as pack names instead of scanning them.
    // `-p a -p b`, or a single `-p a,b` (still comma-split below),
    // both still work; only the bare-space-separated `-p a b` form
    // (never documented or tested) is gone.
    "Only run this pack (comma-separated for more than one); repeat -p/--pack for more",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .option("--explain", "Print rule rationale alongside each violation")
  .option(
    "--stdin-path <path>",
    "Filename to assume when reading stdin (no positional path given)",
    "<stdin>",
  )
  .action(async (rawPaths: string[], opts, command: Command) => {
    try {
      await runCheck(rawPaths, opts, command);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`slop-detector: ${msg}\n`);
      process.exit(2);
    }
  });

program
  .command("list-rules")
  .description(
    "List all rules with their pack, default severity, and rationale",
  )
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action((opts) => {
    const rows = allPacks.flatMap((pack) =>
      pack.rules.map((r) => ({
        rule: r.id,
        pack: r.pack,
        defaultSeverity: r.defaultSeverity,
        enabledByDefault: r.enabledByDefault,
        rationale: r.rationale,
      })),
    );
    if (opts.format === "json") {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      return;
    }
    for (const row of rows) {
      const flag = row.enabledByDefault ? "on" : "off";
      process.stdout.write(
        `${row.rule}\t${row.defaultSeverity}\t${flag}\t${row.rationale}\n`,
      );
    }
  });

program.parseAsync().catch((err) => {
  process.stderr.write(
    `slop-detector: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(2);
});

interface CheckOpts {
  config?: string;
  pack?: string[];
  format: "text" | "json";
  explain?: boolean;
  stdinPath: string;
}

async function runCheck(
  rawPaths: string[],
  rawOpts: unknown,
  command: Command,
): Promise<void> {
  const opts = normalizeOpts(rawOpts);
  const config = opts.config ? loadConfig(opts.config) : defaultConfig();
  const packFilter = opts.pack && opts.pack.length > 0 ? opts.pack : undefined;
  const packs = packsByFilter(packFilter);

  // "-" (or no positional at all) means stdin. Anything else is a real
  // path list; mixing a real path with `--stdin-path` is a usage error
  // rather than a silent no-op, since `--stdin-path` only has an
  // effect on the stdin branch below and a caller who passed both almost
  // certainly meant to scan the path, not stdin.
  const wantsStdin = rawPaths.length === 0 || rawPaths.every((p) => p === "-");
  const stdinPathExplicit =
    command.getOptionValueSource("stdinPath") !== "default";
  if (!wantsStdin && stdinPathExplicit) {
    throw new Error(
      `--stdin-path only applies when reading stdin (no path given, or "-"); got both --stdin-path and ${rawPaths.length} path(s): ${rawPaths.join(", ")}`,
    );
  }

  let summary: CheckSummary;
  if (wantsStdin) {
    if (process.stdin.isTTY) {
      throw new Error(
        "no path given and stdin is a TTY (nothing piped in) -- pass a path, or pipe content in, e.g. `git log -1 --format=%B | slop-detector check --stdin-path COMMIT_MSG`",
      );
    }
    const text = await readStdin();
    const violations = checkText(text, opts.stdinPath, {
      packs,
      config,
      packFilter,
    });
    summary = summarize(violations, 1);
  } else {
    // One CheckSummary per path, so a directory-vs-file scan root is
    // still resolved per path exactly as `checkPath` already does for a
    // single target, then merged: `filesScanned` sums, violations and any
    // warnings concatenate, and `summarize` recomputes the block/warn/info
    // counts over the combined violation list.
    const perPath: CheckSummary[] = [];
    for (const rawPath of rawPaths) {
      if (!fs.existsSync(rawPath)) {
        throw new Error(`Path does not exist: ${rawPath}`);
      }
      perPath.push(checkPath(rawPath, { packs, config, packFilter }));
    }
    const violations = perPath.flatMap((s) => s.violations);
    const filesScanned = perPath.reduce((sum, s) => sum + s.filesScanned, 0);
    summary = summarize(violations, filesScanned);
    const warnings = perPath.flatMap((s) => s.warnings ?? []);
    if (warnings.length > 0) summary.warnings = warnings;
  }

  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write(renderText(summary, opts.explain ?? false));
  }
  process.exit(summary.blockCount > 0 ? 1 : 0);
}

function normalizeOpts(raw: unknown): CheckOpts {
  const r = raw as Record<string, unknown>;
  const packs = Array.isArray(r.pack)
    ? (r.pack as string[]).flatMap((s) =>
        s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      )
    : undefined;
  return {
    config: typeof r.config === "string" ? r.config : undefined,
    pack: packs && packs.length > 0 ? packs : undefined,
    format: r.format === "json" ? "json" : "text",
    explain: Boolean(r.explain),
    stdinPath: typeof r.stdinPath === "string" ? r.stdinPath : "<stdin>",
  };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

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

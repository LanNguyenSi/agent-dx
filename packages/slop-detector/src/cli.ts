#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { Command } from "commander";
import { checkPath, checkText, summarize } from "./engine.js";
import { defaultConfig, loadConfig } from "./config.js";
import { allPacks, packsByFilter } from "./packs/registry.js";
import type { CheckSummary, Severity } from "./types.js";

const program = new Command();

program
  .name("slop-detector")
  .description("Configurable AI-slop linter for PRs and content")
  .version(readVersion());

program
  .command("check [path]")
  .description("Scan a file, directory, or stdin (use '-' or omit path) for slop")
  .option("-c, --config <file>", "Path to slop.config.yml / .json")
  .option("-p, --pack <packs...>", "Only run these packs (comma- or space-separated)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .option("--explain", "Print rule rationale alongside each violation")
  .option("--stdin-path <path>", "Filename to assume when reading stdin", "<stdin>")
  .action(async (rawPath: string | undefined, opts) => {
    try {
      await runCheck(rawPath, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`slop-detector: ${msg}\n`);
      process.exit(2);
    }
  });

program
  .command("list-rules")
  .description("List all rules with their pack, default severity, and rationale")
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
      process.stdout.write(`${row.rule}\t${row.defaultSeverity}\t${flag}\t${row.rationale}\n`);
    }
  });

program.parseAsync().catch((err) => {
  process.stderr.write(`slop-detector: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});

interface CheckOpts {
  config?: string;
  pack?: string[];
  format: "text" | "json";
  explain?: boolean;
  stdinPath: string;
}

async function runCheck(rawPath: string | undefined, rawOpts: unknown): Promise<void> {
  const opts = normalizeOpts(rawOpts);
  const config = opts.config ? loadConfig(opts.config) : defaultConfig();
  const packFilter = opts.pack && opts.pack.length > 0 ? opts.pack : undefined;
  const packs = packsByFilter(packFilter);

  let summary: CheckSummary;
  if (!rawPath || rawPath === "-") {
    const text = await readStdin();
    const violations = checkText(text, opts.stdinPath, { packs, config, packFilter });
    summary = summarize(violations, 1);
  } else {
    if (!fs.existsSync(rawPath)) {
      throw new Error(`Path does not exist: ${rawPath}`);
    }
    summary = checkPath(rawPath, { packs, config, packFilter });
  }

  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    renderText(summary, opts.explain ?? false);
  }
  process.exit(summary.blockCount > 0 ? 1 : 0);
}

function normalizeOpts(raw: unknown): CheckOpts {
  const r = raw as Record<string, unknown>;
  const packs = Array.isArray(r.pack)
    ? (r.pack as string[]).flatMap((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
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

function renderText(summary: CheckSummary, explain: boolean): void {
  const out = process.stdout;
  if (summary.violations.length === 0) {
    out.write(`slop-detector: clean (${summary.filesScanned} files scanned)\n`);
    return;
  }
  const byFile = groupBy(summary.violations, (v) => v.path);
  for (const [filePath, vs] of byFile) {
    out.write(`\n${filePath}\n`);
    for (const v of vs) {
      const sev = severityLabel(v.severity);
      out.write(`  ${sev} ${v.line}:${v.column}  ${v.ruleId}  ${v.message}\n`);
      if (explain) {
        out.write(`    ↪ ${v.rationale}\n`);
      }
    }
  }
  out.write(
    `\n${summary.filesScanned} files scanned, ${summary.violations.length} violations (block ${summary.blockCount}, warn ${summary.warnCount}, info ${summary.infoCount})\n`,
  );
}

function severityLabel(s: Severity): string {
  switch (s) {
    case "block":
      return "BLOCK";
    case "warn":
      return "WARN ";
    case "info":
      return "INFO ";
  }
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
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


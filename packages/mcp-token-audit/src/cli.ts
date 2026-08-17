#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { Command } from "commander";
import { auditFiles } from "./audit.js";
import { defaultProjectDirs, findTranscriptFiles } from "./discover.js";
import { renderJson, renderText } from "./render.js";

const program = new Command();

program
  .name("mcp-token-audit")
  .description(
    "Rank tool calls in Claude Code transcripts by approximate token cost (chars/4), per tool name, with an mcp__* share of the total",
  )
  .version(readVersion())
  .argument(
    "[projectDirs...]",
    "Project directories to scan (each holding *.jsonl transcripts); default: every ~/.claude/projects/* directory",
    [],
  )
  .option(
    "-d, --days <number>",
    "Only include transcripts modified in the last N days",
  )
  .option("--json", "Output machine-readable JSON instead of a text table")
  .action(
    (projectDirsArg: string[], opts: { days?: string; json?: boolean }) => {
      try {
        const projectDirs =
          projectDirsArg.length > 0 ? projectDirsArg : defaultProjectDirs();
        const days = opts.days === undefined ? undefined : parseDays(opts.days);
        const { files, skippedDirs } = findTranscriptFiles(projectDirs, days);
        const result = auditFiles(files, skippedDirs);
        process.stdout.write(
          opts.json ? renderJson(result) : renderText(result),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`mcp-token-audit: ${msg}\n`);
        process.exit(2);
      }
    },
  );

program.parse();

function parseDays(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--days expects a positive number, got "${raw}"`);
  }
  return n;
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

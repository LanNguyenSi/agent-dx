// Pure tool logic for the slop-detector MCP server. Kept separate from the
// stdio transport wiring in `mcp.ts` so it can be unit-tested without
// opening a server (importing `mcp.ts` would run `main()` and block on the
// stdio transport).

import fs from "node:fs";
import { checkPath, checkText, summarize } from "./engine.js";
import { defaultConfig, loadConfig } from "./config.js";
import { packsByFilter } from "./packs/registry.js";
import type { CheckSummary, Severity, Violation } from "./types.js";

export interface SlopCheckInput {
  /** In-memory string to scan. Mutually exclusive with `path`. */
  text?: string;
  /** File or directory path to scan. Mutually exclusive with `text`. */
  path?: string;
  /** Filename to assume for `text` input (drives prose-vs-code detection). */
  filename?: string;
  /** Restrict to these rule packs; off-by-default packs only run when named. */
  packs?: string[];
  /** Path to a slop.config.yml / .json; defaults to the built-in config. */
  configPath?: string;
}

/**
 * Run a slop scan over an in-memory string (`text`) or a file/directory
 * (`path`). Exactly one of `text` / `path` must be provided. Mirrors the
 * config + pack resolution of the `slop-detector check` CLI.
 */
export function runSlopCheck(input: SlopCheckInput): CheckSummary {
  if (input.text !== undefined && input.path !== undefined) {
    throw new Error("slop_check: pass either `text` or `path`, not both");
  }
  const config = input.configPath
    ? loadConfig(input.configPath)
    : defaultConfig();
  const packFilter =
    input.packs && input.packs.length > 0 ? input.packs : undefined;
  const packs = packsByFilter(packFilter);

  if (input.text !== undefined) {
    const violations = checkText(input.text, input.filename ?? "input.md", {
      packs,
      config,
      packFilter,
    });
    return summarize(violations, 1);
  }
  if (input.path !== undefined) {
    if (!fs.existsSync(input.path)) {
      throw new Error(`slop_check: path does not exist: ${input.path}`);
    }
    return checkPath(input.path, { packs, config, packFilter });
  }
  throw new Error("slop_check: one of `text` or `path` is required");
}

const SEVERITY_LABEL: Record<Severity, string> = {
  block: "BLOCK",
  warn: "WARN ",
  info: "INFO ",
};

/**
 * Render a CheckSummary as the human-readable text the `slop_check` MCP
 * tool returns: violations grouped by file, then a one-line tally. Matches
 * the shape of the CLI's text output.
 */
export function renderSummary(summary: CheckSummary): string {
  if (summary.violations.length === 0) {
    return `slop-detector: clean (${summary.filesScanned} file(s) scanned)`;
  }
  const byFile = new Map<string, Violation[]>();
  for (const v of summary.violations) {
    const arr = byFile.get(v.path);
    if (arr) arr.push(v);
    else byFile.set(v.path, [v]);
  }
  const lines: string[] = [];
  for (const [filePath, vs] of byFile) {
    lines.push(filePath);
    for (const v of vs) {
      lines.push(
        `  ${SEVERITY_LABEL[v.severity]} ${v.line}:${v.column}  ${v.ruleId}  ${v.message}`,
      );
    }
  }
  lines.push(
    `${summary.filesScanned} file(s) scanned, ${summary.violations.length} violation(s) ` +
      `(block ${summary.blockCount}, warn ${summary.warnCount}, info ${summary.infoCount})`,
  );
  return lines.join("\n");
}

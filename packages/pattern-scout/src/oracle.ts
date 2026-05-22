import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { oneLine, splitCommand, truncate } from "./util.js";
import type { SearchResult } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Parse `codebase-oracle search` text output. Each hit is a header line
 * `--- <filePath>[:<lineStart>[-<lineEnd>]] (<repo>) ---` followed by the
 * chunk content until the next header.
 */
export function parseOracleSearch(stdout: string): SearchResult[] {
  const results: SearchResult[] = [];
  let current: { location: string; repo: string; body: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const { path, line } = splitLocation(current.location);
    results.push({
      kind: "ours",
      source: current.repo,
      path,
      line,
      snippet: truncate(current.body.join(" ").replace(/\s+/g, " ").trim(), 200),
    });
  };

  for (const raw of stdout.split("\n")) {
    const header = /^---\s+(.+?)\s+\(([^()]+)\)\s+---\s*$/.exec(raw);
    if (header) {
      flush();
      current = { location: header[1], repo: header[2], body: [] };
      continue;
    }
    if (current) current.body.push(raw);
  }
  flush();
  return results;
}

/** Split an oracle location into a file path and a 1-indexed line (0 if absent). */
function splitLocation(location: string): { path: string; line: number } {
  const match = /^(.*):(\d+)(?:-\d+)?$/.exec(location);
  if (match) return { path: match[1], line: Number.parseInt(match[2], 10) };
  return { path: location, line: 0 };
}

export interface OracleSearchOptions {
  limit: number;
  repoFilter?: string;
  /** Working directory for the oracle command (so it can load its `.env`). */
  cwd?: string;
}

export interface OracleSearchOutcome {
  results: SearchResult[];
  ok: boolean;
  detail: string;
}

/**
 * Search our repos via the `codebase-oracle search` CLI. This source is
 * optional: any failure (binary missing, non-zero exit) is captured as an
 * `ok: false` outcome so a federated search still returns exemplar hits.
 */
export async function searchOracle(
  oracleCommand: string,
  query: string,
  options: OracleSearchOptions,
): Promise<OracleSearchOutcome> {
  const [bin, ...prefix] = splitCommand(oracleCommand);
  const args = [...prefix, "search", query, "-k", String(options.limit)];
  if (options.repoFilter) args.push("-r", options.repoFilter);

  try {
    const { stdout } = await execFileAsync(bin, args, {
      maxBuffer: 8 * 1024 * 1024,
      cwd: options.cwd,
    });
    const results = parseOracleSearch(stdout);
    return {
      results,
      ok: true,
      detail: `${results.length} hit(s) via \`${bin} search\``,
    };
  } catch (err) {
    return { results: [], ok: false, detail: describeError(err, bin) };
  }
}

function describeError(err: unknown, bin: string): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string };
  // A string `code` (ENOENT, EACCES, ...) is a spawn-level failure: the
  // binary could not be run at all. A numeric `code` means it ran and
  // exited non-zero.
  if (e && typeof e.code === "string") {
    return `\`${bin}\` could not be run (${e.code}); set oracleCommand in config or skip the oracle source`;
  }
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  const message = stderr || (err instanceof Error ? err.message : String(err));
  return `\`${bin} search\` failed: ${truncate(oneLine(message), 160)}`;
}

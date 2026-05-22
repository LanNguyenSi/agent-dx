import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { escapeRegExp, splitCommand, truncate } from "./util.js";
import { walkTextFiles } from "./walk.js";
import type { SearchResult } from "./types.js";

const execFileAsync = promisify(execFile);

/** An opensrc-cached repo: a short name and the absolute path to its source. */
export interface CachedRepo {
  name: string;
  path: string;
}

/** A compiled exemplar-side matcher plus a label describing how it searches. */
export interface Matcher {
  regex: RegExp;
  describe: string;
}

/**
 * Build the matcher used against exemplar repos. With an explicit `pattern`
 * the term is a case-insensitive regex; otherwise the natural-language
 * `query` is matched as a case-insensitive literal substring. The asymmetry
 * is deliberate: codebase-oracle answers `query` semantically, opensrc repos
 * are searched lexically.
 */
export function buildMatcher(query: string, pattern?: string): Matcher {
  if (pattern !== undefined && pattern !== "") {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid --pattern regex: ${msg}`);
    }
    return { regex, describe: `regex /${pattern}/i` };
  }
  if (query === "") {
    throw new Error("Search query is empty");
  }
  return {
    regex: new RegExp(escapeRegExp(query), "i"),
    describe: `substring "${query}"`,
  };
}

/**
 * Parse `opensrc list` output into cached repos. Each entry carries a
 * 4-space-indented `Path: <abs>` line; the short repo name is the path's
 * second-to-last segment (`.../github.com/<owner>/<repo>/<version>`).
 */
export function parseOpensrcList(stdout: string): CachedRepo[] {
  const repos: CachedRepo[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s+Path:\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const repoPath = match[1];
    const segments = repoPath.split("/").filter(Boolean);
    const name =
      segments.length >= 2 ? segments[segments.length - 2] : repoPath;
    repos.push({ name, path: repoPath });
  }
  return repos;
}

/** Run `opensrc list` and return the cached repos. */
export async function listCachedRepos(
  opensrcCommand: string,
): Promise<CachedRepo[]> {
  const [bin, ...prefix] = splitCommand(opensrcCommand);
  const { stdout } = await execFileAsync(bin, [...prefix, "list"], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseOpensrcList(stdout);
}

/** Hard cap on files walked per repo, guarding against pathological trees. */
const MAX_FILES_PER_REPO = 8000;

export interface ExemplarSearchOptions {
  /** Maximum number of results to collect across all repos. */
  limit: number;
  /** Restrict to cached repos whose name contains this substring. */
  repoFilter?: string;
}

/**
 * Search the source of opensrc-cached repos line by line. Each repo is
 * scanned independently (up to `limit` hits), then results are interleaved
 * round-robin so a broad query spreads across exemplars instead of filling
 * up entirely from whichever repo opensrc happened to list first.
 * Synchronous: the work is local file IO, and the caller overlaps it with
 * the oracle subprocess via `Promise.all`.
 */
export function searchCachedRepos(
  repos: CachedRepo[],
  matcher: Matcher,
  options: ExemplarSearchOptions,
): SearchResult[] {
  const filter = options.repoFilter;
  const selected = filter
    ? repos.filter((r) => r.name.includes(filter))
    : repos;

  const buckets: SearchResult[][] = [];
  for (const repo of selected) {
    const bucket: SearchResult[] = [];
    for (const file of walkTextFiles(repo.path, {
      maxFiles: MAX_FILES_PER_REPO,
    })) {
      if (bucket.length >= options.limit) break;
      let content: string;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const fileLines = content.split("\n");
      for (let i = 0; i < fileLines.length; i += 1) {
        if (bucket.length >= options.limit) break;
        if (matcher.regex.test(fileLines[i])) {
          bucket.push({
            kind: "exemplar",
            source: repo.name,
            path: file,
            line: i + 1,
            snippet: truncate(fileLines[i].trim(), 200),
          });
        }
      }
    }
    buckets.push(bucket);
  }

  return interleave(buckets, options.limit);
}

/** Round-robin merge of per-repo result buckets, truncated to `limit`. */
function interleave(buckets: SearchResult[][], limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const maxLen = buckets.reduce((m, b) => Math.max(m, b.length), 0);
  for (let i = 0; i < maxLen && results.length < limit; i += 1) {
    for (const bucket of buckets) {
      if (i < bucket.length) {
        results.push(bucket[i]);
        if (results.length >= limit) break;
      }
    }
  }
  return results;
}

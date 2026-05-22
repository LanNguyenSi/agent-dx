import {
  buildMatcher,
  listCachedRepos,
  searchCachedRepos,
  type Matcher,
} from "./opensrc.js";
import { searchOracle } from "./oracle.js";
import { oneLine, truncate } from "./util.js";
import type {
  ResolvedConfig,
  SearchResult,
  SearchSummary,
  SourceStatus,
} from "./types.js";

export interface FederatedSearchOptions {
  /** Natural-language query; drives the codebase-oracle semantic search. */
  query: string;
  /** Optional regex for the exemplar (opensrc) side; defaults to the `query` literal. */
  pattern?: string;
  /** Max results per source. */
  limit?: number;
  /** Restrict both sources to a repo whose name contains this substring. */
  repo?: string;
  /** Skip the codebase-oracle source entirely. */
  exemplarsOnly?: boolean;
}

const DEFAULT_LIMIT = 15;

interface SideOutcome {
  results: SearchResult[];
  status: SourceStatus;
}

/**
 * Run a federated pattern search: the opensrc exemplar repos and the
 * codebase-oracle index are queried in parallel and merged into one
 * source-tagged result set. Neither source failing aborts the other.
 */
export async function federatedSearch(
  config: ResolvedConfig,
  options: FederatedSearchOptions,
): Promise<SearchSummary> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const matcher = buildMatcher(options.query, options.pattern);

  const exemplarSide = runExemplarSide(config, matcher, options.repo, limit);
  const oracleSide: Promise<SideOutcome> = options.exemplarsOnly
    ? Promise.resolve({
        results: [],
        status: {
          name: "oracle",
          ok: true,
          detail: "skipped (--exemplars-only)",
        },
      })
    : runOracleSide(config, options.query, options.repo, limit);

  const [exemplar, oracle] = await Promise.all([exemplarSide, oracleSide]);
  const results = [...exemplar.results, ...oracle.results];

  return {
    query: options.query,
    pattern: options.pattern,
    results,
    exemplarCount: exemplar.results.length,
    oursCount: oracle.results.length,
    sources: [exemplar.status, oracle.status],
  };
}

async function runExemplarSide(
  config: ResolvedConfig,
  matcher: Matcher,
  repoFilter: string | undefined,
  limit: number,
): Promise<SideOutcome> {
  try {
    const repos = await listCachedRepos(config.opensrcCommand);
    if (repos.length === 0) {
      return {
        results: [],
        status: {
          name: "opensrc",
          ok: true,
          detail: "no cached repos; run `pattern-scout setup`",
        },
      };
    }
    const results = searchCachedRepos(repos, matcher, { limit, repoFilter });
    return {
      results,
      status: {
        name: "opensrc",
        ok: true,
        detail: `${results.length} hit(s) across ${repos.length} cached repo(s), ${matcher.describe}`,
      },
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const detail =
      e && typeof e.code === "string"
        ? `\`${config.opensrcCommand}\` could not be run (${e.code}); install opensrc from https://github.com/vercel-labs/opensrc`
        : `opensrc source failed: ${truncate(
            oneLine(err instanceof Error ? err.message : String(err)),
            160,
          )}`;
    return { results: [], status: { name: "opensrc", ok: false, detail } };
  }
}

async function runOracleSide(
  config: ResolvedConfig,
  query: string,
  repoFilter: string | undefined,
  limit: number,
): Promise<SideOutcome> {
  const outcome = await searchOracle(config.oracleCommand, query, {
    limit,
    repoFilter,
    cwd: config.oracleCwd,
  });
  return {
    results: outcome.results,
    status: { name: "oracle", ok: outcome.ok, detail: outcome.detail },
  };
}

export type {
  Relevance,
  ResolvedConfig,
  SearchResult,
  SearchSummary,
  SourceKind,
  SourceStatus,
} from "./types.js";

export {
  DEFAULT_REPOS,
  defaultConfig,
  loadConfig,
  mergeConfig,
} from "./config.js";
export type { ConfigFile } from "./config.js";

export { federatedSearch } from "./search.js";
export type { FederatedSearchOptions } from "./search.js";

export { renderSummary } from "./render.js";

export { runSetup } from "./setup.js";
export type { SetupResult } from "./setup.js";

export {
  buildMatcher,
  listCachedRepos,
  parseOpensrcList,
  searchCachedRepos,
} from "./opensrc.js";
export type {
  CachedRepo,
  ExemplarSearchOptions,
  Matcher,
} from "./opensrc.js";

export { parseOracleSearch, searchOracle } from "./oracle.js";
export type { OracleSearchOptions, OracleSearchOutcome } from "./oracle.js";

export { walkTextFiles } from "./walk.js";
export type { WalkOptions } from "./walk.js";

export {
  classifyMatchLine,
  classifyPath,
  exemplarRelevance,
  oracleRelevance,
} from "./relevance.js";
export type { MatchContext, PathCategory } from "./relevance.js";

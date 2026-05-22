/** Which corpus a result came from. */
export type SourceKind = "exemplar" | "ours";

/** A single search hit, normalised across both federated sources. */
export interface SearchResult {
  kind: SourceKind;
  /** Repo name: an opensrc-cached repo (e.g. "zod") or one of our repos (e.g. "agent-tasks"). */
  source: string;
  /** File path. Absolute for exemplar hits, as reported by the oracle for "ours" hits. */
  path: string;
  /** 1-indexed line number, or 0 when the source does not report one. */
  line: number;
  /** The matching line (exemplar) or chunk excerpt (oracle), trimmed. */
  snippet: string;
  /**
   * Similarity score, present only when the source reports one. The
   * `codebase-oracle search` CLI does not currently emit scores, so this is
   * reserved for a future oracle revision.
   */
  score?: number;
}

/** Health of one federated source for a given search. */
export interface SourceStatus {
  name: "opensrc" | "oracle";
  ok: boolean;
  /** Human-readable detail: what was searched, or why the source was skipped. */
  detail: string;
}

/** The merged result of a federated search. */
export interface SearchSummary {
  query: string;
  /** The regex used against exemplar repos, when one was supplied. */
  pattern?: string;
  results: SearchResult[];
  exemplarCount: number;
  oursCount: number;
  sources: SourceStatus[];
}

/** Resolved runtime configuration. */
export interface ResolvedConfig {
  /** opensrc specs fetched by `pattern-scout setup`. */
  defaultRepos: string[];
  /** Command used to invoke opensrc; whitespace-split into argv. */
  opensrcCommand: string;
  /** Command used to invoke codebase-oracle; whitespace-split into argv. */
  oracleCommand: string;
  /**
   * Working directory for the codebase-oracle command. codebase-oracle loads
   * its config (`ORACLE_*` env, scan root) from a `.env` in its working
   * directory, so this should point at a codebase-oracle checkout. When
   * unset, the oracle command inherits pattern-scout's working directory.
   */
  oracleCwd?: string;
}

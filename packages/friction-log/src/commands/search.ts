import { FrictionDb, type ListFrictionsFilter } from '../db.js';
import { defaultDbPath } from '../paths.js';
import type { Friction, FrictionSource, FrictionStatus } from '../types.js';
import { parseAge } from './list.js';

export interface SearchCommandInput {
  query: string;
  status?: FrictionStatus;
  tool?: string;
  category?: string;
  source?: FrictionSource;
  age?: string;
  limit?: number;
  dbPath?: string;
}

export interface SearchCommandOutput {
  frictions: Friction[];
}

export function runSearch(input: SearchCommandInput): SearchCommandOutput {
  if (!input.query || !input.query.trim()) {
    throw new Error('friction-log: search query must not be empty');
  }
  const db = new FrictionDb(input.dbPath ?? defaultDbPath());
  try {
    const filter: ListFrictionsFilter = {
      status: input.status,
      tool: input.tool,
      category: input.category,
      source: input.source,
      sinceIso: parseAge(input.age),
      limit: input.limit,
    };
    try {
      return { frictions: db.searchFrictions(input.query, filter) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // better-sqlite3 surfaces FTS5 parse failures as opaque SQLite errors
      // ("unterminated string", "fts5: syntax error near ...", etc). The
      // surrounding query is parameterized, so any error here is the user's
      // MATCH expression. Turn it into a hint pointing at the FTS5 docs.
      if (/fts5|MATCH|unterminated|syntax error|near "/i.test(msg)) {
        throw new Error(
          `friction-log: invalid FTS5 query "${input.query}". See https://sqlite.org/fts5.html#full_text_query_syntax`
        );
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

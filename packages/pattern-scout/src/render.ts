import type { SearchResult, SearchSummary } from "./types.js";

/** Render a federated search summary as human-readable text. */
export function renderSummary(summary: SearchSummary): string {
  const lines: string[] = [];
  const patternNote = summary.pattern ? ` (pattern: /${summary.pattern}/i)` : "";
  lines.push(`pattern-scout: "${summary.query}"${patternNote}`);
  lines.push("");
  lines.push(
    renderGroup(
      "exemplars (opensrc)",
      summary.results.filter((r) => r.kind === "exemplar"),
    ),
  );
  lines.push("");
  lines.push(
    renderGroup(
      "ours (codebase-oracle)",
      summary.results.filter((r) => r.kind === "ours"),
    ),
  );
  lines.push("");
  lines.push("sources:");
  for (const source of summary.sources) {
    const flag = source.ok ? "ok" : "unavailable";
    lines.push(`  ${source.name}: ${flag} (${source.detail})`);
  }
  return lines.join("\n");
}

function renderGroup(title: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `${title}: no matches`;
  }
  const lines = [`${title}: ${results.length} match(es)`];
  for (const result of results) {
    const location =
      result.line > 0 ? `${result.path}:${result.line}` : result.path;
    const score =
      result.score !== undefined ? ` [${result.score.toFixed(3)}]` : "";
    lines.push(`  ${result.source}  ${location}${score}`);
    lines.push(`    ${result.snippet}`);
    lines.push(`    why: ${result.relevance.reason}`);
  }
  return lines.join("\n");
}

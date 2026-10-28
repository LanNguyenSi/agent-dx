import { analyzeCitationDrift, describeLines } from "../citation-drift.js";
import type { Finding, Rule } from "../types.js";

const RULE_ID = "citation-drift";

/**
 * Opt-in (`check --base <ref>`): flags every line citation that names other
 * text than it named at the ref. Two finding ids, both warnings:
 *   - `citation-moved`: the cited text moved and the new lines are known;
 *     `okf-kit repoint --base <ref>` re-points it
 *   - `citation-content-changed`: an edit touched the cited lines themselves,
 *     so the new position cannot be derived; re-verify by hand
 * Without `--base` (no `ctx.citationDrift`) the rule returns no findings.
 * See `src/citation-drift.ts` for what is judged and how.
 */
export const citationDriftRule: Rule = {
  id: RULE_ID,
  description:
    "Opt-in (`--base <ref>`): flags a line citation whose cited text, as it was at the ref, is no longer at the cited lines (`citation-moved`, re-pointable with `repoint`) or whose cited lines an edit touched (`citation-content-changed`).",
  run(ctx) {
    if (!ctx.citationDrift || !ctx.repoRoot) return [];
    const { ref } = ctx.citationDrift;
    const findings: Finding[] = [];
    for (const verdict of analyzeCitationDrift(
      { root: ctx.repoRoot, bundleDir: ctx.bundleDir, docs: ctx.docs },
      ctx.citationDrift,
    )) {
      const { citation } = verdict;
      if (verdict.status === "moved") {
        findings.push({
          ruleId: RULE_ID,
          severity: "warning",
          file: citation.docRelPath,
          message: `\`${citation.label}\`: the text cited at ${ref} is now at ${describeLines(verdict.newStartLine ?? 0, verdict.newEndLine ?? 0)}; \`okf-kit repoint --base ${ref}\` re-points it [citation-moved]`,
          detail: `resolvedTo: ${verdict.file}`,
        });
      } else if (verdict.status === "changed") {
        findings.push({
          ruleId: RULE_ID,
          severity: "warning",
          file: citation.docRelPath,
          message: `\`${citation.label}\`: ${verdict.reason}; re-verify by hand [citation-content-changed]`,
          detail: `resolvedTo: ${verdict.file}`,
        });
      }
    }
    return findings;
  },
};

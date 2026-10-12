import fs from "node:fs";
import {
  getValidAppliesTo,
  getValidSources,
  hasAppliesToKey,
  hasSourcesKey,
  isWithinRepoRoot,
  resolveRepoPath,
} from "../util.js";
import type { Finding, Rule } from "../types.js";

const RULE_ID = "sources-shape";

export const sourcesShapeRule: Rule = {
  id: RULE_ID,
  description:
    "Frontmatter `sources` and `applies_to`, when present, must each be a non-empty array of non-empty strings; with a repo root (explicit --repo-root or auto-detected), each path must stay inside the repo root and exist.",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      const parsed = doc.frontmatter.parsed;
      if (hasSourcesKey(parsed)) {
        checkPathList(
          findings,
          ctx.repoRoot,
          doc.relPath,
          "sources",
          "Source",
          getValidSources(parsed),
        );
      }
      if (hasAppliesToKey(parsed)) {
        checkPathList(
          findings,
          ctx.repoRoot,
          doc.relPath,
          "applies_to",
          "`applies_to`",
          getValidAppliesTo(parsed),
        );
      }
    }
    return findings;
  },
};

/** Shape and (with a repo root) existence check for one path-list field. */
function checkPathList(
  findings: Finding[],
  repoRoot: string | undefined,
  file: string,
  field: string,
  label: string,
  entries: string[] | undefined,
): void {
  if (!entries) {
    findings.push({
      ruleId: RULE_ID,
      severity: "error",
      file,
      message: `Frontmatter \`${field}\` must be a non-empty array of non-empty strings.`,
    });
    return;
  }
  if (!repoRoot) return;
  for (const entry of entries) {
    if (!isWithinRepoRoot(repoRoot, entry)) {
      findings.push({
        ruleId: RULE_ID,
        severity: "error",
        file,
        message: `\`${field}\` path escapes the repo root: \`${entry}\``,
      });
      continue;
    }
    const target = resolveRepoPath(repoRoot, entry);
    if (!fs.existsSync(target)) {
      findings.push({
        ruleId: RULE_ID,
        severity: "error",
        file,
        message: `${label} path does not exist under repo root: \`${entry}\``,
      });
    }
  }
}

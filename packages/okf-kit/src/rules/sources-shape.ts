import fs from "node:fs";
import {
  analyzeSources,
  getValidAppliesTo,
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
    "Frontmatter `sources` and `applies_to`, when present, must each be a non-empty array of non-empty strings; `sources` entries may also be OKF v0.2 mappings, each needing a non-empty `resource` (a mapping `id`, when present, must be a non-empty string or number). With a repo root (explicit --repo-root or auto-detected), each path (a string entry, or a mapping `resource` that is not a `scheme://` URL) must stay inside the repo root and exist; URL resources are not checked.",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      const parsed = doc.frontmatter.parsed;
      if (hasSourcesKey(parsed)) {
        checkSources(findings, ctx.repoRoot, doc.relPath, parsed);
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

/**
 * `sources` in either OKF shape. A list that is malformed as a whole keeps
 * the one list-level error it always had (worded for the shapes in play); a
 * mapping defect is one error per mapping and does not stop the list's other
 * entries from being checked. Only path entries are checked against the
 * repo root: a mapping `resource` that is a URL is skipped.
 */
function checkSources(
  findings: Finding[],
  repoRoot: string | undefined,
  file: string,
  parsed: unknown,
): void {
  const analysis = analyzeSources(parsed);
  if (!analysis.usable) {
    findings.push({
      ruleId: RULE_ID,
      severity: "error",
      file,
      message: analysis.hasMapping
        ? "Frontmatter `sources` must be a non-empty array of non-empty strings or mappings with a `resource`."
        : "Frontmatter `sources` must be a non-empty array of non-empty strings.",
    });
    return;
  }
  for (const problem of analysis.problems) {
    findings.push({
      ruleId: RULE_ID,
      severity: "error",
      file,
      message: problem.message,
    });
  }
  if (!repoRoot) return;
  checkPathsExist(
    findings,
    repoRoot,
    file,
    "sources",
    "Source",
    analysis.entries
      .filter((entry) => entry.kind === "path")
      .map((entry) => entry.resource),
  );
}

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
  checkPathsExist(findings, repoRoot, file, field, label, entries);
}

/** Containment and existence of each path under `repoRoot`. */
function checkPathsExist(
  findings: Finding[],
  repoRoot: string,
  file: string,
  field: string,
  label: string,
  entries: string[],
): void {
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

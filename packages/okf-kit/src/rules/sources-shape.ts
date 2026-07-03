import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../util.js";
import type { Finding, Rule } from "../types.js";

const RULE_ID = "sources-shape";

export const sourcesShapeRule: Rule = {
  id: RULE_ID,
  description:
    "Frontmatter `sources`, when present, must be a non-empty array of non-empty strings; with --repo-root, each path must exist.",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      const parsed = doc.frontmatter.parsed;
      if (!isRecord(parsed) || !("sources" in parsed)) continue;

      const sources = parsed.sources;
      const isValidShape =
        Array.isArray(sources) &&
        sources.length > 0 &&
        sources.every((s) => typeof s === "string" && s.trim() !== "");

      if (!isValidShape) {
        findings.push({
          ruleId: RULE_ID,
          severity: "error",
          file: doc.relPath,
          message:
            "Frontmatter `sources` must be a non-empty array of non-empty strings.",
        });
        continue;
      }

      if (!ctx.repoRoot) continue;
      for (const source of sources as string[]) {
        const target = path.join(ctx.repoRoot, source);
        if (!fs.existsSync(target)) {
          findings.push({
            ruleId: RULE_ID,
            severity: "error",
            file: doc.relPath,
            message: `Source path does not exist under --repo-root: \`${source}\``,
          });
        }
      }
    }
    return findings;
  },
};

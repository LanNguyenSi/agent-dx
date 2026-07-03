import type { Finding, Rule } from "../types.js";

const RULE_ID = "reserved-files-bare";

export const reservedFilesBareRule: Rule = {
  id: RULE_ID,
  description:
    "Reserved files (index.md, log.md, at any depth) must not carry a frontmatter block.",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      if (!doc.isReserved) continue;
      if (doc.frontmatter.present) {
        findings.push({
          ruleId: RULE_ID,
          severity: "error",
          file: doc.relPath,
          message: `Reserved file \`${doc.basename}\` must not carry a frontmatter block.`,
        });
      }
    }
    return findings;
  },
};

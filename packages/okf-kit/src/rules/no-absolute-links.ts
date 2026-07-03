import { extractMarkdownLinks } from "../links.js";
import type { Finding, Rule } from "../types.js";

const RULE_ID = "no-absolute-links";

export const noAbsoluteLinksRule: Rule = {
  id: RULE_ID,
  description: "Link targets should not start with `/`.",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      for (const link of extractMarkdownLinks(doc.body)) {
        if (!link.pathPart.startsWith("/")) continue;
        findings.push({
          ruleId: RULE_ID,
          severity: "warning",
          file: doc.relPath,
          message:
            `Link target \`${link.target}\` starts with \`/\`: GitHub resolves a leading slash against ` +
            "the repository root, not the bundle root, so this link 404s once the bundle is viewed outside " +
            "its own repository (agent-tasks#387). Use a same-directory relative link instead.",
        });
      }
    }
    return findings;
  },
};

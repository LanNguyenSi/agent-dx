import { isRecord } from "../util.js";
import type { Finding, Rule } from "../types.js";

const RULE_ID = "frontmatter-required";

export const frontmatterRequiredRule: Rule = {
  id: RULE_ID,
  description:
    "Every non-reserved markdown file must have a frontmatter block that parses and carries a non-empty string `type`.",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      if (doc.isReserved) continue;
      const { frontmatter } = doc;

      if (!frontmatter.present) {
        findings.push({
          ruleId: RULE_ID,
          severity: "error",
          file: doc.relPath,
          message:
            "Missing frontmatter block: the file must open with a `---` line and close with a matching `---` line.",
        });
        continue;
      }

      if (frontmatter.parseError) {
        findings.push({
          ruleId: RULE_ID,
          severity: "error",
          file: doc.relPath,
          message: "Frontmatter block is not parseable YAML.",
          detail: frontmatter.parseError,
        });
        continue;
      }

      const type = isRecord(frontmatter.parsed)
        ? frontmatter.parsed.type
        : undefined;
      if (typeof type !== "string" || type.trim() === "") {
        findings.push({
          ruleId: RULE_ID,
          severity: "error",
          file: doc.relPath,
          message: "Frontmatter `type` must be present and a non-empty string.",
        });
      }
    }
    return findings;
  },
};

import { isRecord } from "../util.js";
import type { Finding, Rule } from "../types.js";

const RULE_ID = "reserved-files-bare";

export const reservedFilesBareRule: Rule = {
  id: RULE_ID,
  description:
    "Reserved files (index.md, log.md, at any depth) must not carry a frontmatter block. Under OKF v0.2 the bundle-root index.md alone may carry a frontmatter block, and then exactly one key: `okf_version`.",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      if (!doc.isReserved) continue;
      if (doc.frontmatter.present) {
        // OKF v0.2 exception: the BUNDLE ROOT index.md may carry a
        // frontmatter block with exactly the one key the spec allows it,
        // `okf_version`. Everything else stays a finding exactly as under
        // v0.1: any other key next to it (the version block is the ONLY
        // permitted content), the key on a non-root index.md or on log.md,
        // and, under v0.1 (the resolved version, including via `--spec`),
        // any frontmatter block at all. A frontmatter that does not parse
        // is a block whose keys cannot be read, so it cannot qualify as
        // "exactly one key, okf_version" either.
        if (ctx.specVersion === "v0.2" && doc.relPath === "index.md") {
          const keys = isRecord(doc.frontmatter.parsed)
            ? Object.keys(doc.frontmatter.parsed)
            : [];
          if (keys.length === 1 && keys[0] === "okf_version") continue;
          findings.push({
            ruleId: RULE_ID,
            severity: "error",
            file: doc.relPath,
            message:
              "Bundle-root `index.md` may carry a frontmatter block with exactly one key, `okf_version`.",
          });
          continue;
        }
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

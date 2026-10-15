import { SUPPORTED_OKF_VERSION_TEXTS, readOkfVersion } from "../bundle.js";
import { isRecord } from "../util.js";
import type { Finding, Rule } from "../types.js";

const RULE_ID = "reserved-files-bare";

export const reservedFilesBareRule: Rule = {
  id: RULE_ID,
  description:
    "Reserved files (index.md, log.md, at any depth) must not carry a frontmatter block. Under OKF v0.2 the bundle-root index.md alone may carry a frontmatter block, and then exactly one key: `okf_version`. A bundle-root index.md whose only key is an `okf_version` this tool does not recognize is reported with the value it declares and the supported versions.",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      if (!doc.isReserved) continue;
      if (doc.frontmatter.present) {
        const keys = isRecord(doc.frontmatter.parsed)
          ? Object.keys(doc.frontmatter.parsed)
          : [];
        // The v0.2 exception, in full: the BUNDLE ROOT index.md may carry a
        // frontmatter block with exactly the one key the spec allows it,
        // `okf_version`. Everything else stays a finding exactly as under
        // v0.1: any other key next to it (the version block is the ONLY
        // permitted content), the key on a non-root index.md or on log.md,
        // and, under v0.1 (the resolved version, including via `--spec`),
        // any frontmatter block at all. A frontmatter that does not parse
        // is a block whose keys cannot be read, so it cannot qualify as
        // "exactly one key, okf_version" either.
        const isVersionBlock =
          doc.relPath === "index.md" &&
          keys.length === 1 &&
          keys[0] === "okf_version";
        if (ctx.specVersion === "v0.2" && doc.relPath === "index.md") {
          if (isVersionBlock) continue;
          findings.push({
            ruleId: RULE_ID,
            severity: "error",
            file: doc.relPath,
            message:
              "Bundle-root `index.md` may carry a frontmatter block with exactly one key, `okf_version`.",
          });
          continue;
        }
        // The version key alone, under v0.1, is the author of a HALF-migrated
        // bundle who named a version this tool does not have: detection could
        // only resolve it to v0.1, and the generic "reserved file must not
        // carry a frontmatter block" below would leave them guessing which key
        // was the problem. Name the value and what IS supported instead.
        // A recognized value (`0.1`, or a `0.2` reached through `--spec v0.1`)
        // is a block this version forbids outright, so it keeps the generic
        // message.
        if (isVersionBlock) {
          const declared = readOkfVersion(doc.frontmatter);
          if (declared.version === undefined) {
            findings.push({
              ruleId: RULE_ID,
              severity: "error",
              file: doc.relPath,
              message: `Bundle-root \`index.md\` declares \`okf_version: ${declared.text}\`, which is not a recognized OKF spec version (supported: ${SUPPORTED_OKF_VERSION_TEXTS.join(", ")}); the bundle is checked as v0.1.`,
            });
            continue;
          }
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

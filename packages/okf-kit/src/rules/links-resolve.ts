import fs from "node:fs";
import path from "node:path";
import { extractMarkdownLinks } from "../links.js";
import type { Finding, Rule } from "../types.js";

const RULE_ID = "links-resolve";

export const linksResolveRule: Rule = {
  id: RULE_ID,
  description:
    "Markdown links to `.md` files must resolve to a real file in the bundle.",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      for (const link of extractMarkdownLinks(doc.body)) {
        const resolved = resolveLinkPath(
          ctx.bundleDir,
          doc.relPath,
          link.pathPart,
        );
        if (!fs.existsSync(resolved)) {
          findings.push({
            ruleId: RULE_ID,
            severity: "error",
            file: doc.relPath,
            message: `Link target does not resolve: \`${link.target}\``,
          });
        }
      }
    }
    return findings;
  },
};

/**
 * Relative targets resolve against the containing file's directory. Targets
 * starting with `/` resolve against the bundle root, not the repo root or
 * filesystem root (see the `no-absolute-links` rule for why that leading
 * slash is still worth flagging).
 */
function resolveLinkPath(
  bundleDir: string,
  docRelPath: string,
  pathPart: string,
): string {
  if (pathPart.startsWith("/")) {
    return path.join(bundleDir, pathPart.slice(1));
  }
  const docDir = path.dirname(path.join(bundleDir, docRelPath));
  return path.resolve(docDir, pathPart);
}

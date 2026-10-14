import { scanFootnotes } from "../footnotes.js";
import { analyzeSources, getDeclaredSourceIds } from "../util.js";
import type { Finding, Rule } from "../types.js";

const RULE_ID = "footnotes-resolve";

/**
 * OKF v0.2 footnote citations: a body footnote reference `[^id]` resolves to
 * the `sources` entry whose `id` is `id`. Two checks per doc:
 *
 *  - a `[^id]` reference with no `sources` entry carrying that `id` is an
 *    error, reported once per distinct id (however often it is cited);
 *  - a `sources` entry with an `id` that no `[^id]` reference in the body
 *    cites is a warning, reported once per entry. Only a REFERENCE counts as
 *    citing: a definition line `[^id]: ...` alone leaves the entry
 *    unreferenced (a definition no prose points at renders nowhere), and a
 *    definition line is likewise never itself a reference to resolve --
 *    only the `[^id]` tokens in prose (and inside a definition's text) are.
 *
 * Footnote ids are case-sensitive. Fenced code, inline code and a
 * backslash-escaped `[^id]` are not references (see `src/footnotes.ts`).
 *
 * The rule runs for spec v0.2 bundles only (`okf_version: "0.2"` on the
 * root `index.md`, or `check --spec v0.2`): `[^id]` is plain GFM footnote
 * syntax, and a v0.1 doc using it for its own footnotes has no `sources`
 * `id` contract to answer to, so v0.1 output is unchanged. Reserved files
 * (`index.md`, `log.md`) carry no `sources` and are not scanned. Ids are
 * read from every mapping in `sources` even when that mapping has another
 * defect (no `resource`): `sources-shape` reports the defect, and a
 * footnote citing the entry is not reported as dangling on top of it.
 * Needs no repo root: it reads frontmatter and body only.
 */
export const footnotesResolveRule: Rule = {
  id: RULE_ID,
  description:
    "OKF v0.2 footnotes: every body `[^id]` reference must resolve to a `sources` mapping entry with that `id` (error, once per id), and every `sources` entry with an `id` must be referenced by at least one `[^id]` (warning). Definition lines `[^id]: ...`, fenced code and inline code are not references. Runs for spec v0.2 only.",
  run(ctx) {
    const findings: Finding[] = [];
    if (ctx.specVersion !== "v0.2") return findings;
    for (const doc of ctx.docs) {
      if (doc.isReserved) continue;
      const parsed = doc.frontmatter.parsed;
      const declared = new Set(getDeclaredSourceIds(parsed));
      const { references } = scanFootnotes(doc.body);
      const referenced = new Set(references);

      for (const id of [...referenced].filter((r) => !declared.has(r))) {
        findings.push({
          ruleId: RULE_ID,
          severity: "error",
          file: doc.relPath,
          message: `Footnote \`[^${id}]\` has no \`sources\` entry with \`id: ${id}\``,
        });
      }

      for (const entry of analyzeSources(parsed).entries) {
        if (entry.id === undefined || referenced.has(entry.id)) continue;
        findings.push({
          ruleId: RULE_ID,
          severity: "warning",
          file: doc.relPath,
          message: `\`sources\` entry \`${entry.resource}\` has \`id: ${entry.id}\` but no \`[^${entry.id}]\` footnote references it`,
        });
      }
    }
    return findings;
  },
};

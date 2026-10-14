import type { Rule } from "../types.js";
import { frontmatterRequiredRule } from "./frontmatter-required.js";
import { reservedFilesBareRule } from "./reserved-files-bare.js";
import { reservedFilesStructureRule } from "./reserved-files-structure.js";
import { linksResolveRule } from "./links-resolve.js";
import { noAbsoluteLinksRule } from "./no-absolute-links.js";
import { sourcesShapeRule } from "./sources-shape.js";
import { sourcesFreshRule, sourcesFreshFutureRule } from "./sources-fresh.js";
import { generatedShapeRule } from "./generated-shape.js";
import { footnotesResolveRule } from "./footnotes-resolve.js";
import { citationsResolveRule } from "./citations-resolve.js";
import { proseLineReferencesRule } from "./prose-line-references.js";
import { frontmatterRefsResolveRule } from "./frontmatter-refs-resolve.js";

// proseLineReferencesRule is always registered here, same as
// citationsResolveRule -- its own run(ctx) no-ops (returns []) unless
// ctx.proseLineReferences is set (see src/rules/prose-line-references.ts),
// so a consumer that never passes --prose-line-references sees
// byte-identical `check` output to before this rule existed.
//
// sourcesFreshFutureRule, unlike those two, is always active (no opt-in
// flag gates it, only `--future-skew-minutes` tunes its threshold): it
// assesses the same doc population as sourcesFreshRule, just the opposite
// time direction, so it is always registered alongside it.
export const allRules: Rule[] = [
  frontmatterRequiredRule,
  reservedFilesBareRule,
  reservedFilesStructureRule,
  linksResolveRule,
  noAbsoluteLinksRule,
  sourcesShapeRule,
  sourcesFreshRule,
  sourcesFreshFutureRule,
  generatedShapeRule,
  footnotesResolveRule,
  citationsResolveRule,
  proseLineReferencesRule,
  frontmatterRefsResolveRule,
];

export {
  frontmatterRequiredRule,
  reservedFilesBareRule,
  reservedFilesStructureRule,
  linksResolveRule,
  noAbsoluteLinksRule,
  sourcesShapeRule,
  sourcesFreshRule,
  sourcesFreshFutureRule,
  generatedShapeRule,
  footnotesResolveRule,
  citationsResolveRule,
  proseLineReferencesRule,
  frontmatterRefsResolveRule,
};

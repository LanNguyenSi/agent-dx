import type { Rule } from "../types.js";
import { frontmatterRequiredRule } from "./frontmatter-required.js";
import { reservedFilesBareRule } from "./reserved-files-bare.js";
import { linksResolveRule } from "./links-resolve.js";
import { noAbsoluteLinksRule } from "./no-absolute-links.js";
import { sourcesShapeRule } from "./sources-shape.js";
import { sourcesFreshRule } from "./sources-fresh.js";
import { citationsResolveRule } from "./citations-resolve.js";
import { proseLineReferencesRule } from "./prose-line-references.js";

// proseLineReferencesRule is always registered here, same as
// citationsResolveRule -- its own run(ctx) no-ops (returns []) unless
// ctx.proseLineReferences is set (see src/rules/prose-line-references.ts),
// so a consumer that never passes --prose-line-references sees
// byte-identical `check` output to before this rule existed.
export const allRules: Rule[] = [
  frontmatterRequiredRule,
  reservedFilesBareRule,
  linksResolveRule,
  noAbsoluteLinksRule,
  sourcesShapeRule,
  sourcesFreshRule,
  citationsResolveRule,
  proseLineReferencesRule,
];

export {
  frontmatterRequiredRule,
  reservedFilesBareRule,
  linksResolveRule,
  noAbsoluteLinksRule,
  sourcesShapeRule,
  sourcesFreshRule,
  citationsResolveRule,
  proseLineReferencesRule,
};

import type { Rule } from "../types.js";
import { frontmatterRequiredRule } from "./frontmatter-required.js";
import { reservedFilesBareRule } from "./reserved-files-bare.js";
import { linksResolveRule } from "./links-resolve.js";
import { noAbsoluteLinksRule } from "./no-absolute-links.js";
import { sourcesShapeRule } from "./sources-shape.js";
import { sourcesFreshRule } from "./sources-fresh.js";

export const allRules: Rule[] = [
  frontmatterRequiredRule,
  reservedFilesBareRule,
  linksResolveRule,
  noAbsoluteLinksRule,
  sourcesShapeRule,
  sourcesFreshRule,
];

export {
  frontmatterRequiredRule,
  reservedFilesBareRule,
  linksResolveRule,
  noAbsoluteLinksRule,
  sourcesShapeRule,
  sourcesFreshRule,
};

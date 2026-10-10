import type { PackDefinition } from "../types.js";
import { agentTicsPack } from "./agent-tics.js";
import { proseSlopPack } from "./prose-slop.js";
import { commentSlopPack } from "./comment-slop.js";
import { codeSlopPack } from "./code-slop.js";
import { uiSlopPack } from "./ui-slop.js";
import { placementSlopPack } from "./placement-slop.js";
import { workflowSlopPack } from "./workflow-slop.js";
import { reviewSlopPack } from "./review-slop.js";

export const allPacks: PackDefinition[] = [
  agentTicsPack,
  proseSlopPack,
  commentSlopPack,
  codeSlopPack,
  uiSlopPack,
  placementSlopPack,
  workflowSlopPack,
  reviewSlopPack,
];

/** Thrown when a pack filter names a pack the registry does not know. */
export class UnknownPackError extends Error {
  constructor(
    readonly unknown: string[],
    readonly known: string[],
  ) {
    super(
      `unknown pack${unknown.length === 1 ? "" : "s"} ${unknown
        .map((u) => `"${u}"`)
        .join(", ")} (known packs: ${known.join(", ")})`,
    );
    this.name = "UnknownPackError";
  }
}

/**
 * Resolve a pack-id filter against the registry. An id the registry does not
 * know throws `UnknownPackError` instead of being dropped: a typo such as
 * `--pack ui-slp` would otherwise scan nothing and report a clean run.
 */
export function packsByFilter(filter?: string[]): PackDefinition[] {
  if (!filter || filter.length === 0) return allPacks;
  const known = allPacks.map((p) => p.id as string);
  const unknown = [...new Set(filter)].filter((id) => !known.includes(id));
  if (unknown.length > 0) throw new UnknownPackError(unknown, known);
  const set = new Set(filter);
  return allPacks.filter((p) => set.has(p.id));
}

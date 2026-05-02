import type { PackDefinition } from "../types.js";
import { agentTicsPack } from "./agent-tics.js";
import { proseSlopPack } from "./prose-slop.js";
import { commentSlopPack } from "./comment-slop.js";
import { codeSlopPack } from "./code-slop.js";

export const allPacks: PackDefinition[] = [agentTicsPack, proseSlopPack, commentSlopPack, codeSlopPack];

export function packsByFilter(filter?: string[]): PackDefinition[] {
  if (!filter || filter.length === 0) return allPacks;
  const set = new Set(filter);
  return allPacks.filter((p) => set.has(p.id));
}

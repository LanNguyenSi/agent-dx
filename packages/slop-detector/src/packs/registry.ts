import type { PackDefinition } from "../types.js";
import { agentTicsPack } from "./agent-tics.js";
import { proseSlopPack } from "./prose-slop.js";

export const allPacks: PackDefinition[] = [agentTicsPack, proseSlopPack];

export function packsByFilter(filter?: string[]): PackDefinition[] {
  if (!filter || filter.length === 0) return allPacks;
  const set = new Set(filter);
  return allPacks.filter((p) => set.has(p.id));
}

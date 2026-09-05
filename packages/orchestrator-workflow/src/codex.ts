import { readAgentAsset } from "./assets.js";

import type { Role, Tier } from "./models.js";
import type { ModelSelection } from "./routing.js";

function tomlString(value: string): string {
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) escaped += '\\"';
    else if (code === 0x5c) escaped += "\\\\";
    else if (code === 0x08) escaped += "\\b";
    else if (code === 0x09) escaped += "\\t";
    else if (code === 0x0a) escaped += "\\n";
    else if (code === 0x0c) escaped += "\\f";
    else if (code === 0x0d) escaped += "\\r";
    else if (code < 0x20 || code === 0x7f) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += value[index];
    }
  }
  return `"${escaped}"`;
}

function descriptionForTier(
  description: string,
  tier: Tier | undefined,
): string {
  return tier === undefined
    ? description
    : `${description} (Effort tier: ${tier}.)`;
}

/**
 * Produces a standalone Codex subagent definition. The reviewer intentionally
 * inherits its parent's sandbox: its canonical prompt prohibits source edits,
 * while inherited access lets it create test/build output in temporary paths.
 */
export function composeCodexAgent(
  role: Role,
  selection: ModelSelection,
  tier?: Tier,
): string {
  const asset = readAgentAsset(role);
  const lines = [
    `name = ${tomlString(tier === undefined ? asset.name : `${asset.name}-${tier}`)}`,
    `description = ${tomlString(descriptionForTier(asset.description, tier))}`,
    `model = ${tomlString(selection.model)}`,
    `model_reasoning_effort = ${tomlString(selection.effort)}`,
  ];
  if (role === "explorer" || role === "advisor") {
    lines.push('sandbox_mode = "read-only"');
  }
  lines.push(`developer_instructions = ${tomlString(asset.body.trimEnd())}`);
  return `${lines.join("\n")}\n`;
}

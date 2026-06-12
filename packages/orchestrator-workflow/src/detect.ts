import { existsSync } from "node:fs";
import { join } from "node:path";

export type Harness = "claude" | "codex" | "opencode";

export const HARNESSES: Harness[] = ["claude", "codex", "opencode"];

function anyExists(dir: string, names: string[]): boolean {
  return names.some((name) => existsSync(join(dir, name)));
}

/**
 * Best-effort detection of which harnesses a target repository already uses.
 * AGENTS.md alone is deliberately not a signal: every supported harness can
 * consume it, so it does not identify one.
 */
export function detectHarnesses(dir: string): Harness[] {
  const detected: Harness[] = [];
  if (anyExists(dir, [".claude", "CLAUDE.md"])) detected.push("claude");
  if (anyExists(dir, [".agents", ".codex"])) detected.push("codex");
  if (anyExists(dir, [".opencode", "opencode.json", "opencode.jsonc"])) {
    detected.push("opencode");
  }
  return detected;
}

export function parseHarnessList(list: string): Harness[] {
  const parsed: Harness[] = [];
  for (const entry of list.split(",")) {
    const name = entry.trim().toLowerCase();
    if (name === "") continue;
    if (!(HARNESSES as string[]).includes(name)) {
      throw new Error(
        `Unknown harness "${name}"; valid values: ${HARNESSES.join(", ")}`,
      );
    }
    if (!parsed.includes(name as Harness)) parsed.push(name as Harness);
  }
  if (parsed.length === 0) {
    throw new Error("--harness was given but contained no harness names");
  }
  return parsed;
}

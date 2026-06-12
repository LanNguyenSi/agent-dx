import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Role } from "./models.js";

/** Resolves from both src/ (tsx dev) and dist/ (built) to the package root. */
export const ASSETS_DIR = fileURLToPath(new URL("../assets/", import.meta.url));

export const PACKAGE_VERSION: string = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

export function readAsset(relativePath: string): string {
  return readFileSync(join(ASSETS_DIR, relativePath), "utf8");
}

export function listTemplateNames(): string[] {
  return readdirSync(join(ASSETS_DIR, "templates"))
    .filter((name) => name.endsWith(".md"))
    .sort();
}

export interface AgentAsset {
  name: string;
  description: string;
  body: string;
}

/**
 * The agent assets are the single source of truth for the role prompts. They
 * carry a minimal `name` + `description` frontmatter; the harness-specific
 * frontmatter (model, mode) is composed at install time.
 */
export function readAgentAsset(role: Role): AgentAsset {
  const raw = readAsset(join("agents", `${role}.md`));
  const match = raw.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!match) {
    throw new Error(`Agent asset for "${role}" has no frontmatter block`);
  }
  const [, frontmatter, body] = match;
  const name = frontmatter.match(/^name: (.+)$/m)?.[1]?.trim();
  const descriptionRaw = frontmatter.match(/^description: (.+)$/m)?.[1]?.trim();
  if (!name || !descriptionRaw) {
    throw new Error(`Agent asset for "${role}" is missing name or description`);
  }
  const description = descriptionRaw.replace(/^"(.*)"$/, "$1");
  return { name, description, body };
}

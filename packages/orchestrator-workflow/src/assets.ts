import { readdirSync, readFileSync, type Dirent } from "node:fs";
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

/**
 * Shipped auxiliary skill references. These are deliberately a flat,
 * regular-file-only asset surface: names come from the packaged directory,
 * never from an install target or CLI input, and symlinks/non-markdown files
 * are excluded before an install path is composed from them.
 */
export function isSafeSkillReferenceEntry(
  entry: Pick<Dirent, "name" | "isFile" | "isSymbolicLink">,
): boolean {
  return (
    entry.isFile() &&
    !entry.isSymbolicLink() &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(entry.name)
  );
}

export function listSkillReferenceNames(): string[] {
  return readdirSync(join(ASSETS_DIR, "skill", "references"), {
    withFileTypes: true,
  })
    .filter(isSafeSkillReferenceEntry)
    .map((entry) => entry.name)
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

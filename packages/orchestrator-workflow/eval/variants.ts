import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import { parse as parseYaml } from "yaml";

import { ID_PATTERN, isValidId } from "./dataset.js";
import { hostGitEnv } from "./isolation.js";

/** Repository-relative path of the shipped reviewer prompt. */
export const REVIEWER_PROMPT_PATH =
  "packages/orchestrator-workflow/assets/agents/reviewer.md";

/** Default revision of the `current` variant. */
export const DEFAULT_REVISION = "17055644";

export interface PromptVariant {
  /** Short id recorded with every run, for example `current`. */
  id: string;
  /** Where the text came from, for the run record. */
  source: string;
  /** Whole prompt file, frontmatter included. */
  text: string;
  /** sha256 of `text`. */
  sha256: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A variant id names a results directory, so it follows the entry id
 * pattern: no `/`, no `..`, nothing that leaves the results directory.
 */
export function makeVariant(
  id: string,
  source: string,
  text: string,
): PromptVariant {
  if (!isValidId(id)) {
    throw new Error(
      `variant id ${JSON.stringify(id)} must match ${ID_PATTERN.source}; pass --variant-id`,
    );
  }
  return { id, source, text, sha256: sha256(text) };
}

/** Reads the shipped reviewer prompt at a git revision of `repoRoot`. */
export function readReviewerAtRevision(
  repoRoot: string,
  rev: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return execFileSync(
    "git",
    ["-C", repoRoot, "show", `${rev}:${REVIEWER_PROMPT_PATH}`],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: hostGitEnv(env),
      timeout: 60_000,
    },
  );
}

const CHECK_HEADING = "Check, at minimum:";
const RULES_HEADING = "Rules:";

/**
 * Negative-control transform: drops the whole `Check, at minimum:` list (from
 * its heading line up to the `Rules:` heading) and leaves everything else,
 * including the review-method table, the rules and the output structure,
 * byte-identical. Throws when either anchor is missing or out of order, so a
 * reworded prompt cannot silently produce an unmodified "degraded" variant.
 */
export function degradeReviewerPrompt(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === CHECK_HEADING);
  const end = lines.findIndex((line) => line === RULES_HEADING);
  if (start < 0) throw new Error(`anchor not found: "${CHECK_HEADING}"`);
  if (end < 0) throw new Error(`anchor not found: "${RULES_HEADING}"`);
  if (end <= start) {
    throw new Error(
      `anchor "${RULES_HEADING}" must come after "${CHECK_HEADING}"`,
    );
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

export interface SplitPrompt {
  /** Parsed frontmatter, or an empty object. */
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Splits a prompt file into its YAML frontmatter and its body. */
export function splitPrompt(text: string): SplitPrompt {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) return { frontmatter: {}, body: text };
  const parsed: unknown = parseYaml(match[1]);
  const frontmatter =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { frontmatter, body: match[2] };
}

export interface VariantRequest {
  /** `current`, `degraded`, or `file:<path>`. */
  spec: string;
  /** Optional id override; defaults to the spec name or the file stem. */
  id?: string;
  repoRoot: string;
  revision: string;
  env?: NodeJS.ProcessEnv;
}

/** Resolves a `--variant` argument to a prompt variant. */
export function resolveVariant(request: VariantRequest): PromptVariant {
  const { spec, repoRoot, revision } = request;
  if (spec === "current" || spec === "degraded") {
    const base = readReviewerAtRevision(repoRoot, revision, request.env);
    const source = `git:${revision}:${REVIEWER_PROMPT_PATH}`;
    if (spec === "current") {
      return makeVariant(request.id ?? "current", source, base);
    }
    return makeVariant(
      request.id ?? "degraded",
      `${source}#drop-check-list`,
      degradeReviewerPrompt(base),
    );
  }
  if (spec.startsWith("file:")) {
    const path = spec.slice("file:".length);
    if (path.length === 0) throw new Error("variant file: needs a path");
    const text = readFileSync(path, "utf8");
    const id = request.id ?? basename(path, extname(path));
    return makeVariant(id, `file:${basename(path)}`, text);
  }
  throw new Error(
    `unknown variant ${spec}: use current, degraded or file:<path>`,
  );
}

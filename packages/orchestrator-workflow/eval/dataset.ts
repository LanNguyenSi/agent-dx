import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Dataset format of the reviewer replay evaluation: one JSON file per entry
 * plus an `index.json`. The dataset itself is private to whoever builds it;
 * this module only defines and validates the shape.
 */

export const SCHEMA_VERSION = 1;

export const ENTRY_KINDS = ["finding", "control"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const REVIEW_METHODS = ["normal", "rigorous", "adversarial"] as const;
export type ReviewMethod = (typeof REVIEW_METHODS)[number];

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Severities that count toward recall and false-positive tallies. */
export const MEDIUM_PLUS: readonly string[] = ["medium", "high", "critical"];

/** Placeholders a brief or task spec may carry instead of machine paths. */
export const PLACEHOLDERS = [
  "WORKTREE",
  "EVIDENCE_DIR",
  "RUN_DIR",
  "BASE_SHA",
  "HEAD_SHA",
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface SetupCommand {
  /** Directory inside the checkout, relative, no `..`. `.` is the root. */
  cwd: string;
  argv: string[];
  timeout_s?: number;
}

export interface KnownFinding {
  id: string;
  severity: Severity;
  category: string;
  description: string;
  files?: string[];
}

export interface DatasetEntry {
  schema: number;
  id: string;
  kind: EntryKind;
  repo: {
    name: string;
    /** Local repository the checkout is cloned from. */
    path: string;
    head_sha: string;
    base_sha: string;
    /** Free text, for example when the head is only reachable through a pull ref. */
    fetch_note?: string;
  };
  setup: SetupCommand[];
  review_method: ReviewMethod;
  brief: string;
  task_spec: string;
  known_findings: KnownFinding[];
  provenance: { source: string; round: number; notes?: string };
}

export interface IndexEntry {
  id: string;
  kind: EntryKind;
  file: string;
}

export interface DatasetIndex {
  schema: number;
  entries: IndexEntry[];
}

export interface Dataset {
  dir: string;
  entries: DatasetEntry[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const KNOWN_ID_PATTERN = /^K[0-9]{1,3}$/;

const HOME_ROOTS = ["Users", "home"];
const MACHINE_PATH = new RegExp(`/(?:${HOME_ROOTS.join("|")})/[^\\s/"'\`)]+`);

/** First machine-specific home path in a text, or null. */
export function findMachinePath(text: string): string | null {
  return MACHINE_PATH.exec(text)?.[0] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export interface EntryValidation {
  valid: boolean;
  errors: string[];
  entry?: DatasetEntry;
}

function validateSetup(raw: unknown, errors: string[]): void {
  if (!Array.isArray(raw)) {
    errors.push("setup: expected an array");
    return;
  }
  raw.forEach((cmd, i) => {
    const at = `setup[${i}]`;
    if (!isRecord(cmd)) {
      errors.push(`${at}: expected an object`);
      return;
    }
    const cwd = cmd.cwd;
    if (!nonEmptyString(cwd)) {
      errors.push(`${at}.cwd: expected a non-empty string`);
    } else if (cwd.startsWith("/") || cwd.split("/").includes("..")) {
      errors.push(`${at}.cwd: must stay inside the checkout (got ${cwd})`);
    }
    const argv = cmd.argv;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((a) => typeof a === "string" && a.length > 0)
    ) {
      errors.push(`${at}.argv: expected a non-empty array of strings`);
    }
    const timeout = cmd.timeout_s;
    if (
      timeout !== undefined &&
      (typeof timeout !== "number" || !(timeout > 0))
    ) {
      errors.push(`${at}.timeout_s: expected a positive number`);
    }
  });
}

function validateKnownFindings(
  raw: unknown,
  kind: unknown,
  errors: string[],
): void {
  if (!Array.isArray(raw)) {
    errors.push("known_findings: expected an array");
    return;
  }
  const seen = new Set<string>();
  let mediumPlus = 0;
  raw.forEach((finding, i) => {
    const at = `known_findings[${i}]`;
    if (!isRecord(finding)) {
      errors.push(`${at}: expected an object`);
      return;
    }
    const id = finding.id;
    if (typeof id !== "string" || !KNOWN_ID_PATTERN.test(id)) {
      errors.push(`${at}.id: expected K<number> (got ${String(id)})`);
    } else if (seen.has(id)) {
      errors.push(`${at}.id: duplicate id ${id}`);
    } else {
      seen.add(id);
    }
    const severity = finding.severity;
    if (
      typeof severity !== "string" ||
      !SEVERITIES.includes(severity as Severity)
    ) {
      errors.push(`${at}.severity: expected ${SEVERITIES.join(" | ")}`);
    } else if (MEDIUM_PLUS.includes(severity)) {
      mediumPlus += 1;
    }
    if (!nonEmptyString(finding.category)) {
      errors.push(`${at}.category: expected a non-empty string`);
    }
    if (!nonEmptyString(finding.description)) {
      errors.push(`${at}.description: expected a non-empty string`);
    }
    const files = finding.files;
    if (
      files !== undefined &&
      (!Array.isArray(files) || !files.every((f) => typeof f === "string"))
    ) {
      errors.push(`${at}.files: expected an array of strings`);
    }
  });
  if (kind === "finding" && mediumPlus === 0) {
    errors.push(
      "known_findings: a finding entry needs at least one medium or higher known finding",
    );
  }
  if (kind === "control" && raw.length > 0) {
    errors.push("known_findings: a control entry must list none");
  }
}

/** Structural validation of one entry; never reads the filesystem. */
export function validateEntry(raw: unknown): EntryValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { valid: false, errors: ["<root>: expected an object"] };
  }
  if (raw.schema !== SCHEMA_VERSION) {
    errors.push(`schema: expected ${SCHEMA_VERSION}`);
  }
  if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
    errors.push(`id: expected ${ID_PATTERN.source}`);
  }
  if (!ENTRY_KINDS.includes(raw.kind as EntryKind)) {
    errors.push(`kind: expected ${ENTRY_KINDS.join(" | ")}`);
  }
  if (!REVIEW_METHODS.includes(raw.review_method as ReviewMethod)) {
    errors.push(`review_method: expected ${REVIEW_METHODS.join(" | ")}`);
  }

  const repo = raw.repo;
  if (!isRecord(repo)) {
    errors.push("repo: expected an object");
  } else {
    if (!nonEmptyString(repo.name)) errors.push("repo.name: expected a string");
    if (!nonEmptyString(repo.path)) errors.push("repo.path: expected a string");
    for (const key of ["head_sha", "base_sha"] as const) {
      const sha = repo[key];
      if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
        errors.push(`repo.${key}: expected a full 40-character lowercase sha`);
      }
    }
    if (repo.fetch_note !== undefined && typeof repo.fetch_note !== "string") {
      errors.push("repo.fetch_note: expected a string");
    }
    if (typeof repo.head_sha === "string" && repo.head_sha === repo.base_sha) {
      errors.push("repo: head_sha and base_sha must differ");
    }
  }

  validateSetup(raw.setup, errors);

  for (const key of ["brief", "task_spec"] as const) {
    const text = raw[key];
    if (!nonEmptyString(text)) {
      errors.push(`${key}: expected a non-empty string`);
      continue;
    }
    const machinePath = findMachinePath(text);
    if (machinePath !== null) {
      errors.push(
        `${key}: contains a machine path (${machinePath}); use a placeholder such as {{WORKTREE}}`,
      );
    }
  }

  validateKnownFindings(raw.known_findings, raw.kind, errors);

  const provenance = raw.provenance;
  if (!isRecord(provenance)) {
    errors.push("provenance: expected an object");
  } else {
    if (!nonEmptyString(provenance.source)) {
      errors.push("provenance.source: expected a string");
    }
    if (
      !Number.isInteger(provenance.round) ||
      (provenance.round as number) < 1
    ) {
      errors.push("provenance.round: expected a positive integer");
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors, entry: raw as unknown as DatasetEntry };
}

export interface DatasetLoad {
  dataset: Dataset | null;
  errors: string[];
}

/** Loads and validates `index.json` and every entry it lists. */
export function loadDataset(dir: string): DatasetLoad {
  const errors: string[] = [];
  const indexPath = join(dir, "index.json");
  if (!existsSync(indexPath)) {
    return { dataset: null, errors: [`index.json not found in ${dir}`] };
  }
  let index: unknown;
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch (error) {
    return {
      dataset: null,
      errors: [`index.json: ${error instanceof Error ? error.message : error}`],
    };
  }
  if (
    !isRecord(index) ||
    index.schema !== SCHEMA_VERSION ||
    !Array.isArray(index.entries)
  ) {
    return {
      dataset: null,
      errors: [`index.json: expected {schema: ${SCHEMA_VERSION}, entries: []}`],
    };
  }
  const entries: DatasetEntry[] = [];
  const seen = new Set<string>();
  for (const [i, item] of (index.entries as unknown[]).entries()) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.file !== "string" ||
      !ENTRY_KINDS.includes(item.kind as EntryKind)
    ) {
      errors.push(`index.json entries[${i}]: expected {id, kind, file}`);
      continue;
    }
    if (item.file.includes("..") || item.file.startsWith("/")) {
      errors.push(
        `index.json entries[${i}]: file must stay inside the dataset`,
      );
      continue;
    }
    if (seen.has(item.id)) {
      errors.push(`index.json: duplicate id ${item.id}`);
      continue;
    }
    seen.add(item.id);
    const file = join(dir, item.file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      errors.push(
        `${item.file}: ${error instanceof Error ? error.message : error}`,
      );
      continue;
    }
    const result = validateEntry(raw);
    if (!result.valid || result.entry === undefined) {
      for (const message of result.errors)
        errors.push(`${item.file}: ${message}`);
      continue;
    }
    if (result.entry.id !== item.id) {
      errors.push(
        `${item.file}: id ${result.entry.id} does not match index id ${item.id}`,
      );
      continue;
    }
    if (result.entry.kind !== item.kind) {
      errors.push(
        `${item.file}: kind ${result.entry.kind} does not match index kind ${item.kind}`,
      );
      continue;
    }
    entries.push(result.entry);
  }
  if (errors.length > 0) return { dataset: null, errors };
  return { dataset: { dir, entries }, errors };
}

/** Counts used by the dataset size acceptance bar. */
export function datasetCounts(dataset: Dataset): {
  finding: number;
  control: number;
} {
  return {
    finding: dataset.entries.filter((e) => e.kind === "finding").length,
    control: dataset.entries.filter((e) => e.kind === "control").length,
  };
}

/**
 * Replaces `{{NAME}}` for the known placeholder names only; any other
 * double-brace text (a template in a quoted diff, say) stays untouched.
 */
export function substitutePlaceholders(
  text: string,
  values: Record<Placeholder, string>,
): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) =>
    (PLACEHOLDERS as readonly string[]).includes(name)
      ? values[name as Placeholder]
      : whole,
  );
}

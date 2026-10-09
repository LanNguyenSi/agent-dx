#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { CheckSummary, Severity, Violation } from "../types.js";

export type Threshold = Severity;

const RANK: Record<Severity, number> = { info: 0, warn: 1, block: 2 };

const COMMAND: Record<Severity, string> = {
  block: "error",
  warn: "warning",
  info: "notice",
};

/** Escape the message part of a workflow command (`::cmd ...::<data>`). */
export function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Escape a workflow command property value. */
export function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/**
 * Turn a path reported by the CLI into a path relative to `root` (the
 * repository checkout), with forward slashes, as annotations expect.
 */
export function toRepoRelative(file: string, root: string): string {
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
  const rel = path.relative(root, abs);
  const chosen = rel.startsWith("..") || path.isAbsolute(rel) ? file : rel;
  return chosen.split(path.sep).join("/");
}

/** Built-in rule ids already carry their pack prefix; do not double it. */
function annotationTitle(v: Violation): string {
  return v.ruleId.startsWith(`${v.pack}/`) ? v.ruleId : `${v.pack}/${v.ruleId}`;
}

export function formatAnnotation(v: Violation, root?: string): string {
  const file = root === undefined ? v.path : toRepoRelative(v.path, root);
  const props = [
    `file=${escapeProperty(file)}`,
    `line=${v.line}`,
    `col=${v.column}`,
  ];
  if (v.endLine !== undefined) props.push(`endLine=${v.endLine}`);
  if (v.endColumn !== undefined) props.push(`endColumn=${v.endColumn}`);
  props.push(`title=${escapeProperty(annotationTitle(v))}`);
  return `::${COMMAND[v.severity]} ${props.join(",")}::${escapeData(v.message)}`;
}

export function parseThreshold(value: string): Threshold {
  if (value === "block" || value === "warn" || value === "info") return value;
  throw new Error(
    `invalid severity-threshold "${value}": expected one of block, warn, info`,
  );
}

export function exceedsThreshold(
  summary: Pick<CheckSummary, "violations">,
  threshold: string,
): boolean {
  const min = RANK[parseThreshold(threshold)];
  return summary.violations.some((v) => RANK[v.severity] >= min);
}

/**
 * Keep the changed files that still exist and lie inside `scanPath`
 * (a deleted file shows up in `git diff --name-only` but cannot be scanned).
 */
export function selectChangedFiles(
  changed: string[],
  exists: (file: string) => boolean,
  scanPath = ".",
): string[] {
  const root = path.posix.normalize(scanPath.split(path.sep).join("/"));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of changed) {
    const file = path.posix.normalize(raw);
    if (file === "" || file === "." || seen.has(file)) continue;
    const inside =
      root === "." ||
      root === "" ||
      file === root ||
      file.startsWith(root.endsWith("/") ? root : `${root}/`);
    if (!inside || !exists(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

export function parseSummary(stdout: string): CheckSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("slop-detector output is not valid JSON");
  }
  const s = parsed as Partial<CheckSummary> | null;
  if (s === null || typeof s !== "object" || !Array.isArray(s.violations)) {
    throw new Error("slop-detector output has no violations array");
  }
  return s as CheckSummary;
}

class ActionFailure extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function fail(message: string, code: number): never {
  throw new ActionFailure(message, code);
}

const SHA_RE = /^[0-9a-f]{40,64}$/;

/** Split `git diff --name-only -z` output; only the empty trailing element is dropped. */
export function parseNulList(stdout: string): string[] {
  const parts = stdout.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Make the `path` input repo-relative (posix) against the repo root. */
export function repoRelativeScanPath(scanPath: string, root: string): string {
  const abs = path.isAbsolute(scanPath)
    ? scanPath
    : path.resolve(root, scanPath);
  const rel = path.relative(root, path.resolve(abs));
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

export interface SpawnResult {
  status: number | null;
  stdout: string | null;
  stderr: string | null;
  error?: Error;
}

export interface ActionDeps {
  spawn: (cmd: string, args: string[], opts: { cwd: string }) => SpawnResult;
  readFile: (file: string) => string;
  exists: (file: string) => boolean;
  write: (text: string) => void;
  cliPath: string;
}

export function defaultDeps(): ActionDeps {
  return {
    spawn: (cmd, args, opts) =>
      spawnSync(cmd, args, {
        cwd: opts.cwd,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      }),
    readFile: (f) => fs.readFileSync(f, "utf8"),
    exists: (f) => fs.existsSync(f),
    write: (t) => {
      process.stdout.write(t);
    },
    cliPath: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "cli.js",
    ),
  };
}

function changedFilesFromEvent(
  env: NodeJS.ProcessEnv,
  root: string,
  scanPath: string,
  deps: ActionDeps,
): string[] {
  const eventName = env.GITHUB_EVENT_NAME;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventName !== "pull_request" && eventName !== "pull_request_target") {
    deps.write(
      "::notice title=slop-detector::changed-files-only ignored: not a pull_request event\n",
    );
    return [scanPath];
  }
  if (!eventPath) fail("GITHUB_EVENT_PATH is not set", 2);
  let event: {
    pull_request?: { base?: { sha?: string }; head?: { sha?: string } };
  };
  try {
    event = JSON.parse(deps.readFile(eventPath));
  } catch (err) {
    return fail(
      `cannot read event file ${eventPath}: ${(err as Error).message}`,
      2,
    );
  }
  const base = event?.pull_request?.base?.sha;
  const head = event?.pull_request?.head?.sha;
  if (!base || !head) fail("pull_request event has no base/head sha", 2);
  if (
    typeof base !== "string" ||
    typeof head !== "string" ||
    !SHA_RE.test(base) ||
    !SHA_RE.test(head)
  ) {
    fail("pull_request event base/head sha is not a full commit sha", 2);
  }
  const diff = deps.spawn(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      "-z",
      "--end-of-options",
      `${base}...${head}`,
    ],
    { cwd: root },
  );
  if (diff.status !== 0 || diff.stdout === null) {
    fail(
      `git diff failed (is the checkout deep enough, fetch-depth: 0?): ${(diff.stderr ?? "").trim()}`,
      2,
    );
  }
  return selectChangedFiles(
    parseNulList(diff.stdout),
    (f) => deps.exists(path.join(root, f)),
    repoRelativeScanPath(scanPath, root),
  );
}

/** Run the action; returns the process exit code (0 clean, 1 findings, 2 failure). */
export function runAction(
  env: NodeJS.ProcessEnv,
  deps: ActionDeps = defaultDeps(),
): number {
  try {
    return runActionInner(env, deps);
  } catch (err) {
    if (err instanceof ActionFailure) {
      deps.write(`::error title=slop-detector::${escapeData(err.message)}\n`);
      return err.code;
    }
    throw err;
  }
}

function runActionInner(env: NodeJS.ProcessEnv, deps: ActionDeps): number {
  const root = path.resolve(env.GITHUB_WORKSPACE || process.cwd());
  const scanPath = env.INPUT_PATH || ".";
  const packs = (env.INPUT_PACK || "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const config = env.INPUT_CONFIG || "";
  let threshold: Threshold;
  try {
    threshold = parseThreshold(env.INPUT_SEVERITY_THRESHOLD || "block");
  } catch (err) {
    return fail((err as Error).message, 2);
  }
  const changedOnly = (env.INPUT_CHANGED_FILES_ONLY || "false") === "true";

  const targets = changedOnly
    ? changedFilesFromEvent(env, root, scanPath, deps)
    : [scanPath];
  if (targets.length === 0) {
    deps.write("slop-detector: no changed files to scan\n");
    return 0;
  }

  const args = [deps.cliPath, "check", "--format", "json"];
  for (const p of packs) args.push("--pack", p);
  if (config !== "") args.push("--config", config);
  args.push("--", ...targets);

  const res = deps.spawn(process.execPath, args, { cwd: root });
  if (res.error || res.status === null || res.status === 2 || res.status > 2) {
    const why = res.error ? res.error.message : (res.stderr || "").trim();
    return fail(`slop-detector CLI failed (exit ${res.status}): ${why}`, 2);
  }

  let summary: CheckSummary;
  try {
    summary = parseSummary(res.stdout ?? "");
  } catch (err) {
    return fail((err as Error).message, 2);
  }

  for (const w of new Set(summary.warnings ?? [])) {
    deps.write(`::warning title=slop-detector::${escapeData(w)}\n`);
  }
  for (const v of summary.violations) {
    deps.write(formatAnnotation(v, root) + "\n");
  }
  deps.write(
    `slop-detector: ${summary.filesScanned} file(s) scanned, ${summary.blockCount} block, ${summary.warnCount} warn, ${summary.infoCount} info (threshold: ${threshold})\n`,
  );
  return exceedsThreshold(summary, threshold) ? 1 : 0;
}

const entry = process.argv[1];
if (
  entry &&
  fs.existsSync(entry) &&
  fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = runAction(process.env);
}

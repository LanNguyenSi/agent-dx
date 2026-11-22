import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { withoutRepoSelectionEnv } from "../git-env.js";
import type { CheckStatus } from "./types.js";

/** The `schema_version` every envelope carries; the shipped JSON Schema
 * (`schemas/evidence-envelope.json`) pins it with a `const`. */
export const EVIDENCE_SCHEMA_VERSION = 1;

/** The two moments a piece of evidence can be gathered at. The tool only
 * records which one the caller named; it attaches no meaning to either. */
export const EVIDENCE_PHASES = ["baseline", "closure"] as const;
export type EvidencePhase = (typeof EVIDENCE_PHASES)[number];

/** Who produced the run. Supplied by the caller and recorded as given:
 * nothing here can tell a CI job from a workstation, so a consumer that
 * trusts `ci` checks the `ci_run` reference against the CI itself. */
export const EVIDENCE_PRODUCERS = ["ci", "host", "local"] as const;
export type EvidenceProducer = (typeof EVIDENCE_PRODUCERS)[number];

export type EvidenceResult = "pass" | "fail" | "skip" | "error";

/** The placeholder an argv-form check may carry, as one whole element, for
 * the selector. */
export const SELECTOR_PLACEHOLDER = "{selector}";

/** Upper bound on a `ci_run` reference (a run id or a URL). The schema
 * carries the same number. */
export const CI_RUN_MAX_LENGTH = 2048;

/** One piece of evidence: what ran, against which checkout, with what
 * outcome. The shape `schemas/evidence-envelope.json` describes. */
export interface EvidenceEnvelope {
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  phase: EvidencePhase;
  producer: EvidenceProducer;
  /** Present exactly when `producer` is `ci`. */
  ci_run?: string;
  /** ISO 8601 UTC, when the check finished. */
  time: string;
  /** HEAD of the git work tree the check ran in, read by code. */
  commit: string;
  /** Whether that work tree had uncommitted or untracked changes, read by
   * code, never from input. */
  dirty: boolean;
  /** SHA-256 (hex) over the canonical form of the run's command set; see
   * `commandsDigest`. */
  commands_digest: string;
  /** The selector substituted into this check's argv, or null. */
  selector: string | null;
  /** The argv the check was executed with. Empty only for `skip`. */
  command: string[];
  /** The command's exit code; null when it has none (skipped, timed out,
   * killed, or never started). */
  exit: number | null;
  result: EvidenceResult;
}

/** The caller's opt-in to evidence output. */
export interface EvidenceOptions {
  phase: EvidencePhase;
  producer: EvidenceProducer;
  /** A CI run id or URL; required for `producer: "ci"`, refused for any
   * other producer. */
  ciRun?: string;
  /** Test seam for the envelope `time`. */
  now?: () => Date;
}

/** A refusal a caller turns into a usage error: a stable `reason` for the
 * envelope and a message naming what was wrong. */
export interface Refusal {
  reason: string;
  message: string;
}

const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The mapping from a check's status to the envelope `result`. `skipped`
 * is `skip` and never `pass`: a check that did not run proves nothing. */
export function evidenceResult(status: CheckStatus): EvidenceResult {
  switch (status) {
    case "pass":
      return "pass";
    case "fail":
      return "fail";
    case "skipped":
      return "skip";
    case "error":
      return "error";
  }
}

/** The argv `execCommand` spawns for a shell-string check: `sh -c <cmd>`. */
export function shellArgv(command: string): string[] {
  return ["sh", "-c", command];
}

/**
 * The digest of a run's command set. Canonical form: the UTF-8 bytes of
 * the JSON text of an array holding one argv array per resolved check, in
 * run order, each argv an array of strings exactly as it is spawned (a
 * shell-string check is `["sh","-c","<command>"]`) and an argv-form check
 * with its `{selector}` placeholder still in place, written with no
 * whitespace and no escapes beyond JSON's own. For arrays of strings that
 * is the RFC 8785 form. SHA-256, lower-case hex.
 *
 * Checks that resolved no command (skipped) contribute nothing, and the
 * selector is not part of it: it has its own envelope field.
 */
export function commandsDigest(argvLists: string[][]): string {
  return createHash("sha256").update(JSON.stringify(argvLists)).digest("hex");
}

/** Validates the evidence options of one run. */
export function checkEvidenceOptions(
  options: EvidenceOptions,
): Refusal | undefined {
  if (!EVIDENCE_PHASES.includes(options.phase)) {
    return {
      reason: "evidence_phase_invalid",
      message: `verify: evidence phase must be one of ${EVIDENCE_PHASES.join(", ")} (got "${String(options.phase)}")`,
    };
  }
  if (!EVIDENCE_PRODUCERS.includes(options.producer)) {
    return {
      reason: "evidence_producer_invalid",
      message: `verify: evidence producer must be one of ${EVIDENCE_PRODUCERS.join(", ")} (got "${String(options.producer)}")`,
    };
  }
  const ciRun = options.ciRun;
  if (options.producer === "ci") {
    if (ciRun === undefined || ciRun === "") {
      return {
        reason: "evidence_ci_run_required",
        message:
          "verify: producer ci needs a CI run id or URL (--ci-run); evidence that claims to come from CI without a run reference would be indistinguishable from a local run",
      };
    }
    if (
      ciRun.length > CI_RUN_MAX_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(ciRun)
    ) {
      return {
        reason: "evidence_ci_run_invalid",
        message: `verify: the CI run reference must be a single line of at most ${CI_RUN_MAX_LENGTH} characters without control characters`,
      };
    }
  } else if (ciRun !== undefined) {
    return {
      reason: "evidence_ci_run_not_ci",
      message: `verify: --ci-run only belongs to producer ci (got producer ${options.producer})`,
    };
  }
  return undefined;
}

/** Validates an argv-form check's template: an array of strings whose
 * first element names the program, with `{selector}` only ever as one whole
 * element and never in the program position. */
export function checkArgvTemplate(
  name: string,
  argv: unknown,
): Refusal | undefined {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((item) => typeof item === "string")
  ) {
    return {
      reason: "argv_invalid",
      message: `verify: --argv for check "${name}" must be a non-empty JSON array of strings`,
    };
  }
  const list = argv as string[];
  if (list[0] === "" || list[0].includes("\u0000")) {
    return {
      reason: "argv_invalid",
      message: `verify: --argv for check "${name}" must start with a program name`,
    };
  }
  if (list[0] === SELECTOR_PLACEHOLDER) {
    return {
      reason: "argv_invalid",
      message: `verify: --argv for check "${name}" must not use ${SELECTOR_PLACEHOLDER} as the program: a selector is only ever an argument`,
    };
  }
  if (list.some((item) => item.includes("\u0000"))) {
    return {
      reason: "argv_invalid",
      message: `verify: --argv for check "${name}" has an element with a NUL character`,
    };
  }
  if (
    list.some(
      (item) =>
        item !== SELECTOR_PLACEHOLDER && item.includes(SELECTOR_PLACEHOLDER),
    )
  ) {
    return {
      reason: "argv_invalid",
      message: `verify: --argv for check "${name}" uses ${SELECTOR_PLACEHOLDER} inside a longer element; it is only substituted as one whole element`,
    };
  }
  return undefined;
}

/** Characters that need no quoting in a POSIX shell word. `=` is not among
 * them: an unquoted `NAME=value` in the program position is an assignment,
 * not a program. */
const SHELL_SAFE_WORD = /^[A-Za-z0-9_@%+:,./-]+$/;

/**
 * Renders an argv as one shell-safe string: every element that is not a
 * plain word is wrapped in single quotes (with an embedded quote written
 * as `'\''`), so `sh -c <label>` executes exactly this argv and nothing
 * else, whatever the elements contain. This is the `command` label an
 * argv-form check is handed to an `ExecLike` with: an exec function that
 * does not honour `ExecOptions.argv` and runs the label through a shell
 * still runs the same argv. A caller must still treat a label as display
 * text and prefer `argv`.
 */
export function shellQuoteArgv(argv: readonly string[]): string {
  return argv
    .map((item) =>
      SHELL_SAFE_WORD.test(item) ? item : `'${item.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");
}

/** Validates the runtime types of the selector and discovery inputs, which
 * a library caller can get wrong (a raw string as a discovery list would
 * turn the exact-equality check into a substring match). */
export function checkSelectorInputs(
  selectors: Record<string, unknown>,
  discovery: Record<string, unknown>,
): Refusal | undefined {
  for (const [name, selector] of Object.entries(selectors)) {
    if (typeof selector !== "string") {
      return {
        reason: "selector_invalid",
        message: `verify: the selector for check "${name}" must be a string`,
      };
    }
  }
  for (const [name, entries] of Object.entries(discovery)) {
    if (
      !Array.isArray(entries) ||
      !entries.every((entry) => typeof entry === "string")
    ) {
      return {
        reason: "discovery_invalid",
        message: `verify: the discovery list for check "${name}" must be an array of strings`,
      };
    }
  }
  return undefined;
}

/** Whether an argv template carries the selector placeholder. */
export function hasSelectorPlaceholder(template: string[]): boolean {
  return template.includes(SELECTOR_PLACEHOLDER);
}

/**
 * Validates one selector against the discovery list it must come from. The
 * selector is accepted only when it does not start with `-` (it would be
 * read as an option by the program it is handed to) and is exactly equal,
 * character for character, to one entry of the list: no trimming, no case
 * folding, no prefix or substring match.
 */
export function checkSelector(
  name: string,
  selector: string,
  discovery: readonly string[],
): Refusal | undefined {
  if (selector.startsWith("-")) {
    return {
      reason: "selector_leading_dash",
      message: `verify: the selector for check "${name}" starts with "-"; a selector is never allowed to look like an option`,
    };
  }
  if (!discovery.includes(selector)) {
    return {
      reason: "selector_not_in_discovery",
      message: `verify: the selector for check "${name}" is not exactly equal to any entry of its discovery list`,
    };
  }
  return undefined;
}

/** Replaces every whole `{selector}` element of the template with the
 * selector, as one argv element. Never builds a string, so the selector can
 * never be split, quoted or interpreted. */
export function substituteSelector(
  template: readonly string[],
  selector: string,
): string[] {
  return template.map((item) =>
    item === SELECTOR_PLACEHOLDER ? selector : item,
  );
}

/** Splits a discovery file's text into its entries: one per line, split on
 * `\n` only (a `\r` stays part of the entry, so a CRLF file never matches
 * by accident). Empty lines and lines with a NUL character are not
 * entries. Nothing else is trimmed or changed. */
export function parseDiscoveryText(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line !== "" && !line.includes("\u0000"));
}

export type GitState =
  { ok: true; commit: string; dirty: boolean } | { ok: false; message: string };

function git(cwd: string, args: string[]): string | { error: string } {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
    {
      env: withoutRepoSelectionEnv(),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) return { error: result.error.message };
  if (result.status !== 0) {
    return { error: result.stderr.trim() || `git ${args[0]} failed` };
  }
  return result.stdout;
}

/** The checkout identity of the git work tree `cwd` is in, read by running
 * git: the HEAD commit and whether the tree is dirty (any tracked change
 * or untracked, non-ignored file). */
export function readGitState(cwd: string): GitState {
  const head = git(cwd, ["rev-parse", "--verify", "HEAD"]);
  if (typeof head !== "string") return { ok: false, message: head.error };
  const commit = head.trim();
  if (!COMMIT_PATTERN.test(commit)) {
    return { ok: false, message: `unexpected HEAD value "${commit}"` };
  }
  const status = git(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  if (typeof status !== "string") return { ok: false, message: status.error };
  return { ok: true, commit, dirty: status.length > 0 };
}

export interface EvidenceBuildInput {
  options: EvidenceOptions;
  git: { commit: string; dirty: boolean };
  digest: string;
  selector: string | null;
  command: string[];
  exit: number | null;
  status: CheckStatus;
}

/** Builds one envelope. `time` is taken here, when the check has finished. */
export function buildEvidenceEnvelope(
  input: EvidenceBuildInput,
): EvidenceEnvelope {
  const { options } = input;
  const now = options.now ? options.now() : new Date();
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    phase: options.phase,
    producer: options.producer,
    ...(options.producer === "ci" && options.ciRun !== undefined
      ? { ci_run: options.ciRun }
      : {}),
    time: now.toISOString(),
    commit: input.git.commit,
    dirty: input.git.dirty,
    commands_digest: input.digest,
    selector: input.selector,
    command: input.command,
    exit: input.exit,
    result: evidenceResult(input.status),
  };
}

import type { ExecOptions, ExecResult } from "../exec.js";

/** One parsed failure, as reported by a detector or synthesized by the
 * failures invariant. `file`/`line`/`name` are optional: a detector that
 * cannot locate a failure in the source (or the synthetic invariant entry)
 * omits them and reports `message` alone. */
export interface Failure {
  file?: string;
  line?: number;
  name?: string;
  message: string;
}

/** Per-check tallies. `warnings` counts detector-level findings that are
 * not failures (e.g. eslint `warning`-severity entries); it is unrelated
 * to the top-level envelope `warnings` array, which carries free-text
 * notices such as `detector_matched_nothing`. */
export interface Summary {
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  warnings: number;
}

/** What a detector is given to decide whether it applies and to parse. */
export interface DetectorInput {
  output: string;
  command: string;
  exitCode: number | null;
}

export interface DetectorParseResult {
  summary: Summary;
  failures: Failure[];
  /** Free-text detector warnings (distinct from `summary.warnings`, a
   * count). Merged into the verify result's top-level `warnings`. */
  warnings: string[];
}

/**
 * One output-shape detector. `matches` is the primary signal (output
 * shape); command text is only ever used as a tiebreaker by
 * `selectDetector` when more than one detector's `matches` returns true.
 * The generic detector's `matches` always returns true, so it acts as the
 * fallback when placed last in the detector list.
 */
export interface Detector {
  name: string;
  matches(input: DetectorInput): boolean;
  parse(input: DetectorInput): DetectorParseResult;
}

export type CheckStatus = "pass" | "fail" | "skipped" | "error";

export interface CheckResult {
  name: string;
  command?: string;
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  detector?: string;
  summary: Summary;
  failures: Failure[];
  logPath?: string;
  /** Present only when this check had a `--pass-regex` predicate AND that
   * predicate was actually consulted to decide `status` (i.e. `status`
   * would otherwise -- by exit code alone -- have been `pass` or `fail`,
   * never `error`; see `VerifyOptions.passRegexes`): the predicate's own
   * source, so a reader can tell an opt-in pass/fail from a plain
   * exit-code one apart from the `warnings` entry that names it. */
  passRegex?: string;
}

export type VerifyStatus = "pass" | "fail" | "error";

export interface VerifyResult {
  status: VerifyStatus;
  checks: CheckResult[];
  totalDurationMs: number;
  warnings: string[];
  logs: string[];
  /** True when any check's `failures` list was capped by `maxFailures`.
   * The caller (cli.ts) is responsible for writing `fullChecks` to the
   * log directory and marking the envelope `truncated: true` when this is
   * set; verify() itself never touches the envelope. */
  truncatedByMaxFailures: boolean;
  /** Present only when `truncatedByMaxFailures` is true: the same checks,
   * with every failures list left uncapped. */
  fullChecks?: CheckResult[];
  /** Present only for a status that needs a machine-readable cause beyond
   * `status` itself: `nothing_verified` when every requested check
   * resolved to `skipped` (status `error`, never a silent `pass`), and
   * `aborted` when the run was stopped by `VerifyOptions.signal` (status
   * `error`, with the checks that never ran named in `warnings`). */
  reason?: string;
}

export type ExecLike = (
  cmd: string,
  options: ExecOptions,
) => Promise<ExecResult>;

export interface VerifyOptions {
  cwd: string;
  /** Directory `exec.ts` writes per-check log files into (a `verify/`
   * subdirectory is created under it). */
  logDir: string;
  /** Check names, in run order. Defaults to `DEFAULT_CHECKS`. */
  checks?: string[];
  /** `-x name=command` overrides, keyed by check name. */
  overrides?: Record<string, string>;
  /** Opt-in per-check success predicate, `--pass-regex name=regex` on the
   * CLI (repeatable, keyed by check name; compiled through the shared
   * `compilePassRegex`, the same `m`-flag compile `probe`'s own
   * `--pass-regex`/`passWhen.regex` uses). Once a check's name has an
   * entry here, a match against that check's combined stdout+stderr
   * decides `status` (`pass`/`fail`) in place of its exit code -- for a
   * test runner whose exit code alone is not trustworthy (e.g. phpunit
   * exiting non-zero on a green suite over deprecation notices) -- while
   * `exitCode` itself is kept in the `CheckResult` as data regardless. A
   * check whose own classification is `error` before any predicate is
   * consulted (a timeout, exit 126/127, or an aborted run) is never
   * reclassified by a predicate: those shapes answer nothing about
   * pass/fail either way. A check with no entry here is entirely
   * unaffected: its `status` is the plain exit-code verdict, byte-
   * identical to before this option existed. Naming a check here that is
   * neither requested (`checks`/the default list) nor `-x`-overridden is
   * a usage error (`verify()` never silently ignores a predicate that
   * would never be consulted). */
  passRegexes?: Record<string, RegExp>;
  failFast?: boolean;
  /** Per-check timeout in milliseconds. No timeout when omitted. */
  timeoutMs?: number;
  /** Caps each check's own `failures` list. Defaults to 20. */
  maxFailures?: number;
  env?: NodeJS.ProcessEnv;
  /** Candidate detectors only, in priority order; the fallback is never
   * part of this list (see `fallbackDetector`). Defaults to
   * `DEFAULT_DETECTORS` (vitest, tsc, eslint, in that priority order). */
  detectors?: Detector[];
  /** The detector selected when no candidate in `detectors` matches, or
   * when two or more do and the command text does not name exactly one
   * of them. Defaults to `genericDetector`. */
  fallbackDetector?: Detector;
  /** Test seam: replaces `execCommand`, e.g. to spy on invocation count
   * for a `--fail-fast` test without spawning real shells. */
  execFn?: ExecLike;
  /** Stops the run. The currently running check's command is killed
   * (`exec.ts` `SIGKILL`s its whole process group, so Ctrl-C leaves no
   * orphan), that check is reported as `error` naming the abort rather
   * than as a check that failed, and no further check is started: the
   * ones that never ran are named in a run-level warning, and the result
   * carries `reason: "aborted"`. Additive and optional: omitted,
   * behaviour is exactly as before. The CLI passes the signal its
   * top-level SIGINT/SIGTERM handler owns. */
  signal?: AbortSignal;
  /** Identifies this run for the purpose of nesting per-check log files
   * uniquely under `logDir/verify/<runId>/`, so two runs sharing the same
   * `logDir` never share, or silently append to, the same log file.
   * Defaults to a fresh UUID; a caller that already has a run id (e.g.
   * the CLI's envelope run id) should pass it through here instead. */
  runId?: string;
}

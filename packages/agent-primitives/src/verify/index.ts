import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execCommand } from "../exec.js";
import type { ExecResult } from "../exec.js";
import { UsageError } from "../envelope.js";
import { genericDetector } from "./detectors/generic.js";
import { vitestDetector } from "./detectors/vitest.js";
import { tscDetector } from "./detectors/tsc.js";
import { eslintDetector } from "./detectors/eslint.js";
import type {
  CheckResult,
  CheckStatus,
  Detector,
  DetectorInput,
  DetectorParseResult,
  ExecLike,
  Failure,
  Summary,
  VerifyOptions,
  VerifyResult,
} from "./types.js";

export type {
  CheckResult,
  CheckStatus,
  Detector,
  DetectorInput,
  DetectorParseResult,
  ExecLike,
  Failure,
  Summary,
  VerifyOptions,
  VerifyResult,
  VerifyStatus,
} from "./types.js";
export { genericDetector } from "./detectors/generic.js";
export { vitestDetector } from "./detectors/vitest.js";
export { tscDetector } from "./detectors/tsc.js";
export { eslintDetector } from "./detectors/eslint.js";

/** Default check order, matching the CI convention: build before
 * typecheck (a suite that executes built output needs the build first). */
export const DEFAULT_CHECKS = ["build", "typecheck", "lint", "test"];

/** Default candidate detectors, in priority order (used only as a
 * tiebreak input alongside command text when two or more candidates'
 * shapes both match; see `selectDetector`). `generic` is never part of
 * this list: it is the fallback (`fallbackDetector` in `VerifyOptions`),
 * consulted when zero, or more than one ambiguous, candidate matches. */
export const DEFAULT_DETECTORS: Detector[] = [
  vitestDetector,
  tscDetector,
  eslintDetector,
];

export const DEFAULT_MAX_FAILURES = 20;

/** A check name reaches `npm run <name> --silent` (and a log file name)
 * unquoted; this is the conservative allowlist every resolved name (from
 * `-c` and from `-x`) must match before any command is built, so a name
 * carrying shell metacharacters is rejected as a usage error instead of
 * being interpolated into a shell command. */
const CHECK_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/** exec.ts's own tail bounds (60 lines, 6000 characters per stream; see
 * `TAIL_LINES`/`TAIL_CHARS` there), mirrored here rather than imported so
 * this detection stays a read of the tails it is handed, not a change to
 * exec.ts itself. A tail sitting exactly at either bound means real
 * output was cut off there, not that the command coincidentally produced
 * exactly this much. */
const TAIL_LINE_BOUND = 60;
const TAIL_CHAR_BOUND = 6000;

/** Counts the real lines in a captured tail: `split("\n")` on a string
 * that ends with a newline yields one trailing empty element that is
 * not a line of output at all (e.g. `"a\nb\n".split("\n")` is `["a",
 * "b", ""]`, three elements for two real lines); that phantom element
 * is dropped before counting, so a tail of exactly `TAIL_LINE_BOUND - 1`
 * real lines that happens to end with a newline is never reported as
 * being at the bound. */
function countLines(tail: string): number {
  const lines = tail.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

/** True when a captured tail (stdout or stderr, as returned by
 * `execCommand`) is at exec.ts's own bound. */
function tailAtBound(tail: string): boolean {
  if (tail.length === 0) return false;
  return countLines(tail) >= TAIL_LINE_BOUND || tail.length >= TAIL_CHAR_BOUND;
}

/** eslint's own "✖ N problems (N errors, M warnings)" summary line: the
 * tool's own total, always more trustworthy than a count of issue rows
 * out of a tail that may have been cut before every row reached it. This
 * line is the very last thing eslint prints, so it typically survives a
 * truncated tail (the tail keeps the *end* of the output) even when
 * earlier issue rows did not. */
const ESLINT_TOTALS_LINE =
  /✖\s*\d+\s*problems?\s*\(\s*(\d+)\s*errors?,\s*(\d+)\s*warnings?\s*\)/;

/**
 * When a check's output was truncated at exec.ts's tail bound, a
 * detector's own issue-row count can undercount the real total, and its
 * own `failures` list can be missing entries that fell outside the tail.
 * Prefers the tool's own reported total where one can be found in the
 * tail (currently only eslint's summary line, and only when the eslint
 * detector was actually selected: a totals-shaped line coincidentally
 * present in some other tool's output is not eslint's own total, and
 * trusting it would silently substitute the wrong numbers); either way,
 * a truncated tail always gets the truncation warning, since even a
 * trustworthy total does not make the `failures` list itself complete.
 */
function adjustForTruncatedTail(
  parsed: DetectorParseResult,
  output: string,
  truncated: boolean,
  isEslint: boolean,
): DetectorParseResult {
  if (!truncated) return parsed;

  const totals = isEslint ? ESLINT_TOTALS_LINE.exec(output) : null;
  if (totals) {
    return {
      ...parsed,
      summary: {
        ...parsed.summary,
        errors: Number(totals[1]),
        warnings: Number(totals[2]),
      },
      warnings: [
        ...parsed.warnings,
        "output_tail_truncated: failures list may be partial (counts taken from eslint's own total)",
      ],
    };
  }

  return {
    ...parsed,
    warnings: [
      ...parsed.warnings,
      "output_tail_truncated: counts may be undercounted",
    ],
  };
}

/**
 * One detector selection outcome. `ambiguousCandidates` is populated only
 * when the selection was ambiguous (two or more shape-matching, non-
 * fallback detectors and no single one named by the command text): the
 * names of every candidate detector, for a warning listing what was seen.
 */
export interface DetectorSelection {
  detector: Detector;
  ambiguousCandidates?: string[];
}

/** True when `name` appears in `command` as a whole token: bounded on
 * both sides by the start/end of the string, whitespace, or a path
 * separator, never merely as a substring. This keeps a detector named
 * e.g. `tsc` from being "named by the command" when the command merely
 * contains a longer word that happens to start with the same letters
 * (`tsconfig.json`). */
function commandNamesToken(command: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = "(?:^|[\\s/\\\\])";
  const endBoundary = "(?:$|[\\s/\\\\])";
  return new RegExp(`${boundary}${escaped}${endBoundary}`).test(command);
}

/**
 * Selects a detector for one check's output: `candidates` are consulted
 * first, `fallback` is used whenever none (or more than one, ambiguously)
 * of them applies.
 * Every candidate is a candidate when its `matches(input)` is true. Zero
 * matching candidates selects the fallback; one matching candidate
 * selects it; two or more consult the command text as a tiebreaker
 * (matched on whole-token boundaries, see `commandNamesToken`) only when
 * it names exactly one candidate, otherwise the fallback is chosen and
 * every candidate's name is returned so the caller can warn about the
 * ambiguity.
 */
export function selectDetector(
  candidates: Detector[],
  fallback: Detector,
  input: DetectorInput,
): DetectorSelection {
  const matched = candidates.filter((d) => d.matches(input));

  if (matched.length === 0) return { detector: fallback };
  if (matched.length === 1) return { detector: matched[0] };

  const namedByCommand = matched.filter((d) =>
    commandNamesToken(input.command, d.name),
  );
  if (namedByCommand.length === 1) return { detector: namedByCommand[0] };

  return {
    detector: fallback,
    ambiguousCandidates: matched.map((d) => d.name),
  };
}

/** Shell exit 126 (found but not executable) and 127 (not found) are
 * infra failures, not a check failing its own assertions: they map to
 * `error`, never `fail`. A timeout, or a null exit code from a signal
 * kill outside the timeout path, is likewise something the runner cannot
 * conclude pass/fail from, so it too maps to `error`. */
function classifyStatus(
  exitCode: number | null,
  timedOut: boolean,
): CheckStatus {
  if (timedOut) return "error";
  if (exitCode === null) return "error";
  if (exitCode === 0) return "pass";
  if (exitCode === 126 || exitCode === 127) return "error";
  return "fail";
}

/**
 * The failures invariant, applied to both `fail` and `error` checks: a
 * check whose detector parsed zero failures out of the output gets one
 * synthetic failure entry (naming `timedOut`, or the exit code, plus the
 * output tail) instead of shipping an empty `failures` list, and an
 * `error` check always reports `summary.errors >= 1` even when the
 * detector itself never touches that field. Implemented once here so
 * every detector, generic today and any added later, inherits it
 * automatically instead of each having to remember it.
 */
function applyFailuresInvariant(
  parsed: DetectorParseResult,
  checkName: string,
  exitCode: number | null,
  timedOut: boolean,
  tail: string,
  status: "fail" | "error",
): DetectorParseResult {
  let summary = parsed.summary;
  let failures = parsed.failures;
  let warnings = parsed.warnings;

  if (failures.length === 0) {
    const label = timedOut ? "timedOut" : `exit code ${exitCode}`;
    const synthetic: Failure = {
      name: checkName,
      message: `${label}: ${tail.length > 0 ? tail : "(no output)"}`,
    };
    failures = [synthetic];
    warnings = [...warnings, "detector_matched_nothing"];
    // Only increments the field when the detector itself reported 0 for
    // it: a detector can parse an empty `failures` list while its own
    // `Tests`/totals line still states a nonzero count (e.g. a long diff
    // pushed every `FAIL` block out of the captured tail while the
    // summary line survived), and adding one on top of that already-
    // correct count would double count the one synthetic entry this
    // block just added.
    summary =
      status === "error"
        ? summary.errors === 0
          ? { ...summary, errors: summary.errors + 1 }
          : summary
        : summary.failed === 0
          ? { ...summary, failed: summary.failed + 1 }
          : summary;
  }

  if (status === "error" && summary.errors === 0) {
    summary = { ...summary, errors: 1 };
  }

  return { summary, failures, warnings };
}

/** Reads `package.json` `scripts` from `cwd`. Returns `undefined` (rather
 * than throwing) when the file is missing or unparsable: a missing
 * package.json just means every script-based check resolves to
 * `skipped`, not a hard verify failure. */
function readScripts(cwd: string): Record<string, string> | undefined {
  try {
    const text = fs.readFileSync(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return undefined;
  }
}

interface Resolution {
  command: string | undefined;
  skipped: boolean;
}

/** Resolution per name: `-x` (overrides) wins; else `package.json`
 * `scripts[name]` runs as `npm run <name> --silent`; a name with neither
 * resolves to `skipped`. */
function resolveCommand(
  name: string,
  overrides: Record<string, string>,
  scripts: Record<string, string> | undefined,
): Resolution {
  if (Object.prototype.hasOwnProperty.call(overrides, name)) {
    return { command: overrides[name], skipped: false };
  }
  if (scripts && Object.prototype.hasOwnProperty.call(scripts, name)) {
    return { command: `npm run ${name} --silent`, skipped: false };
  }
  return { command: undefined, skipped: true };
}

function emptySummary(): Summary {
  return { passed: 0, failed: 0, skipped: 0, errors: 0, warnings: 0 };
}

/** De-duplicates a name list, preserving the first occurrence's position:
 * a name requested twice (e.g. `-c d,d`) runs once. */
function dedupePreservingOrder(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Runs the configured checks in order (build, typecheck, lint, test by
 * default) through exec.ts, one at a time, selecting a detector per check
 * by output shape and applying the failures invariant, then caps each
 * check's own `failures` list at `maxFailures`. Never touches the
 * envelope: the caller (cli.ts) decides how `truncatedByMaxFailures` /
 * `fullChecks` map onto `truncated` and `logs`.
 *
 * `options.signal` stops the run rather than merely killing one command:
 * the check that was running is reported as an `error` naming the abort,
 * every check after it is left unstarted and named in a warning, and the
 * result carries `reason: "aborted"`.
 */
export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const start = Date.now();
  const overrides = options.overrides ?? {};
  const requestedNames = options.checks ?? DEFAULT_CHECKS;
  // A check name that only exists as an `-x` override (not in the
  // requested/default list) is still run: an override that is never used
  // would be a silent no-op, which this package's principles rule out.
  const overrideOnlyNames = Object.keys(overrides).filter(
    (name) => !requestedNames.includes(name),
  );
  const requestedAndOverrideNames = [...requestedNames, ...overrideOnlyNames];

  // Every resolved name is validated before any command is built (from
  // `-c`/the default list and from `-x` keys alike): a name carrying a
  // shell metacharacter is a usage error, never interpolated into `npm
  // run <name> --silent` under `sh -c`.
  for (const name of requestedAndOverrideNames) {
    if (!CHECK_NAME_PATTERN.test(name)) {
      throw new UsageError(
        `verify: invalid check name "${name}" (must match ${CHECK_NAME_PATTERN})`,
      );
    }
  }

  const names = dedupePreservingOrder(requestedAndOverrideNames);

  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  if (!Number.isInteger(maxFailures) || maxFailures < 1) {
    throw new UsageError(
      `verify: maxFailures must be a positive integer (got ${maxFailures})`,
    );
  }

  const detectors = options.detectors ?? DEFAULT_DETECTORS;
  const fallbackDetector = options.fallbackDetector ?? genericDetector;
  const execFn: ExecLike = options.execFn ?? execCommand;
  const runId = options.runId ?? randomUUID();
  // Nested under a per-run id: two verify() runs sharing the same
  // `logDir` (e.g. a caller-supplied `-l` directory reused across
  // invocations) never share, or silently append to, the same per-check
  // log file (exec.ts opens each log file with `flags: 'a'`).
  const logDir = path.join(options.logDir, "verify", runId);

  const scripts = readScripts(options.cwd);
  const warnings: string[] = [];
  const namesNeedingScripts = names.some(
    (name) => !Object.prototype.hasOwnProperty.call(overrides, name),
  );
  if (scripts === undefined && namesNeedingScripts) {
    warnings.push(
      `package.json not readable in ${options.cwd}; script-based checks will be skipped`,
    );
  }

  const checks: CheckResult[] = [];
  const fullChecks: CheckResult[] = [];
  const logs: string[] = [];
  let truncatedByMaxFailures = false;
  // Set once the run is stopped (the caller's signal fired), together
  // with the checks that were therefore never started. Reported as its
  // own run-level reason: a stopped run measured nothing about the
  // checks it did not reach, and must not read as a run that did.
  let aborted = false;
  let notStarted: string[] = [];

  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    // Checked before the next check is resolved, not just inside
    // `execFn`: once the caller has asked to stop, spawning another
    // command only to kill it is work nobody asked for, and (for the
    // probe whose emergency restore is waiting on this) one more process
    // racing that restore.
    if (options.signal?.aborted) {
      aborted = true;
      notStarted = names.slice(index);
      break;
    }
    const resolved = resolveCommand(name, overrides, scripts);

    if (resolved.skipped || resolved.command === undefined) {
      const skippedResult: CheckResult = {
        name,
        status: "skipped",
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        summary: emptySummary(),
        failures: [],
      };
      checks.push(skippedResult);
      fullChecks.push(skippedResult);
      // A skipped check is not a non-pass finding: --fail-fast falls
      // through it and continues to the next check, rather than stopping
      // a run just because one check name resolved to nothing.
      continue;
    }

    const command = resolved.command;
    let execResult: ExecResult;
    try {
      execResult = await execFn(command, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeoutMs: options.timeoutMs,
        logDir,
        logFileName: `${name}.log`,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      // execFn itself rejecting (e.g. exec.ts's own `fs.mkdirSync(logDir,
      // ...)` failing because the log directory's parent is unwritable)
      // is not a check finding: it means this check could not even be
      // attempted. Recorded as `status: "error"` with a synthetic failure
      // naming the error, and the run continues with every other check,
      // exactly as any other error check would.
      const message = err instanceof Error ? err.message : String(err);
      const errorResult: CheckResult = {
        name,
        command,
        status: "error",
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        summary: { passed: 0, failed: 0, skipped: 0, errors: 1, warnings: 0 },
        failures: [{ name, message: `exec failed: ${message}` }],
      };
      checks.push(errorResult);
      fullChecks.push(errorResult);
      warnings.push(`${name}: exec failed: ${message}`);
      if (options.failFast) break;
      continue;
    }

    if (execResult.logWriteFailed) {
      warnings.push(
        `${name}: log write failed: ${execResult.logWriteError ?? "unknown error"}`,
      );
    } else {
      logs.push(execResult.logPath);
    }

    // A check whose command was killed by the caller's abort never ran
    // to a conclusion. Reported as an `error` naming the abort, and NOT
    // through `classifyStatus`/`applyFailuresInvariant`, whose synthetic
    // entry would read `exit code null: ...` and present a stopped run
    // as a check that ran and produced nothing. The run stops here: the
    // remaining checks are named in the run-level warning below rather
    // than spawned.
    if (execResult.aborted) {
      const abortedResult: CheckResult = {
        name,
        command,
        status: "error",
        exitCode: execResult.exitCode,
        durationMs: execResult.durationMs,
        timedOut: execResult.timedOut,
        summary: { passed: 0, failed: 0, skipped: 0, errors: 1, warnings: 0 },
        failures: [
          {
            name,
            message: `aborted: the run was stopped while ${name} was running, so this check has no result`,
          },
        ],
        ...(execResult.logWriteFailed ? {} : { logPath: execResult.logPath }),
      };
      checks.push(abortedResult);
      fullChecks.push(abortedResult);
      warnings.push(`${name}: aborted before it could finish`);
      aborted = true;
      notStarted = names.slice(index + 1);
      break;
    }

    // The command exited but something it spawned still held its
    // stdout/stderr open, so exec.ts settled on its flush grace: the
    // detector below parsed output that may be missing whatever was
    // still in flight. Said out loud rather than left to look like a
    // clean parse of the whole output.
    if (execResult.outputMayBeIncomplete) {
      warnings.push(
        `${name}: the command exited while something it spawned still held its output pipes open; the captured output may be incomplete`,
      );
    }

    const status = classifyStatus(execResult.exitCode, execResult.timedOut);
    const output = `${execResult.stdoutTail}\n${execResult.stderrTail}`;
    const selection = selectDetector(detectors, fallbackDetector, {
      output,
      command,
      exitCode: execResult.exitCode,
    });
    const detector = selection.detector;
    if (selection.ambiguousCandidates) {
      warnings.push(
        `${name}: ambiguous detector selection; candidates: ${selection.ambiguousCandidates.join(", ")}`,
      );
    }
    let parsed = detector.parse({
      output,
      command,
      exitCode: execResult.exitCode,
    });

    if (status === "fail" || status === "error") {
      const truncated =
        tailAtBound(execResult.stdoutTail) ||
        tailAtBound(execResult.stderrTail);
      parsed = adjustForTruncatedTail(
        parsed,
        output,
        truncated,
        detector.name === "eslint",
      );

      const tail = output.trim();
      parsed = applyFailuresInvariant(
        parsed,
        name,
        execResult.exitCode,
        execResult.timedOut,
        tail,
        status,
      );
    }

    // Every detector-level warning (including any just added by the
    // invariant above) is merged into the top-level warnings, prefixed
    // with the check name so a caller can tell which check it came from.
    for (const w of parsed.warnings) {
      warnings.push(`${name}: ${w}`);
    }

    const fullResult: CheckResult = {
      name,
      command,
      status,
      exitCode: execResult.exitCode,
      durationMs: execResult.durationMs,
      timedOut: execResult.timedOut,
      detector: detector.name,
      summary: parsed.summary,
      failures: parsed.failures,
      logPath: execResult.logPath,
    };
    fullChecks.push(fullResult);

    let cappedFailures = parsed.failures;
    if (cappedFailures.length > maxFailures) {
      cappedFailures = cappedFailures.slice(0, maxFailures);
      truncatedByMaxFailures = true;
    }
    checks.push({ ...fullResult, failures: cappedFailures });

    if (options.failFast && status !== "pass") break;
  }

  // An empty resolved check list (e.g. `-c ''`) is just as much
  // "nothing was verified" as every resolved check coming back skipped:
  // both must never fall through to a silent "pass".
  const nothingVerified =
    checks.length === 0 || checks.every((c) => c.status === "skipped");

  let overallStatus: VerifyResult["status"];
  let reason: string | undefined;
  if (aborted) {
    // Named ahead of `nothing_verified`, which is what an abort landing
    // before the first check would otherwise look like: "the run was
    // stopped" and "every check resolved to skipped" are different
    // things to tell a caller.
    overallStatus = "error";
    reason = "aborted";
    warnings.push(
      notStarted.length > 0
        ? `aborted: the run was stopped; these checks were never started: ${notStarted.join(", ")}`
        : "aborted: the run was stopped after the last check",
    );
  } else if (nothingVerified) {
    overallStatus = "error";
    reason = "nothing_verified";
    warnings.push(
      checks.length === 0
        ? "nothing_verified: no checks were resolved to run"
        : "nothing_verified: every requested check resolved to skipped",
    );
  } else {
    overallStatus = checks.some((c) => c.status === "error")
      ? "error"
      : checks.some((c) => c.status === "fail")
        ? "fail"
        : "pass";
  }

  return {
    status: overallStatus,
    checks,
    totalDurationMs: Date.now() - start,
    warnings,
    logs,
    truncatedByMaxFailures,
    ...(truncatedByMaxFailures ? { fullChecks } : {}),
    ...(reason ? { reason } : {}),
  };
}

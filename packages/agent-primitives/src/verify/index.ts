import fs from "node:fs";
import path from "node:path";
import { execCommand } from "../exec.js";
import { UsageError } from "../envelope.js";
import { genericDetector } from "./detectors/generic.js";
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

/** Default check order, matching the CI convention: build before
 * typecheck (a suite that executes built output needs the build first). */
export const DEFAULT_CHECKS = ["build", "typecheck", "lint", "test"];

export const DEFAULT_MAX_FAILURES = 20;

const DEFAULT_DETECTORS: Detector[] = [genericDetector];

/** A check name reaches `npm run <name> --silent` (and a log file name)
 * unquoted; this is the conservative allowlist every resolved name (from
 * `-c` and from `-x`) must match before any command is built, so a name
 * carrying shell metacharacters is rejected as a usage error instead of
 * being interpolated into a shell command. */
const CHECK_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;

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

/**
 * Selects a detector for one check's output, following the plan's rule
 * (precised after review): the last entry in `detectors` is the fallback
 * (generic-shaped, always matches); every other entry is a candidate when
 * its `matches(input)` is true. Zero candidates selects the fallback; one
 * candidate selects it; two or more consult the command text as a
 * tiebreaker only when it names exactly one candidate, otherwise the
 * fallback is chosen and every candidate's name is returned so the caller
 * can warn about the ambiguity.
 */
export function selectDetector(
  detectors: Detector[],
  input: DetectorInput,
): DetectorSelection {
  const fallback = detectors[detectors.length - 1];
  const nonFallback = detectors.slice(0, -1);
  const candidates = nonFallback.filter((d) => d.matches(input));

  if (candidates.length === 0) return { detector: fallback };
  if (candidates.length === 1) return { detector: candidates[0] };

  const namedByCommand = candidates.filter((d) =>
    input.command.includes(d.name),
  );
  if (namedByCommand.length === 1) return { detector: namedByCommand[0] };

  return {
    detector: fallback,
    ambiguousCandidates: candidates.map((d) => d.name),
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
    summary =
      status === "error"
        ? { ...summary, errors: summary.errors + 1 }
        : { ...summary, failed: summary.failed + 1 };
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

function sanitizeLogFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_") || "check";
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
  const execFn: ExecLike = options.execFn ?? execCommand;
  const logDir = path.join(options.logDir, "verify");

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

  for (const name of names) {
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
    const execResult = await execFn(command, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeoutMs: options.timeoutMs,
      logDir,
      logFileName: `${sanitizeLogFileName(name)}.log`,
    });

    if (execResult.logWriteFailed) {
      warnings.push(
        `${name}: log write failed: ${execResult.logWriteError ?? "unknown error"}`,
      );
    } else {
      logs.push(execResult.logPath);
    }

    const status = classifyStatus(execResult.exitCode, execResult.timedOut);
    const output = `${execResult.stdoutTail}\n${execResult.stderrTail}`;
    const selection = selectDetector(detectors, {
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

  const allSkipped =
    checks.length > 0 && checks.every((c) => c.status === "skipped");

  let overallStatus: VerifyResult["status"];
  let reason: string | undefined;
  if (allSkipped) {
    overallStatus = "error";
    reason = "nothing_verified";
    warnings.push(
      "nothing_verified: every requested check resolved to skipped",
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

import fs from "node:fs";
import path from "node:path";
import { execCommand } from "../exec.js";
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

/**
 * Selects a detector for one check's output. Shape is primary: every
 * detector in `detectors` whose `matches(input)` returns true is a
 * candidate. Command text is only ever consulted as a tiebreaker, when
 * more than one detector matches the same output (a real possibility once
 * T-005 adds tool-specific detectors, never for the generic-only list
 * used in v0). The generic detector's `matches` always returns true, so
 * placing it last in `detectors` makes it the guaranteed fallback: this
 * function always returns a detector, never undefined.
 */
export function selectDetector(
  detectors: Detector[],
  input: DetectorInput,
): Detector {
  const matches = detectors.filter((d) => d.matches(input));
  if (matches.length <= 1) {
    return matches[0] ?? detectors[detectors.length - 1];
  }
  const byCommandText = matches.find((d) => input.command.includes(d.name));
  return byCommandText ?? matches[0];
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
 * The failures invariant: a check that ended `fail` but whose detector
 * parsed zero failures out of the output gets one synthetic failure entry
 * (the exit code plus the output tail) instead of shipping `status: fail`
 * with `failures: []`. Implemented once here so every detector — generic
 * today, vitest/tsc/eslint in T-005 — inherits it automatically instead
 * of each having to remember it.
 */
function applyFailuresInvariant(
  parsed: DetectorParseResult,
  checkName: string,
  exitCode: number | null,
  tail: string,
): DetectorParseResult {
  if (parsed.failures.length > 0) return parsed;
  const synthetic: Failure = {
    name: checkName,
    message: `exit code ${exitCode}: ${tail.length > 0 ? tail : "(no output)"}`,
  };
  return {
    summary: { ...parsed.summary, failed: parsed.summary.failed + 1 },
    failures: [synthetic],
    warnings: [...parsed.warnings, "detector_matched_nothing"],
  };
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
  const names = [...requestedNames, ...overrideOnlyNames];

  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
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
      if (options.failFast) break;
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
    logs.push(execResult.logPath);

    const status = classifyStatus(execResult.exitCode, execResult.timedOut);
    const output = `${execResult.stdoutTail}\n${execResult.stderrTail}`;
    const detector = selectDetector(detectors, {
      output,
      command,
      exitCode: execResult.exitCode,
    });
    let parsed = detector.parse({
      output,
      command,
      exitCode: execResult.exitCode,
    });

    if (status === "fail") {
      const tail = output.trim();
      const beforeCount = parsed.failures.length;
      parsed = applyFailuresInvariant(parsed, name, execResult.exitCode, tail);
      if (beforeCount === 0) {
        warnings.push(`${name}: detector_matched_nothing`);
      }
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

  const overallStatus = checks.some((c) => c.status === "error")
    ? "error"
    : checks.some((c) => c.status === "fail")
      ? "fail"
      : "pass";

  return {
    status: overallStatus,
    checks,
    totalDurationMs: Date.now() - start,
    warnings,
    logs,
    truncatedByMaxFailures,
    ...(truncatedByMaxFailures ? { fullChecks } : {}),
  };
}

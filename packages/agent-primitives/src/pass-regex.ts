import { signalNumberFromExitCode } from "./exec.js";

/**
 * Compiles a `--pass-regex` / `passWhen.regex` source string into the
 * `RegExp` both `cli.ts`'s `parsePassRegex` and `probe/plan.ts`'s
 * `validatePlan` use, so the two parsers can never drift into two
 * independently-maintained compiles of the same option.
 *
 * Always applies the `m` flag, and only that flag: `^`/`$` then anchor
 * to each LINE of the combined stdout+stderr buffer this pattern is
 * matched against (`exec.ts`'s `combinedOutput`), not only to the whole
 * buffer's very first/last character. That is what a recipe like
 * `^OK \(` needs against a real runner that prints an unrelated line
 * first -- phpunit's own version banner ahead of its green summary, the
 * motivating shape -- since without `m` a leading banner line puts `^`
 * out of reach of the summary line entirely. There is still no flags
 * syntax on this option beyond that: fold `i`/`s` into the pattern
 * itself (JS `RegExp` has no inline-flag syntax at all -- there is no
 * followable `(?i)`/`(?s)` form to fall back on). `(?m)` in particular
 * is NOT redundant-but-harmless: it is not valid JS `RegExp` source
 * (`new RegExp("(?m)...")` throws `SyntaxError: Invalid group`), so it
 * is rejected as a usage error like any other unparseable pattern --
 * the `m` flag this option always applies makes the group unnecessary,
 * it does not make the group valid. This
 * deliberately differs from `--require-baseline-evidence`, which stays
 * flagless (no `m`): that option gates whether a run may proceed at
 * all, not what a test-runner-shaped success line looks like, so it has
 * no equivalent per-line-anchoring need.
 *
 * An unparseable pattern throws the same `SyntaxError` a plain `new
 * RegExp(...)` would; each caller wraps that into its own usage-error
 * shape (`InvalidArgumentError` for the CLI option, `plan_invalid` for
 * the plan-file field).
 */
export function compilePassRegex(source: string): RegExp {
  return new RegExp(source, "m");
}

/**
 * The `(the <subject>'s captured ... tail was truncated; the pattern may
 * have matched output outside the captured tail)` suffix (or `""` when
 * neither side was truncated) a `--pass-regex`/`--require-baseline-
 * evidence` miss warning appends, wherever one is reported: `probe`'s own
 * baseline-stage miss (`probe/setup.ts`, `subject: "baseline"`) and
 * `verify`'s per-check miss (`verify/index.ts`, `subject: "check"`)
 * alike, so the caveat is worded identically in both places rather than
 * maintained as two copies that could drift apart. Lifted out of
 * `probe/setup.ts` (where it used to be a private, baseline-only helper
 * hardcoding "the baseline's") into this shared module for exactly that
 * reason; `probe/setup.ts`'s own call sites pass `"baseline"` and are
 * otherwise unchanged, so this move is behaviour-preserving there.
 */
export function truncationNote(
  subject: string,
  stdoutTruncated: boolean,
  stderrTruncated: boolean,
): string {
  const truncatedSides = [
    stdoutTruncated ? "stdout" : undefined,
    stderrTruncated ? "stderr" : undefined,
  ].filter((side): side is string => side !== undefined);
  return truncatedSides.length > 0
    ? ` (the ${subject}'s captured ${truncatedSides.join(" and ")} tail was truncated; the pattern may have matched output outside the captured tail)`
    : "";
}

/**
 * The warning a matched `--pass-regex`/`passWhen.regex` predicate emits
 * when the run it just overruled still exited non-zero: shared by
 * `verify/index.ts` (`prefix: "<name>: "`, `outputSubject: "the check's
 * output"`, `exitSubject: "the check"`) and `probe/setup.ts`'s baseline
 * verdict (`prefix: ""`, `outputSubject: "the baseline output"`,
 * `exitSubject: "the baseline run"`), so the 128+N signal-band wording
 * (what a shell reports for a child killed by signal N -- "the suite may
 * have been cut short" rather than reading like deprecation noise, see
 * `signalNumberFromExitCode`) is worded identically in both places
 * rather than maintained as two copies that could drift apart. `probe`'s
 * own call site passes the exact `prefix`/`outputSubject`/`exitSubject`
 * strings its pre-existing text already used, so this lift is
 * behaviour-preserving there; its warning text (and its tests) are
 * unchanged.
 */
export function nonZeroPassWarning(params: {
  prefix: string;
  outputSubject: string;
  exitSubject: string;
  pattern: string;
  exitCode: number | null;
  logPath: string;
}): string {
  const { prefix, outputSubject, exitSubject, pattern, exitCode, logPath } =
    params;
  const signalCode = signalNumberFromExitCode(exitCode);
  return signalCode !== undefined
    ? `${prefix}--pass-regex (${pattern}) matched ${outputSubject} but ${exitSubject} exited with ${String(exitCode)}, the code a shell reports for a process killed by signal ${String(signalCode)}; the suite may have been cut short; see ${logPath}`
    : `${prefix}--pass-regex (${pattern}) matched ${outputSubject} despite a non-zero exit code (${String(exitCode)}); treated as a pass (e.g. deprecation-notice noise), not a failure; see ${logPath}`;
}

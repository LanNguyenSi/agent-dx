#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import {
  buildEnvelope,
  currentRunId,
  UsageError,
  type EnvelopeInput,
  type EnvelopeOutput,
} from "./envelope.js";
import {
  doctor,
  DEFAULT_OPTIONAL,
  DEFAULT_REQUIRED,
  type DoctorResult,
} from "./doctor/index.js";
import { execCommand, stdioWatchBoundMs, type ExecResult } from "./exec.js";
import {
  verify,
  DEFAULT_CHECKS,
  DEFAULT_MAX_FAILURES,
  type ExecLike,
  type VerifyResult,
} from "./verify/index.js";
import {
  probe,
  probePlan,
  type ExpectVerdict,
  type IsolationMode,
  type ProbePlanResult,
} from "./probe/index.js";
import {
  parsePlanFile,
  type PlanMutantSpec,
  type ProbePlanSpec,
} from "./probe/plan.js";
import { compilePassRegex } from "./pass-regex.js";
import { reconcileEnvelopeDiffTruncation } from "./probe/mutant.js";
import {
  mutationProbeReportItem,
  mutationProbeReportItems,
  parsePrintFields,
  renderPrint,
  renderProbeSummary,
  type ReportItemDefinition,
  type SummaryInput,
} from "./probe/summary.js";
import { linkEntryUsageError } from "./probe/link-list.js";
import {
  init,
  renderInitText,
  ALL_HARNESSES,
  InitFsUsageError,
  type Harness,
  type InitResult,
} from "./init/index.js";
import { drift, type DriftResult } from "./drift/index.js";
import {
  DEFAULT_MAX_DELETE_PERCENT,
  hygiene,
  type HygieneResult,
} from "./hygiene/index.js";
import {
  parsePatchPlan,
  patch,
  PatchUsageError,
  type PatchEditSpec,
  type PatchResult,
} from "./patch/index.js";
import {
  captureSnapshot,
  compareSnapshots,
  persistSnapshot,
  readSnapshot,
  outsideCheckout,
} from "./snapshot/index.js";
import { checkoutIdentity } from "./snapshot/git.js";
import { guard, type GuardResult } from "./guard/index.js";
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  sweepWorktrees,
  WorktreeRefusal,
  type CreateWorktreeResult,
  type ListWorktreesResult,
  type RemoveWorktreeResult,
  type SweepWorktreesResult,
} from "./worktree/index.js";

function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const text = fs.readFileSync(url, "utf8");
    const pkg = JSON.parse(text) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readVersion();

interface GlobalOptions {
  format: "json" | "text";
  cwd?: string;
  maxChars: string;
  logDir?: string;
  /** `--json`: a no-op alias for `-f json` (already the default),
   * present so the common instinct to ask for JSON explicitly is never
   * an unknown-option error. `true` only when the flag was actually
   * given; conflicts with an explicit `-f text` (see `resolveGlobal`). */
  json?: boolean;
}

export interface ResolvedGlobal {
  format: "json" | "text";
  cwd: string;
  maxChars: number;
  logDir: string;
}

function parseFormat(value: string): "json" | "text" {
  if (value !== "json" && value !== "text") {
    throw new InvalidArgumentError(
      `format must be "json" or "text" (got "${value}")`,
    );
  }
  return value;
}

function parseMaxChars(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError(
      `max-chars must be a positive number (got "${value}")`,
    );
  }
  return value;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `parseList` for an option documented as REPEATABLE as well as
 * comma-separated: commander calls a coercion function once per
 * occurrence of the flag and hands it what the previous occurrence
 * returned, so a coercion that ignores `previous` (as `parseList` does,
 * by design, for the last-value-wins options) silently drops every
 * earlier occurrence's values. Accumulating instead makes both spellings
 * work, and mixable: `--target a.py --target b.py`, `--target a.py,b.py`,
 * and `--target a.py --target b.py,c.py` all reach the command as the
 * list they read as. `previous` is the option's own default (`[]`) on the
 * first occurrence, which is why it is still guarded. */
function collectList(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), ...parseList(value)];
}

/** `--link`'s own comma-separated parse, plus `linkEntryUsageError`
 * (shared with a `--plan` file's own `link` field and the repo defaults
 * file), so all three `link` sources genuinely share one rule -- see
 * that function's own docblock for why a `--link` value is checked at
 * all when it never reaches a shell either way. */
function parseLinkList(value: string): string[] {
  const raw = parseList(value);
  for (const entry of raw) {
    const err = linkEntryUsageError(entry);
    if (err !== undefined) {
      throw new InvalidArgumentError(`--link: "${entry}" ${err}`);
    }
  }
  return raw;
}

/** `-H, --harness <list>`: `claude`, `codex`, `opencode`, comma-separated,
 * or the single literal `all`. `all` cannot be mixed with a named harness
 * (its meaning, "every harness", would otherwise be ambiguous alongside an
 * explicit subset). */
function parseHarnessList(value: string): Harness[] {
  const raw = parseList(value);
  if (raw.length === 0) {
    throw new InvalidArgumentError(
      "-H/--harness: at least one harness is required",
    );
  }
  if (raw.includes("all")) {
    if (raw.length !== 1) {
      throw new InvalidArgumentError(
        '-H/--harness: "all" must not be combined with other harness names',
      );
    }
    return [...ALL_HARNESSES];
  }
  const seen: Harness[] = [];
  for (const name of raw) {
    if (name !== "claude" && name !== "codex" && name !== "opencode") {
      throw new InvalidArgumentError(
        `-H/--harness: unknown harness "${name}" (must be claude, codex, opencode, or all)`,
      );
    }
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** `-x name=command`, accumulated across repeated flags into an object
 * keyed by check name (a later `-x` for the same name overrides an
 * earlier one). Splits on the first `=` only, so a command containing
 * `=` (e.g. `FOO=1 npm test`) is preserved intact. */
export function parseExecOverride(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const idx = value.indexOf("=");
  if (idx <= 0) {
    throw new InvalidArgumentError(
      `-x, --exec must be name=command (got "${value}")`,
    );
  }
  const name = value.slice(0, idx).trim();
  const command = value.slice(idx + 1);
  if (!name) {
    throw new InvalidArgumentError(
      `-x, --exec: empty check name in "${value}"`,
    );
  }
  return { ...previous, [name]: command };
}

/** `--env NAME=VALUE`, accumulated across repeated flags into an object
 * keyed by variable name (a later `--env` for the same name overrides an
 * earlier one). Splits on the first `=` only, so a value containing `=`
 * is preserved intact; no `=` at all, or an empty name before it, is a
 * usage error rather than a silently-dropped variable. `previous` is
 * `undefined` on the first `--env` (no default value is registered for
 * the option, so an invocation that never passes `--env` leaves
 * `opts.env` `undefined` rather than an always-present `{}`, which
 * `requirePlanExclusive`'s presence check below relies on). */
export function parseEnvOption(
  value: string,
  previous: Record<string, string> | undefined,
): Record<string, string> {
  const idx = value.indexOf("=");
  if (idx <= 0) {
    throw new InvalidArgumentError(`--env must be NAME=VALUE (got "${value}")`);
  }
  const name = value.slice(0, idx);
  const varValue = value.slice(idx + 1);
  return { ...previous, [name]: varValue };
}

/** Returns the validated raw string (not a number): mirrors
 * `parseMaxChars`'s style so a default value never has to pass back
 * through this parser (commander does not re-run a custom parser over an
 * option's literal default). Converted to a number where it is consumed. */
// setTimeout's delay is coerced to a signed 32-bit int internally; a
// millisecond value above this rolls over instead of waiting, which would
// make --timeout silently fire (near-)immediately rather than usefully.
const MAX_TIMEOUT_MS = 2147483647;

function parseTimeoutSeconds(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError(
      `--timeout must be a positive number of seconds (got "${value}")`,
    );
  }
  if (n * 1000 > MAX_TIMEOUT_MS) {
    throw new InvalidArgumentError(
      `--timeout in milliseconds must not exceed ${MAX_TIMEOUT_MS} (got "${value}" seconds)`,
    );
  }
  return value;
}

/** Compiles `--require-baseline-evidence <regex>` into a `RegExp`,
 * rejecting an unparseable pattern as a usage error rather than letting
 * it reach `probe()` and throw from inside the run. No flags are applied
 * (a caller who needs `i`/`m`/`s` should fold that into the pattern
 * itself, e.g. `(?i)` is not supported by JS `RegExp` -- there is no
 * flags syntax on this option at all, only the bare pattern). */
function parseRequireBaselineEvidence(value: string): RegExp {
  try {
    return new RegExp(value);
  } catch (err) {
    throw new InvalidArgumentError(
      `--require-baseline-evidence must be a valid regular expression (got "${value}"): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Compiles `--pass-regex <regex>` via the shared `compilePassRegex`
 * (`pass-regex.ts`) -- the same compile `probe/plan.ts`'s `validatePlan`
 * uses for `passWhen.regex`, so both parsers apply the same `m` flag
 * (per-line `^`/`$` anchoring; see `pass-regex.ts`'s own docblock) and
 * an unparseable pattern is a usage error before it ever reaches
 * `probe()`/`probePlan()`, rather than throwing from inside the run. */
function parsePassRegex(value: string): RegExp {
  try {
    return compilePassRegex(value);
  } catch (err) {
    throw new InvalidArgumentError(
      `--pass-regex must be a valid regular expression (got "${value}"): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** `verify`'s own `--pass-regex name=regex`, accumulated across repeated
 * flags into an object keyed by check name (a later `--pass-regex` for
 * the same name overrides an earlier one) -- parsed the same way as `-x
 * name=command` (`parseExecOverride`), splitting on the first `=` only,
 * so a pattern containing `=` is preserved intact. Compiles the pattern
 * through the same shared `compilePassRegex` (`m` flag) `probe`'s own
 * `--pass-regex` and `probe/plan.ts`'s `validatePlan` use, so an
 * unparseable pattern is a usage error here -- naming both the check and
 * the pattern -- before it ever reaches `verify()`. Unlike probe's single
 * un-keyed `--pass-regex <regex>`, this option is per-check, mirroring
 * `-x`'s own name=value shape rather than probe's. */
export function parsePassRegexOverride(
  value: string,
  previous: Record<string, RegExp>,
): Record<string, RegExp> {
  const idx = value.indexOf("=");
  if (idx <= 0) {
    throw new InvalidArgumentError(
      `--pass-regex must be name=regex (got "${value}")`,
    );
  }
  const name = value.slice(0, idx).trim();
  const source = value.slice(idx + 1);
  if (!name) {
    throw new InvalidArgumentError(
      `--pass-regex: empty check name in "${value}"`,
    );
  }
  if (source === "") {
    // An empty pattern compiles fine (`new RegExp("", "m")` is `/(?:)/m`,
    // matching literally any output including none), so it would silently
    // turn this check's verdict into an unconditional pass -- worth
    // rejecting the same way an empty check name already is, rather than
    // letting a truncated `name=regex` (a stray trailing `=`, or a
    // forgotten pattern) through as a usage error nobody sees until the
    // check that never fails.
    throw new InvalidArgumentError(
      `--pass-regex: empty pattern for check "${name}" would match any output`,
    );
  }
  try {
    return { ...previous, [name]: compilePassRegex(source) };
  } catch (err) {
    throw new InvalidArgumentError(
      `--pass-regex must be a valid regular expression for check "${name}" (got "${source}"): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** `--`-prefixed flags this matcher knows take a following argument, so
 * that argument is not itself mistaken for a targeted file/pattern:
 * `vitest run -t <name>` names one test by pattern, not a file, and
 * still runs the whole suite's setup against it. Deliberately narrow
 * (this one flag only): a flag this does not recognize is judged by
 * whether IT starts with `-`, so an unknown flag that takes an argument
 * still makes the command look targeted rather than full-suite -- the
 * same "prints no hint rather than guessing" bias the rest of this
 * matcher already applies. */
const FLAGS_CONSUMING_NEXT_TOKEN = new Set(["-t"]);

/** Whether every token in `tokens` is a flag (or a flag's own
 * argument, consumed via `FLAGS_CONSUMING_NEXT_TOKEN`): true for
 * `["--coverage"]` and `["-t", "some pattern"]`, false the moment a
 * token that is neither is reached (a file or pattern argument, e.g.
 * `test/x.test.ts`). A bare `--` (npm/yarn/pnpm's own argument
 * separator) is flag-shaped here, the same as any other token that
 * starts with `-`: it never by itself disqualifies a command from
 * looking full-suite, and whatever follows it is judged by this exact
 * same rule, token by token -- there is no separate stripping step
 * anywhere in this matcher. */
function tokensLookLikeFlagsOnly(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("-")) return false;
    if (FLAGS_CONSUMING_NEXT_TOKEN.has(token)) i++;
  }
  return true;
}

/** Whether `rest` (everything after the recognized test-runner prefix,
 * already trimmed) still looks like the whole suite: empty, or nothing
 * but flags per `tokensLookLikeFlagsOnly` above, a bare `--`
 * argument-separator (npm/yarn/pnpm's own divider before forwarded
 * args) included -- it is flag-shaped there too, so `npm test --
 * --coverage` is still full-suite while `npm test -- test/x.test.ts`
 * is not, with no separate handling for the separator itself. Shared by
 * the `npm test`, `npm run test[:*]`, `yarn test` and `pnpm test`
 * shapes below, all of which forward extra arguments to the underlying
 * runner the same way. */
function restLooksLikeFullSuite(rest: string): boolean {
  if (rest === "") return true;
  return tokensLookLikeFlagsOnly(rest.split(/\s+/));
}

/**
 * Whether `cmd` looks like it runs a whole test suite rather than one
 * targeted file: `npm test`, `npm run test`/`npm run test:<anything>`,
 * `yarn test` or `pnpm test`, each with nothing after it but flags (a
 * bare `--` argument separator is flags-only shaped in its own right,
 * so `npm test -- --coverage` is still full-suite while `npm test --
 * test/x.test.ts` -- a real file forwarded through it -- is not, the
 * same rule applied to every token, the separator included, with no
 * special-case stripping anywhere); or `vitest run` (bare, through
 * `npx` or not) with nothing after it but flags, `-t <name>` (a
 * pattern, not a file) and a forwarded `--` (`npx vitest run --
 * --coverage`) included. A
 * `probe` over a command like this runs it twice, serially (baseline,
 * then mutant), with no bound when `--timeout` was not given -- exactly
 * the shape that printed the CLI's own full-suite hint. Deliberately
 * narrow (these shapes only): a command this does not recognize prints
 * no hint, rather than guessing.
 */
export function looksLikeFullSuiteTestCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  const npmTest = /^npm(?:\.cmd)?\s+test\b(.*)$/.exec(trimmed);
  if (npmTest !== null) return restLooksLikeFullSuite(npmTest[1].trim());
  const npmRunTest =
    /^npm(?:\.cmd)?\s+run\s+test(?::[\w:-]*)?(?:\s+(.*))?$/.exec(trimmed);
  if (npmRunTest !== null) {
    return restLooksLikeFullSuite((npmRunTest[1] ?? "").trim());
  }
  const yarnTest = /^yarn\s+test\b(.*)$/.exec(trimmed);
  if (yarnTest !== null) return restLooksLikeFullSuite(yarnTest[1].trim());
  const pnpmTest = /^pnpm\s+test\b(.*)$/.exec(trimmed);
  if (pnpmTest !== null) return restLooksLikeFullSuite(pnpmTest[1].trim());
  const match = /(?:^|\s)(?:npx\s+)?vitest\s+run\b(.*)$/.exec(trimmed);
  if (match === null) return false;
  const rest = match[1].trim();
  if (rest === "") return true;
  return tokensLookLikeFlagsOnly(rest.split(/\s+/));
}

function parseMaxFailures(value: string): string {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError(
      `--max-failures must be a positive integer (got "${value}")`,
    );
  }
  return value;
}

/** Resolves cwd/maxChars/logDir without validating that cwd exists: used
 * only for error reporting once we already know something has gone wrong
 * and a best-effort `cwd` value is all the envelope needs. */
function bestEffortGlobal(opts: GlobalOptions): ResolvedGlobal {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const maxChars = Number(opts.maxChars);
  // An empty value, from the flag or from the env, counts as unset:
  // `path.resolve("")` is the invocation directory, which would bury the
  // caller's logs inside the checkout rather than fall back to the default.
  const requestedLogDir =
    opts.logDir || process.env.AGENT_PRIMITIVES_LOG_DIR || undefined;
  // A relative log dir resolves against the directory the command was
  // started in (`process.cwd()`), never against `-C/--cwd`: checks run
  // under `cwd`, and resolving there too would bury the caller's own logs
  // inside the verified checkout. Resolving here, once, keeps every path
  // the envelope's `logs` carries absolute. The tmpdir default is already
  // absolute and stays untouched.
  const logDir =
    requestedLogDir !== undefined
      ? path.resolve(requestedLogDir)
      : path.join(os.tmpdir(), "agent-primitives", currentRunId());
  return { format: opts.format, cwd, maxChars, logDir };
}

/**
 * A `UsageError` carrying a specific machine-readable `reason` for the
 * envelope, for a CLI-level usage error more specific than the generic
 * `"usage_error"` `mapTopLevelError` otherwise reports. Mirrors
 * `InitFsUsageError`'s own `reason` field, minus that class's
 * per-target bookkeeping, which has no equivalent outside `init`.
 */
class CliReasonedUsageError extends UsageError {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
  }
}

/** Resolves and validates the global options. Throws UsageError when `-C`
 * names a path that does not exist or is not a directory, or when
 * `--json` (a no-op alias for `-f json`) is combined with an explicit
 * `-f text` -- the two disagree about which format the caller wants. */
function resolveGlobal(opts: GlobalOptions): ResolvedGlobal {
  const global = bestEffortGlobal(opts);
  if (opts.json && global.format === "text") {
    throw new CliReasonedUsageError(
      "--json conflicts with -f text (use one or the other)",
      "format_conflict",
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(global.cwd);
  } catch {
    throw new UsageError(`cwd does not exist: ${global.cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new UsageError(`cwd is not a directory: ${global.cwd}`);
  }
  return global;
}

/**
 * Pure classification of a stdout write error, kept separate from
 * `installEpipeGuard` so it can be unit-tested without spawning a process
 * or breaking a real pipe. EPIPE (the reader closed the pipe early, e.g.
 * `| head`) is not a failure of this process: it maps to the exit code
 * the command was already going to use, with nothing on stderr. Any other
 * write error is a genuine failure: one line on stderr naming it, exit 2,
 * and (critically) no throw, so it never surfaces as an unhandled 'error'
 * event with a raw stack trace instead of a stable exit code.
 */
export function classifyStdoutError(
  err: NodeJS.ErrnoException,
  successExitCode: number,
): { exitCode: number; stderrLine?: string } {
  if (err.code === "EPIPE") {
    return { exitCode: successExitCode };
  }
  return {
    exitCode: 2,
    stderrLine: `agent-primitives: stdout write failed: ${err.code ?? err.message}\n`,
  };
}

let epipeGuardInstalled = false;
let pendingExitCode = 0;
function installEpipeGuard(): void {
  if (epipeGuardInstalled) return;
  epipeGuardInstalled = true;
  // Defense in depth alongside the write callback below: a stream error
  // can surface as an 'error' event rather than a callback argument
  // (notably when the write was already queued when the pipe broke), and
  // an unhandled 'error' event on process.stdout would end the process
  // with a stack trace instead of a stable exit code.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    const { exitCode, stderrLine } = classifyStdoutError(err, pendingExitCode);
    if (stderrLine) process.stderr.write(stderrLine);
    process.exit(exitCode);
  });
}

/**
 * Writes `data` to stdout and exits only once the write has fully drained
 * (via the write callback), instead of calling process.exit() right after
 * write() returns. Exiting immediately after write() races the write: for
 * output larger than the pipe buffer (64 KiB on most platforms), the
 * process can exit before the OS has drained the buffer, truncating the
 * output the reader sees.
 */
function writeAndExit(data: string, exitCode: number): void {
  pendingExitCode = exitCode;
  installEpipeGuard();
  writeAndExitTo(
    data,
    exitCode,
    process.stdout,
    (code) => process.exit(code),
    (line) => {
      process.stderr.write(line);
    },
  );
}

/** The part of `process.stdout` this module actually uses, so the write
 * path can be driven in a unit test by a fake that yields an error to the
 * callback without breaking a real pipe. */
export interface StdoutSink {
  write(data: string, callback: (err?: Error | null) => void): boolean;
}

/**
 * Writes `data` and reports the outcome only once the write has fully
 * drained (via the write callback), instead of right after write()
 * returns. Exiting immediately after write() races the write: for output
 * larger than the pipe buffer (64 KiB on most platforms), the process can
 * exit before the OS has drained the buffer, truncating the output the
 * reader sees.
 *
 * The callback's own error argument is honoured: `write()` reports a
 * failed write there, so ignoring it would leave the non-EPIPE branch of
 * `classifyStdoutError` unreachable and let a genuinely failed write exit
 * 0 with nothing said about it.
 *
 * `onExit`/`onStderr` are injection points so a test can observe the
 * mapping without terminating the test process.
 */
export function writeAndExitTo(
  data: string,
  exitCode: number,
  sink: StdoutSink,
  onExit: (code: number) => void,
  onStderr: (line: string) => void,
): void {
  sink.write(data, (err) => {
    if (err) {
      const classified = classifyStdoutError(err, exitCode);
      if (classified.stderrLine) onStderr(classified.stderrLine);
      onExit(classified.exitCode);
      return;
    }
    onExit(exitCode);
  });
}

function textTruncationMarker(totalChars: number): string {
  return `\n... [truncated, ${totalChars} characters total]\n`;
}

/**
 * Bounds a text rendering to `maxChars` characters, never more, and states
 * the true full length in the marker, the same honest way the JSON path
 * names the envelope's real size instead of only flagging that something
 * was cut.
 *
 * Below the marker's own length there is no room for both content and a
 * complete marker; the marker itself is then sliced, so a very small `-m`
 * yields a short, truthful fragment rather than an output longer than the
 * caller asked for.
 */
export function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = textTruncationMarker(text.length);
  if (marker.length >= maxChars) return marker.slice(0, Math.max(0, maxChars));
  return text.slice(0, maxChars - marker.length) + marker;
}

/**
 * Bounds a `--report` JSON array to `maxChars` without ever cutting it
 * into invalid JSON (which is exactly what `boundText` does to it, and a
 * report is evidence meant to be pasted). When the whole array fits it
 * is returned verbatim; otherwise only the WHOLE leading items that fit
 * are kept, printed as a valid array (possibly empty), and the number of
 * items left out is returned as `omitted` so the caller can warn about
 * it and name the full, untruncated result (which `probe` saves to its
 * log dir on every run).
 */
export function fitReportItems<T>(
  items: readonly T[],
  maxChars: number,
): { text: string; omitted: number } {
  const full = JSON.stringify(items, null, 2) + "\n";
  if (full.length <= maxChars) return { text: full, omitted: 0 };
  for (let kept = items.length - 1; kept >= 0; kept--) {
    const text = JSON.stringify(items.slice(0, kept), null, 2) + "\n";
    if (text.length <= maxChars) return { text, omitted: items.length - kept };
  }
  return { text: "[]\n", omitted: items.length };
}

/** The path of the full, untruncated result the run saved, the same
 * pointer `--summary` reads: `fullResult` when the envelope's own
 * reduction set it, else the `result-full-*.json` entry of `logs` (which
 * a persisting command like `probe` lists even when the envelope itself
 * fit). Undefined when no such file was written (no log dir, or a failed
 * write, which the envelope says in a warning of its own). */
function fullResultPathOf(
  envelope: Record<string, unknown>,
): string | undefined {
  const savedLog = Array.isArray(envelope.logs)
    ? envelope.logs.find(
        (l): l is string =>
          typeof l === "string" &&
          /^result-full-.*\.json$/.test(path.basename(l)),
      )
    : undefined;
  return typeof envelope.fullResult === "string"
    ? envelope.fullResult
    : savedLog === undefined
      ? undefined
      : path.resolve(savedLog);
}

/**
 * Shared output path for every command: JSON envelope by default, or a
 * bounded text rendering when `-f text` is set. A command without its own
 * text renderer falls back to pretty-printed JSON rather than erroring or
 * silently ignoring `-f text`.
 */
function emit(
  envelope: Record<string, unknown>,
  exitCode: number,
  global: { format: "json" | "text"; maxChars: number },
  textRenderer?: () => string,
): void {
  if (global.format === "text") {
    const raw = textRenderer
      ? textRenderer()
      : JSON.stringify(envelope, null, 2) + "\n";
    writeAndExit(boundText(raw, global.maxChars), exitCode);
    return;
  }
  writeAndExit(JSON.stringify(envelope) + "\n", exitCode);
}

/**
 * The exit code convention for a process ended by a signal: 128 plus the
 * signal number (SIGINT is 2, SIGTERM is 15). Exported so the mapping is
 * unit-testable without sending a real signal to the test runner.
 */
export function signalExitCode(signal: "SIGINT" | "SIGTERM"): number {
  return signal === "SIGINT" ? 130 : 143;
}

/**
 * One controller for the whole process, aborted by the signal handlers
 * below and threaded into every command that runs child processes
 * through `exec.ts`. `exec.ts` `SIGKILL`s the aborted child's whole
 * process group, so a check's own worker dies with this CLI instead of
 * being orphaned by the exit: `detached: true` puts each command in a
 * group of its own, which means a terminal's Ctrl-C reaches this process
 * alone. `worktree create`, `worktree remove` and `worktree sweep` also get it for the check
 * they make before their first change.
 *
 * `probe` is deliberately not wired to it: it installs its own handler
 * for the same two signals, because it has a mutated file to restore and
 * a lock to release before the process may end, and it ends the process
 * itself once that is done.
 */
const shutdownController = new AbortController();

/**
 * The one command child this process has in flight, as the promise of
 * its run, or `null`, together with a promise of when its stdio TRULY
 * closes. The signal handler waits on the latter, not the former: a
 * run's own promise can settle early on `exec.ts`'s flush-grace
 * shortcut while a descendant that left the process group still holds
 * the pipes, and only true closure means every write the run had in
 * flight has actually landed (the same distinction `probe`'s own signal
 * handler makes; see `src/probe/session.ts`'s `createRunController`).
 */
let inFlightExec: Promise<ExecResult> | null = null;
let inFlightExecClosed: Promise<void> | null = null;

/** How long the signal handler waits for that run to settle before
 * exiting anyway. A `SIGKILL`ed process group is gone in milliseconds;
 * this bound only matters for something that put itself out of the
 * group's reach, where exiting is still the right answer. */
const DEFAULT_SHUTDOWN_SETTLE_BOUND_MS = 2000;

/** Always below `exec.ts`'s stdio watch bound, for the same reason as
 * `probe`'s `signalSettleBoundMs()`: past that bound no genuine close
 * can arrive any more. */
function shutdownSettleBoundMs(): number {
  return Math.min(DEFAULT_SHUTDOWN_SETTLE_BOUND_MS, stdioWatchBoundMs() - 1);
}

/** `execCommand` plus the tracking above. Handed to `verify` as its
 * `execFn` so the handler has something to wait for; the real
 * `execCommand` is what actually runs. */
const trackingExec: ExecLike = (cmd, options) => {
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((res) => {
    resolveClosed = res;
  });
  const started = execCommand(cmd, {
    ...options,
    onStdioClosed: () => resolveClosed?.(),
  });
  inFlightExec = started;
  inFlightExecClosed = closed;
  void started
    .catch(() => resolveClosed?.())
    .then(() => {
      if (inFlightExec === started) {
        inFlightExec = null;
        inFlightExecClosed = null;
      }
    });
  return started;
};

async function settleInFlightExec(): Promise<void> {
  const pendingClosed = inFlightExecClosed;
  if (pendingClosed === null) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    pendingClosed,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, shutdownSettleBoundMs());
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

/**
 * Set for exactly as long as a `probe()` call is running. `probe`
 * installs its own SIGINT/SIGTERM handlers, which kill its child,
 * restore the file it mutated, release its lock and only then end the
 * process; the handler below therefore stands aside entirely rather than
 * exiting out from under that restore. Flipped immediately before the
 * call and back in a `finally`, with no `await` in between, so no signal
 * can be delivered in a window where neither handler would act.
 */
let probeOwnsShutdown = false;

/**
 * Installs the process-wide SIGINT/SIGTERM handling: abort whatever
 * child is in flight (which `SIGKILL`s its whole process group), wait
 * for that run to settle, then exit with the signal's conventional code.
 *
 * The wait is what keeps a killed check's last write from landing after
 * this process has already gone; it also lets every other listener for
 * the same signal run first, since it yields before exiting.
 *
 * Installed only on the real CLI entrypoint, never on import: a test
 * importing this module for its exports must not have process-wide
 * signal handlers installed behind its back.
 */
function installSignalHandlers(): void {
  let handling = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (probeOwnsShutdown) return;
      if (handling) return;
      handling = true;
      shutdownController.abort();
      void settleInFlightExec().then(() =>
        process.exit(signalExitCode(signal)),
      );
    });
  }
}

const program = new Command();

// Route commander's own usage errors (unknown option, missing required
// option, bad argument, unknown subcommand, ...) through a thrown
// CommanderError instead of an implicit process.exit(1), so they can be
// emitted as the envelope below with status usage_error / exit 2. Must be
// called before `.command()` so every subcommand inherits it.
program.exitOverride();
program.configureOutput({
  // Commander's own error text would otherwise go to stderr alongside our
  // JSON envelope on stdout; suppress it so the only usage_error signal is
  // the envelope itself. --help and --version text (written via writeOut)
  // is left untouched.
  writeErr: () => {},
});

program
  .name("agent-primitives")
  .description(
    "Agent-first CLI primitives: bounded JSON envelopes, a mutation-probe runner, a verify runner, a PATH doctor, an identifier-drift guard, a commit-hygiene guard, an exact-text patcher, checkout snapshot/delta, a bounded-run guard, and a skill installer (init)",
  )
  .version(VERSION)
  .option(
    "-f, --format <format>",
    "output format: json or text",
    parseFormat,
    "json",
  )
  .option("-C, --cwd <dir>", "working directory (defaults to the process cwd)")
  .option(
    "-m, --max-chars <n>",
    "hard bound on the serialized envelope",
    parseMaxChars,
    "8000",
  )
  .option(
    "-l, --log-dir <dir>",
    "directory for logs and full (untruncated) results (defaults to $AGENT_PRIMITIVES_LOG_DIR or <tmpdir>/agent-primitives/<run-id>/); a relative value resolves against the invocation directory, not --cwd; an empty value means unset and falls back to the default",
  )
  .option(
    "--json",
    "alias for -f json (json is already the default); conflicts with -f text",
  );

program
  .command("doctor")
  .description(
    "Check that required and optional binaries are on PATH, plus a few environment checks",
  )
  .option(
    "-r, --required <list>",
    "comma-separated required binary names",
    parseList,
    DEFAULT_REQUIRED,
  )
  .option(
    "-o, --optional <list>",
    "comma-separated optional binary names",
    parseList,
    DEFAULT_OPTIONAL,
  )
  .option(
    "--target <list>",
    "probe target path(s) (relative to cwd or absolute), repeatable and comma-separated; for a .py path among these, the CPython bytecode cache python3 itself resolves for that file is reported, and a co-located __pycache__ is the named fallback whenever python3 cannot be asked or does not answer (absent from PATH, resolving nothing, or doctor's aggregate spawn deadline already spent)",
    collectList,
    [] as string[],
  )
  .action(
    async (
      opts: { required: string[]; optional: string[]; target: string[] },
      command: Command,
    ) => {
      const start = Date.now();
      const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
      const result = await doctor({
        required: opts.required,
        optional: opts.optional,
        cwd: global.cwd,
        targets: opts.target,
      });
      const { envelope, exitCode } = buildEnvelope({
        version: VERSION,
        command: "doctor",
        status: result.status,
        durationMs: Date.now() - start,
        cwd: global.cwd,
        warnings: result.warnings,
        logs: [],
        extra: {
          tools: result.tools,
          checks: result.checks,
          hints: result.hints,
        },
        maxChars: global.maxChars,
        logDir: global.logDir,
      });
      emit(
        envelope,
        exitCode,
        { format: global.format, maxChars: global.maxChars },
        () => renderDoctorText(result),
      );
    },
  );

/** Longest wall-clock limit `guard` accepts, seconds: the timer is a 32-bit
 * millisecond value. */
const MAX_GUARD_TIMEOUT_S = Math.floor(MAX_TIMEOUT_MS / 1000);

function parseGuardTimeout(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_GUARD_TIMEOUT_S) {
    throw new InvalidArgumentError(
      `timeout-s must be a positive number of seconds, at most ${MAX_GUARD_TIMEOUT_S} (got "${value}")`,
    );
  }
  return n;
}

function parseGuardMaxRss(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError(
      `max-rss-MiB must be a positive number of mebibytes (got "${value}")`,
    );
  }
  return n;
}

function parseGuardPollMs(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 20 || n > 60000) {
    throw new InvalidArgumentError(
      `--poll-ms must be an integer from 20 to 60000 (got "${value}")`,
    );
  }
  return n;
}

function renderGuardText(result: GuardResult, command: string): string {
  const lines = [
    `guard ${result.status}: ${result.reason} (exit ${result.exitCode})`,
    `command: ${command}`,
    `duration: ${result.durationMs} ms, peak rss: ${result.peakRssMiB} MiB (largest process ${result.peakProcessRssMiB} MiB) of ${result.limits.maxRssMiB} MiB, ${result.polls} polls`,
  ];
  const listing = (title: string, list: GuardResult["killed"], n: number) => {
    if (n === 0) return;
    lines.push(`${title}: ${n}`);
    for (const p of list) {
      lines.push(
        `  ${p.pid} ${p.inGroup ? "group" : "escaped"} ${p.rssMiB} MiB ${p.command}`,
      );
    }
  };
  listing("killed at the limit", result.killed, result.killedCount);
  listing("leftovers killed", result.leftovers, result.leftoverCount);
  listing("survivors", result.survivors, result.survivorCount);
  for (const w of result.warnings) lines.push(`warning: ${w}`);
  lines.push(`log: ${result.logPath}`);
  if (result.outputTail) lines.push("output tail:", result.outputTail);
  return lines.join("\n") + "\n";
}

program
  .command("guard")
  .description(
    "Run a command (after --) with a wall-clock timeout and a resident-memory cap in its own process group; kill the whole group at either limit, then find, kill and report anything the command left running. Exit codes: 124 timeout, 123 memory cap, 122 leftovers, 2 could not run or could not check for leftovers, 130 or 143 on SIGINT or SIGTERM (no output), otherwise the command's own code",
  )
  .argument("<timeout-s>", "wall-clock limit in seconds", parseGuardTimeout)
  .argument(
    "<max-rss-MiB>",
    "cap on the summed resident memory of the command's process tree, in MiB",
    parseGuardMaxRss,
  )
  .argument("<cmd...>", "the command and its arguments; put them after `--`")
  .option(
    "--poll-ms <n>",
    "how often the process table is sampled, in milliseconds (a spike between two samples can overshoot the cap)",
    parseGuardPollMs,
    200,
  )
  .action(
    async (
      timeoutS: number,
      maxRssMiB: number,
      cmd: string[],
      opts: { pollMs: number },
      command: Command,
    ) => {
      const start = Date.now();
      const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
      const [executable, ...args] = cmd as [string, ...string[]];
      const result = await guard({
        command: executable,
        args,
        timeoutMs: Math.round(timeoutS * 1000),
        maxRssMiB,
        pollMs: opts.pollMs,
        cwd: global.cwd,
        logDir: global.logDir,
        runId: currentRunId(),
        signal: shutdownController.signal,
      });
      const { envelope } = buildEnvelope({
        version: VERSION,
        command: "guard",
        status: result.status,
        durationMs: Date.now() - start,
        cwd: global.cwd,
        warnings: result.warnings,
        // The log exists whenever the command ran, whatever the outcome
        // (`leftover_check_failed` included); only a run that never started
        // has none.
        logs: result.childExitCode !== null ? [result.logPath] : [],
        extra: {
          reason: result.reason,
          exitCode: result.exitCode,
          childExitCode: result.childExitCode,
          limits: result.limits,
          peakRssMiB: result.peakRssMiB,
          peakProcessRssMiB: result.peakProcessRssMiB,
          polls: result.polls,
          failedPolls: result.failedPolls,
          killedCount: result.killedCount,
          killed: result.killed,
          leftoverCount: result.leftoverCount,
          leftovers: result.leftovers,
          survivorCount: result.survivorCount,
          survivors: result.survivors,
          leftoverCheckFailed: result.leftoverCheckFailed,
          outputTail: result.outputTail,
        },
        maxChars: global.maxChars,
        logDir: global.logDir,
      });
      // The exit code is guard's own (see the command description), not the
      // status class's 0/1/2: a caller tells a timeout from a cap from a
      // leftover from the wrapped command's failure without parsing JSON.
      emit(
        envelope,
        result.exitCode,
        { format: global.format, maxChars: global.maxChars },
        () => renderGuardText(result, cmd.join(" ")),
      );
    },
  );

interface VerifyCliOptions {
  checks?: string[];
  exec: Record<string, string>;
  passRegex: Record<string, RegExp>;
  failFast?: boolean;
  timeout?: string;
  maxFailures?: string;
}

program
  .command("verify")
  .description(
    "Run project verify checks (build, typecheck, lint, test by default)",
  )
  .option(
    "-c, --checks <list>",
    `comma-separated check names, in run order (default: ${DEFAULT_CHECKS.join(",")})`,
    parseList,
  )
  .option(
    "-x, --exec <name=command>",
    "override a check's command (repeatable)",
    parseExecOverride,
    {},
  )
  .option(
    "--pass-regex <name=regex>",
    "opt-in per-check success predicate (repeatable): a match against that check's combined stdout+stderr is a pass, its absence a fail, in place of the exit code -- for a test runner whose exit code alone is not trustworthy (e.g. phpunit exiting non-zero on a green suite over deprecation notices); naming a check that is not requested/-x-overridden is a usage error",
    parsePassRegexOverride,
    {},
  )
  .option("--fail-fast", "stop after the first non-pass check")
  .option("--timeout <s>", "per-check timeout in seconds", parseTimeoutSeconds)
  .option(
    "--max-failures <n>",
    "cap each check's own failures list",
    parseMaxFailures,
    String(DEFAULT_MAX_FAILURES),
  )
  .action(async (opts: VerifyCliOptions, command: Command) => {
    const start = Date.now();
    const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
    const result = await verify({
      cwd: global.cwd,
      logDir: global.logDir,
      runId: currentRunId(),
      checks: opts.checks,
      overrides: opts.exec,
      passRegexes: opts.passRegex,
      failFast: Boolean(opts.failFast),
      signal: shutdownController.signal,
      // Not the default `execCommand`: the tracking wrapper, so the
      // signal handler can wait for the check it just killed to settle
      // before this process exits.
      execFn: trackingExec,
      timeoutMs:
        opts.timeout !== undefined ? Number(opts.timeout) * 1000 : undefined,
      maxFailures: Number(opts.maxFailures ?? DEFAULT_MAX_FAILURES),
    });

    // The log path this writes is appended to `logs` BEFORE buildEnvelope
    // runs, so it lands in the envelope's own `logs` field (buildEnvelope
    // copies `logs` into the envelope at call time; a push afterwards
    // would not be reflected there). Same for `warnings`: a write failure
    // is folded in before buildEnvelope reads it, not pushed after.
    const logs = [...result.logs];
    const warnings = [...result.warnings];
    const pendingEnvelopePatch: { truncated?: true } = {};
    writeFullVerifyResult(
      result,
      pendingEnvelopePatch,
      logs,
      warnings,
      global.logDir,
      currentRunId(),
    );

    const { envelope, exitCode } = buildEnvelope({
      version: VERSION,
      command: "verify",
      persistFullResult: true,
      status: result.status,
      durationMs: Date.now() - start,
      cwd: global.cwd,
      warnings,
      logs,
      extra: {
        checks: result.checks,
        totalDurationMs: result.totalDurationMs,
        ...(result.reason ? { reason: result.reason } : {}),
      },
      maxChars: global.maxChars,
      logDir: global.logDir,
    });
    // The max-failures cap is applied before buildEnvelope ever sees the
    // result, so its own size-triggered reduction may not fire even
    // though real content was cut: mark truncated explicitly whenever
    // verify() itself cut anything.
    if (pendingEnvelopePatch.truncated) {
      envelope.truncated = true;
    }
    emit(
      envelope,
      exitCode,
      { format: global.format, maxChars: global.maxChars },
      () => renderVerifyText(result, envelope),
    );
  });

/**
 * When `verify()` capped a check's own `failures` list (`--max-failures`),
 * writes the same checks with every `failures` list left uncapped to
 * `<logDir>/verify-full-<runId>.json`, pushes that path onto `logs`, and
 * sets `envelopePatch.truncated = true` for the caller to fold into the
 * real envelope (the envelope's own size-triggered reduction may never
 * fire even though real content was cut, since the cap already happened
 * before `buildEnvelope` saw the result). A no-op when nothing was
 * truncated. `runId` is a required parameter (the caller passes the same
 * run id used for the verify() call's own log nesting) so that two
 * verify runs sharing a `logDir` never collide on, or silently overwrite,
 * each other's full-result file. A write failure is never swallowed: it
 * still sets `envelopePatch.truncated` (real content actually was cut),
 * and pushes a warning onto `warnings` naming the directory and the
 * error's code (or message when there is no code) so the caller surfaces
 * it instead of silently losing the uncapped detail.
 * Exported and unit-tested directly (with a synthetic truncated
 * `VerifyResult`) so both effects, the truncated flag and the on-disk
 * file, are independently verified rather than only exercised indirectly
 * through a real CLI run (which the shipped `generic` detector alone can
 * never actually trigger, since it never parses more failures than the
 * invariant's own single synthetic entry per check).
 */
export function writeFullVerifyResult(
  result: VerifyResult,
  envelopePatch: { truncated?: true },
  logs: string[],
  warnings: string[],
  logDir: string,
  runId: string,
): void {
  if (!result.truncatedByMaxFailures) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const fullResultPath = path.join(logDir, `verify-full-${runId}.json`);
    fs.writeFileSync(
      fullResultPath,
      JSON.stringify({ checks: result.fullChecks }, null, 2),
    );
    logs.push(fullResultPath);
  } catch (err) {
    const code =
      err instanceof Error && "code" in err
        ? ((err as NodeJS.ErrnoException).code ?? err.message)
        : String(err);
    warnings.push(
      `writeFullVerifyResult: failed to write full result to ${logDir}: ${code}`,
    );
  }
  envelopePatch.truncated = true;
}

function renderVerifyText(
  result: VerifyResult,
  envelope?: Record<string, unknown>,
): string {
  const lines: string[] = [];
  lines.push(`status: ${result.status}`);
  lines.push("");
  lines.push("checks:");
  for (const check of result.checks) {
    lines.push(
      `  [${check.status}] ${check.name}${check.command ? ` (${check.command})` : ""} - ${check.durationMs}ms`,
    );
    for (const failure of check.failures) {
      const where = [failure.file, failure.line].filter(Boolean).join(":");
      lines.push(`    - ${where ? `${where}: ` : ""}${failure.message}`);
    }
  }
  lines.push("");
  lines.push(`totalDurationMs: ${result.totalDurationMs}`);
  const logs = (envelope?.logs ?? []) as string[];
  if (logs.length > 0) {
    lines.push("");
    lines.push("logs:");
    for (const log of logs) lines.push(`  - ${log}`);
  }
  const warnings = (envelope?.warnings ?? result.warnings) as string[];
  if (warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const warning of warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderDoctorText(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push(`status: ${result.status}`);
  lines.push("");
  lines.push("tools:");
  for (const tool of result.tools) {
    const marker = tool.found ? "OK" : "MISSING";
    const req = tool.required ? "required" : "optional";
    const version = tool.version
      ? ` (${tool.version})`
      : tool.versionCheck === "timed_out"
        ? " (version check timed out)"
        : tool.versionCheck === "skipped_deadline"
          ? " (version check skipped: aggregate deadline reached)"
          : "";
    const at = tool.path ? ` at ${tool.path}` : "";
    lines.push(`  [${marker}] ${tool.name} (${req})${at}${version}`);
  }
  lines.push("");
  lines.push("checks:");
  for (const check of result.checks) {
    lines.push(
      `  [${check.ok ? "ok" : "warn"}] ${check.name}: ${check.detail ?? ""}`,
    );
  }
  if (result.hints.length > 0) {
    lines.push("");
    lines.push("hints:");
    for (const hint of result.hints) lines.push(`  - ${hint}`);
  }
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

interface ProbeCliOptions {
  /** Optional at the option-parser level so `-p/--patch` alone can
   * derive it; `resolveMutantForm` still requires it for `-r` and
   * `-M`/`-w`, which have nothing to derive it from. */
  file?: string;
  /** Optional for the same reason, except that `-p` does not derive a
   * line so much as report the one the patch changed: passing it with
   * `-p` neither moves the mutation nor changes what is reported. */
  line?: number;
  replace?: string;
  match?: string;
  with?: string;
  patch?: string;
  /** Optional at the option-parser level so `--plan` can supply it;
   * required (and checked in the action) for every single-mutant run. */
  test?: string;
  pre?: string;
  /** Only ever present when at least one `--env` was given (no default
   * value is registered for the option): `requirePlanExclusive`'s
   * presence check (`opts[key] !== undefined`) depends on that. */
  env?: Record<string, string>;
  plan?: string;
  isolation: IsolationMode;
  expect: ExpectVerdict;
  timeout?: string;
  link?: string[];
  allowOutside?: boolean;
  requireBaselineEvidence?: RegExp;
  passRegex?: RegExp;
  summary?: boolean;
  print?: string[];
  /** The selected `--report` kind (validated while the options are
   * parsed; `REPORT_KINDS` is the only accepted vocabulary). */
  report?: string;
  /** `--replayed`: the `--report mutation-probes` items describe replays
   * of prior-round definitions (`replayed: true`) rather than newly run
   * probes (`replayed: false`, the default). */
  replayed?: boolean;
}

/** `--print` value: validated while the options are parsed, so an unknown
 * field is a usage error before the probe spends a run. */
function parsePrintOption(value: string): string[] {
  try {
    return parsePrintFields(value);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

/** The report kinds `--report` accepts, in the option's own vocabulary.
 * `mutation-probes` prints the orchestrator implementer contract's
 * `mutation_probes` items, one per mutant. */
const REPORT_KINDS: readonly string[] = ["mutation-probes"];

/** `--report` value: validated while the options are parsed, so an
 * unknown kind is a usage error before the probe spends a run (the same
 * rule `--print` applies to an unknown field). */
function parseReportOption(value: string): string {
  if (!REPORT_KINDS.includes(value)) {
    throw new InvalidArgumentError(
      `--report: unknown report "${value}" (known reports: ${REPORT_KINDS.join(", ")})`,
    );
  }
  return value;
}

/** The view options `probe` accepts together, checked once the whole
 * option set is in: `--summary`, `--print` and `--report` are three
 * renderings of one result, so naming more than one has no honest
 * winner (a usage error, exactly as `--summary` with `--print` already
 * was); `--replayed` shapes only the `--report mutation-probes` items,
 * so it is refused outright rather than silently ignored without them. */
function requireExclusiveViews(opts: ProbeCliOptions): void {
  if (opts.summary && opts.print !== undefined) {
    throw new UsageError("probe: --summary and --print are mutually exclusive");
  }
  if (opts.report !== undefined && (opts.summary || opts.print !== undefined)) {
    throw new UsageError(
      "probe: --report is mutually exclusive with --summary and --print",
    );
  }
  if (opts.replayed && opts.report === undefined) {
    throw new UsageError(
      "probe: --replayed requires --report (it only shapes the printed " +
        "report items; the JSON envelope and the other views are unchanged " +
        "by it)",
    );
  }
}

/** Emits a probe envelope, or, with `--summary` / `--print` / `--report`,
 * the selected view of it instead. The exit code is the one already
 * computed for the envelope; the envelope itself is built unchanged
 * either way. The three views are mutually exclusive (checked by
 * `requireExclusiveViews` before any run starts). A `--report` array
 * that does not fit `-m` prints only whole items (always valid JSON)
 * and says on stderr how many were left out and where the full result
 * is; the exit code is unchanged by that too. `reportDefinitions` is
 * the `--plan` mutant list, per entry, for the report's
 * definition-fill of rows that never computed a `mutant` record (a
 * single probe's definition comes from `opts` itself). */
function emitProbe(
  opts: ProbeCliOptions,
  envelope: Record<string, unknown>,
  exitCode: number,
  global: ResolvedGlobal,
  summary: SummaryInput,
  envelopeInput: EnvelopeInput,
  reportDefinitions?: readonly (ReportItemDefinition | undefined)[],
): void {
  if (opts.report === "mutation-probes") {
    // The same full-result source `--print` reads, so a field the `-m`
    // reduction cut from the JSON view still reports whole here: the
    // report is evidence meant to be pasted, not a summary of it. The
    // printed text is bounded too, but only at item boundaries, so the
    // paste target stays parseable; what fell out is named on stderr
    // beside the path of the full, untruncated result.
    const unreduced = buildEnvelope({
      ...envelopeInput,
      persistFullResult: false,
      maxChars: Number.MAX_SAFE_INTEGER,
    }).envelope;
    const replayed = opts.replayed === true;
    const items =
      opts.plan !== undefined
        ? mutationProbeReportItems(
            unreduced.plan as { results?: unknown } | undefined,
            replayed,
            reportDefinitions,
            // The envelope's top-level reason is the fallback for rows
            // the stopped plan never reached: they carry no reason of
            // their own, and the contract requires one with every
            // `not_applicable` result.
            typeof unreduced.reason === "string" ? unreduced.reason : undefined,
          )
        : [
            mutationProbeReportItem(
              unreduced,
              replayed,
              singleReportDefinition(opts),
            ),
          ];
    const report = fitReportItems(items, global.maxChars);
    if (report.omitted > 0) {
      const fullResult = fullResultPathOf(envelope);
      process.stderr.write(
        `agent-primitives probe: --report: ${report.omitted} item${
          report.omitted === 1 ? "" : "s"
        } omitted from the printed report (-m ${global.maxChars} ` +
          (fullResult === undefined
            ? "characters); no full result file was written, raise -m)\n"
            : `characters); full result: ${fullResult})\n`),
      );
    }
    writeAndExit(report.text, exitCode);
    return;
  }
  if (opts.print !== undefined) {
    // The same payload the result-full file carries, not the `-m`-reduced
    // envelope: a field that exists must not print as null or shortened
    // because the bound cut it from the JSON view. Only the printed text
    // is bounded. `fullResult` is the one pointer only a reduced envelope has.
    const unreduced = buildEnvelope({
      ...envelopeInput,
      persistFullResult: false,
      maxChars: Number.MAX_SAFE_INTEGER,
    }).envelope;
    // `logs` and `warnings` are overlaid from the emitted envelope: the
    // result-full path and a "full result not written" warning only exist
    // after the real build ran. `logs` is a protected key, never reduced.
    const source: Record<string, unknown> = {
      ...unreduced,
      logs: envelope.logs,
      ...(envelope.warnings === undefined
        ? {}
        : { warnings: envelope.warnings }),
      ...(envelope.fullResult === undefined
        ? {}
        : { fullResult: envelope.fullResult }),
    };
    writeAndExit(
      boundText(renderPrint(source, opts.print), global.maxChars),
      exitCode,
    );
    return;
  }
  if (opts.summary) {
    // `fullResult` is set only on an envelope the reduction could fit; one
    // cut to its fixed fields still names the saved file in `logs`, which
    // is never reduced.
    const fullResult = fullResultPathOf(envelope);
    writeAndExit(
      renderProbeSummary(
        {
          ...summary,
          cwd: global.cwd,
          ...(fullResult !== undefined ? { fullResult } : {}),
        },
        global.maxChars,
      ),
      exitCode,
    );
    return;
  }
  emit(envelope, exitCode, {
    format: global.format,
    maxChars: global.maxChars,
  });
}

/** The `--report` definition-fill for a single probe with no `mutant`
 * record: the probe's own `--file`/`-n` and the mutant form it was
 * given. A whole-line `-r/--replace` has no `before` substring, so
 * `before` stays empty and `after` is the replacement; `-p/--patch` has
 * neither text nor (until a mutant record exists) a derived file/line,
 * so those fields stay the not-recorded empty string. */
function singleReportDefinition(opts: ProbeCliOptions): ReportItemDefinition {
  const definition: ReportItemDefinition = {};
  if (opts.file !== undefined) definition.file = opts.file;
  if (opts.line !== undefined) definition.line = opts.line;
  if (opts.match !== undefined) definition.before = opts.match;
  const after = opts.with ?? opts.replace;
  if (after !== undefined) definition.after = after;
  return definition;
}

/** The same fill for a `--plan` run: one entry per plan mutant, indexed
 * by the position that is also every `plan.results[]` row's `index`. A
 * `patch` entry carries no before/after text, and a `replace` entry has
 * no `before` substring (empty `before`, the replacement as `after`). */
function planReportDefinitions(
  mutants: readonly PlanMutantSpec[],
): ReportItemDefinition[] {
  return mutants.map((mutant) => {
    const definition: ReportItemDefinition = { file: mutant.file };
    if (mutant.line !== undefined) definition.line = mutant.line;
    if (mutant.matchText !== undefined) definition.before = mutant.matchText;
    const after = mutant.withText ?? mutant.replaceText;
    if (after !== undefined) definition.after = after;
    return definition;
  });
}

function parseLine(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError(
      `-n/--line must be a positive integer (got "${value}")`,
    );
  }
  return n;
}

function parseIsolationMode(value: string): IsolationMode {
  if (value !== "worktree" && value !== "inplace") {
    throw new InvalidArgumentError(
      `-i/--isolation must be "worktree" or "inplace" (got "${value}")`,
    );
  }
  return value;
}

function parseExpectVerdict(value: string): ExpectVerdict {
  if (value !== "fail" && value !== "pass") {
    throw new InvalidArgumentError(
      `--expect must be "fail" or "pass" (got "${value}")`,
    );
  }
  return value;
}

type MutantChoice =
  | { form: "replace"; replaceText: string }
  | { form: "match"; matchText: string; withText: string }
  | { form: "patch"; patchPath: string };

/** `-r/--replace` and `-M/--match` (with `-w/--with`) mutate a line the
 * caller names outright, so unlike `-p/--patch` they have nothing to
 * derive `--file`/`-n` from: both stay required for them. Commander's
 * own `requiredOption` no longer enforces this, since `--file` and `-n`
 * had to become plain options so `-p` alone could omit them; checked
 * here instead, as a plain `UsageError` that flows through the same
 * `mapTopLevelError` path as every other usage error in this CLI. */
function requireFileAndLine(opts: ProbeCliOptions, flag: string): void {
  if (opts.file === undefined) {
    throw new UsageError(
      `probe: --file is required for ${flag} (only -p/--patch can derive it from the patch)`,
    );
  }
  if (opts.line === undefined) {
    throw new UsageError(
      `probe: -n/--line is required for ${flag} (only -p/--patch can derive it from the patch)`,
    );
  }
}

/**
 * Exactly one mutant form is required: `-r`, or `-M` together with `-w`,
 * or `-p`. Anything else (none, more than one, or `-M`/`-w` given
 * without its pair) is a usage error, thrown here so it flows through
 * the same top-level `mapTopLevelError` path as every other usage error
 * in this CLI.
 */
function resolveMutantForm(opts: ProbeCliOptions): MutantChoice {
  const hasReplace = opts.replace !== undefined;
  const hasMatchPair = opts.match !== undefined || opts.with !== undefined;
  const hasPatch = opts.patch !== undefined;
  const formCount = [hasReplace, hasMatchPair, hasPatch].filter(Boolean).length;
  if (formCount !== 1) {
    throw new UsageError(
      "probe: exactly one mutant form is required: -r/--replace, or " +
        "-M/--match together with -w/--with, or -p/--patch",
    );
  }
  if (hasMatchPair) {
    if (opts.match === undefined || opts.with === undefined) {
      throw new UsageError(
        "probe: -M/--match and -w/--with must be given together",
      );
    }
    requireFileAndLine(opts, "-M/--match and -w/--with");
    return { form: "match", matchText: opts.match, withText: opts.with };
  }
  if (hasReplace) {
    requireFileAndLine(opts, "-r/--replace");
    return { form: "replace", replaceText: opts.replace as string };
  }
  return { form: "patch", patchPath: opts.patch as string };
}

/** The single-mutant options `--plan` refuses outright: the plan file
 * itself carries the mutants and the command they share, so accepting
 * one of these beside it would mean two sources for the same value with
 * no honest precedence between them. `--env` is NOT in this set (it
 * used to be, when a plan run had no wiring for it at all): it is
 * command-line only, the same as `--allow-outside` below --
 * threaded straight through to `probePlan`'s own setup, applied to the
 * baseline and every mutant, since a plan file has no key for it to
 * conflict with. `--require-baseline-evidence` is NOT in this set
 * either, for the same reason: a plan runs every mutant against ONE
 * shared baseline, so there is no second source for this value to
 * conflict with. The run-shaping options (`-i`, `--expect`, `--timeout`)
 * are NOT in this set either: they override the plan's own value when
 * given (see `runProbePlanCommand`'s own docblock for that precedence).
 * `--link` and `--allow-outside` are not in it either: `--link` is merged
 * with the plan's own `link`, and `--allow-outside` has no plan key. */
export const PLAN_EXCLUSIVE_OPTIONS: readonly {
  flag: string;
  key: keyof ProbeCliOptions;
}[] = [
  { flag: "--file", key: "file" },
  { flag: "-n/--line", key: "line" },
  { flag: "-r/--replace", key: "replace" },
  { flag: "-M/--match", key: "match" },
  { flag: "-w/--with", key: "with" },
  { flag: "-p/--patch", key: "patch" },
  { flag: "-t/--test", key: "test" },
  { flag: "--pre", key: "pre" },
];

/** The short form of a `PLAN_EXCLUSIVE_OPTIONS` flag (`-n/--line` ->
 * `-n`): what the `--plan` help sentence below lists, so that sentence
 * is built from the same array `requirePlanExclusive` reads instead of
 * a hand-maintained mirror of it. */
function shortFlag(flag: string): string {
  return flag.split("/")[0];
}

/** "--file, -n, -r, -M, -w, -p, -t and --pre": the `--plan` help
 * sentence's list of mutually exclusive flags, derived from
 * `PLAN_EXCLUSIVE_OPTIONS` so a flag added there without updating this
 * sentence is impossible rather than a drift a reviewer has to catch. */
const PLAN_EXCLUSIVE_FLAG_LIST = ((): string => {
  const shorts = PLAN_EXCLUSIVE_OPTIONS.map(({ flag }) => shortFlag(flag));
  if (shorts.length === 0) return "";
  if (shorts.length === 1) return shorts[0];
  return `${shorts.slice(0, -1).join(", ")} and ${shorts[shorts.length - 1]}`;
})();

function requirePlanExclusive(opts: ProbeCliOptions): void {
  const conflicts = PLAN_EXCLUSIVE_OPTIONS.filter(
    ({ key }) => opts[key] !== undefined,
  ).map(({ flag }) => flag);
  if (conflicts.length > 0) {
    throw new UsageError(
      `probe: --plan cannot be combined with ${conflicts.join(", ")}; the ` +
        `plan file supplies the mutants, the test command and --pre`,
    );
  }
}

/** Whether an option was actually given on the command line, as opposed
 * to carrying commander's own default: only an explicit value overrides
 * what the plan file says. */
function explicitlyGiven(command: Command, key: string): boolean {
  const source = command.getOptionValueSource(key);
  return source !== undefined && source !== "default";
}

/**
 * Runs `probe --plan <path>`: read and validate the plan, reconcile the
 * run-shaping options with it, run every mutant against one shared
 * baseline, and emit one envelope carrying `plan: { baseline, results,
 * summary }`.
 *
 * Precedence, one rule for every run-shaping option: a value given on
 * the command line wins over the plan file's own value, which wins over
 * the CLI default. A mutant's own `expect` wins over both, since it is
 * the only value that is per mutant rather than per run.
 */
async function runProbePlanCommand(
  opts: ProbeCliOptions,
  command: Command,
  global: ResolvedGlobal,
  start: number,
): Promise<void> {
  requirePlanExclusive(opts);
  const planPath = path.resolve(global.cwd, opts.plan ?? "");
  const parsed = parsePlanFile(planPath);
  if (!parsed.ok) {
    const refusalInput: EnvelopeInput = {
      version: VERSION,
      command: "probe",
      persistFullResult: true,
      status: "usage_error",
      durationMs: Date.now() - start,
      cwd: global.cwd,
      warnings: [parsed.message],
      logs: [],
      extra: { reason: parsed.reason },
      maxChars: global.maxChars,
      logDir: global.logDir,
    };
    const { envelope, exitCode } = buildEnvelope(refusalInput);
    emitProbe(
      opts,
      envelope,
      exitCode,
      global,
      {
        status: "usage_error",
        reason: parsed.reason,
        warnings: [parsed.message],
      },
      refusalInput,
    );
    return;
  }
  const plan: ProbePlanSpec = parsed.plan;
  const isolation = explicitlyGiven(command, "isolation")
    ? opts.isolation
    : (plan.isolation ?? opts.isolation);
  const expect = explicitlyGiven(command, "expect")
    ? opts.expect
    : (plan.expect ?? opts.expect);
  const timeoutMs =
    opts.timeout !== undefined ? Number(opts.timeout) * 1000 : plan.timeoutMs;
  // `--pass-regex` has no default value (unlike `isolation`/`expect`
  // above), so its own presence IS "explicitly given": a command-line
  // value wins over the plan file's own `passWhen.regex` when both are
  // given, the same precedence rule `--require-baseline-evidence` would
  // follow if a plan file ever grew a key for it too.
  const passRegex = opts.passRegex ?? plan.passRegex;
  // Handed to `probePlan` for the duration of the call, the same as for a
  // single probe: it owns SIGINT and SIGTERM while it runs, because it
  // has a mutated file to restore before the process may end.
  probeOwnsShutdown = true;
  let result: ProbePlanResult;
  try {
    result = await probePlan({
      mutants: plan.mutants,
      testCommand: plan.testCommand,
      preCommand: plan.preCommand,
      isolation,
      expect,
      timeoutMs,
      env: opts.env,
      // The plan's own `link` stays SEPARATE from `--link` all the way
      // into `probePlan`, which merges all three sources itself in one
      // place ("defaults file, then plan, then CLI"): the plan's
      // entries are repository content (unless the plan file itself
      // lies outside the containment root, which `probePlan` decides)
      // and the link policy holds repository content to a stricter
      // rule than an operator's own `--link`, which a merge here would
      // erase.
      links: opts.link ?? [],
      planLinks: plan.link ?? [],
      planPath,
      planRealPath: parsed.realPath,
      allowOutside: opts.allowOutside ?? false,
      cwd: global.cwd,
      logDir: global.logDir,
      requireBaselineEvidence: opts.requireBaselineEvidence,
      passRegex,
      exitOnSignal: true,
    });
  } finally {
    probeOwnsShutdown = false;
  }
  const envelopeInput: EnvelopeInput = {
    version: VERSION,
    command: "probe",
    persistFullResult: true,
    status: result.status,
    durationMs: Date.now() - start,
    cwd: global.cwd,
    warnings: result.warnings,
    // Only the baseline log, the plan's own setup/dry-run logs and (once
    // reduction runs) the result-full path belong at the top level: this
    // `logs` is a PROTECTED_KEYS field the envelope never cuts, so
    // anything folded in here raises the reduction floor for every
    // mutant added to the plan. A per-mutant log path (its dry run, its
    // real apply) stays inside that mutant's own `plan.results[i].logs`
    // / `.test.logPath`, which the normal reduction can still cap or
    // drop like any other payload field.
    logs: [
      ...(result.baseline !== undefined ? [result.baseline.logPath] : []),
      ...(result.dryRunLogPaths ?? []),
    ],
    extra: {
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.env !== undefined ? { env: result.env } : {}),
      // A short, fixed-vocabulary string (`"met"`/`"violated"`), the
      // same shape `env`/`reason` already carry unreduced in practice --
      // no `keepWhole` entry is added for it: `capString` only shortens
      // a string past `maxString` (thousands of characters at the
      // default scale), never drops a short one, and `capObject`'s own
      // key-count cap sits far above the handful of keys this envelope's
      // `extra` ever carries, so this field is never the one a reduction
      // reaches for.
      ...(result.expectation !== undefined
        ? { expectation: result.expectation }
        : {}),
      plan: {
        ...(result.baseline !== undefined ? { baseline: result.baseline } : {}),
        results: result.results,
        summary: result.summary,
      },
      isolation: result.isolation,
    },
    // A plan of more than a handful of mutants does not fit the default
    // `-m`, and the reduction then cuts `plan.results` (fields per entry
    // first, then whole entries). The counts stay whole: they are five
    // numbers, and they are what tells a reader how much of the array
    // they are looking at is missing -- and that the full result named
    // in `logs` carries the rest.
    keepWhole: ["plan.summary"],
    maxChars: global.maxChars,
    logDir: global.logDir,
  };
  const { envelope, exitCode } = buildEnvelope(envelopeInput);
  // `plan.results[]` is an array, so `keepWhole` above cannot reach into
  // it (see that field's own docblock): a `diff.text` the reduction cut
  // further than this module's own bound already did is corrected here,
  // after the fact, rather than protected from the cut in the first
  // place. `result.results` is the PRE-envelope evidence the correction
  // compares each delivered excerpt against -- `buildEnvelope` deep-copies
  // its input, so this is untouched by the reduction. `global.maxChars`
  // is the same bound this envelope was already built with, so the
  // correction can re-measure and shrink further if writing a field
  // back pushed the whole envelope past it.
  reconcileEnvelopeDiffTruncation(
    envelope,
    { planResults: result.results },
    global.maxChars,
  );
  emitProbe(
    opts,
    envelope,
    exitCode,
    global,
    {
      status: result.status,
      reason: result.reason,
      expectation: result.expectation,
      warnings: result.warnings,
      plan: {
        baseline: result.baseline,
        results: result.results,
        summary: { ...result.summary },
      },
    },
    envelopeInput,
    planReportDefinitions(plan.mutants),
  );
}

program
  .command("probe")
  .description(
    "--file is long-only: the global -f is --format, and every global option (-f, -C, -m, -l, --json) may precede the subcommand.\n\n" +
      "Confirm the unmutated test passes (the baseline), apply one mutant, run the test again and check it reacts per --expect (fails by default), then restore the file",
  )
  .option(
    "--file <path>",
    "path to the file to mutate (long-only: the global -f is --format); required unless -p derives it from a single-path patch",
  )
  .option(
    "-n, --line <n>",
    "1-indexed line number; required except with -p, whose reported line is always the patch's first changed line",
    parseLine,
  )
  .option("-r, --replace <text>", "replace the whole line with this text")
  .option("-M, --match <substr>", "substring to find on the line (requires -w)")
  .option("-w, --with <text>", "replacement for the first match of -M")
  .option("-p, --patch <path>", "path to a unified diff, applied via git apply")
  .option(
    "-t, --test <command>",
    "shell command that runs the test; required unless --plan supplies it",
  )
  .option(
    "--pre <command>",
    "shell command (e.g. a rebuild) run before each test invocation",
  )
  .option(
    "--env <NAME=VALUE>",
    "environment variable for --pre and -t, applied to both the baseline and the mutant run (repeatable)",
    parseEnvOption,
  )
  .option(
    "--require-baseline-evidence <regex>",
    "opt-in: the baseline's own output must match this regex before any verdict is issued, for a test runner neither built-in zero-tests detector recognizes",
    parseRequireBaselineEvidence,
  )
  .option(
    "--pass-regex <regex>",
    "opt-in success predicate (or plan.passWhen.regex): a match against the baseline's and each mutant's combined stdout+stderr is a pass, its absence a failure, in place of the exit code -- for a test runner whose exit code alone is not trustworthy (e.g. phpunit exiting non-zero on a green suite over deprecation notices)",
    parsePassRegex,
  )
  .option(
    "-i, --isolation <mode>",
    "worktree (default; mutates a detached git worktree, leaving the working tree untouched) or inplace",
    parseIsolationMode,
    "worktree",
  )
  .option(
    "--expect <verdict>",
    "fail (default, mutant should break the test) or pass",
    parseExpectVerdict,
    "fail",
  )
  .option(
    "--timeout <seconds>",
    "timeout for --pre and -t",
    parseTimeoutSeconds,
  )
  .option(
    "--plan <path>",
    `JSON file with one test command and a list of mutants, run against one shared baseline; mutually exclusive with ${PLAN_EXCLUSIVE_FLAG_LIST}`,
  )
  .option(
    "--link <dirs>",
    "comma-separated extra directories, each relative to the invocation " +
      "cwd, checked for containment and for existing as a directory " +
      "(refused otherwise); merged and deduplicated with a --plan file's " +
      "own link and with .agent-primitives.json at the repo root, both " +
      "relative to the repository root instead (no $(...) or backtick)",
    parseLinkList,
  )
  .option(
    "--allow-outside",
    "allow --file/--link to resolve outside the containment root",
  )
  .option(
    "--summary",
    "print one line per mutant (id, verdict, expectation, restored_verified, first failing test, log path) and a totals line instead of the JSON envelope; -m bounds its characters and the totals line is always kept; exit codes unchanged",
  )
  .option(
    "--print <fields>",
    "print only these comma-separated top-level envelope fields (dotted paths descend, e.g. mutation_probe.result) as one JSON object instead of the envelope; an unknown field is a usage error; exit codes unchanged",
    parsePrintOption,
  )
  .option(
    "--report <kind>",
    "print a ready-to-paste report instead of the envelope: mutation-probes prints the orchestrator implementer contract's mutation_probes items as one JSON array (one item per mutant, the eleven fields merged from the mutant record and mutation_probe; --replayed marks them replays); when the array does not fit -m it prints only whole items (always valid JSON) and names the omitted count and the full result file on stderr; mutually exclusive with --summary and --print; an unknown kind is a usage error; exit codes unchanged",
    parseReportOption,
  )
  .option(
    "--replayed",
    "with --report: print replayed: true (replays of prior-round definitions) instead of the default false; without --report it is a usage error",
  )
  .action(async (opts: ProbeCliOptions, command: Command) => {
    const start = Date.now();
    const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
    requireExclusiveViews(opts);
    if (opts.plan !== undefined) {
      await runProbePlanCommand(opts, command, global, start);
      return;
    }
    if (opts.test === undefined) {
      throw new UsageError(
        "probe: -t/--test is required (only --plan can supply it instead)",
      );
    }
    const testCommand = opts.test;
    const mutantChoice = resolveMutantForm(opts);
    // A full-suite-shaped command with no `--timeout` runs twice, serially
    // (the baseline, then the mutant), with no bound on either: printed
    // to stderr before the baseline starts, so the notice reaches an
    // operator watching the run rather than only showing up as a slow
    // command with no explanation. Never affects the envelope itself.
    if (
      opts.timeout === undefined &&
      looksLikeFullSuiteTestCommand(testCommand)
    ) {
      process.stderr.write(
        `agent-primitives probe: "${testCommand}" looks like a full test ` +
          `suite; the baseline and the mutant run it serially with no ` +
          `time bound -- pass --timeout <seconds> to cap each run.\n`,
      );
    }
    // Handed to `probe` for the duration of the call: it owns SIGINT and
    // SIGTERM while it runs, because it has a mutated file to restore
    // before the process may end. Set with no `await` between it and the
    // call, so there is no window where a signal would find neither
    // handler willing to act.
    probeOwnsShutdown = true;
    let result;
    try {
      result = await probe({
        file: opts.file,
        line: opts.line,
        ...mutantChoice,
        testCommand,
        preCommand: opts.pre,
        env: opts.env,
        requireBaselineEvidence: opts.requireBaselineEvidence,
        passRegex: opts.passRegex,
        isolation: opts.isolation,
        expect: opts.expect,
        timeoutMs:
          opts.timeout !== undefined ? Number(opts.timeout) * 1000 : undefined,
        links: opts.link ?? [],
        allowOutside: opts.allowOutside ?? false,
        cwd: global.cwd,
        logDir: global.logDir,
        // This process exists to run exactly this probe, so a SIGINT or
        // SIGTERM means "stop now": the handler kills the in-flight
        // child, waits for it to settle, restores, releases the lock,
        // and ends the process with the signal's own conventional exit
        // code. Library callers get the opposite default.
        exitOnSignal: true,
      });
    } finally {
      // `probe` has removed its own handlers by now, so the process-wide
      // one takes over again for whatever is left (building and emitting
      // the envelope).
      probeOwnsShutdown = false;
    }
    // A failing baseline is remapped from the library's own
    // `status: "inconclusive"`/`reason: "baseline_failed"` pair to a
    // literal `status: "baseline_failed"` here, in the envelope only:
    // the exit-code class (`cannot-conclude`, exit 2) is unchanged (see
    // `STATUS_CLASS` in envelope.ts), so a caller gating on the exit
    // code alone sees no difference, while one reading `status` no
    // longer has to also read `reason` to tell a failing baseline apart
    // from every other inconclusive outcome.
    const envelopeStatus =
      result.status === "inconclusive" && result.reason === "baseline_failed"
        ? "baseline_failed"
        : result.status;
    const envelopeInput: EnvelopeInput = {
      version: VERSION,
      command: "probe",
      persistFullResult: true,
      status: envelopeStatus,
      durationMs: Date.now() - start,
      cwd: global.cwd,
      warnings: result.warnings,
      logs: [
        ...(result.baseline !== undefined ? [result.baseline.logPath] : []),
        ...(result.test !== undefined ? [result.test.logPath] : []),
        ...(result.dryRunLogPaths ?? []),
      ],
      extra: {
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.mutant !== undefined ? { mutant: result.mutant } : {}),
        ...(result.mutation_probe !== undefined
          ? { mutation_probe: result.mutation_probe }
          : {}),
        ...(result.baseline !== undefined ? { baseline: result.baseline } : {}),
        ...(result.env !== undefined ? { env: result.env } : {}),
        ...(result.test !== undefined ? { test: result.test } : {}),
        isolation: result.isolation,
        totalDurationMs: result.totalDurationMs,
      },
      maxChars: global.maxChars,
      logDir: global.logDir,
    };
    const { envelope, exitCode: statusExitCode } = buildEnvelope(envelopeInput);
    // `status` above is `result`'s own actual outcome, independent of
    // `--expect` (see `step.ts`'s classify step) -- so the exit code it
    // implies via `STATUS_CLASS` (killed -> ok, survived -> finding) is
    // only right for the default `--expect fail`. `--expect` itself
    // still decides the exit code (unchanged contract): once a real
    // killed/survived verdict was reached, `mutation_probe.expectation`
    // says whether that outcome matched `--expect`, and the exit code
    // follows THAT instead -- `0` for `"met"`, `1` for `"violated"`,
    // exactly the pre-existing exit code for the default `--expect
    // fail`, where `expectation` and `status` always agree. Every other
    // status (`inconclusive`, `usage_error`, `baseline_failed`) has no
    // `expectation` at all and keeps the exit code `buildEnvelope`
    // already computed from `status` itself.
    const expectation = result.mutation_probe?.expectation;
    const exitCode =
      expectation === undefined
        ? statusExitCode
        : expectation === "met"
          ? 0
          : 1;
    // See the plan command's own call to this: a large excerpt can
    // still get cut further by the envelope's own generic string cap,
    // which knows nothing about hunks, and this corrects that case
    // after the fact, against the pre-envelope `result.mutant` as
    // evidence for what was cut, then re-measures against the same
    // `global.maxChars` this envelope was built with.
    reconcileEnvelopeDiffTruncation(
      envelope,
      { mutant: result.mutant },
      global.maxChars,
    );
    emitProbe(
      opts,
      envelope,
      exitCode,
      global,
      {
        status: envelopeStatus,
        reason: result.reason,
        warnings: result.warnings,
        mutant: result.mutant,
        mutation_probe: result.mutation_probe,
        test: result.test,
        baseline: result.baseline,
      },
      envelopeInput,
    );
  });

interface InitCliOptions {
  harness: Harness[];
  targetDir?: string;
  force?: boolean;
}

program
  .command("init")
  .description(
    "Install the agent-primitives skill into a harness's skill directories",
  )
  .option(
    "-H, --harness <list>",
    "comma-separated harnesses (claude, codex, opencode) or the single value all (default: claude)",
    parseHarnessList,
    ["claude"] as Harness[],
  )
  .option(
    "-t, --target-dir <dir>",
    "directory the harness skill paths are resolved under (defaults to -C/--cwd)",
  )
  .option(
    "--force",
    "overwrite a conflicting or outdated existing skill file instead of reporting it as conflicted/outdated",
  )
  .action((opts: InitCliOptions, command: Command) => {
    const start = Date.now();
    const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
    const targetDir = opts.targetDir
      ? path.resolve(global.cwd, opts.targetDir)
      : global.cwd;
    let result: InitResult;
    try {
      result = init({
        harnesses: opts.harness,
        targetDir,
        force: Boolean(opts.force),
      });
    } catch (err) {
      if (err instanceof InitFsUsageError) {
        const { envelope, exitCode } = buildEnvelope({
          version: VERSION,
          command: "init",
          status: "usage_error",
          durationMs: Date.now() - start,
          cwd: global.cwd,
          warnings: err.warnings,
          logs: [],
          extra: {
            reason: err.reason,
            message: err.message,
            targets: err.targets,
          },
          maxChars: global.maxChars,
          logDir: global.logDir,
        });
        emit(envelope, exitCode, {
          format: global.format,
          maxChars: global.maxChars,
        });
        return;
      }
      throw err;
    }
    const { envelope, exitCode } = buildEnvelope({
      version: VERSION,
      command: "init",
      status: result.status,
      durationMs: Date.now() - start,
      cwd: global.cwd,
      warnings: result.warnings,
      logs: [],
      extra: { targets: result.targets },
      maxChars: global.maxChars,
      logDir: global.logDir,
    });
    emit(
      envelope,
      exitCode,
      { format: global.format, maxChars: global.maxChars },
      () => renderInitText(result),
    );
  });

interface DriftCliOptions {
  base: string;
  head: string;
  allow: string[];
  strict?: boolean;
}

function collectAllow(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function renderDriftText(result: DriftResult): string {
  const lines: string[] = [];
  lines.push(`status: ${result.status}`);
  lines.push("");
  const byIdentifier = new Map<string, DriftResult["sites"]>();
  for (const site of result.sites) {
    const group = byIdentifier.get(site.identifier) ?? [];
    group.push(site);
    byIdentifier.set(site.identifier, group);
  }
  for (const [identifier, group] of byIdentifier) {
    for (const site of group) {
      const flag = site.allowlisted ? " [allowlisted]" : "";
      lines.push(
        `${site.path}:${site.line}: ${identifier}${flag} ${site.text}`,
      );
    }
  }
  lines.push("");
  lines.push(
    `${String(result.counts.removed)} removed identifier(s), ${String(result.counts.sites)} site(s) reported, ${String(result.counts.allowlisted)} allowlisted`,
  );
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

program
  .command("drift")
  .description(
    "Report docs and comments that still describe an identifier a git range removed or renamed",
  )
  .requiredOption("--base <rev>", "base revision")
  .requiredOption("--head <rev>", "head revision")
  .option(
    "--allow <glob>",
    "glob to allowlist (repeatable)",
    collectAllow,
    [] as string[],
  )
  .option(
    "--strict",
    "also report allowlisted sites in sites[], flagged with allowlisted/allowlistReason",
  )
  .action(async (opts: DriftCliOptions, command: Command) => {
    const start = Date.now();
    const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
    const result = await drift({
      cwd: global.cwd,
      base: opts.base,
      head: opts.head,
      allow: opts.allow,
      strict: Boolean(opts.strict),
    });
    const { envelope, exitCode } = buildEnvelope({
      version: VERSION,
      command: "drift",
      status: result.status,
      durationMs: Date.now() - start,
      cwd: global.cwd,
      warnings: result.warnings,
      logs: [],
      extra: {
        base: result.base,
        head: result.head,
        base_sha: result.baseSha,
        head_sha: result.headSha,
        merge_base: result.mergeBase,
        removed_identifiers: result.removedIdentifiers,
        sites: result.sites,
        allowlisted: result.allowlisted,
        counts: result.counts,
      },
      // `sites`/`allowlisted` are the fields a large real-tree result cuts
      // first under reduction (a site's `text` can be a whole long
      // CHANGELOG bullet); `counts` is three small numbers that tell a
      // reader how much of `sites` they are still looking at, so it must
      // never disappear along with the array it describes (same idiom as
      // `probe`'s own `plan.summary`, see its own comment above).
      keepWhole: ["counts"],
      maxChars: global.maxChars,
      logDir: global.logDir,
    });
    emit(
      envelope,
      exitCode,
      { format: global.format, maxChars: global.maxChars },
      () => renderDriftText(result),
    );
  });

interface HygieneCliOptions {
  base: string;
  head?: string;
  staged?: boolean;
  extendOnly: string[];
  extendOnlyFile?: string;
  maxDeletePercent: string;
}

function renderHygieneText(result: HygieneResult): string {
  const lines: string[] = [`status: ${result.status}`, ""];
  for (const f of result.findings) {
    lines.push(`${f.kind}: ${f.path}: ${f.detail}`);
  }
  lines.push("");
  lines.push(
    `${String(result.counts.files)} changed file(s), ${String(result.findings.length)} finding(s)`,
  );
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

program
  .command("hygiene")
  .description(
    "Refuse backup files (*.bak, *.orig, *~, and the BSD sed -i leftovers *-e, *-E, *-n, *-r, *-s) and flag wholesale rewrites of extend-only files and dropped test cases in a git range or the index",
  )
  .requiredOption("--base <rev>", "base revision the task started from")
  .option("--head <rev>", "head revision (default HEAD)")
  .option(
    "--staged",
    "compare the merge-base of --base and HEAD against the git index instead of a commit (run before git commit)",
  )
  .option(
    "--extend-only <path>",
    "root-relative path the task may only extend (repeatable)",
    collectAllow,
    [] as string[],
  )
  .option(
    "--extend-only-file <file>",
    "file listing extend-only paths, one per line; blank lines and # comments ignored",
  )
  .option(
    "--max-delete-percent <n>",
    "flag an extend-only file that loses more than this percent of its base lines",
    String(DEFAULT_MAX_DELETE_PERCENT),
  )
  .action(async (opts: HygieneCliOptions, command: Command) => {
    const start = Date.now();
    const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
    const extendOnly = [...opts.extendOnly];
    if (opts.extendOnlyFile !== undefined) {
      let text: string;
      try {
        text = fs.readFileSync(
          path.resolve(global.cwd, opts.extendOnlyFile),
          "utf8",
        );
      } catch (err) {
        throw new UsageError(
          `hygiene: cannot read --extend-only-file ${opts.extendOnlyFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (line.length > 0 && !line.startsWith("#")) extendOnly.push(line);
      }
    }
    const result = hygiene({
      cwd: global.cwd,
      base: opts.base,
      head: opts.head,
      staged: Boolean(opts.staged),
      extendOnly,
      maxDeletePercent: Number(opts.maxDeletePercent),
    });
    const { envelope, exitCode } = buildEnvelope({
      version: VERSION,
      command: "hygiene",
      status: result.status,
      durationMs: Date.now() - start,
      cwd: global.cwd,
      warnings: result.warnings,
      logs: [],
      extra: {
        base: result.base,
        head: result.head,
        base_sha: result.baseSha,
        head_sha: result.headSha,
        merge_base: result.mergeBase,
        max_delete_percent: result.maxDeletePercent,
        extend_only: result.extendOnly,
        findings: result.findings,
        counts: result.counts,
      },
      keepWhole: ["counts"],
      maxChars: global.maxChars,
      logDir: global.logDir,
    });
    emit(
      envelope,
      exitCode,
      { format: global.format, maxChars: global.maxChars },
      () => renderHygieneText(result),
    );
  });

interface PatchCliOptions {
  plan?: string;
  file?: string;
  old?: string;
  oldFile?: string;
  new?: string;
  newFile?: string;
  replaceAll?: boolean;
  dryRun?: boolean;
  allowOutside?: boolean;
  breakHardLinks?: boolean;
}

/** Reads a `--plan`/`--old-file`/`--new-file` argument verbatim: `-`
 * is stdin, anything else a path resolved against the `-C` directory. */
function readPatchInput(cwd: string, flag: string, p: string): string {
  try {
    return p === "-"
      ? fs.readFileSync(0, "utf8")
      : fs.readFileSync(path.resolve(cwd, p), "utf8");
  } catch (err) {
    throw new PatchUsageError(
      `patch: cannot read ${flag} ${p}: ${err instanceof Error ? err.message : String(err)}`,
      "input_unreadable",
    );
  }
}

/** Builds the edit list from either `--plan` or the one-shot flags,
 * refusing any mix of the two forms. */
function patchEditsFromCli(
  cwd: string,
  opts: PatchCliOptions,
): PatchEditSpec[] {
  const oneShot = [
    ["--file", opts.file],
    ["--old", opts.old],
    ["--old-file", opts.oldFile],
    ["--new", opts.new],
    ["--new-file", opts.newFile],
    ["--replace-all", opts.replaceAll],
  ].filter(([, v]) => v !== undefined);
  if (opts.plan !== undefined) {
    if (oneShot.length > 0) {
      throw new PatchUsageError(
        `patch: --plan cannot be combined with ${oneShot.map(([f]) => String(f)).join(", ")}`,
        "option_conflict",
      );
    }
    return parsePatchPlan(readPatchInput(cwd, "--plan", opts.plan), "--plan");
  }
  if (opts.file === undefined) {
    throw new PatchUsageError(
      "patch: pass --plan <file>, or --file with --old/--old-file and --new/--new-file",
      "option_missing",
    );
  }
  const pick = (
    inline: string | undefined,
    file: string | undefined,
    name: "old" | "new",
  ): string => {
    if (inline !== undefined && file !== undefined) {
      throw new PatchUsageError(
        `patch: --${name} and --${name}-file are mutually exclusive`,
        "option_conflict",
      );
    }
    if (inline !== undefined) return inline;
    if (file !== undefined) return readPatchInput(cwd, `--${name}-file`, file);
    throw new PatchUsageError(
      `patch: --file needs --${name} or --${name}-file`,
      "option_missing",
    );
  };
  if (opts.oldFile === "-" && opts.newFile === "-") {
    throw new PatchUsageError(
      "patch: --old-file and --new-file cannot both read stdin",
      "option_conflict",
    );
  }
  const spec: PatchEditSpec = {
    file: opts.file,
    old: pick(opts.old, opts.oldFile, "old"),
    new: pick(opts.new, opts.newFile, "new"),
  };
  if (opts.replaceAll === true) spec.replaceAll = true;
  return [spec];
}

function renderPatchText(result: PatchResult): string {
  const lines: string[] = [
    `status: ${result.status}${result.dryRun ? " (dry run)" : ""}`,
  ];
  if (result.message !== undefined) lines.push(result.message);
  lines.push("");
  for (const e of result.edits) {
    const where =
      e.line_ranges !== undefined && e.line_ranges.length > 0
        ? `, lines ${e.line_ranges.map((r) => (r.start === r.end ? String(r.start) : `${String(r.start)}-${String(r.end)}`)).join(", ")}`
        : "";
    const tier = e.tier !== undefined ? ` (${e.tier}${where})` : "";
    lines.push(`edits[${String(e.index)}] ${e.path}: ${e.status}${tier}`);
    if (e.detail !== undefined) lines.push(`  ${e.detail}`);
    if (e.side_effect !== undefined) {
      for (const l of e.side_effect.lines) {
        lines.push(`    line ${String(l.line)} original:   ${l.original}`);
        lines.push(`    line ${String(l.line)} normalized: ${l.normalized}`);
      }
    }
    if (e.hint !== undefined) {
      lines.push(`  ${e.hint.message}`);
      for (const c of e.hint.candidates) {
        lines.push(
          `  candidate lines ${String(c.line_start)}-${String(c.line_end)} (similarity ${c.similarity.toFixed(2)}):`,
        );
        for (const d of c.differences) {
          lines.push(`    line ${String(d.line)} expected: ${d.expected}`);
          lines.push(`    line ${String(d.line)} actual:   ${d.actual}`);
        }
        if (c.more_differences > 0) {
          lines.push(
            `    ... ${String(c.more_differences)} more differing line(s)`,
          );
        }
      }
    }
  }
  lines.push("");
  for (const f of result.files) {
    lines.push(
      `${f.path}: ${f.status}${f.reason !== undefined ? ` (${f.reason})` : ""}`,
    );
  }
  for (const f of result.files) {
    if (f.diff !== undefined) {
      lines.push("");
      lines.push(f.diff.trimEnd());
    }
  }
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

program
  .command("patch")
  .description(
    "Replace exact text in one or more files from a JSON edit plan (or one --file/--old/--new edit): every edit is verified before any file is written, all or nothing",
  )
  .addHelpText(
    "before",
    '--file is long-only: the global -f is --format, and every global option (-f, -C, -m, -l, --json) may precede the subcommand.\n\nPlan: {"edits":[{"file":"<path>","old":"<text>","new":"<text>","replaceAll":false}]}\n',
  )
  .option(
    "--plan <file>",
    "JSON edit plan (- reads stdin); paths in it resolve against -C",
  )
  .option(
    "--file <path>",
    "one-shot form: the file to edit (long-only: the global -f is --format)",
  )
  .option("--old <text>", "one-shot form: the exact text to replace")
  .option(
    "--old-file <path>",
    "one-shot form: read the old text from a file, verbatim (- reads stdin)",
  )
  .option("--new <text>", "one-shot form: the replacement text")
  .option(
    "--new-file <path>",
    "one-shot form: read the new text from a file, verbatim (- reads stdin)",
  )
  .option(
    "--replace-all",
    "one-shot form: replace every occurrence instead of refusing more than one",
  )
  .option("--dry-run", "resolve every edit and show the diff without writing")
  .option(
    "--allow-outside",
    "allow files that resolve outside the repository root (never inside .git)",
  )
  .option(
    "--break-hard-links",
    "edit a file that has more than one hard link (refused otherwise); the edited name gets a new inode and the other names keep the old content",
  )
  .action(async (opts: PatchCliOptions, command: Command) => {
    const start = Date.now();
    const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
    let result: PatchResult;
    try {
      result = patch({
        cwd: global.cwd,
        edits: patchEditsFromCli(global.cwd, opts),
        dryRun: Boolean(opts.dryRun),
        allowOutside: Boolean(opts.allowOutside),
        breakHardLinks: Boolean(opts.breakHardLinks),
      });
    } catch (err) {
      // A usage error, or an unexpected failure outside the per-file
      // handling: either way the envelope names the command.
      const usage = err instanceof UsageError;
      const { envelope, exitCode } = buildEnvelope({
        version: VERSION,
        command: "patch",
        status: usage ? "usage_error" : "error",
        durationMs: Date.now() - start,
        cwd: global.cwd,
        warnings: [],
        logs: [],
        extra: usage
          ? {
              reason: err instanceof PatchUsageError ? err.reason : "usage",
              message: err.message,
            }
          : {
              reason: "internal",
              message: `patch: ${err instanceof Error ? err.message : String(err)}`,
            },
        maxChars: global.maxChars,
        logDir: global.logDir,
      });
      emit(envelope, exitCode, {
        format: global.format,
        maxChars: global.maxChars,
      });
      return;
    }
    const { envelope, exitCode } = buildEnvelope({
      version: VERSION,
      command: "patch",
      status: result.status,
      durationMs: Date.now() - start,
      cwd: global.cwd,
      warnings: result.warnings,
      logs: [],
      extra: {
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
        dry_run: result.dryRun,
        root: result.root,
        counts: result.counts,
        written_files: result.writtenFiles,
        edits: result.edits,
        files: result.files,
      },
      // `written_files` is what a caller needs after a failed write phase
      // to know which files already changed; `counts` says how much of
      // the reduced `edits`/`files` arrays is missing.
      keepWhole: ["counts", "written_files"],
      maxChars: global.maxChars,
      logDir: global.logDir,
    });
    emit(
      envelope,
      exitCode,
      { format: global.format, maxChars: global.maxChars },
      () => renderPatchText(result),
    );
  });

async function runObservation(
  kind: "snapshot" | "delta",
  opts: { output?: string; since?: string },
  command: Command,
): Promise<void> {
  const start = Date.now();
  const raw = command.optsWithGlobals<GlobalOptions>();
  const fallback = bestEffortGlobal(raw);
  let global: ResolvedGlobal;
  try {
    global = resolveGlobal(raw);
  } catch (err) {
    const { envelope, exitCode } = mapTopLevelError(
      err,
      fallback,
      start,
      false,
    );
    emit(envelope, exitCode, fallback);
    return;
  }
  let result: Record<string, unknown>;
  let status = "error";
  let safeLogDir: string | undefined;
  try {
    const identity = checkoutIdentity(global.cwd);
    const observationLogDir = path.resolve(process.cwd(), global.logDir);
    safeLogDir = outsideCheckout(observationLogDir, identity, global.cwd);
    if (kind === "snapshot") {
      if (opts.output) outsideCheckout(opts.output, identity, global.cwd);
      const artifact = captureSnapshot(global.cwd);
      const saved = persistSnapshot(artifact, {
        ...global,
        logDir: safeLogDir,
        output: opts.output,
      });
      result = {
        artifactPath: saved.artifactPath,
        checkout: artifact.checkout,
        head: artifact.head,
        branch: artifact.branch,
        counts: {
          index: artifact.index.length,
          workingTree: artifact.workingTree.length,
          untracked: artifact.untracked.length,
        },
      };
      status = "ok";
    } else {
      const baseline = readSnapshot(path.resolve(global.cwd, opts.since!));
      result = { ...compareSnapshots(baseline, captureSnapshot(global.cwd)) };
      status = String(result.status);
      delete result.status;
    }
  } catch (err) {
    result = {
      message: err instanceof Error ? err.message : String(err),
      reason: "cannot_conclude",
    };
    // Error reporting never writes logs, even when the supplied path was unsafe.
    safeLogDir = undefined;
  }
  const { envelope, exitCode } = buildEnvelope({
    version: VERSION,
    command: kind,
    status,
    durationMs: Date.now() - start,
    cwd: fallback.cwd,
    extra: result,
    maxChars: fallback.maxChars,
    logDir: safeLogDir,
  });
  emit(
    envelope,
    exitCode,
    { format: fallback.format, maxChars: fallback.maxChars },
    () => JSON.stringify(envelope, null, 2) + "\n",
  );
}
program
  .command("snapshot")
  .description(
    "Capture read-only checkout fingerprints in a full artifact outside checkout",
  )
  .option("--output <path>", "new artifact path outside checkout")
  .action((opts, command) => runObservation("snapshot", opts, command));
program
  .command("delta")
  .description("Compare a saved snapshot with the same checkout now")
  .requiredOption("--since <path>", "saved snapshot artifact")
  .action((opts, command) => runObservation("delta", opts, command));

interface WorktreeCreateCliOptions {
  repo?: string;
  branch: string;
  base?: string;
  path?: string;
  root?: string;
  run?: string;
  link: string[];
  linksFrom?: string;
  setup?: string;
  smoke?: string;
  passRegex?: RegExp;
  /** `--no-fetch` sets this to `false`; commander defaults it to `true`. */
  fetch: boolean;
}

function renderWorktreeCreateText(result: CreateWorktreeResult): string {
  const lines: string[] = [
    `status: ${result.status}`,
    `worktree: ${result.worktree.path}`,
    `branch: ${result.worktree.branch} (${result.upstream === null ? "no upstream" : `tracks ${result.upstream}`})`,
    `base: ${result.base.ref} @ ${result.base.sha}`,
    result.runBase,
    `fetch: ${result.fetch.status}${result.fetch.reason ? ` (${result.fetch.reason})` : ""}`,
    `pointer: ${result.pointer.status}${result.pointer.reason ? ` (${result.pointer.reason})` : ""}`,
  ];
  for (const link of result.links.made) {
    lines.push(
      `link: ${link.path} -> ${link.target} (exclude: ${link.exclude})`,
    );
  }
  for (const link of result.links.skipped) {
    lines.push(`link skipped: ${link.path}: ${link.reason}: ${link.detail}`);
  }
  if (result.links.manifest.status !== "not_needed") {
    lines.push(
      `link manifest: ${result.links.manifest.status}${result.links.manifest.reason ? ` (${result.links.manifest.reason})` : ""}`,
    );
  }
  for (const [name, step] of [
    ["setup", result.setup],
    ["smoke", result.smoke],
  ] as const) {
    lines.push(
      `${name}: ${step.status}${step.reason ? ` (${step.reason})` : ""}`,
    );
  }
  if (result.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

const worktreeCommand = program
  .command("worktree")
  .description(
    "Manage linked git worktrees for task branches (subcommands: create, remove, sweep, list)",
  );

worktreeCommand
  .command("create")
  .description(
    "Create a linked worktree on a new branch (no upstream) from a base, without touching the main checkout; optionally write the .ai/run pointer, link shared dependencies, run a setup command and a smoke check",
  )
  .requiredOption("--branch <name>", "new branch to create in the worktree")
  .option(
    "--repo <path>",
    "repository to branch from (default: the invocation directory)",
  )
  .option(
    "--base <rev>",
    "start point for the branch (default: origin/<default branch>)",
  )
  .option(
    "--path <dir>",
    "exact worktree directory; relative values resolve against the invocation directory, not --repo",
  )
  .option(
    "--root <dir>",
    "directory to create <branch> in (default: <repo>-worktrees next to the main checkout)",
  )
  .option(
    "--run <dir>",
    "run directory; written to .ai/run in the worktree when git ignores that path",
  )
  .option(
    "--link <rel>",
    "repository-relative path to symlink from the main checkout (repeatable, comma-separated)",
    collectList,
    [] as string[],
  )
  .option(
    "--links-from <file>",
    "file with one --link path per line (# comments); must live outside the repository",
  )
  .option("--setup <cmd>", "shell command to run in the worktree after linking")
  .option(
    "--smoke <cmd>",
    "readiness check to run in the worktree after setup; its exit code (or --pass-regex) decides ready / not_ready",
  )
  .option(
    "--pass-regex <regex>",
    "with --smoke: a match against its combined stdout+stderr is ready, no match is not, in place of the exit code",
    parsePassRegex,
  )
  .option("--no-fetch", "do not fetch origin before resolving the base")
  .action(async (opts: WorktreeCreateCliOptions, command: Command) => {
    const start = Date.now();
    const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
    let result: CreateWorktreeResult;
    try {
      result = await createWorktree({
        cwd: global.cwd,
        repo: opts.repo,
        branch: opts.branch,
        base: opts.base,
        path: opts.path,
        root: opts.root,
        run: opts.run,
        links: opts.link,
        linksFrom: opts.linksFrom,
        setup: opts.setup,
        smoke: opts.smoke,
        passRegex: opts.passRegex,
        fetch: opts.fetch,
        logDir: global.logDir,
        toolVersion: VERSION,
        signal: shutdownController.signal,
        execFn: trackingExec,
      });
    } catch (err) {
      if (!(err instanceof WorktreeRefusal)) throw err;
      const { envelope, exitCode } = buildEnvelope({
        version: VERSION,
        command: "worktree create",
        status: "usage_error",
        durationMs: Date.now() - start,
        cwd: global.cwd,
        warnings: [],
        logs: [],
        extra: {
          reason: err.reason,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
        maxChars: global.maxChars,
        logDir: global.logDir,
      });
      emit(
        envelope,
        exitCode,
        { format: global.format, maxChars: global.maxChars },
        () => `worktree create refused (${err.reason}): ${err.message}\n`,
      );
      return;
    }
    const logs = [result.setup.logPath, result.smoke.logPath].filter(
      (p): p is string => p !== undefined,
    );
    const { envelope, exitCode } = buildEnvelope({
      version: VERSION,
      command: "worktree create",
      status: result.status,
      durationMs: Date.now() - start,
      cwd: global.cwd,
      warnings: result.warnings,
      logs,
      extra: {
        worktree: result.worktree,
        base: result.base,
        fetch: result.fetch,
        upstream: result.upstream,
        runBase: result.runBase,
        pointer: result.pointer,
        links: result.links,
        setup: result.setup,
        smoke: result.smoke,
      },
      keepWhole: ["worktree", "base", "runBase", "upstream"],
      maxChars: global.maxChars,
      logDir: global.logDir,
    });
    emit(
      envelope,
      exitCode,
      { format: global.format, maxChars: global.maxChars },
      () => renderWorktreeCreateText(result),
    );
  });

interface WorktreeRemoveCliOptions {
  path?: string;
  force?: boolean;
  deleteBranch?: boolean;
  requireMerged?: boolean;
  base?: string;
  syncMain?: boolean;
}

/** The worktree `remove` acts on: the positional argument or `--path`,
 * which must agree when both are given. */
function resolveRemovePathArg(
  positional: string | undefined,
  flag: string | undefined,
  cwd: string,
): string {
  if (positional === undefined && flag === undefined) {
    throw new WorktreeRefusal(
      "worktree remove needs a path: give it as the positional argument or with --path <dir>",
      "option_invalid",
    );
  }
  if (positional !== undefined && flag !== undefined) {
    if (path.resolve(cwd, positional) !== path.resolve(cwd, flag)) {
      throw new WorktreeRefusal(
        `worktree remove got two different paths: "${positional}" (positional) and "${flag}" (--path)`,
        "option_invalid",
        { positional, path: flag },
      );
    }
    return positional;
  }
  return (positional ?? flag) as string;
}

function renderWorktreeRemoveText(result: RemoveWorktreeResult): string {
  const lines: string[] = [
    `status: ${result.status}`,
    `worktree: ${result.worktree.path}${result.worktree.branch === undefined ? "" : ` (${result.worktree.branch})`}`,
    `links removed: ${result.linksRemoved.length > 0 ? result.linksRemoved.join(", ") : "none"}`,
    `merged: ${result.merged === null ? "not checked" : `${result.merged.merged} (${result.merged.via})`}`,
    `branch: ${result.branch.deleted ? `deleted (${result.branch.reason})` : result.branch.reason}`,
    `pruned: ${result.pruned ? "yes" : "no"}`,
  ];
  if (result.sync !== null) {
    lines.push(`sync-main: ${result.sync.status} (${result.sync.reason})`);
  }
  if (result.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

worktreeCommand
  .command("remove")
  .description(
    "Remove a linked worktree, refusing a dirty, unpushed or (with --require-merged) unmerged one unless --force; unlinks the dependency links it finds, never follows them, and never deletes the default branch or removes the main checkout",
  )
  .argument(
    "[path]",
    "the worktree to remove; relative paths resolve against the invocation directory (or pass it with --path)",
  )
  .option(
    "--path <dir>",
    "the worktree to remove, as an alternative to the positional argument (the same flag `worktree create` takes); both forms together must resolve to the same path (symlinks are not followed)",
  )
  .option(
    "--force",
    "remove it even when it is dirty (edits git status does not show included), has commits no remote branch has, is locked, holds a nested worktree or submodules, a check could not be made (the status, the unpushed or merge state, a HEAD that cannot be read), or is not merged; never overrides not_a_worktree, not_a_git_repo, remove_main_checkout, default_branch_delete, option_invalid, base_not_found, base_not_remote_branch, head_moved for a HEAD that can be read and is not at the commit `git worktree list` showed, git_timeout or interrupted",
  )
  .option(
    "--delete-branch",
    "delete the worktree's branch after the worktree is gone (never the default branch or the main checkout's own branch), only while it still points at the commit `git worktree list` showed before the checks: the removal refuses (head_moved) when the worktree's HEAD is no longer at that commit right before its first change, and a branch that gains a commit after that is kept, with a warning",
  )
  .option(
    "--require-merged",
    "refuse unless the branch is merged into origin/<default branch> (or --base): by ancestry, or by a merged pull request that gh reports for it at exactly the worktree's commit; without gh a squash merge is not recognised and the state is unknown (merge_state_unknown); a merged verdict excuses commits no remote branch has",
  )
  .option(
    "--base <rev>",
    "run the merge check against the remote-tracking branch <rev> (<remote>/<branch> or refs/remotes/<remote>/<branch>, e.g. origin/master) instead of origin's default branch, for a branch whose pull request targets another one; anything else (HEAD, a local branch, a sha, a tag) is refused as base_not_remote_branch; needs --require-merged or --delete-branch; the gh lookup uses the branch part after <remote>/ as the pull request base and runs against gh's default repository (no --repo is passed)",
  )
  .option(
    "--sync-main",
    "after the removal: `git fetch --prune --no-prune-tags origin` in the main checkout (a fetch.pruneTags setting cannot delete a local tag), then fast-forward it to origin's default branch, only when no merge, cherry-pick, revert, rebase, am or bisect is in progress there and it is on the default branch with no staged, unstaged or untracked change and is neither ahead of nor diverged from origin; otherwise skipped with the reason in the result's `sync` field. An ignored file or link in the fast-forward's way makes git refuse it, a failed sync that changes nothing. Never a checkout, reset, stash or force; a failed fetch or fast-forward is a warning, the removal stands",
  )
  .action(
    async (
      pathArg: string | undefined,
      opts: WorktreeRemoveCliOptions,
      command: Command,
    ) => {
      const start = Date.now();
      const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
      let result: RemoveWorktreeResult;
      try {
        const target = resolveRemovePathArg(pathArg, opts.path, global.cwd);
        result = await removeWorktree({
          cwd: global.cwd,
          path: target,
          force: opts.force,
          deleteBranch: opts.deleteBranch,
          requireMerged: opts.requireMerged,
          base: opts.base,
          syncMain: opts.syncMain,
          signal: shutdownController.signal,
        });
      } catch (err) {
        if (!(err instanceof WorktreeRefusal)) throw err;
        const { envelope, exitCode } = buildEnvelope({
          version: VERSION,
          command: "worktree remove",
          status: "usage_error",
          durationMs: Date.now() - start,
          cwd: global.cwd,
          warnings: [],
          logs: [],
          extra: {
            reason: err.reason,
            message: err.message,
            ...(err.details !== undefined ? { details: err.details } : {}),
          },
          maxChars: global.maxChars,
          logDir: global.logDir,
        });
        emit(
          envelope,
          exitCode,
          { format: global.format, maxChars: global.maxChars },
          () => `worktree remove refused (${err.reason}): ${err.message}\n`,
        );
        return;
      }
      const { envelope, exitCode } = buildEnvelope({
        version: VERSION,
        command: "worktree remove",
        status: result.status,
        durationMs: Date.now() - start,
        cwd: global.cwd,
        warnings: result.warnings,
        logs: [],
        extra: {
          worktree: result.worktree,
          linksRemoved: result.linksRemoved,
          merged: result.merged,
          branch: result.branch,
          pruned: result.pruned,
          ...(result.sync !== null ? { sync: result.sync } : {}),
        },
        keepWhole: ["worktree", "branch", "sync"],
        maxChars: global.maxChars,
        logDir: global.logDir,
      });
      emit(
        envelope,
        exitCode,
        { format: global.format, maxChars: global.maxChars },
        () => renderWorktreeRemoveText(result),
      );
    },
  );

interface WorktreeSweepCliOptions {
  root?: string;
  dryRun?: boolean;
}

function renderWorktreeSweepText(result: SweepWorktreesResult): string {
  const lines = [
    `status: ${result.status}${result.dryRun ? " (dry run)" : ""}`,
    `root: ${result.root}`,
    `removed: ${String(result.summary.removed)}  would remove: ${String(result.summary.wouldRemove)}  skipped: ${String(result.summary.skipped)}  ignored: ${String(result.summary.ignored)}`,
  ];
  for (const e of result.entries) {
    lines.push(
      `${e.action}  ${e.path}  ${e.branch ?? (e.repo === undefined ? "-" : "detached")}  ${e.reason}`,
    );
  }
  if (result.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

worktreeCommand
  .command("sweep")
  .description(
    "Remove every linked worktree among the direct children of --root that is clean and merged into origin's default branch, together with its local branch; --dry-run only reports. Merged means ancestry, or a merged pull request that gh reports at exactly the branch's tip; without gh a squash-merged branch is skipped. A branch with no commits of its own (its tip is its fork point, as for a worktree just created; a branch merged by ancestry looks the same) is skipped as no_own_commits, a child that is a symbolic link is not followed, a branch that gained a commit while its worktree was removed is kept, and ignored files inside a removed worktree go with it. Everything else is listed with its reason. Exit 0: nothing skipped; 1: at least one entry was skipped or a branch was kept (status partial); 2: refused",
  )
  .option(
    "--root <dir>",
    "the directory whose direct children are looked at; a worktree anywhere else is never touched, and a main checkout among the children is listed as ignored, never removed",
  )
  .option(
    "--dry-run",
    "run every check and list what would be removed, change nothing",
  )
  .action(async (opts: WorktreeSweepCliOptions, command: Command) => {
    const start = Date.now();
    const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
    let result: SweepWorktreesResult;
    try {
      if (opts.root === undefined) {
        throw new WorktreeRefusal(
          "worktree sweep needs --root <dir>: the directory whose direct children are swept",
          "option_invalid",
        );
      }
      result = await sweepWorktrees({
        cwd: global.cwd,
        root: opts.root,
        dryRun: opts.dryRun,
        signal: shutdownController.signal,
      });
    } catch (err) {
      if (!(err instanceof WorktreeRefusal)) throw err;
      const { envelope, exitCode } = buildEnvelope({
        version: VERSION,
        command: "worktree sweep",
        status: "usage_error",
        durationMs: Date.now() - start,
        cwd: global.cwd,
        warnings: [],
        logs: [],
        extra: {
          reason: err.reason,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
        maxChars: global.maxChars,
        logDir: global.logDir,
      });
      emit(
        envelope,
        exitCode,
        { format: global.format, maxChars: global.maxChars },
        () => `worktree sweep refused (${err.reason}): ${err.message}\n`,
      );
      return;
    }
    const { envelope, exitCode } = buildEnvelope({
      version: VERSION,
      command: "worktree sweep",
      status: result.status,
      durationMs: Date.now() - start,
      cwd: global.cwd,
      warnings: result.warnings,
      logs: [],
      extra: {
        dryRun: result.dryRun,
        root: result.root,
        summary: result.summary,
        entries: result.entries,
      },
      keepWhole: ["summary"],
      maxChars: global.maxChars,
      logDir: global.logDir,
    });
    emit(
      envelope,
      exitCode,
      { format: global.format, maxChars: global.maxChars },
      () => renderWorktreeSweepText(result),
    );
  });

interface WorktreeListCliOptions {
  repo?: string;
  root?: string;
  base?: string;
}

function renderWorktreeListText(result: ListWorktreesResult): string {
  const lines = result.worktrees.map((w) => {
    const dirty = w.dirty === null ? "?" : w.dirty ? "y" : "n";
    const ahead = w.ahead === null ? "?" : String(w.ahead);
    const behind = w.behind === null ? "?" : String(w.behind);
    return `${w.path}  ${w.branch ?? "detached"}  dirty=${dirty}  ahead=${ahead} behind=${behind}  merged=${w.merged.merged}  run=${w.runPointer ?? "-"}`;
  });
  if (result.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

worktreeCommand
  .command("list")
  .description(
    "Report every worktree of a repository (or every work tree below --root): its branch, run pointer, dirty state, commits ahead of and behind the default base (or --base), whether it is merged, and its dependency links",
  )
  .option(
    "--repo <path>",
    "repository to report (default: the invocation directory)",
  )
  .option(
    "--root <dir>",
    "instead of one repository, report the work trees that are direct children of this directory; exclusive with --repo",
  )
  .option(
    "--base <rev>",
    "measure ahead, behind and merged against the remote-tracking branch <rev> (<remote>/<branch> or refs/remotes/<remote>/<branch>, e.g. origin/master for hotfix branches) instead of origin's default branch, in every repository reported; a value that is no remote-tracking branch at all (HEAD, a local branch, a sha, an empty or option-like value) is refused as base_not_remote_branch, also with --root, before any repository is read; with --root, a repository that lacks the remote gives merged unknown and a warning; a well-formed value whose ref a repository lacks gives merged unknown and a warning in either mode; the gh lookup uses the branch part after <remote>/ as the pull request base and runs against gh's default repository (no --repo is passed)",
  )
  .action(async (opts: WorktreeListCliOptions, command: Command) => {
    const start = Date.now();
    const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
    let result: ListWorktreesResult;
    try {
      result = await listWorktrees({
        cwd: global.cwd,
        repo: opts.repo,
        root: opts.root,
        base: opts.base,
      });
    } catch (err) {
      if (!(err instanceof WorktreeRefusal)) throw err;
      const { envelope, exitCode } = buildEnvelope({
        version: VERSION,
        command: "worktree list",
        status: "usage_error",
        durationMs: Date.now() - start,
        cwd: global.cwd,
        warnings: [],
        logs: [],
        extra: {
          reason: err.reason,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
        maxChars: global.maxChars,
        logDir: global.logDir,
      });
      emit(
        envelope,
        exitCode,
        { format: global.format, maxChars: global.maxChars },
        () => `worktree list refused (${err.reason}): ${err.message}\n`,
      );
      return;
    }
    const { envelope, exitCode } = buildEnvelope({
      version: VERSION,
      command: "worktree list",
      status: result.status,
      durationMs: Date.now() - start,
      cwd: global.cwd,
      warnings: result.warnings,
      logs: [],
      extra: {
        worktrees: result.worktrees,
      },
      maxChars: global.maxChars,
      logDir: global.logDir,
    });
    emit(
      envelope,
      exitCode,
      { format: global.format, maxChars: global.maxChars },
      () => renderWorktreeListText(result),
    );
  });

// CommanderError codes that represent a genuine, successful exit (--help,
// --version) rather than a usage error, and must therefore pass their exit
// code straight through instead of being remapped to 2.
const PASSTHROUGH_EXIT_CODES = new Set([
  "commander.helpDisplayed",
  "commander.version",
]);

// A small table from a commonly-tried but wrong option spelling to the
// form that actually works, appended to commander's own "unknown option"
// message. `--text` is a real trap: there is no such flag, `-f text` is
// the only way. Rows belong here only for a spelling that is not
// registered anywhere in this CLI: a registered alias (`--json` since
// AC4 made it a real global option) is parsed by commander itself and
// so never reaches "unknown option" -> never reaches this table.
const UNKNOWN_OPTION_HINTS: Record<string, string> = {
  "--text": "use -f text",
};

/** True when a value looks like it was meant for `--file` rather than
 * `-f`: a path-shaped string with a `/` or a recognizable file
 * extension. Used only to add a hint to `-f`'s own invalid-argument
 * message; `-f`'s two valid values (`json`, `text`) are never even
 * close to path-shaped. */
function looksPathLike(value: string): boolean {
  return value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

/**
 * Appends a short, targeted hint to a raw commander error message when
 * it recognizes the shape of a common mistake: an unknown option with a
 * known alias in `UNKNOWN_OPTION_HINTS`, or an invalid `-f`/`--format`
 * value that looks like it was meant for `probe`'s `--file` instead.
 * Returns the message unchanged when neither shape matches, so it is
 * always safe to call on any error message, not only a commander one.
 */
export function withOptionHint(message: string): string {
  const unknownOption = message.match(/unknown option '(--?[^']+)'/);
  if (unknownOption) {
    const hint = UNKNOWN_OPTION_HINTS[unknownOption[1]];
    if (hint) return `${message} (${hint})`;
  }
  const formatArg = message.match(
    /option '-f, --format <format>' argument '([^']*)' is invalid/,
  );
  if (formatArg && looksPathLike(formatArg[1])) {
    return `${message} (probe's file option is --file; -f is the global --format)`;
  }
  return message;
}

/**
 * Maps any error thrown out of `program.parseAsync()` to an envelope:
 * a CommanderError or UsageError becomes `status: "usage_error"`, anything
 * else becomes `status: "error"`. Exported and unit-tested directly (with
 * a plain Error, a UsageError, and a CommanderError) instead of relying on
 * a process-env test seam to force a runtime error through the real CLI
 * entrypoint.
 */
export function mapTopLevelError(
  err: unknown,
  global: ResolvedGlobal,
  start: number,
  writeErrorLog = true,
): EnvelopeOutput {
  const durationMs = Date.now() - start;
  if (err instanceof CommanderError || err instanceof UsageError) {
    const reason =
      err instanceof CliReasonedUsageError ? err.reason : "usage_error";
    return buildEnvelope({
      version: VERSION,
      command: "unknown",
      status: "usage_error",
      durationMs,
      cwd: global.cwd,
      warnings: [],
      logs: [],
      extra: { reason, message: withOptionHint(err.message) },
      maxChars: global.maxChars,
      logDir: writeErrorLog ? global.logDir : undefined,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return buildEnvelope({
    version: VERSION,
    command: "unknown",
    status: "error",
    durationMs,
    cwd: global.cwd,
    warnings: [],
    logs: [],
    extra: { reason: "error", message },
    maxChars: global.maxChars,
    logDir: writeErrorLog ? global.logDir : undefined,
  });
}

// Only run the CLI (and its process.exit calls) when this file is executed
// directly (`node dist/cli.js ...`), not when it is merely imported for its
// exports (as tests do): otherwise importing this module would parse the
// importer's own process.argv and could exit the importing process.
// argv[1] is the path the shell invoked; every real install path routes
// through a symlink (`node_modules/.bin/agent-primitives` -> the resolved
// dist/cli.js), which is what `npx` and `npm i -g` create, so comparing it
// verbatim against `import.meta.url` (always the resolved realpath) never
// matches. Resolve argv[1] before comparing; fall back to the raw value if
// it does not exist on disk.
function resolvedArgvUrl(argv1: string): string {
  try {
    return pathToFileURL(fs.realpathSync(argv1)).href;
  } catch {
    return pathToFileURL(argv1).href;
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === resolvedArgvUrl(process.argv[1]);

if (isMainModule) {
  installSignalHandlers();
  const start = Date.now();
  program.parseAsync().catch((err: unknown) => {
    // Each branch below terminates the handler (`return` after emitting):
    // emitting now drains asynchronously (writeAndExit waits for the
    // stdout write callback before calling process.exit), so falling
    // through to a later branch would emit a second envelope on the same
    // stdout instead of being a no-op the way an immediate process.exit()
    // used to make it.
    if (err instanceof CommanderError && PASSTHROUGH_EXIT_CODES.has(err.code)) {
      process.exit(err.exitCode);
      return;
    }
    const global = bestEffortGlobal(program.opts<GlobalOptions>());
    const { envelope, exitCode } = mapTopLevelError(
      err,
      global,
      start,
      !process.argv
        .slice(2)
        .some((arg) => arg === "snapshot" || arg === "delta"),
    );
    emit(envelope, exitCode, {
      format: global.format,
      maxChars: global.maxChars,
    });
  });
}

export { program };

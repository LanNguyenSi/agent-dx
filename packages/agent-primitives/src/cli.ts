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
  type EnvelopeOutput,
} from "./envelope.js";
import {
  doctor,
  DEFAULT_OPTIONAL,
  DEFAULT_REQUIRED,
  type DoctorResult,
} from "./doctor/index.js";
import {
  verify,
  DEFAULT_CHECKS,
  DEFAULT_MAX_FAILURES,
  type VerifyResult,
} from "./verify/index.js";
import {
  probe,
  type ExpectVerdict,
  type IsolationMode,
} from "./probe/index.js";

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
  const logDir =
    opts.logDir ??
    process.env.AGENT_PRIMITIVES_LOG_DIR ??
    path.join(os.tmpdir(), "agent-primitives", currentRunId());
  return { format: opts.format, cwd, maxChars, logDir };
}

/** Resolves and validates the global options. Throws UsageError when `-C`
 * names a path that does not exist or is not a directory. */
function resolveGlobal(opts: GlobalOptions): ResolvedGlobal {
  const global = bestEffortGlobal(opts);
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
    "Agent-first CLI primitives: bounded JSON envelopes, a mutation-probe runner, a verify runner, a PATH doctor",
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
    "directory for logs and full (untruncated) results (defaults to $AGENT_PRIMITIVES_LOG_DIR or <tmpdir>/agent-primitives/<run-id>/)",
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
  .action(
    async (
      opts: { required: string[]; optional: string[] },
      command: Command,
    ) => {
      const start = Date.now();
      const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
      const result = await doctor({
        required: opts.required,
        optional: opts.optional,
        cwd: global.cwd,
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

interface VerifyCliOptions {
  checks?: string[];
  exec: Record<string, string>;
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
      failFast: Boolean(opts.failFast),
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
      () => renderVerifyText(result),
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

function renderVerifyText(result: VerifyResult): string {
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
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
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
  file: string;
  line: number;
  replace?: string;
  match?: string;
  with?: string;
  patch?: string;
  test: string;
  pre?: string;
  isolation: IsolationMode;
  expect: ExpectVerdict;
  timeout?: number;
  link?: string[];
  allowOutside?: boolean;
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

function parseTimeoutSeconds(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError(
      `--timeout must be a positive number of seconds (got "${value}")`,
    );
  }
  return n;
}

type MutantChoice =
  | { form: "replace"; replaceText: string }
  | { form: "match"; matchText: string; withText: string }
  | { form: "patch"; patchPath: string };

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
    return { form: "match", matchText: opts.match, withText: opts.with };
  }
  if (hasReplace) {
    return { form: "replace", replaceText: opts.replace as string };
  }
  return { form: "patch", patchPath: opts.patch as string };
}

program
  .command("probe")
  .description(
    "Apply one mutant, confirm the test fails on baseline and (per --expect) reacts to the mutant, then restore",
  )
  .requiredOption(
    "--file <path>",
    "path to the file to mutate (long-only: the global -f is --format)",
  )
  .requiredOption("-n, --line <n>", "1-indexed line number", parseLine)
  .option("-r, --replace <text>", "replace the whole line with this text")
  .option("-M, --match <substr>", "substring to find on the line (requires -w)")
  .option("-w, --with <text>", "replacement for the first match of -M")
  .option("-p, --patch <path>", "path to a unified diff, applied via git apply")
  .requiredOption("-t, --test <command>", "shell command that runs the test")
  .option(
    "--pre <command>",
    "shell command (e.g. a rebuild) run before each test invocation",
  )
  .option(
    "-i, --isolation <mode>",
    "worktree or inplace (default inplace; worktree is not yet implemented)",
    parseIsolationMode,
    "inplace",
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
    "--link <dirs>",
    "comma-separated extra directories checked for containment",
    parseList,
  )
  .option(
    "--allow-outside",
    "allow --file/--link to resolve outside the containment root",
  )
  .action(async (opts: ProbeCliOptions, command: Command) => {
    const start = Date.now();
    const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
    const mutantChoice = resolveMutantForm(opts);
    const result = await probe({
      file: opts.file,
      line: opts.line,
      ...mutantChoice,
      testCommand: opts.test,
      preCommand: opts.pre,
      isolation: opts.isolation,
      expect: opts.expect,
      timeoutMs: opts.timeout !== undefined ? opts.timeout * 1000 : undefined,
      links: opts.link ?? [],
      allowOutside: opts.allowOutside ?? false,
      cwd: global.cwd,
      logDir: global.logDir,
    });
    const { envelope, exitCode } = buildEnvelope({
      version: VERSION,
      command: "probe",
      status: result.status,
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
        ...(result.test !== undefined ? { test: result.test } : {}),
        isolation: result.isolation,
      },
      maxChars: global.maxChars,
      logDir: global.logDir,
    });
    emit(envelope, exitCode, {
      format: global.format,
      maxChars: global.maxChars,
    });
  });

function registerStub(name: string, description: string): void {
  program
    .command(name)
    .description(`${description} (not yet implemented)`)
    .action((_opts: object, command: Command) => {
      const start = Date.now();
      const global = resolveGlobal(command.optsWithGlobals<GlobalOptions>());
      const { envelope, exitCode } = buildEnvelope({
        version: VERSION,
        command: name,
        status: "usage_error",
        durationMs: Date.now() - start,
        cwd: global.cwd,
        warnings: [],
        logs: [],
        extra: { reason: "not_implemented" },
        maxChars: global.maxChars,
        logDir: global.logDir,
      });
      emit(envelope, exitCode, {
        format: global.format,
        maxChars: global.maxChars,
      });
    });
}

registerStub(
  "init",
  "Install the agent-primitives skill into a harness's skill directories",
);

// CommanderError codes that represent a genuine, successful exit (--help,
// --version) rather than a usage error, and must therefore pass their exit
// code straight through instead of being remapped to 2.
const PASSTHROUGH_EXIT_CODES = new Set([
  "commander.helpDisplayed",
  "commander.version",
]);

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
): EnvelopeOutput {
  const durationMs = Date.now() - start;
  if (err instanceof CommanderError || err instanceof UsageError) {
    return buildEnvelope({
      version: VERSION,
      command: "unknown",
      status: "usage_error",
      durationMs,
      cwd: global.cwd,
      warnings: [],
      logs: [],
      extra: { reason: "usage_error", message: err.message },
      maxChars: global.maxChars,
      logDir: global.logDir,
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
    logDir: global.logDir,
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
    const { envelope, exitCode } = mapTopLevelError(err, global, start);
    emit(envelope, exitCode, {
      format: global.format,
      maxChars: global.maxChars,
    });
  });
}

export { program };

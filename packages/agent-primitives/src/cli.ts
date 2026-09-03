#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { buildEnvelope, UsageError, type EnvelopeOutput } from "./envelope.js";
import {
  doctor,
  DEFAULT_OPTIONAL,
  DEFAULT_REQUIRED,
  type DoctorResult,
} from "./doctor/index.js";

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

let runId: string | undefined;
function currentRunId(): string {
  if (!runId) runId = randomUUID();
  return runId;
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

registerStub("probe", "Run a mutation probe");
registerStub("verify", "Run project verify checks");
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

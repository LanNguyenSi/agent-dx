#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { buildEnvelope } from "./envelope.js";
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

function resolveGlobal(opts: GlobalOptions): {
  format: "json" | "text";
  cwd: string;
  maxChars: number;
  logDir: string;
} {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const maxChars = Number(opts.maxChars);
  const logDir =
    opts.logDir ??
    process.env.AGENT_PRIMITIVES_LOG_DIR ??
    path.join(os.tmpdir(), "agent-primitives", currentRunId());
  return { format: opts.format, cwd, maxChars, logDir };
}

function writeEnvelope(
  envelope: Record<string, unknown>,
  exitCode: number,
): never {
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exit(exitCode);
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
        warnings: [],
        logs: [],
        extra: {
          tools: result.tools,
          checks: result.checks,
          hints: result.hints,
        },
        maxChars: global.maxChars,
        logDir: global.logDir,
      });
      if (global.format === "text") {
        process.stdout.write(renderDoctorText(result));
        process.exit(exitCode);
      }
      writeEnvelope(envelope, exitCode);
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
    const version = tool.version ? ` (${tool.version})` : "";
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
      writeEnvelope(envelope, exitCode);
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

function emitUsageError(message: string, start: number): never {
  const opts = program.opts<GlobalOptions>();
  const global = resolveGlobal(opts);
  const { envelope, exitCode } = buildEnvelope({
    version: VERSION,
    command: "unknown",
    status: "usage_error",
    durationMs: Date.now() - start,
    cwd: global.cwd,
    warnings: [],
    logs: [],
    extra: { reason: "usage_error", message },
    maxChars: global.maxChars,
    logDir: global.logDir,
  });
  writeEnvelope(envelope, exitCode);
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
    if (err instanceof CommanderError) {
      if (PASSTHROUGH_EXIT_CODES.has(err.code)) {
        process.exit(err.exitCode);
      }
      emitUsageError(err.message, start);
    }
    emitUsageError(err instanceof Error ? err.message : String(err), start);
  });
}

export { program };

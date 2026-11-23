#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { Command, CommanderError } from "commander";
import { intakeFile } from "./adapters/file.js";
import {
  DigestError,
  computeSpecDigest,
  describeDigestError,
} from "./canonical/index.js";
import { IntakeError } from "./intake/index.js";
import { runTriage } from "./triage/index.js";

function readVersion(): string {
  const url = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(url, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error(`spec-gate: no version in ${url.pathname}`);
  }
  return pkg.version;
}

const program = new Command();

program
  .name("spec-gate")
  .description(
    "Turn a ticket or intent into a checked, reviewable spec and test plan " +
      "before implementation starts.",
  )
  .version(readVersion())
  .helpOption("-h, --help", "display help for spec-gate")
  .showHelpAfterError()
  .allowExcessArguments(false);

function collectPath(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const intake = program
  .command("intake")
  .description("create specs/<id>/source/ from a source");

// Usage errors of this command (a missing --id or <path>, an unknown option)
// and an unexpected exception in the action exit 2, like every other error:
// exit 1 belongs to drift alone. exitOverride makes commander throw instead
// of calling process.exit(1); the usage message is written to stderr before
// the throw, and a help or version request arrives as a CommanderError whose
// exitCode is 0 and stays 0.
intake
  .command("file <path>")
  .description(
    "create specs/<id>/source/ in the target repository from a local file",
  )
  .requiredOption("--id <spec-id>", "the spec ID to create")
  .option(
    "--repo <dir>",
    "the target repository (default: the git toplevel of the current directory)",
  )
  .option(
    "--remote <name>",
    "the remote whose default branch sets base_commit and commands_ref",
    "origin",
  )
  .option("--author <name>", "the author recorded on the body section")
  .option(
    "--attach <path>",
    "record a local attachment by name, hash, size and type; repeatable; the file is never copied",
    collectPath,
    [],
  )
  .option("--no-raw", "do not write ticket.md and record raw: false")
  .option(
    "--check",
    "compare the file with the recorded source: exit 0 when unchanged, 1 on drift, 2 on an error; writes nothing and does not fetch",
  )
  .exitOverride((err: CommanderError) => {
    throw err;
  })
  .action(
    async (
      filePath: string,
      opts: {
        id: string;
        repo?: string;
        remote: string;
        author?: string;
        attach: string[];
        raw: boolean;
        check: boolean;
      },
    ) => {
      try {
        const run = await intakeFile({
          sourcePath: filePath,
          id: opts.id,
          repo: opts.repo,
          remote: opts.remote,
          author: opts.author,
          attach: opts.attach,
          raw: opts.raw,
          check: opts.check,
        });
        if (run.stdout !== "") process.stdout.write(`${run.stdout}\n`);
        process.exitCode = run.exitCode;
      } catch (err) {
        if (!(err instanceof IntakeError)) throw err;
        process.stderr.write(`spec-gate: ${err.message}\n`);
        process.exitCode = 2;
      }
    },
  );

program
  .command("digest")
  .description(
    "print the digest of the normative layer of a spec directory " +
      "(sha256:<hex>); prints nothing and exits non-zero on any error",
  )
  .argument("<spec-dir>", "directory with spec.md and testplan.yaml")
  .option(
    "--repo <path>",
    "git repository to read .spec-gate/commands.yaml from at commands_ref " +
      "(default: the git top level of <spec-dir>)",
  )
  .action((specDir: string, options: { repo?: string }) => {
    try {
      const digest = computeSpecDigest(specDir, options);
      process.stdout.write(`${digest}\n`);
    } catch (err) {
      if (!(err instanceof DigestError)) throw err;
      process.stderr.write(describeDigestError(err));
      process.exitCode = 1;
    }
  });

program
  .command("triage")
  .description(
    "Derive the triage class from <spec-dir>/triage.json and write it back.",
  )
  .argument("<spec-dir>", "directory that holds triage.json")
  .action((specDir: string) => {
    const result = runTriage(specDir);
    if (result.ok) {
      process.stdout.write(`${JSON.stringify(result.report)}\n`);
      return;
    }
    process.stderr.write(`${result.message}\n`);
    for (const error of result.errors ?? []) {
      const at = error.line === undefined ? "" : ` (line ${error.line})`;
      process.stderr.write(
        `  ${error.code} at ${error.path}: ${error.message}${at}\n`,
      );
    }
    process.exitCode = 1;
  });

try {
  await program.parseAsync();
} catch (err) {
  // Only the `intake file` command has exitOverride, so every CommanderError
  // comes from it: help and version keep their exit code 0, a usage error
  // exits 2; anything else is an unexpected exception and also exits 2.
  if (err instanceof CommanderError) {
    // commander has already written the usage message to stderr.
    process.exitCode = err.exitCode === 0 ? 0 : 2;
  } else {
    // An unexpected exception is never silent: name it, then exit 2.
    const text =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`spec-gate: unexpected error: ${text}\n`);
    process.exitCode = 2;
  }
}

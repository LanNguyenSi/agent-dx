#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { Command } from "commander";
import { IntakeError, intakeFile } from "./intake.js";

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
    "compare the file with the recorded source and exit 1 on drift; writes nothing and does not fetch",
  )
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
        process.exitCode = 1;
      }
    },
  );

await program.parseAsync();

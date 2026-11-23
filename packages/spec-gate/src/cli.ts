#!/usr/bin/env node
import fs from "node:fs";
import { Command } from "commander";
import {
  DigestError,
  computeSpecDigest,
  describeDigestError,
} from "./canonical/index.js";
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

program.parse();

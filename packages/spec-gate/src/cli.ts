#!/usr/bin/env node
import fs from "node:fs";
import { Command } from "commander";

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

program.parse();

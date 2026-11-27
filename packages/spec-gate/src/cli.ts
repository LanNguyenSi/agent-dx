#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { Command, CommanderError, Option } from "commander";
import { intakeFile } from "./adapters/file.js";
import { runApproveCheck } from "./approve/index.js";
import {
  DigestError,
  computeSpecDigest,
  describeDigestError,
} from "./canonical/index.js";
import { IntakeError } from "./intake/index.js";
import { ACKS_FILE, lintSpecDir, writeAck } from "./lint/index.js";
import { repoCheck } from "./repo/index.js";
import {
  answerSpecDir,
  bindSpecDir,
  proposeSpecDir,
  questionsSpecDir,
  statusSpecDir,
  type AnswerRequest,
} from "./state/index.js";
import { runTriage } from "./triage/index.js";
import {
  ExportError,
  checkSlicerReturn,
  exportSpecDir,
} from "./exporters/index.js";

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
    "git work tree to read .spec-gate/commands.yaml from at commands_ref " +
      "(default: the git top level of <spec-dir>); its git directory must be <top level>/.git " +
      "or lie outside the work tree",
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

// `lint` and `lint-ack` exit 0 or 1 only for a result (a clean report or one
// with findings, a written ack), and 2 for everything else: a usage error, a
// spec directory that is not one, a refused write, an unexpected exception.
// exitOverride makes commander throw instead of calling process.exit(1); the
// outer catch below maps that to 2 and keeps 0 for help.
program
  .command("lint")
  .description(
    "check a spec directory and print one JSON report line " +
      "(spec-gate-lint/1); exits 0 without errors, 1 with findings, 2 on usage errors",
  )
  .argument("<spec-dir>", "directory with spec.md and testplan.yaml")
  .option("--strict", "unacknowledged warnings fail the run, like errors")
  .option(
    "--final",
    "check as at approval: rules gated on status proposed apply whatever the status",
  )
  .addOption(
    new Option(
      "--profile <profile>",
      "profile to use when triage.json gives none; an error when it disagrees with triage.json",
    ).choices(["light", "full"]),
  )
  .option(
    "--config <path>",
    "a .spec-gate/config.yaml-format file for the rules that read repo-wide settings; " +
      "not allowed with --default-ref or --base (the config is read at the reference commit then)",
  )
  .option(
    "--repo <dir>",
    "the trusted checkout root for the reference-state rules; required with --default-ref and --base, " +
      "never discovered from <spec-dir>, which must lie inside it",
  )
  .option(
    "--default-ref <ref>",
    "full ref name under refs/ of the fetched target branch of the pull request " +
      "(for example refs/remotes/origin/main when it targets main), " +
      "the reference commit for the ancestry checks; resolved offline, never fetched. " +
      "Must be a remote-tracking ref (or the event's base) the spec author cannot move, never a local branch " +
      "or the pull request head. Needs --repo. Without --default-ref and --base the git rules are skipped (no-git)",
  )
  .option(
    "--base <commit>",
    "full commit id of the pull request base from the host event: the reference commit for the ancestry checks " +
      "and, with HEAD, the merge base the diff of .spec-gate/ starts at; wins over --default-ref, " +
      "but with both it must be an ancestor of (or equal to) the --default-ref commit. Needs --repo",
  )
  .exitOverride((err: CommanderError) => {
    throw err;
  })
  .action(
    (
      specDir: string,
      options: {
        strict?: boolean;
        final?: boolean;
        profile?: "light" | "full";
        config?: string;
        repo?: string;
        defaultRef?: string;
        base?: string;
      },
    ) => {
      const result = lintSpecDir(specDir, {
        strict: options.strict,
        final: options.final,
        profile: options.profile,
        configPath: options.config,
        git: {
          repo: options.repo,
          defaultRef: options.defaultRef,
          base: options.base,
        },
      });
      if (!result.ok) {
        process.stderr.write(`spec-gate: ${result.message}\n`);
        process.exitCode = 2;
        return;
      }
      process.stdout.write(`${JSON.stringify(result.report)}\n`);
      process.exitCode = result.report.ok ? 0 : 1;
    },
  );

program
  .command("lint-ack")
  .description(
    "acknowledge one warning: append { rule, id, reason } to <spec-dir>/acks.yaml; " +
      "exits 0 when written, 2 on any refusal",
  )
  .argument("<spec-dir>", "directory with spec.md and testplan.yaml")
  .argument("<rule>", "the warning rule to acknowledge")
  .argument("<id>", "the ID the warning is about, or the rule's target")
  .requiredOption("--reason <text>", "why the warning is accepted (one line)")
  .exitOverride((err: CommanderError) => {
    throw err;
  })
  .action(
    (
      specDir: string,
      rule: string,
      id: string,
      options: { reason: string },
    ) => {
      const result = writeAck(specDir, rule, id, options.reason);
      if (!result.ok) {
        process.stderr.write(`spec-gate: ${result.message}\n`);
        process.exitCode = 2;
        return;
      }
      if (result.normalised) {
        process.stderr.write(
          `spec-gate: lint-ack: ${ACKS_FILE} was rewritten as a block list; its comments were dropped\n`,
        );
      }
      process.stdout.write(`acknowledged ${rule} ${id}\n`);
    },
  );

// `propose` and `bind` follow the exit codes of `lint` and `lint-ack`: 0 for
// a result that was written, 1 for a final lint with findings (propose only;
// the report goes to stdout and nothing is written), 2 for a usage error, a
// refusal or an unexpected exception.
program
  .command("propose")
  .description(
    "move a draft spec to proposed: run the final lint with the git inputs, then set status: proposed " +
      "and create bindings.log; exits 0 when written, 1 when the final lint has findings, 2 on any refusal",
  )
  .argument(
    "<spec-dir>",
    "directory with spec.md, testplan.yaml and bindings.yaml",
  )
  .option(
    "--repo <dir>",
    "the trusted checkout root, as for lint; required with --default-ref and --base",
  )
  .option(
    "--default-ref <ref>",
    "full ref name of the fetched target branch, as for lint",
  )
  .option(
    "--base <commit>",
    "full commit id of the pull request base, as for lint",
  )
  .exitOverride((err: CommanderError) => {
    throw err;
  })
  .action(
    (
      specDir: string,
      options: { repo?: string; defaultRef?: string; base?: string },
    ) => {
      const result = proposeSpecDir(specDir, {
        repo: options.repo,
        defaultRef: options.defaultRef,
        base: options.base,
      });
      if (result.kind === "refused") {
        process.stderr.write(`spec-gate: ${result.message}\n`);
        process.exitCode = 2;
        return;
      }
      if (result.kind === "findings") {
        process.stdout.write(`${JSON.stringify(result.report)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`proposed ${result.spec} at ${result.commit}\n`);
    },
  );

program
  .command("bind")
  .description(
    "change the binding of one test-plan row of a proposed spec: append the full new binding to " +
      "bindings.log and rewrite bindings.yaml; exits 0 when written, 2 on any refusal",
  )
  .argument(
    "<spec-dir>",
    "directory with spec.md, testplan.yaml, bindings.yaml and bindings.log",
  )
  .argument(
    "<tp-id>",
    "the TP ID whose binding changes; it must exist in testplan.yaml and bindings.yaml",
  )
  .requiredOption("--status <status>", "the binding status, new or existing")
  .option("--selector <selector>", "the test selector")
  .option("--file <path>", "the repo-relative test file")
  .option(
    "--fixtures <path>",
    "a repo-relative fixture path; repeatable",
    collectPath,
    [],
  )
  .option("--notes <text>", "a free note on the binding")
  .exitOverride((err: CommanderError) => {
    throw err;
  })
  .action(
    (
      specDir: string,
      tp: string,
      options: {
        status: string;
        selector?: string;
        file?: string;
        fixtures: string[];
        notes?: string;
      },
    ) => {
      const result = bindSpecDir(specDir, tp, options);
      if (!result.ok) {
        process.stderr.write(`spec-gate: ${result.message}\n`);
        process.exitCode = 2;
        return;
      }
      process.stdout.write(`bound ${result.tp} (entry ${result.seq})\n`);
    },
  );

// `repo-check` follows the exit codes of `lint`: 0 for a clean report, 1 for
// a report with findings, 2 for a usage error, a git failure or an
// unexpected exception.
program
  .command("repo-check")
  .description(
    "check that no protected spec at the diff base (a spec.md anywhere in the tree that is not a draft or has a " +
      "bindings.log) disappears, changes its id, goes back to draft or loses its log at HEAD; prints one JSON " +
      "report line (spec-gate-repo-check/1); exits 0 without findings, 1 with findings, 2 on usage errors. " +
      "Run it on every pull request, not only on spec pull requests",
  )
  .requiredOption(
    "--repo <dir>",
    "the trusted checkout root, as for lint; never discovered",
  )
  .option(
    "--default-ref <ref>",
    "full ref name of the fetched target branch, as for lint",
  )
  .option(
    "--base <commit>",
    "full commit id of the pull request base, as for lint; wins over --default-ref and must lie on it",
  )
  .exitOverride((err: CommanderError) => {
    throw err;
  })
  .action((options: { repo: string; defaultRef?: string; base?: string }) => {
    const result = repoCheck({
      repo: options.repo,
      defaultRef: options.defaultRef,
      base: options.base,
    });
    if (!result.ok) {
      process.stderr.write(`spec-gate: ${result.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
    process.exitCode = result.report.ok ? 0 : 1;
  });

// `export` follows the exit codes of `lint`: 0 for a result (a printed
// briefing, a return that names every id), 1 when a checked return is
// missing ids, 2 for a usage error and every refusal (a spec that is not
// merged unchanged on the default branch, a format or a file that cannot
// be read).
program
  .command("export")
  .description(
    "--format ow: print the deterministic slicer briefing of a proposed spec merged unchanged " +
      "on the default branch; --check: verify that a slicer return names every qualified AC and TP id " +
      "of a spec; exits 0 on a complete result, 1 when a checked return misses ids, 2 on any refusal",
  )
  .argument(
    "<spec-dir>",
    "directory with spec.md, testplan.yaml and bindings.yaml",
  )
  .addOption(
    new Option(
      "--format <format>",
      "print the briefing in this format; ow is the only format; needs --repo and --default-ref",
    ).choices(["ow"]),
  )
  .option(
    "--repo <dir>",
    "the trusted checkout root, as for lint; required with --format",
  )
  .option(
    "--default-ref <ref>",
    "full ref name of the default branch (for example refs/remotes/origin/main): " +
      "the spec.md, testplan.yaml and bindings.yaml of the work tree must be byte-equal to the copies " +
      "at that commit and the status must be proposed; required with --format",
  )
  .option(
    "--check <file>",
    "the slicer return to check: exit 0 when every qualified AC and TP id of <spec-dir> appears as a " +
      "whole token in a string field of at least one task, 1 with the missing ids listed; reads no git",
  )
  .exitOverride((err: CommanderError) => {
    throw err;
  })
  .action(
    (
      specDir: string,
      options: {
        format?: string;
        repo?: string;
        defaultRef?: string;
        check?: string;
      },
    ) => {
      try {
        if (options.check !== undefined) {
          if (
            options.format !== undefined ||
            options.repo !== undefined ||
            options.defaultRef !== undefined
          ) {
            throw new ExportError(
              "usage",
              "--check reads no repository and prints no briefing: remove --format, --repo and --default-ref",
            );
          }
          const outcome = checkSlicerReturn(specDir, options.check);
          if (!outcome.ok) {
            throw new ExportError(outcome.code, outcome.message);
          }
          for (const id of outcome.missing) {
            process.stdout.write(`missing ${id}\n`);
          }
          process.exitCode = outcome.missing.length === 0 ? 0 : 1;
          return;
        }
        const outcome = exportSpecDir(specDir, options);
        if (!outcome.ok) {
          throw new ExportError(outcome.code, outcome.message);
        }
        process.stdout.write(outcome.text);
      } catch (err) {
        if (!(err instanceof ExportError)) throw err;
        process.stderr.write(
          `spec-gate: export: ${err.code}: ${err.message}\n`,
        );
        process.exitCode = 2;
      }
    },
  );

// `questions`, `answer` and `status` follow the exit codes of `lint` and
// `lint-ack`: `questions` exits 0 with no unanswered question and 1 with
// one listed; `answer` exits 0 when the answer was written; `status` exits
// 0 for a report; every one exits 2 for a usage error and every refusal.
program
  .command("questions")
  .description(
    "print one JSON line (spec-gate-questions/1) with a spec's unanswered questions in ID order " +
      "and their counts; exits 0 with none unanswered, 1 with one listed, 2 on usage errors or a file that does not load",
  )
  .argument(
    "<spec-dir>",
    "directory with spec.md and an optional questions.json",
  )
  .exitOverride((err: CommanderError) => {
    throw err;
  })
  .action((specDir: string) => {
    const result = questionsSpecDir(specDir);
    if (!result.ok) {
      process.stderr.write(`${result.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
    process.exitCode = result.report.counts.unanswered > 0 ? 1 : 0;
  });

program
  .command("answer")
  .description(
    "append one answer to <spec-dir>/questions.json for a draft spec, with the time taken from the clock " +
      "and the channel, author and optional comment URL recorded as provenance; exits 0 when written, 2 on any refusal",
  )
  .argument(
    "<spec-dir>",
    "directory that is specs/<name> with a draft spec.md and a questions.json",
  )
  .argument("<question-id>", "the QN-<n> question to answer")
  .option("--answer <text>", "the answer text")
  .option("--option <label>", "the label of the chosen option; needs --answer")
  .option(
    "--accept-recommended",
    "answer with the question's recommended option; needs a divergence question that carries one",
  )
  .addOption(
    new Option("--channel <channel>", "where the answer was given")
      .choices(["file", "chat", "comment"])
      .makeOptionMandatory(),
  )
  .requiredOption("--author <login>", "the login of the person who answered")
  .option(
    "--comment-url <url>",
    "the https URL of the comment that recorded the answer; needs --channel comment",
  )
  .exitOverride((err: CommanderError) => {
    throw err;
  })
  .action(
    (
      specDir: string,
      questionId: string,
      opts: {
        answer?: string;
        option?: string;
        acceptRecommended?: boolean;
        channel: string;
        author: string;
        commentUrl?: string;
      },
    ) => {
      const request: AnswerRequest = {
        question: questionId,
        channel: opts.channel,
        author: opts.author,
        ...(opts.answer !== undefined ? { answer: opts.answer } : {}),
        ...(opts.option !== undefined ? { option: opts.option } : {}),
        ...(opts.acceptRecommended === true ? { acceptRecommended: true } : {}),
        ...(opts.commentUrl !== undefined
          ? { commentUrl: opts.commentUrl }
          : {}),
      };
      const result = answerSpecDir(specDir, request);
      if (!result.ok) {
        process.stderr.write(`${result.message}\n`);
        process.exitCode = 2;
        return;
      }
      process.stdout.write(
        `answered ${result.question} (answer ${result.answers})\n`,
      );
    },
  );

program
  .command("status")
  .description(
    "print one offline JSON line (spec-gate-status/1) with a spec's status, triage class stored and derived, " +
      "question counts, open residuals, bindings by status, bindings.log entry count and propose commit, and ack count; " +
      "a file that does not load is null with its code listed; exits 0 for a report, 2 on usage errors",
  )
  .argument("<spec-dir>", "directory with spec.md")
  .exitOverride((err: CommanderError) => {
    throw err;
  })
  .action((specDir: string) => {
    const result = statusSpecDir(specDir);
    if (!result.ok) {
      process.stderr.write(`${result.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
    process.exitCode = 0;
  });

// `approve-check` exits 0 only for a report that says approved, 1 for a
// report that does not, and 2 for a usage error, a refusal or an exception.
// The token is read from the environment and has no option. An option the
// verb does not know is counted here and refused by the verb itself, so
// commander never repeats it on stderr: a token given as `--token=...` by
// mistake is not printed. The verb has no help option of its own, so
// `--help` among its arguments is such an option and exits 2 instead of 0;
// `spec-gate help approve-check` prints the help.
program
  .command("approve-check")
  .description(
    "check whether the proposed spec of an open GitHub pull request is approved and print one JSON report line " +
      "(spec-gate-approve/1): the eight conditions, the repository check among them, and the commands the spec " +
      "refers to; exits 0 when approved, 1 when not, 2 on a usage error or refusal. The checkout must be at the head " +
      "commit of the pull request, not at a merge of it. With --merged it checks after the merge whether the spec at " +
      "the tip of the default branch is the one that was approved; the checkout must then be at that tip. " +
      "The token is read from the environment variable GITHUB_TOKEN only",
  )
  .argument("<spec-dir>", "the spec directory, specs/<name> inside --repo")
  .requiredOption(
    "--repo <dir>",
    "the trusted checkout root, as for lint; never discovered",
  )
  .requiredOption(
    "--default-ref <ref>",
    "full ref name of the fetched default branch, as for lint; the settings are read at its commit",
  )
  .option(
    "--base <commit>",
    "full commit id of the pull request base; it must lie on --default-ref and be the base the host reports. " +
      "Nothing is measured from it",
  )
  .requiredOption(
    "--github-repo <owner/name>",
    "the repository the pull request targets",
  )
  .requiredOption("--pr <number>", "the number of the pull request")
  .option(
    "--api-url <url>",
    "the API root of the host (default: https://api.github.com); https, or http for a loopback host",
  )
  .option(
    "--merged",
    "check after the merge: the pull request must be merged, the checkout at the commit --default-ref names, " +
      "and the head commit of the pull request fetched. Nothing is measured from --base then either",
  )
  .helpOption(false)
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride((err: CommanderError) => {
    throw err;
  })
  .action(
    async (
      specDir: string,
      options: {
        repo: string;
        defaultRef: string;
        base?: string;
        githubRepo: string;
        pr: string;
        apiUrl?: string;
        merged?: boolean;
      },
      command: Command,
    ) => {
      const run = await runApproveCheck(
        {
          specDir,
          repo: options.repo,
          defaultRef: options.defaultRef,
          ...(options.base !== undefined ? { base: options.base } : {}),
          githubRepo: options.githubRepo,
          pr: options.pr,
          ...(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {}),
          ...(options.merged === true ? { merged: true } : {}),
          unknownArguments: command.args.length - 1,
        },
        process.env,
      );
      if (run.stdout !== "") process.stdout.write(run.stdout);
      if (run.stderr !== "") process.stderr.write(run.stderr);
      process.exitCode = run.exitCode;
    },
  );

try {
  await program.parseAsync();
} catch (err) {
  // Only `intake file`, `lint`, `lint-ack`, `propose`, `bind`, `repo-check`,
  // `export`, `questions`, `answer`, `status` and `approve-check` have
  // exitOverride, so every CommanderError comes from one of them: help and
  // version keep their exit code 0, a usage error exits 2; anything else is
  // an unexpected exception and also exits 2.
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

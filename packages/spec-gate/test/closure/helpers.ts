/**
 * Helpers for the closing-check tests: a repository whose default branch
 * holds a command set and a merged proposed spec with one row of every
 * kind, a work branch on top of the start commit, and evidence files
 * written into the spec directory on disk.
 */
import fs from "node:fs";
import path from "node:path";
import {
  runClosure,
  type ClosureReport,
  type ClosureResult,
} from "../../src/closure/index.js";
import { expectedCommandsDigest } from "../../src/formats/index.js";
import { REMOTE_MAIN, Repo, SPEC_REL } from "../lint/git-helpers.js";
import { validFiles } from "../lint/helpers.js";

export const UNIT_ARGV = ["npx", "vitest", "run", "-t", "{selector}"];
export const TYPECHECK_ARGV = ["npm", "run", "typecheck"];
export const UNIT_DIGEST = expectedCommandsDigest(UNIT_ARGV);
export const TYPECHECK_DIGEST = expectedCommandsDigest(TYPECHECK_ARGV);

export const COMMANDS =
  'discovery:\n  argv: ["npx", "vitest", "list"]\n' +
  "commands:\n" +
  '  typecheck:\n    argv: ["npm", "run", "typecheck"]\n' +
  '  unit:\n    argv: ["npx", "vitest", "run", "-t", "{selector}"]\n';

/** One row of every kind: TP-1 red-first, TP-2 stays-green, TP-3 static, TP-4 measurement, TP-5 manual, TP-6 runtime, TP-7 post-deploy. */
export const PLAN =
  "- id: TP-1\n  covers: [AC-1]\n  kind: red-first\n" +
  '  claim: "an old token is rejected after a password change"\n' +
  '  expected: "HTTP 401"\n  oracle: "AC-1"\n' +
  '  red_reason: "the endpoint does not invalidate tokens today"\n' +
  "- id: TP-2\n  covers: [AC-1]\n  kind: stays-green\n" +
  '  claim: "login keeps working"\n  probe_hint: "break the login handler"\n' +
  "- id: TP-3\n  covers: [AC-1]\n  kind: static\n" +
  '  claim: "the type check passes"\n  check_command_ref: typecheck\n' +
  "- id: TP-4\n  covers: [AC-1]\n  kind: measurement\n" +
  '  claim: "login latency stays within range"\n  baseline: 120\n  threshold: "p95 <= 150ms"\n  runs: 5\n' +
  "- id: TP-5\n  covers: [AC-1]\n  kind: manual\n" +
  '  claim: "the reset mail reads well"\n  verifier: "support lead"\n  evidence_location: "review/reset-mail.png"\n' +
  "- id: TP-6\n  covers: [AC-1]\n  kind: runtime\n" +
  '  claim: "a user can log in again"\n  environment: "staging"\n  steps:\n    - "log in"\n    - "reload"\n' +
  '  expected: "asked to log in"\n  evidence_location: "review/runtime.md"\n' +
  "- id: TP-7\n  covers: [AC-1]\n  kind: post-deploy\n" +
  '  claim: "no 5xx after deploy"\n  check: "error rate for 30 minutes"\n  environment: "production"\n';

export const BINDINGS =
  "TP-1:\n  status: new\n  selector: token rejected\n" +
  "TP-2:\n  status: existing\n  selector: login works\n";

export const SELECTORS: Record<string, string | null> = {
  "TP-1": "token rejected",
  "TP-2": "login works",
};

/** The spec files with `commands_ref` and `base_commit` set and the given status. */
export function closureSpecFiles(options: {
  ref: string;
  status?: string;
  plan?: string;
  bindings?: string;
  spec?: string;
}): Record<string, string> {
  let spec = options.spec ?? validFiles()["spec.md"]!;
  spec = spec.replace(/^base_commit: .*$/m, `base_commit: ${options.ref}`);
  spec = spec.replace(/^commands_ref: .*$/m, `commands_ref: ${options.ref}`);
  spec = spec.replace(
    /^status: .*$/m,
    `status: ${options.status ?? "proposed"}`,
  );
  return {
    [`${SPEC_REL}/spec.md`]: spec,
    [`${SPEC_REL}/testplan.yaml`]: options.plan ?? PLAN,
    [`${SPEC_REL}/bindings.yaml`]: options.bindings ?? BINDINGS,
  };
}

export interface Scenario {
  repo: Repo;
  /** The first commit: a README only, no command set. */
  c0: string;
  /** The commit that adds `.spec-gate/commands.yaml`; `commands_ref` of the spec. */
  c1: string;
  /** The merged spec commit and the start commit. */
  spec: string;
  /** Two commits of the work branch on top of the start commit. */
  a: string;
  b: string;
}

/**
 * `c0` (README) - `c1` (command set) - `spec` (the proposed spec) on
 * `main`, `refs/remotes/origin/main` at `spec`, and a checked-out branch
 * `work` with commits `a` and `b` on top of it; `HEAD` is `b`.
 */
export async function scenario(
  options: {
    status?: string;
    plan?: string;
    bindings?: string;
    spec?: string;
    /**
     * Picks the spec's `commands_ref` after `c0` and `c1` exist (default
     * `c1`); it may commit more, and `main` is checked out afterwards.
     */
    // The base no-unused-vars rule reads the names in a signature as variables.
    // eslint-disable-next-line no-unused-vars
    commandsRef?: (at: {
      repo: Repo;
      c0: string;
      c1: string;
    }) => Promise<string>;
  } = {},
): Promise<Scenario> {
  const repo = await Repo.create();
  const c0 = await repo.commit({ "README.md": "one\n" }, "init");
  const c1 = await repo.commit(
    { ".spec-gate/commands.yaml": COMMANDS },
    "commands",
  );
  const ref =
    options.commandsRef === undefined
      ? c1
      : await options.commandsRef({ repo, c0, c1 });
  await repo.checkout("main");
  const spec = await repo.commit(
    closureSpecFiles({
      ref,
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.plan !== undefined ? { plan: options.plan } : {}),
      ...(options.bindings !== undefined ? { bindings: options.bindings } : {}),
      ...(options.spec !== undefined ? { spec: options.spec } : {}),
    }),
    "spec",
  );
  await repo.setRef(REMOTE_MAIN, spec);
  await repo.checkout("work", spec);
  const a = await repo.commit({ "src/a.ts": "a\n" }, "work a");
  const b = await repo.commit({ "src/b.ts": "b\n" }, "work b");
  return { repo, c0, c1, spec, a, b };
}

export interface EnvelopeFields {
  phase?: "baseline" | "closure";
  producer?: "ci" | "host" | "local";
  ci_run?: string;
  time?: string;
  commit: string;
  dirty?: boolean;
  commands_digest?: string;
  selector?: string | null;
  command?: string[];
  exit?: number | null;
  result?: "pass" | "fail" | "skip" | "error";
}

let clock = 0;

/** One envelope of row `tp` as a JSON line; every field not given is the clean default for the row. */
export function envelope(tp: string, fields: EnvelopeFields): string {
  clock += 1;
  const isStatic = tp === "TP-3";
  const result = fields.result ?? "pass";
  const producer = fields.producer ?? "host";
  const out: Record<string, unknown> = {
    schema_version: 1,
    phase: fields.phase ?? "closure",
    producer,
  };
  if (producer === "ci") out["ci_run"] = fields.ci_run ?? "run-1";
  Object.assign(out, {
    time:
      fields.time ?? new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString(),
    commit: fields.commit,
    dirty: fields.dirty ?? false,
    commands_digest:
      fields.commands_digest ?? (isStatic ? TYPECHECK_DIGEST : UNIT_DIGEST),
    selector:
      fields.selector === undefined ? (SELECTORS[tp] ?? null) : fields.selector,
    command: fields.command ?? (isStatic ? TYPECHECK_ARGV : ["npx", "vitest"]),
    exit:
      fields.exit === undefined
        ? result === "pass"
          ? 0
          : result === "skip"
            ? null
            : 1
        : fields.exit,
    result,
  });
  return JSON.stringify(out);
}

/** Writes `evidence/<tp>.jsonl` of the spec directory on disk. */
export function writeEvidence(
  repo: Repo,
  tp: string,
  envelopes: EnvelopeFields[],
): void {
  const dir = path.join(repo.spec, "evidence");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${tp}.jsonl`),
    envelopes.map((e) => `${envelope(tp, e)}\n`).join(""),
  );
}

/** Runs the check in the scenario; `start` defaults to the spec commit. */
export function closureIn(
  s: Scenario,
  options: { start?: string; head?: string; defaultRef?: string } = {},
): ClosureResult {
  return runClosure(s.repo.spec, {
    repo: s.repo.dir,
    defaultRef: options.defaultRef ?? REMOTE_MAIN,
    start: options.start ?? s.spec,
    ...(options.head !== undefined ? { head: options.head } : {}),
  });
}

/** The report of a run that must not be refused. */
export function reportIn(
  s: Scenario,
  options: { start?: string; head?: string } = {},
): ClosureReport {
  const result = closureIn(s, options);
  if (!result.ok) {
    throw new Error(`refused: ${result.code}: ${result.message}`);
  }
  return result.report;
}

export function rowOf(report: ClosureReport, id: string) {
  const row = report.rows.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
}

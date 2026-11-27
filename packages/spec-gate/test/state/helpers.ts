/**
 * Helpers for the propose, bind and bindings-log suites: a repository with
 * a committed draft spec that the final lint passes, and the steps that move
 * it on (propose, bind, commit), each with the same git inputs a pull
 * request job would give.
 */
import fs from "node:fs";
import path from "node:path";
import type { GitRequest, LintReport } from "../../src/lint/index.js";
import { lintSpecDir } from "../../src/lint/index.js";
import type { Clock } from "../../src/state/index.js";
import {
  bindSpecDir,
  proposeSpecDir,
  type BindRequest,
} from "../../src/state/index.js";
import {
  REMOTE_MAIN,
  Repo,
  SPEC_REL,
  plainHistory,
  specFiles,
} from "../lint/git-helpers.js";
import { scratch, validFiles } from "../lint/helpers.js";

/**
 * The valid test plan (TP-1, red-first) plus a stays-green row (TP-2) and a
 * manual row (TP-3), so bind meets each binding rule of a kind.
 */
export const BIND_PLAN =
  `${validFiles()["testplan.yaml"]!}\n` +
  '- id: TP-2\n  covers: [AC-1]\n  kind: stays-green\n  claim: "login keeps working"\n  probe_hint: "break the login handler"\n' +
  '- id: TP-3\n  covers: [AC-1]\n  kind: manual\n  claim: "the message reads well"\n  verifier: alice\n  evidence_location: "the pull request"\n';

export const BIND_BINDINGS =
  "TP-1:\n  status: new\n  selector: rejects old token\n  file: test/auth.test.ts\nTP-2:\n  status: existing\n  selector: login works\n";

export interface Proposable {
  repo: Repo;
  /** The commit the spec was committed in: HEAD before propose. */
  draft: string;
}

/** A repository whose HEAD holds a draft spec that passes the final lint. */
export async function draftRepo(
  files: Record<string, string> = {},
): Promise<Proposable> {
  const { repo, c1 } = await plainHistory();
  const spec = specFiles({ base: c1, ref: c1, plan: BIND_PLAN });
  spec[`${SPEC_REL}/bindings.yaml`] = BIND_BINDINGS;
  for (const [name, text] of Object.entries(files)) {
    spec[`${SPEC_REL}/${name}`] = text;
  }
  const draft = await repo.commit(spec, "spec");
  return { repo, draft };
}

export function gitOf(repo: Repo): GitRequest {
  return { repo: repo.dir, defaultRef: REMOTE_MAIN };
}

export function readSpec(repo: Repo, name: string): string {
  return fs.readFileSync(path.join(repo.spec, name), "utf8");
}

export function writeSpec(repo: Repo, name: string, text: string): void {
  fs.writeFileSync(path.join(repo.spec, name), text);
}

export function specExists(repo: Repo, name: string): boolean {
  return fs.existsSync(path.join(repo.spec, name));
}

/** Commits the work tree of the spec directory as it is. */
export async function commitSpec(repo: Repo, message: string): Promise<string> {
  await repo.sh("add", "-A");
  return repo.commit({}, message);
}

/** Proposes the draft at HEAD and commits the result; throws on anything but a write. */
export async function proposedRepo(
  files: Record<string, string> = {},
): Promise<Proposable & { proposed: string }> {
  const base = await draftRepo(files);
  const result = proposeSpecDir(base.repo.spec, gitOf(base.repo));
  if (result.kind !== "written") {
    throw new Error(`propose did not write: ${JSON.stringify(result)}`);
  }
  const proposed = await commitSpec(base.repo, "propose");
  return { ...base, proposed };
}

/** Binds and throws on a refusal. */
export function bindOk(repo: Repo, tp: string, request: BindRequest): void {
  const result = bindSpecDir(repo.spec, tp, request);
  if (!result.ok) throw new Error(result.message);
}

/** The lint report at HEAD with the job's git inputs. */
export function lintGit(
  repo: Repo,
  options: { final?: boolean } = {},
): LintReport {
  const result = lintSpecDir(repo.spec, { ...options, git: gitOf(repo) });
  if (!result.ok) throw new Error(`usage error: ${result.message}`);
  return result.report;
}

export const ofLogRule = (report: LintReport) =>
  report.errors.filter((f) => f.rule === "bindings-log");

export const codesOf = (report: LintReport) =>
  ofLogRule(report).map((f) => f.code);

/** A spec directory at `specs/s1` under a scratch root, the valid fixture with `overrides`. */
export function draftSpecDir(
  overrides: Record<string, string | null> = {},
): string {
  const dir = path.join(scratch(), "specs", "s1");
  const files = { ...validFiles(), ...overrides };
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue;
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}

/** A clock that always returns the instant `iso` names. */
export const clockAt =
  (iso: string): Clock =>
  () =>
    new Date(iso);

/** A `questions.json` text from question and answer objects. */
export const questionsFile = (
  questions: unknown[],
  answers: unknown[],
): string => JSON.stringify({ questions, answers });

/** A question object with the usual fields, `over` applied. */
export const question = (
  id: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  target: "AC-1",
  class: "blind-spot",
  blocking: false,
  question: `Open point ${id} about the token store?`,
  options: [],
  ...over,
});

/** An answer object with the usual fields, `over` applied. */
export const answerObj = (
  q: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  question: q,
  answer: "revoke",
  channel: "comment",
  author: "alice",
  time: "2000-01-31T12:00:00Z",
  ...over,
});

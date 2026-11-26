/**
 * Helpers for the approval suites: a repository whose head holds a proposed
 * spec that the final lint passes, with settings on the default branch, and
 * a host adapter made of plain values.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import {
  checkApproval,
  type ApproveReport,
  type ApproveRequest,
  type ConditionNumber,
  type ConditionResult,
} from "../../src/approve/index.js";
import type {
  HostAdapter,
  HostReview,
  ReviewState,
} from "../../src/host/index.js";
import { proposeSpecDir } from "../../src/state/index.js";
import {
  COMMANDS_OK,
  REMOTE_MAIN,
  Repo,
  SPEC_REL,
  specFiles,
} from "../lint/git-helpers.js";
import { BIND_BINDINGS, BIND_PLAN, commitSpec } from "../state/helpers.js";

/** Approvers and one agent identity, spelled in another case than the logins the tests use. */
export const CONFIG =
  "approvers: [Alice, bob, dev]\nagent_identities: [Spec-Bot]\n";

/** A repository state the check runs on. */
export interface Scenario {
  /** The repository root. */
  dir: string;
  /** The spec directory. */
  spec: string;
  /** The tip of the default branch, where the settings are. */
  c1: string;
  /** The commit that holds the draft spec. */
  draft: string;
  /** `HEAD`. */
  head: string;
}

export interface Built extends Scenario {
  repo: Repo;
}

/**
 * A default branch with the command set and (unless `config` is `null`)
 * `.spec-gate/config.yaml`, `refs/remotes/origin/main` at its tip, and a
 * branch `pr` with a draft spec that is proposed and committed unless
 * `propose` is false.
 */
export async function build(
  options: { config?: string | null; propose?: boolean } = {},
): Promise<Built> {
  const repo = await Repo.create();
  await repo.commit({ "README.md": "one\n" }, "init");
  const settings: Record<string, string> = {
    ".spec-gate/commands.yaml": COMMANDS_OK,
  };
  if (options.config !== null) {
    settings[".spec-gate/config.yaml"] = options.config ?? CONFIG;
  }
  const c1 = await repo.commit(settings, "settings");
  await repo.setRef(REMOTE_MAIN, c1);
  await repo.checkout("pr", c1);
  const spec = specFiles({ base: c1, ref: c1, plan: BIND_PLAN });
  spec[`${SPEC_REL}/bindings.yaml`] = BIND_BINDINGS;
  const draft = await repo.commit(spec, "spec");
  let head = draft;
  if (options.propose !== false) head = await propose(repo);
  return { repo, dir: repo.dir, spec: repo.spec, c1, draft, head };
}

/** Proposes the draft at `HEAD` and commits the result. */
export async function propose(repo: Repo): Promise<string> {
  const result = proposeSpecDir(repo.spec, {
    repo: repo.dir,
    defaultRef: REMOTE_MAIN,
  });
  if (result.kind !== "written") {
    throw new Error(`propose did not write: ${JSON.stringify(result)}`);
  }
  return commitSpec(repo, "propose");
}

const kept: string[] = [];

afterAll(() => {
  for (const dir of kept.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A copy of a built repository that outlives the test that built it (the
 * scratch directories of the lint helpers go after every test), for the
 * cases that only change what the host says. Removed after the file.
 */
export function keep(built: Scenario): Scenario {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-approve-"));
  kept.push(root);
  const dir = path.join(root, "repo");
  fs.cpSync(built.dir, dir, { recursive: true });
  return {
    dir,
    spec: path.join(dir, SPEC_REL),
    c1: built.c1,
    draft: built.draft,
    head: built.head,
  };
}

/** A review submitted at minute `minute` of one fixed hour. */
export function review(
  login: string,
  state: ReviewState,
  commit: string,
  minute = 0,
): HostReview {
  return {
    login,
    state,
    commit,
    submittedAt: `2024-05-01T10:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/**
 * What the fake host says. Each entry is the value its method resolves to,
 * or a function that is called instead (to throw, or to return anything).
 */
export interface HostSays {
  pullRequest?: unknown;
  reviews?: unknown;
  /** One value for both paths, or one per path. */
  enforcement?: unknown;
  configCommit?: unknown;
}

export type FakeHost = HostAdapter & { calls: string[] };

const give = (value: unknown): unknown =>
  typeof value === "function" ? (value as () => unknown)() : value;

/**
 * A host for `s` on which everything holds unless `says` changes it: a pull
 * request by `dev` from the head to the default branch, one approval by
 * `alice` on the head, both paths enforced.
 */
export function hostFor(s: Scenario, says: HostSays = {}): FakeHost {
  const calls: string[] = [];
  const has = (key: keyof HostSays) => Object.hasOwn(says, key);
  const facts = {
    pullRequest: has("pullRequest") ? says.pullRequest : pullRequestOf(s),
    reviews: has("reviews")
      ? says.reviews
      : [review("alice", "APPROVED", s.head)],
    enforcement: has("enforcement") ? says.enforcement : "enforced",
    configCommit: has("configCommit")
      ? says.configCommit
      : { commit: s.c1, approver: "bob" },
  };
  return {
    calls,
    pullRequest: async () => {
      calls.push("pullRequest");
      return give(facts.pullRequest) as never;
    },
    reviews: async () => {
      calls.push("reviews");
      return give(facts.reviews) as never;
    },
    reviewEnforcement: async (reviewPath) => {
      calls.push(`reviewEnforcement ${reviewPath}`);
      const all = give(facts.enforcement);
      return (
        typeof all === "object" && all !== null
          ? give((all as Record<string, unknown>)[reviewPath])
          : all
      ) as never;
    },
    lastConfigCommit: async () => {
      calls.push("lastConfigCommit");
      return give(facts.configCommit) as never;
    },
    ciRunStatus: async () => {
      calls.push("ciRunStatus");
      throw new Error("the approval check does not ask for a CI run");
    },
  };
}

/** The pull request of `s` as the host reports it when all is well. */
export function pullRequestOf(
  s: Scenario,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: 7,
    author: "dev",
    head: s.head,
    base: s.c1,
    targetRef: "refs/heads/main",
    ...over,
  };
}

export function requestFor(
  s: Scenario,
  host: HostAdapter,
  over: Partial<ApproveRequest> = {},
): ApproveRequest {
  return {
    repo: s.dir,
    specDir: s.spec,
    defaultRef: REMOTE_MAIN,
    host,
    ...over,
  };
}

/** Runs the check and returns its report; a refusal throws. */
export async function check(
  s: Scenario,
  says: HostSays = {},
  over: Partial<ApproveRequest> = {},
): Promise<ApproveReport> {
  const result = await checkApproval(requestFor(s, hostFor(s, says), over));
  if (result.kind !== "report") {
    throw new Error(`the check refused: ${result.message}`);
  }
  return result.report;
}

/** A change a test makes to the spec directory `spec` of a work tree. */
// The base no-unused-vars rule reads the names in a signature as variables.
// eslint-disable-next-line no-unused-vars
export type SpecChange = (spec: string) => void;

/** A way a test merges the pull request of `s`, whose head is `head`. */
// eslint-disable-next-line no-unused-vars
export type Merge = (s: Built, head: string) => Promise<void>;

export const cond = (
  report: ApproveReport,
  condition: ConditionNumber,
): ConditionResult => report.conditions[condition - 1]!;

/** The code of every condition, in order. */
export const codes = (report: ApproveReport): string[] =>
  report.conditions.map((c) => c.code);

/** The numbers of the conditions that do not hold. */
export const failing = (report: ApproveReport): number[] =>
  report.conditions.filter((c) => !c.ok).map((c) => c.condition);

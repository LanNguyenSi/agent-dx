/**
 * `spec-gate closure`: the per-row closing report. Read-only, and offline
 * unless `--github-repo` asks for the host: `spec.md` and `testplan.yaml`
 * are read at the merged spec commit, the
 * history and `.spec-gate/commands.yaml` at `commands_ref` from git, all
 * through the hardened runner; only `bindings.yaml` and `evidence/` are
 * read from the spec directory on disk. Nothing is written and nothing is
 * fetched. With `--github-repo` the one network call the run makes is the
 * CI-run check of every distinct `(commit, ci_run)` a counted
 * `producer: ci` envelope names, through the GitHub host adapter; it marks
 * rows, it decides nothing: no host answer changes a row's state, and a
 * host that fails or cannot be reached marks `host-failed` and never turns
 * into a pass or a refusal.
 *
 * An envelope counts only when it can be attributed to the work: phase
 * `closure`, a commit on `start..head` (the start commit or a descendant
 * of it, and an ancestor of or equal to the head), a clean work tree, the
 * `commands_digest` of the row's one command at `commands_ref` and the
 * selector of the row's binding. The squash survival rule is not applied:
 * an envelope whose commit is not an ancestor of the head never counts.
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildHost,
  holdsToken,
  readToken,
  TOKEN_VARIABLE,
} from "../cli-host.js";
import {
  expectedCommandsDigest,
  parseSpec,
  parseTestPlan,
  type Bindings,
  type EvidenceEnvelope,
  type TestPlanRow,
} from "../formats/index.js";
import { COMMIT_RE } from "../formats/validate.js";
import {
  CI_RUN_STATES,
  createGitHubHost,
  type GitHubHostOptions,
  type HostAdapter,
} from "../host/index.js";
import {
  rowTemplate,
  templatesAtCommandsRef,
} from "../lint/commands-at-ref.js";
import {
  LintGitError,
  isAncestor,
  isCommit,
  readBlobAtCommit,
} from "../lint/git/index.js";
import { resolveGitInputs } from "../lint/git/resolve.js";
import { specDirState } from "../lint/files.js";
import {
  BINDINGS_FILE,
  SPEC_FILE,
  TESTPLAN_FILE,
  loadInputs,
  type FindingSink,
} from "../lint/load.js";
import type { EvidenceFiles, RuleFinding } from "../lint/types.js";
import { isRepoPath, lastFirstParentChange } from "./git.js";
import { judgeRow, kindNeedsEnvelopes, type CountedEnvelope } from "./rules.js";
import {
  CLOSURE_FORMAT,
  CI_STATUSES,
  ROW_STATES,
  type CiStatus,
  type ClosureReport,
  type ClosureRequest,
  type ClosureResult,
  type ClosureRow,
  type IgnoreReason,
  type IgnoredEnvelope,
  type RowState,
} from "./types.js";

class Refusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function refuse(code: string, message: string): never {
  throw new Refusal(code, message);
}

/**
 * Answers "is `a` an ancestor of or equal to `b`" and "is `id` a commit of
 * the repository" once per question.
 */
class History {
  private readonly repo: string;
  private readonly ancestors = new Map<string, boolean>();
  private readonly commits = new Map<string, boolean>();

  constructor(repo: string) {
    this.repo = repo;
  }

  is(a: string, b: string): boolean {
    if (a === b) return true;
    const key = `${a} ${b}`;
    let answer = this.ancestors.get(key);
    if (answer === undefined) {
      answer = isAncestor(this.repo, a, b);
      this.ancestors.set(key, answer);
    }
    return answer;
  }

  known(id: string): boolean {
    let answer = this.commits.get(id);
    if (answer === undefined) {
      answer = isCommit(this.repo, id);
      this.commits.set(id, answer);
    }
    return answer;
  }
}

interface RowCommands {
  /** The argv template of the row's one command, or `undefined` when it has none. */
  template: readonly string[] | undefined;
  selector: string | null;
}

/** The first condition an envelope fails, or `null` when it counts. */
function ignoreReason(
  env: EvidenceEnvelope,
  row: RowCommands,
  start: string,
  head: string,
  ancestry: History,
): IgnoreReason | null {
  if (env.phase !== "closure") return "phase-baseline";
  if (!ancestry.known(env.commit)) return "not-on-head";
  if (!ancestry.is(start, env.commit)) {
    return ancestry.is(env.commit, head) ? "before-start" : "not-on-head";
  }
  if (!ancestry.is(env.commit, head)) return "not-on-head";
  if (env.dirty) return "dirty";
  if (row.template === undefined) return "command-unknown";
  if (env.commands_digest !== expectedCommandsDigest(row.template)) {
    return "digest-mismatch";
  }
  if (env.selector !== row.selector) return "selector-mismatch";
  return null;
}

/**
 * The counted envelopes in order, earliest first: by commit ancestry, and
 * at one commit by `time` (then by line). `null` when two of them lie at
 * commits neither of which is an ancestor of the other, or when an
 * envelope that shares its commit with another has a `time` that does not
 * parse.
 */
function ordered(
  counted: readonly { env: EvidenceEnvelope; line: number }[],
  ancestry: History,
): { env: EvidenceEnvelope; line: number }[] | null {
  const commits = [...new Set(counted.map((item) => item.env.commit))];
  for (let i = 0; i < commits.length; i += 1) {
    for (let j = i + 1; j < commits.length; j += 1) {
      const a = commits[i]!;
      const b = commits[j]!;
      if (!ancestry.is(a, b) && !ancestry.is(b, a)) return null;
    }
  }
  // At one commit only `time` orders; a time that does not parse orders
  // nothing there.
  const perCommit = new Map<string, number>();
  for (const { env } of counted) {
    perCommit.set(env.commit, (perCommit.get(env.commit) ?? 0) + 1);
  }
  if (
    counted.some(
      ({ env }) =>
        (perCommit.get(env.commit) ?? 0) > 1 &&
        Number.isNaN(Date.parse(env.time)),
    )
  ) {
    return null;
  }
  return [...counted].sort((x, y) => {
    if (x.env.commit !== y.env.commit) {
      return ancestry.is(x.env.commit, y.env.commit) ? -1 : 1;
    }
    const dt = Date.parse(x.env.time) - Date.parse(y.env.time);
    return dt !== 0 ? dt : x.line - y.line;
  });
}

function tpNumber(id: string): number {
  return Number(id.slice("TP-".length));
}

function loadFailure(findings: readonly RuleFinding[], file: string): string {
  const own = findings.find(
    (f) => f.file === file || f.file.startsWith(`${file}/`),
  );
  return own?.code ?? "input-invalid";
}

/** One counted `producer: ci` envelope, waiting for its run to be checked. */
interface CiTarget {
  /** Index of the row in the report's `rows`. */
  row: number;
  commit: string;
  run: string;
}

/** The report, and the counted `producer: ci` envelopes the host must be asked about. */
interface Judged {
  report: ClosureReport;
  ci: CiTarget[];
}

function judge(specDir: string, request: ClosureRequest): Judged {
  // Flag shapes first: nothing is read for a value that is not a full id.
  if (!COMMIT_RE.test(request.start)) {
    refuse("start-invalid", "--start is not a full commit id");
  }
  if (request.head !== undefined && !COMMIT_RE.test(request.head)) {
    refuse("head-invalid", "--head is not a full commit id");
  }

  // The spec directory, read from disk as lint reads it.
  const dirState = specDirState(specDir);
  if (dirState === "symlink") {
    refuse("spec-dir-invalid", `${specDir} is a symlink, refusing to read it`);
  }
  if (dirState !== "directory") {
    refuse("spec-dir-invalid", `${specDir} is not a directory`);
  }
  const findings: RuleFinding[] = [];
  const sink: FindingSink = {
    add: (_rule, finding) => {
      findings.push(finding);
    },
  };
  // Only bindings.yaml and evidence/ are read from disk; spec.md and
  // testplan.yaml are read at the merged spec commit below.
  const inputs = loadInputs(specDir, sink);
  if (inputs.bindings.state === "failed") {
    refuse(
      loadFailure(findings, BINDINGS_FILE),
      `${BINDINGS_FILE} does not load`,
    );
  }
  if (inputs.evidence?.state === "failed") {
    refuse(
      loadFailure(findings, "evidence"),
      "evidence/ does not load: no row could be judged from half-read evidence (run lint for the findings)",
    );
  }
  // A missing bindings.yaml binds nothing: a row that needs a selector then
  // has no command and counts no envelope.
  const bindings: Bindings =
    inputs.bindings.state === "ok" ? inputs.bindings.value : {};
  const loadedEvidence = inputs.evidence;
  const evidence: EvidenceFiles =
    loadedEvidence?.state === "ok" ? loadedEvidence.value : {};

  // The repository and the default branch, resolved as lint resolves them.
  const resolved = resolveGitInputs(specDir, {
    repo: request.repo,
    defaultRef: request.defaultRef,
  });
  if (!resolved.ok) refuse("git-input-invalid", resolved.message);
  const repo = resolved.git!.repo;
  const defaultCommit = resolved.git!.reference;
  const start = request.start;
  if (!isCommit(repo, start)) {
    refuse("start-not-a-commit", "--start is not a commit in the repository");
  }
  const head = request.head ?? resolved.git!.head;
  if (!isCommit(repo, head)) {
    refuse("head-not-a-commit", "--head is not a commit in the repository");
  }

  // The merged spec commit.
  const specRel = path
    .relative(fs.realpathSync.native(repo), fs.realpathSync.native(specDir))
    .split(path.sep)
    .join("/");
  if (specRel === "" || !isRepoPath(specRel)) {
    refuse(
      "spec-dir-invalid",
      "the spec directory is not a path this command can read from a commit",
    );
  }
  const specCommit = lastFirstParentChange(repo, defaultCommit, [
    `${specRel}/${SPEC_FILE}`,
    `${specRel}/${TESTPLAN_FILE}`,
  ]);
  if (specCommit === null) {
    refuse(
      "spec-not-merged",
      `no commit on --default-ref changed ${specRel}/${SPEC_FILE} or ${specRel}/${TESTPLAN_FILE}`,
    );
  }
  // spec.md and testplan.yaml as the merged spec commit holds them: the
  // copies that are judged, whatever the work tree holds.
  const atSpecCommit = (file: string): string | undefined => {
    try {
      return readBlobAtCommit(repo, specCommit, `${specRel}/${file}`);
    } catch (err) {
      if (!(err instanceof LintGitError)) throw err;
      if (
        err.code === "git-failed" ||
        err.code === "output-too-large" ||
        err.code === "object-unreadable"
      ) {
        throw err;
      }
      return undefined;
    }
  };
  const specText = atSpecCommit(SPEC_FILE);
  const parsedSpec = specText === undefined ? undefined : parseSpec(specText);
  if (parsedSpec === undefined || !parsedSpec.ok) {
    refuse(
      "spec-invalid",
      `${specRel}/${SPEC_FILE} at the merged spec commit ${specCommit} is missing, not a regular UTF-8 file or not a valid spec`,
    );
  }
  const spec = parsedSpec.value;
  if (spec.frontmatter.status !== "proposed") {
    refuse(
      "spec-not-proposed",
      `${specRel}/${SPEC_FILE} at the merged spec commit ${specCommit} has status ${spec.frontmatter.status}; closure needs status proposed`,
    );
  }
  const planText = atSpecCommit(TESTPLAN_FILE);
  const parsedPlan =
    planText === undefined ? undefined : parseTestPlan(planText);
  if (parsedPlan === undefined || !parsedPlan.ok) {
    refuse(
      "testplan-invalid",
      `${specRel}/${TESTPLAN_FILE} at the merged spec commit ${specCommit} is missing, not a regular UTF-8 file or not a valid test plan`,
    );
  }
  const plan = parsedPlan.value;

  // The start and head commits.
  const ancestry = new History(repo);
  if (!ancestry.is(specCommit, start)) {
    refuse(
      "start-before-spec",
      `--start is not the merged spec commit ${specCommit} or a descendant of it`,
    );
  }
  if (!ancestry.is(start, defaultCommit)) {
    refuse("start-not-on-default", "--start is not on --default-ref");
  }
  if (!ancestry.is(start, head)) {
    refuse("head-before-start", "--head is not --start or a descendant of it");
  }

  // The command set at commands_ref, trusted only on the default branch.
  const templates = templatesAtCommandsRef(
    repo,
    spec.frontmatter.commands_ref,
    defaultCommit,
  );
  if (!templates.ok) refuse(templates.code, templates.message);

  const rows: ClosureRow[] = [];
  const ci: CiTarget[] = [];
  plan.forEach((row: TestPlanRow, rowIndex) => {
    const binding = bindings[row.id];
    const commands: RowCommands = {
      template:
        row.kind !== "static" && binding?.selector === undefined
          ? undefined
          : rowTemplate(row, binding, templates.selectorArgv, templates.byName),
      selector: row.kind === "static" ? null : (binding?.selector ?? null),
    };
    const envelopes = evidence[row.id];
    const ignored: IgnoredEnvelope[] = [];
    const counted: { env: EvidenceEnvelope; line: number }[] = [];
    (envelopes ?? []).forEach((env, index) => {
      const reason = ignoreReason(env, commands, start, head, ancestry);
      if (reason === null) counted.push({ env, line: index + 1 });
      else ignored.push({ line: index + 1, reason });
    });

    let verdict: { state: RowState; reason: string };
    const order = kindNeedsEnvelopes(row.kind)
      ? ordered(counted, ancestry)
      : counted;
    if (order === null) {
      verdict = { state: "unproven", reason: "unordered-evidence" };
    } else {
      const list: CountedEnvelope[] = order.map(({ env }) => ({
        commit: env.commit,
        result: env.result,
        exit: env.exit,
      }));
      verdict = judgeRow(row.kind, list, start, envelopes !== undefined);
    }
    const out: ClosureRow = {
      id: row.id,
      kind: row.kind,
      state: verdict.state,
      reason: verdict.reason,
      self_reported: counted.some(({ env }) => env.producer === "local"),
      ci_unverified: counted.some(({ env }) => env.producer === "ci"),
      counted: counted.length,
      ignored,
    };
    if (row.kind === "stays-green") out.probe = "not-checked";
    if (row.kind === "red-first") out.red_reason = "not-checked";
    if (
      row.kind === "measurement" ||
      row.kind === "manual" ||
      row.kind === "runtime"
    ) {
      out.evidence_location = row.evidence_location ?? null;
    }
    for (const { env } of counted) {
      if (env.producer === "ci" && env.ci_run !== undefined) {
        ci.push({ row: rowIndex, commit: env.commit, run: env.ci_run });
      }
    }
    rows.push(out);
  });

  const counts = Object.fromEntries(ROW_STATES.map((s) => [s, 0])) as Record<
    RowState,
    number
  >;
  for (const row of rows) counts[row.state] += 1;
  const planIds = new Set(plan.map((row) => row.id));
  const unknown = Object.keys(evidence)
    .filter((id) => !planIds.has(id))
    .sort((a, b) => tpNumber(a) - tpNumber(b));
  const report: ClosureReport = {
    format: CLOSURE_FORMAT,
    spec: spec.frontmatter.id,
    start,
    head,
    spec_commit: specCommit,
    ...(request.githubRepo === undefined
      ? {}
      : {
          host: {
            repo: request.githubRepo,
            api_url: request.apiUrl ?? null,
          },
        }),
    ok: counts.failed === 0 && counts.unproven === 0,
    rows,
    counts,
    unknown_rows: unknown,
  };
  return { report, ci };
}

/**
 * Asks the host about one `(commit, run)` and marks what comes back: an
 * answer outside `CI_RUN_STATES` and a throw are `host-failed`, which is
 * the marking of a run nobody vouched for, never a pass and never a
 * refusal.
 */
async function askRun(
  host: HostAdapter,
  commit: string,
  run: string,
): Promise<CiStatus> {
  try {
    const answer = await host.ciRunStatus(commit, run);
    return CI_RUN_STATES.includes(answer) ? answer : "host-failed";
  } catch {
    return "host-failed";
  }
}

/**
 * Marks the rows that hold a counted `producer: ci` envelope: one host call
 * per distinct `(commit, ci_run)`, `ci_unverified` set when any of the
 * row's counted ci envelopes was not `verified`, and `ci_status` set to the
 * worst of them in the order of `CI_STATUSES`. Nothing here touches a row's
 * `state` or the report's `ok`: the host's answer marks, it does not gate.
 */
async function verifyCi(judged: Judged, host: HostAdapter): Promise<void> {
  const asked = new Map<string, Promise<CiStatus>>();
  for (const target of judged.ci) {
    const key = JSON.stringify([target.commit, target.run]);
    if (!asked.has(key)) {
      asked.set(key, askRun(host, target.commit, target.run));
    }
  }
  const byRow = new Map<number, CiStatus[]>();
  for (const target of judged.ci) {
    const status = await asked.get(
      JSON.stringify([target.commit, target.run]),
    )!;
    const list = byRow.get(target.row) ?? [];
    list.push(status);
    byRow.set(target.row, list);
  }
  for (const [rowIndex, statuses] of byRow) {
    const row = judged.report.rows[rowIndex]!;
    row.ci_unverified = statuses.some((status) => status !== "verified");
    row.ci_status = CI_STATUSES.find((status) => statuses.includes(status))!;
  }
}

/**
 * What `--github-repo` asked for, before anything is read: the token, then
 * the adapter. An unknown argument or option is refused here and never
 * repeated: a token given by mistake is not printed.
 */
function makeHost(
  request: ClosureRequest,
  token: string,
  // The base no-unused-vars rule reads the names in a signature as variables.
  // eslint-disable-next-line no-unused-vars
  createHost: (options: GitHubHostOptions) => HostAdapter,
): HostAdapter {
  const built = buildHost(
    createHost,
    {
      githubRepo: request.githubRepo!,
      ...(request.apiUrl !== undefined ? { apiUrl: request.apiUrl } : {}),
    },
    token,
  );
  if (!built.ok) refuse("host-input-invalid", built.message);
  return built.host;
}

/**
 * Runs the closing check. A refusal (a precondition that does not hold, a
 * git read that could not run) carries a code and a message that never
 * holds git's output; no report is made then. With `--github-repo` the
 * token is read from `GITHUB_TOKEN` only, the CI runs of the counted
 * `producer: ci` envelopes are checked with the host, and both outputs are
 * searched for the token before anything is returned: an output that holds
 * it is withheld as a whole.
 */
export async function runClosure(
  specDir: string,
  request: ClosureRequest,
  env: Readonly<Record<string, string | undefined>> = {},
  // The base no-unused-vars rule reads the names in a signature as variables.
  // eslint-disable-next-line no-unused-vars
  seams: { createHost: (options: GitHubHostOptions) => HostAdapter } = {
    createHost: createGitHubHost,
  },
): Promise<ClosureResult> {
  const token = request.githubRepo === undefined ? "" : readToken(env);
  let result: ClosureResult;
  try {
    if ((request.unknownArguments ?? 0) > 0) {
      // What was not understood is not repeated: an argument given by
      // mistake may be a secret.
      refuse(
        "unknown-argument",
        "takes one <spec-dir> and the options --repo, --default-ref, --start, --head, --github-repo and --api-url; an argument or option it does not know was given (it is not repeated here). The token is read from " +
          TOKEN_VARIABLE +
          " only",
      );
    }
    let host: HostAdapter | undefined;
    if (request.githubRepo !== undefined) {
      if (token === "") {
        refuse(
          "token-missing",
          "--github-repo needs a token in the environment variable " +
            TOKEN_VARIABLE +
            "; it is read from there only, never from an option",
        );
      }
      host = makeHost(request, token, seams.createHost);
    } else if (request.apiUrl !== undefined) {
      refuse(
        "host-input-invalid",
        "--api-url is only read with --github-repo; give --github-repo or leave it out",
      );
    }
    const judged = judge(specDir, request);
    if (host !== undefined) await verifyCi(judged, host);
    result = { ok: true, report: judged.report };
  } catch (err) {
    if (err instanceof Refusal) {
      result = { ok: false, code: err.code, message: err.message };
    } else if (err instanceof LintGitError) {
      result = {
        ok: false,
        code: err.code,
        message: "git could not be read",
      };
    } else {
      // The unexpected error text is printed as it is; when a host was in
      // play, the stack could have picked up the token: withhold it then.
      const text =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      if (holdsToken(text, token)) {
        return {
          ok: false,
          code: "token-in-output",
          message:
            "an output held the token and was withheld; nothing is reported",
        };
      }
      throw err;
    }
  }
  if (
    holdsToken(
      result.ok ? JSON.stringify(result.report) : result.message,
      token,
    )
  ) {
    return {
      ok: false,
      code: "token-in-output",
      message: "an output held the token and was withheld; nothing is reported",
    };
  }
  return result;
}

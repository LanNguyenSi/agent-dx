import { execFile } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { ApproveReport } from "../src/approve/index.js";
import {
  afterMerge,
  build,
  codes,
  cond,
  CONFIG_ONLY_BOB,
  editSpec,
  failing,
  keep,
  keepLanded,
  land,
  otherSpec,
  crissCross,
  relogged,
  squashEdited,
  squashWithOwnSettings,
  staleBase,
  STALE_OTHER,
  type Landed,
  type Scenario,
} from "./approve/helpers.js";
import { runBounded, type Run } from "./canonical/helpers.js";
import {
  P,
  PROTECTION_PATH,
  PULL,
  PULL_PATH,
  pullJson,
  pullRequestRule,
  REPOSITORY,
  reviewJson,
  REVIEWS_PATH,
  RULES_PATH,
  sha,
  Stub,
  TOKEN,
} from "./host/stub.js";
import { REMOTE_MAIN, SPEC_REL } from "./lint/git-helpers.js";
import { scratch, validFiles } from "./lint/helpers.js";

const execFileAsync = promisify(execFile);

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cli = cliPath): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cli,
      ...args,
    ]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe("spec-gate CLI", () => {
  it("--version prints the package.json version and exits 0", async () => {
    const run = await runCli(["--version"]);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(pkg.version);
  });

  it("--help exits 0 and names the program", async () => {
    const run = await runCli(["--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`Usage: ${pkg.name}`);
  });

  it("an unknown option exits non-zero with a usage message on stderr", async () => {
    const run = await runCli(["--nope"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("unknown option");
    expect(run.stderr).toContain("Usage: spec-gate");
  });

  it("an unknown command exits non-zero with a usage message on stderr", async () => {
    const run = await runCli(["frobnicate"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("unknown command");
    expect(run.stderr).toContain("Usage: spec-gate");
  });

  describe("an option's value is never echoed by a parser error", () => {
    it("an unknown option with a value before a verb: exit 1, the name stays, the value and the usage text do not hold it", async () => {
      const run = await runCli(["--nope=some-secret-value", "lint", "x"]);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("unknown option '--nope=");
      expect(run.stderr).toContain("Usage: spec-gate");
      expect(run.stderr).not.toContain("some-secret-value");
    });

    it("an unknown option with a value after a verb: exit 2 as before, the value is not echoed (the verbs inherit the setting)", async () => {
      const run = await runCli(["lint", "--nope=some-secret-value", "x"]);
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("unknown option '--nope=");
      expect(run.stderr).toContain("Usage: spec-gate lint");
      expect(run.stderr).not.toContain("some-secret-value");
    });

    it.each([
      ["--profile=some-secret-value"],
      ["--profile", "some-secret-value"],
    ])(
      "a refused value of a known option (%s): exit 2, the allowed choices stay, the value does not",
      async (...args) => {
        const run = await runCli(["lint", ...args, "x"]);
        expect(run.code).toBe(2);
        expect(run.stdout).toBe("");
        expect(run.stderr).toContain("option '--profile <profile>' argument '");
        expect(run.stderr).toContain("Allowed choices are light, full.");
        expect(run.stderr).not.toContain("some-secret-value");
      },
    );

    it("a verb without exitOverride (intake) is covered too", async () => {
      const run = await runCli(["intake", "--nope=some-secret-value"]);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("unknown option '--nope=");
      expect(run.stderr).not.toContain("some-secret-value");
    });
  });

  describe("version source", () => {
    const tmpRoots: string[] = [];
    afterEach(() => {
      for (const dir of tmpRoots.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // The copy lives inside the package so that `commander` still resolves
    // from the package's node_modules. The whole `dist` tree is copied:
    // `cli.js` imports the triage and format modules by relative path, so a
    // lone `cli.js` would fail to load.
    function copyCli(pkgJson: string): string {
      const root = fs.mkdtempSync(
        path.join(fileURLToPath(new URL("..", import.meta.url)), ".tmp-cli-"),
      );
      tmpRoots.push(root);
      // The whole build output: cli.js imports the modules next to it.
      fs.cpSync(path.dirname(cliPath), path.join(root, "dist"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, "package.json"), pkgJson);
      return path.join(root, "dist", "cli.js");
    }

    it("--version reads the version from the package.json next to dist", async () => {
      const cli = copyCli(JSON.stringify({ version: "9.8.7", type: "module" }));
      const run = await runCli(["--version"], cli);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toBe("9.8.7");
    });

    it("fails loudly when package.json has no version", async () => {
      const cli = copyCli(JSON.stringify({ type: "module" }));
      const run = await runCli(["--version"], cli);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("no version");
    });

    it("fails loudly when package.json has an empty version", async () => {
      const cli = copyCli(JSON.stringify({ version: "", type: "module" }));
      const run = await runCli(["--version"], cli);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("no version");
    });
  });
});

describe("spec-gate questions, answer and status", () => {
  const qfile = (questions: unknown[], answers: unknown[]): string =>
    JSON.stringify({ questions, answers });
  const qn = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    target: "AC-1",
    class: "blind-spot",
    blocking: false,
    question: `Open point ${id}?`,
    options: [],
    ...over,
  });

  function specHome(questions: unknown[], answers: unknown[]): string {
    const dir = path.join(scratch(), "specs", "s1");
    for (const [rel, text] of Object.entries(
      Object.assign(validFiles(), {
        "questions.json": qfile(questions, answers),
      }),
    )) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    return dir;
  }

  describe("questions", () => {
    it("exits 1 and prints spec-gate-questions/1 with an unanswered question", async () => {
      const dir = specHome([qn("QN-1", { blocking: true })], []);
      const run = await runCli(["questions", dir]);
      expect(run.code).toBe(1);
      const report = JSON.parse(run.stdout) as {
        format: string;
        counts: { unanswered: number };
      };
      expect(report.format).toBe("spec-gate-questions/1");
      expect(report.counts.unanswered).toBe(1);
    });

    it("exits 0 when nothing is unanswered", async () => {
      const run = await runCli(["questions", specHome([], [])]);
      expect(run.code).toBe(0);
    });

    it("exits 2 on a directory that is not one", async () => {
      const run = await runCli(["questions", path.join(scratch(), "nope")]);
      expect(run.code).toBe(2);
    });
  });

  describe("answer", () => {
    it("exits 0 and writes the answer, then exits 2 on a second answer", async () => {
      const dir = specHome([qn("QN-1")], []);
      const run = await runCli([
        "answer",
        dir,
        "QN-1",
        "--answer",
        "yes",
        "--channel",
        "chat",
        "--author",
        "alice",
      ]);
      expect(run.code).toBe(0);
      const written = JSON.parse(
        fs.readFileSync(path.join(dir, "questions.json"), "utf8"),
      ) as { answers: { question: string; time: string }[] };
      expect(written.answers.map((a) => a.question)).toEqual(["QN-1"]);
      expect(written.answers[0]!.time).toMatch(
        /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/,
      );
      const again = await runCli([
        "answer",
        dir,
        "QN-1",
        "--answer",
        "no",
        "--channel",
        "chat",
        "--author",
        "alice",
      ]);
      expect(again.code).toBe(2);
    });

    it("exits 2 when --channel is missing", async () => {
      const dir = specHome([qn("QN-1")], []);
      const run = await runCli([
        "answer",
        dir,
        "QN-1",
        "--answer",
        "yes",
        "--author",
        "alice",
      ]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("--channel");
    });

    it("exits 2 when --accept-recommended is given with --option", async () => {
      const dir = specHome(
        [
          qn("QN-1", {
            class: "divergence",
            options: [{ label: "keep", consequence: "sessions stay" }],
            recommended: "keep",
          }),
        ],
        [],
      );
      const run = await runCli([
        "answer",
        dir,
        "QN-1",
        "--accept-recommended",
        "--option",
        "keep",
        "--channel",
        "chat",
        "--author",
        "alice",
      ]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("--option");
    });
  });

  describe("status", () => {
    it("exits 0 and prints spec-gate-status/1", async () => {
      const run = await runCli(["status", specHome([], [])]);
      expect(run.code).toBe(0);
      const report = JSON.parse(run.stdout) as {
        format: string;
        status: string;
      };
      expect(report.format).toBe("spec-gate-status/1");
      expect(report.status).toBe("draft");
    });

    it("exits 2 on a directory that is not one", async () => {
      const run = await runCli(["status", path.join(scratch(), "nope")]);
      expect(run.code).toBe(2);
    });
  });
});

/**
 * The built command against a repository on disk and a stub of the GitHub
 * API on a loopback port. No test talks to the real API. Every run is
 * scanned: the token must not be on stdout or stderr, whatever the outcome.
 */
describe("spec-gate approve-check", { timeout: 60_000 }, () => {
  let stub: Stub;
  /** The standard repository: a proposed spec at the head, the settings on the default branch. */
  let S: Scenario;
  /** As `S`, with a file of the spec directory edited in the work tree. */
  let EDITED: Scenario;
  /** No agent identity is configured on the default branch. */
  let NO_AGENTS: Scenario;
  /** The pull request also changes a file under `.spec-gate/`. */
  let CONFIG_CHANGED: Scenario;
  /** The pull request deletes another, proposed spec. */
  let SPEC_DELETED: Scenario;
  /** The checkout is at a merge of the head with the default branch, which moved on. */
  let MERGED: Scenario;
  /**
   * The host reports a base older than a default commit the head merged; that
   * commit added a proposed spec, and the pull request deletes it.
   */
  let STALE_SPEC: Scenario;
  /** As `STALE_SPEC`, with the settings put back to their text at the stale base. */
  let STALE_CONFIG: Scenario;
  /**
   * A second pull request (base as the host reports it: the commit before the
   * spec was merged) that replaces the merged `bindings.log` through draft and
   * a second propose.
   */
  let RELOGGED: Scenario;
  /**
   * The head has two merge bases with the default branch and deletes a spec
   * only one of them holds; by which of the two was committed last.
   */
  let CROSSED: Record<"side" | "default", Scenario>;

  const OTHER = "specs/other/spec.md";

  beforeAll(async () => {
    stub = await Stub.start();
    const standard = await build();
    S = keep(standard);
    EDITED = keep(standard);
    const spec = path.join(EDITED.spec, "spec.md");
    fs.writeFileSync(
      spec,
      fs.readFileSync(spec, "utf8").replace("HTTP 401", "HTTP 403"),
    );

    NO_AGENTS = keep(
      await build({ config: "approvers: [alice]\nagent_identities: []\n" }),
    );

    const config = await build();
    CONFIG_CHANGED = keep({
      ...config,
      head: await config.repo.commit(
        {
          ".spec-gate/config.yaml":
            "approvers: [mallory]\nagent_identities: [Spec-Bot]\n",
        },
        "the pull request names its own approver",
      ),
    });

    const deleted = await build({
      merged: { [OTHER]: otherSpec("other-spec") },
    });
    SPEC_DELETED = keep({
      ...deleted,
      head: await deleted.repo.commit({ [OTHER]: null }, "delete a spec"),
    });

    const merge = await build();
    await merge.repo.checkout("main");
    const tip = await merge.repo.commit(
      { "elsewhere.txt": "the default branch moved on\n" },
      "elsewhere",
    );
    await merge.repo.setRef(REMOTE_MAIN, tip);
    await merge.repo.sh("checkout", "-q", "--detach", merge.head);
    await merge.repo.sh("merge", "-q", "--no-ff", "-m", "merge", tip);
    MERGED = keep({ ...merge, tip });

    STALE_SPEC = keep(await staleBase("spec-deleted"));
    STALE_CONFIG = keep(await staleBase("config-restored"));
    RELOGGED = keep(await relogged());
    CROSSED = {
      side: keep(await crissCross("spec-deleted", "side")),
      default: keep(await crissCross("spec-deleted", "default")),
    };
  }, 180_000);

  afterAll(async () => {
    await stub.close();
  });

  /**
   * A host on which everything holds for `s`: pull request 7 by `dev` from
   * the head to `main`, an approval by `alice` on the head, a ruleset that
   * requires one approval, and the settings merged by pull request 3 with
   * an approval by `bob`.
   */
  function hostOf(s: Scenario): void {
    stub.reset();
    stub.on(PULL_PATH, {
      json: pullJson({
        head: { ref: "pr", sha: s.head, repo: { full_name: "dev/widgets" } },
        base: {
          ref: "main",
          sha: s.tip ?? s.c1,
          repo: { full_name: REPOSITORY },
        },
      }),
    });
    stub.on(REVIEWS_PATH, {
      json: [reviewJson("alice", "APPROVED", s.head, 1)],
    });
    stub.on(RULES_PATH, { json: [pullRequestRule(1)] });
    stub.on(`${P}/commits`, { json: [{ sha: s.c1 }] });
    stub.on(`${P}/commits/${s.c1}/pulls`, {
      json: [
        {
          number: 3,
          merged_at: "2024-05-01T11:00:00Z",
          merge_commit_sha: s.c1,
          head: { ref: "settings", sha: sha("d") },
          base: { ref: "main", repo: { full_name: REPOSITORY } },
        },
      ],
    });
    stub.on(`${P}/pulls/3/reviews`, {
      json: [reviewJson("bob", "APPROVED", sha("d"), 1)],
    });
  }

  beforeEach(() => hostOf(S));

  /** The arguments of a run for `s` against the stub, `over` replacing or (with `null`) dropping an option. */
  function argsFor(
    s: Scenario,
    over: Record<string, string | null> = {},
    specDir = s.spec,
  ): string[] {
    const options: Record<string, string | null> = {
      "--repo": s.dir,
      "--default-ref": REMOTE_MAIN,
      "--github-repo": REPOSITORY,
      "--pr": String(PULL),
      "--api-url": stub.url,
      ...over,
    };
    return [
      "approve-check",
      specDir,
      ...Object.entries(options).flatMap(([flag, value]) =>
        value === null ? [] : [flag, value],
      ),
    ];
  }

  /**
   * Runs the built command with `GITHUB_TOKEN` set to `token` (unset for
   * `null`) and fails when an output holds the test token.
   */
  async function approveCheck(
    args: string[],
    token: string | null = TOKEN,
  ): Promise<Run> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["GITHUB_TOKEN"];
    if (token !== null) env["GITHUB_TOKEN"] = token;
    const run = await runBounded(process.execPath, [cliPath, ...args], {
      env,
      timeoutMs: 30_000,
    });
    expect(run.timedOut).toBe(false);
    expect(run.stdout.includes(TOKEN), "the token on stdout").toBe(false);
    expect(run.stderr.includes(TOKEN), "the token on stderr").toBe(false);
    return run;
  }

  /** The one report line of a run that printed a report. */
  function reportOf(run: Run): ApproveReport {
    const lines = run.stdout.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    expect(run.stdout.endsWith("\n")).toBe(true);
    return JSON.parse(lines[0]!) as ApproveReport;
  }

  /** A run that must end with exit 2, no report and nothing asked of the host. */
  async function refused(
    args: string[],
    token: string | null = TOKEN,
  ): Promise<string> {
    const run = await approveCheck(args, token);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(stub.hits).toEqual([]);
    return run.stderr;
  }

  describe("a report", () => {
    it("exits 0 with one JSON report line when every condition holds", async () => {
      const run = await approveCheck(argsFor(S));
      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      const report = reportOf(run);
      expect(report.format).toBe("spec-gate-approve/1");
      expect(report.approved).toBe(true);
      expect(codes(report)).toEqual(Array(8).fill("ok"));
      expect(report.conditions.map((c) => c.name).at(-1)).toBe(
        "repo-check-clean",
      );
      expect(report.pull_request).toEqual({
        number: PULL,
        author: "dev",
        head: S.head,
        base: S.c1,
        target_ref: "refs/heads/main",
      });
      expect(report.last_config_commit).toEqual({
        commit: S.c1,
        approver: "bob",
      });
      expect(report.commands).toEqual([]);
      expect(run.stdout).not.toContain(S.dir);
      // The token of the environment is what the host was asked with, and
      // every request is a read.
      expect(stub.hits.length).toBeGreaterThan(3);
      for (const hit of stub.hits) {
        expect(hit.method).toBe("GET");
        expect(hit.headers.authorization).toBe(`Bearer ${TOKEN}`);
      }
    });

    it("exits 0 with the base commit of the host given as --base", async () => {
      const run = await approveCheck(argsFor(S, { "--base": S.c1 }));
      expect(run.code).toBe(0);
      expect(reportOf(run)).toMatchObject({ approved: true, reference: S.c1 });
    });

    it("exits 1 with --base on the default ref when the host reports another base", async () => {
      // The first commit of the repository: on the default ref, not the base.
      const first = await runBounded("git", [
        "-C",
        S.dir,
        "rev-list",
        "--max-parents=0",
        "HEAD",
      ]);
      expect(first.code).toBe(0);
      const run = await approveCheck(
        argsFor(S, { "--base": first.stdout.trim() }),
      );
      expect(run.code).toBe(1);
      expect(cond(reportOf(run), 2)).toMatchObject({
        ok: false,
        code: "base-mismatch",
      });
    });

    /** A run for `s` that must print a report that is not approved. */
    async function notApproved(s: Scenario): Promise<ApproveReport> {
      const run = await approveCheck(argsFor(s));
      expect(run.code).toBe(1);
      expect(run.stderr).toBe("");
      const report = reportOf(run);
      expect(report.approved).toBe(false);
      expect(report.conditions).toHaveLength(8);
      return report;
    }

    it("condition 1 fails, exit 1: the host reports another head than the checkout", async () => {
      stub.on(PULL_PATH, {
        json: pullJson({
          head: { ref: "pr", sha: S.draft, repo: { full_name: "dev/widgets" } },
          base: { ref: "main", sha: S.c1, repo: { full_name: REPOSITORY } },
        }),
      });
      const report = await notApproved(S);
      expect(cond(report, 1).code).toBe("head-mismatch");
      expect(failing(report)).toEqual([1]);
    });

    it("condition 1 fails, exit 1: the checkout is a merge of the head with the default branch, as a pull request job checks out by default", async () => {
      hostOf(MERGED);
      const report = await notApproved(MERGED);
      expect(report.head).not.toBe(MERGED.head);
      expect(report.pull_request).toMatchObject({ head: MERGED.head });
      expect(cond(report, 1).code).toBe("head-mismatch");
    });

    it("condition 2 fails, exit 1: the approver is not on the list", async () => {
      stub.on(REVIEWS_PATH, {
        json: [reviewJson("mallory", "APPROVED", S.head, 1)],
      });
      const report = await notApproved(S);
      expect(cond(report, 2).code).toBe("approver-not-qualified");
      expect(failing(report)).toEqual([2]);
    });

    it("condition 3 fails, exit 1: the approval is of a commit without the spec", async () => {
      stub.on(REVIEWS_PATH, {
        json: [reviewJson("alice", "APPROVED", S.c1, 1)],
      });
      const report = await notApproved(S);
      expect(cond(report, 3).code).toBe("review-digest-unavailable");
      expect(failing(report)).toEqual([1, 2, 3]);
    });

    it("condition 4 fails, exit 1: the spec directory of the work tree is not the head's", async () => {
      hostOf(EDITED);
      const report = await notApproved(EDITED);
      expect(cond(report, 4).code).toBe("worktree-not-head");
      expect(failing(report)).toEqual([4]);
    });

    it("condition 5 fails, exit 1: no agent identity is configured", async () => {
      hostOf(NO_AGENTS);
      const report = await notApproved(NO_AGENTS);
      expect(cond(report, 5).code).toBe("approval-not-verifiable");
      expect(failing(report)).toEqual([5]);
      expect(report.approve_reported).toBe(true);
    });

    it("condition 6 fails, exit 1: nothing proves that the host enforces the review", async () => {
      stub.on(RULES_PATH, { json: [] });
      stub.on(PROTECTION_PATH, { status: 404, json: { message: "Not Found" } });
      const report = await notApproved(S);
      expect(cond(report, 6).code).toBe("approval-not-enforced");
      expect(failing(report)).toEqual([6]);
      expect(report.approve_reported).toBe(true);
    });

    it("condition 7 fails, exit 1: the pull request changes a file under .spec-gate/", async () => {
      hostOf(CONFIG_CHANGED);
      const report = await notApproved(CONFIG_CHANGED);
      expect(cond(report, 7).code).toBe("spec-changes-config");
      expect(failing(report)).toEqual([4, 7]);
      // The settings are still the ones of the default branch.
      expect(cond(report, 2).ok).toBe(true);
    });

    it("condition 8 fails, exit 1: the pull request deletes another, proposed spec", async () => {
      hostOf(SPEC_DELETED);
      const report = await notApproved(SPEC_DELETED);
      expect(cond(report, 8)).toMatchObject({
        name: "repo-check-clean",
        code: "repo-check-findings",
        message: `the repository check reports 1 finding: spec-removed "${OTHER}"`,
      });
      expect(failing(report)).toEqual([8]);
    });

    it("condition 8 fails, exit 1, with a stale --base: a spec the default branch gained after the base and the pull request deletes", async () => {
      hostOf(STALE_SPEC);
      const run = await approveCheck(
        argsFor(STALE_SPEC, { "--base": STALE_SPEC.c1 }),
      );
      expect(run.code).toBe(1);
      const report = reportOf(run);
      expect(report.reference).toBe(STALE_SPEC.c1);
      expect(report.pull_request).toMatchObject({ base: STALE_SPEC.c1 });
      expect(report.default_commit).not.toBe(STALE_SPEC.c1);
      expect(cond(report, 8)).toMatchObject({
        code: "repo-check-findings",
        message: `the repository check reports 1 finding: spec-removed "${STALE_OTHER}"`,
      });
      expect(failing(report)).toEqual([8]);
      expect(report.approved).toBe(false);
    });

    it("condition 7 fails, exit 1, with a stale --base: the settings are put back to their text at the base", async () => {
      hostOf(STALE_CONFIG);
      const run = await approveCheck(
        argsFor(STALE_CONFIG, { "--base": STALE_CONFIG.c1 }),
      );
      expect(run.code).toBe(1);
      const report = reportOf(run);
      expect(report.reference).toBe(STALE_CONFIG.c1);
      expect(report.default_commit).not.toBe(STALE_CONFIG.c1);
      expect(cond(report, 7).code).toBe("spec-changes-config");
      // The final lint measures from the default branch as well.
      expect(failing(report)).toEqual([4, 7]);
      expect(report.approved).toBe(false);
    });

    it("condition 4 fails, exit 1, with a stale --base: a merged bindings.log is replaced through draft and a second propose", async () => {
      hostOf(RELOGGED);
      const overs: Record<string, string>[] = [{ "--base": RELOGGED.c1 }, {}];
      for (const over of overs) {
        const run = await approveCheck(argsFor(RELOGGED, over));
        expect(run.code).toBe(1);
        const report = reportOf(run);
        expect(report.default_commit).not.toBe(RELOGGED.c1);
        expect(cond(report, 4)).toMatchObject({
          code: "lint-errors",
          message: expect.stringContaining("bindings-log"),
        });
        expect(failing(report)).toEqual([4]);
        expect(report.approved).toBe(false);
      }
    });

    it.each([["side"], ["default"]] as const)(
      "conditions 4, 7 and 8 fail, exit 1, with two merge bases (the %s commit committed last): the head deletes a spec one of them lacks",
      async (later) => {
        const s = CROSSED[later];
        hostOf(s);
        const overs: Record<string, string>[] = [{}, { "--base": s.c1 }];
        for (const over of overs) {
          const run = await approveCheck(argsFor(s, over));
          expect(run.code).toBe(1);
          const report = reportOf(run);
          for (const condition of [4, 7, 8] as const) {
            expect(cond(report, condition)).toMatchObject({
              ok: false,
              code: "ambiguous-merge-base",
              message: expect.stringContaining("2 merge bases"),
            });
          }
          expect(failing(report)).toEqual([4, 7, 8]);
          expect(report.approved).toBe(false);
        }
      },
    );

    it("exits 1 when the host answers with an error, and nothing it said is printed", async () => {
      stub.on(REVIEWS_PATH, { status: 500, json: { message: "boom" } });
      const report = await notApproved(S);
      expect(cond(report, 1).code).toBe("host-failed");
      expect(JSON.stringify(report)).not.toContain("boom");
    });

    it("exits 1 when the host repeats the token in a body: the answer is not used and the token is not printed", async () => {
      stub.on(PULL_PATH, {
        json: pullJson({
          title: `the token is ${TOKEN}`,
          head: { ref: "pr", sha: S.head, repo: { full_name: "dev/widgets" } },
          base: { ref: "main", sha: S.c1, repo: { full_name: REPOSITORY } },
        }),
      });
      const report = await notApproved(S);
      expect(report.pull_request).toBeNull();
      expect(cond(report, 1).code).toBe("host-failed");
    });

    it("exits 1 when the host cannot be reached", async () => {
      const gone = await Stub.start();
      await gone.close();
      const run = await approveCheck(argsFor(S, { "--api-url": gone.url }));
      expect(run.code).toBe(1);
      const report = reportOf(run);
      expect(report.approved).toBe(false);
      expect(failing(report)).toEqual([1, 2, 3, 6]);
      expect(stub.hits).toEqual([]);
    });
  });

  describe("the token", () => {
    it("exits 2 without GITHUB_TOKEN and names the variable", async () => {
      expect(await refused(argsFor(S), null)).toBe(
        "spec-gate: approve-check: needs a token in the environment variable GITHUB_TOKEN; it is read from there only, never from an option\n",
      );
    });

    it("exits 2 with an empty GITHUB_TOKEN", async () => {
      expect(await refused(argsFor(S), "")).toContain("GITHUB_TOKEN");
    });

    it.each([
      ["--token=<token>", (token: string) => [`--token=${token}`]],
      ["--token <token>", (token: string) => ["--token", token]],
      ["-t<token>", (token: string) => [`-t${token}`]],
      ["a second argument", (token: string) => [token]],
    ])(
      "is not read from the command line (%s): exit 2 with and without the variable, and the value is not printed",
      async (_form, extra) => {
        for (const env of [null, TOKEN]) {
          const stderr = await refused([...argsFor(S), ...extra(TOKEN)], env);
          expect(stderr).toContain("an argument or option it does not know");
          expect(stderr).toContain("GITHUB_TOKEN only");
        }
      },
    );

    it("exits 2 for a token the adapter refuses, and does not print it", async () => {
      const stderr = await refused(argsFor(S), `${TOKEN} and more`);
      expect(stderr).toBe(
        "spec-gate: approve-check: github: token must be printable ASCII without a space\n",
      );
    });

    it.each([
      ["--repo"],
      ["--default-ref"],
      ["--base"],
      ["--github-repo"],
      ["--pr"],
      ["--api-url"],
    ])(
      "given as the value of %s by mistake, it is not printed",
      async (flag) => {
        const run = await approveCheck(argsFor(S, { [flag]: TOKEN }));
        expect(run.code).toBe(2);
        expect(run.stdout).toBe("");
      },
    );

    it("given as the spec directory by mistake, it is not printed", async () => {
      await refused(argsFor(S, {}, TOKEN));
    });

    it("has no option in the help, which `spec-gate help approve-check` prints", async () => {
      const run = await approveCheck(["help", "approve-check"]);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("--github-repo");
      expect(run.stdout).toContain("GITHUB_TOKEN");
      expect(run.stdout).not.toContain("--token");
      expect(run.stdout).not.toContain("--help");
    });

    it("placed before the verb name by mistake, an option is handled by the program: its name is echoed, its value is not, with exit 1 and no report", async () => {
      // The documented limit. Not the test token: the scan of every run
      // would fail on it, which is the point of the limit.
      const run = await approveCheck(
        ["--token=some-secret-value", ...argsFor(S)],
        null,
      );
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("unknown option '--token=");
      expect(run.stderr).not.toContain("some-secret-value");
      expect(stub.hits).toEqual([]);
    });

    it("placed before the verb name as a separate argument, the value of an unknown option is not echoed either", async () => {
      const run = await approveCheck(
        ["--token", "some-secret-value", ...argsFor(S)],
        null,
      );
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("unknown option '--token'");
      expect(run.stderr).not.toContain("some-secret-value");
      expect(stub.hits).toEqual([]);
    });

    it("a bare argument before the verb name is reported as an unknown command: the one place a value is echoed", async () => {
      const run = await approveCheck(["some-bare-word", ...argsFor(S)], null);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("unknown command 'some-bare-word'");
      expect(stub.hits).toEqual([]);
    });
  });

  describe("exit 0 without a report", () => {
    it.each([["--help"], ["-h"]])(
      "%s among the arguments of the verb is no help request: exit 2",
      async (flag) => {
        for (const args of [
          [...argsFor(S), flag],
          ["approve-check", flag, ...argsFor(S).slice(1)],
        ]) {
          const stderr = await refused(args);
          expect(stderr).toContain("an argument or option it does not know");
        }
      },
    );

    it.each([["--version"], ["-V"]])(
      "%s among the arguments of the verb prints the version and exits 0, with no JSON line: the program handles it",
      async (flag) => {
        const run = await approveCheck([...argsFor(S), flag]);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe(`${pkg.version}\n`);
        expect(run.stdout).not.toContain("approved");
        expect(stub.hits).toEqual([]);
      },
    );

    it("a job that asks for the JSON line with approved true is not fooled by them", async () => {
      const approved = (stdout: string): boolean => {
        try {
          return (
            (JSON.parse(stdout) as { approved?: unknown }).approved === true
          );
        } catch {
          return false;
        }
      };
      expect(approved((await approveCheck(argsFor(S))).stdout)).toBe(true);
      for (const args of [
        [...argsFor(S), "--version"],
        ["help", "approve-check"],
        ["--help"],
      ]) {
        const run = await approveCheck(args);
        expect(run.code).toBe(0);
        expect(approved(run.stdout)).toBe(false);
      }
    });
  });

  describe("usage errors and refusals", () => {
    it.each([["abc"], ["0"], ["7.5"], ["-7"]])(
      "exits 2 for --pr %s",
      async (pr) => {
        expect(await refused(argsFor(S, { "--pr": pr }))).toBe(
          "spec-gate: approve-check: --pr must be the number of the pull request: digits only, 1 or more\n",
        );
      },
    );

    it.each([["--repo"], ["--default-ref"], ["--github-repo"], ["--pr"]])(
      "exits 2 without %s",
      async (flag) => {
        const stderr = await refused(argsFor(S, { [flag]: null }));
        expect(stderr).toContain(`required option '${flag} <`);
      },
    );

    it("exits 2 without a spec directory", async () => {
      const stderr = await refused(argsFor(S).filter((arg) => arg !== S.spec));
      expect(stderr).toContain("missing required argument 'spec-dir'");
    });

    it("exits 2 for a repository name the adapter refuses", async () => {
      expect(await refused(argsFor(S, { "--github-repo": "widgets" }))).toBe(
        "spec-gate: approve-check: github: repository must be <owner>/<name>\n",
      );
    });

    it("exits 2 for an API root that is not https and not a loopback host", async () => {
      expect(
        await refused(argsFor(S, { "--api-url": "http://example.com" })),
      ).toBe(
        "spec-gate: approve-check: github: apiUrl must be https (http only for a loopback host)\n",
      );
    });

    it("exits 2 for a spec directory that is not a directory: the check refuses and the host is not asked", async () => {
      expect(
        await refused(argsFor(S, {}, path.join(S.dir, "specs", "nope"))),
      ).toBe(
        "spec-gate: approve-check: the spec directory is not a directory\n",
      );
    });

    it("exits 2 for a spec directory that is not specs/<name>", async () => {
      expect(await refused(argsFor(S, {}, S.dir))).toContain("specs/<name>");
      expect(
        await refused(argsFor(S, {}, path.join(S.dir, ".spec-gate"))),
      ).toContain("specs/<name>");
    });

    it("exits 2 for a default ref that is no full ref name or does not exist", async () => {
      expect(await refused(argsFor(S, { "--default-ref": "main" }))).toContain(
        "--default-ref",
      );
      expect(
        await refused(argsFor(S, { "--default-ref": "refs/heads/nope" })),
      ).toContain("--default-ref");
    });

    it("exits 2 for a base that is not on the default ref", async () => {
      expect(await refused(argsFor(S, { "--base": S.head }))).toContain(
        "--base",
      );
    });

    it("exits 2 for a repository that does not hold the spec directory", async () => {
      await refused(argsFor(S, { "--repo": NO_AGENTS.dir }));
    });

    it("after --, a spec directory that looks like an option is a directory name: exit 2, no help and no exit 0", async () => {
      for (const name of ["--help", "-h", "--version"]) {
        const args = argsFor(S).filter((arg) => arg !== S.spec);
        const stderr = await refused([...args, "--", name]);
        expect(stderr).toBe(
          "spec-gate: approve-check: the spec directory is not a directory\n",
        );
      }
    });

    it("a refusal names no path of the machine", async () => {
      const stderr = await refused(argsFor(S, {}, path.join(S.dir, "nope")));
      expect(stderr).not.toContain(S.dir);
    });
  });

  it("the scenarios are the ones the tests name", () => {
    // A guard for the fixtures: each differs from the standard one where
    // its test says it does.
    expect(EDITED.head).toBe(S.head);
    expect(CONFIG_CHANGED.head).not.toBe(CONFIG_CHANGED.draft);
    expect(fs.existsSync(path.join(SPEC_DELETED.dir, OTHER))).toBe(false);
    expect(MERGED.tip).toBeDefined();
    expect(fs.existsSync(path.join(MERGED.dir, SPEC_REL, "spec.md"))).toBe(
      true,
    );
  });
});

/**
 * `approve-check --merged`: the built command for a merged pull request,
 * against a repository on disk whose checkout is at the tip of the default
 * branch and a stub of the GitHub API on a loopback port.
 */
describe("spec-gate approve-check --merged", { timeout: 60_000 }, () => {
  let stub: Stub;
  /** The standard pull request, merged with a merge commit, squashed and rebased. */
  let BY: Record<"merge-commit" | "squash" | "rebase", Landed>;
  /** The standard pull request, still open: the checkout is at its head. */
  let OPEN: Scenario;
  /** A squash whose commit holds another normative layer than the approved head. */
  let EDITED: Landed;
  /** A squash, and a later commit of the default branch that changes the spec. */
  let LATER: Landed;
  /** A squash that puts the settings back to their text at the base the host reports. */
  let OWN_SETTINGS: Landed;
  /** A squash the default ref of the checkout does not hold yet. */
  let OFF_DEFAULT: Landed;
  /** A squash, and a later commit of the default branch that takes the approver off the list. */
  let REVOKED: Landed;

  beforeAll(async () => {
    stub = await Stub.start();
    BY = {
      "merge-commit": keepLanded(await land(await build(), "merge-commit")),
      squash: keepLanded(await land(await build(), "squash")),
      rebase: keepLanded(await land(await build(), "rebase")),
    };
    OPEN = keep(await build());
    EDITED = keepLanded(await squashEdited());

    const later = await land(await build(), "squash");
    editSpec(later.dir);
    LATER = keepLanded(await afterMerge(later, {}, "the spec changes"));

    OWN_SETTINGS = keepLanded(await squashWithOwnSettings());

    const off = await land(await build(), "squash");
    await off.repo.setRef(
      REMOTE_MAIN,
      await off.repo.sh("rev-parse", `${off.merge}^`),
    );
    OFF_DEFAULT = keepLanded(off);

    REVOKED = keepLanded(
      await afterMerge(await land(await build(), "squash"), {
        ".spec-gate/config.yaml": CONFIG_ONLY_BOB,
      }),
    );
  }, 240_000);

  afterAll(async () => {
    await stub.close();
  });

  /**
   * A host on which everything holds for the pull request of `s`: pull
   * request 7 by `dev` with the head of `s` and the base `c1`, an approval
   * by `alice` on that head, a ruleset that requires one approval, and the
   * settings merged by pull request 3 with an approval by `bob`. `merge` is
   * the merge commit the host reports; without one the pull request is open.
   */
  function hostOf(s: Scenario, merge?: string): void {
    stub.reset();
    stub.on(PULL_PATH, {
      json: pullJson({
        head: { ref: "pr", sha: s.head, repo: { full_name: "dev/widgets" } },
        base: { ref: "main", sha: s.c1, repo: { full_name: REPOSITORY } },
        ...(merge === undefined
          ? {}
          : {
              state: "closed",
              merged: true,
              merged_at: "2024-05-01T12:00:00Z",
              merge_commit_sha: merge,
            }),
      }),
    });
    stub.on(REVIEWS_PATH, {
      json: [reviewJson("alice", "APPROVED", s.head, 1)],
    });
    stub.on(RULES_PATH, { json: [pullRequestRule(1)] });
    stub.on(`${P}/commits`, { json: [{ sha: s.c1 }] });
    stub.on(`${P}/commits/${s.c1}/pulls`, {
      json: [
        {
          number: 3,
          merged_at: "2024-05-01T11:00:00Z",
          merge_commit_sha: s.c1,
          head: { ref: "settings", sha: sha("d") },
          base: { ref: "main", repo: { full_name: REPOSITORY } },
        },
      ],
    });
    stub.on(`${P}/pulls/3/reviews`, {
      json: [reviewJson("bob", "APPROVED", sha("d"), 1)],
    });
  }

  /** Runs the built command for `s` against the stub, with `extra` after the options. */
  async function run(s: Scenario, extra: string[]): Promise<Run> {
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_TOKEN: TOKEN };
    const result = await runBounded(
      process.execPath,
      [
        cliPath,
        "approve-check",
        s.spec,
        "--repo",
        s.dir,
        "--default-ref",
        REMOTE_MAIN,
        "--github-repo",
        REPOSITORY,
        "--pr",
        String(PULL),
        "--api-url",
        stub.url,
        ...extra,
      ],
      { env, timeoutMs: 30_000 },
    );
    expect(result.timedOut).toBe(false);
    expect(result.stdout.includes(TOKEN), "the token on stdout").toBe(false);
    expect(result.stderr.includes(TOKEN), "the token on stderr").toBe(false);
    return result;
  }

  /** The report of a run for the merged pull request of `m`, and its exit code. */
  async function merged(
    m: Landed,
    extra: string[] = [],
  ): Promise<{ code: number | null; report: ApproveReport }> {
    hostOf(m, m.merge);
    const result = await run(m, ["--merged", ...extra]);
    expect(result.stderr).toBe("");
    const lines = result.stdout.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    return {
      code: result.code,
      report: JSON.parse(lines[0]!) as ApproveReport,
    };
  }

  it.each([
    ["merge-commit", "merge-commit", 1],
    ["squash", "single-commit", 3],
    ["rebase", "single-commit", 3],
  ] as const)(
    "exits 0 for a pull request merged by %s: approved at the tip of the default branch",
    async (how, shape, ranges) => {
      const m = BY[how];
      const { code, report } = await merged(m);
      expect(code).toBe(0);
      expect(report.approved).toBe(true);
      expect(codes(report)).toEqual(Array(8).fill("ok"));
      expect(report.mode).toBe("merged");
      expect(report.head).toBe(m.landed);
      expect(report.default_commit).toBe(m.landed);
      expect(report.pull_request!.head).toBe(m.head);
      expect(report.merge).toMatchObject({ commit: m.merge, shape });
      expect(report.merge!.ranges).toHaveLength(ranges);
      for (const hit of stub.hits) expect(hit.method).toBe("GET");
    },
  );

  it("exits 0 with the base commit of the host given as --base, and the report differs in reference alone", async () => {
    const without = await merged(BY.squash);
    const withBase = await merged(BY.squash, ["--base", BY.squash.c1]);
    expect(withBase.code).toBe(0);
    expect(withBase.report.reference).toBe(BY.squash.c1);
    expect({
      ...withBase.report,
      reference: without.report.reference,
    }).toEqual(without.report);
  });

  it("exits 1 for a pull request that is not merged: not-merged", async () => {
    hostOf(OPEN);
    const result = await run(OPEN, ["--merged"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as ApproveReport;
    expect(report.approved).toBe(false);
    for (const condition of [1, 2, 7, 8] as const) {
      expect(cond(report, condition).code).toBe("not-merged");
    }
    expect(report.merge).toBeNull();
    // The same pull request is approved as an open one.
    hostOf(OPEN);
    expect((await run(OPEN, [])).code).toBe(0);
  });

  it("exits 1 for a merged pull request without --merged: it is judged as an open one", async () => {
    hostOf(BY.squash, BY.squash.merge);
    const result = await run(BY.squash, []);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as ApproveReport;
    expect(report.mode).toBe("open");
    expect(cond(report, 1).code).toBe("head-mismatch");
  });

  it("exits 1 for a squash that changed the normative layer after the approval", async () => {
    const { code, report } = await merged(EDITED);
    expect(code).toBe(1);
    expect(cond(report, 3).code).toBe("digest-mismatch-after-merge");
    expect(cond(report, 3).message).toContain(report.digest!);
    expect(cond(report, 3).message).toContain(EDITED.head);
    expect(report.approved).toBe(false);
  });

  it("exits 1 when a later commit of the default branch changed the spec", async () => {
    const { code, report } = await merged(LATER);
    expect(code).toBe(1);
    expect(report.default_commit).toBe(LATER.landed);
    expect(report.default_commit).not.toBe(LATER.merge);
    expect(cond(report, 3).code).toBe("digest-mismatch-after-merge");
    expect(report.approved).toBe(false);
  });

  it.each([
    ["without --base", false],
    ["with --base", true],
  ])(
    "exits 1 for a squash that carried its own approvers change, %s",
    async (_how, withBase) => {
      const m = OWN_SETTINGS;
      const { code, report } = await merged(
        m,
        withBase ? ["--base", m.c1] : [],
      );
      expect(code).toBe(1);
      // At the tip the settings name the approver; they are the merge's own.
      expect(report.approvals).toEqual([
        { login: "alice", commit: m.head, at_head: true, problem: null },
      ]);
      expect(failing(report)).toEqual([2, 7]);
      expect(cond(report, 2).code).toBe("config-in-merge");
      expect(cond(report, 7).code).toBe("spec-changes-config");
      expect(report.pull_request!.base).toBe(m.c1);
      expect(report.reference).toBe(withBase ? m.c1 : m.landed);
      expect(report.approved).toBe(false);
    },
  );

  it("exits 1 for a merge commit that is not on the default ref", async () => {
    const { code, report } = await merged(OFF_DEFAULT);
    expect(code).toBe(1);
    for (const condition of [2, 7, 8] as const) {
      expect(cond(report, condition).code).toBe("merge-not-on-default");
    }
    expect(report.merge).toBeNull();
    expect(report.approved).toBe(false);
  });

  it("exits 1 when the approver was taken off the list on the default branch after the merge", async () => {
    const { code, report } = await merged(REVOKED);
    expect(code).toBe(1);
    expect(failing(report)).toEqual([2]);
    expect(cond(report, 2).code).toBe("approver-not-qualified");
  });

  it("exits 1 for the same with --base at a commit where the approver still was one: the settings are the tip's", async () => {
    const { code, report } = await merged(REVOKED, ["--base", REVOKED.c1]);
    expect(code).toBe(1);
    expect(report.reference).toBe(REVOKED.c1);
    expect(report.default_commit).toBe(REVOKED.landed);
    expect(failing(report)).toEqual([2]);
    expect(cond(report, 2).code).toBe("approver-not-qualified");
    expect(report.approvals[0]!.problem).toBe("not-allowlisted");
  });

  it("exits 1 when the host fails: host-failed for the conditions that need the pull request, never a pass", async () => {
    hostOf(BY.squash, BY.squash.merge);
    stub.on(PULL_PATH, { status: 500 });
    const result = await run(BY.squash, ["--merged"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as ApproveReport;
    expect(report.pull_request).toBeNull();
    for (const condition of [1, 2, 7, 8] as const) {
      expect(cond(report, condition).code).toBe("host-failed");
    }
  });

  it("--merged takes no value: a value after it is an argument the verb does not know, exit 2", async () => {
    hostOf(BY.squash, BY.squash.merge);
    const result = await run(BY.squash, ["--merged", "yes"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("an argument or option it does not know");
    expect(result.stderr).toContain("--api-url and --merged");
    expect(stub.hits).toEqual([]);
  });

  it("the help of the verb names --merged", async () => {
    const result = await runBounded(
      process.execPath,
      [cliPath, "help", "approve-check"],
      { timeoutMs: 30_000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--merged");
    expect(result.stdout).toContain("check after the merge");
  });

  it("the scenarios are the ones the tests name", () => {
    expect(LATER.landed).not.toBe(LATER.merge);
    expect(REVOKED.landed).not.toBe(REVOKED.merge);
    expect(OFF_DEFAULT.landed).toBe(OFF_DEFAULT.merge);
    expect(OPEN.head).not.toBe(OPEN.c1);
    for (const m of Object.values(BY)) expect(m.head).not.toBe(m.landed);
  });
});

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
  build,
  codes,
  cond,
  failing,
  keep,
  otherSpec,
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
  }, 120_000);

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

    it("has no option in the help", async () => {
      const run = await approveCheck(["approve-check", "--help"]);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("--github-repo");
      expect(run.stdout).toContain("GITHUB_TOKEN");
      expect(run.stdout).not.toContain("--token");
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

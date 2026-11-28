import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  lintSpecDir,
  RULES,
  type GitRequest,
  type LintReport,
} from "../../src/lint/index.js";
import {
  REMOTE_MAIN,
  Repo,
  SPEC_REL,
  STATIC_PLAN,
  lintIn,
  ofRule,
  plainHistory,
  specFiles,
  usageError,
} from "./git-helpers.js";
import { runCli, scratch, specDir } from "./helpers.js";

const DEFAULT = { defaultRef: REMOTE_MAIN };

async function committed() {
  const history = await plainHistory();
  const head = await history.repo.commit(
    specFiles({ base: history.c1, ref: history.c1, plan: STATIC_PLAN }),
    "spec",
  );
  return { ...history, head };
}

describe("resolving the git inputs", () => {
  it("resolves the reference, the diff base and the head once, as full commit ids", async () => {
    const { repo, c1 } = await committed();
    // Seen through a rule: the engine passes the resolved inputs on.
    const seen: unknown[] = [];
    const probe = {
      id: "probe-git",
      level: "error" as const,
      profiles: ["light", "full"] as const,
      gated: false,
      ackable: false,
      needsGit: true,
      summary: "probe",
      needs: [],
      check: (ctx: { git?: unknown }) => {
        seen.push(ctx.git);
        return [];
      },
    };
    const result = lintSpecDir(
      repo.spec,
      { git: { repo: repo.dir, defaultRef: REMOTE_MAIN } },
      [...RULES, probe],
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      {
        repo: fs.realpathSync(repo.dir),
        reference: c1,
        diffBase: c1,
        head: await repo.head(),
      },
    ]);
  });

  it("--base is validated and moves nothing: the reference is the --default-ref commit, the diff base the one merge base with HEAD", async () => {
    const { repo, c0, c1 } = await committed();
    // c0 lies on the default branch, so it is a valid base; measured from
    // it, c1 would not be an ancestor of the reference
    const report = lintIn(repo, { ...DEFAULT, base: c0 });
    expect(ofRule(report, "base-commit-not-ancestor")).toHaveLength(0);
    expect(ofRule(report, "commands-ref-not-ancestor")).toHaveLength(0);
    expect(report).toEqual(lintIn(repo, DEFAULT));
    expect(c1).not.toBe(c0);
  });

  it("the resolved inputs with an older --base are the ones without it", async () => {
    const { repo, c0, c1 } = await committed();
    const seen: unknown[] = [];
    const probe = {
      id: "probe-git",
      level: "error" as const,
      profiles: ["light", "full"] as const,
      gated: false,
      ackable: false,
      needsGit: true,
      summary: "probe",
      needs: [],
      check: (ctx: { git?: unknown }) => {
        seen.push(ctx.git);
        return [];
      },
    };
    for (const base of [c0, c1]) {
      const result = lintSpecDir(
        repo.spec,
        { git: { repo: repo.dir, defaultRef: REMOTE_MAIN, base } },
        [...RULES, probe],
      );
      expect(result.ok).toBe(true);
    }
    const expected = {
      repo: fs.realpathSync(repo.dir),
      reference: c1,
      diffBase: c1,
      head: await repo.head(),
    };
    expect(seen).toEqual([expected, expected]);
  });

  it("each combination of the two reference flags", async () => {
    const { repo, c0, c1 } = await committed();
    await repo.setRef("refs/remotes/origin/old", c0);
    const base = (r: LintReport) =>
      ofRule(r, "base-commit-not-ancestor").length;
    // default-ref alone: the commit it names is the reference
    expect(base(lintIn(repo, DEFAULT))).toBe(0);
    expect(base(lintIn(repo, { defaultRef: "refs/remotes/origin/old" }))).toBe(
      1,
    );
    // base alone: refused, a base names no default branch to measure from
    for (const alone of [c1, c0]) {
      expect(usageError(repo, { base: alone })).toBe(
        "--base needs --default-ref <ref>: the change is measured from the merge base of HEAD and the --default-ref commit, never from --base",
      );
    }
    // both: --base is validated and must lie on the default branch; the
    // --default-ref commit stays the reference
    expect(base(lintIn(repo, { ...DEFAULT, base: c0 }))).toBe(0);
    expect(base(lintIn(repo, { ...DEFAULT, base: c1 }))).toBe(0);
    expect(
      base(lintIn(repo, { defaultRef: "refs/remotes/origin/old", base: c0 })),
    ).toBe(1);
    // none: nothing is checked, nothing is wrong
    expect(base(lintIn(repo, undefined))).toBe(0);
    expect(base(lintIn(repo, {}))).toBe(0);
  });

  it("--repo alone is no git input: the git rules are skipped, no-git", async () => {
    const { repo } = await committed();
    const report = lintIn(repo, { repo: repo.dir });
    expect(
      report.skipped.filter((s) => s.reason === "no-git").map((s) => s.rule),
    ).toEqual([
      "base-commit-not-ancestor",
      "commands-ref-not-ancestor",
      "spec-changes-config",
      "stale-evidence",
      "static-command-unknown",
    ]);
  });

  it("--repo may name a directory below the top level, and the default is the spec directory's repository", async () => {
    const { repo } = await committed();
    const sub = path.join(repo.dir, "specs");
    for (const request of [
      DEFAULT,
      { ...DEFAULT, repo: repo.dir },
      { ...DEFAULT, repo: sub },
      { ...DEFAULT, repo: repo.spec },
    ]) {
      const report = lintIn(repo, request);
      expect(report.errors, JSON.stringify(request)).toEqual([]);
    }
  });

  it("a spec directory spelled in another case on a case-insensitive volume", async (ctx) => {
    const { repo } = await committed();
    const probe = scratch();
    fs.mkdirSync(path.join(probe, "CaseProbe"));
    if (!fs.existsSync(path.join(probe, "caseprobe"))) {
      // a spelling in another case cannot be produced on a case-sensitive volume
      ctx.skip();
    }
    // On such a volume the caller can spell the repository's temporary
    // directory as `REPO-...` and `specs` as `Specs`; containment must
    // compare the case git reports, not the case the argument carried.
    const original = path.join(repo.dir, "Specs", "s1");
    const folded = original.replace("repo-", "REPO-");
    expect(folded).not.toBe(original);
    const result = lintSpecDir(folded, { git: { ...DEFAULT, repo: repo.dir } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.errors).toEqual([]);
  });
});

describe("usage errors", () => {
  it("a --default-ref that is not a valid full ref name", async () => {
    const { repo } = await committed();
    for (const bad of [
      "main",
      "origin/main",
      "HEAD",
      "-x",
      "--end-of-options",
      "refs/heads/a..b",
      "refs/heads/x y",
      "",
    ]) {
      expect(usageError(repo, { defaultRef: bad }), JSON.stringify(bad)).toBe(
        "--default-ref is not a valid full ref name under refs/ (for example refs/remotes/origin/main)",
      );
    }
  });

  it("a --default-ref that names no ref or no commit", async () => {
    const { repo, c1 } = await committed();
    await repo.sh("update-ref", "refs/tags/tree", `${c1}^{tree}`);
    for (const missing of [
      "refs/heads/nope",
      "refs/remotes/origin/nope",
      "refs/tags/tree",
    ]) {
      expect(usageError(repo, { defaultRef: missing }), missing).toBe(
        "--default-ref does not resolve to a commit",
      );
    }
  });

  it("a --base that is not the full id of a commit", async () => {
    const { repo, c1 } = await committed();
    await repo.sh("tag", "-a", "-m", "t", "v1", c1);
    const tag = await repo.sh("rev-parse", "refs/tags/v1");
    const tree = await repo.sh("rev-parse", `${c1}^{tree}`);
    for (const bad of [
      c1.slice(0, 12),
      "HEAD",
      "main",
      REMOTE_MAIN,
      "",
      "0".repeat(40),
      tag,
      tree,
      c1.toUpperCase(),
    ]) {
      expect(usageError(repo, { base: bad }), JSON.stringify(bad)).toBe(
        "--base is not the full id of a commit in the repository",
      );
    }
  });

  it("a bad --default-ref is refused even when --base wins", async () => {
    const { repo, c1 } = await committed();
    expect(usageError(repo, { base: c1, defaultRef: "main" })).toContain(
      "--default-ref is not a valid full ref name",
    );
    expect(usageError(repo, { base: c1, defaultRef: "refs/heads/nope" })).toBe(
      "--default-ref does not resolve to a commit",
    );
  });

  it("--repo with no path, or outside a work tree", async () => {
    const { repo } = await committed();
    expect(usageError(repo, { ...DEFAULT, repo: "" })).toBe(
      "--repo needs a path",
    );
    expect(usageError(repo, { ...DEFAULT, repo: "   " })).toBe(
      "--repo needs a path",
    );
    expect(usageError(repo, { ...DEFAULT, repo: scratch() })).toBe(
      "--repo is not inside a git work tree",
    );
    expect(
      usageError(repo, { ...DEFAULT, repo: path.join(scratch(), "absent") }),
    ).toBe("--repo is not inside a git work tree");
  });

  it("a spec directory outside the repository", async () => {
    const { repo } = await committed();
    const other = await plainHistory();
    const result = lintSpecDir(repo.spec, {
      git: { ...DEFAULT, repo: other.repo.dir },
    });
    expect(result).toEqual({
      ok: false,
      message: "the spec directory is not inside the repository",
    });
    // a sibling whose name only starts like the repository's does not count
    const sibling = `${repo.dir}-x`;
    fs.mkdirSync(path.join(sibling, "spec"), { recursive: true });
    const inSibling = lintSpecDir(path.join(sibling, "spec"), {
      git: { ...DEFAULT, repo: repo.dir },
    });
    expect(inSibling).toEqual({
      ok: false,
      message: "the spec directory is not inside the repository",
    });
    fs.rmSync(sibling, { recursive: true });
  });

  it("a spec directory that is a link out of the repository is refused as a link", async () => {
    const { repo } = await committed();
    const outside = specDir();
    const link = path.join(repo.dir, "linked-spec");
    fs.symlinkSync(outside, link);
    expect(lintSpecDir(link, { git: { ...DEFAULT, repo: repo.dir } })).toEqual({
      ok: false,
      message: `${link} is a symlink, refusing to read it`,
    });
  });

  it("a git input without --repo: the repository is never discovered from the spec directory", async () => {
    const { repo, c1 } = await committed();
    const absent = (request: GitRequest) =>
      lintSpecDir(repo.spec, { git: request });
    for (const request of [
      { defaultRef: REMOTE_MAIN },
      { base: c1 },
      { defaultRef: REMOTE_MAIN, base: c1 },
      { defaultRef: REMOTE_MAIN, repo: undefined },
    ]) {
      // the spec directory sits inside a perfectly good repository
      const result = absent(request);
      expect(result.ok, JSON.stringify(request)).toBe(false);
      expect(result.ok ? "" : result.message).toContain(
        "--repo <dir> is required",
      );
    }
    // and outside any repository the answer is the same
    expect(lintSpecDir(specDir(), { git: DEFAULT }).ok).toBe(false);
    // a run without a git input needs no --repo
    expect(lintSpecDir(repo.spec, { git: {} }).ok).toBe(true);
    expect(lintSpecDir(repo.spec, {}).ok).toBe(true);
  });

  it("a repository with no commit at HEAD", async () => {
    const repo = await Repo.create();
    const dir = path.join(repo.dir, SPEC_REL);
    fs.mkdirSync(dir, { recursive: true });
    expect(
      lintSpecDir(dir, { git: { repo: repo.dir, base: "a".repeat(40) } }),
    ).toEqual({
      ok: false,
      message: "--base is not the full id of a commit in the repository",
    });
  });

  it("a HEAD that shares no history with the reference commit", async () => {
    const { repo, c1 } = await committed();
    await repo.sh("checkout", "-q", "--orphan", "island");
    await repo.commit({ "i.txt": "i\n" }, "unrelated");
    expect(usageError(repo, { ...DEFAULT, base: c1 })).toBe(
      "HEAD and the reference commit share no history",
    );
  });

  it("an unborn HEAD", async () => {
    const { repo, c1 } = await committed();
    await repo.sh("checkout", "-q", "--orphan", "fresh");
    expect(usageError(repo, { ...DEFAULT, base: c1 })).toBe(
      "HEAD does not name a commit",
    );
  });

  it("--config together with a git input, either one", async () => {
    const { repo, c1 } = await committed();
    const config = path.join(scratch(), "config.yaml");
    fs.writeFileSync(config, "questions:\n  warn_above: 3\n");
    const message =
      "--config cannot be combined with --default-ref or --base: the config is read at the reference commit then";
    expect(usageError(repo, DEFAULT, { configPath: config })).toBe(message);
    expect(usageError(repo, { base: c1 }, { configPath: config })).toBe(
      message,
    );
    expect(
      usageError(repo, { ...DEFAULT, base: c1 }, { configPath: config }),
    ).toBe(message);
    // without a git input --config keeps working, --repo alone included
    for (const request of [undefined, {}, { repo: repo.dir }]) {
      const result = lintSpecDir(repo.spec, {
        configPath: config,
        git: request,
      });
      expect(result.ok, JSON.stringify(request)).toBe(true);
    }
  });

  it("no message carries an absolute path, an id or git's own words", async () => {
    const { repo, c1 } = await committed();
    const messages = [
      usageError(repo, { defaultRef: "refs/heads/nope" }),
      usageError(repo, { base: c1.slice(0, 10) }),
      usageError(repo, { repo: scratch(), defaultRef: REMOTE_MAIN }),
      usageError(repo, { repo: "", base: c1 }),
    ];
    for (const m of messages) {
      expect(m).not.toMatch(/\/(var|tmp|Users|private)\b/);
      expect(m.toLowerCase()).not.toContain("fatal");
      expect(m).not.toContain(c1.slice(0, 10));
    }
  });
});

describe("the built CLI", () => {
  it("passes the flags through and prints one report line", async () => {
    const { repo, c1 } = await committed();
    for (const args of [
      ["--default-ref", REMOTE_MAIN],
      ["--default-ref", REMOTE_MAIN, "--base", c1],
    ]) {
      const run = await runCli([
        "lint",
        repo.spec,
        "--repo",
        repo.dir,
        ...args,
      ]);
      expect(run.code, args.join(" ")).toBe(0);
      expect(run.stderr).toBe("");
      const parsed = JSON.parse(run.stdout) as LintReport;
      expect(parsed.errors).toEqual([]);
      expect(parsed.skipped.map((s) => s.reason)).toEqual([
        "gate",
        "gate",
        "gate",
      ]);
      // nothing machine-local in the report
      expect(run.stdout).not.toContain(repo.dir);
      expect(run.stdout).not.toContain(fs.realpathSync(repo.dir));
    }
  });

  it("a finding exits 1; --final without git inputs exits 1 and with them exits 0", async () => {
    const { repo, c1 } = await plainHistory();
    const fork = await repo.commit({ "fork.txt": "f\n" }, "fork");
    await repo.commit(specFiles({ base: fork, ref: c1 }), "spec");
    const bad = await runCli([
      "lint",
      repo.spec,
      "--repo",
      repo.dir,
      "--default-ref",
      REMOTE_MAIN,
    ]);
    expect(bad.code).toBe(1);
    expect(
      (JSON.parse(bad.stdout) as LintReport).errors.map((f) => f.rule),
    ).toEqual(["base-commit-not-ancestor"]);

    const good = await plainHistory();
    await good.repo.commit(
      specFiles({ base: good.c1, ref: good.c1, plan: STATIC_PLAN }),
      "spec",
    );
    const without = await runCli(["lint", good.repo.spec, "--final"]);
    expect(without.code).toBe(1);
    const withGit = await runCli([
      "lint",
      good.repo.spec,
      "--repo",
      good.repo.dir,
      "--final",
      "--default-ref",
      REMOTE_MAIN,
    ]);
    expect(withGit.code).toBe(0);
    expect((JSON.parse(withGit.stdout) as LintReport).skipped).toEqual([]);
  });

  it("every refusal is exit 2 with one line on stderr and nothing on stdout", async () => {
    const { repo, c1 } = await committed();
    const config = path.join(scratch(), "config.yaml");
    fs.writeFileSync(config, "questions:\n  warn_above: 3\n");
    for (const args of [
      ["--default-ref", "main"],
      ["--default-ref", "refs/heads/nope"],
      ["--base", c1.slice(0, 12)],
      ["--base", "refs/heads/main"],
      ["--repo", scratch(), "--base", c1],
      ["--base", c1],
      ["--base", c1, "--config", config],
      ["--default-ref", REMOTE_MAIN, "--config", config],
    ]) {
      // every case names the repository, so each one fails for its own reason
      const named = args.includes("--repo")
        ? args
        : ["--repo", repo.dir, ...args];
      const run = await runCli(["lint", repo.spec, ...named]);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stdout, args.join(" ")).toBe("");
      expect(run.stderr.trim().split("\n"), args.join(" ")).toHaveLength(1);
    }
    // a git input without --repo names the missing flag
    for (const args of [
      ["--default-ref", REMOTE_MAIN],
      ["--base", c1],
      ["--default-ref", REMOTE_MAIN, "--base", c1],
    ]) {
      const run = await runCli(["lint", repo.spec, ...args]);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stdout, args.join(" ")).toBe("");
      expect(run.stderr, args.join(" ")).toContain("--repo <dir> is required");
      expect(run.stderr.trim().split("\n"), args.join(" ")).toHaveLength(1);
    }
    // a flag without its value is commander's own usage error
    for (const flag of ["--default-ref", "--base", "--repo"]) {
      const run = await runCli(["lint", repo.spec, flag]);
      expect(run.code, flag).toBe(2);
      expect(run.stdout, flag).toBe("");
      expect(run.stderr, flag).toContain("argument missing");
    }
  });
});

describe("the config at the reference commit", () => {
  const QUESTIONS = JSON.stringify({
    questions: [1, 2, 3].map((n) => ({
      id: `QN-${n}`,
      target: "AC-1",
      class: "blind-spot",
      blocking: false,
      question: `Open point ${n} about the token store?`,
      options: [],
    })),
    answers: [],
  });

  /** The valid spec with three unanswered questions: the budget decides the warning. */
  const withQuestions = (
    base: string,
    ref: string,
  ): Record<string, string> => ({
    ...specFiles({ base, ref }),
    [`${SPEC_REL}/questions.json`]: QUESTIONS,
  });

  const budget = (r: LintReport) => ofRule(r, "question-budget").length;
  const CONFIG = ".spec-gate/config.yaml";

  async function repoWithConfig(text: string | null) {
    const { repo, c1 } = await plainHistory();
    await repo.checkout("main");
    const ref =
      text === null
        ? c1
        : await repo.commit({ [CONFIG]: text }, "config on the default branch");
    await repo.setRef(REMOTE_MAIN, ref);
    await repo.checkout("work", ref);
    return { repo, ref };
  }

  it("a missing config at the reference is the format defaults: seven questions are allowed", async () => {
    const { repo, ref } = await repoWithConfig(null);
    await repo.commit(withQuestions(ref, ref), "spec");
    const report = lintIn(repo, DEFAULT);
    expect(budget(report)).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it("the config at the reference commit sets the budget", async () => {
    const { repo, ref } = await repoWithConfig("questions:\n  warn_above: 2\n");
    await repo.commit(withQuestions(ref, ref), "spec");
    expect(budget(lintIn(repo, DEFAULT))).toBe(1);
    expect(budget(lintIn(repo, { ...DEFAULT, base: ref }))).toBe(1);
  });

  it("a config changed on the head of the pull request changes nothing", async () => {
    const { repo, ref } = await repoWithConfig("questions:\n  warn_above: 2\n");
    await repo.commit(
      {
        ...withQuestions(ref, ref),
        [CONFIG]: "questions:\n  warn_above: 100\n",
      },
      "spec that raises its own budget",
    );
    const report = lintIn(repo, DEFAULT);
    expect(budget(report)).toBe(1);
    expect(ofRule(report, "spec-changes-config")).toHaveLength(1);
  });

  it("a config edited in the working tree and not committed changes nothing", async () => {
    const { repo, ref } = await repoWithConfig("questions:\n  warn_above: 2\n");
    await repo.commit(withQuestions(ref, ref), "spec");
    fs.writeFileSync(
      path.join(repo.dir, CONFIG),
      "questions:\n  warn_above: 100\n",
    );
    expect(budget(lintIn(repo, DEFAULT))).toBe(1);
  });

  it("--base does not move the config: it is read at the --default-ref commit, not at an older PR base", async () => {
    const { repo, ref } = await repoWithConfig("questions:\n  warn_above: 2\n");
    await repo.commit(withQuestions(ref, ref), "spec");
    await repo.checkout("moved", ref);
    const later = await repo.commit(
      { [CONFIG]: "questions:\n  warn_above: 100\n" },
      "default branch relaxes the budget",
    );
    await repo.setRef(REMOTE_MAIN, later);
    await repo.checkout("work");
    // the default tip says 100, the PR base says 2: the default tip decides
    expect(budget(lintIn(repo, DEFAULT))).toBe(0);
    expect(budget(lintIn(repo, { ...DEFAULT, base: ref }))).toBe(0);
  });

  it("without git inputs there is no config: the defaults, whatever the work tree holds", async () => {
    const { repo, ref } = await repoWithConfig("questions:\n  warn_above: 2\n");
    await repo.commit(withQuestions(ref, ref), "spec");
    expect(budget(lintIn(repo, undefined))).toBe(0);
  });

  it("a config that does not parse is a format finding, and the defaults apply", async () => {
    const { repo, ref } = await repoWithConfig("questions: [broken\n");
    await repo.commit(withQuestions(ref, ref), "spec");
    const report = lintIn(repo, DEFAULT);
    expect(
      report.errors.filter((f) => f.rule === "format").map((f) => f.file),
    ).toEqual(["repo:.spec-gate/config.yaml"]);
    expect(budget(report)).toBe(0);
  });

  it("a config that is a symbolic link at the reference is a file finding, not followed", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.checkout("main");
    const linked = await repo.commit(
      { [CONFIG]: { linkTo: "../README.md" } },
      "config as a link",
    );
    await repo.setRef(REMOTE_MAIN, linked);
    await repo.checkout("work", linked);
    await repo.commit(withQuestions(c1, c1), "spec");
    const report = lintIn(repo, DEFAULT);
    expect(report.errors.filter((f) => f.rule === "file")).toEqual([
      expect.objectContaining({
        file: "repo:.spec-gate/config.yaml",
        code: "input-not-regular",
        path: "$",
      }),
    ]);
    expect(budget(report)).toBe(0);
    expect(JSON.stringify(report)).not.toContain(repo.dir);
  });

  it("a config that is not UTF-8 is a file finding", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.checkout("main");
    fs.writeFileSync(path.join(repo.dir, CONFIG), Buffer.from([0xff, 0xfe]));
    await repo.sh("add", "-A");
    await repo.sh("commit", "-q", "-m", "binary config");
    const tip = await repo.head();
    await repo.setRef(REMOTE_MAIN, tip);
    await repo.checkout("work", tip);
    await repo.commit(withQuestions(c1, c1), "spec");
    const report = lintIn(repo, DEFAULT);
    expect(report.errors.filter((f) => f.rule === "file")).toEqual([
      expect.objectContaining({ code: "input-not-utf8" }),
    ]);
  });
});

describe("rule-skipped under --final", () => {
  const skipped = (r: LintReport) =>
    ofRule(r, "rule-skipped").map((f) => [f.id, f.code]);

  it("no git inputs: one error per rule that needs git, nothing without --final", async () => {
    const { repo, c1 } = await committed();
    expect(skipped(lintIn(repo, undefined))).toEqual([]);
    const final = lintIn(repo, undefined, { final: true });
    expect(skipped(final)).toEqual([
      ["base-commit-not-ancestor", "no-git"],
      ["bindings-log", "no-git"],
      ["commands-ref-not-ancestor", "no-git"],
      ["spec-changes-config", "no-git"],
      ["static-command-unknown", "no-git"],
    ]);
    expect(final.ok).toBe(false);
    expect(final.skipped.map((s) => s.reason)).toEqual([
      "no-git",
      "no-git",
      "no-git",
      "no-git",
      "no-git",
      "no-git",
    ]);
    expect(ofRule(final, "rule-skipped")[0]).toMatchObject({
      level: "error",
      file: "$",
      path: "$",
    });
    // with git inputs the final run is clean
    expect(lintIn(repo, { ...DEFAULT, base: c1 }, { final: true }).ok).toBe(
      true,
    );
  });

  it("a missing optional input of an error rule is input-absent, with git inputs too", async () => {
    const { repo } = await committed();
    fs.rmSync(path.join(repo.spec, "triage.json"));
    fs.rmSync(path.join(repo.spec, "source", "meta.json"));
    const lint = lintIn(repo, DEFAULT);
    expect(skipped(lint)).toEqual([]);
    const final = lintIn(repo, DEFAULT, { final: true });
    expect(skipped(final)).toEqual([
      ["meta-frontmatter-mismatch", "input-absent"],
      ["triage-stale", "input-absent"],
    ]);
    expect(final.ok).toBe(false);
  });

  it("the profile, gate and input-failed reasons add nothing; a warning rule never does", async () => {
    const { repo } = await committed();
    // light profile (no triage.json to say otherwise): the full-only error
    // rules are skipped for the profile and add nothing; only triage-stale,
    // which runs in both profiles and lacks its input, does
    const triage = path.join(repo.spec, "triage.json");
    const triageText = fs.readFileSync(triage, "utf8");
    fs.rmSync(triage);
    const light = lintIn(repo, DEFAULT, { final: true, profile: "light" });
    expect(light.skipped.some((s) => s.reason === "profile")).toBe(true);
    expect(skipped(light)).toEqual([["triage-stale", "input-absent"]]);
    fs.writeFileSync(triage, triageText);
    // a questions.json that does not parse: skipped input-failed, a format error
    fs.writeFileSync(path.join(repo.spec, "questions.json"), "{ nope");
    const broken = lintIn(repo, DEFAULT, { final: true });
    expect(broken.skipped.some((s) => s.reason === "input-failed")).toBe(true);
    expect(skipped(broken)).toEqual([]);
    expect(broken.errors.some((f) => f.rule === "format")).toBe(true);
    // a warning rule that is skipped for a missing repository adds nothing
    const warn = {
      id: "warn-git",
      level: "warning" as const,
      profiles: ["light", "full"] as const,
      gated: false,
      ackable: true,
      needsGit: true,
      summary: "w",
      needs: [],
      check: () => [],
    };
    const result = lintSpecDir(specDir(), { final: true }, [...RULES, warn]);
    if (!result.ok) throw new Error(result.message);
    expect(skipped(result.report).map(([id]) => id)).not.toContain("warn-git");
    expect(result.report.skipped).toContainEqual({
      rule: "warn-git",
      reason: "no-git",
    });
  });

  it("a registry without the rule adds no finding and does not fail", () => {
    const without = RULES.filter((r) => r.id !== "rule-skipped");
    const result = lintSpecDir(specDir(), { final: true }, without);
    if (!result.ok) throw new Error(result.message);
    expect(result.report.errors).toEqual([]);
    expect(result.report.skipped.length).toBeGreaterThan(0);
  });

  it("an ack cannot silence it", async () => {
    const { repo } = await committed();
    fs.writeFileSync(
      path.join(repo.spec, "acks.yaml"),
      '- rule: "rule-skipped"\n  id: "spec-changes-config"\n  reason: "later"\n',
    );
    const final = lintIn(repo, undefined, { final: true });
    expect(ofRule(final, "ack-invalid")).toHaveLength(1);
    expect(skipped(final)).toContainEqual(["spec-changes-config", "no-git"]);
  });
});

describe("a git rule that cannot read the repository", () => {
  const saved = process.env["PATH"];
  afterEach(() => {
    process.env["PATH"] = saved;
  });

  /**
   * A `git` first on PATH that fails every call whose arguments hold
   * `needle`: with exit status 128, or, with `how` set to `kill`, by a
   * signal (no exit status at all).
   */
  function failingGit(needle: string, how: "exit" | "kill" = "exit"): void {
    const dir = fs.mkdtempSync(path.join(scratch(), "failing-git-"));
    const real = [
      "/usr/bin/git",
      "/opt/homebrew/bin/git",
      "/usr/local/bin/git",
    ].find((p) => fs.existsSync(p))!;
    fs.writeFileSync(
      path.join(dir, "git"),
      [
        "#!/bin/sh",
        'for a in "$@"; do',
        how === "kill"
          ? `  if [ "$a" = "${needle}" ]; then kill -KILL $$; fi`
          : `  if [ "$a" = "${needle}" ]; then echo "fatal: boom in $PWD" >&2; exit 128; fi`,
        "done",
        `exec "${real}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env["PATH"] = `${dir}${path.delimiter}${saved ?? ""}`;
  }

  it("is an error of that rule with the code git-failed, never a pass, a crash or git's words", async () => {
    const { repo } = await committed();
    failingGit("--is-ancestor");
    const report = lintIn(repo, DEFAULT);
    for (const rule of [
      "base-commit-not-ancestor",
      "commands-ref-not-ancestor",
    ]) {
      expect(ofRule(report, rule), rule).toEqual([
        expect.objectContaining({
          level: "error",
          code: "git-failed",
          path: rule.startsWith("base") ? "base_commit" : "commands_ref",
        }),
      ]);
    }
    expect(ofRule(report, "static-command-unknown")).toEqual([
      expect.objectContaining({ code: "git-failed" }),
    ]);
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain("boom");
    expect(JSON.stringify(report)).not.toContain(repo.dir);
  });

  it("a git stopped by a signal is git-failed in every rule, never a refusal and never a pass", async () => {
    const { repo } = await committed();
    // a killed ancestry check must not read as "not an ancestor"
    failingGit("--is-ancestor", "kill");
    const ancestry = lintIn(repo, DEFAULT);
    for (const rule of [
      "base-commit-not-ancestor",
      "commands-ref-not-ancestor",
      "static-command-unknown",
    ]) {
      expect(ofRule(ancestry, rule), rule).toEqual([
        expect.objectContaining({ level: "error", code: "git-failed" }),
      ]);
    }
    expect(ancestry.ok).toBe(false);
    // a killed tree diff
    failingGit("diff-tree", "kill");
    expect(ofRule(lintIn(repo, DEFAULT), "spec-changes-config")).toEqual([
      expect.objectContaining({ code: "git-failed", file: "repo:.spec-gate" }),
    ]);
    // a git that dies while the command set is read keeps the code git-failed,
    // in the rule that reads it, whichever of the two reads it was
    for (const needle of ["ls-tree", "cat-file"]) {
      failingGit(needle, "kill");
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "static-command-unknown"), needle).toEqual([
        expect.objectContaining({
          code: "git-failed",
          file: "repo:.spec-gate/commands.yaml",
        }),
      ]);
    }
  });

  it("a git stopped by a signal while the inputs are resolved is a usage error, not a wrong answer", async () => {
    const { repo } = await committed();
    // a killed merge-base is not "no shared history"
    failingGit("merge-base", "kill");
    expect(usageError(repo, DEFAULT)).toBe("git could not be read");
    // a killed `--is-ancestor` between --base and --default-ref is not "not on the default branch"
    const base = await repo.head();
    failingGit("--is-ancestor", "kill");
    expect(usageError(repo, { ...DEFAULT, base })).toBe(
      "git could not be read",
    );
    // a killed repository check is not "not inside a work tree"
    failingGit("--absolute-git-dir", "kill");
    expect(usageError(repo, DEFAULT)).toBe("git could not be read");
  });

  it("the tree diff and the file read fail closed too", async () => {
    const { repo } = await committed();
    failingGit("diff-tree");
    expect(ofRule(lintIn(repo, DEFAULT), "spec-changes-config")).toEqual([
      expect.objectContaining({ code: "git-failed", file: "repo:.spec-gate" }),
    ]);
    failingGit("ls-tree");
    const report = lintIn(repo, DEFAULT);
    expect(ofRule(report, "static-command-unknown")).toEqual([
      expect.objectContaining({ code: "object-unreadable" }),
    ]);
    // the config read at the reference fails the same way, as a file finding
    expect(report.errors.filter((f) => f.rule === "file")).toEqual([
      expect.objectContaining({
        file: "repo:.spec-gate/config.yaml",
        code: "input-unreadable",
      }),
    ]);
  });

  it("a repository git refuses to read is a usage error at resolution", async () => {
    const { repo } = await committed();
    fs.rmSync(path.join(repo.dir, ".git", "HEAD"));
    expect(lintSpecDir(repo.spec, { git: DEFAULT }).ok).toBe(false);
  });
});

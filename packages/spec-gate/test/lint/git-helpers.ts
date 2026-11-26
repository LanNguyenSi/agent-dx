/**
 * Helpers for the git-backed lint tests: temporary repositories built in
 * test code (a static fixture directory cannot hold a nested `.git`), a
 * spec directory written into them with chosen reference commits, and the
 * case recorder that backs the guard for rules that need git.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  lintSpecDir,
  type GitRequest,
  type LintOptions,
  type LintReport,
  type RuleDef,
} from "../../src/lint/index.js";
import { git } from "../canonical/helpers.js";
import { scratch, validFiles } from "./helpers.js";

export const SPEC_REL = "specs/s1";
export const REMOTE_MAIN = "refs/remotes/origin/main";
export const COMMANDS_OK =
  'commands:\n  typecheck:\n    argv: ["npm", "run", "typecheck"]\n';
export const COMMANDS_WITH_LINT =
  'commands:\n  typecheck:\n    argv: ["npm", "run", "typecheck"]\n  lint:\n    argv: ["npm", "run", "lint"]\n';

/** The valid test plan plus one static row that names the command `typecheck`. */
export const STATIC_PLAN =
  `${validFiles()["testplan.yaml"]!}\n` +
  '- id: TP-2\n  covers: [AC-1]\n  kind: static\n  claim: "the type check passes"\n  check_command_ref: typecheck\n';

/** A file to commit: its text, a symbolic link to `linkTo`, or `null` to delete it. */
export type Change = string | null | { linkTo: string };

export class Repo {
  private day = 1;

  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async create(options: { sha256?: boolean } = {}): Promise<Repo> {
    const dir = fs.mkdtempSync(path.join(scratch(), "repo-"));
    await git(dir, [
      "init",
      "-q",
      "-b",
      "main",
      ...(options.sha256 ? ["--object-format=sha256"] : []),
    ]);
    return new Repo(dir);
  }

  /** The absolute path of the spec directory inside the repository. */
  get spec(): string {
    return path.join(this.dir, SPEC_REL);
  }

  async sh(...args: string[]): Promise<string> {
    return git(this.dir, args, this.day);
  }

  /** Commits the changes on the current branch; every call is a new commit. */
  async commit(
    files: Record<string, Change>,
    message: string,
  ): Promise<string> {
    this.day += 1;
    for (const [rel, change] of Object.entries(files)) {
      const target = path.join(this.dir, rel);
      if (change === null) {
        fs.rmSync(target, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { force: true });
      if (typeof change === "string") fs.writeFileSync(target, change);
      else fs.symlinkSync(change.linkTo, target);
    }
    await git(this.dir, ["add", "-A"], this.day);
    await git(
      this.dir,
      ["commit", "-q", "--allow-empty", "-m", message],
      this.day,
    );
    return git(this.dir, ["rev-parse", "HEAD"], this.day);
  }

  /**
   * Commits the files straight into the index, bypassing the work tree: a
   * path that differs from another only in case or normalisation form
   * (`.Spec-Gate` next to `.spec-gate`) is a second entry here, where a file
   * system that folds names would make it the first. The work tree is not
   * updated; commit nothing else on top of it with `commit`.
   */
  async commitRaw(
    files: Record<string, string>,
    message: string,
  ): Promise<string> {
    this.day += 1;
    await this.sh("config", "core.ignorecase", "false");
    for (const [rel, text] of Object.entries(files)) {
      const blob = path.join(scratch(), `blob-${this.day}-${rel.length}`);
      fs.writeFileSync(blob, text);
      const id = await this.sh("hash-object", "-w", blob);
      await this.sh(
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${id},${rel}`,
      );
    }
    await git(
      this.dir,
      ["commit", "-q", "--allow-empty", "-m", message],
      this.day,
    );
    return git(this.dir, ["rev-parse", "HEAD"], this.day);
  }

  async checkout(branch: string, from?: string): Promise<void> {
    await this.sh(
      "checkout",
      "-q",
      ...(from === undefined ? [branch] : ["-b", branch, from]),
    );
  }

  async setRef(ref: string, commit: string): Promise<void> {
    await this.sh("update-ref", ref, commit);
  }

  async head(): Promise<string> {
    return this.sh("rev-parse", "HEAD");
  }
}

/**
 * The files of a spec directory with chosen reference commits: the valid
 * fixture, `base_commit` and `commands_ref` in the frontmatter and (unless
 * overridden) in `source/meta.json`, under `specs/s1/`.
 */
export function specFiles(options: {
  base: string;
  ref: string;
  metaBase?: string;
  metaRef?: string;
  plan?: string;
}): Record<string, string> {
  const files = validFiles();
  const sub = (name: string, from: RegExp, to: string): void => {
    const text = files[name]!;
    if (!from.test(text)) throw new Error(`${name} has nothing to replace`);
    files[name] = text.replace(from, to);
  };
  sub("spec.md", /^base_commit: .*$/m, `base_commit: ${options.base}`);
  sub("spec.md", /^commands_ref: .*$/m, `commands_ref: ${options.ref}`);
  sub(
    "source/meta.json",
    /"base_commit": "[^"]*"/,
    `"base_commit": "${options.metaBase ?? options.base}"`,
  );
  sub(
    "source/meta.json",
    /"commands_ref": "[^"]*"/,
    `"commands_ref": "${options.metaRef ?? options.ref}"`,
  );
  if (options.plan !== undefined) files["testplan.yaml"] = options.plan;
  return Object.fromEntries(
    Object.entries(files).map(([name, text]) => [`${SPEC_REL}/${name}`, text]),
  );
}

/**
 * A repository with a default branch of two commits (the second carries
 * `.spec-gate/commands.yaml`), `refs/remotes/origin/main` at its tip and a
 * checked-out branch `pr` that starts there.
 */
export async function plainHistory(): Promise<{
  repo: Repo;
  c0: string;
  c1: string;
}> {
  const repo = await Repo.create();
  const c0 = await repo.commit({ "README.md": "one\n" }, "init");
  const c1 = await repo.commit(
    { ".spec-gate/commands.yaml": COMMANDS_OK },
    "commands",
  );
  await repo.setRef(REMOTE_MAIN, c1);
  await repo.checkout("pr", c1);
  return { repo, c0, c1 };
}

/**
 * The git flags of a run in `repo`: `--repo` is required with a git input,
 * so a request that does not mention `repo` gets the repository's own
 * directory; a request that sets `repo` (even to `undefined`) is kept as it
 * is.
 */
export function withRepo(
  repo: Repo,
  request: GitRequest | undefined,
): GitRequest | undefined {
  if (request === undefined || "repo" in request) return request;
  return { ...request, repo: repo.dir };
}

/** Lints the spec directory of `repo` with the given git flags. */
export function lintIn(
  repo: Repo,
  request: GitRequest | undefined,
  options: LintOptions = {},
): LintReport {
  const result = lintSpecDir(repo.spec, {
    ...options,
    git: withRepo(repo, request),
  });
  if (!result.ok) throw new Error(`usage error: ${result.message}`);
  return result.report;
}

/** The usage error message of a run that must fail without a report. */
export function usageError(
  repo: Repo,
  request: GitRequest | undefined,
  options: LintOptions = {},
): string {
  const result = lintSpecDir(repo.spec, {
    ...options,
    git: withRepo(repo, request),
  });
  if (result.ok) throw new Error("the run was expected to be a usage error");
  return result.message;
}

export const ofRule = (report: LintReport, rule: string) =>
  [...report.errors, ...report.warnings].filter((f) => f.rule === rule);

export const skipReasonOf = (report: LintReport, rule: string) =>
  report.skipped.find((s) => s.rule === rule)?.reason;

const recorded = new Map<string, Set<"pass" | "fail">>();

/**
 * A test case of a rule that needs git. A `pass` case asserts the rule was
 * evaluated (not skipped) and raised no finding; a `fail` case asserts it
 * raised at least one. The case records itself, so the coverage guard
 * cannot be satisfied by a title alone.
 */
export function gitCase(
  rule: string,
  kind: "pass" | "fail",
  title: string,
  run: () => Promise<LintReport>,
): void {
  it(`${rule} ${kind}: ${title}`, async () => {
    const seen = recorded.get(rule) ?? new Set();
    seen.add(kind);
    recorded.set(rule, seen);
    const report = await run();
    if (kind === "pass") {
      expect(skipReasonOf(report, rule), `${rule} was skipped`).toBeUndefined();
      expect(ofRule(report, rule)).toEqual([]);
    } else {
      expect(ofRule(report, rule).length).toBeGreaterThan(0);
    }
  });
}

/**
 * The `rule: kind` pairs a rule list needs and `seen` lacks: every rule
 * that needs git must have a passing and a failing case.
 */
export function missingGitCases(
  rules: readonly RuleDef[],
  seen: ReadonlyMap<string, ReadonlySet<"pass" | "fail">> = recorded,
): string[] {
  const missing: string[] = [];
  for (const rule of rules) {
    if (rule.needsGit !== true) continue;
    for (const kind of ["pass", "fail"] as const) {
      if (!seen.get(rule.id)?.has(kind)) missing.push(`${rule.id}: ${kind}`);
    }
  }
  return missing;
}

/**
 * Squash-merges `branch` into `main` the way a host does: `main` first moves
 * on by an unrelated commit, then one new commit carries the tree of the
 * branch; `refs/remotes/origin/main` is set there and `main` is checked
 * out. The commits of the branch stay in the repository.
 */
export async function squashMerge(repo: Repo, branch: string): Promise<string> {
  await repo.checkout("main");
  await repo.commit({ "elsewhere.txt": "main moved on\n" }, "elsewhere");
  await repo.sh("merge", "-q", "--squash", branch);
  const merged = await repo.commit({}, `squash ${branch}`);
  await repo.setRef(REMOTE_MAIN, merged);
  return merged;
}

/**
 * Rebase-merges `branch` into `main`: `main` moves on by an unrelated
 * commit, the commits of the branch are replayed on top of it as new
 * commits and `main` fast-forwards there; `refs/remotes/origin/main` is set
 * there and `main` is checked out.
 */
export async function rebaseMerge(repo: Repo, branch: string): Promise<string> {
  await repo.checkout("main");
  await repo.commit({ "elsewhere.txt": "main moved on\n" }, "elsewhere");
  await repo.sh("rebase", "-q", "main", branch);
  await repo.checkout("main");
  await repo.sh("merge", "-q", "--ff-only", branch);
  const merged = await repo.head();
  await repo.setRef(REMOTE_MAIN, merged);
  return merged;
}

/**
 * A fresh clone of `main` alone over the file protocol, so the objects only
 * a pull request branch reached are not in it; its directory. Its
 * `refs/remotes/origin/main` is the default branch.
 */
export async function cloneMain(repo: Repo): Promise<string> {
  const dir = fs.mkdtempSync(path.join(scratch(), "clone-"));
  await git(scratch(), [
    "clone",
    "-q",
    "--single-branch",
    "--branch",
    "main",
    `file://${repo.dir}`,
    dir,
  ]);
  return dir;
}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_SPEC_FILES,
  MAX_TREE_ENTRIES,
  REPO_CHECK_FORMAT,
  repoCheck,
  type RepoCheckReport,
} from "../../src/repo/index.js";
import { REMOTE_MAIN, Repo } from "../lint/git-helpers.js";
import { validFiles } from "../lint/helpers.js";

const LOG = "a forged or merged log line\n";

/** A `spec.md` that parses, with the given id and status. */
function spec(id: string, status: string): string {
  const text = validFiles()["spec.md"]!;
  return text
    .replace(/^id: .*$/m, `id: ${id}`)
    .replace(
      /^status: .*$/m,
      status === "superseded"
        ? "status: superseded\nsuperseded_by: next"
        : `status: ${status}`,
    );
}

/**
 * A repository whose default branch holds `files` in one commit after an
 * initial one, with `refs/remotes/origin/main` there and a branch `pr`
 * checked out from it.
 */
async function merged(files: Record<string, string>): Promise<Repo> {
  const repo = await Repo.create();
  await repo.commit({ "README.md": "one\n" }, "init");
  const main = await repo.commit(files, "merged");
  await repo.setRef(REMOTE_MAIN, main);
  await repo.checkout("pr", main);
  return repo;
}

function check(repo: Repo, base?: string): RepoCheckReport {
  const result = repoCheck(
    base === undefined
      ? { repo: repo.dir, defaultRef: REMOTE_MAIN }
      : { repo: repo.dir, base },
  );
  if (!result.ok) throw new Error(`usage error: ${result.message}`);
  return result.report;
}

/** The findings of a check as `path code` pairs. */
function found(repo: Repo): string[] {
  return check(repo).findings.map((f) => `${f.path} ${f.code}`);
}

/** Git plumbing in `repo` with `input` on stdin; the trimmed output. */
function plumb(repo: Repo, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: repo.dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    input,
    maxBuffer: 1 << 28,
  })
    .toString()
    .trim();
}

/** Makes `tree` a commit on top of HEAD and the default branch tip, so it is the diff base. */
function commitTreeAsBase(repo: Repo, tree: string): string {
  const head = plumb(repo, ["commit-tree", tree, "-p", "HEAD", "-m", "big"]);
  plumb(repo, ["update-ref", "HEAD", head]);
  plumb(repo, ["update-ref", REMOTE_MAIN, head]);
  return head;
}

/** A tree `specs/` of `count` directories that all hold the same proposed `spec.md`. */
function manySpecs(repo: Repo, count: number, pad = ""): string {
  const blob = plumb(
    repo,
    ["hash-object", "-w", "--stdin"],
    spec("s", "proposed"),
  );
  const dir = plumb(repo, ["mktree"], `100644 blob ${blob}\tspec.md\n`);
  const entries = Array.from(
    { length: count },
    (_, i) => `040000 tree ${dir}\t${pad}d${String(i).padStart(6, "0")}\n`,
  ).join("");
  const specs = plumb(repo, ["mktree"], entries);
  return plumb(repo, ["mktree"], `040000 tree ${specs}\tspecs\n`);
}

describe("spec-gate repo-check", { timeout: 60_000 }, () => {
  it("a pull request that touches no spec is clean", async () => {
    const repo = await merged({
      "specs/a/spec.md": spec("a", "proposed"),
      "specs/a/bindings.log": LOG,
      "specs/d/spec.md": spec("d", "draft"),
    });
    await repo.commit({ "README.md": "two\n", "src/x.ts": "x\n" }, "code");
    const report = check(repo);
    expect(report).toMatchObject({
      format: REPO_CHECK_FORMAT,
      ok: true,
      spec_files: 2,
      findings: [],
    });
    expect(report.head).toBe(await repo.head());
  });

  it("a proposed spec edited in place, id and status kept, is clean", async () => {
    const repo = await merged({
      "specs/a/spec.md": spec("a", "proposed"),
      "specs/a/bindings.log": LOG,
    });
    await repo.commit(
      {
        "specs/a/spec.md": `${spec("a", "superseded")}\n`,
        "specs/a/bindings.log": `${LOG}${LOG}`,
      },
      "edit",
    );
    expect(found(repo)).toEqual([]);
  });

  it("plain deletion of a proposed spec reports the spec and its log", async () => {
    const repo = await merged({
      "specs/a/spec.md": spec("a", "proposed"),
      "specs/a/bindings.log": LOG,
    });
    await repo.commit(
      { "specs/a/spec.md": null, "specs/a/bindings.log": null },
      "delete",
    );
    const report = check(repo);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => `${f.path} ${f.code}`)).toEqual([
      "specs/a/bindings.log log-removed",
      "specs/a/spec.md spec-removed",
    ]);
  });

  it("a rename plus an id change with a fresh log reports the old path", async () => {
    const repo = await merged({
      "specs/a/spec.md": spec("a", "proposed"),
      "specs/a/bindings.log": LOG,
    });
    await repo.commit(
      {
        "specs/a/spec.md": null,
        "specs/a/bindings.log": null,
        "specs/b/spec.md": spec("b", "proposed"),
        "specs/b/bindings.log": "a fresh log\n",
      },
      "rename and new id",
    );
    expect(found(repo)).toEqual([
      "specs/a/bindings.log log-removed",
      "specs/a/spec.md spec-removed",
    ]);
  });

  it("a rename that keeps the id still reports the old path", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "proposed") });
    await repo.commit(
      { "specs/a/spec.md": null, "specs/a2/spec.md": spec("a", "proposed") },
      "rename",
    );
    expect(found(repo)).toEqual(["specs/a/spec.md spec-removed"]);
  });

  it("an off-layout proposed spec moved into specs/ with a forged log is reported", async () => {
    const repo = await merged({
      "docs/old/spec.md": spec("old", "proposed"),
    });
    await repo.commit(
      {
        "docs/old/spec.md": null,
        "specs/old/spec.md": spec("old", "proposed"),
        "specs/old/bindings.log": "a forged log\n",
      },
      "move into specs",
    );
    expect(found(repo)).toEqual(["docs/old/spec.md spec-removed"]);
  });

  it("a spec at the top level of the repository is protected too", async () => {
    const repo = await merged({ "spec.md": spec("top", "proposed") });
    await repo.commit({ "spec.md": null }, "delete");
    expect(found(repo)).toEqual(["spec.md spec-removed"]);
  });

  it("a superseded spec deleted is reported", async () => {
    const repo = await merged({ "specs/s/spec.md": spec("s", "superseded") });
    await repo.commit({ "specs/s/spec.md": null }, "delete");
    expect(found(repo)).toEqual(["specs/s/spec.md spec-removed"]);
  });

  it("a draft spec without a log deleted is clean", async () => {
    const repo = await merged({
      "specs/d/spec.md": spec("d", "draft"),
      "specs/d/testplan.yaml": "x\n",
    });
    await repo.commit(
      { "specs/d/spec.md": null, "specs/d/testplan.yaml": null },
      "delete",
    );
    const report = check(repo);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("a draft spec with a log that stays a draft only needs its log", async () => {
    const repo = await merged({
      "specs/d/spec.md": spec("d", "draft"),
      "specs/d/bindings.log": LOG,
    });
    await repo.commit({ "specs/d/spec.md": `${spec("d", "draft")}\n` }, "edit");
    expect(found(repo)).toEqual([]);
    await repo.commit({ "specs/d/spec.md": spec("e", "draft") }, "new id");
    expect(found(repo)).toEqual(["specs/d/spec.md spec-id-changed"]);
  });

  it("a draft spec with a log is protected", async () => {
    const repo = await merged({
      "specs/d/spec.md": spec("d", "draft"),
      "specs/d/bindings.log": LOG,
    });
    await repo.commit(
      { "specs/d/spec.md": null, "specs/d/bindings.log": null },
      "delete",
    );
    expect(found(repo)).toEqual([
      "specs/d/bindings.log log-removed",
      "specs/d/spec.md spec-removed",
    ]);
  });

  it("a draft spec that stops being a draft or is renamed stays clean", async () => {
    const repo = await merged({ "specs/d/spec.md": spec("d", "draft") });
    await repo.commit({ "specs/d/spec.md": spec("e", "proposed") }, "move on");
    expect(found(repo)).toEqual([]);
  });

  it("an id changed in place is spec-id-changed", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "proposed") });
    await repo.commit({ "specs/a/spec.md": spec("other", "proposed") }, "id");
    expect(found(repo)).toEqual(["specs/a/spec.md spec-id-changed"]);
  });

  it("a proposed spec set back to draft is spec-status-reverted", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "proposed") });
    await repo.commit({ "specs/a/spec.md": spec("a", "draft") }, "revert");
    expect(found(repo)).toEqual(["specs/a/spec.md spec-status-reverted"]);
  });

  it("an id change and a revert together give both findings", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "superseded") });
    await repo.commit({ "specs/a/spec.md": spec("z", "draft") }, "both");
    expect(found(repo)).toEqual([
      "specs/a/spec.md spec-id-changed",
      "specs/a/spec.md spec-status-reverted",
    ]);
  });

  it("a log removed while the spec stays is log-removed", async () => {
    const repo = await merged({
      "specs/a/spec.md": spec("a", "proposed"),
      "specs/a/bindings.log": LOG,
    });
    await repo.commit({ "specs/a/bindings.log": null }, "drop the log");
    expect(found(repo)).toEqual(["specs/a/bindings.log log-removed"]);
  });

  it("a log replaced by a symbolic link is log-removed", async () => {
    const repo = await merged({
      "specs/a/spec.md": spec("a", "proposed"),
      "specs/a/bindings.log": LOG,
      "elsewhere.log": LOG,
    });
    await repo.commit(
      { "specs/a/bindings.log": { linkTo: "../../elsewhere.log" } },
      "link",
    );
    expect(found(repo)).toEqual(["specs/a/bindings.log log-removed"]);
  });

  it("a spec that stops parsing at HEAD is spec-removed", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "proposed") });
    await repo.commit(
      { "specs/a/spec.md": "no frontmatter at all\n" },
      "break",
    );
    expect(found(repo)).toEqual(["specs/a/spec.md spec-removed"]);
  });

  it("a spec.md replaced by a symbolic link to a valid spec is spec-removed", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "proposed") });
    await repo.commit(
      {
        "specs/a/spec.md": { linkTo: "../../copy.md" },
        "copy.md": spec("a", "proposed"),
      },
      "link",
    );
    expect(found(repo)).toEqual(["specs/a/spec.md spec-removed"]);
  });

  it("a link entry at HEAD whose blob is the same valid spec is spec-removed", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "proposed") });
    const blob = plumb(repo, ["rev-parse", "HEAD:specs/a/spec.md"]);
    plumb(repo, [
      "update-index",
      "--cacheinfo",
      `120000,${blob},specs/a/spec.md`,
    ]);
    plumb(repo, ["commit", "-q", "-m", "same blob, link mode"]);
    expect(found(repo)).toEqual(["specs/a/spec.md spec-removed"]);
  });

  it("a log entry at HEAD with the same blob in link mode is log-removed", async () => {
    const repo = await merged({
      "specs/a/spec.md": spec("a", "proposed"),
      "specs/a/bindings.log": LOG,
    });
    const blob = plumb(repo, ["rev-parse", "HEAD:specs/a/bindings.log"]);
    plumb(repo, [
      "update-index",
      "--cacheinfo",
      `120000,${blob},specs/a/bindings.log`,
    ]);
    plumb(repo, ["commit", "-q", "-m", "same blob, link mode"]);
    expect(found(repo)).toEqual(["specs/a/bindings.log log-removed"]);
  });

  it("a spec.md that becomes a directory is spec-removed", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "proposed") });
    await repo.commit(
      {
        "specs/a/spec.md": null,
        "specs/a/spec.md/inner": spec("a", "proposed"),
      },
      "dir",
    );
    expect(found(repo)).toEqual(["specs/a/spec.md spec-removed"]);
  });

  it("a spec directory replaced by a submodule entry is spec-removed", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "proposed") });
    const head = await repo.head();
    await repo.sh("rm", "-q", "--cached", "specs/a/spec.md");
    await repo.sh(
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${head},specs/a`,
    );
    await repo.sh("commit", "-q", "-m", "submodule");
    expect(found(repo)).toEqual(["specs/a/spec.md spec-removed"]);
  });

  it("a deletion restored in the work tree but not committed is still reported", async () => {
    const repo = await merged({
      "specs/a/spec.md": spec("a", "proposed"),
      "specs/a/bindings.log": LOG,
    });
    await repo.commit(
      { "specs/a/spec.md": null, "specs/a/bindings.log": null },
      "delete",
    );
    fs.mkdirSync(path.join(repo.dir, "specs/a"), { recursive: true });
    fs.writeFileSync(
      path.join(repo.dir, "specs/a/spec.md"),
      spec("a", "proposed"),
    );
    fs.writeFileSync(path.join(repo.dir, "specs/a/bindings.log"), LOG);
    expect(found(repo)).toEqual([
      "specs/a/bindings.log log-removed",
      "specs/a/spec.md spec-removed",
    ]);
  });

  it("an id change undone in the work tree but not committed is still reported", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "proposed") });
    await repo.commit({ "specs/a/spec.md": spec("b", "draft") }, "change");
    fs.writeFileSync(
      path.join(repo.dir, "specs/a/spec.md"),
      spec("a", "proposed"),
    );
    expect(found(repo)).toEqual([
      "specs/a/spec.md spec-id-changed",
      "specs/a/spec.md spec-status-reverted",
    ]);
  });

  it("a spec in a case variant of specs/ moved to specs/ is reported", async () => {
    const repo = await Repo.create();
    await repo.commit({ "README.md": "one\n" }, "init");
    const main = await repo.commitRaw(
      { "Specs/a/SPEC.md": spec("a", "proposed") },
      "upper case",
    );
    await repo.setRef(REMOTE_MAIN, main);
    await repo.checkout("pr", main);
    await repo.sh("rm", "-q", "--cached", "Specs/a/SPEC.md");
    await repo.commitRaw({ "specs/a/spec.md": spec("a", "proposed") }, "lower");
    expect(found(repo)).toEqual(["Specs/a/SPEC.md spec-removed"]);
  });

  it("a log in a case variant is protected too", async () => {
    const repo = await Repo.create();
    await repo.commit({ "README.md": "one\n" }, "init");
    const main = await repo.commitRaw(
      {
        "specs/a/spec.md": spec("a", "draft"),
        "specs/a/Bindings.LOG": LOG,
      },
      "upper case log",
    );
    await repo.setRef(REMOTE_MAIN, main);
    await repo.checkout("pr", main);
    await repo.sh("rm", "-q", "--cached", "specs/a/Bindings.LOG");
    await repo.sh("commit", "-q", "-m", "drop");
    expect(found(repo)).toEqual(["specs/a/Bindings.LOG log-removed"]);
  });

  it("a link entry named spec.md at the diff base protects nothing, even when its blob parses", async () => {
    const repo = await merged({ "README.md": "x\n" });
    const blob = plumb(
      repo,
      ["hash-object", "-w", "--stdin"],
      spec("a", "proposed"),
    );
    plumb(repo, [
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${blob},specs/a/spec.md`,
    ]);
    plumb(repo, ["commit", "-q", "-m", "link entry"]);
    await repo.setRef(REMOTE_MAIN, await repo.head());
    plumb(repo, ["rm", "-q", "--cached", "specs/a/spec.md"]);
    plumb(repo, ["commit", "-q", "-m", "delete the link"]);
    expect(found(repo)).toEqual([]);
  });

  it("a link entry named bindings.log beside a draft at the diff base protects nothing", async () => {
    const repo = await merged({ "specs/d/spec.md": spec("d", "draft") });
    const blob = plumb(repo, ["hash-object", "-w", "--stdin"], LOG);
    plumb(repo, [
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${blob},specs/d/bindings.log`,
    ]);
    plumb(repo, ["commit", "-q", "-m", "link log"]);
    await repo.setRef(REMOTE_MAIN, await repo.head());
    plumb(repo, [
      "rm",
      "-q",
      "--cached",
      "specs/d/spec.md",
      "specs/d/bindings.log",
    ]);
    plumb(repo, ["commit", "-q", "-m", "delete"]);
    expect(found(repo)).toEqual([]);
  });

  it("a spec.md over 4 MiB at HEAD is spec-removed", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "proposed") });
    await repo.commit(
      {
        "specs/a/spec.md": `${spec("a", "proposed")}${"x".repeat(5 * 1024 * 1024)}\n`,
      },
      "huge",
    );
    expect(found(repo)).toEqual(["specs/a/spec.md spec-removed"]);
  });

  it("a spec that did not parse at the diff base protects nothing", async () => {
    const repo = await merged({ "specs/a/spec.md": "status: proposed\n" });
    await repo.commit({ "specs/a/spec.md": null }, "delete");
    expect(found(repo)).toEqual([]);
  });

  it("--base gives the same result as --default-ref", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "proposed") });
    const main = await repo.head();
    await repo.commit({ "specs/a/spec.md": null }, "delete");
    const byBase = check(repo, main);
    expect(byBase.reference).toBe(main);
    expect(byBase.diff_base).toBe(main);
    expect(byBase.findings.map((f) => f.code)).toEqual(["spec-removed"]);
  });

  it("the diff base is the merge base, so a spec merged after the branch point is not checked", async () => {
    const repo = await merged({ "README.md": "base\n" });
    const branchPoint = await repo.head();
    await repo.checkout("main");
    const later = await repo.commit(
      { "specs/late/spec.md": spec("late", "proposed") },
      "late merge",
    );
    await repo.setRef(REMOTE_MAIN, later);
    await repo.checkout("pr");
    const report = check(repo);
    expect(report.diff_base).toBe(branchPoint);
    expect(report.findings).toEqual([]);
  });

  it("findings are sorted by path, then code", async () => {
    const repo = await merged({
      "z/spec.md": spec("z", "proposed"),
      "a/spec.md": spec("a", "proposed"),
      "a/bindings.log": LOG,
    });
    await repo.commit(
      {
        "z/spec.md": null,
        "a/spec.md": spec("b", "draft"),
        "a/bindings.log": null,
      },
      "all of it",
    );
    expect(found(repo)).toEqual([
      "a/bindings.log log-removed",
      "a/spec.md spec-id-changed",
      "a/spec.md spec-status-reverted",
      "z/spec.md spec-removed",
    ]);
  });

  it(`more than ${MAX_SPEC_FILES} files named spec.md is tree-too-large`, async () => {
    const repo = await merged({ "README.md": "x\n" });
    commitTreeAsBase(repo, manySpecs(repo, MAX_SPEC_FILES + 1));
    const report = check(repo);
    expect(report.ok).toBe(false);
    expect(report.spec_files).toBe(0);
    expect(report.findings.map((f) => `${f.path} ${f.code}`)).toEqual([
      ". tree-too-large",
    ]);
  });

  it(`exactly ${MAX_SPEC_FILES} files named spec.md is read`, async () => {
    const repo = await merged({ "README.md": "x\n" });
    commitTreeAsBase(repo, manySpecs(repo, MAX_SPEC_FILES));
    const report = check(repo);
    expect(report.ok).toBe(true);
    expect(report.spec_files).toBe(MAX_SPEC_FILES);
  });

  it(`more than ${MAX_TREE_ENTRIES} entries is tree-too-large`, async () => {
    const repo = await merged({ "README.md": "x\n" });
    const blob = plumb(repo, ["rev-parse", "HEAD:README.md"]);
    const entries = Array.from(
      { length: MAX_TREE_ENTRIES + 1 },
      (_, i) => `100644 blob ${blob}\tf${String(i).padStart(6, "0")}\n`,
    ).join("");
    commitTreeAsBase(repo, plumb(repo, ["mktree"], entries));
    const report = check(repo);
    expect(report.findings.map((f) => f.code)).toEqual(["tree-too-large"]);
    expect(report.findings[0]!.message).toContain("entries");
  });

  it("a tree listing over the output cap is tree-too-large", async () => {
    const repo = await merged({ "README.md": "x\n" });
    commitTreeAsBase(repo, manySpecs(repo, 1_000, "p".repeat(5_000)));
    const report = check(repo);
    expect(report.findings.map((f) => f.code)).toEqual(["tree-too-large"]);
    expect(report.findings[0]!.message).toContain("bytes");
  });

  it("a cap passed at HEAD only is tree-too-large as well", async () => {
    const repo = await merged({ "specs/a/spec.md": spec("a", "proposed") });
    const blob = plumb(repo, ["rev-parse", "HEAD:README.md"]);
    const entries = Array.from(
      { length: MAX_TREE_ENTRIES + 1 },
      (_, i) => `100644 blob ${blob}\tf${String(i).padStart(6, "0")}\n`,
    ).join("");
    const tree = plumb(repo, ["mktree"], entries);
    const head = plumb(repo, ["commit-tree", tree, "-p", "HEAD", "-m", "big"]);
    plumb(repo, ["update-ref", "HEAD", head]);
    expect(found(repo)).toEqual([". tree-too-large"]);
  });

  describe("usage errors", () => {
    it("no --default-ref and no --base", async () => {
      const repo = await merged({ "README.md": "x\n" });
      const result = repoCheck({ repo: repo.dir });
      expect(result).toEqual({
        ok: false,
        message: "repo-check needs --default-ref <ref> or --base <commit>",
      });
    });

    it("no --repo", () => {
      const result = repoCheck({ defaultRef: REMOTE_MAIN });
      expect(result.ok).toBe(false);
    });

    it("a short ref name, an unknown ref and a --base off the default ref", async () => {
      const repo = await merged({ "README.md": "x\n" });
      const side = await repo.commit({ "side.txt": "s\n" }, "side");
      for (const request of [
        { repo: repo.dir, defaultRef: "main" },
        { repo: repo.dir, defaultRef: "refs/remotes/origin/none" },
        { repo: repo.dir, defaultRef: REMOTE_MAIN, base: side },
        { repo: repo.dir, base: "abc" },
      ]) {
        const result = repoCheck(request);
        expect(result.ok, JSON.stringify(request)).toBe(false);
      }
    });
  });
});

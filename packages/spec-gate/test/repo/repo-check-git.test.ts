/**
 * repo-check against trees git itself would not write: duplicate entries,
 * objects missing from the object database, and the entry cap boundary.
 * Each is built with git plumbing; every unreadable shape must fail closed.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_TREE_ENTRIES,
  repoCheck,
  type RepoCheckResult,
} from "../../src/repo/index.js";
import { runBounded } from "../canonical/helpers.js";
import { REMOTE_MAIN, Repo } from "../lint/git-helpers.js";
import { validFiles } from "../lint/helpers.js";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

/** A hex id of the repository's length that names no object. */
const FAKE = "0123456789abcdef0123456789abcdef01234567";

function spec(id: string, status: string): string {
  const text = validFiles()["spec.md"]!;
  return text
    .replace(/^id: .*$/m, `id: ${id}`)
    .replace(/^status: .*$/m, `status: ${status}`);
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

const blob = (repo: Repo, text: string) =>
  plumb(repo, ["hash-object", "-w", "--stdin"], text);

/** The tree `{ README.md, specs/a/<inner lines> }`, `mktree` flags passed through. */
function treeWithSpecDir(
  repo: Repo,
  inner: string[],
  flags: string[] = [],
): string {
  const readme = blob(repo, "one\n");
  const a = plumb(repo, ["mktree", ...flags], `${inner.join("\n")}\n`);
  const specs = plumb(repo, ["mktree"], `040000 tree ${a}\ta\n`);
  return plumb(
    repo,
    ["mktree"],
    `100644 blob ${readme}\tREADME.md\n040000 tree ${specs}\tspecs\n`,
  );
}

function readmeOnly(repo: Repo): string {
  return plumb(
    repo,
    ["mktree"],
    `100644 blob ${blob(repo, "one\n")}\tREADME.md\n`,
  );
}

/** A repository with one commit and `README.md`. */
async function fresh(): Promise<Repo> {
  const repo = await Repo.create();
  await repo.commit({ "README.md": "one\n" }, "init");
  return repo;
}

/**
 * Makes the default branch tip a commit with the tree `base` and checks out
 * a branch `pr` with one commit on top that has the tree `head`.
 */
function history(repo: Repo, trees: { base: string; head: string }): Repo {
  const c1 = plumb(repo, [
    "commit-tree",
    trees.base,
    "-p",
    "HEAD",
    "-m",
    "base",
  ]);
  const c2 = plumb(repo, ["commit-tree", trees.head, "-p", c1, "-m", "head"]);
  plumb(repo, ["update-ref", REMOTE_MAIN, c1]);
  plumb(repo, ["update-ref", "refs/heads/pr", c2]);
  plumb(repo, ["symbolic-ref", "HEAD", "refs/heads/pr"]);
  return repo;
}

function run(repo: Repo): RepoCheckResult {
  return repoCheck({ repo: repo.dir, defaultRef: REMOTE_MAIN });
}

async function cliExit(repo: Repo): Promise<number | null> {
  const out = await runBounded(process.execPath, [
    cliPath,
    "repo-check",
    "--repo",
    repo.dir,
    "--default-ref",
    REMOTE_MAIN,
  ]);
  expect(out.stdout).toBe("");
  return out.code;
}

const FAILED = { ok: false, message: "git could not be read" };

describe(
  "repo-check on trees that do not read cleanly",
  { timeout: 60_000 },
  () => {
    it("duplicate spec.md entries at HEAD, a forged one first, are refused", async () => {
      const r = await fresh();
      const original = blob(r, spec("a", "proposed"));
      const forged = blob(r, spec("z", "draft"));
      const repo = history(r, {
        base: treeWithSpecDir(r, [`100644 blob ${original}\tspec.md`]),
        head: treeWithSpecDir(r, [
          `100644 blob ${forged}\tspec.md`,
          `100644 blob ${original}\tspec.md`,
        ]),
      });
      // git's own path lookup sees the forged entry.
      expect(plumb(repo, ["show", "HEAD:specs/a/spec.md"])).toContain("id: z");
      expect(run(repo)).toEqual(FAILED);
      expect(await cliExit(repo)).toBe(2);
    });

    it("duplicate spec.md entries at the diff base, a draft last, are refused", async () => {
      const r = await fresh();
      const original = blob(r, spec("a", "proposed"));
      const draft = blob(r, spec("a", "draft"));
      const repo = history(r, {
        base: treeWithSpecDir(r, [
          `100644 blob ${original}\tspec.md`,
          `100644 blob ${draft}\tspec.md`,
        ]),
        head: readmeOnly(r),
      });
      expect(
        plumb(repo, ["show", "refs/remotes/origin/main:specs/a/spec.md"]),
      ).toContain("status: proposed");
      expect(run(repo)).toEqual(FAILED);
      expect(await cliExit(repo)).toBe(2);
    });

    it("a spec.md blob missing from the object database at the diff base fails closed", async () => {
      const r = await fresh();
      const repo = history(r, {
        base: treeWithSpecDir(
          r,
          [`100644 blob ${FAKE}\tspec.md`],
          ["--missing"],
        ),
        head: readmeOnly(r),
      });
      expect(run(repo)).toEqual(FAILED);
      expect(await cliExit(repo)).toBe(2);
    });

    it("a tree object missing from the object database at the diff base fails closed", async () => {
      const r = await fresh();
      const readme = blob(r, "one\n");
      const repo = history(r, {
        base: plumb(
          r,
          ["mktree", "--missing"],
          `100644 blob ${readme}\tREADME.md\n040000 tree ${FAKE}\tspecs\n`,
        ),
        head: readmeOnly(r),
      });
      expect(run(repo)).toEqual(FAILED);
      expect(await cliExit(repo)).toBe(2);
    });

    it(`exactly ${MAX_TREE_ENTRIES} entries are read`, async () => {
      const r = await fresh();
      const one = blob(r, "x\n");
      const entries = Array.from(
        { length: MAX_TREE_ENTRIES },
        (_, i) => `100644 blob ${one}\tf${String(i).padStart(6, "0")}\n`,
      ).join("");
      const big = plumb(r, ["mktree"], entries);
      const result = run(history(r, { base: big, head: big }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.report.findings).toEqual([]);
    });
  },
);

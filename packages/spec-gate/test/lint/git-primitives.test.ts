import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_TIMEOUT_MS,
  LintGitError,
  MAX_OUTPUT_BYTES,
  assertCommit,
  changedPaths,
  gitEnv,
  isAncestor,
  isCommit,
  mergeBase,
  readBlobAtCommit,
  resolveHead,
  resolveRef,
  type LintGitCode,
} from "../../src/lint/git/index.js";
import { runGit } from "../../src/lint/git/exec.js";
import { Repo, plainHistory } from "./git-helpers.js";
import { scratch } from "./helpers.js";

function codeOf(fn: () => unknown): LintGitCode | "no error" {
  try {
    fn();
    return "no error";
  } catch (err) {
    if (err instanceof LintGitError) return err.code;
    throw err;
  }
}

const SHA1 = "0123456789abcdef0123456789abcdef01234567";

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

describe("isCommit and assertCommit", () => {
  it("accepts the full id of a commit and nothing else", async () => {
    const { repo, c1 } = await plainHistory();
    const tree = await repo.sh("rev-parse", `${c1}^{tree}`);
    const blob = await repo.sh("rev-parse", `${c1}:README.md`);
    await repo.sh("tag", "-a", "-m", "t", "v1", c1);
    const tag = await repo.sh("rev-parse", "refs/tags/v1");
    expect(isCommit(repo.dir, c1)).toBe(true);
    for (const bad of [
      c1.slice(0, 12), // an abbreviation
      c1.toUpperCase(),
      `${c1}0`,
      "HEAD",
      "main",
      "",
      "-h",
      SHA1, // well formed, no such object
      tree,
      blob,
      tag, // names the tag object, not the commit
    ]) {
      expect(isCommit(repo.dir, bad), bad).toBe(false);
    }
    expect(codeOf(() => assertCommit(repo.dir, tag))).toBe("not-a-commit");
    expect(codeOf(() => assertCommit(repo.dir, c1))).toBe("no error");
  });

  it("refuses a 40-digit prefix of a SHA-256 commit id", async () => {
    const repo = await Repo.create({ sha256: true });
    const c0 = await repo.commit({ "a.txt": "a\n" }, "init");
    expect(c0).toHaveLength(64);
    expect(isCommit(repo.dir, c0)).toBe(true);
    expect(isCommit(repo.dir, c0.slice(0, 40))).toBe(false);
  });

  it("is false, not an exception, in a directory that is no repository", () => {
    expect(isCommit(scratch(), SHA1)).toBe(false);
  });
});

describe("resolveRef", () => {
  it("resolves a full ref name to the full id of its commit", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.setRef("refs/remotes/origin/main", c1);
    expect(resolveRef(repo.dir, "refs/remotes/origin/main")).toBe(c1);
    expect(resolveRef(repo.dir, "refs/heads/main")).toBe(c1);
  });

  it("peels an annotated tag to its commit", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.sh("tag", "-a", "-m", "t", "v1", c1);
    expect(resolveRef(repo.dir, "refs/tags/v1")).toBe(c1);
  });

  it("follows a symbolic ref", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.setRef("refs/remotes/origin/main", c1);
    await repo.sh(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    expect(resolveRef(repo.dir, "refs/remotes/origin/HEAD")).toBe(c1);
  });

  it("refuses a value that is not a valid full ref name", async () => {
    const { repo } = await plainHistory();
    for (const bad of [
      "main",
      "origin/main",
      "heads/main",
      "HEAD",
      "-refs/heads/main",
      "--end-of-options",
      "",
      "refs/",
      "refs/heads/a..b", // fits the character set, refused by check-ref-format
      "refs/heads/a.lock",
      "refs/heads/x y",
      "refs/heads/x\ny",
      "refs/heads/x~1",
      "refs/heads/x^",
      "refs/heads/x:y",
      "refs/heads/{x}",
      "refs/heads/x@{1}",
      "refs//heads/x",
      "refs/heads/x/",
      "/refs/heads/x",
    ]) {
      expect(
        codeOf(() => resolveRef(repo.dir, bad)),
        JSON.stringify(bad),
      ).toBe("ref-invalid");
    }
  });

  it("refuses a ref that does not exist, and does not search short names", async () => {
    const { repo, c1 } = await plainHistory();
    expect(codeOf(() => resolveRef(repo.dir, "refs/heads/nope"))).toBe(
      "ref-unresolvable",
    );
    // `rev-parse refs/remotes/upstream/main` would find this branch by its
    // short-name rules; an exact lookup does not.
    await repo.sh("update-ref", "refs/heads/refs/remotes/upstream/main", c1);
    expect(await repo.sh("rev-parse", "refs/remotes/upstream/main")).toBe(c1);
    expect(
      codeOf(() => resolveRef(repo.dir, "refs/remotes/upstream/main")),
    ).toBe("ref-unresolvable");
  });

  it("refuses a ref that leads to a tree or a blob", async () => {
    const { repo, c1 } = await plainHistory();
    const tree = await repo.sh("rev-parse", `${c1}^{tree}`);
    const blob = await repo.sh("rev-parse", `${c1}:README.md`);
    await repo.sh("update-ref", "refs/tags/tree", tree);
    await repo.sh("update-ref", "refs/tags/blob", blob);
    expect(codeOf(() => resolveRef(repo.dir, "refs/tags/tree"))).toBe(
      "not-a-commit",
    );
    expect(codeOf(() => resolveRef(repo.dir, "refs/tags/blob"))).toBe(
      "not-a-commit",
    );
  });
});

describe("resolveHead", () => {
  it("is the full id of HEAD, and not a commit for an unborn branch", async () => {
    const { repo, c1 } = await plainHistory();
    expect(resolveHead(repo.dir)).toBe(c1);
    const empty = await Repo.create();
    expect(codeOf(() => resolveHead(empty.dir))).toBe("not-a-commit");
  });
});

describe("isAncestor and mergeBase", () => {
  async function forked() {
    const { repo, c0, c1 } = await plainHistory();
    const a = await repo.commit({ "a.txt": "a\n" }, "on pr");
    await repo.checkout("other", c1);
    const b = await repo.commit({ "b.txt": "b\n" }, "on other");
    return { repo, c0, c1, a, b };
  }

  it("is true for an ancestor and for the commit itself, false the other way round and across branches", async () => {
    const { repo, c0, c1, a, b } = await forked();
    expect(isAncestor(repo.dir, c0, c1)).toBe(true);
    expect(isAncestor(repo.dir, c1, a)).toBe(true);
    expect(isAncestor(repo.dir, a, a)).toBe(true);
    expect(isAncestor(repo.dir, a, c1)).toBe(false);
    expect(isAncestor(repo.dir, c1, c0)).toBe(false);
    expect(isAncestor(repo.dir, a, b)).toBe(false);
    expect(isAncestor(repo.dir, b, a)).toBe(false);
  });

  it("takes full commit ids only", async () => {
    const { repo, c1 } = await plainHistory();
    for (const bad of [c1.slice(0, 12), "HEAD", "main", "-h", ""]) {
      expect(
        codeOf(() => isAncestor(repo.dir, bad, c1)),
        bad,
      ).toBe("not-a-commit");
      expect(
        codeOf(() => isAncestor(repo.dir, c1, bad)),
        bad,
      ).toBe("not-a-commit");
      expect(
        codeOf(() => mergeBase(repo.dir, bad, c1)),
        bad,
      ).toBe("not-a-commit");
    }
  });

  it("fails loudly, not with false, when git cannot answer", async () => {
    const { repo } = await plainHistory();
    expect(codeOf(() => isAncestor(repo.dir, SHA1, SHA1))).toBe("git-failed");
  });

  it("the merge base is the fork point, whichever order", async () => {
    const { repo, c1, a, b } = await forked();
    expect(mergeBase(repo.dir, a, b)).toBe(c1);
    expect(mergeBase(repo.dir, b, a)).toBe(c1);
    expect(mergeBase(repo.dir, c1, a)).toBe(c1);
  });

  it("is null for histories that share none", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.sh("checkout", "-q", "--orphan", "island");
    const island = await repo.commit({ "i.txt": "i\n" }, "unrelated");
    expect(mergeBase(repo.dir, island, c1)).toBeNull();
  });
});

describe("changedPaths", () => {
  it("lists every path that differs, from the first commit to the second", async () => {
    const { repo, c1 } = await plainHistory();
    const c2 = await repo.commit(
      {
        ".spec-gate/commands.yaml": "commands: {}\n",
        ".spec-gate/config.yaml": "questions:\n  warn_above: 2\n",
        "src/x.ts": "x\n",
      },
      "change",
    );
    const all = [
      ".spec-gate/commands.yaml",
      ".spec-gate/config.yaml",
      "src/x.ts",
    ];
    expect(changedPaths(repo.dir, c1, c2).sort()).toEqual(all);
    // the other way round, the same paths differ
    expect(changedPaths(repo.dir, c2, c1).sort()).toEqual(all);
    expect(changedPaths(repo.dir, c1, c1)).toEqual([]);
  });

  it("is relative to the repository root, whatever the directory the call starts in", async () => {
    const { repo, c1 } = await plainHistory();
    const c2 = await repo.commit({ ".spec-gate/new.yaml": "a: 1\n" }, "add");
    const inner = path.join(repo.dir, "specs");
    fs.mkdirSync(inner, { recursive: true });
    expect(changedPaths(inner, c1, c2)).toEqual([".spec-gate/new.yaml"]);
  });

  it("shows a deleted and an added path, with renames never merged into one", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.sh("config", "diff.renames", "true");
    await repo.sh("mv", ".spec-gate/commands.yaml", ".spec-gate/moved.yaml");
    const c2 = await repo.commit({}, "rename");
    expect(changedPaths(repo.dir, c1, c2).sort()).toEqual([
      ".spec-gate/commands.yaml",
      ".spec-gate/moved.yaml",
    ]);
  });

  it("is not narrowed by a pathspec: names with glob characters and other case variants are all listed", async () => {
    const { repo, c1 } = await plainHistory();
    const c2 = await repo.commitRaw(
      {
        "a*b": "x\n",
        ".Spec-Gate/y": "y\n",
        ".spec-gate-other/z": "z\n",
      },
      "names",
    );
    expect(changedPaths(repo.dir, c1, c2).sort()).toEqual([
      ".Spec-Gate/y",
      ".spec-gate-other/z",
      "a*b",
    ]);
  });

  it("takes full commit ids only", async () => {
    const { repo, c1 } = await plainHistory();
    expect(codeOf(() => changedPaths(repo.dir, "HEAD", c1))).toBe(
      "not-a-commit",
    );
    expect(codeOf(() => changedPaths(repo.dir, c1, "main"))).toBe(
      "not-a-commit",
    );
  });
});

describe("readBlobAtCommit", () => {
  const FILE = ".spec-gate/commands.yaml";

  it("reads a regular file at the commit, not from the working tree", async () => {
    const { repo, c1 } = await plainHistory();
    fs.writeFileSync(path.join(repo.dir, FILE), "edited: true\n");
    expect(readBlobAtCommit(repo.dir, c1, FILE)).toContain("typecheck");
    const c2 = await repo.commit({ [FILE]: "second: true\n" }, "second");
    expect(readBlobAtCommit(repo.dir, c2, FILE)).toBe("second: true\n");
    expect(readBlobAtCommit(repo.dir, c1, FILE)).toContain("typecheck");
  });

  it("reads an executable file too", async () => {
    const { repo } = await plainHistory();
    fs.writeFileSync(path.join(repo.dir, "run.sh"), "echo\n");
    fs.chmodSync(path.join(repo.dir, "run.sh"), 0o755);
    await repo.sh("add", "run.sh");
    await repo.sh("commit", "-q", "-m", "exec");
    expect(readBlobAtCommit(repo.dir, await repo.head(), "run.sh")).toBe(
      "echo\n",
    );
  });

  it("refuses a symbolic link, whatever it points at", async () => {
    const { repo } = await plainHistory();
    const linked = await repo.commit(
      { [FILE]: { linkTo: "README.md" } },
      "link",
    );
    expect(codeOf(() => readBlobAtCommit(repo.dir, linked, FILE))).toBe(
      "path-not-regular",
    );
  });

  it("refuses a submodule entry and a directory at the path", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.sh("rm", "-q", "--cached", FILE);
    await repo.sh(
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${c1},${FILE}`,
    );
    await repo.sh("commit", "-q", "-m", "gitlink");
    expect(
      codeOf(() => readBlobAtCommit(repo.dir, resolveHead(repo.dir), FILE)),
    ).toBe("path-not-regular");
    const dir = await Repo.create();
    const c = await dir.commit({ [`${FILE}/inner`]: "x\n" }, "a directory");
    expect(codeOf(() => readBlobAtCommit(dir.dir, c, FILE))).toBe(
      "path-not-regular",
    );
  });

  it("does not find a path below a symbolic link", async () => {
    const repo = await Repo.create();
    const linked = await repo.commit(
      {
        "elsewhere/commands.yaml": "commands: {}\n",
        ".spec-gate": { linkTo: "elsewhere" },
      },
      "a directory as a link",
    );
    expect(fs.readFileSync(path.join(repo.dir, FILE), "utf8")).toContain(
      "commands",
    );
    expect(codeOf(() => readBlobAtCommit(repo.dir, linked, FILE))).toBe(
      "path-missing",
    );
  });

  it("a missing path, a bad path and a bad commit are named", async () => {
    const { repo, c1 } = await plainHistory();
    expect(codeOf(() => readBlobAtCommit(repo.dir, c1, "nope.yaml"))).toBe(
      "path-missing",
    );
    for (const bad of ["", "-x", "../x", "a/./b", "a b", "a*", "/abs"]) {
      expect(
        codeOf(() => readBlobAtCommit(repo.dir, c1, bad)),
        bad,
      ).toBe("path-invalid");
    }
    expect(codeOf(() => readBlobAtCommit(repo.dir, "HEAD", FILE))).toBe(
      "not-a-commit",
    );
    expect(codeOf(() => readBlobAtCommit(repo.dir, SHA1, FILE))).toBe(
      "object-unreadable",
    );
  });

  it("refuses bytes that are not UTF-8 and a file over the output cap", async () => {
    const repo = await Repo.create();
    const bad = await repo.commit({}, "empty");
    fs.writeFileSync(
      path.join(repo.dir, "bin.dat"),
      Buffer.from([0xff, 0xfe, 0x41]),
    );
    fs.writeFileSync(
      path.join(repo.dir, "big.txt"),
      "x".repeat(MAX_OUTPUT_BYTES + 1),
    );
    await repo.sh("add", "-A");
    await repo.sh("commit", "-q", "-m", "files");
    const head = await repo.head();
    expect(head).not.toBe(bad);
    expect(codeOf(() => readBlobAtCommit(repo.dir, head, "bin.dat"))).toBe(
      "path-not-utf8",
    );
    expect(codeOf(() => readBlobAtCommit(repo.dir, head, "big.txt"))).toBe(
      "output-too-large",
    );
  });

  it("a blob that the object database lacks is object-unreadable, not an empty file", async () => {
    const { repo, c1 } = await plainHistory();
    const blob = await repo.sh("rev-parse", `${c1}:${FILE}`);
    fs.rmSync(
      path.join(repo.dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)),
    );
    expect(codeOf(() => readBlobAtCommit(repo.dir, c1, FILE))).toBe(
      "object-unreadable",
    );
  });

  it("strips a byte-order mark like the other readers", async () => {
    const { repo } = await plainHistory();
    fs.writeFileSync(path.join(repo.dir, "bom.txt"), "﻿hello\n");
    await repo.sh("add", "-A");
    await repo.sh("commit", "-q", "-m", "bom");
    expect(readBlobAtCommit(repo.dir, await repo.head(), "bom.txt")).toBe(
      "hello\n",
    );
  });
});

describe("git runs scrubbed, bounded and silent", () => {
  const roots: string[] = [];
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    for (const dir of roots.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A `git` first on PATH that logs each call and then runs the real one. */
  function shim(): { log: string } {
    const dir = fs.mkdtempSync(path.join(scratch(), "shim-"));
    roots.push(dir);
    const log = path.join(dir, "calls.log");
    const real = fs.realpathSync(
      ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find(
        (p) => fs.existsSync(p),
      )!,
    );
    fs.writeFileSync(
      path.join(dir, "git"),
      [
        "#!/bin/sh",
        'if [ -n "$SHIM_SLEEP" ]; then exec sleep "$SHIM_SLEEP"; fi',
        'if [ -n "$SHIM_FLOOD" ]; then exec head -c "$SHIM_FLOOD" /dev/zero; fi',
        // a call that holds the argument $SHIM_KILL is killed by a signal
        'if [ -n "$SHIM_KILL" ]; then for a in "$@"; do if [ "$a" = "$SHIM_KILL" ]; then kill -KILL $$; fi; done; fi',
        `printf '%s\\t' "$@" >> "${log}"`,
        `printf '\\n' >> "${log}"`,
        `env | grep '^GIT_' | sort | tr '\\n' ' ' >> "${log}.env"`,
        `printf '\\n' >> "${log}.env"`,
        `exec "${real}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env["PATH"] = `${dir}${path.delimiter}${saved["PATH"] ?? ""}`;
    return { log };
  }

  const calls = (log: string): string[][] =>
    !fs.existsSync(log)
      ? []
      : fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => l.split("\t").slice(0, -1));

  it("drops every GIT_ variable of the caller and sets the five switches, the graft file among them", async () => {
    const { repo, c1 } = await plainHistory();
    const { log } = shim();
    process.env["GIT_DIR"] = "/nonexistent";
    process.env["GIT_WORK_TREE"] = "/nonexistent";
    process.env["GIT_INDEX_FILE"] = "/nonexistent";
    process.env["GIT_NO_REPLACE_OBJECTS"] = "0";
    process.env["GIT_TERMINAL_PROMPT"] = "1";
    expect(isCommit(repo.dir, c1)).toBe(true);
    const envs = fs
      .readFileSync(`${log}.env`, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(envs.length).toBeGreaterThan(0);
    for (const line of envs) {
      expect(line.trim()).toBe(
        `GIT_GRAFT_FILE=${os.devNull} GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0`,
      );
    }
    const env = gitEnv();
    expect(
      Object.keys(env)
        .filter((k) => k.startsWith("GIT_"))
        .sort(),
    ).toEqual([
      "GIT_GRAFT_FILE",
      "GIT_NO_LAZY_FETCH",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_OPTIONAL_LOCKS",
      "GIT_TERMINAL_PROMPT",
    ]);
    expect(env["GIT_GRAFT_FILE"]).toBe(os.devNull);
  });

  it("every call carries the same four overrides right after -C <dir>, before the subcommand", async () => {
    const { repo, c0, c1 } = await plainHistory();
    const { log } = shim();
    const R = repo.dir;
    resolveRef(R, "refs/heads/main");
    resolveHead(R);
    isCommit(R, c1);
    isAncestor(R, c0, c1);
    mergeBase(R, c0, c1);
    changedPaths(R, c0, c1);
    readBlobAtCommit(R, c1, ".spec-gate/commands.yaml");
    const recorded = calls(log);
    expect(recorded.length).toBeGreaterThan(8);
    for (const call of recorded) {
      expect(call.slice(0, 2)).toEqual(["-C", R]);
      expect(call.slice(2, 2 + OVERRIDES.length), call.join(" ")).toEqual(
        OVERRIDES,
      );
    }
  });

  it("a git stopped by a signal is git-failed, never a refusal: not false, not 'no merge base'", async () => {
    const { repo, c0, c1 } = await plainHistory();
    shim();
    process.env["SHIM_KILL"] = "--is-ancestor";
    expect(codeOf(() => isAncestor(repo.dir, c0, c1))).toBe("git-failed");
    process.env["SHIM_KILL"] = "merge-base";
    expect(codeOf(() => mergeBase(repo.dir, c0, c1))).toBe("git-failed");
    process.env["SHIM_KILL"] = "rev-parse";
    expect(codeOf(() => isCommit(repo.dir, c1))).toBe("git-failed");
    expect(codeOf(() => runGit(repo.dir, ["rev-parse", "HEAD"]))).toBe(
      "git-failed",
    );
    process.env["SHIM_KILL"] = "ls-tree";
    expect(
      codeOf(() => readBlobAtCommit(repo.dir, c1, ".spec-gate/commands.yaml")),
    ).toBe("git-failed");
    // the same git, not killed, answers
    delete process.env["SHIM_KILL"];
    expect(isAncestor(repo.dir, c0, c1)).toBe(true);
  });

  it("every primitive passes --end-of-options before the values it was given", async () => {
    const { repo, c0, c1 } = await plainHistory();
    const { log } = shim();
    const R = repo.dir;
    const run = (fn: () => unknown): string[][] => {
      fs.rmSync(log, { force: true });
      fn();
      return calls(log).map((c) => c.slice(2 + OVERRIDES.length)); // without -C <dir> and the overrides
    };
    expect(run(() => isCommit(R, c1))).toEqual([
      ["rev-parse", "--verify", "--end-of-options", `${c1}^{commit}`],
    ]);
    // a value that is no full id never reaches git
    expect(run(() => isCommit(R, "HEAD"))).toEqual([]);
    expect(run(() => isCommit(R, c1.slice(0, 12)))).toEqual([]);
    expect(run(() => isAncestor(R, c0, c1))).toEqual([
      ["merge-base", "--is-ancestor", "--end-of-options", c0, c1],
    ]);
    expect(run(() => mergeBase(R, c0, c1))).toEqual([
      ["merge-base", "--end-of-options", c0, c1],
    ]);
    expect(run(() => changedPaths(R, c0, c1))).toEqual([
      [
        "diff-tree",
        "-r",
        "--name-only",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--end-of-options",
        c0,
        c1,
      ],
    ]);
    const blobCalls = run(() =>
      readBlobAtCommit(R, c1, ".spec-gate/commands.yaml"),
    );
    expect(blobCalls).toHaveLength(2);
    expect(blobCalls[0]).toEqual([
      "ls-tree",
      "-z",
      "--full-tree",
      "--end-of-options",
      c1,
      "--",
      ".spec-gate/commands.yaml",
    ]);
    expect(blobCalls[1]!.slice(0, 3)).toEqual([
      "cat-file",
      "blob",
      "--end-of-options",
    ]);
    expect(blobCalls[1]![3]).toMatch(/^[0-9a-f]{40}$/);
    expect(run(() => resolveRef(R, "refs/heads/main"))).toEqual([
      ["check-ref-format", "refs/heads/main"],
      ["show-ref", "--verify", "--hash", "--end-of-options", "refs/heads/main"],
      ["rev-parse", "--verify", "--end-of-options", `${c1}^{commit}`],
    ]);
    expect(run(() => resolveHead(R))[0]).toEqual([
      "rev-parse",
      "--verify",
      "--end-of-options",
      "HEAD^{commit}",
    ]);
  });

  it("a git that does not finish in time is git-failed, and the message names no argument or path", async () => {
    const { repo } = await plainHistory();
    shim();
    process.env["SHIM_SLEEP"] = "10";
    const started = Date.now();
    let caught: unknown;
    try {
      runGit(repo.dir, ["rev-parse", "HEAD"], 300);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LintGitError);
    expect((caught as LintGitError).code).toBe("git-failed");
    expect((caught as LintGitError).message).not.toContain(repo.dir);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(GIT_TIMEOUT_MS).toBe(30_000);
  });

  it("output over the cap is output-too-large", async () => {
    const { repo } = await plainHistory();
    shim();
    process.env["SHIM_FLOOD"] = String(MAX_OUTPUT_BYTES + 1024);
    expect(codeOf(() => runGit(repo.dir, ["rev-parse", "HEAD"]))).toBe(
      "output-too-large",
    );
  });

  it("a failure never carries git's own words, an argument or a path", async () => {
    const dir = scratch();
    let caught: unknown;
    try {
      mergeBase(dir, SHA1, SHA1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LintGitError);
    const message = (caught as LintGitError).message;
    expect(message).not.toContain(dir);
    expect(message).not.toContain(SHA1);
    expect(message.toLowerCase()).not.toContain("fatal");
    expect(message.toLowerCase()).not.toContain("not a git repository");
  });
});

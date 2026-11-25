import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseBindingsLog,
  serializeNextBind,
  serializeProposeEntry,
  sha256Tag,
  type Binding,
} from "../../src/formats/index.js";
import { lintSpecDir } from "../../src/lint/index.js";
import {
  REMOTE_MAIN,
  SPEC_REL,
  skipReasonOf,
  type Repo,
} from "./git-helpers.js";
import {
  BIND_BINDINGS,
  bindOk,
  codesOf,
  commitSpec,
  draftRepo,
  lintGit,
  ofLogRule,
  proposedRepo,
  readSpec,
  writeSpec,
} from "../state/helpers.js";

/** A log of the propose entry and the given bind entries, chained correctly. */
function forgedLog(
  commit: string,
  bindingsHash: string,
  binds: [string, Binding][] = [],
): string {
  let text = `${serializeProposeEntry(commit, bindingsHash)}\n`;
  for (const [tp, binding] of binds) {
    const parsed = parseBindingsLog(text);
    if (!parsed.ok) throw new Error(parsed.problem.message);
    text += `${serializeNextBind(parsed.value, tp, binding)}\n`;
  }
  return text;
}

/** The bindings-log codes of a lint of the spec directory at `rel`, with the job's git inputs. */
function codesAt(
  repo: Repo,
  rel: string,
  final = false,
): (string | undefined)[] {
  const result = lintSpecDir(path.join(repo.dir, rel), {
    final,
    git: { repo: repo.dir, defaultRef: REMOTE_MAIN },
  });
  if (!result.ok) throw new Error(result.message);
  return ofLogRule(result.report).map((f) => f.code);
}

/** `git mv` of a directory to a place whose parent may not exist yet. */
async function moveDir(repo: Repo, from: string, to: string): Promise<void> {
  fs.mkdirSync(path.dirname(path.join(repo.dir, to)), { recursive: true });
  await repo.sh("mv", from, to);
}

const setStatus = (dir: string, from: string, to: string): void => {
  const file = path.join(dir, "spec.md");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace(`status: ${from}`, `status: ${to}`),
  );
};

/**
 * A repository whose default branch holds the spec at `at`, proposed with a
 * log. The files are written by hand, as a merge that skipped the lint would
 * leave them: propose refuses a place that is not `specs/<name>`.
 */
async function mergedAt(at: string): Promise<Repo> {
  const { repo } = await draftRepo();
  if (at !== SPEC_REL) await moveDir(repo, SPEC_REL, at);
  const draft = await commitSpec(repo, "the draft in its place");
  const dir = path.join(repo.dir, at);
  setStatus(dir, "draft", "proposed");
  fs.writeFileSync(
    path.join(dir, "bindings.log"),
    forgedLog(draft, sha256Tag(BIND_BINDINGS)),
  );
  const merged = await commitSpec(repo, "proposed");
  await repo.setRef(REMOTE_MAIN, merged);
  await repo.checkout("later", merged);
  return repo;
}

/**
 * Moves the merged spec from `from` to `to` on the branch, with a hand edit
 * of bindings.yaml and a fresh log anchored at a draft commit after the move.
 */
async function moveWithFreshLog(
  repo: Repo,
  from: string,
  to: string,
): Promise<void> {
  await moveDir(repo, from, to);
  const dir = path.join(repo.dir, to);
  const edited = BIND_BINDINGS.replace("rejects old token", "anything");
  fs.writeFileSync(path.join(dir, "bindings.yaml"), edited);
  fs.rmSync(path.join(dir, "bindings.log"));
  setStatus(dir, "proposed", "draft");
  const anchor = await commitSpec(repo, "move, edit, back to draft");
  setStatus(dir, "draft", "proposed");
  fs.writeFileSync(
    path.join(dir, "bindings.log"),
    forgedLog(anchor, sha256Tag(edited)),
  );
  await commitSpec(repo, "fresh log");
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

/** A tree of 45000 long names: its listing is far over the 4 MiB git output cap. */
function bigTree(repo: Repo): string {
  const blob = plumb(repo, ["rev-parse", "HEAD:README.md"]);
  const pad = "x".repeat(90);
  const entries = Array.from(
    { length: 45_000 },
    (_, i) => `100644 blob ${blob}\t${pad}${String(i).padStart(6, "0")}\n`,
  ).join("");
  return plumb(repo, ["mktree"], entries);
}

/** The tree `treeish` with the entry `name` set to the tree `child`. */
function graft(
  repo: Repo,
  treeish: string,
  name: string,
  child: string,
): string {
  const kept = plumb(repo, ["ls-tree", treeish])
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith(`\t${name}`));
  const lines = [...kept, `040000 tree ${child}\t${name}`];
  return plumb(repo, ["mktree"], `${lines.join("\n")}\n`);
}

/**
 * Makes `tree` the commit at HEAD and at the reference, so it is the diff
 * base; the work tree keeps the spec directory as it is.
 */
async function commitTreeAsBase(repo: Repo, tree: string): Promise<void> {
  const head = plumb(repo, ["commit-tree", tree, "-p", "HEAD", "-m", "big"]);
  await repo.sh("update-ref", "HEAD", head);
  await repo.setRef(REMOTE_MAIN, head);
}

describe("the bindings-log rule", { timeout: 60_000 }, () => {
  it("a proposed spec with its log, and one bind later, passes", async () => {
    const { repo } = await proposedRepo();
    expect(codesOf(lintGit(repo))).toEqual([]);
    expect(skipReasonOf(lintGit(repo), "bindings-log")).toBeUndefined();
    bindOk(repo, "TP-1", { status: "new", selector: "a new name" });
    await commitSpec(repo, "bind");
    const report = lintGit(repo);
    expect(report.errors).toEqual([]);
    expect(lintGit(repo, { final: true }).errors).toEqual([]);
  });

  it("a draft without a log reports nothing, also under --final", async () => {
    const { repo } = await draftRepo();
    const final = lintGit(repo, { final: true });
    expect(skipReasonOf(final, "bindings-log")).toBeUndefined();
    expect(final.errors).toEqual([]);
    expect(skipReasonOf(lintGit(repo), "bindings-log")).toBe("gate");
  });

  it("a proposed spec without a log is an error", async () => {
    const { repo } = await proposedRepo();
    fs.rmSync(path.join(repo.spec, "bindings.log"));
    await commitSpec(repo, "drop the log");
    expect(codesOf(lintGit(repo))).toEqual(["log-missing"]);
  });

  it("a hand edit of bindings.yaml after propose is a replay mismatch, read against git and not the work tree", async () => {
    const { repo } = await proposedRepo();
    writeSpec(
      repo,
      "bindings.yaml",
      BIND_BINDINGS.replace("rejects old token", "anything at all"),
    );
    await commitSpec(repo, "hand edit");
    const found = ofLogRule(lintGit(repo));
    expect(found).toEqual([
      expect.objectContaining({
        file: "bindings.yaml",
        path: "TP-1",
        id: "TP-1",
        code: "replay-mismatch",
        level: "error",
      }),
    ]);
  });

  it("a rewritten earlier line, a reordered log and a broken sequence break the log", async () => {
    const { repo } = await proposedRepo();
    bindOk(repo, "TP-1", { status: "new", selector: "one" });
    bindOk(repo, "TP-1", { status: "new", selector: "two" });
    await commitSpec(repo, "two binds");
    const lines = readSpec(repo, "bindings.log").trimEnd().split("\n");

    const rewritten = [...lines];
    rewritten[1] = rewritten[1]!.replace('"one"', '"uno"');
    writeSpec(repo, "bindings.log", `${rewritten.join("\n")}\n`);
    expect(codesOf(lintGit(repo))).toEqual(["log-chain"]);

    const reordered = [
      lines[0]!,
      lines[2]!.replace('"seq":3', '"seq":2'),
      lines[1]!.replace('"seq":2', '"seq":3'),
    ];
    writeSpec(repo, "bindings.log", `${reordered.join("\n")}\n`);
    expect(codesOf(lintGit(repo))).toEqual(["log-chain"]);

    writeSpec(repo, "bindings.log", `${[lines[0], lines[2]].join("\n")}\n`);
    expect(codesOf(lintGit(repo))).toEqual(["log-seq"]);

    writeSpec(
      repo,
      "bindings.log",
      `${lines.join("\n")}\n`.replace('"kind":"bind"', '"kind":"rebind"'),
    );
    expect(codesOf(lintGit(repo))).toEqual(["log-entry-shape"]);

    // an extra key in a bind entry, everything else as written
    writeSpec(
      repo,
      "bindings.log",
      `${lines.join("\n")}\n`.replace(
        '"kind":"bind"',
        '"kind":"bind","by":"me"',
      ),
    );
    expect(codesOf(lintGit(repo))).toEqual(["log-entry-shape"]);

    writeSpec(repo, "bindings.log", `${lines.join("\r\n")}\r\n`);
    expect(codesOf(lintGit(repo))).toEqual(["log-line-ending"]);

    // the reader drops a leading byte order mark, as for every spec file
    writeSpec(repo, "bindings.log", `\uFEFF${lines.join("\n")}\n`);
    expect(codesOf(lintGit(repo))).toEqual([]);
  });

  it("a propose commit that is not a commit, or not an ancestor of HEAD, binds nothing", async () => {
    const { repo, draft } = await proposedRepo();
    const hash = sha256Tag(BIND_BINDINGS);
    writeSpec(repo, "bindings.log", forgedLog("f".repeat(40), hash));
    await commitSpec(repo, "unknown commit");
    expect(codesOf(lintGit(repo))).toEqual(["propose-not-a-commit"]);

    // a commit on a branch of its own with the same bindings.yaml
    const pr = (await repo.sh("rev-parse", "--abbrev-ref", "HEAD")).trim();
    await repo.checkout("side", draft);
    const side = await repo.commit({ "side.txt": "x\n" }, "side");
    await repo.checkout(pr);
    writeSpec(repo, "bindings.log", forgedLog(side, hash));
    await commitSpec(repo, "side commit");
    expect(codesOf(lintGit(repo))).toEqual(["propose-not-ancestor"]);
  });

  it("the hash in the propose entry must be that of bindings.yaml at the propose commit, which must hold one", async () => {
    const { repo, draft } = await proposedRepo();
    writeSpec(repo, "bindings.log", forgedLog(draft, sha256Tag("other\n")));
    await commitSpec(repo, "wrong hash");
    expect(codesOf(lintGit(repo))).toEqual(["propose-hash-mismatch"]);

    const before = await repo.sh("rev-parse", `${draft}~1`);
    writeSpec(repo, "bindings.log", forgedLog(before, sha256Tag("x")));
    await commitSpec(repo, "commit without the spec");
    expect(codesOf(lintGit(repo))).toEqual([
      "propose-bindings-missing",
      "propose-not-draft",
    ]);
  });

  it("a bind entry for a TP ID that bindings.yaml did not have at the propose commit", async () => {
    const { repo, draft } = await proposedRepo();
    const extra: Binding = { status: "new", fixtures: [] };
    writeSpec(
      repo,
      "bindings.log",
      forgedLog(draft, sha256Tag(BIND_BINDINGS), [["TP-7", extra]]),
    );
    writeSpec(repo, "bindings.yaml", `${BIND_BINDINGS}TP-7:\n  status: new\n`);
    await commitSpec(repo, "a new id through the log");
    const found = ofLogRule(lintGit(repo));
    expect(found.map((f) => [f.code, f.line])).toEqual([
      ["bind-unknown-id", 2],
    ]);
  });

  it("a log that was merged is never rewritten, even with a recomputed chain", async () => {
    const { repo, draft } = await proposedRepo();
    bindOk(repo, "TP-1", { status: "new", selector: "merged name" });
    const merged = await commitSpec(repo, "bind");
    // the spec pull request is merged: the default branch is at its head
    await repo.setRef(REMOTE_MAIN, merged);
    await repo.checkout("later", merged);
    const binding: Binding = {
      status: "new",
      selector: "quietly changed",
      file: "test/auth.test.ts",
      fixtures: [],
    };
    writeSpec(
      repo,
      "bindings.log",
      forgedLog(draft, sha256Tag(BIND_BINDINGS), [["TP-1", binding]]),
    );
    writeSpec(
      repo,
      "bindings.yaml",
      BIND_BINDINGS.replace("rejects old token", "quietly changed"),
    );
    await commitSpec(repo, "rewrite history");
    expect(codesOf(lintGit(repo))).toEqual(["log-rewritten"]);

    // removing the merged log is refused, also at draft under --final
    await repo.checkout("gone", merged);
    fs.rmSync(path.join(repo.spec, "bindings.log"));
    writeSpec(
      repo,
      "spec.md",
      readSpec(repo, "spec.md").replace("status: proposed", "status: draft"),
    );
    await commitSpec(repo, "drop the merged log");
    expect(codesOf(lintGit(repo, { final: true }))).toEqual(["log-removed"]);

    // appending to the merged log is fine
    await repo.checkout("next", merged);
    bindOk(repo, "TP-1", { status: "existing", selector: "now it exists" });
    await commitSpec(repo, "append");
    // every error of the report, not only this rule's: binding-status takes
    // the red-first row at existing because the log holds its bind entry
    expect(lintGit(repo).errors).toEqual([]);
  });

  it("a spec directory renamed after its log was merged, with a forged fresh log, fails", async () => {
    const { repo } = await proposedRepo();
    bindOk(repo, "TP-1", { status: "new", selector: "merged name" });
    const merged = await commitSpec(repo, "bind");
    await repo.setRef(REMOTE_MAIN, merged);
    await repo.checkout("rename", merged);
    await repo.sh("mv", "specs/s1", "specs/s2");
    const moved = path.join(repo.dir, "specs", "s2");
    const edited = BIND_BINDINGS.replace("rejects old token", "anything");
    fs.writeFileSync(path.join(moved, "bindings.yaml"), edited);
    fs.rmSync(path.join(moved, "bindings.log"));
    const c1 = await commitSpec(repo, "rename and edit");
    fs.writeFileSync(
      path.join(moved, "bindings.log"),
      forgedLog(c1, sha256Tag(edited)),
    );
    await commitSpec(repo, "fresh log");
    for (const final of [false, true]) {
      const result = lintSpecDir(moved, {
        final,
        git: { repo: repo.dir, defaultRef: REMOTE_MAIN },
      });
      if (!result.ok) throw new Error(result.message);
      const codes = ofLogRule(result.report).map((f) => f.code);
      expect(codes, `final ${final}`).toContain("spec-moved");
      expect(codes, `final ${final}`).toContain("log-rewritten");
    }
  });

  it("a bind entry that breaks its row's kind rule: stays-green to new, red-first back from existing to new", async () => {
    const { repo, draft } = await proposedRepo();
    const tp1 = {
      selector: "rejects old token",
      file: "test/auth.test.ts",
      fixtures: [],
    };
    const tp2: Binding = {
      status: "new",
      selector: "login works",
      fixtures: [],
    };
    writeSpec(
      repo,
      "bindings.log",
      forgedLog(draft, sha256Tag(BIND_BINDINGS), [
        ["TP-2", tp2],
        ["TP-1", { status: "existing", ...tp1 }],
        ["TP-1", { status: "new", ...tp1 }],
      ]),
    );
    writeSpec(
      repo,
      "bindings.yaml",
      BIND_BINDINGS.replace(
        "TP-2:\n  status: existing",
        "TP-2:\n  status: new",
      ),
    );
    await commitSpec(repo, "forged kind changes");
    expect(ofLogRule(lintGit(repo)).map((f) => [f.code, f.line])).toEqual([
      ["bind-kind", 2],
      ["bind-kind", 4],
    ]);
  });

  it("a propose entry that names a commit where the spec was no longer a draft or already had a log", async () => {
    const { repo, proposed } = await proposedRepo();
    writeSpec(
      repo,
      "bindings.log",
      forgedLog(proposed, sha256Tag(BIND_BINDINGS)),
    );
    await commitSpec(repo, "re-anchor");
    expect(codesOf(lintGit(repo))).toEqual([
      "propose-log-present",
      "propose-not-draft",
    ]);
  });

  it("a log that is not a regular file at proposed is an error", async () => {
    const { repo } = await proposedRepo();
    fs.rmSync(path.join(repo.spec, "bindings.log"));
    fs.mkdirSync(path.join(repo.spec, "bindings.log"));
    expect(codesOf(lintGit(repo))).toEqual(["input-not-regular"]);
  });

  it("bindings.yaml that does not parse at the propose commit", async () => {
    const { repo } = await draftRepo();
    const broken = "- not a mapping\n";
    writeSpec(repo, "bindings.yaml", broken);
    const anchor = await commitSpec(repo, "broken bindings");
    writeSpec(repo, "bindings.yaml", BIND_BINDINGS);
    writeSpec(
      repo,
      "spec.md",
      readSpec(repo, "spec.md").replace("status: draft", "status: proposed"),
    );
    writeSpec(repo, "bindings.log", forgedLog(anchor, sha256Tag(broken)));
    await commitSpec(repo, "proposed on a broken file");
    expect(codesOf(lintGit(repo))).toEqual(["propose-bindings-invalid"]);
  });

  it("bindings.yaml deleted after propose is a replay mismatch", async () => {
    const { repo } = await proposedRepo();
    fs.rmSync(path.join(repo.spec, "bindings.yaml"));
    await commitSpec(repo, "delete bindings");
    expect(ofLogRule(lintGit(repo))).toEqual([
      expect.objectContaining({
        file: "bindings.yaml",
        path: "$",
        code: "replay-mismatch",
      }),
    ]);
  });

  it("a git read that cannot run is a finding with its code, not an exception", async () => {
    const { repo, draft } = await proposedRepo();
    // A directory name the git reads refuse: the files are written by hand,
    // as propose refuses such a path.
    const odd = path.join(repo.dir, "specs", "s 1");
    fs.cpSync(repo.spec, odd, { recursive: true });
    fs.writeFileSync(
      path.join(odd, "bindings.log"),
      forgedLog(draft, sha256Tag(BIND_BINDINGS)),
    );
    await commitSpec(repo, "odd path");
    const result = lintSpecDir(odd, {
      git: { repo: repo.dir, defaultRef: REMOTE_MAIN },
    });
    if (!result.ok) throw new Error(result.message);
    expect(ofLogRule(result.report).map((f) => f.code)).toEqual([
      "path-invalid",
    ]);
  });

  it("a proposed spec without a log that the pull request moves is spec-moved", async () => {
    const { repo } = await draftRepo();
    writeSpec(
      repo,
      "spec.md",
      readSpec(repo, "spec.md").replace("status: draft", "status: proposed"),
    );
    const merged = await commitSpec(repo, "proposed without a log");
    await repo.setRef(REMOTE_MAIN, merged);
    await repo.checkout("move", merged);
    await repo.sh("mv", "specs/s1", "specs/s2");
    await commitSpec(repo, "move");
    const result = lintSpecDir(path.join(repo.dir, "specs", "s2"), {
      git: { repo: repo.dir, defaultRef: REMOTE_MAIN },
    });
    if (!result.ok) throw new Error(result.message);
    expect(ofLogRule(result.report).map((f) => f.code)).toContain("spec-moved");
  });

  it("a merged log that is not UTF-8 is never extended", async () => {
    const { repo } = await proposedRepo();
    const good = readSpec(repo, "bindings.log");
    fs.writeFileSync(
      path.join(repo.spec, "bindings.log"),
      Buffer.concat([Buffer.from(good), Buffer.from([0xff, 0x0a])]),
    );
    const merged = await commitSpec(repo, "broken bytes");
    await repo.setRef(REMOTE_MAIN, merged);
    await repo.checkout("later", merged);
    writeSpec(repo, "bindings.log", good);
    await commitSpec(repo, "valid again");
    expect(codesOf(lintGit(repo))).toContain("log-rewritten");
  });

  it("a symlinked spec.md at the diff base, outside or inside specs/, does not fail the lint", async () => {
    const { repo } = await proposedRepo();
    const merged = await repo.commit(
      {
        "docs/spec.md": { linkTo: "../README.md" },
        "specs/other/spec.md": { linkTo: "../../README.md" },
      },
      "links named spec.md",
    );
    await repo.setRef(REMOTE_MAIN, merged);
    expect(codesOf(lintGit(repo))).toEqual([]);
  });

  it("a large tree outside specs/ at the diff base does not fail the lint", async () => {
    const { repo } = await proposedRepo();
    // A whole-tree listing of this commit is far over the git output cap; it
    // is built without a work tree.
    const tree = graft(repo, "HEAD^{tree}", "big", bigTree(repo));
    await commitTreeAsBase(repo, tree);
    expect(codesOf(lintGit(repo))).toEqual([]);
  });

  it("a large evidence tree inside a spec directory at the diff base does not fail the lint", async () => {
    const { repo } = await proposedRepo();
    // specs/s1/evidence/ holds the 45000 files: a listing of everything
    // below specs/ is over the cap, the listing of specs/ itself is one line.
    const s1 = graft(repo, `HEAD:${SPEC_REL}`, "evidence", bigTree(repo));
    const specs = graft(repo, "HEAD:specs", "s1", s1);
    await commitTreeAsBase(repo, graft(repo, "HEAD^{tree}", "specs", specs));
    expect(codesOf(lintGit(repo))).toEqual([]);
  });

  it("a spec directory that is not specs/<name> is spec-off-layout, at proposed and at draft under --final", async () => {
    for (const where of ["other/s1", "specs/group/s1", "s1top"]) {
      const { repo } = await proposedRepo();
      await moveDir(repo, SPEC_REL, where);
      await commitSpec(repo, "move");
      expect(codesAt(repo, where), where).toEqual(["spec-off-layout"]);
      expect(codesAt(repo, where, true), where).toEqual(["spec-off-layout"]);
    }
    const { repo } = await draftRepo();
    await moveDir(repo, SPEC_REL, "other/s1");
    await commitSpec(repo, "a draft elsewhere");
    expect(codesAt(repo, "other/s1", true)).toEqual(["spec-off-layout"]);
    // without --final the gate skips the rule at draft
    expect(codesAt(repo, "other/s1")).toEqual([]);
  });

  it("a proposed spec merged outside specs/ never passes, where it is or after a move to another such place", async () => {
    // control: the same hand-written state in specs/<name> is clean
    expect(codesAt(await mergedAt(SPEC_REL), SPEC_REL)).toEqual([]);

    for (const [from, to] of [
      ["s1top", "s2top"],
      ["other/s1", "other/s2"],
    ] as const) {
      const repo = await mergedAt(from);
      for (const final of [false, true]) {
        expect(codesAt(repo, from, final), from).toEqual(["spec-off-layout"]);
      }
      await moveWithFreshLog(repo, from, to);
      for (const final of [false, true]) {
        expect(codesAt(repo, to, final), to).toEqual(["spec-off-layout"]);
      }
    }
  });

  it("a merged spec moved out of specs/ with a forged fresh log is spec-off-layout", async () => {
    const repo = await mergedAt(SPEC_REL);
    await moveWithFreshLog(repo, SPEC_REL, "other/s1");
    for (const final of [false, true]) {
      expect(codesAt(repo, "other/s1", final)).toEqual(["spec-off-layout"]);
    }
  });

  it("without git inputs the rule is skipped (no-git), and under --final that is a rule-skipped error", async () => {
    const { repo } = await proposedRepo();
    const plain = lintSpecDir(repo.spec, {});
    const final = lintSpecDir(repo.spec, { final: true });
    if (!plain.ok || !final.ok) throw new Error("usage error");
    expect(skipReasonOf(plain.report, "bindings-log")).toBe("no-git");
    expect(skipReasonOf(final.report, "bindings-log")).toBe("no-git");
    expect(
      final.report.errors
        .filter((f) => f.rule === "rule-skipped")
        .map((f) => f.id),
    ).toContain("bindings-log");
    expect(
      plain.report.errors.filter((f) => f.rule === "rule-skipped"),
    ).toEqual([]);
  });
});

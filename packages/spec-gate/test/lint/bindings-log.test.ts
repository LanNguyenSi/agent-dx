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
import { REMOTE_MAIN, skipReasonOf } from "./git-helpers.js";
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
    expect(codesOf(lintGit(repo))).toEqual(["propose-bindings-missing"]);
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
    expect(codesOf(lintGit(repo))).toEqual([]);
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

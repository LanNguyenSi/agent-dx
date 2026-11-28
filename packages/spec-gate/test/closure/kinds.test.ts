/**
 * The per-kind rules of the closing check, one case per state a rule can
 * produce, and the producer marks.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClosure } from "../../src/closure/index.js";
import { REMOTE_MAIN, Repo } from "../lint/git-helpers.js";
import {
  COMMANDS,
  PLAN,
  closureIn,
  closureSpecFiles,
  reportIn,
  rowOf,
  scenario,
  writeEvidence,
  type EnvelopeFields,
  type Scenario,
} from "./helpers.js";

// The base no-unused-vars rule reads the names in a signature as variables.
// eslint-disable-next-line no-unused-vars
type Build = (s: Scenario) => EnvelopeFields[];

async function verdict(tp: string, build: Build | null) {
  const s = await scenario();
  if (build !== null) writeEvidence(s.repo, tp, build(s));
  const row = rowOf(reportIn(s), tp);
  return { state: row.state, reason: row.reason };
}

describe("closure: stays-green", { timeout: 60_000 }, () => {
  it("is proven with a pass at the start commit and a pass last", async () => {
    expect(
      await verdict("TP-2", (s) => [{ commit: s.spec }, { commit: s.b }]),
    ).toEqual({ state: "proven", reason: "pass-at-start-and-latest-pass" });
  });

  it("fails when the latest counted envelope is a fail, after a pass", async () => {
    expect(
      await verdict("TP-2", (s) => [
        { commit: s.spec },
        { commit: s.b, result: "fail" },
      ]),
    ).toEqual({ state: "failed", reason: "latest-fail" });
  });

  it("fails when the latest counted envelope is an error", async () => {
    expect(
      await verdict("TP-2", (s) => [
        { commit: s.spec },
        { commit: s.a, result: "error" },
      ]),
    ).toEqual({ state: "failed", reason: "latest-error" });
  });

  it("is unproven without a pass at the start commit", async () => {
    expect(
      await verdict("TP-2", (s) => [{ commit: s.a }, { commit: s.b }]),
    ).toEqual({ state: "unproven", reason: "no-pass-at-start" });
  });

  it("is unproven with only skips", async () => {
    expect(
      await verdict("TP-2", (s) => [
        { commit: s.spec, result: "skip", command: [] },
        { commit: s.b, result: "skip", command: [] },
      ]),
    ).toEqual({ state: "unproven", reason: "latest-skip" });
  });

  it("is unproven without an evidence file", async () => {
    expect(await verdict("TP-2", null)).toEqual({
      state: "unproven",
      reason: "no-evidence-file",
    });
  });

  it("orders by ancestry, not by time or line: an older commit written later is earlier", async () => {
    expect(
      await verdict("TP-2", (s) => [
        { commit: s.b, result: "fail", time: "2026-01-01T00:00:00Z" },
        { commit: s.spec, time: "2026-02-01T00:00:00Z" },
      ]),
    ).toEqual({ state: "failed", reason: "latest-fail" });
  });

  it("orders by time at one commit", async () => {
    expect(
      await verdict("TP-2", (s) => [
        { commit: s.spec, time: "2026-01-01T00:00:02Z" },
        { commit: s.spec, result: "fail", time: "2026-01-01T00:00:01Z" },
      ]),
    ).toEqual({ state: "proven", reason: "pass-at-start-and-latest-pass" });
  });

  it("carries probe: not-checked", async () => {
    const s = await scenario();
    expect(rowOf(reportIn(s), "TP-2").probe).toBe("not-checked");
  });

  it("is unproven when counted envelopes lie on two unrelated branches merged into the head", async () => {
    const s = await scenario();
    await s.repo.checkout("p1", s.spec);
    const p = await s.repo.commit({ "p1.txt": "1\n" }, "p1");
    await s.repo.checkout("p2", s.spec);
    const q = await s.repo.commit({ "p2.txt": "2\n" }, "p2");
    await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge p1", "p1");
    writeEvidence(s.repo, "TP-2", [
      { commit: s.spec },
      { commit: p },
      { commit: q, result: "fail" },
    ]);
    const row = rowOf(reportIn(s), "TP-2");
    expect(row.counted).toBe(3);
    expect({ state: row.state, reason: row.reason }).toEqual({
      state: "unproven",
      reason: "unordered-evidence",
    });
  });

  it("orders by line at one commit and one time", async () => {
    expect(
      await verdict("TP-2", (s) => [
        { commit: s.spec, result: "fail", time: "2026-01-01T00:00:00Z" },
        { commit: s.spec, time: "2026-01-01T00:00:00Z" },
      ]),
    ).toEqual({ state: "proven", reason: "pass-at-start-and-latest-pass" });
    expect(
      await verdict("TP-2", (s) => [
        { commit: s.spec, time: "2026-01-01T00:00:00Z" },
        { commit: s.spec, result: "fail", time: "2026-01-01T00:00:00Z" },
      ]),
    ).toEqual({ state: "failed", reason: "latest-fail" });
  });

  it("is unproven when an envelope with a time that does not parse shares its commit with another", async () => {
    expect(
      await verdict("TP-2", (s) => [
        { commit: s.spec, result: "fail" },
        { commit: s.spec, time: "2026-99-99T99:99:99Z" },
      ]),
    ).toEqual({ state: "unproven", reason: "unordered-evidence" });
  });

  it("orders an envelope with a time that does not parse by its commit alone", async () => {
    expect(
      await verdict("TP-2", (s) => [
        { commit: s.spec },
        { commit: s.b, time: "2026-99-99T99:99:99Z" },
      ]),
    ).toEqual({ state: "proven", reason: "pass-at-start-and-latest-pass" });
  });
});

describe("closure: red-first", { timeout: 60_000 }, () => {
  it("is proven with a fail followed by a pass, the pass last", async () => {
    expect(
      await verdict("TP-1", (s) => [
        { commit: s.a, result: "fail" },
        { commit: s.b },
      ]),
    ).toEqual({ state: "proven", reason: "red-then-green" });
  });

  it("is unproven green without red", async () => {
    expect(
      await verdict("TP-1", (s) => [{ commit: s.a }, { commit: s.b }]),
    ).toEqual({ state: "unproven", reason: "no-red" });
  });

  it("does not count an error as red", async () => {
    expect(
      await verdict("TP-1", (s) => [
        { commit: s.a, result: "error" },
        { commit: s.b },
      ]),
    ).toEqual({ state: "unproven", reason: "no-red" });
  });

  it("fails when no pass follows the last fail", async () => {
    expect(
      await verdict("TP-1", (s) => [
        { commit: s.spec, result: "fail" },
        { commit: s.a },
        { commit: s.b, result: "fail" },
      ]),
    ).toEqual({ state: "failed", reason: "no-green-after-red" });
  });

  it("fails when an error follows the green", async () => {
    expect(
      await verdict("TP-1", (s) => [
        { commit: s.spec, result: "fail" },
        { commit: s.a },
        { commit: s.b, result: "error" },
      ]),
    ).toEqual({ state: "failed", reason: "latest-error" });
  });

  it("is unproven for a fail and a later pass at one commit", async () => {
    expect(
      await verdict("TP-1", (s) => [
        { commit: s.b, result: "fail", time: "2026-01-01T00:00:01Z" },
        { commit: s.b, time: "2026-01-01T00:00:02Z" },
      ]),
    ).toEqual({ state: "unproven", reason: "red-and-green-at-one-commit" });
  });

  it("is unproven for a pass and a later fail at one commit", async () => {
    expect(
      await verdict("TP-1", (s) => [
        { commit: s.b, time: "2026-01-01T00:00:01Z" },
        { commit: s.b, result: "fail", time: "2026-01-01T00:00:02Z" },
      ]),
    ).toEqual({ state: "unproven", reason: "red-and-green-at-one-commit" });
  });

  it("is proven when the green at a later commit follows a red with a rerun at one commit", async () => {
    expect(
      await verdict("TP-1", (s) => [
        { commit: s.a, result: "fail", time: "2026-01-01T00:00:01Z" },
        { commit: s.a, time: "2026-01-01T00:00:02Z" },
        { commit: s.b, time: "2026-01-01T00:00:03Z" },
      ]),
    ).toEqual({ state: "proven", reason: "red-then-green" });
  });

  it("is unproven with nothing counted", async () => {
    expect(
      await verdict("TP-1", (s) => [{ commit: s.a, dirty: true }]),
    ).toEqual({ state: "unproven", reason: "no-counted-evidence" });
  });

  it("carries red_reason: not-checked", async () => {
    const s = await scenario();
    expect(rowOf(reportIn(s), "TP-1").red_reason).toBe("not-checked");
  });
});

describe("closure: static", { timeout: 60_000 }, () => {
  it("is proven with a pass and exit 0 last, without a start-commit envelope", async () => {
    expect(await verdict("TP-3", (s) => [{ commit: s.b }])).toEqual({
      state: "proven",
      reason: "latest-pass-exit-zero",
    });
  });

  it("fails when the latest is a fail", async () => {
    expect(
      await verdict("TP-3", (s) => [
        { commit: s.a },
        { commit: s.b, result: "fail" },
      ]),
    ).toEqual({ state: "failed", reason: "latest-fail" });
  });

  it("counts a null-selector envelope although the row's binding carries a selector", async () => {
    const s = await scenario({
      bindings:
        "TP-1:\n  status: new\n  selector: token rejected\n" +
        "TP-2:\n  status: existing\n  selector: login works\n" +
        "TP-3:\n  status: existing\n  selector: something\n",
    });
    writeEvidence(s.repo, "TP-3", [{ commit: s.b, selector: null }]);
    const row = rowOf(reportIn(s), "TP-3");
    expect([row.state, row.counted, row.ignored]).toEqual(["proven", 1, []]);
  });

  it("is not proven by a pass with a non-zero exit", async () => {
    expect(await verdict("TP-3", (s) => [{ commit: s.b, exit: 3 }])).toEqual({
      state: "unproven",
      reason: "pass-exit-not-zero",
    });
  });
});

describe("closure: kinds decided by review", { timeout: 60_000 }, () => {
  it("reports measurement, manual and runtime as not-decidable with their evidence location", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-4", [
      { commit: s.a, selector: null, dirty: true },
    ]);
    const report = reportIn(s);
    const pick = (id: string) => {
      const row = rowOf(report, id);
      return [row.state, row.reason, row.evidence_location];
    };
    expect(pick("TP-4")).toEqual(["not-decidable", "kind-needs-review", null]);
    expect(pick("TP-5")).toEqual([
      "not-decidable",
      "kind-needs-review",
      "review/reset-mail.png",
    ]);
    expect(pick("TP-6")).toEqual([
      "not-decidable",
      "kind-needs-review",
      "review/runtime.md",
    ]);
    // The envelopes of such a row are listed and decide nothing.
    expect(rowOf(report, "TP-4").ignored).toEqual([
      { line: 1, reason: "dirty" },
    ]);
  });

  it("reports post-deploy as pending", async () => {
    expect(
      await verdict("TP-7", (s) => [{ commit: s.b, result: "fail" }]),
    ).toEqual({
      state: "pending-post-deploy",
      reason: "post-deploy",
    });
  });
});

describe("closure: producer marks", { timeout: 60_000 }, () => {
  const marks = async (producer: "ci" | "host" | "local") => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-2", [{ commit: s.spec, producer }]);
    const row = rowOf(reportIn(s), "TP-2");
    return {
      state: row.state,
      counted: row.counted,
      self_reported: row.self_reported,
      ci_unverified: row.ci_unverified,
    };
  };

  it("counts a local envelope and marks it self-reported", async () => {
    expect(await marks("local")).toEqual({
      state: "proven",
      counted: 1,
      self_reported: true,
      ci_unverified: false,
    });
  });

  it("counts a ci envelope and marks it unverified", async () => {
    expect(await marks("ci")).toEqual({
      state: "proven",
      counted: 1,
      self_reported: false,
      ci_unverified: true,
    });
  });

  it("marks neither for a host envelope", async () => {
    expect(await marks("host")).toEqual({
      state: "proven",
      counted: 1,
      self_reported: false,
      ci_unverified: false,
    });
  });

  it("does not mark a row for an ignored local envelope", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-2", [
      { commit: s.spec },
      { commit: s.a, producer: "local", dirty: true },
    ]);
    expect(rowOf(reportIn(s), "TP-2").self_reported).toBe(false);
  });
});

describe("closure: the merged spec commit", { timeout: 60_000 }, () => {
  it("judges the test plan at the merged spec commit: a kind changed on the work branch changes nothing", async () => {
    const s = await scenario();
    const plan = fs
      .readFileSync(path.join(s.repo.spec, "testplan.yaml"), "utf8")
      .replace("kind: red-first", "kind: post-deploy");
    const changed = await s.repo.commit(
      { "specs/s1/testplan.yaml": plan },
      "edit the plan on the work branch",
    );
    const report = reportIn(s);
    expect(report.spec_commit).toBe(s.spec);
    expect(report.head).toBe(changed);
    expect(rowOf(report, "TP-1").kind).toBe("red-first");
    expect(rowOf(report, "TP-1").state).toBe("unproven");
    expect(report.ok).toBe(false);
  });

  it("reports every row of the merged plan when rows are removed on disk", async () => {
    const s = await scenario();
    fs.writeFileSync(path.join(s.repo.spec, "testplan.yaml"), "[]\n");
    const report = reportIn(s);
    expect(report.rows.map((r) => r.id)).toEqual([
      "TP-1",
      "TP-2",
      "TP-3",
      "TP-4",
      "TP-5",
      "TP-6",
      "TP-7",
    ]);
    expect(report.ok).toBe(false);
  });

  it("reads commands_ref, the id and the status at the merged spec commit, not on disk", async () => {
    const s = await scenario();
    const spec = fs
      .readFileSync(path.join(s.repo.spec, "spec.md"), "utf8")
      .replace(/^commands_ref: .*$/m, `commands_ref: ${s.c0}`)
      .replace(/^status: .*$/m, "status: draft")
      .replace(/^id: .*$/m, "id: other-spec");
    fs.writeFileSync(path.join(s.repo.spec, "spec.md"), spec);
    writeEvidence(s.repo, "TP-2", [{ commit: s.spec }]);
    const report = reportIn(s);
    expect(report.spec).toBe("tiny-valid");
    expect(rowOf(report, "TP-2").state).toBe("proven");
  });

  it("ignores a broken spec.md and testplan.yaml on disk", async () => {
    const s = await scenario();
    fs.writeFileSync(path.join(s.repo.spec, "spec.md"), "no frontmatter\n");
    fs.writeFileSync(path.join(s.repo.spec, "testplan.yaml"), "- id: TP-1\n");
    expect(reportIn(s).rows).toHaveLength(7);
  });

  it("is the latest change on the default branch, also when the start commit is later", async () => {
    const s = await scenario();
    await s.repo.checkout("main");
    const later = await s.repo.commit(
      closureSpecFiles({
        ref: s.c1,
        bindings:
          "TP-1:\n  status: new\n  selector: token rejected\nTP-2:\n  status: existing\n  selector: login works\n",
      }),
      "bindings only",
    );
    const tip = await s.repo.commit({ "README.md": "two\n" }, "unrelated");
    await s.repo.setRef(REMOTE_MAIN, tip);
    // The bindings-only commit touched neither spec.md nor testplan.yaml.
    const report = reportIn(s, { start: later, head: tip });
    expect(report.spec_commit).toBe(s.spec);
  });

  it("is the merge commit when the spec came in through a merge, and a start at the branch commit is refused", async () => {
    const repo = await Repo.create();
    await repo.commit({ "README.md": "one\n" }, "init");
    const c1 = await repo.commit(
      { ".spec-gate/commands.yaml": COMMANDS },
      "commands",
    );
    await repo.checkout("specpr", c1);
    const branchCommit = await repo.commit(
      closureSpecFiles({ ref: c1 }),
      "spec",
    );
    await repo.checkout("main");
    await repo.commit({ "other.txt": "x\n" }, "main moves on");
    await repo.sh("merge", "-q", "--no-ff", "-m", "merge spec", "specpr");
    const merge = await repo.head();
    await repo.setRef(REMOTE_MAIN, merge);
    const run = (start: string) =>
      runClosure(repo.spec, { repo: repo.dir, defaultRef: REMOTE_MAIN, start });
    const ok = run(merge);
    expect(ok.ok && ok.report.spec_commit).toBe(merge);
    const refused = run(branchCommit);
    expect(refused.ok ? "" : refused.code).toBe("start-before-spec");
  });

  it("moves with a test-plan-only change on the default branch after the start", async () => {
    const s = await scenario();
    await s.repo.checkout("main");
    const plan = `${PLAN}- id: TP-8\n  covers: [AC-1]\n  kind: static\n  claim: "lint passes"\n  check_command_ref: typecheck\n`;
    const tip = await s.repo.commit(
      { "specs/s1/testplan.yaml": plan },
      "plan only",
    );
    await s.repo.setRef(REMOTE_MAIN, tip);
    const result = closureIn(s, { start: s.spec, head: tip });
    expect(result.ok ? "" : result.code).toBe("start-before-spec");
  });
});

describe(
  "closure: bindings and the spec directory",
  { timeout: 60_000 },
  () => {
    it("treats a missing bindings.yaml as empty: selector rows count nothing", async () => {
      const s = await scenario();
      fs.rmSync(path.join(s.repo.spec, "bindings.yaml"));
      writeEvidence(s.repo, "TP-2", [{ commit: s.spec }]);
      writeEvidence(s.repo, "TP-3", [{ commit: s.b }]);
      const report = reportIn(s);
      expect(rowOf(report, "TP-2").ignored).toEqual([
        { line: 1, reason: "command-unknown" },
      ]);
      expect(rowOf(report, "TP-2").state).toBe("unproven");
      expect(rowOf(report, "TP-3").state).toBe("proven");
    });

    it("refuses a spec directory that is not a directory", async () => {
      const s = await scenario();
      const file = path.join(s.repo.dir, "specs", "file");
      fs.writeFileSync(file, "x\n");
      const result = runClosure(file, {
        repo: s.repo.dir,
        defaultRef: REMOTE_MAIN,
        start: s.spec,
      });
      expect(result.ok ? "" : result.code).toBe("spec-dir-invalid");
    });

    it("refuses a spec directory that is a symbolic link", async () => {
      const s = await scenario();
      const link = path.join(s.repo.dir, "specs", "link");
      fs.symlinkSync("s1", link);
      const result = runClosure(link, {
        repo: s.repo.dir,
        defaultRef: REMOTE_MAIN,
        start: s.spec,
      });
      expect(result.ok ? "" : result.code).toBe("spec-dir-invalid");
    });
  },
);

describe("closure: unknown rows", { timeout: 60_000 }, () => {
  it("lists an evidence file of no test-plan row and does not refuse", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-10", [{ commit: s.a }]);
    writeEvidence(s.repo, "TP-9", [{ commit: s.a }]);
    expect(reportIn(s).unknown_rows).toEqual(["TP-9", "TP-10"]);
  });
});

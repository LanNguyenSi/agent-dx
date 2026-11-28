/**
 * Which envelopes count: one case per ignore reason, each alone, against
 * an envelope that is clean in every other field.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REMOTE_MAIN } from "../lint/git-helpers.js";
import {
  PLAN,
  reportIn,
  rowOf,
  scenario,
  writeEvidence,
  type EnvelopeFields,
} from "./helpers.js";

describe("closure: counted envelopes", { timeout: 60_000 }, () => {
  it("counts a clean closure envelope at the start commit and on start..head", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-2", [{ commit: s.spec }, { commit: s.b }]);
    const row = rowOf(reportIn(s), "TP-2");
    expect(row.counted).toBe(2);
    expect(row.ignored).toEqual([]);
    expect(row.state).toBe("proven");
  });

  const cases: {
    reason: string;
    // The base no-unused-vars rule reads the names in a signature as variables.
    // eslint-disable-next-line no-unused-vars
    build: (s: Awaited<ReturnType<typeof scenario>>) => Promise<EnvelopeFields>;
  }[] = [
    {
      reason: "phase-baseline",
      // A baseline envelope at the start commit, clean in every other field.
      build: async (s) => ({ commit: s.spec, phase: "baseline" }),
    },
    {
      reason: "before-start",
      build: async (s) => ({ commit: s.c1 }),
    },
    {
      reason: "not-on-head",
      // A commit after the start on another branch, which the head does not hold.
      build: async (s) => {
        await s.repo.checkout("side", s.spec);
        const side = await s.repo.commit({ "side.txt": "x\n" }, "side");
        await s.repo.checkout("work");
        return { commit: side };
      },
    },
    {
      reason: "dirty",
      build: async (s) => ({ commit: s.a, dirty: true }),
    },
    {
      reason: "digest-mismatch",
      build: async (s) => ({ commit: s.a, commands_digest: "0".repeat(64) }),
    },
    {
      reason: "selector-mismatch",
      build: async (s) => ({ commit: s.a, selector: "another test" }),
    },
  ];
  for (const { reason, build } of cases) {
    it(`ignores an envelope for ${reason} alone`, async () => {
      const s = await scenario();
      const odd = await build(s);
      // Line 1 counts, line 2 is the one odd envelope.
      writeEvidence(s.repo, "TP-2", [{ commit: s.spec }, odd]);
      const row = rowOf(reportIn(s), "TP-2");
      expect(row.ignored).toEqual([{ line: 2, reason }]);
      expect(row.counted).toBe(1);
    });
  }

  it("ignores an envelope at a commit forked before the start that the head does not hold (not-on-head)", async () => {
    const s = await scenario();
    await s.repo.checkout("old", s.c1);
    const forked = await s.repo.commit({ "old.txt": "x\n" }, "forked early");
    await s.repo.checkout("work");
    writeEvidence(s.repo, "TP-2", [{ commit: s.spec }, { commit: forked }]);
    expect(rowOf(reportIn(s), "TP-2").ignored).toEqual([
      { line: 2, reason: "not-on-head" },
    ]);
  });

  it("ignores an envelope that names a commit the repository does not hold (not-on-head)", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-2", [
      { commit: s.spec },
      { commit: "a".repeat(40) },
    ]);
    expect(rowOf(reportIn(s), "TP-2").ignored).toEqual([
      { line: 2, reason: "not-on-head" },
    ]);
  });

  it("ignores an envelope after the head (not-on-head) when --head is earlier", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-2", [{ commit: s.spec }, { commit: s.b }]);
    expect(rowOf(reportIn(s, { head: s.a }), "TP-2").ignored).toEqual([
      { line: 2, reason: "not-on-head" },
    ]);
  });

  it("ignores every envelope of a row without a determinable command (command-unknown)", async () => {
    const s = await scenario();
    // TP-2's binding loses its selector on disk: no command to digest.
    fs.writeFileSync(
      path.join(s.repo.spec, "bindings.yaml"),
      "TP-1:\n  status: new\n  selector: token rejected\nTP-2:\n  status: existing\n",
    );
    writeEvidence(s.repo, "TP-2", [{ commit: s.spec, selector: null }]);
    const row = rowOf(reportIn(s), "TP-2");
    expect(row.ignored).toEqual([{ line: 1, reason: "command-unknown" }]);
    expect(row.state).toBe("unproven");
    expect(row.reason).toBe("no-counted-evidence");
  });

  it("ignores a static row's envelope whose command is not in the set (command-unknown)", async () => {
    const s = await scenario({
      plan: PLAN.replace(
        "check_command_ref: typecheck",
        "check_command_ref: build",
      ),
    });
    writeEvidence(s.repo, "TP-3", [{ commit: s.a }]);
    expect(rowOf(reportIn(s), "TP-3").ignored).toEqual([
      { line: 1, reason: "command-unknown" },
    ]);
  });

  it("checks the static row's selector against null", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-3", [{ commit: s.a, selector: "x" }]);
    expect(rowOf(reportIn(s), "TP-3").ignored).toEqual([
      { line: 1, reason: "selector-mismatch" },
    ]);
  });

  it("reads the digest from the template with the placeholder unsubstituted", async () => {
    const s = await scenario();
    const { createHash } = await import("node:crypto");
    const substituted = createHash("sha256")
      .update(JSON.stringify([["npx", "vitest", "run", "-t", "login works"]]))
      .digest("hex");
    writeEvidence(s.repo, "TP-2", [
      { commit: s.a, commands_digest: substituted },
    ]);
    expect(rowOf(reportIn(s), "TP-2").ignored).toEqual([
      { line: 1, reason: "digest-mismatch" },
    ]);
  });

  it("does not count a pre-squash branch commit that the head does not hold", async () => {
    const s = await scenario();
    // A pull request branch from the start, squash-merged into main: its
    // own commit is no ancestor of the squash commit.
    await s.repo.checkout("pr", s.spec);
    const branchCommit = await s.repo.commit({ "src/c.ts": "c\n" }, "pr c");
    await s.repo.checkout("main");
    await s.repo.sh("merge", "-q", "--squash", "pr");
    const squash = await s.repo.commit({}, "squash pr");
    await s.repo.setRef(REMOTE_MAIN, squash);
    writeEvidence(s.repo, "TP-2", [
      { commit: s.spec },
      { commit: branchCommit },
    ]);
    const row = rowOf(reportIn(s, { head: squash }), "TP-2");
    expect(row.ignored).toEqual([{ line: 2, reason: "not-on-head" }]);
  });
});

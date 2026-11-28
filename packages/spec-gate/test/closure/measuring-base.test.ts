/**
 * The closing check measures no range from a merge base: it reads the
 * repository, the default commit and the head, and keeps the lint's
 * earlier resolution of its git inputs. A shallow clone that still holds
 * every commit it reads, and a head whose history crossed the default
 * branch's (two merge bases), give the report the full, plain repository
 * gives; neither is refused as `git-input-invalid`.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClosure } from "../../src/closure/index.js";
import type { ClosureResult } from "../../src/closure/index.js";
import { git } from "../canonical/helpers.js";
import { REMOTE_MAIN, SPEC_REL } from "../lint/git-helpers.js";
import { scratch } from "../lint/helpers.js";
import { scenario, writeEvidence, type Scenario } from "./helpers.js";

function run(
  dir: string,
  s: Scenario,
  options: { head?: string } = {},
): ClosureResult {
  return runClosure(path.join(dir, SPEC_REL), {
    repo: dir,
    defaultRef: REMOTE_MAIN,
    start: s.spec,
    ...(options.head !== undefined ? { head: options.head } : {}),
  });
}

describe(
  "the closing check and the measuring base",
  { timeout: 60_000 },
  () => {
    it("a shallow clone that holds every commit the check reads gives the report of the full repository", async () => {
      const s = await scenario();
      const full = run(s.repo.dir, s);
      expect(full.ok).toBe(true);
      // b, a, the spec commit and c1 (the commands_ref); c0 is behind the
      // shallow boundary.
      const dir = path.join(scratch(), "shallow-closure");
      await git(scratch(), [
        "clone",
        "-q",
        "--depth",
        "4",
        "--single-branch",
        "--branch",
        "work",
        `file://${s.repo.dir}`,
        dir,
      ]);
      // The default ref the job would fetch, at the spec commit the clone
      // already holds.
      await git(dir, ["update-ref", REMOTE_MAIN, s.spec]);
      expect(await git(dir, ["rev-parse", "--is-shallow-repository"])).toBe(
        "true",
      );
      expect(await git(dir, ["rev-parse", REMOTE_MAIN])).toBe(s.spec);
      expect(run(dir, s)).toEqual(full);
    });

    it("a head with two merge bases with the default branch gives the report the plain default commit gives", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-1", [{ commit: s.b, phase: "closure" }]);
      // The default branch makes d1 and merges the work commit b; the work
      // branch merges d1. HEAD and the default tip then have the merge bases
      // b and d1.
      await s.repo.checkout("main");
      const d1 = await s.repo.commit({ "d.txt": "d\n" }, "the default branch");
      await s.repo.sh(
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "the default merges b",
        s.b,
      );
      const crossed = await s.repo.head();
      await s.repo.checkout("work");
      await s.repo.sh("merge", "-q", "--no-ff", "-m", "work merges d1", d1);
      const head = await s.repo.head();
      const bases = (await s.repo.sh("merge-base", "--all", head, crossed))
        .split("\n")
        .sort();
      expect(bases).toEqual([s.b, d1].sort());

      await s.repo.setRef(REMOTE_MAIN, crossed);
      const result = run(s.repo.dir, s, { head });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      // The same spec commit and rows as with the default ref at the spec
      // commit, where there is one merge base.
      await s.repo.setRef(REMOTE_MAIN, s.spec);
      expect(result).toEqual(run(s.repo.dir, s, { head }));
    });
  },
);

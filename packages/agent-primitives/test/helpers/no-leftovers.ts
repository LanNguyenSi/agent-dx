import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { expect } from "vitest";
import { readMarkerFor } from "../../src/lock.js";
import { resolveDeepestExisting } from "../../src/probe/containment.js";

/**
 * Asserts that a refusal made BEFORE `beginWorktree` ever ran (an
 * isolation-escape refusal included) left no trace behind: no linked
 * worktree was registered against `repo` (only the main worktree, the
 * repo itself, shows up in `git worktree list`), no stale in-flight
 * marker was written for it, and no lock file remains in `lockDir`.
 * Shared by `probe-refusal-contract.test.ts` (the single-probe path)
 * and `plan.test.ts` (the plan path), so both sides of the refusal
 * assert the same three no-leftover checks rather than only the
 * refusal reason.
 */
export function expectNoIsolationLeftovers(repo: string, lockDir: string) {
  const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  });
  expect(
    list.split("\n\n").filter((block) => block.trim().length > 0),
  ).toHaveLength(1);
  expect(readMarkerFor(resolveDeepestExisting(repo))).toBeUndefined();
  expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
    [],
  );
}

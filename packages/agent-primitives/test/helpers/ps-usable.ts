import { spawnSync } from "node:child_process";
import type { TestContext } from "vitest";

/**
 * Whether `ps` can run here: a sandbox or environment that forbids running
 * it (for example a setuid binary that cannot be executed) makes every test
 * that reads a real process table fail for a reason that has nothing to do
 * with the code under test. Probed once per test file, by asking for this
 * process's own row.
 */
function probePsUsable(): boolean {
  try {
    const r = spawnSync("ps", ["-o", "pid=", "-p", String(process.pid)], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return (
      r.error === undefined &&
      r.status === 0 &&
      r.stdout.trim() === String(process.pid)
    );
  } catch {
    return false;
  }
}

export const PS_USABLE: boolean = probePsUsable();

// CI always has ps: a probe that fails there (an image without procps, a
// spawn timeout) must fail loudly instead of silently skipping every test
// that needs a process table.
if (!PS_USABLE && process.env.CI) {
  throw new Error(
    "ps cannot run although CI is set: the tests that need a process table would be skipped",
  );
}

/** The note a skipped test carries, so a skip reads as skipped for this
 * reason and no other. */
export const PS_SKIP_NOTE = "ps cannot run in this environment";

/**
 * Skips the running test, with `PS_SKIP_NOTE`, when `ps` cannot run. For a
 * test whose assertion needs a real process table (resident memory, process
 * groups, start times, zombie state): call it first in the test, or hand it
 * to `beforeEach(skipWithoutPs)` at the top of a suite whose tests all need
 * it. Where `ps` runs it does nothing and no test is skipped.
 */
export function skipWithoutPs(ctx: TestContext): void {
  ctx.skip(!PS_USABLE, PS_SKIP_NOTE);
}

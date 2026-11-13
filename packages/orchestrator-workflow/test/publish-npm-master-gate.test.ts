// The publish job refuses a tag whose commit is not on master. These tests
// pin where the step sits in the job and run its real `run:` body against a
// throwaway git fixture under the Actions bash invocation.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
}

const workflow = parse(
  readFileSync(
    new URL("../../../.github/workflows/publish-npm.yml", import.meta.url),
    "utf8",
  ),
) as { jobs: { publish: { steps: Step[] } } };

const steps = workflow.jobs.publish.steps;
const gateIndex = steps.findIndex(
  (s) => s.name === "Verify tagged commit is on master",
);
const gate = steps[gateIndex];

describe("publish-npm.yml on-master step, placement", () => {
  it("exists", () => {
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(gate?.run).toBeTruthy();
  });

  it("sits right after the checkout and before the first npm step", () => {
    const checkout = steps.findIndex((s) =>
      (s.uses ?? "").startsWith("actions/checkout@"),
    );
    const firstNpm = steps.findIndex((s) => /\bnpm\b/.test(s.run ?? ""));
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(firstNpm).toBeGreaterThan(0);
    expect(gateIndex).toBe(checkout + 1);
    expect(gateIndex).toBeLessThan(firstNpm);
  });
});

describe("publish-npm.yml on-master step, executed", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };

  // Builds an origin with master (tag m/v1.0.0) and a side branch with one
  // extra commit (tag s/v1.0.0), clones it, checks the tag out detached and
  // runs the step body the way Actions runs a bare `run:`.
  const runFor = (tag: string) => {
    const dir = mkdtempSync(join(tmpdir(), "publish-gate-"));
    try {
      const seed = join(dir, "seed");
      const origin = join(dir, "origin.git");
      const clone = join(dir, "clone");
      git(dir, "init", "-q", "--bare", origin);
      git(dir, "init", "-q", seed);
      git(seed, "config", "user.email", "t@example.com");
      git(seed, "config", "user.name", "t");
      git(seed, "checkout", "-q", "-b", "master");
      git(seed, "commit", "-q", "--allow-empty", "-m", "on master");
      git(seed, "tag", "m/v1.0.0");
      git(seed, "checkout", "-q", "-b", "side");
      git(seed, "commit", "-q", "--allow-empty", "-m", "side only");
      git(seed, "tag", "s/v1.0.0");
      git(seed, "remote", "add", "origin", origin);
      git(seed, "push", "-q", "origin", "master", "side", "--tags");
      git(dir, "clone", "-q", origin, clone);
      git(clone, "checkout", "-q", tag);
      return spawnSync("bash", ["-e", "-c", gate?.run ?? ""], {
        cwd: clone,
        encoding: "utf8",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("passes for a tag on a master commit", () => {
    expect(runFor("m/v1.0.0").status).toBe(0);
  });

  it("fails for a tag on a commit only reachable from a side branch", () => {
    const r = runFor("s/v1.0.0");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not an ancestor of origin/master");
  });
});

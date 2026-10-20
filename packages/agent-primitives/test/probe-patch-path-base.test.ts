import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnCli } from "./helpers/spawn-cli.js";

/**
 * The base a relative `-p, --patch` resolves against. It is the
 * invocation cwd (`-C/--cwd`), the same base as `--file` and a plan
 * entry's `patch` -- not the process cwd of the CLI process itself.
 * Every run below spawns the CLI with `-C <repo>` from some other
 * process cwd (the test runner's), so a `-p` that still resolved
 * against the process cwd would name a file that is not there and end
 * in `usage_error`/`patch_not_readable` instead of the verdict.
 */

const FIXTURE_JS = [
  "function isPositive(n) {",
  "  return n > 0;",
  "}",
  "module.exports = { isPositive };",
  "",
].join("\n");

const FIXTURE_TEST_JS = [
  "const assert = require('node:assert');",
  "const { isPositive } = require('./fixture.js');",
  "assert.strictEqual(isPositive(5), true);",
  "assert.strictEqual(isPositive(-5), false);",
  "",
].join("\n");

/** `return n > 0;` -> `return false;`: the test fails on the mutant, so
 * a probe that APPLIED the patch reports `killed`. Patch paths are
 * `a/`/`b/` prefixed and repository-root-relative, as documented. */
function patchLines(): string[] {
  const lines = FIXTURE_JS.split("\n");
  return [
    "diff --git a/pkg/fixture.js b/pkg/fixture.js",
    "index 0000000..0000000 100644",
    "--- a/pkg/fixture.js",
    "+++ b/pkg/fixture.js",
    "@@ -1,3 +1,3 @@",
    ` ${lines[0]}`,
    `-${lines[1]}`,
    "+  return false;",
    ` ${lines[2]}`,
  ];
}

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-patch-base-")),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A repository carrying the fixture under `pkg/`, with the patch and
 * the plan as gitignored files AT THE REPOSITORY ROOT, so their names
 * ("cwd-vs-C-mutant.diff", "cwd-vs-C-plan.json") resolve under `-C` and
 * deliberately not under the process cwd the CLI is spawned from. */
function makeRepo(): string {
  const repo = makeTmpDir();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "diff.noprefix", "false");
  git("config", "diff.mnemonicPrefix", "false");
  git("config", "core.autocrlf", "false");
  fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "pkg", "fixture.js"), FIXTURE_JS);
  fs.writeFileSync(path.join(repo, "pkg", "fixture.test.js"), FIXTURE_TEST_JS);
  fs.writeFileSync(
    path.join(repo, ".gitignore"),
    "cwd-vs-C-mutant.diff\ncwd-vs-C-plan.json\n",
  );
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  fs.writeFileSync(
    path.join(repo, "cwd-vs-C-mutant.diff"),
    patchLines().join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(repo, "cwd-vs-C-plan.json"),
    JSON.stringify({
      test: "node pkg/fixture.test.js",
      mutants: [{ file: "pkg/fixture.js", patch: "cwd-vs-C-mutant.diff" }],
    }),
  );
  return repo;
}

interface Envelope {
  status: string;
  reason?: string;
  warnings?: string[];
  plan?: { results: { status: string }[] };
}

function parseEnvelope(stdout: string): Envelope {
  return JSON.parse(stdout) as Envelope;
}

describe("probe -p: a relative patch path resolves against -C, like --file and a plan patch", () => {
  it("-C <repo> with a relative -p uses the patch under the repo, and the same patch named in a plan entry gives the same verdict", async () => {
    const repo = makeRepo();
    const logs = makeTmpDir();

    const single = await spawnCli([
      "-C",
      repo,
      "-l",
      path.join(logs, "single"),
      "-m",
      "100000",
      "probe",
      "--file",
      "pkg/fixture.js",
      "-p",
      "cwd-vs-C-mutant.diff",
      "-t",
      "node pkg/fixture.test.js",
    ]);
    const planned = await spawnCli([
      "-C",
      repo,
      "-l",
      path.join(logs, "plan"),
      "-m",
      "100000",
      "probe",
      "--plan",
      "cwd-vs-C-plan.json",
    ]);

    const singleEnvelope = parseEnvelope(single.stdout);
    const plannedEnvelope = parseEnvelope(planned.stdout);
    // A `-p` resolved against the process cwd would never find the
    // patch: usage_error/patch_not_readable, not a verdict.
    expect(singleEnvelope.status).toBe("killed");
    expect(singleEnvelope.reason).toBeUndefined();
    expect(plannedEnvelope.status).toBe("killed");
    expect(plannedEnvelope.plan?.results.map((r) => r.status)).toEqual([
      "killed",
    ]);
    expect(singleEnvelope.status).toBe(plannedEnvelope.status);
    expect(single.code).toBe(0);
    expect(planned.code).toBe(0);
  }, 120000);

  it("an absolute -p keeps working unchanged under -C", async () => {
    const repo = makeRepo();

    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      path.join(makeTmpDir(), "logs"),
      "-m",
      "100000",
      "probe",
      "--file",
      "pkg/fixture.js",
      "-p",
      path.join(repo, "cwd-vs-C-mutant.diff"),
      "-t",
      "node pkg/fixture.test.js",
    ]);

    expect(parseEnvelope(run.stdout).status).toBe("killed");
    expect(run.code).toBe(0);
  }, 120000);
});

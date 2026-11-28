/**
 * The measuring base of the lint: every rule that measures a change
 * measures it from the one merge base of HEAD and the `--default-ref`
 * commit. One row per case of the claim, through the built CLI:
 *
 * - one merge base: measured;
 * - several: exit 2, nothing measured from one of them;
 * - none: exit 2;
 * - a shallow repository: exit 2;
 * - `--base` given: validated (a commit on `--default-ref`) and measures
 *   nothing, so a base older than a default commit the head merged does not
 *   hide a change;
 * - `--base` without `--default-ref`: exit 2.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintSpecDir, type LintReport } from "../../src/lint/index.js";
import {
  COMMANDS_OK,
  COMMANDS_WITH_LINT,
  REMOTE_MAIN,
  SPEC_REL,
  specFiles,
} from "./git-helpers.js";
import { git } from "../canonical/helpers.js";
import { runCli, scratch } from "./helpers.js";
import {
  BASE_ALONE,
  BASE_OFF,
  NONE,
  SEVERAL,
  SHALLOW,
  noBase,
  oneBase,
  shallow,
  staleBase,
  twoBases,
  type Files,
} from "./measuring-helpers.js";

const SPEC: Files = (c1) => specFiles({ base: c1, ref: c1 });

async function lint(dir: string, flags: string[]) {
  return runCli([
    "lint",
    path.join(dir, SPEC_REL),
    "--repo",
    dir,
    "--default-ref",
    REMOTE_MAIN,
    ...flags,
  ]);
}

/** A usage error: exit 2, the message as the one stderr line, no report. */
function refused(run: { code: number; stdout: string; stderr: string }) {
  expect(run.code).toBe(2);
  expect(run.stdout).toBe("");
  const lines = run.stderr.trim().split("\n");
  expect(lines).toHaveLength(1);
  return lines[0]!.replace(/^spec-gate: /, "");
}

function inProcess(dir: string, base?: string): LintReport {
  const result = lintSpecDir(path.join(dir, SPEC_REL), {
    git: {
      repo: dir,
      defaultRef: REMOTE_MAIN,
      ...(base !== undefined ? { base } : {}),
    },
  });
  if (!result.ok) throw new Error(`usage error: ${result.message}`);
  return result.report;
}

describe("the measuring base of the lint", { timeout: 60_000 }, () => {
  it("one merge base: the change is measured from it", async () => {
    const s = await oneBase(SPEC);
    const run = await lint(s.dir, []);
    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as LintReport).errors).toEqual([]);
  });

  it("several merge bases: exit 2, nothing is measured from one of them", async () => {
    const s = await twoBases(SPEC);
    expect(refused(await lint(s.dir, []))).toBe(SEVERAL);
    expect(refused(await lint(s.dir, ["--base", s.c1]))).toBe(SEVERAL);
  });

  it("no merge base: exit 2", async () => {
    const s = await noBase(SPEC);
    expect(refused(await lint(s.dir, []))).toBe(NONE);
  });

  it("a shallow repository: exit 2, even where git still finds one merge base", async () => {
    const s = await shallow(SPEC);
    expect(refused(await lint(s.dir, []))).toBe(SHALLOW);
    // the full repository it was cloned from measures
    expect((await lint(s.repo.dir, [])).code).toBe(0);
  });

  it("a shallow repository is refused before the flags: a --base behind the boundary gets the shallow message", async () => {
    const s = await oneBase(SPEC);
    // One commit deep on both branches: the branch tip and c1, the tip of
    // the default branch; c0 is behind the boundary and not in the clone.
    const dir = path.join(scratch(), "shallow-one");
    await git(scratch(), [
      "clone",
      "-q",
      "--depth",
      "1",
      "--no-single-branch",
      `file://${s.repo.dir}`,
      dir,
    ]);
    await expect(git(dir, ["cat-file", "-e", s.c0])).rejects.toThrow();
    expect(refused(await lint(dir, ["--base", s.c0]))).toBe(SHALLOW);
    // in the full repository the same base is a valid one
    expect((await lint(s.repo.dir, ["--base", s.c0])).code).toBe(0);
  });

  it("--base older than a default commit the head merged: a setting put back to its text at the base is a change", async () => {
    const s = await staleBase(
      SPEC,
      { ".spec-gate/commands.yaml": COMMANDS_WITH_LINT },
      { ".spec-gate/commands.yaml": COMMANDS_OK },
    );
    const run = await lint(s.dir, ["--base", s.c1]);
    expect(run.code).toBe(1);
    const report = JSON.parse(run.stdout) as LintReport;
    expect(
      report.errors.filter((f) => f.rule === "spec-changes-config"),
    ).toHaveLength(1);
    // the base moves nothing: the same report without it
    expect(inProcess(s.dir, s.c1)).toEqual(inProcess(s.dir));
  });

  it("--base must lie on --default-ref", async () => {
    const s = await oneBase(SPEC);
    await s.repo.checkout("side", s.c1);
    const side = await s.repo.commit({ "side.txt": "s\n" }, "side");
    await s.repo.checkout("pr");
    expect(refused(await lint(s.dir, ["--base", side]))).toBe(BASE_OFF);
  });

  it("--base without --default-ref: exit 2", async () => {
    const s = await oneBase(SPEC);
    const run = await runCli([
      "lint",
      path.join(s.dir, SPEC_REL),
      "--repo",
      s.dir,
      "--base",
      s.c1,
    ]);
    expect(refused(run)).toBe(BASE_ALONE);
  });
});

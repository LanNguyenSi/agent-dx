/**
 * The measuring base of repo-check: the diff base it walks is the one merge
 * base of HEAD and the `--default-ref` commit. One row per case of the
 * claim, through the built CLI (one merge base, several, none, a shallow
 * repository, `--base` given, `--base` without `--default-ref`).
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repoCheck, type RepoCheckReport } from "../../src/repo/index.js";
import { runBounded } from "../canonical/helpers.js";
import { REMOTE_MAIN } from "../lint/git-helpers.js";
import { validFiles } from "../lint/helpers.js";
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
} from "../lint/measuring-helpers.js";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

const PROPOSED = validFiles()["spec.md"]!.replace(
  /^status: .*$/m,
  "status: proposed",
);

const CODE: Files = () => ({ "src/app.ts": "export {};\n" });

async function check(dir: string, flags: string[]) {
  const run = await runBounded(process.execPath, [
    cliPath,
    "repo-check",
    "--repo",
    dir,
    ...flags,
  ]);
  return { code: run.code ?? 1, stdout: run.stdout, stderr: run.stderr };
}

const withDefault = (dir: string, flags: string[] = []) =>
  check(dir, ["--default-ref", REMOTE_MAIN, ...flags]);

/** A usage error: exit 2, the message as the one stderr line, no report. */
function refused(run: { code: number; stdout: string; stderr: string }) {
  expect(run.code).toBe(2);
  expect(run.stdout).toBe("");
  const lines = run.stderr.trim().split("\n");
  expect(lines).toHaveLength(1);
  return lines[0]!.replace(/^spec-gate: /, "");
}

function inProcess(dir: string, base?: string): RepoCheckReport {
  const result = repoCheck({
    repo: dir,
    defaultRef: REMOTE_MAIN,
    ...(base !== undefined ? { base } : {}),
  });
  if (!result.ok) throw new Error(`usage error: ${result.message}`);
  return result.report;
}

describe("the measuring base of repo-check", { timeout: 60_000 }, () => {
  it("one merge base: the diff base is it, the reference the default commit", async () => {
    const s = await oneBase(CODE);
    const run = await withDefault(s.dir);
    expect(run.code).toBe(0);
    const report = JSON.parse(run.stdout) as RepoCheckReport;
    expect(report.reference).toBe(s.c1);
    expect(report.diff_base).toBe(s.c1);
  });

  it("several merge bases: exit 2, nothing is measured from one of them", async () => {
    const s = await twoBases(CODE);
    expect(refused(await withDefault(s.dir))).toBe(SEVERAL);
    expect(refused(await withDefault(s.dir, ["--base", s.c1]))).toBe(SEVERAL);
  });

  it("no merge base: exit 2", async () => {
    const s = await noBase(CODE);
    expect(refused(await withDefault(s.dir))).toBe(NONE);
  });

  it("a shallow repository: exit 2, even where git still finds one merge base", async () => {
    const s = await shallow(CODE);
    expect(refused(await withDefault(s.dir))).toBe(SHALLOW);
    expect((await withDefault(s.repo.dir)).code).toBe(0);
  });

  it("--base older than a default commit the head merged: a spec merged after the base and deleted by the branch is reported", async () => {
    const s = await staleBase(
      CODE,
      { "specs/a/spec.md": PROPOSED },
      { "specs/a/spec.md": null },
    );
    const run = await withDefault(s.dir, ["--base", s.c1]);
    expect(run.code).toBe(1);
    const report = JSON.parse(run.stdout) as RepoCheckReport;
    expect(report.reference).toBe(s.newer);
    expect(report.diff_base).toBe(s.newer);
    expect(report.findings.map((f) => `${f.path} ${f.code}`)).toEqual([
      "specs/a/spec.md spec-removed",
    ]);
    // the base moves nothing: the same report without it
    expect(inProcess(s.dir, s.c1)).toEqual(inProcess(s.dir));
  });

  it("--base must lie on --default-ref", async () => {
    const s = await oneBase(CODE);
    await s.repo.checkout("side", s.c1);
    const side = await s.repo.commit({ "side.txt": "s\n" }, "side");
    await s.repo.checkout("pr");
    expect(refused(await withDefault(s.dir, ["--base", side]))).toBe(BASE_OFF);
  });

  it("--base without --default-ref: exit 2", async () => {
    const s = await oneBase(CODE);
    expect(refused(await check(s.dir, ["--base", s.c1]))).toBe(BASE_ALONE);
  });
});

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_CHECK_FORMAT } from "../../src/repo/index.js";
import { runBounded } from "../canonical/helpers.js";
import { REMOTE_MAIN, Repo } from "../lint/git-helpers.js";
import { validFiles } from "../lint/helpers.js";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

function cli(args: string[]) {
  return runBounded(process.execPath, [cliPath, ...args]);
}

const proposed = validFiles()["spec.md"]!.replace(
  /^status: .*$/m,
  "status: proposed",
);

async function repoWithProposed(): Promise<{ repo: Repo; main: string }> {
  const repo = await Repo.create();
  await repo.commit({ "README.md": "one\n" }, "init");
  const main = await repo.commit({ "specs/a/spec.md": proposed }, "merged");
  await repo.setRef(REMOTE_MAIN, main);
  await repo.checkout("pr", main);
  return { repo, main };
}

describe("spec-gate repo-check (CLI)", { timeout: 60_000 }, () => {
  it("exits 0 with one JSON report line when nothing protected changed", async () => {
    const { repo } = await repoWithProposed();
    await repo.commit({ "README.md": "two\n" }, "code");
    const run = await cli([
      "repo-check",
      "--repo",
      repo.dir,
      "--default-ref",
      REMOTE_MAIN,
    ]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const lines = run.stdout.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(report)).toEqual([
      "format",
      "ok",
      "reference",
      "diff_base",
      "head",
      "spec_files",
      "findings",
    ]);
    expect(report["format"]).toBe(REPO_CHECK_FORMAT);
    expect(report["ok"]).toBe(true);
    expect(run.stdout).not.toContain(repo.dir);
  });

  it("exits 1 with the findings when a protected spec is deleted", async () => {
    const { repo, main } = await repoWithProposed();
    await repo.commit({ "specs/a/spec.md": null }, "delete");
    const run = await cli(["repo-check", "--repo", repo.dir, "--base", main]);
    expect(run.code).toBe(1);
    const report = JSON.parse(run.stdout) as {
      ok: boolean;
      findings: { path: string; code: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => `${f.path} ${f.code}`)).toEqual([
      "specs/a/spec.md spec-removed",
    ]);
  });

  it("exits 2 without --default-ref and --base", async () => {
    const { repo } = await repoWithProposed();
    const run = await cli(["repo-check", "--repo", repo.dir]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("--default-ref <ref> or --base <commit>");
  });

  it("exits 2 without --repo", async () => {
    const run = await cli(["repo-check", "--default-ref", REMOTE_MAIN]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--repo");
  });

  it("exits 2 for a short ref name and names no path", async () => {
    const { repo } = await repoWithProposed();
    const run = await cli([
      "repo-check",
      "--repo",
      repo.dir,
      "--default-ref",
      "main",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--default-ref");
    expect(run.stderr).not.toContain(repo.dir);
  });

  it("exits 2 for an unknown option", async () => {
    const run = await cli(["repo-check", "--nope"]);
    expect(run.code).toBe(2);
  });
});

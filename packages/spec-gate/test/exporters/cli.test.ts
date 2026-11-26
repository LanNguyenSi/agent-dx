/**
 * Usage and reference errors of `spec-gate export`: everything that is not
 * a result exits 2 with a named error.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { runCli } from "../lint/helpers.js";
import { REMOTE_MAIN, exportArgs, makeMergedRepo } from "./repo.js";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function mergedRepo() {
  const repo = await makeMergedRepo();
  roots.push(repo.dir);
  return repo;
}

describe("spec-gate export usage", () => {
  it("needs --format or --check", async () => {
    const repo = await mergedRepo();
    const run = await runCli([
      "export",
      repo.spec,
      "--repo",
      repo.dir,
      "--default-ref",
      REMOTE_MAIN,
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      "export: usage: export needs --format ow or --check",
    );
  });

  it("refuses --format together with --check", async () => {
    const repo = await mergedRepo();
    const run = await runCli([
      "export",
      ...exportArgs(repo),
      "--check",
      path.join(repo.dir, "return.yaml"),
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("export: usage");
  });

  it("refuses a format other than ow", async () => {
    const repo = await mergedRepo();
    const run = await runCli([
      "export",
      ...exportArgs(repo),
      "--format",
      "json",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("invalid");
  });

  it("requires --repo with --format", async () => {
    const repo = await mergedRepo();
    const run = await runCli([
      "export",
      repo.spec,
      "--format",
      "ow",
      "--default-ref",
      REMOTE_MAIN,
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--repo");
    expect(run.stderr).toContain("export: usage");
  });

  it("requires --default-ref with --format", async () => {
    const repo = await mergedRepo();
    const run = await runCli([
      "export",
      repo.spec,
      "--format",
      "ow",
      "--repo",
      repo.dir,
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--default-ref");
    expect(run.stderr).toContain("export: usage");
  });

  for (const [flag, value] of [
    ["--format", "ow"],
    ["--repo", "."],
    ["--default-ref", REMOTE_MAIN],
  ] as const) {
    it(`refuses --check together with ${flag} alone`, async () => {
      const repo = await mergedRepo();
      const run = await runCli([
        "export",
        repo.spec,
        "--check",
        path.join(repo.dir, "return.yaml"),
        flag,
        value,
      ]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(
        "export: usage: --check reads no repository and prints no briefing",
      );
      expect(run.stdout).toBe("");
    });
  }

  it("refuses a spec directory that does not exist", async () => {
    const repo = await mergedRepo();
    const run = await runCli([
      "export",
      path.join(repo.dir, "..", "outside"),
      "--format",
      "ow",
      "--repo",
      repo.dir,
      "--default-ref",
      REMOTE_MAIN,
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("export: spec-dir-invalid");
    expect(run.stderr).toContain("does not exist");
  });

  it("refuses the spec directory of another repository", async () => {
    const repo = await mergedRepo();
    const other = await mergedRepo();
    const run = await runCli([
      "export",
      other.spec,
      "--format",
      "ow",
      "--repo",
      repo.dir,
      "--default-ref",
      REMOTE_MAIN,
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      "export: spec-dir-invalid: the spec directory is not inside the repository",
    );
    expect(run.stdout).toBe("");
  });

  it("refuses the repository root as the spec directory", async () => {
    const repo = await mergedRepo();
    const run = await runCli([
      "export",
      repo.dir,
      "--format",
      "ow",
      "--repo",
      repo.dir,
      "--default-ref",
      REMOTE_MAIN,
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      "export: spec-dir-invalid: the spec directory is the repository root",
    );
    expect(run.stdout).toBe("");
  });

  it("refuses a --default-ref that is not a full ref name", async () => {
    const repo = await mergedRepo();
    const run = await runCli([
      "export",
      repo.spec,
      "--format",
      "ow",
      "--repo",
      repo.dir,
      "--default-ref",
      "main",
    ]);
    expect(run.stderr).toContain("export: ref-invalid");
  });

  it("refuses a --default-ref that names no ref", async () => {
    const repo = await mergedRepo();
    const run = await runCli([
      "export",
      repo.spec,
      "--format",
      "ow",
      "--repo",
      repo.dir,
      "--default-ref",
      "refs/remotes/origin/nope",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("export: ref-unresolvable");
  });
});

/**
 * `spec-gate export --format ow` over temporary git repositories: merged,
 * not merged, changed after the merge, draft, a symbolic link in the work
 * tree; the golden output and its determinism.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../lint/helpers.js";
import {
  FIXTURES,
  REVERSED_BINDINGS,
  exportArgs,
  makeMergedRepo,
  type MergedRepoOptions,
} from "./repo.js";

const GOLDEN = fs.readFileSync(path.join(FIXTURES, "golden.yaml"), "utf8");

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function mergedRepo(options: MergedRepoOptions = {}) {
  const repo = await makeMergedRepo(options);
  roots.push(repo.dir);
  return repo;
}

const EXPORT_TIMEOUT_MS = 60_000;

describe("spec-gate export --format ow", () => {
  it("prints the golden briefing of a spec merged unchanged on the default branch", async () => {
    const repo = await mergedRepo();
    const run = await runCli(
      ["export", ...exportArgs(repo)],
      EXPORT_TIMEOUT_MS,
    );
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(GOLDEN);
    expect(run.stdout).toContain("digest: sha256:");
    expect(run.stdout).toContain(`spec_ref: specs/s1@${repo.commit}\n`);
  });

  it("prints byte-identical output twice in a row", async () => {
    const repo = await mergedRepo();
    const first = await runCli(
      ["export", ...exportArgs(repo)],
      EXPORT_TIMEOUT_MS,
    );
    const second = await runCli(
      ["export", ...exportArgs(repo)],
      EXPORT_TIMEOUT_MS,
    );
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

  it("does not see the insertion order of bindings.yaml", async () => {
    const plain = await mergedRepo();
    const shuffled = await mergedRepo({ bindings: REVERSED_BINDINGS });
    const a = await runCli(["export", ...exportArgs(plain)], EXPORT_TIMEOUT_MS);
    const b = await runCli(
      ["export", ...exportArgs(shuffled)],
      EXPORT_TIMEOUT_MS,
    );
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    // The merge commit id differs (the committed bindings differ); the
    // briefing itself must not see the order.
    const dropRef = (text: string): string =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("spec_ref:"))
        .join("\n");
    expect(dropRef(b.stdout)).toBe(dropRef(a.stdout));
  });

  it("refuses a spec that is not on the default branch", async () => {
    const repo = await mergedRepo({ merge: false });
    const run = await runCli(
      ["export", ...exportArgs(repo)],
      EXPORT_TIMEOUT_MS,
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("export: not-merged");
    expect(run.stderr).toContain("specs/s1/spec.md");
    expect(run.stdout).toBe("");
  });

  it("refuses the work tree changed after the merge", async () => {
    const repo = await mergedRepo();
    fs.appendFileSync(path.join(repo.spec, "spec.md"), "\n");
    const run = await runCli(
      ["export", ...exportArgs(repo)],
      EXPORT_TIMEOUT_MS,
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("export: not-merged");
    expect(run.stderr).toContain("specs/s1/spec.md");
    expect(run.stdout).toBe("");
  });

  it("refuses a spec directory file that is a symbolic link", async () => {
    const repo = await mergedRepo();
    const file = path.join(repo.spec, "testplan.yaml");
    const text = fs.readFileSync(file);
    fs.writeFileSync(path.join(repo.dir, "kept-testplan.yaml"), text);
    fs.rmSync(file);
    fs.symlinkSync(path.join(repo.dir, "kept-testplan.yaml"), file);
    const run = await runCli(
      ["export", ...exportArgs(repo)],
      EXPORT_TIMEOUT_MS,
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("export: not-regular");
    expect(run.stdout).toBe("");
  });

  it("refuses a draft spec", async () => {
    const repo = await mergedRepo({ draft: true });
    const run = await runCli(
      ["export", ...exportArgs(repo)],
      EXPORT_TIMEOUT_MS,
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("export: not-proposed");
    expect(run.stderr).toContain("draft");
    expect(run.stdout).toBe("");
  });
});

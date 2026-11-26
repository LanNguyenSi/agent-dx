/**
 * The path rules of `spec-gate export --format ow` over temporary git
 * repositories: the refusal of non-canonical binding paths (each spelling
 * as a `file` and as a `fixtures` entry) and the drop rule of
 * `allowed_changes_hint` (a Non-goal directory, a Non-goal glob, a glob
 * that must not overreach, and the spec's own normative files).
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../lint/helpers.js";
import {
  POISONED_BINDINGS,
  exportArgs,
  fixtureText,
  makeMergedRepo,
  type MergedRepoOptions,
} from "./repo.js";

const GOLDEN = fixtureText("golden.yaml");

/** The hint block of a briefing: the last key, so it runs to the end. */
const hintOf = (text: string): string =>
  text.split("allowed_changes_hint:\n")[1] ?? "";

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

async function exportOf(options: MergedRepoOptions) {
  const repo = await mergedRepo(options);
  return runCli(["export", ...exportArgs(repo)], EXPORT_TIMEOUT_MS);
}

const NON_CANONICAL = [
  "./specs/s1/spec.md",
  "specs/s1//spec.md",
  "specs/s1/testplan.yaml/",
  "specs/../specs/s1/spec.md",
  "a\\b.ts",
];

/** The fixture bindings plus a `TP-9` binding with this `file`. */
function bindingsWithFile(file: string): string {
  return `${fixtureText("bindings.yaml")}TP-9:\n  status: existing\n  file: '${file}'\n`;
}

/** The fixture bindings plus a `TP-9` binding with this `fixtures` entry. */
function bindingsWithFixture(fixture: string): string {
  return (
    `${fixtureText("bindings.yaml")}TP-9:\n` +
    "  status: existing\n" +
    "  file: test/x.test.ts\n" +
    "  fixtures:\n" +
    `    - '${fixture}'\n`
  );
}

/** The fixture spec with the Non-goal paths replaced. */
function specWithNonGoalPaths(paths: string): string {
  return fixtureText("spec.md").replace(
    "  - paths: src/legacy.ts, src/auth/**",
    `  - paths: ${paths}`,
  );
}

/** The fixture bindings plus one extra binding per given file. */
function bindingsWithFiles(...files: string[]): string {
  let out = fixtureText("bindings.yaml");
  files.forEach((file, i) => {
    out += `TP-${9 - i}:\n  status: existing\n  file: ${file}\n`;
  });
  return out;
}

describe("export refuses non-canonical binding paths", () => {
  for (const bad of NON_CANONICAL) {
    it(`refuses file ${JSON.stringify(bad)} with binding-path-not-canonical`, async () => {
      const run = await exportOf({ bindings: bindingsWithFile(bad) });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(
        "export: binding-path-not-canonical: binding TP-9: file",
      );
      expect(run.stderr).toContain(JSON.stringify(bad));
      expect(run.stdout).toBe("");
    });

    it(`refuses fixtures entry ${JSON.stringify(bad)} with binding-path-not-canonical`, async () => {
      const run = await exportOf({ bindings: bindingsWithFixture(bad) });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(
        "export: binding-path-not-canonical: binding TP-9: fixtures[0]",
      );
      expect(run.stderr).toContain(JSON.stringify(bad));
      expect(run.stdout).toBe("");
    });
  }
});

describe("export drops forbidden paths from allowed_changes_hint", () => {
  it("drops a binding file below a Non-goal directory", async () => {
    const run = await exportOf({
      spec: specWithNonGoalPaths("src/legacy/"),
      bindings: bindingsWithFiles("src/legacy/x.ts"),
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const hint = hintOf(run.stdout);
    expect(hint).not.toContain("  - src/legacy/x.ts\n");
    expect(hint).toBe(hintOf(GOLDEN));
  });

  it("drops a binding file matched by a Non-goal glob", async () => {
    const run = await exportOf({
      spec: specWithNonGoalPaths("src/legacy/**"),
      bindings: bindingsWithFiles("src/legacy/x.ts"),
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const hint = hintOf(run.stdout);
    expect(hint).not.toContain("  - src/legacy/x.ts\n");
    expect(hint).toBe(hintOf(GOLDEN));
  });

  it("drops what a Non-goal glob matches and keeps what it does not", async () => {
    const run = await exportOf({
      spec: specWithNonGoalPaths("src/*.gen.ts"),
      bindings: bindingsWithFiles("src/a.gen.ts", "src/sub/a.gen.ts"),
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const hint = hintOf(run.stdout);
    expect(hint).toContain("  - src/sub/a.gen.ts\n");
    expect(hint).not.toContain("  - src/a.gen.ts\n");
    expect(hint.replace("  - src/sub/a.gen.ts\n", "")).toBe(hintOf(GOLDEN));
  });

  it("never shows the spec's spec.md or testplan.yaml", async () => {
    const run = await exportOf({ bindings: POISONED_BINDINGS });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const hint = hintOf(run.stdout);
    expect(hint).not.toContain("spec.md");
    expect(hint).not.toContain("testplan.yaml");
    expect(hint).toBe(hintOf(GOLDEN));
  });
});

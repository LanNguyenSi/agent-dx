/**
 * The path rules of `spec-gate export --format ow` through the CLI, over
 * temporary git repositories: every named refusal (a binding path or a
 * Non-goal path that is not canonical, a binding path that is a pattern, a
 * Non-goal glob export does not implement) and the drop rule of
 * `allowed_changes_hint` (a Non-goal directory, a Non-goal glob, a glob
 * that matches a directory, a glob that must not overreach, and the spec's
 * own normative files). The rule itself is tabulated in
 * `hint-invariant.test.ts`.
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

/**
 * The same spellings for a `fixtures` entry, which may name a directory
 * and so may end in one `/`: there it takes two to be refused.
 */
const NON_CANONICAL_FIXTURES = NON_CANONICAL.map((bad) =>
  bad.endsWith("/") ? `${bad}/` : bad,
);

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
  }

  for (const bad of NON_CANONICAL_FIXTURES) {
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

  it("reads one trailing slash of a fixtures entry as a directory and still drops what is forbidden", async () => {
    const run = await exportOf({
      bindings:
        `${fixtureText("bindings.yaml")}TP-9:\n` +
        "  status: existing\n" +
        "  file: test/x.test.ts\n" +
        "  fixtures:\n" +
        "    - specs/s1/testplan.yaml/\n" +
        "    - src/auth/\n" +
        "    - test/fixtures/big/\n",
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const hint = hintOf(run.stdout);
    expect(hint).not.toContain("testplan.yaml");
    expect(hint).not.toContain("src/auth");
    expect(hint).toContain("  - test/fixtures/big/\n");
    expect(
      hint
        .replace("  - test/fixtures/big/\n", "")
        .replace("  - test/x.test.ts\n", ""),
    ).toBe(hintOf(GOLDEN));
  });

  for (const pattern of ["src/*", "test/fixtures/**", "src/legac?/a.test.ts"]) {
    it(`refuses file ${JSON.stringify(pattern)} with binding-path-glob`, async () => {
      const run = await exportOf({ bindings: bindingsWithFile(pattern) });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(
        "export: binding-path-glob: binding TP-9: file",
      );
      expect(run.stderr).toContain(JSON.stringify(pattern));
      expect(run.stdout).toBe("");
    });

    it(`refuses fixtures entry ${JSON.stringify(pattern)} with binding-path-glob`, async () => {
      const run = await exportOf({ bindings: bindingsWithFixture(pattern) });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(
        "export: binding-path-glob: binding TP-9: fixtures[0]",
      );
      expect(run.stderr).toContain(JSON.stringify(pattern));
      expect(run.stdout).toBe("");
    });
  }
});

describe("export refuses Non-goal paths it cannot judge", () => {
  const binding = bindingsWithFiles("src/legacy/a.test.ts");

  for (const bad of [
    "./src/legacy",
    "src/legacy//",
    "src/./legacy",
    "src/legacy/.",
    "src//legacy",
  ]) {
    it(`refuses paths entry ${JSON.stringify(bad)} with nongoal-path-not-canonical`, async () => {
      const run = await exportOf({
        spec: specWithNonGoalPaths(`src/keep.ts, ${bad}`),
        bindings: binding,
      });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(
        `export: nongoal-path-not-canonical: NG-1: paths entry ${JSON.stringify(bad)}`,
      );
      expect(run.stdout).toBe("");
    });
  }

  for (const bad of [
    "src/leg?cy/*",
    "src/[l]egacy",
    "src/legacy]",
    "src/{legacy",
    "src/legacy}",
  ]) {
    it(`refuses paths entry ${JSON.stringify(bad)} with nongoal-glob-unsupported`, async () => {
      const run = await exportOf({
        spec: specWithNonGoalPaths(`src/keep.ts, ${bad}`),
        bindings: binding,
      });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(
        `export: nongoal-glob-unsupported: NG-1: paths entry ${JSON.stringify(bad)}`,
      );
      expect(run.stdout).toBe("");
    });
  }
});

describe("export drops forbidden paths from allowed_changes_hint", () => {
  for (const glob of ["src/leg*", "src/legacy*", "*/legacy", "src/**/legacy"]) {
    it(`drops a binding file below a directory the Non-goal glob ${glob} matches`, async () => {
      const run = await exportOf({
        spec: specWithNonGoalPaths(glob),
        bindings: bindingsWithFiles(
          "src/legacy/a.test.ts",
          "src/legacy/b/a.test.ts",
        ),
      });
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      const hint = hintOf(run.stdout);
      expect(hint).not.toContain("src/legacy");
      expect(hint).toBe(hintOf(GOLDEN));
    });
  }

  it("keeps a sibling that only shares a prefix with a Non-goal directory", async () => {
    const run = await exportOf({
      spec: specWithNonGoalPaths("src/legacy"),
      bindings: bindingsWithFiles(
        "src/legacy/a.test.ts",
        "src/legacy-x/a.test.ts",
      ),
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const hint = hintOf(run.stdout);
    expect(hint).toContain("  - src/legacy-x/a.test.ts\n");
    expect(hint).not.toContain("  - src/legacy/a.test.ts\n");
    expect(hint.replace("  - src/legacy-x/a.test.ts\n", "")).toBe(
      hintOf(GOLDEN),
    );
  });

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

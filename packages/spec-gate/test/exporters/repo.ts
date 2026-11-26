/**
 * Fixtures for the export suites, in plain code (no vitest import, so a
 * generator script can build the same repository the tests do): the
 * `export-ow` fixture files, and a temporary repository whose default
 * branch holds them merged, built with the deterministic dates of
 * `test/canonical/helpers.ts` so the commit ids, the digest and the golden
 * output are the same on every run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../canonical/helpers.js";

export const FIXTURES = fileURLToPath(
  new URL("../fixtures/export-ow", import.meta.url),
);

export const SPEC_REL = "specs/s1";
export const REMOTE_MAIN = "refs/remotes/origin/main";
export const COMMANDS_OK =
  'commands:\n  typecheck:\n    argv: ["npm", "run", "typecheck"]\n';

/** The placeholder commit id the fixture frontmatter carries. */
export const PLACEHOLDER = "0123456789abcdef0123456789abcdef01234567";

export function fixtureText(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

/**
 * The fixture bindings with the key order and every fixture list reversed:
 * the same set of paths, a different insertion order. Sorted output must
 * not see the difference.
 */
export const REVERSED_BINDINGS =
  "TP-1:\n" +
  "  status: new\n" +
  "  selector: rejects old token\n" +
  "  file: test/auth.test.ts\n" +
  "  fixtures:\n" +
  "    - test/fixtures/users.json\n" +
  "TP-2:\n" +
  "  status: existing\n" +
  "  selector: login works\n" +
  "  file: test/auth.test.ts\n" +
  "  fixtures:\n" +
  "    - test/fixtures/users.json\n" +
  "    - test/fixtures/tokens.json\n" +
  "TP-4:\n" +
  "  status: existing\n" +
  "  file: test/typecheck.spec.ts\n";

/**
 * The fixture bindings plus a `TP-3` binding that names the spec's own
 * `spec.md` as its `file` and its `testplan.yaml` and a Non-goal path as
 * fixtures: paths the briefing forbids to change, which must never reach
 * `allowed_changes_hint`.
 */
export const POISONED_BINDINGS =
  fixtureText("bindings.yaml") +
  "TP-3:\n" +
  "  status: existing\n" +
  "  file: specs/s1/spec.md\n" +
  "  fixtures:\n" +
  "    - specs/s1/testplan.yaml\n" +
  "    - src/legacy.ts\n";

export interface MergedRepo {
  dir: string;
  spec: string;
  commit: string;
  /** The full commit id the commands file sits at (base and commands_ref). */
  c1: string;
}

export interface MergedRepoOptions {
  /** Write `status: draft` into the committed frontmatter. */
  draft?: boolean;
  /** Move the default branch to the spec commit (the merge). Default true. */
  merge?: boolean;
  /** Replace `bindings.yaml`. */
  bindings?: string;
}

/**
 * A repository with `README.md` and `.spec-gate/commands.yaml` at one
 * commit, then the `export-ow` spec files (with `commands_ref` set to that
 * commit) at the next. `refs/remotes/origin/main` follows the last commit
 * unless `merge` is false, which leaves the spec unmerged.
 */
export async function makeMergedRepo(
  options: MergedRepoOptions = {},
): Promise<MergedRepo> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-export-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  let day = 2;
  const write = (files: Record<string, string>): void => {
    for (const [rel, text] of Object.entries(files)) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
  };
  write({
    "README.md": "one\n",
    ".spec-gate/commands.yaml": COMMANDS_OK,
  });
  await git(dir, ["add", "-A"], day);
  await git(dir, ["commit", "-q", "-m", "commands"], day);
  const c1 = await git(dir, ["rev-parse", "HEAD"], day);
  day = 3;
  let spec = fixtureText("spec.md").split(PLACEHOLDER).join(c1);
  if (options.draft === true) {
    spec = spec.replace("status: proposed", "status: draft");
  }
  write({
    [`${SPEC_REL}/spec.md`]: spec,
    [`${SPEC_REL}/testplan.yaml`]: fixtureText("testplan.yaml"),
    [`${SPEC_REL}/bindings.yaml`]:
      options.bindings ?? fixtureText("bindings.yaml"),
  });
  await git(dir, ["add", "-A"], day);
  await git(dir, ["commit", "-q", "-m", "spec"], day);
  const commit = await git(dir, ["rev-parse", "HEAD"], day);
  if (options.merge ?? true) {
    await git(dir, ["update-ref", REMOTE_MAIN, commit], day);
  } else {
    await git(dir, ["update-ref", REMOTE_MAIN, c1], day);
  }
  return { dir, spec: path.join(dir, SPEC_REL), commit, c1 };
}

/** The export arguments of the merged repository. */
export function exportArgs(repo: MergedRepo): string[] {
  return [
    repo.spec,
    "--format",
    "ow",
    "--repo",
    repo.dir,
    "--default-ref",
    REMOTE_MAIN,
  ];
}

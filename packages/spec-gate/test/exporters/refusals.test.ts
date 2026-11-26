/**
 * The named refusals of `spec-gate export` through the CLI, one case per
 * error code and per place a code is raised from: the reference commit,
 * the work tree, the parsers, the digest, the exporter and the slicer
 * return. Every case exits 2, prints nothing on stdout and names its code
 * and its cause on stderr, so a refusal cannot change its name unnoticed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../lint/helpers.js";
import {
  PLACEHOLDER,
  REMOTE_MAIN,
  SPEC_REL,
  exportArgs,
  fixtureText,
  makeMergedRepo,
  type MergedRepo,
  type MergedRepoOptions,
} from "./repo.js";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-refusal-"));
  roots.push(dir);
  return dir;
}

const EXPORT_TIMEOUT_MS = 60_000;

/** One byte more than a spec file may have, as a YAML comment. */
const OVERSIZE_COMMENT = `#${"x".repeat(4 * 1024 * 1024)}\n`;

const AT_COMMIT = `at ${REMOTE_MAIN}`;

/** The default `after`: the work tree stays as merged. */
function leaveAsMerged(repo: MergedRepo): void {
  void repo;
}

interface Refusal {
  code: string;
  from: string;
  /** Text the refusal must carry next to its code. */
  says: string[];
  /** How the repository is built. */
  options?: MergedRepoOptions;
  /** A change to the work tree after the merge. */
  after?: typeof leaveAsMerged;
  /** The export arguments, when not the usual ones. */
  args?: typeof exportArgs;
}

const bindingsFile = (dir: string): string =>
  path.join(dir, SPEC_REL, "bindings.yaml");

const REFUSALS: Refusal[] = [
  {
    code: "not-regular",
    from: "a symbolic link committed in place of bindings.yaml",
    says: [
      `${SPEC_REL}/bindings.yaml ${AT_COMMIT}`,
      "is not a regular file in the tree",
    ],
    options: {
      beforeCommit: (dir) => {
        fs.writeFileSync(
          path.join(dir, "kept-bindings.yaml"),
          fixtureText("bindings.yaml"),
        );
        fs.rmSync(bindingsFile(dir));
        fs.symlinkSync("../../kept-bindings.yaml", bindingsFile(dir));
      },
    },
  },
  {
    code: "not-utf8",
    from: "a bindings.yaml committed with bytes that are not UTF-8",
    says: [`${SPEC_REL}/bindings.yaml ${AT_COMMIT}`, "is not valid UTF-8"],
    options: {
      beforeCommit: (dir) => {
        fs.writeFileSync(bindingsFile(dir), Buffer.from([0xff, 0xfe, 0x0a]));
      },
    },
  },
  {
    code: "input-too-large",
    from: "a bindings.yaml committed over the size limit",
    says: [`${SPEC_REL}/bindings.yaml ${AT_COMMIT}`, "is larger than"],
    options: {
      beforeCommit: (dir) => {
        fs.appendFileSync(bindingsFile(dir), OVERSIZE_COMMENT);
      },
    },
  },
  {
    code: "input-too-large",
    from: "a work tree bindings.yaml grown over the size limit",
    says: [`the work tree copy of ${SPEC_REL}/bindings.yaml is`, "the limit"],
    after: (repo) => {
      fs.appendFileSync(bindingsFile(repo.dir), OVERSIZE_COMMENT);
    },
  },
  {
    code: "path-invalid",
    from: "a spec directory whose name the commit read does not accept",
    says: ["specs/s 1 is not a path this command can read from a commit"],
    after: (repo) => {
      fs.mkdirSync(path.join(repo.dir, "specs", "s 1"));
    },
    args: (repo) => [
      path.join(repo.dir, "specs", "s 1"),
      "--format",
      "ow",
      "--repo",
      repo.dir,
      "--default-ref",
      REMOTE_MAIN,
    ],
  },
  {
    code: "spec-invalid",
    from: "a spec.md the parser refuses",
    says: ["spec.md is not valid"],
    options: {
      spec: fixtureText("spec.md").replace("## Acceptance", "## Wishes"),
    },
  },
  {
    code: "spec-invalid",
    from: "a spec.md without a GOAL line",
    says: ["spec.md states no goal"],
    options: {
      spec: fixtureText("spec.md").replace(
        "- GOAL: Reject a token that was issued before a password change.\n",
        "",
      ),
    },
  },
  {
    code: "testplan-invalid",
    from: "a testplan.yaml the parser refuses",
    says: ["testplan.yaml is not valid"],
    options: { testplan: "- id: TP-1\n  kind: no-such-kind\n" },
  },
  {
    code: "bindings-invalid",
    from: "a bindings.yaml the parser refuses",
    says: ["bindings.yaml is not valid"],
    options: { bindings: "TP-1:\n  status: no-such-status\n" },
  },
  {
    code: "digest-failed",
    from: "a commands_ref that names no commit",
    says: ["the digest of the spec could not be computed"],
    options: {
      spec: fixtureText("spec.md").replace(
        `commands_ref: ${PLACEHOLDER}`,
        `commands_ref: ${"f".repeat(40)}`,
      ),
    },
  },
  {
    code: "repo-invalid",
    from: "a --repo that is no repository",
    says: ["--repo"],
    args: (repo) => [
      repo.spec,
      "--format",
      "ow",
      "--repo",
      scratchDir(),
      "--default-ref",
      REMOTE_MAIN,
    ],
  },
];

describe("spec-gate export --format ow names every refusal", () => {
  for (const refusal of REFUSALS) {
    it(`${refusal.code}: ${refusal.from}`, async () => {
      const repo = await makeMergedRepo(refusal.options ?? {});
      roots.push(repo.dir);
      (refusal.after ?? leaveAsMerged)(repo);
      const run = await runCli(
        ["export", ...(refusal.args ?? exportArgs)(repo)],
        EXPORT_TIMEOUT_MS,
      );
      expect(run.stderr).toContain(`spec-gate: export: ${refusal.code}: `);
      for (const text of refusal.says) expect(run.stderr).toContain(text);
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
    });
  }
});

/** A spec directory for `--check` and a slicer return with these bytes. */
function checkInputs(returnBytes: Buffer): { dir: string; file: string } {
  const dir = scratchDir();
  fs.writeFileSync(path.join(dir, "spec.md"), fixtureText("spec.md"));
  fs.writeFileSync(
    path.join(dir, "testplan.yaml"),
    fixtureText("testplan.yaml"),
  );
  const file = path.join(dir, "return.yaml");
  fs.writeFileSync(file, returnBytes);
  return { dir, file };
}

describe("spec-gate export --check names every refusal of the return", () => {
  it("not-utf8: a slicer return with bytes that are not UTF-8", async () => {
    const { dir, file } = checkInputs(
      Buffer.concat([
        Buffer.from("tasks:\n  - notes: tiny-valid#AC-1 "),
        Buffer.from([0xff, 0xfe]),
        Buffer.from("\n"),
      ]),
    );
    const run = await runCli(["export", dir, "--check", file]);
    expect(run.stderr).toContain(
      "spec-gate: export: not-utf8: the slicer return is not valid UTF-8",
    );
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
  });

  it("input-too-large: a slicer return over the size limit", async () => {
    const { dir, file } = checkInputs(
      Buffer.from(`tasks:\n  - notes: x\n${OVERSIZE_COMMENT}`),
    );
    const run = await runCli(["export", dir, "--check", file]);
    expect(run.stderr).toContain(
      "spec-gate: export: input-too-large: the slicer return is",
    );
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
  });
});

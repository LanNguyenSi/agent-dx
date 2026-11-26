/**
 * `spec-gate export --format ow` over temporary git repositories: merged,
 * not merged, changed after the merge (a byte order mark and a line ending
 * included), draft, a symbolic link in the work tree, a linked repository
 * directory; the golden output, its determinism and the rule that a
 * forbidden path never enters `allowed_changes_hint`.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../lint/helpers.js";
import {
  FIXTURES,
  POISONED_BINDINGS,
  REMOTE_MAIN,
  REVERSED_BINDINGS,
  SPEC_REL,
  exportArgs,
  fixtureText,
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

/** The briefing without its `spec_ref` line: the commit id is not part of it. */
const dropRef = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("spec_ref:"))
    .join("\n");

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
    expect(dropRef(b.stdout)).toBe(dropRef(a.stdout));
  });

  it("keeps forbidden paths out of the hint when a binding names them", async () => {
    const repo = await mergedRepo({ bindings: POISONED_BINDINGS });
    const run = await runCli(
      ["export", ...exportArgs(repo)],
      EXPORT_TIMEOUT_MS,
    );
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    // The hint is the last key: the block runs to the end of the document.
    const hint = (text: string): string =>
      text.split("allowed_changes_hint:\n")[1] ?? "";
    expect(hint(run.stdout)).toContain("  - test/auth.test.ts\n");
    expect(hint(run.stdout)).not.toContain("spec.md");
    expect(hint(run.stdout)).not.toContain("testplan.yaml");
    expect(hint(run.stdout)).not.toContain("src/legacy.ts");
    // The whole hint is the golden one: the three poisoned paths are gone
    // and every clean binding path is still there.
    expect(hint(run.stdout)).toBe(hint(GOLDEN));
    // And nothing else in the briefing changed either.
    expect(dropRef(run.stdout)).toBe(dropRef(GOLDEN));
  });

  // Each of the three files is compared on its own: a check that skips
  // one of them would let that file differ from the default branch.
  const CHANGES = [
    [
      "that only adds a byte order mark",
      (file: string) => {
        fs.writeFileSync(
          file,
          Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            fs.readFileSync(file),
          ]),
        );
      },
    ],
    [
      "that only changes line endings",
      (file: string) => {
        const text = fs.readFileSync(file, "utf8");
        fs.writeFileSync(file, text.split("\n").join("\r\n"));
      },
    ],
    [
      "changed after the merge",
      (file: string) => {
        fs.appendFileSync(file, "\n");
      },
    ],
  ] as const;

  for (const name of ["spec.md", "testplan.yaml", "bindings.yaml"]) {
    for (const [what, change] of CHANGES) {
      it(`refuses a work tree ${name} ${what}`, async () => {
        const repo = await mergedRepo();
        change(path.join(repo.spec, name));
        const run = await runCli(
          ["export", ...exportArgs(repo)],
          EXPORT_TIMEOUT_MS,
        );
        expect(run.code).toBe(2);
        expect(run.stderr).toContain(
          `export: not-merged: specs/s1/${name} is not merged unchanged`,
        );
        expect(run.stdout).toBe("");
      });
    }
  }

  it("exports a spec reached through a linked repository directory", async () => {
    const repo = await mergedRepo();
    const link = `${repo.dir}-link`;
    fs.symlinkSync(repo.dir, link);
    try {
      const run = await runCli(
        [
          "export",
          path.join(link, SPEC_REL),
          "--format",
          "ow",
          "--repo",
          link,
          "--default-ref",
          REMOTE_MAIN,
        ],
        EXPORT_TIMEOUT_MS,
      );
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      // git resolves the link, so the export works through the real path
      // and the briefing is the golden one.
      expect(run.stdout).toBe(GOLDEN);
    } finally {
      fs.rmSync(link);
    }
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

  it("refuses a superseded spec merged on the default branch", async () => {
    const repo = await mergedRepo({
      spec: fixtureText("spec.md").replace(
        "status: proposed",
        "status: superseded\nsuperseded_by: other-spec",
      ),
    });
    const run = await runCli(
      ["export", ...exportArgs(repo)],
      EXPORT_TIMEOUT_MS,
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      "export: not-proposed: specs/s1/spec.md has status superseded",
    );
    expect(run.stdout).toBe("");
  });
});

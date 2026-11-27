import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeBases,
  specDigestAt,
  specDirMatchesCommit,
  specStateAt,
} from "../../src/approve/index.js";
import { computeSpecDigest } from "../../src/canonical/index.js";
import { LintGitError } from "../../src/lint/git/index.js";
import {
  COMMANDS_OK,
  REMOTE_MAIN,
  Repo,
  SPEC_REL,
  STATIC_PLAN,
  specFiles,
  type Change,
} from "../lint/git-helpers.js";
import { scratch } from "../lint/helpers.js";
import { build, crissCross, staleBase, type SpecChange } from "./helpers.js";

const NO_COMMIT = "0".repeat(40);

describe("specDigestAt", { timeout: 60_000 }, () => {
  it("is the digest computeSpecDigest gives for the checked-out spec directory", async () => {
    const s = await build();
    const digest = specDigestAt(s.dir, s.head, SPEC_REL);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digest).toBe(computeSpecDigest(s.spec, { repo: s.dir }));
  });

  it("is that digest for a plan that refers to a command, read at commands_ref", async () => {
    const repo = await Repo.create();
    const c1 = await repo.commit(
      { ".spec-gate/commands.yaml": COMMANDS_OK },
      "commands",
    );
    const head = await repo.commit(
      specFiles({ base: c1, ref: c1, plan: STATIC_PLAN }),
      "spec",
    );
    const digest = specDigestAt(repo.dir, head, SPEC_REL);
    expect(digest).toBe(computeSpecDigest(repo.spec, { repo: repo.dir }));
    // The argv list is part of the digest: the same spec against another
    // command set has another one.
    const c2 = await repo.commit(
      {
        ".spec-gate/commands.yaml":
          'commands:\n  typecheck:\n    argv: ["true"]\n',
      },
      "other commands",
    );
    const moved = await repo.commit(
      specFiles({ base: c1, ref: c2, plan: STATIC_PLAN }),
      "spec at other commands",
    );
    expect(specDigestAt(repo.dir, moved, SPEC_REL)).not.toBe(digest);
  });

  it("reads the commit, not the work tree and not the head", async () => {
    const s = await build();
    const atDraft = specDigestAt(s.dir, s.draft, SPEC_REL);
    // The status is outside the digest: draft and proposed agree.
    expect(atDraft).toBe(specDigestAt(s.dir, s.head, SPEC_REL));
    const file = path.join(s.spec, "spec.md");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("HTTP 401");
    fs.writeFileSync(file, text.replace("HTTP 401", "HTTP 403"));
    expect(specDigestAt(s.dir, s.head, SPEC_REL)).toBe(atDraft);
    const next = await s.repo.commit({}, "normative change");
    const atNext = specDigestAt(s.dir, next, SPEC_REL);
    expect(atNext).toMatch(/^sha256:/);
    expect(atNext).not.toBe(atDraft);
    expect(specDigestAt(s.dir, s.head, SPEC_REL)).toBe(atDraft);
  });

  it("is null where no digest exists, and only there", async () => {
    const s = await build();
    const read = (name: string) =>
      fs.readFileSync(path.join(s.spec, name), "utf8");
    const good = { spec: read("spec.md"), plan: read("testplan.yaml") };
    const expected = specDigestAt(s.dir, s.head, SPEC_REL);
    expect(expected).toMatch(/^sha256:/);
    /** The digest at a commit that holds the good files, `change` applied. */
    const digestWith = async (
      what: string,
      change: Record<string, Change>,
    ): Promise<string | null> => {
      const files: Record<string, Change> = {
        "spec.md": good.spec,
        "testplan.yaml": good.plan,
        ...change,
      };
      const commit = await s.repo.commit(
        Object.fromEntries(
          Object.entries(files).map(([name, to]) => [
            `${SPEC_REL}/${name}`,
            to,
          ]),
        ),
        what,
      );
      return specDigestAt(s.dir, commit, SPEC_REL);
    };

    expect(specDigestAt(s.dir, s.c1, SPEC_REL)).toBeNull();
    expect(specDigestAt(s.dir, NO_COMMIT, SPEC_REL)).toBeNull();
    expect(specDigestAt(s.dir, "HEAD", SPEC_REL)).toBeNull();
    expect(specDigestAt(s.dir, s.head, "specs/other")).toBeNull();

    expect(await digestWith("no change", {})).toBe(expected);
    expect(
      await digestWith("broken plan", { "testplan.yaml": "- id: [\n" }),
    ).toBeNull();
    expect(await digestWith("no plan", { "testplan.yaml": null })).toBeNull();
    expect(
      await digestWith("broken spec", { "spec.md": "no frontmatter\n" }),
    ).toBeNull();
    expect(await digestWith("no spec", { "spec.md": null })).toBeNull();
    expect(
      await digestWith("spec.md is a link", {
        "real.md": good.spec,
        "spec.md": { linkTo: "real.md" },
      }),
    ).toBeNull();
    expect(
      await digestWith("a plan that names a command of the set", {
        "testplan.yaml": STATIC_PLAN,
      }),
    ).toMatch(/^sha256:/);
    expect(
      await digestWith("a plan that names a command the set lacks", {
        "testplan.yaml": STATIC_PLAN.replace(
          "check_command_ref: typecheck",
          "check_command_ref: nope",
        ),
      }),
    ).toBeNull();
    // No command is referred to, and still commands_ref must be a commit,
    // as for the digest of a spec directory.
    const noRef = good.spec.replace(
      /^commands_ref: .*$/m,
      `commands_ref: ${"d".repeat(40)}`,
    );
    expect(noRef).not.toBe(good.spec);
    expect(
      await digestWith("commands_ref is no commit", { "spec.md": noRef }),
    ).toBeNull();
    // The spec itself parses there: it is the reference that is refused.
    expect(specStateAt(s.dir, await s.repo.head(), SPEC_REL)).toEqual({
      id: "tiny-valid",
      status: "proposed",
    });
    expect(() => computeSpecDigest(s.spec, { repo: s.dir })).toThrow(
      /commands_ref .* is not a commit/,
    );
    expect(await digestWith("the good files again", {})).toBe(expected);
  });
});

describe("specStateAt", { timeout: 60_000 }, () => {
  it("reads id and status from the commit, whatever the work tree says", async () => {
    const s = await build();
    fs.rmSync(path.join(s.spec, "spec.md"));
    expect(specStateAt(s.dir, s.head, SPEC_REL)).toEqual({
      id: "tiny-valid",
      status: "proposed",
    });
    expect(specStateAt(s.dir, s.draft, SPEC_REL)).toEqual({
      id: "tiny-valid",
      status: "draft",
    });
    expect(specStateAt(s.dir, s.c1, SPEC_REL)).toBeNull();
    expect(specStateAt(s.dir, NO_COMMIT, SPEC_REL)).toBeNull();
  });
});

describe("specDirMatchesCommit", { timeout: 60_000 }, () => {
  const matches = (s: { dir: string; head: string; spec: string }) =>
    specDirMatchesCommit(s.dir, s.head, SPEC_REL, s.spec);

  it("holds for a clean checkout, also with an executable file, a nested directory and a file of several megabytes", async () => {
    const s = await build();
    expect(matches(s)).toBe(true);
    fs.mkdirSync(path.join(s.spec, "evidence/run"), { recursive: true });
    fs.writeFileSync(path.join(s.spec, "evidence/run/e.json"), "{}\n");
    fs.writeFileSync(path.join(s.spec, "tool.sh"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    const big = path.join(s.spec, "evidence/big.bin");
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 123, "x");
    fs.writeFileSync(big, bytes);
    await s.repo.sh("add", "-A");
    const head = await s.repo.commit({}, "more files");
    expect(matches({ ...s, head })).toBe(true);
    // An empty directory is nothing git tracks.
    fs.mkdirSync(path.join(s.spec, "empty"));
    expect(matches({ ...s, head })).toBe(true);
    // One byte near the end of the large file, the length unchanged.
    bytes[bytes.length - 2] = 0x79;
    fs.writeFileSync(big, bytes);
    expect(matches({ ...s, head })).toBe(false);
  });

  it("holds in a SHA-256 repository", async () => {
    const repo = await Repo.create({ sha256: true });
    const c1 = await repo.commit(
      { ".spec-gate/commands.yaml": COMMANDS_OK },
      "commands",
    );
    await repo.setRef(REMOTE_MAIN, c1);
    const head = await repo.commit(specFiles({ base: c1, ref: c1 }), "spec");
    expect(head).toHaveLength(64);
    expect(specDirMatchesCommit(repo.dir, head, SPEC_REL, repo.spec)).toBe(
      true,
    );
    fs.appendFileSync(path.join(repo.spec, "spec.md"), "\n");
    expect(specDirMatchesCommit(repo.dir, head, SPEC_REL, repo.spec)).toBe(
      false,
    );
  });

  it("does not hold with a work tree that differs, whatever the difference", async () => {
    const s = await build();
    const cases: [string, SpecChange][] = [
      [
        "a changed file",
        (spec) => fs.appendFileSync(path.join(spec, "spec.md"), "\n"),
      ],
      [
        "a changed file of the same length",
        (spec) => {
          const file = path.join(spec, "bindings.yaml");
          const text = fs.readFileSync(file, "utf8");
          fs.writeFileSync(file, text.replace("status: new", "status: neW"));
        },
      ],
      [
        "an untracked file",
        (spec) => fs.writeFileSync(path.join(spec, "acks.yaml"), "[]\n"),
      ],
      [
        "an untracked file in a new directory",
        (spec) => {
          fs.mkdirSync(path.join(spec, "evidence"));
          fs.writeFileSync(path.join(spec, "evidence/e.json"), "{}\n");
        },
      ],
      [
        "a missing file",
        (spec) => fs.rmSync(path.join(spec, "source/meta.json")),
      ],
      [
        "a file under another name",
        (spec) =>
          fs.renameSync(
            path.join(spec, "source/meta.json"),
            path.join(spec, "source/meta2.json"),
          ),
      ],
      [
        "a file replaced by a link to a file with the same bytes",
        (spec) => {
          fs.renameSync(path.join(spec, "spec.md"), path.join(spec, "..", "x"));
          fs.symlinkSync("../x", path.join(spec, "spec.md"));
        },
      ],
      [
        "a directory replaced by a link to a directory with the same files",
        (spec) => {
          fs.renameSync(
            path.join(spec, "source"),
            path.join(spec, "..", "src"),
          );
          fs.symlinkSync("../src", path.join(spec, "source"));
        },
      ],
      [
        "an untracked link",
        (spec) => fs.symlinkSync("spec.md", path.join(spec, "also.md")),
      ],
    ];
    for (const [what, change] of cases) {
      expect(matches(s), `clean before ${what}`).toBe(true);
      change(s.spec);
      expect(matches(s), what).toBe(false);
      await s.repo.sh("checkout", "-q", "--", ".");
      await s.repo.sh("clean", "-fdq");
    }
    expect(matches(s)).toBe(true);
  });

  it("does not hold when the commit holds a link there, with the link in the work tree or without it", async () => {
    const s = await build();
    const linked = await s.repo.commit(
      { [`${SPEC_REL}/also.md`]: { linkTo: "spec.md" } },
      "a link",
    );
    expect(matches({ ...s, head: linked })).toBe(false);
    fs.rmSync(path.join(s.spec, "also.md"));
    expect(matches({ ...s, head: linked })).toBe(false);
    // Without the link the work tree is the commit before.
    expect(matches(s)).toBe(true);
  });

  it("compares with the commit it is given, not with HEAD", async () => {
    const s = await build();
    expect(specDirMatchesCommit(s.dir, s.draft, SPEC_REL, s.spec)).toBe(false);
    expect(specDirMatchesCommit(s.dir, s.c1, SPEC_REL, s.spec)).toBe(false);
  });

  it("a tree that cannot be read is an error, not an answer", async () => {
    const s = await build();
    for (const [commit, specPath] of [
      [NO_COMMIT, SPEC_REL],
      ["HEAD", SPEC_REL],
      [s.head, "specs/a b"],
      [s.head, "specs/../specs/s1"],
    ] as const) {
      expect(() =>
        specDirMatchesCommit(s.dir, commit, specPath, s.spec),
      ).toThrow(LintGitError);
    }
  });
});

describe("mergeBases", { timeout: 60_000 }, () => {
  it("is the one commit two histories forked at", async () => {
    const s = await build();
    expect(mergeBases(s.dir, s.head, s.c1)).toEqual([s.c1]);
    expect(mergeBases(s.dir, s.c1, s.head)).toEqual([s.c1]);
    expect(mergeBases(s.dir, s.head, s.head)).toEqual([s.head]);
  });

  it("is the merged commit once the head merged a newer one", async () => {
    const s = await staleBase("spec-deleted");
    expect(mergeBases(s.dir, s.head, s.newer)).toEqual([s.newer]);
  });

  it.each([["side"], ["default"]] as const)(
    "lists both merge bases of histories that crossed (the %s commit committed last)",
    async (later) => {
      const s = await crissCross("spec-deleted", later);
      const all = mergeBases(s.dir, s.head, s.newer);
      expect(all).toHaveLength(2);
      expect([...all].sort()).toEqual([...s.bases].sort());
    },
  );

  it("is empty for two histories without a common commit", async () => {
    const s = await build();
    await s.repo.sh("checkout", "-q", "--orphan", "lone");
    const lone = await s.repo.commit({ "lone.txt": "lone\n" }, "no parent");
    expect(mergeBases(s.dir, lone, s.c1)).toEqual([]);
  });

  it("throws for a value that is no full commit id, and for a commit the repository lacks", async () => {
    const s = await build();
    for (const bad of ["HEAD", "main", s.head.slice(0, 12), "--all", ""]) {
      expect(() => mergeBases(s.dir, bad, s.c1)).toThrow(LintGitError);
      expect(() => mergeBases(s.dir, s.c1, bad)).toThrow(LintGitError);
    }
    expect(() => mergeBases(s.dir, NO_COMMIT, s.c1)).toThrow(LintGitError);
  });
});

describe("mergeBases: what git answers", { timeout: 60_000 }, () => {
  const saved = process.env["PATH"];
  afterEach(() => {
    process.env["PATH"] = saved;
  });

  /**
   * A `git` first on PATH that answers every `merge-base` call with
   * `output` and the exit status `status`; every other call goes to the
   * real git.
   */
  function answering(output: string, status: number): void {
    const dir = fs.mkdtempSync(path.join(scratch(), "answering-git-"));
    const real = [
      "/usr/bin/git",
      "/opt/homebrew/bin/git",
      "/usr/local/bin/git",
    ].find((p) => fs.existsSync(p))!;
    fs.writeFileSync(path.join(dir, "out"), output);
    fs.writeFileSync(
      path.join(dir, "git"),
      [
        "#!/bin/sh",
        'for a in "$@"; do',
        `  if [ "$a" = "merge-base" ]; then cat "${dir}/out"; exit ${status}; fi`,
        "done",
        `exec "${real}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env["PATH"] = `${dir}${path.delimiter}${saved ?? ""}`;
  }

  const A = "a".repeat(40);
  const B = "b".repeat(40);

  it("returns every id git lists, in its order", async () => {
    const s = await build();
    answering(`${B}\n${A}\n`, 0);
    expect(mergeBases(s.dir, s.head, s.c1)).toEqual([B, A]);
  });

  it("is empty only for exit 1 without output", async () => {
    const s = await build();
    answering("", 1);
    expect(mergeBases(s.dir, s.head, s.c1)).toEqual([]);
  });

  it.each([
    ["exit 0 without output: never read as no shared history", "", 0],
    ["exit 0 with a line that is no commit id", "not-an-id\n", 0],
    ["exit 0 with a commit id and a line that is none", `${A}\nHEAD\n`, 0],
    ["exit 1 with output", `${A}\n`, 1],
    ["another exit status with a commit id", `${A}\n`, 2],
    ["exit 128 without output", "", 128],
  ])("throws for %s", async (_what, output, status) => {
    const s = await build();
    answering(output, status);
    expect(() => mergeBases(s.dir, s.head, s.c1)).toThrow(LintGitError);
  });
});

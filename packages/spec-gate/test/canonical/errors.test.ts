import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DigestError,
  assertCommit,
  computeSpecDigest,
  describeDigestError,
  readCommandsFile,
} from "../../src/canonical/index.js";
import {
  COMMANDS_FILE,
  git,
  makeRepo,
  runBounded,
  tempDir,
} from "./helpers.js";

const fixtures = fileURLToPath(
  new URL("../fixtures/golden-digest/", import.meta.url),
);
const baseSpec = fs.readFileSync(path.join(fixtures, "base/spec.md"), "utf8");
const basePlan = fs.readFileSync(
  path.join(fixtures, "base/testplan.yaml"),
  "utf8",
);
const baseCommands = fs.readFileSync(
  path.join(fixtures, "repo", COMMANDS_FILE),
  "utf8",
);
const baseRef = /^commands_ref: ([0-9a-f]+)$/m.exec(baseSpec)![1]!;

// A plan with no static row: it needs no commands file.
const planWithoutCommands = basePlan.replace(/- id: TP-4\n(?: {2}.*\n)+/, "");

let scratch = "";
let repo: string;
let counter = 0;

beforeAll(async () => {
  scratch = tempDir("spec-gate-errors-");
  repo = (
    await makeRepo(scratch, [[{ path: COMMANDS_FILE, content: baseCommands }]])
  ).dir;
}, 60_000);

afterAll(() => {
  if (scratch !== "") fs.rmSync(scratch, { recursive: true, force: true });
});

function specDir(files: Record<string, string | Buffer | null> = {}): string {
  const dir = path.join(scratch, `spec-${counter++}`);
  fs.mkdirSync(dir);
  const all: Record<string, string | Buffer | null> = {
    "spec.md": baseSpec,
    "testplan.yaml": basePlan,
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    if (content !== null) fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function failure(run: () => unknown): DigestError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(DigestError);
    return err as DigestError;
  }
  throw new Error("expected a DigestError, got a digest");
}

describe("the inputs", () => {
  it("computes a digest for a valid directory", () => {
    expect(computeSpecDigest(specDir(), { repo })).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it("refuses a spec directory that is not a directory", () => {
    const missing = path.join(scratch, "no-such-dir");
    expect(failure(() => computeSpecDigest(missing, { repo })).code).toBe(
      "spec-dir-invalid",
    );
    const file = path.join(scratch, "a-file");
    fs.writeFileSync(file, "x");
    expect(failure(() => computeSpecDigest(file, { repo })).code).toBe(
      "spec-dir-invalid",
    );
  });

  it("names the missing input", () => {
    const a = failure(() =>
      computeSpecDigest(specDir({ "spec.md": null }), { repo }),
    );
    expect(a.code).toBe("input-missing");
    expect(a.file).toBe("spec.md");
    const b = failure(() =>
      computeSpecDigest(specDir({ "testplan.yaml": null }), { repo }),
    );
    expect(b.code).toBe("input-missing");
    expect(b.file).toBe("testplan.yaml");
  });

  it("refuses a link or a directory in place of an input", () => {
    const linked = specDir({ "spec.md": null });
    fs.symlinkSync(
      path.join(fixtures, "base/spec.md"),
      path.join(linked, "spec.md"),
    );
    expect(failure(() => computeSpecDigest(linked, { repo })).code).toBe(
      "input-not-regular",
    );
    const dir = specDir({ "testplan.yaml": null });
    fs.mkdirSync(path.join(dir, "testplan.yaml"));
    expect(failure(() => computeSpecDigest(dir, { repo })).code).toBe(
      "input-not-regular",
    );
  });

  it("refuses an input over the size limit", () => {
    const big = specDir({
      "testplan.yaml": Buffer.alloc(4 * 1024 * 1024 + 1, 0x61),
    });
    const err = failure(() => computeSpecDigest(big, { repo }));
    expect(err.code).toBe("input-too-large");
    expect(err.file).toBe("testplan.yaml");
  });

  it("refuses bytes that are not UTF-8 instead of replacing them", () => {
    const bytes = Buffer.concat([
      Buffer.from(baseSpec),
      Buffer.from([0xff, 0x0a]),
    ]);
    const err = failure(() =>
      computeSpecDigest(specDir({ "spec.md": bytes }), { repo }),
    );
    expect(err.code).toBe("input-not-utf8");
    expect(err.file).toBe("spec.md");
  });

  it("surfaces the format errors of spec.md", () => {
    const err = failure(() =>
      computeSpecDigest(specDir({ "spec.md": "no frontmatter\n" }), { repo }),
    );
    expect(err.code).toBe("spec-invalid");
    expect(err.file).toBe("spec.md");
    expect(err.formatErrors?.map((e) => e.code)).toEqual([
      "missing-frontmatter",
    ]);
    const text = describeDigestError(err);
    expect(text).toContain("[spec-invalid]");
    expect(text).toContain("[missing-frontmatter] spec.md frontmatter line 1:");
  });

  it("surfaces the format errors of testplan.yaml", () => {
    const err = failure(() =>
      computeSpecDigest(specDir({ "testplan.yaml": "- id: TP-1\n" }), { repo }),
    );
    expect(err.code).toBe("testplan-invalid");
    expect(err.file).toBe("testplan.yaml");
    expect(err.formatErrors?.map((e) => e.code)).toContain("missing-field");
    expect(describeDigestError(err)).toContain("testplan.yaml TP-1.kind");
  });

  it("reports a spec error before it looks at the repository", () => {
    const err = failure(() =>
      computeSpecDigest(specDir({ "spec.md": "x" }), {
        repo: path.join(scratch, "no-such-repo"),
      }),
    );
    expect(err.code).toBe("spec-invalid");
  });
});

describe("the repository and commands_ref", () => {
  it("refuses a directory that is not in a git work tree, when no repo is given", () => {
    const err = failure(() => computeSpecDigest(specDir()));
    expect(err.code).toBe("repo-not-found");
    expect(err.message).toContain("--repo");
  });

  it("refuses a --repo that is not a git repository", () => {
    const plain = path.join(scratch, "plain");
    fs.mkdirSync(plain);
    expect(
      failure(() => computeSpecDigest(specDir(), { repo: plain })).code,
    ).toBe("repo-invalid");
    expect(
      failure(() =>
        computeSpecDigest(specDir(), { repo: path.join(scratch, "missing") }),
      ).code,
    ).toBe("repo-invalid");
  });

  it("refuses a commands_ref that is not a commit in the repository", () => {
    const other = `${"1".repeat(39)}a`;
    const dir = specDir({ "spec.md": baseSpec.replace(baseRef, other) });
    const err = failure(() => computeSpecDigest(dir, { repo }));
    expect(err.code).toBe("commands-ref-unresolvable");
    expect(err.message).toContain(other);
  });

  it("refuses a commands_ref that names a blob, not a commit", async () => {
    const made = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: baseCommands }],
    ]);
    const blob = (
      await runBounded("git", ["rev-parse", `HEAD:${COMMANDS_FILE}`], {
        cwd: made.dir,
      })
    ).stdout.trim();
    const dir = specDir({ "spec.md": baseSpec.replace(baseRef, blob) });
    expect(failure(() => computeSpecDigest(dir, { repo: made.dir })).code).toBe(
      "commands-ref-unresolvable",
    );
  });

  it("refuses a missing commands file when a row refers to a command", async () => {
    const made = await makeRepo(scratch, [
      [{ path: "README.md", content: "x\n" }],
    ]);
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
    });
    const err = failure(() => computeSpecDigest(dir, { repo: made.dir }));
    expect(err.code).toBe("commands-file-missing");
    expect(err.message).toContain(made.shas[0]!);
  });

  it("treats a directory in place of the commands file as missing", async () => {
    const made = await makeRepo(scratch, [
      [{ path: `${COMMANDS_FILE}/inner.yaml`, content: "x\n" }],
    ]);
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
    });
    expect(failure(() => computeSpecDigest(dir, { repo: made.dir })).code).toBe(
      "commands-file-missing",
    );
  });

  it("refuses a link in place of the commands file, whatever it points at", async () => {
    const made = await makeRepo(scratch, [
      [
        { path: "real/commands.yaml", content: baseCommands },
        { path: COMMANDS_FILE, linkTo: "../real/commands.yaml" },
      ],
    ]);
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
    });
    const err = failure(() => computeSpecDigest(dir, { repo: made.dir }));
    expect(err.code).toBe("commands-file-missing");
    expect(err.message).toContain("120000");
  });

  it("refuses a link in place of the .spec-gate directory", async () => {
    const made = await makeRepo(scratch, [
      [
        { path: "elsewhere/commands.yaml", content: baseCommands },
        { path: ".spec-gate", linkTo: "elsewhere" },
      ],
    ]);
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
    });
    expect(failure(() => computeSpecDigest(dir, { repo: made.dir })).code).toBe(
      "commands-file-missing",
    );
  });

  it("refuses a submodule entry in place of the commands file", async () => {
    const made = await makeRepo(scratch, [
      [{ path: "README.md", content: "x\n" }],
    ]);
    await git(made.dir, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${made.shas[0]},${COMMANDS_FILE}`,
    ]);
    await git(made.dir, ["commit", "-q", "-m", "gitlink"], 5);
    const sha = await git(made.dir, ["rev-parse", "HEAD"]);
    const dir = specDir({ "spec.md": baseSpec.replace(baseRef, sha) });
    const err = failure(() => computeSpecDigest(dir, { repo: made.dir }));
    expect(err.code).toBe("commands-file-missing");
    expect(err.message).toContain("160000");
  });

  it("accepts an executable commands file as a regular file", async () => {
    const made = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: baseCommands }],
    ]);
    await git(made.dir, ["update-index", "--chmod=+x", COMMANDS_FILE]);
    await git(made.dir, ["commit", "-q", "-m", "mode"], 5);
    const sha = await git(made.dir, ["rev-parse", "HEAD"]);
    expect(await git(made.dir, ["ls-tree", sha, "--", COMMANDS_FILE])).toMatch(
      /^100755 blob /,
    );
    const dir = specDir({ "spec.md": baseSpec.replace(baseRef, sha) });
    expect(computeSpecDigest(dir, { repo: made.dir })).toMatch(/^sha256:/);
  });

  it("refuses the id of an annotated tag as commands_ref", async () => {
    const made = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: baseCommands }],
    ]);
    await git(made.dir, ["tag", "-a", "-m", "tag", "v1", made.shas[0]!]);
    const tagId = await git(made.dir, ["rev-parse", "v1"]);
    expect(tagId).not.toBe(made.shas[0]);
    const dir = specDir({ "spec.md": baseSpec.replace(baseRef, tagId) });
    const err = failure(() => computeSpecDigest(dir, { repo: made.dir }));
    expect(err.code).toBe("commands-ref-unresolvable");
    expect(failure(() => assertCommit(made.dir, tagId)).code).toBe(
      "commands-ref-unresolvable",
    );
    expect(failure(() => readCommandsFile(made.dir, tagId)).code).toBe(
      "commands-ref-unresolvable",
    );
  });

  it("refuses HEAD, a branch name and a short id in the exported helpers", async () => {
    const made = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: baseCommands }],
    ]);
    const branch = await git(made.dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const full = made.shas[0]!;
    for (const ref of ["HEAD", branch, full.slice(0, 12), full.toUpperCase()]) {
      expect(failure(() => assertCommit(made.dir, ref)).code, ref).toBe(
        "commands-ref-unresolvable",
      );
      expect(failure(() => readCommandsFile(made.dir, ref)).code, ref).toBe(
        "commands-ref-unresolvable",
      );
    }
    expect(() => assertCommit(made.dir, full)).not.toThrow();
    expect(readCommandsFile(made.dir, full)).toBe(baseCommands);
  });

  it("says the object is not available locally in a partial clone, and does not fetch", async () => {
    const src = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: baseCommands }],
    ]);
    await git(src.dir, ["config", "uploadpack.allowFilter", "true"]);
    await git(src.dir, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    const clone = path.join(scratch, `partial-${counter++}`);
    await git(scratch, [
      "clone",
      "-q",
      "--no-checkout",
      "--filter=blob:none",
      `file://${src.dir}`,
      clone,
    ]);
    const blob = await git(src.dir, ["rev-parse", `HEAD:${COMMANDS_FILE}`]);
    const probe = () =>
      runBounded("git", ["cat-file", "-e", blob], {
        cwd: clone,
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      });
    expect((await probe()).code).not.toBe(0);
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, src.shas[0]!),
    });
    const err = failure(() => computeSpecDigest(dir, { repo: clone }));
    expect(err.code).toBe("git-failed");
    expect(err.message).toContain("not be available locally");
    expect(err.message).not.toContain("does not exist");
    // The read did not fetch the blob.
    expect((await probe()).code).not.toBe(0);
  });

  it("reports a commit whose tree object is gone as git-failed, not as a missing file", async () => {
    const made = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: baseCommands }],
    ]);
    const tree = await git(made.dir, ["rev-parse", `${made.shas[0]}^{tree}`]);
    const loose = path.join(
      made.dir,
      ".git",
      "objects",
      tree.slice(0, 2),
      tree.slice(2),
    );
    expect(fs.existsSync(loose)).toBe(true);
    fs.rmSync(loose, { force: true });
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
    });
    const err = failure(() => computeSpecDigest(dir, { repo: made.dir }));
    expect(err.code).toBe("git-failed");
    expect(err.message).toContain("could not read the tree");
  });

  it("names the size when git writes more than the digest reads", async () => {
    const made = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: Buffer.alloc(5 * 1024 * 1024, 0x61) }],
    ]);
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
    });
    const err = failure(() => computeSpecDigest(dir, { repo: made.dir }));
    expect(err.code).toBe("git-failed");
    expect(err.message).toContain("more than 4194304 bytes");
  });

  it("does not need the commands file when no row refers to a command", async () => {
    const made = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: "this: [is not a commands file" }],
    ]);
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
      "testplan.yaml": planWithoutCommands,
    });
    expect(planWithoutCommands).not.toContain("check_command_ref");
    expect(computeSpecDigest(dir, { repo: made.dir })).toMatch(/^sha256:/);
    const noFile = await makeRepo(scratch, [
      [{ path: "README.md", content: "x\n" }],
    ]);
    const dir2 = specDir({
      "spec.md": baseSpec.replace(baseRef, noFile.shas[0]!),
      "testplan.yaml": planWithoutCommands,
    });
    expect(computeSpecDigest(dir2, { repo: noFile.dir })).toMatch(/^sha256:/);
  });

  it("still needs commands_ref to resolve when no row refers to a command", () => {
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, `${"2".repeat(39)}b`),
      "testplan.yaml": planWithoutCommands,
    });
    expect(failure(() => computeSpecDigest(dir, { repo })).code).toBe(
      "commands-ref-unresolvable",
    );
  });

  it("surfaces the format errors of the commands file at commands_ref", async () => {
    const made = await makeRepo(scratch, [
      [
        {
          path: COMMANDS_FILE,
          content: 'commands:\n  typecheck: "npm run typecheck"\n',
        },
      ],
    ]);
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
    });
    const err = failure(() => computeSpecDigest(dir, { repo: made.dir }));
    expect(err.code).toBe("commands-file-invalid");
    expect(err.formatErrors?.map((e) => e.code)).toContain("shell-string");
    expect(describeDigestError(err)).toContain("[shell-string]");
  });

  it("refuses a commands file that is not UTF-8, even one that would otherwise parse", async () => {
    // The invalid byte sits inside an argv string of an otherwise valid
    // file: decoded with replacement characters it would parse and give a
    // digest.
    const made = await makeRepo(scratch, [
      [
        {
          path: COMMANDS_FILE,
          content: Buffer.concat([
            Buffer.from('commands:\n  typecheck:\n    argv: ["npm", "'),
            Buffer.from([0xff]),
            Buffer.from('"]\n'),
          ]),
        },
      ],
    ]);
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
    });
    const err = failure(() => computeSpecDigest(dir, { repo: made.dir }));
    expect(err.code).toBe("commands-file-invalid");
    expect(err.message).toContain("not valid UTF-8");
    expect(err.formatErrors).toBeUndefined();
  });

  it("refuses a command name the commands file at commands_ref does not define", async () => {
    const made = await makeRepo(scratch, [
      [
        {
          path: COMMANDS_FILE,
          content: 'commands:\n  other:\n    argv: ["true"]\n',
        },
      ],
    ]);
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
    });
    const err = failure(() => computeSpecDigest(dir, { repo: made.dir }));
    expect(err.code).toBe("command-ref-unknown");
    expect(err.message).toContain("typecheck");
  });

  it("treats a command name such as constructor as unknown, not as an inherited property", async () => {
    const made = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: baseCommands }],
    ]);
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
      "testplan.yaml": basePlan.replace(
        "check_command_ref: typecheck",
        "check_command_ref: constructor",
      ),
    });
    const err = failure(() => computeSpecDigest(dir, { repo: made.dir }));
    expect(err.code).toBe("command-ref-unknown");
    expect(err.message).toContain("constructor");
  });

  it("reads the commit, not the work tree or the branch head", async () => {
    // The work tree file and a later commit both define typecheck
    // differently; only the file at commands_ref counts.
    const made = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: baseCommands }],
      [{ path: COMMANDS_FILE, content: "not even yaml: [" }],
    ]);
    fs.writeFileSync(path.join(made.dir, COMMANDS_FILE), "dirty work tree\n");
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
    });
    expect(computeSpecDigest(dir, { repo: made.dir })).toBe(
      computeSpecDigest(specDir(), { repo }),
    );
  });

  it("ignores a replace ref, which would swap what the commit ID names", async () => {
    const made = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: baseCommands }],
      [
        {
          path: COMMANDS_FILE,
          content: 'commands:\n  typecheck:\n    argv: ["true"]\n',
        },
      ],
    ]);
    const dir = specDir({
      "spec.md": baseSpec.replace(baseRef, made.shas[0]!),
    });
    const before = computeSpecDigest(dir, { repo: made.dir });
    await git(made.dir, ["replace", made.shas[0]!, made.shas[1]!]);
    expect(computeSpecDigest(dir, { repo: made.dir })).toBe(before);
  });

  it("reports a missing git program as git-failed", () => {
    const saved = process.env["PATH"];
    process.env["PATH"] = path.join(scratch, "no-bin");
    try {
      expect(failure(() => computeSpecDigest(specDir(), { repo })).code).toBe(
        "git-failed",
      );
    } finally {
      process.env["PATH"] = saved;
    }
  });

  it("ignores GIT_DIR from the caller's environment", () => {
    const saved = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = path.join(scratch, "no-such-git-dir");
    try {
      expect(computeSpecDigest(specDir(), { repo })).toMatch(/^sha256:/);
    } finally {
      if (saved === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved;
    }
  });
});

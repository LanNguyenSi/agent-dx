/** `spec-gate digest`, through the built CLI. */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMMANDS_FILE,
  git,
  makeRepo,
  runBounded,
  tempDir,
} from "./helpers.js";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const fixtures = fileURLToPath(
  new URL("../fixtures/golden-digest/", import.meta.url),
);
const expected = JSON.parse(
  fs.readFileSync(path.join(fixtures, "expected.json"), "utf8"),
) as { base: string };
const baseCommands = fs.readFileSync(
  path.join(fixtures, "repo", COMMANDS_FILE),
  "utf8",
);
const laterCommands = fs.readFileSync(
  path.join(fixtures, "alt/commands.later.yaml"),
  "utf8",
);
const baseSpec = fs.readFileSync(path.join(fixtures, "base/spec.md"), "utf8");
const baseRef = /^commands_ref: ([0-9a-f]+)$/m.exec(baseSpec)![1]!;

const cli = (args: string[], cwd: string) =>
  runBounded(process.execPath, [cliPath, ...args], { cwd });

let scratch = "";
/** A repository whose first commit is `commands_ref` and whose head is a later commit. */
let repo = "";
/** A spec directory inside that repository, untracked. */
let inside = "";
/** The same spec directory outside any repository. */
let outside = "";

beforeAll(async () => {
  scratch = tempDir("spec-gate-cli-");
  const made = await makeRepo(scratch, [
    [{ path: COMMANDS_FILE, content: baseCommands }],
    [{ path: COMMANDS_FILE, content: laterCommands }],
  ]);
  repo = made.dir;
  expect(made.shas[0]).toBe(baseRef);
  inside = path.join(repo, "specs", "golden-sample");
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.cpSync(path.join(fixtures, "base"), inside, { recursive: true });
  outside = path.join(scratch, "elsewhere");
  fs.cpSync(path.join(fixtures, "base"), outside, { recursive: true });
}, 60_000);

afterAll(() => {
  if (scratch !== "") fs.rmSync(scratch, { recursive: true, force: true });
});

describe("spec-gate digest", () => {
  it("is listed by --help, with its arguments and --repo", async () => {
    const top = await cli(["--help"], scratch);
    expect(top.code).toBe(0);
    expect(top.stdout).toMatch(/^\s+digest\b/m);
    const own = await cli(["digest", "--help"], scratch);
    expect(own.code).toBe(0);
    expect(own.stdout).toContain("<spec-dir>");
    expect(own.stdout).toContain("--repo <path>");
  });

  it("prints the digest and nothing else, and exits 0", async () => {
    const run = await cli(["digest", "specs/golden-sample"], repo);
    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`${expected.base}\n`);
    expect(run.stderr).toBe("");
  });

  it("reads commands_ref, not the later head commit that changed the commands", async () => {
    // The head of the repository holds a different typecheck argv.
    const head = fs.readFileSync(path.join(repo, COMMANDS_FILE), "utf8");
    expect(head).toBe(laterCommands);
    const run = await cli(["digest", inside], scratch);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(expected.base);
  });

  it("takes the repository from the git top level of the spec directory when --repo is absent", async () => {
    // `outside` has no repository: this is the only difference.
    const without = await cli(["digest", outside], scratch);
    expect(without.code).toBe(1);
    expect(without.stderr).toContain("[repo-not-found]");
    const within = await cli(["digest", inside], scratch);
    expect(within.code).toBe(0);
  });

  it("takes --repo when it is given, and it wins over the top level", async () => {
    const run = await cli(["digest", outside, "--repo", repo], scratch);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(expected.base);
    // A --repo without the commit wins too: the top level would have worked.
    const empty = (
      await makeRepo(scratch, [[{ path: "README.md", content: "x\n" }]])
    ).dir;
    const lost = await cli(["digest", inside, "--repo", empty], scratch);
    expect(lost.code).toBe(1);
    expect(lost.stderr).toContain("[commands-ref-unresolvable]");
  });

  it("prints no digest and exits non-zero on a format error, and says which file", async () => {
    const dir = path.join(scratch, "bad-spec");
    fs.cpSync(path.join(fixtures, "base"), dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spec.md"), "no frontmatter\n");
    const run = await cli(["digest", dir, "--repo", repo], scratch);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("[spec-invalid]");
    expect(run.stderr).toContain("[missing-frontmatter] spec.md");
  });

  it("prints no digest on an unresolvable commands_ref", async () => {
    const dir = path.join(scratch, "bad-ref");
    fs.cpSync(path.join(fixtures, "base"), dir, { recursive: true });
    const spec = path.join(dir, "spec.md");
    fs.writeFileSync(spec, baseSpec.replace(baseRef, `${"3".repeat(39)}c`));
    const run = await cli(["digest", dir, "--repo", repo], scratch);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("[commands-ref-unresolvable]");
  });

  it("prints no digest when the commands file is missing at commands_ref", async () => {
    const bare = await makeRepo(scratch, [
      [{ path: "README.md", content: "x\n" }],
    ]);
    const dir = path.join(scratch, "no-commands");
    fs.cpSync(path.join(fixtures, "base"), dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "spec.md"),
      baseSpec.replace(baseRef, bare.shas[0]!),
    );
    const run = await cli(["digest", dir, "--repo", bare.dir], scratch);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("[commands-file-missing]");
  });

  it("prints no digest when the spec directory is missing", async () => {
    const run = await cli(["digest", path.join(scratch, "nope")], scratch);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("[spec-dir-invalid]");
  });

  it("rejects a missing argument and an unknown option as usage errors, with no digest", async () => {
    const none = await cli(["digest"], scratch);
    expect(none.code).not.toBe(0);
    expect(none.stdout).toBe("");
    expect(none.stderr).toContain("missing required argument");
    const unknown = await cli(["digest", inside, "--nope"], scratch);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("unknown option");
    const extra = await cli(["digest", inside, outside], scratch);
    expect(extra.code).not.toBe(0);
    expect(extra.stdout).toBe("");
  });

  it("gives the same digest on every run", async () => {
    const a = await cli(["digest", inside], scratch);
    const b = await cli(["digest", inside], scratch);
    expect(a.stdout).toBe(b.stdout);
  });
});

describe("spec-gate digest: where the commands file is looked up", () => {
  /** A copy of the base spec whose commands_ref is `ref`. */
  const specAt = (name: string, ref: string): string => {
    const dir = path.join(scratch, name);
    fs.cpSync(path.join(fixtures, "base"), dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spec.md"), baseSpec.replace(baseRef, ref));
    return dir;
  };

  it("resolves the commands file from the repository root, whatever subdirectory --repo names", async () => {
    // A decoy file with other argv lists sits in a subdirectory and in a
    // second one; the real file is at the top.
    const made = await makeRepo(scratch, [
      [
        { path: COMMANDS_FILE, content: baseCommands },
        { path: `decoy/${COMMANDS_FILE}`, content: laterCommands },
      ],
    ]);
    fs.mkdirSync(path.join(made.dir, "plain"));
    const spec = specAt("spec-decoy", made.shas[0]!);
    const top = await cli(["digest", spec, "--repo", made.dir], scratch);
    expect(top.code).toBe(0);
    for (const sub of ["decoy", "plain"]) {
      const run = await cli(
        ["digest", spec, "--repo", path.join(made.dir, sub)],
        scratch,
      );
      expect(run.stderr, sub).toBe("");
      expect(run.stdout, sub).toBe(top.stdout);
    }
  });

  it("refuses a bare repository and a git directory: only a work tree is read", async () => {
    const bare = path.join(scratch, "bare.git");
    await git(scratch, ["clone", "-q", "--bare", repo, bare]);
    for (const target of [bare, path.join(repo, ".git")]) {
      const run = await cli(["digest", outside, "--repo", target], scratch);
      expect(run.code, target).toBe(1);
      expect(run.stdout, target).toBe("");
      expect(run.stderr, target).toContain("[repo-invalid]");
    }
  });

  it("refuses a 40-digit prefix of a SHA-256 commit id", async (ctx) => {
    const dir = path.join(scratch, "sha256-repo");
    fs.mkdirSync(dir);
    try {
      await git(dir, ["init", "-q", "--object-format=sha256"]);
    } catch {
      // The installed git cannot make a SHA-256 repository.
      ctx.skip();
    }
    fs.mkdirSync(path.join(dir, ".spec-gate"));
    fs.writeFileSync(path.join(dir, COMMANDS_FILE), baseCommands);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "commands"]);
    const full = await git(dir, ["rev-parse", "HEAD"]);
    expect(full).toMatch(/^[0-9a-f]{64}$/);
    const whole = await cli(
      ["digest", specAt("spec-sha256-full", full), "--repo", dir],
      scratch,
    );
    expect(whole.stderr).toBe("");
    expect(whole.code).toBe(0);
    const prefix = await cli(
      [
        "digest",
        specAt("spec-sha256-prefix", full.slice(0, 40)),
        "--repo",
        dir,
      ],
      scratch,
    );
    expect(prefix.code).toBe(1);
    expect(prefix.stdout).toBe("");
    expect(prefix.stderr).toContain("[commands-ref-unresolvable]");
  });

  it("refuses a branch whose name looks like a 64-digit commit id", async () => {
    // Works on every git: the name passes the commit-id pattern and resolves
    // to a commit, but it is a moving ref, not the object id itself.
    const made = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: baseCommands }],
    ]);
    const name = "a".repeat(64);
    await git(made.dir, ["branch", name, made.shas[0]!]);
    const run = await cli(
      ["digest", specAt("spec-hex-branch", name), "--repo", made.dir],
      scratch,
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("[commands-ref-unresolvable]");
  });
});

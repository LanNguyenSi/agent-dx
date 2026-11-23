/** `spec-gate digest`, through the built CLI. */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMANDS_FILE, makeRepo, runBounded, tempDir } from "./helpers.js";

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

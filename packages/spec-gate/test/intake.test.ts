import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { splitSourceLines } from "../src/formats/index.js";
import type { SourceMeta } from "../src/intake.js";

const execFileAsync = promisify(execFile);

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const TICKET =
  "Goal: make the login page faster\n\n" +
  "- run the tests before shipping\n" +
  "```\n" +
  "npm test\n" +
  "```\n";

interface Fixture {
  /** The temporary root; deleted after all tests. */
  root: string;
  /** The target repository (git toplevel). */
  repo: string;
  /** The bare repository used as origin. */
  remote: string;
  /** The head commit of the remote default branch, empty when nothing was pushed. */
  remoteHead: string;
}

const created: string[] = [];

afterAll(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function git(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

/**
 * A temporary repository with a bare origin. `defaultBranch` is the remote's
 * branch name; `push: false` leaves the remote with no commits;
 * `attachRemote: false` leaves the repository without any remote.
 */
async function makeFixture(
  options: {
    defaultBranch?: string;
    attachRemote?: boolean;
    push?: boolean;
  } = {},
): Promise<Fixture> {
  const branch = options.defaultBranch ?? "main";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-intake-"));
  created.push(root);
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(repo);
  fs.mkdirSync(remote);
  await git(repo, "-c", `init.defaultBranch=${branch}`, "init", "-q");
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  await git(repo, "add", "base.txt");
  await git(repo, "commit", "-qm", "base");
  let remoteHead = "";
  if (options.attachRemote !== false) {
    await git(
      remote,
      "-c",
      `init.defaultBranch=${branch}`,
      "init",
      "-q",
      "--bare",
    );
    await git(repo, "remote", "add", "origin", remote);
    if (options.push !== false) {
      await git(repo, "push", "-q", "origin", `HEAD:${branch}`);
      remoteHead = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    }
  }
  return { root, repo, remote, remoteHead };
}

function writeTicket(repo: string, text = TICKET): string {
  fs.writeFileSync(path.join(repo, "ticket.txt"), text);
  return "ticket.txt";
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd: string): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, ...args],
      { cwd },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function readMeta(repo: string, id: string): SourceMeta {
  return JSON.parse(
    fs.readFileSync(
      path.join(repo, "specs", id, "source", "meta.json"),
      "utf8",
    ),
  ) as SourceMeta;
}

function metaExists(repo: string, id: string): boolean {
  return fs.existsSync(path.join(repo, "specs", id, "source", "meta.json"));
}

const META_KEYS = [
  "adapter",
  "origin",
  "fetched_at",
  "sha256",
  "trust",
  "sections",
  "attachments",
  "raw",
  "lines",
  "base_commit",
  "commands_ref",
];

it("intake file writes ticket.md byte for byte and a complete meta.json", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-smoke"],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);

  const bytes = fs.readFileSync(path.join(fx.repo, "ticket.txt"));
  expect(
    fs.readFileSync(
      path.join(fx.repo, "specs", "sg-smoke", "source", "ticket.md"),
    ),
  ).toEqual(bytes);

  const metaPath = path.join(
    fx.repo,
    "specs",
    "sg-smoke",
    "source",
    "meta.json",
  );
  const raw = fs.readFileSync(metaPath, "utf8");
  const meta = JSON.parse(raw) as SourceMeta;

  expect(Object.keys(meta)).toEqual(META_KEYS);
  expect(raw).toBe(`${JSON.stringify(meta, null, 2)}\n`);

  expect(meta.adapter).toBe("file");
  expect(meta.trust).toBe("untrusted");
  expect(meta.origin).toBe(ticket);
  expect(meta.fetched_at).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
  expect(meta.sha256).toBe(sha256(bytes));
  expect(meta.sections).toEqual([
    { name: "body", author: null, sha256: sha256(bytes) },
  ]);
  expect(meta.attachments).toEqual([]);
  expect(meta.raw).toBe(true);

  const split = splitSourceLines(bytes.toString("utf8"));
  if (!split.ok) throw new Error(split.errors[0]!.message);
  expect(meta.lines).toEqual(
    split.value.map((l) => ({ id: l.id, kind: l.kind })),
  );

  expect(meta.base_commit).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  expect(meta.base_commit).toBe(fx.remoteHead);
  expect(meta.commands_ref).toBe(meta.base_commit);
});

it("--author is recorded as the author of the body section", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-author", "--author", "alice"],
    fx.repo,
  );
  expect(run.code).toBe(0);
  expect(readMeta(fx.repo, "sg-author").sections).toEqual([
    {
      name: "body",
      author: "alice",
      sha256: sha256(fs.readFileSync(path.join(fx.repo, "ticket.txt"))),
    },
  ]);
});

it("--no-raw skips ticket.md but keeps sha256, origin and lines", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-noraw", "--no-raw"],
    fx.repo,
  );
  expect(run.code).toBe(0);
  const sourceDir = path.join(fx.repo, "specs", "sg-noraw", "source");
  expect(fs.readdirSync(sourceDir)).toEqual(["meta.json"]);
  const meta = readMeta(fx.repo, "sg-noraw");
  expect(meta.raw).toBe(false);
  expect(meta.origin).toBe(ticket);
  expect(meta.sha256).toBe(
    sha256(fs.readFileSync(path.join(fx.repo, "ticket.txt"))),
  );
  expect(meta.lines.length).toBeGreaterThan(0);
});

it("an existing specs/<id>/source/ is refused and nothing is overwritten", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  expect(
    (await runCli(["intake", "file", ticket, "--id", "sg-twice"], fx.repo))
      .code,
  ).toBe(0);
  const before = fs.readFileSync(
    path.join(fx.repo, "specs", "sg-twice", "source", "ticket.md"),
  );
  fs.writeFileSync(path.join(fx.repo, "ticket.txt"), "rewritten\n");
  const run = await runCli(
    ["intake", "file", "ticket.txt", "--id", "sg-twice"],
    fx.repo,
  );
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain("source-exists");
  expect(
    fs.readFileSync(
      path.join(fx.repo, "specs", "sg-twice", "source", "ticket.md"),
    ),
  ).toEqual(before);
  expect(readMeta(fx.repo, "sg-twice").sha256).toBe(sha256(TICKET));
});

it("an id that fails isSpecId exits non-zero and writes nothing", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  for (const bad of [
    "Bad-ID",
    "has space",
    "UPPER",
    "trailing-",
    "a".repeat(65),
  ]) {
    const run = await runCli(
      ["intake", "file", ticket, `--id=${bad}`],
      fx.repo,
    );
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("invalid-spec-id");
  }
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("--id is required", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const run = await runCli(["intake", "file", ticket], fx.repo);
  expect(run.code).not.toBe(0);
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("a symlink source is refused", async () => {
  const fx = await makeFixture();
  writeTicket(fx.repo);
  fs.symlinkSync(
    path.join(fx.repo, "ticket.txt"),
    path.join(fx.repo, "link.txt"),
  );
  const run = await runCli(
    ["intake", "file", "link.txt", "--id", "sg-link"],
    fx.repo,
  );
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain("source-not-a-file");
  expect(run.stderr).toContain("symlink");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("a directory source is refused", async () => {
  const fx = await makeFixture();
  fs.mkdirSync(path.join(fx.repo, "dirsrc"));
  const run = await runCli(
    ["intake", "file", "dirsrc", "--id", "sg-dir"],
    fx.repo,
  );
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain("source-not-a-file");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("a missing source file is refused", async () => {
  const fx = await makeFixture();
  const run = await runCli(
    ["intake", "file", "nope.txt", "--id", "sg-nope"],
    fx.repo,
  );
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain("source-missing");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("base_commit and commands_ref are the remote head, not the local HEAD", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  // The local branch moves ahead of the remote and stays checked out.
  fs.writeFileSync(path.join(fx.repo, "later.txt"), "later\n");
  await git(fx.repo, "add", "later.txt");
  await git(fx.repo, "commit", "-qm", "ahead of origin");
  const localHead = (await git(fx.repo, "rev-parse", "HEAD")).stdout.trim();
  expect(localHead).not.toBe(fx.remoteHead);

  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-remote"],
    fx.repo,
  );
  expect(run.code).toBe(0);
  const meta = readMeta(fx.repo, "sg-remote");
  expect(meta.base_commit).toBe(fx.remoteHead);
  expect(meta.commands_ref).toBe(fx.remoteHead);
  expect(meta.base_commit).not.toBe(localHead);
});

it("the remote default branch may be named other than main", async () => {
  const fx = await makeFixture({ defaultBranch: "trunk" });
  const ticket = writeTicket(fx.repo);
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-trunk"],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  expect(readMeta(fx.repo, "sg-trunk").base_commit).toBe(fx.remoteHead);
});

it("a repository with no remote fails with a named error and writes nothing", async () => {
  const fx = await makeFixture({ attachRemote: false });
  const ticket = writeTicket(fx.repo);
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-norem"],
    fx.repo,
  );
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain("no-remote");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("a remote with no commits fails with a named error and writes nothing", async () => {
  const fx = await makeFixture({ push: false });
  const ticket = writeTicket(fx.repo);
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-empty"],
    fx.repo,
  );
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain("no-default-branch");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

async function expectSecret(
  content: string,
  pattern: string,
  line: number,
  notPrinted: string,
): Promise<void> {
  const fx = await makeFixture();
  fs.writeFileSync(path.join(fx.repo, "ticket.txt"), content);
  const run = await runCli(
    ["intake", "file", "ticket.txt", "--id", "sg-secret"],
    fx.repo,
  );
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain(pattern);
  expect(run.stderr).toContain(`line ${line}`);
  expect(run.stderr).not.toContain(notPrinted);
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
}

it("a private key header is refused", async () => {
  await expectSecret(
    "header\n-----BEGIN OPENSSH PRIVATE KEY-----\nblob\n-----END OPENSSH PRIVATE KEY-----\n",
    "private-key",
    2,
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  );
});

it("an AWS access key id is refused", async () => {
  await expectSecret(
    "the key is AKIAIOSFODNN7EXAMPLE\n",
    "aws-access-key-id",
    1,
    "AKIAIOSFODNN7EXAMPLE",
  );
});

it("a GitHub token is refused", async () => {
  await expectSecret(
    `auth ghp_${"a".repeat(36)}\n`,
    "github-token",
    1,
    `ghp_${"a".repeat(36)}`,
  );
  await expectSecret(
    `auth github_pat_${"b".repeat(40)}\n`,
    "github-token",
    1,
    `github_pat_${"b".repeat(40)}`,
  );
});

it("a Slack token is refused", async () => {
  await expectSecret("one\nxoxb-1234567890\n", "slack-token", 2, "xoxb-");
});

it("a generic secret assignment is refused", async () => {
  await expectSecret(
    'notes\npassword = "supersecretvalue123"\n',
    "secret-assignment",
    2,
    "supersecretvalue123",
  );
});

it("near-miss values that are not secrets are accepted", async () => {
  const fx = await makeFixture();
  fs.writeFileSync(
    path.join(fx.repo, "ticket.txt"),
    [
      `ghp_${"a".repeat(19)}`,
      "AKIAIOSFODNN7EXAMP",
      'token: "short"',
      "xoxq-1234567890",
      "BEGIN PRIVATE KEY here",
      "ghx_" + "a".repeat(40),
      "",
    ].join("\n"),
  );
  const run = await runCli(
    ["intake", "file", "ticket.txt", "--id", "sg-near"],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  expect(metaExists(fx.repo, "sg-near")).toBe(true);
});

it("--attach records name, sha256, size and type and copies nothing", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  fs.mkdirSync(path.join(fx.root, "elsewhere"));
  const notes = path.join(fx.root, "elsewhere", "notes.md");
  const diagram = path.join(fx.root, "elsewhere", "sketch.zzz");
  fs.writeFileSync(notes, "# notes\n");
  fs.writeFileSync(diagram, "binary-ish");
  const run = await runCli(
    [
      "intake",
      "file",
      ticket,
      "--id",
      "sg-attach",
      "--attach",
      notes,
      "--attach",
      diagram,
    ],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  const meta = readMeta(fx.repo, "sg-attach");
  expect(meta.attachments).toEqual([
    {
      name: "notes.md",
      sha256: sha256("# notes\n"),
      size: "# notes\n".length,
      type: "text/markdown",
    },
    {
      name: "sketch.zzz",
      sha256: sha256("binary-ish"),
      size: 10,
      type: "application/octet-stream",
    },
  ]);
  // Nothing was copied into the spec directory.
  expect(
    fs.readdirSync(path.join(fx.repo, "specs", "sg-attach", "source")),
  ).toEqual(["meta.json", "ticket.md"]);
});

it("a missing attachment is an error and writes nothing", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-attach", "--attach", "nope.png"],
    fx.repo,
  );
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain("attachment-missing");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("--check on an unchanged file exits 0 with status ok and does not fetch", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  expect(
    (await runCli(["intake", "file", ticket, "--id", "sg-check"], fx.repo))
      .code,
  ).toBe(0);
  // Break the remote: a check must still pass because it never fetches.
  fs.rmSync(fx.remote, { recursive: true, force: true });
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-check", "--check"],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  expect(JSON.parse(run.stdout)).toEqual({ status: "ok" });
});

it("--check after a changed file exits 1 and names the changed, added and removed line ids", async () => {
  const fx = await makeFixture();
  writeTicket(fx.repo, "alpha\nbravo\n");
  expect(
    (
      await runCli(
        ["intake", "file", "ticket.txt", "--id", "sg-drift"],
        fx.repo,
      )
    ).code,
  ).toBe(0);
  const metaPath = path.join(
    fx.repo,
    "specs",
    "sg-drift",
    "source",
    "meta.json",
  );
  const ticketPath = path.join(fx.repo, "ticket.txt");
  const metaBefore = fs.readFileSync(metaPath);
  const ticketBefore = fs.readFileSync(
    path.join(fx.repo, "specs", "sg-drift", "source", "ticket.md"),
  );

  const oldSplit = splitSourceLines("alpha\nbravo\n");
  if (!oldSplit.ok) throw new Error("fixture must split");

  // One line rewritten and one added at the end.
  fs.writeFileSync(ticketPath, "alpha\nbravo edited\ndelta\n");
  const addedSplit = splitSourceLines("alpha\nbravo edited\ndelta\n");
  if (!addedSplit.ok) throw new Error("fixture must split");
  const addedRun = await runCli(
    ["intake", "file", "ticket.txt", "--id", "sg-drift", "--check"],
    fx.repo,
  );
  expect(addedRun.code).toBe(1);
  const addedDrift = JSON.parse(addedRun.stdout) as {
    status: string;
    changed_lines: { old: string; new: string }[];
    added: string[];
    removed: string[];
  };
  expect(addedDrift.status).toBe("source-drift");
  expect(addedDrift.changed_lines).toEqual([
    { old: oldSplit.value[1]!.id, new: addedSplit.value[1]!.id },
  ]);
  expect(addedDrift.added).toEqual([addedSplit.value[2]!.id]);
  expect(addedDrift.removed).toEqual([]);

  // Lines dropped from the end are reported as removed.
  fs.writeFileSync(ticketPath, "alpha\n");
  const removedRun = await runCli(
    ["intake", "file", "ticket.txt", "--id", "sg-drift", "--check"],
    fx.repo,
  );
  expect(removedRun.code).toBe(1);
  const removedDrift = JSON.parse(removedRun.stdout) as {
    status: string;
    changed_lines: unknown[];
    added: string[];
    removed: string[];
  };
  expect(removedDrift.status).toBe("source-drift");
  expect(removedDrift.changed_lines).toEqual([]);
  expect(removedDrift.added).toEqual([]);
  expect(removedDrift.removed).toEqual([oldSplit.value[1]!.id]);

  // The check wrote nothing.
  expect(fs.readFileSync(metaPath)).toEqual(metaBefore);
  expect(
    fs.readFileSync(
      path.join(fx.repo, "specs", "sg-drift", "source", "ticket.md"),
    ),
  ).toEqual(ticketBefore);
});

it("--check with no recorded source fails with a named error", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-never", "--check"],
    fx.repo,
  );
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain("meta-missing");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("without --repo the git toplevel of the current directory is the target", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  // Run from the repository root so the toplevel is the repository itself.
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-toplevel"],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  const nested = path.join(fx.repo, "deep", "nest");
  fs.mkdirSync(nested, { recursive: true });
  const fromNested = await runCli(
    ["intake", "file", "../../ticket.txt", "--id", "sg-toplevel-nested"],
    nested,
  );
  expect([fromNested.code, fromNested.stderr]).toEqual([0, ""]);
  expect(metaExists(fx.repo, "sg-toplevel")).toBe(true);
  expect(metaExists(fx.repo, "sg-toplevel-nested")).toBe(true);
  // The origin is recorded exactly as given.
  expect(readMeta(fx.repo, "sg-toplevel-nested").origin).toBe(
    "../../ticket.txt",
  );
});

it("--repo selects the target repository", async () => {
  const fx = await makeFixture();
  writeTicket(fx.repo);
  // The working directory (the temporary root) is not inside a git repository.
  const run = await runCli(
    [
      "intake",
      "file",
      path.join(fx.repo, "ticket.txt"),
      "--id",
      "sg-repo",
      "--repo",
      fx.repo,
    ],
    fx.root,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  expect(metaExists(fx.repo, "sg-repo")).toBe(true);
  expect(fs.existsSync(path.join(fx.root, "specs"))).toBe(false);
});

it("--remote selects which remote sets base_commit and commands_ref", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  // A second remote whose default-branch head is a different commit.
  const other = path.join(fx.root, "other.git");
  const seed = path.join(fx.root, "seed");
  fs.mkdirSync(other);
  fs.mkdirSync(seed);
  await git(other, "-c", "init.defaultBranch=main", "init", "-q", "--bare");
  await git(seed, "-c", "init.defaultBranch=main", "init", "-q");
  await git(seed, "config", "user.email", "t@example.com");
  await git(seed, "config", "user.name", "t");
  fs.writeFileSync(path.join(seed, "s.txt"), "seed\n");
  await git(seed, "add", "s.txt");
  await git(seed, "commit", "-qm", "seed");
  await git(seed, "push", "-q", other, "main");
  const otherHead = (await git(seed, "rev-parse", "HEAD")).stdout.trim();
  await git(fx.repo, "remote", "add", "second", other);

  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-remote-opt", "--remote", "second"],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  const meta = readMeta(fx.repo, "sg-remote-opt");
  expect(meta.base_commit).toBe(otherHead);
  expect(meta.commands_ref).toBe(otherHead);
  expect(meta.base_commit).not.toBe(fx.remoteHead);
});

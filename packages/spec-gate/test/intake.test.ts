import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, expect, it, vi } from "vitest";
import { splitSourceLines } from "../src/formats/index.js";
import {
  gitEnv,
  IntakeError,
  parseFetchHead,
  ProcessFailure,
  runProcess,
  writeSource,
} from "../src/intake/index.js";
import type { SourceMeta } from "../src/intake/index.js";

const execFileAsync = promisify(execFile);

/** No helper that runs git or the CLI may hang the suite. */
const HELPER_TIMEOUT_MS = 30_000;

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
  return execFileAsync("git", args, {
    cwd,
    timeout: HELPER_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
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

async function runCli(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, ...args],
      {
        cwd,
        env: env ?? process.env,
        timeout: HELPER_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
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
  // The refusal comes before any remote access: a broken remote changes nothing.
  fs.rmSync(fx.remote, { recursive: true, force: true });
  const run = await runCli(
    ["intake", "file", "ticket.txt", "--id", "sg-twice"],
    fx.repo,
  );
  expect(run.code).toBe(2);
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
    expect(run.code).toBe(2);
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

it("a usage error of intake file exits 2 with the usage message on stderr", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const cases: [string, string[]][] = [
    ["missing --id", ["intake", "file", ticket, "--check"]],
    [
      "unknown option",
      ["intake", "file", ticket, "--id", "sg-usage", "--nope"],
    ],
    ["missing <path>", ["intake", "file", "--id", "sg-usage"]],
  ];
  for (const [label, args] of cases) {
    const run = await runCli(args, fx.repo);
    expect([label, run.code]).toEqual([label, 2]);
    expect([label, run.stderr]).toEqual([
      label,
      expect.stringContaining("Usage: spec-gate intake file"),
    ]);
  }
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("intake file --help exits 0 and names its options", async () => {
  const fx = await makeFixture();
  const run = await runCli(["intake", "file", "--help"], fx.repo);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("--id <spec-id>");
  expect(run.stderr).toBe("");
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
  expect(run.code).toBe(2);
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
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("source-not-a-file");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("a missing source file is refused", async () => {
  const fx = await makeFixture();
  const run = await runCli(
    ["intake", "file", "nope.txt", "--id", "sg-nope"],
    fx.repo,
  );
  expect(run.code).toBe(2);
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
  expect(run.code).toBe(2);
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
  expect(run.code).toBe(2);
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
  expect(run.code).toBe(2);
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
  expect(run.code).toBe(2);
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
  expect(run.code).toBe(2);
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

// ---------------------------------------------------------------------------
// The configured remote is trusted as configured
// ---------------------------------------------------------------------------

/** A non-bare repository on a local path, with one commit on main. */
async function makeLocalRepo(fx: Fixture, name: string): Promise<string> {
  const dir = path.join(fx.root, name);
  fs.mkdirSync(dir);
  await git(dir, "-c", "init.defaultBranch=main", "init", "-q");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "l.txt"), `${name}\n`);
  await git(dir, "add", "l.txt");
  await git(dir, "commit", "-qm", name);
  return (await git(dir, "rev-parse", "HEAD")).stdout.trim();
}

it("a configured remote whose URL is a local path gives that repository's default-branch head", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const localHead = await makeLocalRepo(fx, "local-upstream");
  expect(localHead).not.toBe(fx.remoteHead);
  await git(
    fx.repo,
    "remote",
    "add",
    "localpath",
    path.join(fx.root, "local-upstream"),
  );
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-localurl", "--remote", "localpath"],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  const meta = readMeta(fx.repo, "sg-localurl");
  expect(meta.base_commit).toBe(localHead);
  expect(meta.commands_ref).toBe(localHead);
});

it("a url.<base>.insteadOf rewrite to a local path is honoured as configured", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const localHead = await makeLocalRepo(fx, "insteadof-upstream");
  expect(localHead).not.toBe(fx.remoteHead);
  const bogus = "https://upstream.invalid/rewritten.git";
  await git(fx.repo, "remote", "add", "rewritten", bogus);
  await git(
    fx.repo,
    "config",
    `url.${path.join(fx.root, "insteadof-upstream")}.insteadOf`,
    bogus,
  );
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-insteadof", "--remote", "rewritten"],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  expect(readMeta(fx.repo, "sg-insteadof").base_commit).toBe(localHead);
});

// ---------------------------------------------------------------------------
// The remote head: ref names, tags, local state
// ---------------------------------------------------------------------------

async function refSnapshot(repo: string): Promise<string> {
  return (await git(repo, "for-each-ref", "--format=%(refname) %(objectname)"))
    .stdout;
}

async function isShallow(repo: string): Promise<boolean> {
  return (
    (await git(repo, "rev-parse", "--is-shallow-repository")).stdout.trim() ===
    "true"
  );
}

/** Pushes a new commit to the remote default branch and returns its id. */
async function pushNewCommit(fx: Fixture, name: string): Promise<string> {
  fs.writeFileSync(path.join(fx.repo, name), `${name}\n`);
  await git(fx.repo, "add", name);
  await git(fx.repo, "commit", "-qm", name);
  await git(fx.repo, "push", "-q", "origin", "HEAD:refs/heads/main");
  return (await git(fx.repo, "rev-parse", "HEAD")).stdout.trim();
}

for (const kind of ["annotated", "lightweight"] as const) {
  it(`${kind === "annotated" ? "an" : "a"} ${kind} tag named like the default branch does not change base_commit`, async () => {
    const fx = await makeFixture();
    const ticket = writeTicket(fx.repo);
    const tagged = fx.remoteHead;
    if (kind === "annotated") {
      await git(fx.repo, "tag", "-a", "main", "-m", "tag", tagged);
    } else {
      await git(fx.repo, "tag", "main", tagged);
    }
    await git(fx.repo, "push", "-q", "origin", "refs/tags/main:refs/tags/main");
    const head = await pushNewCommit(fx, "after-tag.txt");
    expect(head).not.toBe(tagged);

    const run = await runCli(
      ["intake", "file", ticket, "--id", "sg-tag"],
      fx.repo,
    );
    expect([run.code, run.stderr]).toEqual([0, ""]);
    const meta = readMeta(fx.repo, "sg-tag");
    expect(meta.base_commit).toBe(head);
    expect(meta.commands_ref).toBe(head);
    expect(
      (await git(fx.repo, "cat-file", "-t", meta.base_commit)).stdout.trim(),
    ).toBe("commit");
  });
}

it("the fetch writes no local ref, fetches no tag and prunes nothing", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  await git(fx.repo, "tag", "-a", "remote-only", "-m", "t", fx.remoteHead);
  await git(
    fx.repo,
    "push",
    "-q",
    "origin",
    "refs/tags/remote-only:refs/tags/remote-only",
  );
  await git(fx.repo, "tag", "-d", "remote-only");
  // A remote-tracking ref whose branch the remote does not have: a prune
  // would delete it, and a missing tracking ref would be created by a fetch.
  await git(fx.repo, "update-ref", "refs/remotes/origin/gone", fx.remoteHead);
  await git(fx.repo, "update-ref", "-d", "refs/remotes/origin/main");
  const head = await pushNewCommit(fx, "ahead.txt");
  await git(fx.repo, "update-ref", "-d", "refs/remotes/origin/main");
  const before = await refSnapshot(fx.repo);

  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-norefs"],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  expect(readMeta(fx.repo, "sg-norefs").base_commit).toBe(head);
  expect(await refSnapshot(fx.repo)).toBe(before);
  expect(before).toContain("refs/remotes/origin/gone");
  expect(before).not.toContain("refs/remotes/origin/main");
  expect((await git(fx.repo, "tag", "-l")).stdout).toBe("");
});

for (const hostile of ["--depth=1", "--prune", "-x"]) {
  it(`a remote HEAD naming the branch ${hostile} is refused and changes nothing`, async () => {
    const fx = await makeFixture();
    const ticket = writeTicket(fx.repo);
    await git(fx.remote, "update-ref", `refs/heads/${hostile}`, fx.remoteHead);
    fs.writeFileSync(
      path.join(fx.remote, "HEAD"),
      `ref: refs/heads/${hostile}\n`,
    );
    const before = await refSnapshot(fx.repo);

    const run = await runCli(
      ["intake", "file", ticket, "--id", "sg-hostile"],
      fx.repo,
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("bad-default-branch");
    expect(await isShallow(fx.repo)).toBe(false);
    expect(await refSnapshot(fx.repo)).toBe(before);
    expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
  });
}

it("a remote HEAD outside refs/heads/ is refused", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  await git(fx.remote, "update-ref", "refs/tags/trunk", fx.remoteHead);
  fs.writeFileSync(path.join(fx.remote, "HEAD"), "ref: refs/tags/trunk\n");
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-outside"],
    fx.repo,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("bad-default-branch");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("a branch that cannot be fetched is a fetch-failed error and writes nothing", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  // The remote advertises HEAD but hides the branch from a fetch.
  await git(fx.remote, "config", "uploadpack.hideRefs", "refs/heads/main");
  const before = await refSnapshot(fx.repo);
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-nofetch"],
    fx.repo,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("fetch-failed");
  expect(await refSnapshot(fx.repo)).toBe(before);
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("a GIT_DIR of the caller does not redirect base_commit", async () => {
  const fx = await makeFixture();
  const decoy = await makeFixture();
  const ticket = writeTicket(fx.repo);
  await pushNewCommit(decoy, "decoy.txt");
  const decoyHead = (await git(decoy.repo, "rev-parse", "HEAD")).stdout.trim();
  expect(decoyHead).not.toBe(fx.remoteHead);

  const run = await runCli(
    [
      "intake",
      "file",
      path.join(fx.repo, ticket),
      "--id",
      "sg-env",
      "--repo",
      fx.repo,
    ],
    fx.root,
    {
      ...process.env,
      GIT_DIR: path.join(decoy.repo, ".git"),
      GIT_WORK_TREE: decoy.repo,
    },
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  expect(readMeta(fx.repo, "sg-env").base_commit).toBe(fx.remoteHead);
});

it("gitEnv drops every GIT_ variable and sets the switches", () => {
  const env = gitEnv({
    PATH: "/bin",
    GIT_DIR: "/decoy",
    GIT_CONFIG_PARAMETERS: "'remote.origin.url'='/decoy'",
    GIT_TERMINAL_PROMPT: "1",
  });
  expect(env["PATH"]).toBe("/bin");
  expect(env["GIT_DIR"]).toBeUndefined();
  expect(env["GIT_CONFIG_PARAMETERS"]).toBeUndefined();
  expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  expect(env["GIT_NO_REPLACE_OBJECTS"]).toBe("1");
  expect(env["GIT_NO_LAZY_FETCH"]).toBe("1");
  expect(env["GIT_OPTIONAL_LOCKS"]).toBe("0");
});

it("a timeout kills the whole process group of a git call", async () => {
  const fx = await makeFixture();
  const pidFile = path.join(fx.root, "grandchild.pid");
  const script =
    "const {spawn}=require('node:child_process');" +
    "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
    "require('node:fs').writeFileSync(process.argv[1],String(c.pid));" +
    "setInterval(()=>{},1000);";
  let failure: unknown;
  try {
    await runProcess(process.execPath, ["-e", script, pidFile], {
      env: process.env,
      timeoutMs: 2000,
    });
  } catch (err) {
    failure = err;
  }
  expect(failure).toBeInstanceOf(ProcessFailure);
  expect((failure as ProcessFailure).kind).toBe("timeout");
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  const alive = (): boolean => {
    try {
      process.kill(grandchild, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && alive(); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const stillAlive = alive();
  if (stillAlive) process.kill(grandchild, "SIGKILL");
  expect(stillAlive).toBe(false);
}, 20_000);

// ---------------------------------------------------------------------------
// --git-timeout and SPEC_GATE_GIT_TIMEOUT
// ---------------------------------------------------------------------------

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A remote whose upload-pack answers its first `answered` calls through the
 * real git and then never answers; the pid of the sleeping child is written
 * to a file. `answered: 0` hangs `ls-remote`, `answered: 1` lets `ls-remote`
 * through and hangs the fetch.
 */
async function makeHangingRemote(
  answered = 0,
): Promise<{ fx: Fixture; pidFile: string }> {
  const fx = await makeFixture();
  const pidFile = path.join(fx.root, "hang.pid");
  const counter = path.join(fx.root, "calls.count");
  const script = path.join(fx.root, "hang.sh");
  fs.writeFileSync(
    script,
    `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0)\nn=$((n + 1))\necho $n > "${counter}"\n` +
      `if [ $n -le ${answered} ]; then exec git upload-pack "$@"; fi\n` +
      `sleep 20 &\necho $! > "${pidFile}"\nwait\n`,
    { mode: 0o755 },
  );
  await git(fx.repo, "config", "remote.origin.uploadpack", script);
  return { fx, pidFile };
}

async function expectHangTimedOut(
  run: CliRun,
  pidFile: string,
  started: number,
  code: "no-remote" | "fetch-failed" = "no-remote",
): Promise<void> {
  expect(run.code).toBe(2);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain(`spec-gate: ${code}:`);
  expect(run.stderr).toContain("within 1 seconds");
  expect(Date.now() - started).toBeLessThan(10_000);
  const hung = Number(fs.readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 50 && pidAlive(hung); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const stillAlive = pidAlive(hung);
  if (stillAlive) process.kill(hung, "SIGKILL");
  expect(stillAlive).toBe(false);
}

it("--git-timeout 1 stops a hanging remote after one second and kills its process group", async () => {
  const { fx, pidFile } = await makeHangingRemote();
  const ticket = writeTicket(fx.repo);
  const started = Date.now();
  const run = await runCli(
    [
      "intake",
      "file",
      ticket,
      "--id",
      "sg-hang",
      "--repo",
      fx.repo,
      "--git-timeout",
      "1",
    ],
    fx.repo,
  );
  await expectHangTimedOut(run, pidFile, started);
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
}, 60_000);

it("--git-timeout 1 stops a fetch that hangs after ls-remote answered", async () => {
  const { fx, pidFile } = await makeHangingRemote(1);
  const ticket = writeTicket(fx.repo);
  const started = Date.now();
  const run = await runCli(
    [
      "intake",
      "file",
      ticket,
      "--id",
      "sg-hang-fetch",
      "--repo",
      fx.repo,
      "--git-timeout",
      "1",
    ],
    fx.repo,
  );
  await expectHangTimedOut(run, pidFile, started, "fetch-failed");
  expect(
    fs.readFileSync(path.join(fx.root, "calls.count"), "utf8").trim(),
  ).toBe("2");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
}, 60_000);

it("SPEC_GATE_GIT_TIMEOUT=1 stops a hanging remote after one second and kills its process group", async () => {
  const { fx, pidFile } = await makeHangingRemote();
  const ticket = writeTicket(fx.repo);
  const started = Date.now();
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-hang", "--repo", fx.repo],
    fx.repo,
    { ...process.env, SPEC_GATE_GIT_TIMEOUT: "1" },
  );
  await expectHangTimedOut(run, pidFile, started);
}, 60_000);

it("a refused git timeout exits 2 before any git call, with the value not echoed, for the flag and the env", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-intake-"));
  created.push(root);
  const notARepo = path.join(root, "plain");
  fs.mkdirSync(notARepo);
  const ticket = path.join(root, "ticket.txt");
  fs.writeFileSync(ticket, TICKET);
  for (const extra of [[], ["--check"]]) {
    const byFlag = await runCli(
      [
        "intake",
        "file",
        ticket,
        "--id",
        "sg-bad",
        "--repo",
        notARepo,
        "--git-timeout",
        "9999",
        ...extra,
      ],
      root,
    );
    expect([byFlag.code, byFlag.stdout]).toEqual([2, ""]);
    expect(byFlag.stderr).toContain("bad-git-timeout");
    expect(byFlag.stderr).not.toContain("9999");
    const byEnv = await runCli(
      [
        "intake",
        "file",
        ticket,
        "--id",
        "sg-bad",
        "--repo",
        notARepo,
        ...extra,
      ],
      root,
      { ...process.env, SPEC_GATE_GIT_TIMEOUT: "" },
    );
    expect([byEnv.code, byEnv.stdout]).toEqual([2, ""]);
    expect(byEnv.stderr).toContain("bad-git-timeout");
  }
  expect(fs.existsSync(path.join(notARepo, "specs"))).toBe(false);
  // Without --repo the repository would be found with git; the refusal still
  // comes first, so the error is the timeout and not a missing repository.
  const noRepo = await runCli(
    ["intake", "file", ticket, "--id", "sg-bad", "--git-timeout", "0x10"],
    notARepo,
  );
  expect([noRepo.code, noRepo.stdout]).toEqual([2, ""]);
  expect(noRepo.stderr).toContain("bad-git-timeout");
  expect(noRepo.stderr).not.toContain("no-git-toplevel");
}, 60_000);

it("a valid --git-timeout leaves a normal run unchanged, and the flag wins over a bad env", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const run = await runCli(
    [
      "intake",
      "file",
      ticket,
      "--id",
      "sg-ok",
      "--repo",
      fx.repo,
      "--git-timeout",
      "30",
    ],
    fx.repo,
    { ...process.env, SPEC_GATE_GIT_TIMEOUT: "abc" },
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  expect(readMeta(fx.repo, "sg-ok").base_commit).toBe(fx.remoteHead);
}, 60_000);

// ---------------------------------------------------------------------------
// --remote
// ---------------------------------------------------------------------------

it("--remote naming a path or a URL is refused and the value is not echoed", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  for (const [value, secret] of [
    [".", null],
    ["..", null],
    ["-x", null],
    [fx.remote, fx.remote],
    ["https://user:pa55w0rdvalue@example.invalid/r.git", "pa55w0rdvalue"],
    ["host:path", "host:path"],
    ["/abs/path", "/abs/path"],
  ] as const) {
    const run = await runCli(
      ["intake", "file", ticket, "--id", "sg-remote-bad", `--remote=${value}`],
      fx.repo,
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("bad-remote");
    if (secret !== null) expect(run.stderr).not.toContain(secret);
    expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
  }
});

it("--remote naming a remote that is not configured is refused", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-remote-none", "--remote", "nope"],
    fx.repo,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("no-remote");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("an unreachable remote does not leak the URL or its credentials", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  await git(
    fx.repo,
    "remote",
    "add",
    "leaky",
    "http://user:s3cr3tpassw0rd@127.0.0.1:1/r.git",
  );
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-leak", "--remote", "leaky"],
    fx.repo,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("no-remote");
  expect(run.stderr).not.toContain("s3cr3tpassw0rd");
  expect(run.stderr).not.toContain("127.0.0.1");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

// ---------------------------------------------------------------------------
// Error paths of the repository, the attachments and meta.json
// ---------------------------------------------------------------------------

it("--repo naming a file is a bad-repo error", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-badrepo", "--repo", ticket],
    fx.repo,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("bad-repo");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("outside a git repository and without --repo the error is no-git-toplevel", async () => {
  const fx = await makeFixture();
  writeTicket(fx.repo);
  const run = await runCli(
    ["intake", "file", path.join(fx.repo, "ticket.txt"), "--id", "sg-notop"],
    fx.root,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("no-git-toplevel");
  expect(fs.existsSync(path.join(fx.root, "specs"))).toBe(false);
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("an attachment that is a directory is refused and writes nothing", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  fs.mkdirSync(path.join(fx.repo, "adir"));
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-attdir", "--attach", "adir"],
    fx.repo,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("attachment-missing");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("--check refuses a meta.json that is not usable and writes nothing", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  expect(
    (await runCli(["intake", "file", ticket, "--id", "sg-badmeta"], fx.repo))
      .code,
  ).toBe(0);
  const metaPath = path.join(
    fx.repo,
    "specs",
    "sg-badmeta",
    "source",
    "meta.json",
  );
  const good = readMeta(fx.repo, "sg-badmeta");
  const goodLine = good.lines[0]!;
  const bad: [string, string][] = [
    ["malformed", "{"],
    ["wrong shape", '{"sha256": 1, "lines": "no"}'],
    ["empty object", "{}"],
    ["null", "null"],
    ["array", "[]"],
    [
      "entry without kind",
      JSON.stringify({ sha256: good.sha256, lines: [{ id: goodLine.id }] }),
    ],
    [
      "entry that is null",
      JSON.stringify({ sha256: good.sha256, lines: [null] }),
    ],
    [
      "entry that is no line id",
      JSON.stringify({
        sha256: "0".repeat(64),
        lines: [{ id: "x", kind: "text" }],
      }),
    ],
  ];
  for (const [label, content] of bad) {
    fs.writeFileSync(metaPath, content);
    const run = await runCli(
      ["intake", "file", ticket, "--id", "sg-badmeta", "--check"],
      fx.repo,
    );
    expect([label, run.code]).toEqual([label, 2]);
    expect([label, run.stderr]).toEqual([
      label,
      expect.stringContaining("meta-invalid"),
    ]);
    expect(run.stderr).not.toContain("    at ");
    expect(run.stdout).toBe("");
    expect(fs.readFileSync(metaPath, "utf8")).toBe(content);
  }
});

it("--check exits 0 for an unchanged file, 1 for drift and 2 for an error", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  await runCli(["intake", "file", ticket, "--id", "sg-codes"], fx.repo);
  const args = ["intake", "file", ticket, "--id", "sg-codes", "--check"];
  expect((await runCli(args, fx.repo)).code).toBe(0);
  fs.writeFileSync(path.join(fx.repo, ticket), "something else\n");
  expect((await runCli(args, fx.repo)).code).toBe(1);
  const missing = await runCli(
    ["intake", "file", ticket, "--id", "sg-none", "--check"],
    fx.repo,
  );
  expect(missing.code).toBe(2);
});

it("--check reports drift with empty lists when the hash differs but every line id is the same", async () => {
  const fx = await makeFixture();
  writeTicket(fx.repo, "alpha\nbravo\n");
  await runCli(["intake", "file", "ticket.txt", "--id", "sg-same"], fx.repo);
  // A trailing newline changes the bytes, not the normalised lines.
  fs.writeFileSync(path.join(fx.repo, "ticket.txt"), "alpha\nbravo\n\n\n");
  const run = await runCli(
    ["intake", "file", "ticket.txt", "--id", "sg-same", "--check"],
    fx.repo,
  );
  expect(run.code).toBe(1);
  expect(JSON.parse(run.stdout)).toEqual({
    status: "source-drift",
    changed_lines: [],
    added: [],
    removed: [],
  });
});

// ---------------------------------------------------------------------------
// Writing: refusals, atomicity
// ---------------------------------------------------------------------------

it("a source/ that appears as a dangling symlink is source-exists and is left alone", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  fs.mkdirSync(path.join(fx.repo, "specs", "sg-dangle"), { recursive: true });
  const link = path.join(fx.repo, "specs", "sg-dangle", "source");
  fs.symlinkSync(path.join(fx.root, "nowhere"), link);
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-dangle"],
    fx.repo,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("source-exists");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readdirSync(path.join(fx.repo, "specs", "sg-dangle"))).toEqual([
    "source",
  ]);
});

it("a symlinked specs directory is source-not-in-repo and the target stays empty", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const outside = path.join(fx.root, "outside-specs");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(fx.repo, "specs"));
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-symspecs"],
    fx.repo,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("source-not-in-repo");
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.lstatSync(path.join(fx.repo, "specs")).isSymbolicLink()).toBe(true);
});

it("a symlinked specs/<id> directory is source-not-in-repo and the target stays empty", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const outside = path.join(fx.root, "outside-id");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(fx.repo, "specs"));
  fs.symlinkSync(outside, path.join(fx.repo, "specs", "sg-symid"));
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-symid"],
    fx.repo,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("source-not-in-repo");
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.readdirSync(path.join(fx.repo, "specs"))).toEqual(["sg-symid"]);
  expect(
    fs.lstatSync(path.join(fx.repo, "specs", "sg-symid")).isSymbolicLink(),
  ).toBe(true);
});

it("a specs path that is a file is a write-failed error, not a stack trace", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  fs.writeFileSync(path.join(fx.repo, "specs"), "i am a file\n");
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-wf"],
    fx.repo,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("write-failed");
  expect(run.stderr).not.toContain("    at ");
  expect(fs.readFileSync(path.join(fx.repo, "specs"), "utf8")).toBe(
    "i am a file\n",
  );
});

it("ticket.md is written before meta.json and a failed write removes everything", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-write-"));
  created.push(root);
  const renames: string[] = [];
  const real = fs.renameSync;
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    renames.push(path.basename(String(to)));
    if (path.basename(String(to)) === "meta.json") {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }
    real(from, to);
  });
  try {
    let failure: unknown;
    try {
      writeSource(root, "sg-half", "specs/sg-half/source", {
        ticket: Buffer.from("raw\n"),
        meta: "{}\n",
      });
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(IntakeError);
    expect((failure as IntakeError).code).toBe("write-failed");
    expect((failure as IntakeError).message).toContain("ENOSPC");
  } finally {
    spy.mockRestore();
  }
  expect(renames).toEqual(["ticket.md", "meta.json"]);
  expect(fs.readdirSync(root)).toEqual([]);
});

it("a failed write keeps a specs directory that already existed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-write-"));
  created.push(root);
  fs.mkdirSync(path.join(root, "specs", "other"), { recursive: true });
  const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw Object.assign(new Error("boom"), { code: "EIO" });
  });
  try {
    expect(() =>
      writeSource(root, "sg-keep", "specs/sg-keep/source", {
        ticket: null,
        meta: "{}\n",
      }),
    ).toThrow(/write-failed.*EIO/);
  } finally {
    spy.mockRestore();
  }
  expect(fs.readdirSync(path.join(root, "specs"))).toEqual(["other"]);
});

// ---------------------------------------------------------------------------
// Secret scan: forms and encodings
// ---------------------------------------------------------------------------

it("a keyword inside an identifier is refused", async () => {
  await expectSecret(
    'DB_PASSWORD="supersecretvalue123"\n',
    "secret-assignment",
    1,
    "supersecretvalue123",
  );
  await expectSecret(
    'AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"\n',
    "secret-assignment",
    1,
    "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
  );
  await expectSecret(
    'x\naccess_token: "abcdefghijklmnop"\n',
    "secret-assignment",
    2,
    "abcdefghijklmnop",
  );
});

it("apiKey and api-key assignments are refused", async () => {
  await expectSecret(
    'apiKey = "abcdefghijklmnopqrst"\n',
    "secret-assignment",
    1,
    "abcdefghijklmnopqrst",
  );
  await expectSecret(
    "x-api-key: 'abcdefghijklmnopqrst'\n",
    "secret-assignment",
    1,
    "abcdefghijklmnopqrst",
  );
});

it("a JSON or YAML key with a closing quote is refused", async () => {
  await expectSecret(
    '{\n  "password": "supersecretvalue123"\n}\n',
    "secret-assignment",
    2,
    "supersecretvalue123",
  );
  await expectSecret(
    "'token': 'abcdefghijklmnop'\n",
    "secret-assignment",
    1,
    "abcdefghijklmnop",
  );
});

it("a PGP private key block header is refused", async () => {
  await expectSecret(
    "a\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nblob\n",
    "private-key",
    2,
    "BEGIN PGP PRIVATE KEY BLOCK",
  );
});

it("a ghr_ token is refused", async () => {
  await expectSecret(
    `refresh ghr_${"c".repeat(36)}\n`,
    "github-token",
    1,
    `ghr_${"c".repeat(36)}`,
  );
});

it("widened near-misses are accepted", async () => {
  const fx = await makeFixture();
  fs.writeFileSync(
    path.join(fx.repo, "ticket.txt"),
    [
      "token_count = 12",
      'max_tokens: "10"',
      '"secret_santa": "tiny"',
      "the password: use the vault",
      "api_key_name = unset",
      "-----BEGIN PGP PUBLIC KEY BLOCK-----",
      "ghq_" + "a".repeat(40),
      "",
    ].join("\n"),
  );
  const run = await runCli(
    ["intake", "file", "ticket.txt", "--id", "sg-near2"],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  expect(metaExists(fx.repo, "sg-near2")).toBe(true);
});

it("a very long assignment line is scanned without stalling", async () => {
  const fx = await makeFixture();
  fs.writeFileSync(
    path.join(fx.repo, "ticket.txt"),
    `${"token".repeat(40_000)}\n${'password="'.repeat(2000)}\n`,
  );
  const started = Date.now();
  const run = await runCli(
    ["intake", "file", "ticket.txt", "--id", "sg-long"],
    fx.repo,
  );
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(run.code === 0 || run.code === 2).toBe(true);
});

it("UTF-16 input and NUL bytes are refused with a named error", async () => {
  for (const [label, bytes] of [
    [
      "utf-16le bom",
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('password = "supersecretvalue123"\n', "utf16le"),
      ]),
    ],
    ["utf-16be bom", Buffer.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x0a])],
    ["nul byte", Buffer.from("fine\nline\0with nul\n")],
    ["bom only", Buffer.from([0xff, 0xfe, 0x68, 0x69, 0x0a])],
  ] as const) {
    const fx = await makeFixture();
    fs.writeFileSync(path.join(fx.repo, "ticket.txt"), bytes);
    const run = await runCli(
      ["intake", "file", "ticket.txt", "--id", "sg-enc"],
      fx.repo,
    );
    expect([label, run.code]).toEqual([label, 2]);
    expect(run.stderr).toContain("source-encoding");
    expect(run.stderr).not.toContain("supersecretvalue123");
    expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// Remote head details
// ---------------------------------------------------------------------------

it("FETCH_HEAD must hold exactly one for-merge entry for this branch", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  const entry = `${sha}\t\tbranch 'main' of /somewhere\n`;
  expect(parseFetchHead(entry, "main")).toBe(sha);
  expect(
    parseFetchHead(`${"c".repeat(64)}\t\tbranch 'main' of u\n`, "main"),
  ).toBe("c".repeat(64));
  for (const [label, content] of [
    ["two entries", `${entry}${other}\t\tbranch '---a' of /somewhere\n`],
    ["no entry", ""],
    ["no commit id", `zzzz\t\tbranch 'main' of /somewhere\n`],
    ["not for merge", `${sha}\tnot-for-merge\tbranch 'main' of /s\n`],
    ["other branch", `${sha}\t\tbranch 'trunk' of /somewhere\n`],
    ["a tag", `${sha}\t\ttag 'main' of /somewhere\n`],
  ] as const) {
    expect(() => parseFetchHead(content, "main"), label).toThrow(
      /fetch-failed/,
    );
  }
});

it("a stale FETCH_HEAD cannot stand in for a failed fetch", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  fs.writeFileSync(
    path.join(fx.repo, ".git", "FETCH_HEAD"),
    `${fx.remoteHead}\t\tbranch 'main' of ${fx.remote}\n`,
  );
  await git(fx.remote, "config", "uploadpack.hideRefs", "refs/heads/main");
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-stale"],
    fx.repo,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("fetch-failed");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("a repo config fetch.writeFetchHEAD=false cannot leave a stale FETCH_HEAD", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  const staleHead = fx.remoteHead;
  const freshHead = await pushNewCommit(fx, "fresh.txt");
  expect(freshHead).not.toBe(staleHead);
  // A FETCH_HEAD from an older fetch of the same branch, and the config that
  // would keep git from overwriting it.
  fs.writeFileSync(
    path.join(fx.repo, ".git", "FETCH_HEAD"),
    `${staleHead}\t\tbranch 'main' of ${fx.remote}\n`,
  );
  await git(fx.repo, "config", "fetch.writeFetchHEAD", "false");
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-wfh"],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  const meta = readMeta(fx.repo, "sg-wfh");
  expect(meta.base_commit).toBe(freshHead);
  expect(meta.base_commit).not.toBe(staleHead);
});

it("a directory named like the remote is not used as one", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  // `git ls-remote sneaky` would read this directory as a repository path.
  const bare = path.join(fx.repo, "sneaky");
  fs.mkdirSync(bare);
  await git(bare, "-c", "init.defaultBranch=main", "init", "-q", "--bare");
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-dirremote", "--remote", "sneaky"],
    fx.repo,
  );
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("no-remote");
  expect(fs.existsSync(path.join(fx.repo, "specs"))).toBe(false);
});

it("a branch that points at a tag object is peeled to its commit", async () => {
  const fx = await makeFixture();
  const ticket = writeTicket(fx.repo);
  await git(fx.repo, "tag", "-a", "obj", "-m", "t", fx.remoteHead);
  await git(fx.repo, "push", "-q", "origin", "refs/tags/obj:refs/tags/obj");
  const tagObject = (await git(fx.repo, "rev-parse", "obj")).stdout.trim();
  expect(tagObject).not.toBe(fx.remoteHead);
  // Only a hand-written ref can name a non-commit object as a branch head.
  fs.writeFileSync(
    path.join(fx.remote, "refs", "heads", "main"),
    `${tagObject}\n`,
  );
  const run = await runCli(
    ["intake", "file", ticket, "--id", "sg-peel"],
    fx.repo,
  );
  expect([run.code, run.stderr]).toEqual([0, ""]);
  expect(readMeta(fx.repo, "sg-peel").base_commit).toBe(fx.remoteHead);
});

it("runProcess reports a missing program and an oversized output", async () => {
  const missing = await runProcess("spec-gate-no-such-program", [], {
    env: process.env,
    timeoutMs: 5000,
  }).catch((err: unknown) => err);
  expect(missing).toBeInstanceOf(ProcessFailure);
  expect((missing as ProcessFailure).kind).toBe("spawn");
  expect((missing as ProcessFailure).message).toContain("not installed");

  const big = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(100000))"],
    { env: process.env, timeoutMs: 10_000, maxOutputBytes: 1000 },
  ).catch((err: unknown) => err);
  expect(big).toBeInstanceOf(ProcessFailure);
  expect((big as ProcessFailure).kind).toBe("output");
});

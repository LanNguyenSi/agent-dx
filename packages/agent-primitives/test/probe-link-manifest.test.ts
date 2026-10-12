import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINK_MANIFEST_FILE,
  LINK_MANIFEST_MAX_BYTES,
  linkedWorktreeAdminDir,
  manifestLinkGroup,
  captureLinkIdentity,
  parseManifest,
  readLinkManifest,
  recordedLinkStillHolds,
  trustedManifestLinks,
  writeLinkManifest,
  type ManifestLink,
} from "../src/probe/link-manifest.js";
import { mergeLinkSources } from "../src/probe/link-list.js";
import { normalizeLinkEntry } from "../src/worktree/index.js";
import { spawnCli } from "./helpers/spawn-cli.js";

/**
 * `worktree create` records the links it made in the new worktree's git
 * administration directory, and `probe` run in that worktree treats each
 * of them like an operator `--link` while it still stands as recorded.
 * Nothing in the working tree can grant a link.
 */

const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const GIT_ENV_WITH_PATH: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  ...GIT_ENV,
};

vi.setConfig({ testTimeout: 120_000 });

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...GIT_ENV },
  });
}

interface Fixture {
  base: string;
  /** The main checkout. Its gitignored `lib` holds the file the test
   * command needs, so a worktree passes its baseline only when `lib` is
   * linked into the probe's isolation copy. */
  repo: string;
  /** Outside every working tree, like a run directory. */
  runDir: string;
  logs: string;
}

function makeFixture(): Fixture {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-manifest-")),
  );
  tmpDirs.push(base);
  const repo = path.join(base, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git(base, ["init", "-q", "-b", "main", repo]);
  fs.writeFileSync(path.join(repo, "src", "a.sh"), "x=1\n");
  fs.writeFileSync(
    path.join(repo, "test.js"),
    [
      'const fs = require("fs");',
      'const ok = fs.existsSync("lib/x.js") &&',
      '  fs.readFileSync("src/a.sh", "utf8").includes("x=1");',
      'if (ok) console.log("OK (1 test)");',
      "process.exit(ok ? 0 : 1);",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(repo, ".gitignore"), "lib\n");
  git(repo, ["add", ".gitignore", "src", "test.js"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  fs.mkdirSync(path.join(repo, "lib"));
  fs.writeFileSync(path.join(repo, "lib", "x.js"), "module.exports = 1;\n");
  const runDir = path.join(base, "run");
  fs.mkdirSync(runDir);
  return { base, repo, runDir, logs: path.join(base, "logs") };
}

async function createWorktree(
  f: Fixture,
  name: string,
  links: string[],
): Promise<string> {
  const target = path.join(f.base, name);
  const r = await spawnCli(
    [
      "-C",
      f.base,
      "worktree",
      "create",
      "--repo",
      f.repo,
      "--branch",
      name,
      "--base",
      "main",
      "--path",
      target,
      ...links.flatMap((l) => ["--link", l]),
    ],
    { env: GIT_ENV },
  );
  expect(r.code, r.stdout + r.stderr).toBe(0);
  return target;
}

function adminDirOf(worktree: string): string {
  const admin = linkedWorktreeAdminDir(worktree);
  if (!admin.ok) throw new Error(admin.reason);
  return admin.dir;
}

/** The entry `create` recorded for `rel` in `worktree`'s manifest. */
function recordedEntry(worktree: string, rel: string): ManifestLink {
  const read = readLinkManifest(worktree);
  if (read.status !== "ok") throw new Error(JSON.stringify(read));
  const entry = read.manifest.links.find((l) => l.path === rel);
  if (entry === undefined) throw new Error(`no recorded link ${rel}`);
  return entry;
}

/** A well-formed manifest entry for the directory at `dir`, as a hostile
 * commit or a stale file might claim it. */
function claimedEntry(rel: string, dir: string): ManifestLink {
  const identity = captureLinkIdentity(dir);
  if (identity === undefined) throw new Error(`cannot resolve ${dir}`);
  return {
    path: rel,
    target: dir,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...identity,
  };
}

function writePlan(file: string, body: Record<string, unknown> = {}): string {
  fs.writeFileSync(
    file,
    JSON.stringify({
      test: "node test.js",
      passWhen: { regex: "^OK \\(" },
      mutants: [{ file: "src/a.sh", line: 1, replace: "x=2" }],
      ...body,
    }),
  );
  return file;
}

interface Probed {
  code: number | null;
  envelope: {
    status: string;
    reason?: string;
    warnings: string[];
    plan?: { results: { status: string }[] };
  };
}

/** Warnings about the link manifest, as opposed to the pass-regex
 * notes every failing baseline carries. */
function isLinkWarning(warning: string): boolean {
  return /worktree link|link manifest/.test(warning);
}

async function probeIn(
  f: Fixture,
  worktree: string,
  args: string[],
): Promise<Probed> {
  const run = await spawnCli(
    ["-C", worktree, "-l", f.logs, "-m", "100000", "probe", ...args],
    { env: GIT_ENV },
  );
  return {
    code: run.code,
    envelope: JSON.parse(run.stdout) as Probed["envelope"],
  };
}

describe("worktree create: the link manifest", () => {
  it("records the links in the git administration directory, not in the working tree", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-record", ["lib"]);

    const admin = adminDirOf(wt);
    expect(path.dirname(path.dirname(admin))).toBe(
      fs.realpathSync(path.join(f.repo, ".git")),
    );
    const file = path.join(admin, LINK_MANIFEST_FILE);
    const recorded = JSON.parse(fs.readFileSync(file, "utf8")) as {
      version: number;
      toolVersion: string;
      links: {
        path: string;
        target: string;
        createdAt: string;
        resolved: string;
        dev: string;
        ino: string;
      }[];
    };
    expect(recorded.version).toBe(2);
    expect(typeof recorded.toolVersion).toBe("string");
    expect(recorded.links).toHaveLength(1);
    const libStat = fs.statSync(path.join(f.repo, "lib"), { bigint: true });
    expect(recorded.links[0]).toMatchObject({
      path: "lib",
      target: path.join(f.repo, "lib"),
      resolved: fs.realpathSync(path.join(f.repo, "lib")),
      dev: libStat.dev.toString(),
      ino: libStat.ino.toString(),
    });
    expect(Number.isNaN(Date.parse(recorded.links[0]!.createdAt))).toBe(false);
    // Private to its owner, and nothing of it in the working tree.
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(fs.existsSync(path.join(wt, LINK_MANIFEST_FILE))).toBe(false);
    expect(git(wt, ["status", "--porcelain", "--ignored"])).not.toContain(
      LINK_MANIFEST_FILE,
    );
  });

  it("reports the manifest in the envelope, and writes none when no link was made", async () => {
    const f = makeFixture();
    const withLink = await spawnCli(
      [
        "-C",
        f.base,
        "worktree",
        "create",
        "--repo",
        f.repo,
        "--branch",
        "a",
        "--base",
        "main",
        "--path",
        path.join(f.base, "wt-a"),
        "--link",
        "lib",
      ],
      { env: GIT_ENV },
    );
    const noLink = await spawnCli(
      [
        "-C",
        f.base,
        "worktree",
        "create",
        "--repo",
        f.repo,
        "--branch",
        "b",
        "--base",
        "main",
        "--path",
        path.join(f.base, "wt-b"),
      ],
      { env: GIT_ENV },
    );
    const a = JSON.parse(withLink.stdout) as {
      links: { manifest: { status: string; path: string } };
    };
    const b = JSON.parse(noLink.stdout) as {
      links: { manifest: { status: string; path?: string } };
    };
    expect(a.links.manifest.status).toBe("written");
    expect(a.links.manifest.path).toBe(
      path.join(adminDirOf(path.join(f.base, "wt-a")), LINK_MANIFEST_FILE),
    );
    expect(b.links.manifest).toEqual({ status: "not_needed" });
    expect(
      fs.existsSync(
        path.join(adminDirOf(path.join(f.base, "wt-b")), LINK_MANIFEST_FILE),
      ),
    ).toBe(false);
  });

  it("is deleted with the worktree: git removes the administration directory and the manifest in it", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-remove", ["lib"]);
    const admin = adminDirOf(wt);
    expect(fs.existsSync(path.join(admin, LINK_MANIFEST_FILE))).toBe(true);

    git(f.repo, ["worktree", "remove", "--force", wt]);

    expect(fs.existsSync(admin)).toBe(false);
    expect(fs.existsSync(path.join(admin, LINK_MANIFEST_FILE))).toBe(false);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("is deleted by `worktree remove` of a clean, pushed worktree: the administration directory goes with the manifest", async () => {
    const f = makeFixture();
    // `remove` refuses commits that are on no remote branch, so the
    // fixture gets an origin and the worktree's branch is pushed.
    const origin = path.join(f.base, "origin.git");
    git(f.base, ["init", "-q", "--bare", "-b", "main", origin]);
    git(f.repo, ["remote", "add", "origin", origin]);
    git(f.repo, ["push", "-q", "origin", "main"]);
    git(f.repo, ["remote", "set-head", "origin", "main"]);
    const wt = await createWorktree(f, "wt-cli-remove", ["lib"]);
    git(wt, ["push", "-q", "origin", "wt-cli-remove"]);
    const admin = adminDirOf(wt);
    expect(fs.existsSync(path.join(admin, LINK_MANIFEST_FILE))).toBe(true);

    const removed = await spawnCli(["-C", f.base, "worktree", "remove", wt], {
      env: GIT_ENV,
    });

    expect(removed.code, removed.stdout + removed.stderr).toBe(0);
    expect(fs.existsSync(admin)).toBe(false);
    expect(fs.existsSync(path.join(admin, LINK_MANIFEST_FILE))).toBe(false);
    expect(fs.existsSync(wt)).toBe(false);
    // The link target in the main checkout is untouched.
    expect(fs.existsSync(path.join(f.repo, "lib", "x.js"))).toBe(true);
  });

  it("reports a failed write as a failed status instead of throwing", () => {
    const f = makeFixture();
    // The main checkout is not a linked worktree: there is no
    // administration directory of the shape the manifest lives in.
    const result = writeLinkManifest(f.repo, [], "0.0.0");
    expect(result.status).toBe("failed");
    expect(fs.existsSync(path.join(f.repo, ".git", LINK_MANIFEST_FILE))).toBe(
      false,
    );
  });
});

describe("probe in a worktree made by create: the recorded links count as --link", () => {
  it("passes the baseline with a plan in the run directory and no link key", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-plan", ["lib"]);
    const plan = writePlan(path.join(f.runDir, "plan.json"));

    const { code, envelope } = await probeIn(f, wt, ["--plan", plan]);

    expect(envelope.warnings).toEqual([]);
    expect(envelope.status).toBe("killed");
    expect(envelope.plan?.results.map((r) => r.status)).toEqual(["killed"]);
    expect(code).toBe(0);
  });

  it("passes the baseline for a plan inside the worktree with no link key, and for a single probe with no --link", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-both", ["lib"]);
    const inRepo = writePlan(path.join(wt, "plan.json"));

    const plan = await probeIn(f, wt, ["--plan", inRepo]);
    const single = await probeIn(f, wt, [
      "--file",
      "src/a.sh",
      "-n",
      "1",
      "-r",
      "x=2",
      "-t",
      "node test.js",
      "--pass-regex",
      "^OK \\(",
    ]);

    expect(plan.envelope.status).toBe("killed");
    expect(single.envelope.status).toBe("killed");
    expect(single.envelope.warnings.filter(isLinkWarning)).toEqual([]);
  });

  it("control: without the manifest the same probe fails its baseline", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-control", ["lib"]);
    fs.rmSync(path.join(adminDirOf(wt), LINK_MANIFEST_FILE));
    const plan = writePlan(path.join(f.runDir, "plan.json"));

    const { envelope } = await probeIn(f, wt, ["--plan", plan]);

    expect(envelope.status).toBe("inconclusive");
    expect(envelope.reason).toBe("baseline_failed");
  });

  it("does not make the main checkout's link trusted: a plain repository has no manifest", async () => {
    const f = makeFixture();
    // The same layout by hand in the main checkout: a gitignored symlink
    // and a manifest-shaped file in `.git`. The main checkout is not a
    // linked worktree, so nothing is read.
    const outside = path.join(f.base, "elsewhere");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "x.js"), "1\n");
    fs.symlinkSync(outside, path.join(f.repo, "lib2"));
    fs.writeFileSync(
      path.join(f.repo, ".git", LINK_MANIFEST_FILE),
      JSON.stringify({
        version: 2,
        toolVersion: "x",
        links: [claimedEntry("lib2", outside)],
      }),
      { mode: 0o600 },
    );
    expect(readLinkManifest(f.repo)).toEqual({ status: "absent" });
    expect(trustedManifestLinks(f.repo)).toEqual({ values: [], warnings: [] });
  });
});

describe("repository content never grants a link", () => {
  it("ignores a manifest-like file in the working tree", async () => {
    const f = makeFixture();
    // No link at create time, so there is no real manifest at all. The
    // working tree then carries a perfectly shaped manifest next to a
    // symlink it names, as a hostile commit might.
    const wt = await createWorktree(f, "wt-hostile", []);
    fs.symlinkSync(path.join(f.repo, "lib"), path.join(wt, "lib"));
    const body = JSON.stringify({
      version: 2,
      toolVersion: "x",
      links: [claimedEntry("lib", path.join(f.repo, "lib"))],
    });
    for (const name of [
      LINK_MANIFEST_FILE,
      `.${LINK_MANIFEST_FILE}`,
      ".agent-primitives-links",
    ]) {
      fs.writeFileSync(path.join(wt, name), body, { mode: 0o600 });
    }
    expect(readLinkManifest(wt)).toEqual({ status: "absent" });
    const plan = writePlan(path.join(f.runDir, "plan.json"));

    const { envelope } = await probeIn(f, wt, ["--plan", plan]);

    expect(envelope.status).toBe("inconclusive");
    expect(envelope.reason).toBe("baseline_failed");
    expect(envelope.warnings.filter(isLinkWarning)).toEqual([]);
  });

  it("does not let a working-tree file stand in for a missing or rejected manifest", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-shadow", ["lib"]);
    const admin = adminDirOf(wt);
    // Corrupt the real one; a good-looking copy in the working tree must
    // not be consulted instead.
    fs.writeFileSync(path.join(admin, LINK_MANIFEST_FILE), "{ not json", {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(wt, LINK_MANIFEST_FILE),
      JSON.stringify({
        version: 2,
        toolVersion: "x",
        links: [claimedEntry("lib", path.join(f.repo, "lib"))],
      }),
    );

    const read = readLinkManifest(wt);
    const trusted = trustedManifestLinks(wt);

    expect(read.status).toBe("rejected");
    expect(trusted.values).toEqual([]);
    expect(trusted.warnings).toHaveLength(1);
    expect(trusted.warnings[0]).toContain(path.join(admin, LINK_MANIFEST_FILE));
  });
});

describe("a recorded link is trusted only while it stands as recorded", () => {
  it("does not trust a link retargeted after create, and says so", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-retarget", ["lib"]);
    // A different directory that would satisfy the test command, so the
    // failing baseline can only come from the link not being trusted.
    const other = path.join(f.base, "other-lib");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "x.js"), "module.exports = 2;\n");
    fs.rmSync(path.join(wt, "lib"));
    fs.symlinkSync(other, path.join(wt, "lib"));
    const plan = writePlan(path.join(f.runDir, "plan.json"));

    const { envelope } = await probeIn(f, wt, ["--plan", plan]);

    expect(envelope.status).toBe("inconclusive");
    expect(envelope.reason).toBe("baseline_failed");
    const linkWarnings = envelope.warnings.filter(isLinkWarning);
    expect(linkWarnings).toHaveLength(1);
    expect(linkWarnings[0]).toContain(
      "not trusting recorded worktree link lib",
    );
    expect(linkWarnings[0]).toContain(JSON.stringify(other));
  });

  it("does not trust a link whose text changed even when it still reaches the same directory", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-alias", ["lib"]);
    // Same directory, other spelling: the identity check alone would let
    // this through, the recorded text is what the operator's link said.
    const alias = path.join(f.base, "lib-alias");
    fs.symlinkSync(path.join(f.repo, "lib"), alias);
    fs.rmSync(path.join(wt, "lib"));
    fs.symlinkSync(alias, path.join(wt, "lib"));
    const entry = recordedEntry(wt, "lib");
    expect(captureLinkIdentity(path.join(wt, "lib"))).toMatchObject({
      resolved: entry.resolved,
      dev: entry.dev,
      ino: entry.ino,
    });

    expect(recordedLinkStillHolds(wt, entry)).toMatchObject({
      holds: false,
      reason: expect.stringContaining("now points at"),
    });
  });

  it("still honours an explicit --link next to a retargeted record", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-retarget-flag", ["lib"]);
    const other = path.join(f.base, "other-lib");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "x.js"), "module.exports = 2;\n");
    fs.rmSync(path.join(wt, "lib"));
    fs.symlinkSync(other, path.join(wt, "lib"));
    const plan = writePlan(path.join(f.runDir, "plan.json"));

    const { envelope } = await probeIn(f, wt, [
      "--plan",
      plan,
      "--link",
      "lib",
    ]);

    expect(envelope.status).toBe("killed");
  });

  it("rejects each way a link can stop being what create made", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-states", ["lib"]);
    const entry = recordedEntry(wt, "lib");
    expect(recordedLinkStillHolds(wt, entry)).toEqual({ holds: true });

    // Replaced by a real directory (what a checkout overwriting an
    // ignored path does).
    fs.rmSync(path.join(wt, "lib"));
    fs.mkdirSync(path.join(wt, "lib"));
    expect(recordedLinkStillHolds(wt, entry)).toMatchObject({
      holds: false,
      reason: "it is no longer a symbolic link",
    });

    // Gone.
    fs.rmSync(path.join(wt, "lib"), { recursive: true });
    expect(recordedLinkStillHolds(wt, entry)).toMatchObject({
      holds: false,
      reason: "it no longer exists",
    });

    // Right text, target gone.
    fs.symlinkSync(entry.target, path.join(wt, "lib"));
    fs.renameSync(entry.target, `${entry.target}.moved`);
    expect(recordedLinkStillHolds(wt, entry)).toMatchObject({
      holds: false,
      reason: "the recorded target no longer exists",
    });
    fs.renameSync(`${entry.target}.moved`, entry.target);

    // Target replaced by a file: not an error, not a --link source.
    const fileTarget = path.join(f.base, "a-file");
    fs.writeFileSync(fileTarget, "x");
    fs.rmSync(path.join(wt, "lib"));
    fs.symlinkSync(fileTarget, path.join(wt, "lib"));
    expect(
      recordedLinkStillHolds(wt, { ...entry, target: fileTarget }),
    ).toMatchObject({ holds: false, quiet: true });
  });

  it("does not trust a nested link whose parent became a symlink", async () => {
    const f = makeFixture();
    fs.mkdirSync(path.join(f.repo, "deep", "dir"), { recursive: true });
    fs.writeFileSync(path.join(f.repo, "deep", "dir", "n.txt"), "n\n");
    const wt = await createWorktree(f, "wt-nested", ["deep/dir"]);
    const entry = recordedEntry(wt, "deep/dir");
    expect(recordedLinkStillHolds(wt, entry)).toEqual({ holds: true });

    const elsewhere = path.join(f.base, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.rmSync(path.join(wt, "deep"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(wt, "deep"));

    expect(recordedLinkStillHolds(wt, entry)).toMatchObject({
      holds: false,
      reason: expect.stringContaining("is not a plain directory any more"),
    });
  });
});

describe("a recorded link is trusted only while it leads where the operator saw it lead", () => {
  /** A directory that would satisfy the test command, so a failing
   * baseline can only mean the link was not trusted. */
  function lookalike(f: Fixture, name: string): string {
    const dir = path.join(f.base, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "x.js"), "module.exports = 3;\n");
    return dir;
  }

  it("does not trust a link whose target path was swapped for a symlink in the main checkout", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-swap-link", ["lib"]);
    const attacker = lookalike(f, "attacker-lib");
    // What a checkout does to an ignored directory when the branch tracks
    // the same path as a symbolic link: the main checkout's `lib` is now a
    // link to somewhere else. The readlink text in the worktree is
    // unchanged, so only the resolved identity can tell.
    fs.rmSync(path.join(f.repo, "lib"), { recursive: true });
    fs.symlinkSync(attacker, path.join(f.repo, "lib"));
    expect(fs.readlinkSync(path.join(wt, "lib"))).toBe(
      path.join(f.repo, "lib"),
    );
    const plan = writePlan(path.join(f.runDir, "plan.json"));

    const { envelope } = await probeIn(f, wt, ["--plan", plan]);

    expect(envelope.status).toBe("inconclusive");
    expect(envelope.reason).toBe("baseline_failed");
    const linkWarnings = envelope.warnings.filter(isLinkWarning);
    expect(linkWarnings).toHaveLength(1);
    expect(linkWarnings[0]).toContain(
      "not trusting recorded worktree link lib",
    );
    expect(linkWarnings[0]).toContain("now resolves to");
    expect(linkWarnings[0]).toContain(JSON.stringify(attacker));
    expect(trustedManifestLinks(wt).values).toEqual([]);
  });

  it("does not trust a link whose target path was swapped for another directory at the same path", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-swap-dir", ["lib"]);
    // Same path, same readlink text, same realpath; a different
    // directory (the new one is made before the old one is moved away, so
    // the inode cannot be reused).
    const replacement = path.join(f.repo, "lib.new");
    fs.mkdirSync(replacement);
    fs.writeFileSync(path.join(replacement, "x.js"), "module.exports = 4;\n");
    fs.renameSync(path.join(f.repo, "lib"), path.join(f.repo, "lib.old"));
    fs.renameSync(replacement, path.join(f.repo, "lib"));
    const plan = writePlan(path.join(f.runDir, "plan.json"));

    const { envelope } = await probeIn(f, wt, ["--plan", plan]);

    expect(envelope.status).toBe("inconclusive");
    expect(envelope.reason).toBe("baseline_failed");
    const linkWarnings = envelope.warnings.filter(isLinkWarning);
    expect(linkWarnings).toHaveLength(1);
    expect(linkWarnings[0]).toContain("now resolves to");
    expect(recordedLinkStillHolds(wt, recordedEntry(wt, "lib"))).toMatchObject({
      holds: false,
    });
  });

  it("an explicit --link still works next to a swapped target", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-swap-flag", ["lib"]);
    const attacker = lookalike(f, "attacker-lib");
    fs.rmSync(path.join(f.repo, "lib"), { recursive: true });
    fs.symlinkSync(attacker, path.join(f.repo, "lib"));
    const plan = writePlan(path.join(f.runDir, "plan.json"));

    const { envelope } = await probeIn(f, wt, [
      "--plan",
      plan,
      "--link",
      "lib",
    ]);

    expect(envelope.status).toBe("killed");
  });

  it.each([
    ["resolved path", { resolved: "/somewhere/else" }],
    ["device", { dev: "999999999" }],
    ["inode", { ino: "999999999" }],
  ])(
    "each part of the recorded identity counts on its own: a different %s is not trusted",
    async (_name, change) => {
      const f = makeFixture();
      const wt = await createWorktree(f, "wt-parts", ["lib"]);
      const entry = recordedEntry(wt, "lib");

      expect(recordedLinkStillHolds(wt, { ...entry, ...change })).toMatchObject(
        {
          holds: false,
          reason: expect.stringContaining("now resolves to"),
        },
      );
    },
  );

  it("control: an untouched link still resolves to the recorded identity", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-same", ["lib"]);
    expect(recordedLinkStillHolds(wt, recordedEntry(wt, "lib"))).toEqual({
      holds: true,
    });
  });

  it("rejects a version 1 manifest (no identity) as a whole, with a warning", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-v1", ["lib"]);
    const file = path.join(adminDirOf(wt), LINK_MANIFEST_FILE);
    const entry = recordedEntry(wt, "lib");
    fs.rmSync(file);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        toolVersion: "0.10.0",
        links: [
          {
            path: entry.path,
            target: entry.target,
            createdAt: entry.createdAt,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const plan = writePlan(path.join(f.runDir, "plan.json"));

    const { envelope } = await probeIn(f, wt, ["--plan", plan]);

    expect(envelope.status).toBe("inconclusive");
    expect(envelope.reason).toBe("baseline_failed");
    const linkWarnings = envelope.warnings.filter(isLinkWarning);
    expect(linkWarnings).toHaveLength(1);
    expect(linkWarnings[0]).toContain("unsupported version");
    expect(linkWarnings[0]).not.toContain("version 1");
    expect(trustedManifestLinks(wt).values).toEqual([]);
  });
});

describe("worktree create: a link whose target does not resolve", () => {
  interface Created {
    links: {
      made: { path: string }[];
      manifest: {
        status: string;
        path?: string;
        reason?: string;
        unrecorded?: { path: string; reason: string }[];
      };
    };
    warnings: string[];
  }

  /** `rel` in the main checkout becomes a symlink to a path that is not
   * there; `worktree create` still links it (the source exists as an
   * entry), but nothing it reaches can be recorded. */
  function dangle(f: Fixture, rel: string): void {
    fs.symlinkSync(path.join(f.base, "nowhere"), path.join(f.repo, rel));
  }

  async function createWith(
    f: Fixture,
    name: string,
    links: string[],
  ): Promise<{ wt: string; out: Created }> {
    const wt = path.join(f.base, name);
    const r = await spawnCli(
      [
        "-C",
        f.base,
        "worktree",
        "create",
        "--repo",
        f.repo,
        "--branch",
        name,
        "--base",
        "main",
        "--path",
        wt,
        ...links.flatMap((l) => ["--link", l]),
      ],
      { env: GIT_ENV },
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    return { wt, out: JSON.parse(r.stdout) as Created };
  }

  it("records nothing when the only link dangles, and does not promise --link", async () => {
    const f = makeFixture();
    fs.rmSync(path.join(f.repo, "lib"), { recursive: true });
    dangle(f, "lib");

    const { wt, out } = await createWith(f, "wt-dangle-only", ["lib"]);

    expect(out.links.made.map((l) => l.path)).toEqual(["lib"]);
    expect(out.links.manifest.status).toBe("failed");
    expect(out.links.manifest.reason).toBe("no link resolves to its target");
    expect(fs.existsSync(path.join(adminDirOf(wt), LINK_MANIFEST_FILE))).toBe(
      false,
    );
    // The warning says what to do about the missing target, in that order.
    const warning = out.warnings.find((w) => w.includes("could not record"));
    expect(warning).toContain("create the targets in the main checkout");
    expect(warning).not.toContain("to link them");
    expect(trustedManifestLinks(wt).values).toEqual([]);
  });

  it("records the links that resolve and lists the dangling one as unrecorded", async () => {
    const f = makeFixture();
    dangle(f, "lib2");
    fs.appendFileSync(path.join(f.repo, ".gitignore"), "lib2\n");

    const { wt, out } = await createWith(f, "wt-dangle-one", ["lib", "lib2"]);

    expect(out.links.manifest.status).toBe("written");
    const unrecorded = out.links.manifest.unrecorded ?? [];
    expect(unrecorded.map((u) => u.path)).toEqual(["lib2"]);
    expect(unrecorded[0]!.reason).toContain("its target does not resolve");
    expect(unrecorded[0]!.reason).toContain("create the target");
    const warning = out.warnings.find((w) => w.includes("not recorded"));
    expect(warning).toContain("lib2");
    expect(warning).toContain("create the target");
    expect(trustedManifestLinks(wt).values).toEqual(["lib"]);
    const read = readLinkManifest(wt);
    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      expect(read.manifest.links.map((l) => l.path)).toEqual(["lib"]);
    }
  });
});

describe("the writer only writes what the reader accepts", () => {
  it("writeLinkManifest leaves out an entry the reader would reject and reports it, keeping the others", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-writer", []);
    const good = claimedEntry("lib", path.join(f.repo, "lib"));
    const bad = { ...good, path: "we\\ird" };

    const written = writeLinkManifest(wt, [good, bad], "0.0.0");

    expect(written.status).toBe("written");
    if (written.status !== "written") return;
    expect(written.unrecorded.map((u) => u.path)).toEqual(["we\\ird"]);
    const read = readLinkManifest(wt);
    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      expect(read.manifest.links.map((l) => l.path)).toEqual(["lib"]);
    }
  });

  it("writeLinkManifest fails, writing nothing, when no entry is recordable", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-writer-none", []);
    const bad = {
      ...claimedEntry("lib", path.join(f.repo, "lib")),
      path: "a\\b",
    };

    const written = writeLinkManifest(wt, [bad], "0.0.0");

    expect(written.status).toBe("failed");
    expect(fs.existsSync(path.join(adminDirOf(wt), LINK_MANIFEST_FILE))).toBe(
      false,
    );
  });

  it("writeLinkManifest fails, writing nothing, when an entry passes the path filter but the reader would reject it", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-writer-reject", []);
    const good = claimedEntry("lib", path.join(f.repo, "lib"));
    const file = path.join(adminDirOf(wt), LINK_MANIFEST_FILE);

    for (const bad of [
      { ...good, target: "relative/target" },
      { ...good, dev: "x" },
    ]) {
      const written = writeLinkManifest(wt, [bad], "0.0.0");

      expect(written.status).toBe("failed");
      if (written.status === "failed") {
        expect(written.reason).toContain("would be rejected by the reader");
      }
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  it.skipIf(process.platform === "win32")(
    "round trip: every entry normalizeLinkEntry accepts is either read back or reported unrecorded by create",
    async () => {
      const f = makeFixture();
      const proposed = [
        "lib",
        "deep/dir",
        "with space",
        "we\\ird",
        "semi;colon",
        "dollar$x",
        "dollar$(x)",
        "uni\u00e9",
        "./dot/./lead",
        "trail/",
      ];
      // Only what the creator accepts is in scope for the round trip.
      const candidates = proposed.filter(
        (c) => normalizeLinkEntry(c).rel !== undefined,
      );
      expect(candidates).toContain("we\\ird");
      expect(candidates.length).toBeGreaterThan(3);
      for (const c of candidates) {
        const rel = normalizeLinkEntry(c).rel!;
        fs.mkdirSync(path.join(f.repo, rel), { recursive: true });
        fs.writeFileSync(path.join(f.repo, rel, "k.txt"), "k\n");
      }
      const target = path.join(f.base, "wt-roundtrip");
      const created = await spawnCli(
        [
          "-C",
          f.base,
          "worktree",
          "create",
          "--repo",
          f.repo,
          "--branch",
          "wt-roundtrip",
          "--base",
          "main",
          "--path",
          target,
          ...candidates.flatMap((c) => ["--link", c]),
        ],
        { env: GIT_ENV },
      );
      expect(created.code, created.stdout + created.stderr).toBe(0);
      const report = JSON.parse(created.stdout) as {
        links: {
          made: { path: string }[];
          manifest: {
            status: string;
            unrecorded?: { path: string; reason: string }[];
          };
        };
      };

      expect(report.links.made.length).toBeGreaterThan(0);
      expect(report.links.manifest.status).toBe("written");
      const read = readLinkManifest(target);
      expect(read.status).toBe("ok");
      if (read.status !== "ok") return;
      const recorded = new Set(read.manifest.links.map((l) => l.path));
      const unrecorded = new Set(
        (report.links.manifest.unrecorded ?? []).map((u) => u.path),
      );
      for (const made of report.links.made) {
        expect(
          recorded.has(made.path) !== unrecorded.has(made.path),
          `${made.path}: recorded=${String(recorded.has(made.path))} unrecorded=${String(unrecorded.has(made.path))}`,
        ).toBe(true);
      }
      // The backslash name is the one the reader refuses; the rest keep
      // working, and everything recorded still holds.
      expect([...unrecorded]).toEqual(["we\\ird"]);
      expect(trustedManifestLinks(target).warnings).toEqual([]);
      expect(trustedManifestLinks(target).values.sort()).toEqual(
        [...recorded].sort(),
      );
    },
  );
});

describe("the manifest file is read with the same care as a plan", () => {
  async function rejectedWith(
    mutate: (file: string, admin: string, wt: string) => void,
  ): Promise<string> {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-hard", ["lib"]);
    const admin = adminDirOf(wt);
    mutate(path.join(admin, LINK_MANIFEST_FILE), admin, wt);
    const read = readLinkManifest(wt);
    expect(read.status).toBe("rejected");
    const trusted = trustedManifestLinks(wt);
    expect(trusted.values).toEqual([]);
    expect(trusted.warnings).toHaveLength(1);
    return read.status === "rejected" ? read.reason : "";
  }

  it("rejects a symbolic link", async () => {
    const reason = await rejectedWith((file, _admin, wt) => {
      const real = path.join(wt, "..", "real-manifest.json");
      fs.renameSync(file, real);
      fs.symlinkSync(real, file);
    });
    expect(reason).toBe("it is a symbolic link");
  });

  it("rejects a file with another hard link", async () => {
    const reason = await rejectedWith((file, _admin, wt) => {
      fs.linkSync(file, path.join(wt, "..", "second-name.json"));
    });
    expect(reason).toBe("it has more than one hard link");
  });

  it("rejects a directory in its place", async () => {
    const reason = await rejectedWith((file) => {
      fs.rmSync(file);
      fs.mkdirSync(file);
    });
    expect(reason).toBe("it is not a regular file");
  });

  it.skipIf(
    process.platform === "win32" || typeof process.getuid !== "function",
  )(
    "rejects a file owned by another user, and trusts no link from it",
    async () => {
      const f = makeFixture();
      const wt = await createWorktree(f, "wt-owner", ["lib"]);
      expect(readLinkManifest(wt).status).toBe("ok");
      const uid = process.getuid!();
      const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
      try {
        const read = readLinkManifest(wt);
        expect(read).toMatchObject({
          status: "rejected",
          reason: "it is not owned by the current user",
        });
        expect(trustedManifestLinks(wt).values).toEqual([]);
        expect(trustedManifestLinks(wt).warnings).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
      expect(readLinkManifest(wt).status).toBe("ok");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO in its place without hanging on the open",
    async () => {
      try {
        execFileSync("mkfifo", ["--help"], { stdio: "ignore" });
      } catch (err) {
        // `mkfifo --help` exits non-zero on BSD; only a missing binary
        // (ENOENT) means the test cannot run.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      }
      const f = makeFixture();
      const wt = await createWorktree(f, "wt-fifo", ["lib"]);
      const file = path.join(adminDirOf(wt), LINK_MANIFEST_FILE);
      fs.rmSync(file);
      execFileSync("mkfifo", [file]);

      // A blocking open of a FIFO never returns, and a synchronous open
      // cannot be interrupted by the test runner's own timeout, so the
      // read runs in a child process with a hard limit.
      const moduleUrl = pathToFileURL(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "..",
          "dist",
          "probe",
          "link-manifest.js",
        ),
      ).href;
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { readLinkManifest } from ${JSON.stringify(moduleUrl)};
           process.stdout.write(JSON.stringify(readLinkManifest(${JSON.stringify(wt)})));`,
        ],
        { encoding: "utf8", timeout: 20_000, env: GIT_ENV_WITH_PATH },
      );

      expect(child.error, "the read hung on the FIFO").toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toMatchObject({
        status: "rejected",
        reason: "it is not a regular file",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a file writable by group or others",
    async () => {
      const reason = await rejectedWith((file) => {
        fs.chmodSync(file, 0o664);
      });
      expect(reason).toBe("it is writable by group or others");
    },
  );

  it("rejects a file past the size cap, without loading it", async () => {
    const reason = await rejectedWith((file) => {
      fs.writeFileSync(file, " ".repeat(LINK_MANIFEST_MAX_BYTES + 1), {
        mode: 0o600,
      });
    });
    expect(reason).toContain("byte cap");
  });

  it("rejects invalid JSON", async () => {
    const reason = await rejectedWith((file) => {
      fs.writeFileSync(file, "[", { mode: 0o600 });
    });
    expect(reason).toBe("it is not valid JSON");
  });

  it("rejects the whole manifest when one entry is malformed, instead of trusting the others", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-partial", ["lib"]);
    const file = path.join(adminDirOf(wt), LINK_MANIFEST_FILE);
    const good = JSON.parse(fs.readFileSync(file, "utf8")) as {
      links: unknown[];
    };
    good.links.push({
      ...claimedEntry("lib", path.join(f.repo, "lib")),
      path: "../escape",
    });
    fs.writeFileSync(file, JSON.stringify(good), { mode: 0o600 });

    expect(readLinkManifest(wt).status).toBe("rejected");
    expect(trustedManifestLinks(wt).values).toEqual([]);
  });
});

describe("parseManifest: the shape is exact and fails closed", () => {
  const entry = {
    path: "lib",
    target: "/abs/lib",
    createdAt: "2026-01-01T00:00:00.000Z",
    resolved: "/abs/real-lib",
    dev: "16777230",
    ino: "123456",
  };
  const ok = { version: 2, toolVersion: "1.2.3", links: [entry] };

  it("accepts what create writes", () => {
    expect(parseManifest(ok)).toEqual({ ok: true, manifest: ok });
  });

  it.each([
    ["an array", []],
    ["null", null],
    ["a wrong version", { ...ok, version: 3 }],
    ["a version 1 manifest (no identity)", { ...ok, version: 1 }],
    [
      "an entry without a resolved identity",
      {
        ...ok,
        links: [
          { path: "lib", target: "/abs/lib", createdAt: entry.createdAt },
        ],
      },
    ],
    [
      "a relative resolved path",
      { ...ok, links: [{ ...entry, resolved: "lib" }] },
    ],
    ["a numeric inode", { ...ok, links: [{ ...entry, ino: 5 }] }],
    ["a non-decimal device", { ...ok, links: [{ ...entry, dev: "0x10" }] }],
    ["an empty inode", { ...ok, links: [{ ...entry, ino: "" }] }],
    ["a missing version", { toolVersion: "x", links: [] }],
    ["an extra top-level key", { ...ok, extra: 1 }],
    ["a non-string toolVersion", { ...ok, toolVersion: 1 }],
    ["links that are not an array", { ...ok, links: {} }],
    ["an entry that is not an object", { ...ok, links: ["lib"] }],
    ["an extra entry key", { ...ok, links: [{ ...entry, mode: 1 }] }],
    ["an absolute path", { ...ok, links: [{ ...entry, path: "/lib" }] }],
    ["a climbing path", { ...ok, links: [{ ...entry, path: "../lib" }] }],
    ["a path into .git", { ...ok, links: [{ ...entry, path: ".git/x" }] }],
    ["a path into .GIT", { ...ok, links: [{ ...entry, path: ".GIT/x" }] }],
    ["an unnormalized path", { ...ok, links: [{ ...entry, path: "a/./b" }] }],
    ["a trailing slash", { ...ok, links: [{ ...entry, path: "lib/" }] }],
    ["a backslash", { ...ok, links: [{ ...entry, path: "a\\b" }] }],
    ["a command substitution", { ...ok, links: [{ ...entry, path: "$(x)" }] }],
    ["an empty path", { ...ok, links: [{ ...entry, path: "" }] }],
    ["a relative target", { ...ok, links: [{ ...entry, target: "lib" }] }],
    ["a bad timestamp", { ...ok, links: [{ ...entry, createdAt: "never" }] }],
    ["a duplicate path", { ...ok, links: [entry, { ...entry }] }],
  ])("rejects %s", (_name, value) => {
    expect(parseManifest(value).ok).toBe(false);
  });
});

describe("where the manifest is looked for", () => {
  it("only a linked worktree's administration directory counts", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-loc", ["lib"]);

    const main = linkedWorktreeAdminDir(f.repo);
    const linked = linkedWorktreeAdminDir(wt);

    expect(main.ok).toBe(false);
    expect(linked.ok).toBe(true);
    if (linked.ok) {
      expect(path.basename(path.dirname(linked.dir))).toBe("worktrees");
    }
  });

  it("a submodule-shaped git directory is not an administration directory", () => {
    const f = makeFixture();
    // A repository whose `.git` file points into `<outer>/.git/modules/m`,
    // the layout git gives a submodule: the git dir differs from the common
    // dir's parent chain only in name, and must not be accepted.
    const sub = path.join(f.base, "sub");
    git(f.base, ["init", "-q", "-b", "main", sub]);
    const moved = path.join(f.base, "outer-git", "modules", "m");
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(path.join(sub, ".git"), moved);
    fs.writeFileSync(path.join(sub, ".git"), `gitdir: ${moved}\n`);
    fs.writeFileSync(
      path.join(moved, LINK_MANIFEST_FILE),
      JSON.stringify({ version: 2, toolVersion: "x", links: [] }),
      { mode: 0o600 },
    );

    expect(linkedWorktreeAdminDir(sub).ok).toBe(false);
    expect(readLinkManifest(sub)).toEqual({ status: "absent" });
  });

  it.each([["elsewhere/wt-shape"], ["sub/worktrees/wt-shape"]])(
    "does not accept an administration directory outside <common git dir>/worktrees/<id> (%s)",
    async (relocated) => {
      const f = makeFixture();
      const wt = await createWorktree(f, "wt-shape", ["lib"]);
      const admin = adminDirOf(wt);
      const common = fs.realpathSync(path.join(f.repo, ".git"));
      // Move the whole administration directory, manifest included, and
      // point the worktree at the new place: git works from it, but it is
      // not the place `git worktree add` makes.
      const moved = path.join(common, relocated);
      fs.mkdirSync(path.dirname(moved), { recursive: true });
      fs.renameSync(admin, moved);
      fs.writeFileSync(path.join(moved, "commondir"), `${common}\n`);
      fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${moved}\n`);
      expect(git(wt, ["rev-parse", "--absolute-git-dir"]).trim()).toBe(moved);
      expect(fs.existsSync(path.join(moved, LINK_MANIFEST_FILE))).toBe(true);

      expect(linkedWorktreeAdminDir(wt).ok).toBe(false);
      expect(readLinkManifest(wt)).toEqual({ status: "absent" });
    },
  );

  it("ignores GIT_DIR in the environment when asking where the git directory is", async () => {
    const f = makeFixture();
    const wt = await createWorktree(f, "wt-env", ["lib"]);
    const before = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(f.repo, ".git");
    try {
      const admin = linkedWorktreeAdminDir(wt);
      expect(admin.ok).toBe(true);
      expect(readLinkManifest(wt).status).toBe("ok");
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
    }
  });
});

describe("manifestLinkGroup", () => {
  it("merges as operator input: no provenance phrase, so no repository-content rules", () => {
    const merged = mergeLinkSources([manifestLinkGroup("/r", ["lib"])]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.namedBy).toBeUndefined();
    expect(merged[0]!.value).toBe(path.resolve("/r", "lib"));
  });
});

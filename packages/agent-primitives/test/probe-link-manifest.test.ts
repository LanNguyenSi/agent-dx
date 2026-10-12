import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINK_MANIFEST_FILE,
  LINK_MANIFEST_MAX_BYTES,
  linkedWorktreeAdminDir,
  manifestLinkGroup,
  parseManifest,
  readLinkManifest,
  recordedLinkStillHolds,
  trustedManifestLinks,
  writeLinkManifest,
} from "../src/probe/link-manifest.js";
import { mergeLinkSources } from "../src/probe/link-list.js";
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
      links: { path: string; target: string; createdAt: string }[];
    };
    expect(recorded.version).toBe(1);
    expect(typeof recorded.toolVersion).toBe("string");
    expect(recorded.links).toHaveLength(1);
    expect(recorded.links[0]).toMatchObject({
      path: "lib",
      target: path.join(f.repo, "lib"),
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
        version: 1,
        toolVersion: "x",
        links: [
          {
            path: "lib2",
            target: outside,
            createdAt: new Date().toISOString(),
          },
        ],
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
      version: 1,
      toolVersion: "x",
      links: [
        {
          path: "lib",
          target: path.join(f.repo, "lib"),
          createdAt: new Date().toISOString(),
        },
      ],
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
        version: 1,
        toolVersion: "x",
        links: [
          {
            path: "lib",
            target: path.join(f.repo, "lib"),
            createdAt: new Date().toISOString(),
          },
        ],
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
    const entry = {
      path: "lib",
      target: path.join(f.repo, "lib"),
      createdAt: "2026-01-01T00:00:00.000Z",
    };
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
    const entry = {
      path: "deep/dir",
      target: path.join(f.repo, "deep", "dir"),
      createdAt: "2026-01-01T00:00:00.000Z",
    };
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
    good.links.push({ path: "../escape", target: "/x", createdAt: "2026" });
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
  };
  const ok = { version: 1, toolVersion: "1.2.3", links: [entry] };

  it("accepts what create writes", () => {
    expect(parseManifest(ok)).toEqual({ ok: true, manifest: ok });
  });

  it.each([
    ["an array", []],
    ["null", null],
    ["a wrong version", { ...ok, version: 2 }],
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
      JSON.stringify({ version: 1, toolVersion: "x", links: [] }),
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

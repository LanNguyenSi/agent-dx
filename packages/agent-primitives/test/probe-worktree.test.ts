import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach, vi } from "vitest";
import { probe, type ProbeOptions } from "../src/probe/index.js";
import {
  markerFilePathFor,
  readMarkerFor,
  removeMarkerFor,
  writeMarker,
} from "../src/lock.js";
import { resolveDeepestExisting } from "../src/probe/containment.js";
import {
  beginWorktree,
  isScratchWorktreePath,
  parseWorktreeListZ,
  readScratchOwner,
  SCRATCH_OWNER_FILE,
} from "../src/probe/isolation.js";
import { runArgv } from "../src/probe/run.js";
import { caseInsensitiveVolume } from "./helpers/case-fs.js";
import { withPathPrepended, writeGitShim } from "./helpers/git-shim.js";

// Call-through mock, the same shape as the one below for
// "../src/probe/run.js": lets a test pin the run id `beginWorktree`
// derives its scratch subdirectory name from, to reproduce a genuine
// run-id collision (the refusal to reuse a pre-existing tracked-diff
// scratch file) without waiting on an actual `randomUUID` clash.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

// Call-through mock: every call runs the real implementation unless a
// test explicitly overrides it for one call (mirrors probe.test.ts's own
// seam). Used to corrupt the tracked-diff sync's own output for the
// worktree_sync_failed test, without touching a shell pipeline that
// would hide the exit code this package must observe. Isolation.ts runs
// every git call through this argv runner (never `execCommand`'s
// shell), so this is the one seam that reaches all of them.
vi.mock("../src/probe/run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/probe/run.js")>();
  return { ...actual, runArgv: vi.fn(actual.runArgv) };
});

// Call-through mock, same shape as the two above: lets one test force
// `beginWorktree` to fail before it ever calls `onWorktreeAttempt` (the
// real function only does that once its own `writeScratchOwner` write
// has succeeded), so that test can observe `session.ts`'s stale-marker
// removal (`if (staleWt) removeMarkerFor(realRoot)`) in isolation from
// the run's own new in-flight marker, which `onWorktreeAttempt` would
// otherwise always write right back over it.
vi.mock("../src/probe/isolation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/probe/isolation.js")>();
  return { ...actual, beginWorktree: vi.fn(actual.beginWorktree) };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "dist", "cli.js");

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-probe-worktree-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

let savedLockDir: string | undefined;
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (savedLockDir === undefined) delete process.env.AGENT_PRIMITIVES_LOCK_DIR;
  else process.env.AGENT_PRIMITIVES_LOCK_DIR = savedLockDir;
  savedLockDir = undefined;
});

/** Every test gets its own lock dir, so a leftover lock/marker from one
 * test can never be observed by another. */
function useLockDir(): string {
  savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
  const dir = makeTmpDir();
  process.env.AGENT_PRIMITIVES_LOCK_DIR = dir;
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

/** Every entry under `root` (`.git` excluded), keyed by its path relative
 * to `root`, mapped to whether it is a symlink and, either way, a hash
 * of its own content (a symlink's own target string, a regular file's
 * bytes, never a followed read): proof a tree is byte-identical AND
 * shape-identical (no path silently turned into a symlink) before and
 * after a run, for the composer nested-bin-dir regression test, which
 * must catch the SOURCE tree's own `vendor/bin` being deleted and
 * replaced with a symlink through the parent `vendor` symlink the old
 * `beginWorktree` loop created. */
function hashTree(
  root: string,
): Map<string, { symlink: boolean; hash: string }> {
  const out = new Map<string, { symlink: boolean; hash: string }>();
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (entry.isSymbolicLink()) {
        out.set(rel, {
          symlink: true,
          hash: createHash("sha256").update(fs.readlinkSync(abs)).digest("hex"),
        });
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      out.set(rel, {
        symlink: false,
        hash: createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
      });
    }
  }
  walk(root);
  return out;
}

const FIXTURE_JS = [
  "function isPositive(n) {",
  "  return n > 0;",
  "}",
  "function unused(n) {",
  "  return n * 2;",
  "}",
  "module.exports = { isPositive };",
  "",
].join("\n");

const FIXTURE_TEST_JS = [
  "const assert = require('node:assert');",
  "const { isPositive } = require('./fixture.js');",
  "assert.strictEqual(isPositive(5), true);",
  "assert.strictEqual(isPositive(-5), false);",
  "",
].join("\n");

/** A fresh git repo (mkdtemp + git init, never the checkout itself) with
 * a committed fixture.js and fixture.test.js. */
function initRepo(): { repo: string } {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "diff.noprefix", "false"]);
  git(repo, ["config", "diff.mnemonicPrefix", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "fixture.js"), FIXTURE_JS);
  fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return { repo };
}

/** A gitignored file that exists ONLY in the source tree: the copy
 * never syncs it (gitignored) and never links `src` (the link policy
 * refuses that), so a test command that finds it under `src/` inside
 * the copy is looking at the operator's real tree. Named by
 * `SRC_TEST_COMMAND`'s own baseline assertion, which is what turns a
 * broken refusal into a failing baseline rather than a silently
 * different envelope. */
const SOURCE_ONLY_SENTINEL = ".only-in-source";

/**
 * The baseline's own witness, run from INSIDE the isolation copy: it
 * asserts where it is standing (not in the source tree) and that the
 * `src/` it can see is the copy's own directory rather than a link back
 * to the source tree, before it asserts anything about the fixture. A
 * link the policy should have refused therefore shows up as a failing
 * BASELINE naming what went wrong, at a point where no mutant has been
 * written yet -- not as a subtly different envelope, and not as a
 * damaged source tree.
 *
 * `sourceReal` is the source repository's realpath, embedded as a
 * literal: the copy lives under the run's `--log-dir`, somewhere else
 * entirely, so "my cwd is not under the source tree" is decidable from
 * inside the command.
 */
function srcCheckJs(sourceReal: string): string {
  return [
    "const assert = require('node:assert');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const SOURCE = ${JSON.stringify(sourceReal)};`,
    "const cwdReal = fs.realpathSync(process.cwd());",
    "assert.ok(",
    "  cwdReal !== SOURCE && !cwdReal.startsWith(SOURCE + path.sep),",
    "  'the command ran in the SOURCE tree, not in the isolation copy',",
    ");",
    "assert.ok(",
    "  fs.realpathSync('src').startsWith(cwdReal + path.sep),",
    "  'src/ in the isolation copy resolves outside the copy',",
    ");",
    "assert.strictEqual(",
    `  fs.existsSync('src/${SOURCE_ONLY_SENTINEL}'),`,
    "  false,",
    "  'src/ in the isolation copy is a link to the SOURCE tree',",
    ");",
    "const { isPositive } = require('./src/fixture.js');",
    "assert.strictEqual(isPositive(5), true);",
    "",
  ].join("\n");
}

const SRC_TEST_COMMAND = "node src-check.test.js";
const SRC_FIXTURE_JS = FIXTURE_JS;

/** A repo whose probe target sits in a TRACKED subdirectory (`src/`),
 * with a repo defaults file naming that same directory. Every link
 * source that could reach `src` is the shape the link policy exists to
 * refuse: linking it would replace the copy's own `src` with the source
 * tree's, and this run's mutant would then be written to the
 * operator's real file. */
function initSrcRepo(
  opts: {
    defaultsLinks?: string[] | null;
    /** Written as this repo's `composer.json` `config` object, for the
     * cases where the value under test comes from composer rather than
     * from the defaults file or `--link`. */
    composerConfig?: Record<string, string>;
  } = {},
): string {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "fixture.js"), SRC_FIXTURE_JS);
  fs.writeFileSync(
    path.join(repo, "src-check.test.js"),
    srcCheckJs(resolveDeepestExisting(repo)),
  );
  fs.writeFileSync(path.join(repo, ".gitignore"), `${SOURCE_ONLY_SENTINEL}\n`);
  if (opts.composerConfig !== undefined) {
    fs.writeFileSync(
      path.join(repo, "composer.json"),
      JSON.stringify({ name: "acme/widget", config: opts.composerConfig }),
    );
  }
  // A second TRACKED directory, unrelated to the target: the shape
  // that reaches the tracked-directory rule without also containing
  // the file this run mutates.
  fs.mkdirSync(path.join(repo, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "lib", "tracked.js"),
    "module.exports = 1;\n",
  );
  const defaultsLinks =
    opts.defaultsLinks === undefined ? ["src"] : opts.defaultsLinks;
  if (defaultsLinks !== null) {
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: defaultsLinks }),
    );
  }
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  // After the commit, so it stays gitignored and untracked: the copy
  // can only ever see it through a link to the source tree.
  fs.writeFileSync(
    path.join(repo, "src", SOURCE_ONLY_SENTINEL),
    "source tree only\n",
  );
  return repo;
}

/** The `--pre` every tracked-target fixture runs, committed as a file
 * rather than written as a `node -e` one-liner so shell quoting is not
 * part of what those tests are about. It creates `node_modules` when
 * the copy has none of its own, so the run COMPLETES whichever way the
 * policy decides: with the link refused the write lands in the copy,
 * and with the link created it lands wherever that link points, which
 * is the escape these fixtures exist to catch. */
const CLOBBER_JS = [
  "const fs = require('node:fs');",
  "fs.mkdirSync('node_modules', { recursive: true });",
  "fs.writeFileSync('node_modules/CLOBBER.txt', 'x');",
  "",
].join("\n");

const CLOBBER_PRE = "node clobber.js";

/** `initRepo()` plus the two things every tracked-target fixture needs:
 * a TRACKED `src/` (the source a link must never share with the copy)
 * and the committed `clobber.js` the `--pre` runs. Each test then
 * creates its own `node_modules` shape on top and commits or ignores
 * it. */
function initTrackedSrcRepo(): string {
  const { repo } = initRepo();
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src", "tracked.js"),
    "module.exports = 1;\n",
  );
  fs.writeFileSync(path.join(repo, "clobber.js"), CLOBBER_JS);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "src"]);
  return repo;
}

/** A standalone git repository with a committed `lib/file.txt`, meant to
 * be added as a submodule (`-c protocol.file.allow=always submodule add
 * <this> sub`) or copied in as a nested plain repository: the shape
 * `nestedRepoBoundaryRelPath` looks for is a directory carrying its OWN
 * `.git`, and a repo with real history is what both `git submodule add`
 * and a plain `git init` in place naturally produce. */
function initUpstreamLibRepo(): string {
  const upstream = makeTmpDir();
  git(upstream, ["init", "-q"]);
  git(upstream, ["config", "user.email", "test@example.com"]);
  git(upstream, ["config", "user.name", "test"]);
  git(upstream, ["config", "core.autocrlf", "false"]);
  fs.mkdirSync(path.join(upstream, "lib"), { recursive: true });
  fs.writeFileSync(path.join(upstream, "lib", "file.txt"), "vendored\n");
  git(upstream, ["add", "-A"]);
  git(upstream, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return upstream;
}

function commitAll(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
}

/** The one assertion every refusal in this group makes about the
 * envelope: the candidate was skipped, naming it and the tracked target
 * it points at. */
function refusedForTrackedTarget(
  warnings: readonly string[],
  candidateName: string,
  targetAbs: string,
): boolean {
  return warnings.some(
    (w) =>
      w.startsWith("skipped linking ") &&
      w.includes(candidateName) &&
      w.includes(
        `git tracks its target ${resolveDeepestExisting(targetAbs)}; source ` +
          "is copied into the isolation copy, never shared",
      ),
  );
}

function baseOptions(
  repo: string,
  overrides: Partial<ProbeOptions> = {},
): ProbeOptions {
  return {
    file: "fixture.js",
    line: 2,
    form: "replace",
    replaceText: "  return false;",
    testCommand: "node fixture.test.js",
    isolation: "worktree",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

function worktreeList(repo: string): string {
  return execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  });
}

describe("probe(): worktree isolation, killed and survived on a clean tree", () => {
  it("kills the mutant, reports isolation.mode worktree with syncedTrackedFiles 0, and leaves the original tree byte-identical", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.restored_verified).toBe(true);
    expect(result.isolation.mode).toBe("worktree");
    expect(result.isolation.syncedTrackedFiles).toBe(0);
    expect(result.isolation.syncedUntrackedFiles).toBe(0);
    expect(result.isolation.path).toBeTruthy();

    const after = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    expect(after).toBe(before);

    // Cleanup after success: no worktree left registered.
    expect(worktreeList(repo)).not.toContain(result.isolation.path as string);
    expect(fs.existsSync(result.isolation.path as string)).toBe(false);
  });

  it("reports survived when the mutant does not affect the test outcome", async () => {
    useLockDir();
    const { repo } = initRepo();

    const result = await probe(
      baseOptions(repo, { line: 5, replaceText: "  return n * 3;" }),
    );

    expect(result.status).toBe("survived");
    expect(result.isolation.mode).toBe("worktree");
  });
});

describe("probe(): worktree isolation syncs the working tree, not just HEAD", () => {
  it("syncs an uncommitted tracked modification: syncedTrackedFiles reflects it and the baseline sees the modified content", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.appendFileSync(path.join(repo, "fixture.js"), "\n// TRACKED_MARKER\n");
    const checkMarker =
      "node -e \"if (!require('fs').readFileSync('fixture.js','utf8').includes('TRACKED_MARKER')) process.exit(1)\"";

    const result = await probe(baseOptions(repo, { testCommand: checkMarker }));

    expect(result.isolation.syncedTrackedFiles).toBe(1);
    expect(result.baseline?.exitCode).toBe(0);
  });

  it("copies an untracked, non-ignored file to the worktree, and that file is what makes the mutant catchable", async () => {
    useLockDir();
    const { repo } = initRepo();
    // A strict check gated on an untracked, non-ignored marker file: the
    // weak assertion alone (isPositive(5) === true) still holds after
    // this mutation, so only the strict check (run when the marker
    // exists) actually discriminates the mutant.
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const assert = require('node:assert');",
        "const fs = require('node:fs');",
        "const { isPositive } = require('./fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "if (fs.existsSync('strict.marker')) {",
        "  assert.strictEqual(isPositive(-5), false);",
        "}",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "strict test",
    ]);
    // A mutation that keeps isPositive(5) === true (the weak check keeps
    // passing without the marker) but breaks isPositive(-5) === false
    // (the strict check, gated on the untracked marker).
    fs.writeFileSync(path.join(repo, "strict.marker"), "");

    const result = await probe(
      baseOptions(repo, {
        form: "match",
        replaceText: undefined,
        matchText: "n > 0",
        withText: "n >= -5",
      }),
    );

    expect(result.isolation.syncedUntrackedFiles).toBe(1);
    expect(result.status).toBe("killed");
  });

  it("negative control: with the copy step disabled (the untracked marker never reaches the worktree), the same mutant survives instead of being killed", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const assert = require('node:assert');",
        "const fs = require('node:fs');",
        "const { isPositive } = require('./fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "if (fs.existsSync('strict.marker')) {",
        "  assert.strictEqual(isPositive(-5), false);",
        "}",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "strict test",
    ]);
    fs.writeFileSync(path.join(repo, "strict.marker"), "");

    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    mockRun.mockImplementation(async (file, args, options) => {
      const result = await actualRun.runArgv(file, args, options);
      // Simulate a disabled copy step: strip whatever `git ls-files
      // --others` reported, so beginWorktree's own copy loop has nothing
      // to iterate over.
      if (args[0] === "ls-files" && args.includes("--others")) {
        return { ...result, stdout: "" };
      }
      return result;
    });

    try {
      const result = await probe(
        baseOptions(repo, {
          form: "match",
          replaceText: undefined,
          matchText: "n > 0",
          withText: "n >= -5",
        }),
      );

      expect(result.isolation.syncedUntrackedFiles).toBe(0);
      expect(result.status).toBe("survived");
    } finally {
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
      );
    }
  });
});

describe("probe(): worktree isolation, node_modules and --pre", () => {
  it("symlinks node_modules found in the source tree (depth <= 3) and lists them in isolation.linked", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.mkdirSync(path.join(repo, "node_modules"));
    fs.writeFileSync(
      path.join(repo, "node_modules", "marker.txt"),
      "present\n",
    );
    fs.mkdirSync(path.join(repo, "a", "b", "node_modules"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repo, "a", "b", "c", "node_modules"), {
      recursive: true,
    });

    const result = await probe(baseOptions(repo));

    expect(result.isolation.linked).toContain(path.join(repo, "node_modules"));
    expect(result.isolation.linked).toContain(
      path.join(repo, "a", "b", "node_modules"),
    );
    expect(result.isolation.linked).not.toContain(
      path.join(repo, "a", "b", "c", "node_modules"),
    );
  });

  it("composer: symlinks vendor-dir and a custom, non-default bin-dir (both gitignored/untracked) and lists them in isolation.linked; the baseline needing vendor/autoload.php passes with no --link", async () => {
    useLockDir();
    const { repo } = initRepo();
    // vendor/ and the custom bin-dir are exactly what a real composer
    // project gitignores: untracked, and never synced by the normal
    // untracked-file copy (`git ls-files --others --exclude-standard`
    // skips them) -- proving the fixture needs the auto-link, not a
    // sync this package already did for another reason.
    fs.writeFileSync(path.join(repo, ".gitignore"), "vendor/\nbin/\n");
    fs.writeFileSync(
      path.join(repo, "composer.json"),
      JSON.stringify({ name: "acme/widget", config: { "bin-dir": "bin" } }),
    );
    git(repo, ["add", "composer.json", ".gitignore"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "composer"]);
    fs.mkdirSync(path.join(repo, "vendor"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "vendor", "autoload.php"),
      "<?php // stand-in autoloader, php need not be installed\n",
    );
    fs.mkdirSync(path.join(repo, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "bin", "composer-bin-marker.txt"),
      "present\n",
    );

    // PHP is not assumed to be installed here: a `node` stand-in for a
    // `phpunit`/composer test script, checking only that the isolation
    // copy actually has `vendor/autoload.php` and the custom bin-dir on
    // disk, never PHP's own autoloading semantics.
    const testCommand =
      "node -e \"require('node:fs').accessSync('vendor/autoload.php'); " +
      "require('node:fs').accessSync('bin/composer-bin-marker.txt')\"";

    const result = await probe(baseOptions(repo, { testCommand }));

    expect(result.isolation.linked).toEqual(
      expect.arrayContaining([
        path.join(repo, "vendor"),
        path.join(repo, "bin"),
      ]),
    );
    // The test command never depends on fixture.js, so the mutant run
    // observes the exact same outcome as the baseline: a deterministic
    // "survived", not a mutation-probe result this fixture cares about,
    // but proof the baseline itself did not fail -- which it would if
    // vendor/bin were not on disk in the isolation copy.
    expect(result.status).toBe("survived");
  });

  it("composer: without a composer.json, the same gitignored vendor/ is never synced and the baseline fails -- the bug the auto-link fixes", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "vendor/\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "gitignore",
    ]);
    fs.mkdirSync(path.join(repo, "vendor"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "vendor", "autoload.php"),
      "<?php // stand-in autoloader\n",
    );

    const result = await probe(
      baseOptions(repo, {
        testCommand:
          "node -e \"require('node:fs').accessSync('vendor/autoload.php')\"",
      }),
    );

    expect(result.isolation.linked).not.toContain(path.join(repo, "vendor"));
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_failed");
  });

  it("composer: DEFAULT layout (no config, real vendor/ and vendor/bin/) links vendor only and never touches the SOURCE tree -- regression for the bug where linking the default bin-dir separately deleted the real vendor/bin through the vendor symlink and replaced it with a self-referential (ELOOP) symlink", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "vendor/\n");
    fs.writeFileSync(
      path.join(repo, "composer.json"),
      JSON.stringify({ name: "acme/widget" }),
    );
    git(repo, ["add", "composer.json", ".gitignore"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "composer"]);
    fs.mkdirSync(path.join(repo, "vendor", "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "vendor", "autoload.php"),
      "<?php // stand-in autoloader\n",
    );
    fs.writeFileSync(
      path.join(repo, "vendor", "bin", "phpunit"),
      "#!/bin/sh\necho phpunit\n",
    );

    const before = hashTree(repo);

    const result = await probe(baseOptions(repo));

    const after = hashTree(repo);
    expect(after).toEqual(before);
    for (const [, entry] of after) {
      expect(entry.symlink).toBe(false);
    }
    expect(
      fs.lstatSync(path.join(repo, "vendor", "bin")).isSymbolicLink(),
    ).toBe(false);
    expect(fs.existsSync(path.join(repo, "vendor", "bin", "phpunit"))).toBe(
      true,
    );
    expect(result.isolation.linked).toEqual([path.join(repo, "vendor")]);
    // The default bin-dir IS a candidate (composer declares it, and
    // discovery reports what composer declares); the link policy is
    // what keeps it out of the copy, and says so rather than dropping
    // it silently.
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "vendor", "bin")) &&
          w.includes("already covered by vendor"),
      ),
    ).toBe(true);
  });

  it("the nesting rule protects an explicit --link nested inside an auto-linked composer vendor-dir from being destroyed through the parent symlink, and warns naming it", async () => {
    // The same rule as the previous test, reached from the OTHER
    // source: here the nested candidate is an operator's own --link,
    // which no composer-side reasoning could ever have filtered, so
    // the two tests together pin the rule for a discovered candidate
    // and for a supplied one.
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "vendor/\n");
    fs.writeFileSync(
      path.join(repo, "composer.json"),
      JSON.stringify({ name: "acme/widget" }),
    );
    git(repo, ["add", "composer.json", ".gitignore"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "composer"]);
    fs.mkdirSync(path.join(repo, "vendor", "extra-tool"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repo, "vendor", "autoload.php"),
      "<?php // stand-in autoloader\n",
    );
    fs.writeFileSync(
      path.join(repo, "vendor", "extra-tool", "marker.txt"),
      "present\n",
    );

    const before = hashTree(repo);

    const result = await probe(
      baseOptions(repo, {
        links: [path.join(repo, "vendor", "extra-tool")],
      }),
    );

    const after = hashTree(repo);
    expect(after).toEqual(before);
    expect(
      fs.lstatSync(path.join(repo, "vendor", "extra-tool")).isSymbolicLink(),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(repo, "vendor", "extra-tool", "marker.txt")),
    ).toBe(true);
    expect(result.isolation.linked).toEqual([path.join(repo, "vendor")]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "vendor", "extra-tool")) &&
          w.includes("already covered by vendor"),
      ),
    ).toBe(true);
  });

  it("repo defaults file (.agent-primitives.json): every probe invocation reads it and links what it names, no --link needed -- exercised through a repo reached via a symlinked ancestor (os.tmpdir() itself, on macOS), pinning the fix for the realpath-vs-display-path mismatch that used to drop this silently", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "extra-cache/\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "gitignore",
    ]);
    fs.mkdirSync(path.join(repo, "extra-cache"), { recursive: true });
    fs.writeFileSync(path.join(repo, "extra-cache", "marker.txt"), "present\n");
    // The defaults file itself is untracked repo content, exactly like a
    // real `.agent-primitives.json` an operator keeps out of git or
    // commits alongside the project; either way `probe()` reads it by
    // path, not from git.
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: ["extra-cache"] }),
    );

    const result = await probe(baseOptions(repo));

    // `linked` carries the realpath'd form of an explicit link (the repo
    // defaults file's own `link` entries are resolved the same way
    // `--link` is, in `index.ts`'s `links[].abs`), which differs from
    // `repo` itself exactly when `repo` sits under a symlinked ancestor
    // -- the case this test exercises.
    expect(result.isolation.linked).toContain(
      resolveDeepestExisting(path.join(repo, "extra-cache")),
    );
  });

  it("repo defaults file: an unknown key is a usage error naming the path and the key, fail-closed", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: ["vendor"], typoKey: true }),
    );

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("defaults_file_invalid");
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, ".agent-primitives.json")) &&
          w.includes("typoKey"),
      ),
    ).toBe(true);
  });

  it("--pre rebuilds inside the worktree, and the mutant reaches a test that executes built output", async () => {
    useLockDir();
    const repo = makeTmpDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(
      path.join(repo, "src", "lib.js"),
      [
        "function isPositive(n) {",
        "  return n > 0;",
        "}",
        "module.exports = { isPositive };",
        "",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(repo, "dist"));
    fs.writeFileSync(path.join(repo, "dist", "lib.js"), "");
    fs.writeFileSync(
      path.join(repo, "run-test.js"),
      [
        "const assert = require('node:assert');",
        "const { isPositive } = require('./dist/lib.js');",
        "assert.strictEqual(isPositive(5), true);",
        "assert.strictEqual(isPositive(-5), false);",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);

    const result = await probe(
      baseOptions(repo, {
        file: "src/lib.js",
        line: 2,
        replaceText: "  return false;",
        preCommand: "cp src/lib.js dist/lib.js",
        testCommand: "node run-test.js",
      }),
    );

    expect(result.status).toBe("killed");
    expect(result.baseline?.exitCode).toBe(0);
    // Untouched by the whole run: the worktree's own dist/ absorbed the
    // rebuild, never the original tree's.
    expect(fs.readFileSync(path.join(repo, "dist", "lib.js"), "utf8")).toBe("");
  });
});

/**
 * The link policy end to end (`src/probe/link-policy.ts`): every
 * candidate from every source is judged before any link is created,
 * and each refusal reaches the envelope's own `warnings`. The unit
 * tests for the four rules live in `test/link-policy.test.ts`; these
 * are the shapes that only a real probe run can show -- what ends up
 * in the isolation copy, what the source tree looks like afterwards,
 * and what the operator is told.
 */
describe("probe(): worktree isolation, the link policy", () => {
  /** A module directory a test command can `require`, so a link that
   * silently dropped shows up as a failing BASELINE rather than as a
   * subtly different envelope. */
  function writeModule(dir: string, name: string): void {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(
      path.join(dir, name, "package.json"),
      JSON.stringify({ name, main: "index.js" }),
    );
    fs.writeFileSync(
      path.join(dir, name, "index.js"),
      `module.exports = ${JSON.stringify(name)};\n`,
    );
  }

  it("links a node_modules that is itself a symlink to a directory OUTSIDE the repository, at the root and nested, and the copy resolves modules through both (containment is judged on where the candidate SITS, never on where it points)", async () => {
    useLockDir();
    const { repo } = initRepo();
    // The provisioning this org's own worktrees use: no install of
    // their own, node_modules symlinked to a sibling checkout's.
    const outsideRoot = makeTmpDir();
    const outsideNested = makeTmpDir();
    writeModule(outsideRoot, "dep");
    writeModule(outsideNested, "dep-nested");
    fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
    // Without a trailing slash, so the ignore rule matches the SYMLINK
    // too (git sees a symlink as a file): the untracked sync must not
    // be what puts these in the copy, or this test would pass with the
    // link step doing nothing at all.
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    fs.writeFileSync(
      path.join(repo, "link-check.test.js"),
      [
        "const assert = require('node:assert');",
        "assert.strictEqual(require('dep'), 'dep');",
        "assert.strictEqual(",
        "  require('./packages/app/node_modules/dep-nested'),",
        "  'dep-nested',",
        ");",
        "const { isPositive } = require('./fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "links"]);
    fs.symlinkSync(outsideRoot, path.join(repo, "node_modules"));
    fs.symlinkSync(
      outsideNested,
      path.join(repo, "packages", "app", "node_modules"),
    );

    const result = await probe(
      baseOptions(repo, { testCommand: "node link-check.test.js" }),
    );

    expect(result.isolation.linked).toEqual(
      expect.arrayContaining([
        path.join(repo, "node_modules"),
        path.join(repo, "packages", "app", "node_modules"),
      ]),
    );
    // The baseline resolved both modules through the copy's own links;
    // the mutant then broke the assertion the fixture carries.
    expect(result.status).toBe("killed");
    expect(result.baseline?.exitCode).toBe(0);
  });

  it("links TWO distinct in-repo symlinks that point at ONE shared install: nesting is judged on the destination paths in the copy, not on what the links resolve to", async () => {
    useLockDir();
    const { repo } = initRepo();
    const shared = path.join(repo, "shared-install");
    writeModule(shared, "dep");
    fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".gitignore"),
      ["node_modules", "shared-install"].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(repo, "link-check.test.js"),
      [
        "const assert = require('node:assert');",
        "assert.strictEqual(require('dep'), 'dep');",
        "assert.strictEqual(",
        "  require('./packages/app/node_modules/dep'),",
        "  'dep',",
        ");",
        "const { isPositive } = require('./fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "links"]);
    fs.symlinkSync(shared, path.join(repo, "node_modules"));
    fs.symlinkSync(shared, path.join(repo, "packages", "app", "node_modules"));

    const result = await probe(
      baseOptions(repo, { testCommand: "node link-check.test.js" }),
    );

    expect(result.isolation.linked).toEqual(
      expect.arrayContaining([
        path.join(repo, "node_modules"),
        path.join(repo, "packages", "app", "node_modules"),
      ]),
    );
    expect(result.warnings.some((w) => w.includes("already covered by"))).toBe(
      false,
    );
    expect(result.status).toBe("killed");
  });

  it("refuses a composer bin-dir of '.' (repository content naming the root): the isolation copy is never replaced by a link to the source tree, the source stays byte-identical, the run still completes, and nothing is left behind", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "vendor/\n");
    fs.writeFileSync(
      path.join(repo, "composer.json"),
      // The value a hostile (or merely wrong) composer.json carries:
      // resolved, it IS the repository root.
      JSON.stringify({ name: "acme/widget", config: { "bin-dir": "." } }),
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "composer"]);
    fs.mkdirSync(path.join(repo, "vendor"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "vendor", "autoload.php"),
      "<?php // stand-in autoloader\n",
    );

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    for (const [, entry] of after) expect(entry.symlink).toBe(false);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([path.join(repo, "vendor")]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "composer.json")) &&
          w.includes("bin-dir") &&
          // The sits-rule's phrase, not the resolves-rule's ("it
          // resolves to the repository root itself"): both would refuse
          // this candidate.
          w.includes("it is the repository root itself"),
      ),
    ).toBe(true);
    // No leftover from the refusal: the worktree was removed and
    // deregistered, and no repository-keyed marker survives.
    expect(fs.existsSync(result.isolation.path as string)).toBe(false);
    expect(worktreeList(repo)).not.toContain(result.isolation.path as string);
    expect(fs.existsSync(markerFilePathFor(resolveDeepestExisting(repo)))).toBe(
      false,
    );
  });

  it("refuses a defaults-file link naming the directory this run's own mutant is written into, so the mutant reaches the copy's own file and never the operator's", async () => {
    useLockDir();
    const repo = initSrcRepo();

    const before = hashTree(repo);
    const result = await probe(
      baseOptions(repo, {
        file: "src/fixture.js",
        testCommand: SRC_TEST_COMMAND,
      }),
    );
    const after = hashTree(repo);

    // The whole source tree, not just the target: a link created over
    // `src` would have made this run's mutant land in the operator's
    // own file, and a delete through such a link would show here too.
    expect(after).toEqual(before);
    for (const [, entry] of after) expect(entry.symlink).toBe(false);
    expect(result.status).toBe("killed");
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, ".agent-primitives.json")) &&
          w.includes('"src"') &&
          w.includes("must stay a real directory in the copy"),
      ),
    ).toBe(true);
    expect(result.isolation.linked).toEqual([]);
    // The baseline proves it from INSIDE the copy: a gitignored file
    // that exists only in the source tree is not visible under the
    // copy's own `src`, so `src` in the copy is a real directory of the
    // copy's, not a link to the source.
    expect(result.baseline?.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(repo, "src", "fixture.js"), "utf8")).toBe(
      SRC_FIXTURE_JS,
    );
  });

  it("refuses an operator's --link naming the mutated file's own directory too: the tracked-directory rule is for repository content, but the 'must stay a real directory in the copy' rule applies to every source", async () => {
    useLockDir();
    const repo = initSrcRepo({ defaultsLinks: null });

    const result = await probe(
      baseOptions(repo, {
        file: "src/fixture.js",
        testCommand: SRC_TEST_COMMAND,
        links: ["src"],
      }),
    );

    expect(result.status).toBe("killed");
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "src")) &&
          w.includes("must stay a real directory in the copy"),
      ),
    ).toBe(true);
    expect(result.isolation.linked).toEqual([]);
    expect(result.baseline?.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(repo, "src", "fixture.js"), "utf8")).toBe(
      SRC_FIXTURE_JS,
    );
  });

  it("refuses a composer vendor-dir that names a TRACKED directory (source, which the copy syncs for itself), naming the composer.json and the value", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(
      path.join(repo, "composer.json"),
      JSON.stringify({ name: "acme/widget", config: { "vendor-dir": "libs" } }),
    );
    fs.mkdirSync(path.join(repo, "libs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "libs", "tracked.php"), "<?php // src\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "composer"]);

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "composer.json")) &&
          w.includes('"libs"') &&
          w.includes("git tracks it"),
      ),
    ).toBe(true);
  });

  it("every refusal reaches the envelope's warnings: an out-of-root composer value and a tracked defaults-file entry are both reported in one run", async () => {
    useLockDir();
    const repo = initSrcRepo({ defaultsLinks: ["lib"] });
    const outside = makeTmpDir();
    fs.mkdirSync(path.join(outside, "vendor"), { recursive: true });
    const relEscape = path.relative(repo, path.join(outside, "vendor"));
    fs.writeFileSync(
      path.join(repo, "composer.json"),
      JSON.stringify({
        name: "acme/widget",
        config: { "vendor-dir": relEscape },
      }),
    );
    git(repo, ["add", "composer.json"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "composer"]);

    const result = await probe(
      baseOptions(repo, {
        file: "src/fixture.js",
        testCommand: SRC_TEST_COMMAND,
      }),
    );

    expect(result.status).toBe("killed");
    expect(
      result.warnings.some(
        (w) =>
          w.includes(relEscape) &&
          w.includes("does not sit inside the repository root"),
      ),
    ).toBe(true);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, ".agent-primitives.json")) &&
          w.includes('"lib"') &&
          w.includes("git tracks it"),
      ),
    ).toBe(true);
  });

  it("links a gitignored directory the defaults file names, and refuses a TRACKED one from the same file in the same run: the rule is what git tracks, not where the value came from", async () => {
    useLockDir();
    const repo = initSrcRepo({ defaultsLinks: ["lib", "vendor"] });
    fs.appendFileSync(path.join(repo, ".gitignore"), "vendor\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "ignore"]);
    fs.mkdirSync(path.join(repo, "vendor"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "vendor", "autoload.php"),
      "<?php // stand-in autoloader\n",
    );

    const result = await probe(
      baseOptions(repo, {
        file: "src/fixture.js",
        testCommand: SRC_TEST_COMMAND,
      }),
    );

    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([
      resolveDeepestExisting(path.join(repo, "vendor")),
    ]);
    expect(
      result.warnings.some(
        (w) => w.includes('"lib"') && w.includes("git tracks it"),
      ),
    ).toBe(true);
  });
});

/**
 * The isolation copy's own FILESYSTEM, not the path strings the link
 * policy compares. `mkdirSync`, `rmSync` and `symlinkSync` resolve
 * symlinks in the path they are given, and on a case-insensitive
 * volume (APFS and HFS+ by default) two spellings that differ only in
 * case are one entry: a candidate the policy sees as a new path can be
 * the same directory as one already linked, or the very directory this
 * run writes into. Every test here runs a real probe over a scratch
 * fixture, hashes the SOURCE tree before and after, and asserts what
 * the operator is told as well as that nothing moved.
 */
describe("probe(): worktree isolation, a destination the copy spells differently", () => {
  const PHPUNIT_STUB = "#!/bin/sh\necho phpunit\n";

  /** A repo with a gitignored `vendor/` (an autoloader and a `bin/`),
   * a committed `composer.json` carrying `config`, and the standard
   * fixture the probe mutates at the root. */
  function initVendorRepo(config: Record<string, string>): string {
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "vendor/\n");
    fs.writeFileSync(
      path.join(repo, "composer.json"),
      JSON.stringify({ name: "acme/widget", config }),
    );
    git(repo, ["add", "composer.json", ".gitignore"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "composer"]);
    fs.mkdirSync(path.join(repo, "vendor", "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "vendor", "autoload.php"),
      "<?php // stand-in autoloader\n",
    );
    fs.writeFileSync(path.join(repo, "vendor", "bin", "phpunit"), PHPUNIT_STUB);
    return repo;
  }

  it("a composer bin-dir of 'VENDOR/bin' over a linked 'vendor': the destination resolves through the link this run just created, so it is refused and the operator's real vendor/bin survives byte for byte", async () => {
    useLockDir();
    const repo = initVendorRepo({
      "vendor-dir": "vendor",
      "bin-dir": "VENDOR/bin",
    });
    const caseInsensitive = caseInsensitiveVolume(repo);

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    // Nothing in the source tree became a symlink: the shape this
    // leaves behind when the delete goes through the `vendor` link is
    // a `vendor/bin` that points at itself.
    for (const [, entry] of after) expect(entry.symlink).toBe(false);
    expect(
      fs.lstatSync(path.join(repo, "vendor", "bin")).isSymbolicLink(),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(repo, "vendor", "bin", "phpunit"), "utf8"),
    ).toBe(PHPUNIT_STUB);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([path.join(repo, "vendor")]);
    if (caseInsensitive) {
      expect(
        result.warnings.some(
          (w) =>
            w.includes(path.join(repo, "VENDOR", "bin")) &&
            w.includes("outside the copy") &&
            w.includes("linked earlier in this run"),
        ),
      ).toBe(true);
    } else {
      // A case-sensitive volume has no `VENDOR` to stat, so the value
      // is not a directory on disk and never becomes a candidate.
      expect(
        result.warnings.some((w) => w.includes(path.join(repo, "VENDOR"))),
      ).toBe(false);
    }
  });

  it("a committed defaults file naming both 'cache' and 'CACHE/inner': the second destination resolves through the first link, and the operator's real cache/inner is neither deleted nor replaced", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "cache/\n");
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: ["cache", path.join("CACHE", "inner")] }),
    );
    git(repo, ["add", ".gitignore", ".agent-primitives.json"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "defaults"]);
    fs.mkdirSync(path.join(repo, "cache", "inner"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "cache", "inner", "marker.txt"),
      "present\n",
    );
    const caseInsensitive = caseInsensitiveVolume(repo);

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    for (const [, entry] of after) expect(entry.symlink).toBe(false);
    expect(
      fs.readFileSync(path.join(repo, "cache", "inner", "marker.txt"), "utf8"),
    ).toBe("present\n");
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([
      resolveDeepestExisting(path.join(repo, "cache")),
    ]);
    if (caseInsensitive) {
      expect(
        result.warnings.some(
          (w) =>
            w.includes(path.join(repo, ".agent-primitives.json")) &&
            w.includes(path.join("CACHE", "inner")) &&
            w.includes("outside the copy"),
        ),
      ).toBe(true);
    }
  });

  it("a defaults-file link naming a path that does NOT exist under a linked directory's case variant: nothing is created in the operator's real vendor, which is what the check before the mkdir buys", async () => {
    useLockDir();
    // Two sources in one run, for the two halves of the mkdir shape:
    // composer's own `bin-dir` naming a path that is not there is
    // dropped at DISCOVERY (a value that is not a directory on disk is
    // never a candidate), so the only way to reach the loop with a
    // missing destination is a link source that has no such filter --
    // the defaults file, `--plan`, or `--link`.
    const repo = initVendorRepo({
      "vendor-dir": "vendor",
      "bin-dir": path.join("VENDOR", "deep", "nested"),
    });
    fs.rmSync(path.join(repo, "vendor", "bin"), {
      recursive: true,
      force: true,
    });
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: [path.join("VENDOR", "deep", "nested")] }),
    );
    const caseInsensitive = caseInsensitiveVolume(repo);

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    // The measured shape: with `vendor` linked, a recursive mkdir of
    // `<copy>/VENDOR/deep` creates the directory in the operator's real
    // `vendor/`.
    expect(fs.existsSync(path.join(repo, "vendor", "deep"))).toBe(false);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([path.join(repo, "vendor")]);
    if (caseInsensitive) {
      expect(
        result.warnings.some(
          (w) =>
            w.includes(path.join(repo, "VENDOR", "deep", "nested")) &&
            w.includes("outside the copy"),
        ),
      ).toBe(true);
    }
  });

  it("a composer vendor-dir of 'SRC' with the mutant in src/: rules 2 and 3 see the copy's own spelling, so the link is refused and the operator's src is untouched", async () => {
    useLockDir();
    const repo = initSrcRepo({
      defaultsLinks: null,
      composerConfig: { "vendor-dir": "SRC" },
    });
    const caseInsensitive = caseInsensitiveVolume(repo);

    const before = hashTree(repo);
    const result = await probe(
      baseOptions(repo, {
        file: "src/fixture.js",
        testCommand: SRC_TEST_COMMAND,
      }),
    );
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(fs.readFileSync(path.join(repo, "src", "fixture.js"), "utf8")).toBe(
      SRC_FIXTURE_JS,
    );
    // The baseline's own witness ran inside the copy and found its
    // `src/` to be the copy's own directory (see `srcCheckJs`).
    expect(result.status).toBe("killed");
    expect(result.baseline?.exitCode).toBe(0);
    if (caseInsensitive) {
      expect(result.isolation.linked).toEqual([]);
      expect(
        result.warnings.some(
          (w) =>
            w.includes(path.join(repo, "composer.json")) &&
            w.includes('"SRC"') &&
            w.includes("must stay a real directory in the copy"),
        ),
      ).toBe(true);
    }
  });

  it("a defaults-file link of 'SRC' with the mutant in src/: the same refusal, reached from repository content that names a path rather than from composer", async () => {
    useLockDir();
    const repo = initSrcRepo({ defaultsLinks: ["SRC"] });
    const caseInsensitive = caseInsensitiveVolume(repo);

    const before = hashTree(repo);
    const result = await probe(
      baseOptions(repo, {
        file: "src/fixture.js",
        testCommand: SRC_TEST_COMMAND,
      }),
    );
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(fs.readFileSync(path.join(repo, "src", "fixture.js"), "utf8")).toBe(
      SRC_FIXTURE_JS,
    );
    expect(result.status).toBe("killed");
    expect(result.baseline?.exitCode).toBe(0);
    if (caseInsensitive) {
      expect(result.isolation.linked).toEqual([]);
      expect(
        result.warnings.some(
          (w) =>
            w.includes(path.join(repo, ".agent-primitives.json")) &&
            w.includes('"SRC"') &&
            w.includes("must stay a real directory in the copy"),
        ),
      ).toBe(true);
    }
  });

  it("an operator's --link of 'SRC' with the mutant in src/: rule 2 has no latitude for any source, so this one is refused too", async () => {
    useLockDir();
    const repo = initSrcRepo({ defaultsLinks: null });
    const caseInsensitive = caseInsensitiveVolume(repo);

    const before = hashTree(repo);
    const result = await probe(
      baseOptions(repo, {
        file: "src/fixture.js",
        testCommand: SRC_TEST_COMMAND,
        links: ["SRC"],
      }),
    );
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(fs.readFileSync(path.join(repo, "src", "fixture.js"), "utf8")).toBe(
      SRC_FIXTURE_JS,
    );
    expect(result.status).toBe("killed");
    expect(result.baseline?.exitCode).toBe(0);
    if (caseInsensitive) {
      expect(result.isolation.linked).toEqual([]);
      expect(
        result.warnings.some(
          (w) =>
            w.includes(path.join(repo, "SRC")) &&
            w.includes("must stay a real directory in the copy"),
        ),
      ).toBe(true);
    }
  });

  it("refuses a composer vendor-dir naming a gitignored 'esc -> ..': it sits inside the repository and leaves it, and repository content gets no such latitude", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "esc\n");
    fs.writeFileSync(
      path.join(repo, "composer.json"),
      JSON.stringify({ name: "acme/widget", config: { "vendor-dir": "esc" } }),
    );
    git(repo, ["add", "composer.json", ".gitignore"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "composer"]);
    // The shape a checkout picks up from a tool that links a cache next
    // to the repository: a relative symlink out of the tree.
    fs.symlinkSync("..", path.join(repo, "esc"));

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "composer.json")) &&
          w.includes('"esc"') &&
          w.includes("resolves outside the repository root"),
      ),
    ).toBe(true);
  });

  it("links a case-variant candidate that is neither protected nor tracked (the negative control: the canonical spelling is not a blanket refusal)", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "cache\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "ignore"]);
    fs.mkdirSync(path.join(repo, "cache"), { recursive: true });
    fs.writeFileSync(path.join(repo, "cache", "marker.txt"), "present\n");
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: ["CACHE"] }),
    );
    const caseInsensitive = caseInsensitiveVolume(repo);
    // On a case-insensitive volume the link resolves to the real
    // `cache/`, so the copy can read the marker through it; on a
    // case-sensitive one `CACHE` is simply a directory that is not
    // there and the link is created dangling, which the baseline must
    // not depend on.
    const readsMarker = [
      "const assert = require('node:assert');",
      "const fs = require('node:fs');",
      caseInsensitive
        ? "assert.strictEqual(fs.readFileSync('CACHE/marker.txt', 'utf8'), 'present\\n');"
        : "assert.ok(fs.lstatSync('CACHE').isSymbolicLink());",
      "const { isPositive } = require('./fixture.js');",
      "assert.strictEqual(isPositive(5), true);",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(repo, "cache-check.test.js"), readsMarker);

    const result = await probe(
      baseOptions(repo, { testCommand: "node cache-check.test.js" }),
    );

    expect(result.status).toBe("killed");
    expect(result.baseline?.exitCode).toBe(0);
    expect(result.isolation.linked).toEqual([
      resolveDeepestExisting(path.join(repo, "CACHE")),
    ]);
    expect(result.warnings.some((w) => w.includes("skipped linking"))).toBe(
      false,
    );
  });

  it("links a sibling whose name merely starts with an earlier link's name: 'vendor' does not cover 'vendor-bin'", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(
      path.join(repo, ".gitignore"),
      ["vendor", "vendor-bin"].join("\n") + "\n",
    );
    git(repo, ["add", ".gitignore"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "ignore"]);
    fs.mkdirSync(path.join(repo, "vendor"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "vendor", "autoload.php"),
      "<?php // stand-in autoloader\n",
    );
    fs.mkdirSync(path.join(repo, "vendor-bin"), { recursive: true });
    fs.writeFileSync(path.join(repo, "vendor-bin", "marker.txt"), "present\n");
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: ["vendor", "vendor-bin"] }),
    );
    fs.writeFileSync(
      path.join(repo, "both-check.test.js"),
      [
        "const assert = require('node:assert');",
        "const fs = require('node:fs');",
        "assert.ok(fs.existsSync('vendor/autoload.php'));",
        "assert.strictEqual(",
        "  fs.readFileSync('vendor-bin/marker.txt', 'utf8'),",
        "  'present\\n',",
        ");",
        "const { isPositive } = require('./fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "",
      ].join("\n"),
    );

    const result = await probe(
      baseOptions(repo, { testCommand: "node both-check.test.js" }),
    );

    expect(result.status).toBe("killed");
    expect(result.baseline?.exitCode).toBe(0);
    expect(result.isolation.linked).toEqual([
      resolveDeepestExisting(path.join(repo, "vendor")),
      resolveDeepestExisting(path.join(repo, "vendor-bin")),
    ]);
    expect(result.warnings.some((w) => w.includes("already covered by"))).toBe(
      false,
    );
  });

  it("reports the provenance of an accepted link repository content named, and nothing for one an operator typed", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(
      path.join(repo, ".gitignore"),
      ["vendor", "typed-cache"].join("\n") + "\n",
    );
    git(repo, ["add", ".gitignore"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "ignore"]);
    fs.mkdirSync(path.join(repo, "vendor"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "vendor", "autoload.php"),
      "<?php // stand-in autoloader\n",
    );
    fs.mkdirSync(path.join(repo, "typed-cache"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: ["vendor"] }),
    );

    const result = await probe(baseOptions(repo, { links: ["typed-cache"] }));

    expect(result.status).toBe("killed");
    expect(result.isolation.linkedNamedBy).toEqual([
      {
        path: resolveDeepestExisting(path.join(repo, "vendor")),
        namedBy: `"vendor" named in the "link" list of ${path.join(repo, ".agent-primitives.json")}`,
      },
    ]);
    // Every path in `linkedNamedBy` is in `linked` too; the operator's
    // own `--link` is in `linked` alone.
    expect(result.isolation.linked).toEqual(
      expect.arrayContaining([
        resolveDeepestExisting(path.join(repo, "vendor")),
        resolveDeepestExisting(path.join(repo, "typed-cache")),
      ]),
    );
  });

  it("refuses a candidate whose TARGET resolves inside the isolation copy: a --log-dir inside the repository puts the copy where the auto-discovery walk can find its composer.json and offer the copy's own vendor back", async () => {
    useLockDir();
    const { repo } = initRepo();
    // Tracked, so the copy carries both: the walk finds the copy's own
    // `composer.json` (the copy sits at `<log-dir>/wt-<uuid>/wt`, three
    // directories below the root, exactly the depth cutoff) and its
    // `vendor` exists there to be offered as a candidate.
    fs.mkdirSync(path.join(repo, "vendor"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "vendor", "autoload.php"),
      "<?php // stand-in autoloader\n",
    );
    fs.writeFileSync(
      path.join(repo, "composer.json"),
      JSON.stringify({ name: "acme/widget" }),
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "composer"]);
    const logDir = path.join(repo, "probe-logs");
    fs.mkdirSync(logDir, { recursive: true });

    const result = await probe(baseOptions(repo, { logDir }));

    expect(result.status).toBe("killed");
    const copy = result.isolation.path as string;
    // Nothing linked points back into the copy: a link whose target is
    // the copy's own directory makes the copy refer to itself.
    for (const linked of result.isolation.linked) {
      expect(linked.startsWith(copy + path.sep)).toBe(false);
    }
    expect(
      result.warnings.some((w) =>
        w.includes("inside the isolation copy itself"),
      ),
    ).toBe(true);
    // The copy's own `.git` FILE sits inside `ctx.copyRootReal`, exempted
    // from the nested-repository boundary check for exactly this reason
    // (see `copyRootReal`'s docblock): this fixture's target resolves
    // there, and must be refused by the more specific "inside the
    // isolation copy itself" reason above, never by a false-sounding
    // "nested repository" one.
    expect(result.warnings.some((w) => w.includes("nested repository"))).toBe(
      false,
    );
  });

  it("leaves a destination the untracked sync already recreated as the SAME symlink alone, reports it as carried rather than as reaching out of the copy, and still lists it in isolation.linked", async () => {
    useLockDir();
    const { repo } = initRepo();
    const outside = makeTmpDir();
    fs.mkdirSync(path.join(outside, "dep"), { recursive: true });
    fs.writeFileSync(
      path.join(outside, "dep", "package.json"),
      JSON.stringify({ name: "dep", main: "index.js" }),
    );
    fs.writeFileSync(
      path.join(outside, "dep", "index.js"),
      'module.exports = "dep";\n',
    );
    // NOT gitignored, unlike the linked-node_modules test above: the
    // untracked sync therefore lists this symlink and recreates it in
    // the copy (never following it), so the destination the link step
    // would use already exists and already points outside.
    fs.writeFileSync(
      path.join(repo, "link-check.test.js"),
      [
        "const assert = require('node:assert');",
        "assert.strictEqual(require('dep'), 'dep');",
        "const { isPositive } = require('./fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "check"]);
    fs.symlinkSync(outside, path.join(repo, "node_modules"));

    const beforeOutside = hashTree(outside);
    const result = await probe(
      baseOptions(repo, { testCommand: "node link-check.test.js" }),
    );
    const afterOutside = hashTree(outside);

    // The install at the other end of the symlink is untouched.
    expect(afterOutside).toEqual(beforeOutside);
    expect(result.status).toBe("killed");
    // The baseline resolved `dep` all the same: the copy carries the
    // synced symlink, which points where this link would have.
    expect(result.baseline?.exitCode).toBe(0);
    // Reported as carried: the copy really does reach that install, and
    // an envelope that omitted it could not be told from one where the
    // directory never reached the copy at all.
    expect(result.isolation.linked).toContain(path.join(repo, "node_modules"));
    // Its own wording, not the danger wording every other destination
    // that resolves out of the copy gets: nothing here is at risk.
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "node_modules")) &&
          w.includes("already carries the same symlink the source tree does") &&
          w.includes("left as synced"),
      ),
    ).toBe(true);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "node_modules")) &&
          w.includes("outside the copy"),
      ),
    ).toBe(false);
  });

  it("a --link whose case variant aliases a PARENT of the mutated directory is refused by rule 2, on the copy's own spelling of the WHOLE destination: the run carries on without that link and the operator's tree is untouched", async () => {
    useLockDir();
    const repo = makeTmpDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    fs.mkdirSync(path.join(repo, "src", "sub"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src", "sub", "fixture.js"),
      SRC_FIXTURE_JS,
    );
    fs.writeFileSync(
      path.join(repo, "sub-check.test.js"),
      [
        "const assert = require('node:assert');",
        "const { isPositive } = require('./src/sub/fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    const caseInsensitive = caseInsensitiveVolume(repo);

    const before = hashTree(repo);
    const result = await probe(
      baseOptions(repo, {
        file: path.join("src", "sub", "fixture.js"),
        testCommand: "node sub-check.test.js",
        // Every segment of a destination is read back from the copy by
        // entry identity, not just the last one, so this spelling of the
        // PARENT canonicalises to `src/sub` and rule 2 sees that the
        // directory this run's mutant is written into sits inside the
        // candidate. Before that, only the final component was read back
        // and `SRC/sub` compared as a different path, leaving the whole
        // run to be refused by the postcondition instead.
        links: [path.join("SRC", "sub")],
      }),
    );
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(
      fs.readFileSync(path.join(repo, "src", "sub", "fixture.js"), "utf8"),
    ).toBe(SRC_FIXTURE_JS);
    // Either way the run reaches a verdict: one link is skipped, never
    // the whole run.
    expect(result.status).toBe("killed");
    if (caseInsensitive) {
      expect(result.isolation.linked).toEqual([]);
      expect(
        result.warnings.some(
          (w) =>
            w.includes(path.join(repo, "SRC", "sub")) &&
            w.includes(`own ${path.join("src", "sub")} sits inside it`) &&
            w.includes("must stay a real directory in the copy"),
        ),
      ).toBe(true);
    } else {
      // A case-sensitive volume has no alias: `SRC/sub` is a directory
      // that is not there, and the link is created dangling next to the
      // copy's own `src`.
      expect(result.isolation.linked).toEqual([path.join(repo, "SRC", "sub")]);
    }
  });

  it("refuses a defaults-file link naming the mapped cwd when the run is invoked from a package subdirectory and mutates a file elsewhere", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "fixture.js"), SRC_FIXTURE_JS);
    // Run from `packages/app`, mutate `src/fixture.js`: the cwd and the
    // mutated directory are two different paths, and the copy has to
    // keep BOTH real.
    fs.writeFileSync(
      path.join(repo, "packages", "app", "app.test.js"),
      [
        "const assert = require('node:assert');",
        "const { isPositive } = require('../../src/fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: [path.join("packages", "app")] }),
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "packages"]);

    const before = hashTree(repo);
    const result = await probe(
      baseOptions(repo, {
        cwd: path.join(repo, "packages", "app"),
        file: path.join("..", "..", "src", "fixture.js"),
        testCommand: "node app.test.js",
      }),
    );
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "packages", "app")) &&
          w.includes(`own ${path.join("packages", "app")} sits inside it`) &&
          w.includes("must stay a real directory in the copy"),
      ),
    ).toBe(true);
  });

  /** A tracked module under `src/sub/`, unrelated to the probe's own
   * fixture at the repository root: the shape where a link over a
   * case-variant PARENT touches nothing this run writes to, so nothing
   * but the rules themselves can notice it. */
  const IMPORTANT_JS = "module.exports = { important: true };\n";

  /** Writes the copy's own `src/sub/important.js` from inside the
   * isolation copy. Harmless there and destructive through a link: on a
   * case-insensitive volume a link created at `SRC/sub` IS the copy's
   * `src/sub`, so this same write lands in the operator's tracked file.
   * The true spelling rather than the variant one, so the command means
   * the same thing on both kinds of volume. */
  const CLOBBER_SUB_PRE =
    "node -e \"require('node:fs').writeFileSync('src/sub/important.js','// CLOBBERED')\"";

  function initTrackedSubRepo(): string {
    const { repo } = initRepo();
    fs.mkdirSync(path.join(repo, "src", "sub"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src", "sub", "important.js"),
      IMPORTANT_JS,
    );
    return repo;
  }

  function commitAll(repo: string, message: string): void {
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  }

  it("refuses a defaults-file link whose case variant names a TRACKED PARENT ('SRC/sub' over 'src/sub'), with the mutant outside it and a --pre that writes there: every segment is canonicalised, so git's index is asked about the directory the copy really carries", async () => {
    useLockDir();
    const repo = initTrackedSubRepo();
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: [path.join("SRC", "sub")] }),
    );
    commitAll(repo, "sub");
    const caseInsensitive = caseInsensitiveVolume(repo);

    const before = hashTree(repo);
    const result = await probe(
      baseOptions(repo, { preCommand: CLOBBER_SUB_PRE }),
    );
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(
      fs.readFileSync(path.join(repo, "src", "sub", "important.js"), "utf8"),
    ).toBe(IMPORTANT_JS);
    expect(result.status).toBe("killed");
    if (caseInsensitive) {
      expect(result.isolation.linked).toEqual([]);
      expect(
        result.warnings.some(
          (w) =>
            w.includes(path.join(repo, ".agent-primitives.json")) &&
            w.includes(path.join("SRC", "sub")) &&
            w.includes("git tracks it"),
        ),
      ).toBe(true);
    } else {
      // A case-sensitive volume has no alias: `SRC/sub` is a directory
      // that is not there, and the link is created next to the copy's
      // own `src`, pointing at nothing.
      expect(result.isolation.linked).toEqual([
        path.join(resolveDeepestExisting(repo), "SRC", "sub"),
      ]);
    }
  });

  it("refuses the same TRACKED PARENT alias when a composer vendor-dir names it, naming the composer.json and the value", async () => {
    useLockDir();
    const repo = initTrackedSubRepo();
    fs.writeFileSync(
      path.join(repo, "composer.json"),
      JSON.stringify({
        name: "acme/widget",
        config: { "vendor-dir": path.join("SRC", "sub") },
      }),
    );
    commitAll(repo, "composer");
    const caseInsensitive = caseInsensitiveVolume(repo);

    const before = hashTree(repo);
    const result = await probe(
      baseOptions(repo, { preCommand: CLOBBER_SUB_PRE }),
    );
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(
      fs.readFileSync(path.join(repo, "src", "sub", "important.js"), "utf8"),
    ).toBe(IMPORTANT_JS);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    if (caseInsensitive) {
      expect(
        result.warnings.some(
          (w) =>
            w.includes(path.join(repo, "composer.json")) &&
            w.includes(path.join("SRC", "sub")) &&
            w.includes("git tracks it"),
        ),
      ).toBe(true);
    } else {
      // Composer values are dropped at DISCOVERY when they name nothing
      // on disk, so on this volume there is no candidate at all.
      expect(
        result.warnings.some((w) => w.includes(path.join("SRC", "sub"))),
      ).toBe(false);
    }
  });

  it("refuses a composer vendor-dir naming a gitignored 'esc -> .' (a symlink to the repository root itself): it sits inside the repository under a name of its own, and a --pre writing through it never reaches the real root", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "esc\n");
    fs.writeFileSync(
      path.join(repo, "composer.json"),
      JSON.stringify({ name: "acme/widget", config: { "vendor-dir": "esc" } }),
    );
    commitAll(repo, "composer");
    // The shape a tool that links the project into itself leaves behind:
    // a relative symlink whose target IS the repository root. It sits
    // inside the repository (rule 1's containment) and resolves inside
    // it too (rule 1's namedBy clause), and linking it would hand the
    // copy the whole source tree under the name `esc`.
    fs.symlinkSync(".", path.join(repo, "esc"));

    const before = hashTree(repo);
    const result = await probe(
      baseOptions(repo, {
        preCommand:
          "node -e \"const fs=require('node:fs');fs.mkdirSync('esc',{recursive:true});fs.writeFileSync('esc/clobber.txt','x')\"",
      }),
    );
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(repo, "clobber.txt"))).toBe(false);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "composer.json")) &&
          w.includes('"esc"') &&
          w.includes("resolves to the repository root itself"),
      ),
    ).toBe(true);
  });

  it("a committed defaults file naming 'CACHE/inner' BEFORE 'cache': the second destination's delete would remove the link the first one created, so it is refused, and linked/linkedNamedBy report exactly what the copy carries", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "cache/\n");
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: [path.join("CACHE", "inner"), "cache"] }),
    );
    // The witness runs inside the copy: it asserts the SHAPE the copy
    // carries, which is the only way to see what survived a run whose
    // worktree is removed on the way out. With the second candidate
    // linked, the copy's `CACHE` would itself be a symlink (its `rmSync`
    // having taken the first link with it), not a real directory.
    fs.writeFileSync(
      path.join(repo, "cache-check.test.js"),
      [
        "const assert = require('node:assert');",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "assert.ok(",
        "  fs.lstatSync('CACHE').isDirectory(),",
        "  'CACHE in the isolation copy is not a real directory',",
        ");",
        "assert.ok(",
        "  fs.lstatSync(path.join('CACHE', 'inner')).isSymbolicLink(),",
        "  'CACHE/inner in the isolation copy is not a symlink',",
        ");",
        "assert.strictEqual(",
        "  fs.readFileSync(path.join('CACHE', 'inner', 'marker.txt'), 'utf8'),",
        "  'present\\n',",
        ");",
        "const { isPositive } = require('./fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "",
      ].join("\n"),
    );
    commitAll(repo, "defaults");
    fs.mkdirSync(path.join(repo, "cache", "inner"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "cache", "inner", "marker.txt"),
      "present\n",
    );
    const caseInsensitive = caseInsensitiveVolume(repo);
    if (!caseInsensitive) {
      // `CACHE/inner` is simply not there on a case-sensitive volume, so
      // the two destinations never alias and there is nothing to refuse.
      return;
    }

    const before = hashTree(repo);
    const result = await probe(
      baseOptions(repo, { testCommand: "node cache-check.test.js" }),
    );
    const after = hashTree(repo);

    expect(after).toEqual(before);
    for (const [, entry] of after) expect(entry.symlink).toBe(false);
    expect(
      fs.readFileSync(path.join(repo, "cache", "inner", "marker.txt"), "utf8"),
    ).toBe("present\n");
    // The witness above ran inside the copy and found the first link
    // still there.
    expect(result.baseline?.exitCode).toBe(0);
    expect(result.status).toBe("killed");
    const firstLink = path.join(resolveDeepestExisting(repo), "CACHE", "inner");
    expect(result.isolation.linked).toEqual([firstLink]);
    expect(result.isolation.linkedNamedBy.map((e) => e.path)).toEqual([
      firstLink,
    ]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "cache")) &&
          w.includes(path.join("CACHE", "inner")) &&
          w.includes("linked earlier in this run") &&
          w.includes("the delete at that destination would remove"),
      ),
    ).toBe(true);
  });

  it("the postcondition's mapped-cwd half: a defaults-file link over the cwd's own parent, reached under a spelling the copy does not use, fails the sync rather than running --pre and -t in the operator's tree", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "packages/\n");
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: ["packages"] }),
    );
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "fixture.js"), SRC_FIXTURE_JS);
    // The control's own witness, run from the copy's root: it asserts
    // the link is really there before it asserts anything about the
    // fixture. Its require of `src/fixture.js` does not cross the link,
    // which is what keeps it looking at the copy's own mutant.
    fs.writeFileSync(
      path.join(repo, "root-check.test.js"),
      [
        "const assert = require('node:assert');",
        "const fs = require('node:fs');",
        "assert.ok(",
        "  fs.lstatSync('packages').isSymbolicLink(),",
        "  'packages was not linked into the isolation copy',",
        ");",
        "const { isPositive } = require('./src/fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "assert.strictEqual(isPositive(-5), false);",
        "",
      ].join("\n"),
    );
    commitAll(repo, "packages");
    // Gitignored, so the copy never syncs it and can only reach it
    // through the link the defaults file asks for: the shape a
    // vendored/installed package directory really has.
    fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "packages", "app", "app.test.js"),
      [
        "const assert = require('node:assert');",
        "const { isPositive } = require('../../src/fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "assert.strictEqual(isPositive(-5), false);",
        "",
      ].join("\n"),
    );
    // The control: the same defaults file, run from the repository root
    // so the cwd is not inside the linked directory at all (rule 2
    // refuses a candidate that contains the cwd, whatever its
    // spelling). It shows the fixture links `packages` and reaches a
    // verdict, so what the variant run below changes is the spelling
    // and nothing else.
    const control = await probe(
      baseOptions(repo, {
        file: path.join("src", "fixture.js"),
        testCommand: "node root-check.test.js",
      }),
    );
    expect(control.status).toBe("killed");
    expect(control.isolation.linked).toEqual([
      path.join(resolveDeepestExisting(repo), "packages"),
    ]);

    if (!caseInsensitiveVolume(repo)) {
      // No alias on this volume: `PACKAGES/app` is not a directory at
      // all, so there is no second spelling to be invoked under.
      return;
    }

    const before = hashTree(repo);
    // Same run, same link, invoked under a spelling of the cwd that the
    // copy does not use for that directory. Rule 2 compares the
    // candidate's canonical destination (`packages`) against the
    // protected paths in the SOURCE tree's own spelling
    // (`PACKAGES/app`), and those two strings do not meet; what the
    // rules cannot see, the postcondition measures on the filesystem.
    const result = await probe(
      baseOptions(repo, {
        file: path.join("..", "..", "src", "fixture.js"),
        testCommand: "node app.test.js",
        cwd: path.join(repo, "PACKAGES", "app"),
      }),
    );
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("worktree_sync_failed");
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join("PACKAGES", "app")) &&
          w.includes("outside the") &&
          w.includes("would have written to the source tree"),
      ),
    ).toBe(true);
  });

  it("the postcondition's mutated-path half: a --link over the mutated file's own directory, named in the spelling the copy uses while --file named the other one, fails the sync rather than writing the mutant into the operator's file", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.mkdirSync(path.join(repo, "src", "sub"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src", "sub", "fixture.js"),
      SRC_FIXTURE_JS,
    );
    fs.writeFileSync(
      path.join(repo, "sub-check.test.js"),
      [
        "const assert = require('node:assert');",
        "const { isPositive } = require('./src/sub/fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "assert.strictEqual(isPositive(-5), false);",
        "",
      ].join("\n"),
    );
    commitAll(repo, "sub");
    if (!caseInsensitiveVolume(repo)) {
      // Without an alias the two spellings name two directories, one of
      // which does not exist, and nothing aliases anything.
      return;
    }

    const before = hashTree(repo);
    // The run's own two inputs spell one directory two ways: `--file`
    // reaches the mutant through `SRC/sub`, the link names `src/sub`.
    // The protected path is the source tree's spelling of the first, the
    // candidate's canonical destination is the copy's spelling of the
    // second, and rule 2 compares strings; only the postcondition, which
    // resolves both against the copy's filesystem, sees that the link
    // moved the file this run mutates out of the copy.
    const result = await probe(
      baseOptions(repo, {
        file: path.join("SRC", "sub", "fixture.js"),
        testCommand: "node sub-check.test.js",
        links: [path.join(repo, "src", "sub")],
      }),
    );
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(
      fs.readFileSync(path.join(repo, "src", "sub", "fixture.js"), "utf8"),
    ).toBe(SRC_FIXTURE_JS);
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("worktree_sync_failed");
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join("SRC", "sub", "fixture.js")) &&
          w.includes("outside the") &&
          w.includes("would have written to the source tree"),
      ),
    ).toBe(true);
  });
});

describe("probe(): worktree isolation, a link target that reaches the repository root under a SECOND SPELLING", () => {
  /** The same directory name in the two Unicode normalisation forms:
   * `e` with an acute as one code point (NFC) and as `e` plus a
   * combining acute (NFD). Written as escapes because an editor renders
   * the two identically. */
  const NFC_NAME = "r\u00e9sources";
  const NFD_NAME = "re\u0301sources";

  /** A `--pre` that makes sure `node_modules/` is there and writes a
   * byte into it. With the auto-discovered `node_modules` refused, that
   * byte lands in a real directory of the isolation copy; with it
   * linked, it lands wherever the link points -- which for every target
   * below is the source tree. */
  const CLOBBER_PRE =
    "node -e \"const fs=require('node:fs');" +
    "fs.mkdirSync('node_modules',{recursive:true});" +
    "fs.writeFileSync('node_modules/CLOBBER.txt','x')\"";

  /** A repo whose own directory name AND its parent's are chosen here:
   * `mkdtemp` picks a random name that may itself mix case, and every
   * case below needs a second spelling of one specific segment. The
   * `node_modules` these tests add afterwards is gitignored, so the copy
   * can only ever see it through a link. */
  function initNamedRepo(
    parentName: string,
    repoName: string,
  ): { base: string; repo: string } {
    const base = makeTmpDir();
    const repo = path.join(base, parentName, repoName);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    fs.writeFileSync(path.join(repo, "fixture.js"), FIXTURE_JS);
    fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    return { base, repo };
  }

  /** Creates the gitignored `node_modules -> target` the auto-discovery
   * walk finds, runs a probe whose `--pre` writes through it, and
   * reports the source tree's own hashes on both sides of the run. */
  async function probeThroughNodeModules(
    repo: string,
    target: string,
  ): Promise<{
    before: Map<string, { symlink: boolean; hash: string }>;
    after: Map<string, { symlink: boolean; hash: string }>;
    result: Awaited<ReturnType<typeof probe>>;
  }> {
    fs.symlinkSync(target, path.join(repo, "node_modules"));
    const before = hashTree(repo);
    const result = await probe(baseOptions(repo, { preCommand: CLOBBER_PRE }));
    const after = hashTree(repo);
    return { before, after, result };
  }

  it("refuses every spelling that resolves to the repository root or an ancestor of it -- a case-variant repo directory, a case-variant ancestor segment, an NFD target for an NFC directory -- and still refuses the three exact spellings, leaving the source tree byte-identical in all six", async () => {
    useLockDir();

    // 1. `node_modules -> ../REPO` for a repository directory really
    //    named `repo`: realpath reports `.../p1/REPO` against a root of
    //    `.../p1/repo`, two strings for one directory.
    {
      const { base, repo } = initNamedRepo("p1", "repo");
      const caseInsensitive = caseInsensitiveVolume(base);
      const { before, after, result } = await probeThroughNodeModules(
        repo,
        path.join("..", "REPO"),
      );

      expect(after).toEqual(before);
      expect(fs.existsSync(path.join(repo, "CLOBBER.txt"))).toBe(false);
      expect(result.isolation.linked).toEqual([]);
      expect(result.status).toBe("killed");
      if (caseInsensitive) {
        // The two spellings really are one directory on this volume,
        // and realpath really does not close the gap.
        expect(fs.realpathSync(path.join(repo, "node_modules"))).not.toBe(
          resolveDeepestExisting(repo),
        );
        expect(fs.statSync(path.join(repo, "node_modules")).ino).toBe(
          fs.statSync(repo).ino,
        );
        expect(
          result.warnings.some(
            (w) =>
              w.includes("node_modules") &&
              w.includes("resolves to the repository root itself"),
          ),
        ).toBe(true);
      } else {
        // `../REPO` names nothing here, so the walk never offers the
        // entry as a linkable directory at all.
        expect(result.warnings.some((w) => w.includes("node_modules"))).toBe(
          false,
        );
      }
    }

    // 2. An ABSOLUTE target whose ancestor segment is spelled in another
    //    case: the repository root itself, reached as
    //    `<base>/ancestor/repo` for a real `<base>/Ancestor/repo`.
    {
      const { base, repo } = initNamedRepo("Ancestor", "repo");
      const caseInsensitive = caseInsensitiveVolume(base);
      const { before, after, result } = await probeThroughNodeModules(
        repo,
        path.join(base, "ancestor", "repo"),
      );

      expect(after).toEqual(before);
      expect(fs.existsSync(path.join(repo, "CLOBBER.txt"))).toBe(false);
      expect(result.isolation.linked).toEqual([]);
      expect(result.status).toBe("killed");
      if (caseInsensitive) {
        expect(
          result.warnings.some(
            (w) =>
              w.includes("node_modules") &&
              w.includes("resolves to the repository root itself"),
          ),
        ).toBe(true);
      } else {
        expect(result.warnings.some((w) => w.includes("node_modules"))).toBe(
          false,
        );
      }
    }

    // 3. An NFD target for a repository directory stored in NFC.
    {
      const { base, repo } = initNamedRepo("p3", NFC_NAME);
      // Measured on this volume rather than assumed: APFS's
      // case-insensitive variant is normalisation-insensitive, its
      // case-sensitive variant is not, and a Linux host is neither.
      const normalises = fs.existsSync(path.join(base, "p3", NFD_NAME));
      const { before, after, result } = await probeThroughNodeModules(
        repo,
        path.join("..", NFD_NAME),
      );

      expect(after).toEqual(before);
      expect(fs.existsSync(path.join(repo, "CLOBBER.txt"))).toBe(false);
      expect(result.isolation.linked).toEqual([]);
      expect(result.status).toBe("killed");
      if (normalises) {
        expect(fs.realpathSync(path.join(repo, "node_modules"))).not.toBe(
          resolveDeepestExisting(repo),
        );
        expect(
          result.warnings.some(
            (w) =>
              w.includes("node_modules") &&
              w.includes("resolves to the repository root itself"),
          ),
        ).toBe(true);
      } else {
        expect(result.warnings.some((w) => w.includes("node_modules"))).toBe(
          false,
        );
      }
    }

    // The three EXACT spellings, as negative controls in the same test:
    // these were already refused before identity was consulted, and the
    // wording each one gets must not have moved.
    // 4. `node_modules -> ..`: an ancestor, spelled the way it is.
    {
      const { repo } = initNamedRepo("p4", "repo");
      const parent = path.dirname(repo);
      const { before, after, result } = await probeThroughNodeModules(
        repo,
        "..",
      );

      expect(after).toEqual(before);
      // This target's write would land beside the repository, not in it.
      expect(fs.existsSync(path.join(parent, "CLOBBER.txt"))).toBe(false);
      expect(result.isolation.linked).toEqual([]);
      expect(result.status).toBe("killed");
      expect(
        result.warnings.some(
          (w) =>
            w.includes("node_modules") &&
            w.includes("which contains the repository root"),
        ),
      ).toBe(true);
    }

    // 5. `node_modules -> <the root's own absolute path>`.
    {
      const { repo } = initNamedRepo("p5", "repo");
      const { before, after, result } = await probeThroughNodeModules(
        repo,
        repo,
      );

      expect(after).toEqual(before);
      expect(fs.existsSync(path.join(repo, "CLOBBER.txt"))).toBe(false);
      expect(result.isolation.linked).toEqual([]);
      expect(result.status).toBe("killed");
      expect(
        result.warnings.some(
          (w) =>
            w.includes("node_modules") &&
            w.includes("resolves to the repository root itself"),
        ),
      ).toBe(true);
    }

    // 6. `node_modules -> .`.
    {
      const { repo } = initNamedRepo("p6", "repo");
      const { before, after, result } = await probeThroughNodeModules(
        repo,
        ".",
      );

      expect(after).toEqual(before);
      expect(fs.existsSync(path.join(repo, "CLOBBER.txt"))).toBe(false);
      expect(result.isolation.linked).toEqual([]);
      expect(result.status).toBe("killed");
      expect(
        result.warnings.some(
          (w) =>
            w.includes("node_modules") &&
            w.includes("resolves to the repository root itself"),
        ),
      ).toBe(true);
    }
  }, 90000);
});

describe("probe(): worktree isolation, a link target that is TRACKED source", () => {
  // Every fixture here is auto-discovered: no `--link`, no file naming
  // a path, nothing for rules 1, 2 or 4 to object to. What makes the
  // link dangerous is only what it POINTS AT, and a `--pre` writing
  // through it is what turns that into a write in the operator's own
  // tracked tree.
  it("refuses a gitignored 'node_modules -> src' the walk found: the run completes, nothing is linked, and the source tree is byte-identical", async () => {
    useLockDir();
    const repo = initTrackedSrcRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    commitAll(repo, "ignore node_modules");
    // Created after the commit, so it stays gitignored and untracked:
    // only the walk can find it, and only its target is tracked.
    fs.symlinkSync("src", path.join(repo, "node_modules"), "dir");

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo, { preCommand: CLOBBER_PRE }));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(repo, "src", "CLOBBER.txt"))).toBe(false);
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
    expect(result.isolation.linked).toEqual([]);
    expect(
      refusedForTrackedTarget(
        result.warnings,
        "node_modules",
        path.join(repo, "src"),
      ),
    ).toBe(true);
  });

  it("refuses the same link COMMITTED: what git tracks about the candidate is beside the point, the target is what decides", async () => {
    useLockDir();
    const repo = initTrackedSrcRepo();
    fs.symlinkSync("src", path.join(repo, "node_modules"), "dir");
    commitAll(repo, "commit the node_modules symlink");

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo, { preCommand: CLOBBER_PRE }));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(repo, "src", "CLOBBER.txt"))).toBe(false);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      refusedForTrackedTarget(
        result.warnings,
        "node_modules",
        path.join(repo, "src"),
      ),
    ).toBe(true);
  });

  it("refuses a 'node_modules' git tracks as a DIRECTORY of its own (a vendored file committed under it), which no rule keyed on how the candidate was named ever sees", async () => {
    useLockDir();
    const repo = initTrackedSrcRepo();
    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "node_modules", "vendored.txt"),
      "vendored\n",
    );
    commitAll(repo, "commit a vendored node_modules");

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo, { preCommand: CLOBBER_PRE }));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(repo, "node_modules", "CLOBBER.txt"))).toBe(
      false,
    );
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      refusedForTrackedTarget(
        result.warnings,
        "node_modules",
        path.join(repo, "node_modules"),
      ),
    ).toBe(true);
  });

  it("refuses the ALIAS spelling of the same target ('node_modules -> ../REPO/src'), which resolves into the root while spelling a path outside it: containment of the target is decided by identity, never by relativizing two realpath strings", async (t) => {
    useLockDir();
    const repo = initTrackedSrcRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    commitAll(repo, "ignore node_modules");
    // On a case-sensitive volume the uppercased repository name is
    // simply a directory that is not there, the symlink dangles, and
    // the walk never offers the candidate at all.
    t.skip(!caseInsensitiveVolume(repo), "not on a case-insensitive volume");
    fs.symlinkSync(
      path.join("..", path.basename(repo).toUpperCase(), "src"),
      path.join(repo, "node_modules"),
      "dir",
    );
    // The spelling the policy is handed, and what a plain relativize
    // would make of it: `realpath` normalises no case, so this target
    // reads as a path OUTSIDE the root while naming `src` inside it.
    const targetSpelling = resolveDeepestExisting(
      path.join(repo, "node_modules"),
    );
    expect(
      path
        .relative(resolveDeepestExisting(repo), targetSpelling)
        .startsWith(".."),
    ).toBe(true);

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo, { preCommand: CLOBBER_PRE }));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(repo, "src", "CLOBBER.txt"))).toBe(false);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes("node_modules") &&
          w.includes(`git tracks its target ${targetSpelling}`),
      ),
    ).toBe(true);
  });

  it("negative control: a target OUTSIDE the root (a sibling checkout's install) still links, and the copy really resolves through it", async () => {
    useLockDir();
    const repo = initTrackedSrcRepo();
    const sibling = makeTmpDir();
    fs.mkdirSync(path.join(sibling, "install"), { recursive: true });
    fs.writeFileSync(path.join(sibling, "install", "marker.txt"), "sibling\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    commitAll(repo, "ignore node_modules");
    fs.symlinkSync(
      path.join(path.relative(repo, sibling), "install"),
      path.join(repo, "node_modules"),
      "dir",
    );

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo, { preCommand: CLOBBER_PRE }));
    const after = hashTree(repo);

    expect(result.status).toBe("killed");
    // The walk's own spelling of what it found, which is what
    // `isolation.linked` reports for an auto-discovered candidate.
    expect(result.isolation.linked).toEqual([path.join(repo, "node_modules")]);
    // The link was really used: the `--pre` wrote through it, into the
    // sibling checkout and not into this repository.
    expect(fs.existsSync(path.join(sibling, "install", "CLOBBER.txt"))).toBe(
      true,
    );
    expect(after).toEqual(before);
  });

  it("negative control: an UNTRACKED target inside the root (a monorepo's hoisted install) still links, from both the root and the package that points at it", async () => {
    useLockDir();
    const repo = initTrackedSrcRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "packages", "app", "index.js"),
      "module.exports = 1;\n",
    );
    commitAll(repo, "a package and an ignored node_modules");
    // The hoisted install, and the package-level symlink pointing back
    // up at it: both gitignored, both inside the root, neither tracked.
    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "node_modules", "hoisted.txt"),
      "hoisted\n",
    );
    fs.symlinkSync(
      path.join("..", "..", "node_modules"),
      path.join(repo, "packages", "app", "node_modules"),
      "dir",
    );

    const result = await probe(baseOptions(repo, { preCommand: CLOBBER_PRE }));

    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([
      path.join(repo, "node_modules"),
      path.join(repo, "packages", "app", "node_modules"),
    ]);
    // Shared, which is exactly what these links exist for: the `--pre`
    // wrote into the hoisted install through the copy's own link.
    expect(fs.existsSync(path.join(repo, "node_modules", "CLOBBER.txt"))).toBe(
      true,
    );
    // ... and nothing tracked moved.
    expect(fs.existsSync(path.join(repo, "src", "CLOBBER.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "src", "tracked.js"), "utf8")).toBe(
      "module.exports = 1;\n",
    );
  });

  it("refuses a target BELOW a submodule's own root ('node_modules -> sub/lib'), which the outer index lists nowhere but the submodule's own gitlink", async () => {
    useLockDir();
    const repo = initTrackedSrcRepo();
    const upstream = initUpstreamLibRepo();
    git(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      upstream,
      "sub",
    ]);
    commitAll(repo, "add submodule");
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    commitAll(repo, "ignore node_modules");
    fs.symlinkSync(
      path.join("sub", "lib"),
      path.join(repo, "node_modules"),
      "dir",
    );

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo, { preCommand: CLOBBER_PRE }));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(repo, "sub", "lib", "CLOBBER.txt"))).toBe(
      false,
    );
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes("node_modules") &&
          w.includes(
            `its target ${resolveDeepestExisting(path.join(repo, "sub", "lib"))} sits inside a nested repository at sub`,
          ) &&
          w.includes("whose content the outer index never lists"),
      ),
    ).toBe(true);
  });

  it("control: the submodule's own ROOT ('node_modules -> sub') stays refused by the OUTER index's gitlink, the same as before the nested-repository boundary existed", async () => {
    useLockDir();
    const repo = initTrackedSrcRepo();
    const upstream = initUpstreamLibRepo();
    git(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      upstream,
      "sub",
    ]);
    commitAll(repo, "add submodule");
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    commitAll(repo, "ignore node_modules");
    fs.symlinkSync("sub", path.join(repo, "node_modules"), "dir");

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo, { preCommand: CLOBBER_PRE }));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(repo, "sub", "CLOBBER.txt"))).toBe(false);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      refusedForTrackedTarget(
        result.warnings,
        "node_modules",
        path.join(repo, "sub"),
      ),
    ).toBe(true);
  });

  it("refuses a target BELOW a gitignored NESTED PLAIN repository's own root ('node_modules -> nested/lib'), the same boundary a submodule's content sits behind", async () => {
    useLockDir();
    const repo = initTrackedSrcRepo();
    fs.writeFileSync(
      path.join(repo, ".gitignore"),
      ["node_modules", "nested"].join("\n") + "\n",
    );
    commitAll(repo, "ignore node_modules and nested");
    const nested = path.join(repo, "nested");
    fs.mkdirSync(path.join(nested, "lib"), { recursive: true });
    fs.writeFileSync(path.join(nested, "lib", "file.txt"), "nested\n");
    git(nested, ["init", "-q"]);
    git(nested, ["config", "user.email", "test@example.com"]);
    git(nested, ["config", "user.name", "test"]);
    git(nested, ["add", "-A"]);
    git(nested, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "init nested",
    ]);
    fs.symlinkSync(
      path.join("nested", "lib"),
      path.join(repo, "node_modules"),
      "dir",
    );

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo, { preCommand: CLOBBER_PRE }));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(nested, "lib", "CLOBBER.txt"))).toBe(false);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes("node_modules") &&
          w.includes("inside a nested repository at nested"),
      ),
    ).toBe(true);
  });

  it("negative control: a gitignored nested directory carrying no '.git' of its own still links -- nesting alone is not the boundary", async () => {
    useLockDir();
    const repo = initTrackedSrcRepo();
    fs.writeFileSync(
      path.join(repo, ".gitignore"),
      ["node_modules", "plain"].join("\n") + "\n",
    );
    commitAll(repo, "ignore node_modules and plain");
    fs.mkdirSync(path.join(repo, "plain", "lib"), { recursive: true });
    fs.writeFileSync(path.join(repo, "plain", "lib", "file.txt"), "plain\n");
    fs.symlinkSync(
      path.join("plain", "lib"),
      path.join(repo, "node_modules"),
      "dir",
    );

    const result = await probe(baseOptions(repo, { preCommand: CLOBBER_PRE }));

    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([path.join(repo, "node_modules")]);
    expect(fs.existsSync(path.join(repo, "plain", "lib", "CLOBBER.txt"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(repo, "src", "CLOBBER.txt"))).toBe(false);
  });

  it("refuses an auto-discovered 'node_modules -> .git' (gitignored, so untracked, and outside any nested-repository boundary): neither isTrackedPath nor nestedRepoBoundaryRelPath sees a target that IS the repository's own git directory", async () => {
    useLockDir();
    const repo = initTrackedSrcRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    commitAll(repo, "ignore node_modules");
    // `.git/.git` does not exist, so `nestedRepoBoundaryRelPath` finds no
    // boundary here, and git's own index never lists `.git` at all --
    // only the dedicated `.git` refusal catches this candidate.
    fs.symlinkSync(
      path.join(repo, ".git"),
      path.join(repo, "node_modules"),
      "dir",
    );

    const gitBefore = hashTree(path.join(repo, ".git"));
    const result = await probe(baseOptions(repo, { preCommand: CLOBBER_PRE }));
    const gitAfter = hashTree(path.join(repo, ".git"));

    expect(gitAfter).toEqual(gitBefore);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.startsWith("skipped linking ") &&
          w.includes("node_modules") &&
          w.includes("is the repository's own git directory"),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(repo, "src", "CLOBBER.txt"))).toBe(false);
  });
});

describe("probe(): worktree isolation, a destination whose ancestor in the copy is a file", () => {
  it("skips a defaults-file link naming a path under a TRACKED FILE ('SRC/FILE.TXT/x' over 'src/file.txt') with a warning, and the run completes instead of failing the whole sync", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "file.txt"), "tracked\n");
    // Repository content naming a path UNDER a tracked file. It passes
    // rule 3 honestly: git tracks `src/file.txt`, but nothing is tracked
    // under it, so `src/file.txt/x` is untracked and the rule has
    // nothing to refuse.
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: [path.join("SRC", "FILE.TXT", "x")] }),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "tracked file",
    ]);
    if (!caseInsensitiveVolume(repo)) {
      // `SRC/FILE.TXT` is free space in the copy on this volume: the
      // recursive mkdir creates it, the link is made, and the shape this
      // test is about has nothing to act on.
      return;
    }

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(fs.readFileSync(path.join(repo, "src", "file.txt"), "utf8")).toBe(
      "tracked\n",
    );
    // The run completed: one impossible destination is a skipped link,
    // never a failed sync for everything else in the run.
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
    expect(result.isolation.linked).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join("SRC", "FILE.TXT", "x")) &&
          w.includes(path.join("SRC", "FILE.TXT")) &&
          w.includes("is not a directory in the copy"),
      ),
    ).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("worktree_sync_failed")),
    ).toBe(false);
  });

  it("skips a defaults-file link under a DANGLING symlink ('dang -> nowhere-at-all', the entry naming 'dang/x') with the same warning, on any volume: something IS there, so the recursive mkdir cannot create through it either", async () => {
    useLockDir();
    const { repo } = initRepo();
    // A committed symlink resolving nowhere. It reaches the copy as the
    // same dangling link, and the destination `dang/x` is a path the
    // rules above have nothing to say about: git tracks `dang` itself
    // but nothing under it, and the target resolves to no directory at
    // all. Needs no case-insensitive volume: the entry names the
    // ancestor in its own spelling.
    fs.symlinkSync("nowhere-at-all", path.join(repo, "dang"));
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: [path.join("dang", "x")] }),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "dangling symlink",
    ]);

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    // One impossible destination is a skipped link, never a failed sync
    // for the whole run: the branch that reports a dangling ancestor as
    // blocking is what keeps the recursive mkdir from throwing EEXIST
    // into the sync's own catch.
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
    expect(result.isolation.linked).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join("dang", "x")) &&
          w.includes("sits under dang, which is not a directory in the copy"),
      ),
    ).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("worktree_sync_failed")),
    ).toBe(false);
  });
});

describe("probe(): worktree isolation, a link target that CONTAINS the isolation copy", () => {
  it("refuses a defaults-file link naming the in-repo --log-dir the copy itself lives under, the mirror of the target-inside-the-copy refusal", async () => {
    useLockDir();
    const { repo } = initRepo();
    const logDir = path.join(repo, ".probe-logs");
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".probe-logs\n");
    // Repository content naming the directory the isolation copy is
    // created inside: it sits in the repository, resolves inside it, is
    // not tracked, and contains no path this run writes to, so every
    // up-front rule accepts it.
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: [".probe-logs"] }),
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "log dir"]);

    /** The source tree without the log directory, whose contents this
     * run legitimately writes. */
    const hashTreeOutsideLogs = (): Map<
      string,
      { symlink: boolean; hash: string }
    > => {
      const all = hashTree(repo);
      for (const key of [...all.keys()]) {
        if (key === ".probe-logs" || key.startsWith(".probe-logs" + path.sep)) {
          all.delete(key);
        }
      }
      return all;
    };

    const before = hashTreeOutsideLogs();
    const result = await probe(baseOptions(repo, { logDir }));
    const after = hashTreeOutsideLogs();

    expect(after).toEqual(before);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(".probe-logs") &&
          w.includes("which contains the isolation copy"),
      ),
    ).toBe(true);
  });

  it("refuses the same in-repo --log-dir named under a CASE VARIANT ('.PROBE-LOGS' for a '.probe-logs' log dir): the mirror is decided by filesystem identity, which is the only thing that sees it", async (t) => {
    useLockDir();
    const { repo } = initRepo();
    const logDir = path.join(repo, ".probe-logs");
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".probe-logs\n");
    // The same shape as the test above, spelled the one way no string
    // comparison catches: `realpath` normalises no case, so this target
    // resolves to `<repo>/.PROBE-LOGS`, which relativizes to a path
    // OUTSIDE the copy while naming the very directory the copy sits
    // in. Untracked and containing nothing this run writes to, so every
    // rule up to the mirror accepts it.
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: [".PROBE-LOGS"] }),
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "log dir"]);
    // On a case-sensitive volume `.PROBE-LOGS` is a directory that is
    // not there: it contains no copy, and the mirror has nothing to
    // decide.
    t.skip(!caseInsensitiveVolume(repo), "not on a case-insensitive volume");
    const targetSpelling = resolveDeepestExisting(
      path.join(repo, ".PROBE-LOGS"),
    );
    expect(targetSpelling.endsWith(".PROBE-LOGS")).toBe(true);

    /** The source tree without the log directory, whose contents this
     * run legitimately writes. */
    const hashTreeOutsideLogs = (): Map<
      string,
      { symlink: boolean; hash: string }
    > => {
      const all = hashTree(repo);
      for (const key of [...all.keys()]) {
        if (key === ".probe-logs" || key.startsWith(".probe-logs" + path.sep)) {
          all.delete(key);
        }
      }
      return all;
    };

    const before = hashTreeOutsideLogs();
    const result = await probe(baseOptions(repo, { logDir }));
    const after = hashTreeOutsideLogs();

    expect(after).toEqual(before);
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([]);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(`its target resolves to ${targetSpelling}`) &&
          w.includes("which contains the isolation copy"),
      ),
    ).toBe(true);
  });
});

describe("probe(): worktree isolation, the tracked-file listing behind the link policy", () => {
  it("fails closed when git cannot answer which candidates it tracks: no link repository content named is created, and the envelope says so", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(
      path.join(repo, ".gitignore"),
      ["vendor", "typed-cache", "node_modules"].join("\n") + "\n",
    );
    git(repo, ["add", ".gitignore"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "ignore"]);
    // Gitignored, so the real listing would report it as untracked and
    // the link would be created: what keeps it out here is only that
    // the listing could not run at all.
    fs.mkdirSync(path.join(repo, "vendor"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "vendor", "autoload.php"),
      "<?php // stand-in autoloader\n",
    );
    fs.mkdirSync(path.join(repo, "typed-cache"), { recursive: true });
    // Auto-discovered, gitignored, and untracked: the real listing
    // would report its target as untracked too, so only the listing
    // being unanswerable keeps it out. The fail-closed rule covers
    // every candidate the policy would have asked about, not just the
    // ones repository content named.
    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".agent-primitives.json"),
      JSON.stringify({ link: ["vendor"] }),
    );
    const binDir = makeTmpDir();
    writeGitShim(binDir, "fail-ls-files-pathspec");

    const result = await withPathPrepended(binDir, () =>
      probe(baseOptions(repo, { links: ["typed-cache"] })),
    );

    expect(result.status).toBe("killed");
    expect(
      result.warnings.some(
        (w) =>
          w.includes("git ls-files could not check which link candidates") &&
          w.includes("treated as tracked"),
      ),
    ).toBe(true);
    // The destination half's refusal says the listing could not check,
    // never that git tracks it, the same as the target half below: the
    // listing never got the chance to answer, and claiming it did would
    // be false.
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "vendor")) &&
          w.includes(
            "could not check whether git tracks vendor; treated as tracked",
          ),
      ),
    ).toBe(true);
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "vendor")) && w.includes("git tracks it"),
      ),
    ).toBe(false);
    // The target half's refusal says the listing could not check,
    // never that git tracks it: the listing never got the chance to
    // answer, and claiming it did would be false.
    expect(
      result.warnings.some(
        (w) =>
          w.includes(path.join(repo, "node_modules")) &&
          w.includes(
            `could not check whether git tracks its target ${resolveDeepestExisting(path.join(repo, "node_modules"))}; treated as tracked`,
          ),
      ),
    ).toBe(true);
    expect(
      result.warnings.some((w) =>
        w.includes(
          `git tracks its target ${resolveDeepestExisting(path.join(repo, "node_modules"))}; source is copied`,
        ),
      ),
    ).toBe(false);
    // Both candidates rule 3 questions are refused; the operator's own
    // `--link`, which neither half of it applies to, still links.
    expect(result.isolation.linked).toEqual([
      resolveDeepestExisting(path.join(repo, "typed-cache")),
    ]);
    expect(result.isolation.linkedNamedBy).toEqual([]);
  });
});

describe("probe(): worktree isolation, non-git fallback", () => {
  it("falls back to inplace with a warning naming the fallback, outside a git work tree", async () => {
    useLockDir();
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "fixture.js"), FIXTURE_JS);
    fs.writeFileSync(path.join(dir, "fixture.test.js"), FIXTURE_TEST_JS);

    const result = await probe(baseOptions(dir));

    expect(result.status).toBe("killed");
    expect(result.isolation.mode).toBe("inplace");
    expect(
      result.warnings.some(
        (w) =>
          w.includes("not inside a git work tree") && w.includes("inplace"),
      ),
    ).toBe(true);
  });
});

describe("probe(): worktree isolation, sync failure", () => {
  it("a deliberately conflicting tracked diff yields worktree_sync_failed, exit-class inconclusive, and no verdict", async () => {
    useLockDir();
    const { repo } = initRepo();

    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    mockRun.mockImplementation(async (file, args, options) => {
      const result = await actualRun.runArgv(file, args, options);
      if (args[0] === "diff" && args.includes("--binary")) {
        // `git diff HEAD --binary --output=<path>` writes the diff
        // straight to that file (never through this call's own stdout
        // capture); overwriting it here, after the real call already
        // produced it, is what corrupts the sync's own diff content.
        const outputArg = args.find((a) => a.startsWith("--output="));
        if (outputArg === undefined) {
          throw new Error("expected a --output= argument on this diff call");
        }
        const diffPath = outputArg.slice("--output=".length);
        // A hunk whose context matches nothing in fixture.js: cannot
        // apply cleanly against a freshly checked-out HEAD worktree.
        fs.writeFileSync(
          diffPath,
          [
            "diff --git a/fixture.js b/fixture.js",
            "index 0000000..1111111 100644",
            "--- a/fixture.js",
            "+++ b/fixture.js",
            "@@ -1,1 +1,1 @@",
            "-this line does not exist in fixture.js",
            "+neither does this one",
            "",
          ].join("\n"),
        );
      }
      return result;
    });

    try {
      const result = await probe(baseOptions(repo));
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("worktree_sync_failed");
      expect(result.mutant).toBeUndefined();
    } finally {
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
      );
    }
  });
});

describe("probe(): worktree isolation, concurrent probes on one repository serialize", () => {
  it("a second probe on a different file in the same repository is probe_in_progress while the first is still running", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, "fixture2.js"), FIXTURE_JS);
    fs.writeFileSync(path.join(repo, "fixture2.test.js"), FIXTURE_TEST_JS);
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "second file",
    ]);

    const slow = baseOptions(repo, {
      testCommand: "sleep 1 && node fixture.test.js",
    });
    const first = probe(slow);
    // Give the first call a head start so it has acquired the
    // repository-keyed lock by the time the second one runs.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const second = await probe(
      baseOptions(repo, {
        file: "fixture2.js",
        testCommand: "node fixture2.test.js",
      }),
    );

    expect(second.status).toBe("inconclusive");
    expect(second.reason).toBe("probe_in_progress");

    const firstResult = await first;
    expect(firstResult.status).toBe("killed");
  }, 15000);
});

describe("probe(): worktree isolation, cleanup after SIGTERM and stale-worktree recovery", () => {
  it("SIGTERM during a slow mutant run still cleans up the worktree and leaves no lock", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    // Pinned (rather than the CLI's own per-run default) so the test
    // knows where to look for the worktree: it lands at
    // `<logDir>/wt-<random>/wt`, a fresh per-run subdirectory of
    // `logDir` rather than a fixed name directly under it (see
    // isolation.ts's own docblock on why), so the exact path is
    // discovered once the run is under way rather than pinned up front.
    const logDir = makeTmpDir();
    const findWorktreePath = (): string | undefined => {
      for (const entry of fs.readdirSync(logDir)) {
        if (entry.startsWith("wt-")) {
          const candidate = path.join(logDir, entry, "wt");
          if (fs.existsSync(candidate)) return candidate;
        }
      }
      return undefined;
    };
    // Written OUTSIDE the worktree (via an absolute path in an env var,
    // inherited all the way down to the grandchild): the worktree itself
    // gets removed as part of the SIGTERM cleanup this test is proving,
    // so a heartbeat file living inside it could not be read afterward
    // regardless of whether the grandchild was actually killed.
    const heartbeatDir = makeTmpDir();
    const heartbeat = path.join(heartbeatDir, "heartbeat-out.txt");

    fs.writeFileSync(
      path.join(repo, "heartbeat-worker.js"),
      [
        "const fs = require('node:fs');",
        "const target = process.env.HEARTBEAT_ABS_PATH;",
        "let n = 0;",
        "const tick = () => {",
        "  n += 1;",
        "  fs.writeFileSync(target, String(n));",
        "};",
        "tick();",
        "const id = setInterval(tick, 100);",
        "setTimeout(() => { clearInterval(id); process.exit(0); }, 10000);",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "if (content.includes('SLOW_MARKER')) {",
        "  spawn(process.execPath, ['heartbeat-worker.js'], { stdio: 'inherit' });",
        "  setTimeout(() => { process.exit(0); }, 10000);",
        "} else { process.exit(0); }",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "heartbeat test",
    ]);

    const child = spawn(
      "node",
      [
        CLI_PATH,
        "probe",
        "--file",
        "fixture.js",
        "-n",
        "2",
        "-r",
        "  return false; // SLOW_MARKER",
        "-t",
        "node fixture.test.js",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          AGENT_PRIMITIVES_LOCK_DIR: lockDir,
          AGENT_PRIMITIVES_LOG_DIR: logDir,
          HEARTBEAT_ABS_PATH: heartbeat,
        },
        stdio: "ignore",
      },
    );

    const deadline = Date.now() + 10000;
    while (!fs.existsSync(heartbeat)) {
      if (Date.now() > deadline) {
        throw new Error("heartbeat.txt never appeared before the deadline");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The worktree really is there, mid-run, before it gets torn down:
    // asserted first, so a regression that never creates it in the first
    // place is reported as that, not as a false pass on "gone after
    // SIGTERM".
    const worktreePath = findWorktreePath();
    expect(worktreePath).toBeDefined();
    expect(fs.existsSync(worktreePath!)).toBe(true);

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
    expect(fs.existsSync(worktreePath!)).toBe(false);
    // Only the main worktree (the repo itself) is left registered: the
    // probe's own worktree was removed as part of the SIGTERM cleanup.
    const list = worktreeList(repo);
    expect(list.split("\n\n").filter((b) => b.trim().length > 0)).toHaveLength(
      1,
    );

    const countAtExit = fs.readFileSync(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const countAfterSettling = fs.readFileSync(heartbeat, "utf8");
    expect(countAfterSettling).toBe(countAtExit);
  }, 20000);

  it("a leftover worktree marker (simulating a SIGKILL) is recovered by the next invocation on the same repository", async () => {
    useLockDir();
    const { repo } = initRepo();

    // Build a real leftover worktree by hand (what a SIGKILL mid-run
    // would leave: the worktree registered and on disk at the probe's
    // own scratch shape under its log dir, a marker recording its path
    // and that log dir, keyed on the repository root, with a dead pid).
    const staleLogDir = makeTmpDir();
    const stalePath = path.join(staleLogDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    const staleAdd = spawnSync(
      "git",
      ["worktree", "add", "--detach", "--", stalePath, "HEAD"],
      { cwd: repo },
    );
    expect(staleAdd.status).toBe(0);

    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");
    const realRoot = resolveDeepestExisting(repo);
    writeMarker(realRoot, {
      targetPath: stalePath,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid,
      timestamp: new Date().toISOString(),
      scratchRoot: staleLogDir,
    });

    const result = await probe(baseOptions(repo));

    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    // The stale worktree itself is gone (removed as part of recovery).
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  });

  it("removes the stale-worktree marker once recovery succeeds, even when this run's own new worktree attempt then fails before it writes its own marker: the inverted condition (`if (!staleWt)`) would leave the already-recovered marker behind instead", async () => {
    // `session.ts`'s `prepareWorktreeSession` recovers a leftover from a
    // previous run, then always starts a fresh worktree for THIS run;
    // that fresh attempt's own `onWorktreeAttempt` immediately writes a
    // new marker, which would mask a broken removal of the OLD one by
    // simply overwriting it. Forcing `beginWorktree` to fail before it
    // ever reaches `onWorktreeAttempt` (mirroring its real
    // `writeScratchOwner`-throws early-failure path) removes that mask:
    // whether the old marker is still there afterward depends only on
    // whether the recovery's own removal ran.
    useLockDir();
    const { repo } = initRepo();

    const staleLogDir = makeTmpDir();
    const stalePath = path.join(staleLogDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    const staleAdd = spawnSync(
      "git",
      ["worktree", "add", "--detach", "--", stalePath, "HEAD"],
      { cwd: repo },
    );
    expect(staleAdd.status).toBe(0);

    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");
    const realRoot = resolveDeepestExisting(repo);
    writeMarker(realRoot, {
      targetPath: stalePath,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid,
      timestamp: new Date().toISOString(),
      scratchRoot: staleLogDir,
    });

    // `mockImplementationOnce` overrides exactly the one call this run
    // makes; every later call (a later test in this file, this same
    // test's own cleanup) falls back to the module's own call-through
    // default (`vi.fn(actual.beginWorktree)`, set once in the `vi.mock`
    // factory above), so nothing here needs to be restored afterward.
    vi.mocked(beginWorktree).mockImplementationOnce(async () => ({
      ok: false,
      reason: "worktree_sync_failed",
      detail: "stub: forced failure before onWorktreeAttempt",
      logPaths: [],
    }));

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("inconclusive");
    // The old leftover was already recovered (removed) before this
    // run's own new-worktree attempt ever ran, let alone failed.
    expect(fs.existsSync(stalePath)).toBe(false);
    // The correct code removed the recovered marker at recovery time;
    // this run's own stub failure never wrote a new one over it. The
    // inverted-condition mutant skips that removal, so the marker
    // recovery already made obsolete (still naming the now-deleted
    // `stalePath`) would still be sitting on disk here.
    expect(readMarkerFor(realRoot)).toBeUndefined();
  });

  it("writes no worktree marker at all for a normal run that had none to recover (negative control)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);

    expect(readMarkerFor(realRoot)).toBeUndefined();

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
  });

  it("a leftover worktree marker is recovered whatever its pid says, even an alive one, once the lock has already ruled out a live probe of its own for this repository", async () => {
    useLockDir();
    const { repo } = initRepo();

    // Same shape as the test above, but with an ALIVE pid (this
    // process's own) under a timestamp far in the past: the
    // repository-keyed worktree marker's own `pid` field is never
    // consulted by this recovery path (see `probe/session.ts`'s
    // stale-worktree recovery), on the same reasoning `doctor`'s
    // `stale-worktree` check now applies its own bound for -- a pid
    // that still resolves to *something* proves nothing about whether
    // THIS marker's probe is still running, and the lock already
    // excludes a second live probe on this repository under this lock
    // directory regardless.
    const staleLogDir = makeTmpDir();
    const stalePath = path.join(staleLogDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    const staleAdd = spawnSync(
      "git",
      ["worktree", "add", "--detach", "--", stalePath, "HEAD"],
      { cwd: repo },
    );
    expect(staleAdd.status).toBe(0);

    const realRoot = resolveDeepestExisting(repo);
    writeMarker(realRoot, {
      targetPath: stalePath,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: process.pid,
      timestamp: "2020-01-01T00:00:00.000Z",
      scratchRoot: staleLogDir,
    });

    const result = await probe(baseOptions(repo));

    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  });

  it("a leftover whose registration is still `locked initializing` (the add died with the process) is recovered by the next invocation", async () => {
    useLockDir();
    const { repo } = initRepo();
    const staleLogDir = makeTmpDir();
    const stalePath = path.join(staleLogDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    git(repo, ["worktree", "add", "--detach", "--", stalePath, "HEAD"]);
    const adminDir = path.join(repo, ".git", "worktrees");
    const [adminEntry] = fs.readdirSync(adminDir);
    fs.writeFileSync(path.join(adminDir, adminEntry, "locked"), "initializing");
    expect(worktreeList(repo)).toContain("locked initializing");
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");
    const realRoot = resolveDeepestExisting(repo);
    writeMarker(realRoot, {
      targetPath: stalePath,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid,
      timestamp: new Date().toISOString(),
      scratchRoot: staleLogDir,
    });

    const result = await probe(baseOptions(repo));

    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  });

  it("a registered worktree of the scratch shape with no marker at all is still recovered by the next invocation", async () => {
    useLockDir();
    const { repo } = initRepo();
    const stalePath = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    git(repo, ["worktree", "add", "--detach", "--", stalePath, "HEAD"]);
    const realRoot = resolveDeepestExisting(repo);
    expect(readMarkerFor(realRoot)).toBeUndefined();

    const result = await probe(baseOptions(repo));

    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  });

  it("a marker naming a directory outside the scratch shape is refused: nothing is deleted, the marker stays, and the run reports it", async () => {
    useLockDir();
    const { repo } = initRepo();
    const outside = path.join(makeTmpDir(), "somebody-elses-directory");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "precious.txt"), "keep me\n");
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");
    const realRoot = resolveDeepestExisting(repo);
    writeMarker(realRoot, {
      targetPath: outside,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid,
      timestamp: new Date().toISOString(),
      scratchRoot: path.dirname(outside),
    });

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("stale_worktree");
    expect(
      result.warnings.some(
        (w) => w.includes(outside) && w.includes(markerFilePathFor(realRoot)),
      ),
    ).toBe(true);
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe(
      "keep me\n",
    );
    expect(readMarkerFor(realRoot)).toBeDefined();
    // Nothing of this run's own was started either: no worktree added.
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  });

  it("a marker naming the operator's own registered worktree is refused: it stays registered and intact", async () => {
    useLockDir();
    const { repo } = initRepo();
    const own = path.join(makeTmpDir(), "feature-branch");
    git(repo, ["worktree", "add", "--detach", "--", own, "HEAD"]);
    fs.writeFileSync(path.join(own, "work-in-progress.txt"), "uncommitted\n");
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");
    const realRoot = resolveDeepestExisting(repo);
    writeMarker(realRoot, {
      targetPath: own,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid,
      timestamp: new Date().toISOString(),
      scratchRoot: path.dirname(own),
    });

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("stale_worktree");
    expect(worktreeList(repo)).toContain(resolveDeepestExisting(own));
    expect(
      fs.readFileSync(path.join(own, "work-in-progress.txt"), "utf8"),
    ).toBe("uncommitted\n");
    expect(readMarkerFor(realRoot)).toBeDefined();
  });

  it("a removal at the end of a run that does not take keeps the marker and warns with the path and the manual command", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    // Neither the removal nor the prune runs: the registration is left
    // behind on purpose, the way a git that refuses would leave it.
    mockRun.mockImplementation(async (file, args, options) => {
      if (
        file === "git" &&
        args[0] === "worktree" &&
        (args[1] === "remove" || args[1] === "prune")
      ) {
        return {
          exitCode: 128,
          durationMs: 0,
          stdout: "",
          stderr: "shimmed: did not run",
          logPath: path.join(options.logDir, "shimmed.log"),
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          logWriteFailed: false,
          stdioClosed: true,
        };
      }
      return actualRun.runArgv(file, args, options);
    });

    try {
      const result = await probe(baseOptions(repo));
      const worktreePath = result.isolation.path as string;

      // The verdict stands: the cleanup is best-effort.
      expect(result.status).toBe("killed");
      expect(readMarkerFor(realRoot)?.targetPath).toBe(worktreePath);
      expect(
        result.warnings.some(
          (w) =>
            w.includes(`the worktree at ${worktreePath} was not removed`) &&
            w.includes(
              `git -C ${realRoot} worktree remove --force --force -- ${worktreePath}`,
            ),
        ),
      ).toBe(true);
      // Still registered (git's own removal never ran); the directory
      // itself is gone, deleted for a path the gate admitted.
      expect(worktreeList(repo)).toContain(
        resolveDeepestExisting(worktreePath),
      );
      expect(fs.existsSync(worktreePath)).toBe(false);
    } finally {
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
      );
      git(repo, ["worktree", "prune"]);
    }
  });
});

describe("probe(): worktree isolation, the removal waits for a sync step that outlives the handler's own settle wait", () => {
  it("git worktree list/remove start only after the sync's in-flight git call has settled, even when the handler gave up waiting for it", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, "extra.txt"), "untracked\n");
    const savedBound = process.env.AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS;
    process.env.AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS = "50";
    const events: string[] = [];
    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    mockRun.mockImplementation(async (file, args, options) => {
      if (file === "git" && args[0] === "ls-files") {
        events.push("sync:ls-files:started");
        // The signal lands while this call is in flight, and the call
        // does not die with it: the abort signal is withheld from the
        // real runner and the result reports `aborted: false`, so the
        // sync behaves like a git child the handler's kill never
        // reached, still running long after the handler's 50 ms wait
        // for it has expired.
        process.emit("SIGTERM" as never);
        const { signal: _withheld, ...withoutSignal } = options;
        const result = await actualRun.runArgv(file, args, withoutSignal);
        await new Promise((resolve) => setTimeout(resolve, 300));
        events.push("sync:ls-files:settled");
        return { ...result, aborted: false };
      }
      // The recovery step lists worktrees before the sync starts; only
      // the calls after the sync's own call are the cleanup's.
      if (
        file === "git" &&
        args[0] === "worktree" &&
        args[1] !== "add" &&
        events.includes("sync:ls-files:started")
      ) {
        events.push(`cleanup:${args[1]}:started`);
      }
      return actualRun.runArgv(file, args, options);
    });

    try {
      const result = await probe(baseOptions(repo));

      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("aborted");
      const settled = events.indexOf("sync:ls-files:settled");
      const firstCleanup = events.findIndex((e) => e.startsWith("cleanup:"));
      expect(settled).toBeGreaterThanOrEqual(0);
      expect(firstCleanup).toBeGreaterThan(settled);
      expect(events).toContain("cleanup:remove:started");
      expect(
        worktreeList(repo)
          .split("\n\n")
          .filter((b) => b.trim().length > 0),
      ).toHaveLength(1);
    } finally {
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
      );
      if (savedBound === undefined) {
        delete process.env.AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS;
      } else {
        process.env.AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS = savedBound;
      }
    }
  });
});

describe("probe(): worktree isolation, a signal landing while the worktree is still being synced", () => {
  /** sha256 of every file in the original tree that this section
   * asserts is left untouched, keyed by relative path. */
  function treeHashes(
    repo: string,
    relPaths: string[],
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rel of relPaths) {
      out[rel] = createHash("sha256")
        .update(fs.readFileSync(path.join(repo, rel)))
        .digest("hex");
    }
    return out;
  }

  async function waitFor(
    predicate: () => boolean,
    what: string,
    timeoutMs = 20000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`${what} never happened`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** The path of this run's scratch subdirectory content, once it
   * exists: `<logDir>/wt-<random>/<name>`. */
  function scratchPath(logDir: string, name: string): string | undefined {
    for (const entry of fs.readdirSync(logDir)) {
      if (!entry.startsWith("wt-")) continue;
      const candidate = path.join(logDir, entry, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  /** The `--pre`/`-t` exec logs this run wrote directly into `--log-dir`
   * (the sync's own git logs live in its scratch subdirectory instead).
   * Empty means the run never got past the sync, which is what makes an
   * assertion about a signal landing mid-sync say what it claims. */
  function execLogs(logDir: string): string[] {
    return fs.readdirSync(logDir).filter((f) => f.startsWith("exec-"));
  }

  /** Spawns the CLI worktree probe under a pinned lock dir and log dir,
   * with stdout captured so the signal contract (no envelope on a
   * signalled run) can be asserted. */
  function spawnProbe(
    repo: string,
    lockDir: string,
    logDir: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ): { child: ReturnType<typeof spawn>; stdout: () => string } {
    let stdout = "";
    const child = spawn(
      "node",
      [
        CLI_PATH,
        "probe",
        "--file",
        "fixture.js",
        "-n",
        "2",
        "-r",
        "  return false;",
        "-t",
        "node fixture.test.js",
        "-i",
        "worktree",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          AGENT_PRIMITIVES_LOCK_DIR: lockDir,
          AGENT_PRIMITIVES_LOG_DIR: logDir,
          // git's own messages are read back from its log below; a
          // fixed locale keeps them the messages this file expects.
          LC_ALL: "C",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    return { child, stdout: () => stdout };
  }

  /** A repository with a tracked change big enough that `git diff HEAD
   * --binary` runs for hundreds of milliseconds. The committed blob is
   * one byte; the incompressible content is written into the working
   * tree here, never checked in. */
  function makeSlowDiffRepo(): string {
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, "big.bin"), "x");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "big"]);
    fs.writeFileSync(path.join(repo, "big.bin"), randomBytes(40 * 1024 * 1024));
    return repo;
  }

  it("SIGTERM during the tracked-diff capture exits 143 with no output, removes the worktree, and leaves no marker, no lock, and the original tree untouched", async () => {
    const lockDir = useLockDir();
    const repo = makeSlowDiffRepo();
    const logDir = makeTmpDir();
    const before = treeHashes(repo, [
      "fixture.js",
      "fixture.test.js",
      "big.bin",
    ]);

    const { child, stdout } = spawnProbe(repo, lockDir, logDir);
    // `git diff --output=<path>` creates that file as it starts, so its
    // appearance is the sync's diff phase actually running: no fixed
    // sleep decides when the signal lands.
    await waitFor(
      () => scratchPath(logDir, "tracked.diff") !== undefined,
      "the tracked diff started",
    );
    const diffPath = scratchPath(logDir, "tracked.diff")!;
    const worktreePath = path.join(path.dirname(diffPath), "wt");
    expect(fs.existsSync(worktreePath)).toBe(true);

    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );

    expect(exitCode).toBe(143);
    expect(stdout()).toBe("");
    // The signal really did land inside the sync: nothing had run a
    // baseline command yet.
    expect(execLogs(logDir)).toEqual([]);
    // The worktree is gone from disk and from git's registry.
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
    const { resolveDeepestExisting } =
      await import("../src/probe/containment.js");
    const realRoot = resolveDeepestExisting(repo);
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
    expect(
      treeHashes(repo, ["fixture.js", "fixture.test.js", "big.bin"]),
    ).toEqual(before);
    // No git child outlived the exit: the interrupted diff of a 40 MB
    // change would still be writing into this file if it had.
    const sizeAtExit = fs.statSync(diffPath).size;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fs.statSync(diffPath).size).toBe(sizeAtExit);
  }, 40000);

  it("SIGTERM during the untracked-file copy exits 143 with no output, removes the worktree, and leaves no marker, no lock, and the original tree untouched", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const many = path.join(repo, "many");
    fs.mkdirSync(many, { recursive: true });
    for (let i = 0; i < 6000; i += 1) {
      fs.writeFileSync(
        path.join(many, `u-${String(i).padStart(5, "0")}.txt`),
        "x".repeat(64),
      );
    }
    const logDir = makeTmpDir();
    const before = treeHashes(repo, ["fixture.js", "fixture.test.js"]);

    const { child, stdout } = spawnProbe(repo, lockDir, logDir);
    // The first of the 6000 entries appearing inside the worktree is the
    // copy phase being under way, with the rest of it still ahead.
    await waitFor(
      () => scratchPath(logDir, "wt") !== undefined,
      "the worktree was created",
    );
    const worktreePath = scratchPath(logDir, "wt")!;
    await waitFor(
      () => fs.existsSync(path.join(worktreePath, "many", "u-00000.txt")),
      "the untracked copy started",
    );
    // `git ls-files` sorts, so the last of the 6000 entries is copied
    // last: its absence is this phase still being under way at the
    // moment the signal is sent, not a run that had already finished
    // syncing and would exit the same way for unrelated reasons.
    expect(fs.existsSync(path.join(worktreePath, "many", "u-05999.txt"))).toBe(
      false,
    );

    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );

    expect(exitCode).toBe(143);
    expect(stdout()).toBe("");
    // The signal really did land inside the sync: nothing had run a
    // baseline command yet.
    expect(execLogs(logDir)).toEqual([]);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
    const { resolveDeepestExisting } =
      await import("../src/probe/containment.js");
    const realRoot = resolveDeepestExisting(repo);
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
    expect(treeHashes(repo, ["fixture.js", "fixture.test.js"])).toEqual(before);
  }, 40000);

  it("SIGKILL during the tracked-diff capture leaves a marker at the repository key that doctor reports and the next probe recovers", async () => {
    const lockDir = useLockDir();
    const repo = makeSlowDiffRepo();
    const logDir = makeTmpDir();

    const { child } = spawnProbe(repo, lockDir, logDir);
    await waitFor(
      () => scratchPath(logDir, "tracked.diff") !== undefined,
      "the tracked diff started",
    );
    const worktreePath = path.join(
      path.dirname(scratchPath(logDir, "tracked.diff")!),
      "wt",
    );

    // SIGKILL, not SIGTERM: no handler runs, so nothing cleans up. The
    // marker written right after `git worktree add` succeeded is the
    // only trail left, and this is what it is for.
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    const { resolveDeepestExisting } =
      await import("../src/probe/containment.js");
    const realRoot = resolveDeepestExisting(repo);
    const marker = readMarkerFor(realRoot);
    expect(marker).toBeDefined();
    expect(marker!.targetPath).toBe(worktreePath);
    expect(execLogs(logDir)).toEqual([]);
    // The leftover really is registered: asserted before the recovery
    // steps, so a regression that never created one reads as that.
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(2);

    const { doctor } = await import("../src/doctor/index.js");
    const doctorResult = await doctor({ cwd: repo, lockDir });
    const staleWorktreeCheck = doctorResult.checks.find(
      (c) => c.name === "stale-worktree",
    );
    expect(staleWorktreeCheck?.ok).toBe(false);
    expect(staleWorktreeCheck?.detail).toContain(worktreePath);

    // The next probe on this repository recovers it and reaches a normal
    // verdict. The big working-tree change is dropped first: it is the
    // slow-diff device of this test, not part of what recovery proves.
    fs.rmSync(path.join(repo, "big.bin"), { force: true });
    git(repo, ["checkout", "--", "big.bin"]);
    const result = await probe(baseOptions(repo, { logDir }));
    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(worktreePath)).toBe(false);
  }, 40000);

  /** A repository whose checkout has enough files that `git worktree
   * add` runs for hundreds of milliseconds, generated here and never
   * checked in, with one more device on top: the first of those files
   * carries a smudge filter that reports it has started (by creating
   * the file named in `SMUDGE_STARTED`) and then blocks. A signal sent
   * once that file exists lands while git is provably inside the
   * checkout, with the worktree registered, locked, and partly on
   * disk, rather than at whatever point a poll happened to catch. The
   * next probe on the repository has to run with the filter set back
   * to `cat` (see `releaseGate`). */
  function makeSlowAddRepo(): string {
    const { repo } = initRepo();
    const many = path.join(repo, "many");
    fs.mkdirSync(many, { recursive: true });
    for (let i = 0; i < 3000; i += 1) {
      fs.writeFileSync(
        path.join(many, `f-${String(i).padStart(5, "0")}.txt`),
        "x".repeat(64),
      );
    }
    fs.writeFileSync(
      path.join(repo, ".gitattributes"),
      "many/f-00000.txt filter=gate\n",
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "many"]);
    // The started-file path travels via an env var, never interpolated
    // into the command string.
    git(repo, [
      "config",
      "filter.gate.smudge",
      'touch "$SMUDGE_STARTED" && sleep 30 && cat',
    ]);
    return repo;
  }

  function releaseGate(repo: string): void {
    git(repo, ["config", "filter.gate.smudge", "cat"]);
  }

  /** Resolves once the gated checkout has reached its blocking filter:
   * `git worktree add` is then inside the checkout for certain. */
  async function waitForGate(startedPath: string): Promise<void> {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(startedPath)) {
      if (Date.now() > deadline) throw new Error("the checkout never started");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /** The pid of the `git worktree add` child the spawned CLI has
   * running, read from the process table (`/proc` on Linux, `ps`
   * elsewhere). The CLI starts it in a process group of its own, so a
   * `SIGKILL` to the CLI alone leaves it running: it then completes,
   * and git tidies up after itself, or dies on its closed output pipe
   * and its own junk handler does the same. A leftover of the kind a
   * crash of the whole process tree leaves (registered, locked, on
   * disk) needs the git child killed as well. */
  function gitAddChildOf(cliPid: number): number | undefined {
    if (process.platform === "linux") {
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^[0-9]+$/.test(entry)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
          const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (Number(afterComm[1]) !== cliPid) continue;
          const argv = fs
            .readFileSync(`/proc/${entry}/cmdline`, "utf8")
            .split("\0");
          if (argv.includes("worktree") && argv.includes("add")) {
            return Number(entry);
          }
        } catch {
          // The process ended between the listing and the read.
        }
      }
      return undefined;
    }
    const table = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
      encoding: "utf8",
    });
    for (const line of table.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match || Number(match[2]) !== cliPid) continue;
      if (/\bworktree\b/.test(match[3]) && /\badd\b/.test(match[3])) {
        return Number(match[1]);
      }
    }
    return undefined;
  }

  /** Kills the CLI and then the whole process group of its `git
   * worktree add` child, once that add is blocked inside its checkout:
   * the state a crash of the whole tree leaves behind. */
  async function crashDuringAdd(
    child: ReturnType<typeof spawn>,
    startedPath: string,
  ): Promise<void> {
    await waitForGate(startedPath);
    const gitPid = gitAddChildOf(child.pid!);
    expect(gitPid).toBeDefined();
    child.kill("SIGKILL");
    process.kill(-gitPid!, "SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  }

  /** This run's scratch directory under `logDir` (`wt-<random>`), which
   * survives the cleanup: only the worktree inside it is removed. */
  function scratchDir(logDir: string): string {
    const entries = fs.readdirSync(logDir).filter((e) => e.startsWith("wt-"));
    expect(entries).toHaveLength(1);
    return path.join(logDir, entries[0]);
  }

  it("SIGTERM while git worktree add is running exits 143 with no output and leaves no registration, nothing on disk, no marker, and no lock", async () => {
    const lockDir = useLockDir();
    const repo = makeSlowAddRepo();
    const logDir = makeTmpDir();

    const started = path.join(makeTmpDir(), "smudge-started");
    const { child, stdout } = spawnProbe(repo, lockDir, logDir, {
      SMUDGE_STARTED: started,
    });
    await waitForGate(started);
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );

    expect(exitCode).toBe(143);
    expect(stdout()).toBe("");
    // The add really was cut short: git prints this line only once the
    // checkout has completed, and the diff phase never started.
    const scratch = scratchDir(logDir);
    expect(
      fs.readFileSync(path.join(scratch, "worktree-add.log"), "utf8"),
    ).not.toContain("HEAD is now at");
    expect(fs.existsSync(path.join(scratch, "tracked.diff"))).toBe(false);
    expect(execLogs(logDir)).toEqual([]);
    // Nothing registered (the locked entry an interrupted add leaves is
    // cleared too), nothing on disk, no marker, the lock released.
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
    expect(fs.existsSync(path.join(scratch, "wt"))).toBe(false);
    expect(readMarkerFor(resolveDeepestExisting(repo))).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
  }, 40000);

  it("a crash while git worktree add is running leaves the marker written before the add, which doctor reports and the next probe recovers", async () => {
    const lockDir = useLockDir();
    const repo = makeSlowAddRepo();
    const logDir = makeTmpDir();
    const realRoot = resolveDeepestExisting(repo);

    const started = path.join(makeTmpDir(), "smudge-started");
    const { child } = spawnProbe(repo, lockDir, logDir, {
      SMUDGE_STARTED: started,
    });
    await crashDuringAdd(child, started);

    const scratch = scratchDir(logDir);
    const worktreePath = path.join(scratch, "wt");
    expect(
      fs.readFileSync(path.join(scratch, "worktree-add.log"), "utf8"),
    ).not.toContain("HEAD is now at");
    // The marker was written before the add ran, so it is here even
    // though the add never returned; it names the path and the log dir.
    const marker = readMarkerFor(realRoot);
    expect(marker).toBeDefined();
    expect(marker!.targetPath).toBe(worktreePath);
    expect(marker!.scratchRoot).toBe(path.resolve(logDir));
    // The leftover really is registered (locked, as an interrupted add
    // leaves it): asserted before the recovery steps, so a regression
    // that never created one reads as that.
    expect(worktreeList(repo)).toContain("locked initializing");
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(2);

    const { doctor } = await import("../src/doctor/index.js");
    const doctorResult = await doctor({
      cwd: repo,
      lockDir,
      required: [],
      optional: [],
    });
    const staleWorktreeCheck = doctorResult.checks.find(
      (c) => c.name === "stale-worktree",
    );
    expect(staleWorktreeCheck?.ok).toBe(false);
    expect(staleWorktreeCheck?.detail).toContain(worktreePath);
    expect(staleWorktreeCheck?.detail).toContain("remove --force --force");

    releaseGate(repo);
    const result = await probe(baseOptions(repo, { logDir }));
    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  }, 40000);

  it("a crash while git worktree add is running, with the marker then deleted by hand: doctor still reports the registration and the next probe still recovers", async () => {
    const lockDir = useLockDir();
    const repo = makeSlowAddRepo();
    const logDir = makeTmpDir();
    const realRoot = resolveDeepestExisting(repo);

    const started = path.join(makeTmpDir(), "smudge-started");
    const { child } = spawnProbe(repo, lockDir, logDir, {
      SMUDGE_STARTED: started,
    });
    await crashDuringAdd(child, started);

    const worktreePath = path.join(scratchDir(logDir), "wt");
    expect(readMarkerFor(realRoot)).toBeDefined();
    removeMarkerFor(realRoot);
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(worktreeList(repo)).toContain("locked initializing");
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(2);

    const { doctor } = await import("../src/doctor/index.js");
    const doctorResult = await doctor({
      cwd: repo,
      lockDir,
      required: [],
      optional: [],
    });
    const staleWorktreeCheck = doctorResult.checks.find(
      (c) => c.name === "stale-worktree",
    );
    expect(staleWorktreeCheck?.ok).toBe(false);
    expect(staleWorktreeCheck?.detail).toContain(
      resolveDeepestExisting(worktreePath),
    );

    releaseGate(repo);
    const result = await probe(baseOptions(repo, { logDir }));
    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  }, 40000);
});

describe("probe(): worktree isolation, a reused --log-dir never replays a previous run", () => {
  it("two probes sharing one --log-dir each get their own scratch subdirectory (not one fixed name reused)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const sharedLogDir = makeTmpDir();

    const result1 = await probe(baseOptions(repo, { logDir: sharedLogDir }));
    expect(result1.status).toBe("killed");
    const result2 = await probe(baseOptions(repo, { logDir: sharedLogDir }));
    expect(result2.status).toBe("killed");

    const subdirs = fs
      .readdirSync(sharedLogDir)
      .filter((e) => e.startsWith("wt-"));
    expect(subdirs.length).toBe(2);
  });

  it("refuses to reuse a pre-existing tracked-diff scratch file (a run-id collision) rather than silently replaying it", async () => {
    useLockDir();
    const { repo } = initRepo();
    const logDir = makeTmpDir();
    const fixedId = "11111111-1111-1111-1111-111111111111";
    const mockUuid = vi.mocked(randomUUID);
    mockUuid.mockReturnValue(fixedId as ReturnType<typeof randomUUID>);

    // Pre-seed the exact scratch file this run's `beginWorktree` call
    // will compute (given the pinned run id above), with content from
    // an imagined "previous run": exactly the collision the pre-existing
    // check refuses instead of silently treating as this run's own.
    const staleDiffPath = path.join(logDir, `wt-${fixedId}`, "tracked.diff");
    fs.mkdirSync(path.dirname(staleDiffPath), { recursive: true });
    fs.writeFileSync(staleDiffPath, "stale content from an earlier run\n");

    try {
      const result = await probe(baseOptions(repo, { logDir }));
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("worktree_sync_failed");
      // Refused before ever being touched: neither read as this run's
      // own diff nor overwritten.
      expect(fs.readFileSync(staleDiffPath, "utf8")).toBe(
        "stale content from an earlier run\n",
      );
    } finally {
      mockUuid.mockReset();
      mockUuid.mockImplementation(
        (await vi.importActual<typeof import("node:crypto")>("node:crypto"))
          .randomUUID,
      );
    }
  });
});

describe("probe(): worktree isolation, argv-only git calls (no shell injection)", () => {
  it("a --log-dir containing shell metacharacters is passed to git as an opaque argv element, never executed", async () => {
    useLockDir();
    const { repo } = initRepo();
    const base = makeTmpDir();
    const logDir = path.join(base, "$(touch PWNED)x");

    const result = await probe(baseOptions(repo, { logDir }));

    expect(result.status).toBe("killed");
    // Every git call in isolation.ts runs with `cwd: root` (the
    // repository), so a shell that DID expand this would create PWNED
    // there, not under `--log-dir` itself or this process's own cwd;
    // checked in all three places nothing was ever created anywhere.
    expect(fs.existsSync(path.join(repo, "PWNED"))).toBe(false);
    expect(fs.existsSync(path.join(base, "PWNED"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "PWNED"))).toBe(false);
  });
});

describe("probe(): worktree isolation, tracked-diff sync preserves non-UTF-8 bytes", () => {
  it("a non-UTF-8 byte in a non-target tracked file survives the sync byte for byte (never routed through a UTF-8-decoding capture)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const otherFile = path.join(repo, "other.bin");
    fs.writeFileSync(otherFile, "committed\n");
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "other file",
    ]);
    // A lone UTF-8 continuation byte (0x80): never valid on its own, so
    // decoding as UTF-8 and re-encoding would replace it with U+FFFD,
    // changing both the bytes and the hash.
    const binaryContent = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x80, 0x0d, 0x0a,
    ]);
    fs.writeFileSync(otherFile, binaryContent);
    const expectedSha = createHash("sha256")
      .update(binaryContent)
      .digest("hex");

    const shaOutDir = makeTmpDir();
    const shaOutPath = path.join(shaOutDir, "sha-out.txt");
    const previousEnv = process.env.SHA_OUT_PATH;
    process.env.SHA_OUT_PATH = shaOutPath;
    try {
      const result = await probe(
        baseOptions(repo, {
          preCommand:
            "node -e \"const fs=require('fs'),crypto=require('crypto');" +
            "const h=crypto.createHash('sha256').update(fs.readFileSync('other.bin')).digest('hex');" +
            'fs.writeFileSync(process.env.SHA_OUT_PATH, h);"',
        }),
      );
      expect(result.status).toBe("killed");
      expect(fs.readFileSync(shaOutPath, "utf8")).toBe(expectedSha);
    } finally {
      if (previousEnv === undefined) delete process.env.SHA_OUT_PATH;
      else process.env.SHA_OUT_PATH = previousEnv;
    }
  });
});

describe("probe(): worktree isolation, untracked entries by type", () => {
  it("a nested repository directory is skipped with a warning instead of aborting the sync", async () => {
    useLockDir();
    const { repo } = initRepo();
    const nestedDir = path.join(repo, "vendor", "nested-repo");
    fs.mkdirSync(nestedDir, { recursive: true });
    git(nestedDir, ["init", "-q"]);
    fs.writeFileSync(path.join(nestedDir, "file.txt"), "nested\n");

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("killed");
    expect(
      result.warnings.some(
        (w) =>
          w.includes("nested repository") &&
          w.includes(path.join("vendor", "nested-repo")),
      ),
    ).toBe(true);
  });

  it("a valid untracked symlink and a dangling one are both recreated as symlinks (not copied as files), neither aborting the sync", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, "link-target.txt"), "target\n");
    fs.symlinkSync("link-target.txt", path.join(repo, "valid-link.txt"));
    fs.symlinkSync("does-not-exist.txt", path.join(repo, "dangling-link.txt"));

    const outDir = makeTmpDir();
    const outPath = path.join(outDir, "link-check.json");
    const previousEnv = process.env.LINK_CHECK_OUT_PATH;
    process.env.LINK_CHECK_OUT_PATH = outPath;
    try {
      const result = await probe(
        baseOptions(repo, {
          preCommand:
            "node -e \"const fs=require('fs');" +
            "const valid=fs.lstatSync('valid-link.txt').isSymbolicLink();" +
            "const dangling=fs.lstatSync('dangling-link.txt').isSymbolicLink();" +
            'fs.writeFileSync(process.env.LINK_CHECK_OUT_PATH, JSON.stringify({valid,dangling}));"',
        }),
      );

      expect(result.status).toBe("killed");
      expect(result.reason).toBeUndefined();
      const linkCheck = JSON.parse(fs.readFileSync(outPath, "utf8"));
      expect(linkCheck).toEqual({ valid: true, dangling: true });
    } finally {
      if (previousEnv === undefined) delete process.env.LINK_CHECK_OUT_PATH;
      else process.env.LINK_CHECK_OUT_PATH = previousEnv;
    }
  });

  it("an untracked ABSOLUTE symlink that resolves outside the copy is still recreated, with a warning naming it and where it resolves", async () => {
    useLockDir();
    const { repo } = initRepo();
    const repoReal = resolveDeepestExisting(repo);
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "real.txt"), "real\n");
    // Untracked and absolute: the copy recreates the same symlink the
    // source tree has, which still resolves into the real repository
    // rather than into the copy. No `--pre` here writes through it: the
    // warning, not a byte-identical write-through demonstration, is
    // what this fixture is about.
    fs.symlinkSync(path.join(repoReal, "src"), path.join(repo, "docs"), "dir");

    const before = hashTree(repo);
    const result = await probe(baseOptions(repo));
    const after = hashTree(repo);

    expect(after).toEqual(before);
    expect(result.status).toBe("killed");
    expect(
      result.warnings.some(
        (w) =>
          w.includes("docs") &&
          w.includes(`resolves to ${path.join(repoReal, "src")}`) &&
          w.includes("outside the isolation copy"),
      ),
    ).toBe(true);
  });

  it("an untracked DANGLING symlink whose target sits outside the copy still warns, even though the target does not exist yet: the containment check runs on the link's own target, not on the recreated link (which realpath cannot follow through a missing target and would otherwise read back as trivially contained)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const repoReal = resolveDeepestExisting(repo);
    const escapedFile = path.join(repoReal, "created-by-pre.txt");
    // Untracked, absolute, and DANGLING: nothing named
    // "created-by-pre.txt" exists in the source tree yet, so the
    // recreated link's own realpath cannot be followed at all.
    fs.symlinkSync(escapedFile, path.join(repo, "docs"));

    const result = await probe(
      baseOptions(repo, {
        preCommand:
          "node -e \"require('fs').writeFileSync('docs', 'ESCAPED')\"",
      }),
    );

    try {
      // The `--pre` wrote through the recreated symlink, which still
      // points at the real repository: the copy carries the same
      // dangling link the source tree has, and this fixture's whole
      // point is that the escape happened -- the warning, not
      // prevention, is the deliverable.
      expect(fs.readFileSync(escapedFile, "utf8")).toBe("ESCAPED");
      expect(result.status).toBe("killed");
      expect(
        result.warnings.some(
          (w) =>
            w.includes("docs") &&
            w.includes(`resolves to ${escapedFile}`) &&
            w.includes("outside the isolation copy"),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(escapedFile, { force: true });
    }
  });

  it("an untracked RELATIVE symlink whose target escapes through '..' still warns, with the probe's own --log-dir placed inside the repository (the relative target is resolved against the link's own real directory in the copy, not against the log dir)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const repoReal = resolveDeepestExisting(repo);
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "real.txt"), "real\n");
    // Climbs from the copy (three directories below an in-repo
    // `--log-dir`: `<log-dir>/wt-<uuid>/wt`) back up to the repository
    // root, then back down into `src` -- landing on the source tree's
    // own directory rather than the copy's.
    fs.symlinkSync(path.join("..", "..", "..", "src"), path.join(repo, "docs"));
    const logDir = path.join(repo, "probe-logs-rel-escape");
    fs.mkdirSync(logDir, { recursive: true });

    const result = await probe(baseOptions(repo, { logDir }));

    // No `--pre` here writes through the link: the log dir sits inside
    // the repository for this fixture (so its own scratch output is
    // itself part of the tree), which is exactly why a whole-tree hash
    // comparison would be the wrong check -- `src/real.txt` unchanged is
    // the property this fixture is actually about.
    expect(fs.readFileSync(path.join(repo, "src", "real.txt"), "utf8")).toBe(
      "real\n",
    );
    expect(result.status).toBe("killed");
    expect(
      result.warnings.some(
        (w) =>
          w.includes("docs") &&
          w.includes(`resolves to ${path.join(repoReal, "src")}`) &&
          w.includes("outside the isolation copy"),
      ),
    ).toBe(true);
  });

  it("the probe's own --log-dir, when it sits inside the repository, is excluded from the untracked sync entirely", async () => {
    useLockDir();
    const { repo } = initRepo();
    const inRepoLogDir = path.join(repo, "scratch-logs");
    fs.mkdirSync(inRepoLogDir, { recursive: true });

    const result = await probe(baseOptions(repo, { logDir: inRepoLogDir }));

    expect(result.status).toBe("killed");
    // Nothing from the probe's own scratch space (its worktree, its
    // tracked-diff file, its exec logs) was ever treated as an
    // untracked source file to copy.
    expect(result.isolation.syncedUntrackedFiles).toBe(0);
  });

  it("an untracked plain directory entry is skipped with a warning naming it, neither walked nor mistaken for a nested repository", async () => {
    useLockDir();
    const { repo } = initRepo();
    const plainDir = path.join(repo, "plain-untracked-dir");
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, "inner.txt"), "hello\n");

    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    mockRun.mockImplementation(async (file, args, options) => {
      const result = await actualRun.runArgv(file, args, options);
      if (args[0] === "ls-files" && args.includes("--others")) {
        // Real `git ls-files --others --exclude-standard` never reports
        // a plain (non-repository) directory as its own entry: it lists
        // files, or a directory only at a nested `.git` boundary. The
        // entry is stubbed in here because that is the only way to
        // reach the skip-with-a-warning fallback this asserts.
        return { ...result, stdout: result.stdout + "plain-untracked-dir\0" };
      }
      return result;
    });

    try {
      const result = await probe(baseOptions(repo));
      // The entry is skipped, not walked and not copied, and the sync
      // continues to a normal verdict rather than failing over it.
      expect(result.status).toBe("killed");
      expect(
        result.warnings.some(
          (w) =>
            w.includes(
              "neither a regular file, a symlink, nor a nested repository",
            ) && w.includes("plain-untracked-dir"),
        ),
      ).toBe(true);
      expect(
        result.warnings.some((w) =>
          w.includes("skipped a nested repository directory"),
        ),
      ).toBe(false);
    } finally {
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
      );
    }
  });
});

describe("probe(): worktree isolation, a gitignored target is never synced", () => {
  it("--file that is gitignored yields a typed target_not_synced reason, not a raw ENOENT", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.js\n");
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "gitignore",
    ]);
    fs.writeFileSync(path.join(repo, "ignored.js"), FIXTURE_JS);

    const result = await probe(baseOptions(repo, { file: "ignored.js" }));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("target_not_synced");
  });
});

describe("probe(): worktree isolation, --allow-outside is rejected as a usage error", () => {
  it("--allow-outside combined with --isolation worktree is worktree_allow_outside_unsupported, not a raw path or hash failure", async () => {
    useLockDir();
    const { repo } = initRepo();
    const outsideDir = makeTmpDir();
    const outsideFile = path.join(outsideDir, "outside.js");
    fs.writeFileSync(outsideFile, FIXTURE_JS);

    const result = await probe(
      baseOptions(repo, {
        file: path.relative(repo, outsideFile),
        allowOutside: true,
      }),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("worktree_allow_outside_unsupported");
  });
});

describe("probe(): worktree isolation, a real SIGKILL leaves a recoverable marker", () => {
  it("SIGKILL to a CLI worktree probe mid-run leaves a marker at the repository key that doctor reports and the next probe recovers from", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const logDir = makeTmpDir();
    // Written OUTSIDE the worktree (an absolute path, via an env var):
    // the test command's own cwd is the worktree's copy, which is what
    // this test leaves leftover on disk by design (SIGKILL, no
    // cleanup) -- but the readiness signal itself must survive
    // independent of that.
    const readyDir = makeTmpDir();
    const ready = path.join(readyDir, "ready.txt");

    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.READY_ABS_PATH, 'running');",
        "setTimeout(() => { process.exit(0); }, 15000);",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "slow test",
    ]);

    const child = spawn(
      "node",
      [
        CLI_PATH,
        "probe",
        "--file",
        "fixture.js",
        "-n",
        "2",
        "-r",
        "  return false;",
        "-t",
        "node fixture.test.js",
        "-i",
        "worktree",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          AGENT_PRIMITIVES_LOCK_DIR: lockDir,
          AGENT_PRIMITIVES_LOG_DIR: logDir,
          READY_ABS_PATH: ready,
        },
        stdio: "ignore",
      },
    );

    const deadline = Date.now() + 15000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) {
        throw new Error("ready.txt never appeared before the deadline");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    // SIGKILL, not SIGTERM: bypasses this probe's own signal handler
    // entirely, so nothing here runs cleanup -- exactly the crash the
    // repository-keyed marker exists to recover from.
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    const { resolveDeepestExisting } =
      await import("../src/probe/containment.js");
    const realRoot = resolveDeepestExisting(repo);
    const marker = readMarkerFor(realRoot);
    expect(marker).toBeDefined();
    // The leftover worktree really is still there (nothing cleaned it
    // up): asserted before the doctor/recovery steps below, so a
    // regression that never actually created one is reported as that.
    expect(fs.existsSync(marker!.targetPath)).toBe(true);

    const { doctor } = await import("../src/doctor/index.js");
    const doctorResult = await doctor({ cwd: repo, lockDir });
    const staleWorktreeCheck = doctorResult.checks.find(
      (c) => c.name === "stale-worktree",
    );
    expect(staleWorktreeCheck?.ok).toBe(false);
    expect(staleWorktreeCheck?.detail).toContain(marker!.targetPath);

    // Restore the normal test command (the killed run's own left a
    // command that depends on an env var only that spawned CLI had) so
    // the recovery run below is a normal probe, not a repeat of the
    // crash.
    fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "restore normal test command",
    ]);

    // The next probe on this repository recovers automatically: the
    // leftover worktree is removed and a normal verdict is produced.
    const result = await probe(baseOptions(repo, { logDir }));
    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(marker!.targetPath)).toBe(false);
  }, 30000);
});

describe("probe(): worktree isolation, the original-tree defense-in-depth guard", () => {
  it("a test command that writes to the original tree's target (an absolute path, bypassing the worktree remap) is caught as worktree_original_tree_modified", async () => {
    useLockDir();
    const { repo } = initRepo();
    const absTarget = path.join(repo, "fixture.js");
    // The path travels via an env var, not interpolated into the shell
    // command string: this test is about the original-tree guard, not
    // about quoting a path safely into `-e`.
    const previousEnv = process.env.ORIGINAL_TREE_TARGET;
    process.env.ORIGINAL_TREE_TARGET = absTarget;

    try {
      const result = await probe(
        baseOptions(repo, {
          testCommand:
            "node -e \"require('fs').writeFileSync(process.env.ORIGINAL_TREE_TARGET, 'CLOBBERED')\"",
        }),
      );

      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("worktree_original_tree_modified");
    } finally {
      if (previousEnv === undefined) delete process.env.ORIGINAL_TREE_TARGET;
      else process.env.ORIGINAL_TREE_TARGET = previousEnv;
    }
  });
});

/** The registry blocks the real git reports, never a shim. */
function worktreeBlocks(repo: string): string[] {
  return worktreeList(repo)
    .split("\n\n")
    .filter((b) => b.trim().length > 0);
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
  if (!pid) throw new Error("failed to obtain a dead pid for the test");
  return pid;
}

describe("probe(): worktree isolation on a git that rejects -z (older than 2.36)", () => {
  it("removes its worktree without a false not-removed warning or a kept marker, and the next probe on the repository is not blocked", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "reject-z");
    const logDir = makeTmpDir();

    const first = await withPathPrepended(shimDir, () =>
      probe(baseOptions(repo, { logDir })),
    );

    expect(first.status).toBe("killed");
    expect(
      first.warnings.filter(
        (w) => w.includes("was not removed") || w.includes("could not run"),
      ),
    ).toEqual([]);
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(first.isolation.path as string)).toBe(false);
    expect(worktreeBlocks(repo)).toHaveLength(1);

    const second = await withPathPrepended(shimDir, () =>
      probe(baseOptions(repo, { logDir })),
    );

    expect(second.status).toBe("killed");
    expect(second.warnings).not.toContain("recovered_stale_worktree");
    expect(second.warnings.filter((w) => w.includes("could not run"))).toEqual(
      [],
    );
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(worktreeBlocks(repo)).toHaveLength(1);
  });
});

describe("probe(): worktree isolation when git worktree list cannot run in any form", () => {
  it("warns with the surviving-admin-entry detail, never an 'unverified' one, when the probe's own worktree cleanup finds its target only in goneTargets: a clean, verified removal that git worktree prune has not cleared the registration for yet (probe/session.ts's own cleanupWtSession path)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "no-worktree-list");
    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    mockRun.mockImplementation(async (file, args, options) => {
      const worktreeIndex = args.indexOf("worktree");
      if (
        file === "git" &&
        worktreeIndex !== -1 &&
        args[worktreeIndex + 1] === "add"
      ) {
        const result = await actualRun.runArgv(file, args, options);
        if (result.exitCode === 0) {
          // Lock the entry `git worktree add` just wrote, the shape an
          // interrupted add leaves behind: `git worktree prune` then
          // skips it even once the target directory is gone, which is
          // what leaves the admin entry surviving for this test.
          const adminDir = path.join(repo, ".git", "worktrees");
          for (const entry of fs.readdirSync(adminDir)) {
            const lockedPath = path.join(adminDir, entry, "locked");
            if (!fs.existsSync(lockedPath)) {
              fs.writeFileSync(lockedPath, "initializing");
            }
          }
        }
        return result;
      }
      if (
        file === "git" &&
        worktreeIndex !== -1 &&
        args[worktreeIndex + 1] === "remove"
      ) {
        // Double `--force` on a real git can clear even a locked
        // entry; shimmed to fail so the admin entry above survives
        // for the gitdir-files fallback to find, the same technique
        // `test/isolation.test.ts`'s own `shimRemoveToFail` uses.
        return {
          exitCode: 128,
          durationMs: 0,
          stdout: "",
          stderr: "shimmed: the removal did not run",
          logPath: path.join(options.logDir, "shimmed-remove.log"),
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          logWriteFailed: false,
          stdioClosed: true,
        };
      }
      return actualRun.runArgv(file, args, options);
    });

    try {
      const result = await withPathPrepended(shimDir, () =>
        probe(baseOptions(repo)),
      );

      expect(result.status).toBe("killed");
      const worktreePath = result.isolation.path as string;
      expect(worktreePath).toBeTruthy();
      // A clean, verified removal: never the "unverified" wording the
      // sibling test below asserts for a registry that could not be
      // read at all.
      expect(
        result.warnings.some(
          (w) =>
            w.includes(`the worktree at ${worktreePath} was removed, but`) &&
            w.includes("unverified"),
        ),
      ).toBe(false);
      expect(result.warnings.some((w) => w.includes("was not removed"))).toBe(
        false,
      );
      const match = result.warnings.filter(
        (w) =>
          w.includes(`the worktree at ${worktreePath} was removed, but`) &&
          w.includes("admin entry") &&
          w.includes("worktree prune") &&
          // G4: the composed message drops the redundant leading
          // clause ("was removed," already says the target is gone).
          !w.includes("but the target is gone, but"),
      );
      expect(match).toHaveLength(1);
      expect(fs.existsSync(worktreePath)).toBe(false);
    } finally {
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
      );
      git(repo, ["worktree", "prune"]);
    }
  });

  it("warns with the surviving-admin-entry detail, never an 'unverified' one, when the recovery loop's own cleanup of a marker-named leftover finds its target only in goneTargets (probe/session.ts's own recovery-loop path)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    const staleLogDir = makeTmpDir();
    const stalePath = path.join(staleLogDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    const staleAdd = spawnSync(
      "git",
      ["worktree", "add", "--detach", "--", stalePath, "HEAD"],
      { cwd: repo },
    );
    expect(staleAdd.status).toBe(0);
    const adminDir = path.join(repo, ".git", "worktrees");
    const [adminEntry] = fs.readdirSync(adminDir);
    // Locked the way an interrupted add leaves it, so `git worktree
    // prune` (which `cleanupWorktree` itself runs as part of the
    // recovery) skips it even once the target directory is gone.
    fs.writeFileSync(path.join(adminDir, adminEntry, "locked"), "initializing");
    writeMarker(realRoot, {
      targetPath: stalePath,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid(),
      timestamp: new Date().toISOString(),
      scratchRoot: staleLogDir,
    });

    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "no-worktree-list");
    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    mockRun.mockImplementation(async (file, args, options) => {
      if (file === "git" && args[0] === "worktree" && args[1] === "remove") {
        // Same technique as the sibling test above: double `--force`
        // on a real git would otherwise clear the locked entry itself.
        return {
          exitCode: 128,
          durationMs: 0,
          stdout: "",
          stderr: "shimmed: the removal did not run",
          logPath: path.join(options.logDir, "shimmed-remove.log"),
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          logWriteFailed: false,
          stdioClosed: true,
        };
      }
      return actualRun.runArgv(file, args, options);
    });

    try {
      const result = await withPathPrepended(shimDir, () =>
        probe(baseOptions(repo)),
      );

      expect(result.status).toBe("killed");
      expect(result.warnings).toContain("recovered_stale_worktree");
      expect(
        result.warnings.some(
          (w) =>
            w.includes(
              `the leftover worktree at ${stalePath} was removed, but`,
            ) && w.includes("unverified"),
        ),
      ).toBe(false);
      const match = result.warnings.filter(
        (w) =>
          w.includes(
            `the leftover worktree at ${stalePath} was removed, but`,
          ) &&
          w.includes("admin entry") &&
          w.includes("worktree prune") &&
          !w.includes("but the target is gone, but"),
      );
      expect(match).toHaveLength(1);
      expect(readMarkerFor(realRoot)).toBeUndefined();
      expect(fs.existsSync(stalePath)).toBe(false);
    } finally {
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
      );
    }
  });

  it("reports the removal as done but unverified, clears its marker, and the next probe is not stale_worktree", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "no-worktree-list");
    const logDir = makeTmpDir();

    const first = await withPathPrepended(shimDir, () =>
      probe(baseOptions(repo, { logDir })),
    );

    expect(first.status).toBe("killed");
    const worktreePath = first.isolation.path as string;
    expect(
      first.warnings.some(
        (w) =>
          w.includes(`the worktree at ${worktreePath} was removed, but`) &&
          w.includes("unverified"),
      ),
    ).toBe(true);
    expect(first.warnings.some((w) => w.includes("was not removed"))).toBe(
      false,
    );
    expect(
      first.warnings.some((w) =>
        w.includes(`git worktree list could not run for ${realRoot}`),
      ),
    ).toBe(true);
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(worktreeBlocks(repo)).toHaveLength(1);

    const second = await withPathPrepended(shimDir, () =>
      probe(baseOptions(repo, { logDir })),
    );

    expect(second.status).toBe("killed");
    expect(second.reason).not.toBe("stale_worktree");
    expect(second.warnings).not.toContain("recovered_stale_worktree");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(worktreeBlocks(repo)).toHaveLength(1);
  });

  it("recovers a marker-named scratch directory git never registered, reporting the removal as unverified and naming no command for it, and the next probe is not stale_worktree", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "no-worktree-list");
    const logDir = makeTmpDir();
    // The shape an add killed before it registered anything leaves: a
    // marker naming a scratch directory under this run's log dir that
    // git never listed, with no listing to check it against. No other
    // worktree is ever registered against this repository, so it has
    // no `worktrees/` admin directory either: not even the
    // gitdir-files fallback can help, and the outcome stays genuinely
    // unverified (see the next test for the case where it can).
    const planted = path.join(logDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, "stale.txt"), "leftover\n");
    writeMarker(realRoot, {
      targetPath: planted,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid(),
      timestamp: new Date().toISOString(),
      scratchRoot: logDir,
    });

    const first = await withPathPrepended(shimDir, () =>
      probe(baseOptions(repo, { logDir })),
    );

    expect(first.status).toBe("killed");
    expect(first.warnings).toContain("recovered_stale_worktree");
    expect(
      first.warnings.filter(
        (w) =>
          w.includes(`the leftover worktree at ${planted} was removed, but`) &&
          w.includes(
            "the directory is gone; the registration could not be checked",
          ),
      ),
    ).toHaveLength(1);
    expect(first.warnings.some((w) => w.includes("was not removed"))).toBe(
      false,
    );
    expect(
      first.warnings.some((w) =>
        w.includes(`worktree remove --force --force -- ${planted}`),
      ),
    ).toBe(false);
    expect(fs.existsSync(planted)).toBe(false);
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(worktreeBlocks(repo)).toHaveLength(1);

    const second = await withPathPrepended(shimDir, () =>
      probe(baseOptions(repo, { logDir })),
    );

    expect(second.status).toBe("killed");
    expect(second.reason).not.toBe("stale_worktree");
    expect(second.warnings).not.toContain("recovered_stale_worktree");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(worktreeBlocks(repo)).toHaveLength(1);
  });

  it("recovers a marker-named scratch directory git never registered as a VERIFIED removal, through the gitdir-files fallback, when the repository has another linked worktree keeping its admin directory readable", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    // A second, unrelated linked worktree, never of the probe's own
    // scratch shape, added for real before the shim goes up: it is
    // never touched by the recovery (filtered out immediately by
    // `isScratchWorktreePath`) but its admin entry keeps this
    // repository's `worktrees/` directory non-empty, which is what
    // lets the gitdir-files fallback list anything at all once `git
    // worktree list` itself cannot run in any form.
    const sibling = path.join(makeTmpDir(), "sibling-worktree");
    git(repo, ["worktree", "add", "--detach", "--", sibling, "HEAD"]);
    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "no-worktree-list");
    const logDir = makeTmpDir();
    // The same never-registered leftover shape as the test above: a
    // marker naming a scratch directory git never listed, planted
    // directly rather than through `git worktree add`.
    const planted = path.join(logDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, "stale.txt"), "leftover\n");
    writeMarker(realRoot, {
      targetPath: planted,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid(),
      timestamp: new Date().toISOString(),
      scratchRoot: logDir,
    });

    const result = await withPathPrepended(shimDir, () =>
      probe(baseOptions(repo, { logDir })),
    );

    expect(result.status).toBe("killed");
    expect(result.warnings).toContain("recovered_stale_worktree");
    // A VERIFIED removal gets no "was removed, but ... unverified"
    // warning at all (see `probe/session.ts`'s recovery loop): the
    // gitdir-files fallback found nothing named `planted` among the
    // admin entries (it was never registered), so `cleanupWorktree`
    // asserts the removal instead of falling back to the disk alone.
    expect(result.warnings.some((w) => w.includes(planted))).toBe(false);
    expect(result.warnings.some((w) => w.includes("was not removed"))).toBe(
      false,
    );
    expect(fs.existsSync(planted)).toBe(false);
    expect(readMarkerFor(realRoot)).toBeUndefined();
    // The main worktree and the untouched sibling, never `planted`
    // (which was never a block of its own).
    expect(worktreeBlocks(repo)).toHaveLength(2);
  });

  // Root deletes through a read-only parent, so the leftover cannot be
  // made to stay on disk for it.
  it.skipIf(process.getuid?.() === 0)(
    "a marker-named leftover still on disk after an unverified removal keeps the marker and names the marker file as the one escape, never the manual command",
    async () => {
      useLockDir();
      const { repo } = initRepo();
      const realRoot = resolveDeepestExisting(repo);
      const shimDir = makeTmpDir();
      writeGitShim(shimDir, "no-worktree-list");
      const logDir = makeTmpDir();
      const scratchDir = path.join(logDir, `wt-${randomUUID()}`);
      const planted = path.join(scratchDir, "wt");
      fs.mkdirSync(planted, { recursive: true });
      fs.writeFileSync(path.join(planted, "stale.txt"), "leftover\n");
      writeMarker(realRoot, {
        targetPath: planted,
        backupPath: realRoot,
        preHash: "",
        mutatedHash: "",
        pid: deadPid(),
        timestamp: new Date().toISOString(),
        scratchRoot: logDir,
      });
      // With its parent read-only, the delete empties the directory
      // but cannot remove the directory itself: something stays on
      // disk, and with no listing there is no registration to consult.
      fs.chmodSync(scratchDir, 0o555);
      try {
        const result = await withPathPrepended(shimDir, () =>
          probe(baseOptions(repo, { logDir })),
        );

        expect(result.status).toBe("inconclusive");
        expect(result.reason).toBe("stale_worktree");
        const escape = result.warnings.filter(
          (w) => w.includes(planted) && w.includes("was not removed"),
        );
        expect(escape).toHaveLength(1);
        expect(escape[0]).toContain("still on disk");
        expect(escape[0]).toContain(
          `delete the marker file to clear it: ${markerFilePathFor(realRoot)}`,
        );
        expect(escape[0]).not.toContain("worktree remove --force --force");
        expect(readMarkerFor(realRoot)).toBeDefined();
        expect(fs.existsSync(planted)).toBe(true);
      } finally {
        fs.chmodSync(scratchDir, 0o755);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "a run whose own worktree stays on disk after an unverified removal keeps its marker and names the marker file as the one escape, never the manual command",
    async () => {
      useLockDir();
      const { repo } = initRepo();
      const realRoot = resolveDeepestExisting(repo);
      const shimDir = makeTmpDir();
      writeGitShim(shimDir, "no-worktree-list");
      const logDir = makeTmpDir();
      // The test command runs in the worktree and makes the worktree's
      // own scratch directory read-only, so the end-of-run delete
      // empties the worktree but cannot remove the directory itself.
      const result = await withPathPrepended(shimDir, () =>
        probe(
          baseOptions(repo, {
            logDir,
            testCommand:
              "node -e \"require('fs').chmodSync(require('path').dirname(process.cwd()), 0o555)\"",
          }),
        ),
      );
      const worktreePath = result.isolation.path as string;
      try {
        expect(result.status).toBe("survived");
        expect(worktreePath).toBeTruthy();
        const escape = result.warnings.filter((w) =>
          w.includes(`the worktree at ${worktreePath} was not removed`),
        );
        expect(escape).toHaveLength(1);
        expect(escape[0]).toContain("still on disk");
        expect(escape[0]).toContain(
          `delete the marker file to clear it: ${markerFilePathFor(realRoot)}`,
        );
        expect(escape[0]).not.toContain("worktree remove --force --force");
        expect(readMarkerFor(realRoot)?.targetPath).toBe(worktreePath);
        expect(fs.existsSync(worktreePath)).toBe(true);
      } finally {
        fs.chmodSync(path.dirname(worktreePath), 0o755);
      }
    },
  );
});

describe("probe(): worktree isolation, a marker never certifies its own containment", () => {
  it("a marker naming an unregistered scratch-shaped directory under its own recorded log dir, outside this run's --log-dir, is refused: nothing is deleted and the marker stays", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    const pretendRoot = makeTmpDir();
    const planted = path.join(pretendRoot, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, "precious.txt"), "keep me\n");
    writeMarker(realRoot, {
      targetPath: planted,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid(),
      timestamp: new Date().toISOString(),
      scratchRoot: pretendRoot,
    });

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("stale_worktree");
    expect(
      result.warnings.some(
        (w) =>
          w.includes(planted) &&
          w.includes("not under this run's log dir") &&
          w.includes(markerFilePathFor(realRoot)),
      ),
    ).toBe(true);
    expect(fs.readFileSync(path.join(planted, "precious.txt"), "utf8")).toBe(
      "keep me\n",
    );
    expect(readMarkerFor(realRoot)).toBeDefined();
    expect(worktreeBlocks(repo)).toHaveLength(1);
  });

  it("the same marker with the directory under this run's own --log-dir is recovered, whatever log dir the marker recorded", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    const logDir = makeTmpDir();
    const planted = path.join(logDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, "stale.txt"), "leftover\n");
    writeMarker(realRoot, {
      targetPath: planted,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid(),
      timestamp: new Date().toISOString(),
      scratchRoot: makeTmpDir(),
    });

    const result = await probe(baseOptions(repo, { logDir }));

    expect(result.status).toBe("killed");
    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(fs.existsSync(planted)).toBe(false);
    expect(readMarkerFor(realRoot)).toBeUndefined();
  });
});

describe("probe(): worktree isolation, a live probe under another lock directory", () => {
  it("a second probe under a different AGENT_PRIMITIVES_LOCK_DIR leaves the first probe's live worktree alone, and a third probe after the first finishes finds nothing to recover", async () => {
    const lockDirFirst = makeTmpDir();
    // This process's probes run under a different lock dir than the
    // first (CLI) probe, so the lock cannot serialize them.
    useLockDir();
    const { repo } = initRepo();
    const logDirFirst = makeTmpDir();
    const signals = makeTmpDir();
    const ready = path.join(signals, "ready.txt");
    const release = path.join(signals, "release.txt");
    // Only the first (CLI) probe gets the two signal paths in its
    // environment: its test announces itself through `ready` and then
    // holds until `release` exists, so the first probe provably sits in
    // its test, worktree in use, for as long as this test wants. The
    // in-process probes below run the same file without either path
    // and go straight to the assertions.
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const ready = process.env.READY_ABS_PATH;",
        "const release = process.env.RELEASE_ABS_PATH;",
        "if (ready) fs.writeFileSync(ready, 'running');",
        "const started = Date.now();",
        "function run() {",
        "  const assert = require('node:assert');",
        "  const { isPositive } = require('./fixture.js');",
        "  assert.strictEqual(isPositive(5), true);",
        "  assert.strictEqual(isPositive(-5), false);",
        "}",
        "function wait() {",
        "  if (!release || fs.existsSync(release) || Date.now() - started > 15000) {",
        "    run();",
        "    return;",
        "  }",
        "  setTimeout(wait, 50);",
        "}",
        "wait();",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "slow test",
    ]);

    const child = spawn(
      "node",
      [
        CLI_PATH,
        "probe",
        "--file",
        "fixture.js",
        "-n",
        "2",
        "-r",
        "  return false;",
        "-t",
        "node fixture.test.js",
        "-i",
        "worktree",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          AGENT_PRIMITIVES_LOCK_DIR: lockDirFirst,
          AGENT_PRIMITIVES_LOG_DIR: logDirFirst,
          READY_ABS_PATH: ready,
          RELEASE_ABS_PATH: release,
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let firstStdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      firstStdout += chunk;
    });
    const firstClosed = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });

    const deadline = Date.now() + 15000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error("the first probe's test never signalled readiness");
      }
      if (child.exitCode !== null) {
        throw new Error(
          `the first probe exited early with ${String(child.exitCode)}: ${firstStdout}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // The first probe's worktree is registered, on disk, and owned by
    // the CLI process, which is still running its test.
    const scratchDuring = parseWorktreeListZ(
      execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
        cwd: repo,
        encoding: "utf8",
      }),
    )
      .map(resolveDeepestExisting)
      .filter(isScratchWorktreePath);
    expect(scratchDuring).toHaveLength(1);
    const firstWorktree = scratchDuring[0];
    expect(readScratchOwner(firstWorktree)?.pid).toBe(child.pid);

    const second = await probe(baseOptions(repo));

    expect(second.status).toBe("killed");
    expect(
      second.warnings.some(
        (w) =>
          w.includes(firstWorktree) &&
          w.includes(`live probe (pid ${String(child.pid)})`),
      ),
    ).toBe(true);
    expect(second.warnings).not.toContain("recovered_stale_worktree");
    // The first probe is still held in its test: its worktree is intact
    // and registered after the second probe has run to completion.
    expect(fs.existsSync(firstWorktree)).toBe(true);
    expect(fs.existsSync(path.join(firstWorktree, "fixture.js"))).toBe(true);
    expect(worktreeList(repo)).toContain(firstWorktree);

    fs.writeFileSync(release, "go");
    expect(await firstClosed).toBe(0);
    const firstResult = JSON.parse(firstStdout) as {
      status: string;
      warnings: string[];
    };
    expect(firstResult.status).toBe("killed");
    expect(
      firstResult.warnings.filter((w) => w.includes("was not removed")),
    ).toEqual([]);
    expect(fs.existsSync(firstWorktree)).toBe(false);

    const third = await probe(baseOptions(repo));

    expect(third.status).toBe("killed");
    expect(third.warnings).not.toContain("recovered_stale_worktree");
    expect(third.warnings.filter((w) => w.includes("live probe"))).toEqual([]);
    expect(worktreeBlocks(repo)).toHaveLength(1);
  }, 30000);
});

describe("probe(): worktree isolation, the owner record's bound", () => {
  /** A pid that is alive from any user's point of view: pid 1 always
   * exists, and the liveness check reads the EPERM a non-root user gets
   * from signalling it as alive. */
  const ALIVE_PID = 1;

  function writeOwner(wt: string, timestamp: string): void {
    fs.writeFileSync(
      path.join(path.dirname(wt), SCRATCH_OWNER_FILE),
      JSON.stringify({
        pid: ALIVE_PID,
        timestamp,
        logDir: path.dirname(path.dirname(wt)),
      }),
    );
  }

  function registeredScratch(repo: string): string[] {
    return parseWorktreeListZ(
      execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
        cwd: repo,
        encoding: "utf8",
      }),
    )
      .map(resolveDeepestExisting)
      .filter(isScratchWorktreePath);
  }

  it("recovers a registered scratch worktree whose owner record is past the bound even though its pid is alive, and leaves one under a fresh record alone", async () => {
    useLockDir();
    const { repo } = initRepo();
    const logDir = makeTmpDir();
    const expired = path.join(logDir, `wt-${randomUUID()}`, "wt");
    const fresh = path.join(logDir, `wt-${randomUUID()}`, "wt");
    for (const wt of [expired, fresh]) {
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      git(repo, ["worktree", "add", "--detach", "--", wt, "HEAD"]);
    }
    writeOwner(expired, "2020-01-01T00:00:00.000Z");
    writeOwner(fresh, new Date().toISOString());
    const expiredResolved = resolveDeepestExisting(expired);
    const freshResolved = resolveDeepestExisting(fresh);

    const result = await probe(baseOptions(repo, { logDir }));

    expect(result.status).toBe("killed");
    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(
      result.warnings.filter(
        (w) =>
          w.includes(freshResolved) &&
          w.includes(`live probe (pid ${String(ALIVE_PID)})`),
      ),
    ).toHaveLength(1);
    expect(
      result.warnings.filter(
        (w) => w.includes(expiredResolved) && w.includes("live probe"),
      ),
    ).toEqual([]);
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(registeredScratch(repo)).toEqual([freshResolved]);
  });
});

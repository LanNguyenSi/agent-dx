import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markerFilePathFor, readMarkerFor, writeMarker } from "../src/lock.js";
import {
  isPathContained,
  physicalRealpath,
  resolveDeepestExisting,
  resolveDeepestExistingLenient,
  resolvePhysicalLocation,
  UnresolvablePathError,
} from "../src/probe/containment.js";
import { init } from "../src/init/index.js";
import { cleanupWorktree } from "../src/probe/isolation.js";
import { linkSourceIsOperatorInput } from "../src/probe/link-policy.js";
import { probe, probePlan, type ProbeOptions } from "../src/probe/index.js";
import { realGitPath, withPathPrepended } from "./helpers/git-shim.js";
import { expectNoIsolationLeftovers } from "./helpers/no-leftovers.js";

/**
 * A `..` through a symlinked component: `dd.js -> odl/../two.js` with
 * `odl` a link to a directory OUTSIDE the repository is `<outside>/two.js`
 * to the kernel (the `..` climbs from where `odl` points), whatever an
 * in-root `two.js` does or does not exist. Every judgement of what a run
 * may read, write or delete is made on that physical location, and the
 * run then acts on exactly the judged path. Plain symlinks only, so every
 * row runs on Linux as well as macOS.
 */

vi.setConfig({ testTimeout: 60_000 });

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-dotdot-test-")),
  );
  tmpDirs.push(dir);
  return dir;
}

/** Removal of the directory chains `deepLink` builds: they are longer
 * than `PATH_MAX`, which a recursive remove by absolute path cannot
 * reach on every Node version, so each is taken down from the inside. */
const deepTeardowns: (() => void)[] = [];

const canLchmod =
  typeof fs.lchmodSync === "function" && process.getuid?.() !== 0;

/**
 * `<dir>/<name>`, a symlink whose physical location is longer than
 * `PATH_MAX` and ends at `victim`: a chain of 200-character directories
 * below `dir`, entered through relative links (`<name>` -> `m` -> `m` ->
 * `out` -> `victim`) that each stay well below `PATH_MAX`. The kernel
 * follows them one at a time, each relative to the directory it sits in;
 * an `lstat` of the absolute spelling of the last stretch fails with
 * `ENAMETOOLONG`.
 */
function deepLink(dir: string, victim: string, name: string): void {
  const segment = "a".repeat(200);
  const pathMax = process.platform === "darwin" ? 1024 : 4096;
  const perHop = Math.floor(pathMax / 2 / (segment.length + 1));
  const hops = 3;
  const stretch = `${segment}/`.repeat(perHop);
  const saved = process.cwd();
  deepTeardowns.push(() => {
    try {
      process.chdir(dir);
      let depth = 0;
      while (fs.existsSync(segment)) {
        process.chdir(segment);
        depth++;
      }
      for (; depth > 0; depth--) {
        for (const link of ["m", "out"]) fs.rmSync(link, { force: true });
        process.chdir("..");
        fs.rmdirSync(segment);
      }
    } finally {
      process.chdir(saved);
    }
  });
  try {
    process.chdir(dir);
    for (let hop = 0; hop < hops; hop++) {
      for (let i = 0; i < perHop; i++) {
        fs.mkdirSync(segment);
        process.chdir(segment);
      }
      if (hop === hops - 1) fs.symlinkSync(victim, "out");
      else fs.symlinkSync(`${stretch}${hop === hops - 2 ? "out" : "m"}`, "m");
    }
  } finally {
    process.chdir(saved);
  }
  fs.symlinkSync(`${stretch}m`, path.join(dir, name));
}

/** Whether `spelling` names the very directory `expected` does, to the
 * kernel: the same device and inode. */
function sameDirectory(spelling: string, expected: string): boolean {
  const a = fs.statSync(spelling);
  const b = fs.statSync(expected);
  return a.dev === b.dev && a.ino === b.ino;
}

let savedLockDir: string | undefined;
afterEach(() => {
  for (const teardown of deepTeardowns.splice(0)) teardown();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (savedLockDir === undefined) delete process.env.AGENT_PRIMITIVES_LOCK_DIR;
  else process.env.AGENT_PRIMITIVES_LOCK_DIR = savedLockDir;
  savedLockDir = undefined;
});

function useLockDir(): string {
  savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
  const dir = makeTmpDir();
  process.env.AGENT_PRIMITIVES_LOCK_DIR = dir;
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const FIXTURE_JS = "exports.f = (n) => {\n  return n > 0;\n};\n";
const FIXTURE_TEST_JS =
  "const { f } = require('./fixture.js');\nif (f(0) !== false) process.exit(1);\n";
/** What every outside file holds: two lines carry the `-M` text, so a
 * derivation that read one would answer `match_ambiguous` and name them. */
const OUTSIDE = "n > 0\nn > 0\n";

interface Fixture {
  repo: string;
  outside: string;
}

/** A committed repository whose `odl` links to `<outside>/odir` and whose
 * `dd-*.js` links each name `odl/../<x>`, an outside file to the kernel,
 * while the JavaScript `realpath` spells it `<repo>/<x>`: missing in the
 * repository (`two.js`), present there too (`one.js`), a symlink cycle
 * there (`loop-a.js`), or below a regular file there (`f2.js/child`). */
function fixture(): Fixture {
  const repo = makeTmpDir();
  const outside = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["config", "maintenance.auto", "false"]);
  git(repo, ["config", "gc.auto", "0"]);
  fs.writeFileSync(path.join(repo, "fixture.js"), FIXTURE_JS);
  fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
  fs.writeFileSync(path.join(repo, "one.js"), "in the repository\n");
  fs.writeFileSync(path.join(repo, "f2.js"), "a file\n");
  fs.symlinkSync("loop-b.js", path.join(repo, "loop-a.js"));
  fs.symlinkSync("loop-a.js", path.join(repo, "loop-b.js"));
  fs.mkdirSync(path.join(outside, "odir"));
  for (const name of ["two.js", "one.js", "loop-a.js"]) {
    fs.writeFileSync(path.join(outside, name), OUTSIDE);
  }
  fs.mkdirSync(path.join(outside, "f2.js"));
  fs.writeFileSync(path.join(outside, "f2.js", "child"), OUTSIDE);
  fs.symlinkSync(path.join(outside, "odir"), path.join(repo, "odl"));
  fs.symlinkSync("odl/../two.js", path.join(repo, "dd-enoent.js"));
  fs.symlinkSync("odl/../one.js", path.join(repo, "dd-exists.js"));
  fs.symlinkSync("odl/../loop-a.js", path.join(repo, "dd-eloop.js"));
  fs.symlinkSync("odl/../f2.js/child", path.join(repo, "dd-enotdir.js"));
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return { repo, outside };
}

const VARIANTS = [
  { name: "dd-enoent.js", victim: "two.js" },
  { name: "dd-exists.js", victim: "one.js" },
  { name: "dd-eloop.js", victim: "loop-a.js" },
  { name: "dd-enotdir.js", victim: path.join("f2.js", "child") },
] as const;

type Mode = "inplace" | "worktree";
const MODES: Mode[] = ["inplace", "worktree"];

/** A test command that leaves a trace of every run and reads the victim:
 * no trace means no baseline (and no mutant) ever ran. */
function tracingCommand(victim: string, trace: string): string {
  return `cat '${victim}' >> '${trace}'; node fixture.test.js`;
}

describe("a --file whose symlink target walks .. through a symlinked directory out of the root", () => {
  for (const variant of VARIANTS) {
    for (const mode of MODES) {
      for (const line of [undefined, 1] as const) {
        it(`probe(), ${variant.name}, ${mode} isolation, ${line === undefined ? "-M without -n" : "-n 1"}: file_outside_root, nothing outside read or written`, async () => {
          const lockDir = useLockDir();
          const fx = fixture();
          const victim = path.join(fx.outside, variant.victim);
          const trace = path.join(makeTmpDir(), "trace");
          const options: ProbeOptions = {
            file: variant.name,
            form: "match",
            matchText: "n > 0",
            withText: "true",
            testCommand: tracingCommand(victim, trace),
            isolation: mode,
            expect: "fail",
            cwd: fx.repo,
            logDir: makeTmpDir(),
            ...(line === undefined ? {} : { line }),
          };
          const result = await probe(options);
          expect(result.status).toBe("inconclusive");
          expect(result.reason).toBe("file_outside_root");
          expect(result.warnings.join("\n")).not.toContain("occurs on");
          expect(fs.existsSync(trace)).toBe(false);
          expect(fs.readFileSync(victim, "utf8")).toBe(OUTSIDE);
          expectNoIsolationLeftovers(fx.repo, lockDir);
        });
      }

      it(`probePlan(), ${variant.name}, ${mode} isolation, -n 1: usage_error file_outside_root, nothing outside read or written`, async () => {
        const lockDir = useLockDir();
        const fx = fixture();
        const victim = path.join(fx.outside, variant.victim);
        const trace = path.join(makeTmpDir(), "trace");
        const result = await probePlan({
          mutants: [
            {
              file: variant.name,
              line: 1,
              form: "match",
              matchText: "n > 0",
              withText: "true",
            },
          ],
          testCommand: tracingCommand(victim, trace),
          isolation: mode,
          expect: "fail",
          cwd: fx.repo,
          logDir: makeTmpDir(),
        });
        expect(result.status).toBe("usage_error");
        expect(result.reason).toBe("file_outside_root");
        expect(fs.existsSync(trace)).toBe(false);
        expect(fs.readFileSync(victim, "utf8")).toBe(OUTSIDE);
        expectNoIsolationLeftovers(fx.repo, lockDir);
      });
    }
  }

  for (const mode of MODES) {
    it(`a .. in the --file argument itself (-f odl/../two.js), ${mode} isolation: judged and acted on as <root>/two.js, the outside file is never reached`, async () => {
      useLockDir();
      const fx = fixture();
      const victim = path.join(fx.outside, "two.js");
      const trace = path.join(makeTmpDir(), "trace");
      const result = await probe({
        file: "odl/../two.js",
        line: 1,
        form: "match",
        matchText: "n > 0",
        withText: "true",
        testCommand: tracingCommand(victim, trace),
        isolation: mode,
        expect: "fail",
        cwd: fx.repo,
        logDir: makeTmpDir(),
      });
      expect(result.status).toBe("usage_error");
      expect(result.reason).toBe("file_not_found");
      expect(result.warnings.join("\n")).toContain(
        path.join(fx.repo, "two.js"),
      );
      expect(fs.existsSync(trace)).toBe(false);
      expect(fs.readFileSync(victim, "utf8")).toBe(OUTSIDE);
    });
  }
});

describe("resolveDeepestExisting and its lenient twin place a .. physically and agree", () => {
  it("both answer the kernel's location for a path, existing or not, whose .. climbs from a symlinked directory", () => {
    const fx = fixture();
    const outside = fs.realpathSync.native(fx.outside);
    const cases: [string, string][] = [
      [path.join(fx.repo, "dd-exists.js"), path.join(outside, "one.js")],
      [path.join(fx.repo, "dd-enoent.js"), path.join(outside, "two.js")],
      [`${fx.repo}/odl/../one.js`, path.join(outside, "one.js")],
      [`${fx.repo}/odl/../new/x.js`, path.join(outside, "new", "x.js")],
      [`${fx.repo}/odl/..`, outside],
    ];
    for (const [spelling, physical] of cases) {
      expect(resolveDeepestExisting(spelling)).toBe(physical);
      expect(resolveDeepestExistingLenient(spelling)).toBe(physical);
    }
  });

  it("a .. after a component that does not resolve is not placed: the strict one throws, the lenient one does not", () => {
    const fx = fixture();
    fs.symlinkSync(
      path.join(fx.outside, "gone"),
      path.join(fx.repo, "dangling"),
    );
    fs.symlinkSync("fixture.js", path.join(fx.repo, "link-to-file"));
    for (const spelling of [
      `${fx.repo}/missing/../one.js`,
      `${fx.repo}/dangling/../one.js`,
      // A regular file is no directory to climb from (ENOTDIR to the
      // kernel), so its `..` is never applied either, also when a
      // followed link is what lands on the file.
      `${fx.repo}/fixture.js/../one.js`,
      `${fx.repo}/link-to-file/../one.js`,
    ]) {
      expect(() => resolveDeepestExisting(spelling)).toThrow(
        UnresolvablePathError,
      );
      expect(() => resolveDeepestExistingLenient(spelling)).not.toThrow();
      expect(resolveDeepestExistingLenient(spelling)).not.toBe(
        path.join(fs.realpathSync.native(fx.repo), "one.js"),
      );
    }
  });

  it("a missing tail keeps today's answers: the deepest existing prefix placed, the rest verbatim", () => {
    const fx = fixture();
    const repo = fs.realpathSync.native(fx.repo);
    expect(resolveDeepestExisting(path.join(fx.repo, "nope", "x.js"))).toBe(
      path.join(repo, "nope", "x.js"),
    );
    expect(
      resolveDeepestExisting(path.join(fx.repo, "fixture.js", "child.js")),
    ).toBe(path.join(repo, "fixture.js", "child.js"));
  });

  it("a symlink cycle is refused by the strict one, as any path past the link budget is, and placed where it sits by the lenient one", () => {
    const fx = fixture();
    const repo = fs.realpathSync.native(fx.repo);
    for (const name of ["loop-a.js", path.join("loop-b.js", "below.js")]) {
      const spelling = path.join(fx.repo, name);
      expect(() => resolveDeepestExisting(spelling)).toThrow(
        UnresolvablePathError,
      );
      expect(resolveDeepestExistingLenient(spelling)).toBe(
        path.join(repo, name),
      );
    }
  });

  it("a link whose target climbs with .. from a regular file is placed where the link sits: the kernel answers ENOTDIR for it too", () => {
    const fx = fixture();
    const repo = fs.realpathSync.native(fx.repo);
    // `f2.js` is a file in the repository, so `f2.js/..` is ENOTDIR to
    // the kernel and to the walk alike, and the walk-up places the link.
    fs.symlinkSync("f2.js/../one.js", path.join(fx.repo, "via-file.js"));
    const spelling = path.join(fx.repo, "via-file.js");
    expect(() => fs.statSync(spelling)).toThrow(/ENOTDIR/);
    expect(resolveDeepestExisting(spelling)).toBe(
      path.join(repo, "via-file.js"),
    );
    expect(resolveDeepestExistingLenient(spelling)).toBe(
      path.join(repo, "via-file.js"),
    );
  });

  it("a missing first component below the filesystem root: placed verbatim, and a .. after it is refused by the strict one", () => {
    const fsRoot = path.parse(os.tmpdir()).root;
    const missing = `${fsRoot}agent-primitives-no-such-top-level-${String(process.pid)}`;
    expect(fs.existsSync(missing)).toBe(false);
    const plain = `${missing}${path.sep}x.js`;
    expect(resolveDeepestExisting(plain)).toBe(plain);
    expect(resolveDeepestExistingLenient(plain)).toBe(plain);
    const climbing = `${missing}${path.sep}..${path.sep}etc`;
    expect(() => resolveDeepestExisting(climbing)).toThrow(
      UnresolvablePathError,
    );
    expect(resolveDeepestExistingLenient(climbing)).toBe(climbing);
  });

  it("physicalRealpath takes the spelling it is given: a .. through a symlinked directory lands where the kernel puts it", () => {
    const fx = fixture();
    const spelling = `${fx.repo}${path.sep}odl${path.sep}..${path.sep}two.js`;
    expect(physicalRealpath(spelling)).toBe(
      path.join(fs.realpathSync.native(fx.outside), "two.js"),
    );
    expect(physicalRealpath(spelling)).toBe(fs.realpathSync.native(spelling));
  });

  /** Whether this volume gives a file a resource fork under
   * `<file>/..namedfork/rsrc` (macOS, on a filesystem that has forks). */
  const hasNamedForks = (() => {
    if (process.platform !== "darwin") return false;
    const probeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-primitives-fork-probe-"),
    );
    try {
      const file = path.join(probeDir, "f");
      fs.writeFileSync(file, "data\n");
      fs.writeFileSync(path.join(file, "..namedfork", "rsrc"), "fork\n");
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  })();

  it.skipIf(!hasNamedForks)(
    "macOS: a link into <outside-file>/..namedfork/rsrc is refused by the strict one, since the kernel opens the outside fork where the walk finds nothing; the lenient one still places it where the link sits",
    () => {
      // `lstat` of `<file>/..namedfork` answers ENOTDIR, so the walk
      // finds the link's target missing and, alone, places the link at
      // its own spelling inside the root. The kernel follows it.
      const fx = fixture();
      const repo = fs.realpathSync.native(fx.repo);
      const outside = fs.realpathSync.native(fx.outside);
      const fork = path.join(fx.outside, "two.js", "..namedfork", "rsrc");
      fs.writeFileSync(fork, "the outside fork\n");
      const link = path.join(fx.repo, "fork-link.js");
      fs.symlinkSync(fork, link);
      expect(fs.readFileSync(link, "utf8")).toBe("the outside fork\n");
      const thrown = refusal(link);
      expect(thrown).toBeInstanceOf(UnresolvablePathError);
      expect((thrown as UnresolvablePathError).path).toBe(link);
      expect((thrown as UnresolvablePathError).code).toBeUndefined();
      // The fork spelled directly is the same disagreement.
      expect(refusal(fork)).toBeInstanceOf(UnresolvablePathError);
      // The lenient one does not ask the kernel and answers what it
      // answered before, which is why nothing that acts may use it.
      const lenient = resolveDeepestExistingLenient(link);
      expect(lenient).toBe(path.join(repo, "fork-link.js"));
      expect(isPathContained(repo, lenient)).toBe(true);
      expect(resolveDeepestExistingLenient(fork)).toBe(
        path.join(outside, "two.js", "..namedfork", "rsrc"),
      );
    },
  );

  it.skipIf(!hasNamedForks)(
    "macOS: a link into the fork of a file that carries none is a dangling link to the kernel too, and stays placed where it sits",
    () => {
      const fx = fixture();
      const repo = fs.realpathSync.native(fx.repo);
      const link = path.join(fx.repo, "no-fork-link.js");
      fs.symlinkSync(
        path.join(fx.outside, "one.js", "..namedfork", "rsrc"),
        link,
      );
      expect(() => fs.statSync(link)).toThrow(/ENOENT/);
      expect(resolveDeepestExisting(link)).toBe(
        path.join(repo, "no-fork-link.js"),
      );
    },
  );

  it("a relative spelling is spliced onto the current directory and its .. still placed physically", () => {
    const fx = fixture();
    const saved = process.cwd();
    process.chdir(fx.repo);
    try {
      expect(resolveDeepestExisting("odl/../one.js")).toBe(
        path.join(fs.realpathSync.native(fx.outside), "one.js"),
      );
    } finally {
      process.chdir(saved);
    }
  });

  /** `<base>/c<n-1> -> ... -> c0 -> real`: a chain of `n` links ending at
   * the directory `<base>/real`, which holds `real/s -> <base>/far`. */
  function chain(n: number): { base: string; head: string } {
    const base = makeTmpDir();
    fs.mkdirSync(path.join(base, "real"));
    fs.mkdirSync(path.join(base, "far"));
    fs.mkdirSync(path.join(base, "real", "plain"));
    fs.symlinkSync(path.join(base, "far"), path.join(base, "real", "s"));
    let previous = "real";
    for (let i = 0; i < n; i++) {
      fs.symlinkSync(previous, path.join(base, `c${String(i)}`));
      previous = `c${String(i)}`;
    }
    return { base, head: path.join(base, previous) };
  }

  /** More links than the kernel follows in one lookup on either
   * platform this suite runs on (32 on macOS, 40 on Linux), and fewer
   * than the walk's own budget of 64. */
  const PAST_KERNEL_LINKS = 50;
  /** A number of links the kernel follows on both. */
  const WITHIN_KERNEL_LINKS = 20;

  it("the walk's link budget: exactly 64 links are walked, and a 65th is refused, never re-appended below the 64 that were placed", () => {
    const at64 = chain(64);
    // The walk on its own, without the kernel's answer: 64 links resolve.
    expect(physicalRealpath(at64.head)).toBe(path.join(at64.base, "real"));
    expect(physicalRealpath(path.join(at64.head, "plain"))).toBe(
      path.join(at64.base, "real", "plain"),
    );
    expect(resolveDeepestExistingLenient(at64.head)).toBe(
      path.join(at64.base, "real"),
    );
    // 64 links to `real`, then `s` is the 65th: placing `<base>/real` and
    // re-appending `s` verbatim would name `<base>/far` to the kernel.
    expect(() => physicalRealpath(path.join(at64.head, "s"))).toThrow(/ELOOP/);
    expect(() => resolveDeepestExisting(path.join(at64.head, "s"))).toThrow(
      UnresolvablePathError,
    );
    // The lenient one never throws and keeps that shorter spelling.
    expect(resolveDeepestExistingLenient(path.join(at64.head, "s"))).toBe(
      path.join(at64.base, "real", "s"),
    );
    const at63 = chain(63);
    expect(physicalRealpath(path.join(at63.head, "s"))).toBe(
      path.join(at63.base, "far"),
    );
  });

  it("a chain the walk places in full and the kernel does not follow (more links than its own limit) is refused by the strict one with the kernel's ELOOP", () => {
    for (const links of [PAST_KERNEL_LINKS, 63, 64]) {
      const built = chain(links);
      expect(() => fs.statSync(built.head)).toThrow(/ELOOP/);
      for (const spelling of [built.head, path.join(built.head, "plain")]) {
        const thrown = refusal(spelling);
        expect(thrown).toBeInstanceOf(UnresolvablePathError);
        expect((thrown as UnresolvablePathError).code).toBe("ELOOP");
      }
      // The lenient one answers the walk's placement, unasked.
      expect(resolveDeepestExistingLenient(built.head)).toBe(
        path.join(built.base, "real"),
      );
    }
    // A chain the kernel follows is placed as before, `s` included.
    const short = chain(WITHIN_KERNEL_LINKS);
    expect(resolveDeepestExisting(short.head)).toBe(
      path.join(short.base, "real"),
    );
    expect(resolveDeepestExisting(path.join(short.head, "plain"))).toBe(
      path.join(short.base, "real", "plain"),
    );
    expect(resolveDeepestExisting(path.join(short.head, "s"))).toBe(
      path.join(short.base, "far"),
    );
  });

  it("a path the walk finds missing while the kernel fails another way (ELOOP on a dangling chain past its limit) is refused, not placed", () => {
    const base = makeTmpDir();
    let previous = "gone";
    for (let i = 0; i < PAST_KERNEL_LINKS; i++) {
      fs.symlinkSync(previous, path.join(base, `d${String(i)}`));
      previous = `d${String(i)}`;
    }
    const head = path.join(base, previous);
    // The walk follows every link and finds `gone` missing (ENOENT),
    // which alone places the head where it sits.
    expect(() => physicalRealpath(head)).toThrow(/ENOENT/);
    expect(() => fs.statSync(head)).toThrow(/ELOOP/);
    const thrown = refusal(head);
    expect(thrown).toBeInstanceOf(UnresolvablePathError);
    expect((thrown as UnresolvablePathError).code).toBe("ELOOP");
    expect(resolveDeepestExistingLenient(head)).toBe(head);
    // The same dangling chain cut short enough for the kernel: ENOENT to
    // both, and placed where it sits as before.
    const shortHead = path.join(base, `d${String(WITHIN_KERNEL_LINKS - 1)}`);
    expect(() => fs.statSync(shortHead)).toThrow(/ENOENT/);
    expect(resolveDeepestExisting(shortHead)).toBe(shortHead);
  });

  it("<file>/. is placed at the file by the walk and is ENOTDIR to the kernel: refused by the strict one, placed by the lenient one", () => {
    const fx = fixture();
    const repo = fs.realpathSync.native(fx.repo);
    fs.symlinkSync("fixture.js/.", path.join(fx.repo, "dot-link.js"));
    for (const spelling of [
      `${fx.repo}${path.sep}fixture.js${path.sep}.`,
      `${fx.repo}${path.sep}fixture.js${path.sep}`,
      path.join(fx.repo, "dot-link.js"),
    ]) {
      expect(() => fs.statSync(spelling)).toThrow(/ENOTDIR/);
      const thrown = refusal(spelling);
      expect(thrown).toBeInstanceOf(UnresolvablePathError);
      expect((thrown as UnresolvablePathError).code).toBe("ENOTDIR");
      expect(resolveDeepestExistingLenient(spelling)).toBe(
        path.join(repo, "fixture.js"),
      );
    }
    // A directory spelled the same two ways is a directory to both.
    fs.mkdirSync(path.join(fx.repo, "dir"));
    for (const spelling of [
      `${fx.repo}${path.sep}dir${path.sep}.`,
      `${fx.repo}${path.sep}dir${path.sep}`,
    ]) {
      expect(resolveDeepestExisting(spelling)).toBe(path.join(repo, "dir"));
    }
  });

  it("a symlinked component re-pointed between the walk and the kernel's answer is refused: the kernel reaches another file than the one placed", () => {
    const fx = fixture();
    const repo = fs.realpathSync.native(fx.repo);
    fs.mkdirSync(path.join(fx.repo, "inner"));
    fs.writeFileSync(path.join(fx.repo, "inner", "two.js"), "inside\n");
    fs.writeFileSync(path.join(fx.outside, "odir", "two.js"), OUTSIDE);
    const lnk = path.join(fx.repo, "lnk");
    fs.symlinkSync("inner", lnk);
    const spelling = path.join(lnk, "two.js");
    // Unraced, the link is followed and the file placed inside the root.
    expect(resolveDeepestExisting(spelling)).toBe(
      path.join(repo, "inner", "two.js"),
    );
    // Raced: the walk has placed `<root>/inner/two.js` when `lnk` is
    // re-pointed at `<outside>/odir`, just before the kernel is asked
    // (the walk itself only ever calls `lstat` and `readlink`).
    const realStat = fs.statSync;
    let repointed = false;
    const spy = vi.spyOn(fs, "statSync").mockImplementation(((
      ...args: Parameters<typeof fs.statSync>
    ) => {
      if (!repointed) {
        repointed = true;
        fs.unlinkSync(lnk);
        fs.symlinkSync(path.join(fx.outside, "odir"), lnk);
      }
      return realStat(...args);
    }) as typeof fs.statSync);
    let thrown: unknown;
    try {
      thrown = refusal(spelling);
    } finally {
      spy.mockRestore();
    }
    expect(repointed).toBe(true);
    expect(thrown).toBeInstanceOf(UnresolvablePathError);
    expect((thrown as UnresolvablePathError).path).toBe(spelling);
    expect((thrown as UnresolvablePathError).code).toBeUndefined();
  });

  it("a symlinked component re-pointed and its old target removed between the walk and the kernel's answer is refused: the placed file is gone, whatever the kernel reaches now", () => {
    const fx = fixture();
    const repo = fs.realpathSync.native(fx.repo);
    const placed = path.join(repo, "inner", "two.js");
    fs.mkdirSync(path.join(fx.repo, "inner"));
    fs.writeFileSync(placed, "inside\n");
    fs.writeFileSync(path.join(fx.outside, "odir", "two.js"), OUTSIDE);
    const lnk = path.join(fx.repo, "lnk");
    fs.symlinkSync("inner", lnk);
    const spelling = path.join(lnk, "two.js");
    expect(resolveDeepestExisting(spelling)).toBe(placed);
    // Raced as above, and the file the walk placed is removed as well:
    // the kernel still reaches a file through the spelling (the outside
    // one), while there is nothing left at the placement to hold it
    // against.
    const realStat = fs.statSync;
    let raced = false;
    const spy = vi.spyOn(fs, "statSync").mockImplementation(((
      ...args: Parameters<typeof fs.statSync>
    ) => {
      if (!raced) {
        raced = true;
        fs.unlinkSync(lnk);
        fs.symlinkSync(path.join(fx.outside, "odir"), lnk);
        fs.unlinkSync(placed);
      }
      return realStat(...args);
    }) as typeof fs.statSync);
    let thrown: unknown;
    try {
      thrown = refusal(spelling);
    } finally {
      spy.mockRestore();
    }
    expect(raced).toBe(true);
    expect(fs.statSync(spelling).isFile()).toBe(true);
    expect(fs.existsSync(placed)).toBe(false);
    expect(thrown).toBeInstanceOf(UnresolvablePathError);
    expect((thrown as UnresolvablePathError).path).toBe(spelling);
    expect((thrown as UnresolvablePathError).code).toBe("ENOENT");
  });

  it("an empty path is the current directory to both resolvers: the kernel is asked about the absolute spelling that was walked, not about the argument as given", () => {
    const dir = makeTmpDir();
    const saved = process.cwd();
    process.chdir(dir);
    try {
      // `stat("")` itself is ENOENT to the kernel.
      expect(() => fs.statSync("")).toThrow(/ENOENT/);
      expect(resolveDeepestExisting("")).toBe(fs.realpathSync.native(dir));
      expect(resolveDeepestExisting("")).toBe(
        resolveDeepestExistingLenient(""),
      );
    } finally {
      process.chdir(saved);
    }
  });

  it("a path past the budget through `l -> .` steps is refused, whatever number of steps", () => {
    const base = makeTmpDir();
    const log = path.join(base, "log");
    fs.mkdirSync(log);
    fs.mkdirSync(path.join(base, "victim", "wt"), { recursive: true });
    fs.symlinkSync(".", path.join(log, "l"));
    fs.symlinkSync(path.join(base, "victim"), path.join(log, "U"));
    for (const steps of [WITHIN_KERNEL_LINKS, 63, 64, 65, 100]) {
      const spelling = `${log}/${"l/".repeat(steps)}U/wt`;
      if (steps === WITHIN_KERNEL_LINKS) {
        expect(resolveDeepestExisting(spelling)).toBe(
          path.join(base, "victim", "wt"),
        );
      } else {
        // 63 steps and `U` are the 64 links the walk still places
        // (`physicalRealpath` below), and more than the kernel follows.
        expect(() => resolveDeepestExisting(spelling)).toThrow(
          UnresolvablePathError,
        );
      }
    }
    expect(physicalRealpath(`${log}/${"l/".repeat(63)}U/wt`)).toBe(
      path.join(base, "victim", "wt"),
    );
    expect(() => physicalRealpath(`${log}/${"l/".repeat(64)}U/wt`)).toThrow(
      /ELOOP/,
    );
  });

  /** `<base>/log` with `l -> .`, and `<base>/victim/wt`. */
  function logAndVictim(): { log: string; victim: string } {
    const base = makeTmpDir();
    const log = path.join(base, "log");
    const victim = path.join(base, "victim");
    fs.mkdirSync(log);
    fs.mkdirSync(path.join(victim, "wt"), { recursive: true });
    fs.symlinkSync(".", path.join(log, "l"));
    return { log, victim };
  }

  /** The strict resolver's error for `spelling`, or `undefined`. */
  function refusal(spelling: string): unknown {
    try {
      resolveDeepestExisting(spelling);
    } catch (err) {
      return err;
    }
    return undefined;
  }

  it("a link whose physical location is longer than PATH_MAX is refused, and no less so behind a spent link budget: the kernel follows it either way", () => {
    const { log, victim } = logAndVictim();
    deepLink(log, victim, "U");
    // The shape is live: the kernel reaches <victim>/wt through it.
    expect(
      sameDirectory(path.join(log, "U", "wt"), path.join(victim, "wt")),
    ).toBe(true);
    for (const [steps, code] of [
      [0, "ENAMETOOLONG"],
      // `U` is the 64th link and the first link of its target the 65th.
      [63, "ELOOP"],
      // `U` itself is the 65th link.
      [64, "ELOOP"],
    ] as const) {
      const spelling = `${log}/${"l/".repeat(steps)}U/wt`;
      const thrown = refusal(spelling);
      expect(thrown).toBeInstanceOf(UnresolvablePathError);
      expect((thrown as UnresolvablePathError).code).toBe(code);
      // The lenient one never throws: it keeps the spelling inside
      // <log>, which is why nothing that acts on a path may use it.
      expect(resolveDeepestExistingLenient(spelling)).toBe(
        path.join(log, "U", "wt"),
      );
    }
  });

  it.skipIf(!canLchmod)(
    "a symlink whose own mode is 000 is refused, and no less so behind a spent link budget: the kernel follows it either way",
    () => {
      const { log, victim } = logAndVictim();
      fs.symlinkSync(victim, path.join(log, "U"));
      fs.lchmodSync(path.join(log, "U"), 0o000);
      expect(
        sameDirectory(path.join(log, "U", "wt"), path.join(victim, "wt")),
      ).toBe(true);
      for (const [steps, code] of [
        [0, "EACCES"],
        [63, "EACCES"],
        [64, "ELOOP"],
      ] as const) {
        const spelling = `${log}/${"l/".repeat(steps)}U/wt`;
        const thrown = refusal(spelling);
        expect(thrown).toBeInstanceOf(UnresolvablePathError);
        expect((thrown as UnresolvablePathError).code).toBe(code);
        expect(resolveDeepestExistingLenient(spelling)).toBe(
          path.join(log, "U", "wt"),
        );
      }
    },
  );

  const caseInsensitiveTmp = (() => {
    const probeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-primitives-case-probe-"),
    );
    try {
      return fs.existsSync(probeDir.toUpperCase());
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  })();

  it.skipIf(!caseInsensitiveTmp)(
    "a case variant of an existing directory keeps the case it was given, as the link policy's alias checks need, by both and by the link-source resolver",
    () => {
      const base = makeTmpDir();
      fs.mkdirSync(path.join(base, "MixedCase"));
      const variant = path.join(base, "mixedcase");
      expect(resolveDeepestExisting(variant)).toBe(variant);
      expect(resolveDeepestExistingLenient(variant)).toBe(variant);
      expect(resolveDeepestExisting(path.join(variant, "new.js"))).toBe(
        path.join(variant, "new.js"),
      );
      expect(resolvePhysicalLocation(path.join(variant, "new.js"))).toBe(
        path.join(variant, "new.js"),
      );
    },
  );
});

describe("the worktree cleanup gate judges the physical location and removes exactly it", () => {
  const U = "wt-00000000-0000-4000-8000-000000000000";

  /** A dead pid, for a marker no live probe owns. */
  function deadPid(): number {
    const pid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!pid) throw new Error("failed to obtain a dead pid for the test");
    return pid;
  }

  function plantMarker(repo: string, targetPath: string, scratchRoot: string) {
    const realRoot = resolveDeepestExisting(repo);
    writeMarker(realRoot, {
      targetPath,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid(),
      timestamp: new Date().toISOString(),
      scratchRoot,
    });
    return realRoot;
  }

  function repoOnly(): string {
    return fixture().repo;
  }

  function probeRun(
    repo: string,
    logDir: string,
  ): Promise<{
    status: string;
    reason?: string;
    warnings: string[];
  }> {
    return probe({
      file: "fixture.js",
      line: 2,
      form: "replace",
      replaceText: "  return true;",
      testCommand: "node fixture.test.js",
      isolation: "worktree",
      expect: "fail",
      cwd: repo,
      logDir,
    });
  }

  it("scenario A, <log-dir>/link/../wt-<uuid>/wt with link -> <outside>/sub: the marker is refused and kept, <outside>/wt-<uuid>/wt is untouched", async () => {
    useLockDir();
    const repo = repoOnly();
    const logDir = makeTmpDir();
    const outside = makeTmpDir();
    fs.mkdirSync(path.join(outside, "sub"));
    const victim = path.join(outside, U, "wt");
    fs.mkdirSync(path.join(victim, "precious"), { recursive: true });
    fs.writeFileSync(path.join(victim, "precious", "data.txt"), "keep me\n");
    fs.symlinkSync(path.join(outside, "sub"), path.join(logDir, "link"));
    const targetPath = `${logDir}/link/../${U}/wt`;
    const realRoot = plantMarker(repo, targetPath, logDir);

    const result = await probeRun(repo, logDir);

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("stale_worktree");
    expect(result.warnings.join("\n")).toContain(markerFilePathFor(realRoot));
    expect(readMarkerFor(realRoot)?.targetPath).toBe(targetPath);
    expect(
      fs.readFileSync(path.join(victim, "precious", "data.txt"), "utf8"),
    ).toBe("keep me\n");
  });

  it("scenario B, <log-dir>/wt-<uuid>/wt/link/.. with link -> <victim>/sub: the marker is refused and kept, <victim> is untouched", async () => {
    useLockDir();
    const repo = repoOnly();
    const logDir = makeTmpDir();
    const victim = makeTmpDir();
    fs.mkdirSync(path.join(victim, "sub"));
    fs.mkdirSync(path.join(victim, "docs"));
    fs.writeFileSync(path.join(victim, "docs", "thesis.txt"), "keep me\n");
    fs.writeFileSync(path.join(victim, "top.txt"), "keep me\n");
    fs.mkdirSync(path.join(logDir, U, "wt"), { recursive: true });
    fs.symlinkSync(
      path.join(victim, "sub"),
      path.join(logDir, U, "wt", "link"),
    );
    const targetPath = `${logDir}/${U}/wt/link/..`;
    const realRoot = plantMarker(repo, targetPath, logDir);

    const result = await probeRun(repo, logDir);

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("stale_worktree");
    expect(readMarkerFor(realRoot)?.targetPath).toBe(targetPath);
    expect(fs.readdirSync(victim).sort()).toEqual(["docs", "sub", "top.txt"]);
    expect(
      fs.readFileSync(path.join(victim, "docs", "thesis.txt"), "utf8"),
    ).toBe("keep me\n");
  });

  for (const dot of [".", ".."]) {
    it(`a recorded path with a "${dot}" component is refused even where its physical location is a scratch worktree under the log dir`, async () => {
      const repo = repoOnly();
      const logDir = makeTmpDir();
      const scratch = path.join(logDir, U, "wt");
      fs.mkdirSync(path.join(scratch, "keep"), { recursive: true });
      fs.mkdirSync(path.join(logDir, "a"));
      const recorded =
        dot === "." ? `${logDir}/./${U}/wt` : `${logDir}/a/../${U}/wt`;
      const cleanup = await cleanupWorktree(repo, recorded, logDir, {
        scratchRoot: logDir,
      });
      expect(cleanup.ok).toBe(false);
      expect(cleanup.refused).toBe(true);
      expect(cleanup.detail).toContain(`refusing to remove ${recorded}`);
      expect(cleanup.detail).toContain(`"${dot}" component`);
      expect(fs.existsSync(path.join(scratch, "keep"))).toBe(true);
    });
  }

  for (const shape of ["l -> . steps", "a link chain"] as const) {
    it(`a recorded path behind 64 or more links (${shape}) ahead of a symlinked wt-<uuid>: the marker is refused and kept, <victim>/wt is untouched`, async () => {
      useLockDir();
      const repo = repoOnly();
      const logDir = makeTmpDir();
      const victim = makeTmpDir();
      fs.mkdirSync(path.join(victim, "wt", "docs"), { recursive: true });
      fs.writeFileSync(path.join(victim, "wt", "docs", "thesis.txt"), "keep\n");
      let targetPath: string;
      if (shape === "l -> . steps") {
        fs.symlinkSync(".", path.join(logDir, "l"));
        fs.symlinkSync(victim, path.join(logDir, U));
        targetPath = `${logDir}/${"l/".repeat(64)}${U}/wt`;
      } else {
        fs.mkdirSync(path.join(logDir, "real"));
        fs.symlinkSync(victim, path.join(logDir, "real", U));
        let previous = "real";
        for (let i = 0; i < 64; i++) {
          fs.symlinkSync(previous, path.join(logDir, `c${String(i)}`));
          previous = `c${String(i)}`;
        }
        targetPath = `${logDir}/${previous}/${U}/wt`;
      }
      const realRoot = plantMarker(repo, targetPath, logDir);

      const result = await probeRun(repo, logDir);

      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("stale_worktree");
      expect(readMarkerFor(realRoot)?.targetPath).toBe(targetPath);
      expect(
        fs.readFileSync(path.join(victim, "wt", "docs", "thesis.txt"), "utf8"),
      ).toBe("keep\n");
    });
  }

  for (const shape of [
    "a link to an over-PATH_MAX location",
    "a mode-000 link",
  ] as const) {
    for (const steps of [0, 64]) {
      it.skipIf(shape === "a mode-000 link" && !canLchmod)(
        `a recorded path whose wt-<uuid> is ${shape} the walk cannot read but the kernel follows, behind ${String(steps)} \`l -> .\` steps: the marker is refused and kept, <victim>/wt is untouched`,
        async () => {
          useLockDir();
          const repo = repoOnly();
          const logDir = makeTmpDir();
          const victim = makeTmpDir();
          fs.mkdirSync(path.join(victim, "wt", "docs"), { recursive: true });
          fs.writeFileSync(
            path.join(victim, "wt", "docs", "thesis.txt"),
            "keep\n",
          );
          fs.symlinkSync(".", path.join(logDir, "l"));
          if (shape === "a mode-000 link") {
            fs.symlinkSync(victim, path.join(logDir, U));
            fs.lchmodSync(path.join(logDir, U), 0o000);
          } else {
            deepLink(logDir, victim, U);
          }
          // The recorded path is live for the kernel: a removal of the
          // spelling <log-dir>/wt-<uuid>/wt would empty <victim>/wt.
          expect(
            sameDirectory(path.join(logDir, U, "wt"), path.join(victim, "wt")),
          ).toBe(true);
          const targetPath = `${logDir}/${"l/".repeat(steps)}${U}/wt`;
          const realRoot = plantMarker(repo, targetPath, logDir);

          const result = await probeRun(repo, logDir);

          expect(result.status).toBe("inconclusive");
          expect(result.reason).toBe("stale_worktree");
          expect(readMarkerFor(realRoot)?.targetPath).toBe(targetPath);
          expect(
            fs.readFileSync(
              path.join(victim, "wt", "docs", "thesis.txt"),
              "utf8",
            ),
          ).toBe("keep\n");
        },
      );
    }
  }

  /** A `git` on PATH that re-points `lnk` at `to` the first time the
   * gate lists the registered worktrees (after the judgement, before the
   * removal); `flag` records that it did. */
  function repointingGit(
    lnk: string,
    to: string,
  ): { binDir: string; flag: string } {
    const binDir = makeTmpDir();
    const flag = path.join(binDir, "swapped");
    const shim = path.join(binDir, "git");
    fs.writeFileSync(
      shim,
      [
        "#!/bin/sh",
        `case " $* " in *" worktree list "*)`,
        `  if [ ! -e '${flag}' ]; then`,
        `    : > '${flag}'`,
        `    rm -f '${lnk}'`,
        `    ln -s '${to}' '${lnk}'`,
        "  fi",
        "  ;;",
        "esac",
        `exec '${realGitPath()}' "$@"`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(shim, 0o755);
    return { binDir, flag };
  }

  it("a re-pointed component reaching another registered worktree of the repository: git worktree remove gets the judged location, and the other worktree stays registered and on disk", async () => {
    const repo = repoOnly();
    const logDir = makeTmpDir();
    const elsewhere = makeTmpDir();
    const judged = path.join(logDir, "real", U, "wt");
    fs.mkdirSync(judged, { recursive: true });
    const other = path.join(elsewhere, U, "wt");
    fs.mkdirSync(path.dirname(other));
    git(repo, ["worktree", "add", "--detach", "--", other, "HEAD"]);
    const lnk = path.join(logDir, "lnk");
    fs.symlinkSync(path.join(logDir, "real"), lnk);
    const recorded = path.join(lnk, U, "wt");
    const { binDir, flag } = repointingGit(lnk, elsewhere);

    const cleanup = await withPathPrepended(binDir, () =>
      cleanupWorktree(repo, recorded, logDir, { scratchRoot: logDir }),
    );

    expect(fs.existsSync(flag)).toBe(true);
    expect(cleanup.refused).toBe(false);
    expect(fs.existsSync(judged)).toBe(false);
    expect(fs.existsSync(path.join(other, "fixture.js"))).toBe(true);
    expect(git(repo, ["worktree", "list", "--porcelain"])).toContain(
      `worktree ${fs.realpathSync(other)}`,
    );
  });

  it("a symlinked component re-pointed while the gate runs git does not redirect the removal: the judged location is removed, never the new target", async () => {
    const repo = repoOnly();
    const logDir = makeTmpDir();
    const elsewhere = makeTmpDir();
    // The scratch worktree the gate judges: `<log-dir>/real/wt-<uuid>/wt`,
    // recorded through `<log-dir>/lnk -> real`.
    const judged = path.join(logDir, "real", U, "wt");
    fs.mkdirSync(judged, { recursive: true });
    fs.writeFileSync(path.join(judged, "scratch.txt"), "scratch\n");
    // What the recorded spelling reaches once `lnk` is re-pointed.
    const victim = path.join(elsewhere, U, "wt");
    fs.mkdirSync(path.join(victim, "precious"), { recursive: true });
    fs.writeFileSync(path.join(victim, "precious", "data.txt"), "keep me\n");
    const lnk = path.join(logDir, "lnk");
    fs.symlinkSync(path.join(logDir, "real"), lnk);
    const recorded = path.join(lnk, U, "wt");

    const { binDir, flag } = repointingGit(lnk, elsewhere);

    const cleanup = await withPathPrepended(binDir, () =>
      cleanupWorktree(repo, recorded, logDir, { scratchRoot: logDir }),
    );

    expect(fs.existsSync(flag)).toBe(true);
    expect(cleanup.refused).toBe(false);
    expect(cleanup.ok).toBe(true);
    expect(fs.existsSync(judged)).toBe(false);
    expect(
      fs.readFileSync(path.join(victim, "precious", "data.txt"), "utf8"),
    ).toBe("keep me\n");
  });
});

describe("a plan file named through a symlinked step whose target walks .. into the repository", () => {
  it("is not operator input: the step is placed where the kernel follows it, inside the root", () => {
    const base = makeTmpDir();
    const root = path.join(base, "x", "R");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(base, "x", "y"));
    const elsewhere = makeTmpDir();
    fs.writeFileSync(path.join(elsewhere, "plan.json"), "{}\n");
    fs.symlinkSync(
      path.join(elsewhere, "plan.json"),
      path.join(root, "link.json"),
    );
    // `<base>/a/dd -> odl/../R` with `odl -> <base>/x/y` is `<base>/x/R`
    // (the root) to the kernel; the JavaScript `realpath` would spell it
    // `<base>/a/R`, a decoy directory outside the root.
    const a = path.join(base, "a");
    fs.mkdirSync(path.join(a, "R"), { recursive: true });
    fs.symlinkSync(path.join(base, "x", "y"), path.join(a, "odl"));
    fs.symlinkSync("odl/../R", path.join(a, "dd"));
    const planPath = path.join(a, "dd", "link.json");
    expect(
      linkSourceIsOperatorInput(
        {
          kind: "plan",
          planPath,
          planRealPath: fs.realpathSync.native(
            path.join(elsewhere, "plan.json"),
          ),
        },
        fs.realpathSync.native(root),
      ),
    ).toBe(false);
  });
});

/** `<base>/ll -> sub/../realdir` with `sub -> <base>/deep/er`: `<base>/ll`
 * is `<base>/deep/realdir` to the kernel, while the JavaScript `realpath`
 * spells it `<base>/realdir`, a decoy directory that holds nothing. */
function dotdotAncestor(): { spelled: string; physical: string } {
  const base = makeTmpDir();
  fs.mkdirSync(path.join(base, "deep", "er"), { recursive: true });
  fs.mkdirSync(path.join(base, "deep", "realdir"));
  fs.mkdirSync(path.join(base, "realdir"));
  fs.symlinkSync(path.join(base, "deep", "er"), path.join(base, "sub"));
  fs.symlinkSync("sub/../realdir", path.join(base, "ll"));
  return {
    spelled: path.join(base, "ll"),
    physical: path.join(fs.realpathSync.native(base), "deep", "realdir"),
  };
}

describe("a plan file named through a later step below a prefix whose symlink target walks ..", () => {
  it("is not operator input: every step after that prefix is judged below where the kernel puts it", () => {
    const base = makeTmpDir();
    const root = path.join(base, "x", "R");
    fs.mkdirSync(path.join(root, "dir"), { recursive: true });
    fs.mkdirSync(path.join(base, "x", "y"));
    fs.mkdirSync(path.join(base, "x", "E"));
    const elsewhere = makeTmpDir();
    fs.writeFileSync(path.join(elsewhere, "plan.json"), "{}\n");
    fs.symlinkSync(
      path.join(elsewhere, "plan.json"),
      path.join(root, "dir", "plan.json"),
    );
    // The kernel's route: `<base>/a/dd -> odl/../E` is `<base>/x/E`, whose
    // `s` links into `<root>/dir`.
    fs.symlinkSync(path.join(root, "dir"), path.join(base, "x", "E", "s"));
    const a = path.join(base, "a");
    fs.mkdirSync(path.join(a, "E"), { recursive: true });
    fs.symlinkSync(path.join(base, "x", "y"), path.join(a, "odl"));
    fs.symlinkSync("odl/../E", path.join(a, "dd"));
    // The decoy the JavaScript `realpath` reaches instead: `<base>/a/E/s`.
    const decoy = makeTmpDir();
    fs.symlinkSync(decoy, path.join(a, "E", "s"));
    fs.symlinkSync(
      path.join(elsewhere, "plan.json"),
      path.join(decoy, "plan.json"),
    );
    expect(
      linkSourceIsOperatorInput(
        {
          kind: "plan",
          planPath: path.join(a, "dd", "s", "plan.json"),
          planRealPath: fs.realpathSync(path.join(elsewhere, "plan.json")),
        },
        fs.realpathSync.native(root),
      ),
    ).toBe(false);
  });
});

describe("a directory reached through an ancestor whose symlink target walks ..", () => {
  it("a --log-dir there: the -i worktree copy is judged at its physical location and the run completes", async () => {
    const lockDir = useLockDir();
    const fx = fixture();
    const { spelled, physical } = dotdotAncestor();
    const result = await probe({
      file: "fixture.js",
      line: 2,
      form: "replace",
      replaceText: "  return true;",
      testCommand: "node fixture.test.js",
      isolation: "worktree",
      expect: "fail",
      cwd: fx.repo,
      logDir: path.join(spelled, "logs"),
    });
    expect(result.reason ?? "").not.toBe("worktree_sync_failed");
    expect(result.status).toBe("killed");
    expect(fs.existsSync(path.join(physical, "logs"))).toBe(true);
    expectNoIsolationLeftovers(fx.repo, lockDir);
  });

  it("an init --target-dir there: the target is written inside it, judged where the kernel puts it", () => {
    const { spelled, physical } = dotdotAncestor();
    const targetDir = path.join(spelled, "target");
    fs.mkdirSync(path.join(physical, "target"));
    const result = init({ targetDir, content: "skill\n" });
    expect(result.status).toBe("written");
    const written = path.join(
      physical,
      "target",
      path.relative(targetDir, result.targets[0]!.path),
    );
    expect(fs.readFileSync(written, "utf8")).toBe("skill\n");
  });
});

describe("a --log-dir behind a symlinked ancestor and a link chain exactly as long as the kernel follows", () => {
  /** The longest chain of links to a directory the kernel follows in
   * one lookup on this platform (32 on macOS, 40 on Linux). */
  function kernelLinkLimit(): number {
    const base = makeTmpDir();
    fs.mkdirSync(path.join(base, "real"));
    let previous = "real";
    for (let links = 1; links <= 64; links++) {
      const name = `k${String(links)}`;
      fs.symlinkSync(previous, path.join(base, name));
      try {
        fs.statSync(path.join(base, name));
      } catch {
        return links - 1;
      }
      previous = name;
    }
    return 64;
  }

  it("an operator --link to such a chain is linked: the copy's destination is judged from the copy's physical root, where the log dir's own symlink does not count against the kernel's limit", async () => {
    useLockDir();
    const fx = fixture();
    const limit = kernelLinkLimit();
    expect(limit).toBeLessThan(64);
    let next = path.join(fx.outside, "odir");
    for (let i = limit; i >= 1; i--) {
      const hop = path.join(fx.repo, `hop${String(i)}`);
      fs.symlinkSync(next, hop);
      next = hop;
    }
    const head = path.join(fx.repo, "hop1");
    expect(fs.statSync(head).isDirectory()).toBe(true);
    // One symlinked ancestor ahead of the same chain is one link too
    // many for the kernel, which is what the destination in the copy
    // would be if it were spelled through the log dir as given.
    const behind = makeTmpDir();
    fs.symlinkSync(head, path.join(behind, "hop1"));
    const alias = path.join(makeTmpDir(), "alias");
    fs.symlinkSync(behind, alias);
    expect(() => fs.statSync(path.join(alias, "hop1"))).toThrow(/ELOOP/);

    const realLogs = makeTmpDir();
    const logDir = path.join(makeTmpDir(), "to-logs");
    fs.symlinkSync(realLogs, logDir);
    const result = await probe({
      file: "fixture.js",
      line: 2,
      form: "replace",
      replaceText: "  return true;",
      testCommand: "node fixture.test.js",
      isolation: "worktree",
      expect: "fail",
      cwd: fx.repo,
      logDir,
      links: ["hop1"],
    });
    expect(result.reason ?? "").not.toBe("worktree_sync_failed");
    expect(result.status).toBe("killed");
    expect(result.isolation.linked).toEqual([head]);
  });
});

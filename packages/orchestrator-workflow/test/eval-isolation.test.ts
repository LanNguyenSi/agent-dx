import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CLAUDE_TMPDIR_MAX_BYTES,
  DISALLOWED_TOOLS,
  KNOWN_SECRET_NAMES,
  checkPlacement,
  checkScratchRoot,
  createRunScratch,
  currentUid,
  defaultScratchRoot,
  leakedSecretNames,
  maxTmpPathBytes,
  normalizeEnvName,
  scratchPathForms,
  resolveChecked,
  scratchTmpPathBytes,
  sessionNpmCache,
  unsafeAncestor,
  hostGitEnv,
  isGitConfigEnvName,
  isInside,
  isSandboxInjectedName,
  pathForms,
  redactPaths,
  redactSecrets,
  scanForSecrets,
  secretValues,
  sessionSettings,
  systemTempRoots,
} from "../eval/isolation.js";
import {
  leftoverTotal,
  parseGuardEnvelope,
  parseLsofPlaces,
  placesInside,
  runGuarded,
  sweepByCwd,
} from "../eval/processes.js";
import type { ProcessPlaces } from "../eval/processes.js";
import { FAKE_GUARD } from "./eval-helpers.js";

let work: string;

/**
 * Whether a `Tool(//abs/path)` deny rule in `rules` covers `path`, read the
 * way Claude Code reads Read and Edit paths (gitignore style): `*` stays
 * within one path segment, a trailing `/**` covers everything below.
 */
function denies(rules: string[], tool: string, path: string): boolean {
  const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return rules.some((rule) => {
    const m = new RegExp(`^${tool}\\(/(/.*)\\)$`).exec(rule);
    if (m === null) return false;
    const source = m[1]
      .split("/**")
      .map((part) => part.split("*").map(escape).join("[^/]*"))
      .join("(?:/.*)?");
    return new RegExp(`^${source}$`).test(path);
  });
}

beforeAll(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "ow-eval-iso-")));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("run scratch", () => {
  it("creates an opaque run directory with empty session directories", () => {
    const a = createRunScratch(join(work, "s"));
    const b = createRunScratch(join(work, "s"));
    expect(a.id).toMatch(/^[0-9a-f]{8}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.root).toBe(join(work, "s", a.id));
    for (const dir of [a.evidence, a.runFiles, a.tmp, a.gh, a.meta]) {
      expect(readdirSync(dir), dir).toEqual([]);
    }
    expect(readdirSync(a.home)).toEqual([".claude"]);
    expect(a.configDir).toBe(join(a.home, ".claude"));
  });

  it("creates the scratch root and every run directory for the owner only", () => {
    const root = join(work, "private-root");
    const previous = process.umask(0o022);
    try {
      const a = createRunScratch(root);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(a.root).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previous);
    }
    // A umask that takes one of the owner's own bits still leaves both directories 0700.
    const narrow = process.umask(0o400);
    let b: ReturnType<typeof createRunScratch>;
    try {
      b = createRunScratch(join(work, "narrow-root"));
    } finally {
      process.umask(narrow);
    }
    expect(statSync(b.root).mode & 0o777).toBe(0o700);
    expect(statSync(join(work, "narrow-root")).mode & 0o777).toBe(0o700);
    // The session directories inside keep the umask's mode; make them listable for the cleanup.
    for (const dir of [
      b.evidence,
      b.runFiles,
      b.home,
      b.configDir,
      b.tmp,
      b.gh,
      b.meta,
    ])
      chmodSync(dir, 0o700);
  });

  it("refuses a scratch root that is a symlink, foreign or writable by others", () => {
    const real = join(work, "real-root");
    mkdirSync(real, { mode: 0o700 });
    expect(checkScratchRoot(real)).toBeNull();
    // A root that does not exist yet passes: it is created 0700.
    expect(checkScratchRoot(join(work, "not-yet"))).toBeNull();

    const link = join(work, "link-root");
    symlinkSync(real, link);
    expect(checkScratchRoot(link)).toContain("symbolic link");
    expect(() => createRunScratch(link)).toThrow(/symbolic link/);

    const open = join(work, "open-root");
    mkdirSync(open);
    for (const mode of [0o777, 0o775, 0o757]) {
      chmodSync(open, mode);
      expect(checkScratchRoot(open), mode.toString(8)).toContain(
        "group or others",
      );
    }
    chmodSync(open, 0o755);
    expect(checkScratchRoot(open)).toBeNull();
    chmodSync(open, 0o777);
    expect(() => createRunScratch(open)).toThrow(/group or others/);
    expect(readdirSync(open)).toEqual([]);

    const uid = statSync(real).uid;
    expect(checkScratchRoot(real, uid)).toBeNull();
    expect(checkScratchRoot(real, uid + 1)).toContain(`owned by uid ${uid}`);

    const file = join(work, "file-root");
    writeFileSync(file, "");
    expect(checkScratchRoot(file)).toContain("not a directory");
  });
});

describe("scratch root ancestors", () => {
  const uid = (): number => statSync(work).uid;
  const dir = (name: string, mode: number): string => {
    const path = mkdtempSync(join(work, `${name}-`));
    chmodSync(path, mode);
    return path;
  };

  it("refuses a root below a directory the group or others can write without the sticky bit", () => {
    for (const mode of [0o777, 0o775, 0o757, 0o722]) {
      const shared = dir("anc-open", mode);
      // The root does not exist yet: it would be created inside the open directory.
      const message = checkScratchRoot(join(shared, "root"));
      expect(message, mode.toString(8)).toContain("unsafe directory");
      expect(message, mode.toString(8)).toContain(shared);
      expect(message, mode.toString(8)).toContain("sticky bit");
      expect(() => createRunScratch(join(shared, "root"))).toThrow(
        /unsafe directory/,
      );
      chmodSync(shared, 0o700);
    }
  });

  it("looks past the parent, at every ancestor up to the file system root", () => {
    const shared = dir("anc-deep", 0o777);
    const deep = join(shared, "a", "b");
    mkdirSync(deep, { recursive: true });
    chmodSync(join(shared, "a"), 0o755);
    chmodSync(deep, 0o700);
    // The root itself is fine (0700, ours); the open directory is two levels above it.
    const root = join(deep, "root");
    mkdirSync(root, { mode: 0o700 });
    const message = checkScratchRoot(root);
    expect(message).toContain(shared);
    expect(message).toContain("unsafe directory");
    chmodSync(shared, 0o700);
    expect(checkScratchRoot(root)).toBeNull();
  });

  it("accepts a sticky shared parent, such as /tmp or /Users/Shared, and a private one", () => {
    const sticky = dir("anc-sticky", 0o1777);
    expect(checkScratchRoot(join(sticky, "root"))).toBeNull();
    const group = dir("anc-sticky-group", 0o1775);
    expect(checkScratchRoot(join(group, "root"))).toBeNull();
    const closed = dir("anc-closed", 0o755);
    expect(checkScratchRoot(join(closed, "root"))).toBeNull();
    chmodSync(sticky, 0o700);
    chmodSync(group, 0o700);
  });

  it("refuses an ancestor owned by an account that is neither you nor root", () => {
    const parent = dir("anc-owner", 0o755);
    const message = checkScratchRoot(join(parent, "root"), uid() + 1);
    expect(message).toContain(`owned by uid ${uid()}`);
    expect(message).toContain("unsafe directory");
    // The same chain is fine for its owner.
    expect(checkScratchRoot(join(parent, "root"), uid())).toBeNull();
  });

  it("follows a symbolic link in the path instead of trusting it", () => {
    const open = dir("anc-link-target", 0o777);
    const link = join(work, `anc-link-${uid()}`);
    symlinkSync(open, link);
    const message = checkScratchRoot(join(link, "root"));
    expect(message).toContain("unsafe directory");
    expect(message).toContain(open);
    chmodSync(open, 0o700);
  });

  it("judges the ancestors only: the path itself is the caller's to check", () => {
    const parent = dir("anc-self", 0o755);
    const open = join(parent, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    // The path is writable by others, its parent is not: not an ancestor problem.
    expect(unsafeAncestor(open, uid())).toBeNull();
    expect(unsafeAncestor(join(open, "child"), uid())).toContain(open);
    chmodSync(open, 0o700);
  });

  it("refuses a dangling symbolic link in the path, and creates nothing where it points", () => {
    const parent = dir("anc-dangling", 0o755);
    const target = join(parent, "later");
    const link = join(parent, "dl");
    symlinkSync(target, link);
    const root = join(link, "oe");
    const message = checkScratchRoot(root);
    expect(message).toContain(
      `${link} is a symbolic link to ${target}, which does not exist`,
    );
    expect(() => createRunScratch(root)).toThrow(/does not exist/);
    expect(existsSync(target)).toBe(false);
    // Once the target exists (and is safe), the same path is accepted.
    mkdirSync(target, { mode: 0o700 });
    expect(checkScratchRoot(root)).toBeNull();
    // A dangling link as the last component is the caller's: the root itself is a link.
    rmSync(target, { recursive: true });
    expect(unsafeAncestor(link, uid())).toContain("does not exist");
  });

  it("refuses a symbolic link in the path that another account owns", () => {
    const parent = dir("anc-link-owner", 0o755);
    const real = join(parent, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(parent, "link");
    symlinkSync(real, link);
    // As seen by another uid, the link (owned by this test's uid) is foreign: it is refused as a link.
    const message = unsafeAncestor(join(link, "root"), uid() + 1);
    expect(message).toBe(
      `${link} is a symbolic link owned by uid ${uid()}, who could point it elsewhere`,
    );
    expect(unsafeAncestor(join(link, "root"), uid())).toBeNull();
  });

  it("resolves relative links and chains of links before it judges the ancestors", () => {
    const parent = dir("anc-chain", 0o755);
    const open = join(parent, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const closed = join(parent, "closed");
    mkdirSync(closed, { mode: 0o700 });
    // first -> second -> ../closed (relative), so the root lands in the closed directory.
    mkdirSync(join(parent, "sub"), { mode: 0o755 });
    symlinkSync("../closed", join(parent, "sub", "second"));
    symlinkSync(join(parent, "sub", "second"), join(parent, "first"));
    expect(resolveChecked(join(parent, "first", "root"), uid())).toEqual({
      existing: closed,
      missing: ["root"],
    });
    expect(checkScratchRoot(join(parent, "first", "root"))).toBeNull();
    // The same chain into the open directory is refused at the open directory.
    symlinkSync("../open", join(parent, "sub", "third"));
    symlinkSync(join(parent, "sub", "third"), join(parent, "fourth"));
    expect(checkScratchRoot(join(parent, "fourth", "root"))).toContain(
      `${open} can be written by the group or others`,
    );
    chmodSync(open, 0o700);
  });

  it("stops at a loop of symbolic links and at a path below a file", () => {
    const parent = dir("anc-loop", 0o755);
    symlinkSync(join(parent, "b"), join(parent, "a"));
    symlinkSync(join(parent, "a"), join(parent, "b"));
    // Both links point at each other: stat fails, so the link counts as dangling.
    expect(unsafeAncestor(join(parent, "a", "root"), uid())).toContain(
      "which does not exist",
    );
    const file = join(parent, "file");
    writeFileSync(file, "");
    const below = resolveChecked(join(file, "root"), uid());
    expect(below).toHaveProperty("error");
    expect((below as { error: string }).error).toContain(
      `${join(file, "root")} cannot be inspected`,
    );
    expect(checkScratchRoot(join(file, "root"))).toContain(
      "cannot be inspected",
    );
  });

  it("follows at most 40 symbolic links", () => {
    const parent = dir("anc-many", 0o755);
    const real = join(parent, "real");
    mkdirSync(real, { mode: 0o700 });
    // A chain of n links, each pointing at the next, the last at the real directory.
    const chain = (n: number, name: string): string => {
      let next = real;
      for (let i = n; i >= 1; i -= 1) {
        const link = join(parent, `${name}${i}`);
        symlinkSync(next, link);
        next = link;
      }
      return next;
    };
    // stat itself follows at most 32 links on macOS, so the bound is reached through the path, part by part.
    const mid = chain(20, "p");
    const deep = join(parent, "deep");
    mkdirSync(deep, { mode: 0o700 });
    const second = join(deep, "q");
    symlinkSync(mid, second);
    expect(resolveChecked(join(second, "root"), uid())).toEqual({
      existing: real,
      missing: ["root"],
    });
    const third = join(real, "r");
    symlinkSync(chain(20, "s"), third);
    const over = resolveChecked(join(second, "r", "root"), uid());
    expect(over).toEqual({
      error: `${join(second, "r", "root")} has more than 40 symbolic links`,
    });
    rmSync(third);
  });

  it("checks the root before it creates it", () => {
    const shared = dir("anc-before", 0o777);
    const root = join(shared, "root");
    expect(() => createRunScratch(root)).toThrow(/unsafe directory/);
    expect(existsSync(root)).toBe(false);
    chmodSync(shared, 0o700);
  });

  it("checks the directory above an existing root too", () => {
    const shared = dir("anc-existing", 0o777);
    const root = join(shared, "root");
    mkdirSync(root, { mode: 0o700 });
    expect(checkScratchRoot(root)).toContain("unsafe directory");
    chmodSync(shared, 0o755);
    expect(checkScratchRoot(root)).toBeNull();
  });
});

describe("placement of scratch and results", () => {
  const base = {
    scratchRoot: "/srv/scratch",
    outDir: "/srv/results",
    datasetDir: "/srv/data/dataset",
    home: "/home/someone",
    tempRoots: ["/tmp", "/private/tmp"],
  };

  it("accepts directories outside the dataset tree, the home and the temp roots", () => {
    expect(checkPlacement(base)).toBeNull();
  });

  it("refuses a scratch directory inside a temp root, in any form of it, and says why", () => {
    for (const scratchRoot of ["/tmp/eval-scratch", "/private/tmp/a/b"]) {
      const message = checkPlacement({ ...base, scratchRoot });
      expect(message, scratchRoot).toContain("--scratch");
      expect(message, scratchRoot).toContain("inside a temp root");
      expect(message, scratchRoot).toContain("own checkout");
    }
    // The host's own temp roots apply when none are passed.
    expect(
      checkPlacement({
        scratchRoot: join(tmpdir(), "eval-scratch"),
        outDir: "/srv/results",
        datasetDir: "/srv/data/dataset",
        home: "/home/someone",
      }),
    ).toContain("inside a temp root");
    // The temp root itself is refused; a sibling with the same prefix is not.
    expect(checkPlacement({ ...base, scratchRoot: "/tmp" })).toContain(
      "inside a temp root",
    );
    expect(checkPlacement({ ...base, scratchRoot: "/tmpfoo/x" })).toBeNull();
  });

  it("refuses a results or scratch directory in the dataset's parent tree", () => {
    expect(checkPlacement({ ...base, outDir: "/srv/data/out" })).toContain(
      "--out",
    );
    expect(checkPlacement({ ...base, outDir: "/srv/data" })).toContain("--out");
    expect(
      checkPlacement({ ...base, scratchRoot: "/srv/data/dataset/s" }),
    ).toContain("--scratch");
  });

  it("refuses a scratch directory in the home or in the results", () => {
    expect(
      checkPlacement({ ...base, scratchRoot: "/home/someone/tmp" }),
    ).toContain("inside the home directory");
    expect(
      checkPlacement({ ...base, scratchRoot: "/home/someone/tmp" }),
    ).toContain("own checkout");
    expect(
      checkPlacement({ ...base, scratchRoot: "/srv/results/scratch" }),
    ).toContain("inside --out");
  });

  it("refuses a scratch whose tmp path is over the limit, naming the fallback", () => {
    // /srv/scratch + / + 8 hex + /tmp = 25 bytes: fine.
    expect(scratchTmpPathBytes("/srv/scratch")).toBe(25);
    expect(checkPlacement(base)).toBeNull();
    // Exactly at this uid's limit passes, one byte over is refused.
    const limit = maxTmpPathBytes();
    const atLimit = "/srv/" + "x".repeat(limit - 5 - 13);
    expect(scratchTmpPathBytes(atLimit)).toBe(limit);
    expect(checkPlacement({ ...base, scratchRoot: atLimit })).toBeNull();
    const over = checkPlacement({ ...base, scratchRoot: `${atLimit}x` });
    expect(over).toContain("--scratch");
    expect(over).toContain("too long");
    expect(over).toContain(`${limit + 1} bytes`);
    expect(over).toContain(`the limit is ${limit} bytes`);
    expect(over).toContain("/tmp/claude-<uid>");
    // The 38 byte path measured to fall back for uid 501 is refused there.
    const measured = "/Users/Shared/ow-eval";
    expect(scratchTmpPathBytes(measured)).toBe(34);
    expect(
      checkPlacement({ ...base, scratchRoot: measured, maxTmpPath: 33 }),
    ).toContain("too long");
    // The seam raises the limit.
    expect(
      checkPlacement({ ...base, scratchRoot: `${atLimit}x`, maxTmpPath: 40 }),
    ).toBeNull();
  });

  it("derives the limit from Claude Code's 44 byte bound and the uid, in bytes", () => {
    expect(CLAUDE_TMPDIR_MAX_BYTES).toBe(44);
    // 44 - "/" - "claude-501" (10 bytes) = 33: the measured 31 worked, the measured 38 fell back.
    expect(maxTmpPathBytes(501)).toBe(33);
    expect(maxTmpPathBytes(0)).toBe(35);
    // A five-digit uid leaves 31, a ten-digit one 26: the default root (29) no longer fits.
    expect(maxTmpPathBytes(12345)).toBe(31);
    expect(maxTmpPathBytes(1234567890)).toBe(26);
    expect(maxTmpPathBytes()).toBe(maxTmpPathBytes(currentUid()));
    const root = defaultScratchRoot("darwin", () => true)!;
    expect(
      checkPlacement({
        ...base,
        scratchRoot: root,
        maxTmpPath: maxTmpPathBytes(1234567890),
      }),
    ).toContain("too long");
    // Bytes, not characters: each "é" is two bytes in UTF-8.
    expect(scratchTmpPathBytes("/srv/é")).toBe(
      scratchTmpPathBytes("/srv/e") + 1,
    );
    const accented = "/srv/" + "é".repeat(8);
    expect(accented.length + 13).toBe(26);
    expect(scratchTmpPathBytes(accented)).toBe(34);
    expect(
      checkPlacement({ ...base, scratchRoot: accented, maxTmpPath: 33 }),
    ).toContain("too long");
  });

  it("refuses a path a permission rule would read as a pattern", () => {
    expect(checkPlacement({ ...base, outDir: "/srv/res*ults" })).toContain(
      "pattern",
    );
  });

  it("refuses a scratch path a shell would split or end, which the canary's commands carry as they are", () => {
    for (const ch of [
      " ",
      "\t",
      "'",
      '"',
      "`",
      "$",
      ";",
      "&",
      "|",
      "<",
      ">",
      "{",
      "}",
    ]) {
      const message = checkPlacement({
        ...base,
        scratchRoot: `/srv/scr${ch}atch`,
      });
      expect(message, JSON.stringify(ch)).toContain(
        "whitespace, a quote or a shell operator",
      );
    }
    // Only the scratch path is put into commands; plain characters and other paths pass.
    expect(
      checkPlacement({ ...base, scratchRoot: "/srv/s-a_1.x+@" }),
    ).toBeNull();
    expect(checkPlacement({ ...base, outDir: "/srv/res ults" })).toBeNull();
  });

  it("decides containment by path segments, not by string prefix", () => {
    expect(isInside("/a/b", "/a")).toBe(true);
    expect(isInside("/a", "/a")).toBe(true);
    expect(isInside("/ab", "/a")).toBe(false);
    expect(isInside("/a/../b", "/a")).toBe(false);
  });
});

describe("default scratch root", () => {
  it("is /Users/Shared/oe on macOS when /Users/Shared exists", () => {
    expect(defaultScratchRoot("darwin", () => true)).toBe("/Users/Shared/oe");
  });

  it("leaves room for the run id and the tmp directory within the limit", () => {
    const root = defaultScratchRoot("darwin", () => true)!;
    expect(scratchTmpPathBytes(root)).toBe(29);
    expect(scratchTmpPathBytes(root)).toBeLessThanOrEqual(maxTmpPathBytes(501));
  });

  it("is absent elsewhere, so --scratch is required", () => {
    expect(defaultScratchRoot("darwin", () => false)).toBeNull();
    expect(defaultScratchRoot("linux", () => true)).toBeNull();
    expect(defaultScratchRoot("win32", () => true)).toBeNull();
  });

  it("lies outside the home and every temp root", () => {
    const root = defaultScratchRoot("darwin", () => true)!;
    expect(
      checkPlacement({
        scratchRoot: root,
        outDir: "/srv/results",
        datasetDir: "/srv/data/dataset",
        home: "/Users/someone",
        tempRoots: ["/tmp", "/private/tmp", "/private/var/folders/xx/T"],
      }),
    ).toBeNull();
  });
});

describe("session settings", () => {
  let scratch: ReturnType<typeof createRunScratch>;
  let settings: Record<string, any>;
  /** The same run placed as in production: no temp root covers its scratch. */
  let placed: Record<string, any>;
  beforeAll(() => {
    scratch = createRunScratch(join(work, "settings"));
    settings = sessionSettings({
      scratch,
      scratchRoot: join(work, "settings"),
      denied: ["/home/someone", "/srv/data"],
      tempRoots: systemTempRoots(),
    });
    placed = sessionSettings({
      scratch,
      scratchRoot: join(work, "settings"),
      denied: ["/home/someone", "/srv/data"],
      tempRoots: [],
    });
  });

  it("keeps the API key out of Bash commands through the sandbox, not the scrub variable", () => {
    expect(settings.sandbox.credentials).toEqual({
      envVars: [{ name: "ANTHROPIC_API_KEY", mode: "deny" }],
    });
  });

  it("denies reads of the shared temp roots and re-opens only this run's scratch", () => {
    const roots = systemTempRoots();
    expect(roots).toEqual(expect.arrayContaining(pathForms(tmpdir())));
    if (process.platform === "darwin")
      expect(roots).toEqual(expect.arrayContaining(["/tmp", "/private/tmp"]));
    const fs = settings.sandbox.filesystem;
    expect(fs.denyRead).toEqual(expect.arrayContaining(roots));
    // The scratch lives under the system temp root here, as it does by default:
    // each of its own directories sits inside a denied root and is re-opened
    // by an allowRead entry that is strictly narrower than that root.
    const realTmp = realpathSync(tmpdir());
    for (const dir of fs.allowRead as string[]) {
      expect(isInside(dir, realTmp), dir).toBe(true);
      const covering = (fs.denyRead as string[]).filter((d) =>
        isInside(dir, d),
      );
      expect(covering.length, dir).toBeGreaterThan(0);
      for (const d of covering) expect(dir.length, d).toBeGreaterThan(d.length);
    }
    expect(
      (fs.denyRead as string[]).some((d) => isInside(scratch.meta, d)),
    ).toBe(true);
    expect(fs.allowRead).not.toContain(scratch.meta);
  });

  it("turns the sandbox on, strict, with no way out", () => {
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.sandbox.excludedCommands).toEqual([]);
    expect(settings.sandbox.network).toEqual({
      allowedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    });
  });

  it("denies reads of the protected trees and of other runs, and opens only this run", () => {
    const fs = settings.sandbox.filesystem;
    expect(fs.denyRead).toEqual(
      expect.arrayContaining(["/home/someone", "/srv/data"]),
    );
    expect(fs.denyRead).toContain(join(work, "settings"));
    expect(fs.allowRead).toEqual([
      scratch.checkout,
      scratch.evidence,
      scratch.runFiles,
      scratch.home,
      scratch.tmp,
    ]);
    expect(fs.allowWrite).toEqual([
      scratch.checkout,
      scratch.evidence,
      scratch.tmp,
      scratch.home,
    ]);
    expect(fs.allowWrite).not.toContain(scratch.meta);
    expect(fs.allowWrite).not.toContain(scratch.runFiles);
    expect(fs.denyWrite).toEqual([
      "/home/someone",
      "/srv/data",
      scratch.configDir,
    ]);
  });

  it("keeps the session's own Claude Code config dir from Bash writes and from the file tools", () => {
    const fs = settings.sandbox.filesystem;
    // Inside the writable home, so only the narrower denyWrite entry (which wins) holds it.
    expect(isInside(scratch.configDir, scratch.home)).toBe(true);
    expect(fs.allowWrite).toContain(scratch.home);
    expect(fs.denyWrite).toContain(scratch.configDir);
    // Bash may still read it: every Bash command runs Claude Code's shell snapshot from there.
    expect(fs.denyRead).not.toContain(scratch.configDir);
    const deny: string[] = settings.permissions.deny;
    for (const tool of ["Read", "Edit"]) {
      expect(deny).toContain(`${tool}(/${scratch.configDir})`);
      expect(deny).toContain(`${tool}(/${scratch.configDir}/**)`);
    }
    expect(denies(deny, "Edit", join(scratch.configDir, "settings.json"))).toBe(
      true,
    );
  });

  it("denies the config dir in every form when the scratch root is reached through a symlink", () => {
    const realParent = join(work, "real-parent");
    mkdirSync(realParent);
    const linkParent = join(work, "link-parent");
    symlinkSync(realParent, linkParent);
    const root = join(linkParent, "root");
    const linked = createRunScratch(root);
    expect(linked.configDir.startsWith(realParent)).toBe(true);
    const viaLink = join(root, linked.id, "home", ".claude");
    expect(scratchPathForms(linked.configDir, root)).toEqual([
      linked.configDir,
      viaLink,
    ]);
    const s: Record<string, any> = sessionSettings({
      scratch: linked,
      scratchRoot: root,
      denied: ["/home/someone"],
      tempRoots: [],
    });
    expect(s.sandbox.filesystem.denyWrite).toEqual(
      expect.arrayContaining([linked.configDir, viaLink]),
    );
    for (const path of [linked.configDir, viaLink])
      expect(s.permissions.deny).toContain(`Edit(/${path}/**)`);
    // A path outside the scratch root keeps only its own forms.
    expect(scratchPathForms("/elsewhere/x", root)).toEqual(["/elsewhere/x"]);
  });

  it("denies the file tools every run's prompt, evidence and home, and leaves this run's checkout readable", () => {
    const root = join(work, "settings");
    const sibling = createRunScratch(root);
    const deny: string[] = placed.permissions.deny;
    for (const part of ["meta", "evidence", "home"]) {
      expect(deny).toContain(`Read(/${root}/*/${part})`);
      expect(deny).toContain(`Read(/${root}/*/${part}/**)`);
    }
    for (const target of [
      join(sibling.meta, "prompt.md"),
      join(sibling.meta, "session.json"),
      join(sibling.evidence, "notes.txt"),
      join(sibling.home, ".npm", "x"),
      join(sibling.configDir, "settings.json"),
    ])
      expect(denies(deny, "Read", target), target).toBe(true);
    // This run's own checkout stays open to the file tools.
    for (const target of [
      scratch.checkout,
      join(scratch.checkout, "README.md"),
      join(scratch.checkout, "src", "a.ts"),
    ])
      expect(denies(deny, "Read", target), target).toBe(false);
    // Its own evidence and home are reached through Bash: re-opened there for reading and writing.
    const fs = placed.sandbox.filesystem;
    for (const dir of [scratch.evidence, scratch.home]) {
      expect(denies(deny, "Read", join(dir, "x")), dir).toBe(true);
      expect(fs.allowRead).toContain(dir);
      expect(fs.allowWrite).toContain(dir);
    }
  });

  it("writes no Edit rule over a directory Bash must write, since Claude Code turns Edit rules into sandbox write denials", () => {
    const deny: string[] = placed.permissions.deny;
    const sibling = createRunScratch(join(work, "settings"));
    // Writable to Bash: none of these may fall under an Edit rule.
    for (const target of [
      join(scratch.checkout, "out.txt"),
      join(scratch.evidence, "log.txt"),
      join(scratch.home, "canary.txt"),
      join(scratch.home, ".npm", "_cacache", "x"),
      join(scratch.tmp, "claude-501", "cwd"),
    ])
      expect(denies(deny, "Edit", target), target).toBe(false);
    // The private parts that are never written: Edit rules there are harmless and kept.
    for (const target of [
      join(scratch.meta, "settings.json"),
      join(sibling.meta, "prompt.md"),
      join(scratch.configDir, "settings.json"),
    ])
      expect(denies(deny, "Edit", target), target).toBe(true);
    // The file-writing tools themselves are disallowed outright.
    for (const tool of ["Edit", "Write", "NotebookEdit"])
      expect(DISALLOWED_TOOLS).toContain(tool);
  });

  it("denies the file tools the protected trees and the session's own meta files", () => {
    const deny: string[] = settings.permissions.deny;
    for (const path of ["/home/someone", "/srv/data", scratch.meta]) {
      expect(deny).toContain(`Read(/${path})`);
      expect(deny).toContain(`Read(/${path}/**)`);
      expect(deny).toContain(`Edit(/${path}/**)`);
    }
    expect(deny).toEqual(expect.arrayContaining(["SendMessage", "ListAgents"]));
    expect(
      deny.some((r) => r.startsWith("Glob(") || r.startsWith("Grep(")),
    ).toBe(false);
    // Measured: with the sandbox enabled this key hangs claude 2.1.302 before its first tool call.
    expect(settings.permissions).not.toHaveProperty(
      "blockReadsOutsideWorkingDirectories",
    );
    expect(JSON.stringify(settings)).not.toContain(
      "blockReadsOutsideWorkingDirectories",
    );
    expect(settings.crossSessionInbound).toBe("refuse");
    expect(settings.isolatePeerMachines).toBe(true);
  });

  it("denies Read and Edit on every form of every temp root, bare and recursive", () => {
    const deny: string[] = settings.permissions.deny;
    const roots = systemTempRoots();
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      for (const tool of ["Read", "Edit"]) {
        expect(deny, `${tool} ${root}`).toContain(`${tool}(/${root})`);
        expect(deny, `${tool} ${root}`).toContain(`${tool}(/${root}/**)`);
      }
    }
    if (process.platform === "darwin") {
      for (const root of ["/tmp", "/private/tmp"])
        expect(deny).toContain(`Read(/${root}/**)`);
    }
  });

  it("disallows every tool that reaches another session or a remote service", () => {
    for (const tool of [
      "SendMessage",
      "ListAgents",
      "TaskStop",
      "RemoteTrigger",
      "PushNotification",
      "Artifact",
      "CronCreate",
      "Monitor",
      "Workflow",
    ]) {
      expect(DISALLOWED_TOOLS, tool).toContain(tool);
    }
  });
});

describe("secrets and redaction", () => {
  it("finds the key and credential-looking values by kind, never returning them", () => {
    const values = secretValues(
      {
        SOME_TOKEN: "abcdefghijklmnop",
        SHORT_TOKEN: "short",
        PLAIN: "abcdefghijklmnopqrst",
      },
      "sk-the-api-key-value",
    );
    expect(values.map((v) => v.name)).toEqual([
      "the API key",
      "the value of SOME_TOKEN",
    ]);
    const text =
      "x sk-the-api-key-value y abcdefghijklmnop -----BEGIN OPENSSH PRIVATE KEY----- ghp_abcdefghijklmnopqrstuvwxyz0123";
    const hits = scanForSecrets(text, values);
    expect(hits).toEqual([
      "the API key",
      "the value of SOME_TOKEN",
      "private key block",
      "GitHub token",
    ]);
    expect(hits.join(" ")).not.toContain("sk-the-api-key-value");
    const clean = redactSecrets(text, values);
    expect(scanForSecrets(clean, values)).toEqual([]);
    expect(clean).toContain("<redacted: the API key>");
  });

  it("treats a value as a secret by the words in its variable's name, each word alone", () => {
    const value = "abcdefghijklmnop";
    const hit = (name: string): boolean =>
      secretValues({ [name]: value }).length === 1;
    for (const name of [
      "SERVICE_TOKEN",
      "APP_SECRET",
      "DB_PASSWORD",
      "DB_PASSWD",
      "AWS_CREDENTIALS",
      "OPENAI_API_KEY",
      "OPENAI_APIKEY",
      "SIGNING_KEY",
      "BASIC_AUTH",
      "service_token",
    ])
      expect(hit(name), name).toBe(true);
    // A bare KEY inside a name does not count; only a trailing _KEY does.
    for (const name of ["KEYBOARD_LAYOUT", "HOMEBREW_PREFIX", "EDITOR"])
      expect(hit(name), name).toBe(false);
  });

  it("recognises exactly the git configuration pass-through names", () => {
    for (const name of [
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_KEY_12",
      "GIT_CONFIG_VALUE_0",
    ])
      expect(isGitConfigEnvName(name), name).toBe(true);
    for (const name of [
      "AGENT_TASKS_TOKEN",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "GH_TOKEN",
      "FOO_SECRET",
      "GIT_CONFIG_KEY_",
      "GIT_CONFIG_KEY_0_TOKEN",
      "MY_GIT_CONFIG_KEY_0",
      "GIT_CONFIG_GLOBAL",
    ])
      expect(isGitConfigEnvName(name), name).toBe(false);
  });

  it("counts every reported name except a sandbox-injected one the host does not hold", () => {
    const host = ["PATH", "HOME", "MY_HOST_TOKEN"];
    // Sandbox-injected names are not host secrets.
    expect(
      leakedSecretNames(
        [
          "CLOUDSDK_PROXY_PASSWORD",
          "GIT_CONFIG_KEY_0",
          "GIT_CONFIG_VALUE_3",
          "GIT_CONFIG_COUNT",
        ],
        host,
      ),
    ).toEqual([]);
    // A name of the host environment counts, and so does a name it does not hold (fail closed).
    expect(leakedSecretNames(["MY_HOST_TOKEN ", "FOO_SECRET"], host)).toEqual([
      "MY_HOST_TOKEN",
      "FOO_SECRET",
    ]);
    for (const name of [
      "SOME_NEW_INJECTED_SECRET",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "GIT_CONFIG_KEY_",
      "GIT_CONFIG_GLOBAL",
      "MY_GIT_CONFIG_KEY_0",
      "CLOUDSDK_PROXY_PASSWORD_2",
    ])
      expect(leakedSecretNames([name], []), name).toEqual([name]);
    // The same sandbox name counts once the host holds it.
    expect(
      leakedSecretNames(
        ["CLOUDSDK_PROXY_PASSWORD"],
        [...host, "CLOUDSDK_PROXY_PASSWORD"],
      ),
    ).toEqual(["CLOUDSDK_PROXY_PASSWORD"]);
    // An empty line is no name.
    expect(leakedSecretNames(["", "  ", "``", "=x"], [])).toEqual([]);
  });

  it("counts a git configuration name the host holds, like any other host name", () => {
    for (const name of [
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_COUNT",
    ]) {
      expect(leakedSecretNames([name], [name]), name).toEqual([name]);
      expect(leakedSecretNames([name], ["PATH"]), name).toEqual([]);
    }
    // Held under another case by the host, still held.
    expect(
      leakedSecretNames(["GIT_CONFIG_KEY_0"], ["git_config_key_0"]),
    ).toEqual(["GIT_CONFIG_KEY_0"]);
  });

  it("normalizes a reported name before comparing: spaces, backticks, a value after =, case", () => {
    const host = ["GH_TOKEN", "PATH"];
    expect(normalizeEnvName(" `GH_TOKEN` ")).toBe("GH_TOKEN");
    expect(normalizeEnvName("GH_TOKEN=ghp_value")).toBe("GH_TOKEN");
    expect(normalizeEnvName("` GH_TOKEN =x`")).toBe("GH_TOKEN");
    for (const raw of ["`GH_TOKEN`", "GH_TOKEN=x", "gh_token", " GH_TOKEN "])
      expect(leakedSecretNames([raw], host), raw).toHaveLength(1);
    // A value printed after the name never reaches the result.
    expect(leakedSecretNames(["GH_TOKEN=ghp_secretvalue"], host)).toEqual([
      "GH_TOKEN",
    ]);
    // Injected names are recognised in any spelling, while the host does not hold them.
    expect(
      leakedSecretNames(
        [
          "`git_config_count`",
          "GIT_CONFIG_KEY_0=core.pager",
          " cloudsdk_proxy_password ",
        ],
        host,
      ),
    ).toEqual([]);
    expect(isSandboxInjectedName("cloudsdk_proxy_password")).toBe(true);
    expect(isSandboxInjectedName("Git_Config_Value_7")).toBe(true);
    expect(isSandboxInjectedName("GH_TOKEN")).toBe(false);
  });

  it("counts every known secret name, none of which is sandbox-injected", () => {
    expect(KNOWN_SECRET_NAMES).toEqual(
      expect.arrayContaining([
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "GH_TOKEN",
        "CLAUDE_CODE_MESSAGING_SOCKET",
      ]),
    );
    for (const name of KNOWN_SECRET_NAMES) {
      expect(isSandboxInjectedName(name), name).toBe(false);
      expect(leakedSecretNames([name], []), name).toEqual([name]);
      expect(leakedSecretNames([name.toLowerCase()], []), name).toHaveLength(1);
    }
  });

  it("scans for the host's git configuration values, which can carry a credential", () => {
    const values = secretValues({
      GIT_CONFIG_VALUE_0: "AUTHORIZATION: bearer abcdefghijkl",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_1: "short",
    });
    expect(values).toEqual([
      {
        name: "the value of GIT_CONFIG_VALUE_0",
        value: "AUTHORIZATION: bearer abcdefghijkl",
      },
    ]);
  });

  it("never treats an empty value as a match", () => {
    expect(scanForSecrets("text", [{ name: "empty", value: "" }])).toEqual([]);
    expect(redactSecrets("text", [{ name: "empty", value: "" }])).toBe("text");
  });

  it("redacts a whole path under a protected tree, and only the prefix of a session path", () => {
    const text =
      "see /w/x/checkout/src/a.ts and /o/results/current/sample-control/run-1/result.json, then /o/results.";
    const out = redactPaths(text, [
      { path: "/w/x/checkout", label: "<worktree>" },
      { path: "/o/results", label: "<results>", whole: true },
    ]);
    expect(out).toBe("see <worktree>/src/a.ts and <results>, then <results>.");
  });

  it("gives host git commands nothing but the passed variables and fixed git settings", () => {
    const env = hostGitEnv({ PATH: "/bin", GH_TOKEN: "x", HOME: "/h" });
    expect(env).toEqual({
      PATH: "/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_SSH_COMMAND: "false",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});

describe("guarded commands and the sweep", { timeout: 60_000 }, () => {
  it("parses guard's envelope and rejects anything else", () => {
    const report = parseGuardEnvelope(
      JSON.stringify({
        command: "guard",
        reason: "leftover",
        childExitCode: 0,
        killedCount: 0,
        leftoverCount: 2,
        survivorCount: 1,
        leftoverCheckFailed: false,
        peakRssMiB: 12.5,
        leftovers: [{ pid: 5, inGroup: false, command: "sleep 9" }],
      }),
    );
    expect(report).toMatchObject({
      reason: "leftover",
      exit_code: 0,
      leftover_count: 2,
      survivor_count: 1,
      peak_rss_mib: 12.5,
      processes: [{ pid: 5, in_group: false, command: "sleep 9" }],
    });
    expect(parseGuardEnvelope("not json")).toBeNull();
    expect(parseGuardEnvelope('{"command":"verify","reason":"x"}')).toBeNull();
  });

  it("runs a command under the guard with its stdin, stdout and stderr in files", async () => {
    const dir = mkdtempSync(join(work, "g-"));
    writeFileSync(join(dir, "in.txt"), "hello");
    const result = await runGuarded(
      process.execPath,
      [
        "-e",
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('got '+s);console.error('warn');process.exit(4)})",
      ],
      {
        guardBin: FAKE_GUARD,
        cwd: dir,
        env: { PATH: process.env.PATH },
        timeoutMs: 20_000,
        maxRssMiB: 512,
        stdinFile: join(dir, "in.txt"),
        stdoutFile: join(dir, "out.txt"),
        stderrFile: join(dir, "err.txt"),
        logDir: join(dir, "log"),
        sweepRoots: [],
      },
    );
    expect(result.code).toBe(4);
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeNull();
    expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("got hello\n");
    expect(readFileSync(join(dir, "err.txt"), "utf8")).toBe("warn\n");
    const argv: string[] = JSON.parse(
      readFileSync(join(dir, "log", "fake-guard-argv.json"), "utf8"),
    ).argv;
    expect(argv.slice(0, 7)).toEqual([
      "--format",
      "json",
      "--log-dir",
      join(dir, "log"),
      "guard",
      "20",
      "512",
    ]);
  });

  it("kills a process left working inside a swept root, and only there", async () => {
    const inside = mkdtempSync(join(work, "in-"));
    const outside = mkdtempSync(join(work, "out-"));
    const start = (cwd: string): number => {
      const child = spawn("sleep", ["300"], {
        cwd,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return child.pid!;
    };
    const a = start(inside);
    const b = start(outside);
    await new Promise((r) => setTimeout(r, 300));
    const swept = sweepByCwd([inside], { PATH: process.env.PATH });
    expect(swept.unavailable).toBeNull();
    expect(swept.killed.map((p) => p.pid)).toEqual([a]);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(a, 0)).toThrow();
    expect(() => process.kill(b, 0)).not.toThrow();
    process.kill(b, "SIGKILL");
    expect(leftoverTotal({ guard: null, swept })).toBe(1);
  });

  it("kills a process that left the root but holds a file open inside it, and says why", async () => {
    const inside = mkdtempSync(join(work, "fd-in-"));
    const outside = mkdtempSync(join(work, "fd-out-"));
    const log = join(inside, "session.log");
    const fd = openSync(log, "a");
    // Working directory outside the root; standard output is a log file inside it.
    const child = spawn("sleep", ["300"], {
      cwd: outside,
      detached: true,
      stdio: ["ignore", fd, "ignore"],
    });
    child.unref();
    closeSync(fd);
    const bystander = spawn("sleep", ["300"], {
      cwd: outside,
      detached: true,
      stdio: "ignore",
    });
    bystander.unref();
    await new Promise((r) => setTimeout(r, 300));
    const swept = sweepByCwd([inside], { PATH: process.env.PATH });
    expect(swept.unavailable).toBeNull();
    expect(swept.killed).toEqual([
      { pid: child.pid, cwd: outside, via: "open_file", file: log },
    ]);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(child.pid!, 0)).toThrow();
    expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
    process.kill(bystander.pid!, "SIGKILL");
  });

  it("reports guard's timeout and a leftover it killed", async () => {
    const dir = mkdtempSync(join(work, "t-"));
    mkdirSync(join(dir, "log"));
    const common = {
      guardBin: FAKE_GUARD,
      cwd: dir,
      env: { PATH: process.env.PATH },
      maxRssMiB: 512,
      stdinFile: null,
      stdoutFile: join(dir, "o"),
      stderrFile: join(dir, "e"),
      logDir: join(dir, "log"),
      sweepRoots: [],
    };
    const slow = await runGuarded("sleep", ["30"], {
      ...common,
      timeoutMs: 800,
    });
    expect(slow.timedOut).toBe(true);
    expect(slow.guard?.reason).toBe("timeout");
    const leaving = await runGuarded(
      process.execPath,
      [
        "-e",
        "require('child_process').spawn('sleep',['30'],{stdio:'ignore'}).unref()",
      ],
      { ...common, timeoutMs: 20_000 },
    );
    expect(leaving.guard?.reason).toBe("leftover");
    expect(leftoverTotal(leaving)).toBe(1);
  });
});

describe("sweep matching", () => {
  const table = (entries: [number, ProcessPlaces][]) => new Map(entries);

  it("matches a working directory first, then an open file, by path segments", () => {
    const hits = placesInside(
      table([
        [10, { cwd: "/scratch/run1/checkout", files: ["/scratch/run1/x"] }],
        [11, { cwd: "/elsewhere", files: ["/etc/hosts", "/scratch/run1/log"] }],
        [12, { cwd: "/scratch/run10/checkout", files: [] }],
        [13, { cwd: null, files: ["/scratch/run1"] }],
        [14, { cwd: "/elsewhere", files: ["/etc/hosts"] }],
      ]),
      ["/scratch/run1"],
    );
    expect(hits).toEqual([
      { pid: 10, cwd: "/scratch/run1/checkout", via: "cwd" },
      {
        pid: 11,
        cwd: "/elsewhere",
        via: "open_file",
        file: "/scratch/run1/log",
      },
      { pid: 13, cwd: "", via: "open_file", file: "/scratch/run1" },
    ]);
  });

  it("never selects this process, pid 1 or lower pids", () => {
    const inside: ProcessPlaces = { cwd: "/r/x", files: [] };
    const hits = placesInside(
      table([
        [1, inside],
        [0, inside],
        [500, inside],
        [501, inside],
      ]),
      ["/r"],
      500,
    );
    expect(hits.map((h) => h.pid)).toEqual([501]);
  });

  it("reads lsof's field output: working directory, descriptors, and only absolute names", () => {
    const parsed = parseLsofPlaces(
      [
        "p20",
        "fcwd",
        "n/scratch/run1",
        "f0",
        "n/dev/null",
        "f1",
        "n/scratch/run1/out.log",
        "f3",
        "n*:8080",
        "f4",
        "ncount->socket",
        "p21",
        "fcwd",
        "n/",
        "",
      ].join("\n"),
    );
    expect(parsed.get(20)).toEqual({
      cwd: "/scratch/run1",
      files: ["/dev/null", "/scratch/run1/out.log"],
    });
    expect(parsed.get(21)).toEqual({ cwd: "/", files: [] });
    expect(parsed.size).toBe(2);
  });
});

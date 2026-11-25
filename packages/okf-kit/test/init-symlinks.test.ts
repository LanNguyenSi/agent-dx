import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../src/errors.js";
import { runInit } from "../src/init.js";
import {
  assertNoSymlinkBelow,
  findWalkRoot,
  writeFileNoFollow,
} from "../src/safe-fs.js";
import { runCli } from "./helpers.js";

const SCAFFOLD_FILENAMES = [
  "index.md",
  "log.md",
  "overview-template.md",
  "module-template.md",
  "invariant-template.md",
  "runbook-template.md",
  "incident-template.md",
  "benchmark-template.md",
];

const NOTHING_WRITTEN = /nothing was written/i;

describe("init never writes through a symbolic link", () => {
  let base: string;
  let repo: string;
  let outside: string;

  beforeEach(() => {
    base = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-init-links-")),
    );
    repo = path.join(base, "repo");
    outside = path.join(base, "outside");
    fs.mkdirSync(repo);
    fs.mkdirSync(outside);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function listing(dir: string): string[] {
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  }

  function refusal(fn: () => unknown): UsageError {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      return error as UsageError;
    }
    throw new Error("expected runInit to refuse");
  }

  describe.each([false, true])("force=%s", (force) => {
    it("refuses a scaffold file that is a link to an outside file, names it, and leaves the outside file alone", () => {
      const victim = path.join(outside, "victim.txt");
      fs.writeFileSync(victim, "precious\n");
      const target = path.join(repo, "docs", "okf");
      fs.mkdirSync(target, { recursive: true });
      fs.symlinkSync(victim, path.join(target, "index.md"));

      const error = refusal(() => runInit(target, { force, cwd: repo }));

      expect(error.message).toContain(path.join(target, "index.md"));
      expect(error.message).toContain(victim);
      expect(error.message).toMatch(NOTHING_WRITTEN);
      expect(fs.readFileSync(victim, "utf8")).toBe("precious\n");
      expect(fs.lstatSync(path.join(target, "index.md")).isSymbolicLink()).toBe(
        true,
      );
      // No partial scaffold: the other seven files were not created either.
      expect(listing(target)).toEqual(["index.md"]);
    });

    it("refuses a dangling link at a scaffold name and creates nothing at the link target", () => {
      const missing = path.join(outside, "not-yet.txt");
      const target = path.join(repo, "okf");
      fs.mkdirSync(target);
      fs.symlinkSync(missing, path.join(target, "log.md"));

      const error = refusal(() => runInit(target, { force, cwd: repo }));

      expect(error.message).toContain(path.join(target, "log.md"));
      expect(error.message).toContain(missing);
      expect(fs.existsSync(missing)).toBe(false);
      expect(listing(target)).toEqual(["log.md"]);
      expect(listing(outside)).toEqual([]);
    });

    it("refuses a target directory that is a link, writing nothing through it", () => {
      const linkedTarget = path.join(repo, "okf");
      fs.symlinkSync(outside, linkedTarget);

      const error = refusal(() => runInit(linkedTarget, { force, cwd: repo }));

      expect(error.message).toContain(linkedTarget);
      expect(error.message).toContain(outside);
      expect(error.message).toMatch(NOTHING_WRITTEN);
      expect(listing(outside)).toEqual([]);
    });

    it("refuses a link above the target (docs -> outside, target docs/okf), writing nothing through it", () => {
      fs.symlinkSync(outside, path.join(repo, "docs"));
      const target = path.join(repo, "docs", "okf");

      const error = refusal(() => runInit(target, { force, cwd: repo }));

      expect(error.message).toContain(path.join(repo, "docs"));
      expect(error.message).toContain(outside);
      expect(error.message).toMatch(NOTHING_WRITTEN);
      expect(listing(outside)).toEqual([]);
    });

    it("refuses a link above a not-yet-existing target (dangling parent link)", () => {
      const missing = path.join(outside, "later");
      fs.symlinkSync(missing, path.join(repo, "docs"));

      refusal(() =>
        runInit(path.join(repo, "docs", "okf"), { force, cwd: repo }),
      );

      expect(fs.existsSync(missing)).toBe(false);
    });
  });

  it("refuses a link above the target when the target is given relative to the working directory", () => {
    fs.symlinkSync(outside, path.join(repo, "docs"));

    const result = runCli(["init", path.join("docs", "okf")], repo);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(path.join(repo, "docs"));
    expect(result.stderr).toMatch(NOTHING_WRITTEN);
    expect(listing(outside)).toEqual([]);
  });

  it("refuses a link above the target when the target is given as an absolute path", () => {
    fs.symlinkSync(outside, path.join(repo, "docs"));

    const result = runCli(["init", path.join(repo, "docs", "okf")], repo);

    expect(result.status).toBe(2);
    expect(listing(outside)).toEqual([]);
  });

  it("refuses a link above the target when the working directory is spelled through an alias", () => {
    const alias = path.join(base, "alias");
    fs.symlinkSync(repo, alias);
    fs.symlinkSync(outside, path.join(repo, "docs"));

    // The target is spelled through the alias; the working directory is the
    // real path. The walk still starts at the working directory.
    const error = refusal(() =>
      runInit(path.join(alias, "docs", "okf"), { cwd: repo }),
    );

    expect(error.message).toMatch(NOTHING_WRITTEN);
    expect(listing(outside)).toEqual([]);
  });

  it("does not let a `..` in the target argument hide a link", () => {
    fs.symlinkSync(outside, path.join(repo, "docs"));

    const error = refusal(() =>
      runInit(path.join(repo, "x", "..", "docs", "okf"), { cwd: repo }),
    );

    expect(error.message).toMatch(NOTHING_WRITTEN);
    expect(listing(outside)).toEqual([]);
  });

  it("refuses a FIFO at a scaffold name with --force without blocking", () => {
    if (process.platform === "win32") return;
    const target = path.join(repo, "okf");
    fs.mkdirSync(target);
    execFileSync("mkfifo", [path.join(target, "index.md")]);

    const error = refusal(() => runInit(target, { force: true, cwd: repo }));

    expect(error.message).toContain(path.join(target, "index.md"));
    expect(error.message).toMatch(/FIFO/);
    expect(error.message).toMatch(NOTHING_WRITTEN);
    expect(listing(target)).toEqual(["index.md"]);
  });

  it("refuses a directory at a scaffold name with --force", () => {
    const target = path.join(repo, "okf");
    fs.mkdirSync(path.join(target, "log.md"), { recursive: true });

    const error = refusal(() => runInit(target, { force: true, cwd: repo }));

    expect(error.message).toContain(path.join(target, "log.md"));
    expect(error.message).toMatch(/directory/);
    expect(listing(target)).toEqual(["log.md"]);
  });

  it("checks all eight scaffold targets before the first write: a bad last file leaves nothing written", () => {
    const victim = path.join(outside, "victim.txt");
    fs.writeFileSync(victim, "precious\n");
    const target = path.join(repo, "okf");
    fs.mkdirSync(target);
    // benchmark-template.md is the last scaffold file written; index.md,
    // the first, is a regular file that --force would overwrite.
    fs.writeFileSync(path.join(target, "index.md"), "old\n");
    fs.symlinkSync(victim, path.join(target, "benchmark-template.md"));

    refusal(() => runInit(target, { force: true, cwd: repo }));

    expect(fs.readFileSync(path.join(target, "index.md"), "utf8")).toBe(
      "old\n",
    );
    expect(listing(target)).toEqual(["benchmark-template.md", "index.md"]);
    expect(fs.readFileSync(victim, "utf8")).toBe("precious\n");
  });

  it("does not create missing directories when it refuses", () => {
    fs.symlinkSync(outside, path.join(repo, "linked"));

    refusal(() => runInit(path.join(repo, "linked", "a", "b"), { cwd: repo }));

    expect(listing(outside)).toEqual([]);
  });

  it("accepts a target outside the working directory below a link the user placed above it", () => {
    const real = path.join(base, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(base, "shortcut"));
    const target = path.join(base, "shortcut", "bundle");

    const result = runInit(target, { cwd: repo });

    expect(result.filesWritten.sort()).toEqual([...SCAFFOLD_FILENAMES].sort());
    for (const name of SCAFFOLD_FILENAMES) {
      expect(fs.existsSync(path.join(real, "bundle", name))).toBe(true);
    }
  });

  it("refuses a link below a target outside the working directory", () => {
    const victim = path.join(outside, "victim.txt");
    fs.writeFileSync(victim, "precious\n");
    const target = path.join(base, "elsewhere");
    fs.mkdirSync(target);
    fs.symlinkSync(victim, path.join(target, "index.md"));

    refusal(() => runInit(target, { force: true, cwd: repo }));

    expect(fs.readFileSync(victim, "utf8")).toBe("precious\n");
  });

  it("scaffolds normally under the working directory without links, with and without --force", () => {
    const target = path.join(repo, "docs", "okf");
    expect(runInit(target, { cwd: repo }).filesWritten.sort()).toEqual(
      [...SCAFFOLD_FILENAMES].sort(),
    );
    expect(
      runInit(target, { cwd: repo, force: true }).filesWritten.sort(),
    ).toEqual([...SCAFFOLD_FILENAMES].sort());
  });

  it("scaffolds into the working directory itself", () => {
    expect(runInit(repo, { cwd: repo }).filesWritten.sort()).toEqual(
      [...SCAFFOLD_FILENAMES].sort(),
    );
  });

  it("the CLI scaffolds the default docs/okf target and exits 0 when no links are involved", () => {
    const result = runCli(["init"], repo);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(repo, "docs", "okf", "index.md"))).toBe(
      true,
    );
  });

  describe("safe-fs primitives", () => {
    it("writeFileNoFollow refuses a link at the leaf even when no earlier check ran (overwrite)", () => {
      const victim = path.join(outside, "victim.txt");
      fs.writeFileSync(victim, "precious\n");
      const link = path.join(repo, "link.md");
      fs.symlinkSync(victim, link);

      expect(() => writeFileNoFollow(link, "new\n", true)).toThrow(UsageError);
      expect(fs.readFileSync(victim, "utf8")).toBe("precious\n");
    });

    it("writeFileNoFollow refuses a dangling link at the leaf and creates nothing", () => {
      const missing = path.join(outside, "missing.txt");
      const link = path.join(repo, "link.md");
      fs.symlinkSync(missing, link);

      expect(() => writeFileNoFollow(link, "new\n", true)).toThrow(UsageError);
      expect(() => writeFileNoFollow(link, "new\n", false)).toThrow(UsageError);
      expect(fs.existsSync(missing)).toBe(false);
    });

    it("writeFileNoFollow without overwrite refuses an existing regular file and leaves it intact", () => {
      const file = path.join(repo, "exists.md");
      fs.writeFileSync(file, "keep\n");

      expect(() => writeFileNoFollow(file, "new\n", false)).toThrow(UsageError);
      expect(fs.readFileSync(file, "utf8")).toBe("keep\n");
    });

    it("writeFileNoFollow with overwrite truncates an existing regular file", () => {
      const file = path.join(repo, "exists.md");
      fs.writeFileSync(file, "a much longer previous content\n");

      writeFileNoFollow(file, "new\n", true);

      expect(fs.readFileSync(file, "utf8")).toBe("new\n");
    });

    it("writeFileNoFollow creates a missing file", () => {
      const file = path.join(repo, "fresh.md");
      writeFileNoFollow(file, "new\n", false);
      expect(fs.readFileSync(file, "utf8")).toBe("new\n");
    });

    it("writeFileNoFollow refuses a FIFO without blocking", () => {
      if (process.platform === "win32") return;
      const fifo = path.join(repo, "pipe.md");
      execFileSync("mkfifo", [fifo]);
      expect(() => writeFileNoFollow(fifo, "new\n", true)).toThrow(UsageError);
    });

    it("writeFileNoFollow refuses a FIFO that has a reader, so the open itself succeeds and the type check decides", () => {
      if (process.platform === "win32") return;
      const fifo = path.join(repo, "pipe.md");
      execFileSync("mkfifo", [fifo]);
      const reader = fs.openSync(
        fifo,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
      );
      try {
        expect(() => writeFileNoFollow(fifo, "new\n", true)).toThrow(
          /not a regular file/,
        );
        const buffer = Buffer.alloc(16);
        expect(fs.readSync(reader, buffer, 0, 16, null)).toBe(0);
      } finally {
        fs.closeSync(reader);
      }
    });

    it("findWalkRoot picks the working directory when the target is under it, the target otherwise", () => {
      const inside = path.join(repo, "a", "b");
      expect(findWalkRoot(inside, repo)).toBe(repo);
      expect(findWalkRoot(repo, repo)).toBe(repo);
      const elsewhere = path.join(outside, "c");
      expect(findWalkRoot(elsewhere, repo)).toBe(elsewhere);
    });

    it("assertNoSymlinkBelow does not examine the root itself", () => {
      const rootLink = path.join(base, "root-link");
      fs.symlinkSync(repo, rootLink);
      fs.mkdirSync(path.join(repo, "d"));
      expect(() =>
        assertNoSymlinkBelow(rootLink, path.join(rootLink, "d")),
      ).not.toThrow();
    });
  });
});

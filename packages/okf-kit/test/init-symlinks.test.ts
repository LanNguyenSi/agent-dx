import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

  describe("walk root beyond the working directory", () => {
    function makeClone(): { sub: string } {
      fs.mkdirSync(path.join(repo, ".git"));
      const sub = path.join(repo, "packages", "x");
      fs.mkdirSync(sub, { recursive: true });
      return { sub };
    }

    it("refuses ../../docs/okf from a subdirectory when docs/okf is a link", () => {
      const { sub } = makeClone();
      fs.mkdirSync(path.join(repo, "docs"));
      fs.symlinkSync(outside, path.join(repo, "docs", "okf"));

      const result = runCli(
        ["init", path.join("..", "..", "docs", "okf")],
        sub,
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(path.join(repo, "docs", "okf"));
      expect(result.stderr).toMatch(/real path/);
      expect(result.stderr).toMatch(NOTHING_WRITTEN);
      expect(listing(outside)).toEqual([]);
    });

    it("refuses ../../docs/okf from a subdirectory when docs is a link", () => {
      const { sub } = makeClone();
      fs.symlinkSync(outside, path.join(repo, "docs"));

      const result = runCli(
        ["init", path.join("..", "..", "docs", "okf")],
        sub,
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(path.join(repo, "docs"));
      expect(listing(outside)).toEqual([]);
    });

    it.each(["docs-okf", "docs"])(
      "refuses an absolute target inside the clone from a working directory outside it (%s is the link)",
      (linked) => {
        makeClone();
        if (linked === "docs") {
          fs.symlinkSync(outside, path.join(repo, "docs"));
        } else {
          fs.mkdirSync(path.join(repo, "docs"));
          fs.symlinkSync(outside, path.join(repo, "docs", "okf"));
        }
        const elsewhere = path.join(base, "elsewhere");
        fs.mkdirSync(elsewhere);

        const result = runCli(
          ["init", path.join(repo, "docs", "okf"), "--force"],
          elsewhere,
        );

        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(NOTHING_WRITTEN);
        expect(listing(outside)).toEqual([]);
      },
    );

    it("matches the working directory by identity when it is spelled differently from the target", () => {
      const spelledAsAlias = path.join(base, "alias");
      fs.symlinkSync(repo, spelledAsAlias);
      fs.symlinkSync(outside, path.join(repo, "docs"));

      const error = refusal(() =>
        runInit(path.join(repo, "docs", "okf"), { cwd: spelledAsAlias }),
      );

      expect(error.message).toContain(path.join(repo, "docs"));
      expect(listing(outside)).toEqual([]);
    });

    it("scaffolds ../../docs/okf from a subdirectory when nothing is linked", () => {
      const { sub } = makeClone();

      const result = runCli(
        ["init", path.join("..", "..", "docs", "okf")],
        sub,
      );

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(repo, "docs", "okf", "index.md"))).toBe(
        true,
      );
    });

    it("refuses a target that is itself a link when it lies outside any repository, and says to pass the real path", () => {
      const linkedTarget = path.join(base, "linked-target");
      fs.symlinkSync(outside, linkedTarget);
      const elsewhere = path.join(base, "elsewhere");
      fs.mkdirSync(elsewhere);

      const error = refusal(() => runInit(linkedTarget, { cwd: elsewhere }));

      expect(error.message).toContain(linkedTarget);
      expect(error.message).toContain(outside);
      expect(error.message).toMatch(/real path/);
      expect(listing(outside)).toEqual([]);
    });

    it.each([false, true])(
      "refuses docs -> . and writes nothing through it (clone with .git: %s)",
      (withGit) => {
        if (withGit) fs.mkdirSync(path.join(repo, ".git"));
        fs.symlinkSync(".", path.join(repo, "docs"));

        const error = refusal(() =>
          runInit(path.join(repo, "docs", "okf"), { cwd: repo }),
        );

        expect(error.message).toContain(path.join(repo, "docs"));
        expect(listing(repo).filter((n) => n !== ".git")).toEqual(["docs"]);
      },
    );
  });

  describe("hard links", () => {
    it("refuses --force over a scaffold file that is a hard link to an outside file, before writing anything", () => {
      const victim = path.join(outside, "victim.txt");
      fs.writeFileSync(victim, "precious\n");
      const target = path.join(repo, "okf");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "index.md"), "old\n");
      fs.linkSync(victim, path.join(target, "benchmark-template.md"));

      const error = refusal(() => runInit(target, { force: true, cwd: repo }));

      expect(error.message).toContain(
        path.join(target, "benchmark-template.md"),
      );
      expect(error.message).toMatch(/hard links/);
      expect(error.message).toMatch(NOTHING_WRITTEN);
      expect(fs.readFileSync(victim, "utf8")).toBe("precious\n");
      expect(fs.readFileSync(path.join(target, "index.md"), "utf8")).toBe(
        "old\n",
      );
    });

    it("still overwrites a regular file with a single link under --force", () => {
      const target = path.join(repo, "okf");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "index.md"), "old\n");

      runInit(target, { force: true, cwd: repo });

      expect(fs.readFileSync(path.join(target, "index.md"), "utf8")).not.toBe(
        "old\n",
      );
    });
  });

  describe("FIFO guard (run in a child process with a hard timeout)", () => {
    const SAFE_FS = pathToFileURL(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "dist",
        "safe-fs.js",
      ),
    ).href;
    const CHILD = `
      const { writeFileNoFollow } = await import(process.env.SAFE_FS);
      const fs = await import("node:fs");
      let reader;
      if (process.env.WITH_READER) {
        reader = fs.openSync(process.env.FIFO, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      }
      let outcome = "wrote";
      try {
        writeFileNoFollow(process.env.FIFO, "new\\n", true);
      } catch (error) {
        outcome = error.constructor.name + ": " + error.message;
      }
      const read = reader === undefined ? -1 : fs.readSync(reader, Buffer.alloc(16), 0, 16, null);
      console.log(JSON.stringify({ outcome, read }));
    `;

    function runChild(withReader: boolean) {
      const fifo = path.join(repo, "pipe.md");
      execFileSync("mkfifo", [fifo]);
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", CHILD],
        {
          encoding: "utf8",
          timeout: 8000,
          killSignal: "SIGKILL",
          env: {
            ...process.env,
            SAFE_FS,
            FIFO: fifo,
            WITH_READER: withReader ? "1" : "",
          },
        },
      );
      return result;
    }

    it(
      "refuses a FIFO with no reader instead of blocking in open",
      { timeout: 20000 },
      () => {
        if (process.platform === "win32") return;
        const result = runChild(false);

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout) as { outcome: string };
        expect(parsed.outcome).toMatch(/^UsageError: Refusing to write/);
      },
    );

    it(
      "refuses a FIFO that has a reader and writes nothing to it",
      { timeout: 20000 },
      () => {
        if (process.platform === "win32") return;
        const result = runChild(true);

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout) as {
          outcome: string;
          read: number;
        };
        expect(parsed.outcome).toMatch(
          /^UsageError: Refusing to write .*not a regular file/,
        );
        expect(parsed.read).toBe(0);
      },
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

    it("findWalkRoot prefers the nearest .git ancestor over the working directory", () => {
      fs.mkdirSync(path.join(repo, ".git"));
      const sub = path.join(repo, "packages", "x");
      fs.mkdirSync(sub, { recursive: true });
      expect(findWalkRoot(path.join(repo, "docs", "okf"), sub)).toBe(repo);
      expect(findWalkRoot(path.join(sub, "docs"), sub)).toBe(repo);
    });

    it("findWalkRoot accepts a .git file (worktree or submodule) and the target itself as the repository root", () => {
      fs.writeFileSync(path.join(repo, ".git"), "gitdir: elsewhere\n");
      expect(findWalkRoot(path.join(repo, "a", "b"), outside)).toBe(repo);
      expect(findWalkRoot(repo, outside)).toBe(repo);
    });

    it("findWalkRoot takes the nearest of several .git ancestors", () => {
      fs.mkdirSync(path.join(repo, ".git"));
      const inner = path.join(repo, "vendor", "inner");
      fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
      expect(findWalkRoot(path.join(inner, "docs"), repo)).toBe(inner);
    });

    it("findWalkRoot falls back to the working directory when no ancestor holds .git and the target is under it", () => {
      const inside = path.join(repo, "a", "b");
      expect(findWalkRoot(inside, repo)).toBe(repo);
      expect(findWalkRoot(repo, repo)).toBe(repo);
    });

    it("findWalkRoot falls back to the target's parent when there is no .git ancestor and the target is outside the working directory", () => {
      const elsewhere = path.join(outside, "c");
      expect(findWalkRoot(elsewhere, repo)).toBe(outside);
    });

    it("findWalkRoot never takes a link as the root, even one that points at the working directory or at a repository", () => {
      const self = path.join(repo, "docs");
      fs.symlinkSync(".", self);
      expect(findWalkRoot(path.join(self, "okf"), repo)).toBe(repo);
      fs.mkdirSync(path.join(outside, ".git"));
      const toRepo = path.join(base, "to-outside");
      fs.symlinkSync(outside, toRepo);
      expect(findWalkRoot(path.join(toRepo, "okf"), repo)).toBe(toRepo);
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

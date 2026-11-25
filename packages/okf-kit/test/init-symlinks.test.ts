import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../src/errors.js";
import { runInit } from "../src/init.js";
import {
  MAX_ROOT_LINK_HOPS,
  assertScaffoldFileWritable,
  createDirectories,
  resolvePhysicalTarget,
  systemWalkStart,
  writeFileNoFollow,
} from "../src/safe-fs.js";
import { CLI_PATH, runCli } from "./helpers.js";

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

function listing(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

/**
 * Every entry below `dir` with its type, link text or file content, read
 * with lstat so no link is followed. Two equal snapshots mean nothing was
 * created, removed, truncated or rewritten anywhere below `dir`.
 */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const rel = path.relative(dir, full);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        out.push(`${rel} -> ${fs.readlinkSync(full)}`);
      } else if (stat.isDirectory()) {
        out.push(`${rel}/`);
        visit(full);
      } else if (stat.isFile()) {
        out.push(`${rel} = ${fs.readFileSync(full, "utf8")}`);
      } else {
        out.push(`${rel} (special)`);
      }
    }
  };
  visit(dir);
  return out;
}

function refusal(fn: () => unknown): UsageError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return error as UsageError;
  }
  throw new Error("expected a refusal");
}

function expectScaffoldIn(dir: string): void {
  expect(fs.lstatSync(dir).isDirectory()).toBe(true);
  for (const name of SCAFFOLD_FILENAMES) {
    expect(fs.lstatSync(path.join(dir, name)).isFile()).toBe(true);
  }
}

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

  describe.each([false, true])("force=%s", (force) => {
    it("refuses a scaffold file that is a link to an outside file, names it, and leaves the outside file alone", () => {
      const victim = path.join(outside, "victim.txt");
      fs.writeFileSync(victim, "precious\n");
      const target = path.join(repo, "docs", "okf");
      fs.mkdirSync(target, { recursive: true });
      fs.symlinkSync(victim, path.join(target, "index.md"));

      const error = refusal(() => runInit(target, { force }));

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

      const error = refusal(() => runInit(target, { force }));

      expect(error.message).toContain(path.join(target, "log.md"));
      expect(error.message).toContain(missing);
      expect(fs.existsSync(missing)).toBe(false);
      expect(listing(target)).toEqual(["log.md"]);
      expect(listing(outside)).toEqual([]);
    });

    it("refuses a target directory that is a link, writing nothing through it", () => {
      const linkedTarget = path.join(repo, "okf");
      fs.symlinkSync(outside, linkedTarget);

      const error = refusal(() => runInit(linkedTarget, { force }));

      expect(error.message).toContain(linkedTarget);
      expect(error.message).toContain(outside);
      expect(error.message).toMatch(/real path/);
      expect(error.message).toMatch(NOTHING_WRITTEN);
      expect(listing(outside)).toEqual([]);
    });

    it("refuses a link above the target (docs -> outside, target docs/okf), writing nothing through it", () => {
      fs.symlinkSync(outside, path.join(repo, "docs"));
      const target = path.join(repo, "docs", "okf");

      const error = refusal(() => runInit(target, { force }));

      expect(error.message).toContain(
        `${path.join(repo, "docs")} is a symbolic link`,
      );
      expect(error.message).toContain(outside);
      expect(error.message).toMatch(/real path/);
      expect(error.message).toMatch(NOTHING_WRITTEN);
      expect(listing(outside)).toEqual([]);
    });

    it("refuses a link above a not-yet-existing target (dangling parent link)", () => {
      const missing = path.join(outside, "later");
      fs.symlinkSync(missing, path.join(repo, "docs"));

      refusal(() => runInit(path.join(repo, "docs", "okf"), { force }));

      expect(fs.existsSync(missing)).toBe(false);
    });
  });

  it("does not let a `..` in the target argument hide a link", () => {
    fs.symlinkSync(outside, path.join(repo, "docs"));

    const error = refusal(() =>
      runInit(path.join(repo, "x", "..", "docs", "okf")),
    );

    expect(error.message).toMatch(NOTHING_WRITTEN);
    expect(listing(outside)).toEqual([]);
  });

  it("refuses a FIFO at a scaffold name with --force without blocking", () => {
    if (process.platform === "win32") return;
    const target = path.join(repo, "okf");
    fs.mkdirSync(target);
    execFileSync("mkfifo", [path.join(target, "index.md")]);

    const error = refusal(() => runInit(target, { force: true }));

    expect(error.message).toContain(path.join(target, "index.md"));
    expect(error.message).toMatch(/FIFO/);
    expect(error.message).toMatch(NOTHING_WRITTEN);
    expect(listing(target)).toEqual(["index.md"]);
  });

  it("refuses a directory at a scaffold name with --force", () => {
    const target = path.join(repo, "okf");
    fs.mkdirSync(path.join(target, "log.md"), { recursive: true });

    const error = refusal(() => runInit(target, { force: true }));

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

    refusal(() => runInit(target, { force: true }));

    expect(fs.readFileSync(path.join(target, "index.md"), "utf8")).toBe(
      "old\n",
    );
    expect(listing(target)).toEqual(["benchmark-template.md", "index.md"]);
    expect(fs.readFileSync(victim, "utf8")).toBe("precious\n");
  });

  it("does not create missing directories when it refuses", () => {
    fs.symlinkSync(outside, path.join(repo, "linked"));

    refusal(() => runInit(path.join(repo, "linked", "a", "b")));

    expect(listing(outside)).toEqual([]);
  });

  it("refuses a path component that is a file, and says so", () => {
    fs.writeFileSync(path.join(repo, "f"), "x\n");
    const before = snapshot(base);

    const error = refusal(() => runInit(path.join(repo, "f", "okf")));

    expect(error.message).toContain(
      `${path.join(repo, "f")} exists and is not a directory`,
    );
    expect(error.message).toMatch(NOTHING_WRITTEN);
    expect(snapshot(base)).toEqual(before);
  });

  it("refuses a link the user placed above the checkout, and scaffolds when given the real path", () => {
    fs.symlinkSync(repo, path.join(base, "alias"));
    const before = snapshot(base);

    const error = refusal(() =>
      runInit(path.join(base, "alias", "docs", "okf")),
    );

    expect(error.message).toContain(path.join(base, "alias"));
    expect(error.message).toContain(repo);
    expect(error.message).toMatch(/real path/);
    expect(snapshot(base)).toEqual(before);

    const real = path.join(
      fs.realpathSync(path.join(base, "alias")),
      "docs",
      "okf",
    );
    runInit(real);
    expectScaffoldIn(path.join(repo, "docs", "okf"));
  });

  it("scaffolds normally without links, with and without --force", () => {
    const target = path.join(repo, "docs", "okf");
    expect(runInit(target).filesWritten.sort()).toEqual(
      [...SCAFFOLD_FILENAMES].sort(),
    );
    expect(runInit(target, { force: true }).filesWritten.sort()).toEqual(
      [...SCAFFOLD_FILENAMES].sort(),
    );
    expectScaffoldIn(target);
  });

  it("scaffolds into an existing empty directory", () => {
    expect(runInit(repo).filesWritten.sort()).toEqual(
      [...SCAFFOLD_FILENAMES].sort(),
    );
  });

  it("the CLI scaffolds the default docs/okf target and exits 0 when no links are involved", () => {
    const result = runCli(["init"], repo);
    expect(result.status).toBe(0);
    expectScaffoldIn(path.join(repo, "docs", "okf"));
  });

  it("the CLI refusal names the link and its text, exits 2 and says to pass the real path", () => {
    fs.symlinkSync(outside, path.join(repo, "docs"));

    const result = runCli(["init", path.join("docs", "okf")], repo);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `${path.join(repo, "docs")} is a symbolic link`,
    );
    expect(result.stderr).toContain(outside);
    expect(result.stderr).toMatch(/real path/);
    expect(result.stderr).toMatch(NOTHING_WRITTEN);
    expect(listing(outside)).toEqual([]);
  });

  // The first component of the temp directory as the OS spells it. On macOS
  // that is /var, a link in the filesystem root to private/var; on a Linux CI
  // runner it is a real /tmp and this control has nothing to exercise.
  const rootEntry = path.join(
    path.parse(os.tmpdir()).root,
    os.tmpdir().split(path.sep).filter(Boolean)[0] ?? "",
  );
  const tmpIsBehindRootLink =
    path.parse(os.tmpdir()).root === "/" &&
    fs.lstatSync(rootEntry).isSymbolicLink();

  it.runIf(tmpIsBehindRootLink)(
    "follows a real link in the filesystem root (the OS temp directory) and writes at the physical location",
    () => {
      const spelled = fs.mkdtempSync(
        path.join(os.tmpdir(), "okf-kit-root-link-"),
      );
      try {
        expect(fs.realpathSync(spelled)).not.toBe(spelled);
        const target = path.join(spelled, "docs", "okf");

        const result = runInit(target);

        expect(result.targetDir).toBe(target);
        expectScaffoldIn(path.join(fs.realpathSync(spelled), "docs", "okf"));

        // A link below the root link is still refused.
        fs.symlinkSync(outside, path.join(spelled, "linked"));
        refusal(() => runInit(path.join(spelled, "linked", "okf")));
        expect(listing(outside)).toEqual([]);
      } finally {
        fs.rmSync(spelled, { recursive: true, force: true });
      }
    },
  );

  describe("hard links", () => {
    it("refuses --force over a scaffold file that is a hard link to an outside file, before writing anything", () => {
      const victim = path.join(outside, "victim.txt");
      fs.writeFileSync(victim, "precious\n");
      const target = path.join(repo, "okf");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "index.md"), "old\n");
      fs.linkSync(victim, path.join(target, "benchmark-template.md"));

      const error = refusal(() => runInit(target, { force: true }));

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

      runInit(target, { force: true });

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

    it("createDirectories creates each missing level, outermost first", () => {
      const levels = [
        path.join(repo, "a"),
        path.join(repo, "a", "b"),
        path.join(repo, "a", "b", "c"),
      ];
      createDirectories(levels);
      expect(fs.lstatSync(levels[2]).isDirectory()).toBe(true);
    });

    it("createDirectories refuses a link to a directory that appeared at a level after the walk, and creates nothing below it", () => {
      const planted = path.join(repo, "docs");
      fs.symlinkSync(outside, planted);

      const error = refusal(() =>
        createDirectories([planted, path.join(planted, "okf")]),
      );

      expect(error.message).toContain(planted);
      expect(listing(outside)).toEqual([]);
    });

    it("createDirectories refuses a level that exists by now, a real directory included", () => {
      fs.mkdirSync(path.join(repo, "docs"));
      refusal(() => createDirectories([path.join(repo, "docs")]));
    });
  });

  describe("the walk (resolvePhysicalTarget) under an injected filesystem root", () => {
    let fsRoot: string;
    const followed = (): { root: string; followLinksInRoot: boolean } => ({
      root: fsRoot,
      followLinksInRoot: true,
    });

    beforeEach(() => {
      fsRoot = path.join(base, "fsroot");
      fs.mkdirSync(fsRoot);
    });

    it("returns an existing link-free directory as itself", () => {
      const target = path.join(fsRoot, "home", "repo", "docs");
      fs.mkdirSync(target, { recursive: true });

      expect(resolvePhysicalTarget(target, followed())).toEqual({
        physical: target,
        kind: "directory",
        missing: [],
      });
    });

    it("returns the walk root itself as a directory", () => {
      expect(resolvePhysicalTarget(fsRoot, followed())).toEqual({
        physical: fsRoot,
        kind: "directory",
        missing: [],
      });
    });

    it("reports the missing levels outermost first and stops looking below the first one", () => {
      fs.mkdirSync(path.join(fsRoot, "home"));
      const target = path.join(fsRoot, "home", "a", "b", "c");

      expect(resolvePhysicalTarget(target, followed())).toEqual({
        physical: target,
        kind: "missing",
        missing: [
          path.join(fsRoot, "home", "a"),
          path.join(fsRoot, "home", "a", "b"),
          target,
        ],
      });
    });

    it("reports an existing file at the last component as `other` and refuses one above it", () => {
      fs.mkdirSync(path.join(fsRoot, "home"));
      const file = path.join(fsRoot, "home", "f");
      fs.writeFileSync(file, "x\n");

      expect(resolvePhysicalTarget(file, followed())).toEqual({
        physical: file,
        kind: "other",
        missing: [],
      });
      const error = refusal(() =>
        resolvePhysicalTarget(path.join(file, "okf"), followed()),
      );
      expect(error.message).toContain(`${file} exists and is not a directory`);
    });

    it("refuses a component it cannot examine instead of treating it as missing", () => {
      if (process.platform === "win32" || process.getuid?.() === 0) return;
      const locked = path.join(fsRoot, "locked");
      fs.mkdirSync(path.join(locked, "inner"), { recursive: true });
      fs.chmodSync(locked, 0o000);
      try {
        const error = refusal(() =>
          resolvePhysicalTarget(path.join(locked, "inner", "okf"), followed()),
        );
        expect(error.message).toContain(path.join(locked, "inner"));
        expect(error.message).toMatch(/cannot be examined \(EACCES\)/);
        expect(error.message).toMatch(NOTHING_WRITTEN);
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    });

    it("follows a link in the root with a relative text (macOS /tmp -> private/tmp) in front of a real repository path", () => {
      const physicalRepo = path.join(fsRoot, "private", "tmp", "repo");
      fs.mkdirSync(path.join(physicalRepo, ".git"), { recursive: true });
      fs.symlinkSync(path.join("private", "tmp"), path.join(fsRoot, "tmp"));

      expect(
        resolvePhysicalTarget(
          path.join(fsRoot, "tmp", "repo", "docs", "okf"),
          followed(),
        ),
      ).toEqual({
        physical: path.join(physicalRepo, "docs", "okf"),
        kind: "missing",
        missing: [
          path.join(physicalRepo, "docs"),
          path.join(physicalRepo, "docs", "okf"),
        ],
      });
    });

    it("refuses the same root link when the root is one where links are not followed (a Windows drive or share root)", () => {
      fs.mkdirSync(path.join(fsRoot, "private", "tmp", "repo"), {
        recursive: true,
      });
      const link = path.join(fsRoot, "tmp");
      fs.symlinkSync(path.join("private", "tmp"), link);

      const error = refusal(() =>
        resolvePhysicalTarget(path.join(fsRoot, "tmp", "repo"), {
          root: fsRoot,
          followLinksInRoot: false,
        }),
      );
      expect(error.message).toContain(link);
    });

    it("still refuses a link below a followed root link", () => {
      fs.mkdirSync(path.join(fsRoot, "private", "tmp", "repo"), {
        recursive: true,
      });
      fs.symlinkSync(path.join("private", "tmp"), path.join(fsRoot, "tmp"));
      const hostile = path.join(fsRoot, "private", "tmp", "repo", "docs");
      fs.symlinkSync(outside, hostile);

      const error = refusal(() =>
        resolvePhysicalTarget(
          path.join(fsRoot, "tmp", "repo", "docs", "okf"),
          followed(),
        ),
      );
      expect(error.message).toContain(`${hostile} is a symbolic link`);
      expect(error.message).toContain(outside);
    });

    it("follows a root link whose text leads through another root link", () => {
      fs.mkdirSync(path.join(fsRoot, "private", "var", "home"), {
        recursive: true,
      });
      fs.symlinkSync(path.join("private", "var"), path.join(fsRoot, "var"));
      fs.symlinkSync(path.join("var", "home"), path.join(fsRoot, "home"));

      expect(
        resolvePhysicalTarget(path.join(fsRoot, "home", "u"), followed())
          .physical,
      ).toBe(path.join(fsRoot, "private", "var", "home", "u"));
    });

    function chainOfRootLinks(count: number): string {
      fs.mkdirSync(path.join(fsRoot, "end"));
      for (let i = count; i >= 1; i--) {
        fs.symlinkSync(
          i === count ? "end" : `l${i + 1}`,
          path.join(fsRoot, `l${i}`),
        );
      }
      return path.join(fsRoot, "l1", "okf");
    }

    it("follows exactly the allowed number of root links in a row", () => {
      const target = chainOfRootLinks(MAX_ROOT_LINK_HOPS);
      expect(resolvePhysicalTarget(target, followed()).physical).toBe(
        path.join(fsRoot, "end", "okf"),
      );
    });

    it("refuses one root link more than the allowed number", () => {
      const target = chainOfRootLinks(MAX_ROOT_LINK_HOPS + 1);
      const error = refusal(() => resolvePhysicalTarget(target, followed()));
      expect(error.message).toMatch(/cannot be followed/);
      expect(error.message).toMatch(NOTHING_WRITTEN);
    });

    it("refuses root links that point at each other", () => {
      fs.symlinkSync("b", path.join(fsRoot, "a"));
      fs.symlinkSync("a", path.join(fsRoot, "b"));

      const error = refusal(() =>
        resolvePhysicalTarget(path.join(fsRoot, "a", "okf"), followed()),
      );
      expect(error.message).toMatch(/cannot be followed/);
    });

    it("refuses a root link that leads to a file", () => {
      fs.writeFileSync(path.join(fsRoot, "file"), "x\n");
      fs.symlinkSync("file", path.join(fsRoot, "tmp"));

      const error = refusal(() =>
        resolvePhysicalTarget(path.join(fsRoot, "tmp"), followed()),
      );
      expect(error.message).toMatch(/cannot be followed/);
    });

    it("rejects a target, or a root link text, that is not below the walk root", () => {
      expect(() => resolvePhysicalTarget(outside, followed())).toThrow(
        /not below the walk root/,
      );
      expect(() => resolvePhysicalTarget(base, followed())).toThrow(
        /not below the walk root/,
      );
      fs.symlinkSync(outside, path.join(fsRoot, "away"));
      expect(() =>
        resolvePhysicalTarget(path.join(fsRoot, "away", "okf"), followed()),
      ).toThrow(/not below the walk root/);
    });

    // One row per combination. A link is followed only when it is a direct
    // entry of the walk root and leads to an existing directory; where `.git`
    // sits and where the link points never turn a refusal into an acceptance.
    const POSITIONS = ["root", "above", "parent", "target"] as const;
    const GIT_POSITIONS = [
      "none",
      "repo",
      "beside-link",
      "at-resolution",
    ] as const;
    const RESOLUTIONS = [
      "twin",
      "outside",
      "git-root-elsewhere",
      "dangling",
    ] as const;
    const ROWS = POSITIONS.flatMap((position) =>
      GIT_POSITIONS.flatMap((git) =>
        RESOLUTIONS.map((resolution) => ({ position, git, resolution })),
      ),
    );

    it.each(ROWS)(
      "link at $position, .git $git, pointing at $resolution",
      ({ position, git, resolution }) => {
        // The path as typed is <root>/a/ws/repo/docs/okf.
        const typed = ["a", "ws", "repo", "docs", "okf"];
        const index = { root: 0, above: 1, parent: 3, target: 4 }[position];
        const link = path.join(fsRoot, ...typed.slice(0, index + 1));
        const rest = typed.slice(index + 1);
        fs.mkdirSync(path.dirname(link), { recursive: true });

        // "twin" holds what the typed path names below the link, the way a
        // user's own alias does; above the repository it holds the repository.
        const twin = `${link}.real`;
        fs.mkdirSync(path.join(twin, ...rest), { recursive: true });
        const elsewhere = path.join(fsRoot, "elsewhere");
        fs.mkdirSync(path.join(elsewhere, "outside"), { recursive: true });
        fs.mkdirSync(path.join(elsewhere, "victim", ".git"), {
          recursive: true,
        });
        const destination = {
          twin,
          outside: path.join(elsewhere, "outside"),
          "git-root-elsewhere": path.join(elsewhere, "victim"),
          dangling: path.join(elsewhere, "nothing-here"),
        }[resolution];
        fs.symlinkSync(destination, link);

        const repoIndex = typed.indexOf("repo");
        const physicalRepo =
          index < repoIndex
            ? path.join(twin, ...typed.slice(index + 1, repoIndex + 1))
            : path.join(fsRoot, ...typed.slice(0, repoIndex + 1));
        if (git === "repo") {
          fs.mkdirSync(path.join(physicalRepo, ".git"), { recursive: true });
        } else if (git === "beside-link") {
          fs.mkdirSync(path.join(path.dirname(link), ".git"), {
            recursive: true,
          });
        } else if (git === "at-resolution" && resolution !== "dangling") {
          fs.mkdirSync(path.join(destination, ".git"), { recursive: true });
        }

        const target = path.join(fsRoot, ...typed);
        const before = snapshot(fsRoot);
        if (position === "root" && resolution !== "dangling") {
          expect(resolvePhysicalTarget(target, followed()).physical).toBe(
            path.join(destination, ...rest),
          );
        } else {
          const error = refusal(() =>
            resolvePhysicalTarget(target, followed()),
          );
          expect(error.message).toContain(`${link} is a symbolic link`);
          expect(error.message).toContain(destination);
          expect(error.message).toMatch(NOTHING_WRITTEN);
        }
        // Where links in the root are not followed, every row is a refusal.
        refusal(() =>
          resolvePhysicalTarget(target, {
            root: fsRoot,
            followLinksInRoot: false,
          }),
        );
        expect(snapshot(fsRoot)).toEqual(before);
      },
    );
  });

  describe("changes between the checks and the writes, simulated by hooking fs", () => {
    type AnyFunction = (...args: unknown[]) => unknown;
    const hooked = fs as unknown as Record<string, AnyFunction>;
    const restore: Array<() => void> = [];

    /** Replaces `fs[name]` until the test ends; `around` gets the real function and the call's arguments. */
    function intercept(
      name: "readdirSync" | "mkdirSync" | "fstatSync",
      around: (real: AnyFunction, args: unknown[]) => unknown,
    ): void {
      const real = hooked[name];
      hooked[name] = function (this: unknown, ...args: unknown[]) {
        return around((...realArgs) => real.apply(this, realArgs), args);
      };
      restore.push(() => {
        hooked[name] = real;
      });
    }

    afterEach(() => {
      while (restore.length > 0) restore.pop()?.();
    });

    it("without --force, does not truncate a file that appears at a scaffold name after the emptiness check", () => {
      const target = path.join(repo, "okf");
      fs.mkdirSync(target);
      const planted = path.join(target, "index.md");
      let done = false;
      intercept("readdirSync", (real, args) => {
        const entries = real(...args);
        if (!done && args[0] === target) {
          done = true;
          fs.writeFileSync(planted, "planted\n");
        }
        return entries;
      });

      const error = refusal(() => runInit(target));

      expect(done).toBe(true);
      expect(error.message).toContain(planted);
      expect(fs.readFileSync(planted, "utf8")).toBe("planted\n");
      expect(listing(target)).toEqual(["index.md"]);
    });

    it("refuses a link planted at a missing level after the walk and writes nothing at its destination", () => {
      const target = path.join(repo, "docs", "okf");
      let done = false;
      intercept("mkdirSync", (real, args) => {
        if (!done) {
          done = true;
          fs.symlinkSync(outside, path.join(repo, "docs"));
        }
        return real(...args);
      });

      const error = refusal(() => runInit(target));

      expect(done).toBe(true);
      expect(error.message).toContain(path.join(repo, "docs"));
      expect(listing(outside)).toEqual([]);
    });

    it.each([false, true])(
      "writes through the open descriptor: a link swapped in at the leaf after the open is not followed (overwrite=%s)",
      (overwrite) => {
        const victim = path.join(outside, "victim.txt");
        fs.writeFileSync(victim, "precious\n");
        const file = path.join(repo, "index.md");
        if (overwrite) fs.writeFileSync(file, "old\n");
        let done = false;
        intercept("fstatSync", (real, args) => {
          const stat = real(...args);
          if (!done) {
            done = true;
            fs.unlinkSync(file);
            fs.symlinkSync(victim, file);
          }
          return stat;
        });

        writeFileNoFollow(file, "new\n", overwrite);

        expect(done).toBe(true);
        expect(fs.readFileSync(victim, "utf8")).toBe("precious\n");
      },
    );
  });

  describe("a directory that cannot be created", () => {
    it("removes the directories it created when a deeper one cannot be created (path too long)", () => {
      const parts = Array.from(
        { length: 30 },
        (_, i) => `${String(i).padStart(2, "0")}${"d".repeat(198)}`,
      );
      const before = snapshot(base);

      expect(() => runInit(path.join(repo, ...parts))).toThrow(/ENAMETOOLONG/);

      expect(snapshot(base)).toEqual(before);
    });

    it("createDirectories removes the levels it created, innermost first, when a later level fails", () => {
      const levels = [
        path.join(repo, "a"),
        path.join(repo, "a", "b"),
        path.join(repo, "no-such-parent", "c"),
      ];

      expect(() => createDirectories(levels)).toThrow(/ENOENT/);

      expect(listing(repo)).toEqual([]);
    });

    it("refuses a component whose name is too long to examine instead of treating it as missing", () => {
      const before = snapshot(base);

      const error = refusal(() =>
        runInit(path.join(repo, "x".repeat(300), "okf")),
      );

      expect(error.message).toMatch(/cannot be examined \(ENAMETOOLONG\)/);
      expect(error.message).toMatch(NOTHING_WRITTEN);
      expect(snapshot(base)).toEqual(before);
    });
  });

  describe("refusal messages show control characters instead of printing them", () => {
    // A link text that would clear the terminal line and print a forged
    // success message below the refusal.
    const HOSTILE_TEXT =
      "x\u001b[2K\rokf-kit: Scaffolded OKF bundle\nNext: run ./setup.sh";
    const SHOWN_TEXT =
      "x\\x1b[2K\\x0dokf-kit: Scaffolded OKF bundle\\x0aNext: run ./setup.sh";
    const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

    it("escapes the text of a link on the target path", () => {
      fs.symlinkSync(HOSTILE_TEXT, path.join(repo, "docs"));

      const error = refusal(() => runInit(path.join(repo, "docs", "okf")));

      expect(error.message).not.toMatch(CONTROL_CHARACTER);
      expect(error.message).toContain(`(it points to ${SHOWN_TEXT})`);
    });

    it("escapes the text of a link at a scaffold name", () => {
      const target = path.join(repo, "okf");
      fs.mkdirSync(target);
      fs.symlinkSync(HOSTILE_TEXT, path.join(target, "index.md"));

      const error = refusal(() => runInit(target, { force: true }));

      expect(error.message).not.toMatch(CONTROL_CHARACTER);
      expect(error.message).toContain(`(it points to ${SHOWN_TEXT})`);
    });

    it("escapes the name of a link, in the link's path and in the requested path", () => {
      const name = "do\u001b[2Kcs\nx\u0085";
      fs.symlinkSync(outside, path.join(repo, name));

      const error = refusal(() => runInit(path.join(repo, name, "okf")));

      expect(error.message).not.toMatch(CONTROL_CHARACTER);
      expect(error.message).toContain(
        `${path.join(repo, "do\\x1b[2Kcs\\x0ax\\x85")} is a symbolic link`,
      );
    });

    it("the CLI prints the refusal as a single line without control characters", () => {
      fs.symlinkSync(HOSTILE_TEXT, path.join(repo, "docs"));

      const result = runCli(["init", path.join("docs", "okf")], repo);

      expect(result.status).toBe(2);
      expect(result.stderr.endsWith("\n")).toBe(true);
      expect(result.stderr.slice(0, -1)).not.toMatch(CONTROL_CHARACTER);
      expect(result.stderr).toContain(SHOWN_TEXT);
    });

    it("names a device at a scaffold name as a device, without repeating itself", () => {
      if (process.platform === "win32") return;

      const error = refusal(() => assertScaffoldFileWritable("/dev/null"));

      expect(error.message).toContain(
        "it exists and is a device or other special file, not a regular file",
      );
    });
  });

  describe("systemWalkStart", () => {
    it("follows links in the POSIX root only", () => {
      expect(systemWalkStart("/repo/docs/okf", path.posix.parse)).toEqual({
        root: "/",
        followLinksInRoot: true,
      });
    });

    it("follows no link in a Windows drive root", () => {
      expect(systemWalkStart("C:\\repo\\docs\\okf", path.win32.parse)).toEqual({
        root: "C:\\",
        followLinksInRoot: false,
      });
    });

    it("follows no link in a Windows share root", () => {
      expect(
        systemWalkStart("\\\\server\\share\\repo\\docs", path.win32.parse),
      ).toEqual({ root: "\\\\server\\share\\", followLinksInRoot: false });
    });

    it("uses the platform's own path rules by default", () => {
      expect(systemWalkStart(repo).root).toBe(path.parse(repo).root);
    });
  });
});

/**
 * The attack matrix, run through the built CLI as a hostile
 * checkout would be: once as an unpacked tarball (no `.git`) and once as a
 * clone (`.git` directory in the repository). The expected result of every
 * scenario is the same in both, because the rule does not look at `.git`.
 */
describe.each([
  { git: false, label: "no .git (unpacked tarball)" },
  { git: true, label: ".git directory (clone)" },
])("init attack matrix through the CLI: $label", ({ git }) => {
  interface Sandbox {
    root: string;
    repo: string;
    outside: string;
  }
  interface Run {
    cwd: string;
    args: string[];
  }
  interface Scenario {
    id: number;
    name: string;
    setup: (s: Sandbox) => Run;
    /** The directory the scaffold must land in; absent when the run must be refused. */
    landsIn?: (s: Sandbox) => string;
    /** Refused only where names compare case-insensitively; elsewhere the typed name is a new directory in the repository. */
    refusedOnCaseInsensitiveVolume?: boolean;
    posixOnly?: boolean;
  }

  let s: Sandbox;

  beforeEach(() => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-init-matrix-")),
    );
    s = {
      root,
      repo: path.join(root, "repo"),
      outside: path.join(root, "outside"),
    };
    fs.mkdirSync(s.repo);
    fs.mkdirSync(s.outside);
    if (git) fs.mkdirSync(path.join(s.repo, ".git"));
    fs.writeFileSync(path.join(s.outside, "index.md"), "precious\n");
  });

  afterEach(() => {
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  const dir = (...parts: string[]): string => {
    const full = path.join(...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  };
  const link = (text: string, ...at: string[]): void =>
    fs.symlinkSync(text, path.join(...at));
  const okf = path.join("docs", "okf");
  const up = path.join("..", "outside");
  const upUp = path.join("..", "..", "outside");

  const SCENARIOS: Scenario[] = [
    {
      id: 1,
      name: "docs -> ../outside, relative target, cwd = repo",
      setup: (s) => {
        link(up, s.repo, "docs");
        return { cwd: s.repo, args: [okf, "--force"] };
      },
    },
    {
      id: 2,
      name: "docs/okf -> ../../outside, cwd = repo",
      setup: (s) => {
        dir(s.repo, "docs");
        link(upUp, s.repo, "docs", "okf");
        return { cwd: s.repo, args: [okf, "--force"] };
      },
    },
    {
      id: 3,
      name: "docs/okf -> ../../outside, cwd = parent of repo",
      setup: (s) => {
        dir(s.repo, "docs");
        link(upUp, s.repo, "docs", "okf");
        return { cwd: s.root, args: [path.join("repo", okf), "--force"] };
      },
    },
    {
      id: 4,
      name: "docs/okf -> ../../outside, cwd outside the repo, absolute target",
      setup: (s) => {
        dir(s.repo, "docs");
        link(upUp, s.repo, "docs", "okf");
        return {
          cwd: dir(s.root, "elsewhere"),
          args: [path.join(s.repo, okf), "--force"],
        };
      },
    },
    {
      id: 5,
      name: "docs -> ../outside, cwd outside the repo, absolute target",
      setup: (s) => {
        link(up, s.repo, "docs");
        return {
          cwd: dir(s.root, "elsewhere"),
          args: [path.join(s.repo, okf), "--force"],
        };
      },
    },
    {
      id: 6,
      name: "docs -> ../outside, cwd = repo/packages/x, target ../../docs/okf",
      setup: (s) => {
        link(up, s.repo, "docs");
        return {
          cwd: dir(s.repo, "packages", "x"),
          args: [path.join("..", "..", okf), "--force"],
        };
      },
    },
    {
      id: 7,
      name: "docs/okf -> ../../outside, cwd = repo/packages/x",
      setup: (s) => {
        dir(s.repo, "docs");
        link(upUp, s.repo, "docs", "okf");
        return {
          cwd: dir(s.repo, "packages", "x"),
          args: [path.join("..", "..", okf), "--force"],
        };
      },
    },
    {
      id: 8,
      name: "link named DOCS, target docs/okf",
      setup: (s) => {
        link(up, s.repo, "DOCS");
        return { cwd: s.repo, args: [okf, "--force"] };
      },
      refusedOnCaseInsensitiveVolume: true,
      landsIn: (s) => path.join(s.repo, "docs", "okf"),
    },
    {
      id: 9,
      name: "link named docs, target DOCS/okf",
      setup: (s) => {
        link(up, s.repo, "docs");
        return { cwd: s.repo, args: [path.join("DOCS", "okf"), "--force"] };
      },
      refusedOnCaseInsensitiveVolume: true,
      landsIn: (s) => path.join(s.repo, "DOCS", "okf"),
    },
    {
      id: 10,
      name: "l/../docs/okf with l -> ../outside: `..` is removed textually, the link is never entered",
      setup: (s) => {
        dir(s.repo, "docs");
        link(up, s.repo, "l");
        return {
          cwd: s.repo,
          args: [path.join("l", "..", okf), "--force"],
        };
      },
      landsIn: (s) => path.join(s.repo, "docs", "okf"),
    },
    {
      id: 11,
      name: "index.md is a hard link to the outside file, --force",
      setup: (s) => {
        fs.linkSync(
          path.join(s.outside, "index.md"),
          path.join(dir(s.repo, "docs", "okf"), "index.md"),
        );
        return { cwd: s.repo, args: [okf, "--force"] };
      },
    },
    {
      id: 12,
      name: "index.md is a link to the outside file (absolute text), --force",
      setup: (s) => {
        link(
          path.join(s.outside, "index.md"),
          dir(s.repo, "docs", "okf"),
          "index.md",
        );
        return { cwd: s.repo, args: [okf, "--force"] };
      },
    },
    {
      id: 13,
      name: "log.md is a dangling link, no --force",
      setup: (s) => {
        link(
          path.join(s.outside, "new.md"),
          dir(s.repo, "docs", "okf"),
          "log.md",
        );
        return { cwd: s.repo, args: [okf] };
      },
    },
    {
      id: 14,
      name: "index.md is a FIFO, --force",
      posixOnly: true,
      setup: (s) => {
        execFileSync("mkfifo", [
          path.join(dir(s.repo, "docs", "okf"), "index.md"),
        ]);
        return { cwd: s.repo, args: [okf, "--force"] };
      },
    },
    {
      id: 15,
      name: "log.md is a socket, --force",
      posixOnly: true,
      setup: (s) => {
        const target = dir(s.repo, "docs", "okf");
        // Bound by a relative name: a socket path has a short length limit.
        execFileSync(
          process.execPath,
          [
            "-e",
            "require('node:net').createServer().listen('log.md', () => process.exit(0))",
          ],
          { cwd: target, timeout: 15000 },
        );
        expect(fs.lstatSync(path.join(target, "log.md")).isSocket()).toBe(true);
        return { cwd: s.repo, args: [okf, "--force"] };
      },
    },
    {
      id: 16,
      name: "docs -> . and the target is docs",
      setup: (s) => {
        link(".", s.repo, "docs");
        return { cwd: s.repo, args: ["docs", "--force"] };
      },
    },
    {
      id: 17,
      name: "docs -> .. and the target is docs/okf",
      setup: (s) => {
        link("..", s.repo, "docs");
        return { cwd: s.repo, args: [okf, "--force"] };
      },
    },
    {
      id: 18,
      name: "target spelled through alias -> repo, docs/okf is a link, cwd = repo",
      setup: (s) => {
        dir(s.repo, "docs");
        link(upUp, s.repo, "docs", "okf");
        link("repo", s.root, "alias");
        return {
          cwd: s.repo,
          args: [path.join(s.root, "alias", okf), "--force"],
        };
      },
    },
    {
      id: 19,
      name: "cwd entered through a link to the repo, docs/okf is a link",
      setup: (s) => {
        link("repo", s.root, "cwdlink");
        dir(s.repo, "docs");
        link(upUp, s.repo, "docs", "okf");
        return { cwd: path.join(s.root, "cwdlink"), args: [okf, "--force"] };
      },
    },
    {
      id: 20,
      name: "index.md -> /dev/null, --force",
      posixOnly: true,
      setup: (s) => {
        link("/dev/null", dir(s.repo, "docs", "okf"), "index.md");
        return { cwd: s.repo, args: [okf, "--force"] };
      },
    },
    {
      id: 21,
      name: "a directory at the scaffold name index.md, --force",
      setup: (s) => {
        dir(s.repo, "docs", "okf", "index.md");
        return { cwd: s.repo, args: [okf, "--force"] };
      },
    },
    {
      id: 22,
      name: "a file where a directory is needed (f/okf)",
      setup: (s) => {
        fs.writeFileSync(path.join(s.repo, "f"), "x\n");
        return { cwd: s.repo, args: [path.join("f", "okf"), "--force"] };
      },
    },
    {
      id: 23,
      name: "alias -> repo, docs -> ../outside, cwd = repo, absolute target through the alias",
      setup: (s) => {
        link("repo", s.root, "alias");
        link(up, s.repo, "docs");
        return {
          cwd: s.repo,
          args: [path.join(s.root, "alias", okf), "--force"],
        };
      },
    },
    {
      id: 24,
      name: "alias -> repo, docs -> ../outside, cwd elsewhere, absolute target through the alias",
      setup: (s) => {
        link("repo", s.root, "alias");
        link(up, s.repo, "docs");
        return {
          cwd: dir(s.root, "el"),
          args: [path.join(s.root, "alias", okf), "--force"],
        };
      },
    },
    {
      id: 25,
      name: "docs -> ../other where other/okf is another git repository, --force",
      setup: (s) => {
        dir(s.root, "other", "okf", ".git");
        fs.writeFileSync(
          path.join(s.root, "other", "okf", "index.md"),
          "precious\n",
        );
        link(path.join("..", "other"), s.repo, "docs");
        return { cwd: s.repo, args: [okf, "--force"] };
      },
    },
    {
      id: 26,
      name: ".git is a file (worktree or submodule), docs -> ../outside, cwd elsewhere",
      setup: (s) => {
        fs.rmSync(path.join(s.repo, ".git"), { recursive: true, force: true });
        fs.writeFileSync(path.join(s.repo, ".git"), "gitdir: x\n");
        link(up, s.repo, "docs");
        return {
          cwd: dir(s.root, "el"),
          args: [path.join(s.repo, okf), "--force"],
        };
      },
    },
    {
      id: 27,
      name: "the target itself is alias -> repo",
      setup: (s) => {
        link("repo", s.root, "alias");
        return { cwd: s.root, args: ["alias", "--force"] };
      },
    },
    {
      id: 28,
      name: "log.md is a hard link to the outside file, --force",
      setup: (s) => {
        fs.linkSync(
          path.join(s.outside, "index.md"),
          path.join(dir(s.repo, "docs", "okf"), "log.md"),
        );
        return { cwd: s.repo, args: [okf, "--force"] };
      },
    },
    {
      id: 29,
      name: "control: an existing regular index.md is overwritten with --force",
      setup: (s) => {
        fs.writeFileSync(
          path.join(dir(s.repo, "docs", "okf"), "index.md"),
          "old\n",
        );
        return { cwd: s.repo, args: [okf, "--force"] };
      },
      landsIn: (s) => path.join(s.repo, "docs", "okf"),
    },
    {
      id: 30,
      name: "control: clean ../../docs/okf from a subdirectory",
      setup: (s) => ({
        cwd: dir(s.repo, "packages", "x"),
        args: [path.join("..", "..", okf)],
      }),
      landsIn: (s) => path.join(s.repo, "docs", "okf"),
    },
    {
      id: 31,
      name: "control: clean absolute target from a cwd outside the repo",
      setup: (s) => ({
        cwd: dir(s.root, "el"),
        args: [path.join(s.repo, okf)],
      }),
      landsIn: (s) => path.join(s.repo, "docs", "okf"),
    },
    {
      id: 32,
      name: "control: clean docs/okf in the repo",
      setup: (s) => ({ cwd: s.repo, args: [okf] }),
      landsIn: (s) => path.join(s.repo, "docs", "okf"),
    },
    {
      id: 33,
      name: "control: cwd entered through a link to the repo, clean relative target",
      setup: (s) => {
        link("repo", s.root, "cwdlink");
        return { cwd: path.join(s.root, "cwdlink"), args: [okf] };
      },
      landsIn: (s) => path.join(s.repo, "docs", "okf"),
    },
    {
      id: 34,
      name: "docs -> ../victim where victim is the root of another git repository",
      setup: (s) => {
        dir(s.root, "victim", ".git");
        link(path.join("..", "victim"), s.repo, "docs");
        return { cwd: s.repo, args: [okf, "--force"] };
      },
    },
    {
      id: 35,
      name: "docs -> ../victim-parent where victim-parent/okf is the root of another git repository, cwd elsewhere",
      setup: (s) => {
        dir(s.root, "victim-parent", "okf", ".git");
        fs.writeFileSync(
          path.join(s.root, "victim-parent", "okf", "log.md"),
          "precious\n",
        );
        link(path.join("..", "victim-parent"), s.repo, "docs");
        return {
          cwd: dir(s.root, "el"),
          args: [path.join(s.repo, okf), "--force"],
        };
      },
    },
  ];

  it.each(SCENARIOS)("[$id] $name", { timeout: 60000 }, (scenario) => {
    if (scenario.posixOnly === true && process.platform === "win32") return;
    const run = scenario.setup(s);
    const caseInsensitive = fs.existsSync(path.join(s.root, "REPO"));
    const refused =
      scenario.landsIn === undefined ||
      (scenario.refusedOnCaseInsensitiveVolume === true && caseInsensitive);
    const before = snapshot(s.root);
    const outsideBefore = snapshot(s.outside);

    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "init", ...run.args],
      {
        cwd: run.cwd,
        encoding: "utf8",
        timeout: 30000,
        killSignal: "SIGKILL",
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    // Whatever the verdict, nothing outside the repository changed.
    expect(snapshot(s.outside)).toEqual(outsideBefore);
    if (refused) {
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(NOTHING_WRITTEN);
      expect(snapshot(s.root)).toEqual(before);
    } else {
      expect(result.status).toBe(0);
      expectScaffoldIn((scenario.landsIn as (s: Sandbox) => string)(s));
    }
  });
});

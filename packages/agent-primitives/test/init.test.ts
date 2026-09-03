import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { init, ALL_HARNESSES, InitFsUsageError } from "../src/init/index.js";
import { init as initFromIndex } from "../src/index.js";
import { UsageError } from "../src/envelope.js";

// Permission bits are meaningless to root (bypasses them entirely), so the
// EACCES case below only discriminates as a non-root user.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-init-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CONTENT_A = "# skill A\n";
const CONTENT_B = "# skill B (different)\n";

describe("init", () => {
  it("is re-exported from the package's index", () => {
    expect(initFromIndex).toBe(init);
  });

  it("writes a fresh file for the default harness (claude)", async () => {
    const dir = makeTmpDir();
    const result = await init({ targetDir: dir, content: CONTENT_A });
    expect(result.status).toBe("written");
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.harness).toBe("claude");
    const filePath = path.join(
      dir,
      ".claude",
      "skills",
      "agent-primitives",
      "SKILL.md",
    );
    expect(result.targets[0]?.path).toBe(filePath);
    expect(fs.readFileSync(filePath, "utf8")).toBe(CONTENT_A);
  });

  it("reports unchanged when the existing content is byte-identical", async () => {
    const dir = makeTmpDir();
    await init({ targetDir: dir, content: CONTENT_A });
    const result = await init({ targetDir: dir, content: CONTENT_A });
    expect(result.status).toBe("unchanged");
    expect(result.targets[0]?.status).toBe("unchanged");
  });

  it("reports conflicted, and leaves the file untouched, when the content differs", async () => {
    const dir = makeTmpDir();
    await init({ targetDir: dir, content: CONTENT_A });
    const result = await init({ targetDir: dir, content: CONTENT_B });
    expect(result.status).toBe("conflicted");
    expect(result.targets[0]?.status).toBe("conflicted");
    const filePath = path.join(
      dir,
      ".claude",
      "skills",
      "agent-primitives",
      "SKILL.md",
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(CONTENT_A);
  });

  it("overwrites and reports written when --force resolves a conflict", async () => {
    const dir = makeTmpDir();
    await init({ targetDir: dir, content: CONTENT_A });
    await init({ targetDir: dir, content: CONTENT_B }); // conflicted, untouched
    const result = await init({
      targetDir: dir,
      content: CONTENT_B,
      force: true,
    });
    expect(result.status).toBe("written");
    const filePath = path.join(
      dir,
      ".claude",
      "skills",
      "agent-primitives",
      "SKILL.md",
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(CONTENT_B);
  });

  it("writes every requested harness to its own path, and never under .claude/agents", async () => {
    const dir = makeTmpDir();
    const result = await init({
      targetDir: dir,
      content: CONTENT_A,
      harnesses: [...ALL_HARNESSES],
    });
    expect(result.status).toBe("written");
    expect(result.targets).toHaveLength(3);
    expect(
      fs.readFileSync(
        path.join(dir, ".claude", "skills", "agent-primitives", "SKILL.md"),
        "utf8",
      ),
    ).toBe(CONTENT_A);
    expect(
      fs.readFileSync(
        path.join(dir, ".agents", "skills", "agent-primitives", "SKILL.md"),
        "utf8",
      ),
    ).toBe(CONTENT_A);
    expect(
      fs.readFileSync(
        path.join(dir, ".opencode", "skills", "agent-primitives", "SKILL.md"),
        "utf8",
      ),
    ).toBe(CONTENT_A);
    expect(fs.existsSync(path.join(dir, ".claude", "agents"))).toBe(false);
  });

  it("aggregates to conflicted when any one of several harnesses conflicts", async () => {
    const dir = makeTmpDir();
    await init({ targetDir: dir, content: CONTENT_A, harnesses: ["claude"] });
    const result = await init({
      targetDir: dir,
      content: CONTENT_B,
      harnesses: [...ALL_HARNESSES],
    });
    expect(result.status).toBe("conflicted");
    const claudeTarget = result.targets.find((t) => t.harness === "claude");
    const codexTarget = result.targets.find((t) => t.harness === "codex");
    expect(claudeTarget?.status).toBe("conflicted");
    expect(codexTarget?.status).toBe("written");
  });

  it("refuses a target that resolves outside targetDir via a pre-existing symlink", () => {
    const dir = makeTmpDir();
    const outside = makeTmpDir();
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, ".claude", "skills"));
    expect(() => init({ targetDir: dir, content: CONTENT_A })).toThrow(
      UsageError,
    );
    expect(
      fs.existsSync(path.join(outside, "agent-primitives", "SKILL.md")),
    ).toBe(false);
  });

  it("refuses the whole run, writing nothing, when only one of several harnesses escapes", () => {
    const dir = makeTmpDir();
    const outside = makeTmpDir();
    // codex's own path (.agents/skills/...) escapes; claude's does not.
    fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, ".agents", "skills"));
    expect(() =>
      init({
        targetDir: dir,
        content: CONTENT_A,
        harnesses: ["claude", "codex"],
      }),
    ).toThrow(UsageError);
    expect(
      fs.existsSync(path.join(dir, ".claude", "skills", "agent-primitives")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(outside, "agent-primitives", "SKILL.md")),
    ).toBe(false);
  });

  it("defaults to the packaged assets/skill/SKILL.md when no content override is given", async () => {
    const dir = makeTmpDir();
    const result = await init({ targetDir: dir });
    expect(result.status).toBe("written");
    const written = fs.readFileSync(result.targets[0]!.path, "utf8");
    expect(written).toMatch(/^---\nname: agent-primitives\n/);
  });

  describe("a symlink at the target file path itself", () => {
    function claudeFilePath(dir: string): string {
      return path.join(
        dir,
        ".claude",
        "skills",
        "agent-primitives",
        "SKILL.md",
      );
    }

    it("refuses a dangling symlink pointing outside targetDir, and writes nothing", () => {
      const dir = makeTmpDir();
      const outside = makeTmpDir();
      const filePath = claudeFilePath(dir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.symlinkSync(path.join(outside, "escaped.md"), filePath);

      expect(() => init({ targetDir: dir, content: CONTENT_A })).toThrow(
        UsageError,
      );
      expect(fs.existsSync(path.join(outside, "escaped.md"))).toBe(false);
    });

    it("refuses the same dangling symlink with --force", () => {
      const dir = makeTmpDir();
      const outside = makeTmpDir();
      const filePath = claudeFilePath(dir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.symlinkSync(path.join(outside, "escaped.md"), filePath);

      expect(() =>
        init({ targetDir: dir, content: CONTENT_A, force: true }),
      ).toThrow(UsageError);
      expect(fs.existsSync(path.join(outside, "escaped.md"))).toBe(false);
    });

    it("refuses a symlink at the target path even when it resolves inside targetDir", () => {
      const dir = makeTmpDir();
      const filePath = claudeFilePath(dir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const realFile = path.join(dir, "real-content.md");
      fs.writeFileSync(realFile, CONTENT_A);
      fs.symlinkSync(realFile, filePath);

      expect(() => init({ targetDir: dir, content: CONTENT_A })).toThrow(
        UsageError,
      );
      // The file the symlink points at, not just the symlink itself, is
      // never written through.
      expect(fs.readFileSync(realFile, "utf8")).toBe(CONTENT_A);
      expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
    });

    it("-H all: a dangling symlink at one harness's target refuses the whole run", () => {
      const dir = makeTmpDir();
      const outside = makeTmpDir();
      const codexFilePath = path.join(
        dir,
        ".agents",
        "skills",
        "agent-primitives",
        "SKILL.md",
      );
      fs.mkdirSync(path.dirname(codexFilePath), { recursive: true });
      fs.symlinkSync(path.join(outside, "escaped.md"), codexFilePath);

      expect(() =>
        init({
          targetDir: dir,
          content: CONTENT_A,
          harnesses: [...ALL_HARNESSES],
        }),
      ).toThrow(UsageError);
      expect(
        fs.existsSync(path.join(dir, ".claude", "skills", "agent-primitives")),
      ).toBe(false);
      expect(
        fs.existsSync(
          path.join(dir, ".opencode", "skills", "agent-primitives"),
        ),
      ).toBe(false);
      expect(fs.existsSync(path.join(outside, "escaped.md"))).toBe(false);
    });

    it("O_NOFOLLOW refuses a symlink planted after the pre-write check finds no entry (TOCTOU)", () => {
      const dir = makeTmpDir();
      const outside = makeTmpDir();
      const filePath = claudeFilePath(dir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      const realLstatSync = fs.lstatSync;
      const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((
        p: fs.PathLike,
        opts?: unknown,
      ) => {
        if (p === filePath) {
          // Simulate a race: something else plants a symlink in the
          // gap right after this process's own check observed nothing
          // there, then this mock still reports "no entry" to the
          // caller, exactly as the real, unraced check would have.
          fs.symlinkSync(path.join(outside, "escaped.md"), filePath);
          return undefined;
        }
        return (realLstatSync as (p: fs.PathLike, opts?: unknown) => unknown)(
          p,
          opts,
        );
      }) as typeof fs.lstatSync);

      try {
        expect(() => init({ targetDir: dir, content: CONTENT_A })).toThrow();
      } finally {
        spy.mockRestore();
      }
      expect(fs.existsSync(path.join(outside, "escaped.md"))).toBe(false);
    });
  });

  describe("a symlink introduced while init creates the target directory", () => {
    it("re-checks realpath after mkdir, refusing an intermediate symlink introduced during directory creation (TOCTOU)", () => {
      const dir = makeTmpDir();
      const outside = makeTmpDir();
      const claudeDir = path.join(dir, ".claude");
      const skillDir = path.join(claudeDir, "skills", "agent-primitives");

      const realMkdirSync = fs.mkdirSync;
      const spy = vi.spyOn(fs, "mkdirSync").mockImplementation(((
        p: fs.PathLike,
        opts?: unknown,
      ) => {
        if (p === skillDir) {
          // Simulate a race: something else replaced ".claude" with a
          // symlink to an outside directory right before this
          // process's own mkdir -p ran.
          fs.symlinkSync(outside, claudeDir);
        }
        return (realMkdirSync as (p: fs.PathLike, opts?: unknown) => unknown)(
          p,
          opts,
        );
      }) as typeof fs.mkdirSync);

      try {
        expect(() => init({ targetDir: dir, content: CONTENT_A })).toThrow(
          UsageError,
        );
      } finally {
        spy.mockRestore();
      }
      // The race's mkdir -p unavoidably creates the empty directory shell
      // under `outside` before the post-mkdir recheck can run; what the
      // recheck must still prevent is the file itself landing there.
      expect(
        fs.existsSync(
          path.join(outside, "skills", "agent-primitives", "SKILL.md"),
        ),
      ).toBe(false);
    });
  });

  describe("named reasons for filesystem errors at the target", () => {
    it('ENOTDIR: "-t" itself is a file -> reason "target_not_a_directory"', () => {
      const parent = makeTmpDir();
      const targetDir = path.join(parent, "not-a-directory");
      fs.writeFileSync(targetDir, "x");

      let caught: unknown;
      try {
        init({ targetDir, content: CONTENT_A });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InitFsUsageError);
      expect((caught as InitFsUsageError).reason).toBe(
        "target_not_a_directory",
      );
    });

    it('EISDIR: a directory sits at the target file path -> reason "target_path_is_a_directory"', () => {
      const dir = makeTmpDir();
      const filePath = path.join(
        dir,
        ".claude",
        "skills",
        "agent-primitives",
        "SKILL.md",
      );
      fs.mkdirSync(filePath, { recursive: true });

      let caught: unknown;
      try {
        init({ targetDir: dir, content: CONTENT_A });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InitFsUsageError);
      expect((caught as InitFsUsageError).reason).toBe(
        "target_path_is_a_directory",
      );
    });

    it.skipIf(isRoot)(
      'EACCES: an unwritable existing target with --force -> reason "target_not_writable"',
      () => {
        const dir = makeTmpDir();
        const filePath = path.join(
          dir,
          ".claude",
          "skills",
          "agent-primitives",
          "SKILL.md",
        );
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, CONTENT_B);
        fs.chmodSync(filePath, 0o400);

        let caught: unknown;
        try {
          init({ targetDir: dir, content: CONTENT_A, force: true });
        } catch (err) {
          caught = err;
        } finally {
          fs.chmodSync(filePath, 0o600);
        }
        expect(caught).toBeInstanceOf(InitFsUsageError);
        expect((caught as InitFsUsageError).reason).toBe("target_not_writable");
      },
    );

    it('a symlink at the target file path -> reason "target_is_a_symlink"', () => {
      const dir = makeTmpDir();
      const filePath = path.join(
        dir,
        ".claude",
        "skills",
        "agent-primitives",
        "SKILL.md",
      );
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.symlinkSync(path.join(dir, "elsewhere.md"), filePath);

      let caught: unknown;
      try {
        init({ targetDir: dir, content: CONTENT_A });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InitFsUsageError);
      expect((caught as InitFsUsageError).reason).toBe("target_is_a_symlink");
    });

    it('a resolved target that escapes --target-dir -> reason "target_escapes_directory"', () => {
      const dir = makeTmpDir();
      const outside = makeTmpDir();
      fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
      fs.symlinkSync(outside, path.join(dir, ".claude", "skills"));

      let caught: unknown;
      try {
        init({ targetDir: dir, content: CONTENT_A });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InitFsUsageError);
      expect((caught as InitFsUsageError).reason).toBe(
        "target_escapes_directory",
      );
    });

    it('ELOOP from the O_NOFOLLOW open (a symlink planted after pre-validation) -> reason "target_is_a_symlink"', () => {
      const dir = makeTmpDir();
      const skillDir = path.join(dir, ".claude", "skills", "agent-primitives");
      fs.mkdirSync(skillDir, { recursive: true });
      const filePath = path.join(skillDir, "SKILL.md");

      const realLstatSync = fs.lstatSync;
      const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((
        p: fs.PathLike,
        opts?: unknown,
      ) => {
        if (p === filePath) {
          // Simulate a race: something else plants a symlink, pointing
          // inside the target directory at a file that does not exist,
          // right after this process's own pre-validation lstat observed
          // nothing there. resolveDeepestExisting cannot resolve a
          // dangling symlink through realpath, so it falls back to the
          // (real, contained) parent directory and containment holds;
          // only the write's own O_NOFOLLOW open still catches this one.
          fs.symlinkSync(path.join(skillDir, "does-not-exist.md"), filePath);
          return undefined;
        }
        return (realLstatSync as (p: fs.PathLike, opts?: unknown) => unknown)(
          p,
          opts,
        );
      }) as typeof fs.lstatSync);

      let caught: unknown;
      try {
        init({ targetDir: dir, content: CONTENT_A });
      } catch (err) {
        caught = err;
      } finally {
        spy.mockRestore();
      }
      expect(caught).toBeInstanceOf(InitFsUsageError);
      expect((caught as InitFsUsageError).reason).toBe("target_is_a_symlink");
      expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
    });
  });

  describe("-H all validates every harness before writing any of them", () => {
    it("a directory at the codex target refuses the run before claude is written", () => {
      const dir = makeTmpDir();
      const codexFilePath = path.join(
        dir,
        ".agents",
        "skills",
        "agent-primitives",
        "SKILL.md",
      );
      fs.mkdirSync(codexFilePath, { recursive: true });

      let caught: unknown;
      try {
        init({
          targetDir: dir,
          content: CONTENT_A,
          harnesses: [...ALL_HARNESSES],
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InitFsUsageError);
      expect((caught as InitFsUsageError).reason).toBe(
        "target_path_is_a_directory",
      );
      expect((caught as InitFsUsageError).targets).toEqual([]);
      expect(
        fs.existsSync(path.join(dir, ".claude", "skills", "agent-primitives")),
      ).toBe(false);
      expect(
        fs.existsSync(
          path.join(dir, ".opencode", "skills", "agent-primitives"),
        ),
      ).toBe(false);
    });

    it.skipIf(isRoot)(
      "a read-only existing file at the codex target with --force refuses the run before claude is written",
      () => {
        const dir = makeTmpDir();
        const codexFilePath = path.join(
          dir,
          ".agents",
          "skills",
          "agent-primitives",
          "SKILL.md",
        );
        fs.mkdirSync(path.dirname(codexFilePath), { recursive: true });
        fs.writeFileSync(codexFilePath, CONTENT_B);
        fs.chmodSync(codexFilePath, 0o400);

        let caught: unknown;
        try {
          init({
            targetDir: dir,
            content: CONTENT_A,
            harnesses: [...ALL_HARNESSES],
            force: true,
          });
        } catch (err) {
          caught = err;
        } finally {
          fs.chmodSync(codexFilePath, 0o600);
        }
        expect(caught).toBeInstanceOf(InitFsUsageError);
        expect((caught as InitFsUsageError).reason).toBe("target_not_writable");
        expect((caught as InitFsUsageError).targets).toEqual([]);
        expect(
          fs.existsSync(
            path.join(dir, ".claude", "skills", "agent-primitives"),
          ),
        ).toBe(false);
        expect(
          fs.existsSync(
            path.join(dir, ".opencode", "skills", "agent-primitives"),
          ),
        ).toBe(false);
      },
    );
  });

  describe("--force over a strictly longer existing target", () => {
    it("overwrites without leaving a trailing tail from the old content (O_TRUNC)", async () => {
      const dir = makeTmpDir();
      const filePath = path.join(
        dir,
        ".claude",
        "skills",
        "agent-primitives",
        "SKILL.md",
      );
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const packaged = fs.readFileSync(
        new URL("../assets/skill/SKILL.md", import.meta.url),
        "utf8",
      );
      // Strictly longer than the packaged skill, so a write that opened
      // without O_TRUNC (or with it silently dropped, e.g. by an `| 0`
      // in place of the real flag) would leave this tail behind.
      const longerExisting = packaged + "x".repeat(packaged.length + 1000);
      expect(longerExisting.length).toBeGreaterThan(packaged.length);
      fs.writeFileSync(filePath, longerExisting);

      const result = await init({ targetDir: dir, force: true });
      expect(result.status).toBe("written");
      const written = fs.readFileSync(filePath, "utf8");
      expect(written.length).toBe(packaged.length);
      expect(written).toBe(packaged);
    });
  });

  describe("the O_NOFOLLOW guard is asserted at module load", () => {
    afterEach(() => {
      vi.doUnmock("node:fs");
      vi.resetModules();
    });

    it("refuses to load when fs.constants.O_NOFOLLOW is not a positive number", async () => {
      vi.doMock("node:fs", async () => {
        const actual =
          await vi.importActual<typeof import("node:fs")>("node:fs");
        const constants = { ...actual.constants, O_NOFOLLOW: undefined };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mocked: any = { ...actual, constants };
        mocked.default = mocked;
        return mocked;
      });
      vi.resetModules();
      await expect(import("../src/init/index.js")).rejects.toThrow(
        /O_NOFOLLOW/,
      );
    });
  });
});

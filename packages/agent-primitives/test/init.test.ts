import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { init, ALL_HARNESSES, InitFsUsageError } from "../src/init/index.js";
import {
  init as initFromIndex,
  InitFsUsageError as InitFsUsageErrorFromIndex,
} from "../src/index.js";
import type { InitFsErrorReason as InitFsErrorReasonFromIndex } from "../src/index.js";
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
  it("is re-exported from the package's index, error class included", () => {
    expect(initFromIndex).toBe(init);
    expect(InitFsUsageErrorFromIndex).toBe(InitFsUsageError);
    // The reason type travels with the class: a caller narrowing on
    // `reason` imports both from the barrel, and this assignment is the
    // typecheck's own witness that the type export exists.
    const reason: InitFsErrorReasonFromIndex = "target_not_a_regular_file";
    expect(reason).toBe("target_not_a_regular_file");
  });

  it("writes a fresh file for the default harness (claude)", () => {
    const dir = makeTmpDir();
    const result = init({ targetDir: dir, content: CONTENT_A });
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

  it("reports unchanged when the existing content is byte-identical", () => {
    const dir = makeTmpDir();
    init({ targetDir: dir, content: CONTENT_A });
    const result = init({ targetDir: dir, content: CONTENT_A });
    expect(result.status).toBe("unchanged");
    expect(result.targets[0]?.status).toBe("unchanged");
  });

  it("reports conflicted, and leaves the file untouched, when the content differs", () => {
    const dir = makeTmpDir();
    init({ targetDir: dir, content: CONTENT_A });
    const result = init({ targetDir: dir, content: CONTENT_B });
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

  it("overwrites and reports written when --force resolves a conflict", () => {
    const dir = makeTmpDir();
    init({ targetDir: dir, content: CONTENT_A });
    init({ targetDir: dir, content: CONTENT_B }); // conflicted, untouched
    const result = init({
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

  it("writes every requested harness to its own path, and never under .claude/agents", () => {
    const dir = makeTmpDir();
    const result = init({
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

  it("aggregates to conflicted when any one of several harnesses conflicts", () => {
    const dir = makeTmpDir();
    init({ targetDir: dir, content: CONTENT_A, harnesses: ["claude"] });
    const result = init({
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

  it("defaults to the packaged assets/skill/SKILL.md when no content override is given", () => {
    const dir = makeTmpDir();
    const result = init({ targetDir: dir });
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
      let planted = false;
      const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((
        p: fs.PathLike,
        opts?: unknown,
      ) => {
        if (p === filePath && !planted) {
          planted = true;
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
    for (const mode of [0o000, 0o200]) {
      it.skipIf(isRoot)(
        `mode ${mode.toString(8).padStart(4, "0")}: an existing target that cannot be read -> reason "target_not_readable"`,
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
          fs.chmodSync(filePath, mode);

          let caught: unknown;
          try {
            init({ targetDir: dir, content: CONTENT_A });
          } catch (err) {
            caught = err;
          } finally {
            fs.chmodSync(filePath, 0o600);
          }
          expect(caught).toBeInstanceOf(InitFsUsageError);
          expect((caught as InitFsUsageError).reason).toBe(
            "target_not_readable",
          );
        },
      );
    }

    it('an unmapped read failure -> reason "target_not_readable"', () => {
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
      const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((p) => {
        if (p === filePath) throw new RangeError("fixture read limit");
        return CONTENT_A;
      }) as typeof fs.readFileSync);

      let caught: unknown;
      try {
        init({ targetDir: dir, content: CONTENT_A });
      } catch (err) {
        caught = err;
      } finally {
        spy.mockRestore();
      }
      expect(caught).toBeInstanceOf(InitFsUsageError);
      expect((caught as InitFsUsageError).reason).toBe("target_not_readable");
    });

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
      let planted = false;
      const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((
        p: fs.PathLike,
        opts?: unknown,
      ) => {
        if (p === filePath && !planted) {
          planted = true;
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

  describe("validation-to-write changes", () => {
    function targetPath(dir: string): string {
      return path.join(
        dir,
        ".claude",
        "skills",
        "agent-primitives",
        "SKILL.md",
      );
    }

    it("writes again when an identical target is removed after validation", () => {
      const dir = makeTmpDir();
      const filePath = targetPath(dir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, CONTENT_A);
      const realLstat = fs.lstatSync;
      let targetStats = 0;
      const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((p, opts) => {
        if (p === filePath && ++targetStats === 2) fs.unlinkSync(filePath);
        return realLstat(p, opts as never);
      }) as typeof fs.lstatSync);
      try {
        const result = init({ targetDir: dir, content: CONTENT_A });
        expect(result.targets[0]?.status).toBe("written");
      } finally {
        spy.mockRestore();
      }
      expect(fs.readFileSync(filePath, "utf8")).toBe(CONTENT_A);
    });

    it("reports conflict when an identical target is rewritten after validation", () => {
      const dir = makeTmpDir();
      const filePath = targetPath(dir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, CONTENT_A);
      const realLstat = fs.lstatSync;
      let targetStats = 0;
      const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((p, opts) => {
        if (p === filePath && ++targetStats === 2) {
          fs.writeFileSync(filePath, CONTENT_B);
        }
        return realLstat(p, opts as never);
      }) as typeof fs.lstatSync);
      try {
        const result = init({ targetDir: dir, content: CONTENT_A });
        expect(result.targets[0]?.status).toBe("conflicted");
      } finally {
        spy.mockRestore();
      }
      expect(fs.readFileSync(filePath, "utf8")).toBe(CONTENT_B);
    });

    it("preserves and conflicts with a regular target created just before the absent-name open", () => {
      const dir = makeTmpDir();
      const filePath = targetPath(dir);
      const realOpen = fs.openSync;
      let planted = false;
      const spy = vi.spyOn(fs, "openSync").mockImplementation(((p, flags) => {
        if (p === filePath && !planted) {
          planted = true;
          fs.writeFileSync(filePath, CONTENT_B);
        }
        return realOpen(p, flags);
      }) as typeof fs.openSync);
      try {
        const result = init({ targetDir: dir, content: CONTENT_A });
        expect(result.targets[0]?.status).toBe("conflicted");
      } finally {
        spy.mockRestore();
      }
      expect(fs.readFileSync(filePath, "utf8")).toBe(CONTENT_B);
    });

    it("preserves and conflicts when an identical target is removed, then recreated differently before open", () => {
      const dir = makeTmpDir();
      const filePath = targetPath(dir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, CONTENT_A);
      const realLstat = fs.lstatSync;
      let targetStats = 0;
      const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((
        p,
        opts,
      ) => {
        if (p === filePath && ++targetStats === 2) fs.unlinkSync(filePath);
        return realLstat(p, opts as never);
      }) as typeof fs.lstatSync);
      const realOpen = fs.openSync;
      let planted = false;
      const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((
        p,
        flags,
      ) => {
        if (p === filePath && !planted) {
          planted = true;
          fs.writeFileSync(filePath, CONTENT_B);
        }
        return realOpen(p, flags);
      }) as typeof fs.openSync);
      try {
        const result = init({ targetDir: dir, content: CONTENT_A });
        expect(result.targets[0]?.status).toBe("conflicted");
      } finally {
        openSpy.mockRestore();
        lstatSpy.mockRestore();
      }
      expect(fs.readFileSync(filePath, "utf8")).toBe(CONTENT_B);
    });
  });

  it("completes a write when writeSync initially writes only a prefix", () => {
    const dir = makeTmpDir();
    const realWrite = fs.writeSync;
    let calls = 0;
    const spy = vi.spyOn(fs, "writeSync").mockImplementation(((
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
    ) => {
      calls += 1;
      const bounded =
        calls === 1 ? Math.max(1, Math.floor(length / 2)) : length;
      return realWrite(fd, buffer, offset, bounded);
    }) as typeof fs.writeSync);
    try {
      const result = init({ targetDir: dir, content: CONTENT_B.repeat(100) });
      expect(result.status).toBe("written");
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBeGreaterThan(1);
    expect(
      fs.readFileSync(
        path.join(dir, ".claude", "skills", "agent-primitives", "SKILL.md"),
        "utf8",
      ),
    ).toBe(CONTENT_B.repeat(100));
  });

  it("names a zero-progress write failure and closes the descriptor", () => {
    const dir = makeTmpDir();
    const writeSpy = vi.spyOn(fs, "writeSync").mockReturnValue(0);
    const closeSpy = vi.spyOn(fs, "closeSync");
    let caught: unknown;
    let closeCalls = 0;
    try {
      init({ targetDir: dir, content: CONTENT_A });
    } catch (err) {
      caught = err;
    } finally {
      closeCalls = closeSpy.mock.calls.length;
      writeSpy.mockRestore();
      closeSpy.mockRestore();
    }
    expect(caught).toBeInstanceOf(InitFsUsageError);
    expect((caught as InitFsUsageError).reason).toBe("target_write_failed");
    expect(closeCalls).toBe(1);
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

  describe("a read-only target that already holds the content being installed", () => {
    function writeReadOnly(filePath: string, content: string): void {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      fs.chmodSync(filePath, 0o400);
    }

    it.skipIf(isRoot)(
      "reports unchanged under --force instead of refusing it as unwritable",
      () => {
        const dir = makeTmpDir();
        const filePath = path.join(
          dir,
          ".claude",
          "skills",
          "agent-primitives",
          "SKILL.md",
        );
        writeReadOnly(filePath, CONTENT_A);

        let result;
        try {
          result = init({ targetDir: dir, content: CONTENT_A, force: true });
        } finally {
          fs.chmodSync(filePath, 0o600);
        }
        expect(result.status).toBe("unchanged");
        expect(result.targets[0]?.status).toBe("unchanged");
        expect(fs.readFileSync(filePath, "utf8")).toBe(CONTENT_A);
      },
    );

    it.skipIf(isRoot)(
      "-H all: the other harnesses are still installed alongside it",
      () => {
        const dir = makeTmpDir();
        const codexFilePath = path.join(
          dir,
          ".agents",
          "skills",
          "agent-primitives",
          "SKILL.md",
        );
        writeReadOnly(codexFilePath, CONTENT_A);

        let result;
        try {
          result = init({
            targetDir: dir,
            content: CONTENT_A,
            harnesses: [...ALL_HARNESSES],
            force: true,
          });
        } finally {
          fs.chmodSync(codexFilePath, 0o600);
        }
        expect(result.status).toBe("written");
        expect(result.targets.find((t) => t.harness === "codex")?.status).toBe(
          "unchanged",
        );
        expect(result.targets.find((t) => t.harness === "claude")?.status).toBe(
          "written",
        );
        expect(
          fs.readFileSync(
            path.join(dir, ".claude", "skills", "agent-primitives", "SKILL.md"),
            "utf8",
          ),
        ).toBe(CONTENT_A);
        expect(
          fs.readFileSync(
            path.join(
              dir,
              ".opencode",
              "skills",
              "agent-primitives",
              "SKILL.md",
            ),
            "utf8",
          ),
        ).toBe(CONTENT_A);
      },
    );
  });

  describe("a failure during the write phase, after earlier harnesses landed", () => {
    it("carries the completed prefix on the error's own targets", () => {
      const dir = makeTmpDir();
      const opencodeFilePath = path.join(
        dir,
        ".opencode",
        "skills",
        "agent-primitives",
        "SKILL.md",
      );
      fs.mkdirSync(path.dirname(opencodeFilePath), { recursive: true });

      const realLstatSync = fs.lstatSync;
      let planted = false;
      const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((
        p: fs.PathLike,
        opts?: unknown,
      ) => {
        if (p === opencodeFilePath && !planted) {
          planted = true;
          // Simulate a race on the last of the three harnesses: something
          // else plants a symlink right after this process's own
          // pre-validation lstat observed nothing there, so claude and
          // codex are written before opencode's own O_NOFOLLOW open fails.
          fs.symlinkSync(
            path.join(path.dirname(opencodeFilePath), "does-not-exist.md"),
            opencodeFilePath,
          );
          return undefined;
        }
        return (realLstatSync as (p: fs.PathLike, opts?: unknown) => unknown)(
          p,
          opts,
        );
      }) as typeof fs.lstatSync);

      let caught: unknown;
      try {
        init({
          targetDir: dir,
          content: CONTENT_A,
          harnesses: [...ALL_HARNESSES],
        });
      } catch (err) {
        caught = err;
      } finally {
        spy.mockRestore();
      }

      expect(caught).toBeInstanceOf(InitFsUsageError);
      const err = caught as InitFsUsageError;
      expect(err.reason).toBe("target_is_a_symlink");
      // Exactly the harnesses that completed before the failure, in order,
      // and no entry for the one that failed.
      expect(err.targets.map((t) => t.harness)).toEqual(["claude", "codex"]);
      expect(err.targets.map((t) => t.status)).toEqual(["written", "written"]);
      expect(
        fs.readFileSync(
          path.join(dir, ".claude", "skills", "agent-primitives", "SKILL.md"),
          "utf8",
        ),
      ).toBe(CONTENT_A);
    });
  });

  describe("--force over a strictly longer existing target", () => {
    it("overwrites without leaving a trailing tail from the old content (O_TRUNC)", () => {
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

      const result = init({ targetDir: dir, force: true });
      expect(result.status).toBe("written");
      const written = fs.readFileSync(filePath, "utf8");
      expect(written.length).toBe(packaged.length);
      expect(written).toBe(packaged);
    });
  });

  describe("the O_NOFOLLOW guard is checked by init(), not at module load", () => {
    afterEach(() => {
      vi.doUnmock("node:fs");
      vi.resetModules();
    });

    /** Re-imports the module graph with `fs.constants.O_NOFOLLOW` removed,
     * standing in for a platform that does not offer the constant. */
    function mockFsWithoutONoFollow(): void {
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
    }

    it('init() refuses with reason "platform_unsupported" when fs.constants.O_NOFOLLOW is not a positive number', async () => {
      const dir = makeTmpDir();
      mockFsWithoutONoFollow();
      const mod = await import("../src/init/index.js");

      let caught: unknown;
      try {
        mod.init({ targetDir: dir, content: CONTENT_A });
      } catch (err) {
        caught = err;
      }
      // The re-imported module has its own class identity, so the reason
      // and the message carry the assertion rather than `instanceof`.
      expect((caught as { reason?: string } | undefined)?.reason).toBe(
        "platform_unsupported",
      );
      expect((caught as Error | undefined)?.message).toMatch(/O_NOFOLLOW/);
      expect(
        fs.existsSync(
          path.join(dir, ".claude", "skills", "agent-primitives", "SKILL.md"),
        ),
      ).toBe(false);
    });

    it("probe, verify, and doctor stay loadable on the same platform", async () => {
      mockFsWithoutONoFollow();
      const barrel = await import("../src/index.js");
      expect(typeof barrel.probe).toBe("function");
      expect(typeof barrel.verify).toBe("function");
      expect(typeof barrel.doctor).toBe("function");
    });
  });
});

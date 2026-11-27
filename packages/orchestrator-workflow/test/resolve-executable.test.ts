import { describe, expect, it } from "vitest";

import {
  isFullyQualifiedWin32,
  resolveExecutable,
} from "../src/resolve-executable.js";

/** A fake file system: only the listed absolute paths are regular files. */
function filesOf(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

const CWD_PLANT = "opencode.exe";

describe("isFullyQualifiedWin32", () => {
  it("accepts drive-absolute and UNC paths", () => {
    expect(isFullyQualifiedWin32("C:\\tools")).toBe(true);
    expect(isFullyQualifiedWin32("d:/tools")).toBe(true);
    expect(isFullyQualifiedWin32("\\\\server\\share\\bin")).toBe(true);
  });

  it("rejects relative, empty, current-drive and drive-relative paths", () => {
    for (const entry of [
      "",
      ".",
      "..\\bin",
      "bin",
      "\\foo",
      "C:foo",
      "C:",
      "\\\\server",
      "\\\\server\\",
    ]) {
      expect(isFullyQualifiedWin32(entry), entry).toBe(false);
    }
  });
});

describe("resolveExecutable on win32", () => {
  const base = { platform: "win32" } as const;

  it("never returns a file from the current directory for relative PATH entries", () => {
    // The fake file system holds the planted files under every spelling a
    // naive lookup could produce; none of them may come back.
    const planted = [
      CWD_PLANT,
      "opencode.com",
      ".\\opencode.exe",
      "bin\\opencode.exe",
      "\\opencode.exe",
      "C:opencode.exe",
      "C:bin\\opencode.exe",
    ];
    for (const pathEnv of [
      ".",
      ";;",
      "",
      "bin",
      ".;bin;..\\x",
      "\\",
      "C:",
      "C:bin",
    ]) {
      expect(
        resolveExecutable("opencode", {
          ...base,
          pathEnv,
          isFile: filesOf(...planted),
        }),
        pathEnv,
      ).toBeUndefined();
    }
  });

  it("skips relative entries but still finds a later absolute one", () => {
    const hit = "C:\\tools\\opencode.exe";
    expect(
      resolveExecutable("opencode", {
        ...base,
        pathEnv: `.;;bin;C:rel;${"C:\\tools"}`,
        isFile: filesOf(CWD_PLANT, "bin\\opencode.exe", hit),
      }),
    ).toBe(hit);
  });

  it("accepts a quoted absolute entry and strips the quotes", () => {
    const hit = "C:\\Program Files\\opencode\\opencode.exe";
    expect(
      resolveExecutable("opencode", {
        ...base,
        pathEnv: '"C:\\Program Files\\opencode"',
        isFile: filesOf(hit),
      }),
    ).toBe(hit);
  });

  it("does not treat a quoted relative entry as absolute", () => {
    expect(
      resolveExecutable("opencode", {
        ...base,
        pathEnv: '".";"bin"',
        isFile: filesOf("opencode.exe", "bin\\opencode.exe"),
      }),
    ).toBeUndefined();
  });

  it("accepts a UNC entry", () => {
    const hit = "\\\\srv\\share\\opencode.exe";
    expect(
      resolveExecutable("opencode", {
        ...base,
        pathEnv: "\\\\srv\\share",
        isFile: filesOf(hit),
      }),
    ).toBe(hit);
  });

  it("drops trailing separators before joining", () => {
    const hit = "C:\\tools\\opencode.exe";
    expect(
      resolveExecutable("opencode", {
        ...base,
        pathEnv: "C:\\tools\\\\",
        isFile: filesOf(hit),
      }),
    ).toBe(hit);
  });

  it("tries .exe before .com when PATHEXT is unset", () => {
    const both = filesOf("C:\\a\\opencode.exe", "C:\\a\\opencode.com");
    expect(
      resolveExecutable("opencode", {
        ...base,
        pathEnv: "C:\\a",
        isFile: both,
      }),
    ).toBe("C:\\a\\opencode.exe");
  });

  it("follows PATHEXT order between .exe and .com", () => {
    const both = filesOf("C:\\a\\opencode.exe", "C:\\a\\opencode.com");
    expect(
      resolveExecutable("opencode", {
        ...base,
        pathEnv: "C:\\a",
        pathExt: ".CMD;.COM;.EXE",
        isFile: both,
      }),
    ).toBe("C:\\a\\opencode.com");
    expect(
      resolveExecutable("opencode", {
        ...base,
        pathEnv: "C:\\a",
        pathExt: ".EXE;.COM",
        isFile: both,
      }),
    ).toBe("C:\\a\\opencode.exe");
  });

  it("falls back to .exe then .com when PATHEXT names neither", () => {
    expect(
      resolveExecutable("opencode", {
        ...base,
        pathEnv: "C:\\a",
        pathExt: ".CMD;.BAT",
        isFile: filesOf("C:\\a\\opencode.com", "C:\\a\\opencode.exe"),
      }),
    ).toBe("C:\\a\\opencode.exe");
  });

  it("reports not found for a .cmd or .bat shim alone", () => {
    for (const pathExt of [undefined, ".CMD;.BAT;.EXE;.COM"]) {
      expect(
        resolveExecutable("opencode", {
          ...base,
          pathEnv: "C:\\npm",
          pathExt,
          isFile: filesOf(
            "C:\\npm\\opencode.cmd",
            "C:\\npm\\opencode.bat",
            "C:\\npm\\opencode",
          ),
        }),
      ).toBeUndefined();
    }
  });

  it("returns the first absolute hit in PATH order", () => {
    expect(
      resolveExecutable("opencode", {
        ...base,
        pathEnv: "C:\\first;C:\\second",
        isFile: filesOf("C:\\second\\opencode.exe", "C:\\first\\opencode.com"),
      }),
    ).toBe("C:\\first\\opencode.com");
    expect(
      resolveExecutable("opencode", {
        ...base,
        pathEnv: "C:\\first;C:\\second",
        isFile: filesOf("C:\\second\\opencode.exe"),
      }),
    ).toBe("C:\\second\\opencode.exe");
  });

  it("returns undefined for an unset or empty PATH", () => {
    const isFile = filesOf(CWD_PLANT);
    expect(
      resolveExecutable("opencode", { ...base, pathEnv: undefined, isFile }),
    ).toBeUndefined();
    expect(
      resolveExecutable("opencode", { ...base, pathEnv: "", isFile }),
    ).toBeUndefined();
  });
});

describe("resolveExecutable off win32", () => {
  it("returns the bare name for linux and darwin without consulting the file system", () => {
    for (const platform of ["linux", "darwin", "freebsd"]) {
      expect(
        resolveExecutable("opencode", {
          platform,
          pathEnv: ".:/usr/bin",
          isFile: () => {
            throw new Error("must not be called");
          },
        }),
      ).toBe("opencode");
    }
  });
});

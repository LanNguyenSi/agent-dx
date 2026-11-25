import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readBlobBytes, specPathIn } from "../../src/state/git.js";
import { createFile, replaceFile } from "../../src/state/write.js";
import { LintGitError } from "../../src/lint/git/exec.js";
import { Repo } from "../lint/git-helpers.js";
import { scratch } from "../lint/helpers.js";

describe("specPathIn", () => {
  it("names a directory below the root, the root itself, and nothing outside", () => {
    const root = scratch();
    for (const name of ["a/b", "..x", "..x/y"]) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      expect(specPathIn(root, path.join(root, name)), name).toBe(name);
    }
    expect(specPathIn(root, root)).toBe("");
    expect(specPathIn(path.join(root, "a"), root)).toBeNull();
    expect(
      specPathIn(path.join(root, "a", "b"), path.join(root, "..x")),
    ).toBeNull();
    expect(specPathIn(root, path.join(root, "missing"))).toBeNull();
  });
});

describe("readBlobBytes", { timeout: 60_000 }, () => {
  it("reads raw bytes, gives null for a missing path and refuses a link", async () => {
    const repo = await Repo.create();
    const commit = await repo.commit(
      { "a.txt": "\uFEFFbytes\n", link: { linkTo: "a.txt" } },
      "files",
    );
    expect(readBlobBytes(repo.dir, commit, "a.txt")).toEqual(
      Buffer.from("\uFEFFbytes\n"),
    );
    expect(readBlobBytes(repo.dir, commit, "nope.txt")).toBeNull();
    let code: string | undefined;
    try {
      readBlobBytes(repo.dir, commit, "link");
    } catch (err) {
      if (err instanceof LintGitError) code = err.code;
    }
    expect(code).toBe("path-not-regular");
  });
});

describe("replaceFile and createFile", () => {
  it("replaceFile keeps the permission bits of the file it replaces", () => {
    const dir = scratch();
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "old\n");
    fs.chmodSync(file, 0o640);
    expect(replaceFile(dir, "f.txt", "new\n")).toEqual({ ok: true });
    expect(fs.readFileSync(file, "utf8")).toBe("new\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir)).toEqual(["f.txt"]);
  });

  it("replaceFile refuses a target that is not a regular file", () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, "d"));
    fs.writeFileSync(path.join(dir, "real"), "x");
    fs.symlinkSync("real", path.join(dir, "l"));
    for (const name of ["d", "l"]) {
      const result = replaceFile(dir, name, "x");
      expect(result, name).toEqual({
        ok: false,
        message: `${name} is not a regular file`,
      });
    }
    expect(fs.readFileSync(path.join(dir, "real"), "utf8")).toBe("x");
  });

  it("createFile never overwrites an existing name", () => {
    const dir = scratch();
    expect(createFile(dir, "n", "one")).toEqual({ ok: true });
    expect(createFile(dir, "n", "two")).toEqual({
      ok: false,
      message: "n already exists",
    });
    expect(fs.readFileSync(path.join(dir, "n"), "utf8")).toBe("one");
    expect(fs.readdirSync(dir)).toEqual(["n"]);
  });
});

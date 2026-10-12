import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parsePatchPlan,
  patch,
  PatchUsageError,
  type PatchEditSpec,
} from "../src/patch/index.js";
import {
  applyReplacementsPreservingUnchangedLines,
  resolveFileEdits,
} from "../src/patch/engine.js";
import { notFoundHint, visualizeWhitespace } from "../src/patch/hint.js";
import { statusClass } from "../src/envelope.js";
import { buildSpawnEnv, CLI_PATH, spawnCli } from "./helpers/spawn-cli.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(prefix = "agent-primitives-patch-test-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

/** A git work tree (only `.git` matters: it marks the root). */
function repo(files: Record<string, string | Buffer> = {}): string {
  const dir = tmpDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

function readBuf(dir: string, rel: string): Buffer {
  return fs.readFileSync(path.join(dir, rel));
}

function run(cwd: string, edits: PatchEditSpec[], extra = {}) {
  return patch({ cwd, edits, ...extra });
}

/** Every entry of a directory tree except `.git`. */
function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const full = path.join(d, e.name);
      out.push(path.relative(dir, full));
      if (e.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

describe("patch: matching tiers", () => {
  it("exact match first, reported per edit with its line range", () => {
    const dir = repo({ "a.txt": "one\ntwo\nthree\n" });
    const r = run(dir, [{ file: "a.txt", old: "two\nthree", new: "TWO\n3" }]);
    expect(r.status).toBe("written");
    expect(r.edits[0]).toMatchObject({
      status: "written",
      tier: "exact",
      occurrences: 1,
      line_ranges: [{ start: 2, end: 3 }],
    });
    expect(read(dir, "a.txt")).toBe("one\nTWO\n3\n");
  });

  it("trailing_whitespace tier when exact finds nothing; other lines keep their bytes", () => {
    const dir = repo({ "a.txt": "keep  \ntwo  \nthree\nkeep\t\n" });
    const r = run(dir, [{ file: "a.txt", old: "two\nthree", new: "2\n3" }]);
    expect(r.status).toBe("written");
    expect(r.edits[0].tier).toBe("trailing_whitespace");
    expect(r.edits[0].line_ranges).toEqual([{ start: 2, end: 3 }]);
    expect(read(dir, "a.txt")).toBe("keep  \n2\n3\nkeep\t\n");
    expect(r.warnings.join(" ")).toContain("fuzzy tier");
  });

  it("unicode tier for typographic quotes, dashes and special spaces", () => {
    const dir = repo({
      "a.txt": "a\nsay(“hi”) – x y\nz “q”\n",
    });
    const r = run(dir, [
      { file: "a.txt", old: 'say("hi") - x y', new: 'say("bye")' },
    ]);
    expect(r.status).toBe("written");
    expect(r.edits[0].tier).toBe("unicode");
    // Only the touched line is rewritten; line 3 keeps its smart quotes.
    expect(read(dir, "a.txt")).toBe('a\nsay("bye")\nz “q”\n');
  });

  it("unicode tier applies NFKC", () => {
    const dir = repo({ "a.txt": "ﬁle = 1\n" });
    const r = run(dir, [{ file: "a.txt", old: "file = 1", new: "file = 2" }]);
    expect(r.edits[0].tier).toBe("unicode");
    expect(read(dir, "a.txt")).toBe("file = 2\n");
  });

  it("an exact unique match is not refused because a fuzzy tier would see more", () => {
    // "foo\n" occurs once exactly (line 2); the trailing_whitespace view
    // would see it twice. Ambiguity is counted in the tier that matched.
    const dir = repo({ "a.txt": "foo  \nfoo\n" });
    const r = run(dir, [{ file: "a.txt", old: "foo\n", new: "bar\n" }]);
    expect(r.status).toBe("written");
    expect(r.edits[0]).toMatchObject({
      tier: "exact",
      line_ranges: [{ start: 2, end: 2 }],
    });
    expect(read(dir, "a.txt")).toBe("foo  \nbar\n");
  });
});

describe("patch: ambiguity", () => {
  it("refuses more than one exact match and lists the match lines", () => {
    const before = "x\nfoo\ny\nfoo\n";
    const dir = repo({ "a.txt": before });
    const r = run(dir, [{ file: "a.txt", old: "foo", new: "bar" }]);
    expect(r.status).toBe("ambiguous");
    expect(statusClass(r.status)).toBe("finding");
    expect(r.edits[0]).toMatchObject({
      status: "ambiguous",
      tier: "exact",
      occurrences: 2,
      match_lines: [2, 4],
    });
    expect(r.edits[0].detail).toContain("lines 2, 4");
    expect(read(dir, "a.txt")).toBe(before);
  });

  it("counts ambiguity in a fuzzy tier too", () => {
    const before = "a  \nb\na \nb\n";
    const dir = repo({ "a.txt": before });
    const r = run(dir, [{ file: "a.txt", old: "a\nb", new: "c" }]);
    expect(r.status).toBe("ambiguous");
    expect(r.edits[0]).toMatchObject({
      tier: "trailing_whitespace",
      match_lines: [1, 3],
    });
    expect(read(dir, "a.txt")).toBe(before);
  });

  it("replaceAll replaces every occurrence", () => {
    const dir = repo({ "a.txt": "foo\nfoo bar foo\n" });
    const r = run(dir, [
      { file: "a.txt", old: "foo", new: "baz", replaceAll: true },
    ]);
    expect(r.status).toBe("written");
    expect(r.edits[0].occurrences).toBe(3);
    expect(read(dir, "a.txt")).toBe("baz\nbaz bar baz\n");
  });
});

describe("patch: several edits of one file", () => {
  it("are all matched against the original content, not the evolving one", () => {
    const dir = repo({ "a.txt": "x\ny\n" });
    const r = run(dir, [
      { file: "a.txt", old: "x", new: "y" },
      { file: "a.txt", old: "y", new: "z" },
    ]);
    expect(r.status).toBe("written");
    expect(read(dir, "a.txt")).toBe("y\nz\n");
  });

  it("refuses overlapping edits and writes nothing", () => {
    const dir = repo({ "a.txt": "abcd\n" });
    const r = run(dir, [
      { file: "a.txt", old: "abc", new: "1" },
      { file: "a.txt", old: "bcd", new: "2" },
    ]);
    expect(r.status).toBe("overlap");
    expect(r.edits.map((e) => e.status)).toEqual(["overlap", "overlap"]);
    expect(r.edits[0].overlaps_with).toEqual([1]);
    expect(r.edits[1].overlaps_with).toEqual([0]);
    expect(read(dir, "a.txt")).toBe("abcd\n");
  });

  it("refuses an exact edit on a line a fuzzy-tier edit rewrites", () => {
    const dir = repo({ "a.txt": "left  right  \n" });
    const r = run(dir, [
      { file: "a.txt", old: "left", new: "L" },
      { file: "a.txt", old: "right\n", new: "R\n" },
    ]);
    expect(r.edits[1].tier).toBe("trailing_whitespace");
    expect(r.status).toBe("overlap");
    expect(read(dir, "a.txt")).toBe("left  right  \n");
  });
});

describe("patch: bytes kept", () => {
  it("keeps CRLF and writes inserted line breaks as CRLF", () => {
    const dir = repo({ "a.txt": "one\r\ntwo\r\nthree\r\n" });
    const r = run(dir, [
      { file: "a.txt", old: "two\nthree", new: "2a\n2b\nthree" },
    ]);
    expect(r.status).toBe("written");
    expect(r.files[0].line_ending).toBe("crlf");
    expect(read(dir, "a.txt")).toBe("one\r\n2a\r\n2b\r\nthree\r\n");
  });

  it("accepts CRLF in the old text of a CRLF file", () => {
    const dir = repo({ "a.txt": "one\r\ntwo\r\n" });
    const r = run(dir, [{ file: "a.txt", old: "one\r\ntwo", new: "x" }]);
    expect(r.status).toBe("written");
    expect(read(dir, "a.txt")).toBe("x\r\n");
  });

  it("keeps LF in an LF file even when the new text carries CRLF", () => {
    const dir = repo({ "a.txt": "one\ntwo\n" });
    run(dir, [{ file: "a.txt", old: "one", new: "a\r\nb" }]);
    expect(read(dir, "a.txt")).toBe("a\nb\ntwo\n");
  });

  it("keeps the endings of untouched lines in a mixed-ending file", () => {
    const dir = repo({ "a.txt": "a\r\nb\nc\r\n" });
    run(dir, [{ file: "a.txt", old: "c", new: "C" }]);
    expect(read(dir, "a.txt")).toBe("a\r\nb\nC\r\n");
  });

  it("keeps CRLF on a fuzzy-tier line rewrite", () => {
    const dir = repo({ "a.txt": "one  \r\ntwo\r\n" });
    const r = run(dir, [{ file: "a.txt", old: "one\ntwo", new: "1\n2" }]);
    expect(r.edits[0].tier).toBe("trailing_whitespace");
    expect(read(dir, "a.txt")).toBe("1\r\n2\r\n");
  });

  it("keeps a byte-order mark", () => {
    const dir = repo({ "a.txt": "﻿hello\n" });
    const r = run(dir, [{ file: "a.txt", old: "hello", new: "bye" }]);
    expect(r.files[0].bom).toBe(true);
    expect(readBuf(dir, "a.txt")).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("bye\n")]),
    );
  });

  it("keeps a missing trailing newline", () => {
    const dir = repo({ "a.txt": "a\nb" });
    run(dir, [{ file: "a.txt", old: "b", new: "c" }]);
    expect(read(dir, "a.txt")).toBe("a\nc");
  });

  it("keeps the file mode", () => {
    const dir = repo({ "x.sh": "echo a\n", "y.txt": "secret\n" });
    fs.chmodSync(path.join(dir, "x.sh"), 0o755);
    fs.chmodSync(path.join(dir, "y.txt"), 0o600);
    const r = run(dir, [
      { file: "x.sh", old: "a", new: "b" },
      { file: "y.txt", old: "secret", new: "s" },
    ]);
    expect(r.status).toBe("written");
    expect(fs.statSync(path.join(dir, "x.sh")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(dir, "y.txt")).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary or backup file behind", () => {
    const dir = repo({ "a.txt": "a\n", "sub/b.txt": "b\n" });
    run(dir, [
      { file: "a.txt", old: "a", new: "A" },
      { file: "sub/b.txt", old: "b", new: "B" },
    ]);
    expect(listTree(dir)).toEqual(["a.txt", "sub", "sub/b.txt"]);
  });

  it("refuses a binary file and a non-UTF-8 file with a reason", () => {
    const dir = repo({
      "bin.dat": Buffer.from([0x61, 0x00, 0x62]),
      "latin1.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    });
    const bin = run(dir, [{ file: "bin.dat", old: "a", new: "b" }]);
    expect(bin.status).toBe("error");
    expect(bin.reason).toBe("binary");
    expect(bin.message).toContain("bin.dat");
    const latin = run(dir, [{ file: "latin1.txt", old: "caf", new: "x" }]);
    expect(latin.status).toBe("error");
    expect(latin.reason).toBe("not_utf8");
    expect(readBuf(dir, "latin1.txt")).toEqual(
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    );
  });
});

describe("patch: all or nothing", () => {
  it("a missing edit in file 2 leaves file 1 untouched", () => {
    const dir = repo({ "one.txt": "alpha\n", "two.txt": "beta\n" });
    const r = run(dir, [
      { file: "one.txt", old: "alpha", new: "ALPHA" },
      { file: "two.txt", old: "gamma", new: "GAMMA" },
    ]);
    expect(r.status).toBe("missing");
    expect(r.message).toBe("plan refused: nothing was written");
    expect(r.edits.map((e) => e.status)).toEqual(["not_written", "missing"]);
    expect(r.writtenFiles).toEqual([]);
    expect(read(dir, "one.txt")).toBe("alpha\n");
    expect(read(dir, "two.txt")).toBe("beta\n");
  });

  it("an ambiguous edit in file 2 leaves file 1 untouched", () => {
    const dir = repo({ "one.txt": "alpha\n", "two.txt": "b\nb\n" });
    const r = run(dir, [
      { file: "one.txt", old: "alpha", new: "ALPHA" },
      { file: "two.txt", old: "b", new: "c" },
    ]);
    expect(r.status).toBe("ambiguous");
    expect(read(dir, "one.txt")).toBe("alpha\n");
  });

  it("an unreadable file 2 leaves file 1 untouched", () => {
    const dir = repo({ "one.txt": "alpha\n" });
    const r = run(dir, [
      { file: "one.txt", old: "alpha", new: "ALPHA" },
      { file: "nope.txt", old: "x", new: "y" },
    ]);
    expect(r.status).toBe("error");
    expect(r.reason).toBe("not_found");
    expect(read(dir, "one.txt")).toBe("alpha\n");
  });

  it("a write error stops the write phase and names the files already written", () => {
    const dir = repo({
      "one.txt": "1\n",
      "two.txt": "2\n",
      "three.txt": "3\n",
    });
    let calls = 0;
    const r = patch({
      cwd: dir,
      edits: [
        { file: "one.txt", old: "1", new: "one" },
        { file: "two.txt", old: "2", new: "two" },
        { file: "three.txt", old: "3", new: "three" },
      ],
      renameFile: (from, to) => {
        calls += 1;
        if (calls === 2) throw new Error("simulated rename failure");
        fs.renameSync(from, to);
      },
    });
    expect(r.status).toBe("error");
    expect(statusClass(r.status)).toBe("cannot-conclude");
    expect(r.reason).toBe("write_failed");
    expect(r.writtenFiles).toEqual(["one.txt"]);
    expect(r.message).toContain("already written: one.txt");
    expect(r.edits.map((e) => e.status)).toEqual([
      "written",
      "error",
      "not_written",
    ]);
    expect(read(dir, "one.txt")).toBe("one\n");
    expect(read(dir, "two.txt")).toBe("2\n");
    expect(read(dir, "three.txt")).toBe("3\n");
    expect(listTree(dir)).toEqual(["one.txt", "three.txt", "two.txt"]);
  });

  it("does not overwrite a file that changed after it was read", () => {
    const dir = repo({ "one.txt": "1\n", "two.txt": "2\n" });
    const r = patch({
      cwd: dir,
      edits: [
        { file: "one.txt", old: "1", new: "one" },
        { file: "two.txt", old: "2", new: "two" },
      ],
      renameFile: (from, to) => {
        fs.renameSync(from, to);
        fs.writeFileSync(path.join(dir, "two.txt"), "2 changed\n");
      },
    });
    expect(r.status).toBe("error");
    expect(r.files[1].reason).toBe("changed_since_read");
    expect(r.writtenFiles).toEqual(["one.txt"]);
    expect(read(dir, "two.txt")).toBe("2 changed\n");
  });
});

describe("patch: dry run and unchanged", () => {
  it("--dry-run writes nothing and returns the same envelope with a diff", () => {
    const dir = repo({ "a.txt": "one\ntwo\n", "b.txt": "x\n" });
    const before = listTree(dir).map((p) => [
      p,
      fs.statSync(path.join(dir, p)).mtimeMs,
    ]);
    const r = run(
      dir,
      [
        { file: "a.txt", old: "two", new: "2" },
        { file: "b.txt", old: "x", new: "y" },
      ],
      { dryRun: true },
    );
    expect(r.status).toBe("would_write");
    expect(statusClass(r.status)).toBe("ok");
    expect(r.dryRun).toBe(true);
    expect(r.edits.map((e) => e.status)).toEqual([
      "would_write",
      "would_write",
    ]);
    expect(r.writtenFiles).toEqual([]);
    expect(r.files[0].diff).toBe(
      "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n",
    );
    expect(read(dir, "a.txt")).toBe("one\ntwo\n");
    expect(read(dir, "b.txt")).toBe("x\n");
    expect(
      listTree(dir).map((p) => [p, fs.statSync(path.join(dir, p)).mtimeMs]),
    ).toEqual(before);
  });

  it("a refused dry run reports the finding the same way", () => {
    const dir = repo({ "a.txt": "a\n" });
    const r = run(dir, [{ file: "a.txt", old: "zzz", new: "y" }], {
      dryRun: true,
    });
    expect(r.status).toBe("missing");
  });

  it("unchanged when the plan yields identical content; the file is not rewritten", () => {
    const dir = repo({ "a.txt": "same\n" });
    const ino = fs.statSync(path.join(dir, "a.txt")).ino;
    const r = run(dir, [{ file: "a.txt", old: "same", new: "same" }]);
    expect(r.status).toBe("unchanged");
    expect(statusClass(r.status)).toBe("ok");
    expect(r.edits[0].status).toBe("unchanged");
    expect(r.files[0].status).toBe("unchanged");
    expect(r.writtenFiles).toEqual([]);
    expect(fs.statSync(path.join(dir, "a.txt")).ino).toBe(ino);
  });

  it("the diff preview applies with git apply to the same result as the write", () => {
    const content = Array.from(
      { length: 30 },
      (_, i) => `line ${String(i)}\n`,
    ).join("");
    const dir = repo({ "a.txt": content, "b.txt": content });
    const edits = (f: string): PatchEditSpec[] => [
      { file: f, old: "line 2\n", new: "two\nlines\n" },
      { file: f, old: "line 5\n", new: "" },
      { file: f, old: "line 20\nline 21", new: "twenty" },
      { file: f, old: "line 29\n", new: "end" },
    ];
    const dry = run(dir, edits("a.txt"), { dryRun: true });
    expect(dry.status).toBe("would_write");
    fs.writeFileSync(path.join(dir, "a.diff"), dry.files[0].diff ?? "");
    execFileSync("git", ["apply", "a.diff"], { cwd: dir });
    const real = run(dir, edits("b.txt"));
    expect(real.status).toBe("written");
    expect(read(dir, "a.txt")).toBe(read(dir, "b.txt"));
  });
});

describe("patch: paths", () => {
  it("refuses a path outside the root unless allowOutside", () => {
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, "o.txt"), "out\n");
    const dir = repo({ "a.txt": "a\n" });
    const rel = path.relative(dir, path.join(outside, "o.txt"));
    const r = run(dir, [
      { file: "a.txt", old: "a", new: "A" },
      { file: rel, old: "out", new: "OUT" },
    ]);
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("outside_root");
    expect(r.edits[1].status).toBe("refused");
    expect(read(dir, "a.txt")).toBe("a\n");
    expect(fs.readFileSync(path.join(outside, "o.txt"), "utf8")).toBe("out\n");

    const ok = run(dir, [{ file: rel, old: "out", new: "OUT" }], {
      allowOutside: true,
    });
    expect(ok.status).toBe("written");
    expect(fs.readFileSync(path.join(outside, "o.txt"), "utf8")).toBe("OUT\n");
  });

  it("the root is the git work tree of the cwd, so a sibling directory is inside", () => {
    const dir = repo({ "pkg/x.txt": "x\n", "docs/d.txt": "d\n" });
    const r = run(path.join(dir, "pkg"), [
      { file: "../docs/d.txt", old: "d", new: "D" },
    ]);
    expect(r.status).toBe("written");
    expect(r.edits[0].path).toBe(path.join("docs", "d.txt"));
  });

  it("refuses anything inside .git, even with allowOutside", () => {
    const dir = repo({});
    const config = read(dir, ".git/config");
    for (const allowOutside of [false, true]) {
      const r = run(dir, [{ file: ".git/config", old: "[core]", new: "[x]" }], {
        allowOutside,
      });
      expect(r.status).toBe("usage_error");
      expect(r.reason).toBe("git_dir");
    }
    expect(read(dir, ".git/config")).toBe(config);
  });

  it("follows a symlink inside the root and edits its target, keeping the link", () => {
    const dir = repo({ "real.txt": "r\n" });
    fs.symlinkSync("real.txt", path.join(dir, "link.txt"));
    const r = run(dir, [{ file: "link.txt", old: "r", new: "R" }]);
    expect(r.status).toBe("written");
    expect(r.edits[0].path).toBe("real.txt");
    expect(fs.lstatSync(path.join(dir, "link.txt")).isSymbolicLink()).toBe(
      true,
    );
    expect(read(dir, "real.txt")).toBe("R\n");
  });

  it("refuses a symlink whose target resolves outside the root", () => {
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, "o.txt"), "o\n");
    const dir = repo({});
    fs.symlinkSync(path.join(outside, "o.txt"), path.join(dir, "link.txt"));
    const r = run(dir, [{ file: "link.txt", old: "o", new: "O" }]);
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("outside_root");
    expect(fs.readFileSync(path.join(outside, "o.txt"), "utf8")).toBe("o\n");
  });

  it("refuses a symlink into .git", () => {
    const dir = repo({});
    fs.symlinkSync(".git/config", path.join(dir, "cfg"));
    const r = run(dir, [{ file: "cfg", old: "[core]", new: "[x]" }]);
    expect(r.reason).toBe("git_dir");
  });

  it("groups edits naming one file by two spellings", () => {
    const dir = repo({ "a.txt": "a b\n" });
    const r = run(dir, [
      { file: "a.txt", old: "a", new: "1" },
      { file: "./a.txt", old: "b", new: "2" },
    ]);
    expect(r.files).toHaveLength(1);
    expect(read(dir, "a.txt")).toBe("1 2\n");
  });
});

describe("patch: input validation", () => {
  it("rejects an empty old text", () => {
    const dir = repo({ "a.txt": "a\n" });
    expect(() => run(dir, [{ file: "a.txt", old: "", new: "x" }])).toThrow(
      PatchUsageError,
    );
    try {
      run(dir, [{ file: "a.txt", old: "", new: "x" }]);
    } catch (err) {
      expect((err as PatchUsageError).reason).toBe("empty_old");
    }
    expect(read(dir, "a.txt")).toBe("a\n");
  });

  it("parsePatchPlan refuses unknown keys, wrong types and an empty list", () => {
    const bad = [
      "not json",
      "[]",
      '{"edits":[]}',
      '{"edits":[{"file":"a","old":"x","new":"y"}],"extra":1}',
      '{"edits":[{"file":"a","oldText":"x","new":"y"}]}',
      '{"edits":[{"file":"a","old":1,"new":"y"}]}',
      '{"edits":[{"file":"a","old":"x","new":"y","replaceAll":"yes"}]}',
      '{"edits":[{"file":"","old":"x","new":"y"}]}',
    ];
    for (const text of bad) {
      expect(() => parsePatchPlan(text), text).toThrow(PatchUsageError);
    }
    expect(
      parsePatchPlan(
        '{"edits":[{"file":"a","old":"x","new":"","replaceAll":true}]}',
      ),
    ).toEqual([{ file: "a", old: "x", new: "", replaceAll: true }]);
  });
});

describe("patch: hints", () => {
  it("names the closest candidate with visualised whitespace", () => {
    const dir = repo({
      "a.ts": "function f() {\n\treturn 1;\n}\n",
    });
    const r = run(dir, [
      { file: "a.ts", old: "function f() {\n  return 1;\n}", new: "x" },
    ]);
    expect(r.status).toBe("missing");
    const hint = r.edits[0].hint;
    expect(hint?.candidates[0]).toMatchObject({
      line_start: 1,
      line_end: 3,
      whitespace_only: true,
      differences: [{ line: 2, expected: "··return·1;", actual: "→return·1;" }],
    });
    expect(hint?.message).toContain("closest candidate: lines 1-3");
  });

  it("says when the new text is already in the file", () => {
    const h = notFoundHint("a\nalready done\n", "not here", "already done");
    expect(h.new_text_at_line).toBe(2);
    expect(h.message).toContain("already in the file at line 2");
  });

  it("finds no candidate in unrelated content", () => {
    const h = notFoundHint("zzz\nqqq\n", "completely different", "x");
    expect(h.candidates).toEqual([]);
    expect(h.message).toContain("no similar lines found");
  });

  it("visualises other whitespace as code points", () => {
    expect(visualizeWhitespace("a b​c")).toBe("a⟨U+00A0⟩b⟨U+200B⟩c");
  });
});

describe("patch engine", () => {
  it("applyReplacementsPreservingUnchangedLines keeps untouched lines byte for byte", () => {
    const original = "a  \nb  \nc  \n";
    const base = "a\nb\nc\n";
    expect(
      applyReplacementsPreservingUnchangedLines(original, base, [
        { matchIndex: 2, matchLength: 1, newText: "B" },
      ]),
    ).toBe("a  \nB\nc  \n");
  });

  it("resolveFileEdits reports missing without regions", () => {
    const r = resolveFileEdits("abc\n", [
      { index: 0, old: "zz", new: "y", replaceAll: false },
    ]);
    expect(r.edits[0].status).toBe("missing");
    expect(r.newContent).toBeUndefined();
  });
});

describe("patch CLI", () => {
  it("one-shot form writes and exits 0", async () => {
    const dir = repo({ "a.txt": "hello\n" });
    const res = await spawnCli([
      "-C",
      dir,
      "patch",
      "--file",
      "a.txt",
      "--old",
      "hello",
      "--new",
      "bye",
    ]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as { command: string; status: string };
    expect(out).toMatchObject({ command: "patch", status: "written" });
    expect(read(dir, "a.txt")).toBe("bye\n");
  });

  it("--old-file and --new-file read the texts verbatim", async () => {
    const dir = repo({ "a.txt": "x\n  'q' \"r\" $y\nz\n" });
    const scratch = tmpDir();
    fs.writeFileSync(path.join(scratch, "old"), "  'q' \"r\" $y\n");
    fs.writeFileSync(path.join(scratch, "new"), "`done`\n");
    const res = await spawnCli([
      "-C",
      dir,
      "patch",
      "--file",
      "a.txt",
      "--old-file",
      path.join(scratch, "old"),
      "--new-file",
      path.join(scratch, "new"),
    ]);
    expect(res.code).toBe(0);
    expect(read(dir, "a.txt")).toBe("x\n`done`\nz\n");
  });

  it("--plan applies a multi-file plan; a finding exits 1 and writes nothing", async () => {
    const dir = repo({ "a.txt": "a\n", "b.txt": "b\n" });
    const scratch = tmpDir();
    const plan = path.join(scratch, "plan.json");
    fs.writeFileSync(
      plan,
      JSON.stringify({
        edits: [
          { file: "a.txt", old: "a", new: "A" },
          { file: "b.txt", old: "nope", new: "B" },
        ],
      }),
    );
    const bad = await spawnCli(["-C", dir, "patch", "--plan", plan]);
    expect(bad.code).toBe(1);
    expect((JSON.parse(bad.stdout) as { status: string }).status).toBe(
      "missing",
    );
    expect(read(dir, "a.txt")).toBe("a\n");

    fs.writeFileSync(
      plan,
      JSON.stringify({
        edits: [
          { file: "a.txt", old: "a", new: "A" },
          { file: "b.txt", old: "b", new: "B" },
        ],
      }),
    );
    const good = await spawnCli(["-C", dir, "patch", "--plan", plan]);
    expect(good.code).toBe(0);
    expect(read(dir, "a.txt") + read(dir, "b.txt")).toBe("A\nB\n");
  });

  it("--plan - reads the plan from stdin", () => {
    const dir = repo({ "a.txt": "a\n" });
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, "-C", dir, "patch", "--plan", "-"],
      {
        input: JSON.stringify({
          edits: [{ file: "a.txt", old: "a", new: "b" }],
        }),
        env: buildSpawnEnv(),
        encoding: "utf8",
      },
    );
    expect(res.status).toBe(0);
    expect(read(dir, "a.txt")).toBe("b\n");
  });

  it("refuses mixing --plan with the one-shot flags, and an empty --old (exit 2)", async () => {
    const dir = repo({ "a.txt": "a\n" });
    const mixed = await spawnCli([
      "-C",
      dir,
      "patch",
      "--plan",
      "p.json",
      "--file",
      "a.txt",
    ]);
    expect(mixed.code).toBe(2);
    expect(JSON.parse(mixed.stdout)).toMatchObject({
      command: "patch",
      status: "usage_error",
      reason: "option_conflict",
    });
    const empty = await spawnCli([
      "-C",
      dir,
      "patch",
      "--file",
      "a.txt",
      "--old",
      "",
      "--new",
      "x",
    ]);
    expect(empty.code).toBe(2);
    expect(JSON.parse(empty.stdout)).toMatchObject({ reason: "empty_old" });
    const both = await spawnCli([
      "-C",
      dir,
      "patch",
      "--file",
      "a.txt",
      "--old",
      "a",
      "--old-file",
      "x",
      "--new",
      "b",
    ]);
    expect(both.code).toBe(2);
  });

  it("refuses a path outside the root with exit 2", async () => {
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, "o.txt"), "o\n");
    const dir = repo({});
    const res = await spawnCli([
      "-C",
      dir,
      "patch",
      "--file",
      path.join(outside, "o.txt"),
      "--old",
      "o",
      "--new",
      "O",
    ]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout)).toMatchObject({
      status: "usage_error",
      reason: "outside_root",
    });
    expect(fs.readFileSync(path.join(outside, "o.txt"), "utf8")).toBe("o\n");
  });

  it("text mode renders statuses, hints and the diff", async () => {
    const dir = repo({ "a.txt": "one\ntwo\n" });
    const dry = await spawnCli([
      "-C",
      dir,
      "-f",
      "text",
      "patch",
      "--file",
      "a.txt",
      "--old",
      "two",
      "--new",
      "2",
      "--dry-run",
    ]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("status: would_write (dry run)");
    expect(dry.stdout).toContain(
      "edits[0] a.txt: would_write (exact, lines 2)",
    );
    expect(dry.stdout).toContain("-two\n+2");
    expect(read(dir, "a.txt")).toBe("one\ntwo\n");

    const miss = await spawnCli([
      "-C",
      dir,
      "-f",
      "text",
      "patch",
      "--file",
      "a.txt",
      "--old",
      "  two",
      "--new",
      "2",
    ]);
    expect(miss.code).toBe(1);
    expect(miss.stdout).toContain("edits[0] a.txt: missing");
    expect(miss.stdout).toContain("expected: ··two");
  });
});

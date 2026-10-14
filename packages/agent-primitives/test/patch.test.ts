import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
      "a.txt": "a\nsay(“hi”) – x\u00A0y\nz “q”\n",
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
    const dir = repo({ "a.txt": "\uFEFFhello\n" });
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

  it("does not say the edit was applied for a short new text", () => {
    const h = notFoundHint("let x = 1;\nfoo(x);\n", "not here", "x");
    expect(h.new_text_at_line).toBeUndefined();
    expect(h.message).not.toContain("already in the file");
  });

  it("does not say the edit was applied when new is part of old", () => {
    const h = notFoundHint(
      "return value + 1;\n",
      "return value + 1; // gone",
      "return value + 1;",
    );
    expect(h.new_text_at_line).toBeUndefined();
    expect(h.message).not.toContain("already in the file");
  });

  it("needs eight non-whitespace characters in the new text", () => {
    const content = "a\nab cd efg\nab cd efgh\n";
    expect(
      notFoundHint(content, "not here", "ab cd efg").new_text_at_line,
    ).toBeUndefined();
    expect(
      notFoundHint(content, "not here", "ab cd efgh").new_text_at_line,
    ).toBe(3);
  });

  it("still names the line of a distinctive multi-line new text", () => {
    const content = "start\nconst total = sum(items);\nreturn total;\nend\n";
    const h = notFoundHint(
      content,
      "const total = 0;",
      "const total = sum(items);\nreturn total;",
    );
    expect(h.new_text_at_line).toBe(2);
    expect(h.message).toContain("already in the file at line 2");
  });

  it("finds no candidate in unrelated content", () => {
    const h = notFoundHint("zzz\nqqq\n", "completely different", "x");
    expect(h.candidates).toEqual([]);
    expect(h.message).toContain("no similar lines found");
  });

  it("visualises other whitespace as code points", () => {
    expect(visualizeWhitespace("a\u00A0b\u200Bc")).toBe("a⟨U+00A0⟩b⟨U+200B⟩c");
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

/** True when the filesystem under `dir` treats `A` and `a` as one name. */
function caseInsensitive(dir: string): boolean {
  const probe = path.join(dir, "CaseProbe.tmp");
  fs.writeFileSync(probe, "");
  try {
    return fs.existsSync(path.join(dir, "caseprobe.tmp"));
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

describe("patch: git directories in any spelling", () => {
  const ci = caseInsensitive(os.tmpdir());

  it.skipIf(!ci)(
    "refuses .GIT/config and .Git/config on a case-insensitive filesystem",
    () => {
      const dir = repo({});
      const config = read(dir, ".git/config");
      for (const file of [".GIT/config", ".Git/config", "./.gIt/config"]) {
        const r = run(dir, [{ file, old: "[core]", new: "[x]" }]);
        expect(r.status, file).toBe("usage_error");
        expect(r.reason, file).toBe("git_dir");
      }
      expect(read(dir, ".git/config")).toBe(config);
    },
  );

  it.skipIf(!ci)("refuses a symlink to .GIT/config", () => {
    const dir = repo({});
    const config = read(dir, ".git/config");
    fs.symlinkSync(".GIT/config", path.join(dir, "cfg"));
    const r = run(dir, [{ file: "cfg", old: "[core]", new: "[x]" }]);
    expect(r.reason).toBe("git_dir");
    expect(read(dir, ".git/config")).toBe(config);
  });

  it.skipIf(!ci)("refuses -C <repo>/.GIT --file config", async () => {
    const dir = repo({});
    const config = read(dir, ".git/config");
    const res = await spawnCli([
      "-C",
      path.join(dir, ".GIT"),
      "patch",
      "--file",
      "config",
      "--old",
      "[core]",
      "--new",
      "[x]",
    ]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout)).toMatchObject({
      command: "patch",
      status: "usage_error",
      reason: "git_dir",
    });
    expect(read(dir, ".git/config")).toBe(config);
  });

  it.skipIf(!ci)("refuses the .GIT file of a linked worktree", () => {
    const main = repo({ "a.txt": "a\n" });
    execFileSync("git", ["add", "a.txt"], { cwd: main, env: gitEnv });
    execFileSync("git", ["commit", "-q", "-m", "init"], {
      cwd: main,
      env: gitEnv,
    });
    const wt = path.join(tmpDir(), "wt");
    execFileSync("git", ["worktree", "add", "-q", wt], {
      cwd: main,
      env: gitEnv,
    });
    const pointer = read(wt, ".git");
    const r = run(wt, [{ file: ".GIT", old: "gitdir", new: "x" }]);
    expect(r.reason).toBe("git_dir");
    expect(read(wt, ".git")).toBe(pointer);
  });

  it.skipIf(!ci)("refuses ../other/.GIT/config even with allowOutside", () => {
    const other = repo({});
    const config = read(other, ".git/config");
    const dir = repo({});
    const rel = path.join(path.relative(dir, other), ".GIT", "config");
    const r = run(dir, [{ file: rel, old: "[core]", new: "[x]" }], {
      allowOutside: true,
    });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("git_dir");
    expect(read(other, ".git/config")).toBe(config);
  });

  it("refuses a git directory with another name by its identity", () => {
    const dir = tmpDir();
    execFileSync("git", ["init", "-q", "--separate-git-dir", "gd", "."], {
      cwd: dir,
    });
    const config = read(dir, "gd/config");
    const r = run(dir, [{ file: "gd/config", old: "[core]", new: "[x]" }]);
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("git_dir");
    expect(read(dir, "gd/config")).toBe(config);
  });

  it.skipIf(!ci)(
    "refuses .GIT/<symlink to a work-tree file> by its spelling in any case",
    () => {
      const dir = repo({ "a.txt": "a\n" });
      fs.symlinkSync("../a.txt", path.join(dir, ".git", "lnk"));
      const r = run(dir, [{ file: ".GIT/lnk", old: "a", new: "b" }]);
      expect(r.reason).toBe("git_dir");
      expect(read(dir, "a.txt")).toBe("a\n");
    },
  );

  it("refuses .git/<symlink to a work-tree file> by its spelling", () => {
    const dir = repo({ "a.txt": "a\n" });
    fs.symlinkSync("../a.txt", path.join(dir, ".git", "lnk"));
    const r = run(dir, [{ file: ".git/lnk", old: "a", new: "b" }]);
    expect(r.reason).toBe("git_dir");
    expect(read(dir, "a.txt")).toBe("a\n");
  });
});

describe("patch: one file, every spelling", () => {
  const ci = caseInsensitive(os.tmpdir());

  it.skipIf(!ci)(
    "groups a letter-case variant: overlap is detected and one write applies both",
    () => {
      const dir = repo({ "a.txt": "alpha\nbeta\n" });
      const clash = run(dir, [
        { file: "a.txt", old: "alpha", new: "X" },
        { file: "A.txt", old: "alpha", new: "Y" },
      ]);
      expect(clash.status).toBe("overlap");
      expect(clash.files).toHaveLength(1);
      expect(read(dir, "a.txt")).toBe("alpha\nbeta\n");

      const r = run(dir, [
        { file: "a.txt", old: "alpha", new: "X" },
        { file: "A.txt", old: "beta", new: "Y" },
      ]);
      expect(r.status).toBe("written");
      expect(r.writtenFiles).toEqual(["a.txt"]);
      expect(read(dir, "a.txt")).toBe("X\nY\n");
    },
  );

  it("groups an NFD and an NFC spelling of one name", () => {
    const nfc = "café.txt";
    const nfd = "cafe\u0301.txt";
    const dir = repo({ [nfc]: "one two\n" });
    if (!fs.existsSync(path.join(dir, nfd))) return; // normalisation-sensitive FS
    const r = run(dir, [
      { file: nfc, old: "one", new: "1" },
      { file: nfd, old: "two", new: "2" },
    ]);
    expect(r.status).toBe("written");
    expect(r.files).toHaveLength(1);
    expect(read(dir, nfc)).toBe("1 2\n");
  });

  it("groups a symlink and its target: one write applies both edits", () => {
    const dir = repo({ "real.txt": "a b\n" });
    fs.symlinkSync("real.txt", path.join(dir, "link.txt"));
    const r = run(dir, [
      { file: "link.txt", old: "a", new: "1" },
      { file: "real.txt", old: "b", new: "2" },
    ]);
    expect(r.status).toBe("written");
    expect(r.files).toHaveLength(1);
    expect(r.writtenFiles).toEqual(["real.txt"]);
    expect(read(dir, "real.txt")).toBe("1 2\n");
    expect(fs.lstatSync(path.join(dir, "link.txt")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("refuses a hard-linked file by default and names the reason", () => {
    const dir = repo({ "a.txt": "a\n" });
    fs.linkSync(path.join(dir, "a.txt"), path.join(dir, "b.txt"));
    const r = run(dir, [{ file: "a.txt", old: "a", new: "A" }]);
    expect(r.status).toBe("not_editable");
    expect(statusClass(r.status)).toBe("finding");
    expect(r.reason).toBe("hard_link");
    expect(r.edits[0]).toMatchObject({
      status: "not_editable",
      reason: "hard_link",
    });
    expect(read(dir, "a.txt")).toBe("a\n");
  });

  it("with breakHardLinks groups both names into one write", () => {
    const dir = repo({ "a.txt": "a b\n" });
    fs.linkSync(path.join(dir, "a.txt"), path.join(dir, "b.txt"));
    const r = run(
      dir,
      [
        { file: "a.txt", old: "a", new: "1" },
        { file: "b.txt", old: "b", new: "2" },
      ],
      { breakHardLinks: true },
    );
    expect(r.status).toBe("written");
    expect(r.files).toHaveLength(1);
    expect(r.writtenFiles).toEqual(["a.txt"]);
    expect(read(dir, "a.txt")).toBe("1 2\n");
    // The rename gave a.txt a new inode; the other name keeps the old text.
    expect(read(dir, "b.txt")).toBe("a b\n");
  });
});

describe("patch: fuzzy matches change nothing outside the match", () => {
  it("refuses a unicode match whose line would lose typographic quotes elsewhere", () => {
    const before = 'const q = "said “hi”"; run(‘1’);\n';
    const dir = repo({ "a.js": before });
    const r = run(dir, [{ file: "a.js", old: "run('1')", new: "run('2')" }]);
    expect(r.status).toBe("fuzzy_side_effect");
    expect(statusClass(r.status)).toBe("finding");
    expect(r.edits[0]).toMatchObject({
      status: "fuzzy_side_effect",
      tier: "unicode",
    });
    const hint = r.edits[0].side_effect;
    expect(hint?.changed_characters).toEqual(
      expect.arrayContaining(['“ (U+201C) -> "', '” (U+201D) -> "']),
    );
    expect(hint?.exact_text).toBe("run(‘1’)");
    expect(hint?.lines[0].line).toBe(1);
    expect(read(dir, "a.js")).toBe(before);
  });

  it("refuses when NFKC would change a superscript or fullwidth text outside the match", () => {
    for (const before of ["y = x² + run(‘1’);\n", "ＡＢ = run(‘1’);\n"]) {
      const dir = repo({ "a.js": before });
      const r = run(dir, [{ file: "a.js", old: "run('1')", new: "run('2')" }]);
      expect(r.status, before).toBe("fuzzy_side_effect");
      expect(read(dir, "a.js")).toBe(before);
    }
  });

  it("applies a fuzzy match whose lines have nothing else to normalize, keeping the rest", () => {
    const dir = repo({
      "a.js": "foo(‘a’) + bar\n",
      "b.txt": "a – b  \nc\n",
    });
    const r = run(dir, [
      { file: "a.js", old: "foo('a')", new: "X" },
      { file: "b.txt", old: "a - b", new: "Y" },
    ]);
    expect(r.status).toBe("written");
    expect(r.edits.map((e) => e.tier)).toEqual(["unicode", "unicode"]);
    expect(read(dir, "a.js")).toBe("X + bar\n");
    // The trailing whitespace after the match is outside it: kept.
    expect(read(dir, "b.txt")).toBe("Y  \nc\n");
  });

  it("keeps the line endings of a fuzzy match's lines in a mixed-ending file", () => {
    const dir = repo({ "a.txt": "x\r\none  \ntwo\r\n" });
    const r = run(dir, [{ file: "a.txt", old: "one\ntwo", new: "1\n2" }]);
    expect(r.edits[0].tier).toBe("trailing_whitespace");
    expect(read(dir, "a.txt")).toBe("x\r\n1\r\n2\r\n");
  });

  it("refuses two overlapping edits matched in the same fuzzy tier as overlap", () => {
    const dir = repo({ "a.txt": "ab  \ncd\n" });
    const r = run(dir, [
      { file: "a.txt", old: "ab\nc", new: "1" },
      { file: "a.txt", old: "b\ncd", new: "2" },
    ]);
    expect(r.edits.map((e) => e.tier)).toEqual([
      "trailing_whitespace",
      "trailing_whitespace",
    ]);
    expect(r.status).toBe("overlap");
    expect(r.edits[0].overlaps_with).toEqual([1]);
    expect(read(dir, "a.txt")).toBe("ab  \ncd\n");
  });

  it("does not match mid-line when old's last line ends in whitespace", () => {
    const dir = repo({ "a.txt": "let v = computeTotal(x);\n" });
    const r = run(dir, [{ file: "a.txt", old: "computeTotal ", new: "sum " }]);
    expect(r.status).toBe("missing");
    expect(read(dir, "a.txt")).toBe("let v = computeTotal(x);\n");

    const end = repo({ "a.txt": "let x = 1;\t\nz\n" });
    const ok = run(end, [
      { file: "a.txt", old: "let x = 1; ", new: "let x = 2;" },
    ]);
    expect(ok.status).toBe("written");
    expect(ok.edits[0].tier).toBe("trailing_whitespace");
    expect(read(end, "a.txt")).toBe("let x = 2;\nz\n");
  });

  it("matches in a file whose last line is whitespace only without a newline", () => {
    const dir = repo({ "a.txt": "x  \n   " });
    const r = run(dir, [{ file: "a.txt", old: "x\n", new: "X\n" }]);
    expect(r.status).toBe("written");
    expect(r.edits[0].tier).toBe("trailing_whitespace");
    expect(read(dir, "a.txt")).toBe("X\n   ");
  });

  // Two unicode-tier matches on one line whose normalized gap ("-") also
  // occurs inside the first match's original text.
  const gapInsideMatch = [
    { file: "a.txt", old: "a-b x", new: "X" },
    { file: "a.txt", old: "c-d", new: "Y" },
  ];

  it("keeps a literal gap between two fuzzy matches and splits at the real match ends", () => {
    const before = "a-b\u00A0x-c\u2010d\n";
    const dir = repo({ "a.txt": before });
    const r = run(dir, gapInsideMatch);
    expect(r.status).toBe("written");
    expect(r.edits.map((e) => e.tier)).toEqual(["unicode", "unicode"]);
    expect(read(dir, "a.txt")).toBe("X-Y\n");

    const resolved = resolveFileEdits(
      before,
      gapInsideMatch.map((e, index) => ({ index, ...e, replaceAll: false })),
    );
    expect(resolved.regions[0].parts).toEqual([
      { start: 0, end: 5, text: "X" },
      { start: 6, end: 9, text: "Y" },
    ]);
  });

  it("refuses a replaceAll whose gaps between fuzzy matches are not literal", () => {
    // Each "a-b c" is matched through its no-break space; the en dashes
    // between the matches read "-" only in the normalized text.
    const before = "a-b\u00A0c–a-b\u00A0c–a-b\u00A0c\n";
    const dir = repo({ "a.txt": before });
    const r = run(dir, [
      { file: "a.txt", old: "a-b c", new: "Z", replaceAll: true },
    ]);
    expect(r.status).toBe("fuzzy_side_effect");
    expect(r.edits[0]).toMatchObject({ tier: "unicode", occurrences: 3 });
    expect(readBuf(dir, "a.txt").equals(Buffer.from(before))).toBe(true);
  });

  it("applies a replaceAll of three fuzzy matches on one line with literal gaps", () => {
    const dir = repo({ "a.txt": "a-b\u00A0c-a-b\u00A0c-a-b\u00A0c\n" });
    const r = run(dir, [
      { file: "a.txt", old: "a-b c", new: "Z", replaceAll: true },
    ]);
    expect(r.status).toBe("written");
    expect(r.edits[0]).toMatchObject({ tier: "unicode", occurrences: 3 });
    expect(read(dir, "a.txt")).toBe("Z-Z-Z\n");
  });
});

describe("patch: modes, line breaks and path checks", () => {
  it("keeps mode 0664 and a setgid bit under umask 022", () => {
    const dir = repo({ "g.txt": "g\n", "s.txt": "s\n" });
    fs.chmodSync(path.join(dir, "g.txt"), 0o664);
    fs.chmodSync(path.join(dir, "s.txt"), 0o2775);
    const setgid = (fs.statSync(path.join(dir, "s.txt")).mode & 0o2000) !== 0;
    const previous = process.umask(0o022);
    let r;
    try {
      r = run(dir, [
        { file: "g.txt", old: "g", new: "G" },
        { file: "s.txt", old: "s", new: "S" },
      ]);
    } finally {
      process.umask(previous);
    }
    expect(r.status).toBe("written");
    expect(fs.statSync(path.join(dir, "g.txt")).mode & 0o7777).toBe(0o664);
    if (setgid) {
      expect(fs.statSync(path.join(dir, "s.txt")).mode & 0o7777).toBe(0o2775);
    }
  });

  it("edits a file with CR CR LF line breaks", () => {
    const dir = repo({ "a.txt": "a\r\r\nb\n" });
    const r = run(dir, [{ file: "a.txt", old: "b", new: "c" }]);
    expect(r.status).toBe("written");
    expect(read(dir, "a.txt")).toBe("a\r\r\nc\n");
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses a read-only file and leaves it as it is",
    () => {
      const dir = repo({ "a.txt": "ro\n" });
      fs.chmodSync(path.join(dir, "a.txt"), 0o444);
      const r = run(dir, [{ file: "a.txt", old: "ro", new: "rw" }]);
      expect(r.status).toBe("not_editable");
      expect(r.reason).toBe("read_only");
      expect(read(dir, "a.txt")).toBe("ro\n");
      expect(fs.statSync(path.join(dir, "a.txt")).mode & 0o777).toBe(0o444);
    },
  );

  it("edits a file whose name starts with two dots at the root", () => {
    const dir = repo({ "..foo.txt": "x\n" });
    const r = run(dir, [{ file: "..foo.txt", old: "x", new: "y" }]);
    expect(r.status).toBe("written");
    expect(r.edits[0].path).toBe("..foo.txt");
    expect(read(dir, "..foo.txt")).toBe("y\n");
  });

  it("says a missing file is never created", () => {
    const dir = repo({});
    const r = run(dir, [{ file: "new.txt", old: "x", new: "y" }]);
    expect(r.status).toBe("error");
    expect(r.reason).toBe("not_found");
    expect(r.message).toContain(
      "file does not exist; patch only edits existing files (it never creates one)",
    );
    expect(fs.existsSync(path.join(dir, "new.txt"))).toBe(false);
  });

  it("refuses to write when a directory on the path became a symlink after the read", () => {
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, "f.txt"), "outside\n");
    const dir = repo({ "A/f.txt": "one\n", "B/f.txt": "two\n" });
    let calls = 0;
    const r = patch({
      cwd: dir,
      edits: [
        { file: "A/f.txt", old: "one", new: "ONE" },
        { file: "B/f.txt", old: "two", new: "TWO" },
      ],
      renameFile: (from, to) => {
        fs.renameSync(from, to);
        if (calls++ === 0) {
          fs.rmSync(path.join(dir, "B"), { recursive: true });
          fs.symlinkSync(outside, path.join(dir, "B"));
        }
      },
    });
    expect(r.status).toBe("error");
    expect(r.files[1].reason).toBe("path_changed");
    expect(r.writtenFiles).toEqual([path.join("A", "f.txt")]);
    expect(fs.readFileSync(path.join(outside, "f.txt"), "utf8")).toBe(
      "outside\n",
    );
  });

  it("refuses to write when the resolved path no longer resolves to itself", () => {
    const dir = repo({ "A/f.txt": "one\n", "B/f.txt": "two\n" });
    let calls = 0;
    const r = patch({
      cwd: dir,
      edits: [
        { file: "A/f.txt", old: "one", new: "ONE" },
        { file: "B/f.txt", old: "two", new: "TWO" },
      ],
      renameFile: (from, to) => {
        fs.renameSync(from, to);
        if (calls++ === 0) {
          // Same file, but its directory now sits behind a symlink.
          fs.renameSync(path.join(dir, "B"), path.join(dir, "B2"));
          fs.symlinkSync("B2", path.join(dir, "B"));
        }
      },
    });
    expect(r.status).toBe("error");
    expect(r.files[1].reason).toBe("path_changed");
    expect(read(dir, "B2/f.txt")).toBe("two\n");
  });

  it("replaces many occurrences in linear time", () => {
    // Large enough that spreading one array element per occurrence into a
    // call would exceed the call stack.
    const n = 250_000;
    const dir = repo({
      "a.txt": "x  \nfoo\n".repeat(n),
      "b.txt": "foo bar\n".repeat(n),
    });
    const start = Date.now();
    const r = run(dir, [
      { file: "a.txt", old: "x\nfoo", new: "y\nbar", replaceAll: true },
      { file: "b.txt", old: "foo", new: "baz", replaceAll: true },
    ]);
    const elapsed = Date.now() - start;
    expect(r.status).toBe("written");
    expect(r.edits.map((e) => e.occurrences)).toEqual([n, n]);
    // The trailing whitespace inside each match is replaced with it.
    expect(read(dir, "a.txt") === "y\nbar\n".repeat(n)).toBe(true);
    expect(read(dir, "b.txt") === "baz bar\n".repeat(n)).toBe(true);
    // Linear work takes well under a second here; the quadratic splice
    // and line lookup took tens of seconds at this size.
    expect(elapsed).toBeLessThan(10_000);
  }, 60_000);
});

describe("patch: source hygiene", () => {
  it("src/patch and its tests hold no invisible or combining literal characters (they are written as escapes)", () => {
    const pkg = path.join(path.dirname(CLI_PATH), "..");
    const dir = path.join(pkg, "src", "patch");
    const files = [
      ...fs.readdirSync(dir).map((name) => path.join(dir, name)),
      path.join(pkg, "test", "patch.test.ts"),
    ];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const invisible = [...text].filter(
        (ch) => ch !== " " && /[\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{M}]/u.test(ch),
      );
      expect(invisible, file).toEqual([]);
    }
  });
});

describe("patch CLI: findings", () => {
  it("a fuzzy side effect exits 1 and the text mode shows the lines", async () => {
    const dir = repo({ "a.js": 'q = "“hi”"; run(‘1’);\n' });
    const json = await spawnCli([
      "-C",
      dir,
      "patch",
      "--file",
      "a.js",
      "--old",
      "run('1')",
      "--new",
      "run('2')",
    ]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      command: "patch",
      status: "fuzzy_side_effect",
    });
    const text = await spawnCli([
      "-C",
      dir,
      "-f",
      "text",
      "patch",
      "--file",
      "a.js",
      "--old",
      "run('1')",
      "--new",
      "run('2')",
    ]);
    expect(text.stdout).toContain("edits[0] a.js: fuzzy_side_effect");
    expect(text.stdout).toContain("line 1 normalized:");
  });

  it("refuses two fuzzy matches whose gap is not literal, even when the gap text occurs inside a match", async () => {
    // The en dash between the matches is outside both; the normalized
    // gap "-" also occurs inside the first match's original text.
    const before = "a-b\u00A0x–c\u2010d\n";
    const dir = repo({ "a.txt": before });
    const scratch = tmpDir();
    const plan = path.join(scratch, "plan.json");
    fs.writeFileSync(
      plan,
      JSON.stringify({
        edits: [
          { file: "a.txt", old: "a-b x", new: "X" },
          { file: "a.txt", old: "c-d", new: "Y" },
        ],
      }),
    );
    const res = await spawnCli(["-C", dir, "patch", "--plan", plan]);
    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout) as {
      status: string;
      edits: Array<{ status: string; tier: string }>;
    };
    expect(out.status).toBe("fuzzy_side_effect");
    expect(out.edits.map((e) => [e.status, e.tier])).toEqual([
      ["fuzzy_side_effect", "unicode"],
      ["fuzzy_side_effect", "unicode"],
    ]);
    expect(readBuf(dir, "a.txt").equals(Buffer.from(before))).toBe(true);
  });

  it("--break-hard-links edits a hard-linked file", async () => {
    const dir = repo({ "a.txt": "a\n" });
    fs.linkSync(path.join(dir, "a.txt"), path.join(dir, "b.txt"));
    const refused = await spawnCli([
      "-C",
      dir,
      "patch",
      "--file",
      "a.txt",
      "--old",
      "a",
      "--new",
      "A",
    ]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      status: "not_editable",
      reason: "hard_link",
    });
    const ok = await spawnCli([
      "-C",
      dir,
      "patch",
      "--break-hard-links",
      "--file",
      "a.txt",
      "--old",
      "a",
      "--new",
      "A",
    ]);
    expect(ok.code).toBe(0);
    expect(read(dir, "a.txt")).toBe("A\n");
    expect(read(dir, "b.txt")).toBe("a\n");
  });
});

describe("patch: replaceAll under the line-end rule", () => {
  // "a a" occurs at 0 and, overlapping, at 2 in "a a a"; old ends in
  // whitespace, so a fuzzy match must end at a line end: only 2 counts.
  it("replaces the occurrence the line-end rule keeps although an overlapping one before it is dropped", () => {
    const dir = repo({ "all.txt": "a a a \n", "one.txt": "a a a \n" });
    const single = run(dir, [{ file: "one.txt", old: "a a\t", new: "X" }]);
    const all = run(dir, [
      { file: "all.txt", old: "a a\t", new: "X", replaceAll: true },
    ]);
    expect(single.status).toBe("written");
    expect(all.status).toBe("written");
    expect(all.edits[0]).toMatchObject({
      status: "written",
      tier: "trailing_whitespace",
      occurrences: 1,
      line_ranges: [{ start: 1, end: 1 }],
    });
    expect(read(dir, "all.txt")).toBe(read(dir, "one.txt"));
    expect(read(dir, "all.txt")).toBe("a X\n");
  });

  it("replaces the kept occurrence of every line", () => {
    const dir = repo({
      "all.txt": "a a a \nb a a \n",
      "l1.txt": "a a a \n",
      "l2.txt": "b a a \n",
    });
    const all = run(dir, [
      { file: "all.txt", old: "a a\t", new: "X", replaceAll: true },
    ]);
    expect(all.status).toBe("written");
    expect(all.edits[0]).toMatchObject({
      tier: "trailing_whitespace",
      occurrences: 2,
      line_ranges: [
        { start: 1, end: 1 },
        { start: 2, end: 2 },
      ],
    });
    // Each candidate on its own, without replaceAll, decides the same.
    for (const file of ["l1.txt", "l2.txt"]) {
      expect(run(dir, [{ file, old: "a a\t", new: "X" }]).status).toBe(
        "written",
      );
    }
    expect(read(dir, "all.txt")).toBe(
      read(dir, "l1.txt") + read(dir, "l2.txt"),
    );
    expect(read(dir, "all.txt")).toBe("a X\nb X\n");
  });
});

/** A bare repository `repo.git` (cloned from a one-commit repository)
 * with a linked worktree `wt` next to it, all in one temporary dir. */
function bareRepoWithWorktree(): { bare: string; wt: string } {
  const base = tmpDir();
  const src = path.join(base, "src");
  fs.mkdirSync(src);
  execFileSync("git", ["init", "-q"], { cwd: src });
  fs.writeFileSync(path.join(src, "a.txt"), "a\n");
  execFileSync("git", ["add", "a.txt"], { cwd: src, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    cwd: src,
    env: gitEnv,
  });
  execFileSync("git", ["clone", "-q", "--bare", "src", "repo.git"], {
    cwd: base,
    env: gitEnv,
  });
  const bare = path.join(base, "repo.git");
  execFileSync("git", ["worktree", "add", "-q", "../wt"], {
    cwd: bare,
    env: gitEnv,
  });
  return { bare, wt: path.join(base, "wt") };
}

describe("patch: git directories without a work tree", () => {
  it("refuses -C <bare repository> --file config, also as a dry run", async () => {
    const { bare } = bareRepoWithWorktree();
    const config = read(bare, "config");
    const edit = { file: "config", old: "[core]", new: "[x]" };
    for (const dryRun of [false, true]) {
      const r = run(bare, [edit], { dryRun });
      expect(r.status).toBe("usage_error");
      expect(r.reason).toBe("git_dir");
      expect(r.warnings).toEqual([]);
    }
    const res = await spawnCli([
      "-C",
      bare,
      "patch",
      "--file",
      "config",
      "--old",
      "[core]",
      "--new",
      "[x]",
    ]);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout)).toMatchObject({
      status: "usage_error",
      reason: "git_dir",
    });
    expect(read(bare, "config")).toBe(config);
  });

  it("refuses -C <bare repository>/worktrees/<wt> --file HEAD", () => {
    const { bare } = bareRepoWithWorktree();
    const gitDir = path.join(bare, "worktrees", "wt");
    const head = read(gitDir, "HEAD");
    const r = run(gitDir, [{ file: "HEAD", old: "ref:", new: "x" }]);
    expect(r.reason).toBe("git_dir");
    expect(read(gitDir, "HEAD")).toBe(head);
  });

  it("refuses the common directory of a linked worktree of a bare repository, even with allowOutside", () => {
    const { bare, wt } = bareRepoWithWorktree();
    const config = read(bare, "config");
    const r = run(
      wt,
      [{ file: "../repo.git/config", old: "[core]", new: "[x]" }],
      { allowOutside: true },
    );
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("git_dir");
    expect(read(bare, "config")).toBe(config);
  });

  it("outside any repository the check finds nothing and warns of nothing", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    const r = run(dir, [{ file: "a.txt", old: "a", new: "b" }]);
    expect(r.status).toBe("written");
    expect(r.warnings).toEqual([]);
  });
});

describe("patch: a git directory check that cannot be made is reported", () => {
  it("warns when git cannot be run", () => {
    const dir = tmpDir();
    execFileSync("git", ["init", "-q", "--separate-git-dir", "gd", "."], {
      cwd: dir,
    });
    const config = read(dir, "gd/config");
    const res = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "-C",
        dir,
        "--json",
        "patch",
        "--file",
        "gd/config",
        "--old",
        "[core]",
        "--new",
        "[x]",
        "--dry-run",
      ],
      { env: { PATH: path.join(dir, "no-such-bin") }, encoding: "utf8" },
    );
    const out = JSON.parse(res.stdout) as { warnings: string[] };
    expect(out.warnings.join("\n")).toContain(
      "the git directory check by identity was skipped (git could not be run",
    );
    expect(read(dir, "gd/config")).toBe(config);
  });

  it("warns when the root is a work tree but git fails there, and runs no git for a .git file naming a path that does not resolve", () => {
    const dir = tmpDir();
    // A directory that exists but is no git directory: git stops at the
    // .git file with an error.
    fs.mkdirSync(path.join(dir, "adm"));
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: adm\n");
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    const r = run(dir, [{ file: "a.txt", old: "a", new: "b" }], {
      dryRun: true,
    });
    expect(r.status).toBe("would_write");
    expect(r.warnings.join("\n")).toContain(
      "the git directory check by identity was skipped (git rev-parse failed",
    );
    // A path the filesystem cannot resolve: the check cannot follow it
    // to the commondir git would read, so git is not run.
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: no-such-git-dir\n");
    const missing = run(dir, [{ file: "a.txt", old: "a", new: "b" }], {
      dryRun: true,
    });
    expect(missing.status).toBe("would_write");
    expect(missing.warnings.join("\n")).toContain(
      `the git directory check by identity was skipped (git was not run: ${path.join(dir, ".git")} names its git directory by a path that does not resolve, which this check cannot follow)`,
    );
  });
});

describe("patch: write and dry run agree", () => {
  it("a fuzzy-tier dry-run diff applies with git apply to the same result as the write, keeping trailing whitespace after the match", () => {
    const content = "keep\nx  \ny  \nz\n";
    const dir = repo({ "a.txt": content, "b.txt": content });
    const edits = (file: string): PatchEditSpec[] => [
      { file, old: "x\ny", new: "N" },
    ];
    const dry = run(dir, edits("a.txt"), { dryRun: true });
    expect(dry.status).toBe("would_write");
    expect(dry.edits[0].tier).toBe("trailing_whitespace");
    fs.writeFileSync(path.join(dir, "a.diff"), dry.files[0].diff ?? "");
    execFileSync("git", ["apply", "--whitespace=nowarn", "a.diff"], {
      cwd: dir,
    });
    const real = run(dir, edits("b.txt"));
    expect(real.status).toBe("written");
    expect(read(dir, "b.txt")).toBe("keep\nN  \nz\n");
    expect(read(dir, "a.txt")).toBe(read(dir, "b.txt"));
  });

  it("applies a trailing_whitespace-tier match with typographic quotes inside the match", () => {
    const dir = repo({ "a.txt": "say \u201Chi\u201D  \nnext\nend\n" });
    const r = run(dir, [
      { file: "a.txt", old: "say \u201Chi\u201D\nnext", new: "N" },
    ]);
    expect(r.status).toBe("written");
    expect(r.edits[0].tier).toBe("trailing_whitespace");
    expect(read(dir, "a.txt")).toBe("N\nend\n");
  });

  it("refuses a hard-linked file on a dry run too", () => {
    const dir = repo({ "a.txt": "a\n" });
    fs.linkSync(path.join(dir, "a.txt"), path.join(dir, "b.txt"));
    const r = run(dir, [{ file: "a.txt", old: "a", new: "A" }], {
      dryRun: true,
    });
    expect(r.status).toBe("not_editable");
    expect(r.reason).toBe("hard_link");
    expect(r.edits[0]).toMatchObject({
      status: "not_editable",
      reason: "hard_link",
    });
  });

  it("refuses to write when a symlink spelling the plan used was retargeted after the read", () => {
    const dir = repo({
      "A/f.txt": "one\n",
      "t.txt": "two\n",
      "u.txt": "two\n",
    });
    fs.symlinkSync("t.txt", path.join(dir, "link.txt"));
    let calls = 0;
    const r = patch({
      cwd: dir,
      edits: [
        { file: "A/f.txt", old: "one", new: "ONE" },
        { file: "link.txt", old: "two", new: "TWO" },
      ],
      renameFile: (from, to) => {
        fs.renameSync(from, to);
        if (calls++ === 0) {
          fs.rmSync(path.join(dir, "link.txt"));
          fs.symlinkSync("u.txt", path.join(dir, "link.txt"));
        }
      },
    });
    expect(r.status).toBe("error");
    expect(r.files[1]).toMatchObject({
      path: "t.txt",
      status: "error",
      reason: "path_changed",
    });
    expect(r.writtenFiles).toEqual([path.join("A", "f.txt")]);
    expect(read(dir, "t.txt")).toBe("two\n");
    expect(read(dir, "u.txt")).toBe("two\n");
  });
});

describe("patch: growth bound of the fuzzy split", () => {
  // NFKC of L + U+0304 has two characters; with U+0323 appended it is the
  // one character U+1E38. The bound stops the first match at the longer
  // prefix, so this plan is refused although a split exists.
  const edits = [
    { file: "a.txt", old: "\u1E38", new: "A" },
    { file: "a.txt", old: "Z", new: "B" },
  ];

  it("refuses two adjacent unicode matches when the first passes a longer normalized prefix (documented false refusal)", () => {
    const before = "L\u0304\u0323\uFF3A\n";
    const dir = repo({ "a.txt": before });
    const r = run(dir, edits);
    expect(r.status).toBe("fuzzy_side_effect");
    expect(r.edits.map((e) => [e.status, e.tier])).toEqual([
      ["fuzzy_side_effect", "unicode"],
      ["fuzzy_side_effect", "unicode"],
    ]);
    expect(readBuf(dir, "a.txt").equals(Buffer.from(before))).toBe(true);
  });

  it("applies the same edits when a literal gap separates the matches", () => {
    const dir = repo({ "a.txt": "L\u0304\u0323 \uFF3A\n" });
    const r = run(dir, edits);
    expect(r.status).toBe("written");
    expect(read(dir, "a.txt")).toBe("A B\n");
  });
});

describe("patch: replaceAll boundaries", () => {
  it("replaces adjacent exact occurrences", () => {
    const dir = repo({ "a.txt": "abab\n" });
    const r = run(dir, [
      { file: "a.txt", old: "ab", new: "X", replaceAll: true },
    ]);
    expect(r.status).toBe("written");
    expect(r.edits[0]).toMatchObject({
      tier: "exact",
      occurrences: 2,
      line_ranges: [
        { start: 1, end: 1 },
        { start: 1, end: 1 },
      ],
    });
    expect(read(dir, "a.txt")).toBe("XX\n");
  });

  it("takes overlapping exact occurrences from left to right, each starting at or after the end of the one before", () => {
    const dir = repo({ "four.txt": "aaaa\n", "five.txt": "aaaaa\n" });
    const r = run(dir, [
      { file: "four.txt", old: "aa", new: "X", replaceAll: true },
      { file: "five.txt", old: "aa", new: "X", replaceAll: true },
    ]);
    expect(r.status).toBe("written");
    expect(r.edits.map((e) => e.occurrences)).toEqual([2, 2]);
    expect(read(dir, "four.txt")).toBe("XX\n");
    expect(read(dir, "five.txt")).toBe("XXa\n");
  });

  it("replaces only the first of two fuzzy occurrences that overlap, both ending at a line end", () => {
    // Under the trailing_whitespace tier "a\na" starts at offsets 0 and 2
    // of "a\na\na"; both end at a line end, so both count (an edit
    // without replaceAll is ambiguous), and the second overlaps the
    // first, so replaceAll takes only the first.
    const dir = repo({ "a.txt": "a \na \na \n", "b.txt": "a \na \na \n" });
    const one = run(dir, [{ file: "b.txt", old: "a\na ", new: "Q" }]);
    expect(one.status).toBe("ambiguous");
    expect(one.edits[0].occurrences).toBe(2);
    const r = run(dir, [
      { file: "a.txt", old: "a\na ", new: "Q", replaceAll: true },
    ]);
    expect(r.status).toBe("written");
    expect(r.edits[0]).toMatchObject({
      tier: "trailing_whitespace",
      occurrences: 1,
      line_ranges: [{ start: 1, end: 2 }],
    });
    expect(read(dir, "a.txt")).toBe("Q\na \n");
  });
});

/** `git` in `cwd` with a throw-away identity and no user or system
 * configuration. */
function gitIn(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...gitEnv,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** A one-commit repository `src` under a fresh temporary dir. */
function committedSource(): { base: string; src: string } {
  const base = tmpDir();
  const src = path.join(base, "src");
  fs.mkdirSync(src);
  gitIn(src, "init", "-q");
  fs.writeFileSync(path.join(src, "a.txt"), "a\n");
  gitIn(src, "add", "a.txt");
  gitIn(src, "commit", "-q", "-m", "init");
  return { base, src };
}

function addHook(gitDir: string): void {
  fs.mkdirSync(path.join(gitDir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\n");
}

/** A bare repository `nested.git` inside the work tree `outer`. */
function bareInsideWorkTree(): { outer: string; nested: string } {
  const { base, src } = committedSource();
  const outer = path.join(base, "outer");
  fs.mkdirSync(outer);
  gitIn(outer, "init", "-q");
  fs.writeFileSync(path.join(outer, "o.txt"), "o\n");
  gitIn(outer, "clone", "-q", "--bare", src, "nested.git");
  const nested = path.join(outer, "nested.git");
  addHook(nested);
  return { outer, nested };
}

/** A bare repository `inbare.git` with its work tree `main` checked out
 * inside it (`git -C inbare.git worktree add main`). */
function workTreeInsideBare(): { bare: string; main: string } {
  const { base, src } = committedSource();
  gitIn(base, "clone", "-q", "--bare", src, "inbare.git");
  const bare = path.join(base, "inbare.git");
  gitIn(bare, "worktree", "add", "-q", "main");
  addHook(bare);
  return { bare, main: path.join(bare, "main") };
}

/** A work tree `sep` whose git directory is `<base>/<gitDirName>`. */
function separateGitDir(gitDirName: string): {
  base: string;
  wt: string;
  gd: string;
} {
  const base = tmpDir();
  const wt = path.join(base, "sep");
  fs.mkdirSync(wt);
  const gd = path.join(base, gitDirName);
  gitIn(wt, "init", "-q", "--separate-git-dir", gd, ".");
  fs.writeFileSync(path.join(wt, "s.txt"), "s\n");
  return { base, wt, gd };
}

/** A superproject `super` holding `src` as the submodule `sub`. */
function superWithSubmodule(): { sup: string; sub: string } {
  const { base, src } = committedSource();
  const sup = path.join(base, "super");
  fs.mkdirSync(sup);
  gitIn(sup, "init", "-q");
  fs.writeFileSync(path.join(sup, "s.txt"), "s\n");
  gitIn(sup, "add", "s.txt");
  gitIn(sup, "commit", "-q", "-m", "s");
  gitIn(
    sup,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    src,
    "sub",
  );
  return { sup, sub: path.join(sup, "sub") };
}

interface PatchJson {
  status: string;
  reason?: string;
  warnings: string[];
  edits: { status: string; reason?: string; detail?: string }[];
}

/** The CLI run with git on PATH and `env` added to its fixed
 * environment, parsed. */
async function cliWithGit(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; out: PatchJson }> {
  const res = await spawnCli(["--json", ...args], {
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return { code: res.code, out: JSON.parse(res.stdout) as PatchJson };
}

/** The CLI run with a PATH that has no git on it, so only a check that
 * runs no git can refuse; `env` adds to that environment. */
function cliWithoutGit(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { code: number | null; out: PatchJson } {
  const res = spawnSync(process.execPath, [CLI_PATH, "--json", ...args], {
    env: { PATH: path.join(tmpDir(), "no-git-bin"), ...env },
    encoding: "utf8",
  });
  return { code: res.status, out: JSON.parse(res.stdout) as PatchJson };
}

const CONFIG_EDIT = ["--old", "[core]", "--new", "[x]", "--dry-run"];

describe("patch: git directories recognised by their layout", () => {
  it("refuses -C inside a bare repository nested in a work tree, also as a dry run", () => {
    const { outer, nested } = bareInsideWorkTree();
    const config = read(nested, "config");
    const hook = read(nested, "hooks/pre-commit");
    const cfg = { file: "config", old: "[core]", new: "[x]" };
    for (const dryRun of [false, true]) {
      const r = run(nested, [cfg], { dryRun });
      expect(r.status).toBe("usage_error");
      expect(r.reason).toBe("git_dir");
      expect(r.edits[0].detail).toContain("looks like a git directory");
      const hooks = run(
        path.join(nested, "hooks"),
        [{ file: "pre-commit", old: "#", new: "X" }],
        { dryRun },
      );
      expect(hooks.reason).toBe("git_dir");
      const fromOuter = run(outer, [{ ...cfg, file: "nested.git/config" }], {
        dryRun,
      });
      expect(fromOuter.reason).toBe("git_dir");
    }
    expect(read(nested, "config")).toBe(config);
    expect(read(nested, "hooks/pre-commit")).toBe(hook);
    // The work tree around it stays editable.
    const ok = run(outer, [{ file: "o.txt", old: "o", new: "O" }]);
    expect(ok.status).toBe("written");
    expect(ok.warnings).toEqual([]);
  });

  it("edits a work tree checked out inside its bare repository and refuses the repository around it", () => {
    const { bare, main } = workTreeInsideBare();
    const config = read(bare, "config");
    const r = run(main, [{ file: "a.txt", old: "a", new: "b" }]);
    expect(r.status).toBe("written");
    expect(r.warnings).toEqual([]);
    expect(read(main, "a.txt")).toBe("b\n");
    const config_ = run(
      main,
      [{ file: "../config", old: "[core]", new: "[x]" }],
      { allowOutside: true },
    );
    expect(config_.status).toBe("usage_error");
    expect(config_.reason).toBe("git_dir");
    expect(config_.edits[0].detail).toContain("which git names");
    // Not only the repository directory itself: anything below it.
    const hook = run(
      main,
      [{ file: "../hooks/pre-commit", old: "#", new: "X" }],
      { allowOutside: true },
    );
    expect(hook.status).toBe("usage_error");
    expect(hook.reason).toBe("git_dir");
    expect(read(bare, "config")).toBe(config);
    expect(read(bare, "hooks/pre-commit")).toBe("#!/bin/sh\n");
  });

  it("refuses a bare repository that git declines to open", async () => {
    const { bare } = bareRepoWithWorktree();
    const config = read(bare, "config");
    const explicit = path.join(tmpDir(), "explicit.gitconfig");
    fs.writeFileSync(explicit, "[safe]\n\tbareRepository = explicit\n");
    const cases: [string, NodeJS.ProcessEnv][] = [
      ["safe.bareRepository=explicit", { GIT_CONFIG_GLOBAL: explicit }],
      ["dubious ownership", { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" }],
    ];
    for (const [name, env] of cases) {
      const { code, out } = await cliWithGit(
        ["-C", bare, "patch", "--file", "config", ...CONFIG_EDIT],
        env,
      );
      expect(code, name).toBe(2);
      expect(out, name).toMatchObject({
        status: "usage_error",
        reason: "git_dir",
      });
      expect(out.edits[0].detail, name).toContain("looks like a git directory");
    }
    expect(read(bare, "config")).toBe(config);
  });

  it("asks git about the root itself, whatever GIT_DIR, GIT_WORK_TREE and GIT_CEILING_DIRECTORIES say", async () => {
    const other = repo({ "x.txt": "x\n" });
    const { base, wt } = separateGitDir("gd");
    const config = read(base, "gd/config");
    const named = await cliWithGit(
      [
        "-C",
        wt,
        "patch",
        "--file",
        "../gd/config",
        "--allow-outside",
        ...CONFIG_EDIT,
      ],
      { GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other },
    );
    expect(named.code).toBe(2);
    expect(named.out).toMatchObject({
      status: "usage_error",
      reason: "git_dir",
      warnings: [],
    });
    expect(named.out.edits[0].detail).toContain("which git names");
    expect(read(base, "gd/config")).toBe(config);
    // A GIT_DIR that does not exist would make git fail in the work tree
    // (and the result warn); it never reaches git.
    const norm = repo({ "a.txt": "a\n" });
    const clean = await cliWithGit(
      [
        "-C",
        norm,
        "patch",
        "--file",
        "a.txt",
        "--old",
        "a",
        "--new",
        "b",
        "--dry-run",
      ],
      { GIT_DIR: "/nonexistent" },
    );
    expect(clean.code).toBe(0);
    expect(clean.out).toMatchObject({ status: "would_write", warnings: [] });
    // A ceiling at the bare repository would stop git below it (then only
    // the layout refuses); without it git names the repository.
    const { bare } = bareRepoWithWorktree();
    addHook(bare);
    const ceiling = await cliWithGit(
      [
        "-C",
        path.join(bare, "hooks"),
        "patch",
        "--file",
        "pre-commit",
        "--old",
        "#",
        "--new",
        "X",
        "--dry-run",
      ],
      { GIT_CEILING_DIRECTORIES: bare },
    );
    expect(ceiling.code).toBe(2);
    expect(ceiling.out).toMatchObject({
      status: "usage_error",
      reason: "git_dir",
    });
    expect(ceiling.out.edits[0].detail).toContain("which git names");
  });

  it("refuses a separate git directory whose name ends in a space, by git's own word", () => {
    const { wt, gd } = separateGitDir("gd ");
    const config = read(gd, "config");
    const r = run(wt, [{ file: "../gd /config", old: "[core]", new: "[x]" }], {
      allowOutside: true,
    });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("git_dir");
    expect(r.edits[0].detail).toContain("which git names");
    expect(r.warnings).toEqual([]);
    expect(read(gd, "config")).toBe(config);
    const ok = run(wt, [{ file: "s.txt", old: "s", new: "S" }]);
    expect(ok.status).toBe("written");
    expect(ok.warnings).toEqual([]);
  });

  it("reports a git directory git names but cannot be stated, and still refuses it", () => {
    const { base, src } = committedSource();
    gitIn(base, "clone", "-q", "--bare", src, "gd\n");
    const bare = path.join(base, "gd\n");
    const config = read(bare, "config");
    const cfg = { file: "config", old: "[core]", new: "[x]" };
    const r = run(bare, [cfg], { dryRun: true });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("git_dir");
    // Git's answer is the repository's path with its line break, then
    // `.` for the common directory: that last line names the repository.
    expect(r.edits[0].detail).toContain("which git names");
    expect(r.warnings.join("\n")).toContain("which cannot be stated");
    expect(r.warnings.join("\n")).toContain("line break in its name");
    // Next to a directory named like the line before the break, git's
    // output reads as that directory, a blank line and the rest; that
    // directory is no git directory and is not refused for its identity.
    fs.mkdirSync(path.join(base, "gd"));
    fs.writeFileSync(path.join(base, "gd", "y.txt"), "y\n");
    const again = run(bare, [cfg], { dryRun: true });
    expect(again.reason).toBe("git_dir");
    expect(again.warnings.join("\n")).toContain("line break in its name");
    expect(again.warnings.join("\n")).toContain(
      "which is not laid out like a git directory",
    );
    const sibling = run(bare, [{ file: "../gd/y.txt", old: "y", new: "z" }], {
      dryRun: true,
      allowOutside: true,
    });
    expect(sibling.status).toBe("would_write");
    expect(read(bare, "config")).toBe(config);
  });

  it("edits files of a linked worktree and of a submodule work tree with no warning", () => {
    const { wt } = bareRepoWithWorktree();
    const linked = run(wt, [{ file: "a.txt", old: "a", new: "b" }]);
    expect(linked.status).toBe("written");
    expect(linked.warnings).toEqual([]);
    const { sup, sub } = superWithSubmodule();
    const inSub = run(sub, [{ file: "a.txt", old: "a", new: "b" }]);
    expect(inSub.status).toBe("written");
    expect(inSub.warnings).toEqual([]);
    const fromSuper = run(sup, [{ file: "sub/a.txt", old: "b", new: "c" }]);
    expect(fromSuper.status).toBe("written");
    expect(fromSuper.warnings).toEqual([]);
    expect(read(sub, "a.txt")).toBe("c\n");
    const gitDir = run(
      sub,
      [{ file: "../.git/modules/sub/config", old: "[core]", new: "[x]" }],
      { allowOutside: true },
    );
    expect(gitDir.reason).toBe("git_dir");
  });
});

describe("patch: the layout test of a git directory (no git on PATH)", () => {
  /** A directory laid out like a git directory: `HEAD` (default: a
   * symbolic ref), `objects/`, `refs/` and a `config` to edit. */
  function gitLike(
    layout: { head?: string; objects?: boolean; refs?: boolean } = {},
    name = "fake",
  ): string {
    const dir = path.join(tmpDir(), name);
    fs.mkdirSync(dir);
    if (layout.objects !== false) fs.mkdirSync(path.join(dir, "objects"));
    if (layout.refs !== false) fs.mkdirSync(path.join(dir, "refs"));
    fs.writeFileSync(
      path.join(dir, "HEAD"),
      layout.head ?? "ref: refs/heads/main\n",
    );
    fs.writeFileSync(path.join(dir, "config"), "[core]\n");
    return dir;
  }

  function editConfig(
    cwd: string,
    env: NodeJS.ProcessEnv = {},
    file = "config",
  ) {
    return cliWithoutGit(
      ["-C", cwd, "patch", "--file", file, ...CONFIG_EDIT],
      env,
    );
  }

  it("a HEAD naming a ref, with objects and refs, marks a git directory", () => {
    const { code, out } = editConfig(gitLike());
    expect(code).toBe(2);
    expect(out).toMatchObject({ status: "usage_error", reason: "git_dir" });
    expect(out.edits[0].detail).toContain("looks like a git directory");
    expect(out.warnings.join("\n")).toContain("git could not be run");
  });

  it("so does a HEAD holding an object id, a HEAD symlink into refs, or ref: without a space", () => {
    const oid = gitLike({ head: "0123456789abcdef0123456789abcdef01234567\n" });
    const noSpace = gitLike({ head: "ref:refs/heads/main\n" });
    const link = gitLike();
    fs.rmSync(path.join(link, "HEAD"));
    fs.symlinkSync("refs/heads/main", path.join(link, "HEAD"));
    for (const dir of [oid, noSpace, link]) {
      expect(editConfig(dir).out, dir).toMatchObject({
        status: "usage_error",
        reason: "git_dir",
      });
    }
  });

  it("not a HEAD that names neither", () => {
    const { code, out } = editConfig(gitLike({ head: "garbage\n" }));
    expect(code).toBe(0);
    expect(out.status).toBe("would_write");
  });

  it("not without objects (unless GIT_OBJECT_DIRECTORY relocates them) or without refs", () => {
    const noObjects = gitLike({ objects: false });
    expect(editConfig(noObjects).out.status).toBe("would_write");
    expect(
      editConfig(noObjects, {
        GIT_OBJECT_DIRECTORY: path.join(gitLike(), "objects"),
      }).out,
    ).toMatchObject({ status: "usage_error", reason: "git_dir" });
    expect(editConfig(gitLike({ refs: false })).out.status).toBe("would_write");
  });

  it("objects and refs may sit where GIT_COMMON_DIR points, as git looks there too", () => {
    const headOnly = gitLike({ objects: false, refs: false });
    expect(editConfig(headOnly).out.status).toBe("would_write");
    expect(
      editConfig(headOnly, { GIT_COMMON_DIR: gitLike() }).out,
    ).toMatchObject({ status: "usage_error", reason: "git_dir" });
  });

  it("objects and refs may sit in the directory its commondir file names", () => {
    const base = tmpDir();
    fs.mkdirSync(path.join(base, "common", "objects"), { recursive: true });
    fs.mkdirSync(path.join(base, "common", "refs"));
    const admin = path.join(base, "admin");
    fs.mkdirSync(admin);
    fs.writeFileSync(path.join(admin, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(admin, "commondir"), "../common\n");
    fs.writeFileSync(path.join(admin, "config"), "[core]\n");
    expect(editConfig(admin).out).toMatchObject({
      status: "usage_error",
      reason: "git_dir",
    });
  });

  it("a linked worktree's administrative directory is one by its gitdir and commondir files", () => {
    const admin = path.join(tmpDir(), "wt-admin");
    fs.mkdirSync(admin);
    fs.writeFileSync(path.join(admin, "gitdir"), "/nowhere/.git\n");
    fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
    fs.writeFileSync(path.join(admin, "config"), "[core]\n");
    const { out } = editConfig(admin);
    expect(out).toMatchObject({ status: "usage_error", reason: "git_dir" });
    expect(out.edits[0].detail).toContain("looks like a git directory");
  });

  it("above a target inside a work tree the walk passes over only the root's own repository, above any other target nothing", () => {
    const fake = gitLike();
    // A work tree inside the git directory, as `git worktree add` lays
    // it out: `.git` names an administrative directory whose commondir
    // names the repository.
    fs.mkdirSync(path.join(fake, "admin"));
    fs.writeFileSync(
      path.join(fake, "admin", "HEAD"),
      "ref: refs/heads/main\n",
    );
    fs.writeFileSync(path.join(fake, "admin", "commondir"), "..\n");
    fs.mkdirSync(path.join(fake, "wt"));
    fs.writeFileSync(path.join(fake, "wt", ".git"), "gitdir: ../admin\n");
    fs.writeFileSync(path.join(fake, "wt", "a.txt"), "a\n");
    const inside = cliWithoutGit([
      "-C",
      path.join(fake, "wt"),
      "patch",
      "--file",
      "a.txt",
      "--old",
      "a",
      "--new",
      "b",
      "--dry-run",
    ]);
    expect(inside.code).toBe(0);
    expect(inside.out.status).toBe("would_write");
    const outside = cliWithoutGit([
      "-C",
      path.join(fake, "wt"),
      "patch",
      "--file",
      "../config",
      "--allow-outside",
      ...CONFIG_EDIT,
    ]);
    expect(outside.out).toMatchObject({
      status: "usage_error",
      reason: "git_dir",
    });
    // A `.git` file that names no git directory makes no work tree: the
    // walk goes on upward and finds the repository.
    fs.mkdirSync(path.join(fake, "broken"));
    fs.writeFileSync(path.join(fake, "broken", ".git"), "gitdir: nowhere\n");
    fs.writeFileSync(path.join(fake, "broken", "b.txt"), "b\n");
    const broken = cliWithoutGit([
      "-C",
      path.join(fake, "broken"),
      "patch",
      "--file",
      "b.txt",
      "--old",
      "b",
      "--new",
      "c",
      "--dry-run",
    ]);
    expect(broken.out).toMatchObject({
      status: "usage_error",
      reason: "git_dir",
    });
    // So does a -C directory that is not a work tree at all.
    addHook(fake);
    const hooks = cliWithoutGit([
      "-C",
      path.join(fake, "hooks"),
      "patch",
      "--file",
      "pre-commit",
      "--old",
      "#",
      "--new",
      "X",
      "--dry-run",
    ]);
    expect(hooks.out).toMatchObject({
      status: "usage_error",
      reason: "git_dir",
    });
  });

  it("a commondir naming a path through a symlink and then .. is resolved as git does, symlink first", () => {
    const base = tmpDir();
    fs.mkdirSync(path.join(base, "deep", "real"), { recursive: true });
    fs.mkdirSync(path.join(base, "deep", "repo.git", "objects"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(base, "deep", "repo.git", "refs"));
    fs.symlinkSync(path.join("deep", "real"), path.join(base, "lnk"));
    const admin = path.join(base, "admin");
    fs.mkdirSync(admin);
    fs.writeFileSync(path.join(admin, "HEAD"), "ref: refs/heads/main\n");
    // Read lexically this is <base>/repo.git, which does not exist; git
    // follows lnk to deep/real first and lands on deep/repo.git.
    fs.writeFileSync(path.join(admin, "commondir"), "../lnk/../repo.git\n");
    fs.writeFileSync(path.join(admin, "config"), "[core]\n");
    const { code, out } = editConfig(admin);
    expect(code).toBe(2);
    expect(out).toMatchObject({ status: "usage_error", reason: "git_dir" });
    expect(out.edits[0].detail).toContain("looks like a git directory");
    expect(read(admin, "config")).toBe("[core]\n");
  });

  it("a root's .git grants its own repository only when git would open it, so a crafted one passes over nothing", () => {
    /** Runs a dry-run edit with `-C <p>/x`, where `x` holds `a.txt` and
     * a `.git` that `make` builds, inside the git directory `p`. */
    function inside(
      p: string,
      make: (dotGit: string) => void,
      env: NodeJS.ProcessEnv = {},
    ): PatchJson {
      const x = path.join(p, "x");
      fs.mkdirSync(x);
      fs.writeFileSync(path.join(x, "a.txt"), "a\n");
      make(path.join(x, ".git"));
      return cliWithoutGit(
        [
          "-C",
          x,
          "patch",
          "--file",
          "a.txt",
          "--old",
          "a",
          "--new",
          "b",
          "--dry-run",
        ],
        env,
      ).out;
    }
    /** A `.git` directory holding `HEAD` and `commondir`, as a linked
     * worktree's administrative directory does. */
    const adminLike =
      (head: string, commondir: string) =>
      (dotGit: string): void => {
        fs.mkdirSync(dotGit);
        fs.writeFileSync(path.join(dotGit, "HEAD"), head);
        fs.writeFileSync(path.join(dotGit, "commondir"), commondir);
      };
    const ref = "ref: refs/heads/main\n";
    // The control: a .git git opens, whose common directory is the git
    // directory around it, makes x a work tree inside its own repository.
    expect(inside(gitLike(), adminLike(ref, "../..\n")).status).toBe(
      "would_write",
    );
    // A form feed after `ref:` is no whitespace to git.
    expect(
      inside(gitLike(), adminLike("ref:\frefs/heads/main\n", "../..\n")).reason,
      "form feed in HEAD",
    ).toBe("git_dir");
    // `refs` a plain file git cannot search.
    const plainRefs = gitLike({ refs: false });
    fs.writeFileSync(path.join(plainRefs, "refs"), "x\n");
    expect(
      inside(plainRefs, adminLike(ref, "../..\n")).reason,
      "refs is a plain file",
    ).toBe("git_dir");
    // A commondir through a dangling symlink, which git cannot resolve
    // (read lexically it names the git directory around x).
    expect(
      inside(gitLike(), (dotGit) => {
        adminLike(ref, "../dangling/../..\n")(dotGit);
        fs.symlinkSync("nowhere", path.join(path.dirname(dotGit), "dangling"));
      }).reason,
      "commondir through a dangling symlink",
    ).toBe("git_dir");
    // A directory that is a git directory only by the caller's
    // GIT_COMMON_DIR: refused, and never the root's own.
    expect(
      inside(
        gitLike({ objects: false, refs: false }),
        adminLike(ref, "../..\n"),
        {
          GIT_COMMON_DIR: gitLike(),
        },
      ).reason,
      "common directory by GIT_COMMON_DIR only",
    ).toBe("git_dir");
    // A .git file naming the git directory around x, whose commondir file
    // is empty: git stops there.
    const emptyCommon = gitLike();
    fs.writeFileSync(path.join(emptyCommon, "commondir"), "");
    expect(
      inside(emptyCommon, (dotGit) => {
        fs.writeFileSync(dotGit, "gitdir: ..\n");
      }).reason,
      "empty commondir",
    ).toBe("git_dir");
    // A .git file naming a directory without HEAD.
    expect(
      inside(gitLike(), (dotGit) => {
        const adm = path.join(path.dirname(dotGit), "adm");
        fs.mkdirSync(adm);
        fs.writeFileSync(path.join(adm, "commondir"), "../..\n");
        fs.writeFileSync(dotGit, "gitdir: adm\n");
      }).reason,
      "gitdir naming no git directory",
    ).toBe("git_dir");
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "a FIFO in a directory above the target is read without waiting",
    () => {
      for (const fifo of ["HEAD", "commondir"]) {
        const base = tmpDir();
        if (fifo === "commondir") {
          fs.writeFileSync(path.join(base, "HEAD"), "ref: refs/heads/main\n");
        }
        execFileSync("mkfifo", [path.join(base, fifo)]);
        const dir = path.join(base, "w");
        fs.mkdirSync(dir);
        gitIn(dir, "init", "-q");
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        const res = spawnSync(
          process.execPath,
          [
            CLI_PATH,
            "-C",
            dir,
            "--json",
            "patch",
            "--file",
            "a.txt",
            "--old",
            "a",
            "--new",
            "b",
            "--dry-run",
          ],
          {
            env: { PATH: path.join(base, "no-git-bin") },
            encoding: "utf8",
            // A CLI stuck in a blocking open of the FIFO cannot act on
            // SIGTERM, so a stall is ended with SIGKILL and fails here.
            timeout: 20000,
            killSignal: "SIGKILL",
          },
        );
        expect(res.signal, fifo).toBeNull();
        expect(JSON.parse(res.stdout), fifo).toMatchObject({
          status: "would_write",
        });
      }
    },
    60_000,
  );
});

describe("patch: every directory above a target is checked, up to the filesystem root", () => {
  it("refuses -C <repo>/.git/hooks and -C <bare>/hooks made a repository of their own by git init, also as a dry run", () => {
    const { base, src } = committedSource();
    gitIn(base, "clone", "-q", src, "n1");
    gitIn(base, "clone", "-q", "--bare", src, "b1.git");
    for (const gitDir of [
      path.join(base, "n1", ".git"),
      path.join(base, "b1.git"),
    ]) {
      addHook(gitDir);
      const hooks = path.join(gitDir, "hooks");
      gitIn(hooks, "init", "-q");
      for (const dryRun of [false, true]) {
        const r = run(hooks, [{ file: "pre-commit", old: "#", new: "X" }], {
          dryRun,
        });
        expect(r.status, gitDir).toBe("usage_error");
        expect(r.reason, gitDir).toBe("git_dir");
        expect(r.edits[0].detail, gitDir).toContain(
          `is inside ${gitDir}, which looks like a git directory`,
        );
      }
      expect(read(hooks, "pre-commit")).toBe("#!/bin/sh\n");
    }
  });

  it("refuses a work tree of a repository that is one of git's own directories in it", () => {
    const { base, src } = committedSource();
    // <repo>/.git/hooks/.git naming the git directory around it: git
    // takes hooks as a work tree of that repository.
    gitIn(base, "clone", "-q", src, "n1");
    const gitDir = path.join(base, "n1", ".git");
    addHook(gitDir);
    fs.writeFileSync(path.join(gitDir, "hooks", ".git"), "gitdir: ..\n");
    const viaGitfile = run(path.join(gitDir, "hooks"), [
      { file: "pre-commit", old: "#", new: "X" },
    ]);
    expect(viaGitfile.status).toBe("usage_error");
    expect(viaGitfile.reason).toBe("git_dir");
    expect(read(gitDir, "hooks/pre-commit")).toBe("#!/bin/sh\n");
    // A linked worktree checked out as a bare repository's hooks.
    gitIn(base, "clone", "-q", "--bare", src, "b1.git");
    const bare = path.join(base, "b1.git");
    fs.rmSync(path.join(bare, "hooks"), { recursive: true });
    gitIn(bare, "worktree", "add", "-q", "hooks");
    const linked = run(path.join(bare, "hooks"), [
      { file: "a.txt", old: "a", new: "b" },
    ]);
    expect(linked.status).toBe("usage_error");
    expect(linked.reason).toBe("git_dir");
    expect(read(bare, "hooks/a.txt")).toBe("a\n");
  });

  it("edits a work tree inside its own repository from -C below its root, and a linked worktree inside a .git directory", () => {
    const { main } = workTreeInsideBare();
    fs.mkdirSync(path.join(main, "sub"));
    fs.writeFileSync(path.join(main, "sub", "q.txt"), "q\n");
    const sub = run(path.join(main, "sub"), [
      { file: "q.txt", old: "q", new: "r" },
    ]);
    expect(sub.status).toBe("written");
    expect(sub.warnings).toEqual([]);
    expect(read(main, "sub/q.txt")).toBe("r\n");
    const { base, src } = committedSource();
    gitIn(base, "clone", "-q", src, "n2");
    const n2 = path.join(base, "n2");
    gitIn(n2, "worktree", "add", "-q", path.join(".git", "wt"));
    const wt = path.join(n2, ".git", "wt");
    const inGitDir = run(wt, [{ file: "a.txt", old: "a", new: "b" }]);
    expect(inGitDir.status).toBe("written");
    expect(inGitDir.warnings).toEqual([]);
    // Its repository's own files stay refused from there.
    const config = run(wt, [{ file: "../config", old: "[core]", new: "[x]" }], {
      allowOutside: true,
    });
    expect(config.reason).toBe("git_dir");
  });

  it("an empty .git directory, or one holding only a commondir file, makes no work tree: the repository around it is refused", () => {
    const { base, src } = committedSource();
    gitIn(base, "clone", "-q", "--bare", src, "b.git");
    const bare = path.join(base, "b.git");
    addHook(bare);
    fs.mkdirSync(path.join(bare, "hooks", ".git"));
    for (const dryRun of [false, true]) {
      const empty = run(
        path.join(bare, "hooks"),
        [{ file: "pre-commit", old: "#", new: "X" }],
        { dryRun },
      );
      expect(empty.status).toBe("usage_error");
      expect(empty.reason).toBe("git_dir");
    }
    // A .git directory whose commondir names the repository, without a
    // HEAD: git does not open it (it names the repository around it).
    const sub = path.join(bare, "sub");
    fs.mkdirSync(path.join(sub, ".git"), { recursive: true });
    fs.writeFileSync(path.join(sub, ".git", "commondir"), "../..\n");
    fs.writeFileSync(path.join(sub, "s.txt"), "s\n");
    const named = run(sub, [{ file: "s.txt", old: "s", new: "t" }]);
    expect(named.status).toBe("usage_error");
    expect(named.reason).toBe("git_dir");
    expect(read(bare, "hooks/pre-commit")).toBe("#!/bin/sh\n");
    expect(read(sub, "s.txt")).toBe("s\n");
  });

  it("a .git file with an empty gitdir path makes no work tree: the repository around it is refused", () => {
    const { base, src } = committedSource();
    gitIn(base, "clone", "-q", "--bare", src, "b.git");
    const x = path.join(base, "b.git", "x");
    fs.mkdirSync(x);
    fs.writeFileSync(path.join(x, ".git"), "gitdir: \n");
    // Next to a commondir file naming the repository: an empty gitdir
    // must not be read as naming x itself.
    fs.writeFileSync(path.join(x, "commondir"), "..\n");
    fs.writeFileSync(path.join(x, "x.txt"), "x\n");
    const r = run(x, [{ file: "x.txt", old: "x", new: "y" }]);
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("git_dir");
    expect(read(x, "x.txt")).toBe("x\n");
  });

  it("refuses a work-tree root that is itself laid out like a git directory", () => {
    const dir = repo({ "a.txt": "a\n" });
    fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(dir, "objects"));
    fs.mkdirSync(path.join(dir, "refs"));
    const r = run(dir, [{ file: "a.txt", old: "a", new: "b" }]);
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("git_dir");
    expect(r.edits[0].detail).toContain(
      `is inside ${dir}, which looks like a git directory`,
    );
    expect(read(dir, "a.txt")).toBe("a\n");
  });

  it("a caller's GIT_COMMON_DIR does not reach git's identity lookup", async () => {
    const dir = repo({ "a.txt": "a\n" });
    const { code, out } = await cliWithGit(
      [
        "-C",
        dir,
        "patch",
        "--file",
        "a.txt",
        "--old",
        "a",
        "--new",
        "b",
        "--dry-run",
      ],
      { GIT_COMMON_DIR: "/nonexistent" },
    );
    expect(code).toBe(0);
    expect(out).toMatchObject({ status: "would_write", warnings: [] });
  });

  it("refuses a common directory git names by its identity even when its HEAD is broken", () => {
    const { bare, wt } = bareRepoWithWorktree();
    fs.writeFileSync(path.join(bare, "HEAD"), "garbage\n");
    const config = read(bare, "config");
    const r = run(
      wt,
      [{ file: "../repo.git/config", old: "[core]", new: "[x]" }],
      { allowOutside: true },
    );
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("git_dir");
    expect(r.edits[0].detail).toContain("which git names");
    expect(r.warnings).toEqual([]);
    expect(read(bare, "config")).toBe(config);
  });

  it("takes the pieces of a git directory name with a line break only where they are laid out like one, and warns", () => {
    const base = tmpDir();
    const wt = path.join(base, "wt");
    fs.mkdirSync(wt);
    const gitDir = path.join(base, "g\nd");
    gitIn(wt, "init", "-q", "--separate-git-dir", gitDir, ".");
    // Git's answer reads as <base>/g and d (relative to the root), twice.
    fs.mkdirSync(path.join(base, "g"));
    fs.writeFileSync(path.join(base, "g", "y.txt"), "y\n");
    fs.mkdirSync(path.join(wt, "d"));
    fs.writeFileSync(path.join(wt, "d", "x.txt"), "x\n");
    const inTree = run(wt, [{ file: "d/x.txt", old: "x", new: "z" }], {
      dryRun: true,
    });
    expect(inTree.status).toBe("would_write");
    expect(inTree.warnings.join("\n")).toContain("line break in its name");
    expect(inTree.warnings.join("\n")).toContain(
      "which is not laid out like a git directory",
    );
    const sibling = run(wt, [{ file: "../g/y.txt", old: "y", new: "z" }], {
      dryRun: true,
      allowOutside: true,
    });
    expect(sibling.status).toBe("would_write");
    const config = read(gitDir, "config");
    const inGitDir = run(
      wt,
      [{ file: "../g\nd/config", old: "[core]", new: "[x]" }],
      { allowOutside: true },
    );
    expect(inGitDir.status).toBe("usage_error");
    expect(inGitDir.reason).toBe("git_dir");
    expect(read(gitDir, "config")).toBe(config);
  });
});

/** The built `patch` module, run by `patchInChild`. */
const DIST_PATCH_URL = pathToFileURL(
  path.join(path.dirname(CLI_PATH), "patch", "index.js"),
).href;

const CHILD_PATCH_SCRIPT = [
  "const [url, json] = process.argv.slice(1);",
  "const { patch } = await import(url);",
  "process.stdout.write(JSON.stringify(patch(JSON.parse(json))));",
].join("\n");

/** git on PATH with no global or system configuration. */
const GIT_CHILD_ENV: NodeJS.ProcessEnv = {
  ...gitEnv,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

interface ChildPatchRun {
  out: PatchJson;
  ms: number;
}

/**
 * Runs `patch` from the built package in a child node process with a
 * process group of its own, for layouts where git (or a check that
 * regressed) could wait forever: a run still going after `limitMs` is
 * ended by SIGKILL to that whole group and fails the test. git started by
 * patch runs in a group of its own; what a regressed bound would leave
 * behind there is released by the caller (`releaseFifo`, `killRecorded`).
 * The group is not killed after a normal exit, so that a test can see
 * what patch itself left running.
 */
async function patchInChild(
  options: {
    cwd: string;
    edits: PatchEditSpec[];
    dryRun?: boolean;
    allowOutside?: boolean;
    gitTimeoutMs?: number;
  },
  env: NodeJS.ProcessEnv,
  limitMs = 30_000,
): Promise<ChildPatchRun> {
  const start = Date.now();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      CHILD_PATCH_SCRIPT,
      DIST_PATCH_URL,
      JSON.stringify(options),
    ],
    { env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const killGroup = (): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is gone.
    }
  };
  let stalled = false;
  const timer = setTimeout(() => {
    stalled = true;
    killGroup();
  }, limitMs);
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  clearTimeout(timer);
  const ms = Date.now() - start;
  if (stalled)
    throw new Error(`patch did not return within ${String(limitMs)} ms`);
  if (stdout === "") throw new Error(`patch printed nothing: ${stderr}`);
  return { out: JSON.parse(stdout) as PatchJson, ms };
}

/** Opens a FIFO for writing without waiting and closes it, so that a
 * process blocked opening it for reading goes on (and reads EOF). */
function releaseFifo(fifo: string): void {
  try {
    fs.closeSync(
      fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK),
    );
  } catch {
    // Gone already.
  }
}

/** A directory laid out like a git directory (HEAD, objects, refs). */
function gitDirLayout(dir: string): string {
  fs.mkdirSync(path.join(dir, "objects"), { recursive: true });
  fs.mkdirSync(path.join(dir, "refs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

/**
 * A work tree `w` whose `.git` file names its git directory by a path
 * that reaches `g` only after a symlink and a `..`, in one of three
 * forms: `link/../g` relative to `w`, the same absolute, or an absolute
 * path through a symlinked directory above `w` (`<base>/alias/../g`).
 * git lets the filesystem resolve the path (the symlink first, then the
 * `..`), which lands on the physical `g`; read lexically the path names
 * a decoy next to it, laid out like a git directory with a harmless
 * `commondir`, so a check that folds the `..` sees nothing there.
 */
function gitfileThroughSymlink(form: "relative" | "absolute" | "ancestor"): {
  root: string;
  physical: string;
} {
  const base = tmpDir();
  const w = path.join(base, "w");
  fs.mkdirSync(w);
  fs.writeFileSync(path.join(w, "a.txt"), "a\n");
  const elsewhere = path.join(base, "elsewhere");
  fs.mkdirSync(path.join(elsewhere, "deep"), { recursive: true });
  const physical = gitDirLayout(path.join(elsewhere, "g"));
  let gitdir: string;
  let decoy: string;
  if (form === "ancestor") {
    fs.symlinkSync(path.join(elsewhere, "deep"), path.join(base, "alias"));
    gitdir = `${base}/alias/../g`;
    decoy = gitDirLayout(path.join(base, "g"));
  } else {
    fs.symlinkSync(path.join(elsewhere, "deep"), path.join(w, "link"));
    gitdir = form === "relative" ? "link/../g" : `${w}/link/../g`;
    decoy = gitDirLayout(path.join(w, "g"));
  }
  fs.writeFileSync(path.join(decoy, "commondir"), ".\n");
  fs.writeFileSync(path.join(w, ".git"), `gitdir: ${gitdir}\n`);
  return { root: w, physical };
}

const GITFILE_FORMS = ["relative", "absolute", "ancestor"] as const;

/** git's own directories in a git directory, as patch reserves them. */
const RESERVED_GIT_SUBDIRS = [
  "objects",
  "refs",
  "hooks",
  "info",
  "logs",
  "worktrees",
  "modules",
  "branches",
  "remotes",
  "rr-cache",
  "reftable",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
];

/** Whether this filesystem finds `hooks` as `hook` + U+017F (as
 * case-insensitive APFS does); a case-sensitive one (Linux CI) does not. */
function filesystemFoldsLongS(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-fold-"));
  try {
    fs.mkdirSync(path.join(dir, "hookſ"));
    const folded = fs.statSync(path.join(dir, "hookſ"));
    const ascii = fs.statSync(path.join(dir, "hooks"));
    return folded.dev === ascii.dev && folded.ino === ascii.ino;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether a hard link of a symlink is a link to the symlink itself (as
 * on Linux), not refused or made to its target (as on macOS). */
function hardLinksSymlinks(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-ln-"));
  try {
    fs.mkdirSync(path.join(dir, "d"));
    fs.symlinkSync("d", path.join(dir, "s"));
    fs.linkSync(path.join(dir, "s"), path.join(dir, "h"));
    const s = fs.lstatSync(path.join(dir, "s"));
    const h = fs.lstatSync(path.join(dir, "h"));
    return h.isSymbolicLink() && s.ino === h.ino;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LONG_S_FOLDS = filesystemFoldsLongS();
const HARD_LINKS_SYMLINKS = hardLinksSymlinks();

describe("patch: git's own directories and .git are found by the filesystem, under any spelling", () => {
  it("refuses -C in each of git's own directories made a work tree of its repository by a .git file, in either letter case", async () => {
    const { base, src } = committedSource();
    gitIn(base, "clone", "-q", src, "n1");
    const gitDir = path.join(base, "n1", ".git");
    for (const [i, name] of RESERVED_GIT_SUBDIRS.entries()) {
      // Every other name with a capital first letter: the same directory
      // on a case-insensitive filesystem, another one on Linux.
      const spelling =
        i % 2 === 0 ? name : `${name[0].toUpperCase()}${name.slice(1)}`;
      const dir = path.join(gitDir, spelling);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".git"), "gitdir: ..\n");
      fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
      const { out } = await patchInChild(
        { cwd: dir, edits: [{ file: "x.txt", old: "x", new: "y" }] },
        GIT_CHILD_ENV,
      );
      expect(out.status, spelling).toBe("usage_error");
      expect(out.reason, spelling).toBe("git_dir");
      expect(read(dir, "x.txt"), spelling).toBe("x\n");
    }
  }, 120_000);

  it.skipIf(!LONG_S_FOLDS)(
    "refuses a work tree whose name the filesystem folds to hooks (U+017F), as a worktree of its bare repository and by a .git file",
    async () => {
      const longS = "hookſ";
      const { base, src } = committedSource();
      gitIn(base, "init", "-q", "--bare", "--template=", "b.git");
      const bare = path.join(base, "b.git");
      gitIn(bare, "fetch", "-q", src, "+refs/heads/*:refs/heads/*");
      const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: src,
        encoding: "utf8",
      }).trim();
      gitIn(bare, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
      gitIn(bare, "worktree", "add", "-q", "-f", longS, branch);
      // As stored, and typed in ASCII.
      for (const spelling of [longS, "hooks"]) {
        const { out } = await patchInChild(
          {
            cwd: path.join(bare, spelling),
            edits: [{ file: "a.txt", old: "a", new: "b" }],
          },
          GIT_CHILD_ENV,
        );
        expect(out.reason, spelling).toBe("git_dir");
      }
      expect(read(bare, `${longS}/a.txt`)).toBe("a\n");
      // A worktree nested in that directory: its root lies below it.
      const nested = path.join(bare, longS, "wt");
      gitIn(bare, "worktree", "add", "-q", "-b", "wt", nested, branch);
      const below = await patchInChild(
        { cwd: nested, edits: [{ file: "a.txt", old: "a", new: "b" }] },
        GIT_CHILD_ENV,
      );
      expect(below.out.reason).toBe("git_dir");
      expect(read(nested, "a.txt")).toBe("a\n");
      gitIn(base, "clone", "-q", src, "n1");
      const gitDir = path.join(base, "n1", ".git");
      fs.rmSync(path.join(gitDir, "hooks"), { recursive: true, force: true });
      fs.mkdirSync(path.join(gitDir, longS));
      fs.writeFileSync(path.join(gitDir, longS, ".git"), "gitdir: ..\n");
      fs.writeFileSync(path.join(gitDir, longS, "pre-commit"), "#!/bin/sh\n");
      const { out } = await patchInChild(
        {
          cwd: path.join(gitDir, longS),
          edits: [{ file: "pre-commit", old: "#", new: "X" }],
        },
        GIT_CHILD_ENV,
      );
      expect(out.reason).toBe("git_dir");
      expect(read(gitDir, "hooks/pre-commit")).toBe("#!/bin/sh\n");
    },
    60_000,
  );

  it("refuses a work tree inside its own bare repository when that repository's hooks is a symlink to it or to a directory above it", async () => {
    const { bare, main } = workTreeInsideBare();
    gitIn(bare, "worktree", "add", "-q", "-b", "w2", path.join("nest", "w2"));
    const nested = path.join(bare, "nest", "w2");
    fs.rmSync(path.join(bare, "hooks"), { recursive: true });
    for (const [target, root] of [
      ["main", main],
      ["nest", nested],
    ]) {
      fs.rmSync(path.join(bare, "hooks"), { force: true });
      fs.symlinkSync(target, path.join(bare, "hooks"));
      const { out } = await patchInChild(
        { cwd: root, edits: [{ file: "a.txt", old: "a", new: "b" }] },
        GIT_CHILD_ENV,
      );
      expect(out.status, target).toBe("usage_error");
      expect(out.reason, target).toBe("git_dir");
      expect(read(root, "a.txt"), target).toBe("a\n");
    }
  });

  it("refuses a hard link of a .git file, also through a symlink to it, as the entry the filesystem finds as .git", () => {
    const dir = tmpDir();
    gitIn(dir, "init", "-q", "--separate-git-dir", "gd", ".");
    fs.linkSync(path.join(dir, ".git"), path.join(dir, "alias"));
    fs.symlinkSync("alias", path.join(dir, "via-symlink"));
    const before = read(dir, ".git");
    for (const file of ["alias", "via-symlink"]) {
      const r = run(dir, [{ file, old: "gitdir", new: "x" }], {
        breakHardLinks: true,
      });
      expect(r.reason, file).toBe("git_dir");
      expect(r.edits[0].detail, file).toContain("has a .git path component");
    }
    expect(read(dir, ".git")).toBe(before);
  });

  it.skipIf(!HARD_LINKS_SYMLINKS)(
    "refuses a path through a hard link of a .git symlink as a .git path component",
    () => {
      const base = tmpDir();
      gitIn(base, "init", "-q", "--bare", "gd");
      const wt = path.join(base, "wt");
      fs.mkdirSync(wt);
      fs.symlinkSync(path.join(base, "gd"), path.join(wt, ".git"));
      fs.linkSync(path.join(wt, ".git"), path.join(wt, "alias"));
      const config = read(base, "gd/config");
      const r = run(wt, [{ file: "alias/config", old: "[core]", new: "[x]" }], {
        allowOutside: true,
      });
      expect(r.reason).toBe("git_dir");
      expect(r.edits[0].detail).toContain("has a .git path component");
      expect(read(base, "gd/config")).toBe(config);
    },
  );
});

describe("patch: git's identity lookup is bounded", () => {
  const NO_GIT_ENV = (): NodeJS.ProcessEnv => ({
    PATH: path.join(tmpDir(), "no-git-bin"),
  });
  const notRun =
    "the git directory check by identity was skipped (git was not run: ";

  it.skipIf(process.platform === "win32")(
    "does not run git when its discovery would read a commondir that is no small regular file",
    async () => {
      // Without git on PATH: a check that regressed reports git missing.
      const zero = repo({ "a.txt": "a\n" });
      fs.symlinkSync("/dev/zero", path.join(zero, ".git", "commondir"));
      const big = repo({ "a.txt": "a\n" });
      const bigFile = path.join(big, ".git", "commondir");
      fs.writeFileSync(bigFile, "");
      fs.truncateSync(bigFile, 128 * 1024);
      // A .git file naming a git directory with a FIFO commondir, its path
      // followed by line breaks past 64 KiB (git drops them).
      const padded = tmpDir();
      const g1 = gitDirLayout(path.join(padded, "g"));
      execFileSync("mkfifo", [path.join(g1, "commondir")]);
      const w1 = path.join(padded, "w");
      fs.mkdirSync(w1);
      fs.writeFileSync(
        path.join(w1, ".git"),
        `gitdir: ../g${"\n".repeat(100 * 1024)}`,
      );
      fs.writeFileSync(path.join(w1, "a.txt"), "a\n");
      // A .git file whose path ends at a NUL: git reads it as naming the
      // file's own directory.
      const nul = gitDirLayout(path.join(tmpDir(), "n"));
      execFileSync("mkfifo", [path.join(nul, "commondir")]);
      fs.writeFileSync(path.join(nul, ".git"), "gitdir: \0junk\n");
      fs.writeFileSync(path.join(nul, "a.txt"), "a\n");
      // A .git file whose path is not UTF-8.
      const bytes = tmpDir();
      fs.writeFileSync(
        path.join(bytes, ".git"),
        Buffer.concat([Buffer.from("gitdir: "), Buffer.from([0xff, 0xfe])]),
      );
      fs.writeFileSync(path.join(bytes, "a.txt"), "a\n");
      const cases: [string, string, string][] = [
        [zero, "commondir whole, and it is not a regular file", "/dev/zero"],
        [big, "commondir whole, and it holds 131072 bytes", "sparse"],
        [w1, "commondir whole, and it is not a regular file", "padded"],
        [nul, "commondir whole, and it is not a regular file", "nul"],
        [bytes, "by a path that is not UTF-8", "not utf-8"],
      ];
      for (const [cwd, why, label] of cases) {
        const { out } = await patchInChild(
          {
            cwd,
            edits: [{ file: "a.txt", old: "a", new: "b" }],
            dryRun: true,
          },
          NO_GIT_ENV(),
        );
        expect(out.warnings.join("\n"), label).toContain(notRun);
        expect(out.warnings.join("\n"), label).toContain(why);
      }
      releaseFifo(path.join(g1, "commondir"));
      releaseFifo(path.join(nul, "commondir"));
    },
    60_000,
  );

  it.skipIf(process.platform === "win32")(
    "does not run git when a FIFO commondir is in a .git file's git directory or in a bare repository above the root, also past a .git FIFO or symlink loop",
    async () => {
      const viaGitfile = tmpDir();
      const g = gitDirLayout(path.join(viaGitfile, "g"));
      execFileSync("mkfifo", [path.join(g, "commondir")]);
      const w = path.join(viaGitfile, "w");
      fs.mkdirSync(w);
      fs.writeFileSync(path.join(w, ".git"), "gitdir: ../g\n");
      fs.writeFileSync(path.join(w, "a.txt"), "a\n");
      const above = gitDirLayout(path.join(tmpDir(), "z"));
      execFileSync("mkfifo", [path.join(above, "commondir")]);
      const below = path.join(above, "w");
      fs.mkdirSync(below);
      fs.writeFileSync(path.join(below, "a.txt"), "a\n");
      // A .git that is neither a file nor a directory: git 2.39 looks
      // further up past it (newer git stops there with an error).
      const pastFifo = path.join(above, "f");
      fs.mkdirSync(pastFifo);
      execFileSync("mkfifo", [path.join(pastFifo, ".git")]);
      fs.writeFileSync(path.join(pastFifo, "a.txt"), "a\n");
      // A .git that cannot be stated (a symlink loop): git 2.39 goes on.
      const pastLoop = path.join(above, "l");
      fs.mkdirSync(pastLoop);
      fs.symlinkSync(".git", path.join(pastLoop, ".git"));
      fs.writeFileSync(path.join(pastLoop, "a.txt"), "a\n");
      try {
        for (const cwd of [w, below, pastFifo, pastLoop]) {
          const { out } = await patchInChild(
            {
              cwd,
              edits: [{ file: "a.txt", old: "a", new: "b" }],
              dryRun: true,
              gitTimeoutMs: 3000,
            },
            GIT_CHILD_ENV,
          );
          expect(out.warnings.join("\n"), cwd).toContain(notRun);
          expect(out.warnings.join("\n"), cwd).toContain(
            "commondir whole, and it is not a regular file",
          );
        }
      } finally {
        releaseFifo(path.join(g, "commondir"));
        releaseFifo(path.join(above, "commondir"));
        releaseFifo(path.join(pastFifo, ".git"));
      }
    },
    90_000,
  );

  it.skipIf(process.platform === "win32")(
    "looks no further up than git's discovery goes: a .git directory, a .git file, a bare repository",
    async () => {
      const cases: [string, (dir: string) => void][] = [
        ["git dir", (dir) => gitIn(dir, "init", "-q")],
        [
          "git file",
          (dir) => {
            gitIn(path.dirname(dir), "init", "-q", "--bare", "sep.git");
            fs.writeFileSync(path.join(dir, ".git"), "gitdir: ../sep.git\n");
          },
        ],
        ["bare", (dir) => gitDirLayout(dir)],
      ];
      for (const [label, make] of cases) {
        // A parent laid out like a git directory with a FIFO commondir:
        // git never gets there, so neither does the check. The FIFO is
        // made last, after every git command of the setup.
        const parent = gitDirLayout(path.join(tmpDir(), "p"));
        const dir = path.join(parent, "r");
        fs.mkdirSync(dir);
        make(dir);
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        const fifo = path.join(parent, "commondir");
        execFileSync("mkfifo", [fifo]);
        try {
          const { out } = await patchInChild(
            {
              cwd: dir,
              edits: [{ file: "a.txt", old: "a", new: "b" }],
              dryRun: true,
              gitTimeoutMs: 3000,
            },
            GIT_CHILD_ENV,
          );
          expect(out.warnings.join("\n"), label).not.toContain(notRun);
          expect(out.warnings.join("\n"), label).not.toContain(
            "did not finish",
          );
        } finally {
          releaseFifo(fifo);
        }
      }
    },
    120_000,
  );

  it.skipIf(process.platform === "win32")(
    "resolves a .git file's gitdir path as git does, the symlink before the .., and does not run git for a FIFO commondir only the physical target holds",
    async () => {
      const fifos: string[] = [];
      try {
        for (const form of GITFILE_FORMS) {
          const { root, physical } = gitfileThroughSymlink(form);
          const fifo = path.join(physical, "commondir");
          execFileSync("mkfifo", [fifo]);
          fifos.push(fifo);
          const { out } = await patchInChild(
            {
              cwd: root,
              edits: [{ file: "a.txt", old: "a", new: "b" }],
              dryRun: true,
              gitTimeoutMs: 3000,
            },
            GIT_CHILD_ENV,
          );
          expect(out.warnings.join("\n"), form).toContain(notRun);
          expect(out.warnings.join("\n"), form).toContain(
            `git would read ${fifo} whole, and it is not a regular file`,
          );
        }
      } finally {
        for (const fifo of fifos) releaseFifo(fifo);
      }
    },
    90_000,
  );

  it("resolves a .git file's gitdir path as git does and does not run git for a sparse commondir only the physical target holds (no git on PATH)", async () => {
    for (const form of GITFILE_FORMS) {
      const { root, physical } = gitfileThroughSymlink(form);
      const sparse = path.join(physical, "commondir");
      fs.writeFileSync(sparse, "");
      fs.truncateSync(sparse, 128 * 1024);
      const { out } = await patchInChild(
        {
          cwd: root,
          edits: [{ file: "a.txt", old: "a", new: "b" }],
          dryRun: true,
        },
        NO_GIT_ENV(),
      );
      expect(out.warnings.join("\n"), form).toContain(notRun);
      expect(out.warnings.join("\n"), form).toContain(
        `git would read ${sparse} whole, and it holds 131072 bytes`,
      );
    }
  }, 60_000);

  it("grants the root's own git directory through a gitdir path the filesystem resolves to the repository around the root", async () => {
    // `w/.git` names `link/..` with `w/link` a symlink to `p/objects`:
    // for git, `w` is a work tree of `p`. Read lexically, `link/..` is
    // `w` itself, which is no git directory, and `p` would be refused.
    const p = gitDirLayout(path.join(tmpDir(), "p"));
    const w = path.join(p, "w");
    fs.mkdirSync(w);
    fs.symlinkSync(path.join(p, "objects"), path.join(w, "link"));
    fs.writeFileSync(path.join(w, ".git"), "gitdir: link/..\n");
    fs.writeFileSync(path.join(w, "a.txt"), "a\n");
    for (const [label, env] of [
      ["git", GIT_CHILD_ENV],
      ["no git", NO_GIT_ENV()],
    ] as const) {
      const { out } = await patchInChild(
        {
          cwd: w,
          edits: [{ file: "a.txt", old: "a", new: "b" }],
          dryRun: true,
        },
        env,
      );
      expect(out.status, label).toBe("would_write");
      // The repository's own files stay refused from there.
      const head = await patchInChild(
        {
          cwd: w,
          edits: [{ file: "../HEAD", old: "ref", new: "x" }],
          dryRun: true,
          allowOutside: true,
        },
        env,
      );
      expect(head.out.status, label).toBe("usage_error");
      expect(head.out.reason, label).toBe("git_dir");
    }
    expect(read(p, "HEAD")).toBe("ref: refs/heads/main\n");
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "reads an empty gitdir path as git does: git stops at the .git file, so a FIFO commondir beside it is never a hazard and git runs",
    async () => {
      const x = tmpDir();
      fs.writeFileSync(path.join(x, ".git"), "gitdir: \n");
      fs.writeFileSync(path.join(x, "a.txt"), "a\n");
      const fifo = path.join(x, "commondir");
      execFileSync("mkfifo", [fifo]);
      try {
        const { out } = await patchInChild(
          {
            cwd: x,
            edits: [{ file: "a.txt", old: "a", new: "b" }],
            dryRun: true,
            gitTimeoutMs: 3000,
          },
          GIT_CHILD_ENV,
        );
        expect(out.status).toBe("would_write");
        expect(out.warnings.join("\n")).toContain(
          "the git directory check by identity was skipped (git rev-parse failed",
        );
        expect(out.warnings.join("\n")).not.toContain(notRun);
      } finally {
        releaseFifo(fifo);
      }
    },
    60_000,
  );

  it("reads the root's .git file up to git's 1 MiB limit: a padded gitdir path stays the root's own, a file past the limit names no git directory", async () => {
    // `p/w/.git` names `..`, so `p` is the root's own git directory. Line
    // breaks after the path do not count (git strips them), but git
    // refuses a .git file over 1 MiB, and then `p` is a git directory
    // above the root like any other.
    const p = gitDirLayout(path.join(tmpDir(), "p"));
    const w = path.join(p, "w");
    fs.mkdirSync(w);
    fs.writeFileSync(path.join(w, "a.txt"), "a\n");
    const cases = [
      ["exactly 1 MiB", 1024 * 1024, "would_write"],
      ["1 MiB and one byte", 1024 * 1024 + 1, "usage_error"],
    ] as const;
    for (const [size, bytes, status] of cases) {
      fs.writeFileSync(
        path.join(w, ".git"),
        "gitdir: ..\n" + "\n".repeat(bytes - "gitdir: ..\n".length),
      );
      for (const [label, env] of [
        ["git", GIT_CHILD_ENV],
        ["no git", NO_GIT_ENV()],
      ] as const) {
        const { out } = await patchInChild(
          {
            cwd: w,
            edits: [{ file: "a.txt", old: "a", new: "b" }],
            dryRun: true,
            gitTimeoutMs: 3000,
          },
          env,
        );
        expect(out.status, `${size}, ${label}`).toBe(status);
        if (status === "usage_error") {
          expect(out.reason, `${size}, ${label}`).toBe("git_dir");
        }
      }
    }
    expect(read(w, "a.txt")).toBe("a\n");
  }, 60_000);

  it("reads a commondir as git does: trailing line breaks dropped, then the path ends at a NUL", () => {
    // `D` has a HEAD and a commondir naming `../C`, which holds objects and
    // refs, so git opens `D` as a git directory. The bytes after the NUL
    // are not part of the path for git and must not hide `C` from the check.
    const root = repo({ "D/f.txt": "f\n" });
    fs.writeFileSync(path.join(root, "D", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(
      path.join(root, "D", "commondir"),
      Buffer.concat([
        Buffer.from("../C"),
        Buffer.from([0]),
        Buffer.from("junk\r\n"),
      ]),
    );
    fs.mkdirSync(path.join(root, "C", "objects"), { recursive: true });
    fs.mkdirSync(path.join(root, "C", "refs"), { recursive: true });
    const r = run(root, [{ file: "D/f.txt", old: "f", new: "g" }]);
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("git_dir");
    expect(read(root, "D/f.txt")).toBe("f\n");
  });

  it("strips a commondir's trailing line breaks before it cuts at the NUL, as git does", () => {
    // `../C\n\0junk`: the line break sits before the NUL, so it is part of
    // the path git reads (`C\n`, which does not exist): `D` is no git
    // directory, although `C` holds objects and refs.
    const root = repo({ "D/f.txt": "f\n" });
    fs.writeFileSync(path.join(root, "D", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(
      path.join(root, "D", "commondir"),
      Buffer.concat([
        Buffer.from("../C\n"),
        Buffer.from([0]),
        Buffer.from("junk"),
      ]),
    );
    fs.mkdirSync(path.join(root, "C", "objects"), { recursive: true });
    fs.mkdirSync(path.join(root, "C", "refs"), { recursive: true });
    const r = run(root, [{ file: "D/f.txt", old: "f", new: "g" }], {
      dryRun: true,
    });
    expect(r.status).toBe("would_write");
  });

  it.skipIf(process.platform === "win32")(
    "a caller's GIT_OBJECT_DIRECTORY does not reach git's identity lookup, so git's discovery ends where the check modelled it",
    async () => {
      // A repository under a parent holding a valid HEAD and a FIFO
      // commondir (no objects or refs, so the layout check does not
      // refuse it). With GIT_OBJECT_DIRECTORY naming a directory that
      // does not exist, git's test fails for every directory and its
      // discovery would walk past the repository into the parent, where
      // it reads commondir right after HEAD and would wait on the FIFO;
      // the variable is removed from git's environment, so git names the
      // repository and warns of nothing.
      const parent = path.join(tmpDir(), "p");
      fs.mkdirSync(parent);
      fs.writeFileSync(path.join(parent, "HEAD"), "ref: refs/heads/main\n");
      const dir = path.join(parent, "r");
      fs.mkdirSync(dir);
      gitIn(dir, "init", "-q");
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      const fifo = path.join(parent, "commondir");
      execFileSync("mkfifo", [fifo]);
      try {
        const { out } = await patchInChild(
          {
            cwd: dir,
            edits: [{ file: "a.txt", old: "a", new: "b" }],
            dryRun: true,
            gitTimeoutMs: 3000,
          },
          { ...GIT_CHILD_ENV, GIT_OBJECT_DIRECTORY: "/nonexistent" },
        );
        expect(out.status).toBe("would_write");
        expect(out.warnings).toEqual([]);
      } finally {
        releaseFifo(fifo);
      }
    },
    60_000,
  );

  it.skipIf(process.platform === "win32")(
    "stops git when it waits on a FIFO HEAD and warns, the name and layout checks still applying",
    async () => {
      const dir = repo({ "a.txt": "a\n" });
      const head = path.join(dir, ".git", "HEAD");
      fs.rmSync(head);
      execFileSync("mkfifo", [head]);
      try {
        const { out, ms } = await patchInChild(
          {
            cwd: dir,
            edits: [{ file: "a.txt", old: "a", new: "b" }],
            dryRun: true,
            gitTimeoutMs: 1000,
          },
          GIT_CHILD_ENV,
        );
        expect(out.status).toBe("would_write");
        expect(out.warnings.join("\n")).toContain(
          "the git directory check by identity was skipped (git rev-parse did not finish within 1000 ms and was stopped)",
        );
        expect(ms).toBeLessThan(20_000);
      } finally {
        releaseFifo(head);
      }
    },
    60_000,
  );

  describe.skipIf(process.platform === "win32")(
    "with a git that misbehaves",
    () => {
      /** A `git` on PATH that runs `body` (a POSIX sh script) and records
       * the PIDs it names in `pids`. */
      function fakeGit(body: string): { env: NodeJS.ProcessEnv; pids: string } {
        const bin = tmpDir();
        const pids = path.join(bin, "pids");
        fs.writeFileSync(
          path.join(bin, "git"),
          `#!/bin/sh\nPIDS='${pids}'\n${body}\n`,
          { mode: 0o755 },
        );
        return { env: { PATH: bin }, pids };
      }

      function recordedPids(file: string): number[] {
        if (!fs.existsSync(file)) return [];
        return fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map(Number);
      }

      /** Running: signal 0 reaches it and it is no zombie (killed, not
       * yet reaped by its new parent). When neither /proc nor `ps` can
       * tell, it counts as running. */
      function alive(pid: number): boolean {
        try {
          process.kill(pid, 0);
        } catch {
          return false;
        }
        try {
          const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
          return stat[stat.lastIndexOf(")") + 2] !== "Z";
        } catch {
          // No /proc (macOS): ask ps.
        }
        const ps = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
          encoding: "utf8",
        });
        if (ps.status !== 0) return true;
        return !ps.stdout.trim().startsWith("Z");
      }

      function killRecorded(file: string): void {
        for (const pid of recordedPids(file)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }

      it("ends git and everything in its process group after the timeout", async () => {
        const { env, pids } = fakeGit(
          'echo $$ >> "$PIDS"\n/bin/sleep 300 &\necho $! >> "$PIDS"\nexec /bin/sleep 300',
        );
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        try {
          const { out } = await patchInChild(
            {
              cwd: dir,
              edits: [{ file: "a.txt", old: "a", new: "b" }],
              dryRun: true,
              gitTimeoutMs: 1000,
            },
            env,
          );
          expect(out.warnings.join("\n")).toContain(
            "git rev-parse did not finish within 1000 ms and was stopped",
          );
          const recorded = recordedPids(pids);
          expect(recorded).toHaveLength(2);
          // A killed process can stay a zombie for a moment until it is reaped.
          const deadline = Date.now() + 5000;
          while (recorded.some(alive) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
          }
          expect(recorded.filter(alive)).toEqual([]);
        } finally {
          killRecorded(pids);
        }
      }, 60_000);

      it("stops git after the default 3 s when no timeout is given", async () => {
        const { env, pids } = fakeGit(
          'echo $$ >> "$PIDS"\nexec /bin/sleep 300',
        );
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        try {
          const { out, ms } = await patchInChild(
            {
              cwd: dir,
              edits: [{ file: "a.txt", old: "a", new: "b" }],
              dryRun: true,
            },
            env,
          );
          expect(out.status).toBe("would_write");
          expect(out.warnings.join("\n")).toContain(
            "git rev-parse did not finish within 3000 ms and was stopped",
          );
          expect(ms).toBeGreaterThanOrEqual(2500);
          expect(ms).toBeLessThan(20_000);
        } finally {
          killRecorded(pids);
        }
      }, 60_000);

      it("stops git when it writes more than its answer can hold, and when a signal ends it", async () => {
        const line = "a".repeat(99);
        const chatty = fakeGit(
          `i=0\nwhile [ $i -lt 2000 ]; do echo ${line}; i=$((i+1)); done`,
        );
        const signalled = fakeGit("kill -TERM $$");
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        const cases: [NodeJS.ProcessEnv, string][] = [
          [
            chatty.env,
            "git rev-parse wrote more than 65536 bytes and was stopped",
          ],
          [signalled.env, "git rev-parse was ended by SIGTERM"],
        ];
        for (const [env, warning] of cases) {
          const { out } = await patchInChild(
            {
              cwd: dir,
              edits: [{ file: "a.txt", old: "a", new: "b" }],
              dryRun: true,
            },
            env,
          );
          expect(out.status, warning).toBe("would_write");
          expect(out.warnings.join("\n"), warning).toContain(warning);
        }
      }, 60_000);
    },
  );
});

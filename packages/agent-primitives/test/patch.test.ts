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
    const nfd = "café.txt";
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
  it("src/patch holds no invisible literal characters (they are written as escapes)", () => {
    const dir = path.join(path.dirname(CLI_PATH), "..", "src", "patch");
    for (const name of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      const invisible = [...text].filter(
        (ch) => ch !== " " && /[\p{Cf}\p{Zs}\p{Zl}\p{Zp}]/u.test(ch),
      );
      expect(invisible, name).toEqual([]);
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

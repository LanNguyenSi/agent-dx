import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  countPhpTestMethods,
  countTestCases,
  hygiene,
  isBackupPath,
  isTestPath,
} from "../src/hygiene/index.js";
import { UsageError } from "../src/envelope.js";
import { spawnCli } from "./helpers/spawn-cli.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function write(repo: string, rel: string, content: string): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function numbered(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${String(i)}\n`).join(
    "",
  );
}

function initRepo(): string {
  const repo = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-hygiene-test-"),
  );
  tmpDirs.push(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  write(repo, "docs/log.md", numbered("entry", 100));
  write(
    repo,
    "test/a.test.ts",
    'it("one", () => {});\nit("two", () => {});\ntest("three", () => {});\n',
  );
  write(repo, "src/a.ts", "export const a = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

function commitAll(repo: string, msg = "change"): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", msg]);
}

describe("helpers", () => {
  it("matches the four backup basename patterns and nothing else", () => {
    for (const p of [
      "a.md-E",
      "a.md-e",
      "a.md-n",
      "a.md-r",
      "a.md-s",
      "x/y.bak",
      "z.orig",
      "doc.md~",
      "file-E",
    ]) {
      expect(isBackupPath(p)).toBe(true);
    }
    for (const p of [
      "a.md",
      "x/backup.ts",
      "ORIGIN",
      "E",
      "dir-E/file.md",
      "dir-e/file.md",
      "a.md-ee",
      "a.md-x",
    ]) {
      expect(isBackupPath(p)).toBe(false);
    }
  });

  it("recognises test paths", () => {
    expect(isTestPath("test/x.ts")).toBe(true);
    expect(isTestPath("src/x.spec.ts")).toBe(true);
    expect(isTestPath("pkg/test_x.py")).toBe(true);
    expect(isTestPath("src/x.ts")).toBe(false);
  });

  it("counts test cases across languages", () => {
    const src = [
      'it("a", () => {});',
      '  test.skip("b", () => {});',
      '  it.each([1])("c", () => {});',
      "def test_d():",
      "  async def test_e():",
      "func TestF(t *testing.T) {",
      "@Test",
      "const it = 1;",
      "// it(not a case",
    ].join("\n");
    expect(countTestCases(src)).toBe(7);
  });

  it("counts PHPUnit test methods by name, docblock tag and attribute", () => {
    const byName = [
      "<?php",
      "final class FooTest extends TestCase {",
      "  public function testOne(): void {}",
      "  public static function testTwo(): void {}",
      "  protected function helper(): void {}",
      "}",
    ].join("\n");
    expect(countPhpTestMethods(byName)).toBe(2);

    const byDoc = [
      "  /**",
      "   * Checks the thing.",
      "   *",
      "   * @test",
      "   * @dataProvider provider",
      "   */",
      "  public function itWorks(): void {}",
      "  /** @test */",
      "  public function alsoWorks(): void {}",
      "  /** @testdox not a marker */",
      "  public function notATest(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(byDoc)).toBe(2);

    const byAttribute = [
      "  #[Test]",
      "  public function a(): void {}",
      "  #[\\PHPUnit\\Framework\\Attributes\\Test]",
      "  public function b(): void {}",
      "  #[DataProvider('p'), Test]",
      "  public function c(): void {}",
      "  #[TestDox('x')]",
      "  public function d(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(byAttribute)).toBe(3);
  });

  it("counts a PHP method with both a test name and a marker once", () => {
    const both = "  /** @test */\n  public function testOne(): void {}\n";
    const nameOnly = "  public function testOne(): void {}\n";
    expect(countPhpTestMethods(both)).toBe(1);
    expect(countPhpTestMethods(nameOnly)).toBe(1);
  });

  it("does not count PHP comments or non-test methods", () => {
    const src = [
      "  // public function testCommented(): void {}",
      "   * function testInDocblock()",
      "  public function provider(): array { return []; }",
      "  $s = 'function testInString()';",
    ].join("\n");
    expect(countPhpTestMethods(src)).toBe(0);
  });

  it("routes .php paths to the PHP counter only", () => {
    const php = "  public function testOne(): void {}\n@test\n";
    expect(countTestCases(php, "tests/src/Unit/FooTest.php")).toBe(1);
    expect(countTestCases(php)).toBe(1);
    expect(isTestPath("src/FooTest.php")).toBe(true);
    expect(isTestPath("src/Foo.php")).toBe(false);
  });
});

describe("hygiene", () => {
  it("passes a clean extending commit", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "docs/log.md", numbered("entry", 100) + "entry new\n");
    write(
      repo,
      "test/a.test.ts",
      'it("one", () => {});\nit("two", () => {});\ntest("three", () => {});\nit("four", () => {});\n',
    );
    commitAll(repo);
    const r = hygiene({ cwd: repo, base, extendOnly: ["docs/log.md"] });
    expect(r.status).toBe("ok");
    expect(r.findings).toEqual([]);
  });

  it("refuses every backup pattern in a committed range", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    for (const name of ["a.md-E", "b.bak", "c.orig", "d.md~"]) {
      write(repo, `docs/${name}`, "x\n");
    }
    commitAll(repo);
    const r = hygiene({ cwd: repo, base });
    expect(r.status).toBe("fail");
    expect(r.findings.map((f) => f.path).sort()).toEqual([
      "docs/a.md-E",
      "docs/b.bak",
      "docs/c.orig",
      "docs/d.md~",
    ]);
    expect(r.counts.backupFiles).toBe(4);
  });

  it("refuses the BSD flag-as-suffix leftovers of sed -i -e and sed -i -E", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "docs/a.md-e", "x\n");
    write(repo, "docs/b.md-E", "x\n");
    git(repo, ["add", "-A"]);
    const r = hygiene({ cwd: repo, base, staged: true });
    expect(r.status).toBe("fail");
    expect(r.findings.map((f) => f.path).sort()).toEqual([
      "docs/a.md-e",
      "docs/b.md-E",
    ]);
  });

  it("does not report a tracked file that already had a backup-style name and is only modified", () => {
    const repo = initRepo();
    write(repo, "test/fixture.orig", "one\ntwo\n");
    write(repo, "notes.md-e", "kept\n");
    commitAll(repo, "tracked fixtures");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "test/fixture.orig", "one\ntwo\nthree\n");
    write(repo, "notes.md-e", "kept\nmore\n");
    commitAll(repo, "modify fixtures");
    expect(hygiene({ cwd: repo, base }).status).toBe("ok");
    git(repo, ["mv", "test/fixture.orig", "test/moved.orig"]);
    commitAll(repo, "rename between backup-style names");
    expect(hygiene({ cwd: repo, base }).status).toBe("ok");
  });

  it("reports a file renamed onto a backup-style name", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["mv", "src/a.ts", "src/a.ts~"]);
    commitAll(repo, "rename to backup name");
    const r = hygiene({ cwd: repo, base });
    expect(r.status).toBe("fail");
    expect(r.findings[0]).toMatchObject({
      kind: "backup_file",
      path: "src/a.ts~",
    });
  });

  it("refuses a staged backup file before commit, but not an unstaged one", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "docs/x.md-E", "x\n");
    expect(hygiene({ cwd: repo, base, staged: true }).status).toBe("ok");
    git(repo, ["add", "docs/x.md-E"]);
    const r = hygiene({ cwd: repo, base, staged: true });
    expect(r.status).toBe("fail");
    expect(r.findings[0]).toMatchObject({
      kind: "backup_file",
      path: "docs/x.md-E",
    });
  });

  it("does not report a deleted backup file", () => {
    const repo = initRepo();
    write(repo, "old.bak", "x\n");
    commitAll(repo, "add bak");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["rm", "-q", "old.bak"]);
    commitAll(repo, "remove bak");
    expect(hygiene({ cwd: repo, base }).status).toBe("ok");
  });

  it("flags an extend-only file reduced to its new line", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "docs/log.md", "entry new\n");
    commitAll(repo);
    const r = hygiene({ cwd: repo, base, extendOnly: ["./docs/log.md"] });
    expect(r.status).toBe("fail");
    expect(r.findings[0]).toMatchObject({
      kind: "extend_only_rewrite",
      path: "docs/log.md",
      baseLines: 100,
      removedLines: 100,
      removedPercent: 100,
    });
  });

  it("honours the threshold: at the limit passes, over it fails", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(
      repo,
      "docs/log.md",
      numbered("entry", 100).split("\n").slice(20).join("\n"),
    );
    commitAll(repo);
    const at = hygiene({
      cwd: repo,
      base,
      extendOnly: ["docs/log.md"],
      maxDeletePercent: 20,
    });
    expect(at.status).toBe("ok");
    const over = hygiene({
      cwd: repo,
      base,
      extendOnly: ["docs/log.md"],
      maxDeletePercent: 19,
    });
    expect(over.status).toBe("fail");
  });

  it("measures extend-only files whose names git C-quotes (non-ASCII, quote character)", () => {
    const repo = initRepo();
    const names = [
      "docs/caf\u00e9.md",
      'docs/q"uote.md',
      "docs/back\\slash.md",
    ];
    for (const n of names) write(repo, n, numbered("entry", 50));
    commitAll(repo, "add quoted names");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    for (const n of names) write(repo, n, "entry new\n");
    commitAll(repo, "rewrite");
    const r = hygiene({ cwd: repo, base, extendOnly: names });
    expect(r.status).toBe("fail");
    expect(r.findings.map((f) => f.path).sort()).toEqual([...names].sort());
    for (const f of r.findings) expect(f.removedPercent).toBe(100);
    expect(r.warnings).toEqual([]);
  });

  it("passes an extend-only rename that keeps the content, flags a rename that rewrites it", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["mv", "docs/log.md", "docs/log2.md"]);
    commitAll(repo, "rename");
    const kept = hygiene({ cwd: repo, base, extendOnly: ["docs/log.md"] });
    expect(kept.status).toBe("ok");
    expect(kept.warnings).toEqual([]);
    write(repo, "docs/log2.md", "entry new\n");
    commitAll(repo, "rewrite");
    const r = hygiene({ cwd: repo, base, extendOnly: ["docs/log.md"] });
    expect(r.findings[0]).toMatchObject({
      kind: "extend_only_rewrite",
      removedPercent: 100,
    });
  });

  it("measures an extend-only file renamed and cut while git still reports a rename", () => {
    const repo = initRepo();
    write(repo, "docs/ext.md", numbered("entry", 50));
    commitAll(repo, "add ext");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["mv", "docs/ext.md", "docs/ext2.md"]);
    write(repo, "docs/ext2.md", numbered("entry", 30));
    commitAll(repo, "rename and cut");
    const status = git(repo, ["diff", "-M", "--name-status", base, "HEAD"]);
    expect(status).toMatch(/^R\d+\tdocs\/ext\.md\tdocs\/ext2\.md$/m);
    const r = hygiene({ cwd: repo, base, extendOnly: ["docs/ext.md"] });
    expect(r.status).toBe("fail");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: "extend_only_rewrite",
      path: "docs/ext.md",
      baseLines: 50,
      removedLines: 20,
      removedPercent: 40,
    });
    expect(r.warnings).toEqual([]);
  });

  it("treats an extend-only path as a literal name, not pathspec magic", () => {
    const repo = initRepo();
    write(repo, ":colon.md", numbered("entry", 50));
    commitAll(repo, "add colon name");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, ":colon.md", "entry new\n");
    commitAll(repo, "rewrite");
    const r = hygiene({ cwd: repo, base, extendOnly: [":colon.md"] });
    expect(r.status).toBe("fail");
    expect(r.findings[0]).toMatchObject({
      kind: "extend_only_rewrite",
      path: ":colon.md",
      removedPercent: 100,
    });
    expect(r.warnings).toEqual([]);
  });

  it("measures an extend-only rewrite under ambient GIT_*_PATHSPECS switches", () => {
    const repo = initRepo();
    write(repo, "docs/log.md", numbered("entry", 50));
    commitAll(repo, "add log");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "docs/log.md", "entry new\n");
    commitAll(repo, "rewrite");
    const names = [
      "GIT_GLOB_PATHSPECS",
      "GIT_NOGLOB_PATHSPECS",
      "GIT_ICASE_PATHSPECS",
      "GIT_LITERAL_PATHSPECS",
    ];
    const saved = names.map((n) => process.env[n]);
    try {
      for (const name of names) {
        for (const other of names) delete process.env[other];
        process.env[name] = "1";
        const r = hygiene({ cwd: repo, base, extendOnly: ["docs/log.md"] });
        expect(r.warnings, name).toEqual([]);
        expect(r.status, name).toBe("fail");
        expect(r.findings[0], name).toMatchObject({
          kind: "extend_only_rewrite",
          path: "docs/log.md",
          removedPercent: 100,
        });
      }
    } finally {
      names.forEach((n, i) => {
        if (saved[i] === undefined) delete process.env[n];
        else process.env[n] = saved[i];
      });
    }
  });

  it("warns instead of passing silently when the removed lines cannot be measured", () => {
    const repo = initRepo();
    write(repo, "bin.dat", "a\0b\n".repeat(20));
    commitAll(repo, "binary");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "bin.dat", "c\0d\n");
    commitAll(repo, "rewrite binary");
    const r = hygiene({ cwd: repo, base, extendOnly: ["bin.dat"] });
    expect(r.status).toBe("ok");
    expect(r.warnings.join("\n")).toContain("could not measure");
    expect(r.warnings.join("\n")).toContain("bin.dat");
  });

  it("warns for an extend-only path that does not exist at the base", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "docs/new.md", "x\n");
    commitAll(repo);
    const r = hygiene({
      cwd: repo,
      base,
      extendOnly: ["docs/new.md", "typo.md"],
    });
    expect(r.status).toBe("ok");
    expect(r.warnings).toEqual([
      expect.stringContaining("docs/new.md does not exist at"),
      expect.stringContaining("typo.md does not exist at"),
    ]);
  });

  it("does not flag a heavy rewrite of a file not listed as extend-only", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "docs/log.md", "entry new\n");
    commitAll(repo);
    expect(hygiene({ cwd: repo, base }).status).toBe("ok");
  });

  it("flags an extend-only file that was deleted", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["rm", "-q", "docs/log.md"]);
    commitAll(repo);
    const r = hygiene({ cwd: repo, base, extendOnly: ["docs/log.md"] });
    expect(r.findings[0]).toMatchObject({
      kind: "extend_only_rewrite",
      removedPercent: 100,
    });
  });

  it("flags a replaced test file that dropped cases", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "test/a.test.ts", 'it("only new", () => {});\n');
    commitAll(repo);
    const r = hygiene({ cwd: repo, base });
    expect(r.status).toBe("fail");
    expect(r.findings[0]).toMatchObject({
      kind: "test_cases_dropped",
      path: "test/a.test.ts",
      baseCases: 3,
      headCases: 1,
    });
  });

  it("flags PHPUnit test methods reduced from 4 to 1", () => {
    const repo = initRepo();
    write(
      repo,
      "tests/src/Unit/FooTest.php",
      [
        "<?php",
        "final class FooTest extends TestCase {",
        "  public function testOne(): void {}",
        "  /** @test */",
        "  public function two(): void {}",
        "  #[Test]",
        "  public function three(): void {}",
        "  public function testFour(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(repo, "php tests");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(
      repo,
      "tests/src/Unit/FooTest.php",
      [
        "<?php",
        "final class FooTest extends TestCase {",
        "  public function testOne(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(repo);
    const r = hygiene({ cwd: repo, base });
    expect(r.status).toBe("fail");
    expect(r.findings[0]).toMatchObject({
      kind: "test_cases_dropped",
      path: "tests/src/Unit/FooTest.php",
      baseCases: 4,
      headCases: 1,
    });
  });

  it("does not flag removing only the @test tag from a test-named PHP method", () => {
    const repo = initRepo();
    write(
      repo,
      "tests/BarTest.php",
      "<?php\n  /** @test */\n  public function testOne(): void {}\n",
    );
    commitAll(repo, "php test");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(
      repo,
      "tests/BarTest.php",
      "<?php\n  public function testOne(): void {}\n",
    );
    commitAll(repo);
    expect(hygiene({ cwd: repo, base }).status).toBe("ok");
  });

  it("flags a deleted test file and tracks a rename without a false positive", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["mv", "test/a.test.ts", "test/b.test.ts"]);
    commitAll(repo, "rename");
    expect(hygiene({ cwd: repo, base }).status).toBe("ok");
    git(repo, ["rm", "-q", "test/b.test.ts"]);
    commitAll(repo, "delete");
    const r = hygiene({ cwd: repo, base });
    expect(r.findings[0]).toMatchObject({
      kind: "test_cases_dropped",
      headCases: 0,
    });
  });

  it("throws UsageError for a bad base and for a non-git directory", () => {
    const repo = initRepo();
    expect(() => hygiene({ cwd: repo, base: "nope-nope" })).toThrow(UsageError);
    expect(() =>
      hygiene({ cwd: repo, base: "HEAD", maxDeletePercent: 101 }),
    ).toThrow(UsageError);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-plain-"));
    tmpDirs.push(plain);
    expect(() => hygiene({ cwd: plain, base: "HEAD" })).toThrow(UsageError);
  });
});

describe("hygiene CLI", () => {
  it("exits 1 and names the file for a real BSD-style sed backup, 0 when clean", async () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    // The `-E` backup file is what `sed -i -E` creates on BSD sed; write it
    // directly so the test is portable across GNU and BSD hosts.
    write(repo, "docs/log.md-E", numbered("entry", 100));
    write(repo, "docs/log.md", numbered("entry", 100) + "added\n");
    git(repo, ["add", "-A"]);
    const bad = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--staged",
    ]);
    expect(bad.code).toBe(1);
    const out = JSON.parse(bad.stdout) as {
      status: string;
      findings: { kind: string; path: string }[];
    };
    expect(out.status).toBe("fail");
    expect(out.findings).toEqual([
      expect.objectContaining({ kind: "backup_file", path: "docs/log.md-E" }),
    ]);
    git(repo, ["reset", "-q", "docs/log.md-E"]);
    const good = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--staged",
    ]);
    expect(good.code).toBe(0);
  });

  it("reads extend-only paths from a file and honours --max-delete-percent", async () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "docs/log.md", "entry new\n");
    commitAll(repo);
    const list = path.join(repo, "..", `${path.basename(repo)}-list.txt`);
    fs.writeFileSync(list, "# extend only\n\ndocs/log.md\n");
    tmpDirs.push(list);
    const run = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--extend-only-file",
      list,
      "--max-delete-percent",
      "50",
    ]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).findings[0].kind).toBe("extend_only_rewrite");
    const usage = await spawnCli(["-C", repo, "hygiene", "--base", "zzzz"]);
    expect(usage.code).toBe(2);
  });

  it("resolves a relative --extend-only-file against the -C directory", async () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "docs/log.md", "entry new\n");
    write(repo, "extend-only.txt", "docs/log.md\n");
    commitAll(repo);
    const run = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--extend-only-file",
      "extend-only.txt",
    ]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).findings[0].kind).toBe("extend_only_rewrite");
  });
});

describe("hygiene from the merge-base", () => {
  /** A repo where `feat` branched off, then the default branch gained two
   * test cases in test/a.test.ts (3 -> 5). `feat` changes only src/a.ts
   * and stays checked out. */
  function movedBaseRepo(): {
    repo: string;
    main: string;
    forkSha: string;
    mainSha: string;
  } {
    const repo = initRepo();
    const main = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    const forkSha = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["checkout", "-q", "-b", "feat"]);
    write(repo, "src/a.ts", "export const a = 2;\n");
    commitAll(repo, "feat change");
    git(repo, ["checkout", "-q", main]);
    write(
      repo,
      "test/a.test.ts",
      'it("one", () => {});\nit("two", () => {});\ntest("three", () => {});\nit("four", () => {});\nit("five", () => {});\n',
    );
    commitAll(repo, "main adds two cases");
    const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["checkout", "-q", "feat"]);
    return { repo, main, forkSha, mainSha };
  }

  it("does not report test cases the moved base added after the branch point", () => {
    const { repo, main, forkSha, mainSha } = movedBaseRepo();
    const r = hygiene({ cwd: repo, base: main });
    expect(r.findings).toEqual([]);
    expect(r.status).toBe("ok");
    expect(r.baseSha).toBe(mainSha);
    expect(r.mergeBase).toBe(forkSha);
    expect(r.counts.files).toBe(1);
  });

  it("gives the same result for the moved base name and the SHA it branched from", () => {
    const { repo, main, forkSha } = movedBaseRepo();
    const byName = hygiene({ cwd: repo, base: main });
    const bySha = hygiene({ cwd: repo, base: forkSha });
    expect(byName.mergeBase).toBe(forkSha);
    expect(bySha.mergeBase).toBe(forkSha);
    expect(bySha.findings).toEqual(byName.findings);
    expect(bySha.counts).toEqual(byName.counts);
  });

  it("names the merge-base when an extend-only path is missing there", () => {
    const { repo, main, forkSha, mainSha } = movedBaseRepo();
    git(repo, ["checkout", "-q", main]);
    write(repo, "docs/later.md", "x\n");
    commitAll(repo, "main adds docs/later.md");
    git(repo, ["checkout", "-q", "feat"]);
    const r = hygiene({
      cwd: repo,
      base: main,
      extendOnly: ["docs/later.md"],
    });
    expect(r.mergeBase).toBe(forkSha);
    expect(r.baseSha).not.toBe(mainSha);
    expect(r.warnings).toEqual([
      `extend-only path docs/later.md does not exist at the merge-base ${forkSha} of ${main}; skipped`,
    ]);
  });

  it("names a shallow clone as the likely cause when no merge-base is found", () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-primitives-hygiene-shallow-"),
    );
    tmpDirs.push(parent);
    const origin = path.join(parent, "origin");
    const clone = path.join(parent, "clone");
    fs.mkdirSync(origin);
    git(origin, ["init", "-q", "-b", "master"]);
    git(origin, ["config", "user.email", "test@example.com"]);
    git(origin, ["config", "user.name", "test"]);
    write(origin, "src/a.ts", "export const a = 1;\n");
    commitAll(origin, "one");
    git(origin, ["checkout", "-q", "-b", "feat"]);
    write(origin, "src/b.ts", "export const b = 1;\n");
    commitAll(origin, "two");
    git(origin, ["checkout", "-q", "master"]);
    write(origin, "src/c.ts", "export const c = 1;\n");
    commitAll(origin, "three");
    git(parent, [
      "clone",
      "-q",
      "--depth",
      "1",
      "--no-single-branch",
      `file://${origin}`,
      clone,
    ]);
    git(clone, ["checkout", "-q", "origin/feat"]);
    const r = hygiene({ cwd: clone, base: "origin/master" });
    const warning = r.warnings.find((w) => w.includes("no merge-base"));
    expect(warning).toBeDefined();
    expect(warning).toContain("shallow clone");
  });

  it("falls back to the base directly with --staged when HEAD is unborn", () => {
    const { repo, main, mainSha } = movedBaseRepo();
    git(repo, ["checkout", "-q", "--orphan", "fresh"]);
    git(repo, ["rm", "-rq", "--cached", "."]);
    write(repo, "src/n.ts", "export const n = 1;\n");
    git(repo, ["add", "src/n.ts"]);
    const r = hygiene({ cwd: repo, base: main, staged: true });
    expect(r.mergeBase).toBe(mainSha);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("HEAD does not resolve to a commit"),
      ]),
    );
  });

  it("uses the merge-base with HEAD for --staged", () => {
    const { repo, main, forkSha } = movedBaseRepo();
    write(repo, "src/b.ts", "export const b = 1;\n");
    git(repo, ["add", "src/b.ts"]);
    const r = hygiene({ cwd: repo, base: main, staged: true });
    expect(r.findings).toEqual([]);
    expect(r.mergeBase).toBe(forkSha);
    expect(r.headSha).toBeNull();
  });

  it("still reports a drop the head side made", () => {
    const { repo, main } = movedBaseRepo();
    write(repo, "test/a.test.ts", 'it("one", () => {});\n');
    commitAll(repo, "feat drops cases");
    const r = hygiene({ cwd: repo, base: main });
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: "test_cases_dropped",
        path: "test/a.test.ts",
        baseCases: 3,
        headCases: 1,
      }),
    ]);
  });

  it("warns and compares the trees directly when there is no merge-base", () => {
    const { repo, main, mainSha } = movedBaseRepo();
    git(repo, ["checkout", "-q", "--orphan", "other"]);
    git(repo, ["rm", "-rq", "--cached", "."]);
    write(repo, "test/a.test.ts", 'it("one", () => {});\n');
    git(repo, ["add", "test/a.test.ts"]);
    git(repo, ["commit", "-q", "-m", "orphan"]);
    const r = hygiene({ cwd: repo, base: main });
    expect(r.mergeBase).toBe(mainSha);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("no merge-base between"),
      ]),
    );
    expect(r.warnings.join("\n")).toContain("no common ancestor");
    expect(r.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "test_cases_dropped", baseCases: 5 }),
      ]),
    );
  });

  it("names the resolved commits in the CLI envelope", async () => {
    const { repo, main, forkSha, mainSha } = movedBaseRepo();
    const res = await spawnCli(["-C", repo, "hygiene", "--base", main]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as {
      base: string;
      base_sha: string;
      head_sha: string;
      merge_base: string;
    };
    expect(out.base).toBe(main);
    expect(out.base_sha).toBe(mainSha);
    expect(out.merge_base).toBe(forkSha);
    expect(out.head_sha).toBe(git(repo, ["rev-parse", "HEAD"]).trim());
  });
});

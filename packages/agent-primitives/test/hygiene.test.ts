import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  listTestCases,
  parseIntendedDeletion,
  readWorktreeFile,
  UNCOMMITTED_FILES_CAP,
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

  it("counts a same-line Test attribute and does not mark the next method", () => {
    expect(countPhpTestMethods("  #[Test] public function a(): void {}")).toBe(
      1,
    );
    const src = [
      "  #[Test] public function a(): void {}",
      "  public function helper(): void {}",
      "  public function testB(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(src)).toBe(2);
  });

  it("counts a same-line @test docblock and does not mark the next method", () => {
    expect(
      countPhpTestMethods("  /** @test */ public function a(): void {}"),
    ).toBe(1);
    const src = [
      "  /** @test */ public function a(): void {}",
      "  public function helper(): void {}",
      "  public function testB(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(src)).toBe(2);
  });

  it("counts method-like lines inside a block comment, the documented limit", () => {
    const src = [
      "  /*",
      "  public function testInBlockComment(): void {}",
      "  function testInComment(): void {}",
      "  */",
      "  public function testAfter(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(src)).toBe(3);
  });

  it("counts method-like lines inside heredocs and nowdocs, quoted forms and indented terminators included, the documented limit", () => {
    const src = [
      "  public function setUp(): void {",
      "    $a = <<<EOD",
      "function testInHeredoc(): void {}",
      "EOD;",
      "    $b = <<<'TXT'",
      "function testInNowdoc(): void {}",
      "TXT;",
      '    $c = <<<"QT"',
      "function testInHeredocQuoted(): void {}",
      "    QT;",
      "  }",
    ].join("\n");
    expect(countPhpTestMethods(src)).toBe(3);
  });

  it("does not leak a class docblock @test onto the next method", () => {
    const src = [
      "<?php",
      "/**",
      " * @test",
      " */",
      "class FooTest extends TestCase {",
      "  private function helper(): void {}",
      "}",
    ].join("\n");
    expect(countPhpTestMethods(src)).toBe(0);
  });

  it("does not treat @test in a line comment, or a Test attribute inside a string, as a marker", () => {
    const lineComment = [
      "  // @test",
      "  public function helper(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(lineComment)).toBe(0);
    const hashComment = [
      "  # @test",
      "  public function helper(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(hashComment)).toBe(0);
    const inString = [
      "  $s = '#[Test]';",
      "  public function helper(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(inString)).toBe(0);
  });

  it("keeps every method counted below a /* inside a string literal", () => {
    const src = [
      "<?php",
      "final class FooTest extends TestCase {",
      "  public function setUp(): void {",
      "    $this->files = glob(__DIR__ . '/fixtures/*.json');",
      "  }",
      "  public function testOne(): void {}",
      "  public function testTwo(): void {}",
      "  public function testThree(): void {}",
      "  /** @test */",
      "  public function four(): void {}",
      "}",
    ].join("\n");
    expect(countPhpTestMethods(src)).toBe(4);
  });

  it("keeps every method counted below an escaped quote before a /*", () => {
    const src = [
      "  public function setUp(): void {",
      "    $s = 'it\\'s /* fine';",
      "  }",
      "  public function testOne(): void {}",
      "  public function testTwo(): void {}",
      "  /** @test */",
      "  public function three(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(src)).toBe(3);
  });

  it("keeps every method counted below a conflict marker string and a heredoc opener string", () => {
    const conflict = [
      "<?php",
      "final class FooTest extends TestCase {",
      "  public function setUp(): void {",
      "    $s = '<<<<<<< HEAD';",
      "  }",
      "  public function testOne(): void {}",
      "  public function testTwo(): void {}",
      "}",
    ].join("\n");
    expect(countPhpTestMethods(conflict)).toBe(2);
    const opener = [
      "<?php",
      "final class FooTest extends TestCase {",
      "  public function setUp(): void {",
      "    $marker = '<<<EOD';",
      "  }",
      "  public function testOne(): void {}",
      "  public function testTwo(): void {}",
      "  private function body(): string {",
      "    return <<<EOD",
      "some text",
      "EOD;",
      "  }",
      "}",
    ].join("\n");
    expect(countPhpTestMethods(opener)).toBe(2);
  });

  it("counts every method around a heredoc for each PHP 7.3 terminator shape including EOT .", () => {
    const terminated = (terminator: string): string =>
      [
        "  public function setUp(): void {",
        "    $a = <<<EOT",
        "function testInHeredoc(): void {}",
        terminator,
        "  }",
        "  public function testAfter(): void {}",
      ].join("\n");
    for (const terminator of [
      "EOT;",
      "EOT,",
      "EOT)",
      "EOT .",
      "EOT]",
      "EOT->",
      "EOT",
    ]) {
      expect(countPhpTestMethods(terminated(terminator)), terminator).toBe(2);
    }
    const inArguments = [
      "  public function setUp(): void {",
      "    foo(<<<EOD",
      "function testInHeredoc(): void {}",
      "EOD, 1);",
      "  }",
      "  public function testAfter(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(inArguments)).toBe(2);
    const nextLineParen = [
      "  public function setUp(): void {",
      "    foo(<<<EOD",
      "function testInHeredoc(): void {}",
      "EOD",
      ");",
      "  }",
      "  public function testAfter(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(nextLineParen)).toBe(2);
    const longerLabel = [
      "  public function setUp(): void {",
      "    $a = <<<EOD",
      "EODX;",
      "function testInBody(): void {}",
      "EOD;",
      "  }",
      "  public function testAfter(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(longerLabel)).toBe(2);
    const bodyThatLooksLikeATerminator = [
      "  public function setUp(): void {",
      "    $a = <<<EOD",
      "The example body mentions EOD in prose",
      "function testInBody(): void {}",
      "EOD;",
      "  }",
      "  public function testAfter(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(bodyThatLooksLikeATerminator)).toBe(2);
  });

  it("keeps a pending marker across a multi-line attribute", () => {
    const byAttribute = [
      "  #[Test]",
      "  #[DataProviderExternal(",
      "    Provider::class,",
      "  )]",
      "  public function a(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(byAttribute)).toBe(1);
    const byDoc = [
      "  /** @test */",
      "  #[DataProviderExternal(",
      "    Provider::class,",
      "  )]",
      "  public function b(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(byDoc)).toBe(1);
    const testInContinuation = [
      "  #[DataProviderExternal(",
      "    Provider::class,",
      "  ), Test]",
      "  public function c(): void {}",
      "  public function helper(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(testInContinuation)).toBe(1);
    const noMarkerInContinuation = [
      "  /** @test */",
      "  #[DataProviderExternal(",
      "    Provider::class,",
      "  )]",
      "  public function d(): void {}",
      "  public function helper(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(noMarkerInContinuation)).toBe(1);
  });

  it("counts every method when a block comment, heredoc or attribute never closes", () => {
    const unterminatedComment = [
      "<?php",
      "final class FooTest extends TestCase {",
      "  public function testOne(): void {}",
      "  /*",
      "  function testInComment(): void {}",
      "  the file ends inside the comment",
    ].join("\n");
    expect(countPhpTestMethods(unterminatedComment)).toBe(2);
    const unterminatedHeredoc = [
      "<?php",
      "final class FooTest extends TestCase {",
      "  public function testOne(): void {}",
      "  public function body(): string {",
      "    return <<<EOD",
      "function testInBody(): void {}",
      "still in the heredoc, the file ends here",
    ].join("\n");
    expect(countPhpTestMethods(unterminatedHeredoc)).toBe(2);
    const unterminatedAttribute = [
      "<?php",
      "final class FooTest extends TestCase {",
      "  public function testOne(): void {}",
      "  #[DataProviderExternal(",
      "    Provider::class,",
      "  public function testTwo(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(unterminatedAttribute)).toBe(2);
  });

  it("never hides a method behind a glob line comment, a hash glob comment or a trailing glob comment", () => {
    const lineComment = [
      "<?php",
      "final class FooTest extends TestCase {",
      "  // see src/*",
      "  public function testOne(): void {}",
      "  public function testTwo(): void {}",
      "  /** helper */",
      "  private function helper(): void {}",
      "}",
    ].join("\n");
    expect(countPhpTestMethods(lineComment)).toBe(2);
    const hashComment = [
      "<?php",
      "final class FooTest extends TestCase {",
      "  # tests/fixtures/*.json",
      "  public function testOne(): void {}",
      "  public function testTwo(): void {}",
      "  /** helper */",
      "  private function helper(): void {}",
      "}",
    ].join("\n");
    expect(countPhpTestMethods(hashComment)).toBe(2);
    const trailing = [
      "<?php",
      "final class FooTest extends TestCase {",
      "  public function setUp(): void {",
      "    $x = 1; // see src/*",
      "  }",
      "  public function testOne(): void {}",
      "  public function testTwo(): void {}",
      "  /** helper */",
      "  private function helper(): void {}",
      "}",
    ].join("\n");
    expect(countPhpTestMethods(trailing)).toBe(2);
  });

  it("keeps a marker across comment lines and ends an attribute continuation on its balancing line", () => {
    const commentLines = [
      "  /** @test */",
      "  // reason",
      "  # another reason",
      "  public function works(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(commentLines)).toBe(1);
    const balancedThenDoc = [
      "  #[Foo(",
      "    1,",
      "  )]",
      "  private $x;",
      "  /** @test */",
      "  public function works(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(balancedThenDoc)).toBe(1);
    const docThenAttributeThenProperty = [
      "  /** @test */",
      "  #[Foo(",
      "    1,",
      "  )]",
      "  private $x;",
      "  public function helper(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(docThenAttributeThenProperty)).toBe(0);
  });

  it("reads Test on the opening line of an attribute group that stays open", () => {
    const src = [
      "  #[Test, TestWith(['[', 'x'])]",
      "  public function itWorks(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(src)).toBe(1);
  });

  it("scans a long unbalanced attribute continuation without a method line", () => {
    const lines = ["  #[Group('[')]", "  private $x;"];
    for (let i = 0; i < 20000; i++) lines.push(`    'data line ${i}',`);
    expect(countPhpTestMethods(lines.join("\n"))).toBe(0);
    const withTail = [...lines, "  public function testOne(): void {}"];
    expect(countPhpTestMethods(withTail.join("\n"))).toBe(1);
  });

  it("never hides a method or drops its marker behind a multi-line string whose body holds /*", () => {
    const src = [
      "<?php",
      "final class FooTest extends TestCase {",
      "  public function setUp(): void {",
      "    $s = 'first line",
      "/* still the string",
      "';",
      "  }",
      "  /** @test */",
      "  public function works(): void {}",
      "}",
    ].join("\n");
    expect(countPhpTestMethods(src)).toBe(1);
  });

  it("never hides a method behind an attribute with a bracket inside a string", () => {
    const balanced = [
      "  #[TestWith(['/^\\[/'])]",
      "  public function testOne(): void {}",
      "  public function testTwo(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(balanced)).toBe(2);
    const opensAContinuation = [
      "  #[TestWith(['/^\\['])]",
      "  public function testOne(): void {}",
      "  public function testTwo(): void {}",
      "  #[Bar(']')]",
      "  public function testThree(): void {}",
    ].join("\n");
    expect(countPhpTestMethods(opensAContinuation)).toBe(3);
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

  it("counts PHPUnit methods below a glob string and flags a drop through the CLI", async () => {
    const repo = initRepo();
    const fixture = (n: number): string =>
      [
        "<?php",
        "final class FooTest extends TestCase {",
        "  public function setUp(): void {",
        "    $this->files = glob(__DIR__ . '/fixtures/*.json');",
        "  }",
        ...Array.from(
          { length: n },
          (_, i) => `  public function test${String(i)}(): void {}`,
        ),
        "  /** @test */",
        "  public function four(): void {}",
        "}",
        "",
      ].join("\n");
    write(repo, "tests/FooTest.php", fixture(4));
    commitAll(repo, "php tests");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "tests/FooTest.php", fixture(3));
    commitAll(repo);
    const run = await spawnCli(["-C", repo, "hygiene", "--base", base]);
    expect(run.code).toBe(1);
    const out = JSON.parse(run.stdout) as {
      findings: {
        kind: string;
        path: string;
        baseCases: number;
        headCases: number;
      }[];
    };
    expect(out.findings[0]).toMatchObject({
      kind: "test_cases_dropped",
      path: "tests/FooTest.php",
      baseCases: 5,
      headCases: 4,
    });
  });

  it("flags a PHPUnit test deleted below a // see src/* comment and above a docblock through the CLI", async () => {
    const repo = initRepo();
    const fixture = (n: number): string =>
      [
        "<?php",
        "final class FooTest extends TestCase {",
        "  // see src/*",
        ...Array.from(
          { length: n },
          (_, i) => `  public function test${String(i)}(): void {}`,
        ),
        "  /** helper */",
        "  private function helper(): void {}",
        "  /** @test */",
        "  public function four(): void {}",
        "}",
        "",
      ].join("\n");
    write(repo, "tests/SeeTest.php", fixture(4));
    commitAll(repo, "php tests");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "tests/SeeTest.php", fixture(3));
    commitAll(repo);
    const run = await spawnCli(["-C", repo, "hygiene", "--base", base]);
    expect(run.code).toBe(1);
    const out = JSON.parse(run.stdout) as {
      findings: {
        kind: string;
        path: string;
        baseCases: number;
        headCases: number;
      }[];
    };
    expect(out.findings[0]).toMatchObject({
      kind: "test_cases_dropped",
      path: "tests/SeeTest.php",
      baseCases: 5,
      headCases: 4,
    });
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

  it("reports a drop staged in the index, counted from the merge-base", () => {
    const { repo, main, forkSha } = movedBaseRepo();
    write(repo, "test/a.test.ts", 'it("one", () => {});\n');
    git(repo, ["add", "test/a.test.ts"]);
    const r = hygiene({ cwd: repo, base: main, staged: true });
    expect(r.mergeBase).toBe(forkSha);
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: "test_cases_dropped",
        path: "test/a.test.ts",
        baseCases: 3,
        headCases: 1,
      }),
    ]);
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

describe("hygiene intended deletions", () => {
  /** `initRepo()` plus a second test file: test/a.test.ts has 3 cases,
   * test/b.test.ts has 2, both committed as the base. */
  function twoTestFilesRepo(): { repo: string; base: string } {
    const repo = initRepo();
    write(
      repo,
      "test/b.test.ts",
      'it("one", () => {});\nit("two", () => {});\n',
    );
    commitAll(repo, "second test file");
    return { repo, base: git(repo, ["rev-parse", "HEAD"]).trim() };
  }

  it("allows a declared drop whose count covers it and records the allowance", () => {
    const { repo, base } = twoTestFilesRepo();
    write(repo, "test/a.test.ts", 'it("kept", () => {});\n');
    commitAll(repo, "drop two cases");
    const r = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts=2"],
    });
    expect(r.status).toBe("ok");
    expect(r.findings).toEqual([]);
    expect(r.intendedDeclarations).toEqual([
      { path: "test/a.test.ts", declared: 2 },
    ]);
    expect(r.intendedDeletions).toEqual([
      {
        path: "test/a.test.ts",
        baseCases: 3,
        headCases: 1,
        dropped: 2,
        declared: 2,
      },
    ]);
    expect(r.counts).toMatchObject({ testCaseDrops: 0, intendedDeletions: 1 });
    expect(r.warnings).toEqual([]);
  });

  it("reports an undeclared drop and lists the dropped test names", () => {
    const { repo, base } = twoTestFilesRepo();
    write(repo, "test/a.test.ts", 'it("one", () => {});\n');
    commitAll(repo, "drop two cases");
    const r = hygiene({ cwd: repo, base });
    expect(r.status).toBe("fail");
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: "test_cases_dropped",
        path: "test/a.test.ts",
        detail: 'test-case markers fell from 3 to 1; dropped: "two", "three"',
        baseCases: 3,
        headCases: 1,
        droppedNames: ["two", "three"],
      }),
    ]);
    expect(r.intendedDeletions).toEqual([]);
    expect(r.counts).toMatchObject({ testCaseDrops: 1, intendedDeletions: 0 });
  });

  it("applies the allowance to one file and still reports the other drop", () => {
    const { repo, base } = twoTestFilesRepo();
    write(repo, "test/a.test.ts", 'it("kept", () => {});\n');
    write(repo, "test/b.test.ts", 'it("kept", () => {});\n');
    commitAll(repo, "drop a case in each");
    const r = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts=2"],
    });
    expect(r.status).toBe("fail");
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: "test_cases_dropped",
        path: "test/b.test.ts",
      }),
    ]);
    expect(r.intendedDeletions).toHaveLength(1);
    expect(r.intendedDeletions[0]?.path).toBe("test/a.test.ts");
    expect(r.counts).toMatchObject({ testCaseDrops: 1, intendedDeletions: 1 });
  });

  it("reports a drop above the declared count with that count in the detail", () => {
    const { repo, base } = twoTestFilesRepo();
    write(repo, "test/a.test.ts", 'it("one", () => {});\n');
    commitAll(repo, "drop two cases");
    const r = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts=1"],
    });
    expect(r.status).toBe("fail");
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: "test_cases_dropped",
        detail:
          'test-case markers fell from 3 to 1 (declared 1); dropped: "two", "three"',
      }),
    ]);
    expect(r.intendedDeletions).toEqual([]);
    // Consulted, so not stale: the declaration decided this finding.
    expect(r.warnings).toEqual([]);
  });

  it("does not let all excuse a deleted test file and lists its tests instead", () => {
    const { repo, base } = twoTestFilesRepo();
    git(repo, ["rm", "-q", "test/a.test.ts"]);
    commitAll(repo, "delete a test file");
    const r = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts=all"],
    });
    expect(r.status).toBe("fail");
    expect(r.intendedDeletions).toEqual([]);
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: "test_cases_dropped",
        path: "test/a.test.ts",
        baseCases: 3,
        headCases: 0,
        droppedNames: ["one", "two", "three"],
        detail:
          'test-case markers fell from 3 to 0 (file deleted) (declared all, which does not excuse a whole-file drop); dropped: "one", "two", "three"; excuse them with --intended-deletion \'test/a.test.ts::<test name>\' per test',
      }),
    ]);
    // Consulted, so the declaration is not reported stale as well.
    expect(r.warnings).toEqual([]);
  });

  it("keeps a bare path parseable but lets it excuse no partial drop either", () => {
    const { repo, base } = twoTestFilesRepo();
    write(repo, "test/a.test.ts", 'it("one", () => {});\n');
    commitAll(repo, "drop two cases");
    const declared = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts"],
    });
    expect(declared.status).toBe("fail");
    expect(declared.intendedDeclarations).toEqual([
      { path: "test/a.test.ts", declared: "all" },
    ]);
    expect(declared.intendedDeletions).toEqual([]);
    expect(declared.findings[0]?.detail).toContain(
      "declared all, which does not excuse a drop",
    );
    expect(declared.findings[0]?.droppedNames).toEqual(["two", "three"]);
  });

  it("warns for a declaration that allowed nothing and leaves the status alone", () => {
    const { repo, base } = twoTestFilesRepo();
    write(repo, "src/a.ts", "export const a = 2;\n");
    commitAll(repo, "no test case dropped");
    const r = hygiene({
      cwd: repo,
      base,
      intendedDeletions: [
        "docs/absent.test.ts=1",
        "./src/a.ts=1",
        "test/b.test.ts=3",
      ],
    });
    expect(r.status).toBe("ok");
    expect(r.findings).toEqual([]);
    expect(r.intendedDeletions).toEqual([]);
    expect(r.warnings).toEqual([
      "intended deletion not used: docs/absent.test.ts",
      "intended deletion not used: src/a.ts",
      "intended deletion not used: test/b.test.ts",
    ]);
  });

  it("matches a renamed test file's declaration on its head-side path", () => {
    const { repo, base } = twoTestFilesRepo();
    write(
      repo,
      "test/a.test.ts",
      'it("one", () => {});\nit("two", () => {});\n',
    );
    git(repo, ["mv", "test/a.test.ts", "test/renamed.test.ts"]);
    commitAll(repo, "rename with one case dropped");
    // The rename has to survive git's own rename detection for the head-
    // side match this test is about to be exercised; a pure delete-plus-
    // add would match the old path instead.
    expect(git(repo, ["diff", "-M", "--name-status", base, "HEAD"])).toContain(
      "R",
    );
    const r = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["./test/renamed.test.ts=1"],
    });
    expect(r.status).toBe("ok");
    expect(r.intendedDeletions).toEqual([
      {
        path: "test/renamed.test.ts",
        baseCases: 3,
        headCases: 2,
        dropped: 1,
        declared: 1,
      },
    ]);
    const byName = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["./test/renamed.test.ts::three"],
    });
    expect(byName.status).toBe("ok");
    expect(byName.intendedDeletions[0]).toMatchObject({
      path: "test/renamed.test.ts",
      declared: "names",
      names: ["three"],
    });
    // The old name is not the path the finding (or the allowance) uses.
    const oldName = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts=1"],
    });
    expect(oldName.status).toBe("fail");
    expect(oldName.findings[0]?.path).toBe("test/renamed.test.ts");
    expect(oldName.warnings).toEqual([
      "intended deletion not used: test/a.test.ts",
    ]);
  });

  it("allows a declared drop of PHPUnit test methods", () => {
    const repo = initRepo();
    const fixture = (n: number): string =>
      [
        "<?php",
        "final class FooTest extends TestCase {",
        ...Array.from(
          { length: n },
          (_, i) => `  public function test${String(i)}(): void {}`,
        ),
        "}",
        "",
      ].join("\n");
    write(repo, "tests/FooTest.php", fixture(4));
    commitAll(repo, "php tests");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "tests/FooTest.php", fixture(1));
    commitAll(repo);
    const r = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["tests/FooTest.php=3"],
    });
    expect(r.status).toBe("ok");
    expect(r.intendedDeletions).toEqual([
      {
        path: "tests/FooTest.php",
        baseCases: 4,
        headCases: 1,
        dropped: 3,
        declared: 3,
      },
    ]);
    const short = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["tests/FooTest.php=2"],
    });
    expect(short.status).toBe("fail");
    expect(short.findings[0]?.detail).toContain("(declared 2)");
  });

  it("rejects an at-most count of 0, a negative, a non-integer and an empty path", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    for (const spec of [
      "test/a.test.ts=0",
      "test/a.test.ts=-1",
      "test/a.test.ts=1.5",
      "test/a.test.ts=abc",
      "test/a.test.ts=",
      "=2",
      "",
    ]) {
      expect(() =>
        hygiene({ cwd: repo, base, intendedDeletions: [spec] }),
      ).toThrow(UsageError);
    }
    // A bare path and `=all` are the two accepted forms, and `./` is
    // stripped from the path as it is for `--extend-only`.
    const ok = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["./test/a.test.ts", "src/a.ts=all"],
    });
    expect(ok.intendedDeclarations).toEqual([
      { path: "test/a.test.ts", declared: "all" },
      { path: "src/a.ts", declared: "all" },
    ]);
  });

  it("reads the count after the LAST `=`: a path whose name contains `=` needs an explicit count", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    // The bare form of such a path is read as a count (everything after
    // the LAST `=`) and rejected: `y.test.ts` is no count at all.
    expect(() =>
      hygiene({ cwd: repo, base, intendedDeletions: ["test/x=y.test.ts"] }),
    ).toThrow(UsageError);
    // `=<n>` and `=all` both work: the path keeps the `=` and the count
    // is what follows the LAST one.
    const ok = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/x=y.test.ts=all", "test/p=q.test.ts=2"],
    });
    expect(ok.intendedDeclarations).toEqual([
      { path: "test/x=y.test.ts", declared: "all" },
      { path: "test/p=q.test.ts", declared: 2 },
    ]);
  });
});

describe("listTestCases", () => {
  it("names JS/TS markers by their title string, whatever the suffix or quote", () => {
    const content = [
      'it("plain", () => {});',
      "test('single', () => {});",
      "it(`template`, () => {});",
      'it.skip("skipped", () => {});',
      'it.only("focused", () => {});',
      'it.each([1, 2])("each %s", (n) => {});',
      'test.each([[1, 2]])("table, with a comma", () => {});',
      'it("escaped \\"quote\\" inside", () => {});',
      'it("sets x=3 and a :: colon", () => {});',
      "it(",
      '  "title on the next line",',
      "  () => {},",
      ");",
    ].join("\n");
    expect(listTestCases(content, "x.test.ts")).toEqual([
      "plain",
      "single",
      "template",
      "skipped",
      "focused",
      "each %s",
      "table, with a comma",
      'escaped "quote" inside',
      "sets x=3 and a :: colon",
      "title on the next line",
    ]);
  });

  it("collapses every whitespace run in a title, a multi-line template literal included", () => {
    const content =
      "it(`first line\n   second\tline`, () => {});\nit('a   b', () => {});\n";
    expect(listTestCases(content, "x.test.ts")).toEqual([
      "first line second line",
      "a b",
    ]);
  });

  it("names a marker whose title is not a string literal by its own line", () => {
    expect(listTestCases("  it(title, () => {});\n", "x.test.ts")).toEqual([
      "it(title, () => {});",
    ]);
  });

  it("names Python, Go and annotated tests by their function", () => {
    expect(
      listTestCases(
        "def test_one():\n    pass\nasync def test_two(x):\n    pass\ndef helper():\n",
        "test_a.py",
      ),
    ).toEqual(["test_one", "test_two"]);
    expect(
      listTestCases(
        "func TestAlpha(t *testing.T) {}\nfunc helper() {}\nfunc TestBeta_x(t *testing.T) {}\n",
        "a_test.go",
      ),
    ).toEqual(["TestAlpha", "TestBeta_x"]);
    expect(
      listTestCases(
        "  @Test\n  void shouldWork() {}\n  @Test(timeout = 5)\n  @Disabled\n  public void other() {}\n  @test public void inline() {}\n",
        "FooTest.java",
      ),
    ).toEqual(["shouldWork", "other", "inline"]);
  });

  it("lists PHPUnit methods by name and leaves the count as it was", () => {
    const content = [
      "<?php",
      "final class FooTest extends TestCase {",
      "  public function testOne(): void {}",
      "  /** @test */",
      "  public function it_does_things(): void {}",
      "  #[Test]",
      "  public function attributed(): void {}",
      "  public function helper(): void {}",
      "}",
      "",
    ].join("\n");
    expect(listTestCases(content, "tests/FooTest.php")).toEqual([
      "testOne",
      "it_does_things",
      "attributed",
    ]);
    expect(countTestCases(content, "tests/FooTest.php")).toBe(3);
    expect(countPhpTestMethods(content)).toBe(3);
  });

  it("gives one entry per marker, so the list length is the count", () => {
    const content =
      'it("a", () => {});\nit(x, () => {});\nit("a", () => {});\n';
    expect(listTestCases(content, "x.test.ts")).toHaveLength(
      countTestCases(content, "x.test.ts"),
    );
    expect(countTestCases(content, "x.test.ts")).toBe(3);
  });
});

describe("parseIntendedDeletion", () => {
  it("reads <path>::<name> as a name, whatever the title holds", () => {
    expect(parseIntendedDeletion("./test/a.test.ts::one")).toEqual({
      path: "test/a.test.ts",
      names: ["one"],
    });
    for (const title of [
      "a, b, c",
      "sets x=3",
      "ends with =all",
      "has :: inside",
      "  padded  ",
    ]) {
      expect(parseIntendedDeletion(`test/a.test.ts::${title}`)).toEqual({
        path: "test/a.test.ts",
        names: [title.trim()],
      });
    }
  });

  it("collapses whitespace inside a declared name", () => {
    expect(parseIntendedDeletion("p.test.ts::a \t  b\n c")).toEqual({
      path: "p.test.ts",
      names: ["a b c"],
    });
  });

  it("keeps the count forms as they were", () => {
    expect(parseIntendedDeletion("test/a.test.ts=2")).toEqual({
      path: "test/a.test.ts",
      declared: 2,
    });
    expect(parseIntendedDeletion("test/a.test.ts=all")).toEqual({
      path: "test/a.test.ts",
      declared: "all",
    });
    expect(parseIntendedDeletion("test/a.test.ts")).toEqual({
      path: "test/a.test.ts",
      declared: "all",
    });
  });

  it("rejects an empty path or an empty name", () => {
    for (const spec of ["::one", "test/a.test.ts::", "test/a.test.ts::   "]) {
      expect(() => parseIntendedDeletion(spec)).toThrow(UsageError);
    }
  });
});

describe("hygiene whole-file drops are declared by name", () => {
  /** `initRepo()` (test/a.test.ts: one, two, three) plus a file with
   * awkward titles, a Go file and a Python file, committed as the base. */
  function namedTestsRepo(): { repo: string; base: string } {
    const repo = initRepo();
    write(
      repo,
      "test/c.test.ts",
      'it("handles a, b", () => {});\nit("sets x=3", () => {});\nit("has :: a colon", () => {});\n',
    );
    write(
      repo,
      "pkg/foo_test.go",
      "package foo\n\nfunc TestAlpha(t *testing.T) {}\n\nfunc TestBeta(t *testing.T) {}\n",
    );
    write(
      repo,
      "py/test_sample.py",
      "def test_one():\n    pass\n\nasync def test_two():\n    pass\n",
    );
    commitAll(repo, "more tests");
    return { repo, base: git(repo, ["rev-parse", "HEAD"]).trim() };
  }

  function deleteFile(repo: string, rel: string): void {
    git(repo, ["rm", "-q", rel]);
    commitAll(repo, `delete ${rel}`);
  }

  it("excuses a deleted file whose tests are all named, and records the names", () => {
    const { repo, base } = namedTestsRepo();
    deleteFile(repo, "test/a.test.ts");
    const r = hygiene({
      cwd: repo,
      base,
      intendedDeletions: [
        "test/a.test.ts::one",
        "test/a.test.ts::two",
        "test/a.test.ts::three",
      ],
    });
    expect(r.status).toBe("ok");
    expect(r.findings).toEqual([]);
    expect(r.intendedDeclarations).toEqual([
      { path: "test/a.test.ts", names: ["one", "two", "three"] },
    ]);
    expect(r.intendedDeletions).toEqual([
      {
        path: "test/a.test.ts",
        baseCases: 3,
        headCases: 0,
        dropped: 3,
        declared: "names",
        names: ["one", "two", "three"],
      },
    ]);
    expect(r.counts).toMatchObject({ testCaseDrops: 0, intendedDeletions: 1 });
    expect(r.warnings).toEqual([]);
  });

  it("excuses a file emptied of its tests the same way as a deleted one", () => {
    const { repo, base } = namedTestsRepo();
    write(repo, "test/a.test.ts", "// everything moved elsewhere\n");
    commitAll(repo, "empty the file");
    const blanket = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts=all"],
    });
    expect(blanket.status).toBe("fail");
    expect(blanket.findings[0]).toMatchObject({
      headCases: 0,
      droppedNames: ["one", "two", "three"],
    });
    expect(blanket.findings[0]?.detail).not.toContain("file deleted");
    const named = hygiene({
      cwd: repo,
      base,
      intendedDeletions: [
        "test/a.test.ts::one",
        "test/a.test.ts::two",
        "test/a.test.ts::three",
      ],
    });
    expect(named.status).toBe("ok");
  });

  it("reports a dropped test the declaration leaves out and names it", () => {
    const { repo, base } = namedTestsRepo();
    deleteFile(repo, "test/a.test.ts");
    const r = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts::one", "test/a.test.ts::two"],
    });
    expect(r.status).toBe("fail");
    expect(r.intendedDeletions).toEqual([]);
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: "test_cases_dropped",
        path: "test/a.test.ts",
        droppedNames: ["one", "two", "three"],
      }),
    ]);
    expect(r.findings[0]?.detail).toContain("2 of 3 dropped tests named");
    expect(r.findings[0]?.detail).toContain('not named: "three"');
    expect(r.counts).toMatchObject({ testCaseDrops: 1, intendedDeletions: 0 });
  });

  it("throws a usage error for a name that is not among the dropped tests", () => {
    const { repo, base } = namedTestsRepo();
    deleteFile(repo, "test/a.test.ts");
    const all = [
      "test/a.test.ts::one",
      "test/a.test.ts::two",
      "test/a.test.ts::three",
    ];
    expect(() =>
      hygiene({
        cwd: repo,
        base,
        intendedDeletions: [...all, "test/a.test.ts::four"],
      }),
    ).toThrow(
      /not dropped.*test\/a\.test\.ts: "four" declared 1 time\(s\), dropped 0 \(all dropped tests: "one", "two", "three"\)/,
    );
    // Misspelled while the rest are right: still an error, not a finding.
    expect(() =>
      hygiene({
        cwd: repo,
        base,
        intendedDeletions: ["test/a.test.ts::One", ...all.slice(1)],
      }),
    ).toThrow(UsageError);
  });

  it("throws for an unknown name on a partial drop too", () => {
    const { repo, base } = namedTestsRepo();
    write(repo, "test/a.test.ts", 'it("one", () => {});\n');
    commitAll(repo, "keep one");
    expect(() =>
      hygiene({
        cwd: repo,
        base,
        intendedDeletions: ["test/a.test.ts::one"],
      }),
    ).toThrow(UsageError);
  });

  it("does not let a count equal to the number of dropped tests excuse a whole-file drop", () => {
    const { repo, base } = namedTestsRepo();
    deleteFile(repo, "test/a.test.ts");
    for (const n of [3, 99]) {
      const r = hygiene({
        cwd: repo,
        base,
        intendedDeletions: [`test/a.test.ts=${String(n)}`],
      });
      expect(r.status).toBe("fail");
      expect(r.intendedDeletions).toEqual([]);
      expect(r.findings[0]?.detail).toContain(
        `declared ${String(n)}, a count does not excuse a whole-file drop`,
      );
      expect(r.findings[0]?.droppedNames).toEqual(["one", "two", "three"]);
    }
  });

  it("lets the names decide when a count or all comes with them", () => {
    const { repo, base } = namedTestsRepo();
    deleteFile(repo, "test/a.test.ts");
    const names = [
      "test/a.test.ts::one",
      "test/a.test.ts::two",
      "test/a.test.ts::three",
    ];
    for (const extra of ["test/a.test.ts=3", "test/a.test.ts=all"]) {
      const full = hygiene({
        cwd: repo,
        base,
        intendedDeletions: [extra, ...names],
      });
      expect(full.status).toBe("ok");
      expect(full.intendedDeletions[0]).toMatchObject({ declared: "names" });
      const partial = hygiene({
        cwd: repo,
        base,
        intendedDeletions: [extra, names[0] as string],
      });
      expect(partial.status).toBe("fail");
    }
  });

  it("excuses a partial drop by naming every dropped test, or by a covering count", () => {
    const { repo, base } = namedTestsRepo();
    write(repo, "test/a.test.ts", 'it("one", () => {});\n');
    commitAll(repo, "keep one");
    const named = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts::two", "test/a.test.ts::three"],
    });
    expect(named.status).toBe("ok");
    expect(named.intendedDeletions).toEqual([
      {
        path: "test/a.test.ts",
        baseCases: 3,
        headCases: 1,
        dropped: 2,
        declared: "names",
        names: ["two", "three"],
      },
    ]);
    const incomplete = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts::two"],
    });
    expect(incomplete.status).toBe("fail");
    expect(incomplete.findings[0]?.detail).toContain('not named: "three"');
    // A covering count still excuses it, unchanged, and wins over names
    // that leave one test out.
    const counted = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts=2", "test/a.test.ts::two"],
    });
    expect(counted.status).toBe("ok");
    expect(counted.intendedDeletions[0]).toMatchObject({ declared: 2 });
    const tooSmall = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts=1"],
    });
    expect(tooSmall.status).toBe("fail");
    expect(tooSmall.findings[0]?.detail).toContain("(declared 1)");
  });

  it("round-trips titles that hold commas, = and :: through the declaration", () => {
    const { repo, base } = namedTestsRepo();
    deleteFile(repo, "test/c.test.ts");
    const r = hygiene({
      cwd: repo,
      base,
      intendedDeletions: [
        "test/c.test.ts::handles a, b",
        "test/c.test.ts::sets x=3",
        "test/c.test.ts::has :: a colon",
      ],
    });
    expect(r.status).toBe("ok");
    expect(r.intendedDeletions[0]).toMatchObject({
      declared: "names",
      names: ["handles a, b", "sets x=3", "has :: a colon"],
    });
    // The finding spells the same titles out, JSON-quoted.
    const undeclared = hygiene({ cwd: repo, base });
    expect(undeclared.findings[0]?.droppedNames).toEqual([
      "handles a, b",
      "sets x=3",
      "has :: a colon",
    ]);
    expect(undeclared.findings[0]?.detail).toContain(
      '"handles a, b", "sets x=3", "has :: a colon"',
    );
  });

  it("names Go and Python tests and rejects all for them as well", () => {
    const { repo, base } = namedTestsRepo();
    deleteFile(repo, "pkg/foo_test.go");
    deleteFile(repo, "py/test_sample.py");
    const blanket = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["pkg/foo_test.go=all", "py/test_sample.py"],
    });
    expect(blanket.status).toBe("fail");
    expect(blanket.findings.map((f) => [f.path, f.droppedNames])).toEqual([
      ["pkg/foo_test.go", ["TestAlpha", "TestBeta"]],
      ["py/test_sample.py", ["test_one", "test_two"]],
    ]);
    const named = hygiene({
      cwd: repo,
      base,
      intendedDeletions: [
        "pkg/foo_test.go::TestAlpha",
        "pkg/foo_test.go::TestBeta",
        "py/test_sample.py::test_one",
        "py/test_sample.py::test_two",
      ],
    });
    expect(named.status).toBe("ok");
    expect(named.intendedDeletions.map((d) => d.path)).toEqual([
      "pkg/foo_test.go",
      "py/test_sample.py",
    ]);
  });

  it("needs a duplicated title declared as often as it was dropped", () => {
    const repo = initRepo();
    write(
      repo,
      "test/d.test.ts",
      'it("same", () => {});\nit("same", () => {});\nit("other", () => {});\n',
    );
    commitAll(repo, "duplicate titles");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["rm", "-q", "test/d.test.ts"]);
    commitAll(repo, "delete");
    const twice = hygiene({
      cwd: repo,
      base,
      intendedDeletions: [
        "test/d.test.ts::same",
        "test/d.test.ts::same",
        "test/d.test.ts::other",
      ],
    });
    expect(twice.status).toBe("ok");
    expect(twice.intendedDeletions[0]).toMatchObject({
      dropped: 3,
      names: ["same", "same", "other"],
    });
    const once = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/d.test.ts::same", "test/d.test.ts::other"],
    });
    expect(once.status).toBe("fail");
    expect(once.findings[0]?.droppedNames).toEqual(["same", "same", "other"]);
    expect(once.findings[0]?.detail).toContain(
      '(2 of 3 dropped tests named); not named: "same" x2 (named x1)',
    );
  });

  describe("a title that more than one dropped case carries", () => {
    /** a.test.ts: describe A { works, keeps } and describe B { works }; the
     * change keeps only A's `keeps`, so B's unrelated `works` goes too. */
    function worksTwiceRepo(): { repo: string; base: string } {
      const repo = initRepo();
      write(
        repo,
        "test/w.test.ts",
        [
          'describe("A", () => {',
          '  it("works", () => {});',
          '  it("keeps", () => {});',
          "});",
          'describe("B", () => {',
          '  it("works", () => {});',
          "});",
          "",
        ].join("\n"),
      );
      commitAll(repo, "works twice");
      const base = git(repo, ["rev-parse", "HEAD"]).trim();
      write(
        repo,
        "test/w.test.ts",
        'describe("A", () => {\n  it("keeps", () => {});\n});\n',
      );
      commitAll(repo, "drop both works");
      return { repo, base };
    }

    it("is a finding naming it twice when declared once, ok when declared twice", () => {
      const { repo, base } = worksTwiceRepo();
      const undeclared = hygiene({ cwd: repo, base });
      expect(undeclared.findings[0]?.droppedNames).toEqual(["works", "works"]);
      expect(undeclared.findings[0]?.detail).toContain('dropped: "works" x2');
      const once = hygiene({
        cwd: repo,
        base,
        intendedDeletions: ["test/w.test.ts::works"],
      });
      expect(once.status).toBe("fail");
      expect(once.intendedDeletions).toEqual([]);
      expect(once.findings[0]?.droppedNames).toEqual(["works", "works"]);
      expect(once.findings[0]?.detail).toContain(
        'not named: "works" x2 (named x1)',
      );
      const twice = hygiene({
        cwd: repo,
        base,
        intendedDeletions: ["test/w.test.ts::works", "test/w.test.ts::works"],
      });
      expect(twice.status).toBe("ok");
      expect(twice.intendedDeletions[0]).toMatchObject({
        declared: "names",
        names: ["works", "works"],
      });
    });

    it("is a usage error when declared more often than it was dropped", () => {
      const { repo, base } = worksTwiceRepo();
      expect(() =>
        hygiene({
          cwd: repo,
          base,
          intendedDeletions: [
            "test/w.test.ts::works",
            "test/w.test.ts::works",
            "test/w.test.ts::works",
          ],
        }),
      ).toThrow(
        /"works" declared 3 time\(s\), dropped 2 \(all dropped tests: "works" x2\)/,
      );
      // Dropped once, declared twice: the same error for a single case.
      write(repo, "test/one.test.ts", 'it("solo", () => {});\n');
      commitAll(repo, "solo");
      const soloBase = git(repo, ["rev-parse", "HEAD"]).trim();
      git(repo, ["rm", "-q", "test/one.test.ts"]);
      commitAll(repo, "drop solo");
      expect(() =>
        hygiene({
          cwd: repo,
          base: soloBase,
          intendedDeletions: [
            "test/one.test.ts::solo",
            "test/one.test.ts::solo",
          ],
        }),
      ).toThrow(UsageError);
    });

    it("merges flag and file per name by the larger count, never the sum", () => {
      const { repo, base } = worksTwiceRepo();
      const w = "test/w.test.ts::works";
      const names = (flag: string[], file: string[]): string[] | undefined =>
        hygiene({
          cwd: repo,
          base,
          intendedDeletions: flag,
          intendedDeletionsFromFile: file,
        }).intendedDeclarations[0]?.names;
      // Once in each source counts once (a sum of 2 would excuse the drop).
      const bothOnce = hygiene({
        cwd: repo,
        base,
        intendedDeletions: [w],
        intendedDeletionsFromFile: [w],
      });
      expect(bothOnce.intendedDeclarations[0]?.names).toEqual(["works"]);
      expect(bothOnce.status).toBe("fail");
      // Twice in one source, once in the other: two, whichever way round.
      expect(names([w, w], [w])).toEqual(["works", "works"]);
      expect(names([w], [w, w])).toEqual(["works", "works"]);
      expect(names([w, w], [w, w])).toEqual(["works", "works"]);
      // Flag only and file only.
      expect(names([w, w], [])).toEqual(["works", "works"]);
      expect(names([], [w])).toEqual(["works"]);
      const ok = hygiene({
        cwd: repo,
        base,
        intendedDeletions: [w],
        intendedDeletionsFromFile: [w, w],
      });
      expect(ok.status).toBe("ok");
    });

    it("holds for a Python method name repeated across classes", () => {
      const repo = initRepo();
      write(
        repo,
        "py/test_dup.py",
        [
          "class A:",
          "    def test_x(self):",
          "        pass",
          "",
          "class B:",
          "    def test_x(self):",
          "        pass",
          "",
          "    def test_y(self):",
          "        pass",
          "",
        ].join("\n"),
      );
      commitAll(repo, "python duplicates");
      const base = git(repo, ["rev-parse", "HEAD"]).trim();
      git(repo, ["rm", "-q", "py/test_dup.py"]);
      commitAll(repo, "delete");
      const once = hygiene({
        cwd: repo,
        base,
        intendedDeletions: ["py/test_dup.py::test_x", "py/test_dup.py::test_y"],
      });
      expect(once.status).toBe("fail");
      expect(once.findings[0]?.droppedNames).toEqual([
        "test_x",
        "test_x",
        "test_y",
      ]);
      const twice = hygiene({
        cwd: repo,
        base,
        intendedDeletions: [
          "py/test_dup.py::test_x",
          "py/test_dup.py::test_x",
          "py/test_dup.py::test_y",
        ],
      });
      expect(twice.status).toBe("ok");
    });
  });

  it("caps the names in the detail but keeps them all on the finding", () => {
    const repo = initRepo();
    const titles = Array.from({ length: 12 }, (_, i) => `case ${String(i)}`);
    write(
      repo,
      "test/many.test.ts",
      titles.map((t) => `it("${t}", () => {});\n`).join(""),
    );
    commitAll(repo, "many tests");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["rm", "-q", "test/many.test.ts"]);
    commitAll(repo, "delete");
    const r = hygiene({ cwd: repo, base });
    expect(r.findings[0]?.droppedNames).toEqual(titles);
    expect(r.findings[0]?.detail).toContain('"case 9", and 2 more');
    expect(r.findings[0]?.detail).not.toContain("case 10");
  });

  it("lists every dropped name, with counts, in the stale-name error", () => {
    const repo = initRepo();
    const titles = Array.from({ length: 12 }, (_, i) => `case ${String(i)}`);
    write(
      repo,
      "test/many.test.ts",
      [...titles, "case 0"].map((t) => `it("${t}", () => {});\n`).join(""),
    );
    commitAll(repo, "many tests");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["rm", "-q", "test/many.test.ts"]);
    commitAll(repo, "delete");
    let message = "";
    try {
      hygiene({
        cwd: repo,
        base,
        intendedDeletions: ["test/many.test.ts::nope"],
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('"case 0" x2');
    expect(message).toContain('"case 11"');
    expect(message).not.toContain("more");
  });

  it("warns for a names declaration on a path that dropped nothing", () => {
    const { repo, base } = namedTestsRepo();
    write(repo, "src/a.ts", "export const a = 2;\n");
    commitAll(repo, "unrelated");
    const r = hygiene({
      cwd: repo,
      base,
      intendedDeletions: ["test/a.test.ts::one"],
    });
    expect(r.status).toBe("ok");
    expect(r.warnings).toEqual(["intended deletion not used: test/a.test.ts"]);
  });

  it("merges a count and names declared for one path in any order", () => {
    const { repo, base } = namedTestsRepo();
    const specs = [
      "test/a.test.ts=all",
      "test/a.test.ts=2",
      "test/a.test.ts::one",
    ];
    for (const order of [specs, [...specs].reverse()]) {
      const r = hygiene({ cwd: repo, base, intendedDeletions: order });
      expect(r.intendedDeclarations).toEqual([
        { path: "test/a.test.ts", declared: 2, names: ["one"] },
      ]);
    }
    // The same name from the flag and from the file counts once; the
    // sources swap without changing the result.
    const one = "test/a.test.ts::one";
    for (const [flag, file] of [
      [[one], [one]],
      [[one, "test/a.test.ts=3"], [one]],
      [[one], [one, "test/a.test.ts=3"]],
    ] as const) {
      const r = hygiene({
        cwd: repo,
        base,
        intendedDeletions: flag,
        intendedDeletionsFromFile: file,
      });
      expect(r.intendedDeclarations[0]?.names).toEqual(["one"]);
    }
  });
});

describe("hygiene intended deletions CLI", () => {
  function repoWithDrop(): { repo: string; base: string } {
    const repo = initRepo();
    write(
      repo,
      "test/b.test.ts",
      'it("one", () => {});\nit("two", () => {});\n',
    );
    commitAll(repo, "second test file");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "test/a.test.ts", 'it("kept", () => {});\n');
    commitAll(repo, "drop two cases");
    return { repo, base };
  }

  it("reads declarations from --intended-deletion-file, blank and # lines ignored", async () => {
    const { repo, base } = repoWithDrop();
    write(repo, "intended.txt", "# intended deletions\n\ntest/a.test.ts=2\n");
    commitAll(repo, "declaration file");
    const run = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--intended-deletion-file",
      "intended.txt",
    ]);
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout) as {
      intended_declarations: { path: string; declared: number | string }[];
      intended_deletions: { path: string; dropped: number }[];
      counts: { intendedDeletions: number };
    };
    expect(out.intended_declarations).toEqual([
      { path: "test/a.test.ts", declared: 2 },
    ]);
    expect(out.intended_deletions).toEqual([
      {
        path: "test/a.test.ts",
        baseCases: 3,
        headCases: 1,
        dropped: 2,
        declared: 2,
      },
    ]);
    expect(out.counts.intendedDeletions).toBe(1);
  });

  it("treats an empty declaration file as no option at all", async () => {
    const { repo, base } = repoWithDrop();
    write(repo, "intended.txt", "# nothing here\n\n");
    const withEmpty = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--intended-deletion-file",
      "intended.txt",
    ]);
    const without = await spawnCli(["-C", repo, "hygiene", "--base", base]);
    expect(withEmpty.code).toBe(1);
    expect(without.code).toBe(1);
    const empty = JSON.parse(withEmpty.stdout) as {
      intended_declarations: unknown[];
      warnings: string[];
    };
    expect(empty.intended_declarations).toEqual([]);
    expect(empty.warnings).toEqual([]);
    const missing = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--intended-deletion-file",
      "no-such-file.txt",
    ]);
    expect(missing.code).toBe(2);
  });

  it("applies both forms, the larger declared count winning for one path", async () => {
    const { repo, base } = repoWithDrop();
    write(repo, "test/b.test.ts", 'it("one", () => {});\n');
    write(repo, "intended.txt", "test/a.test.ts=5\ntest/b.test.ts=all\n");
    commitAll(repo, "second drop and a declaration file");
    const run = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--intended-deletion",
      "test/a.test.ts=1",
      "--intended-deletion",
      "test/b.test.ts=1",
      "--intended-deletion-file",
      "intended.txt",
    ]);
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout) as {
      intended_declarations: { path: string; declared: number | string }[];
      intended_deletions: { path: string; declared: number | string }[];
    };
    // The file's 5 covers the 2-case drop the flag's 1 would not, and a
    // number beats `all` (which excuses nothing); the smaller number and
    // the `all` are what lose.
    expect(out.intended_declarations).toEqual([
      { path: "test/a.test.ts", declared: 5 },
      { path: "test/b.test.ts", declared: 1 },
    ]);
    expect(out.intended_deletions).toEqual([
      expect.objectContaining({ path: "test/a.test.ts", declared: 5 }),
      expect.objectContaining({ path: "test/b.test.ts", declared: 1 }),
    ]);
  });

  it("resolves a relative --intended-deletion-file against the -C directory", async () => {
    const { repo, base } = repoWithDrop();
    write(repo, "intended.txt", "test/a.test.ts=2\n");
    commitAll(repo, "declaration file");
    const run = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--intended-deletion-file",
      "intended.txt",
    ]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).intended_deletions).toHaveLength(1);
  });

  it("exits 2 for an unusable --intended-deletion value", async () => {
    const { repo, base } = repoWithDrop();
    for (const spec of ["test/a.test.ts=0", "test/a.test.ts=abc"]) {
      const run = await spawnCli([
        "-C",
        repo,
        "hygiene",
        "--base",
        base,
        "--intended-deletion",
        spec,
      ]);
      expect(run.code).toBe(2);
      expect(JSON.parse(run.stdout).status).toBe("usage_error");
    }
  });

  it("echoes the declarations and keeps the applied allowances whole under a small -m", async () => {
    const repo = initRepo();
    for (let i = 0; i < 25; i++) {
      write(
        repo,
        `test/t${String(i)}.test.ts`,
        'it("one", () => {});\nit("two", () => {});\n',
      );
    }
    commitAll(repo, "many test files");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    for (let i = 0; i < 25; i++) {
      write(repo, `test/t${String(i)}.test.ts`, 'it("one", () => {});\n');
    }
    commitAll(repo, "each drops one case");
    const declared = "test/t0.test.ts=1";
    const full = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--intended-deletion",
      declared,
    ]);
    const tight = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--intended-deletion",
      declared,
      "-m",
      "900",
    ]);
    const big = JSON.parse(full.stdout) as {
      counts: { testCaseDrops: number; intendedDeletions: number };
      intended_declarations: unknown[];
      intended_deletions: unknown[];
    };
    expect(big.counts).toMatchObject({
      testCaseDrops: 24,
      intendedDeletions: 1,
    });
    expect(big.intended_declarations).toEqual([
      { path: "test/t0.test.ts", declared: 1 },
    ]);
    const cut = JSON.parse(tight.stdout) as {
      truncated?: boolean;
      counts: { intendedDeletions: number };
      intended_declarations?: unknown[];
      intended_deletions: { path: string; dropped: number }[];
      findings?: unknown[];
    };
    expect(cut.truncated).toBe(true);
    // The allowance is agent input: unlike `findings` (and the
    // declaration echo), which the reduction cuts away, it survives
    // whole, and it still agrees with `counts`.
    expect(cut.findings).toBeUndefined();
    expect(cut.intended_declarations).toBeUndefined();
    expect(cut.intended_deletions).toEqual(big.intended_deletions);
    expect(cut.intended_deletions).toEqual([
      {
        path: "test/t0.test.ts",
        baseCases: 2,
        headCases: 1,
        dropped: 1,
        declared: 1,
      },
    ]);
    expect(cut.counts.intendedDeletions).toBe(cut.intended_deletions.length);
  });
});

describe("hygiene named deletions CLI", () => {
  /** test/a.test.ts (one, two, three) deleted, and test/c.test.ts with
   * awkward titles deleted, after the base commit. */
  function deletedRepo(): { repo: string; base: string } {
    const repo = initRepo();
    write(
      repo,
      "test/c.test.ts",
      'it("handles a, b", () => {});\nit("sets x=3", () => {});\n',
    );
    commitAll(repo, "second test file");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["rm", "-q", "test/a.test.ts", "test/c.test.ts"]);
    commitAll(repo, "delete both test files");
    return { repo, base };
  }

  type Out = {
    status: string;
    intended_declarations: { path: string; names?: string[] }[];
    intended_deletions: { path: string; declared: string; names?: string[] }[];
    findings: { path: string; detail: string; droppedNames: string[] }[];
  };

  async function run(
    repo: string,
    base: string,
    extra: string[],
  ): Promise<{ code: number | null; out: Out }> {
    const r = await spawnCli(["-C", repo, "hygiene", "--base", base, ...extra]);
    return { code: r.code, out: JSON.parse(r.stdout) as Out };
  }

  const flag = (spec: string): string[] => ["--intended-deletion", spec];

  it("flag only: every name on the flag excuses the deleted file", async () => {
    const { repo, base } = deletedRepo();
    const { code, out } = await run(repo, base, [
      ...flag("test/a.test.ts::one"),
      ...flag("test/a.test.ts::two"),
      ...flag("test/a.test.ts::three"),
      ...flag("test/c.test.ts::handles a, b"),
      ...flag("test/c.test.ts::sets x=3"),
    ]);
    expect(code).toBe(0);
    expect(out.intended_deletions).toEqual([
      expect.objectContaining({
        path: "test/a.test.ts",
        declared: "names",
        names: ["one", "two", "three"],
      }),
      expect.objectContaining({
        path: "test/c.test.ts",
        declared: "names",
        names: ["handles a, b", "sets x=3"],
      }),
    ]);
  });

  it("file only: one name per line, commas and = in a title intact", async () => {
    const { repo, base } = deletedRepo();
    write(
      repo,
      "intended.txt",
      [
        "# the removed design",
        "test/a.test.ts::one",
        "test/a.test.ts::two",
        "test/a.test.ts::three",
        "test/c.test.ts::handles a, b",
        "test/c.test.ts::sets x=3",
        "",
      ].join("\n"),
    );
    const { code, out } = await run(repo, base, [
      "--intended-deletion-file",
      "intended.txt",
    ]);
    expect(code).toBe(0);
    expect(out.intended_deletions.map((d) => d.names)).toEqual([
      ["one", "two", "three"],
      ["handles a, b", "sets x=3"],
    ]);
  });

  it("flag and file naming different tests merge: neither source wins", async () => {
    const { repo, base } = deletedRepo();
    write(
      repo,
      "intended.txt",
      "test/a.test.ts::three\ntest/c.test.ts::sets x=3\n",
    );
    const common = [
      ...flag("test/a.test.ts::one"),
      ...flag("test/a.test.ts::two"),
      ...flag("test/c.test.ts::handles a, b"),
    ];
    const { code, out } = await run(repo, base, [
      ...common,
      "--intended-deletion-file",
      "intended.txt",
    ]);
    expect(code).toBe(0);
    expect(out.intended_declarations).toEqual([
      { path: "test/a.test.ts", names: ["one", "two", "three"] },
      { path: "test/c.test.ts", names: ["handles a, b", "sets x=3"] },
    ]);
    // Either source alone leaves a test out, so each alone is a finding.
    const flagOnly = await run(repo, base, common);
    expect(flagOnly.code).toBe(1);
    expect(flagOnly.out.findings.map((f) => f.path)).toEqual([
      "test/a.test.ts",
      "test/c.test.ts",
    ]);
    const fileOnly = await run(repo, base, [
      "--intended-deletion-file",
      "intended.txt",
    ]);
    expect(fileOnly.code).toBe(1);
  });

  it("flag and file naming the same test count it once", async () => {
    const { repo, base } = deletedRepo();
    write(repo, "intended.txt", "test/a.test.ts::one\ntest/a.test.ts::two\n");
    const { code, out } = await run(repo, base, [
      ...flag("test/a.test.ts::one"),
      ...flag("test/a.test.ts::two"),
      ...flag("test/a.test.ts::three"),
      ...flag("test/c.test.ts::handles a, b"),
      ...flag("test/c.test.ts::sets x=3"),
      "--intended-deletion-file",
      "intended.txt",
    ]);
    expect(code).toBe(0);
    expect(out.intended_declarations[0]).toEqual({
      path: "test/a.test.ts",
      names: ["one", "two", "three"],
    });
  });

  it("exits 1 with the dropped names for a blanket all, from the flag and from the file", async () => {
    const { repo, base } = deletedRepo();
    write(repo, "intended.txt", "test/a.test.ts=all\ntest/c.test.ts\n");
    for (const extra of [
      [...flag("test/a.test.ts=all"), ...flag("test/c.test.ts")],
      ["--intended-deletion-file", "intended.txt"],
    ]) {
      const { code, out } = await run(repo, base, extra);
      expect(code).toBe(1);
      expect(out.findings.map((f) => [f.path, f.droppedNames])).toEqual([
        ["test/a.test.ts", ["one", "two", "three"]],
        ["test/c.test.ts", ["handles a, b", "sets x=3"]],
      ]);
      expect(out.findings[0]?.detail).toContain(
        "does not excuse a whole-file drop",
      );
    }
  });

  it("declares a multi-line template title through the file", async () => {
    const repo = initRepo();
    write(
      repo,
      "test/m.test.ts",
      "it(`first line\n    second line`, () => {});\n",
    );
    commitAll(repo, "multi-line title");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["rm", "-q", "test/m.test.ts"]);
    commitAll(repo, "delete");
    write(repo, "intended.txt", "test/m.test.ts::first line second line\n");
    const viaFile = await run(repo, base, [
      "--intended-deletion-file",
      "intended.txt",
    ]);
    expect(viaFile.code).toBe(0);
    expect(viaFile.out.intended_deletions[0]?.names).toEqual([
      "first line second line",
    ]);
    const viaFlag = await run(repo, base, [
      ...flag("test/m.test.ts::first  line   second line"),
    ]);
    expect(viaFlag.code).toBe(0);
  });

  it("counts a repeated title per source and takes the larger count", async () => {
    const repo = initRepo();
    write(
      repo,
      "test/w.test.ts",
      'it("works", () => {});\nit("works", () => {});\n',
    );
    commitAll(repo, "works twice");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["rm", "-q", "test/w.test.ts"]);
    commitAll(repo, "delete");
    write(repo, "once.txt", "test/w.test.ts::works\n");
    write(repo, "twice.txt", "test/w.test.ts::works\ntest/w.test.ts::works\n");
    const w = "test/w.test.ts::works";
    const bothOnce = await run(repo, base, [
      ...flag(w),
      "--intended-deletion-file",
      "once.txt",
    ]);
    expect(bothOnce.code).toBe(1);
    expect(bothOnce.out.findings[0]?.droppedNames).toEqual(["works", "works"]);
    expect(bothOnce.out.findings[0]?.detail).toContain('"works" x2');
    const flagTwiceFileOnce = await run(repo, base, [
      ...flag(w),
      ...flag(w),
      "--intended-deletion-file",
      "once.txt",
    ]);
    expect(flagTwiceFileOnce.code).toBe(0);
    const flagOnceFileTwice = await run(repo, base, [
      ...flag(w),
      "--intended-deletion-file",
      "twice.txt",
    ]);
    expect(flagOnceFileTwice.code).toBe(0);
    const over = await run(repo, base, [...flag(w), ...flag(w), ...flag(w)]);
    expect(over.code).toBe(2);
    expect(over.out.status).toBe("usage_error");
  });

  it("exits 2 with a usage error for a name that was not dropped", async () => {
    const { repo, base } = deletedRepo();
    const { code, out } = await run(repo, base, [
      ...flag("test/a.test.ts::nope"),
    ]);
    expect(code).toBe(2);
    expect(out.status).toBe("usage_error");
  });

  it("spells the dropped names out in the text view", async () => {
    const { repo, base } = deletedRepo();
    const r = await spawnCli([
      "-C",
      repo,
      "-f",
      "text",
      "hygiene",
      "--base",
      base,
      ...flag("test/a.test.ts::one"),
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      'test_cases_dropped: test/a.test.ts: test-case markers fell from 3 to 0 (file deleted) (1 of 3 dropped tests named); not named: "two", "three"',
    );
    const ok = await spawnCli([
      "-C",
      repo,
      "-f",
      "text",
      "hygiene",
      "--base",
      base,
      ...flag("test/a.test.ts::one"),
      ...flag("test/a.test.ts::two"),
      ...flag("test/a.test.ts::three"),
      ...flag("test/c.test.ts::handles a, b"),
      ...flag("test/c.test.ts::sets x=3"),
    ]);
    expect(ok.stdout).toContain(
      'intended deletion: test/a.test.ts: 3 -> 0 (3 dropped, declared by name: "one", "two", "three")',
    );
  });
});

const PHP_TWO_METHODS = [
  "<?php",
  "final class FooTest extends TestCase {",
  "  public function testOne(): void {}",
  "  public function testTwo(): void {}",
  "}",
  "",
].join("\n");
const PHP_ONE_METHOD = [
  "<?php",
  "final class FooTest extends TestCase {",
  "  public function testOne(): void {}",
  "}",
  "",
].join("\n");

/** A repo whose base commit holds `tests/FooTest.php` with two PHPUnit
 * methods; the tree is clean when this returns. */
function phpRepo(): { repo: string; base: string } {
  const repo = initRepo();
  write(repo, "tests/FooTest.php", PHP_TWO_METHODS);
  commitAll(repo, "php test");
  return { repo, base: git(repo, ["rev-parse", "HEAD"]).trim() };
}

/** Runs `fn` with a `git` first on PATH that fails when `subcommand` is
 * anywhere in its argument list (global options such as
 * `--no-optional-locks` come before the subcommand) and otherwise runs the
 * real git. */
function withFailingGit<T>(subcommand: string, fn: () => T): T {
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const shimDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-git-shim-"),
  );
  tmpDirs.push(shimDir);
  fs.writeFileSync(
    path.join(shimDir, "git"),
    `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = ${subcommand} ]; then echo "simulated ${subcommand} failure" >&2; exit 128; fi\ndone\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${savedPath ?? ""}`;
  try {
    return fn();
  } finally {
    process.env.PATH = savedPath;
  }
}

function uncommittedWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((w) => w.includes("uncommitted changes"));
}

describe("hygiene: uncommitted changes outside the comparison", () => {
  it("warns about an unstaged test-method deletion that plain mode does not see, and --worktree finds it", async () => {
    const { repo, base } = phpRepo();
    write(repo, "tests/FooTest.php", PHP_ONE_METHOD);

    const plain = hygiene({ cwd: repo, base });
    expect(plain.status).toBe("ok");
    expect(plain.findings).toEqual([]);
    expect(plain.counts.uncommitted).toBe(1);
    expect(plain.uncommittedFiles).toEqual(["tests/FooTest.php"]);
    expect(plain.warnings).toEqual([
      "1 tracked files have uncommitted changes not covered by this comparison; commit them, or use --staged / --worktree (tests/FooTest.php)",
    ]);

    const summary = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--summary",
    ]);
    expect(summary.code).toBe(0);
    const lines = summary.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      /^warning: 1 tracked files have uncommitted changes .*tests\/FooTest\.php/,
    );
    expect(lines[0]).toContain("--staged / --worktree");
    expect(lines[lines.length - 1]).toContain("warnings=1 uncommitted=1");

    const worktree = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--worktree",
      "--summary",
    ]);
    expect(worktree.code).toBe(1);
    expect(worktree.stdout).toContain(
      "test_cases_dropped | tests/FooTest.php | test-case markers fell from 2 to 1",
    );
    expect(worktree.stdout).toContain("warnings=0 uncommitted=0");
  });

  it("puts the envelope fields in place: uncommitted_files, head label and null head_sha", async () => {
    const { repo, base } = phpRepo();
    write(repo, "tests/FooTest.php", PHP_ONE_METHOD);
    const plain = JSON.parse(
      (await spawnCli(["-C", repo, "hygiene", "--base", base])).stdout,
    ) as {
      head: string;
      head_sha: string | null;
      uncommitted_files: string[];
      counts: { uncommitted: number };
    };
    expect(plain.uncommitted_files).toEqual(["tests/FooTest.php"]);
    expect(plain.counts.uncommitted).toBe(1);
    expect(plain.head).toBe("HEAD");
    expect(plain.head_sha).toMatch(/^[0-9a-f]{40}$/);
    const wt = JSON.parse(
      (await spawnCli(["-C", repo, "hygiene", "--base", base, "--worktree"]))
        .stdout,
    ) as typeof plain;
    expect(wt.head).toBe("(worktree)");
    expect(wt.head_sha).toBeNull();
    expect(wt.uncommitted_files).toEqual([]);
    const printed = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      base,
      "--print",
      "uncommitted_files",
    ]);
    expect(JSON.parse(printed.stdout)).toMatchObject({
      uncommitted_files: ["tests/FooTest.php"],
    });
  });

  it("a staged-only change: plain mode warns, --staged finds the drop and warns about nothing", () => {
    const { repo, base } = phpRepo();
    write(repo, "tests/FooTest.php", PHP_ONE_METHOD);
    git(repo, ["add", "tests/FooTest.php"]);

    const plain = hygiene({ cwd: repo, base });
    expect(plain.status).toBe("ok");
    expect(plain.counts.uncommitted).toBe(1);
    expect(uncommittedWarnings(plain.warnings)).toHaveLength(1);

    const staged = hygiene({ cwd: repo, base, staged: true });
    expect(staged.status).toBe("fail");
    expect(staged.findings).toEqual([
      expect.objectContaining({
        kind: "test_cases_dropped",
        path: "tests/FooTest.php",
        baseCases: 2,
        headCases: 1,
      }),
    ]);
    expect(staged.warnings).toEqual([]);
    expect(staged.counts.uncommitted).toBe(0);
    expect(staged.uncommittedFiles).toEqual([]);
  });

  it("a change staged and then modified further: --staged warns about the unstaged part", () => {
    const { repo, base } = phpRepo();
    write(repo, "tests/FooTest.php", PHP_ONE_METHOD);
    git(repo, ["add", "tests/FooTest.php"]);
    write(repo, "tests/FooTest.php", PHP_ONE_METHOD + "// later edit\n");
    const staged = hygiene({ cwd: repo, base, staged: true });
    expect(staged.status).toBe("fail");
    expect(staged.counts.uncommitted).toBe(1);
    expect(staged.uncommittedFiles).toEqual(["tests/FooTest.php"]);
    expect(staged.warnings).toEqual([
      "1 tracked files have uncommitted changes not covered by this comparison; stage and commit them, or use --worktree (tests/FooTest.php)",
    ]);
  });

  it("--staged ignores an unstaged-only change of another file only through the warning", () => {
    const { repo, base } = phpRepo();
    write(repo, "src/a.ts", "export const a = 2;\n");
    const staged = hygiene({ cwd: repo, base, staged: true });
    expect(staged.status).toBe("ok");
    expect(staged.counts.uncommitted).toBe(1);
    expect(staged.uncommittedFiles).toEqual(["src/a.ts"]);
  });

  it("a clean tree has no warning and uncommitted=0, and the other envelope fields are as before", async () => {
    const { repo, base } = phpRepo();
    write(repo, "src/b.ts", "export const b = 1;\n");
    write(repo, "docs/x.md.bak", "x\n");
    commitAll(repo, "change");
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    const r = hygiene({ cwd: repo, base });
    expect(r.warnings).toEqual([]);
    expect(r.counts.uncommitted).toBe(0);
    expect(r.uncommittedFiles).toEqual([]);
    const { uncommittedFiles: _files, ...rest } = r;
    const { uncommitted: _count, ...otherCounts } = r.counts;
    expect({ ...rest, counts: otherCounts }).toEqual({
      status: "fail",
      base,
      head: "HEAD",
      baseSha: base,
      headSha: head,
      mergeBase: base,
      maxDeletePercent: 20,
      extendOnly: [],
      intendedDeclarations: [],
      intendedDeletions: [],
      findings: [
        expect.objectContaining({ kind: "backup_file", path: "docs/x.md.bak" }),
      ],
      counts: {
        files: 2,
        backupFiles: 1,
        extendOnlyRewrites: 0,
        testCaseDrops: 0,
        intendedDeletions: 0,
      },
      warnings: [],
    });
    for (const extra of [[], ["--staged"], ["--worktree"]]) {
      const run = await spawnCli([
        "-C",
        repo,
        "hygiene",
        "--base",
        base,
        ...extra,
        "--summary",
      ]);
      const lines = run.stdout.trimEnd().split("\n");
      expect(lines.some((l) => l.startsWith("warning:"))).toBe(false);
      expect(lines[lines.length - 1]).toMatch(/ warnings=0 uncommitted=0 /);
    }
  });

  it("never counts an untracked file as uncommitted in plain or --staged mode", () => {
    const { repo, base } = phpRepo();
    write(repo, "tests/NewTest.php", PHP_TWO_METHODS);
    write(repo, "notes.md.bak", "x\n");
    for (const staged of [false, true]) {
      const r = hygiene({ cwd: repo, base, staged });
      expect(r.status).toBe("ok");
      expect(r.counts.uncommitted).toBe(0);
      expect(r.uncommittedFiles).toEqual([]);
      expect(r.warnings).toEqual([]);
    }
  });

  it("counts a rename once and keeps a path with spaces whole", () => {
    const { repo, base } = phpRepo();
    git(repo, ["mv", "src/a.ts", "src/a b.ts"]);
    const plain = hygiene({ cwd: repo, base });
    expect(plain.counts.uncommitted).toBe(1);
    expect(plain.uncommittedFiles).toEqual(["src/a b.ts"]);
    // Fully staged rename: nothing unstaged for --staged to warn about.
    const staged = hygiene({ cwd: repo, base, staged: true });
    expect(staged.counts.uncommitted).toBe(0);
    write(repo, "src/a b.ts", "export const a = 3;\n");
    const staged2 = hygiene({ cwd: repo, base, staged: true });
    expect(staged2.uncommittedFiles).toEqual(["src/a b.ts"]);
  });

  it("does not read the source path of a rename as an entry of its own", () => {
    // A source path whose third character is a space looks like a status
    // line ("ab cd.ts" reads as XY "ab", path "cd.ts") if it is not skipped.
    const repo = initRepo();
    write(repo, "ab cd.ts", "export const x = 1;\n");
    commitAll(repo, "spaced name");
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["mv", "ab cd.ts", "renamed.ts"]);
    const r = hygiene({ cwd: repo, base });
    expect(r.counts.uncommitted).toBe(1);
    expect(r.uncommittedFiles).toEqual(["renamed.ts"]);
  });

  it("lists at most the cap, with the exact count, and names five paths in the warning", () => {
    const { repo, base } = phpRepo();
    const total = UNCOMMITTED_FILES_CAP + 5;
    for (let i = 0; i < total; i++)
      write(repo, `bulk/f${String(i)}.txt`, "a\n");
    commitAll(repo, "bulk");
    const base2 = git(repo, ["rev-parse", "HEAD"]).trim();
    for (let i = 0; i < total; i++)
      write(repo, `bulk/f${String(i)}.txt`, "b\n");
    const r = hygiene({ cwd: repo, base: base2 });
    expect(base).not.toBe(base2);
    expect(r.counts.uncommitted).toBe(total);
    expect(r.uncommittedFiles).toHaveLength(UNCOMMITTED_FILES_CAP);
    expect(r.warnings).toEqual([
      expect.stringContaining(
        `${String(total)} tracked files have uncommitted changes`,
      ),
    ]);
    expect(r.warnings[0]).toContain(`and ${String(total - 5)} more)`);
  });

  it("a failing git status becomes a warning and leaves the result and status unchanged", () => {
    const { repo, base } = phpRepo();
    write(repo, "docs/x.md-E", "x\n");
    commitAll(repo, "backup");
    const expected = hygiene({ cwd: repo, base });
    const r = withFailingGit("status", () => hygiene({ cwd: repo, base }));
    expect(r.status).toBe("fail");
    expect(r.findings).toEqual(expected.findings);
    expect(r.counts.uncommitted).toBe(0);
    expect(r.uncommittedFiles).toEqual([]);
    expect(r.warnings).toEqual([
      expect.stringContaining("could not list uncommitted changes"),
    ]);
    expect(r.warnings[0]).toContain("simulated status failure");
    const wt = withFailingGit("status", () =>
      hygiene({ cwd: repo, base, worktree: true }),
    );
    expect(wt.status).toBe("fail");
    expect(wt.findings).toEqual(expected.findings);
    expect(wt.warnings).toEqual([
      expect.stringContaining("could not list uncommitted changes"),
    ]);
  });

  it("a failing git ls-files in --worktree mode is a warning and leaves the result unchanged", async () => {
    const { repo, base } = phpRepo();
    write(repo, "tests/FooTest.php", PHP_ONE_METHOD);
    write(repo, "tests/NewTest.php", PHP_TWO_METHODS);
    const expected = hygiene({ cwd: repo, base, worktree: true });
    expect(expected.status).toBe("fail");
    const r = withFailingGit("ls-files", () =>
      hygiene({ cwd: repo, base, worktree: true }),
    );
    expect(r.status).toBe("fail");
    expect(r.findings).toEqual(expected.findings);
    expect(r.warnings).toEqual([
      expect.stringContaining("could not list untracked files"),
    ]);
    expect(r.warnings[0]).toContain("simulated ls-files failure");
    expect(expected.warnings).toEqual([
      expect.stringContaining("1 untracked files match a test or backup"),
    ]);
  });

  it("leaves .git/index byte-identical in every mode, also on a stat-dirty tree", () => {
    const { repo, base } = phpRepo();
    write(repo, "src/a.ts", "export const a = 1;\n");
    write(repo, "tests/FooTest.php", PHP_ONE_METHOD);
    git(repo, ["add", "tests/FooTest.php"]);
    // Stat data that no longer matches the index entry, content unchanged:
    // `git status` and `git diff` would refresh the index and write it.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(repo, "src/a.ts"), future, future);
    fs.utimesSync(path.join(repo, "docs/log.md"), future, future);
    const indexFile = path.join(repo, ".git", "index");
    const md5 = (): string =>
      createHash("md5").update(fs.readFileSync(indexFile)).digest("hex");
    const before = md5();
    for (const options of [{}, { staged: true }, { worktree: true }]) {
      hygiene({ cwd: repo, base, ...options });
      expect(md5()).toBe(before);
    }
    // The refresh is real: the porcelain commands do write this index.
    git(repo, ["status", "--porcelain"]);
    expect(md5()).not.toBe(before);
  });

  it("pins the path-list cap at 50", () => {
    expect(UNCOMMITTED_FILES_CAP).toBe(50);
    const { repo, base } = phpRepo();
    for (let i = 0; i < 55; i++) write(repo, `bulk/f${String(i)}.txt`, "a\n");
    commitAll(repo, "bulk");
    const base2 = git(repo, ["rev-parse", "HEAD"]).trim();
    for (let i = 0; i < 55; i++) write(repo, `bulk/f${String(i)}.txt`, "b\n");
    const r = hygiene({ cwd: repo, base: base2 });
    expect(base).not.toBe(base2);
    expect(r.uncommittedFiles).toHaveLength(50);
    expect(r.counts.uncommitted).toBe(55);
  });
});

describe("hygiene --worktree", () => {
  it("compares the merge-base with the working tree, staged and unstaged changes alike", () => {
    const { repo, base } = phpRepo();
    write(repo, "test/a.test.ts", 'it("one", () => {});\n');
    write(repo, "tests/FooTest.php", PHP_ONE_METHOD);
    git(repo, ["add", "tests/FooTest.php"]);
    const r = hygiene({ cwd: repo, base, worktree: true });
    expect(r.status).toBe("fail");
    expect(r.head).toBe("(worktree)");
    expect(r.headSha).toBeNull();
    expect(r.mergeBase).toBe(base);
    expect(r.findings.map((f) => f.path).sort()).toEqual([
      "test/a.test.ts",
      "tests/FooTest.php",
    ]);
    expect(r.counts.uncommitted).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it("warns when the index holds a version that differs from both HEAD and the working tree", () => {
    const { repo, base } = phpRepo();
    write(repo, "tests/FooTest.php", PHP_ONE_METHOD);
    git(repo, ["add", "tests/FooTest.php"]);
    git(repo, ["restore", "--source=HEAD", "--worktree", "tests/FooTest.php"]);
    expect(git(repo, ["status", "--porcelain"]).slice(0, 2)).toBe("MM");
    const wt = hygiene({ cwd: repo, base, worktree: true });
    expect(wt.status).toBe("ok");
    expect(wt.counts.uncommitted).toBe(1);
    expect(wt.uncommittedFiles).toEqual(["tests/FooTest.php"]);
    expect(wt.warnings).toEqual([
      "1 tracked files have a staged version that differs from both HEAD and the working tree; stage the working tree (git add) or check with --staged (tests/FooTest.php)",
    ]);
    const staged = hygiene({ cwd: repo, base, staged: true });
    expect(staged.status).toBe("fail");
    // A staged-only change is the comparison itself in --worktree mode.
    git(repo, ["add", "tests/FooTest.php"]);
    const settled = hygiene({ cwd: repo, base, worktree: true });
    expect(settled.counts.uncommitted).toBe(0);
    expect(settled.warnings).toEqual([]);
  });

  it("reports a test file deleted in the working tree", () => {
    const { repo, base } = phpRepo();
    fs.rmSync(path.join(repo, "tests/FooTest.php"));
    const r = hygiene({ cwd: repo, base, worktree: true });
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: "test_cases_dropped",
        path: "tests/FooTest.php",
        baseCases: 2,
        headCases: 0,
        detail: expect.stringContaining("(file deleted)"),
      }),
    ]);
  });

  it("uses the merge-base of base and HEAD when the base moved", () => {
    const repo = initRepo();
    const main = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    const forkSha = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["checkout", "-q", "-b", "feat"]);
    git(repo, ["checkout", "-q", main]);
    write(
      repo,
      "test/a.test.ts",
      'it("one", () => {});\nit("two", () => {});\ntest("three", () => {});\nit("four", () => {});\n',
    );
    commitAll(repo, "main adds a case");
    git(repo, ["checkout", "-q", "feat"]);
    write(repo, "test/a.test.ts", 'it("one", () => {});\n');
    const r = hygiene({ cwd: repo, base: main, worktree: true });
    expect(r.mergeBase).toBe(forkSha);
    expect(r.findings).toEqual([
      expect.objectContaining({ baseCases: 3, headCases: 1 }),
    ]);
  });

  it("measures an extend-only rewrite made in the working tree", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "docs/log.md", "entry new\n");
    const r = hygiene({
      cwd: repo,
      base,
      worktree: true,
      extendOnly: ["docs/log.md"],
    });
    expect(r.findings).toEqual([
      expect.objectContaining({ kind: "extend_only_rewrite" }),
    ]);
  });

  it("names untracked test and backup files in a separate warning, ignores other untracked files", () => {
    const { repo, base } = phpRepo();
    write(repo, "tests/NewTest.php", PHP_TWO_METHODS);
    write(repo, "notes.md.bak", "x\n");
    write(repo, "src/untracked.ts", "export const u = 1;\n");
    const r = hygiene({ cwd: repo, base, worktree: true });
    expect(r.status).toBe("ok");
    expect(r.counts.uncommitted).toBe(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("2 untracked files match a test or backup");
    expect(r.warnings[0]).toContain("tests/NewTest.php");
    expect(r.warnings[0]).toContain("notes.md.bak");
    expect(r.warnings[0]).not.toContain("src/untracked.ts");
    const clean = initRepo();
    write(clean, "src/untracked.ts", "export const u = 1;\n");
    const base2 = git(clean, ["rev-parse", "HEAD"]).trim();
    expect(
      hygiene({ cwd: clean, base: base2, worktree: true }).warnings,
    ).toEqual([]);
  });

  it("treats a symlink as --staged does: the link target text, not the file behind it", () => {
    const repo = initRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    write(
      repo,
      "elsewhere/five.test.ts",
      Array.from({ length: 5 }, () => 'it("x", () => {});\n').join(""),
    );
    fs.rmSync(path.join(repo, "test/a.test.ts"));
    fs.symlinkSync(
      "../elsewhere/five.test.ts",
      path.join(repo, "test/a.test.ts"),
    );
    git(repo, ["add", "-A"]);
    const staged = hygiene({ cwd: repo, base, staged: true });
    const wt = hygiene({ cwd: repo, base, worktree: true });
    expect(wt.findings).toEqual(staged.findings);
    expect(wt.findings).toEqual([
      expect.objectContaining({
        kind: "test_cases_dropped",
        path: "test/a.test.ts",
        baseCases: 3,
        headCases: 0,
      }),
    ]);
  });
});

describe("readWorktreeFile", () => {
  it("reads a regular file and a symlink's target text, and refuses escapes", () => {
    const repo = initRepo();
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-primitives-outside-"),
    );
    tmpDirs.push(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    fs.symlinkSync(outside, path.join(repo, "linked-dir"));
    fs.symlinkSync("src/a.ts", path.join(repo, "link.ts"));
    expect(readWorktreeFile(repo, "src/a.ts")).toBe("export const a = 1;\n");
    expect(readWorktreeFile(repo, "link.ts")).toBe("src/a.ts");
    expect(readWorktreeFile(repo, "linked-dir/secret.txt")).toBeUndefined();
    expect(
      readWorktreeFile(
        repo,
        path.join("..", path.basename(outside), "secret.txt"),
      ),
    ).toBeUndefined();
    expect(readWorktreeFile(repo, "src")).toBeUndefined();
    expect(readWorktreeFile(repo, "src/missing.ts")).toBeUndefined();
  });
});

describe("hygiene mode combinations", () => {
  it("--worktree alone is a worktree comparison", () => {
    const { repo, base } = phpRepo();
    const r = hygiene({ cwd: repo, base, worktree: true });
    expect(r.head).toBe("(worktree)");
    expect(r.status).toBe("ok");
  });

  it("--worktree with --staged is a usage error naming both flags", () => {
    const { repo, base } = phpRepo();
    expect(() =>
      hygiene({ cwd: repo, base, worktree: true, staged: true }),
    ).toThrow(/--worktree and --staged are mutually exclusive/);
  });

  it("--worktree with --head is a usage error naming both flags, even for HEAD", () => {
    const { repo, base } = phpRepo();
    for (const head of ["HEAD", base]) {
      expect(() => hygiene({ cwd: repo, base, worktree: true, head })).toThrow(
        /--worktree and --head are mutually exclusive/,
      );
    }
    expect(() =>
      hygiene({ cwd: repo, base, worktree: true, head: "HEAD" }),
    ).toThrow(UsageError);
  });

  it("--staged wins over --head: the head is ignored, even an unresolvable one", () => {
    const { repo, base } = phpRepo();
    write(repo, "tests/FooTest.php", PHP_ONE_METHOD);
    git(repo, ["add", "tests/FooTest.php"]);
    const r = hygiene({ cwd: repo, base, staged: true, head: "no-such-rev" });
    expect(r.head).toBe("(index)");
    expect(r.headSha).toBeNull();
    expect(r.status).toBe("fail");
  });

  it("neither flag keeps the commit comparison against --head", () => {
    const { repo, base } = phpRepo();
    write(repo, "tests/FooTest.php", PHP_ONE_METHOD);
    commitAll(repo, "drop");
    const r = hygiene({ cwd: repo, base, head: "HEAD~1" });
    expect(r.status).toBe("ok");
    expect(r.head).toBe("HEAD~1");
  });
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
    for (const p of ["a.md-E", "x/y.bak", "z.orig", "doc.md~", "file-E"]) {
      expect(isBackupPath(p)).toBe(true);
    }
    for (const p of ["a.md", "x/backup.ts", "ORIGIN", "E", "dir-E/file.md"]) {
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
});

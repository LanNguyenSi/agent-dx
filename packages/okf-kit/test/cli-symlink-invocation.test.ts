// Regression: the CLI must actually run when invoked through a symlink.
//
// Every real install path routes through one: `npx okf-kit` and `npm i -g
// okf-kit` both create `node_modules/.bin/okf-kit -> ../okf-kit/dist/cli.js`
// and exec the symlink. The main-module guard used to compare argv[1]
// verbatim against `import.meta.url`, which is the resolved realpath, so the
// comparison never matched: the published 0.3.0 CLI silently did nothing and
// exited 0 on every standard invocation. Exit 0 with no output is exactly the
// shape that fools a smoke test, so these tests assert on stdout and on
// filesystem effects, never on the exit code alone.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(here, "..", "dist", "cli.js");

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-symlink-"));
  tmpDirs.push(d);
  return d;
}

describe("CLI invoked through a symlink (the npx / npm -g shape)", () => {
  it("prints its version, rather than no-opping with exit 0", () => {
    const dir = tmpDir();
    const link = path.join(dir, "okf-kit");
    fs.symlinkSync(cliPath, link);

    const stdout = execFileSync(process.execPath, [link, "--version"], {
      encoding: "utf8",
    });

    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("scaffolds a bundle, rather than no-opping with exit 0", () => {
    const dir = tmpDir();
    const link = path.join(dir, "okf-kit");
    fs.symlinkSync(cliPath, link);
    const target = path.join(dir, "bundle");

    execFileSync(process.execPath, [link, "init", target], { encoding: "utf8" });

    expect(fs.existsSync(path.join(target, "index.md"))).toBe(true);
  });

  it("still runs when invoked by its real path", () => {
    const stdout = execFileSync(process.execPath, [cliPath, "--version"], {
      encoding: "utf8",
    });

    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

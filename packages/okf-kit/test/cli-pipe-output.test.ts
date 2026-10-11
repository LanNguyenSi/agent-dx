// Regression: `check --json` must deliver its whole report when stdout is a
// pipe. The CLI used to call process.exit() right after process.stdout.write();
// for a pipe the write is asynchronous, so a report larger than the pipe
// buffer (platform dependent) was cut off at the buffer size.
// A file redirect hides the bug (file writes are synchronous), so these tests
// spawn the built CLI with a real pipe and a real pipe reader.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_PATH, FIXTURES_DIR } from "./helpers.js";

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

// A bundle whose JSON report is well over 64 KiB: every doc carries a broken
// link, so each one adds an error finding.
function largeBundle(docs: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-pipe-"));
  tmpDirs.push(dir);
  for (let i = 0; i < docs; i++) {
    fs.writeFileSync(
      path.join(dir, `doc-${i}.md`),
      `---\ntype: concept\n---\n\n[Broken](missing-target-${i}.md)\n`,
    );
  }
  return dir;
}

// Same shape as largeBundle, but every finding is a warning (absolute link),
// so the verdict is exit 0 without --strict.
function largeWarningBundle(docs: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-pipe-"));
  tmpDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "other.md"),
    "---\ntype: concept\n---\n\n# Other\n",
  );
  for (let i = 0; i < docs; i++) {
    fs.writeFileSync(
      path.join(dir, `doc-${i}.md`),
      `---\ntype: concept\n---\n\n[Other](/other.md)\n`,
    );
  }
  return dir;
}

interface PipedRun {
  code: number | null;
  stdout: Buffer;
}

// Reads the child's stdout through a real pipe, the way `| jq` would.
function runPiped(args: string[]): Promise<PipedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(chunks) }),
    );
  });
}

// Reads one chunk, then closes the read end like `| head -1` would.
function runEarlyClose(
  args: string[],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.stdout.once("data", () => child.stdout.destroy());
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

describe("check output through a pipe", () => {
  it("delivers the complete JSON report when it exceeds the pipe buffer", async () => {
    const bundle = largeBundle(600);
    const piped = await runPiped([
      "check",
      "--json",
      "--repo-root",
      bundle,
      bundle,
    ]);

    expect(piped.stdout.length).toBeGreaterThan(65536);
    const report = JSON.parse(piped.stdout.toString("utf8"));
    expect(report.summary.errors).toBeGreaterThanOrEqual(600);
    expect(piped.code).toBe(1);

    // Same bytes as a redirect to a file would carry.
    const outFile = path.join(bundle, "..", `${path.basename(bundle)}.json`);
    tmpDirs.push(outFile);
    const fd = fs.openSync(outFile, "w");
    const filed = spawnSync(
      process.execPath,
      [CLI_PATH, "check", "--json", "--repo-root", bundle, bundle],
      { stdio: ["ignore", fd, "ignore"] },
    );
    fs.closeSync(fd);
    expect(filed.status).toBe(1);
    expect(piped.stdout.equals(fs.readFileSync(outFile))).toBe(true);
  });

  it("delivers the complete text report when it exceeds the pipe buffer", async () => {
    const bundle = largeBundle(1500);
    const piped = await runPiped(["check", "--repo-root", bundle, bundle]);
    expect(piped.stdout.length).toBeGreaterThan(65536);
    expect(piped.stdout.toString("utf8")).toContain("missing-target-1499.md");
    expect(piped.code).toBe(1);
  });

  it("keeps exit 0 for a clean bundle and exit 1 for errors when piped", async () => {
    const clean = path.join(FIXTURES_DIR, "valid-bundle");
    const ok = await runPiped(["check", "--json", "--repo-root", clean, clean]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout.toString("utf8")).summary.errors).toBe(0);

    const broken = path.join(FIXTURES_DIR, "broken-link");
    const bad = await runPiped(["check", "--json", broken]);
    expect(bad.code).toBe(1);
  });

  it("keeps the --strict warning exit (1) and the non-strict warning exit (0) when piped", async () => {
    const dir = path.join(FIXTURES_DIR, "absolute-link");
    const lax = await runPiped(["check", "--json", dir]);
    expect(lax.code).toBe(0);
    const strict = await runPiped(["check", "--json", "--strict", dir]);
    expect(strict.code).toBe(1);
  });

  it("ends silently with the verdict code when the reader closes early (warnings only)", async () => {
    const bundle = largeWarningBundle(3000);
    const run = await runEarlyClose(["check", "--repo-root", bundle, bundle]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
  });

  it("keeps exit 1 and an empty stderr when the reader closes early on an error bundle", async () => {
    const bundle = largeBundle(1500);
    const run = await runEarlyClose(["check", "--repo-root", bundle, bundle]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(1);
  });
});

describe("docs-for output through a pipe", () => {
  it("delivers the complete JSON when it exceeds the pipe buffer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-pipe-"));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "foo.ts"), "export {};\n");
    const bundle = path.join(root, "docs");
    fs.mkdirSync(bundle);
    for (let i = 0; i < 1500; i++) {
      fs.writeFileSync(
        path.join(bundle, `doc-${i}.md`),
        `---\ntype: concept\nsources:\n  - src/foo.ts\n---\n\n# Doc ${i}\n`,
      );
    }
    const args = [
      "docs-for",
      "--json",
      "--repo-root",
      root,
      bundle,
      "src/foo.ts",
    ];
    const piped = await runPiped(args);
    expect(piped.stdout.length).toBeGreaterThan(65536);
    expect(piped.code).toBe(0);

    const outFile = path.join(root, "out.json");
    const fd = fs.openSync(outFile, "w");
    const filed = spawnSync(process.execPath, [CLI_PATH, ...args], {
      stdio: ["ignore", fd, "ignore"],
    });
    fs.closeSync(fd);
    expect(filed.status).toBe(0);
    expect(piped.stdout.equals(fs.readFileSync(outFile))).toBe(true);
    expect(JSON.parse(piped.stdout.toString("utf8"))).toBeTruthy();
  });
});

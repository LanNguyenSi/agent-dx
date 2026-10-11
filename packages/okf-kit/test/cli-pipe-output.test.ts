// Regression: `check --json` must deliver its whole report when stdout is a
// pipe. The CLI used to call process.exit() right after process.stdout.write();
// for a pipe the write is asynchronous, so a report larger than the 64 KiB pipe
// buffer was cut off at the buffer size .
// A file redirect hides the bug (file writes are synchronous), so these tests
// spawn the built CLI with a real pipe and a real pipe reader.

import { spawn } from "node:child_process";
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
    const { spawnSync } = await import("node:child_process");
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
});

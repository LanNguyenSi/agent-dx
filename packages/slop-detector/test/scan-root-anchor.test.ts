import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckSummary } from "../src/types.js";

// Regression coverage for: `check <file> [<file>...] --config
// slop.config.yml` must judge a file exactly as `check . --config
// slop.config.yml` judges it. Every fixture below anchors its config's
// path patterns to the fixture root (mirroring a real repo-root
// slop.config.yml) and puts the checked file inside a NESTED directory
// that also carries its own package.json: a plausible wrong fix would
// anchor to the nearest package.json to the scanned file instead of to
// the config file's directory, and the nested package.json is what makes
// that wrong choice still fail this fixture (it would resolve to the
// nested directory, not the fixture root, so the pattern still wouldn't
// match).
//
// Exercised through the real CLI (`node --import tsx src/cli.ts`), not
// the engine API directly: the bug lived entirely in `cli.ts` not passing
// a scan-root anchor into `checkPath`, so a test that only calls
// `checkPath`/`checkFiles` directly would never have caught it.
//
// The child process's own cwd stays `packageRoot` (same as `cli.test.ts`):
// `--import tsx` resolves the `tsx` loader relative to the *process*
// cwd, so pointing cwd at the fixture directory (which has no
// `node_modules`) breaks module resolution before the CLI even runs. The
// directory-scan target is therefore the fixture root's own absolute
// path rather than a literal ".", and `--config` is always an absolute
// path too: `resolveScanRoot` treats a directory target identically
// regardless of whether it is spelled ".", "./", or given as an absolute
// path (see engine.ts), so this still exercises the same anchor logic
// `check .` from the fixture root would.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliEntry = path.join(packageRoot, "src", "cli.ts");

function runCli(
  args: string[],
  input = "",
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliEntry, ...args],
    { cwd: packageRoot, encoding: "utf8", input },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

function runCliJson(args: string[], input = ""): CheckSummary {
  const { stdout, stderr, status } = runCli(
    [...args, "--format", "json"],
    input,
  );
  if (status !== 0 && status !== 1) {
    throw new Error(`CLI exited ${status} unexpectedly: ${stderr}`);
  }
  return JSON.parse(stdout) as CheckSummary;
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-scanroot-anchor-"));
  // Nested package: its own package.json one level below the fixture
  // root, so a scanned file's "nearest package.json" is this one, NOT
  // the fixture root (see file header for why that matters).
  fs.mkdirSync(path.join(tmp, "packages", "sub", "src"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(tmp, "packages", "sub", "package.json"),
    JSON.stringify({ name: "sub", version: "1.0.0" }, null, 2) + "\n",
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("config path patterns anchor to the --config file's directory", () => {
  it("review.allowPaths: a root-anchored entry excuses a nested file scanned as an explicit CLI argument, same as a full-directory scan from the fixture root", () => {
    const configPath = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      configPath,
      [
        "packs:",
        "  review-slop: true",
        "review:",
        "  allowPaths:",
        "    - packages/sub/README.md",
      ].join("\n") + "\n",
    );
    const target = path.join(tmp, "packages", "sub", "README.md");
    fs.writeFileSync(target, "F1 landed in review round 2.\n");

    const viaFile = runCliJson([
      "check",
      target,
      "--pack",
      "review-slop",
      "--config",
      configPath,
    ]);
    const viaDir = runCliJson([
      "check",
      tmp,
      "--pack",
      "review-slop",
      "--config",
      configPath,
    ]);

    // Allowlisted by `review.allowPaths` -- zero block findings either way.
    expect(viaDir.blockCount).toBe(0);
    expect(viaFile.blockCount).toBe(0);
    expect(viaFile.violations).toEqual(viaDir.violations);
  });

  it("placement.instructionGlobs: a root-anchored pattern matches a nested file scanned as an explicit CLI argument, same as a full-directory scan (no zero-match warning)", () => {
    const configPath = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      configPath,
      [
        "packs:",
        "  placement-slop: true",
        "placement:",
        "  instructionGlobs:",
        "    - packages/sub/PLAYBOOK.md",
      ].join("\n") + "\n",
    );
    const target = path.join(tmp, "packages", "sub", "PLAYBOOK.md");
    fs.writeFileSync(target, "# Playbook\n\nNo markers here.\n");

    const viaFile = runCliJson([
      "check",
      target,
      "--pack",
      "placement-slop",
      "--config",
      configPath,
    ]);
    const viaDir = runCliJson([
      "check",
      tmp,
      "--pack",
      "placement-slop",
      "--config",
      configPath,
    ]);

    const unmatchedWarning =
      /instructionGlobs pattern "packages\/sub\/PLAYBOOK\.md" matched no scanned files/;
    expect(viaDir.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(unmatchedWarning)]),
    );
    expect(viaFile.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(unmatchedWarning)]),
    );
  });

  it("entrypointGlobs: a root-anchored pattern matches a nested file scanned as an explicit CLI argument, same as a full-directory scan (no zero-match warning)", () => {
    const configPath = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      configPath,
      [
        "packs:",
        "  code-slop: true",
        "corpus: true",
        "entrypointGlobs:",
        "  - packages/sub/src/index.ts",
      ].join("\n") + "\n",
    );
    const target = path.join(tmp, "packages", "sub", "src", "index.ts");
    fs.writeFileSync(target, "export function helperA() { return 1; }\n");

    const viaFile = runCliJson([
      "check",
      target,
      "--pack",
      "code-slop",
      "--config",
      configPath,
    ]);
    const viaDir = runCliJson([
      "check",
      tmp,
      "--pack",
      "code-slop",
      "--config",
      configPath,
    ]);

    const unmatchedWarning =
      /entrypointGlobs pattern "packages\/sub\/src\/index\.ts" matched no scanned files/;
    expect(viaDir.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(unmatchedWarning)]),
    );
    expect(viaFile.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(unmatchedWarning)]),
    );
  });

  it("--stdin-path keeps scanning a commit message and a relative filename after the anchor change", () => {
    const configPath = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      configPath,
      ["packs:", "  review-slop: true"].join("\n") + "\n",
    );

    const commitMsg = runCliJson(
      [
        "check",
        "--stdin-path",
        "COMMIT_MSG",
        "--pack",
        "review-slop",
        "--config",
        configPath,
      ],
      "Fixes F1 and F2a from review round 2.\n",
    );
    expect(commitMsg.filesScanned).toBe(1);

    const relSummary = runCliJson(
      [
        "check",
        "--stdin-path",
        "notes/relative.md",
        "--pack",
        "review-slop",
        "--config",
        configPath,
      ],
      "Fixes F1 and F2a from review round 2.\n",
    );
    expect(relSummary.filesScanned).toBe(1);
  });
});

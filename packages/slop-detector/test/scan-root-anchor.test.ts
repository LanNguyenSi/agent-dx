import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckSummary } from "../src/types.js";
import { runSlopCheck } from "../src/mcp-check.js";

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

// The everyday-shape tests further down spawn the BUILT CLI instead, and
// point the child process's cwd AT the fixture root, because that is the
// only way to run the invocation people actually type: every path
// (`--config slop.config.yml`, the target, a `--stdin-path` value) spelled
// relative to the config file's own directory. `--import tsx` can't be
// used there, since it resolves the loader against the process cwd and a
// fixture directory has no `node_modules` (see the file header).
const distCli = path.join(packageRoot, "dist", "cli.js");

// Reading built output means the build has to be at least as new as the
// source: CI's package job builds before it tests, and a mutation probe
// passes `--pre 'npm run build'` so the mutant reaches `dist/`. For every
// other way of running the suite, a missing OR stale `dist/cli.js` (older
// than the newest file under `src/`) is rebuilt here, so these tests can
// neither go inert nor pass against previously built code.
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const mtime = entry.isDirectory()
      ? newestMtimeMs(full)
      : fs.statSync(full).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function distIsCurrent(): boolean {
  if (!fs.existsSync(distCli)) return false;
  return (
    newestMtimeMs(path.join(packageRoot, "dist")) >=
    newestMtimeMs(path.join(packageRoot, "src"))
  );
}

function ensureBuilt(): void {
  if (distIsCurrent()) return;
  const built = spawnSync("npm", ["run", "build"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (built.status !== 0) {
    throw new Error(
      `npm run build failed (${built.status}): ${built.stderr ?? ""}`,
    );
  }
}

function runBuiltCliJson(
  args: string[],
  cwd: string,
  input = "",
): CheckSummary {
  try {
    const stdout = execFileSync(
      process.execPath,
      [distCli, ...args, "--format", "json"],
      { cwd, encoding: "utf8", input },
    );
    return JSON.parse(stdout) as CheckSummary;
  } catch (err) {
    // Exit 1 just means "block findings present"; the JSON summary is
    // still on stdout and is exactly what these tests assert on.
    const e = err as { status?: number; stdout?: string; stderr?: string };
    if (e.status === 1 && e.stdout) {
      return JSON.parse(e.stdout) as CheckSummary;
    }
    throw new Error(`built CLI exited ${e.status}: ${e.stderr ?? ""}`);
  }
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
    // Scope: this only guards that stdin is still READ and scanned at all
    // (the criterion's "--stdin-path keeps working" clause). Both
    // assertions below are `filesScanned === 1`, which does not
    // discriminate the anchor: they hold with the anchor, without it, and
    // with any wrong anchor, since a stdin scan always reports exactly one
    // file. The anchor's effect on the stdin branch is covered by
    // "--stdin-path agrees with the equivalent file argument" and
    // "treatAsProse ... --stdin-path" below, and its everyday
    // repo-relative shape by the built-CLI test at the end of this file.
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

// Round 2: the anchor from round 1 above was applied unconditionally,
// which broke `check .`'s own verdict once `--config` pointed OUTSIDE the
// scanned directory (a central/shared config). The fix is a containment
// condition (see src/util/pattern-anchor.ts:resolvePatternAnchor): the
// anchor only applies when the checked target actually lies inside the
// config file's own directory; otherwise the pre-round-1 per-target
// resolution applies, unchanged.
describe("the anchor only applies when the target lies inside the --config file's directory", () => {
  it("an out-of-tree --config leaves check .'s own verdict unaffected (round-1 regression)", () => {
    // `scanned/` is the target; `shared/slop.config.yml` lives OUTSIDE it.
    // `review.allowPaths` is written relative to the SCANNED directory
    // (the pre-round-1, and still-correct-for-this-case, resolution), so
    // an unconditional anchor to `shared/` (round 1's bug) breaks the
    // match and turns a clean scan into two block findings.
    fs.mkdirSync(path.join(tmp, "shared"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "scanned", "sub"), { recursive: true });
    const configPath = path.join(tmp, "shared", "slop.config.yml");
    fs.writeFileSync(
      configPath,
      [
        "packs:",
        "  review-slop: true",
        "review:",
        "  allowPaths:",
        "    - sub/allowed.md",
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(tmp, "scanned", "sub", "allowed.md"),
      "F1 landed in review round 2.\n",
    );
    const scannedDir = path.join(tmp, "scanned");
    // A relative `--config` spelling, resolved against the CLI's own
    // process cwd (`packageRoot`, see the file header for why the child
    // process's cwd can't be pointed at the fixture directory) rather
    // than against the scanned directory: `path.resolve` inside
    // `resolvePatternAnchor` treats it the same way either way, so this
    // still exercises the relative-spelling case the design calls for.
    const relativeConfigFromCliCwd = path.relative(packageRoot, configPath);

    const viaRelativeConfig = runCliJson([
      "check",
      scannedDir,
      "--pack",
      "review-slop",
      "--config",
      relativeConfigFromCliCwd,
    ]);
    const viaAbsoluteConfig = runCliJson([
      "check",
      scannedDir,
      "--pack",
      "review-slop",
      "--config",
      configPath,
    ]);

    // Base (pre-round-1) behavior: the scan root is the scanned directory
    // itself, `allowPaths: ["sub/allowed.md"]` matches, zero block
    // findings. Round 1's unconditional anchor broke this to 2.
    expect(viaRelativeConfig.blockCount).toBe(0);
    expect(viaAbsoluteConfig.blockCount).toBe(0);
  });

  it("CLI and MCP agree for a root-anchored allowPaths entry, contained under --config's directory", () => {
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

    const viaCli = runCliJson([
      "check",
      target,
      "--pack",
      "review-slop",
      "--config",
      configPath,
    ]);
    const viaMcp = runSlopCheck({
      path: target,
      packs: ["review-slop"],
      configPath,
    });

    expect(viaCli.blockCount).toBe(0);
    expect(viaMcp.blockCount).toBe(0);
    expect(viaMcp.violations).toEqual(viaCli.violations);
  });

  it("--stdin-path agrees with the equivalent file argument, contained under --config's directory", () => {
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
    const content = "F1 landed in review round 2.\n";
    fs.writeFileSync(target, content);

    const viaFile = runCliJson([
      "check",
      target,
      "--pack",
      "review-slop",
      "--config",
      configPath,
    ]);
    // An ABSOLUTE `--stdin-path`, not a relative one: the CLI's own child
    // process cwd is fixed at `packageRoot` (see the file header), which
    // has its own `package.json`, so a relative `--stdin-path` spelled
    // the same as the pattern would coincidentally relativize to the
    // same string under the pre-anchor nearest-package.json fallback too
    // (a false pass that would not discriminate the anchor from a broken
    // one). The absolute path breaks that coincidence: the nested
    // `packages/sub/package.json` fixture (see `beforeEach` above) is its
    // OWN nearest package.json, so the pre-anchor fallback relativizes it
    // to bare `README.md` (not matching `packages/sub/README.md`) while
    // the fix relativizes it to the config directory instead.
    const viaStdin = runCliJson(
      [
        "check",
        "--stdin-path",
        target,
        "--pack",
        "review-slop",
        "--config",
        configPath,
      ],
      content,
    );

    expect(viaFile.blockCount).toBe(0);
    expect(viaStdin.blockCount).toBe(0);
  });

  it("ignorePaths: a root-anchored entry excludes a nested file passed as an absolute CLI argument, same as a full-directory scan", () => {
    const configPath = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      configPath,
      [
        "packs:",
        "  review-slop: true",
        "ignorePaths:",
        "  - packages/sub/ignored/**",
      ].join("\n") + "\n",
    );
    fs.mkdirSync(path.join(tmp, "packages", "sub", "ignored"), {
      recursive: true,
    });
    const target = path.join(tmp, "packages", "sub", "ignored", "bad.md");
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

    // The single-file scan sees exactly this target: ignored means zero
    // files scanned and zero block findings for it, matching the fact
    // that walking the whole directory never picks it up either (its
    // finding-id content, if scanned, would be a block finding: the
    // absence of one here IS the assertion that it stayed excluded).
    expect(viaFile.filesScanned).toBe(0);
    expect(viaFile.blockCount).toBe(0);
    expect(viaDir.blockCount).toBe(0);
    expect(viaDir.violations.some((v) => v.path === target)).toBe(false);
  });

  it("treatAsCode: a root-anchored entry reclassifies a nested file passed as an absolute CLI argument out of prose-slop, same as a full-directory scan", () => {
    const configPath = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      configPath,
      [
        "packs:",
        "  prose-slop: true",
        "treatAsCode:",
        "  - packages/sub/notes.txt",
      ].join("\n") + "\n",
    );
    const target = path.join(tmp, "packages", "sub", "notes.txt");
    fs.writeFileSync(target, "This has an em dash — right here.\n");

    const viaFile = runCliJson([
      "check",
      target,
      "--pack",
      "prose-slop",
      "--config",
      configPath,
    ]);
    const viaDir = runCliJson([
      "check",
      tmp,
      "--pack",
      "prose-slop",
      "--config",
      configPath,
    ]);

    // `.txt` defaults to "prose" (would otherwise trip
    // `prose-slop/em-dash`); `treatAsCode` reclassifies it to "code" so
    // the rule no longer applies, in both scan shapes alike.
    expect(viaDir.warnCount).toBe(0);
    expect(viaFile.warnCount).toBe(0);
    expect(viaFile.violations).toEqual(viaDir.violations);
  });

  it("treatAsProse: a root-anchored entry reclassifies a nested file passed as an absolute CLI argument into prose-slop, same as a full-directory scan", () => {
    const configPath = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      configPath,
      [
        "packs:",
        "  prose-slop: true",
        "treatAsProse:",
        "  - packages/sub/notes.ts",
      ].join("\n") + "\n",
    );
    const target = path.join(tmp, "packages", "sub", "notes.ts");
    fs.writeFileSync(target, "This has an em dash — right here.\n");

    const viaFile = runCliJson([
      "check",
      target,
      "--pack",
      "prose-slop",
      "--config",
      configPath,
    ]);
    const viaDir = runCliJson([
      "check",
      tmp,
      "--pack",
      "prose-slop",
      "--config",
      configPath,
    ]);

    // `.ts` defaults to "code" (prose-slop wouldn't apply at all);
    // `treatAsProse` reclassifies it to "prose" so `prose-slop/em-dash`
    // newly applies, in both scan shapes alike.
    expect(viaDir.warnCount).toBe(1);
    expect(viaFile.warnCount).toBe(1);
    expect(viaFile.violations).toEqual(viaDir.violations);
  });
});

// Round 3: one test per ENTRY-POINT OPTION SITE, not per behaviour. Four
// entry points each pass two anchor options into the engine (`scanRoot`,
// which drives `review.allowPaths`/`placement.instructionGlobs`/
// `entrypointGlobs`, and `configAnchor`, which drives `ignorePaths`/
// `treatAsProse`/`treatAsCode`), so there are eight sites at which a
// dropped option would silently restore the old verdict for one family on
// one entry point. The tests above cover four of them; the four here cover
// the rest, each chosen so that neutralising exactly that one option at
// exactly that one site flips the assertion.
describe("each entry point's scanRoot and configAnchor option is load-bearing", () => {
  const reviewText = "F1 landed in review round 2.\n";
  const emDashText = "This has an em dash — right here.\n";

  function writeConfig(body: string[]): string {
    const configPath = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(configPath, body.join("\n") + "\n");
    return configPath;
  }

  it("MCP text: scanRoot carries the anchor, so a root-anchored review.allowPaths entry excuses the assumed filename", () => {
    const configPath = writeConfig([
      "packs:",
      "  review-slop: true",
      "review:",
      "  allowPaths:",
      "    - packages/sub/README.md",
    ]);
    const filename = path.join(tmp, "packages", "sub", "README.md");
    fs.writeFileSync(filename, reviewText);

    const viaText = runSlopCheck({
      text: reviewText,
      filename,
      packs: ["review-slop"],
      configPath,
    });
    const viaPath = runSlopCheck({
      path: filename,
      packs: ["review-slop"],
      configPath,
    });

    // Without the anchor on `scanRoot`, `checkText` falls back to the
    // nearest package.json above `filename` -- the NESTED
    // `packages/sub/package.json` from `beforeEach` -- which relativizes
    // the file to bare `README.md`, so the root-anchored pattern stops
    // matching and both findings in `reviewText` come back.
    expect(viaText.blockCount).toBe(0);
    expect(viaText.violations).toEqual(viaPath.violations);
  });

  it("MCP text: configAnchor carries the anchor, so a root-anchored treatAsProse entry reclassifies the assumed filename", () => {
    const configPath = writeConfig([
      "packs:",
      "  prose-slop: true",
      "treatAsProse:",
      "  - packages/sub/notes.ts",
    ]);
    const filename = path.join(tmp, "packages", "sub", "notes.ts");
    fs.writeFileSync(filename, emDashText);

    const viaText = runSlopCheck({
      text: emDashText,
      filename,
      packs: ["prose-slop"],
      configPath,
    });
    const viaPath = runSlopCheck({
      path: filename,
      packs: ["prose-slop"],
      configPath,
    });

    // `.ts` is "code" by default, and `prose-slop` never applies to code:
    // the em-dash violation exists only because `treatAsProse` matched,
    // and it only matches while `configAnchor` relativizes the ABSOLUTE
    // `filename` to `packages/sub/notes.ts`. Dropped, the pattern is
    // compared against the absolute path, matches nothing, and the count
    // falls to 0.
    expect(viaText.warnCount).toBe(1);
    expect(viaText.violations.map((v) => v.ruleId)).toEqual([
      "prose-slop/em-dash",
    ]);
    expect(viaText.violations).toEqual(viaPath.violations);
  });

  it("MCP text without a filename names no target: the placeholder is never anchored, whatever the process cwd", () => {
    const configPath = writeConfig([
      "packs:",
      "  prose-slop: true",
      "treatAsCode:",
      "  - packages/sub/input.md",
      // What an EMPTY filename would relativize to if it were anchored:
      // `path.resolve("")` is the (mocked) cwd itself.
      "  - packages/sub",
    ]);
    // The placeholder `input.md` resolved against a cwd inside the config
    // directory would LOOK contained. It names no file the caller chose,
    // so it must not be anchored: `input.md` stays prose and the em dash
    // is reported, exactly as before the anchor existed.
    const cwdSpy = vi
      .spyOn(process, "cwd")
      .mockReturnValue(path.join(tmp, "packages", "sub"));
    try {
      // Absent, empty and (from a JS caller that ignores the types) null
      // all name nothing: none may be anchored, and none may throw.
      const unnamed: Array<[string | undefined, string]> = [
        [undefined, "input.md"],
        ["", ""],
        [null as unknown as string, "input.md"],
      ];
      for (const [filename, reportedPath] of unnamed) {
        const viaText = runSlopCheck({
          text: emDashText,
          filename,
          packs: ["prose-slop"],
          configPath,
        });
        // The reported path keeps its pre-anchor derivation: the gate
        // decides the anchor, it does not rename the input.
        expect(viaText.violations[0]?.path).toBe(reportedPath);
        expect(viaText.warnCount).toBe(1);
        expect(viaText.violations.map((v) => v.ruleId)).toEqual([
          "prose-slop/em-dash",
        ]);
      }
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("MCP path: configAnchor carries the anchor, so a root-anchored ignorePaths entry prunes the named file exactly as the directory scan does", () => {
    const configPath = writeConfig([
      "packs:",
      "  review-slop: true",
      "ignorePaths:",
      "  - packages/sub/ignored/**",
    ]);
    fs.mkdirSync(path.join(tmp, "packages", "sub", "ignored"), {
      recursive: true,
    });
    const target = path.join(tmp, "packages", "sub", "ignored", "bad.md");
    fs.writeFileSync(target, reviewText);

    const viaPath = runSlopCheck({
      path: target,
      packs: ["review-slop"],
      configPath,
    });
    const viaDir = runSlopCheck({
      path: tmp,
      packs: ["review-slop"],
      configPath,
    });

    // Pruned before it is read, so the file is never counted and its two
    // findings never appear -- the same outcome walking the whole fixture
    // produces. Dropping `configAnchor` compares `ignorePaths` against the
    // absolute path, which the pattern cannot match, so the file is
    // scanned and both findings come back.
    expect(viaPath.filesScanned).toBe(0);
    expect(viaPath.blockCount).toBe(0);
    expect(viaDir.violations.some((v) => v.path === target)).toBe(false);
  });

  it("CLI stdin: configAnchor carries the anchor, so a root-anchored treatAsProse entry reclassifies the --stdin-path value", () => {
    const configPath = writeConfig([
      "packs:",
      "  prose-slop: true",
      "treatAsProse:",
      "  - packages/sub/notes.ts",
    ]);
    const target = path.join(tmp, "packages", "sub", "notes.ts");
    fs.writeFileSync(target, emDashText);

    const viaStdin = runCliJson(
      [
        "check",
        "--stdin-path",
        target,
        "--pack",
        "prose-slop",
        "--config",
        configPath,
      ],
      emDashText,
    );
    const viaFile = runCliJson([
      "check",
      target,
      "--pack",
      "prose-slop",
      "--config",
      configPath,
    ]);

    // Same reasoning as the MCP `text` case above: the violation exists
    // only while the ABSOLUTE `--stdin-path` value is relativized to
    // `packages/sub/notes.ts` before `treatAsProse` is matched.
    expect(viaStdin.warnCount).toBe(1);
    expect(viaStdin.violations.map((v) => v.ruleId)).toEqual([
      "prose-slop/em-dash",
    ]);
    expect(viaFile.warnCount).toBe(1);
  });
});

// The two shapes above are spelled with absolute paths, because the tsx
// runner pins the child's cwd to the package root. These two spawn the
// built CLI from the fixture root instead, so every path is spelled the
// way a person or a pre-commit hook spells it: relative to the config
// file's own directory.
describe("everyday invocation shapes, spelled relative to the config file's directory", () => {
  beforeAll(() => {
    ensureBuilt();
  }, 180_000);

  it("--stdin-path with a repo-relative path into a nested package is judged by the root-anchored allowPaths entry", () => {
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
    const content = "F1 landed in review round 2.\n";
    fs.writeFileSync(path.join(tmp, "packages", "sub", "README.md"), content);

    const viaStdin = runBuiltCliJson(
      [
        "check",
        "--stdin-path",
        "packages/sub/README.md",
        "--pack",
        "review-slop",
        "--config",
        "slop.config.yml",
      ],
      tmp,
      content,
    );

    // This is the invocation the pre-commit habit uses (pipe the file or
    // the commit message in, name the path relative to the repo root,
    // point at the repo-root config). Without the anchor it resolves
    // against the NESTED `packages/sub/package.json`, the root-anchored
    // allowlist entry stops matching, and the run blocks on two findings
    // the repo-root directory scan does not report.
    expect(viaStdin.filesScanned).toBe(1);
    expect(viaStdin.blockCount).toBe(0);
  });

  it("stdin without --stdin-path names no target: the <stdin> placeholder is never anchored, even from a cwd inside the config directory", () => {
    fs.writeFileSync(
      path.join(tmp, "slop.config.yml"),
      [
        "packs:",
        "  prose-slop: true",
        "treatAsCode:",
        '  - "packages/sub/<stdin>"',
      ].join("\n") + "\n",
    );

    const viaStdin = runBuiltCliJson(
      ["check", "--pack", "prose-slop", "--config", "../../slop.config.yml"],
      path.join(tmp, "packages", "sub"),
      "An em dash \u2014 sits in this prose.\n",
    );

    // Anchoring the placeholder would relativize `<cwd>/<stdin>` to
    // `packages/sub/<stdin>`, match the treatAsCode entry, turn the input
    // into code and silence prose-slop: a verdict decided by the working
    // directory. With no named target the input stays prose.
    expect(viaStdin.filesScanned).toBe(1);
    expect(viaStdin.warnCount).toBe(1);
  });

  it("an empty --stdin-path names no target either: the cwd it would resolve to is never anchored", () => {
    fs.writeFileSync(
      path.join(tmp, "slop.config.yml"),
      ["packs:", "  prose-slop: true", "treatAsCode:", "  - packages/sub"].join(
        "\n",
      ) + "\n",
    );

    const viaStdin = runBuiltCliJson(
      [
        "check",
        "--stdin-path",
        "",
        "--pack",
        "prose-slop",
        "--config",
        "../../slop.config.yml",
      ],
      path.join(tmp, "packages", "sub"),
      "An em dash \u2014 sits in this prose.\n",
    );

    // `path.resolve("")` is the process cwd. Anchored, it would relativize
    // to `packages/sub`, match the treatAsCode entry and silence
    // prose-slop from this one directory only.
    expect(viaStdin.warnCount).toBe(1);
  });

  it("a nested directory target resolves patterns against the config file's directory, not against itself", () => {
    const rootAnchored = path.join(tmp, "root-anchored.yml");
    fs.writeFileSync(
      rootAnchored,
      [
        "packs:",
        "  review-slop: true",
        "review:",
        "  allowPaths:",
        "    - packages/sub/README.md",
      ].join("\n") + "\n",
    );
    // The same allowlist entry written relative to the SCANNED
    // subdirectory: the spelling that worked before `--config` moved the
    // anchor, and the one the README's migration note tells you to
    // rewrite.
    const subAnchored = path.join(tmp, "sub-anchored.yml");
    fs.writeFileSync(
      subAnchored,
      [
        "packs:",
        "  review-slop: true",
        "review:",
        "  allowPaths:",
        "    - README.md",
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(tmp, "packages", "sub", "README.md"),
      "F1 landed in review round 2.\n",
    );

    const viaRootAnchored = runBuiltCliJson(
      [
        "check",
        "packages/sub",
        "--pack",
        "review-slop",
        "--config",
        "root-anchored.yml",
      ],
      tmp,
    );
    const viaSubAnchored = runBuiltCliJson(
      [
        "check",
        "packages/sub",
        "--pack",
        "review-slop",
        "--config",
        "sub-anchored.yml",
      ],
      tmp,
    );

    expect(viaRootAnchored.blockCount).toBe(0);
    // The documented breaking direction, asserted rather than only
    // described: a pattern written relative to the scanned subdirectory
    // no longer matches once `--config` is given.
    expect(viaSubAnchored.blockCount).toBe(2);
  });
});

// The corpus pre-pass classifies every file a second time, independently
// of the per-file classification the rules see, to decide what enters the
// corpus at all. That call needs the same anchor: a file wrongly left in
// the corpus keeps counting as a consumer of someone else's export, which
// changes a verdict on a DIFFERENT file than the misclassified one.
describe("corpus mode applies the anchor when it classifies files", () => {
  it("a root-anchored treatAsProse entry keeps the named file out of the corpus, so the export it referenced is reported as unused", () => {
    const configPath = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      configPath,
      [
        "packs:",
        "  code-slop: true",
        "corpus: true",
        "rules:",
        "  code-slop/unused-export:",
        "    enabled: true",
        "treatAsProse:",
        "  - packages/sub/src/consumer.ts",
      ].join("\n") + "\n",
    );
    const indexPath = path.join(tmp, "packages", "sub", "src", "index.ts");
    fs.writeFileSync(
      indexPath,
      "export function helperA() {\n  return 1;\n}\n",
    );
    fs.writeFileSync(
      path.join(tmp, "packages", "sub", "src", "consumer.ts"),
      'import { helperA } from "./index.js";\n' +
        "export function useIt() {\n  return helperA();\n}\n",
    );

    const summary = runCliJson([
      "check",
      tmp,
      "--pack",
      "code-slop",
      "--config",
      configPath,
    ]);
    const unused = summary.violations.filter(
      (v) => v.ruleId === "code-slop/unused-export",
    );

    // `consumer.ts` is the only file referencing `helperA`. Classified as
    // prose by the root-anchored pattern it never enters the corpus, so
    // `helperA` has no consumer and `index.ts` is flagged. Leave the
    // anchor off that classification and `consumer.ts` stays code, keeps
    // its reference, and this violation disappears entirely (its own
    // `useIt` export is not reported either, since the rules still see
    // `consumer.ts` as prose).
    expect(unused.map((v) => v.path)).toEqual([indexPath]);
  });
});

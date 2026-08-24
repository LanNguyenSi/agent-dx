import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFiles, buildCorpus } from "../src/engine.js";
import type {
  Corpus,
  FileTarget,
  PackDefinition,
  ResolvedConfig,
  Rule,
} from "../src/types.js";

// This package's own root: it has a real package.json with `main` and
// `exports` fields pointing at built `dist/*.js` files, so it always
// resolves a non-empty set of corpus entrypoints when used as a pkgRoot.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const baseConfig: ResolvedConfig = {
  packs: {
    "agent-tics": false,
    "prose-slop": false,
    "comment-slop": false,
    "code-slop": true,
    "ui-slop": false,
    "placement-slop": false,
  },
  ruleOverrides: {},
  ignorePaths: [],
  treatAsProse: [],
  treatAsCode: [],
  entrypointGlobs: [],
};

// Regression coverage for: `checkFiles` must call `buildCorpus` with the
// caller's raw `options.scanRoot` (possibly undefined), NOT the
// cwd-defaulted `resolvedScanRoot` it derives for `RuleContext.scanRoot`.
// `buildCorpus`'s own fallback (`pkgRoot = scanRoot ?? _findNearestPackageRoot(files)`)
// has no `process.cwd()` fallback by design: when neither a scanRoot nor a
// nearby package.json is available, it must resolve zero entrypoints, not
// silently adopt whatever package.json happens to be nearest to the
// process's current working directory.
describe("buildCorpus scanRoot decoupling from checkFiles", () => {
  let tmpDir: string | undefined;
  let originalCwd: string | undefined;

  afterEach(() => {
    if (originalCwd) process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    originalCwd = undefined;
  });

  it("buildCorpus resolves zero entrypoints with an undefined scanRoot and no nearby package.json, but resolves some when pointed at a real package via process.cwd()", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "slop-corpus-scanroot-"));
    const filePath = join(tmpDir, "a.ts");
    writeFileSync(filePath, `export function helperA() { return 1; }\n`);

    originalCwd = process.cwd();
    process.chdir(packageRoot);
    try {
      const noRoot = buildCorpus([filePath], baseConfig, undefined);
      expect(noRoot.entrypoints.size).toBe(0);

      const cwdRoot = buildCorpus([filePath], baseConfig, process.cwd());
      expect(cwdRoot.entrypoints.size).toBeGreaterThan(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("checkFiles (no options.scanRoot) builds a corpus with zero entrypoints even when process.cwd() has an unrelated package.json with real dist entrypoints", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "slop-corpus-scanroot-checkfiles-"));
    const filePath = join(tmpDir, "a.ts");
    writeFileSync(filePath, `export function helperA() { return 1; }\n`);

    // Probe rule/pack: captures whatever Corpus `checkFiles` actually
    // built and hands to rules via RuleContext, so this asserts on the
    // real corpus produced by checkFiles's internal buildCorpus call —
    // not on a hand-constructed one.
    let capturedCorpus: Corpus | undefined;
    const probeRule: Rule = {
      id: "probe/capture-corpus",
      pack: "code-slop",
      defaultSeverity: "info",
      enabledByDefault: true,
      rationale: "test probe capturing the corpus checkFiles built",
      appliesTo: (file: FileTarget) => file.kind === "code",
      check: (ctx) => {
        capturedCorpus = ctx.corpus;
        return [];
      },
    };
    const probePack: PackDefinition = {
      id: "code-slop",
      description: "test probe pack",
      rules: [probeRule],
    };

    originalCwd = process.cwd();
    // cwd has a real package.json (this package's own) with `main` and
    // `exports` resolving to real files under dist/ — the same shape the
    // reviewer's repro used to demonstrate the leak.
    process.chdir(packageRoot);
    try {
      checkFiles([filePath], {
        packs: [probePack],
        config: baseConfig,
        corpusEnabled: true,
        // Deliberately omitted: options.scanRoot
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(capturedCorpus).toBeDefined();
    expect(capturedCorpus!.entrypoints.size).toBe(0);
  });
});

import fs from "node:fs";
import path from "node:path";
import type { TSESTree } from "@typescript-eslint/types";
import type {
  CheckSummary,
  Corpus,
  CorpusExportEntry,
  FileTarget,
  PackDefinition,
  ResolvedConfig,
  Rule,
  RuleContext,
  Violation,
} from "./types.js";
import { effectiveSeverity, isRuleEnabled } from "./config.js";
import { detectFileKind, globToRegex } from "./util/file-kind.js";
import { buildDisableMap } from "./util/disable-comments.js";
import {
  extractDeclaredNames,
  isTypeScriptOrJavaScript,
  nodeLoc,
  parseTsFile,
  snippet,
  walk,
  type AnyNode,
} from "./util/ts-ast.js";

export interface CheckOptions {
  packs: PackDefinition[];
  config: ResolvedConfig;
  packFilter?: string[];
  /**
   * Opt-in to the corpus pre-pass programmatically.
   * The env var SLOP_CORPUS=1 and config.corpus:true are the other two switches.
   */
  corpusEnabled?: boolean;
  /**
   * Hint: the directory at which to start looking for package.json when
   * resolving entrypoints during corpus building.  Falls back to the
   * directory of the first scanned file when omitted.
   */
  scanRoot?: string;
}

export function checkText(
  text: string,
  filePath: string,
  options: CheckOptions,
): Violation[] {
  return _checkTextWithCorpus(text, filePath, options, undefined);
}

function _checkTextWithCorpus(
  text: string,
  filePath: string,
  options: CheckOptions,
  corpus: Corpus | undefined,
): Violation[] {
  const file: FileTarget = {
    path: filePath,
    text,
    kind: detectFileKind(filePath, options.config),
  };
  if (file.kind === "binary") return [];

  const disable = buildDisableMap(text);
  const violations: Violation[] = [];

  for (const pack of options.packs) {
    if (options.packFilter && !options.packFilter.includes(pack.id)) continue;
    // `--pack <id>` (packFilter) is documented as the opt-in path for
    // off-by-default packs (`comment-slop`, `code-slop`). A bare config
    // gate would mean `--pack code-slop` silently scans nothing — which
    // is exactly what users would not expect when they explicitly named
    // the pack on the CLI. So if the pack is in the explicit filter,
    // treat it as enabled regardless of `config.packs[pack.id]`.
    const explicitlyRequested = options.packFilter?.includes(pack.id) ?? false;
    if (!explicitlyRequested && !options.config.packs[pack.id]) continue;

    for (const rule of pack.rules) {
      if (!isRuleEnabled(rule.id, rule.pack, rule.enabledByDefault, options.config)) continue;
      if (!rule.appliesTo(file)) continue;

      const ctx: RuleContext = { file, config: options.config, corpus };
      const ruleViolations = runRule(rule, ctx);
      for (const v of ruleViolations) {
        if (disable.lineDisabled(v.line, v.ruleId, v.pack)) continue;
        v.severity = effectiveSeverity(rule.id, rule.defaultSeverity, options.config);
        violations.push(v);
      }
    }
  }

  return violations;
}

function runRule(rule: Rule, ctx: RuleContext): Violation[] {
  try {
    return rule.check(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Rule ${rule.id} failed on ${ctx.file.path}: ${msg}`);
  }
}

export function checkFiles(
  files: string[],
  options: CheckOptions,
): CheckSummary {
  // Build the corpus when explicitly requested (env, config option, or option flag).
  const wantCorpus =
    process.env.SLOP_CORPUS === "1" ||
    options.corpusEnabled === true ||
    options.config.corpus === true;
  const corpus = wantCorpus ? buildCorpus(files, options.config, options.scanRoot) : undefined;

  const violations: Violation[] = [];
  let scanned = 0;
  for (const filePath of files) {
    const text = fs.readFileSync(filePath, "utf8");
    violations.push(..._checkTextWithCorpus(text, filePath, options, corpus));
    scanned++;
  }
  const summary = summarize(violations, scanned);
  if (corpus && corpus.unmatchedEntrypointGlobs.length > 0) {
    summary.warnings = corpus.unmatchedEntrypointGlobs.map(
      (glob) =>
        `entrypointGlobs pattern "${glob}" matched no scanned files — check for a typo, or that it's relative to the scan root (or nearest package.json) rather than to something else`,
    );
  }
  return summary;
}

export function checkPath(
  rootPath: string,
  options: CheckOptions,
): CheckSummary {
  const files = walkDir(rootPath, options.config);
  return checkFiles(files, { ...options, scanRoot: options.scanRoot ?? rootPath });
}

// ─────────────────────────── Corpus building ──────────────────────────────────

/**
 * Build a cross-file Corpus from the given file list.
 *
 * Each .ts/.js file in `files` is parsed once; the pass extracts:
 *   - every exported symbol (ExportNamedDeclaration / ExportDefaultDeclaration)
 *   - every identifier reference (imported names + CallExpression callee names)
 *
 * Entrypoints are resolved from the nearest `package.json` relative to
 * `scanRoot` (or the first file's directory when `scanRoot` is omitted),
 * plus any file matched by `config.entrypointGlobs`.
 */
export function buildCorpus(
  files: string[],
  config: ResolvedConfig,
  scanRoot?: string,
): Corpus {
  const exportsByFile = new Map<string, CorpusExportEntry[]>();
  const referencingFilesByName = new Map<string, Set<string>>();
  const entrypoints = new Set<string>();
  const callCountBySymbol = new Map<string, number>();
  // Files reached via `export * from "./mod.js"` somewhere in the scan.
  // Merged into `entrypoints` after the main loop (see rationale below).
  const starReexportTargets = new Set<string>();

  const addExport = (filePath: string, symbol: string, node: TSESTree.Node, file: FileTarget): void => {
    const entry: CorpusExportEntry = { file: filePath, symbol, loc: nodeLoc(node), snippet: snippet(file, node) };
    let list = exportsByFile.get(filePath);
    if (!list) {
      list = [];
      exportsByFile.set(filePath, list);
    }
    list.push(entry);
  };

  const addReference = (filePath: string, name: string): void => {
    let referencingFiles = referencingFilesByName.get(name);
    if (!referencingFiles) {
      referencingFiles = new Set<string>();
      referencingFilesByName.set(name, referencingFiles);
    }
    referencingFiles.add(filePath);
  };

  for (const filePath of files) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const file: FileTarget = { path: filePath, text, kind: detectFileKind(filePath, config) };
    if (file.kind !== "code" || !isTypeScriptOrJavaScript(file)) continue;

    const result = parseTsFile(file);
    if (!result.ok) continue;

    walk(result.ast as unknown as AnyNode, (node) => {
      // ── Collect exports ─────────────────────────────────────────────────
      if (node.type === "ExportNamedDeclaration") {
        const exportNode = node as TSESTree.ExportNamedDeclaration;
        if (exportNode.declaration) {
          for (const name of extractDeclaredNames(exportNode.declaration as AnyNode)) {
            addExport(filePath, name, exportNode, file);
          }
        }
        for (const spec of exportNode.specifiers) {
          const exported = spec.exported;
          const name = exported.type === "Identifier" ? exported.name : null;
          if (name) addExport(filePath, name, spec, file);

          // A re-export (`export { x } from "./other.js"`) is a real
          // consumer of `x` in the *other* module — without this, every
          // barrel re-export makes its underlying symbol look unused.
          // `local` is the name as it exists in the source module (the
          // pre-rename name); that's what needs to count as referenced.
          if (exportNode.source && spec.local.type === "Identifier") {
            addReference(filePath, spec.local.name);
          }
        }
        return;
      }
      if (node.type === "ExportDefaultDeclaration") {
        addExport(filePath, "default", node, file);
        return;
      }
      // `export * from "./mod.js"` (and `export * as ns from "./mod.js"`).
      // We don't know which of `mod`'s exports are actually consumed
      // downstream of the barrel without resolving the whole re-export
      // chain, so — same trade-off as the package.json entrypoint
      // exemption — treat the *entire* resolved file as reachable public
      // API rather than tracking individual symbols. Cheaper than full
      // resolution, and it closes the false positive: without this, every
      // symbol in a file that's only ever consumed through a `export *`
      // barrel was flagged as unused.
      if (node.type === "ExportAllDeclaration") {
        const src = (node as TSESTree.ExportAllDeclaration).source;
        const specifier = src && typeof src.value === "string" ? src.value : null;
        if (specifier && specifier.startsWith(".")) {
          const abs = path.resolve(path.dirname(filePath), specifier);
          const resolved = _resolveSourceFile(abs);
          if (resolved) starReexportTargets.add(resolved);
        }
        return;
      }

      // ── Collect references: imports ──────────────────────────────────────
      if (node.type === "ImportDeclaration") {
        for (const spec of (node as TSESTree.ImportDeclaration).specifiers) {
          if (spec.type === "ImportSpecifier") {
            const imported = (spec as TSESTree.ImportSpecifier).imported;
            addReference(filePath, imported.type === "Identifier" ? imported.name : "default");
          } else if (spec.type === "ImportDefaultSpecifier") {
            addReference(filePath, "default");
          }
          // ImportNamespaceSpecifier (import * as ns) — no specific symbol to track
        }
        return;
      }

      // ── Collect references: call expressions ─────────────────────────────
      if (node.type === "CallExpression") {
        const callee = (node as TSESTree.CallExpression).callee;
        if (callee.type === "Identifier") {
          addReference(filePath, callee.name);
          callCountBySymbol.set(callee.name, (callCountBySymbol.get(callee.name) ?? 0) + 1);
        }
        return;
      }
    });
  }

  // ── Resolve package.json entrypoints ──────────────────────────────────────
  const pkgRoot = scanRoot ?? _findNearestPackageRoot(files);
  if (pkgRoot) _resolveEntrypoints(pkgRoot, entrypoints);

  // `entrypointGlobs` doesn't require a package.json — resolve it whenever
  // globs are configured, independent of the `if (pkgRoot)` branch above,
  // so programmatic `checkFiles` callers without a package.json in scope
  // still get it. Root is `scanRoot` when given, else the nearest
  // package.json directory, else `process.cwd()` (see the JSDoc on
  // `ResolvedConfig.entrypointGlobs` in types.ts for the same contract).
  const entrypointGlobs = config.entrypointGlobs ?? [];
  let unmatchedEntrypointGlobs: string[] = [];
  if (entrypointGlobs.length > 0) {
    const globRoot = scanRoot ?? pkgRoot ?? process.cwd();
    unmatchedEntrypointGlobs = _resolveEntrypointGlobs(globRoot, files, entrypointGlobs, entrypoints);
  }

  // `export * from` targets are exempted the same way package.json
  // entrypoints are (see the ExportAllDeclaration branch above).
  for (const target of starReexportTargets) entrypoints.add(target);

  return { exportsByFile, referencingFilesByName, entrypoints, callCountBySymbol, unmatchedEntrypointGlobs };
}

/** Walk up from the first file looking for a package.json directory. */
function _findNearestPackageRoot(files: string[]): string | null {
  if (files.length === 0) return null;
  let dir = path.dirname(path.resolve(files[0]));
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const TS_SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Resolve an absolute path to an existing file on disk: try it verbatim,
 * then swap its (real or apparent) extension across `TS_SOURCE_EXTS`.
 * Returns null when nothing on disk matches — e.g. a dist-only path with
 * no source counterpart in the scan root, or an unresolvable specifier.
 * Shared by package.json entrypoint resolution and `export * from`
 * resolution, which both need the same "given a path, find the real
 * source file" logic.
 */
function _resolveSourceFile(abs: string): string | null {
  if (fs.existsSync(abs)) return abs;
  const base = abs.replace(/\.[cm]?[jt]s[x]?$/, "");
  for (const ext of TS_SOURCE_EXTS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface _PkgEntryShape {
  main?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
}

/**
 * Populate `into` with absolute TS/JS source file paths reachable via
 * the package.json `main`, `bin`, and `exports` fields at `root`.
 *
 * The resolution is opportunistic: it tries the path verbatim, then
 * a set of source-file extension substitutions.  Files that cannot be
 * resolved on-disk are silently skipped (they may be pre-built dist
 * paths that map to no source file in the scan root).
 */
function _resolveEntrypoints(root: string, into: Set<string>): void {
  let pkg: _PkgEntryShape;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as _PkgEntryShape;
  } catch {
    return;
  }

  function tryAdd(raw: unknown): void {
    if (typeof raw !== "string") return;
    // Condition keys (e.g. "import", "require", "default") start without ".".
    if (!raw.startsWith(".")) return;
    const resolved = _resolveSourceFile(path.resolve(root, raw));
    if (resolved) into.add(resolved);
  }

  function walkExportsField(val: unknown): void {
    if (typeof val === "string") { tryAdd(val); return; }
    if (!val || typeof val !== "object") return;
    if (Array.isArray(val)) { for (const item of val) walkExportsField(item); return; }
    for (const v of Object.values(val as Record<string, unknown>)) walkExportsField(v);
  }

  if (pkg.main) tryAdd(pkg.main);

  if (pkg.bin) {
    if (typeof pkg.bin === "string") tryAdd(pkg.bin);
    else for (const v of Object.values(pkg.bin)) tryAdd(v);
  }

  if (pkg.exports) walkExportsField(pkg.exports);
}

/**
 * Populate `into` with every scanned file whose path (relative to `root`,
 * forward-slash normalized) matches one of `globs`.
 *
 * This is the escape hatch for the case `_resolveEntrypoints` cannot handle:
 * `package.json` `main`/`bin`/`exports` typically point at compiled `dist/`
 * output, so when the scan targets `src/` the real public-API barrel is
 * never recognised as an entrypoint and its re-exports get flagged as dead.
 * `config.entrypointGlobs` lets a project mark that barrel explicitly, e.g.
 * `entrypointGlobs: ["src/index.ts"]`.
 *
 * Returns the subset of `globs` that matched zero scanned files, so the
 * caller can surface a warning — a typo'd or wrongly-rooted pattern would
 * otherwise fail silently and leave the corpus rules behaving as if
 * `entrypointGlobs` had never been set.
 */
function _resolveEntrypointGlobs(root: string, files: string[], globs: string[], into: Set<string>): string[] {
  const regexes = globs.map((g) => globToRegex(g));
  const matchCounts = new Array<number>(globs.length).fill(0);
  for (const filePath of files) {
    const abs = path.resolve(filePath);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    for (let i = 0; i < regexes.length; i++) {
      if (regexes[i].test(rel)) {
        into.add(abs);
        matchCounts[i]++;
      }
    }
  }
  return globs.filter((_, i) => matchCounts[i] === 0);
}

export function summarize(violations: Violation[], filesScanned: number): CheckSummary {
  return {
    filesScanned,
    violations,
    blockCount: violations.filter((v) => v.severity === "block").length,
    warnCount: violations.filter((v) => v.severity === "warn").length,
    infoCount: violations.filter((v) => v.severity === "info").length,
  };
}

function walkDir(rootPath: string, config: ResolvedConfig): string[] {
  const stat = fs.statSync(rootPath);
  if (stat.isFile()) {
    return shouldIgnore(rootPath, config, false) ? [] : [rootPath];
  }
  const out: string[] = [];
  const stack: string[] = [rootPath];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const isDir = entry.isDirectory();
      if (shouldIgnore(full, config, isDir)) continue;
      if (isDir) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function shouldIgnore(filePath: string, config: ResolvedConfig, isDirectory: boolean): boolean {
  const normalized = filePath.split(path.sep).join("/");
  const candidates = isDirectory ? [normalized, normalized + "/"] : [normalized];
  return config.ignorePaths.some((glob) => {
    const re = globToRegex(glob);
    if (candidates.some((c) => re.test(c))) return true;
    if (isDirectory && glob.endsWith("/**")) {
      const dirGlob = glob.slice(0, -3);
      if (globToRegex(dirGlob).test(normalized)) return true;
    }
    return false;
  });
}

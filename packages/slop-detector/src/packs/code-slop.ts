import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { TSESTree } from "@typescript-eslint/types";
import type { FileTarget, PackDefinition, Rule, RuleContext, Violation } from "../types.js";
import { extractDeclaredNames, isTypeScriptOrJavaScript, parseTsFile, walk, type AnyNode, type ParsedTsFile } from "../util/ts-ast.js";

function appliesToCode(file: FileTarget): boolean {
  return isTypeScriptOrJavaScript(file);
}

function makeViolation(
  rule: Rule,
  file: FileTarget,
  loc: { line: number; column: number; endLine?: number; endColumn?: number },
  message: string,
  matched: string,
): Violation {
  return {
    ruleId: rule.id,
    pack: rule.pack,
    severity: rule.defaultSeverity,
    path: file.path,
    line: loc.line,
    column: loc.column,
    endLine: loc.endLine,
    endColumn: loc.endColumn,
    message,
    rationale: rule.rationale,
    matched,
  };
}

function nodeLoc(node: TSESTree.Node): { line: number; column: number; endLine: number; endColumn: number } {
  return {
    line: node.loc.start.line,
    column: node.loc.start.column + 1,
    endLine: node.loc.end.line,
    endColumn: node.loc.end.column + 1,
  };
}

function snippet(file: FileTarget, node: TSESTree.Node, max = 80): string {
  if (!node.range) return "";
  const raw = file.text.slice(node.range[0], Math.min(node.range[1], node.range[0] + max));
  return raw.replace(/\s+/g, " ");
}

// ─────────────────────────── Rule 1: try/catch around non-throwing code ───

const NEVER_THROWS: ReadonlySet<string> = new Set([
  "BooleanLiteral", "Literal", "TemplateLiteral", "Identifier", "ThisExpression",
  "NumericLiteral", "StringLiteral", "BigIntLiteral", "NullLiteral",
  "ArrayPattern", "ObjectPattern",
  "VariableDeclaration", "VariableDeclarator",
  "EmptyStatement", "BreakStatement", "ContinueStatement",
  "BlockStatement", "ReturnStatement", "IfStatement",
  "BinaryExpression", "LogicalExpression", "UnaryExpression",
  "ConditionalExpression", "SpreadElement",
  "ArrayExpression", "ObjectExpression", "Property",
  "AssignmentExpression", "UpdateExpression",
]);

function tryBlockMayThrow(block: TSESTree.BlockStatement): boolean {
  let mayThrow = false;
  walk(block as unknown as AnyNode, (node) => {
    if (mayThrow) return;
    switch (node.type) {
      case "CallExpression":
      case "NewExpression":
      case "AwaitExpression":
      case "YieldExpression":
      case "ThrowStatement":
      case "TaggedTemplateExpression":
        mayThrow = true;
        return;
      case "MemberExpression":
        // `a.b` can throw when `a` is null/undefined. Only safe if both sides
        // are obviously safe (this/identifier with non-computed key on a
        // *literal* is rare).
        if (node.object.type !== "ThisExpression") {
          mayThrow = true;
        }
        return;
      case "AssignmentExpression":
        if (node.left.type === "MemberExpression" && node.left.object.type !== "ThisExpression") {
          mayThrow = true;
        }
        return;
      default:
        if (NEVER_THROWS.has(node.type)) return;
        // Unknown node — conservative: assume it might throw. This keeps the
        // false-positive rate low at the cost of false negatives.
        mayThrow = true;
        return;
    }
  });
  return mayThrow;
}

const tryCatchCannotThrow: Rule = {
  id: "code-slop/try-catch-cannot-throw",
  pack: "code-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "A `try/catch` wrapping code that the AST proves cannot throw (no calls, no member access, no `await`) is dead defensive scaffolding — drop the wrap and trust the language.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];
    const ast = result.ast;
    const violations: Violation[] = [];
    walk(ast as unknown as AnyNode, (node) => {
      if (node.type !== "TryStatement") return;
      if (tryBlockMayThrow(node.block)) return;
      violations.push(
        makeViolation(
          tryCatchCannotThrow,
          ctx.file,
          nodeLoc(node),
          "try/catch wraps code with no calls, awaits or member-access — nothing here can throw",
          snippet(ctx.file, node),
        ),
      );
    });
    return violations;
  },
};

// ─────────────────────────── Rule 2: default value on required-typed param ─

function paramTypeIsRequired(typeAnnotation: TSESTree.TSTypeAnnotation | undefined): boolean {
  if (!typeAnnotation) return false; // no annotation: skip (could be JS).
  const t = typeAnnotation.typeAnnotation;
  // Skip if type is a union containing `undefined` or `null`.
  if (t.type === "TSUnionType") {
    const hasNullable = t.types.some(
      (m) =>
        m.type === "TSUndefinedKeyword" ||
        m.type === "TSNullKeyword" ||
        m.type === "TSVoidKeyword" ||
        (m.type === "TSLiteralType" && m.literal.type === "Literal" && m.literal.value === null),
    );
    if (hasNullable) return false;
  }
  if (
    t.type === "TSAnyKeyword" ||
    t.type === "TSUnknownKeyword" ||
    t.type === "TSUndefinedKeyword" ||
    t.type === "TSVoidKeyword" ||
    // A type-reference may be a generic parameter (`<T>`) that gets
    // instantiated with `undefined` at the call site, or a type alias whose
    // body we cannot inspect statically. Be conservative.
    t.type === "TSTypeReference"
  ) {
    return false;
  }
  return true;
}

const defaultOnRequiredParam: Rule = {
  id: "code-slop/default-on-required-param",
  pack: "code-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "A default value on a parameter whose type forbids `undefined` is unreachable — TypeScript already enforces the value is supplied. Drop the default or widen the type to be honest about it.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];
    const ast = result.ast;
    const violations: Violation[] = [];
    walk(ast as unknown as AnyNode, (node) => {
      if (
        node.type !== "FunctionDeclaration" &&
        node.type !== "FunctionExpression" &&
        node.type !== "ArrowFunctionExpression" &&
        node.type !== "TSDeclareFunction"
      ) {
        return;
      }
      const fn = node as TSESTree.FunctionLike;
      for (const param of fn.params) {
        if (param.type !== "AssignmentPattern") continue;
        const left = param.left;
        if (left.type !== "Identifier") continue;
        if (left.optional) continue; // `x?: T = ...` is contradictory but TS already complains.
        if (!paramTypeIsRequired(left.typeAnnotation)) continue;
        violations.push(
          makeViolation(
            defaultOnRequiredParam,
            ctx.file,
            nodeLoc(param),
            `Default value on \`${left.name}\` whose type does not include \`undefined\` — the default is unreachable`,
            snippet(ctx.file, param),
          ),
        );
      }
    });
    return violations;
  },
};

// ─────────────────────────── Rule 3: empty catch / rethrow ────────────────

function isPureRethrow(handler: TSESTree.CatchClause): boolean {
  const body = handler.body;
  if (body.body.length !== 1) return false;
  const stmt = body.body[0];
  if (stmt.type !== "ThrowStatement") return false;
  if (stmt.argument.type !== "Identifier") return false;
  if (!handler.param || handler.param.type !== "Identifier") return false;
  return stmt.argument.name === handler.param.name;
}

function isEmptyCatch(handler: TSESTree.CatchClause): boolean {
  return handler.body.body.length === 0;
}

const emptyOrRethrowCatch: Rule = {
  id: "code-slop/empty-or-rethrow-catch",
  pack: "code-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "`catch (e) { throw e; }` and empty `catch {}` blocks are no-ops dressed up as error handling. Either swallow with intent (and a comment explaining why), or drop the wrapper.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];
    const ast = result.ast;
    const violations: Violation[] = [];
    walk(ast as unknown as AnyNode, (node) => {
      if (node.type !== "CatchClause") return;
      if (isPureRethrow(node)) {
        violations.push(
          makeViolation(
            emptyOrRethrowCatch,
            ctx.file,
            nodeLoc(node),
            "Catch only rethrows the error — drop the try/catch wrapper",
            snippet(ctx.file, node),
          ),
        );
      } else if (isEmptyCatch(node)) {
        violations.push(
          makeViolation(
            emptyOrRethrowCatch,
            ctx.file,
            nodeLoc(node),
            "Empty catch block silently swallows errors — handle, log, or remove the try/catch",
            snippet(ctx.file, node),
          ),
        );
      }
    });
    return violations;
  },
};

// ─────────────────────────── Rule 4: async without await ──────────────────

function functionBodyHasAwait(node: TSESTree.FunctionLike): boolean {
  const body = node.body;
  if (!body || body.type !== "BlockStatement") return false;
  let found = false;
  walk(body as unknown as AnyNode, (n) => {
    if (found) return;
    if (n.type === "AwaitExpression" || n.type === "ForOfStatement" && n.await) {
      found = true;
    }
    // Don't recurse into nested function bodies — they have their own scope.
    if (
      n !== body &&
      (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression")
    ) {
      // walk() will recurse anyway; we tolerate the false negative here.
    }
  });
  return found;
}

function functionReturnTypeRequiresPromise(node: TSESTree.FunctionLike): boolean {
  const ret = (node as TSESTree.FunctionDeclaration).returnType;
  if (!ret) return false;
  const t = ret.typeAnnotation;
  if (t.type === "TSTypeReference" && t.typeName.type === "Identifier" && t.typeName.name === "Promise") {
    return true;
  }
  return false;
}

const asyncWithoutAwait: Rule = {
  id: "code-slop/async-without-await",
  pack: "code-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "An `async` function with no `await` and no `Promise<T>` return type is wrapping its return value in a Promise for nothing. Drop `async` or add the await that's missing.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];
    const ast = result.ast;
    const violations: Violation[] = [];
    walk(ast as unknown as AnyNode, (node) => {
      if (
        node.type !== "FunctionDeclaration" &&
        node.type !== "FunctionExpression" &&
        node.type !== "ArrowFunctionExpression"
      ) {
        return;
      }
      const fn = node as TSESTree.FunctionLike;
      if (!fn.async) return;
      if (functionBodyHasAwait(fn)) return;
      if (functionReturnTypeRequiresPromise(fn)) return;
      violations.push(
        makeViolation(
          asyncWithoutAwait,
          ctx.file,
          nodeLoc(node),
          "`async` function with no `await` and no `Promise<T>` return type — drop `async` or add the missing `await`",
          snippet(ctx.file, node),
        ),
      );
    });
    return violations;
  },
};

// ─────────────────────────── Rule 5: backcompat shim for unreleased API ───

const KEPT_FOR_BACKCOMPAT = /kept\s+for\s+back(?:wards?[\s-]?)?compat(?:ibility)?/i;
const DEPRECATED_SINCE = /@deprecated\s+since\s+v?(\d+\.\d+\.\d+)/i;

interface Origin {
  packageVersion: string | null;
}

// Per-directory memoisation for package.json walks. A scan over a 10k-file
// repo would otherwise stat ~package.json up to 10x per file; this collapses
// to one lookup per directory containing files, then cache hits.
const packageVersionCache = new Map<string, string | null>();

function readPackageVersion(filePath: string): string | null {
  let dir = path.dirname(path.resolve(filePath));
  const visited: string[] = [];
  try {
    for (let i = 0; i < 10; i++) {
      if (packageVersionCache.has(dir)) {
        const hit = packageVersionCache.get(dir) ?? null;
        for (const v of visited) packageVersionCache.set(v, hit);
        return hit;
      }
      visited.push(dir);
      const pkg = path.join(dir, "package.json");
      if (fs.existsSync(pkg)) {
        const raw = JSON.parse(fs.readFileSync(pkg, "utf8")) as { version?: string };
        const version = typeof raw.version === "string" ? raw.version : null;
        for (const v of visited) packageVersionCache.set(v, version);
        return version;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    for (const v of visited) packageVersionCache.set(v, null);
    return null;
  }
  for (const v of visited) packageVersionCache.set(v, null);
  return null;
}

function semverGreater(a: string, b: string): boolean {
  const [aMajor, aMinor, aPatch] = a.split(".").map((n) => parseInt(n, 10));
  const [bMajor, bMinor, bPatch] = b.split(".").map((n) => parseInt(n, 10));
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch > bPatch;
}

const backcompatShimUnreleased: Rule = {
  id: "code-slop/backcompat-shim-unreleased",
  pack: "code-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "`@deprecated since v0.5.0` on a package whose current version is 0.3.0 means the agent invented a backcompat story for code that never shipped. Drop the shim — there is nothing to be backwards-compatible *with*.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];
    const ast = result.ast as ParsedTsFile;
    const origin: Origin = { packageVersion: readPackageVersion(ctx.file.path) };
    const violations: Violation[] = [];

    // (a) `@deprecated since X.Y.Z` for a version greater than the current one.
    if (origin.packageVersion) {
      for (const c of ast.comments ?? []) {
        if (c.type !== "Block") continue;
        const m = c.value.match(DEPRECATED_SINCE);
        if (!m) continue;
        const claimed = m[1];
        if (semverGreater(claimed, origin.packageVersion)) {
          violations.push(
            makeViolation(
              backcompatShimUnreleased,
              ctx.file,
              {
                line: c.loc.start.line,
                column: c.loc.start.column + 1,
                endLine: c.loc.end.line,
                endColumn: c.loc.end.column + 1,
              },
              `\`@deprecated since v${claimed}\` but package.json is at ${origin.packageVersion} — the deprecation refers to an unreleased version`,
              `/*${c.value.slice(0, 80)}*/`,
            ),
          );
        }
      }
    }

    // (b) `// kept for backcompat` orphan markers in code files. Distinct
    // from the comment-slop variant: this rule treats them as a *code* smell
    // (the function exists only as a shim) rather than a standalone comment
    // leftover. The text-vs-marker proportion guard prevents the rule from
    // matching prose that quotes the marker as an example (e.g. this file
    // does that in its own rationale strings and inline comments).
    for (const c of ast.comments ?? []) {
      const m = KEPT_FOR_BACKCOMPAT.exec(c.value);
      if (!m) continue;
      const trimmed = c.value.trim();
      // Marker must dominate the comment: ≤24 chars of surrounding text.
      // Comments like `// internal helper, kept for backcompat` (10 chars
      // before, 0 after) still fire; long prose that quotes the phrase does
      // not.
      if (trimmed.length - m[0].length > 24) continue;
      // Only flag in code-slop if the comment is attached to a function or
      // export declaration; a free-standing comment is comment-slop's job.
      const offset = c.range?.[1] ?? -1;
      if (offset < 0) continue;
      const after = ctx.file.text.slice(offset, offset + 200);
      // The declaration must be the *next* significant token after the
      // comment — only whitespace, async, and decorators allowed in between.
      // Otherwise we'd flag any comment that has a function declaration
      // somewhere in the next 200 chars.
      if (
        /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:async\s+)?(?:export\s+(?:default\s+)?)?(?:function|const|class|let|var|interface|type)\b/.test(
          after,
        )
      ) {
        violations.push(
          makeViolation(
            backcompatShimUnreleased,
            ctx.file,
            {
              line: c.loc.start.line,
              column: c.loc.start.column + 1,
              endLine: c.loc.end.line,
              endColumn: c.loc.end.column + 1,
            },
            "Symbol kept only for backcompat — verify a real consumer exists outside this repo, otherwise delete",
            c.type === "Line" ? `//${c.value}` : `/*${c.value}*/`,
          ),
        );
      }
    }

    return violations;
  },
};

void semverGreater; // keep export-graph honest under noUnusedLocals when imported by tests.

// ─────────────────────────── Rule 6: phantom (undeclared) import ──────────

// Bare Node builtins. The `node:`-prefixed form is always a builtin and is
// handled before this lookup; subpaths like `fs/promises` reduce to `fs`
// first, so only the top-level names are listed here.
const NODE_BUILTINS: ReadonlySet<string> = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls",
  "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
  "worker_threads", "zlib",
]);

interface PackageJsonShape {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

interface PackageContext {
  // Every specifier the rule must treat as legitimately importable: declared
  // dependency names (all four blocks), the package's own name, and workspace
  // sibling names.
  known: ReadonlySet<string>;
  // false when no package.json was found above the file — the rule cannot
  // decide and stays a no-op.
  found: boolean;
}

// Per-directory memoisation, mirroring readPackageVersion: a scan over a large
// repo would otherwise re-walk package.json for every file in a directory.
const packageContextCache = new Map<string, PackageContext>();

function readJsonSafe(file: string): PackageJsonShape | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as PackageJsonShape;
  } catch {
    return null;
  }
}

// Mirror of readJsonSafe for YAML files (e.g. pnpm-workspace.yaml).
// Returns the parsed object, or null on any read/parse error.
function readYamlSafe(file: string): unknown {
  try {
    return YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

// Extract the `packages` array from a pnpm-workspace.yaml file at the given
// path. Returns an empty array when the file is absent or has no string-typed
// `packages` entries.
function pnpmWorkspacePatterns(wsYamlPath: string): string[] {
  const raw = readYamlSafe(wsYamlPath);
  if (!raw || typeof raw !== "object") return [];
  const pkgs = (raw as Record<string, unknown>).packages;
  if (!Array.isArray(pkgs)) return [];
  return pkgs.filter((p): p is string => typeof p === "string");
}

function collectDepNames(pkg: PackageJsonShape, into: Set<string>): void {
  for (const block of [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ]) {
    if (block && typeof block === "object") {
      for (const name of Object.keys(block)) into.add(name);
    }
  }
}

function workspacePatterns(pkg: PackageJsonShape): string[] {
  const ws = pkg.workspaces;
  if (Array.isArray(ws)) return ws.filter((p): p is string => typeof p === "string");
  if (ws && typeof ws === "object" && Array.isArray(ws.packages)) {
    return ws.packages.filter((p): p is string => typeof p === "string");
  }
  return [];
}

// Resolve workspace globs to the `name` of each sibling package. Handles:
//   - exact paths (no star): `packages/my-lib`
//   - single-level wildcard: `packages/*`, `packages/eslint-*`
//   - nested wildcard: `packages/*/*`
//   - globstar: `apps/**` (any depth below the prefix)
// Does NOT add a glob dependency — the resolver is hand-rolled and conservative.
// Known fail-open limitations (each can only UNDER-flag, never over-flag, so
// they are safe for a warn-severity rule): negation patterns (`!packages/x`)
// are not subtracted, symlinked package dirs are skipped (readdir reports them
// as non-directories), and only `*` is honored as a wildcard (other glob
// metacharacters are matched literally).
function collectWorkspaceSiblings(rootDir: string, patterns: string[], into: Set<string>): void {
  // Walk the pattern segments and return the set of concrete directory paths
  // that match. A literal segment descends into a single child; a segment with
  // `*` (other than `**`) matches directory entries against an anchored regex;
  // `**` matches zero or more directory levels.
  function resolveGlob(currentDirs: string[], segments: string[]): string[] {
    if (segments.length === 0) return currentDirs;
    const [seg, ...rest] = segments;
    const next: string[] = [];
    for (const dir of currentDirs) {
      if (seg === "**") {
        // Collect this dir and all nested subdirs, then continue with remainder.
        const allDirs: string[] = [dir];
        function collectSubdirs(d: string, depth: number): void {
          if (depth > 10) return;
          let ents: fs.Dirent[];
          try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            if (e.isDirectory()) {
              allDirs.push(path.join(d, e.name));
              collectSubdirs(path.join(d, e.name), depth + 1);
            }
          }
        }
        collectSubdirs(dir, 0);
        next.push(...resolveGlob(allDirs, rest));
      } else if (seg.includes("*")) {
        // Escape regex metacharacters except `*`, then replace `*` with `.*`.
        // `?` is escaped too (we only honor `*`), and the RegExp build is
        // wrapped so a pathological segment from a scanned repo's manifest can
        // never throw out of the rule — it just resolves no siblings.
        const regexSrc = seg.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
        let re: RegExp;
        try {
          re = new RegExp(`^${regexSrc}$`);
        } catch {
          continue; // invalid glob segment — fail open
        }
        let ents: fs.Dirent[];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          if (e.isDirectory() && re.test(e.name)) {
            next.push(path.join(dir, e.name));
          }
        }
      } else {
        // Literal segment — descend unconditionally (let downstream catch ENOENT).
        next.push(path.join(dir, seg));
      }
    }
    return resolveGlob(next, rest);
  }

  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      // Exact path — try to read its package.json directly.
      const pkg = readJsonSafe(path.join(rootDir, pattern, "package.json"));
      if (pkg?.name) into.add(pkg.name);
      continue;
    }
    // resolveGlob expands every wildcard — including `**`, which yields every
    // directory at every depth below its prefix — so each resolved directory is
    // itself a candidate package directory. Read its package.json name.
    const segments = pattern.split(/[\\/]+/).filter(Boolean);
    for (const dir of resolveGlob([rootDir], segments)) {
      const pkg = readJsonSafe(path.join(dir, "package.json"));
      if (pkg?.name) into.add(pkg.name);
    }
  }
}

function readPackageContext(filePath: string): PackageContext {
  const startDir = path.dirname(path.resolve(filePath));
  const cached = packageContextCache.get(startDir);
  if (cached) return cached;

  // Phase 1 — walk up to the nearest package.json (the file's own package).
  const chain: string[] = [];
  let dir = startDir;
  let ownPkg: PackageJsonShape | null = null;
  let ownDir = "";
  for (let i = 0; i < 40; i++) {
    chain.push(dir);
    if (fs.existsSync(path.join(dir, "package.json"))) {
      ownPkg = readJsonSafe(path.join(dir, "package.json"));
      ownDir = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // ownPkg is null when no package.json exists above the file, or when the
  // nearest one is malformed JSON. Both fail open to a no-op: a broken
  // manifest yields no declared names, so scanning it would flag every
  // import — worse than staying silent for a warn-severity rule.
  if (!ownPkg) {
    const miss: PackageContext = { known: new Set(), found: false };
    for (const d of chain) packageContextCache.set(d, miss);
    return miss;
  }

  const known = new Set<string>();
  collectDepNames(ownPkg, known);
  if (ownPkg.name) known.add(ownPkg.name);

  // Phase 2 — find the nearest workspace root at or above the own package and
  // add every sibling package name. A workspace sibling imported without a
  // dependency entry is legal in a monorepo, so it must not be flagged.
  // Patterns are gathered from BOTH package.json `workspaces` AND a
  // `pnpm-workspace.yaml` file at the same directory (union of both sources).
  let wsDir = ownDir;
  for (let i = 0; i < 40; i++) {
    const pkg = wsDir === ownDir ? ownPkg : readJsonSafe(path.join(wsDir, "package.json"));
    const pkgPatterns = pkg ? workspacePatterns(pkg) : [];
    const pnpmPatterns = pnpmWorkspacePatterns(path.join(wsDir, "pnpm-workspace.yaml"));
    const patterns = Array.from(new Set([...pkgPatterns, ...pnpmPatterns]));
    if (patterns.length > 0) {
      collectWorkspaceSiblings(wsDir, patterns, known);
      break;
    }
    const parent = path.dirname(wsDir);
    if (parent === wsDir) break;
    wsDir = parent;
  }

  const ctx: PackageContext = { known, found: true };
  for (const d of chain) packageContextCache.set(d, ctx);
  return ctx;
}

type SpecifierClass = { kind: "skip" } | { kind: "package"; name: string };

// Reduce a module specifier to the package name to look up, or classify it as
// not-our-concern (relative, absolute, builtin, protocol URL, `#imports`).
function classifySpecifier(spec: string): SpecifierClass {
  if (spec.length === 0) return { kind: "skip" };
  if (spec.startsWith(".")) return { kind: "skip" }; // ./ ../ . ..
  if (spec.startsWith("/")) return { kind: "skip" }; // absolute posix
  if (spec.startsWith("#")) return { kind: "skip" }; // package.json `imports`
  if (/^[a-zA-Z]:[\\/]/.test(spec)) return { kind: "skip" }; // absolute windows
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return { kind: "skip" }; // node:, data:, http:, ...
  let name: string;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2 || parts[0].length < 2 || parts[1].length === 0) {
      return { kind: "skip" }; // malformed scoped specifier
    }
    name = `${parts[0]}/${parts[1]}`;
  } else {
    name = spec.split("/")[0];
  }
  if (NODE_BUILTINS.has(name)) return { kind: "skip" };
  return { kind: "package", name };
}

const phantomImport: Rule = {
  id: "code-slop/phantom-import",
  pack: "code-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "An import of a package that no package.json in scope declares is a hallucinated dependency — it will fail to install or silently resolve to the wrong thing. Declare the dependency or fix the specifier.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];
    const pkg = readPackageContext(ctx.file.path);
    if (!pkg.found) return []; // no package.json above the file — cannot decide.

    const violations: Violation[] = [];
    const consider = (spec: string, node: TSESTree.Node): void => {
      const cls = classifySpecifier(spec);
      if (cls.kind !== "package") return;
      if (pkg.known.has(cls.name)) return;
      violations.push(
        makeViolation(
          phantomImport,
          ctx.file,
          nodeLoc(node),
          `\`${cls.name}\` is imported but not declared in package.json (dependencies, devDependencies, peerDependencies or optionalDependencies)`,
          snippet(ctx.file, node),
        ),
      );
    };

    walk(result.ast as unknown as AnyNode, (node) => {
      switch (node.type) {
        case "ImportDeclaration":
        case "ExportAllDeclaration":
        case "ExportNamedDeclaration": {
          const source = node.source;
          if (source && source.type === "Literal" && typeof source.value === "string") {
            consider(source.value, source);
          }
          return;
        }
        case "ImportExpression": {
          const source = node.source;
          if (source.type === "Literal" && typeof source.value === "string") {
            consider(source.value, source);
          }
          return;
        }
        case "TSImportEqualsDeclaration": {
          const ref = node.moduleReference;
          if (
            ref.type === "TSExternalModuleReference" &&
            ref.expression.type === "Literal" &&
            typeof ref.expression.value === "string"
          ) {
            consider(ref.expression.value, ref.expression);
          }
          return;
        }
        case "CallExpression": {
          // Bare `require("pkg")` call.
          if (
            node.callee.type === "Identifier" &&
            node.callee.name === "require" &&
            node.arguments.length === 1 &&
            node.arguments[0].type === "Literal" &&
            typeof node.arguments[0].value === "string"
          ) {
            consider(node.arguments[0].value, node.arguments[0]);
            return;
          }
          // `require.resolve("pkg")` — equally broken for undeclared packages.
          if (
            node.callee.type === "MemberExpression" &&
            !node.callee.computed &&
            node.callee.object.type === "Identifier" &&
            node.callee.object.name === "require" &&
            node.callee.property.type === "Identifier" &&
            node.callee.property.name === "resolve" &&
            node.arguments.length >= 1 &&
            node.arguments[0].type === "Literal" &&
            typeof node.arguments[0].value === "string"
          ) {
            consider(node.arguments[0].value, node.arguments[0]);
          }
          return;
        }
        default:
          return;
      }
    });
    return violations;
  },
};

// Exported test-only helper: clears all module-level caches so that test cases
// that create temporary directories cannot observe stale results from prior runs.
export function __resetCaches(): void {
  packageContextCache.clear();
  packageVersionCache.clear();
}

// ─────────────────────────── Rule 7: placeholder (stub) function body ─────

// Placeholder-ish text in a thrown error message, or in the error
// constructor name (`NotImplementedError`).
const STUB_THROW_TEXT =
  /\b(?:not[\s-]*(?:yet[\s-]*)?implement|unimplement|todo|fixme|tbd|stub|placeholder|not[\s-]*supported|coming[\s-]*soon)/i;
const STUB_THROW_CTOR = /^(?:not.?implement|unimplement)/i;

type StubKind = "empty" | "throw" | "return";

const STUB_BODY_MESSAGE: Record<StubKind, string> = {
  empty: "has an empty body",
  throw: "only throws a not-implemented error",
  return: "only returns a trivial placeholder value (null / undefined / {} / [])",
};

// A string literal or a no-substitution template literal, else null.
function staticStringValue(node: TSESTree.Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  return null;
}

// `throw new Error("not implemented")` / `throw new NotImplementedError()`.
function isPlaceholderThrow(stmt: TSESTree.ThrowStatement): boolean {
  const arg = stmt.argument;
  if (arg.type !== "NewExpression") return false;
  if (arg.callee.type === "Identifier" && STUB_THROW_CTOR.test(arg.callee.name)) return true;
  const msg = staticStringValue(arg.arguments[0]);
  return msg !== null && STUB_THROW_TEXT.test(msg);
}

// `return;` / `return null` / `return undefined` / `return void 0` /
// `return {}` / `return []`.
function isTrivialReturn(stmt: TSESTree.ReturnStatement): boolean {
  const arg = stmt.argument;
  if (!arg) return true;
  if (arg.type === "Literal" && arg.value === null) return true;
  if (arg.type === "Identifier" && arg.name === "undefined") return true;
  if (arg.type === "UnaryExpression" && arg.operator === "void") return true;
  if (arg.type === "ObjectExpression" && arg.properties.length === 0) return true;
  if (arg.type === "ArrayExpression" && arg.elements.length === 0) return true;
  return false;
}

// Classify a block body as a placeholder, or null when it is real code.
function classifyStubBody(body: TSESTree.BlockStatement): StubKind | null {
  if (body.body.length === 0) return "empty";
  if (body.body.length !== 1) return null;
  const stmt = body.body[0];
  if (stmt.type === "ThrowStatement" && isPlaceholderThrow(stmt)) return "throw";
  if (stmt.type === "ReturnStatement" && isTrivialReturn(stmt)) return "return";
  return null;
}

function memberName(key: TSESTree.Node): string {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return String(key.value);
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  return "method";
}

const stubBody: Rule = {
  id: "code-slop/stub-body",
  pack: "code-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "A named function or method whose whole body is empty, a not-implemented throw, or a trivial `return null`/`undefined`/`{}`/`[]` is a scaffolded signature that was never finished. Implement it or delete the stub.",
  // Ambient `.d.ts` files are declaration-only by design — never flag them.
  appliesTo: (file) => appliesToCode(file) && !/\.d\.[cm]?ts$/i.test(file.path),
  check(ctx: RuleContext): Violation[] {
    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];
    const violations: Violation[] = [];
    const flag = (node: TSESTree.Node, name: string, kind: StubKind): void => {
      violations.push(
        makeViolation(
          stubBody,
          ctx.file,
          nodeLoc(node),
          `\`${name}\` ${STUB_BODY_MESSAGE[kind]} — finish the implementation or delete the stub`,
          snippet(ctx.file, node),
        ),
      );
    };

    walk(result.ast as unknown as AnyNode, (node) => {
      // Named function declarations. `export default function () {}` has no
      // id (anonymous) and is skipped; overload signatures parse as
      // TSDeclareFunction and never reach here.
      if (node.type === "FunctionDeclaration") {
        if (!node.id) return;
        const kind = classifyStubBody(node.body);
        if (kind) flag(node, node.id.name, kind);
        return;
      }
      // Class methods. v1 stays conservative: only `method` kind, not
      // constructors or accessors. Abstract methods parse as
      // TSAbstractMethodDefinition and never match; an overload signature's
      // value is a TSEmptyBodyFunctionExpression, skipped by the
      // FunctionExpression guard below.
      if (node.type === "MethodDefinition") {
        if (node.kind !== "method") return;
        const fn = node.value;
        if (fn.type !== "FunctionExpression" || fn.body?.type !== "BlockStatement") return;
        const kind = classifyStubBody(fn.body);
        if (kind) flag(node, memberName(node.key), kind);
        return;
      }
    });
    return violations;
  },
};

// ─────────────────────────── Rule 8: unused export (corpus-aware) ────────────

const unusedExport: Rule = {
  id: "code-slop/unused-export",
  pack: "code-slop",
  defaultSeverity: "warn",
  // Off by default — requires the corpus pre-pass (SLOP_CORPUS=1 or config.corpus:true).
  enabledByDefault: false,
  rationale:
    "An exported symbol with no consumers inside the package and no coverage via package.json entrypoints (bin/main/exports) is dead public surface — either consume it internally, expose it via the public API map, or delete it.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    // Bail early when corpus is absent; preserves backward compat with direct
    // rule.check() calls in unit tests that do not build a corpus.
    if (!ctx.corpus) return [];

    const { referencesByFile, entrypoints } = ctx.corpus;

    // Skip every symbol in files that are package.json entrypoints — those
    // symbols ARE the public API regardless of whether they're imported
    // elsewhere in the scan root.
    const absPath = path.resolve(ctx.file.path);
    if (entrypoints.has(absPath) || entrypoints.has(ctx.file.path)) return [];

    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];

    // Collect (symbol-name, AST-node) pairs for all exports in this file.
    const fileExports: Array<{ name: string; node: TSESTree.Node }> = [];
    walk(result.ast as unknown as AnyNode, (node) => {
      if (node.type === "ExportNamedDeclaration") {
        const exportNode = node as TSESTree.ExportNamedDeclaration;
        if (exportNode.declaration) {
          for (const name of extractDeclaredNames(exportNode.declaration as AnyNode)) {
            fileExports.push({ name, node: exportNode });
          }
        }
        for (const spec of exportNode.specifiers) {
          const exported = spec.exported;
          const name = exported.type === "Identifier" ? exported.name : null;
          if (name) fileExports.push({ name, node: spec });
        }
        return;
      }
      if (node.type === "ExportDefaultDeclaration") {
        fileExports.push({ name: "default", node });
      }
    });

    const violations: Violation[] = [];
    for (const { name, node } of fileExports) {
      // Does any OTHER file reference this symbol?
      const hasConsumer = Array.from(referencesByFile.entries()).some(
        ([file, refs]) => file !== ctx.file.path && refs.has(name),
      );
      if (!hasConsumer) {
        violations.push(
          makeViolation(
            unusedExport,
            ctx.file,
            nodeLoc(node),
            `\`${name}\` is exported but not imported by any other file in the package`,
            snippet(ctx.file, node),
          ),
        );
      }
    }
    return violations;
  },
};

// ─────────────────────────── Rule 9: single-callsite helper (corpus-aware) ────

const singleCallsiteHelper: Rule = {
  id: "code-slop/single-callsite-helper",
  pack: "code-slop",
  defaultSeverity: "warn",
  enabledByDefault: false,
  rationale:
    "A named function or `const` with a body of ≤ 3 statements that is called from at most one place across the entire package is a candidate for inlining. Merging it with its sole caller reduces indirection and makes the flow easier to follow.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    if (!ctx.corpus) return [];

    const { callCountBySymbol } = ctx.corpus;

    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];

    const violations: Violation[] = [];

    walk(result.ast as unknown as AnyNode, (node) => {
      let funcName: string | null = null;
      let body: TSESTree.BlockStatement | null = null;

      // Named function declarations: `function foo() { ... }`
      if (node.type === "FunctionDeclaration") {
        const fn = node as TSESTree.FunctionDeclaration;
        if (!fn.id || !fn.body) return;
        funcName = fn.id.name;
        body = fn.body;
      }
      // `const foo = (...) => { ... }` or `const foo = function() { ... }`
      else if (node.type === "VariableDeclaration") {
        const varDecl = node as TSESTree.VariableDeclaration;
        if (varDecl.declarations.length !== 1) return;
        const d = varDecl.declarations[0];
        if (d.id.type !== "Identifier") return;
        const init = d.init;
        if (!init) return;
        if (
          (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") &&
          init.body &&
          init.body.type === "BlockStatement"
        ) {
          funcName = d.id.name;
          body = init.body;
        }
      }

      if (!funcName || !body) return;

      // Only flag helpers with a small (≤ 3 statements) body.
      if (body.body.length > 3) return;

      // Zero body is already caught by stub-body; skip to avoid duplicate noise.
      if (body.body.length === 0) return;

      // Count total call-expression occurrences across the whole package.
      const callCount = callCountBySymbol.get(funcName) ?? 0;
      if (callCount > 1) return;

      violations.push(
        makeViolation(
          singleCallsiteHelper,
          ctx.file,
          nodeLoc(node),
          `\`${funcName}\` has a ≤ 3-statement body and is called from ${
            callCount === 0 ? "nowhere in the package" : "exactly one place"
          } — consider inlining or deleting it`,
          snippet(ctx.file, node),
        ),
      );
    });

    return violations;
  },
};

export const codeSlopPack: PackDefinition = {
  id: "code-slop",
  description:
    "AST-based catches for AI-tic code: try/catch around non-throwing code, defaults on required-typed params, empty/rethrow catches, async without await, backcompat shims for unreleased APIs, imports of undeclared packages, placeholder function bodies, unused exports, single-callsite helpers.",
  rules: [
    tryCatchCannotThrow,
    defaultOnRequiredParam,
    emptyOrRethrowCatch,
    asyncWithoutAwait,
    backcompatShimUnreleased,
    phantomImport,
    stubBody,
    unusedExport,
    singleCallsiteHelper,
  ],
};

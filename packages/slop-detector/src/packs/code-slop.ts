import fs from "node:fs";
import path from "node:path";
import type { TSESTree } from "@typescript-eslint/types";
import type { FileTarget, PackDefinition, Rule, RuleContext, Violation } from "../types.js";
import { isTypeScriptOrJavaScript, parseTsFile, walk, type AnyNode, type ParsedTsFile } from "../util/ts-ast.js";

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

export const codeSlopPack: PackDefinition = {
  id: "code-slop",
  description:
    "AST-based catches for AI-tic code: try/catch around non-throwing code, defaults on required-typed params, empty/rethrow catches, async without await, backcompat shims for unreleased APIs.",
  rules: [
    tryCatchCannotThrow,
    defaultOnRequiredParam,
    emptyOrRethrowCatch,
    asyncWithoutAwait,
    backcompatShimUnreleased,
  ],
};

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

function commentLoc(comment: TSESTree.Comment): { line: number; column: number; endLine: number; endColumn: number } {
  return {
    line: comment.loc.start.line,
    column: comment.loc.start.column + 1,
    endLine: comment.loc.end.line,
    endColumn: comment.loc.end.column + 1,
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

// ─────────────────────────── Rule 1: jsdoc on trivial accessor ────────────

function isTrivialBody(body: TSESTree.BlockStatement | TSESTree.Expression | null | undefined): boolean {
  if (!body) return false;
  if (body.type !== "BlockStatement") {
    // Arrow with expression body is trivial only if the expression itself is.
    return isTrivialExpression(body);
  }
  const stmts = body.body;
  if (stmts.length === 0) return true;
  if (stmts.length !== 1) return false;
  const stmt = stmts[0];
  if (stmt.type === "ReturnStatement") {
    return !stmt.argument || isTrivialExpression(stmt.argument);
  }
  if (stmt.type === "ExpressionStatement") {
    return isTrivialExpression(stmt.expression);
  }
  return false;
}

function isTrivialExpression(expr: TSESTree.Node): boolean {
  switch (expr.type) {
    case "Identifier":
    case "Literal":
    case "ThisExpression":
      return true;
    case "MemberExpression":
      return !expr.computed && (expr.object.type === "ThisExpression" || expr.object.type === "Identifier");
    case "AssignmentExpression":
      return (
        expr.operator === "=" &&
        (expr.left.type === "Identifier" || expr.left.type === "MemberExpression") &&
        isTrivialExpression(expr.right)
      );
    case "ArrowFunctionExpression":
      return false;
    default:
      return false;
  }
}

function findPrecedingJsDoc(ast: ParsedTsFile, node: TSESTree.Node): TSESTree.Comment | null {
  const targetStart = node.range?.[0] ?? node.loc.start.line;
  const comments = ast.comments ?? [];
  let candidate: TSESTree.Comment | null = null;
  for (const c of comments) {
    const end = c.range?.[1] ?? -1;
    if (end <= (typeof targetStart === "number" ? targetStart : Number.MAX_SAFE_INTEGER)) {
      if (c.type === "Block" && c.value.startsWith("*")) {
        const linesBetween = node.loc.start.line - c.loc.end.line;
        if (linesBetween >= 0 && linesBetween <= 1) {
          candidate = c;
        } else if (linesBetween > 1) {
          candidate = null;
        }
      }
    }
  }
  return candidate;
}

const jsdocOnTrivialAccessor: Rule = {
  id: "comment-slop/jsdoc-on-trivial-accessor",
  pack: "comment-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "JSDoc that only restates the property name (`/** Get the foo. */ get foo() { return this._foo; }`) adds zero information for readers and is the most common AI-tic in generated TS/JS — drop it.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];
    const ast = result.ast;
    const violations: Violation[] = [];
    walk(ast as unknown as AnyNode, (node) => {
      let candidate: TSESTree.Node | null = null;
      let body: TSESTree.BlockStatement | TSESTree.Expression | null = null;
      if (node.type === "MethodDefinition" && (node.kind === "get" || node.kind === "set")) {
        candidate = node;
        body = node.value.body ?? null;
      } else if (node.type === "FunctionDeclaration" && node.body) {
        candidate = node;
        body = node.body;
      } else if (
        node.type === "VariableDeclaration" &&
        node.declarations.length === 1 &&
        node.declarations[0].init &&
        (node.declarations[0].init.type === "ArrowFunctionExpression" ||
          node.declarations[0].init.type === "FunctionExpression")
      ) {
        const init = node.declarations[0].init;
        candidate = node;
        body = init.body ?? null;
      }
      if (!candidate || !isTrivialBody(body)) return;
      const jsdoc = findPrecedingJsDoc(ast, candidate);
      if (!jsdoc) return;
      violations.push(
        makeViolation(
          jsdocOnTrivialAccessor,
          ctx.file,
          commentLoc(jsdoc),
          "JSDoc on a trivial getter / pass-through — the signature already documents itself",
          `/*${jsdoc.value.slice(0, 80)}*/`,
        ),
      );
    });
    return violations;
  },
};

// ─────────────────────────── Rule 2: comment restates next line ───────────

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "in", "into", "is", "it", "its", "of", "on", "or", "over", "that", "the",
  "this", "to", "was", "were", "will", "with",
]);

const SIGNIFICANT_WORD = /[a-z][a-z0-9]+/gi;

function commentTokens(text: string): string[] {
  return (text.match(SIGNIFICANT_WORD) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Map a JS/TS keyword to the natural-language concepts a "comment restating
// the next line" would typically use. Keeps the heuristic strict (every
// comment token must match) without being too literal — a `// loop over items`
// above `for (const item of items)` should match because `for` implies "loop".
const KEYWORD_SYNONYMS: Record<string, string[]> = {
  for: ["loop", "iterate", "iteration"],
  while: ["loop", "until"],
  do: ["loop"],
  if: ["check", "when", "branch"],
  else: ["otherwise"],
  return: ["return"],
  throw: ["error", "raise"],
  catch: ["error", "handle"],
  try: ["attempt"],
  function: ["function", "helper"],
  async: ["async"],
  await: ["wait"],
  new: ["create"],
  import: ["import", "load"],
  export: ["export"],
  class: ["class"],
  break: ["break", "exit"],
  continue: ["skip"],
};

const JS_KEYWORD = new Set(Object.keys(KEYWORD_SYNONYMS));

function codeIdentifiers(line: string): string[] {
  // Split camelCase/PascalCase/snake_case into pieces.
  const pieces: string[] = [];
  for (const raw of line.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    const lower = raw.toLowerCase();
    pieces.push(lower);
    for (const part of raw.split(/_|(?=[A-Z])/)) {
      if (part) pieces.push(part.toLowerCase());
    }
    if (JS_KEYWORD.has(lower)) {
      pieces.push(...KEYWORD_SYNONYMS[lower]);
    }
  }
  return pieces;
}

function nextNonBlankCodeLine(text: string, afterLine: number): string | null {
  const lines = text.split("\n");
  for (let i = afterLine; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    return lines[i];
  }
  return null;
}

const commentRestatesNextLine: Rule = {
  id: "comment-slop/comment-restates-next-line",
  pack: "comment-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "A `// loop over items` comment directly above `for (const item of items)` is pure restatement — well-named code already says it. Comments should explain *why*, not narrate *what*.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];
    const ast = result.ast;
    const violations: Violation[] = [];
    for (const comment of ast.comments ?? []) {
      if (comment.type !== "Line") continue;
      const tokens = commentTokens(comment.value);
      if (tokens.length === 0 || tokens.length > 6) continue;
      const nextLine = nextNonBlankCodeLine(ctx.file.text, comment.loc.end.line);
      if (!nextLine) continue;
      const ids = new Set(codeIdentifiers(nextLine));
      const matched = tokens.filter((t) => ids.has(t));
      if (matched.length >= tokens.length) {
        violations.push(
          makeViolation(
            commentRestatesNextLine,
            ctx.file,
            commentLoc(comment),
            "Comment restates the next line — drop it or rewrite to explain *why*",
            `//${comment.value.slice(0, 80)}`,
          ),
        );
      }
    }
    return violations;
  },
};

// ─────────────────────────── Rule 3: orphan markers ───────────────────────

const ORPHAN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /^\s*removed\s*$/i, reason: "isolated `// removed` marker — delete the line and the surrounding leftover" },
  { re: /^\s*kept\s+for\s+back(?:wards?[\s-]?)?compat(?:ibility)?\.?\s*$/i, reason: "`// kept for backcompat` orphan — if there's no caller, delete" },
  { re: /^\s*deprecated[,\s]+kept\s+for\s+back(?:wards?[\s-]?)?compat(?:ibility)?.*$/i, reason: "`// deprecated, kept for backcompat` shim marker — verify the caller exists or delete" },
  { re: /^\s*todo\s+old\s*[:.]?\s*.*$/i, reason: "`// TODO old` is a stale follow-up marker — convert to a real TODO with context or delete" },
  { re: /^\s*legacy\s*$/i, reason: "isolated `legacy` marker — delete or expand into a real comment" },
  { re: /^\s*\(\s*deprecated\s*\)\s*$/i, reason: "`(deprecated)` orphan marker — use `@deprecated` JSDoc on the symbol instead" },
];

const orphanMarkers: Rule = {
  id: "comment-slop/orphan-markers",
  pack: "comment-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "Stray `// removed`, `// kept for backcompat`, `/* legacy */` notes are leftover scratchwork from agent edits — they refer to context that was already deleted, so they confuse the reader without helping anyone.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];
    const ast = result.ast;
    const violations: Violation[] = [];
    for (const comment of ast.comments ?? []) {
      const text = comment.value;
      for (const { re, reason } of ORPHAN_PATTERNS) {
        if (re.test(text)) {
          violations.push(
            makeViolation(
              orphanMarkers,
              ctx.file,
              commentLoc(comment),
              reason,
              comment.type === "Line" ? `//${text}` : `/*${text}*/`,
            ),
          );
          break;
        }
      }
    }
    return violations;
  },
};

// ─────────────────────────── Rule 4: comment-heavier-than-body helpers ────

function countNonEmptyLines(text: string): number {
  return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).length;
}

function commentLinesIn(comment: TSESTree.Comment): number {
  if (comment.type === "Line") return 1;
  return Math.max(1, comment.loc.end.line - comment.loc.start.line + 1);
}

function findFunctionBodyText(file: FileTarget, body: TSESTree.BlockStatement): string {
  if (!body.range) return "";
  return file.text.slice(body.range[0] + 1, body.range[1] - 1);
}

const commentHeavierThanBody: Rule = {
  id: "comment-slop/comment-heavier-than-body",
  pack: "comment-slop",
  defaultSeverity: "info",
  enabledByDefault: true,
  rationale:
    "If a small internal helper has more lines of leading comment than lines of code, the comment is doing the work the function should do — either inline the function or shorten the prose.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];
    const ast = result.ast;
    const violations: Violation[] = [];
    walk(ast as unknown as AnyNode, (node) => {
      let body: TSESTree.BlockStatement | null = null;
      let candidate: TSESTree.Node | null = null;
      if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && node.body) {
        body = node.body;
        candidate = node;
      } else if (node.type === "ArrowFunctionExpression" && node.body && node.body.type === "BlockStatement") {
        body = node.body;
        candidate = node;
      }
      if (!body || !candidate) return;
      const bodyLines = countNonEmptyLines(findFunctionBodyText(ctx.file, body));
      if (bodyLines === 0 || bodyLines > 8) return; // only flag small helpers
      const jsdoc = findPrecedingJsDoc(ast, candidate);
      if (!jsdoc) return;
      const docLines = commentLinesIn(jsdoc);
      if (docLines >= 4 && docLines > bodyLines) {
        violations.push(
          makeViolation(
            commentHeavierThanBody,
            ctx.file,
            commentLoc(jsdoc),
            `Leading comment is ${docLines} lines for a ${bodyLines}-line helper — shorten or delete`,
            `/*${jsdoc.value.slice(0, 80)}*/`,
          ),
        );
      }
    });
    return violations;
  },
};

// ─────────────────────────── Rule 5: ascii banner divider ─────────────────

const BANNER_LINE = /^[\s/*#]*[=*\-_~]{8,}[\s/*#]*$/;

const asciiBanner: Rule = {
  id: "comment-slop/ascii-banner",
  pack: "comment-slop",
  defaultSeverity: "info",
  enabledByDefault: true,
  rationale:
    "ASCII divider lines (`// =====`, `/* -------- */`) are a decorative tell from generated code; structural comments belong as named section headers if at all.",
  appliesTo: appliesToCode,
  check(ctx: RuleContext): Violation[] {
    const result = parseTsFile(ctx.file);
    if (!result.ok) return [];
    const ast = result.ast;
    const violations: Violation[] = [];
    for (const comment of ast.comments ?? []) {
      const lines = comment.value.split("\n");
      const hasBanner = lines.some((l) => BANNER_LINE.test(l));
      if (!hasBanner) continue;
      // Ignore single short bars — flag obvious decorative dividers.
      const bar = lines.find((l) => BANNER_LINE.test(l)) ?? "";
      const bareChars = bar.replace(/[\s/*#]/g, "");
      if (bareChars.length < 8) continue;
      violations.push(
        makeViolation(
          asciiBanner,
          ctx.file,
          commentLoc(comment),
          "ASCII banner / divider comment — drop the decoration; section headers belong in named symbols",
          comment.type === "Line" ? `//${bar}` : `/*${bar}*/`,
        ),
      );
    }
    return violations;
  },
};

void nodeLoc; // re-exported helper, intentionally retained for future rules

export const commentSlopPack: PackDefinition = {
  id: "comment-slop",
  description:
    "AST-based catches for AI-tic comments: trivial-getter JSDoc, comments that restate the next line, orphan markers, comment-heavier-than-body helpers, ASCII banner dividers.",
  rules: [
    jsdocOnTrivialAccessor,
    commentRestatesNextLine,
    orphanMarkers,
    commentHeavierThanBody,
    asciiBanner,
  ],
};

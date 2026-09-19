import path from "node:path";
import type { TSESTree } from "@typescript-eslint/types";
import type {
  FileTarget,
  PackDefinition,
  ResolvedConfig,
  Rule,
  RuleContext,
  Violation,
} from "../types.js";
import { DEFAULT_REVIEW_ALLOW_PATHS } from "../config.js";
import { globToRegex } from "../util/file-kind.js";
import {
  findAllRegex,
  offsetToLineCol,
  stripFencedCode,
  stripInlineCode,
} from "../util/text.js";
import {
  isTypeScriptOrJavaScript,
  parseTsFile,
  walk,
  type AnyNode,
} from "../util/ts-ast.js";

// ─────────────────────────── file targeting ───────────────────────────

const MARKDOWN_EXT = new Set([".md", ".mdx", ".markdown"]);

function isMarkdownFile(file: FileTarget): boolean {
  const ext = path.extname(file.path).toLowerCase();
  return MARKDOWN_EXT.has(ext);
}

// A commit message either arrives as `check --stdin-path COMMIT_MSG` (the
// documented commit-message-mode invocation, see README "review-slop by
// example") or as a real git hook file (`.git/COMMIT_EDITMSG`, or a
// caller's own `<name>.commitmsg` convention). Matched on the basename so
// a directory prefix (`.git/COMMIT_EDITMSG`, `tmp/msg.commitmsg`) doesn't
// matter.
function isCommitMessageFile(file: FileTarget): boolean {
  const base = path.basename(file.path);
  return (
    base === "COMMIT_MSG" ||
    base.endsWith("COMMIT_EDITMSG") ||
    base.toLowerCase().endsWith(".commitmsg")
  );
}

function appliesToReviewSurface(file: FileTarget): boolean {
  return (
    isMarkdownFile(file) ||
    isCommitMessageFile(file) ||
    isTypeScriptOrJavaScript(file)
  );
}

/**
 * `filePath` relativized to `scanRoot` and forward-slash normalized --
 * same helper as `placement-slop.ts`'s `relativizeToScanRoot`, duplicated
 * locally rather than imported since it isn't exported there (every pack
 * in this codebase carries its own small file-targeting helpers, see
 * `workflow-slop.ts`/`comment-slop.ts`).
 */
function relativizeToScanRoot(filePath: string, scanRoot: string): string {
  const rel = path.relative(scanRoot, path.resolve(filePath));
  return rel.split(path.sep).join("/");
}

function isAllowedPath(ctx: RuleContext): boolean {
  const { file, config, scanRoot } = ctx;
  // Fallback mirrors `defaultConfig()`'s own default (imported from
  // config.ts, not a second hand-typed literal) for a hand-built
  // `ResolvedConfig` that omits `review` entirely.
  const allowPaths = config.review?.allowPaths ?? DEFAULT_REVIEW_ALLOW_PATHS;
  if (allowPaths.length === 0) return false;
  const rel = relativizeToScanRoot(file.path, scanRoot ?? process.cwd());
  return allowPaths.some((g) => globToRegex(g).test(rel));
}

// ─────────────────────────── shared match plumbing ───────────────────

interface Match {
  index: number;
  match: string;
}

function makeViolation(
  rule: Rule,
  file: FileTarget,
  match: Match,
  message: string,
): Violation {
  const start = offsetToLineCol(file.text, match.index);
  const end = offsetToLineCol(file.text, match.index + match.match.length);
  return {
    ruleId: rule.id,
    pack: rule.pack,
    severity: rule.defaultSeverity,
    path: file.path,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    message,
    rationale: rule.rationale,
    matched: match.match,
  };
}

/**
 * Spans of `text` matched by any `config.review.allow` pattern (same
 * semantics as `placement.allow`). Scanned over the whole text in one
 * pass, not line-by-line: a violation regex here can span a line break
 * (`ROUND_WORD`'s `\s+` matches a newline), so an allow pattern excusing
 * it must be able to as well, or a wrapped match could never be excused
 * at all. A caller that wants a per-line-only allow pattern can still write
 * one (e.g. anchored with `^`/`$` against `re`'s `m` flag) -- this just
 * stops the engine itself from forcing that restriction.
 */
function computeReviewAllowedSpans(
  text: string,
  config: ResolvedConfig,
): Array<{ start: number; end: number }> {
  const patterns = config.review?.allow ?? [];
  if (patterns.length === 0) return [];
  const spans: Array<{ start: number; end: number }> = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern, "g");
    for (const m of findAllRegex(text, re)) {
      spans.push({ start: m.index, end: m.index + m.match.length });
    }
  }
  return spans;
}

function insideAnySpan(
  offset: number,
  matchLength: number,
  spans: Array<{ start: number; end: number }>,
): boolean {
  return spans.some(
    (span) => offset >= span.start && offset + matchLength <= span.end,
  );
}

function isAllowedByReviewAllow(text: string, config: ResolvedConfig): boolean {
  const patterns = config.review?.allow ?? [];
  return patterns.some((p) => new RegExp(p).test(text));
}

/**
 * Per-match context filter: given the local text a regex was matched
 * against (the stripped prose text, a comment's value, or a test title's
 * string-literal value) and the match's `[start, end)` span within that
 * same local text, decide whether the match should still count. Used by
 * `round-reference` to require a review-context word in the same sentence
 * (as `sentenceWindow` below bounds one) for both of its patterns, and by
 * `finding-id` for its severity-letter alternative only -- the plain `F`
 * form stays ungated. `handoff-phrase` passes no filter and keeps every
 * match.
 */
type MatchFilter = (text: string, start: number, end: number) => boolean;

/** Every match of `re` in the prose/commit-message surface: fenced and inline code stripped, `review.allow` spans excused. */
function scanProseSurface(
  file: FileTarget,
  config: ResolvedConfig,
  re: RegExp,
  filter?: MatchFilter,
): Match[] {
  const text = stripInlineCode(stripFencedCode(file.text));
  const allowedSpans = computeReviewAllowedSpans(text, config);
  const matches: Match[] = [];
  for (const m of findAllRegex(text, re)) {
    if (insideAnySpan(m.index, m.match.length, allowedSpans)) continue;
    if (filter && !filter(text, m.index, m.index + m.match.length)) continue;
    matches.push({ index: m.index, match: m.match });
  }
  return matches;
}

/** Every match of `re` inside a TS/JS file's line/block comments, offset back to absolute file position. */
function scanComments(
  file: FileTarget,
  config: ResolvedConfig,
  re: RegExp,
  filter?: MatchFilter,
): Match[] {
  const result = parseTsFile(file);
  if (!result.ok) return [];
  const matches: Match[] = [];
  for (const comment of result.ast.comments ?? []) {
    if (isAllowedByReviewAllow(comment.value, config)) continue;
    const base = comment.range ? comment.range[0] + 2 : 0; // skip "//" or "/*"
    for (const m of findAllRegex(comment.value, re)) {
      if (filter && !filter(comment.value, m.index, m.index + m.match.length))
        continue;
      matches.push({ index: base + m.index, match: m.match });
    }
  }
  return matches;
}

const TEST_CALL_NAMES = new Set(["it", "test", "describe"]);
// The modifier properties the three entry points chain in vitest and jest:
// `.only`, `.skip`, `.each`, plus vitest's `.concurrent` and `.for`.
const TEST_MEMBER_NAMES = new Set([
  "only",
  "skip",
  "each",
  "concurrent",
  "for",
]);
// `it.only.each` / `test.concurrent.each` is as deep as those APIs
// compose; a longer chain is not a test entry point this pack recognizes.
const MAX_TEST_MEMBER_DEPTH = 2;

/**
 * True for a callee naming a test entry point: a bare `it`/`test`/
 * `describe` identifier, or that identifier followed by up to
 * `MAX_TEST_MEMBER_DEPTH` non-computed modifier properties from
 * `TEST_MEMBER_NAMES` (`describe.skip`, `it.each`, `it.only.each`,
 * `test.concurrent.each`).
 */
function isTestTitleCallee(callee: TSESTree.Node): boolean {
  let node: TSESTree.Node = callee;
  let depth = 0;
  while (node.type === "MemberExpression") {
    if (node.computed || node.property.type !== "Identifier") return false;
    if (!TEST_MEMBER_NAMES.has(node.property.name)) return false;
    depth++;
    if (depth > MAX_TEST_MEMBER_DEPTH) return false;
    node = node.object;
  }
  return node.type === "Identifier" && TEST_CALL_NAMES.has(node.name);
}

function isTestTitleCall(node: TSESTree.CallExpression): boolean {
  return isTestTitleCallee(node.callee);
}

/**
 * True for a CURRIED test-title call: one whose callee is itself the thing
 * that produced the title-taking function, so the title sits in the OUTER
 * call's first argument rather than in the callee's own. Two shapes, both
 * `.each` tables:
 *
 * - `it.each(table)("title", fn)` -- the callee is a `CallExpression`
 *   (`it.each(table)`).
 * - ``it.each`table`("title", fn)`` -- the callee is a
 *   `TaggedTemplateExpression` whose tag is `it.each`.
 *
 * One level up from the ordinary `isTestTitleCall` shapes above, which
 * carry the title in their own first argument.
 */
function isCurriedEachTitleCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;
  if (callee.type === "CallExpression") return isTestTitleCall(callee);
  if (callee.type === "TaggedTemplateExpression") {
    return isTestTitleCallee(callee.tag);
  }
  return false;
}

/** Every match of `re` inside the first string-literal argument of an `it`/`test`/`describe` call (including a chained `.only`/`.skip`/`.each`/`.concurrent`/`.for`, and the curried ``it.each(table)("title", fn)`` / ``it.each`table`("title", fn)`` forms). */
function scanTestTitles(
  file: FileTarget,
  config: ResolvedConfig,
  re: RegExp,
  filter?: MatchFilter,
): Match[] {
  const result = parseTsFile(file);
  if (!result.ok) return [];
  const matches: Match[] = [];
  walk(result.ast as unknown as AnyNode, (node) => {
    if (node.type !== "CallExpression") return;
    const call = node as unknown as TSESTree.CallExpression;
    if (!isTestTitleCall(call) && !isCurriedEachTitleCall(call)) return;
    const arg = call.arguments[0];
    if (!arg || arg.type !== "Literal" || typeof arg.value !== "string") {
      return;
    }
    if (isAllowedByReviewAllow(arg.value, config)) return;
    if (!arg.range) return;
    const base = arg.range[0] + 1; // skip the opening quote
    for (const m of findAllRegex(arg.value, re)) {
      if (filter && !filter(arg.value, m.index, m.index + m.match.length))
        continue;
      matches.push({ index: base + m.index, match: m.match });
    }
  });
  return matches;
}

interface RegexRule {
  re: RegExp;
  filter?: MatchFilter;
}

function checkReviewTokenRule(
  rule: Rule,
  ctx: RuleContext,
  regexRules: RegexRule[],
  describe: (matched: string) => string,
): Violation[] {
  const { file, config } = ctx;
  if (isAllowedPath(ctx)) return [];
  const matches: Match[] = [];
  if (isMarkdownFile(file) || isCommitMessageFile(file)) {
    for (const { re, filter } of regexRules)
      matches.push(...scanProseSurface(file, config, re, filter));
  }
  if (isTypeScriptOrJavaScript(file)) {
    for (const { re, filter } of regexRules) {
      matches.push(...scanComments(file, config, re, filter));
      matches.push(...scanTestTitles(file, config, re, filter));
    }
  }
  matches.sort((a, b) => a.index - b.index);
  return matches.map((m) => makeViolation(rule, file, m, describe(m.match)));
}

// ─────────────────────────── Rule 1: finding-id ───────────────────────

// Run-local review-finding shorthand: an uppercase letter F immediately
// followed by exactly one digit and an optional lowercase letter (see the
// rationale string below for concrete examples), and either half of a
// slash-joined pair of two such tokens. Single digit only -- a review
// round realistically never mints a double-digit finding count, so
// `F16`/`F22`/`F12` (a function-key range, an F1-car number, ...) no
// longer match, and capital F only (a lower-case leading letter
// reads as an unrelated token, e.g. an aperture value), so a version
// number or an 8-char hex tracker id (a workspace's own convention) never
// match: neither starts with a literal capital F immediately followed by
// a digit. The trailing negative lookahead excludes a token immediately
// followed by a hyphen and a digit (`F1-2026`), the shape of a version or
// a date rather than a finding id. A single ordinary word like `F1`
// itself (a Formula 1 reference, a function key) is not otherwise
// disambiguated from a genuine finding id: that residual imprecision is
// accepted rather than guessed at with a hand-picked word list, since
// this pack does not do LLM-judged disambiguation (see the package
// README's review-slop section for the same note).
const FINDING_ID = /\bF\d[a-z]?\b(?!-\d)/g;

// The same run-local shorthand, extended to four severity-letter forms
// this workspace's own review reports also use for a finding id: an
// uppercase H, M, L, or C (high, medium, low, critical) followed by
// exactly one digit and an optional lowercase letter, with the same
// trailing negative lookahead as the F form above (so `M1-2026` does
// not match either). Left ungated, this shape would swallow far more
// ordinary vocabulary than the capital F does: `H1`-`H6` are HTML and
// Markdown heading levels, `M1`-`M3` are Apple chip generations (and
// economists' money-supply measures), `L1`/`L2` are cache or network
// layers, and `C1`-`C4` range from a hazmat class to a vitamin name.
// So, unlike the F form, a severity-letter match only counts when the
// same sentence window (see `sentenceWindow` and `hasReviewContext`
// further down this file) also carries a review-process word --
// `FINDING_ID_CONTEXT` below names the set.
//
// This is a coarse gate, not disambiguation: a sentence naming one of
// the four letters above clears purely because no review-process word
// shares its sentence window, not because the pack understood the
// sentence was about a chip or a cache. A genuine bug-fix sentence
// that happens to name one of these letters is therefore a known,
// accepted false positive -- see the package README's review-slop
// section and this package's own test suite for a pinned example --
// and `config.review.allow` (or `allowPaths`) is the escape hatch for
// it, not a smarter filter.
const SEVERITY_FINDING_ID = /\b[HMLC]\d[a-z]?\b(?!-\d)/g;

// Both `round \d+` and the bare `R\d+` token read ordinary prose as a
// false positive in isolation (`## Round 2` heading, `round 2 of the DNS
// retry`, a Cloudflare `R2` bucket, `DeepSeek-R1`, `see pin R3`). Rather
// than guess from the token's shape alone, each match is only kept when
// the same sentence also carries a review-process word -- one sentence,
// bounded by `.`, `!`, `?`, a blank line, a heading, or a list item (see
// `sentenceWindow` below). `round`/`rounds` counts as context for a bare
// `R\d+` token (a nearby "round" is real evidence, e.g. "over several
// rounds we settled on R3"), but deliberately NOT for `round \d+` itself
// -- the matched phrase always contains the word "round", so including it
// in its own context set would make the filter a no-op.
const REVIEW_CONTEXT_WORD = "review(?:e[dr]|s|ing)?";
const ROUND_WORD_CONTEXT = new RegExp(
  `\\b(${REVIEW_CONTEXT_WORD}|fix(?:e[ds]|ing)?|finding[s]?)\\b`,
  "i",
);
const ROUND_TOKEN_CONTEXT = new RegExp(
  `\\b(${REVIEW_CONTEXT_WORD}|round[s]?|fix(?:e[ds]|ing)?|finding[s]?)\\b`,
  "i",
);

// The review-process word set gating `SEVERITY_FINDING_ID` above is the
// bare round token's set, by alias rather than by a second literal: a
// bare severity-letter id is exactly as ambiguous as a bare `RN` round
// token and deserves the same context words, `round`/`rounds` included,
// and one source cannot drift from the other when the vocabulary is
// extended.
const FINDING_ID_CONTEXT = ROUND_TOKEN_CONTEXT;

const findingId: Rule = {
  id: "review-slop/finding-id",
  pack: "review-slop",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    "A finding id (`F1`, `F2a`, or a severity-letter id like `M1`/`H2a` when the same sentence also carries a review-process word such as `reviewed`, `reviews`, or `reviewing`) only resolves against the one review round it was minted in. Baked into a test title, a source comment, a commit message, or a doc, it reads as a precise reference but is opaque and dead the moment that round is over. The severity-letter gate is coarse (it clears only on the absence of a review-process word, not on the sentence's topic), so a genuine bug-fix sentence naming a chip or cache id is an accepted false positive; `review.allow` or `review.allowPaths` is the escape hatch.",
  appliesTo: appliesToReviewSurface,
  check(ctx: RuleContext): Violation[] {
    return checkReviewTokenRule(
      findingId,
      ctx,
      [
        { re: FINDING_ID },
        {
          re: SEVERITY_FINDING_ID,
          filter: hasReviewContext(FINDING_ID_CONTEXT),
        },
      ],
      (matched) =>
        `Run-local finding id \`${matched}\`: only resolvable against the review round it was minted in.`,
    );
  },
};

// ─────────────────────────── Rule 2: round-reference ──────────────────

// Case-insensitive: the review cycle's own name followed directly by
// whitespace and a digit (see the rationale string further down for
// concrete examples). Requires a digit, so a bare, digitless `review
// round` (the kit's own name for its own review-round mechanism, e.g.
// `assets/agents/reviewer.md`'s "review round" prose) is never run-local
// evidence by itself, only a specific numbered round is, so the
// digitless form is not matched at all, at any severity. Whitespace
// (not a hyphen) between the word and the digit, so `round-2` (a
// hyphenated cross-reference some of this repo's own source comments
// use) does not match either, and a function call ending in the same
// word applied to an argument, or the bare plural noun form, never
// match: neither puts a digit immediately after the whitespace-
// terminated word.
const ROUND_WORD = /\bround\s+\d+\b/gi;
// Case-sensitive: a bare round-reference token, an uppercase R followed
// by one or two digits. Excludes a resistor-label token inside a fenced
// markdown code block via `stripFencedCode` in `scanProseSurface`, same
// carve-out as `finding-id` gets for a key name in a code block.
const ROUND_TOKEN = /\bR\d{1,2}\b/g;

// An ATX heading line and a list-item line, both allowing CommonMark's
// up-to-three leading spaces of indentation. Used as structural sentence
// boundaries below, not to parse Markdown.
const HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/;
const LIST_ITEM_LINE = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t])/;

function lineStart(text: string, i: number): number {
  return text.lastIndexOf("\n", i) + 1;
}

function lineEnd(text: string, i: number): number {
  const nl = text.indexOf("\n", i);
  return nl === -1 ? text.length : nl;
}

/**
 * True when the `\n` at `text[i]` ends the sentence window, i.e. when it
 * is structural rather than a soft wrap:
 *
 * - it is part of a blank line (a real paragraph break),
 * - it terminates a Markdown heading line, or
 * - the line after it starts a heading or a list item.
 *
 * A plain soft-wrap newline inside one paragraph (or inside one list
 * item's own wrapped body) is NOT a boundary: every prose file in this
 * repo wraps around 72-80 columns, and treating each line break as a
 * boundary collapsed the window to whatever fragment happened to share a
 * physical line with the match, wrongly missing a context word one
 * wrapped line away (found via this pack's own dogfood run over
 * `docs/okf/log.md`, itself a hand-wrapped Markdown file). The heading
 * and list-item cases close the other direction: a heading's own words
 * ("## Review rounds") and a preceding list item's words are not part of
 * the following bullet's sentence, and without them a period-less bullet
 * list under such a heading inherited its context words two lines up.
 */
function isWindowBoundaryNewline(text: string, i: number): boolean {
  if (text[i] !== "\n") return false;
  if (text[i - 1] === "\n" || text[i + 1] === "\n") return true;
  if (i > 0 && HEADING_LINE.test(text.slice(lineStart(text, i - 1), i))) {
    return true;
  }
  const nextLine = text.slice(i + 1, lineEnd(text, i + 1));
  return HEADING_LINE.test(nextLine) || LIST_ITEM_LINE.test(nextLine);
}

/**
 * The substring of `text` around `[start, end)` bounded by the nearest
 * sentence boundary on each side, exclusive of the boundary itself: a
 * `.`, `!` or `?`, or a structural newline (a blank line, a heading line,
 * or the start of a list item -- see `isWindowBoundaryNewline`). This is
 * the one sentence a context word is looked up in.
 */
function sentenceWindow(text: string, start: number, end: number): string {
  let begin = start;
  while (begin > 0) {
    const ch = text[begin - 1];
    if (ch === "." || ch === "!" || ch === "?") break;
    if (isWindowBoundaryNewline(text, begin - 1)) break;
    begin--;
  }
  let stop = end;
  while (stop < text.length) {
    const ch = text[stop];
    if (ch === "." || ch === "!" || ch === "?") break;
    if (isWindowBoundaryNewline(text, stop)) break;
    stop++;
  }
  return text.slice(begin, stop);
}

function hasReviewContext(contextRe: RegExp): MatchFilter {
  return (text, start, end) => contextRe.test(sentenceWindow(text, start, end));
}

const roundReference: Rule = {
  id: "review-slop/round-reference",
  pack: "review-slop",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    "A review-round reference (`round 2`, `R3`, `review round 1 fixes`) only makes sense inside the run that produced it. Baked into a test title, a source comment, a commit message, or a doc, it is stale the moment the next round starts. Only flagged when the same sentence -- bounded by `.`, `!`, `?`, a blank line, a heading, or a list item -- also carries a review-process word (`review`, `reviewed`, `reviews`, `reviewing`, `finding`, `fix`, or -- for the bare `R3` shorthand -- `round` itself), so an unrelated `round 2 of the DNS retry` or a Cloudflare `R2` bucket is left alone.",
  appliesTo: appliesToReviewSurface,
  check(ctx: RuleContext): Violation[] {
    return checkReviewTokenRule(
      roundReference,
      ctx,
      [
        { re: ROUND_WORD, filter: hasReviewContext(ROUND_WORD_CONTEXT) },
        { re: ROUND_TOKEN, filter: hasReviewContext(ROUND_TOKEN_CONTEXT) },
      ],
      (matched) =>
        `Run-local round reference \`${matched}\`: only resolvable against the review run it was minted in.`,
    );
  },
};

// ─────────────────────────── Rule 3: handoff-phrase ────────────────────

// The preposition-plus-article opener, then a bare workspace name, then
// the plural (or singular) noun for a set of workspace handoff notes --
// see the pattern itself below, and the rationale string further down
// for a concrete example. Points at a run-local operating layer
// (workspace conventions, machine paths, org governance) rather than the
// package's own reusable content.
const HANDOFF_PHRASE = /\bper\s+the\s+[a-z][\w-]*\s+handoffs?\b/gi;

const handoffPhrase: Rule = {
  id: "review-slop/handoff-phrase",
  pack: "review-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "A workspace-handoff phrase (`per the <workspace> handoffs`, e.g. `per the pandora handoffs`) points a reader at a run-local operating layer -- a workspace's own conventions, paths, or governance -- that a package shipped to other repos or orgs has no access to.",
  appliesTo: appliesToReviewSurface,
  check(ctx: RuleContext): Violation[] {
    return checkReviewTokenRule(
      handoffPhrase,
      ctx,
      [{ re: HANDOFF_PHRASE }],
      (matched) =>
        `Workspace-handoff phrase \`${matched}\`: points at a run-local operating layer, not this package's own content.`,
    );
  },
};

// ─────────────────────────── pack export ───────────────────────────

export const reviewSlopPack: PackDefinition = {
  id: "review-slop",
  description:
    "Run-local review tokens leaking into reusable content: finding ids (`F1`, `F2a`, or a severity-letter id like `M1`/`H2a` when the same sentence also carries a review-process word), round references (`round 2`, `R3`, `review round 1 fixes`), and workspace-handoff phrases (`per the <workspace> handoffs`). Scans Markdown, TS/JS source comments, test titles, and a commit-message file. Off by default; opt in via `--pack review-slop` or `packs.review-slop: true`.",
  rules: [findingId, roundReference, handoffPhrase],
};

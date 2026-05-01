import type { FileTarget, PackDefinition, Rule, Violation } from "../types.js";
import { findAllRegex, offsetToLineCol, stripFencedCode, stripInlineCode } from "../util/text.js";

const EM_DASH = /—/g;
const HEDGING_OPENER =
  /(^|[\n.!?]\s+)(It is important to note(?: that)?|It('|')s worth noting(?: that)?|Furthermore|Moreover|In conclusion|In summary|Notably|Additionally|That being said|It should be noted)\b/gim;
const MARKETING_ADJECTIVES =
  /\b(seamless(?:ly)?|robust|powerful|cutting-?edge|state-of-the-art|world-?class|enterprise-?grade|blazing\s?fast|next-?gen(?:eration)?|game-?changing|revolutionary|industry-?leading|best-in-class)\b/gi;
const DELVE_TAPESTRY =
  /\b(delve(?:s|d|ing)?\s+(?:into|deeper)|tapestry\s+of|in\s+the\s+realm\s+of|navigate\s+the\s+complexities|underscore(?:s|d)?\s+the\s+importance|leverag(?:e|es|ing)\s+the\s+power\s+of)\b/gi;
const TRIPLE_ADJECTIVE =
  /\b(\w+),\s+(\w+),\s+and\s+(\w+)\b/gi;
const REDUNDANT_TRAILING_NOTE =
  /(^|\n)\s*(Note:|Please note(?:\s+that)?|Important:)\s*[^\n]+/gim;
const TLDR_AT_END = /(^|\n)#{0,4}\s*(TL;DR|TLDR|Summary)\s*:?\s*\n[\s\S]+$/i;

function makeViolation(
  rule: Rule,
  file: FileTarget,
  match: { index: number; match: string },
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

function appliesToProse(file: FileTarget): boolean {
  return file.kind === "prose";
}

function proseText(file: FileTarget): string {
  return stripInlineCode(stripFencedCode(file.text));
}

const emDashInProse: Rule = {
  id: "prose-slop/em-dash",
  pack: "prose-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "Em-dashes (`—`) in user-facing prose are a recognisable AI-generation tell. The user prefers commas / colons / parentheses across LanNguyenSi repos.",
  appliesTo: appliesToProse,
  check({ file }) {
    return findAllRegex(proseText(file), EM_DASH).map((m) =>
      makeViolation(emDashInProse, file, m, "Em-dash in prose — replace with comma, colon, or parentheses"),
    );
  },
};

const hedgingOpener: Rule = {
  id: "prose-slop/hedging-opener",
  pack: "prose-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "Sentence openers like `It is important to note`, `Furthermore`, `In conclusion` are filler that an agent leans on. Cut them or restructure the sentence.",
  appliesTo: appliesToProse,
  check({ file }) {
    return findAllRegex(proseText(file), HEDGING_OPENER).map((m) =>
      makeViolation(hedgingOpener, file, { index: m.index + (m.groups[1]?.length ?? 0), match: m.groups[2] }, `Hedging opener \`${m.groups[2]}\` — drop it or rewrite the sentence`),
    );
  },
};

const marketingAdjectives: Rule = {
  id: "prose-slop/marketing-adjectives",
  pack: "prose-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "Adjectives like `seamless`, `robust`, `powerful`, `cutting-edge` carry no information. They mark prose as AI-generated marketing fluff rather than honest description.",
  appliesTo: appliesToProse,
  check({ file }) {
    return findAllRegex(proseText(file), MARKETING_ADJECTIVES).map((m) =>
      makeViolation(marketingAdjectives, file, m, `Empty marketing adjective \`${m.match}\` — describe what it actually does instead`),
    );
  },
};

const delveTapestry: Rule = {
  id: "prose-slop/delve-tapestry",
  pack: "prose-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "Phrases like `delve into`, `tapestry of`, `in the realm of`, `navigate the complexities`, `underscore the importance`, `leverage the power of` are signature LLM idioms.",
  appliesTo: appliesToProse,
  check({ file }) {
    return findAllRegex(proseText(file), DELVE_TAPESTRY).map((m) =>
      makeViolation(delveTapestry, file, m, `LLM idiom \`${m.match}\` — rewrite plainly`),
    );
  },
};

const redundantTrailingNote: Rule = {
  id: "prose-slop/redundant-note",
  pack: "prose-slop",
  defaultSeverity: "info",
  enabledByDefault: false,
  rationale:
    "`Note:` / `Please note that` / `Important:` lines are often redundant; if it matters, fold the content into the surrounding paragraph. Off by default — too noisy on legitimate callouts.",
  appliesTo: appliesToProse,
  check({ file }) {
    return findAllRegex(proseText(file), REDUNDANT_TRAILING_NOTE).map((m) =>
      makeViolation(redundantTrailingNote, file, m, "Redundant `Note:` / `Important:` aside — consider folding into surrounding text"),
    );
  },
};

const tldrAtEnd: Rule = {
  id: "prose-slop/tldr-at-end",
  pack: "prose-slop",
  defaultSeverity: "info",
  enabledByDefault: false,
  rationale:
    "A `TL;DR` or `Summary` block at the *end* of a doc is the second summary (intro plus end) — pick one. Off by default; bias toward false-positive on legitimate retrospective summaries.",
  appliesTo: appliesToProse,
  check({ file }) {
    const text = proseText(file);
    const m = TLDR_AT_END.exec(text);
    if (!m) return [];
    const idx = text.lastIndexOf(m[2], m.index + m[0].length);
    return [
      makeViolation(
        tldrAtEnd,
        file,
        { index: idx >= 0 ? idx : m.index, match: m[2] },
        "TL;DR / Summary at end of doc — usually a duplicate of the intro",
      ),
    ];
  },
};

const tripleAdjective: Rule = {
  id: "prose-slop/triple-adjective",
  pack: "prose-slop",
  defaultSeverity: "info",
  enabledByDefault: false,
  rationale:
    "The `X, Y, and Z` rule-of-three is a recognisable LLM rhythm when overused. Off by default — too many false positives on legitimate lists.",
  appliesTo: appliesToProse,
  check({ file }) {
    const text = proseText(file);
    const matches = findAllRegex(text, TRIPLE_ADJECTIVE);
    return matches
      .filter((m) => /^[a-z]+$/i.test(m.groups[1]) && /^[a-z]+$/i.test(m.groups[2]) && /^[a-z]+$/i.test(m.groups[3]))
      .map((m) => makeViolation(tripleAdjective, file, m, "Rule-of-three triple — vary cadence"));
  },
};

export const proseSlopPack: PackDefinition = {
  id: "prose-slop",
  description: "Catches AI-tic prose patterns: em-dashes, hedging openers, marketing adjectives, signature LLM idioms.",
  rules: [
    emDashInProse,
    hedgingOpener,
    marketingAdjectives,
    delveTapestry,
    redundantTrailingNote,
    tldrAtEnd,
    tripleAdjective,
  ],
};

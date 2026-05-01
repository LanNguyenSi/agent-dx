import type { FileTarget, PackDefinition, Rule, Violation } from "../types.js";
import { findAllRegex, offsetToLineCol, stripFencedCode, stripInlineCode } from "../util/text.js";

const STRAY_INVOKE_TAG = /<\/?(?:invoke|antml:function_calls|function_calls|antml:parameter)\b[^>]*>/g;
const STRAY_RESULT_TAG = /<\/result>/g;
const CLAUDE_CODE_FOOTER = /(?:🤖\s*Generated\s+with|Generated\s+with)\s+\[?Claude\s+Code\]?/gi;
const COAUTHORED_BY_CLAUDE = /^Co-Authored-By:\s+Claude\b.*$/gim;
const DOUBLED_SUMMARY_HEADING = /^#{1,4}\s*Summary\s*$/gim;
const PLACEHOLDER_TODO = /\b(TODO|FIXME):\s*\[?(insert|add|fill in|describe|tbd)\b[^\n]*/gi;
const ELLIPSIS_PROMISE = /\b(I'?ll|let me|let's)\s+(now\s+)?(continue|proceed|implement|add|fix|update)\s+(this|that|the [a-z]+)\.{2,}/gi;

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

function appliesEverywhere(file: FileTarget): boolean {
  return file.kind !== "binary";
}

function appliesToProse(file: FileTarget): boolean {
  return file.kind === "prose";
}

function scanText(file: FileTarget): string {
  if (file.kind === "prose") {
    return stripInlineCode(stripFencedCode(file.text));
  }
  return file.text;
}

const strayInvokeTag: Rule = {
  id: "agent-tics/stray-invoke-tag",
  pack: "agent-tics",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    "Tool-call XML wrappers (`<invoke>`, `<function_calls>`, `<parameter>`) leaking into committed text or prose is a copy-paste artefact from agent serialisation, not real content.",
  appliesTo: appliesEverywhere,
  check({ file }) {
    return findAllRegex(scanText(file), STRAY_INVOKE_TAG).map((m) =>
      makeViolation(strayInvokeTag, file, m, `Stray tool-call tag \`${m.match}\` — looks like leaked agent XML wrapping`),
    );
  },
};

const strayResultTag: Rule = {
  id: "agent-tics/stray-result-tag",
  pack: "agent-tics",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    "`</result>` appearing in committed prose or code is almost always a copy-paste artefact from MCP free-form parameter serialisation; the parameter is plain text and does not need a closing tag.",
  appliesTo: appliesEverywhere,
  check({ file }) {
    return findAllRegex(scanText(file), STRAY_RESULT_TAG).map((m) =>
      makeViolation(strayResultTag, file, m, "Stray `</result>` tag — MCP free-form params are plain strings, not XML"),
    );
  },
};

const claudeCodeFooter: Rule = {
  id: "agent-tics/claude-code-footer",
  pack: "agent-tics",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "Auto-appended `Generated with Claude Code` footers in READMEs / commit bodies / PR descriptions are noise unless your project policy explicitly wants attribution there.",
  appliesTo(file) {
    return file.kind === "prose";
  },
  check({ file }) {
    return findAllRegex(file.text, CLAUDE_CODE_FOOTER).map((m) =>
      makeViolation(claudeCodeFooter, file, m, "Auto-appended Claude Code attribution footer — remove or replace with project-specific provenance"),
    );
  },
};

const coauthoredByClaude: Rule = {
  id: "agent-tics/coauthored-by-claude",
  pack: "agent-tics",
  defaultSeverity: "info",
  enabledByDefault: false,
  rationale:
    "`Co-Authored-By: Claude` trailers are standard provenance for Claude Code commits, but some teams strip them for cleaner history. Off by default; opt in to flag.",
  appliesTo: appliesEverywhere,
  check({ file }) {
    return findAllRegex(file.text, COAUTHORED_BY_CLAUDE).map((m) =>
      makeViolation(coauthoredByClaude, file, m, "Claude Code commit trailer — strip if your project does not want agent attribution in git log"),
    );
  },
};

const doubledSummaryHeading: Rule = {
  id: "agent-tics/doubled-summary-heading",
  pack: "agent-tics",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "Two `## Summary` headings in the same PR body / README means the agent re-summarised at the bottom after already summarising at the top — pick one.",
  appliesTo: appliesToProse,
  check({ file }) {
    const matches = findAllRegex(file.text, DOUBLED_SUMMARY_HEADING);
    if (matches.length < 2) return [];
    return matches.slice(1).map((m) =>
      makeViolation(doubledSummaryHeading, file, m, "Second `Summary` heading in the same document — collapse into one"),
    );
  },
};

const placeholderTodo: Rule = {
  id: "agent-tics/placeholder-todo",
  pack: "agent-tics",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "Template-style `TODO: [insert ...]` / `TODO: describe ...` placeholders mean the agent left a fill-in-the-blank stub instead of actual content. Either resolve or delete.",
  appliesTo: appliesEverywhere,
  check({ file }) {
    return findAllRegex(file.text, PLACEHOLDER_TODO).map((m) =>
      makeViolation(placeholderTodo, file, m, "Unresolved template placeholder — replace with real content or remove"),
    );
  },
};

const ellipsisPromise: Rule = {
  id: "agent-tics/ellipsis-promise",
  pack: "agent-tics",
  defaultSeverity: "info",
  enabledByDefault: false,
  rationale:
    'Conversational "I\'ll continue..." / "Let me proceed..." sentences in committed prose are agent self-narration leaking into docs. Off by default; opt in for strict prose.',
  appliesTo: appliesToProse,
  check({ file }) {
    return findAllRegex(file.text, ELLIPSIS_PROMISE).map((m) =>
      makeViolation(ellipsisPromise, file, m, "Agent self-narration leaking into prose — drop or rewrite as a statement"),
    );
  },
};

export const agentTicsPack: PackDefinition = {
  id: "agent-tics",
  description: "Catches the visible tells of agent serialisation leaking into committed content (XML wrappers, footers, placeholders).",
  rules: [
    strayInvokeTag,
    strayResultTag,
    claudeCodeFooter,
    coauthoredByClaude,
    doubledSummaryHeading,
    placeholderTodo,
    ellipsisPromise,
  ],
};

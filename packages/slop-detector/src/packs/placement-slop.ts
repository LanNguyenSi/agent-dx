import path from "node:path";
import type {
  FileTarget,
  PackDefinition,
  ResolvedConfig,
  Rule,
  RuleContext,
  Violation,
} from "../types.js";
import { globToRegex } from "../util/file-kind.js";
import { findAllRegex, offsetToLineCol } from "../util/text.js";

// ─────────────────────────── shared helpers ───────────────────────────

// Instruction files are the reusable prompt/config surface an agent writes
// once and every future agent (and every future org, machine, and point in
// time) reads back. Org-, host-, and moment-bound evidence baked into that
// surface stops being true, or stops being anyone else's business, the
// moment it leaves the run it was measured in.
const DEFAULT_INSTRUCTION_GLOBS = [
  "**/SKILL.md",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/.claude/agents/**/*.md",
  "**/.opencode/agents/**/*.md",
  "**/.claude/skills/**/*.md",
];
const DEFAULT_INSTRUCTION_REGEXES = DEFAULT_INSTRUCTION_GLOBS.map(globToRegex);

function appliesToInstructionCandidate(file: FileTarget): boolean {
  // Cheap pre-filter shared by every rule in the pack: instruction files are
  // always markdown, so anything not detected as prose can never match one
  // of the (default or configured) instruction globs. The exact glob match,
  // which needs `config.placement.instructionGlobs`, happens in each
  // rule's `check`, where `ResolvedConfig` is available.
  return file.kind === "prose";
}

function isInstructionFile(filePath: string, config: ResolvedConfig): boolean {
  const normalized = filePath.split(path.sep).join("/");
  if (DEFAULT_INSTRUCTION_REGEXES.some((re) => re.test(normalized)))
    return true;
  const extra = config.placement?.instructionGlobs ?? [];
  return extra.some((g) => globToRegex(g).test(normalized));
}

/** Line numbers (1-based) whose text matches one of `config.placement.allow`. */
function allowedLineNumbers(text: string, config: ResolvedConfig): Set<number> {
  const patterns = config.placement?.allow ?? [];
  if (patterns.length === 0) return new Set();
  const regexes = patterns.map((p) => new RegExp(p));
  const out = new Set<number>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (regexes.some((re) => re.test(lines[i]))) out.add(i + 1);
  }
  return out;
}

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

/**
 * Shared scan: only instruction files are considered, `placement.allow`
 * lines are skipped, and every remaining match of `re` (global) is turned
 * into a violation via `describe`.
 */
function scanInstructionFile(
  rule: Rule,
  ctx: RuleContext,
  re: RegExp,
  describe: (matched: string) => string,
): Violation[] {
  const { file, config } = ctx;
  if (!isInstructionFile(file.path, config)) return [];
  const allowed = allowedLineNumbers(file.text, config);
  const violations: Violation[] = [];
  for (const m of findAllRegex(file.text, re)) {
    const { line } = offsetToLineCol(file.text, m.index);
    if (allowed.has(line)) continue;
    violations.push(makeViolation(rule, file, m, describe(m.match)));
  }
  return violations;
}

// ─────────────────────────── Rule 1: home-path ───────────────────────────

const HOME_PATH = /(~\/|\$HOME\/|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/)/g;

const homePath: Rule = {
  id: "placement-slop/home-path",
  pack: "placement-slop",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    "A literal home/user path (`~/`, `$HOME/`, `/Users/<name>/`, `/home/<name>/`) baked into an instruction file only makes sense on the machine (and for the user) it was written on. Every other machine and every other person reading the same file gets a dead path.",
  appliesTo: appliesToInstructionCandidate,
  check(ctx: RuleContext): Violation[] {
    return scanInstructionFile(
      homePath,
      ctx,
      HOME_PATH,
      (matched) =>
        `Machine-bound home path \`${matched}\` in an instruction file: use a repo-relative path instead.`,
    );
  },
};

// ─────────────────────────── Rule 2: dated-evidence ───────────────────────────

const DATED_EVIDENCE = /\b20\d{2}-\d{2}-\d{2}\b/g;

const datedEvidence: Rule = {
  id: "placement-slop/dated-evidence",
  pack: "placement-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "An ISO date stamped into an instruction file usually marks a point-in-time measurement (an A/B result, an incident, a rollout) rather than a standing instruction. It reads as current the day it's written and as stale evidence forever after.",
  appliesTo: appliesToInstructionCandidate,
  check(ctx: RuleContext): Violation[] {
    return scanInstructionFile(
      datedEvidence,
      ctx,
      DATED_EVIDENCE,
      (matched) =>
        `Dated evidence \`${matched}\` in an instruction file: point-in-time measurements go stale, so state the durable rule instead.`,
    );
  },
};

// ─────────────────────────── Rule 3: tally-phrase ───────────────────────────

const TALLY_PHRASE =
  /\b(so far|to date|the one measured|only observed)\b|\bn\s*=\s*\d+\b|\bp\s*=\s*0\.\d+\b|\bmedian\s+\d+\s+(seconds|ms)\b/gi;

const tallyPhrase: Rule = {
  id: "placement-slop/tally-phrase",
  pack: "placement-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "Phrases like `so far`, `to date`, `n=8`, `p=0.016`, `median 320 seconds` report the outcome of one specific measurement run. That evidence belongs in a run log or a memory file, not baked into a reusable instruction as if it were a permanent property of the system.",
  appliesTo: appliesToInstructionCandidate,
  check(ctx: RuleContext): Violation[] {
    return scanInstructionFile(
      tallyPhrase,
      ctx,
      TALLY_PHRASE,
      (matched) =>
        `Tally/measurement phrase \`${matched}\` in an instruction file: cite the durable conclusion, not the one run's numbers.`,
    );
  },
};

// ─────────────────────────── Rule 4: opaque-id ───────────────────────────

const OPAQUE_ID = /\b[0-9a-f]{8}\b/g;
const URL_SPAN = /https?:\/\/\S+/g;

function insideAnyUrl(
  offset: number,
  matchLength: number,
  urlSpans: Array<{ start: number; end: number }>,
): boolean {
  return urlSpans.some(
    (span) => offset >= span.start && offset + matchLength <= span.end,
  );
}

const opaqueId: Rule = {
  id: "placement-slop/opaque-id",
  pack: "placement-slop",
  defaultSeverity: "warn",
  enabledByDefault: true,
  rationale:
    "A standalone 8-char lowercase hex id (a task id, a commit's short SHA) is only resolvable against the tracker or repo it was minted in. It reads as a precise reference but is opaque and often dead outside that one system.",
  appliesTo: appliesToInstructionCandidate,
  check(ctx: RuleContext): Violation[] {
    const { file, config } = ctx;
    if (!isInstructionFile(file.path, config)) return [];
    const allowed = allowedLineNumbers(file.text, config);
    const urlSpans = findAllRegex(file.text, URL_SPAN).map((m) => ({
      start: m.index,
      end: m.index + m.match.length,
    }));
    const violations: Violation[] = [];
    for (const m of findAllRegex(file.text, OPAQUE_ID)) {
      if (insideAnyUrl(m.index, m.match.length, urlSpans)) continue;
      const { line } = offsetToLineCol(file.text, m.index);
      if (allowed.has(line)) continue;
      violations.push(
        makeViolation(
          opaqueId,
          file,
          m,
          `Opaque id \`${m.match}\` in an instruction file: only resolvable against the tracker/repo it was minted in.`,
        ),
      );
    }
    return violations;
  },
};

// ─────────────────────────── Rule 5: org-marker ───────────────────────────

const orgMarker: Rule = {
  id: "placement-slop/org-marker",
  pack: "placement-slop",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    "`placement.markers` names this org's own handles, product names, or paths. An instruction file meant to be reusable across orgs (a shared skill, a published pack) should not carry them; each match is a leak of exactly the kind this pack exists to catch.",
  appliesTo: appliesToInstructionCandidate,
  check(ctx: RuleContext): Violation[] {
    const { file, config } = ctx;
    if (!isInstructionFile(file.path, config)) return [];
    const markers = config.placement?.markers ?? [];
    if (markers.length === 0) return [];
    const allowed = allowedLineNumbers(file.text, config);
    const violations: Violation[] = [];
    for (const pattern of markers) {
      const re = new RegExp(pattern, "g");
      for (const m of findAllRegex(file.text, re)) {
        const { line } = offsetToLineCol(file.text, m.index);
        if (allowed.has(line)) continue;
        violations.push(
          makeViolation(
            orgMarker,
            file,
            m,
            `Org-specific marker \`${m.match}\` (pattern \`${pattern}\`) in an instruction file: keep it organisation-neutral, or add a line to \`placement.allow\`.`,
          ),
        );
      }
    }
    return violations;
  },
};

// ─────────────────────────── pack export ───────────────────────────

export const placementSlopPack: PackDefinition = {
  id: "placement-slop",
  description:
    "Org-, machine-, and point-in-time-bound evidence leaking into reusable instruction files (SKILL.md, AGENTS.md, CLAUDE.md, agent/skill prompt files): home paths, dated evidence, tally phrases, opaque ids, and configured org markers. Off by default; opt in via `--pack placement-slop` or `packs.placement-slop: true`.",
  rules: [homePath, datedEvidence, tallyPhrase, opaqueId, orgMarker],
};

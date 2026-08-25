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

/**
 * `filePath` relativized to `scanRoot` and forward-slash normalized, so a
 * glob written as `packages/foo/**` matches identically whether the CLI was
 * invoked with a relative, `./`-prefixed, or absolute scan path — all three
 * resolve to the same absolute `scanRoot` and the same absolute `filePath`,
 * so `path.relative` of the two always agrees.
 */
function relativizeToScanRoot(filePath: string, scanRoot: string): string {
  const rel = path.relative(scanRoot, path.resolve(filePath));
  return rel.split(path.sep).join("/");
}

function isInstructionFile(ctx: RuleContext): boolean {
  // `scanRoot` is always populated by the engine (`checkText`/`checkFiles`/
  // `checkPath`); the `process.cwd()` fallback only matters for a
  // hand-built `RuleContext` a test or a future caller constructs directly.
  const relPath = relativizeToScanRoot(
    ctx.file.path,
    ctx.scanRoot ?? process.cwd(),
  );
  if (DEFAULT_INSTRUCTION_REGEXES.some((re) => re.test(relPath))) return true;
  const extra = ctx.config.placement?.instructionGlobs ?? [];
  return extra.some((g) => globToRegex(g).test(relPath));
}

/** Absolute offset (into `text`) each line starts at, indexed by 0-based line number. */
function lineStartOffsets(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * `text` split on `\n`, with a single trailing `\r` stripped from each line
 * (a CRLF file's lines otherwise end in `\r`, which a `$`-anchored pattern
 * never matches before). Only the line's own tail is trimmed, so an
 * absolute offset derived from `lineStartOffsets(text)` (which indexes into
 * the untouched `text`) stays correct, and a match can never extend into
 * the stripped `\r` since it was never part of the line being matched
 * against.
 */
function splitLinesForMatching(text: string): string[] {
  return text
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Spans of `text` matched by any `config.placement.allow` pattern. Matched
 * per line (like the pre-span-scoping code's `.test(line)` loop, so `^`/`$`
 * in a pattern still anchor to line boundaries, not file boundaries) rather
 * than over the whole file text (which would also let a pattern that can
 * cross a newline, e.g. `start[\s\S]*end`, excuse an arbitrary multi-line
 * region). An allow match only excuses the span it actually covers (e.g.
 * an install URL that carries an org handle), not the rest of the line it
 * sits on: a home path, a date, or a tally phrase elsewhere on that same
 * line is unrelated to what the allow pattern matched and must still be
 * checked.
 */
function computeAllowedSpans(
  text: string,
  config: ResolvedConfig,
): Array<{ start: number; end: number }> {
  const patterns = config.placement?.allow ?? [];
  if (patterns.length === 0) return [];
  const lines = splitLinesForMatching(text);
  const lineStarts = lineStartOffsets(text);
  const spans: Array<{ start: number; end: number }> = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern, "g");
    for (let i = 0; i < lines.length; i++) {
      for (const m of findAllRegex(lines[i], re)) {
        const start = lineStarts[i] + m.index;
        spans.push({ start, end: start + m.match.length });
      }
    }
  }
  return spans;
}

/**
 * Spans of `text` that home-path / dated-evidence / opaque-id must not
 * fire inside: an `http(s)://` or `www.` URL, and a markdown link target
 * (`](...)`). A path segment, a date, or a hex id that's part of a real
 * link isn't org-, machine-, or point-in-time-bound leakage — it's the
 * link doing its job.
 */
const URL_OR_WWW_SPAN = /(?:https?:\/\/|www\.)\S+/g;
const MD_LINK_TARGET_SPAN = /\]\([^)\s]*\)/g;

function computeExcludedSpans(
  text: string,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const m of findAllRegex(text, URL_OR_WWW_SPAN)) {
    spans.push({ start: m.index, end: m.index + m.match.length });
  }
  for (const m of findAllRegex(text, MD_LINK_TARGET_SPAN)) {
    spans.push({ start: m.index, end: m.index + m.match.length });
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

interface ScanOptions {
  /** Skip a match that falls inside a URL or markdown link target span. */
  skipExcludedSpans?: boolean;
  /** Skip a match for a rule-specific reason (e.g. an all-digit "opaque id"). */
  shouldSkip?: (
    match: { index: number; match: string },
    file: FileTarget,
  ) => boolean;
}

/**
 * Shared scan: only instruction files are considered, matches inside a
 * `placement.allow` span are skipped, and every remaining match of `re`
 * (global), run over the whole file text (so a phrase wrapped across a
 * line break still matches), is turned into a violation via `describe`.
 */
function scanInstructionFile(
  rule: Rule,
  ctx: RuleContext,
  re: RegExp,
  describe: (matched: string) => string,
  opts: ScanOptions = {},
): Violation[] {
  const { file, config } = ctx;
  if (!isInstructionFile(ctx)) return [];
  const allowedSpans = computeAllowedSpans(file.text, config);
  const excluded = opts.skipExcludedSpans
    ? computeExcludedSpans(file.text)
    : [];
  const violations: Violation[] = [];
  for (const m of findAllRegex(file.text, re)) {
    if (excluded.length > 0 && insideAnySpan(m.index, m.match.length, excluded))
      continue;
    if (
      allowedSpans.length > 0 &&
      insideAnySpan(m.index, m.match.length, allowedSpans)
    )
      continue;
    if (opts.shouldSkip?.(m, file)) continue;
    violations.push(makeViolation(rule, file, m, describe(m.match)));
  }
  return violations;
}

// ─────────────────────────── Rule 1: home-path ───────────────────────────

const HOME_PATH = /(~\/|\$HOME\/|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/)/g;

// `/Users/<name>/` and `/home/<user>/` written with an angle-bracket
// placeholder is already the generic form this rule wants — it isn't a
// leaked machine-bound path, it's the *documentation* of one. A real
// account name (`/home/node/app`, a container convention) still fires:
// telling those two apart in general is not a clean heuristic, so the
// placeholder form is the only carve-out (see README "by example" section).
function isPlaceholderHomePath(matched: string): boolean {
  return /^\/(?:Users|home)\/<[^>]+>\/$/.test(matched);
}

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
      {
        skipExcludedSpans: true,
        shouldSkip: (m) => isPlaceholderHomePath(m.match),
      },
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
      { skipExcludedSpans: true },
    );
  },
};

// ─────────────────────────── Rule 3: tally-phrase ───────────────────────────

// Multi-word alternatives use `\s+` rather than a literal space so a phrase
// wrapped across a line break by a formatter or an editor's soft wrap ("So\nfar")
// still matches — `scanInstructionFile` already runs `re` over the whole file
// text rather than per line, but a literal space in the source pattern still
// wouldn't cross the `\n` `so\nfar` leaves behind. The negative lookbehind on
// `to date` excludes the unrelated idiom "up to date" (a currency claim, not a
// tally phrase); it only catches a single space between "up" and "to" — an
// arbitrary run of whitespace there is not worth a variable-width lookbehind.
const TALLY_PHRASE =
  /\bso\s+far\b|(?<!up\s)\bto\s+date\b|\bthe\s+one\s+measured\b|\bonly\s+observed\b|\bn\s*=\s*\d+\b|\bp\s*=\s*0\.\d+\b|\bmedian\s+\d+\s+(seconds|ms)\b/gi;

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
      { skipExcludedSpans: true },
    );
  },
};

// ─────────────────────────── Rule 4: opaque-id ───────────────────────────

const OPAQUE_ID = /\b[0-9a-f]{8}\b/g;

// An all-digit 8-char run ("12345678", a date written without dashes) is
// never a hex id in practice; requiring at least one a-f letter cuts that
// false-positive class without needing a separate digit-run exemption.
function hasNoHexLetter(matched: string): boolean {
  return !/[a-f]/i.test(matched);
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
    return scanInstructionFile(
      opaqueId,
      ctx,
      OPAQUE_ID,
      (matched) =>
        `Opaque id \`${matched}\` in an instruction file: only resolvable against the tracker/repo it was minted in.`,
      {
        skipExcludedSpans: true,
        shouldSkip: (m, file) =>
          hasNoHexLetter(m.match) || file.text[m.index - 1] === "#",
      },
    );
  },
};

// ─────────────────────────── Rule 5: org-marker ───────────────────────────

// `placement.markers` is repo-authored config, but a pathological pattern
// (or a marker that happens to match on every line of a large file) could
// still produce an unbounded violation list; cap it per rule per file.
const MAX_MARKER_VIOLATIONS_PER_FILE = 50;

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
    if (!isInstructionFile(ctx)) return [];
    const markers = config.placement?.markers ?? [];
    if (markers.length === 0) return [];
    const allowedSpans = computeAllowedSpans(file.text, config);
    const lines = splitLinesForMatching(file.text);
    const lineStarts = lineStartOffsets(file.text);
    const violations: Violation[] = [];
    markerLoop: for (const pattern of markers) {
      // Matched per line, not over the whole file text: a pathological
      // pattern's cost is then bounded by line length rather than file
      // size.
      const re = new RegExp(pattern, "g");
      for (let i = 0; i < lines.length; i++) {
        for (const m of findAllRegex(lines[i], re)) {
          const absIndex = lineStarts[i] + m.index;
          if (
            allowedSpans.length > 0 &&
            insideAnySpan(absIndex, m.match.length, allowedSpans)
          )
            continue;
          if (violations.length >= MAX_MARKER_VIOLATIONS_PER_FILE)
            break markerLoop;
          violations.push(
            makeViolation(
              orgMarker,
              file,
              { index: absIndex, match: m.match },
              `Org-specific marker \`${m.match}\` (pattern \`${pattern}\`) in an instruction file: keep it organisation-neutral, or add a line to \`placement.allow\`.`,
            ),
          );
        }
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

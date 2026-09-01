import fs from "node:fs";
import path from "node:path";
import { getValidSources } from "../util.js";
import {
  CITATION_RE,
  computeExcludedSpans,
  computeFencedSpans,
  computeIndentedCodeSpans,
  computeParagraphStarts,
  computeTableRowSpans,
  hasParentSegment,
  paragraphStartFor,
  resolveCitation,
  type BasenameCache,
} from "./citations-resolve.js";
import type {
  BundleDoc,
  Finding,
  ProseLineReferencesOptions,
  Rule,
} from "../types.js";

const RULE_ID = "prose-line-references";

/**
 * Opt-in (`--prose-line-references`, see `src/cli.ts`) checker for a prose
 * line reference outside `citations-resolve`'s own `` `path:N` `` grammar:
 * plain English shapes like "lines 496-498" or "generate-codex-config.ts
 * lines 129-132" that name a line number but were never written as a
 * backtick-delimited citation. `citations-resolve`'s `CITATION_RE` requires
 * a literal `:` between the path and the digits, so these are structurally
 * invisible to it -- a doc can be re-verified, re-stamped, and pass `check`
 * with 0 findings while its prose line numbers are drifted, because nothing
 * ever looked at them. See harness task ad66c43f (2026-08-30/31): both
 * review rounds of that OKF sweep found wrong prose line numbers behind a
 * fresh `citations-resolve`-clean stamp, and named the missing mechanical
 * guard as the structural cause.
 *
 * Gated on `ctx.proseLineReferences` being present (see
 * `ProseLineReferencesOptions` in `src/types.ts`), mirroring
 * `citations-resolve`'s own `ctx.requireAnchors` discipline: a consumer
 * that never passes `--prose-line-references` gets byte-identical `check`
 * output to before this rule existed.
 *
 * Extraction grammar (conservative, see the README's "Prose line references
 * (opt-in, `--prose-line-references`)" section for the authoritative
 * writeup): `line N`, `lines N-M`, `lines N-M` with an en-dash/em-dash, and
 * `lines N to M` (`LINE_REF_RE`). Deliberately NOT matched:
 *   - `L N` / `L1` -- not observed in the corpus this rule was measured
 *     against (see the CHANGELOG entry), and far more ambiguous than
 *     `line N` (`L1` already means "review finding 1" in this package's own
 *     README authoring convention for `citations-resolve`'s short-form
 *     citations).
 *   - `<file>:N` outside backticks -- already matched by
 *     `citations-resolve`'s own `CITATION_RE`, which has no backtick
 *     requirement (only its heading-section form does); duplicating it here
 *     would double-report the same drift under two rule ids.
 *   - a comma-separated list of several line numbers/ranges after one
 *     `lines` keyword (e.g. "lines 178, 234, 265-268") -- only the first
 *     number/range immediately after the keyword is extracted; the rest are
 *     silently under-extracted rather than mis-parsed. Conservative
 *     under-extraction, never mis-binding, matches this rule's "never
 *     guess" posture throughout.
 *   - a second, unlabelled range chained by "vs"/"and" onto an already-
 *     extracted one (e.g. "lines 676-698 vs 564-591" only extracts
 *     676-698) -- same reasoning.
 *
 * Exemptions for the LINE REFERENCE match itself (`line N`/`lines N-M`):
 * fenced code blocks, indented code blocks, inline code spans, and
 * Markdown table rows (`computeExcludedSpans`, reused verbatim from
 * `citations-resolve`), and the char span of any real `citations-resolve`
 * full citation (`CITATION_RE`, reused verbatim) -- the latter mostly
 * matters for a citation's own quoted string anchor, e.g.
 * `` `path.md:10-20#"see line 5 above"` ``, whose anchor text could
 * otherwise itself look like a bare prose line reference. A URL with a port
 * (`host:8080`), an ISO timestamp, and a version string (`1.2.3`) need no
 * special-casing: `LINE_REF_RE` requires the literal word `line`/`lines`
 * immediately before the digits, which none of those three shapes contain.
 *
 * A DIFFERENT, narrower exclusion set applies to FILE MENTION detection:
 * fenced code, indented code, and table rows only -- deliberately NOT
 * `computeInlineCodeSpans`. A bare backtick-wrapped filename
 * (`` `src/cli.ts` ``) is the normal, encouraged way to name a file in this
 * package's own prose (see the README's authoring guidance), so excluding
 * inline code from mention detection the way `citations-resolve` excludes
 * it from short-form citation matching would make this rule unable to bind
 * against the overwhelming majority of real file mentions in a bundle.
 *
 * Binding rule (conservative, "never guess across paragraphs"): a bare line
 * reference is bound to a "file mention" -- a path-like token
 * (`FILE_MENTION_RE`, the same extension set `CITATION_RE` recognises) that
 * resolves to a real file under the bundle's repo root via
 * `resolveCitation`, reused verbatim from `citations-resolve` so file
 * resolution follows the identical rules (frontmatter `sources` match,
 * ancestor climb for a bare filename, repo-root-relative, doc-relative,
 * "last full path mentioned", repo-wide basename search) rather than a
 * second, drift-prone copy of that logic:
 *   1. the nearest file mention in the same sentence, preceding first, then
 *      following (`findSentenceStart`/`findSentenceEnd` locate the sentence
 *      boundary around the reference; see there for the "what counts as a
 *      sentence end" heuristic);
 *   2. otherwise the nearest PRECEDING file mention in the same paragraph
 *      (`computeParagraphStarts`/`paragraphStartFor`, reused verbatim);
 *   3. otherwise `unresolvable` -- never guessed, never silently bound to
 *      the wrong file.
 * A candidate file-mention token that itself fails to resolve (a stray
 * path-like word that is not a real file) or resolves ambiguously (more
 * than one real file shares its basename) is NOT skipped in favor of a
 * farther candidate: "nearest wins" is taken literally, so the outcome is
 * `unresolvable`/`ambiguous` rather than quietly falling through to a
 * second-nearest mention that was not what the prose actually named.
 *
 * Reserved citing docs (`index.md`/`log.md`, `doc.isReserved`) are skipped
 * entirely, the same carve-out `citations-resolve` already gives them: an
 * append-only narrative journal routinely narrates historical line-number
 * deltas as prose about the past, not live citations against current
 * content.
 *
 * Findings, one per extracted reference (`--prose-line-references-strict`
 * can add a second, see below): `unresolvable` and `ambiguous` are
 * `notice`-severity (real false-positive risk: "line" occurs in ordinary
 * English -- "in line with", "product line" -- with no adjacent number
 * often enough that "no file mention nearby" is weaker evidence of drift
 * than a resolved-but-wrong reference); `out-of-bounds` (covers both
 * range-exceeds-file and an inverted range) and `blank-start-line` are
 * `warning`-severity, mirroring `citations-resolve`'s own "a wrong
 * start/target is strong drift evidence" posture once a reference DOES
 * resolve to a single real file.
 *
 * Strict mode (`ProseLineReferencesOptions.strict`, `--prose-line-
 * references-strict`, ignored unless `--prose-line-references` is also
 * passed -- same "ignored unless the base flag is set" discipline
 * `--require-anchors-allow` already uses): flags EVERY extracted reference,
 * regardless of whether it also resolved cleanly, with its own
 * `warning`-severity `prose-line-reference-not-anchored` finding and a
 * fixed remedy: lift it into a backtick `path:N-M` citation (so
 * `citations-resolve` can verify it going forward), or de-precise it to a
 * symbol name. This is intentionally additive, not a replacement for the
 * base checks above: a drifted reference under strict mode gets both its
 * `out-of-bounds`/etc. finding AND the policy finding, since both facts are
 * independently true of it.
 */

// Same extension set CITATION_RE recognises -- see the "Extraction
// grammar" doc block above for why this rule does not invent a second one.
// The trailing `(?!\w)` matters here in a way it does not for CITATION_RE:
// CITATION_RE requires a literal `:` immediately after the extension
// group, which already forces the regex engine to backtrack past a
// shorter alternative that is a prefix of a longer one (`js` is a prefix
// of `json`) until the full, correct extension matches. FILE_MENTION_RE
// has nothing after the extension group to force that backtracking, so
// without this lookahead a real `foo.json` mention would silently match
// as `foo.js` (the `on` left dangling) -- `(?!\w)` rejects that truncated
// match outright, so the engine backtracks to the real extension instead.
const FILE_MENTION_RE = /[\w./-]+\.(?:ts|js|mjs|md|yml|yaml|json)(?!\w)/g;

// "line N" / "lines N-M" / "lines N-M" (en-/em-dash) / "lines N to M".
// Deliberately requires the literal keyword right before the digits -- see
// the "Extraction grammar" doc block above for every shape this leaves out
// on purpose.
const LINE_REF_RE = /\b[Ll]ines?\s+(\d+)(?:\s*(?:-|–|—|to)\s*(\d+))?\b/g;

type FileMention = {
  index: number;
  end: number;
  text: string;
};

type Problem = {
  reason: "out-of-bounds" | "blank-start-line";
  message: string;
};

function isWithinAnySpan(
  index: number,
  spans: Array<[number, number]>,
): boolean {
  return spans.some(([start, end]) => index >= start && index < end);
}

/** 1-based line number of `index` within `content`. */
function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

// Duplicated from citations-resolve's own splitLines (not exported: this
// rule needs the identical "trailing newline does not count as an extra
// blank final line" semantics so a file's line count agrees with what
// citations-resolve would report for the same file, but the function
// itself is a two-line utility not worth threading a new export for).
function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (
    lines.length > 0 &&
    lines[lines.length - 1] === "" &&
    content.endsWith("\n")
  ) {
    lines.pop();
  }
  return lines;
}

/**
 * Every `FILE_MENTION_RE` match in `content` outside `mentionExcludedSpans`
 * (fenced/indented code, table rows -- see the "Exemptions" doc block
 * above for why inline code is deliberately NOT one of these), skipping a
 * leading-`/` (out-of-scope, same as `citations-resolve`'s
 * `citedPath.startsWith("/")`) or `..`-segment (`hasParentSegment`, same as
 * `citations-resolve`'s `path-traversal-rejected`) token outright -- such a
 * token is never a candidate binding target, so it is left out of the
 * mention list entirely rather than being found nearest and then reported
 * unresolvable.
 */
function collectFileMentions(
  content: string,
  mentionExcludedSpans: Array<[number, number]>,
): FileMention[] {
  const mentions: FileMention[] = [];
  const re = new RegExp(FILE_MENTION_RE.source, FILE_MENTION_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (isWithinAnySpan(m.index, mentionExcludedSpans)) continue;
    const text = m[0];
    if (text.startsWith("/") || hasParentSegment(text)) continue;
    mentions.push({ index: m.index, end: m.index + text.length, text });
  }
  return mentions;
}

/**
 * True when `content[i]` is a sentence-ending `.`/`!`/`?` NOT inside
 * `protectedSpans` (fenced/inline code, table rows, or a real citation's
 * own span) and followed, after any run of repeated terminal punctuation,
 * by whitespace and then either the end of the content or a character that
 * plausibly starts a new sentence (uppercase letter, digit, backtick,
 * quote, or open paren/bracket). This is a heuristic, not a real sentence
 * grammar -- it exists only to scope the "same sentence" binding
 * preference (see the "Binding rule" doc block above); getting it wrong in
 * either direction degrades to the paragraph-level fallback, never to a
 * silently wrong bind, since a reference with no in-sentence mention still
 * falls through to `nearestPrecedingMentionInParagraph`. A filename's own
 * internal dot (`generate-codex-config.ts`) never needs a dedicated
 * exemption here: it is never followed by whitespace (the extension
 * letters come right after), so the "followed by whitespace" requirement
 * below already disqualifies it on its own.
 */
function isSentenceEnderAt(
  content: string,
  i: number,
  protectedSpans: Array<[number, number]>,
): boolean {
  const ch = content[i];
  if (ch !== "." && ch !== "!" && ch !== "?") return false;
  if (isWithinAnySpan(i, protectedSpans)) return false;
  let j = i + 1;
  while (content[j] === "." || content[j] === "!" || content[j] === "?") j++;
  const after = content[j];
  if (after !== undefined && !/\s/.test(after)) return false;
  let k = j;
  while (k < content.length && /\s/.test(content[k])) k++;
  const nextChar = content[k];
  if (nextChar === undefined) return true;
  return /[A-Z0-9`"'([]/.test(nextChar);
}

/** Nearest sentence-ender at or after `paragraphStart` and before `idx`, or `paragraphStart` when none exists. */
function findSentenceStart(
  content: string,
  idx: number,
  paragraphStart: number,
  protectedSpans: Array<[number, number]>,
): number {
  for (let i = idx - 1; i >= paragraphStart; i--) {
    if (isSentenceEnderAt(content, i, protectedSpans)) return i + 1;
  }
  return paragraphStart;
}

/** Nearest sentence-ender at or after `idx` and before `paragraphEnd`, or `paragraphEnd` when none exists. */
function findSentenceEnd(
  content: string,
  idx: number,
  paragraphEnd: number,
  protectedSpans: Array<[number, number]>,
): number {
  for (let i = idx; i < paragraphEnd; i++) {
    if (isSentenceEnderAt(content, i, protectedSpans)) return i + 1;
  }
  return paragraphEnd;
}

/** Offset one past the paragraph starting at `paragraphStart` (see computeParagraphStarts), or `contentLength` for the last paragraph. */
function paragraphEndFor(
  starts: number[],
  paragraphStart: number,
  contentLength: number,
): number {
  for (const s of starts) {
    if (s > paragraphStart) return s;
  }
  return contentLength;
}

/**
 * The binding target for a line reference at `idx`: the nearest file
 * mention in the same sentence (preceding first, then following), or
 * `null` when the sentence has none at all -- see the "Binding rule" doc
 * block above.
 */
function nearestMentionInSentence(
  mentions: FileMention[],
  idx: number,
  sentenceStart: number,
  sentenceEnd: number,
): FileMention | null {
  let preceding: FileMention | null = null;
  for (const mention of mentions) {
    if (mention.index >= sentenceStart && mention.end <= idx) {
      if (!preceding || mention.index > preceding.index) preceding = mention;
    }
  }
  if (preceding) return preceding;

  let following: FileMention | null = null;
  for (const mention of mentions) {
    if (mention.index >= idx && mention.end <= sentenceEnd) {
      if (!following || mention.index < following.index) following = mention;
    }
  }
  return following;
}

/** Nearest preceding file mention anywhere in the same paragraph -- the fallback once the same-sentence search finds nothing. */
function nearestPrecedingMentionInParagraph(
  mentions: FileMention[],
  idx: number,
  paragraphStart: number,
): FileMention | null {
  let best: FileMention | null = null;
  for (const mention of mentions) {
    if (mention.index >= paragraphStart && mention.end <= idx) {
      if (!best || mention.index > best.index) best = mention;
    }
  }
  return best;
}

/**
 * Base drift checks against an already-resolved single target: an
 * inverted or file-exceeding range (`out-of-bounds`) or a blank start
 * line (`blank-start-line`) -- one problem reported, `out-of-bounds`
 * checked first since a blank-line check on an out-of-range line number
 * is meaningless. Returns `null` (no `Problem`, not "unreadable") when the
 * target cannot be read at all; the caller folds that into `unresolvable`
 * (see the "Findings" doc block above: a fifth, `unreadable-target`
 * reason was deliberately not added, to keep to the four reasons this
 * rule's design settled on).
 */
function checkTarget(
  resolvedPath: string,
  startLine: number,
  endLine: number | null,
): Problem | null | "unreadable" {
  let content: string;
  try {
    content = fs.readFileSync(resolvedPath, "utf8");
  } catch {
    return "unreadable";
  }
  const lines = splitLines(content);
  const last = endLine ?? startLine;
  if (endLine !== null && endLine < startLine) {
    return {
      reason: "out-of-bounds",
      message: `range end (${endLine}) is before its start (${startLine})`,
    };
  }
  if (startLine > lines.length || last > lines.length) {
    return {
      reason: "out-of-bounds",
      message: `citation exceeds file length (${lines.length} line(s))`,
    };
  }
  const startText = (lines[startLine - 1] ?? "").trim();
  if (startText === "") {
    return { reason: "blank-start-line", message: "start line is blank" };
  }
  return null;
}

function formatRef(startLine: number, endLine: number | null): string {
  return endLine !== null
    ? `lines ${startLine}-${endLine}`
    : `line ${startLine}`;
}

function pushFinding(
  findings: Finding[],
  file: string,
  raw: string,
  docLine: number,
  reason: string,
  message: string,
  severity: "warning" | "notice",
  detail?: string,
): void {
  findings.push({
    ruleId: RULE_ID,
    severity,
    file,
    message: `\`${raw}\` (doc line ${docLine}): ${message} [${reason}]`,
    ...(detail ? { detail } : {}),
  });
}

function scanDoc(
  cache: BasenameCache,
  root: string,
  bundleDir: string,
  doc: BundleDoc,
  options: ProseLineReferencesOptions,
): Finding[] {
  if (doc.isReserved) return [];

  const findings: Finding[] = [];
  const content = doc.raw;
  const sources = getValidSources(doc.frontmatter.parsed) ?? [];
  const docAbsPath = path.join(bundleDir, doc.relPath);

  const excludedSpans = computeExcludedSpans(content);
  const citationSpans: Array<[number, number]> = [];
  const citationRe = new RegExp(CITATION_RE.source, "g");
  let cm: RegExpExecArray | null;
  while ((cm = citationRe.exec(content)) !== null) {
    citationSpans.push([cm.index, cm.index + cm[0].length]);
  }
  const protectedSpans = [...excludedSpans, ...citationSpans];

  // A narrower exclusion set for file-mention detection: fenced/indented
  // code and table rows, but NOT inline code -- see the "Exemptions" doc
  // block above.
  const mentionExcludedSpans: Array<[number, number]> = [
    ...computeFencedSpans(content),
    ...computeIndentedCodeSpans(content),
    ...computeTableRowSpans(content),
  ];
  const fileMentions = collectFileMentions(content, mentionExcludedSpans);
  const paragraphStarts = computeParagraphStarts(content);

  const re = new RegExp(LINE_REF_RE.source, LINE_REF_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (isWithinAnySpan(m.index, protectedSpans)) continue;

    const startLine = Number(m[1]);
    const endLine = m[2] !== undefined ? Number(m[2]) : null;
    const raw = formatRef(startLine, endLine);
    const docLine = lineNumberAt(content, m.index);

    const paragraphStart = paragraphStartFor(paragraphStarts, m.index);
    const paragraphEnd = paragraphEndFor(
      paragraphStarts,
      paragraphStart,
      content.length,
    );
    const sentenceStart = findSentenceStart(
      content,
      m.index,
      paragraphStart,
      protectedSpans,
    );
    const sentenceEnd = findSentenceEnd(
      content,
      m.index,
      paragraphEnd,
      protectedSpans,
    );

    const mention =
      nearestMentionInSentence(
        fileMentions,
        m.index,
        sentenceStart,
        sentenceEnd,
      ) ??
      nearestPrecedingMentionInParagraph(fileMentions, m.index, paragraphStart);

    let boundFile: string | null = null;

    if (!mention) {
      pushFinding(
        findings,
        doc.relPath,
        raw,
        docLine,
        "unresolvable",
        "no file mention could be bound to this prose line reference",
        "notice",
      );
    } else {
      const resolution = resolveCitation(
        cache,
        root,
        docAbsPath,
        content,
        sources,
        mention.text,
        mention.index,
      );
      if (!resolution || "skip" in resolution) {
        pushFinding(
          findings,
          doc.relPath,
          raw,
          docLine,
          "unresolvable",
          `nearest file mention \`${mention.text}\` does not resolve to a real file`,
          "notice",
        );
      } else if ("ambiguous" in resolution) {
        pushFinding(
          findings,
          doc.relPath,
          raw,
          docLine,
          "ambiguous",
          `file mention \`${mention.text}\` resolves to more than one file, not evaluated`,
          "notice",
          `candidates: ${resolution.candidates.join(", ")}`,
        );
      } else {
        boundFile = path.relative(root, resolution.path);
        const problem = checkTarget(resolution.path, startLine, endLine);
        if (problem === "unreadable") {
          pushFinding(
            findings,
            doc.relPath,
            raw,
            docLine,
            "unresolvable",
            `bound target \`${boundFile}\` exists but could not be read`,
            "notice",
          );
        } else if (problem) {
          pushFinding(
            findings,
            doc.relPath,
            raw,
            docLine,
            problem.reason,
            `bound to \`${boundFile}\`, ${problem.message}`,
            "warning",
            `resolvedTo: ${boundFile}`,
          );
        }
      }
    }

    if (options.strict) {
      const boundSuffix = boundFile ? ` (bound to \`${boundFile}\`)` : "";
      pushFinding(
        findings,
        doc.relPath,
        raw,
        docLine,
        "prose-line-reference-not-anchored",
        `prose line reference; lift into a backtick anchored citation or de-precise to a symbol name${boundSuffix}`,
        "warning",
      );
    }
  }

  return findings;
}

export const proseLineReferencesRule: Rule = {
  id: RULE_ID,
  description:
    "(opt-in, `--prose-line-references`) Prose-embedded line references outside citations-resolve's backtick grammar (`line N`, `lines N-M`, `lines N to M`) are bound to the nearest named file mention (same sentence, then same paragraph) and flagged when the bound reference is out of bounds, blank, or unresolvable/ambiguous. `--prose-line-references-strict` additionally flags every such reference as a formatting policy violation, resolved or not.",
  run(ctx) {
    if (!ctx.proseLineReferences) return [];
    if (!ctx.repoRoot) {
      return [
        {
          ruleId: RULE_ID,
          severity: "notice",
          file: "",
          message:
            "prose line reference resolution skipped: not inside a git work tree",
        },
      ];
    }
    const root = ctx.repoRoot;
    const cache: BasenameCache = new Map();
    return ctx.docs.flatMap((doc) =>
      scanDoc(cache, root, ctx.bundleDir, doc, ctx.proseLineReferences!),
    );
  },
};

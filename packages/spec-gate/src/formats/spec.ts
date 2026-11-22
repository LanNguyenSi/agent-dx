/**
 * `spec.md`: the readable, reviewable statement of what is to be built.
 *
 * Layout: YAML frontmatter, then `## ` sections. The grammar is line
 * based, so that a model can write it, a person can read it in a PR diff,
 * and a parser needs no Markdown engine.
 *
 * ```
 * ---
 * id: password-change-logout
 * source: source/meta.json
 * base_commit: <40 hex>
 * commands_ref: <40 hex>
 * status: draft
 * retired_ids: []
 * ---
 *
 * ## Goal
 *
 * - GOAL: One sentence stating the goal.
 *
 * ## Context
 *
 * Free prose. Nothing in it is normative; only the character rule reads it.
 *
 * ## Acceptance
 *
 * - AC-1: Observable behaviour, on one line.
 *   - source: SL-1, SL-2
 *   - owner: alice
 * ```
 *
 * Sections (`## <title>`, exact, once each, any order; every one but
 * Context may be absent, which reads as empty): Goal, Context,
 * Acceptance, Non-goals, Defaults, Decisions, Residuals, Source ledger.
 * Any other `## ` heading is an error, so no normative line can hide
 * behind an unknown heading. `###` and deeper headings are only allowed
 * inside Context.
 *
 * Context ends at the next line that starts at column 0 with `## `, and
 * at nothing else. Code fences, indented headings and setext headings do
 * not end it, and a `## ` line inside what looks like a code block does,
 * so it is then a section start or an unknown-section error. Both fail
 * closed: nothing a reader sees under a real heading is lost.
 *
 * Every line of the file is checked for forbidden characters before
 * anything else looks at it: a control character other than tab, a format
 * character, a line or paragraph separator, or a lone surrogate (Unicode
 * categories Cc, Cf, Zl, Zp, Cs; see `chars.ts`) is rejected
 * (`forbidden-character`). There is no exemption: frontmatter lines and
 * their comments, the title line, `## ` heading lines, Context lines,
 * blank-looking lines and lines below an unknown heading are checked like
 * item and attribute lines. Without that, an invisible character in front
 * of `## ` would turn a heading a reader sees into Context prose.
 *
 * Outside Context every non-blank line is either an item line
 * `- <ID>: <text>` (column 0) or an attribute line `  - <key>: <value>`
 * (two spaces) below it. One more level, `    - <key>: <value>` (four
 * spaces), exists only below `provenance`. Text is one line; spaces only,
 * no tabs.
 *
 * Per-line attributes:
 * - AC: `source` (SL IDs, comma separated), `owner` (who stands behind
 *   the requirement today; `none` means nobody does), both required.
 * - NG: `paths` (comma separated repo-relative paths or globs), optional;
 *   a line without paths describes behaviour and is checked by review only.
 * - DF: `reason` and `affects_behavior` (`true` or `false`), both required.
 * - DC: `question` (a QN ID) and a `provenance` block with `channel`
 *   (`file`, `chat` or `comment`), `author` and `time` (ISO 8601 UTC),
 *   plus optional `comment_url`.
 * - RS: `class` (`divergence`, `blind-spot` or `untestable`) and `status`
 *   (`open` or `resolved`), optional `question`.
 * - SL: the item text is `<source line ID> -> <targets>` where targets are
 *   AC, NG, DF, DC or RS IDs separated by commas, or `out`; `out` needs a
 *   `reason` attribute and is the only case that allows one.
 *
 * The parser checks grammar, per-line attributes, ID shape, ID uniqueness
 * and that no ID in `retired_ids` is live. It does not check what a lint
 * rule owns: exactly one GOAL, non-empty NG, AC coverage, ledger
 * completeness, references that point nowhere.
 */
import type { FormatError, ParseResult } from "./errors.js";
import { FORBIDDEN_WHAT, findForbiddenCharacter } from "./chars.js";
import { ErrorSink, failResult, okResult } from "./errors.js";
import { MAX_INPUT_LENGTH, parseYamlText, stripBom } from "./input.js";
import { isSourceLineId } from "./source-lines.js";
import { ANSWER_CHANNELS, OPEN_POINT_CLASSES } from "./vocab.js";
import type { AnswerChannel, OpenPointClass } from "./vocab.js";
import { isNumberedId, isSpecId, parseId } from "./ids.js";
import type { IdPrefix } from "./ids.js";
import type { Rec } from "./validate.js";
import {
  commitValue,
  describeType,
  enumValue,
  hasOwn,
  isRecord,
  isoTime,
  nonEmptyString,
  relativePath,
  rejectUnknownKeys,
  urlValue,
} from "./validate.js";

/** The only value `source` in the frontmatter may have. */
export const SPEC_SOURCE_PATH = "source/meta.json";

export const SPEC_STATUSES = ["draft", "proposed", "superseded"] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

export const RESIDUAL_STATUSES = ["open", "resolved"] as const;
export type ResidualStatus = (typeof RESIDUAL_STATUSES)[number];

/** `owner` value that records that no living person stands behind a line. */
export const OWNER_NONE = "none";

/** Target word of a source-ledger entry that maps to nothing. */
export const LEDGER_OUT = "out";

export const SPEC_SECTION_TITLES = [
  "Goal",
  "Context",
  "Acceptance",
  "Non-goals",
  "Defaults",
  "Decisions",
  "Residuals",
  "Source ledger",
] as const;
export type SpecSectionTitle = (typeof SPEC_SECTION_TITLES)[number];

const SECTION_PREFIX: Readonly<Record<SpecSectionTitle, IdPrefix | null>> = {
  Goal: "GOAL",
  Context: null,
  Acceptance: "AC",
  "Non-goals": "NG",
  Defaults: "DF",
  Decisions: "DC",
  Residuals: "RS",
  "Source ledger": "SL",
};

export interface SpecFrontmatter {
  id: string;
  source: string;
  base_commit: string;
  commands_ref: string;
  status: SpecStatus;
  superseded_by?: string;
  /** IDs that were used once and must never be used again. */
  retired_ids: string[];
}

interface LineBase {
  id: string;
  text: string;
  /** 1-based line of the item in `spec.md`. */
  line: number;
}

export type GoalLine = LineBase;

export interface AcceptanceLine extends LineBase {
  /** SL IDs. */
  source: string[];
  owner: string;
}

export interface NonGoalLine extends LineBase {
  paths: string[];
}

export interface DefaultLine extends LineBase {
  reason: string;
  affects_behavior: boolean;
}

export interface Provenance {
  channel: AnswerChannel;
  author: string;
  time: string;
  comment_url?: string;
}

export interface DecisionLine extends LineBase {
  question: string;
  provenance: Provenance;
}

export interface ResidualLine extends LineBase {
  class: OpenPointClass;
  status: ResidualStatus;
  question?: string;
}

export interface LedgerLine {
  id: string;
  line: number;
  /** The source line ID (`L<position>-<hash>`). */
  sourceLine: string;
  /** Target IDs; empty when `out`. */
  targets: string[];
  out: boolean;
  /** Present exactly when `out`. */
  reason?: string;
}

export interface Spec {
  frontmatter: SpecFrontmatter;
  goal: GoalLine | null;
  acceptance: AcceptanceLine[];
  nonGoals: NonGoalLine[];
  defaults: DefaultLine[];
  decisions: DecisionLine[];
  residuals: ResidualLine[];
  ledger: LedgerLine[];
  /** Sections that appear in the file, in file order. */
  sections: SpecSectionTitle[];
  /** Every live ID, in file order. */
  ids: string[];
}

// ---------------------------------------------------------------- frontmatter

const FRONTMATTER_KEYS = [
  "id",
  "source",
  "base_commit",
  "commands_ref",
  "status",
  "superseded_by",
  "retired_ids",
] as const;

function parseFrontmatter(
  sink: ErrorSink,
  doc: unknown,
  startLine: number,
): SpecFrontmatter | undefined {
  const before = sink.errors.length;
  if (!isRecord(doc)) {
    sink.add(
      "wrong-type",
      "frontmatter",
      `frontmatter must be a mapping, got ${describeType(doc)}`,
      startLine,
    );
    return undefined;
  }
  const rec: Rec = doc;
  rejectUnknownKeys(sink, rec, FRONTMATTER_KEYS, "frontmatter", "frontmatter");
  for (const key of ["id", "source", "base_commit", "commands_ref", "status"]) {
    if (!hasOwn(rec, key)) {
      sink.add(
        "missing-field",
        `frontmatter.${key}`,
        `frontmatter is missing required field ${key}`,
      );
    }
  }
  const out: Partial<SpecFrontmatter> = {};
  if (hasOwn(rec, "id")) {
    const v = nonEmptyString(sink, rec["id"], "frontmatter.id", "id");
    if (v !== undefined) {
      if (isSpecId(v)) out.id = v;
      else {
        sink.add(
          "invalid-value",
          "frontmatter.id",
          "id must be lower-case letters, digits and single hyphens, at most 64 characters",
        );
      }
    }
  }
  if (hasOwn(rec, "source")) {
    const v = nonEmptyString(
      sink,
      rec["source"],
      "frontmatter.source",
      "source",
    );
    if (v !== undefined) {
      if (v === SPEC_SOURCE_PATH) out.source = v;
      else {
        sink.add(
          "invalid-value",
          "frontmatter.source",
          `source must be ${SPEC_SOURCE_PATH}, got ${JSON.stringify(v)}`,
        );
      }
    }
  }
  if (hasOwn(rec, "base_commit")) {
    const v = commitValue(
      sink,
      rec["base_commit"],
      "frontmatter.base_commit",
      "base_commit",
    );
    if (v !== undefined) out.base_commit = v;
  }
  if (hasOwn(rec, "commands_ref")) {
    const v = commitValue(
      sink,
      rec["commands_ref"],
      "frontmatter.commands_ref",
      "commands_ref",
    );
    if (v !== undefined) out.commands_ref = v;
  }
  if (hasOwn(rec, "status")) {
    const v = enumValue(
      sink,
      rec["status"],
      SPEC_STATUSES,
      "frontmatter.status",
      "status",
    );
    if (v !== undefined) out.status = v;
  }
  const superseded = rec["status"] === "superseded";
  if (hasOwn(rec, "superseded_by")) {
    const v = nonEmptyString(
      sink,
      rec["superseded_by"],
      "frontmatter.superseded_by",
      "superseded_by",
    );
    if (v !== undefined) {
      if (!superseded) {
        sink.add(
          "invalid-value",
          "frontmatter.superseded_by",
          "superseded_by is only allowed when status is superseded",
        );
      } else if (!isSpecId(v)) {
        sink.add(
          "invalid-value",
          "frontmatter.superseded_by",
          "superseded_by must be a spec ID",
        );
      } else out.superseded_by = v;
    }
  } else if (superseded) {
    sink.add(
      "missing-field",
      "frontmatter.superseded_by",
      "frontmatter is missing superseded_by, which status superseded requires",
    );
  }
  const retired: string[] = [];
  if (hasOwn(rec, "retired_ids")) {
    const raw = rec["retired_ids"];
    if (!Array.isArray(raw)) {
      sink.add(
        "wrong-type",
        "frontmatter.retired_ids",
        `retired_ids must be a list, got ${describeType(raw)}`,
      );
    } else {
      const seen = new Set<string>();
      raw.forEach((item, i) => {
        const path = `frontmatter.retired_ids[${i}]`;
        if (typeof item !== "string" || !isNumberedId(item)) {
          sink.add(
            "invalid-id",
            path,
            `retired_ids may only list numbered IDs such as AC-3, got ${JSON.stringify(item)}`,
          );
        } else if (seen.has(item)) {
          sink.add("duplicate-id", path, `retired_ids lists ${item} twice`);
        } else {
          seen.add(item);
          retired.push(item);
        }
      });
    }
  }
  if (sink.errors.length > before) return undefined;
  return { ...out, retired_ids: retired } as SpecFrontmatter;
}

// ----------------------------------------------------------------------- body

interface RawAttr {
  key: string;
  value: string;
  line: number;
  block: Map<string, { value: string; line: number }>;
}

interface RawItem {
  section: SpecSectionTitle;
  idText: string;
  text: string;
  line: number;
  attrs: Map<string, RawAttr>;
}

const HEADING_RE = /^## (.*)$/;
const ITEM_RE = /^- (\S+?):(?: (.*))?$/;
const ATTR_RE = /^( +)- ([a-z][a-z_]*):(?: (.*))?$/;

/** Splits the item and attribute lines of the normative sections. */
function collectItems(
  sink: ErrorSink,
  lines: string[],
  firstLine: number,
): { items: RawItem[]; sections: SpecSectionTitle[] } {
  const items: RawItem[] = [];
  const sections: SpecSectionTitle[] = [];
  let section: SpecSectionTitle | null = null;
  // After an unknown heading the lines below it are not read again: the
  // heading itself was reported.
  let skipping = false;
  let item: RawItem | null = null;
  let attr: RawAttr | null = null;

  for (const [offset, text] of lines.entries()) {
    const lineNo = firstLine + offset;

    // The character rule comes first and has no exemption. It reads the raw
    // line before any heading, section, blank-line or trim logic, so no
    // `continue` below can skip it: a heading line, a Context line, a line
    // that trims to nothing and a line below an unknown heading are checked
    // like an item line. A line that is not read as an item or an attribute
    // is reported at `$`.
    const bad = findForbiddenCharacter(text);
    if (bad) {
      const unread = skipping || section === "Context";
      const idm = /^- (\S+?):/.exec(text);
      const am0 = ATTR_RE.exec(text);
      const nested = am0 !== null && am0[1]!.length === 4 && attr !== null;
      const path = unread
        ? "$"
        : idm
          ? `${idm[1]}.text`
          : item && am0
            ? nested
              ? `${item.idText}.${attr!.key}.${am0[2]}`
              : `${item.idText}.${am0[2]}`
            : "$";
      sink.add(
        "forbidden-character",
        path,
        `the line contains ${bad.label}, ${FORBIDDEN_WHAT}`,
        lineNo,
      );
    }

    const heading = HEADING_RE.exec(text);
    if (heading) {
      const title = heading[1]!.trim();
      item = null;
      attr = null;
      if (!(SPEC_SECTION_TITLES as readonly string[]).includes(title)) {
        sink.add(
          "unknown-section",
          `section.${title}`,
          `unknown section ${JSON.stringify(title)}; allowed: ${SPEC_SECTION_TITLES.join(", ")}`,
          lineNo,
        );
        section = null;
        skipping = true;
        continue;
      }
      skipping = false;
      const known = title as SpecSectionTitle;
      if (sections.includes(known)) {
        sink.add(
          "duplicate-section",
          `section.${title}`,
          `section ${title} appears twice`,
          lineNo,
        );
      } else sections.push(known);
      section = known;
      continue;
    }

    if (skipping) continue;

    // Context runs to the next line that starts at column 0 with '## '.
    // Code fences, indented headings and setext headings do not change that.
    if (section === "Context") continue;

    if (text.trim() === "") continue;

    if (section === null) {
      // Before the first section only a title line is tolerated.
      if (/^# \S/.test(text)) continue;
      sink.add(
        "unexpected-line",
        "$",
        "text before the first section; start with a '## ' heading",
        lineNo,
      );
      continue;
    }

    if (/^[ \t]*\t/.test(text)) {
      sink.add("bad-indent", "$", "indent with spaces, not tabs", lineNo);
      continue;
    }

    if (text.startsWith("- ")) {
      const m = ITEM_RE.exec(text);
      if (!m) {
        sink.add(
          "invalid-item-line",
          "$",
          "an item line reads '- <ID>: <text>'",
          lineNo,
        );
        item = null;
        attr = null;
        continue;
      }
      item = {
        section,
        idText: m[1]!,
        text: (m[2] ?? "").trim(),
        line: lineNo,
        attrs: new Map(),
      };
      attr = null;
      items.push(item);
      continue;
    }

    const am = ATTR_RE.exec(text);
    if (!am) {
      sink.add(
        "unexpected-line",
        "$",
        "a line in this section must be an item ('- <ID>: <text>') or an attribute ('  - <key>: <value>')",
        lineNo,
      );
      continue;
    }
    const indent = am[1]!.length;
    const key = am[2]!;
    const value = (am[3] ?? "").trim();
    if (indent === 2) {
      if (!item) {
        sink.add(
          "unexpected-line",
          "$",
          "attribute line without an item above it",
          lineNo,
        );
        continue;
      }
      if (item.attrs.has(key)) {
        sink.add(
          "duplicate-attribute",
          `${item.idText}.${key}`,
          `attribute ${key} appears twice on ${item.idText}`,
          lineNo,
        );
        attr = null;
        continue;
      }
      attr = { key, value, line: lineNo, block: new Map() };
      item.attrs.set(key, attr);
      continue;
    }
    if (indent === 4) {
      if (!item || !attr) {
        sink.add(
          "bad-indent",
          "$",
          "a nested attribute needs a block attribute such as 'provenance:' above it",
          lineNo,
        );
        continue;
      }
      if (attr.block.has(key)) {
        sink.add(
          "duplicate-attribute",
          `${item.idText}.${attr.key}.${key}`,
          `attribute ${attr.key}.${key} appears twice on ${item.idText}`,
          lineNo,
        );
        continue;
      }
      attr.block.set(key, { value, line: lineNo });
      continue;
    }
    sink.add(
      "bad-indent",
      "$",
      "attributes are indented by 2 spaces, nested attributes by 4",
      lineNo,
    );
  }

  return { items, sections };
}

/** Reads and validates the attributes of one item. */
class AttrReader {
  private readonly used = new Set<string>();

  private readonly sink: ErrorSink;
  private readonly item: RawItem;

  constructor(sink: ErrorSink, item: RawItem) {
    this.sink = sink;
    this.item = item;
  }

  private get id(): string {
    return this.item.idText;
  }

  private take(key: string): RawAttr | undefined {
    this.used.add(key);
    return this.item.attrs.get(key);
  }

  /** Marks an attribute as handled by the caller without reading it. */
  claim(key: string): void {
    this.used.add(key);
  }

  private missing(key: string): void {
    this.sink.add(
      "missing-attribute",
      `${this.id}.${key}`,
      `${this.id} is missing required attribute ${key}`,
      this.item.line,
    );
  }

  /** A scalar attribute; reports and returns undefined when absent (if required), empty or nested. */
  scalar(key: string, required: boolean): string | undefined {
    const a = this.take(key);
    if (!a) {
      if (required) this.missing(key);
      return undefined;
    }
    if (a.block.size > 0) {
      this.sink.add(
        "bad-indent",
        `${this.id}.${key}`,
        `attribute ${key} takes a value, not nested attributes`,
        a.line,
      );
      return undefined;
    }
    if (a.value === "") {
      this.sink.add(
        "empty-value",
        `${this.id}.${key}`,
        `attribute ${key} of ${this.id} must not be empty`,
        a.line,
      );
      return undefined;
    }
    return a.value;
  }

  /** A comma separated list of non-empty, unique entries. */
  list(key: string, required: boolean): string[] | undefined {
    const value = this.scalar(key, required);
    if (value === undefined) return undefined;
    const parts = value.split(",").map((p) => p.trim());
    const seen = new Set<string>();
    for (const part of parts) {
      if (part === "") {
        this.sink.add(
          "empty-value",
          `${this.id}.${key}`,
          `attribute ${key} of ${this.id} has an empty list entry`,
          this.item.attrs.get(key)!.line,
        );
        return undefined;
      }
      if (seen.has(part)) {
        this.sink.add(
          "duplicate-value",
          `${this.id}.${key}`,
          `attribute ${key} of ${this.id} lists ${part} twice`,
          this.item.attrs.get(key)!.line,
        );
        return undefined;
      }
      seen.add(part);
    }
    return parts;
  }

  /** A block attribute: a header line with nested `key: value` lines. */
  block(
    key: string,
    required: boolean,
  ): Map<string, { value: string; line: number }> | undefined {
    const a = this.take(key);
    if (!a) {
      if (required) this.missing(key);
      return undefined;
    }
    if (a.value !== "") {
      this.sink.add(
        "invalid-value",
        `${this.id}.${key}`,
        `attribute ${key} of ${this.id} is a block; put its fields on nested lines`,
        a.line,
      );
      return undefined;
    }
    if (a.block.size === 0) {
      this.sink.add(
        "empty-value",
        `${this.id}.${key}`,
        `block ${key} of ${this.id} has no fields`,
        a.line,
      );
      return undefined;
    }
    return a.block;
  }

  line(key: string): number {
    return this.item.attrs.get(key)?.line ?? this.item.line;
  }

  /** Reports every attribute no rule asked for. */
  finish(): void {
    for (const [key, attr] of this.item.attrs) {
      if (!this.used.has(key)) {
        this.sink.add(
          "unknown-attribute",
          `${this.id}.${key}`,
          `${this.id} does not take an attribute ${key}`,
          attr.line,
        );
      }
    }
  }
}

function idsOfPrefix(
  sink: ErrorSink,
  values: string[],
  prefixes: readonly string[],
  path: string,
  line: number,
): boolean {
  let good = true;
  for (const v of values) {
    const parsed = parseId(v);
    if (!parsed.ok || !prefixes.includes(parsed.value.prefix)) {
      sink.add(
        "invalid-id",
        path,
        `${JSON.stringify(v)} must be an ID with prefix ${prefixes.join(", ")}`,
        line,
      );
      good = false;
    }
  }
  return good;
}

function singleId(
  sink: ErrorSink,
  value: string,
  prefix: string,
  path: string,
  line: number,
): boolean {
  return idsOfPrefix(sink, [value], [prefix], path, line);
}

function requireText(sink: ErrorSink, item: RawItem): boolean {
  if (item.text === "") {
    sink.add(
      "empty-value",
      `${item.idText}.text`,
      `${item.idText} has no text after the colon`,
      item.line,
    );
    return false;
  }
  return true;
}

type SpecBody = Omit<Spec, "frontmatter">;

function buildBody(
  sink: ErrorSink,
  retiredIds: string[],
  items: RawItem[],
  sections: SpecSectionTitle[],
): SpecBody {
  const spec: SpecBody = {
    goal: null,
    acceptance: [],
    nonGoals: [],
    defaults: [],
    decisions: [],
    residuals: [],
    ledger: [],
    sections,
    ids: [],
  };
  const seen = new Set<string>();
  const retired = new Set(retiredIds);
  const seenSourceLines = new Set<string>();

  for (const item of items) {
    const idPath = item.idText;
    const prefix = SECTION_PREFIX[item.section];
    const parsed = parseId(item.idText);
    if (!parsed.ok) {
      sink.add(
        "invalid-id",
        idPath,
        `${JSON.stringify(item.idText)} is not an ID`,
        item.line,
      );
      continue;
    }
    if (parsed.value.prefix !== prefix) {
      sink.add(
        "id-section-mismatch",
        idPath,
        `${item.idText} does not belong in section ${item.section}; it takes ${prefix} IDs`,
        item.line,
      );
      continue;
    }
    if (seen.has(item.idText)) {
      sink.add(
        "duplicate-id",
        idPath,
        `${item.idText} is used twice`,
        item.line,
      );
      continue;
    }
    seen.add(item.idText);
    if (retired.has(item.idText)) {
      sink.add(
        "retired-id-live",
        idPath,
        `${item.idText} is listed in retired_ids and must not be used again`,
        item.line,
      );
    }
    spec.ids.push(item.idText);
    const attrs = new AttrReader(sink, item);
    const base = { id: item.idText, text: item.text, line: item.line };

    switch (item.section) {
      case "Goal": {
        if (requireText(sink, item)) spec.goal ??= base;
        break;
      }
      case "Acceptance": {
        const okText = requireText(sink, item);
        const source = attrs.list("source", true);
        const owner = attrs.scalar("owner", true);
        const sourceOk =
          source !== undefined &&
          idsOfPrefix(
            sink,
            source,
            ["SL"],
            `${idPath}.source`,
            attrs.line("source"),
          );
        if (okText && sourceOk && source && owner !== undefined) {
          spec.acceptance.push({ ...base, source, owner });
        }
        break;
      }
      case "Non-goals": {
        const okText = requireText(sink, item);
        const rawPaths = attrs.list("paths", false);
        let paths: string[] = [];
        if (rawPaths) {
          sink.lineHint = attrs.line("paths");
          for (const p of rawPaths) {
            relativePath(sink, p, `${idPath}.paths`, "paths entry");
          }
          sink.lineHint = undefined;
          paths = rawPaths;
        }
        if (okText) spec.nonGoals.push({ ...base, paths });
        break;
      }
      case "Defaults": {
        const okText = requireText(sink, item);
        const reason = attrs.scalar("reason", true);
        const flag = attrs.scalar("affects_behavior", true);
        let affects: boolean | undefined;
        if (flag !== undefined) {
          if (flag === "true") affects = true;
          else if (flag === "false") affects = false;
          else {
            sink.add(
              "invalid-value",
              `${idPath}.affects_behavior`,
              `affects_behavior of ${idPath} must be true or false`,
              attrs.line("affects_behavior"),
            );
          }
        }
        if (okText && reason !== undefined && affects !== undefined) {
          spec.defaults.push({ ...base, reason, affects_behavior: affects });
        }
        break;
      }
      case "Decisions": {
        const okText = requireText(sink, item);
        const question = attrs.scalar("question", true);
        let questionOk = false;
        if (question !== undefined) {
          questionOk = singleId(
            sink,
            question,
            "QN",
            `${idPath}.question`,
            attrs.line("question"),
          );
        }
        const block = attrs.block("provenance", true);
        let provenance: Provenance | undefined;
        if (block)
          provenance = readProvenance(
            sink,
            idPath,
            block,
            attrs.line("provenance"),
          );
        if (okText && questionOk && question !== undefined && provenance) {
          spec.decisions.push({ ...base, question, provenance });
        }
        break;
      }
      case "Residuals": {
        const okText = requireText(sink, item);
        const rawClass = attrs.scalar("class", true);
        const rawStatus = attrs.scalar("status", true);
        const question = attrs.scalar("question", false);
        const cls =
          rawClass === undefined
            ? undefined
            : enumValue(
                sink,
                rawClass,
                OPEN_POINT_CLASSES,
                `${idPath}.class`,
                `class of ${idPath}`,
              );
        const status =
          rawStatus === undefined
            ? undefined
            : enumValue(
                sink,
                rawStatus,
                RESIDUAL_STATUSES,
                `${idPath}.status`,
                `status of ${idPath}`,
              );
        let questionOk = true;
        if (question !== undefined) {
          questionOk = singleId(
            sink,
            question,
            "QN",
            `${idPath}.question`,
            attrs.line("question"),
          );
        }
        if (okText && cls && status && questionOk) {
          const line: ResidualLine = { ...base, class: cls, status };
          if (question !== undefined) line.question = question;
          spec.residuals.push(line);
        }
        break;
      }
      case "Source ledger": {
        const entry = readLedgerItem(sink, item, attrs, seenSourceLines);
        if (entry) spec.ledger.push(entry);
        break;
      }
      case "Context":
        break;
    }
    attrs.finish();
  }
  return spec;
}

function readProvenance(
  sink: ErrorSink,
  idPath: string,
  block: Map<string, { value: string; line: number }>,
  headerLine: number,
): Provenance | undefined {
  const before = sink.errors.length;
  const allowed = ["channel", "author", "time", "comment_url"];
  for (const [key, entry] of block) {
    if (!allowed.includes(key)) {
      sink.add(
        "unknown-attribute",
        `${idPath}.provenance.${key}`,
        `provenance of ${idPath} does not take a field ${key}`,
        entry.line,
      );
    }
  }
  for (const key of ["channel", "author", "time"]) {
    if (!block.has(key)) {
      sink.add(
        "missing-attribute",
        `${idPath}.provenance.${key}`,
        `provenance of ${idPath} is missing required field ${key}`,
        headerLine,
      );
    }
  }
  const out: Partial<Provenance> = {};
  const channel = block.get("channel");
  if (channel) {
    out.channel = enumValue(
      sink,
      channel.value,
      ANSWER_CHANNELS,
      `${idPath}.provenance.channel`,
      `channel of ${idPath}`,
    );
  }
  const author = block.get("author");
  if (author) {
    out.author = nonEmptyString(
      sink,
      author.value,
      `${idPath}.provenance.author`,
      `author of ${idPath}`,
    );
  }
  const time = block.get("time");
  if (time) {
    out.time = isoTime(
      sink,
      time.value,
      `${idPath}.provenance.time`,
      `time of ${idPath}`,
    );
  }
  const url = block.get("comment_url");
  if (url) {
    const v = urlValue(
      sink,
      url.value,
      `${idPath}.provenance.comment_url`,
      `comment_url of ${idPath}`,
    );
    if (v !== undefined) out.comment_url = v;
  }
  if (sink.errors.length > before) return undefined;
  return out as Provenance;
}

function readLedgerItem(
  sink: ErrorSink,
  item: RawItem,
  attrs: AttrReader,
  seenSourceLines: Set<string>,
): LedgerLine | undefined {
  const idPath = item.idText;
  const parts = item.text.split(" -> ");
  if (
    parts.length !== 2 ||
    parts[0]!.trim() === "" ||
    parts[1]!.trim() === ""
  ) {
    sink.add(
      "invalid-item-line",
      idPath,
      `${idPath} must read '<source line ID> -> <targets>'`,
      item.line,
    );
    return undefined;
  }
  const sourceLine = parts[0]!.trim();
  const targets = parts[1]!.split(",").map((t) => t.trim());
  let good = true;
  if (!isSourceLineId(sourceLine)) {
    sink.add(
      "invalid-id",
      `${idPath}.source_line`,
      `${JSON.stringify(sourceLine)} is not a source line ID (L<position>-<12 hex characters>)`,
      item.line,
    );
    good = false;
  } else if (seenSourceLines.has(sourceLine)) {
    sink.add(
      "duplicate-value",
      `${idPath}.source_line`,
      `source line ${sourceLine} is mapped by more than one ledger entry; list all its targets in one entry`,
      item.line,
    );
    good = false;
  } else seenSourceLines.add(sourceLine);

  const out = targets.length === 1 && targets[0] === LEDGER_OUT;
  if (!out) {
    if (targets.includes(LEDGER_OUT)) {
      sink.add(
        "invalid-value",
        `${idPath}.targets`,
        `${idPath}: 'out' cannot be combined with other targets`,
        item.line,
      );
      good = false;
    } else if (
      !idsOfPrefix(
        sink,
        targets,
        ["AC", "NG", "DF", "DC", "RS"],
        `${idPath}.targets`,
        item.line,
      )
    ) {
      good = false;
    } else if (new Set(targets).size !== targets.length) {
      sink.add(
        "duplicate-value",
        `${idPath}.targets`,
        `${idPath} lists a target twice`,
        item.line,
      );
      good = false;
    }
  }
  let reason: string | undefined;
  if (out) {
    reason = attrs.scalar("reason", true);
    if (reason === undefined) good = false;
  } else if (item.attrs.has("reason")) {
    attrs.claim("reason");
    sink.add(
      "attribute-not-allowed",
      `${idPath}.reason`,
      `${idPath} maps to targets; only an 'out' entry takes a reason`,
      attrs.line("reason"),
    );
    good = false;
  }
  if (!good) return undefined;
  const entry: LedgerLine = {
    id: idPath,
    line: item.line,
    sourceLine,
    targets: out ? [] : targets,
    out,
  };
  if (reason !== undefined) entry.reason = reason;
  return entry;
}

// ------------------------------------------------------------------- entry

/** Parses the text of a `spec.md`. */
export function parseSpec(input: string): ParseResult<Spec> {
  const sink = new ErrorSink();
  if (input.length > MAX_INPUT_LENGTH) {
    return failResult([
      {
        code: "input-too-large",
        path: "$",
        message: `input is ${input.length} characters, the limit is ${MAX_INPUT_LENGTH}`,
      } satisfies FormatError,
    ]);
  }
  const lines = stripBom(input).replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") {
    sink.add(
      "missing-frontmatter",
      "frontmatter",
      "a spec starts with a '---' line that opens the frontmatter",
      1,
    );
    return failResult(sink.errors);
  }
  const close = lines.indexOf("---", 1);
  if (close < 0) {
    sink.add(
      "unterminated-frontmatter",
      "frontmatter",
      "the frontmatter is never closed by a '---' line",
      1,
    );
    return failResult(sink.errors);
  }
  // The character rule for the frontmatter lines. The YAML decoder checks
  // the same text again, but it gets every line ended by a line feed and so
  // reads a carriage return that ends one of them here as part of a line
  // end. The sink keeps one report per line.
  for (let i = 1; i < close; i++) {
    const bad = findForbiddenCharacter(lines[i]!);
    if (bad) {
      sink.add(
        "forbidden-character",
        "frontmatter",
        `the line contains ${bad.label}, ${FORBIDDEN_WHAT}`,
        i + 1,
      );
    }
  }
  const yaml = parseYamlText(
    lines
      .slice(1, close)
      .map((line) => `${line}\n`)
      .join(""),
  );
  let frontmatter: SpecFrontmatter | undefined;
  if (!yaml.ok) {
    for (const e of yaml.errors) {
      sink.add(
        e.code,
        "frontmatter",
        e.message,
        e.line !== undefined ? e.line + 1 : 2,
      );
    }
  } else {
    frontmatter = parseFrontmatter(sink, yaml.value, 2);
  }
  const { items, sections } = collectItems(
    sink,
    lines.slice(close + 1),
    close + 2,
  );
  const body = buildBody(sink, frontmatter?.retired_ids ?? [], items, sections);
  if (!sink.empty || !frontmatter) return failResult(sink.errors);
  return okResult({ frontmatter, ...body });
}

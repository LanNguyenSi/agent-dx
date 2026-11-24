/**
 * `source/meta.json`, as far as lint reads it: the source line list and the
 * two reference commits the intake step recorded. The intake step writes the
 * whole file; the reader here validates what the rules need and, unlike the
 * intake reader, never throws.
 */
import {
  ErrorSink,
  isSourceLineId,
  parseJsonText,
  type FormatError,
  type ParseResult,
  type SourceLineKind,
} from "../formats/index.js";
import {
  COMMIT_RE,
  describeType,
  hasOwn,
  isRecord,
} from "../formats/validate.js";

export const SOURCE_LINE_KINDS: readonly SourceLineKind[] = [
  "text",
  "image",
  "code",
];

export interface LintSourceMeta {
  /** Full commit ids, as in the `spec.md` frontmatter. */
  base_commit: string;
  commands_ref: string;
  lines: { id: string; kind: SourceLineKind }[];
}

/** The reference commits of `source/meta.json`, in the order they are checked. */
export const META_COMMIT_FIELDS = ["base_commit", "commands_ref"] as const;

/**
 * Parses the text of a `source/meta.json`; validates `lines[]`,
 * `base_commit` and `commands_ref` (a full commit id: 40 or 64 lower-case
 * hex digits).
 */
export function parseSourceMeta(text: string): ParseResult<LintSourceMeta> {
  const decoded = parseJsonText(text);
  if (!decoded.ok) return decoded;
  const sink = new ErrorSink();
  const doc = decoded.value;
  if (!isRecord(doc)) {
    sink.add(
      "wrong-type",
      "$",
      `meta must be an object, got ${describeType(doc)}`,
    );
    return { ok: false, errors: sink.errors };
  }
  const commits: Record<string, string> = {};
  for (const field of META_COMMIT_FIELDS) {
    if (!hasOwn(doc, field)) {
      sink.add("missing-field", field, `meta is missing ${field}`);
      continue;
    }
    const value = doc[field];
    if (typeof value !== "string") {
      sink.add(
        "wrong-type",
        field,
        `${field} must be a string, got ${describeType(value)}`,
      );
    } else if (!COMMIT_RE.test(value)) {
      sink.add(
        "invalid-value",
        field,
        `${field} must be a full commit id (40 or 64 lower-case hex digits), got ${JSON.stringify(value)}`,
      );
    } else {
      commits[field] = value;
    }
  }
  if (!hasOwn(doc, "lines")) {
    sink.add("missing-field", "lines", "meta is missing lines");
    return { ok: false, errors: sink.errors };
  }
  const raw = doc["lines"];
  if (!Array.isArray(raw)) {
    sink.add(
      "wrong-type",
      "lines",
      `lines must be a list, got ${describeType(raw)}`,
    );
    return { ok: false, errors: sink.errors };
  }
  const lines: LintSourceMeta["lines"] = [];
  const seen = new Set<string>();
  raw.forEach((entry: unknown, i) => {
    const at = `lines[${i}]`;
    if (!isRecord(entry)) {
      sink.add(
        "wrong-type",
        at,
        `a lines entry must be an object with id and kind, got ${describeType(entry)}`,
      );
      return;
    }
    const { id, kind } = entry;
    let good = true;
    if (typeof id !== "string" || !isSourceLineId(id)) {
      sink.add(
        "invalid-id",
        `${at}.id`,
        `${at}.id must be a source line ID (L<position>-<12 hex characters>), got ${JSON.stringify(id)}`,
      );
      good = false;
    } else if (seen.has(id)) {
      sink.add("duplicate-value", `${at}.id`, `lines lists ${id} twice`);
      good = false;
    }
    if (
      typeof kind !== "string" ||
      !(SOURCE_LINE_KINDS as readonly string[]).includes(kind)
    ) {
      sink.add(
        "invalid-value",
        `${at}.kind`,
        `${at}.kind must be one of ${SOURCE_LINE_KINDS.join(", ")}, got ${JSON.stringify(kind)}`,
      );
      good = false;
    }
    if (good) {
      seen.add(id as string);
      lines.push({ id: id as string, kind: kind as SourceLineKind });
    }
  });
  if (sink.errors.length > 0) {
    return { ok: false, errors: sink.errors as FormatError[] };
  }
  return {
    ok: true,
    value: {
      base_commit: commits["base_commit"]!,
      commands_ref: commits["commands_ref"]!,
      lines,
    },
  };
}

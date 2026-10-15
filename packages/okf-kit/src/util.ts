import path from "node:path";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether parsed frontmatter has a `sources` key at all, regardless of shape validity. */
export function hasSourcesKey(parsed: unknown): boolean {
  return isRecord(parsed) && "sources" in parsed;
}

/**
 * Returns the frontmatter list under `key` when it is shaped correctly (a
 * non-empty array of non-empty strings), or undefined otherwise (absent, or
 * present but malformed). The shape check behind `getValidAppliesTo`; the
 * `sources` list has its own two-shape reader, `analyzeSources`.
 */
export function getValidPathList(
  parsed: unknown,
  key: string,
): string[] | undefined {
  if (!isRecord(parsed) || !(key in parsed)) return undefined;
  const list = parsed[key];
  const isValidShape =
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((s) => typeof s === "string" && s.trim() !== "");
  return isValidShape ? (list as string[]) : undefined;
}

/** How a `sources` entry resolves: a repo-relative path, or a URL that is never touched on disk. */
export type SourceKind = "path" | "url";

/**
 * One usable `sources` entry. OKF v0.1 writes an entry as a plain string
 * (`form: "string"`, always a repo-relative path); OKF v0.2 writes it as a
 * mapping (`form: "mapping"`) with a required `resource`, an optional `id`
 * (the key a body footnote `[^id]` resolves by) and descriptive fields this
 * tool does not read (`title`, `author`, `usage_count`, `last_modified`,
 * ...). Both shapes are accepted under either spec version.
 */
export interface SourceEntry {
  /** The path or URL: the string itself, or the mapping's `resource`. */
  resource: string;
  /** The mapping's `id` (a YAML number is accepted and stringified); undefined for a string entry or a mapping without a usable `id`. */
  id?: string;
  form: "string" | "mapping";
  /** `url` only for a MAPPING `resource` that is a `scheme://` URL; a string entry is always a `path`, exactly as before v0.2. */
  kind: SourceKind;
}

/** A defect in one `sources` item that leaves the rest of the list usable. */
export interface SourceItemProblem {
  /** 1-based position in the `sources` list. */
  position: number;
  message: string;
}

export interface SourcesAnalysis {
  /**
   * False when the list as a whole is malformed (not an array, empty, or an
   * item that is neither a non-blank string nor a mapping): the one failure
   * `sources-shape` reports as a single list-level error and every
   * staleness/lookup consumer skips the doc for, as before v0.2.
   */
  usable: boolean;
  /** True when at least one item is a mapping (decides which list-level message applies). */
  hasMapping: boolean;
  /** Every item that yielded a resource, in list order (empty when `usable` is false). */
  entries: SourceEntry[];
  /** Per-item defects of a mapping (no/blank/non-string `resource`, unusable `id`); only populated when `usable` is true. */
  problems: SourceItemProblem[];
}

/**
 * Whether a mapping `resource` is a URL (`https://...`, `file://...`, any
 * `scheme://`) rather than a repo-relative path. Deliberately narrow: only
 * `scheme://` counts, the scheme needs at least two characters (so a
 * Windows drive letter `C://` is not one), and the test is anchored at the
 * start, so a path that merely contains `://` further in (`docs/a://b.md`)
 * or starts with `./` or `..` is still a path and still goes through
 * `isWithinRepoRoot`. A `urn:`/`mailto:` style resource has no `//` and so
 * counts as a path (it then fails the existence check, loudly).
 */
export function isUrlResource(resource: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(resource.trim());
}

/** A mapping `id` as the footnote key it names, or undefined when it is not a usable id (a string or a finite number, non-blank). */
function normalizeSourceId(id: unknown): string | undefined {
  if (typeof id === "string") return id.trim() === "" ? undefined : id.trim();
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return undefined;
}

/**
 * Reads the frontmatter `sources` list in both OKF shapes. A string item is
 * valid when non-blank (as in v0.1); a mapping item yields an entry when its
 * `resource` is a non-blank string and is otherwise reported as an item
 * problem WITHOUT invalidating the list, so one broken mapping neither
 * hides the doc's other sources from the staleness rules nor turns into a
 * second list-level finding. Anything else (a number, a nested list, a
 * blank string) makes the whole list unusable, the v0.1 behavior.
 */
export function analyzeSources(parsed: unknown): SourcesAnalysis {
  const unusable: SourcesAnalysis = {
    usable: false,
    hasMapping: false,
    entries: [],
    problems: [],
  };
  if (!isRecord(parsed) || !("sources" in parsed)) return unusable;
  const list = parsed.sources;
  if (!Array.isArray(list) || list.length === 0) return unusable;
  const hasMapping = list.some(isRecord);
  const entries: SourceEntry[] = [];
  const problems: SourceItemProblem[] = [];
  for (let i = 0; i < list.length; i++) {
    const item: unknown = list[i];
    const position = i + 1;
    if (typeof item === "string") {
      if (item.trim() === "") return { ...unusable, hasMapping };
      entries.push({ resource: item, form: "string", kind: "path" });
      continue;
    }
    if (!isRecord(item)) return { ...unusable, hasMapping };
    const resource = item.resource;
    if (typeof resource !== "string" || resource.trim() === "") {
      problems.push({
        position,
        message:
          "resource" in item
            ? `\`sources\` entry ${position} is a mapping whose \`resource\` is not a non-empty string`
            : `\`sources\` entry ${position} is a mapping without a \`resource\``,
      });
      continue;
    }
    let id: string | undefined;
    if ("id" in item) {
      id = normalizeSourceId(item.id);
      if (id === undefined) {
        problems.push({
          position,
          message: `\`sources\` entry ${position} (\`${resource}\`) has an \`id\` that is not a non-empty string or number`,
        });
      }
    }
    entries.push({
      resource,
      ...(id === undefined ? {} : { id }),
      form: "mapping",
      kind: isUrlResource(resource) ? "url" : "path",
    });
  }
  return { usable: true, hasMapping, entries, problems };
}

/**
 * The `id` of every mapping item in the raw `sources` list, whether or not
 * the item is otherwise usable (a mapping without a `resource` still names
 * the footnote that cites it, so a footnote pointing at it is not ALSO
 * reported as dangling on top of the shape error). Empty when `sources` is
 * absent or not a list.
 */
export function getDeclaredSourceIds(parsed: unknown): string[] {
  return getDeclaredSourceIdPositions(parsed).map((d) => d.id);
}

/** Like `getDeclaredSourceIds`, with each id's 1-based position in the `sources` list. */
export function getDeclaredSourceIdPositions(
  parsed: unknown,
): { id: string; position: number }[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.sources)) return [];
  const ids: { id: string; position: number }[] = [];
  (parsed.sources as unknown[]).forEach((item, i) => {
    if (!isRecord(item) || !("id" in item)) return;
    const id = normalizeSourceId(item.id);
    if (id !== undefined) ids.push({ id, position: i + 1 });
  });
  return ids;
}

/**
 * The repo-relative PATH entries of the frontmatter `sources` list, or
 * undefined when the list is absent or malformed as a whole (see
 * `analyzeSources`). This is the one view the path-driven consumers share:
 * `sources-fresh` (staleness), `docs-for` (reverse lookup),
 * `citations-resolve` and `prose-line-references` (allowed citation
 * targets). Each entry is the string itself (OKF v0.1) or the `resource` of
 * a mapping entry (OKF v0.2); a URL `resource` and a mapping without a
 * usable `resource` are left out, so none of those consumers ever resolves
 * them against the file system. For a list of plain strings the result is
 * exactly what it was before v0.2 support. `sources-shape` and
 * `footnotes-resolve` need more than paths and read `analyzeSources`.
 */
export function getValidSources(parsed: unknown): string[] | undefined {
  const analysis = analyzeSources(parsed);
  if (!analysis.usable) return undefined;
  return analysis.entries
    .filter((entry) => entry.kind === "path")
    .map((entry) => entry.resource);
}

/** Whether parsed frontmatter has an `applies_to` key at all, regardless of shape validity. */
export function hasAppliesToKey(parsed: unknown): boolean {
  return isRecord(parsed) && "applies_to" in parsed;
}

/**
 * Returns the frontmatter `applies_to` array when it is shaped correctly
 * (a non-empty array of non-empty strings, the same shape as `sources`), or
 * undefined otherwise (absent, or present but malformed). `applies_to` is a
 * lookup-only field: `docs-for` matches it, `sources-shape` validates it,
 * and `sources-fresh` never reads it.
 */
export function getValidAppliesTo(parsed: unknown): string[] | undefined {
  return getValidPathList(parsed, "applies_to");
}

/**
 * Resolves a `sources` frontmatter entry (a plain string, never a glob)
 * against `repoRoot` with `path.join`, not `path.resolve`. The difference
 * matters for a source spelled with a leading slash (`/src/foo.ts`):
 * `path.join` treats it as repo-relative, exactly like every other entry,
 * while `path.resolve` would treat the leading slash as an instruction to
 * re-root at the filesystem root, silently escaping `repoRoot` entirely.
 * An `applies_to` entry is resolved by the same helper. Every place that
 * resolves a `sources` or `applies_to` entry goes through this helper
 * (`sources-shape`, `sources-fresh`, `citations-resolve` and `docs-for`),
 * so the check rules and the reverse lookup agree on what a `sources`
 * entry resolves to.
 */
export function resolveRepoPath(repoRoot: string, source: string): string {
  return path.join(repoRoot, source);
}

/**
 * Whether a `sources` / `applies_to` entry stays inside `repoRoot`. The
 * entry is resolved with `resolveRepoPath` and judged with `path.relative`
 * (never a string prefix, so a sibling directory sharing the root's name
 * prefix does not pass); a leading-slash entry is repo-relative there, so
 * only `..` segments can escape. The check is lexical: symlinks are not
 * resolved, so an in-tree link pointing outside the repo is not detected.
 */
export function isWithinRepoRoot(repoRoot: string, entry: string): boolean {
  const rel = path.relative(repoRoot, resolveRepoPath(repoRoot, entry));
  return (
    rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
  );
}

/**
 * Parses a frontmatter `timestamp` STRING to milliseconds since the epoch,
 * forcing UTC interpretation whenever the string carries no UTC designator
 * (`Z`) or numeric offset (`hasUtcDesignator`, D-016). `Date.parse` resolves
 * a designator-less string ("2026-01-01T13:00:00") in the machine's LOCAL
 * timezone by default, which would make every caller that reads a
 * `timestamp` through this function -- `sources-fresh`'s own day-wide
 * staleness comparison AND its re-stamp direction comparison
 * (`compareRestampDirection` in `src/rules/sources-fresh.ts`) -- read the
 * IDENTICAL frontmatter differently depending on where `okf-kit check`
 * happens to run. Appending `Z` before parsing makes the resolved instant a
 * property of the STRING, not of `TZ`, for every comparison in this
 * package, not just some of them. A string that already carries a
 * designator is parsed unchanged: `Date.parse` already resolves it
 * correctly on every machine. See docs/staleness.md's "Designator-less
 * timestamps" section for the full rationale and the one case this does
 * NOT cover (a value that is not parseable to an instant at all). The raw
 * string is trimmed before either check: the `Z` this
 * function appends for a designator-less value must land at the very end,
 * not after trailing whitespace, so a whitespace-padded value is parsed
 * the same as its untrimmed form (both `hasUtcDesignator` and `Date.parse`
 * would otherwise treat the padding as part of the value).
 */
function parseTimestampInstantMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  const ms = Date.parse(hasUtcDesignator(trimmed) ? trimmed : `${trimmed}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The frontmatter `generated` mapping (OKF v0.2: `generated: { by, at }`,
 * the replacement for the v0.1 `timestamp`), or undefined when the key is
 * absent OR present but not a mapping (`generated: some string`): the two
 * cases are deliberately not told apart here, which is why `generated-shape`
 * tests the key's presence itself when it reports a malformed value under
 * v0.2. Readers: the effective-stamp helpers below and that rule.
 */
export function getGenerated(
  parsed: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(parsed)) return undefined;
  return isRecord(parsed.generated) ? parsed.generated : undefined;
}

/**
 * The frontmatter `generated` mapping's `at` value -- an ISO 8601 date-time
 * with an explicit offset -- or undefined when it is absent, or present but
 * not a Date/string this tool can read (a number, null, a nested mapping, a
 * blank string). A value that cannot be read counts as "absent" here, which
 * is the spec's own fallback posture: consumers MAY fall back to `timestamp`
 * when `generated.at` is missing. A native `Date` (a `!!timestamp`-tagged
 * scalar or a programmatically constructed frontmatter) passes through
 * exactly like the `timestamp` helpers accept one.
 */
export function getGeneratedAtValue(
  parsed: unknown,
): Date | string | undefined {
  const generated = getGenerated(parsed);
  if (!generated) return undefined;
  const at = generated.at;
  if (at instanceof Date) return at;
  if (typeof at === "string" && at.trim() !== "") return at;
  return undefined;
}

/** The raw frontmatter `timestamp` value (Date or non-blank string), or undefined. NOT the effective stamp -- this ignores `generated.at` and exists for the divergence check below. */
function getTimestampValue(parsed: unknown): Date | string | undefined {
  if (!isRecord(parsed)) return undefined;
  const timestamp = parsed.timestamp;
  if (timestamp instanceof Date) return timestamp;
  if (typeof timestamp === "string" && timestamp.trim() !== "")
    return timestamp;
  return undefined;
}

/**
 * THE one effective stamp value every timestamp reader in this package
 * uses: the OKF v0.2 `generated.at` when present, else the v0.1
 * `timestamp`. Keeping the precedence in this single private helper is
 * what makes every consumer -- `sources-fresh`'s day-wide staleness
 * comparison, its re-stamp direction comparison over historical blobs
 * (`git show <sha>:<path>` parsed with the IDENTICAL `parseFrontmatter`),
 * `sources-fresh-future`'s clock-skew comparison, and every one of the
 * public helpers below -- judge a doc by the SAME stamp, so a re-stamp that
 * moves from `timestamp` to `generated.at` (either direction, on either
 * side of the commit boundary) can never be judged by two different
 * notions of "the stamp". A v0.1 bundle (no `generated` key) resolves to
 * `timestamp` unchanged.
 */
function getEffectiveStampValue(parsed: unknown): Date | string | undefined {
  return getGeneratedAtValue(parsed) ?? getTimestampValue(parsed);
}

/** The effective stamp value resolved to milliseconds since the epoch, or undefined when it is not parseable to an instant (same undefined cases the public helpers document). */
function stampValueToMs(stamp: Date | string): number | undefined {
  if (stamp instanceof Date) {
    const ms = stamp.getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }
  return parseTimestampInstantMs(stamp);
}

/**
 * Returns the frontmatter `timestamp` as a Unix epoch (seconds), or
 * undefined when absent, not a Date/string, or not parseable as a date.
 * Used by sources-fresh to compare against a source path's last-commit
 * time. Accepts a `Date` instance first: the `yaml` package's default
 * (core) schema resolves timestamp scalars to strings, but a YAML 1.1
 * `!!timestamp` tag (or a caller constructing frontmatter programmatically)
 * can hand back a native `Date`, and that should be assessed rather than
 * degrade to the no-valid-timestamp notice. A designator-less STRING is
 * parsed via `parseTimestampInstantMs`, i.e. as UTC, so this epoch never
 * depends on the machine's local timezone (D-016).
 *
 * Reads the EFFECTIVE stamp: the OKF v0.2 `generated.at` when the doc
 * carries one, else the v0.1 `timestamp` (see
 * `getEffectiveStampValue`; same `Date` vs. string and same designator-less
 * handling for either).
 */
export function getTimestampEpoch(parsed: unknown): number | undefined {
  const stamp = getEffectiveStampValue(parsed);
  if (stamp === undefined) return undefined;
  const ms = stampValueToMs(stamp);
  return ms === undefined ? undefined : Math.floor(ms / 1000);
}

/**
 * Like `getTimestampEpoch`, but at MILLISECOND resolution instead of
 * floored to the second. Used ONLY by `compareRestampDirection` (D-008):
 * flooring to whole seconds would treat two distinct re-stamps less than a
 * second apart (`...00.000Z` -> `...00.500Z`) as the SAME instant, which is
 * wrong for a comparison whose whole job is deciding "strictly later or
 * not" (a genuine forward move at that resolution must read as
 * `restamped`, not as the D-009 same-instant notice). Every OTHER
 * `getTimestampEpoch` caller keeps calling that function unchanged: their
 * thresholds (days, not milliseconds) make the distinction this function
 * exists for immaterial there, so there was no reason to touch them. Read
 * as an instant at millisecond resolution, exactly like `getTimestampEpoch`
 * otherwise -- same `Date` vs. string handling, same undefined cases, same
 * UTC-forcing treatment of a designator-less string (D-016), and the same
 * EFFECTIVE stamp (`generated.at` when present, else `timestamp`), which is
 * what lets a re-stamp that moves between the two keys be judged for
 * direction like any other re-stamp.
 */
export function getTimestampEpochMs(parsed: unknown): number | undefined {
  const stamp = getEffectiveStampValue(parsed);
  if (stamp === undefined) return undefined;
  return stampValueToMs(stamp);
}

/**
 * The effective stamp's raw string form (see `getEffectiveStampValue`:
 * `generated.at` when present, else `timestamp`), or undefined when it is
 * absent, blank, or not a string -- notably, a native `Date` instance (see
 * `getTimestampEpoch`'s doc comment) returns undefined here too, since a
 * `Date`'s `getTime()` already names one instant on every machine, so
 * there is no raw spelling left for a caller to inspect. Callers:
 * `hasUtcDesignator` (`sources-fresh-future`'s clock-skew check, and
 * `parseTimestampInstantMs`'s UTC-forcing decision, D-016), and
 * `describeTimestampValue`, which names each side's raw spelling in the
 * same-instant notice.
 */
export function getRawTimestampString(parsed: unknown): string | undefined {
  const stamp = getEffectiveStampValue(parsed);
  if (typeof stamp !== "string") return undefined;
  return stamp;
}

/**
 * Whether an ISO-ish timestamp string carries an explicit UTC designator
 * (`Z`) or a numeric UTC offset (`+02:00`, `-0500`) at its end. A string
 * with neither ("2026-01-01T00:00:00", "2026-01-01 00:00:00") is resolved
 * by `Date.parse` in the machine's LOCAL timezone; a string with either
 * already names a real UTC instant, so nothing beyond recognizing it is
 * needed here.
 *
 * Two callers consult this predicate, and they respond to the same
 * ambiguity in two different ways (D-016): `sources-fresh-future`'s
 * clock-skew check SKIPS a designator-less timestamp entirely (a notice,
 * not a warning) rather than compare it -- that allowance is minutes wide,
 * too narrow to safely absorb a multi-hour timezone shift. `sources-fresh`
 * instead FORCES UTC for it (`parseTimestampInstantMs`), for both its
 * day-wide staleness comparison and its re-stamp direction comparison
 * (`compareRestampDirection`) -- its thresholds are day-wide, so treating
 * the value as UTC everywhere is both consistent and safe. Which rule takes
 * which approach, and why, is written down once: see docs/staleness.md's
 * "Designator-less timestamps" paragraph.
 */
export function hasUtcDesignator(raw: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw.trim());
}

/**
 * A canonical identity string for the effective stamp VALUE (`generated.at`
 * when present, else the frontmatter `timestamp`), or undefined when it is
 * absent, blank, or not a scalar this tool understands. Two docs (or two
 * revisions of one doc) are "stamped the same" iff this returns the same
 * value for both.
 *
 * `compareRestampDirection` (sources-fresh) consults it in exactly two
 * places, both of them comparing identities rather than instants:
 *
 *  - as its FALLBACK, when direction cannot be judged at all: either side
 *    unparseable to an instant even after `getTimestampEpochMs` forces UTC
 *    for a designator-less string (D-016). With nothing comparable to
 *    order, the question becomes "did the raw value change", and any
 *    textual change counts as `restamped` -- see that function's doc
 *    comment for the full three-way split.
 *  - when both sides DO resolve to an instant and name the SAME one,
 *    to tell a rewrite (a different spelling of that one instant, e.g.
 *    `2026-01-01T00:00:00Z` to `2026-01-01T00:00:00+00:00`, which gets
 *    the D-009 notice) from a byte-identical value (never a re-stamp
 *    attempt, so it gets nothing).
 *
 * Comparing VALUES, not diff text, is what makes the identity test immune
 * to the three shapes a diff-text scan gets wrong: a `timestamp:` line
 * inside a fenced YAML example in the doc BODY (it is not the frontmatter
 * key, so it never reaches this function at all), a rename (the two
 * revisions are read by path, not from a diff header), and a merge commit
 * (whose combined-diff output is empty while its trees are perfectly
 * readable).
 *
 * The `date:`/`string:` prefixes keep the two YAML shapes distinguishable:
 * a `!!timestamp`-tagged scalar resolving to a native `Date` and a plain
 * string are different frontmatter, so rewriting one into the other counts
 * as a changed identity here. Deliberately NOT normalized to an epoch:
 * this is an identity test ("did the raw value change"), not a
 * chronological one. Whether the new value is CORRECT is a separate
 * question this function deliberately does not answer (see docs/staleness.md's
 * known limitations).
 *
 * Reads the EFFECTIVE stamp (`generated.at` when present, else `timestamp`),
 * and prefixes a `generated.at` value with `generated-at:` so switching the
 * very same instant from the `timestamp:` line to the `generated.at:` line
 * (the OKF v0.2 migration of a stamp) reads as a CHANGED identity, exactly
 * like a string rewritten to a native `Date` does, and never as the
 * byte-identical value that gets no same-instant notice at all.
 */
export function getTimestampIdentity(parsed: unknown): string | undefined {
  const stamp = getEffectiveStampValue(parsed);
  if (stamp === undefined) return undefined;
  const sourcePrefix =
    getGeneratedAtValue(parsed) === undefined ? "" : "generated-at:";
  if (stamp instanceof Date) {
    const ms = stamp.getTime();
    return Number.isNaN(ms) ? undefined : `${sourcePrefix}date:${ms}`;
  }
  return `${sourcePrefix}string:${stamp.trim()}`;
}

/**
 * One side of the `generated.at` vs `timestamp` divergence check, as the
 * `generated-shape` rule reports it: both raw values, for quoting in the
 * finding text, and both resolved instants, for the ISO rendering a native
 * `Date` needs (it has no raw spelling).
 */
export interface StampDivergence {
  generatedAt: Date | string;
  timestamp: Date | string;
  generatedAtMs: number;
  timestampMs: number;
}

/**
 * Whether the frontmatter carries BOTH an OKF v0.2 `generated.at` and a
 * v0.1 `timestamp`, each parseable to an instant, and those two instants
 * DIFFER: the doc then claims two different "last verified" moments at
 * once, and `generated.at` (which every effective-stamp reader uses)
 * silently wins. Undefined when either key is absent or unparseable (there
 * is no second instant to disagree with, and the effective-stamp rules
 * already say which value is read), and undefined when both keys name the
 * SAME instant -- a doc mid-migration that set both to the same moment is
 * redundant, not contradictory.
 */
export function getStampDivergence(
  parsed: unknown,
): StampDivergence | undefined {
  const generatedAt = getGeneratedAtValue(parsed);
  const timestamp = getTimestampValue(parsed);
  if (generatedAt === undefined || timestamp === undefined) return undefined;
  const generatedAtMs = stampValueToMs(generatedAt);
  const timestampMs = stampValueToMs(timestamp);
  if (generatedAtMs === undefined || timestampMs === undefined)
    return undefined;
  if (generatedAtMs === timestampMs) return undefined;
  return { generatedAt, timestamp, generatedAtMs, timestampMs };
}

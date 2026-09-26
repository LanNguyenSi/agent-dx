import path from "node:path";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether parsed frontmatter has a `sources` key at all, regardless of shape validity. */
export function hasSourcesKey(parsed: unknown): boolean {
  return isRecord(parsed) && "sources" in parsed;
}

/**
 * Returns the frontmatter `sources` array when it is shaped correctly (a
 * non-empty array of non-empty strings), or undefined otherwise (absent, or
 * present but malformed). Shared between sources-shape (which reports the
 * shape violation) and sources-fresh (which only assesses staleness for a
 * validly-shaped sources list, leaving the shape error itself to
 * sources-shape).
 */
export function getValidSources(parsed: unknown): string[] | undefined {
  if (!hasSourcesKey(parsed)) return undefined;
  const sources = (parsed as Record<string, unknown>).sources;
  const isValidShape =
    Array.isArray(sources) &&
    sources.length > 0 &&
    sources.every((s) => typeof s === "string" && s.trim() !== "");
  return isValidShape ? (sources as string[]) : undefined;
}

/**
 * Resolves a `sources` frontmatter entry (a plain string, never a glob)
 * against `repoRoot` with `path.join`, not `path.resolve`. The difference
 * matters for a source spelled with a leading slash (`/src/foo.ts`):
 * `path.join` treats it as repo-relative, exactly like every other entry,
 * while `path.resolve` would treat the leading slash as an instruction to
 * re-root at the filesystem root, silently escaping `repoRoot` entirely.
 * Every place that resolves a `sources` entry goes through this helper
 * (`sources-shape`, `sources-fresh`, `citations-resolve` and `docs-for`),
 * so the check rules and the reverse lookup agree on what a `sources`
 * entry resolves to.
 */
export function resolveRepoPath(repoRoot: string, source: string): string {
  return path.join(repoRoot, source);
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
 * NOT cover (a value that is not parseable to an instant at all). The raw string is trimmed before either check: the `Z` this
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
 */
export function getTimestampEpoch(parsed: unknown): number | undefined {
  if (!isRecord(parsed)) return undefined;
  const timestamp = parsed.timestamp;
  if (timestamp instanceof Date) {
    const ms = timestamp.getTime();
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
  }
  if (typeof timestamp !== "string" || timestamp.trim() === "")
    return undefined;
  const ms = parseTimestampInstantMs(timestamp);
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
 * UTC-forcing treatment of a designator-less string (D-016).
 */
export function getTimestampEpochMs(parsed: unknown): number | undefined {
  if (!isRecord(parsed)) return undefined;
  const timestamp = parsed.timestamp;
  if (timestamp instanceof Date) {
    const ms = timestamp.getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (typeof timestamp !== "string" || timestamp.trim() === "")
    return undefined;
  return parseTimestampInstantMs(timestamp);
}

/**
 * The frontmatter `timestamp`'s raw string form, or undefined when it is
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
  if (!isRecord(parsed)) return undefined;
  const timestamp = parsed.timestamp;
  if (typeof timestamp !== "string" || timestamp.trim() === "")
    return undefined;
  return timestamp;
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
 * A canonical identity string for the frontmatter `timestamp` VALUE, or
 * undefined when the key is absent, blank, or not a scalar this tool
 * understands. Two docs (or two revisions of one doc) are "stamped the
 * same" iff this returns the same value for both.
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
 */
export function getTimestampIdentity(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const timestamp = parsed.timestamp;
  if (timestamp instanceof Date) {
    const ms = timestamp.getTime();
    return Number.isNaN(ms) ? undefined : `date:${ms}`;
  }
  if (typeof timestamp !== "string" || timestamp.trim() === "")
    return undefined;
  return `string:${timestamp.trim()}`;
}

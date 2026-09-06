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
 * Returns the frontmatter `timestamp` as a Unix epoch (seconds), or
 * undefined when absent, not a Date/string, or not parseable as a date.
 * Used by sources-fresh to compare against a source path's last-commit
 * time. Accepts a `Date` instance first: the `yaml` package's default
 * (core) schema resolves timestamp scalars to strings, but a YAML 1.1
 * `!!timestamp` tag (or a caller constructing frontmatter programmatically)
 * can hand back a native `Date`, and that should be assessed rather than
 * degrade to the no-valid-timestamp notice.
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
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return undefined;
  return Math.floor(ms / 1000);
}

/**
 * The frontmatter `timestamp`'s raw string form, or undefined when it is
 * absent, blank, or not a string -- notably, a native `Date` instance (see
 * `getTimestampEpoch`'s doc comment) returns undefined here too, since a
 * `Date`'s `getTime()` is always UTC-unambiguous and carries none of the
 * local-timezone risk `hasUtcDesignator` exists to catch. Used only by
 * `sources-fresh-future`'s UTC-designator gate; `sources-fresh` itself has
 * no need for the raw string, only the resolved epoch.
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
 * (`Z`) or a numeric UTC offset (`+02:00`, `-0500`) at its end. A timestamp
 * with neither ("2026-01-01T00:00:00", "2026-01-01 00:00:00") parses in
 * the machine's LOCAL timezone under `Date.parse`, which would make
 * `sources-fresh-future`'s clock-skew comparison swing by hours depending
 * on which machine runs the check -- not usable for a check whose default
 * allowance is only 10 minutes. A numeric offset, unlike a bare local
 * time, is unambiguous: `Date.parse`/`Date#getTime()` already normalizes
 * it to a real UTC instant, so no extra conversion is needed here beyond
 * recognizing it as present. `sources-fresh`'s own thresholds are in
 * days, wide enough that this ambiguity doesn't practically matter there,
 * so this helper is deliberately NOT applied to that rule's comparison.
 */
export function hasUtcDesignator(raw: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw.trim());
}

/**
 * A canonical identity string for the frontmatter `timestamp` VALUE, or
 * undefined when the key is absent, blank, or not a scalar this tool
 * understands. Two docs (or two revisions of one doc) are "stamped the same"
 * iff this returns the same value for both.
 *
 * Used by `sources-fresh` to decide whether a commit actually re-stamped a
 * doc, by comparing the doc's frontmatter at that commit against its
 * frontmatter in the commit's first parent. Comparing VALUES, not diff text,
 * is what makes the test immune to the three shapes a diff-text scan gets
 * wrong: a `timestamp:` line inside a fenced YAML example in the doc BODY (it
 * is not the frontmatter key, so it never reaches this function at all), a
 * rename (the two revisions are read by path, not from a diff header), and a
 * merge commit (whose combined-diff output is empty while its trees are
 * perfectly readable).
 *
 * The `date:`/`string:` prefixes keep the two YAML shapes distinguishable: a
 * `!!timestamp`-tagged scalar resolving to a native `Date` and a plain string
 * are different frontmatter, so rewriting one into the other counts as a
 * re-stamp rather than silently comparing equal. Deliberately NOT normalized
 * to an epoch: this is an identity test ("did the value change"), not a
 * chronological one, so re-writing `2026-01-01T00:00:00Z` as
 * `2026-01-01T00:00:00+00:00` counts as a re-stamp -- the author touched the
 * stamp. Whether the new value is CORRECT is a separate question this
 * function deliberately does not answer (see the README's known limitations).
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

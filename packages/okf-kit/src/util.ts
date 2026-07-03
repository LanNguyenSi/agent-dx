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

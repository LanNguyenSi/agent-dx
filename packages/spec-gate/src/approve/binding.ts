/**
 * The binding of a merged pull request to a spec, as a pure rule over the
 * states a spec can have at a commit.
 *
 * After the merge the approval check judges the spec at the tip of the
 * default branch. The state it judges there is "proposed, with the digest
 * at the tip". A pull request is the one that brought the spec only when
 * that state arrives twice:
 *
 * - over the reviewed commits: the spec is in that state at the head commit
 *   that was approved, and is not at the merge base of that head with the
 *   first parent of the merge commit;
 * - on the default branch: some measured first-parent step goes from another
 *   state to that state.
 *
 * Both are one question about the two ends of a range, `arrives`. A range
 * whose end is in another state never counts, whatever its start is: a
 * spec that is a draft, or is not there, at both ends was not brought, and
 * neither was one that arrives at a text the tip does not hold.
 */

/** The states a spec can have at a commit, seen from the tip that is judged. */
export const SPEC_STANDINGS = [
  /** No `spec.md` that parses: the spec is not there, or cannot be read. */
  "absent",
  /** A `spec.md` that parses with a status other than `proposed`. */
  "not-proposed",
  /** `proposed`, with another digest than the tip has, or with none. */
  "proposed-other",
  /** `proposed`, with the digest the tip has. */
  "proposed-tip",
] as const;
export type SpecStanding = (typeof SPEC_STANDINGS)[number];

/**
 * The standing of a spec at a commit: `state` is its frontmatter state
 * there (`null` when `spec.md` is missing or does not parse), `digest` its
 * digest there (`null` when none exists), `tipDigest` the digest judged at
 * the tip (`null` when the tip has none: then nothing is `proposed-tip`).
 */
export function standingOf(
  state: { status: string } | null,
  digest: string | null,
  tipDigest: string | null,
): SpecStanding {
  if (state === null) return "absent";
  if (state.status !== "proposed") return "not-proposed";
  return tipDigest !== null && digest === tipDigest
    ? "proposed-tip"
    : "proposed-other";
}

/**
 * Whether the state judged at the tip arrives over a range: the spec is
 * `proposed-tip` at its end and is not at its start.
 */
export function arrives(start: SpecStanding, end: SpecStanding): boolean {
  return end === "proposed-tip" && start !== "proposed-tip";
}

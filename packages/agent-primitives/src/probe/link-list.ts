import path from "node:path";

/**
 * Whether a `link` value is usable, wherever one is accepted: `--link`,
 * a `--plan` file's own `link` field, and the repo defaults file's
 * `link` field. Returns the reason it is not, or `undefined` when it is
 * fine.
 *
 * Every `link` value that reaches `git`/`fs` already does so through an
 * argv array or a direct syscall, never a shell (see the README's
 * isolation section), so a `$(...)` or a backtick in one is inert either
 * way. This check is defense in depth on the two sources that come from
 * a FILE rather than being typed on the command line by the person
 * running the probe: a `--plan` an operator did not necessarily write
 * themselves, and the repo's own `.agent-primitives.json` -- the same
 * reasoning `-t`/`--pre` being shell commands is why THEY may never be
 * filled from untrusted text. Applied identically to `--link` itself so
 * all three sources genuinely share one rule rather than the CLI flag
 * being merely "safe" while the file-sourced ones are "checked".
 */
export function linkEntryUsageError(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return "must be a non-empty string";
  }
  if (value.includes("$(") || value.includes("`")) {
    return 'must not contain "$(" or a backtick';
  }
  return undefined;
}

/** One `link` source's values, and where they came from. */
export interface LinkSourceGroup {
  /** What each value is resolved against: the repository root for a
   * `--plan` file's and the repo defaults file's entries, the
   * invocation cwd for `--link`. */
  base: string;
  values: readonly string[];
  /** Set for a source that is a FILE in the repository, to the phrase
   * naming it (`the "link" list of /r/.agent-primitives.json`): each
   * merged value then carries `"<value>" named in <namedIn>`, which is
   * both the message fragment a refusal needs and the flag that marks
   * the value as repository content rather than something an operator
   * typed (see `link-policy.ts`). Absent for `--link`. */
  namedIn?: string;
}

/** One merged `link` value: the resolved absolute path, plus the
 * provenance phrase for a value repository content named. */
export interface MergedLink {
  value: string;
  namedBy?: string;
}

/**
 * Merges `link` values from several sources into one deduplicated list,
 * each source's own `values` resolved against its own `base` before
 * comparison (a `--plan` file's and the repo defaults file's `link`
 * entries are relative to the repository root; `--link` is relative to
 * the invocation cwd -- see the README's `--plan` and "repo defaults
 * file" sections). Groups are folded in the order given; a later
 * group's value that resolves to a path an earlier group already added
 * is dropped, never the other way around, so "later sources add, none
 * removes": every distinct resolved path from every group survives,
 * each exactly once, in first-seen order. A path several sources name
 * therefore keeps the FIRST source's provenance, which is the
 * conservative direction: the defaults file and the plan are checked
 * as repository content even when `--link` names the same path too.
 */
export function mergeLinkSources(
  groups: readonly LinkSourceGroup[],
): MergedLink[] {
  const seen = new Set<string>();
  const merged: MergedLink[] = [];
  for (const group of groups) {
    for (const value of group.values) {
      const abs = path.resolve(group.base, value);
      if (seen.has(abs)) continue;
      seen.add(abs);
      merged.push({
        value: abs,
        ...(group.namedIn !== undefined
          ? { namedBy: `"${value}" named in ${group.namedIn}` }
          : {}),
      });
    }
  }
  return merged;
}

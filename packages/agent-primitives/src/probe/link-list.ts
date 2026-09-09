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

/**
 * Merges `link` values from several sources into one deduplicated list,
 * each source's own `values` resolved against its own `base` before
 * comparison (a `--plan` file's and the repo defaults file's `link`
 * entries are relative to the repository root; `--link` is relative to
 * the invocation cwd -- see the README's `--plan` and "repo defaults
 * file" sections). Groups are folded in the order given; a later
 * group's value that resolves to a path an earlier group already added
 * is dropped, never the other way around, so "later sources add, none
 * removes" (D-006 task 6c7e1532): every distinct resolved path from
 * every group survives, each exactly once, in first-seen order.
 */
export function mergeLinkSources(
  groups: readonly { base: string; values: readonly string[] }[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const value of group.values) {
      const abs = path.resolve(group.base, value);
      if (seen.has(abs)) continue;
      seen.add(abs);
      merged.push(abs);
    }
  }
  return merged;
}

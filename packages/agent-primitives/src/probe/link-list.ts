import fs from "node:fs";
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
  /** The value exactly as its source gave it, before being resolved
   * against that source's `base`: a refusal (`linkSourceMissingMessage`
   * below) names both this and `value`, since "the value as given" and
   * "the absolute path it resolved to" are two different things a
   * reader needs, and the given form is what an operator (or a plan/
   * defaults-file author) actually typed. */
  given: string;
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
        given: value,
        ...(group.namedIn !== undefined
          ? { namedBy: `"${value}" named in ${group.namedIn}` }
          : {}),
      });
    }
  }
  return merged;
}

/**
 * Whether a merged `link` value's SOURCE exists as a directory, checked
 * for the three EXPLICIT sources only (`--link`, a `--plan` file's own
 * `link`, the repo defaults file's `link`) -- never for an
 * auto-discovered candidate (`node_modules`, a composer `vendor-dir`/
 * `bin-dir`), which keeps its own documented skip-when-absent behaviour,
 * decided entirely elsewhere (`link-policy.ts`/`isolation.ts`). The
 * caller (`index.ts`, `probe()` and `probePlan()` alike) runs this right
 * after `mergeLinkSources`, before the isolation copy is created (before
 * `openRunSetup`/`prepareWorktreeSession` ever runs): linking a source
 * that is not there is not a candidate to skip, the way an
 * auto-discovered one is -- it is a value an invocation, a `--plan`
 * file, or the repository itself explicitly named and cannot have,
 * which fails closed as a usage error instead of being linked anyway
 * (dangling) or silently dropped (see GitHub issue #242).
 *
 * Returns `undefined` when `link.value` exists and is a directory, else
 * the refusal message, which names all three parts a reader needs: the
 * value AS GIVEN (`link.given`, before it was resolved), the absolute
 * path it resolved to (`link.value`), and the phrase naming what it was
 * resolved against -- `basePhrase`, supplied by the caller, since only
 * the caller knows which base applies to this particular value
 * (`"the invocation cwd"` for `--link`, `"the repository root"` for a
 * `--plan` file's and the defaults file's entries; see the README's
 * `--link` and "Non-JS repositories" sections). A source that exists
 * but is a FILE, not a directory, is refused the same way, named
 * accordingly. A `stat` that fails for a reason OTHER than "not there"
 * (an ancestor directory locked against this process, `EACCES`; a
 * symlink loop, `ELOOP`; ...) is never reported as "does not exist" --
 * that would tell an operator to create a directory that may well
 * already be sitting right there behind a permission this process
 * cannot see through -- it is refused with its own phrase naming the
 * errno instead, equally fail-closed (this function still returns a
 * message, never `undefined`, so the source is never treated as fine
 * merely because it could not be checked).
 */
export function linkSourceMissingMessage(
  link: MergedLink,
  basePhrase: string,
): string | undefined {
  let stat: fs.Stats | undefined;
  let statErrorCode: string | undefined;
  try {
    stat = fs.statSync(link.value);
  } catch (err) {
    stat = undefined;
    statErrorCode =
      err instanceof Error && "code" in err && typeof err.code === "string"
        ? err.code
        : undefined;
  }
  if (stat !== undefined && stat.isDirectory()) return undefined;
  const problem =
    stat !== undefined
      ? "is not a directory"
      : statErrorCode === "ENOENT" || statErrorCode === "ENOTDIR"
        ? "does not exist"
        : `could not be checked (${statErrorCode ?? "unknown error"})`;
  const provenance = link.namedBy !== undefined ? ` (${link.namedBy})` : "";
  return (
    `link "${link.given}" resolved to ${link.value} against ` +
    `${basePhrase}, but that path ${problem}${provenance}`
  );
}

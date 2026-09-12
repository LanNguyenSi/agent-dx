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
  /** The phrase naming `base` for a reader (`"the repository root"`,
   * `"the invocation cwd"`), carried onto every `MergedLink` this group
   * contributes so a caller building a `link_source_not_found` message
   * never has to re-derive which base applied to which value from
   * `namedBy`'s mere presence or absence. */
  basePhrase: string;
  values: readonly string[];
  /** Set for a source that is a FILE in the repository, to the phrase
   * naming it (`the "link" list of /r/.agent-primitives.json`): each
   * merged value then carries `"<value>" named in <namedIn>`, which is
   * both the message fragment a refusal needs and the flag that marks
   * the value as repository content rather than something an operator
   * typed (see `link-policy.ts`). Absent for `--link`. */
  namedIn?: string;
  /** The "stop naming it" half of a `link_source_not_found` refusal's
   * remedy clause -- "remove the entry from <file>" for a
   * repository-content source, "drop --link" for the CLI flag -- carried
   * onto every `MergedLink` this group contributes the same way
   * `basePhrase` is. Deliberately just that half: the OTHER half (what
   * to do about the source itself, "create it" / "point it at a
   * directory" / "check its permissions") depends on WHICH way the
   * source is unusable, which only `linkSourceMissingMessage` knows
   * (the `fs.statSync` result), so it prefixes this clause with the
   * branch-appropriate half rather than this group naming one fixed
   * prefix for every branch. */
  remedy: string;
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
  /** The owning group's own `basePhrase`, copied here rather than
   * re-derived from `namedBy`. */
  basePhrase: string;
  namedBy?: string;
  /** The owning group's own `remedy` (the "stop naming it" half only,
   * see `LinkSourceGroup.remedy`), copied here the same way. */
  remedy: string;
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
        basePhrase: group.basePhrase,
        remedy: group.remedy,
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
 * resolved against -- `link.basePhrase`, carried by `mergeLinkSources`
 * from the owning group (`"the invocation cwd"` for `--link`, `"the
 * repository root"` for a `--plan` file's and the defaults file's
 * entries; see the README's `--link` and "Non-JS repositories"
 * sections). A source that exists but is a FILE, not a directory, is
 * refused the same way, named accordingly. A `stat` that fails for a
 * reason OTHER than "not there" (an ancestor directory locked against
 * this process, `EACCES`/`EPERM`; a symlink loop, `ELOOP`; ...) is never
 * reported as "does not exist" -- that would tell an operator to create
 * a directory that may well already be sitting right there behind a
 * permission this process cannot see through -- it is refused with its
 * own phrase naming the errno instead, equally fail-closed (this
 * function still returns a message, never `undefined`, so the source is
 * never treated as fine merely because it could not be checked). The
 * remedy prefixed onto `link.remedy` (see that field's own docblock for
 * why only the "stop naming it" half lives there) matches the branch: a
 * path that does not exist is told to "create it", one that is a plain
 * file is told to "point it at a directory" (creating a NEW directory
 * there would still leave the file in the way). The two remaining errno
 * shapes read differently by what a reader can actually act on: `EACCES`
 * and `EPERM` name a permission this process itself lacks, so those two
 * alone are told to "check its permissions" -- advising "create it"
 * there would be wrong on its face, since a permission this process
 * cannot see through may already have a directory sitting right there.
 * Every other errno, `ELOOP` (a symlink cycle) included, names something
 * a permission fix would not touch at all -- there is no permission to
 * grant against a path that cycles back on itself -- so those are told
 * instead to "check what the path resolves to", which is the actual
 * question a symlink cycle (or any other unrecognized failure) raises.
 */
export function linkSourceMissingMessage(link: MergedLink): string | undefined {
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
  const remedyPrefix =
    stat !== undefined
      ? "point it at a directory, or "
      : statErrorCode === "ENOENT" || statErrorCode === "ENOTDIR"
        ? "create it, or "
        : statErrorCode === "EACCES" || statErrorCode === "EPERM"
          ? "check its permissions, or "
          : "check what the path resolves to, or ";
  const provenance = link.namedBy !== undefined ? ` (${link.namedBy})` : "";
  return (
    `link "${link.given}" resolved to ${link.value} against ` +
    `${link.basePhrase}, but that path ${problem}${provenance}. ` +
    `${remedyPrefix}${link.remedy}.`
  );
}

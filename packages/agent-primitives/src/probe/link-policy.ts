import fs from "node:fs";
import path from "node:path";
import { isPathContained, resolveDeepestExisting } from "./containment.js";

/**
 * One directory something asked `beginWorktree` to symlink into the
 * isolation copy: an auto-discovered `node_modules`, a composer
 * project's `vendor-dir`/`bin-dir`, a `--plan` file's own `link`, the
 * repo defaults file's `link`, or an operator's `--link`.
 *
 * `absDir` is the path that will be handed to `fs.symlinkSync` as the
 * link's TARGET, and it is never resolved through realpath by the
 * policy: a `node_modules` that is itself a symlink to a directory
 * outside the repository (this is what a worktree provisioned by
 * symlinking a sibling checkout's install looks like) must reach the
 * copy as the same symlink the real tree has, not be refused for where
 * its target happens to live. See `linkRelPath` for how the policy
 * judges WHERE a candidate sits instead.
 */
export interface LinkCandidate {
  /** Absolute path of the directory to link, as it will be symlinked. */
  absDir: string;
  /**
   * Set exactly when repository content named this directory (a
   * composer `config` value, a `--plan` file's `link` entry, the repo
   * defaults file's `link` entry), to the phrase naming the entry and
   * the file it came from: `"." named in "bin-dir" of /r/composer.json`.
   * Its presence is also what makes rule 4 (below) apply, so it is a
   * provenance FLAG as much as a message fragment: an operator's own
   * `--link` leaves it unset and keeps its latitude.
   */
  namedBy?: string;
}

/** A candidate the policy accepted, with the worktree-relative path it
 * will be created at. */
export interface PlannedLink {
  candidate: LinkCandidate;
  /** Destination path inside the copy, relative to the copy's root. */
  relPath: string;
}

export interface LinkPolicyContext {
  /** The repository root, already resolved through realpath. */
  rootReal: string;
  /**
   * Every worktree-relative path the copy must keep as a real
   * directory of its own: the run's mapped cwd, and the directory of
   * every file the run mutates. A candidate that is one of these, or
   * an ancestor of one, is refused (rule 2): linking it replaces that
   * part of the CHECKOUT with a symlink to the source tree, and the
   * mutant is then written to the operator's real file. The copy's own
   * root (`""`) never needs to be listed here: no other path can
   * contain it, and the candidate that IS the root is refused by the
   * rule above this one.
   */
  protectedRelPaths: readonly string[];
  /**
   * Whether git tracks anything at or under this worktree-relative
   * path. Consulted only for a file-sourced candidate (rule 3); the
   * caller computes it (one `git ls-files` listing) so this function
   * stays a pure decision over already-collected facts. Always asked
   * with a path `canonicalRelPath` has already spelled, since the
   * caller's listing is restricted to those same spellings.
   */
  isTrackedPath: (relPath: string) => boolean;
  /**
   * The isolation copy's OWN spelling of a destination (see
   * `canonicalDestRelPath`, which is what `beginWorktree` passes here).
   * Rules 2 and 3 are decided on what it returns, never on the source
   * tree's spelling alone: on a case-insensitive filesystem `SRC` and
   * `src` are one directory, so a candidate spelled the first way
   * compares as a different string against every protected and tracked
   * path while naming exactly the directory they name.
   *
   * Required rather than optional with an identity default: a caller
   * that forgets it would silently get the string comparison this
   * function exists to replace, which fails OPEN (a candidate accepted
   * because its spelling differed), and that is the one direction that
   * reaches the source tree.
   */
  canonicalRelPath: (relPath: string) => string;
}

export interface LinkPlan {
  /** Accepted candidates, in the order they were evaluated. */
  links: PlannedLink[];
  /** One line per refused or skipped candidate, in evaluation order. */
  warnings: string[];
}

/**
 * Where a candidate SITS, relative to the repository root: its parent
 * resolved through realpath with its own last segment re-appended
 * verbatim, then relativized against `rootReal`. Returns `undefined`
 * when the candidate does not sit under the root at all.
 *
 * Resolving the parent (and only the parent) is the whole point: the
 * parent chain must be resolved or a repository reached through a
 * symlinked ancestor (macOS's `/tmp` -> `/private/tmp`, a symlinked
 * checkout path) compares an unresolved candidate against a resolved
 * root and every link silently drops; the candidate's own last segment
 * must NOT be resolved or a `node_modules` symlinked to a sibling
 * checkout reads as "outside the root" and is refused, which is a
 * regression against a copy that simply carries the same symlink the
 * real tree has.
 */
export function linkRelPath(
  absDir: string,
  rootReal: string,
): string | undefined {
  const parent = path.dirname(absDir);
  const location =
    parent === absDir
      ? absDir // the filesystem root has no parent to resolve
      : path.join(resolveDeepestExisting(parent), path.basename(absDir));
  const rel = path.relative(rootReal, location);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel;
}

/** Whether `rel` is `ancestorRel` itself or sits under it, both
 * worktree-relative (`""` is the copy's own root, which contains
 * everything). Deliberately a comparison of DESTINATION paths, never of
 * realpath'd targets: what makes nesting dangerous is one link's
 * `rmSync`/`symlinkSync` resolving through another link this same loop
 * already created at an ancestor destination, which is a property of
 * where the two links are CREATED, not of what they point at. Two
 * distinct in-repo symlinks pointing at one shared target are two
 * independent destinations and both belong in the copy.
 *
 * The separator in the prefix test is load-bearing in BOTH directions:
 * without it `src-cache/app` reads as sitting under `src` (so a
 * perfectly linkable sibling is refused) and `vendor-bin` reads as
 * sitting under `vendor` (so a second, independent install is dropped
 * as already covered). Exported for `beginWorktree`, which re-applies
 * the nesting rule against the links it has actually created. */
export function relContains(ancestorRel: string, rel: string): boolean {
  if (ancestorRel === "") return true;
  if (ancestorRel === rel) return true;
  return rel.startsWith(ancestorRel + path.sep);
}

/**
 * The isolation copy's OWN spelling of a destination: `wtReal` is the
 * copy's root as `fs.realpathSync` reports it, `relPath` the
 * worktree-relative path a candidate would be linked at, built from the
 * SOURCE tree's spelling of that candidate (`linkRelPath`).
 *
 * The copy's filesystem is not obliged to agree with that spelling. On
 * a case-insensitive filesystem (APFS and HFS+ by default, NTFS) `SRC`
 * and `src` are one directory, so a `vendor-dir` of `SRC` names the
 * copy's own `src` while comparing as a different string against every
 * protected and tracked path. `fs.realpathSync` does not close that
 * gap: measured on APFS, it returns the spelling it was GIVEN for a
 * plain directory (`.../SRC` stays `.../SRC`), and only a symlink in
 * the path is genuinely resolved. What does close it is the directory
 * entry itself: `lstat` of the alias and of the real entry report the
 * same `ino`/`dev`, and `readdir` reports the name the directory really
 * carries, so scanning the parent for the entry with that identity
 * yields the copy's own name for the destination.
 *
 * Only the FINAL component is canonicalised that way; the parent chain
 * is resolved through `realpath` instead, which follows symlinks but
 * leaves case alone. A case-variant spelling of a parent therefore
 * still compares as a different string here (`SRC/sub` stays
 * `SRC/sub`), and what catches that shape is not this function but the
 * postcondition `beginWorktree` runs once the links are created: the
 * mapped cwd and every mutated path must still resolve inside the copy.
 * See the README's isolation limitations.
 *
 * Returns `relPath` unchanged when the destination's parent does not
 * sit inside the copy at all (the caller's own containment check is
 * what decides about that shape) and when nothing exists at the
 * destination under any spelling, which is the ordinary case for the
 * gitignored runtime directories these links exist for: there is no
 * on-disk name to read, and the planned one is the name the link will
 * be created under.
 */
export function canonicalDestRelPath(wtReal: string, relPath: string): string {
  const dest = path.join(wtReal, relPath);
  const parent = path.dirname(dest);
  const parentRel = path.relative(wtReal, resolveDeepestExisting(parent));
  if (parentRel.startsWith("..") || path.isAbsolute(parentRel)) return relPath;
  let name = path.basename(dest);
  try {
    const destStat = fs.lstatSync(dest);
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const entryStat = fs.lstatSync(path.join(parent, entry.name));
      if (entryStat.ino === destStat.ino && entryStat.dev === destStat.dev) {
        name = entry.name;
        break;
      }
    }
  } catch {
    // Nothing exists at `dest` under any spelling (or the parent cannot
    // be listed): the planned name is the one the link gets.
  }
  return parentRel === "" ? name : path.join(parentRel, name);
}

/** The one warning format every refusal and skip uses: what was
 * skipped, who named it (for a file-sourced candidate), and why.
 * Exported so the link loop in `beginWorktree`, which refuses a
 * candidate the plan accepted when the copy's own filesystem turns out
 * to disagree with it, reports in this same format rather than a second
 * one of its own. */
export function skippedLinkWarning(
  candidate: LinkCandidate,
  reason: string,
): string {
  const source =
    candidate.namedBy === undefined ? "" : ` (${candidate.namedBy})`;
  return `skipped linking ${candidate.absDir}${source}: ${reason}`;
}

/**
 * The link policy: decides, for EVERY candidate and before any
 * filesystem action, whether it may be symlinked into the isolation
 * copy and where. `beginWorktree` performs the accepted links and
 * nothing else; a candidate this function does not return is never
 * `rmSync`'d, never `symlinkSync`'d, and never reached at all.
 *
 * That order is the point. Each link is an `rmSync` followed by a
 * `symlinkSync` at a path inside the copy, and both syscalls resolve
 * symlinks in the path they are given: a destination that is the copy's
 * own root, that contains a file the run mutates, or that sits under a
 * link this loop already created, does not delete or replace something
 * in the copy at all -- it reaches straight back into the operator's
 * real source tree. A check applied after such a call has already lost.
 *
 * What this function decides is only half of the guarantee, and it says
 * so where it matters below: every rule here compares PATHS, while the
 * three syscalls that create a link resolve them on a filesystem that
 * may spell them differently (see `canonicalDestRelPath`) and that the
 * loop's own earlier links have meanwhile changed. Rules 2 and 3 are
 * therefore decided on the copy's own spelling, and `beginWorktree`
 * re-checks containment immediately before each of its syscalls and
 * asserts a postcondition afterwards. Neither replaces the other: a
 * decision taken up front is what keeps a dangerous candidate from
 * being touched at all, and the syscall-time check is what keeps a
 * decision that was right when it was taken from being wrong by the
 * time it is acted on.
 *
 * Four rules, in this order, each skip a warning and never a silent
 * drop:
 *
 * 1. Containment, judged on where the candidate SITS (`linkRelPath`),
 *    never on where a symlinked candidate POINTS. A candidate outside
 *    the repository root is skipped. A candidate repository content
 *    named (`namedBy`) must additionally RESOLVE inside the root: a
 *    gitignored `esc -> ..` a `composer.json` points its `vendor-dir`
 *    at sits inside the repository and leaves it, and repository
 *    content gets no such latitude. The latitude rule 1 does grant --
 *    a `node_modules` symlinked to a sibling checkout's install, linked
 *    as the same symlink the real tree carries -- belongs to a
 *    candidate the walk found on disk, which names no path at all.
 * 2. The copy's root itself is never linked (a candidate whose relative
 *    path is empty), and neither is any candidate that contains the
 *    run's mapped cwd or the directory of a file the run mutates: those
 *    paths must stay real directories in the copy, or the run's own
 *    writes land in the source tree.
 * 3. A candidate repository content named (`namedBy`) may only name a
 *    directory git does not track. These inputs exist for gitignored
 *    runtime output (`vendor/`, `node_modules/`, a tool cache); a
 *    tracked directory is SOURCE, and source must be copied into the
 *    isolation copy, not shared with the tree being isolated from. An
 *    operator's own `--link` keeps its latitude here (rules 1, 2 and 4
 *    still apply to it).
 * 4. Nesting: a candidate whose destination is at or under a
 *    destination this run already linked is skipped as already covered
 *    -- the only shape whose `rmSync`/`symlinkSync` would resolve
 *    through a link this loop itself created. Judged here on the
 *    planned destinations, and re-judged by `beginWorktree` against the
 *    links it has actually created, in the copy's own spelling.
 */
export function planLinks(
  candidates: readonly LinkCandidate[],
  ctx: LinkPolicyContext,
): LinkPlan {
  const links: PlannedLink[] = [];
  const warnings: string[] = [];
  for (const candidate of candidates) {
    const relPath = linkRelPath(candidate.absDir, ctx.rootReal);
    if (relPath === undefined) {
      warnings.push(
        skippedLinkWarning(
          candidate,
          "it does not sit inside the repository root",
        ),
      );
      continue;
    }
    if (relPath === "") {
      warnings.push(
        skippedLinkWarning(
          candidate,
          "it is the repository root itself; linking it would replace the " +
            "isolation copy with the source tree",
        ),
      );
      continue;
    }
    if (
      candidate.namedBy !== undefined &&
      !isPathContained(ctx.rootReal, resolveDeepestExisting(candidate.absDir))
    ) {
      warnings.push(
        skippedLinkWarning(
          candidate,
          "it resolves outside the repository root; a directory named by " +
            "repository content must both sit inside the root and resolve " +
            "inside it",
        ),
      );
      continue;
    }
    // The copy's own spelling, from here on: rules 2 and 3 are about
    // which DIRECTORY OF THE COPY a candidate names, and a string that
    // merely differs in case names the same one.
    const canonicalRel = ctx.canonicalRelPath(relPath);
    const protectedRel = ctx.protectedRelPaths.find((p) =>
      relContains(canonicalRel, p),
    );
    if (protectedRel !== undefined) {
      warnings.push(
        skippedLinkWarning(
          candidate,
          `the isolation copy's own ${protectedRel} sits inside it, and must ` +
            "stay a real directory in the copy",
        ),
      );
      continue;
    }
    if (candidate.namedBy !== undefined && ctx.isTrackedPath(canonicalRel)) {
      warnings.push(
        skippedLinkWarning(
          candidate,
          "git tracks it; a directory named by repository content is only " +
            "linked when git does not track it (these inputs exist for " +
            "gitignored runtime output, and tracked source is copied into " +
            "the isolation copy rather than shared with the source tree)",
        ),
      );
      continue;
    }
    const covering = links.find((planned) =>
      relContains(planned.relPath, relPath),
    );
    if (covering !== undefined) {
      warnings.push(
        skippedLinkWarning(
          candidate,
          `it is already covered by ${covering.relPath}, linked earlier in this run`,
        ),
      );
      continue;
    }
    links.push({ candidate, relPath });
  }
  return { links, warnings };
}

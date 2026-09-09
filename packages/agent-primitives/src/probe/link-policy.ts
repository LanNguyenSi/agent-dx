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
  /**
   * Set exactly when the auto-discovery walk found this directory on
   * disk (a `node_modules`), rather than any text naming a path: a
   * composer `vendor-dir`/`bin-dir` carries `namedBy` instead, and an
   * operator's own `--link` carries neither. The two flags together are
   * what separate the candidates rule 3 questions from the one it
   * leaves its latitude to (`hasOperatorLatitude`).
   */
  discovered?: true;
}

/**
 * Whether rule 3 leaves this candidate its latitude: true only for a
 * path an operator typed on the command line (`--link`), which carries
 * neither provenance flag. A directory repository content named
 * (`namedBy`) and one the walk found on disk (`discovered`) are both
 * asked what git tracks; the operator's own is not, and the README's
 * rule 3 says what that latitude costs.
 *
 * One exported predicate rather than the condition written out at each
 * site, because `beginWorktree` builds its single `git ls-files`
 * listing from EXACTLY the candidates this function will be asked
 * about: a candidate the policy questions but the listing never covered
 * comes back "untracked" for want of a pathspec, which is the direction
 * that reaches the source tree.
 */
export function hasOperatorLatitude(candidate: LinkCandidate): boolean {
  return candidate.namedBy === undefined && candidate.discovered !== true;
}

/** A candidate the policy accepted, with the worktree-relative path it
 * will be created at. */
export interface PlannedLink {
  candidate: LinkCandidate;
  /** Destination path inside the copy, relative to the copy's root, in
   * the SOURCE tree's own spelling: the path the link is created at. */
  relPath: string;
  /** The same destination in the COPY's spelling
   * (`canonicalDestRelPath`), which is what rules 2, 3 and 4 are decided
   * on. Kept on the accepted link so a later candidate's nesting check
   * compares two paths the copy agrees about, rather than two source
   * spellings that may name one directory. */
  canonicalRelPath: string;
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
   * The SOURCE tree's OWN spelling of a path relative to the repository
   * root: the same per-segment identity read `canonicalRelPath` performs
   * for the copy, anchored at the root instead (`beginWorktree` passes
   * `canonicalDestRelPath` bound to `rootReal`).
   *
   * Asked about the resolved TARGET of a candidate, and needed for the
   * same reason the destination side needs its own: `realpath` hands a
   * target back in the spelling it was GIVEN, so a `vendor-dir` of `SRC`
   * resolves to `<root>/SRC` and git's case-sensitive index reports that
   * spelling as untracked while naming exactly the tracked `src` the
   * repository really carries.
   *
   * Required rather than optional with an identity default, for the same
   * reason `canonicalRelPath` is: the default would silently be the
   * string comparison this exists to replace, and it fails OPEN.
   */
  canonicalRootRelPath: (relPath: string) => string;
  /**
   * The isolation copy's OWN spelling of a destination (see
   * `canonicalDestRelPath`, which is what `beginWorktree` passes here).
   * Rules 2, 3 and 4 are decided on what it returns, never on the
   * source tree's spelling alone: on a case-insensitive filesystem
   * `SRC` and `src` are one directory, so a candidate spelled the first
   * way compares as a different string against every protected and
   * tracked path, and against every destination already planned, while
   * naming exactly the directory they name.
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
 * Canonicalised PER SEGMENT, the whole chain, starting from `wtReal`:
 * each segment is read back by that same entry identity inside the
 * directory the segments before it named, and the next segment is
 * looked up under the name that came back. Resolving the parent chain
 * through `realpath` instead (which follows symlinks but leaves case
 * alone) is what used to make a case-variant PARENT invisible: `SRC/sub`
 * stayed `SRC/sub`, so it compared as a different string against the
 * tracked `src/sub` in rules 2 and 3 and against the `:(literal)`
 * pathspecs of the caller's `git ls-files` listing, while naming exactly
 * the directory those paths name. Symlinks are still followed, because
 * looking a segment up inside the directory the previous ones named is
 * an ordinary path lookup: a chain that leaves the copy through a
 * symlink reports the names it finds at the other end, and whether such
 * a destination may be linked at all is the caller's containment check,
 * not this function's.
 *
 * From the first segment that does not exist, the remaining segments are
 * returned as given. That fallback is safe rather than merely
 * convenient: nothing is on disk there under any spelling, so there is
 * no entry that could alias it, and the name the link is created under
 * is the planned one. It is also the ordinary case for the gitignored
 * runtime directories these links exist for. A segment that DOES exist
 * but whose parent cannot be listed keeps its given spelling too and the
 * walk goes on through it: the path still resolves, only the on-disk
 * name is unreadable.
 */
export function canonicalDestRelPath(wtReal: string, relPath: string): string {
  const canonical: string[] = [];
  let parent = wtReal;
  let missing = false;
  for (const segment of relPath.split(path.sep).filter((s) => s.length > 0)) {
    if (missing) {
      canonical.push(segment);
      continue;
    }
    const name = canonicalEntryName(parent, segment);
    if (name === undefined) {
      missing = true;
      canonical.push(segment);
      continue;
    }
    canonical.push(name);
    parent = path.join(parent, name);
  }
  return canonical.join(path.sep);
}

/**
 * How `resolved` relates to `base`, decided by FILESYSTEM IDENTITY
 * rather than by comparing path strings: `"same"` when the two paths
 * name one directory, `"contains"` when `resolved` is an ancestor of
 * `base`, and `undefined` for every other relation (including a
 * `resolved` that is not on disk at all).
 *
 * The string comparison this replaces does not merely miss cases, it
 * fails OPEN, which is the one direction that reaches the operator's
 * tree. `fs.realpathSync` resolves symlinks and nothing else: measured
 * on APFS, it normalises neither CASE (`/base/REPO` comes back as
 * `/base/REPO` for a directory really named `repo`) nor Unicode FORM (an
 * NFD spelling of an NFC directory name comes back NFD). A gitignored
 * `node_modules -> ../REPO`, or one whose absolute target spells an
 * ANCESTOR segment in another case, therefore resolves TO the
 * repository root while comparing as a path outside it, and linking it
 * hands the isolation copy the whole source tree under that name.
 *
 * `ino`/`dev` is what the destination side of this same module already
 * decides on (`canonicalEntryName`), against the same aliasing, and this
 * is the target side of it. The `"contains"` half walks `base`'s own
 * ancestors up to the filesystem root and compares identity at each
 * step, rather than testing one string for a prefix of the other:
 * `base` is already realpath'd, so each of its ancestors is a real
 * directory, and any alias of one of them is that same entry under
 * another spelling. Directories cannot be hard-linked, so for the
 * directories this decides about, one `ino`/`dev` is one directory.
 *
 * The plain string comparison is kept ahead of the syscalls as a
 * pre-filter: it answers the ordinary case without touching the
 * filesystem, and it is the only thing that CAN answer for a `resolved`
 * that does not exist (there is nothing to stat, and nothing to write
 * through either).
 */
export type EntryRelation = "same" | "contains";

export function entryRelationTo(
  resolved: string,
  base: string,
): EntryRelation | undefined {
  if (resolved === base) return "same";
  if (isPathContained(resolved, base)) return "contains";
  const resolvedId = entryIdentity(resolved);
  if (resolvedId === undefined) return undefined;
  if (sameEntry(resolvedId, entryIdentity(base))) return "same";
  let dir = path.dirname(base);
  while (true) {
    if (sameEntry(resolvedId, entryIdentity(dir))) return "contains";
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Where a candidate's resolved TARGET sits inside the repository, as a
 * path relative to `rootReal`, or `undefined` when it does not sit
 * inside the root at all; `""` is the root itself. This is the TARGET
 * side of the question `linkRelPath` answers for where a candidate
 * SITS, and `resolvedTarget` is what `resolveDeepestExisting` made of
 * the candidate: symlinks followed, a missing tail re-appended
 * verbatim, so the path named is the candidate's own target rather than
 * whichever ancestor of it happens to exist.
 *
 * It cannot be a `path.relative` against `rootReal`, for the reason
 * `entryRelationTo` gives: `realpath` resolves symlinks and normalises
 * neither case nor Unicode form, so a `node_modules -> ../REPO/src` for
 * a directory really named `repo` resolves INTO the root while spelling
 * a path outside it (measured on APFS), and a plain relativize reads it
 * as outside and asks git nothing at all -- which is the direction that
 * reaches the source tree. The target's ancestors are walked instead
 * and compared to the root by filesystem IDENTITY, the segments walked
 * past collected as the relative path.
 *
 * The spelling that comes back is the TARGET's own, which need not be
 * the source tree's: `LinkPolicyContext.canonicalRootRelPath` is what
 * turns it into the name git's index carries.
 */
export function linkTargetRelPath(
  resolvedTarget: string,
  rootReal: string,
): string | undefined {
  const rootId = entryIdentity(rootReal);
  const segments: string[] = [];
  let dir = resolvedTarget;
  while (true) {
    if (dir === rootReal) return segments.join(path.sep);
    const dirId = entryIdentity(dir);
    if (dirId !== undefined && sameEntry(dirId, rootId)) {
      return segments.join(path.sep);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    segments.unshift(path.basename(dir));
    dir = parent;
  }
}

/** `ino`/`dev` of what `p` resolves to -- symlinks followed, the same
 * way the syscalls that create a link follow them -- or `undefined` when
 * nothing is there to identify. */
function entryIdentity(p: string): { ino: number; dev: number } | undefined {
  try {
    const stat = fs.statSync(p);
    return { ino: stat.ino, dev: stat.dev };
  } catch {
    return undefined;
  }
}

/** Two entries are the same entry only when they agree on BOTH halves.
 * The `dev` half is defensive rather than exercised: an `ino` repeats
 * across filesystems, so without it a candidate on a second volume that
 * happened to carry the root's inode number would read as the root
 * itself. Reproducing that needs a second device (a disk image, a
 * mount), which no fixture in this package sets up, so the half is
 * documented here rather than pinned by a test -- the same standing as
 * the `dev` half of `canonicalEntryName`'s own identity check. */
function sameEntry(
  a: { ino: number; dev: number },
  b: { ino: number; dev: number } | undefined,
): boolean {
  return b !== undefined && a.ino === b.ino && a.dev === b.dev;
}

/** The name the directory entry `parent`/`name` really carries, found by
 * `ino`/`dev` identity among `parent`'s entries; `name` itself when the
 * entry exists but `parent` cannot be listed, and `undefined` when
 * nothing is there under any spelling. Split out so
 * `canonicalDestRelPath` can tell those last two apart: one keeps
 * walking, the other stops looking.
 *
 * The `dev` half is defensive rather than exercised. Every entry
 * compared here is a child of one directory, so all of them are on one
 * filesystem already and `ino` alone decides in practice; `dev` is what
 * keeps that from being an assumption a mount point inside the copy
 * could quietly break. Pinning it would need a second device (a disk
 * image, a mount), which no fixture in this package sets up, so it is
 * documented rather than tested. */
function canonicalEntryName(parent: string, name: string): string | undefined {
  let target: fs.Stats;
  try {
    target = fs.lstatSync(path.join(parent, name));
  } catch {
    return undefined;
  }
  try {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const entryStat = fs.lstatSync(path.join(parent, entry.name));
      if (entryStat.ino === target.ino && entryStat.dev === target.dev) {
        return entry.name;
      }
    }
  } catch {
    // The parent cannot be listed; the given spelling reaches the same
    // entry the syscalls will.
  }
  return name;
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
 *    candidate the walk found on disk, which names no path at all, and
 *    it is latitude for a target pointing AWAY from the root, or at an
 *    untracked directory inside it, and no further: a candidate of ANY
 *    source that resolves TO the root, or to a directory containing it
 *    (`esc -> .`, `node_modules -> .`), is skipped here, and one that
 *    resolves to TRACKED source inside the root (`node_modules -> src`)
 *    is skipped by rule 3 below, since linking either puts the source
 *    tree inside the copy under that name and every write through it
 *    lands in the real tree.
 *    Both halves of that -- IS the root, CONTAINS the root -- are
 *    decided by filesystem identity (`entryRelationTo`), never by
 *    comparing the two resolved path strings: realpath normalises
 *    neither case nor Unicode form, so `node_modules -> ../REPO` for a
 *    directory really named `repo` is the same shape as
 *    `node_modules -> ..` under a spelling no string comparison sees.
 * 2. The copy's root itself is never linked (a candidate whose relative
 *    path is empty), and neither is any candidate that contains the
 *    run's mapped cwd or the directory of a file the run mutates: those
 *    paths must stay real directories in the copy, or the run's own
 *    writes land in the source tree.
 * 3. What git tracks is never shared, asked in two places. A candidate
 *    repository content named (`namedBy`) may only name a DESTINATION
 *    git does not track; and no candidate except an operator's own
 *    `--link` (`hasOperatorLatitude`) may point AT something git tracks,
 *    whatever name it sits under. These inputs exist for gitignored
 *    runtime output (`vendor/`, `node_modules/`, a tool cache); a
 *    tracked directory is SOURCE, and source must be copied into the
 *    isolation copy, not shared with the tree being isolated from. The
 *    target half is what the auto-discovery lane needs: a gitignored (or
 *    committed) `node_modules -> src`, and a `node_modules` git tracks
 *    as a directory of its own, both sit under a name the rules above
 *    have nothing to say about while handing the copy the operator's
 *    real source. Only a target INSIDE the root is asked about, by
 *    filesystem identity (`linkTargetRelPath`): a target outside it is
 *    rule 1's latitude and is not this repository's source at all. An
 *    operator's own `--link` keeps its latitude for both halves (rules
 *    1, 2 and 4 still apply to it).
 * 4. Nesting: a candidate whose destination is at or under a
 *    destination this run already linked is skipped as already covered
 *    -- the only shape whose `rmSync`/`symlinkSync` would resolve
 *    through a link this loop itself created. Judged on the planned
 *    destinations in the copy's own spelling (both sides of the
 *    comparison, so a case variant of an already-planned destination
 *    is seen as the same directory), and re-judged by `beginWorktree`
 *    against the links it has actually created.
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
    const resolved = resolveDeepestExisting(candidate.absDir);
    if (
      candidate.namedBy !== undefined &&
      !isPathContained(ctx.rootReal, resolved)
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
    // Where a candidate RESOLVES may be the root itself, or an ancestor
    // of it, while it SITS inside the root under a name of its own: a
    // gitignored `esc -> .` (or a `node_modules -> .`) passes both rules
    // above, and linking it hands the copy the whole source tree at that
    // name, so every `--pre` write through it lands in the operator's
    // real root. This applies to EVERY source, including a candidate the
    // walk found on disk: rule 1's latitude is for a target pointing
    // AWAY from the root (a sibling checkout's install, linked as the
    // same symlink the real tree carries), never for one pointing at it.
    // Decided by filesystem IDENTITY (`entryRelationTo`), never by
    // comparing the two realpath strings: realpath normalises neither
    // case nor Unicode form, so a `node_modules -> ../REPO` for a
    // directory really named `repo` resolves to the root while spelling
    // a path outside it.
    const rootRelation = entryRelationTo(resolved, ctx.rootReal);
    if (rootRelation !== undefined) {
      warnings.push(
        skippedLinkWarning(
          candidate,
          rootRelation === "same"
            ? "it resolves to the repository root itself; linking it would " +
                "put the source tree inside the isolation copy"
            : `it resolves to ${resolved}, which contains the repository ` +
                "root; linking it would put the source tree inside the " +
                "isolation copy",
        ),
      );
      continue;
    }
    // The copy's own spelling, from here on: rules 2, 3 and 4 are about
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
    // Rule 3's other half, and the reason the auto-discovery lane needs
    // one at all: what a candidate POINTS AT can be tracked source even
    // when the name it sits under is neither tracked nor protected. A
    // gitignored `node_modules -> src`, the same link committed, and a
    // `node_modules` git tracks as a directory of its own all reach here
    // past every rule above, and linking any of them puts the operator's
    // real source inside the copy under that name -- every `--pre` write
    // through it then lands in the tree this run exists to isolate from.
    // Asked of every candidate but an operator's own `--link`, and only
    // about a target that sits INSIDE the root: a target outside it (a
    // sibling checkout's install) is the latitude rule 1 grants, and an
    // untracked one inside it (a hoisted monorepo install, a shared
    // cache) is exactly what these links exist for. Both the containment
    // and the spelling are decided by filesystem identity, never by
    // relativizing two realpath strings: `node_modules -> ../REPO/src`
    // for a directory really named `repo` resolves into the root while
    // spelling a path outside it, and `-> SRC` names the tracked `src`
    // under a spelling git's case-sensitive index calls untracked.
    if (!hasOperatorLatitude(candidate)) {
      const targetRel = linkTargetRelPath(resolved, ctx.rootReal);
      if (
        targetRel !== undefined &&
        targetRel !== "" &&
        ctx.isTrackedPath(ctx.canonicalRootRelPath(targetRel))
      ) {
        warnings.push(
          skippedLinkWarning(
            candidate,
            `git tracks its target ${resolved}; source is copied into the ` +
              "isolation copy, never shared with the tree being isolated " +
              "from, so every write through such a link would land in the " +
              "source tree",
          ),
        );
        continue;
      }
    }
    const covering = links.find((planned) =>
      relContains(planned.canonicalRelPath, canonicalRel),
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
    links.push({ candidate, relPath, canonicalRelPath: canonicalRel });
  }
  return { links, warnings };
}

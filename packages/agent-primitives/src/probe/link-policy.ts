import path from "node:path";
import { resolveDeepestExisting } from "./containment.js";

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
   * path. Consulted only for a file-sourced candidate (rule 4); the
   * caller computes it (one `git ls-files` listing) so this function
   * stays a pure decision over already-collected facts.
   */
  isTrackedPath: (relPath: string) => boolean;
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
 * independent destinations and both belong in the copy. */
function relContains(ancestorRel: string, rel: string): boolean {
  if (ancestorRel === "") return true;
  if (ancestorRel === rel) return true;
  return rel.startsWith(ancestorRel + path.sep);
}

/** The one warning format every refusal and skip below uses: what was
 * skipped, who named it (for a file-sourced candidate), and why. */
function skipped(candidate: LinkCandidate, reason: string): string {
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
 * Four rules, in this order, each skip a warning and never a silent
 * drop:
 *
 * 1. Containment, judged on where the candidate SITS (`linkRelPath`),
 *    never on where a symlinked candidate POINTS. A candidate outside
 *    the repository root is skipped.
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
 *    through a link this loop itself created.
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
        skipped(candidate, "it does not sit inside the repository root"),
      );
      continue;
    }
    if (relPath === "") {
      warnings.push(
        skipped(
          candidate,
          "it is the repository root itself; linking it would replace the " +
            "isolation copy with the source tree",
        ),
      );
      continue;
    }
    const protectedRel = ctx.protectedRelPaths.find((p) =>
      relContains(relPath, p),
    );
    if (protectedRel !== undefined) {
      warnings.push(
        skipped(
          candidate,
          `the isolation copy's own ${protectedRel} sits inside it, and must ` +
            "stay a real directory in the copy",
        ),
      );
      continue;
    }
    if (candidate.namedBy !== undefined && ctx.isTrackedPath(relPath)) {
      warnings.push(
        skipped(
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
        skipped(
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

import fs from "node:fs";
import crypto from "node:crypto";

/** One released version of the packaged skill asset
 * (`assets/skill/SKILL.md`), named by the `agent-primitives/v<version>`
 * tag that shipped it, alongside the SHA-256 content digest of the file at
 * that tag. */
export interface SkillLedgerEntry {
  version: string;
  sha256: string;
}

interface SkillLedgerFile {
  asset: string;
  digests: SkillLedgerEntry[];
}

/** Loading the checked-in ledger without throwing: `entries` is what
 * `init()` should treat the ledger as; `warning` is set exactly when
 * something about the on-disk file kept some or all of it from loading,
 * so a caller can surface that on `InitResult.warnings` without failing
 * the run. */
export interface SkillLedgerLoadResult {
  entries: SkillLedgerEntry[];
  warning?: string;
}

/**
 * SHA-256 hex digest of `content`, read as UTF-8 text (the same encoding
 * `init` itself reads and writes the skill file with), so a digest
 * computed here always matches one computed by `shasum -a 256` against
 * the same file's bytes for a UTF-8-clean text file.
 */
export function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function ledgerUrl(): URL {
  return new URL("../../assets/skill-ledger.json", import.meta.url);
}

/**
 * Reads the checked-in ledger of every `assets/skill/SKILL.md` digest this
 * package has released (`assets/skill-ledger.json`). Resolved relative to
 * this module's own compiled location the same way `readPackagedSkill`
 * (`../index.ts`) resolves the asset itself
 * (`dist/init/ledger.js` -> `../../assets/skill-ledger.json`, two levels
 * up to the package root), so the same relative path resolves correctly
 * whether this file is running from `dist/` or, via `tsx`, from `src/`
 * directly.
 *
 * Maintaining the ledger, primary case (an in-progress change to
 * `assets/skill/SKILL.md`, not yet released): the SAME change that edits
 * the asset appends one `{ version, sha256 }` entry to this file, labelled
 * with the version being prepared for the next release, digest computed
 * with `shasum -a 256` against the edited asset. If the asset changes
 * again before that version ships, the pending entry is REPLACED in
 * place, never joined by a second one for the same unreleased version: at
 * most the last entry may ever be rewritten, and only while its version
 * is still unreleased. An entry for a version that has already shipped is
 * immutable; recompute it, if ever needed, from that version's
 * `agent-primitives/v<x>` tag (`git show
 * agent-primitives/v<x>:packages/agent-primitives/assets/skill/SKILL.md |
 * shasum -a 256`) or, for a published release without a tag, from its
 * published tarball (`npm pack <name>@<version>`, then hash the unpacked
 * `package/assets/skill/SKILL.md`). The ledger-completeness test
 * (`test/skill-ledger.test.ts`) reads this file with `readSkillLedger`,
 * which stays strict (throws on a missing or malformed file, never
 * degrades), and fails the moment the digest of the asset actually in the
 * tree is not the ledger's LAST entry, so a change to the asset without
 * appending or replacing that last entry is caught before it ships; the
 * same test also pins the entries to strictly ascending semver order with
 * differing adjacent digests, so an append with an unchanged asset (a
 * likely copy-paste mistake) fails too.
 *
 * `init()` itself never calls this strict reader directly: it uses
 * `readSkillLedgerSafe` below, which never throws, so a missing or
 * corrupted ledger degrades `init` rather than crashing it.
 */
export function readSkillLedger(): SkillLedgerEntry[] {
  const raw = fs.readFileSync(ledgerUrl(), "utf8");
  const parsed = JSON.parse(raw) as SkillLedgerFile;
  return parsed.digests;
}

/** True exactly for an object shaped like `{ version: string, sha256: 64
 * lowercase hex }`, the shape `readSkillLedgerSafe` requires of every
 * entry it keeps. */
function isWellFormedEntry(value: unknown): value is SkillLedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.version === "string" &&
    typeof candidate.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.sha256)
  );
}

/**
 * Same ledger `readSkillLedger` reads, but never throws: `init()` must
 * never fail because the ledger it consults is missing or broken. An
 * absent file, a file that is not valid JSON, and a parsed file with no
 * `digests` array all degrade to an empty ledger (so every differing
 * target simply reads `conflicted`, the pre-existing safe default,
 * instead of `outdated`); each of those is paired with a `warning`
 * string naming the cause, no raw stack and no path beyond the one this
 * module already resolves. An individual entry that is not
 * `{ version: string, sha256: 64 lowercase hex }` is dropped on its own
 * rather than discarding an otherwise sound ledger; a run that dropped
 * one or more entries this way also gets a `warning` naming the count.
 * The release-time completeness check keeps using the strict
 * `readSkillLedger` above, so a broken checked-in ledger still fails the
 * test suite rather than being silently tolerated here.
 */
export function readSkillLedgerSafe(): SkillLedgerLoadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(ledgerUrl(), "utf8");
  } catch {
    return {
      entries: [],
      warning:
        "skill digest ledger (assets/skill-ledger.json) could not be " +
        "read; treating it as empty, so a differing target reports " +
        "conflicted instead of outdated",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      entries: [],
      warning:
        "skill digest ledger (assets/skill-ledger.json) is not valid " +
        "JSON; treating it as empty, so a differing target reports " +
        "conflicted instead of outdated",
    };
  }

  const digests = (parsed as { digests?: unknown } | null)?.digests;
  if (!Array.isArray(digests)) {
    return {
      entries: [],
      warning:
        'skill digest ledger (assets/skill-ledger.json) has no "digests" ' +
        "array; treating it as empty, so a differing target reports " +
        "conflicted instead of outdated",
    };
  }

  const entries: SkillLedgerEntry[] = [];
  let dropped = 0;
  for (const item of digests) {
    if (isWellFormedEntry(item)) {
      entries.push(item);
    } else {
      dropped += 1;
    }
  }
  if (dropped === 0) return { entries };
  return {
    entries,
    warning:
      `skill digest ledger (assets/skill-ledger.json) dropped ${dropped} ` +
      `malformed entr${dropped === 1 ? "y" : "ies"} (each must be ` +
      "{ version: string, sha256: 64 lowercase hex }); the rest of the " +
      "ledger still loaded",
  };
}

/**
 * Looks up `existing`'s content digest in `ledger`. Called only for a
 * target whose bytes already differ from the content that would be
 * installed, so a match here always names a version other than the one
 * about to be installed: an existing target byte-identical to the
 * current asset is `unchanged` and never reaches this lookup at all.
 * `undefined` means the digest matches no known release: the target
 * holds either a local edit or content from before the ledger's own
 * coverage began, and is never treated as safe to upgrade automatically.
 * `ledger` order matters: this is a first-match lookup (`Array#find`), so
 * when two entries somehow carried the same digest (they should not; the
 * completeness test pins adjacent entries to differ) the earlier,
 * lower-versioned one would win.
 */
export function findLedgerMatch(
  existing: string,
  ledger: readonly SkillLedgerEntry[],
): SkillLedgerEntry | undefined {
  const digest = sha256Hex(existing);
  return ledger.find((entry) => entry.sha256 === digest);
}

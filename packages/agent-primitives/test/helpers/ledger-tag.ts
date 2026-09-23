// Pure helpers for the skill-ledger release-coverage test: semver ordering
// and the mapping from a release tag's version to the ledger entry whose
// digest that tag's skill asset must equal. Kept free of git and fs so the
// mapping can be unit-tested against a synthetic ledger in any checkout.

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface ParsedSemver {
  core: [number, number, number];
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver {
  const match = SEMVER.exec(version);
  if (!match) {
    throw new Error(`not a semver version: ${JSON.stringify(version)}`);
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence: the numeric core decides first; on an equal core a
 * prerelease sorts before its release, and two prereleases compare
 * identifier by identifier. Build metadata is ignored. A string that is
 * not semver throws rather than comparing as NaN.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const difference = pa.core[i] - pb.core[i];
    if (difference !== 0) return difference;
  }
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    return pb.prerelease.length - pa.prerelease.length;
  }
  const length = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < length; i++) {
    const difference = compareIdentifier(pa.prerelease[i], pb.prerelease[i]);
    if (difference !== 0) return difference;
  }
  return pa.prerelease.length - pb.prerelease.length;
}

/**
 * The ledger records each version in which the skill asset changed (an
 * append with an unchanged digest is rejected by the ledger's own test),
 * so a release that left the asset alone has no entry of its own: its
 * asset must equal the nearest earlier entry's. Returns the exact entry
 * for `version` when there is one, otherwise the highest entry below it,
 * otherwise undefined. The ledger need not be sorted.
 */
export function ledgerEntryForTag<T extends { version: string }>(
  version: string,
  ledger: readonly T[],
): T | undefined {
  const exact = ledger.find(
    (entry) => compareSemver(entry.version, version) === 0,
  );
  if (exact) return exact;
  return [...ledger]
    .sort((a, b) => compareSemver(a.version, b.version))
    .filter((entry) => compareSemver(entry.version, version) < 0)
    .at(-1);
}

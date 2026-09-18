#!/usr/bin/env node
/**
 * Guard: release-time CHANGELOG hygiene for every published package that
 * keeps a CHANGELOG.md, plus an anchor rule for the OW bundle log.
 *
 * Why this exists (rationale and motivating incidents are recorded in
 * packages/orchestrator-workflow/CHANGELOG.md's entry introducing the
 * `lint-release-changelogs` CI job):
 * A release commit bumps a package's package.json version. Nothing
 * before this script failed the build when that bump left the
 * CHANGELOG's top heading unmoved (the cut was forgotten), or when a cut
 * heading landed above a still-populated `[Unreleased]` section (the
 * bullets were never moved under it). Separately, packages/orchestrator-
 * workflow/docs/okf/log.md narrates release history in prose, but two
 * past entries wrote a live `CHANGELOG.md:<n>` citation instead of prose
 * or an anchor; the next release cut shifted the CHANGELOG's lines out
 * from under both, and okf-kit's citation checker cannot tell a citation
 * that now resolves to unrelated content from one that never drifted
 * (there is no "this used to point somewhere else" signal once the
 * shift has already happened). Both mistakes were only caught by hand
 * during review. This script closes both gaps mechanically.
 *
 * Rules:
 *  1. version-heading: for every packages/<name>/ with a non-private
 *     package.json AND a CHANGELOG.md (a package with no CHANGELOG.md is
 *     out of this rule's scope, see "Scope" below), the first
 *     `## [x.y.z]` heading in that CHANGELOG (the first release heading
 *     at or below any leading `## [Unreleased]` heading, which never
 *     itself matches the version-heading pattern) must equal that
 *     package's package.json version.
 *  2. fresh-unreleased (only meaningful with --base <ref>): a package
 *     whose current package.json version is a strictly greater semver
 *     release than its version at <ref> just had a release cut (a head
 *     version that is equal to, or older than, base is not a cut and
 *     never fires this rule, so a stale or wrong --base cannot flag a
 *     downgrade as a forgotten cut). Its CHANGELOG's `[Unreleased]`
 *     section (the body between the `## [Unreleased]` heading and the
 *     next `## [` heading) must be empty in the working tree; a
 *     non-empty body there means the cut moved the heading but left the
 *     bullets behind instead of moving them under the new heading.
 *     Without --base there is no prior version to compare against, so
 *     this rule is skipped with a printed notice ("skipping rule 2..."),
 *     never silently: rule 1 still runs standalone against master with
 *     no --base since it needs no history at all.
 *  3. log-mention-anchor: any `CHANGELOG.md:<n>` or `CHANGELOG.md:<n>-<m>`
 *     mention anywhere in packages/orchestrator-workflow/docs/okf/log.md
 *     that is not immediately followed by an okf-kit anchor (bare
 *     `#word`/`#[...]`, or quoted `#"..."`) fails. This is narrower than
 *     okf-kit's own `anchor-required` (--require-anchors) rule, which
 *     exempts log.md as a reserved doc; this rule exists precisely to
 *     cover that exemption for the one CHANGELOG.md-shaped mention
 *     pattern log.md's own convention already forbids writing bare (see
 *     log.md's repeated "historical line numbers in this log are written
 *     as prose, not citation syntax" notes).
 *  4. empty-release-section: the first release heading (the same one
 *     rule 1 checks) must have a non-whitespace body before the next
 *     `## [` heading or end of file. A cut that moves the heading but
 *     leaves nothing under it (an empty `## [x.y.z] - date` with no
 *     bullets) passes rule 1 whenever the version happens to match, so
 *     this is its own rule rather than folded into rule 1's check.
 *  5. checked-package-scope (only when the expectation list is
 *     non-empty, see --expect below): a list of packages this repository
 *     is already known to check (agent-primitives, okf-kit,
 *     orchestrator-workflow, slop-detector by default) must still all be
 *     in the checked set computed by "Scope" below. Without this, a
 *     package silently losing its CHANGELOG.md (deleted by accident, or
 *     the package flipped to `"private": true`) only shows up as a
 *     smaller number in the final "N package(s) checked" line, which
 *     nobody reads closely enough to notice a shrink from 4 to 3. The
 *     expectation list defaults to the pinned `EXPECTED_CHECKED_PACKAGES`
 *     below when `--expect` is not given (the real repo's CI invocation
 *     takes this default); `--expect <csv>` overrides it, and an empty
 *     csv (`--expect ""`) opts out of this rule entirely, which is how a
 *     fixture whose packages do not share this repo's names runs the
 *     other four rules without a spurious checked-package-scope finding.
 *     A fixture that does want to exercise rule 5 passes its own
 *     package names via `--expect`.
 *
 * Scope: this script does not require every public package to carry a
 * CHANGELOG.md; several intentionally have none today (see the
 * "skipping (no CHANGELOG.md): ..." line this script prints at runtime
 * for the current, authoritative list), and adding that requirement is
 * out of scope for this check (see the task's negative space: it does
 * not change okf-kit's citation rules or historical CHANGELOG content,
 * and this stays a release-hygiene check for packages that already
 * opted into a CHANGELOG). Every public package with a package.json but
 * no CHANGELOG.md is printed as a skipped notice so the exclusion stays
 * visible instead of silent; it is never a rule 1 failure (see rule 5's
 * checked-package-scope for the one case this script does treat as
 * regression-worthy: a package that used to be checked and now is
 * not).
 *
 * Usage:
 *   node scripts/check-release-changelogs.mjs [--base <ref>] [--root <dir>] [--expect <csv>]
 *
 * --root overrides the repository root this script checks; it exists so
 * tests can point the guard at a disposable fixture tree (its own git
 * repository) instead of copying files into this one. Default: the repo
 * root two directories above this script.
 *
 * --expect overrides rule 5's expectation list (see rule 5 above); a csv
 * of package names, or "" to opt out. Default: EXPECTED_CHECKED_PACKAGES.
 *
 * Exit codes: 0 clean, 1 with a per-finding report, 2 usage error.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
);

// Pinned, not derived: the set of packages/<name> this repo is already
// known to check (has a non-private package.json and a CHANGELOG.md
// today). See rule 5 above. Update this list deliberately when a package
// adopts or drops a CHANGELOG.md; an unreviewed drop is exactly the
// regression this rule exists to catch.
// Mirrored literally by PINNED_PACKAGES in
// packages/orchestrator-workflow/test/check-release-changelogs.test.ts: update
// both together (the test suite fails loudly when the two lists disagree).
const EXPECTED_CHECKED_PACKAGES = [
  "agent-primitives",
  "okf-kit",
  "orchestrator-workflow",
  "slop-detector",
];

// The prerelease identifier character class shared by VERSION_HEADING_RE
// below and parseSemver further down, so the two cannot drift apart the
// way they used to: VERSION_HEADING_RE only accepted `[\w.]` (no
// hyphen), while parseSemver already accepted `[0-9A-Za-z.-]`, so a
// package.json version with a hyphenated prerelease tag such as
// "1.0.0-alpha-1" parsed fine but never matched the heading regex. Both
// sites build their prerelease group from this one string instead of
// repeating the character class literally.
const PRERELEASE_IDENTIFIER_CHARS = "0-9A-Za-z.-";

// Matches the first release heading, skipping any leading `## [Unreleased]`
// heading (which never matches the `x.y.z` shape below and is therefore
// already excluded by the pattern itself). The optional trailing
// `+[\w.]+` group accepts build metadata, mirroring parseSemver's own
// tolerance below, so a package.json version that carries build metadata
// can still have a matching heading instead of always failing rule 1.
const VERSION_HEADING_RE = new RegExp(
  `^## \\[(\\d+\\.\\d+\\.\\d+(?:-[${PRERELEASE_IDENTIFIER_CHARS}]+)?(?:\\+[\\w.]+)?)\\]`,
  "m",
);
const UNRELEASED_HEADING_RE = /^## \[Unreleased\]\s*\n/m;
const NEXT_HEADING_RE = /^## \[/m;
// A `CHANGELOG.md:<n>` or `CHANGELOG.md:<n>-<m>` mention, captured with its
// trailing text so the anchor check below can look at what follows without
// a second pass over the file.
const LOG_MENTION_RE = /CHANGELOG\.md:\d+(?:-\d+)?/g;
// An okf-kit anchor immediately after a mention's range: bare
// (`#0.24.0`, `#[0.24.0]`) or double-quoted (`#"..."`).
const ANCHOR_AFTER_RE = /^#(?:"[^"]*"|[\w.[\]-]+)/;

// Module-level, but assigned once in main() before any other function
// runs: lets --root override the default repo root without threading it
// through every function's parameter list.
let REPO_ROOT;
let PACKAGES_DIR;
let LOG_MD;

function usageErrorExit(message) {
  process.stderr.write(
    `check-release-changelogs: ${message}\n` +
      "Usage: node scripts/check-release-changelogs.mjs [--base <ref>] [--root <dir>] [--expect <csv>]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  let base;
  let root;
  let expect;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") {
      base = argv[i + 1];
      i += 1;
      if (base === undefined) {
        usageErrorExit("--base requires a ref argument");
      }
      continue;
    }
    if (arg === "--root") {
      root = argv[i + 1];
      i += 1;
      if (root === undefined) {
        usageErrorExit("--root requires a directory argument");
      }
      continue;
    }
    if (arg === "--expect") {
      expect = argv[i + 1];
      i += 1;
      if (expect === undefined) {
        usageErrorExit("--expect requires a (possibly empty) csv argument");
      }
      continue;
    }
    usageErrorExit(`unrecognized argument: ${arg}`);
  }
  return { base, root, expect };
}

// Resolves --base to a real commit sha exactly once, up front, instead of
// letting every per-package `git show <base>:<path>` failure collapse
// into the same "nothing to compare" outcome. An invalid --base (a typo,
// a flag-shaped value, a ref this checkout does not have) is a usage
// error (exit 2), not a silently skipped rule 2.
function resolveBaseCommit(base) {
  if (base.startsWith("--")) {
    usageErrorExit(`--base value looks like a flag, not a ref: "${base}"`);
  }
  let out;
  try {
    out = execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const detail = String(err.stderr || err.message).trim().split("\n")[0];
    usageErrorExit(
      `--base "${base}" does not resolve to a commit in this repository (${detail})`,
    );
  }
  return out.trim();
}

function listChangelogPackages(expectedPackages, findings) {
  let entries;
  try {
    entries = readdirSync(PACKAGES_DIR, { withFileTypes: true });
  } catch (err) {
    usageErrorExit(`could not read ${PACKAGES_DIR}: ${err.message}`);
  }
  const dirNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const checked = [];
  const skippedNoChangelog = [];
  const skippedPrivate = [];
  for (const name of dirNames) {
    const pkgJsonPath = join(PACKAGES_DIR, name, "package.json");
    const changelogPath = join(PACKAGES_DIR, name, "CHANGELOG.md");
    if (!existsSync(pkgJsonPath)) {
      continue; // not a package directory at all
    }
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    if (pkg.private === true) {
      skippedPrivate.push(name);
      continue;
    }
    if (!existsSync(changelogPath)) {
      skippedNoChangelog.push(name);
      continue;
    }
    checked.push(name);
  }

  if (skippedNoChangelog.length > 0) {
    console.log(
      `check-release-changelogs: skipping (no CHANGELOG.md): ${skippedNoChangelog.join(", ")}`,
    );
  }
  if (skippedPrivate.length > 0) {
    console.log(
      `check-release-changelogs: skipping (private): ${skippedPrivate.join(", ")}`,
    );
  }

  if (expectedPackages.length === 0) {
    console.log(
      "check-release-changelogs: skipping rule 5 (checked-package-scope): --expect is empty",
    );
  } else {
    const checkedSet = new Set(checked);
    const missing = expectedPackages.filter((name) => !checkedSet.has(name));
    if (missing.length > 0) {
      findings.push({
        file: relative(REPO_ROOT, PACKAGES_DIR),
        line: 1,
        rule: "checked-package-scope",
        message: `expected package(s) no longer checked (missing package.json, CHANGELOG.md, or now private): ${missing.join(", ")}`,
      });
    }
  }

  return checked;
}

function readCurrentVersion(name) {
  const pkgJsonPath = join(PACKAGES_DIR, name, "package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  return pkg.version;
}

function readBaseVersion(resolvedBase, name) {
  const relPath = `packages/${name}/package.json`;
  try {
    const raw = execFileSync("git", ["show", `${resolvedBase}:${relPath}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(raw).version;
  } catch {
    // No such file at base: a new package that did not exist there yet.
    // resolvedBase itself is already known-good (resolveBaseCommit ran
    // first), so this is a genuine "nothing to compare" case, not a
    // masked ref error.
    return undefined;
  }
}

// Strict `x.y.z`, `x.y.z-prerelease`, or `x.y.z(+build)`/`x.y.z-prerelease+build`
// parse. Build metadata (the `+...` suffix, if any) is stripped before
// matching and carries no precedence per semver's own spec (two versions
// that differ only in build metadata are equal), so it is discarded here
// rather than returned. Returns null for anything that still does not
// match a plain `x.y.z` core (a non-numeric tag, a missing segment),
// which callers treat as "cannot compare directionally" rather than
// crashing.
function parseSemver(version) {
  if (typeof version !== "string") {
    return null;
  }
  const withoutBuild = version.split("+")[0];
  const m = new RegExp(
    `^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([${PRERELEASE_IDENTIFIER_CHARS}]+))?$`,
  ).exec(withoutBuild);
  if (!m) {
    return null;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4],
  };
}

// Semver-spec precedence compare (semver.org clause 11) between two
// prerelease strings, `undefined` meaning "no prerelease" (a release
// always outranks a prerelease of the same x.y.z). Dot-separated
// identifiers are compared left to right: two numeric identifiers
// compare numerically, a numeric identifier always ranks below an
// alphanumeric one regardless of digits, otherwise identifiers compare
// lexically (ASCII); when every shared identifier is equal, the shorter
// identifier list ranks lower (rc <rc.1). Returns -1, 0, or 1.
function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const aParts = a.split(".");
  const bParts = b.split(".");
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const ai = aParts[i];
    const bi = bParts[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNumeric = /^\d+$/.test(ai);
    const bNumeric = /^\d+$/.test(bi);
    if (aNumeric && bNumeric) {
      const an = Number(ai);
      const bn = Number(bi);
      if (an !== bn) return an > bn ? 1 : -1;
      continue;
    }
    if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    }
    if (ai !== bi) return ai > bi ? 1 : -1;
  }
  return 0;
}

// True when `head` is a strictly greater release than `base`, by numeric
// major.minor.patch tuple compare, then by semver-spec prerelease
// precedence (see comparePrerelease) when major.minor.patch tie; an
// identical version, including two that differ only in build metadata
// (stripped by parseSemver before this ever sees it), is never an
// increase. Falls back to a plain string inequality (with a printed
// notice) when either version does not parse as strict semver, so a
// version this guard cannot compare directionally still gets rule 2's
// old, more permissive behavior instead of silently never firing.
function isVersionIncrease(base, head, packageName) {
  const b = parseSemver(base);
  const h = parseSemver(head);
  if (!b || !h) {
    console.log(
      `check-release-changelogs: ${packageName}: could not parse "${base}" / "${head}" as strict semver for rule 2's direction check; falling back to a plain inequality`,
    );
    return base !== head;
  }
  if (h.major !== b.major) return h.major > b.major;
  if (h.minor !== b.minor) return h.minor > b.minor;
  if (h.patch !== b.patch) return h.patch > b.patch;
  return comparePrerelease(h.prerelease, b.prerelease) > 0;
}

function checkVersionHeading(name, findings) {
  const changelogPath = join(PACKAGES_DIR, name, "CHANGELOG.md");
  const relChangelog = relative(REPO_ROOT, changelogPath);
  const changelog = readFileSync(changelogPath, "utf8");
  const version = readCurrentVersion(name);

  const match = VERSION_HEADING_RE.exec(changelog);
  if (!match) {
    findings.push({
      file: relChangelog,
      line: 1,
      rule: "version-heading",
      message: `no "## [x.y.z]" release heading found; expected one matching package.json's version ${version}`,
    });
    return;
  }
  if (match[1] !== version) {
    const line = changelog.slice(0, match.index).split("\n").length;
    findings.push({
      file: relChangelog,
      line,
      rule: "version-heading",
      message: `top CHANGELOG heading is [${match[1]}] but package.json version is ${version}`,
    });
  }
}

function checkEmptyReleaseSection(name, findings) {
  const changelogPath = join(PACKAGES_DIR, name, "CHANGELOG.md");
  const relChangelog = relative(REPO_ROOT, changelogPath);
  const changelog = readFileSync(changelogPath, "utf8");

  const match = VERSION_HEADING_RE.exec(changelog);
  if (!match) {
    return; // rule 1 already reports a missing release heading
  }
  // Skip past the rest of the heading's own line (a trailing " - date" is
  // heading metadata, not body content) before looking for a body.
  const headingLineEnd = changelog.indexOf("\n", match.index + match[0].length);
  const afterHeading =
    headingLineEnd === -1
      ? ""
      : changelog.slice(headingLineEnd + 1);
  NEXT_HEADING_RE.lastIndex = 0;
  const nextHeading = NEXT_HEADING_RE.exec(afterHeading);
  const body = nextHeading
    ? afterHeading.slice(0, nextHeading.index)
    : afterHeading;
  if (body.trim().length === 0) {
    const line = changelog.slice(0, match.index).split("\n").length;
    findings.push({
      file: relChangelog,
      line,
      rule: "empty-release-section",
      message: `release heading [${match[1]}] has no content before the next heading (or end of file); the cut looks incomplete`,
    });
  }
}

function checkFreshUnreleased(name, resolvedBase, findings) {
  const changelogPath = join(PACKAGES_DIR, name, "CHANGELOG.md");
  const relChangelog = relative(REPO_ROOT, changelogPath);
  const currentVersion = readCurrentVersion(name);
  const baseVersion = readBaseVersion(resolvedBase, name);
  if (
    baseVersion === undefined ||
    !isVersionIncrease(baseVersion, currentVersion, name)
  ) {
    return;
  }

  const changelog = readFileSync(changelogPath, "utf8");
  const unreleasedMatch = UNRELEASED_HEADING_RE.exec(changelog);
  if (!unreleasedMatch) {
    // No [Unreleased] heading at all: nothing else in this script flags
    // that absence either (rule 1 only checks the first release
    // heading's version, not whether an [Unreleased] heading exists
    // above it), so a fresh cut with no [Unreleased] heading exits 0
    // here. Out of scope for rule 2, which only compares content
    // already under that heading.
    return;
  }
  const afterHeading = changelog.slice(
    unreleasedMatch.index + unreleasedMatch[0].length,
  );
  NEXT_HEADING_RE.lastIndex = 0;
  const nextHeading = NEXT_HEADING_RE.exec(afterHeading);
  const body = nextHeading
    ? afterHeading.slice(0, nextHeading.index)
    : afterHeading;
  if (body.trim().length > 0) {
    const line = changelog
      .slice(0, unreleasedMatch.index)
      .split("\n").length;
    findings.push({
      file: relChangelog,
      line,
      rule: "fresh-unreleased",
      message: `package.json version changed (${baseVersion} -> ${currentVersion}) but [Unreleased] still carries content; move it under the new heading`,
    });
  }
}

function checkLogMentionAnchors(findings) {
  if (!existsSync(LOG_MD)) {
    return;
  }
  const relLog = relative(REPO_ROOT, LOG_MD);
  const content = readFileSync(LOG_MD, "utf8");
  for (const match of content.matchAll(LOG_MENTION_RE)) {
    const after = content.slice(match.index + match[0].length);
    if (ANCHOR_AFTER_RE.test(after)) {
      continue;
    }
    const line = content.slice(0, match.index).split("\n").length;
    findings.push({
      file: relLog,
      line,
      rule: "log-mention-anchor",
      message: `"${match[0]}" has no okf-kit anchor (#anchor / #"...") immediately after its range; write it as prose or add an anchor`,
    });
  }
}

function main() {
  const { base, root, expect } = parseArgs(process.argv.slice(2));
  const isDefaultRoot = root === undefined;
  REPO_ROOT = isDefaultRoot ? DEFAULT_REPO_ROOT : resolve(root);
  PACKAGES_DIR = join(REPO_ROOT, "packages");
  LOG_MD = join(
    REPO_ROOT,
    "packages",
    "orchestrator-workflow",
    "docs",
    "okf",
    "log.md",
  );

  // --expect defaults to EXPECTED_CHECKED_PACKAGES when absent (the real
  // repo's CI invocation passes nothing extra and gets that default); an
  // explicit csv (including "", which yields []) always overrides it, so
  // a fixture under --root can either exercise rule 5 against its own
  // package names or opt out entirely. See rule 5 above.
  const expectedPackages =
    expect === undefined
      ? EXPECTED_CHECKED_PACKAGES
      : expect
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0);

  const findings = [];

  const packages = listChangelogPackages(expectedPackages, findings);
  for (const name of packages) {
    checkVersionHeading(name, findings);
    checkEmptyReleaseSection(name, findings);
  }

  if (base === undefined) {
    console.log(
      "check-release-changelogs: no --base given, skipping rule 2 (fresh-unreleased)",
    );
  } else {
    const resolvedBase = resolveBaseCommit(base);
    for (const name of packages) {
      checkFreshUnreleased(name, resolvedBase, findings);
    }
  }

  checkLogMentionAnchors(findings);

  if (findings.length > 0) {
    for (const f of findings) {
      console.error(`::error::${f.file}:${f.line} [${f.rule}] ${f.message}`);
    }
    console.error(`check-release-changelogs: ${findings.length} finding(s)`);
    process.exit(1);
  }

  console.log(
    `check-release-changelogs: OK (${packages.length} package(s) checked${
      base === undefined ? ", rule 2 skipped" : ` against --base ${base}`
    })`,
  );
}

main();

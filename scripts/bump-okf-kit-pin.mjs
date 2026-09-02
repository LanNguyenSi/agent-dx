#!/usr/bin/env node
/**
 * Rewrite the `npm install -g okf-kit@<version>` pin line in each of the
 * repo's release-relevant workflow files to a target version.
 *
 * Why this exists (task 7d17996d): orchestrator-workflow's
 * test/docs-consistency.test.ts carries a parity guard (the
 * "every okf-kit@<version> pin under .github/workflows/ matches
 * package.json" describe block) requiring every such pin across
 * .github/workflows/ to equal packages/okf-kit/package.json's version. An
 * okf-kit release PR that only cuts okf-kit's own version, without also
 * bumping these pins, turns OW's suite red on master -- and since
 * publish-npm.yml runs the tests at the tag tree, the OW tag then cannot
 * publish either (see decision D-003 and packages/okf-kit/CHANGELOG.md's
 * [Unreleased] entry). This script makes the pin bump a single mechanical
 * step in the same release commit as the version cut, instead of a manual
 * edit that is easy to forget.
 *
 * Usage:
 *   node scripts/bump-okf-kit-pin.mjs [version]
 *
 * With no argument, the version is read from
 * packages/okf-kit/package.json. Only `npm install -g okf-kit@<old>` lines
 * in the two workflow files below are rewritten; `npx okf-kit@<version>`
 * example lines (e.g. in packages/okf-kit/README.md) are intentionally out
 * of scope for this script -- those are prose examples checked by a
 * separate docs-consistency assertion, not release-workflow config.
 *
 * Exits non-zero, naming the file, when a target workflow file has no
 * `npm install -g okf-kit@<version>` pin line to rewrite -- a silent no-op
 * would defeat the whole point of a mechanical release step. Idempotent:
 * running it again once the pins already equal the target version reports
 * "okf-kit@<version> -> okf-kit@<version>" (no bytes change) and still
 * exits 0.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");

// The workflow files whose `npm install -g okf-kit@<version>` pin must
// track packages/okf-kit/package.json's version (mirrors the two install
// sites the docs-consistency parity guard currently finds under
// .github/workflows/; a third install site would need adding here too,
// same as it would need covering by that guard).
const TARGET_FILES = ["ci.yml", "okf-staleness.yml"];
const PIN_RE = /npm install -g okf-kit@([\w.-]+)/;

function resolveTargetVersion(argVersion) {
  if (argVersion) return argVersion;
  const pkgPath = join(REPO_ROOT, "packages", "okf-kit", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (!pkg.version) {
    throw new Error(`no "version" field found in ${pkgPath}`);
  }
  return pkg.version;
}

function main() {
  const targetVersion = resolveTargetVersion(process.argv[2]);
  const missing = [];

  for (const file of TARGET_FILES) {
    const filePath = join(WORKFLOWS_DIR, file);
    const content = readFileSync(filePath, "utf8");
    const match = content.match(PIN_RE);
    if (!match) {
      missing.push(file);
      continue;
    }

    const oldVersion = match[1];
    const rewritten = content.replace(
      PIN_RE,
      `npm install -g okf-kit@${targetVersion}`,
    );
    if (rewritten !== content) {
      writeFileSync(filePath, rewritten, "utf8");
    }
    console.log(
      `.github/workflows/${file}: okf-kit@${oldVersion} -> okf-kit@${targetVersion}`,
    );
  }

  if (missing.length > 0) {
    console.error(
      `bump-okf-kit-pin: no "npm install -g okf-kit@<version>" pin line found in: ${missing
        .map((f) => `.github/workflows/${f}`)
        .join(", ")}`,
    );
    process.exit(1);
  }

  process.exit(0);
}

main();

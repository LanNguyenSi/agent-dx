#!/usr/bin/env node
/**
 * Guard: every packages/*\/package.json directory must be listed in the
 * `ci` job's `strategy.matrix.package` list in .github/workflows/ci.yml,
 * and every entry in that list must exist as a packages/ directory.
 *
 * Why this exists (e8d88adf, T-002 round 2 finding 3):
 * The per-package "Format check" step (and the rest of the `ci` job) only
 * runs for packages named in `matrix.package`, a hand-maintained list. A
 * new packages/<x> with a package.json that is never added to that list
 * silently skips the whole `ci` job, including the fail-closed Format
 * check step, for that package. This script closes that gap: it fails CI
 * the moment a package.json exists without a matching matrix entry (or a
 * matrix entry no longer has a package dir behind it).
 *
 * Parsing note: this reads the YAML with a targeted regex over the `ci`
 * job's `matrix: / package:` block rather than adding a YAML-parsing
 * dependency. It is anchored to `\n  ci:\n` followed by the nearest
 * `package:\n` list of `- name` lines, and fails closed (exit 1) if that
 * anchor or the list cannot be found, so a workflow restructuring that
 * breaks the regex breaks CI loudly instead of silently disabling the
 * guard. If the workflow's job/matrix shape changes, update the regex
 * below to match.
 *
 * Exits 0 when clean, 1 with a report when the sets disagree or the
 * matrix block cannot be located.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const CI_YML = join(REPO_ROOT, ".github", "workflows", "ci.yml");

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

let ciYml;
try {
  ciYml = readFileSync(CI_YML, "utf8");
} catch (err) {
  fail(`could not read ${CI_YML}: ${err.message}`);
}

// Anchor to the `ci:` job, then its `strategy: / matrix: / package:` list.
const jobMatch = ciYml.match(/\n {2}ci:\n[\s\S]*?\n {4}strategy:\n[\s\S]*?\n {6}matrix:\n {8}package:\n([\s\S]*?)(?=\n {8}\S|\n {6}\S|\n {4}\S)/);
if (!jobMatch) {
  fail(
    "could not locate the ci job's strategy.matrix.package list in .github/workflows/ci.yml " +
      "(regex anchor did not match - the workflow shape may have changed; update scripts/check-format-check-matrix.mjs)",
  );
}

const listBlock = jobMatch[1];
const matrixPackages = [...listBlock.matchAll(/^ {10}- (\S+)\s*$/gm)].map((m) => m[1]);

if (matrixPackages.length === 0) {
  fail("matched the matrix.package block but found no `- <name>` entries in it");
}

const packageDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(PACKAGES_DIR, name, "package.json")));

const dirSet = new Set(packageDirs);
const matrixSet = new Set(matrixPackages);

const missingFromMatrix = packageDirs.filter((name) => !matrixSet.has(name));
const missingDir = matrixPackages.filter((name) => !dirSet.has(name));

if (missingFromMatrix.length > 0 || missingDir.length > 0) {
  const lines = [];
  if (missingFromMatrix.length > 0) {
    lines.push(
      `package(s) with a package.json but not in ci.yml's matrix.package list: ${missingFromMatrix.join(", ")}`,
    );
  }
  if (missingDir.length > 0) {
    lines.push(
      `matrix.package entries with no packages/<name>/package.json: ${missingDir.join(", ")}`,
    );
  }
  fail(lines.join("; "));
}

console.log(
  `OK: ${matrixPackages.length} matrix.package entries match ${packageDirs.length} packages/*/package.json directories`,
);

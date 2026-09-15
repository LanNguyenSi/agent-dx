#!/usr/bin/env node
/**
 * Guard: every non-private packages/<name>/package.json must ship a
 * LICENSE file whose content is byte-equal to the repo root LICENSE, and
 * that file must actually land in the package's npm tarball.
 *
 * Why this exists: LICENSE only lived at the repo root;
 * no package directory had one, and packing a package produced a
 * tarball with "license": "MIT" in its package.json but no LICENSE text
 * inside it.
 *
 * For each packages/<name> with a package.json that is not
 * `"private": true`, this script:
 *   1. reads packages/<name>/LICENSE and compares it byte-for-byte
 *      against the root LICENSE;
 *   2. runs `npm pack --dry-run --ignore-scripts --json` inside the
 *      package directory (no install needed, and no lifecycle script may
 *      run: the guard only needs the file list, never a build) and asserts
 *      the resulting file list includes an entry named "LICENSE".
 *      npm force-includes a top-level LICENSE file, so today this second
 *      assertion is a tripwire for that npm behaviour changing rather than
 *      an independently reachable failure; check 1 is the load-bearing one.
 *
 * Exits 0 when every non-private package passes both checks, 1 with a
 * report otherwise.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const ROOT_LICENSE_PATH = join(REPO_ROOT, "LICENSE");

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

let rootLicense;
try {
  rootLicense = readFileSync(ROOT_LICENSE_PATH);
} catch (err) {
  fail(`could not read root LICENSE at ${ROOT_LICENSE_PATH}: ${err.message}`);
}

let packageEntries;
try {
  packageEntries = readdirSync(PACKAGES_DIR, { withFileTypes: true });
} catch (err) {
  fail(`could not read ${PACKAGES_DIR}: ${err.message}`);
}

const candidates = packageEntries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(PACKAGES_DIR, name, "package.json")))
  .sort();

if (candidates.length === 0) {
  fail(`no packages/<name>/package.json directories found under ${PACKAGES_DIR}`);
}

const problems = [];
let checked = 0;

for (const name of candidates) {
  const pkgDir = join(PACKAGES_DIR, name);
  const pkgJsonPath = join(pkgDir, "package.json");

  let pkgJson;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch (err) {
    problems.push(`${name}: could not read/parse package.json (${err.message})`);
    continue;
  }

  if (pkgJson.private === true) {
    continue;
  }

  checked += 1;
  const licensePath = join(pkgDir, "LICENSE");

  if (!existsSync(licensePath)) {
    problems.push(`${name}: missing packages/${name}/LICENSE`);
  } else {
    let packageLicense;
    try {
      packageLicense = readFileSync(licensePath);
    } catch (err) {
      problems.push(`${name}: could not read packages/${name}/LICENSE (${err.message})`);
    }
    if (packageLicense && !packageLicense.equals(rootLicense)) {
      problems.push(`${name}: packages/${name}/LICENSE does not match the root LICENSE byte-for-byte`);
    }
  }

  let packOutput;
  try {
    packOutput = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: pkgDir,
      encoding: "utf8",
    });
  } catch (err) {
    problems.push(`${name}: npm pack --dry-run --json failed: ${err.message}`);
    continue;
  }

  let packResult;
  try {
    packResult = JSON.parse(packOutput);
  } catch (err) {
    problems.push(`${name}: could not parse npm pack --dry-run --json output: ${err.message}`);
    continue;
  }

  const entry = Array.isArray(packResult) ? packResult[0] : packResult;
  const files = (entry && entry.files) || [];
  const hasLicense = files.some((f) => f && f.path === "LICENSE");

  if (!hasLicense) {
    problems.push(`${name}: npm pack --dry-run --json does not list a LICENSE entry`);
  }
}

if (problems.length > 0) {
  fail(problems.join("; "));
}

console.log(`OK: ${checked} non-private packages ship a LICENSE matching the root LICENSE and pack it into their tarball`);

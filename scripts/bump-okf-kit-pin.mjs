#!/usr/bin/env node
/**
 * Rewrite every `npm install -g okf-kit@<version>` and `npx
 * okf-kit@<version>` pin under `.github/workflows/` to a target version.
 *
 * Why this exists: orchestrator-workflow's test/docs-consistency.test.ts
 * carries a parity guard (the "every okf-kit@<version> pin under
 * .github/workflows/ matches package.json" describe block) requiring
 * every such pin, in either form, across every workflow file to equal
 * packages/okf-kit/package.json's version. An okf-kit release PR that
 * only cuts okf-kit's own version, without also bumping these pins,
 * turns OW's suite red on master -- and since publish-npm.yml runs the
 * tests at the tag tree, the OW tag then cannot publish either (see
 * packages/okf-kit/CHANGELOG.md's [Unreleased] entry and CONTRIBUTING.md's
 * "Releasing okf-kit" section). This script makes the pin bump a single mechanical step in the
 * same release commit as the version cut, instead of a manual edit that
 * is easy to forget or to only partially cover.
 *
 * Usage:
 *   node scripts/bump-okf-kit-pin.mjs [--dry-run] [version]
 *
 * With no version argument, the target version is read from
 * packages/okf-kit/package.json. Both the argument and the package.json
 * version must be semver-shaped (e.g. `1.2.3` or `1.2.3-rc.1`); anything
 * else is rejected with a usage message and nothing is written. An
 * unrecognized flag (anything starting with `-` other than `--dry-run`)
 * is rejected the same way, so a typo like `--dry-run-x` or an
 * accidental `--foo` can never be mistaken for a version and silently
 * written into a workflow file as a literal pin.
 *
 * `--dry-run` prints every occurrence that would be rewritten (old ->
 * new, per file) without writing any file; useful to preview a bump
 * ahead of cutting the version in packages/okf-kit/package.json.
 *
 * Every `.yml`/`.yaml` file directly under `.github/workflows/` is
 * scanned (mirrors the docs-consistency guard's own readdir, so a new
 * workflow file adding its own pin is covered automatically). Only the
 * command forms `npm install -g okf-kit@<version>` and `npx
 * okf-kit@<version>` are matched; a prose mention like `# Exact pin:
 * okf-kit@0.3.0 on npm` in a comment is not preceded by either command
 * form and is left untouched. `ci.yml` and `okf-staleness.yml` are
 * additionally required to carry at least one pin each after the scan
 * (the guard's baseline expectation); either file missing entirely, or
 * present with zero pins, is reported by name and exits non-zero. This
 * script covers only `.github/workflows/`, not okf-kit's own README.md
 * `npx okf-kit@<version> check path/to/bundle` example: that pin is a
 * prose example, not release-workflow config, checked by a separate
 * docs-consistency assertion.
 *
 * The shipped template packages/okf-kit/templates/okf-staleness.yml is
 * rewritten in the same pass (its install pin and its "pinned to okf-kit
 * <version>" header sentence), so the template names the release that
 * ships it. This repo's own generated copy .github/workflows/okf-staleness.yml
 * gets the same header rewrite. A missing template, or one without exactly one
 * install pin and exactly one header, exits non-zero before anything is written.
 *
 * Every workflow file is read before any file is written, so a
 * genuinely missing or unreadable file never leaves a partial bump
 * behind (some files rewritten, others not). Exits non-zero, naming the
 * file, when a required workflow file is missing entirely, when a
 * required workflow file has no pin to rewrite (the other, present
 * files are still rewritten in this case), or when zero pins were found
 * anywhere under .github/workflows/ -- a silent no-op would defeat the
 * whole point of a mechanical release step. Idempotent: running it
 * again once the pins already equal the target version reports
 * "okf-kit@<version> -> okf-kit@<version>" (no bytes change) and still
 * exits 0.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");

// Mirrors the docs-consistency guard's own regex exactly: both the
// `npm install -g` and `npx` command forms, global so every occurrence in
// a file is found, not just the first.
const PIN_RE = /(?:npm install -g|npx) okf-kit@([\w.-]+)/g;
// No build metadata (`+build`): the guard's capture class cannot carry a
// `+`, so a version the guard cannot read back is rejected up front.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

// The two workflow files the release procedure has always expected to
// carry at least one pin. A new workflow file adding its own pin is
// picked up automatically by the readdir scan above; these two are kept
// as a floor so a release that accidentally strips both files' pins is
// still caught by name, not just by the "zero pins anywhere" check.
const REQUIRED_FILES = ["ci.yml", "okf-staleness.yml"];

// The shipped okf-staleness template carries the same pin twice: the
// `npm install -g okf-kit@<version>` line (matched by PIN_RE) and the header
// sentence "pinned to okf-kit <version>" (wrapped over a comment line break).
// Both move with the release so the template never names a version other than
// the one that ships it. Prose such as "ships in the release after 0.16.0" is
// deliberately not matched.
const TEMPLATE_REL = "packages/okf-kit/templates/okf-staleness.yml";
const TEMPLATE_PATH = join(REPO_ROOT, ...TEMPLATE_REL.split("/"));
// This repo's own generated copy of the template, re-synced on each bump.
const GENERATED_COPY = "okf-staleness.yml";
const TEMPLATE_HEADER_RE =
  /(pinned to okf-kit\s+#?\s*)(\d+\.\d+\.\d+(?:-[\w.-]+)?)/g;

function usageErrorExit(message) {
  process.stderr.write(
    `bump-okf-kit-pin: ${message}\n` +
      "Usage: node scripts/bump-okf-kit-pin.mjs [--dry-run] [version]\n",
  );
  process.exitCode = 1;
}

function parseArgs(argv) {
  let dryRun = false;
  let versionArg;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`unrecognized option: ${arg}`);
    }
    if (versionArg !== undefined) {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
    versionArg = arg;
  }
  return { dryRun, versionArg };
}

function resolveTargetVersion(versionArg) {
  if (versionArg !== undefined) {
    if (!SEMVER_RE.test(versionArg)) {
      throw new Error(
        `invalid version argument "${versionArg}" (expected semver, e.g. 1.2.3)`,
      );
    }
    return versionArg;
  }
  const pkgPath = join(REPO_ROOT, "packages", "okf-kit", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (!pkg.version || !SEMVER_RE.test(pkg.version)) {
    throw new Error(
      `invalid or missing "version" field in ${pkgPath} (expected semver, e.g. 1.2.3)`,
    );
  }
  return pkg.version;
}

function main() {
  let dryRun;
  let versionArg;
  try {
    ({ dryRun, versionArg } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    usageErrorExit(err.message);
    return;
  }

  let targetVersion;
  try {
    targetVersion = resolveTargetVersion(versionArg);
  } catch (err) {
    usageErrorExit(err.message);
    return;
  }

  let workflowFiles;
  try {
    workflowFiles = readdirSync(WORKFLOWS_DIR).filter(
      (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
    );
  } catch (err) {
    process.stderr.write(
      `bump-okf-kit-pin: cannot read ${WORKFLOWS_DIR}: ${err.message}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Read every file first; nothing is written until every file that
  // should exist has been read successfully, so a genuinely missing
  // file never leaves some files rewritten and others not. A file that
  // is present but has no pin to rewrite is a separate, per-file
  // condition, checked further below only after the writes happen.
  const reads = [];
  const readErrors = [];
  for (const file of workflowFiles) {
    const filePath = join(WORKFLOWS_DIR, file);
    try {
      const content = readFileSync(filePath, "utf8");
      reads.push({
        file,
        filePath,
        content,
        label: `.github/workflows/${file}`,
      });
    } catch (err) {
      readErrors.push(
        `.github/workflows/${file}: ${err.code === "ENOENT" ? "not found" : err.message}`,
      );
    }
  }

  if (readErrors.length > 0) {
    process.stderr.write(`bump-okf-kit-pin: ${readErrors.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }

  let templateContent;
  try {
    templateContent = readFileSync(TEMPLATE_PATH, "utf8");
  } catch (err) {
    process.stderr.write(
      `bump-okf-kit-pin: ${TEMPLATE_REL}: ${err.code === "ENOENT" ? "not found" : err.message}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const missingRequired = REQUIRED_FILES.filter(
    (name) => !reads.some((r) => r.file === name),
  );
  if (missingRequired.length > 0) {
    process.stderr.write(
      `bump-okf-kit-pin: required workflow file(s) missing entirely: ${missingRequired
        .map((f) => `.github/workflows/${f}`)
        .join(", ")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Both the missing-file checks above and this pin computation happen
  // before any write, so a file that is genuinely missing never leaves
  // some files rewritten and others not. A file that is present but has
  // no pin to rewrite is a separate, per-file condition (checked below)
  // and does not block writing the other files that do have a pin --
  // matching the pre-existing "the file that DID have a pin still gets
  // rewritten" expectation.
  const rewrites = [];
  let totalPins = 0;
  for (const { file, filePath, content, label } of reads) {
    const occurrences = [];
    let rewritten = content.replace(PIN_RE, (match, oldVersion) => {
      occurrences.push(oldVersion);
      return match.replace(`okf-kit@${oldVersion}`, `okf-kit@${targetVersion}`);
    });
    totalPins += occurrences.length;
    // This repo's own generated copy of the template carries the same header
    // sentence; it is re-synced with the pin. Not counted as a workflow pin.
    if (file === GENERATED_COPY) {
      rewritten = rewritten.replace(
        TEMPLATE_HEADER_RE,
        (_m, lead) => `${lead}${targetVersion}`,
      );
    }
    rewrites.push({ file, filePath, content, rewritten, occurrences, label });
  }

  // The template is rewritten in the same pass but is not part of the
  // workflow "zero pins" accounting; it has its own check, evaluated before
  // any write. Install pins and header sentences are counted separately and
  // exactly one of each is required.
  const templateInstallPins = [];
  const templateHeaderPins = [];
  const templateRewritten = templateContent
    .replace(PIN_RE, (match, oldVersion) => {
      templateInstallPins.push(oldVersion);
      return match.replace(`okf-kit@${oldVersion}`, `okf-kit@${targetVersion}`);
    })
    .replace(TEMPLATE_HEADER_RE, (_m, lead, oldVersion) => {
      templateHeaderPins.push(oldVersion);
      return `${lead}${targetVersion}`;
    });
  const templateOccurrences = [...templateInstallPins, ...templateHeaderPins];
  if (templateInstallPins.length !== 1 || templateHeaderPins.length !== 1) {
    process.stderr.write(
      `bump-okf-kit-pin: expected exactly one install pin and exactly one "pinned to okf-kit" header in ${TEMPLATE_REL}, found ${templateInstallPins.length} install pin(s) and ${templateHeaderPins.length} header(s); nothing written\n`,
    );
    process.exitCode = 1;
    return;
  }
  rewrites.push({
    file: null,
    filePath: TEMPLATE_PATH,
    content: templateContent,
    rewritten: templateRewritten,
    occurrences: templateOccurrences,
    label: TEMPLATE_REL,
  });

  for (const r of rewrites) {
    for (const oldVersion of r.occurrences) {
      console.log(
        `${r.label}: okf-kit@${oldVersion} -> okf-kit@${targetVersion}`,
      );
    }
  }

  if (!dryRun) {
    for (const r of rewrites) {
      if (r.rewritten !== r.content) {
        writeFileSync(r.filePath, r.rewritten, "utf8");
      }
    }
  }

  if (totalPins === 0) {
    process.stderr.write(
      'bump-okf-kit-pin: no "npm install -g okf-kit@<version>" or "npx ' +
        'okf-kit@<version>" pin found under .github/workflows/\n',
    );
    process.exitCode = 1;
    return;
  }

  const missingPins = REQUIRED_FILES.filter((name) => {
    const r = rewrites.find((r) => r.file === name);
    return r.occurrences.length === 0;
  });
  if (missingPins.length > 0) {
    process.stderr.write(
      `bump-okf-kit-pin: no okf-kit@<version> pin line found in: ${missingPins
        .map((f) => `.github/workflows/${f}`)
        .join(", ")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

main();

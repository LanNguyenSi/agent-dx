#!/usr/bin/env node
// Assert that a package's `latest` dist-tag points at the highest published
// stable version. publish-npm.yml runs this after a publish (and in its
// idempotency branch) so a run whose `latest` ended up on an older version,
// for example because two publish runs finished out of order, fails loudly
// and names the repair workflow instead of ending green.
//
// Inputs are the bodies of `npm view <pkg> dist-tags --json` and
// `npm view <pkg> versions --json`, passed as files. The dist-tags body is
// resolved through resolveVersion from lib/resolve-version.mjs (shared with
// dist-tag-version.mjs), so both the npm 11 object shape and the npm 12 array
// shape work. The versions body is a
// JSON array of version strings; a package with a single published version
// prints a bare string instead, and an npm 12 body may wrap the list in one
// more array, so all three are accepted.
//
// "Highest stable" means the highest version without a prerelease part.
// Prerelease versions are ignored, even when they sort higher. When no stable
// version is published at all there is nothing for `latest` to point at, which
// passes with a notice.
//
// Deprecated versions are NOT skipped: npm's own implicit-latest rule skips
// them, but the deprecation flag is only visible per version in the full
// packument, which this check does not read. If the highest stable version is
// deprecated, `latest` correctly sits on a lower version and this check
// reports an error; the self-test pins that behaviour. Resolve it by moving
// the tag deliberately with the "Move an npm dist-tag" workflow and
// re-running, or by un-deprecating the version.
//
// A parse failure is reported as a distinct ::warning:: line, never as a
// mismatch, so the caller's log tells "could not read the response" from
// "latest is on the wrong version". Both exit 1 so the caller can retry
// either one against registry/CDN lag.
//
// Modes:
//   --package <name> --dist-tags <file> --versions <file>
//                  exit 0 when ok, 1 on a mismatch (::error::) or on
//                  unparsable input (::warning::), 2 on a usage error
//   --self-test    exercise the decision against fixtures, no files needed

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVersion } from "./lib/resolve-version.mjs";

const REPAIR =
  'Repair it with the "Move an npm dist-tag" workflow (.github/workflows/npm-dist-tag.yml); re-running the publish workflow does not move a tag.';

const STABLE = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/;

function parseStable(version) {
  const m = STABLE.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Throws on a body that is not JSON or not a list of version strings.
function parseVersions(text) {
  let data = JSON.parse(text);
  if (typeof data === "string") data = [data];
  if (Array.isArray(data) && data.length === 1 && Array.isArray(data[0])) data = data[0];
  if (!Array.isArray(data) || !data.every((v) => typeof v === "string")) {
    throw new Error("versions body is not a list of version strings");
  }
  return data;
}

// Pure decision, kept separate so the self-test needs no files. Returns
// { status: "ok" | "mismatch" | "unparsable", message }.
export function decide(pkg, distTagsText, versionsText) {
  let latest;
  let versions;
  try {
    latest = resolveVersion(distTagsText, "latest");
    versions = parseVersions(versionsText);
  } catch (err) {
    return { status: "unparsable", message: `could not parse npm view output for ${pkg}: ${err.message}` };
  }

  let highest = null;
  let highestText = "";
  for (const v of versions) {
    const parsed = parseStable(v);
    if (parsed && (highest === null || compare(parsed, highest) > 0)) {
      highest = parsed;
      highestText = v;
    }
  }
  if (highest === null) {
    return { status: "ok", message: `${pkg} has no stable version published; nothing for latest to point at.` };
  }

  const latestParsed = parseStable(latest);
  if (latestParsed !== null && compare(latestParsed, highest) === 0) {
    return { status: "ok", message: `${pkg} latest is ${latest}, the highest stable version.` };
  }
  return {
    status: "mismatch",
    message: `${pkg} dist-tag latest is ${latest === "" ? "not set" : latest}, expected ${highestText} (the highest published stable version). ${REPAIR}`,
  };
}

function runCli(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const pkg = get("--package");
  const tagsFile = get("--dist-tags");
  const versionsFile = get("--versions");
  if (!pkg || !tagsFile || !versionsFile) {
    console.error("usage: check-latest.mjs --package <name> --dist-tags <file> --versions <file> | --self-test");
    return 2;
  }
  let tagsText;
  let versionsText;
  try {
    tagsText = readFileSync(tagsFile, "utf8");
    versionsText = readFileSync(versionsFile, "utf8");
  } catch (err) {
    console.log(`::warning::could not read npm view output for ${pkg}: ${err.message}`);
    return 1;
  }
  const result = decide(pkg, tagsText, versionsText);
  if (result.status === "ok") {
    console.log(`::notice::${result.message}`);
    return 0;
  }
  console.log(result.status === "mismatch" ? `::error::${result.message}` : `::warning::${result.message}`);
  return 1;
}

function selfTest() {
  const P = "demo";
  const tagsObj = (latest) => JSON.stringify({ latest });
  const tagsArr = (latest) => JSON.stringify([{ latest }]);
  const cases = [
    // [name, tags body, versions body, wanted status, wanted message fragment]
    ["latest equals highest", tagsObj("0.22.1"), '["0.21.0","0.22.0","0.22.1"]', "ok", "highest stable"],
    [
      "latest older than highest (out-of-order publish)",
      tagsObj("0.11.0"),
      '["0.10.0","0.11.0","0.12.0"]',
      "mismatch",
      "expected 0.12.0",
    ],
    [
      "latest higher than every listed stable",
      tagsObj("0.13.0"),
      '["0.10.0","0.11.0","0.12.0"]',
      "mismatch",
      "expected 0.12.0",
    ],
    ["higher prereleases are ignored", tagsObj("0.12.0"), '["0.11.0","0.12.0","0.13.0-rc.1"]', "ok", "highest stable"],
    [
      "latest on a prerelease is a mismatch",
      tagsObj("0.13.0-rc.1"),
      '["0.11.0","0.12.0","0.13.0-rc.1"]',
      "mismatch",
      "expected 0.12.0",
    ],
    ["only prereleases published", "{}", '["0.1.0-rc.1","0.1.0-rc.2"]', "ok", "no stable version"],
    ["numeric, not lexical, ordering", tagsObj("0.9.0"), '["0.9.0","0.10.0"]', "mismatch", "expected 0.10.0"],
    ["missing latest tag", "{}", '["0.1.0"]', "mismatch", "not set"],
    ["npm 11 object shape", tagsObj("1.2.3"), '["1.2.3"]', "ok", "highest stable"],
    ["npm 12 array shape", tagsArr("1.2.3"), '["1.2.3"]', "ok", "highest stable"],
    ["npm 12 array shape, mismatch", tagsArr("1.2.2"), '["1.2.2","1.2.3"]', "mismatch", "expected 1.2.3"],
    ["single published version prints a bare string", tagsObj("1.0.0"), '"1.0.0"', "ok", "highest stable"],
    ["versions wrapped in one more array", tagsArr("1.0.1"), '[["1.0.0","1.0.1"]]', "ok", "highest stable"],
    [
      "highest stable is deprecated: reported (deprecation is not read)",
      tagsObj("0.5.0"),
      '["0.5.0","0.6.0"]',
      "mismatch",
      "expected 0.6.0",
    ],
    ["malformed dist-tags JSON", "not json {{{", '["1.0.0"]', "unparsable", "could not parse"],
    ["malformed versions JSON", tagsObj("1.0.0"), "not json {{{", "unparsable", "could not parse"],
    ["versions body is not a list of strings", tagsObj("1.0.0"), '{"1.0.0":{}}', "unparsable", "could not parse"],
    ["versions list holds non-strings", tagsObj("1.0.0"), "[1,2]", "unparsable", "could not parse"],
  ];
  let failed = 0;
  let total = 0;
  for (const [name, tags, versions, wantedStatus, fragment] of cases) {
    total++;
    const got = decide(P, tags, versions);
    const pass = got.status === wantedStatus && got.message.includes(fragment);
    if (!pass) failed++;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name} (wanted ${wantedStatus}, got ${got.status}: ${got.message})`);
  }

  // The mismatch message must name the package, latest, the expected version
  // and the repair workflow.
  const msg = decide(P, tagsObj("0.11.0"), '["0.11.0","0.12.0"]').message;
  for (const part of [P, "0.11.0", "0.12.0", "Move an npm dist-tag", "npm-dist-tag.yml"]) {
    total++;
    const pass = msg.includes(part);
    if (!pass) failed++;
    console.log(`  ${pass ? "PASS" : "FAIL"}  mismatch message names '${part}'`);
  }

  // The CLI wrapper itself: spawn this file against fixture files and assert
  // stdout and the exit status (annotations go to stdout).
  const self = fileURLToPath(import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), "check-latest-"));
  try {
    const tagsFile = join(dir, "tags.json");
    const versionsFile = join(dir, "versions.json");
    const cli = (tags, versions, extra = []) => {
      writeFileSync(tagsFile, tags);
      writeFileSync(versionsFile, versions);
      return spawnSync(
        process.execPath,
        [self, "--package", P, "--dist-tags", tagsFile, "--versions", versionsFile, ...extra],
        { encoding: "utf8", timeout: 20000 },
      );
    };
    const cliCases = [
      ["cli ok exits 0", cli(tagsObj("1.0.0"), '["1.0.0"]'), 0, "::notice::"],
      ["cli mismatch exits 1 with ::error::", cli(tagsObj("0.9.0"), '["0.9.0","1.0.0"]'), 1, "::error::"],
      ["cli unparsable exits 1 with ::warning::", cli("nope", '["1.0.0"]'), 1, "::warning::"],
      [
        "cli missing file exits 1 with ::warning::",
        spawnSync(
          process.execPath,
          [self, "--package", P, "--dist-tags", join(dir, "absent.json"), "--versions", versionsFile],
          { encoding: "utf8", timeout: 20000 },
        ),
        1,
        "::warning::",
      ],
      [
        "cli without arguments exits 2",
        spawnSync(process.execPath, [self], { encoding: "utf8", timeout: 20000 }),
        2,
        "",
      ],
    ];
    for (const [name, run, wantedStatus, fragment] of cliCases) {
      total++;
      const pass = run.status === wantedStatus && run.stdout.includes(fragment);
      if (!pass) failed++;
      console.log(`  ${pass ? "PASS" : "FAIL"}  ${name} (wanted exit ${wantedStatus}, got exit ${run.status}: ${run.stdout.trim()})`);
    }

    // Reached through a symlinked directory, the CLI must still run and
    // decide (a script that silently does nothing there would pass vacuously).
    const linked = join(dir, "linked");
    symlinkSync(dirname(self), linked, "dir");
    total++;
    writeFileSync(tagsFile, tagsObj("0.9.0"));
    writeFileSync(versionsFile, '["0.9.0","1.0.0"]');
    const viaLink = spawnSync(
      process.execPath,
      [join(linked, "check-latest.mjs"), "--package", P, "--dist-tags", tagsFile, "--versions", versionsFile],
      { encoding: "utf8", timeout: 20000 },
    );
    const linkPass = viaLink.status === 1 && viaLink.stdout.includes("::error::");
    if (!linkPass) failed++;
    console.log(
      `  ${linkPass ? "PASS" : "FAIL"}  cli run through a symlinked directory still decides (got exit ${viaLink.status}: ${viaLink.stdout.trim().slice(0, 80)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.error(`::error::${failed} self-test case(s) failed; refusing to trust the latest check`);
    process.exit(1);
  }
  console.log(`check-latest self-test: ${total} cases pass`);
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}
process.exit(runCli(argv));

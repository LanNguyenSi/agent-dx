#!/usr/bin/env node
// Read the body of `npm view <pkg> dist-tags --json` on stdin and print the
// version one dist-tag points at (empty output when the tag is absent).
//
// This exists because npm 12 made `--json` always return an array: npm 11 and
// earlier print `{"latest":"0.19.1"}`, npm 12 prints `[{"latest":"0.19.1"}]`.
// A filter written for the object shape (`.[$t]` in jq, or `obj[tag]` in JS)
// throws "Cannot index array with string" on the npm 12 shape, and a caller
// that swallows the failure sees an empty result and can misread a working
// registry as a tag that never landed. So: accept both shapes here, once,
// with a self-test, instead of re-deriving the filter inline in a workflow.
//
// A parse failure is deliberately NOT reported as "tag absent": bad or
// unexpected output prints a ::warning:: line and exits 1, so the caller's
// log distinguishes "could not read the response" from "the tag is not there
// yet" and can keep retrying either way without conflating them.
//
// Modes:
//   <tag>          read stdin, print the version (or nothing), exit 0;
//                  on unparsable input print a ::warning:: and exit 1
//   --self-test    exercise the resolver against fixtures, no stdin needed
//
// The resolver itself lives in lib/resolve-version.mjs, which check-latest.mjs
// imports too; this file always runs its CLI.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVersion } from "./lib/resolve-version.mjs";

function selfTest() {
  const cases = [
    // [name, input, tag, wanted: {version} or {parseError: true}]
    ["object shape returns the version", '{"latest":"0.19.1"}', "latest", { version: "0.19.1" }],
    ["array shape returns the version", '[{"latest":"0.19.1"}]', "latest", { version: "0.19.1" }],
    ["missing tag returns empty (object shape)", '{"next":"0.20.0"}', "latest", { version: "" }],
    ["missing tag returns empty (array shape)", '[{"next":"0.20.0"}]', "latest", { version: "" }],
    ["unparsable input is reported as a parse error", 'not json {{{', "latest", { parseError: true }],
    ["empty array returns empty", "[]", "latest", { version: "" }],
    ["null body returns empty (tag absent, not a parse error)", "null", "latest", { version: "" }],
  ];
  let failed = 0;
  let total = 0;
  for (const [name, input, tag, wanted] of cases) {
    total++;
    let got;
    try {
      got = { version: resolveVersion(input, tag) };
    } catch {
      got = { parseError: true };
    }
    const pass = got.version === wanted.version && Boolean(got.parseError) === Boolean(wanted.parseError);
    if (!pass) failed++;
    const gotLabel = got.parseError ? "parse-error" : `'${got.version}'`;
    const wantLabel = wanted.parseError ? "parse-error" : `'${wanted.version}'`;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name} (wanted ${wantLabel}, got ${gotLabel})`);
  }
  // The CLI wrapper itself: spawn this file so the entry-point guard, the
  // stdin read, the stdout output and the exit codes are pinned too.
  const self = fileURLToPath(import.meta.url);
  const cliCases = [
    // [name, args, stdin, wanted stdout, wanted exit status]
    ["cli prints the version for the object shape", ["latest"], '{"latest":"0.19.1"}', "0.19.1", 0],
    ["cli prints the version for the array shape", ["latest"], '[{"latest":"0.19.1"}]', "0.19.1", 0],
    ["cli prints nothing for an absent tag", ["latest"], '{"next":"0.20.0"}', "", 0],
    ["cli treats a null body as an absent tag", ["latest"], "null", "", 0],
    ["cli exits 1 on unparsable input", ["latest"], "not json {{{", "", 1],
    ["cli exits 2 without a tag argument", [], "", "", 2],
  ];
  for (const [name, args, input, wantedOut, wantedStatus] of cliCases) {
    total++;
    const run = spawnSync(process.execPath, [self, ...args], { input, encoding: "utf8", timeout: 20000 });
    const pass = run.status === wantedStatus && run.stdout === wantedOut;
    if (!pass) failed++;
    console.log(
      `  ${pass ? "PASS" : "FAIL"}  ${name} (wanted exit ${wantedStatus} '${wantedOut}', got exit ${run.status} '${run.stdout}')`,
    );
  }
  // The CLI reached through a symlinked directory still runs and prints.
  const dir = mkdtempSync(join(tmpdir(), "dist-tag-version-"));
  try {
    const linked = join(dir, "linked");
    symlinkSync(dirname(self), linked, "dir");
    total++;
    const run = spawnSync(process.execPath, [join(linked, "dist-tag-version.mjs"), "latest"], {
      input: '{"latest":"0.19.1"}',
      encoding: "utf8",
      timeout: 20000,
    });
    const pass = run.status === 0 && run.stdout === "0.19.1";
    if (!pass) failed++;
    console.log(`  ${pass ? "PASS" : "FAIL"}  cli run through a symlinked directory still prints (got exit ${run.status} '${run.stdout}')`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failed > 0) {
    console.error(`::error::${failed} self-test case(s) failed; refusing to trust the resolver`);
    process.exit(1);
  }
  console.log(`dist-tag-version self-test: ${total} cases pass`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--self-test")) {
    selfTest();
    process.exit(0);
  }

  const tag = argv[0];
  if (!tag) {
    console.error("usage: dist-tag-version.mjs <dist-tag> | --self-test");
    process.exit(2);
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  let version;
  try {
    version = resolveVersion(chunks.join(""), tag);
  } catch (err) {
    console.error(`::warning::could not parse npm view output: ${err.message}`);
    process.exit(1);
  }
  process.stdout.write(version);
}

await main();

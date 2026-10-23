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

// Pure resolver, kept separate so the self-test needs no stdin. Throws on
// input that is not JSON; a JSON body that carries no object to index into
// (empty array, null, a bare string) resolves to "tag absent", which the
// caller must be able to tell apart from a throw.
export function resolveVersion(text, tag) {
  const data = JSON.parse(text);
  const obj = Array.isArray(data) ? data[0] : data;
  if (obj === null || obj === undefined || typeof obj !== "object") return "";
  const version = obj[tag];
  return typeof version === "string" ? version : "";
}

function selfTest() {
  const cases = [
    // [name, input, tag, wanted: {version} or {parseError: true}]
    ["object shape returns the version", '{"latest":"0.19.1"}', "latest", { version: "0.19.1" }],
    ["array shape returns the version", '[{"latest":"0.19.1"}]', "latest", { version: "0.19.1" }],
    ["missing tag returns empty (object shape)", '{"next":"0.20.0"}', "latest", { version: "" }],
    ["missing tag returns empty (array shape)", '[{"next":"0.20.0"}]', "latest", { version: "" }],
    ["unparsable input is reported as a parse error", 'not json {{{', "latest", { parseError: true }],
    ["empty array returns empty", "[]", "latest", { version: "" }],
  ];
  let failed = 0;
  for (const [name, input, tag, wanted] of cases) {
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
  if (failed > 0) {
    console.error(`::error::${failed} self-test case(s) failed; refusing to trust the resolver`);
    process.exit(1);
  }
  console.log("self-test: all cases pass");
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

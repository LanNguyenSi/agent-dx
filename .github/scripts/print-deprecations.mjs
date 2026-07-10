#!/usr/bin/env node
// Print each published version of a package and whether it carries a
// deprecation message.
//
// This exists because `npm deprecate`'s exit code is not evidence: it masks an
// unauthorized write as a 404, and it can exit non-zero after the write landed.
// The registry's own view of the package is the only thing worth asserting on.
//
// Modes:
//   <pkg>                          print state, exit 0
//   <pkg> --json                   print state as JSON to stdout (for snapshots)
//   <pkg> --expect <v> [--baseline <file>]
//       assert that <v> is deprecated, that dist-tags.latest is not <v>, and
//       that no version deprecated in this run other than <v>. "Other than" is
//       measured against the baseline snapshot when given, so a package with a
//       legitimate deprecation history keeps working.
//
// The packument is served through a caching CDN and the `deprecated` field can
// lag a successful write, so --expect polls with backoff rather than reading
// once. A read that never converges is reported as UNCONFIRMED (exit 3), which
// is deliberately distinct from "the write did not land" (exit 1): the operator
// must not conflate "cannot see it yet" with "it did not happen".

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const pkg = argv[0];

if (!argv.includes("--self-test") && (!pkg || pkg.startsWith("--"))) {
  console.error("usage: print-deprecations.mjs <package> [--json] [--expect <version> [--baseline <file>]] | --self-test");
  process.exit(2);
}

const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
};
const asJson = argv.includes("--json");
const expect = flag("--expect");
const baselineFile = flag("--baseline");

if (argv.includes("--expect") && !expect) {
  console.error("--expect requires a version argument");
  process.exit(2);
}

// Pure verdict logic, kept separate so it can be exercised without a network.
// Returns { ok, retry, problems }.
//   ok=true            -> exactly the expected version was deprecated by this run
//   retry=true         -> not visible yet; distinct from "did not land"
//   problems.length>0  -> this run changed something it should not have
export function verdict(state, expect, baseline) {
  const newlyDeprecated = state.deprecated.filter((v) => !baseline.includes(v));
  const unexpected = newlyDeprecated.filter((v) => v !== expect);
  const problems = [];
  if (unexpected.length > 0) {
    problems.push(`this run deprecated versions it should not have: ${unexpected.join(", ")}`);
  }
  if (state.latest === expect) {
    problems.push(`dist-tags.latest still points at the deprecated ${expect}`);
  }
  if (problems.length > 0) return { ok: false, retry: false, problems };
  if (!state.deprecated.includes(expect)) return { ok: false, retry: true, problems };
  return { ok: true, retry: false, problems };
}

function selfTest() {
  const cases = [
    // [name, state, expect, baseline, wanted]
    ["target deprecated, nothing else", { deprecated: ["0.3.0"], latest: "0.3.1" }, "0.3.0", [], "ok"],
    ["target not yet visible", { deprecated: [], latest: "0.3.1" }, "0.3.0", [], "retry"],
    ["blast radius: sibling deprecated too", { deprecated: ["0.3.0", "0.3.1"], latest: "0.3.1" }, "0.3.0", [], "problem"],
    ["pre-existing deprecation is not our fault", { deprecated: ["0.1.0", "0.3.0"], latest: "0.3.1" }, "0.3.0", ["0.1.0"], "ok"],
    ["latest points at the deprecated version", { deprecated: ["0.3.1"], latest: "0.3.1" }, "0.3.1", [], "problem"],
    ["whole package deprecated", { deprecated: ["0.3.0", "0.3.1"], latest: "0.3.1" }, "0.3.0", [], "problem"],
  ];
  let failed = 0;
  for (const [name, state, expect, baseline, wanted] of cases) {
    const v = verdict(state, expect, baseline);
    const got = v.problems.length > 0 ? "problem" : v.retry ? "retry" : "ok";
    const pass = got === wanted;
    if (!pass) failed++;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name} (wanted ${wanted}, got ${got})`);
  }
  if (failed > 0) {
    console.error(`::error::${failed} self-test case(s) failed; refusing to touch the registry`);
    process.exit(1);
  }
  console.log("self-test: all cases pass");
}

if (argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

async function fetchPackument() {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, {
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
  });
  if (!res.ok) throw new Error(`registry returned ${res.status} for ${pkg}`);
  const doc = await res.json();
  const versions = doc.versions ?? {};
  if (Object.keys(versions).length === 0) {
    // A packument with no versions cannot support any assertion. Never treat
    // this as a vacuous pass.
    throw new Error(`registry returned no versions for ${pkg}`);
  }
  return {
    latest: doc["dist-tags"]?.latest ?? null,
    deprecated: Object.keys(versions)
      .filter((v) => versions[v].deprecated)
      .sort(),
    all: Object.keys(versions).sort(),
    messages: Object.fromEntries(
      Object.keys(versions).filter((v) => versions[v].deprecated).map((v) => [v, versions[v].deprecated]),
    ),
  };
}

function render(state) {
  for (const v of state.all) {
    const msg = state.messages[v];
    console.log(`  ${v.padEnd(12)} ${msg ? "DEPRECATED" : "ok"}${msg ? `  ${JSON.stringify(msg)}` : ""}`);
  }
  console.log(`  dist-tags.latest = ${state.latest}`);
}

const first = await fetchPackument();

if (asJson) {
  process.stdout.write(JSON.stringify({ deprecated: first.deprecated, latest: first.latest }));
  process.exit(0);
}

render(first);
if (!expect) process.exit(0);

// Versions already deprecated before this run are none of our business.
let baseline = [];
if (baselineFile) {
  try {
    baseline = JSON.parse(readFileSync(baselineFile, "utf8")).deprecated ?? [];
  } catch (err) {
    console.error(`::error::cannot read baseline ${baselineFile}: ${err.message}`);
    process.exit(2);
  }
}

const DELAYS_MS = [0, 3000, 5000, 10000, 15000, 30000];
let state = first;
for (const delay of DELAYS_MS) {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  state = await fetchPackument();
  if (state.deprecated.includes(expect)) break;
}

const { problems } = verdict(state, expect, baseline);

if (problems.length > 0) {
  console.log("\nregistry state now:");
  render(state);
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}

if (!state.deprecated.includes(expect)) {
  console.log("\nregistry state now:");
  render(state);
  console.error(
    `::warning::${pkg}@${expect} is not visible as deprecated yet. The write may still be propagating through the registry CDN, or it may not have landed. Re-run this check before re-running the deprecate step.`,
  );
  process.exit(3);
}

console.log(`\nOK: ${pkg}@${expect} is deprecated; latest is ${state.latest}; this run deprecated nothing else.`);

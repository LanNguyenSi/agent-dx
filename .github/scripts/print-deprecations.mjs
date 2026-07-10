#!/usr/bin/env node
// Print each published version of a package and whether it carries a
// deprecation message. With `--assert-only <version>`, also assert that the
// named version is deprecated and that no other version is.
//
// This exists because `npm deprecate`'s exit code is not evidence: it masks an
// unauthorized write as a 404, and it can fail after the write landed. The
// registry's own view of the package is the only thing worth asserting on.

const [, , pkg, ...rest] = process.argv;

if (!pkg) {
  console.error("usage: print-deprecations.mjs <package> [--assert-only <version>]");
  process.exit(2);
}

const assertIdx = rest.indexOf("--assert-only");
const assertOnly = assertIdx === -1 ? null : rest[assertIdx + 1];
if (assertIdx !== -1 && !assertOnly) {
  console.error("--assert-only requires a version argument");
  process.exit(2);
}

const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`);
if (!res.ok) {
  console.error(`registry returned ${res.status} for ${pkg}`);
  process.exit(1);
}
const doc = await res.json();
const versions = Object.keys(doc.versions ?? {}).sort();

const deprecated = [];
for (const v of versions) {
  const msg = doc.versions[v].deprecated;
  const flag = msg ? "DEPRECATED" : "ok";
  console.log(`  ${v.padEnd(12)} ${flag}${msg ? `  ${JSON.stringify(msg)}` : ""}`);
  if (msg) deprecated.push(v);
}
console.log(`  dist-tags.latest = ${doc["dist-tags"]?.latest}`);

if (!assertOnly) process.exit(0);

const problems = [];
if (!deprecated.includes(assertOnly)) {
  problems.push(`${assertOnly} is NOT deprecated on the registry`);
}
const extra = deprecated.filter((v) => v !== assertOnly);
if (extra.length > 0) {
  problems.push(`unexpected deprecated versions: ${extra.join(", ")}`);
}
if (doc["dist-tags"]?.latest === assertOnly) {
  problems.push(`dist-tags.latest still points at the deprecated ${assertOnly}`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(`OK: exactly ${assertOnly} is deprecated, latest is ${doc["dist-tags"].latest}`);

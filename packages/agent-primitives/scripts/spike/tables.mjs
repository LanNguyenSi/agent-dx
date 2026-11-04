#!/usr/bin/env node
// Throwaway spike helper: prints the markdown tables of REPORT.md from the
// per-case JSON that run-cases.mjs wrote.   node tables.mjs <out-dir>
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const rs = readdirSync(dir)
  .filter((f) => /^(?:case|control)-.*\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
  .sort((a, b) => (a.group === b.group ? a.id.localeCompare(b.id) : a.group === "case" ? -1 : 1));
const f1 = (x) => (x === null || x === undefined ? "n/a" : x.toFixed(1));
const short = (p) => p.split("/").slice(-2).join("/");

console.log("### Cases (reviewer-found surviving mutants)\n");
console.log("| case | repo | range (merge-base..head) | resolved | survivors (file:line) | v1 | v2 | exact line | nearest probe | cand. | files | cand./file | uncov./file |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rs.filter((x) => x.group === "case")) {
  if (!r.resolved) {
    console.log(`| ${r.id} | ${r.repo} | - | no (${r.error}) | | | | | | | | | |`);
    continue;
  }
  if (r.skipped) {
    console.log(`| ${r.id} | ${r.repo} | ${r.range} | yes | ${r.survivors.map((s) => `${s.file}:${s.line}`).join(", ")} | out of language scope | | | | | | | |`);
    continue;
  }
  const n = r.changedSourceFiles.length;
  r.v1.verdicts.forEach((v, i) => {
    const v2 = r.v2.verdicts[i];
    const first = i === 0;
    console.log(
      `| ${first ? r.id : ""} | ${first ? r.repo : ""} | ${first ? r.range : ""} | ${first ? "yes" : ""} | ${short(v.file)}:${v.line} | ${v.verdict} | ${v2.verdict} | ${v.exactLine ? "yes" : "no"} | ${v.probeDistance === null ? "none" : v.probeDistance} | ${first ? r.v1.candidates : ""} | ${first ? n : ""} | ${first ? f1(r.v1.candidates / Math.max(n, 1)) : ""} | ${first ? f1(r.v1.perFile.reduce((a, f) => a + f.uncovered, 0) / Math.max(n, 1)) : ""} |`,
    );
  });
}
console.log("\n### Controls (review found no surviving mutant)\n");
console.log("| control | repo | range | resolved | cand. v1 | cand. v2 | changed src files | cand./file | covered (<=3 lines) | uncov./file | unresolved probes |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rs.filter((x) => x.group === "control")) {
  if (!r.resolved) {
    console.log(`| ${r.id} | ${r.repo} | - | no (${r.error}) | | | | | | | |`);
    continue;
  }
  const n = r.changedSourceFiles.length;
  console.log(
    `| ${r.id} | ${r.repo} | ${r.range} | yes | ${r.v1.candidates} | ${r.v2.candidates} | ${n} | ${n ? f1(r.v1.candidates / n) : "n/a"} | ${r.v1.coveredTol3}/${r.v1.candidates} | ${n ? f1(r.v1.perFile.reduce((a, f) => a + f.uncovered, 0) / n) : "n/a"} | ${r.probes.filter((p) => p.line === null).length} of ${r.probes.length} |`,
  );
}

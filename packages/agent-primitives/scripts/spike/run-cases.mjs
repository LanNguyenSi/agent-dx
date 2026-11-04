#!/usr/bin/env node
// Throwaway spike driver: runs the enumerator over the cases in cases.json and
// scores it against the reviewers' surviving mutants and the implementers'
// planned mutants.
//   node run-cases.mjs <cases.json> <repos-dir> <out-dir>
// Writes <out-dir>/<case-id>.json per case and <out-dir>/aggregate.json.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify, listChanged, parseDiff } from "./branch-enumerator.mjs";
import { extract } from "./extract-probes.mjs";

const [casesPath, reposDir, outDir] = process.argv.slice(2);
if (!casesPath || !reposDir || !outDir) {
  process.stderr.write("usage: run-cases.mjs <cases.json> <repos-dir> <out-dir>\n");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const TOL = 3;

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function sameFile(a, b) {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function hunkRange(h) {
  const m = /\+(\d+)(?:,(\d+))?/.exec(h);
  const start = Number(m[1]);
  const count = m[2] === undefined ? 1 : Number(m[2]);
  return [start, start + Math.max(count, 1) - 1];
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function resolveProbes(repo, head, sources) {
  const probes = [];
  for (const src of sources) {
    const text = readFileSync(src, "utf8");
    for (const p of extract(text, src.split("/").pop())) {
      if (p.line !== undefined) {
        probes.push({ file: p.file, line: p.line, src: p.src, by: "line" });
        continue;
      }
      let body = null;
      try {
        body = git(repo, ["show", `${head}:${p.file}`]);
      } catch {
        // the file may not exist at head
      }
      if (body === null) {
        probes.push({ file: p.file, line: null, src: p.src, by: "text-unresolved-file" });
        continue;
      }
      const lines = body.split("\n");
      const hits = [];
      for (let i = 0; i < lines.length; i += 1) if (lines[i].includes(p.text)) hits.push(i + 1);
      if (!hits.length) probes.push({ file: p.file, line: null, src: p.src, by: "text-unresolved" });
      for (const line of hits.slice(0, 4)) probes.push({ file: p.file, line, src: p.src, by: "text" });
    }
  }
  return probes;
}

function score(c, files, variantOpts, probes) {
  const diff = c._diffFiles;
  const { records } = classify(diff, variantOpts);
  const srcFiles = files;
  const covered = (r, tol) =>
    probes.some((p) => p.line !== null && sameFile(p.file, r.file) && Math.abs(p.line - r.line) <= tol);
  const perFile = srcFiles.map((f) => {
    const rs = records.filter((r) => r.file === f);
    const lines = new Set(rs.map((r) => r.line));
    const unc = new Set(rs.filter((r) => !covered(r, TOL)).map((r) => r.line));
    return { file: f, candidates: rs.length, candidateLines: lines.size, uncovered: rs.filter((r) => !covered(r, TOL)).length, uncoveredLines: unc.size };
  });
  const verdicts = [];
  for (const s of c.survivors ?? []) {
    const lo = s.lo ?? s.line;
    const hi = s.hi ?? s.line;
    const inFile = records.filter((r) => sameFile(r.file, s.file));
    const near = inFile.filter((r) => r.line >= lo - TOL && r.line <= hi + TOL);
    const fileEntry = diff.find((d) => sameFile(d.file, s.file));
    let verdict = "miss";
    let note = "";
    if (!fileEntry) note = "survivor file not in the changed non-test source files";
    else {
      const addedLines = fileEntry.added.map((a) => a.line);
      const lineChanged = addedLines.some((l) => l >= lo && l <= hi);
      if (!lineChanged) note = "survivor line is not an added line in base..head";
      const survHunks = new Set(fileEntry.added.filter((a) => a.line >= lo - TOL && a.line <= hi + TOL).map((a) => a.hunk));
      if (near.length) verdict = "hit";
      else {
        const sameHunk = inFile.filter((r) => {
          for (const h of survHunks) if (r.hunk === h) return true;
          const [a, b] = hunkRange(r.hunk);
          return lo >= a && hi <= b;
        });
        if (sameHunk.length) verdict = "partial";
      }
    }
    const exact = inFile.some((r) => r.line >= lo && r.line <= hi);
    if (s.verdictOverride) {
      note = `${note} override ${verdict} -> ${s.verdictOverride}: ${s.overrideWhy}`.trim();
      verdict = s.verdictOverride;
    }
    verdicts.push({
      file: s.file, line: s.line ?? `${lo}-${hi}`, verdict, note, exactLine: exact,
      probeDistance: (() => {
        const ds = probes.filter((p) => p.line !== null && sameFile(p.file, s.file)).map((p) => (p.line < lo ? lo - p.line : p.line > hi ? p.line - hi : 0));
        return ds.length ? Math.min(...ds) : null;
      })(),
      nearKinds: [...new Set(near.map((r) => r.kind))],
      hitUncoveredTol3: near.some((r) => !covered(r, TOL)),
      hitUncoveredTol0: near.some((r) => !covered(r, 0)),
      exactUncoveredTol3: inFile.some((r) => r.line >= lo && r.line <= hi && !covered(r, TOL)),
      exactUncoveredTol0: inFile.some((r) => r.line >= lo && r.line <= hi && !covered(r, 0)),
      nearCoveredBy: near.some((r) => covered(r, TOL)) ? "covered" : "uncovered",
      what: s.what ?? "",
    });
  }
  const byKind = {};
  const uncByKind = {};
  for (const r of records) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (!covered(r, TOL)) uncByKind[r.kind] = (uncByKind[r.kind] ?? 0) + 1;
  }
  const coveredN = records.filter((r) => covered(r, TOL)).length;
  const covered0 = records.filter((r) => covered(r, 0)).length;
  return { candidates: records.length, coveredTol3: coveredN, coveredTol0: covered0, byKind, uncoveredByKind: uncByKind, perFile, verdicts, records };
}

const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const results = [];
for (const c of cases) {
  const repo = join(reposDir, c.repo);
  const res = { id: c.id, group: c.group, repo: c.repo, task: c.task, lang: c.lang, resolved: false };
  try {
    if (!existsSync(repo)) throw new Error("repo clone missing");
    const base = git(repo, ["rev-parse", `${c.base}^{commit}`]);
    const head = git(repo, ["rev-parse", `${c.head}^{commit}`]);
    const mb = git(repo, ["merge-base", base, head]);
    Object.assign(res, { base: base.slice(0, 12), head: head.slice(0, 12), mergeBase: mb.slice(0, 12), range: `${mb.slice(0, 12)}..${head.slice(0, 12)}`, resolved: true });
    const allFiles = parseDiff(listChanged(repo, `${mb}..${head}`));
    res.changedFilesAll = allFiles.length;
    if (c.lang !== "ts") {
      res.skipped = "out of language scope";
      res.survivors = c.survivors ?? [];
      results.push(res);
      writeFileSync(join(outDir, `${c.id}.json`), JSON.stringify(res, null, 1));
      continue;
    }
    const probes = resolveProbes(repo, head, c.probeSources ?? []);
    res.probes = probes;
    c._diffFiles = allFiles.filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f.file) && !/(?:^|\/)(?:tests?|__tests__|__mocks__|e2e|fixtures|evidence)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$|(?:^|\/)(?:vitest|jest|playwright)\.config\./.test(f.file));
    const srcFiles = c._diffFiles.map((f) => f.file);
    res.changedSourceFiles = srcFiles;
    res.v1 = score(c, srcFiles, {}, probes);
    res.v2 = score(c, srcFiles, { v2: true }, probes);
    res.survivors = c.survivors ?? [];
    res.excluded = c.excluded ?? [];
  } catch (e) {
    res.error = String(e.message ?? e).split("\n")[0];
  }
  results.push(res);
  writeFileSync(join(outDir, `${c.id}.json`), JSON.stringify(res, null, 1));
}

function aggregate(variant, group) {
  const rs = results.filter((r) => r.group === group && r.resolved && r[variant]);
  const pooledTotal = [];
  const pooledUnc = [];
  const perCaseMean = [];
  const perCaseUncMean = [];
  const kindTot = {};
  const kindUnc = {};
  let cand = 0;
  let cov3 = 0;
  let cov0 = 0;
  const sv = { n: 0, hit: 0, partial: 0, miss: 0, exact: 0, hitUnc3: 0, hitUnc0: 0, exactUnc3: 0, exactUnc0: 0 };
  const hitKinds = {};
  const dist = { d0: 0, d1to3: 0, dMore: 0 };
  for (const r of rs) {
    const v = r[variant];
    cand += v.candidates;
    cov3 += v.coveredTol3;
    cov0 += v.coveredTol0;
    for (const f of v.perFile) {
      pooledTotal.push(f.candidates);
      pooledUnc.push(f.uncovered);
    }
    if (v.perFile.length) {
      perCaseMean.push(mean(v.perFile.map((f) => f.candidates)));
      perCaseUncMean.push(mean(v.perFile.map((f) => f.uncovered)));
    }
    for (const [k, n] of Object.entries(v.byKind)) kindTot[k] = (kindTot[k] ?? 0) + n;
    for (const [k, n] of Object.entries(v.uncoveredByKind)) kindUnc[k] = (kindUnc[k] ?? 0) + n;
    for (const d of v.verdicts) {
      sv.n += 1;
      sv[d.verdict] += 1;
      if (d.exactLine) sv.exact += 1;
      if (d.probeDistance === 0) dist.d0 += 1;
      else if (d.probeDistance !== null && d.probeDistance <= 3) dist.d1to3 += 1;
      else dist.dMore += 1;
      if (d.verdict === "hit" && d.hitUncoveredTol3) sv.hitUnc3 += 1;
      if (d.verdict === "hit" && d.hitUncoveredTol0) sv.hitUnc0 += 1;
      if (d.exactUncoveredTol3) sv.exactUnc3 += 1;
      if (d.exactUncoveredTol0) sv.exactUnc0 += 1;
      if (d.verdict === "hit") for (const k of d.nearKinds) hitKinds[k] = (hitKinds[k] ?? 0) + 1;
    }
  }
  return {
    cases: rs.length, changedSourceFiles: pooledTotal.length, candidates: cand,
    coveredShareTol3: cand ? cov3 / cand : null, coveredShareTol0: cand ? cov0 / cand : null,
    perFileMeanPooled: mean(pooledTotal), perFileMedianPooled: median(pooledTotal),
    perFileUncMeanPooled: mean(pooledUnc), perFileUncMedianPooled: median(pooledUnc),
    perCaseMeanOfMeans: mean(perCaseMean), perCaseUncMeanOfMeans: mean(perCaseUncMean),
    kindTot, kindUnc, survivors: sv, hitKinds, probeDistance: dist,
  };
}

const agg = {};
for (const variant of ["v1", "v2"]) for (const group of ["case", "control"]) agg[`${variant}-${group}`] = aggregate(variant, group);
writeFileSync(join(outDir, "aggregate.json"), JSON.stringify({ agg, unresolved: results.filter((r) => !r.resolved).map((r) => ({ id: r.id, error: r.error })) }, null, 1));
process.stdout.write(JSON.stringify(agg, null, 1) + "\n");

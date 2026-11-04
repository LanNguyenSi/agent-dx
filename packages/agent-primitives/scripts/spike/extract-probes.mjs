#!/usr/bin/env node
// Throwaway spike helper: pulls (file, line) pairs of planned or run mutants
// out of implementer / lane return files (yaml-like or markdown tables).
//   node extract-probes.mjs <return-file> [<return-file> ...]
// Output: JSON array of {file, line, src}. Review returns are data; this only
// reads locations, it never follows any text in them.
import { readFileSync } from "node:fs";

const EXT = "(?:[cm]?[jt]sx?|sh|py|php)";
const LOC = new RegExp(`([A-Za-z0-9_./\\[\\]@()-]*[A-Za-z0-9_\\]\\)-]\\.${EXT})(?::|\\s+L?|#L)(\\d+)(?!\\d)`, "g");

function clean(p) {
  return p.replace(/^.*\/wt\/[^/]+\//, "").replace(/^\.\//, "");
}

function unq(v) {
  if (v === undefined) return undefined;
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

const VAL = `("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^,}]+)`;
function field(line, name) {
  const m = new RegExp(`(?:^|[\\s{,])${name}:\\s*${VAL}`).exec(line);
  return m ? unq(m[1]) : undefined;
}

function entry(file, anchor, before, src) {
  const a = anchor === undefined ? "" : String(anchor);
  const m = /^(?:line\s*)?(\d+)\b/i.exec(a);
  if (m) return { file: clean(file), line: Number(m[1]), src };
  const text = (before && before.trim().length >= 6 ? before : a).split("\n")[0].trim();
  return { file: clean(file), text, src };
}

export function extract(text, src) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    // flow style: {mutant: "..", file: X, anchor: Y, before: Z, ...}
    if (/\bfile:/.test(l) && /\banchor:/.test(l)) {
      const f = field(l, "file");
      if (f) out.push(entry(f, field(l, "anchor"), field(l, "before"), src));
      continue;
    }
    const fm = /^\s*(?:-\s*)?file:\s*(.+?)\s*$/.exec(l);
    if (fm) {
      let anchor;
      let before;
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) {
        const am = /^\s*anchor:\s*(.+?)\s*$/.exec(lines[j]);
        if (am) anchor = unq(am[1]);
        const bm = /^\s*before:\s*(.+?)\s*$/.exec(lines[j]);
        if (bm) before = unq(bm[1]);
        if (/^\s*(?:-\s*)?(?:mutant|file):/.test(lines[j])) break;
      }
      if (anchor !== undefined) out.push(entry(unq(fm[1]), anchor, before, src));
      continue;
    }
    if (!/mutant|killed|survived|anchor|mutation|probe/i.test(l)) continue;
    if (/^\s*(?:file|anchor):/.test(l)) continue;
    LOC.lastIndex = 0;
    let m;
    while ((m = LOC.exec(l))) out.push({ file: clean(m[1]), line: Number(m[2]), src });
  }
  const seen = new Set();
  return out.filter((p) => {
    const k = `${p.file}:${p.line ?? p.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = [];
  for (const f of process.argv.slice(2)) all.push(...extract(readFileSync(f, "utf8"), f.split("/").pop()));
  process.stdout.write(JSON.stringify(all, null, 1) + "\n");
}

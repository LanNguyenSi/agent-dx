#!/usr/bin/env node
// Throwaway spike (not shipped, not referenced by package.json).
// Enumerates candidate behaviour branches added or changed in base..head of a
// git checkout, for TypeScript and JavaScript sources only.
//
//   node branch-enumerator.mjs <repo-dir> <base>..<head> [--v2]
//
// Emits one JSON object per line: {file, line, kind, hunk}
//   kind: conditional | default | flag | early-return
// `line` is the line number in the head version of the file.
//
// The heuristic is line based on purpose: it reads `git diff -U0` and
// classifies each added line with regular expressions after stripping string
// contents and comments. It does not parse the language, so it over-reports
// (noise) and can under-report multi-line constructs; REPORT.md measures both.
import { execFileSync } from "node:child_process";

const SRC_EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|__mocks__|e2e|fixtures|evidence)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$|(?:^|\/)(?:vitest|jest|playwright)\.config\./;

export function listChanged(repo, range) {
  const out = execFileSync(
    "git",
    ["-C", repo, "diff", "-U0", "--no-color", "--find-renames", "--diff-filter=AMR", range, "--"],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  return out;
}

export function parseDiff(diff) {
  const files = [];
  let cur = null;
  let hunk = "";
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4);
      cur = p === "/dev/null" ? null : { file: p.replace(/^b\//, ""), added: [] };
      if (cur) files.push(cur);
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (m) {
      newLine = Number(m[1]);
      hunk = raw;
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("+")) {
      cur.added.push({ line: newLine, text: raw.slice(1), hunk });
      newLine += 1;
    }
  }
  return files;
}

// Blank out string and template literal contents and strip comments so that
// operators inside text do not match. Keeps the quote characters and length.
function scrub(text, state) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (state.block) {
      if (c === "*" && n === "/") {
        state.block = false;
        out += "  ";
        i += 2;
      } else {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && n === "*") {
      state.block = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "/" && n === "/") break;
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      out += c + " ".repeat(Math.max(0, j - i - 1)) + (j < text.length ? c : "");
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const RE = {
  ifHead: /(?:^|[\s;}])(?:else\s+)?if\s*\(/,
  elseOnly: /^\s*}?\s*else\s*{?\s*$/,
  switchHead: /(?:^|[\s;}])switch\s*\(/,
  caseArm: /^\s*(?:case\b.+|default)\s*:/,
  // a ternary: `?` that is not `?.`, `??`, `?:` (optional property) or a TS optional marker
  ternary: /[^?.\s]\s*\?\s+[^?:]/,
  loopCond: /(?:^|[\s;}])(?:while)\s*\(/,
  typedParamDefault: /^\s*(?:(?:private|public|protected|readonly)\s+)*[A-Za-z_$][\w$]*\??\s*:\s*[^=]+?\s*=\s*[^=>].*,\s*$/,
  boolArm: /(?:\|\||&&)\s*$|^\s*(?:\|\||&&)\s*\S/,
  nullish: /\?\?=?/,
  orFallback: /(?:=|return|=>|\()\s*[^=<>!]*?\|\|\s*[^|]/,
  paramDefault: /[(,{]\s*[A-Za-z_$][\w$]*\s*=\s*[^=>\s]/,
  destructDefault: /(?:const|let|var)\s*[{[][^=]*[A-Za-z_$][\w$]*\s*=\s*[^=>\s]/,
  optionKeyDecl: /^\s*(?:readonly\s+)?[A-Za-z_$][\w$]*\?\s*:\s*\S/,
  earlyReturnInline: /\bif\s*\(.*\)\s*(?:return|throw|continue|break)\b/,
  exitStmt: /^\s*(?:return|throw|continue|break)\b/,
};

function indentOf(text) {
  return text.length - text.trimStart().length;
}

export function classify(files, opts = {}) {
  const records = [];
  const skipped = { nonSource: new Set(), test: new Set() };
  for (const f of files) {
    if (!SRC_EXT.test(f.file)) {
      skipped.nonSource.add(f.file);
      continue;
    }
    if (TEST_PATH.test(f.file)) {
      skipped.test.add(f.file);
      continue;
    }
    const state = { block: false };
    let prevOpener = null; // last added if/else opener {line, indent}
    let prevLine = -1;
    for (const a of f.added) {
      if (a.line !== prevLine + 1) {
        prevOpener = null;
        state.block = false;
      }
      prevLine = a.line;
      const raw = a.text;
      const code = scrub(raw, state);
      const t = code.trim();
      if (t === "" || /^import\b|^export\s+(?:\*|{)[^=]*from\b/.test(t)) continue;
      const kinds = new Set();
      const isIf = RE.ifHead.test(code);
      if (isIf || RE.elseOnly.test(code) || RE.switchHead.test(code) || RE.caseArm.test(code) || RE.loopCond.test(code) || (opts.v2 && RE.boolArm.test(code))) {
        kinds.add("conditional");
      }
      if (RE.ternary.test(code) && !/^\s*(?:readonly\s+)?[\w$]+\?\s*:/.test(code) && !/\)\s*\?\s*:|=>\s*\?/.test(code)) {
        kinds.add("conditional");
      }
      if (RE.nullish.test(code) || RE.orFallback.test(code)) kinds.add("default");
      if (RE.paramDefault.test(code) && /(?:function|=>|\)\s*{|\bconstructor\b|\w\s*\()/.test(code)) kinds.add("default");
      if (RE.destructDefault.test(code)) kinds.add("default");
      if (opts.v2 && !/^\s*(?:const|let|var|export|type|interface|case)\b/.test(code) && RE.typedParamDefault.test(code)) kinds.add("default");
      if (/['"]--[a-z][\w-]*['"]/.test(raw) || /\.option\(|\.flag\(|parseArgs\(/.test(code) || RE.optionKeyDecl.test(code)) {
        kinds.add("flag");
      }
      if (RE.earlyReturnInline.test(code)) kinds.add("early-return");
      if (RE.exitStmt.test(code) && prevOpener && indentOf(raw) > prevOpener.indent && a.line - prevOpener.line <= 2) {
        kinds.add("early-return");
      }
      if (isIf || RE.elseOnly.test(code)) {
        prevOpener = { line: a.line, indent: indentOf(raw) };
      } else if (!RE.exitStmt.test(code)) {
        prevOpener = null;
      }
      for (const kind of kinds) records.push({ file: f.file, line: a.line, kind, hunk: a.hunk });
    }
  }
  return { records, skipped };
}

function main() {
  const args = process.argv.slice(2);
  // --v2: also flag lines that start or end with && / || (arms of a multi-line
  // condition) and typed parameter defaults (`name: T = value,`). Both were
  // added after looking at the first measurement's misses, see REPORT.md.
  const v2 = args.includes("--v2");
  const [repo, range] = args.filter((a) => !a.startsWith("--"));
  if (!repo || !range || !range.includes("..")) {
    process.stderr.write("usage: branch-enumerator.mjs <repo-dir> <base>..<head>\n");
    process.exit(2);
  }
  const files = parseDiff(listChanged(repo, range));
  const { records, skipped } = classify(files, { v2 });
  for (const r of records) process.stdout.write(JSON.stringify(r) + "\n");
  process.stderr.write(
    `candidates=${records.length} nonSourceFiles=${skipped.nonSource.size} testFiles=${skipped.test.size}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();

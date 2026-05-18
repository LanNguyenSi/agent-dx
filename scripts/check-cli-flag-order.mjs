#!/usr/bin/env node
/**
 * Lint: commander `.option(...)` declarations must use `-short, --long`, NOT
 * `--long, -short`.
 *
 * Why this exists (ef80348a / friction-log M5):
 * Commander accepts a mis-ordered declaration like `.option('--yes, -y', ...)`
 * silently. It registers the literal string as the flag name, so the long
 * form `--yes` is never wired up. At the CLI, `--yes` does nothing, the
 * prompter runs, and a non-interactive `init --yes` blocks on stdin. No type
 * error, no commander warning, no test failure unless a smoke test
 * happens to hit the affected path.
 *
 * This check is the cheapest possible enforcement: a regex scan of every
 * `packages/*\/src/**\/*.ts` file looking for the bad pattern. Run in CI as a
 * non-matrix job so a single failing call surfaces it across all packages
 * at once.
 *
 * Exits 0 when clean, 1 with a per-file report when violations are found.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

// Matches the inside of an .option(...) call where the FIRST string literal
// starts with `--long, -s` (long form before short form). We only flag the
// mis-order; commander accepts both `-s, --long` and `-s, --long <value>`.
const BAD_PATTERN = /\.option\(\s*['"`]--[a-zA-Z][\w-]*,\s*-[a-zA-Z]\b/g;

function* walkTsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walkTsFiles(full);
    } else if (entry.isFile() && /\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

const violations = [];

for (const pkgEntry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
  if (!pkgEntry.isDirectory()) continue;
  const srcDir = join(PACKAGES_DIR, pkgEntry.name, "src");
  try {
    statSync(srcDir);
  } catch {
    continue;
  }
  for (const file of walkTsFiles(srcDir)) {
    const content = readFileSync(file, "utf8");
    let match;
    BAD_PATTERN.lastIndex = 0;
    while ((match = BAD_PATTERN.exec(content)) !== null) {
      const before = content.slice(0, match.index);
      const line = before.split("\n").length;
      violations.push({
        file: relative(REPO_ROOT, file),
        line,
        snippet: match[0],
      });
    }
  }
}

if (violations.length === 0) {
  console.log(
    `commander-flag-order: clean (scanned packages/*/src/**/*.{ts,js,mts,mjs,cts,cjs})`,
  );
  process.exit(0);
}

console.error("commander-flag-order: violations found\n");
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.snippet}`);
  console.error(`    fix: reorder to '-short, --long'\n`);
}
console.error(
  `Commander parses a mis-ordered first arg ('--long, -short') as a literal\n` +
    `flag name, silently dropping the long form. Use '-short, --long'.`,
);
process.exit(1);

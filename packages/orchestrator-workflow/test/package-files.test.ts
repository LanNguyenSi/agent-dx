import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

const files: string[] = JSON.parse(
  readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"),
).files;

// npm packs a `files` entry as a plain file, a directory (recursively) or,
// in the forms this package uses, `dir/*.md`.
function covered(rel: string): boolean {
  return files.some((raw) => {
    const entry = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (entry === rel) return true;
    const glob = entry.match(/^(.*)\/\*\.md$/);
    if (glob) {
      const rest = rel.slice(glob[1].length + 1);
      return (
        rel.startsWith(`${glob[1]}/`) &&
        !rest.includes("/") &&
        rest.endsWith(".md")
      );
    }
    return rel.startsWith(`${entry}/`);
  });
}

function relativeLinks(doc: string): string[] {
  const text = readFileSync(join(PACKAGE_DIR, doc), "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    out.push(target.split("#")[0]);
  }
  return out;
}

describe("published package covers the links of its shipped docs", () => {
  for (const doc of ["README.md", "INSTALL-AGENT.md"]) {
    it(`every relative link in ${doc} that targets the package resolves to a packed file`, () => {
      const links = relativeLinks(doc);
      let checked = 0;
      for (const link of links) {
        const abs = resolve(PACKAGE_DIR, link);
        const rel = relative(PACKAGE_DIR, abs).split(sep).join("/");
        if (rel.startsWith("..")) continue;
        checked++;
        expect(
          existsSync(abs) && statSync(abs).isFile(),
          `${doc} links ${link}, which is not a file`,
        ).toBe(true);
        expect(
          covered(rel),
          `${doc} links ${link}, which no files entry packs`,
        ).toBe(true);
      }
      if (doc === "README.md") expect(checked).toBeGreaterThan(0);
    });
  }

  it("covered() follows the entry forms", () => {
    expect(covered("docs/operator-install.md")).toBe(true);
    expect(covered("docs/okf/index.md")).toBe(false);
    expect(covered("README.md")).toBe(true);
  });
});

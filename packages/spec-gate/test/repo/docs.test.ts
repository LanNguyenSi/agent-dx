import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_LISTING_BYTES,
  MAX_SPEC_FILES,
  MAX_TREE_ENTRIES,
  REPO_CHECK_CODES,
  REPO_CHECK_FORMAT,
} from "../../src/repo/index.js";

const read = (rel: string) =>
  fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function section(doc: string, title: string): string {
  const from = doc.indexOf(`\n## ${title}\n`);
  if (from < 0) throw new Error(`docs/lint.md has no section ${title}`);
  const next = doc.indexOf("\n## ", from + 1);
  return doc.slice(from, next < 0 ? undefined : next);
}

describe("docs of repo-check", () => {
  const doc = section(read("../../docs/lint.md"), "Repository check");

  it("names every finding code, the report format and the caps", () => {
    for (const code of REPO_CHECK_CODES) {
      expect(doc, code).toContain(`\`${code}\``);
    }
    expect(doc).toContain(REPO_CHECK_FORMAT);
    expect(doc).toContain(String(MAX_TREE_ENTRIES));
    expect(doc).toContain(String(MAX_SPEC_FILES));
    expect(MAX_LISTING_BYTES).toBe(4 * 1024 * 1024);
    expect(doc).toContain("4 MiB");
  });

  it("says CI runs it on every pull request", () => {
    expect(doc).toContain("on every pull request");
  });

  it("is in the README and the changelog", () => {
    expect(read("../../README.md")).toContain("spec-gate repo-check");
    expect(read("../../CHANGELOG.md")).toContain("spec-gate repo-check");
  });
});

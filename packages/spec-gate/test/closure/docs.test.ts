import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IGNORE_REASONS, ROW_STATES } from "../../src/closure/index.js";

const read = (rel: string): string =>
  fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("docs/closure.md", () => {
  const doc = read("../../docs/closure.md");

  it("names every ignore reason and every row state", () => {
    for (const reason of IGNORE_REASONS) expect(doc).toContain(`\`${reason}\``);
    for (const state of ROW_STATES) expect(doc).toContain(`\`${state}\``);
  });

  it("is linked from the README and the changelog names the verb", () => {
    expect(read("../../README.md")).toContain("docs/closure.md");
    expect(read("../../CHANGELOG.md")).toContain("spec-gate closure");
  });
});

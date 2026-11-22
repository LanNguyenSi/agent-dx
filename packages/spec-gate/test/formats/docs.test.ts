import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REFERENCE_STATES,
  markdownCell,
  renderFieldLayerTable,
  renderIdPrefixTable,
  renderKindTable,
  renderReferenceStateTable,
} from "../../src/formats/index.js";

const docPath = fileURLToPath(
  new URL("../../docs/formats.md", import.meta.url),
);
const doc = fs.readFileSync(docPath, "utf8");

function block(name: string): string {
  const begin = `<!-- BEGIN generated: ${name} -->`;
  const end = `<!-- END generated: ${name} -->`;
  const from = doc.indexOf(begin);
  const to = doc.indexOf(end);
  if (from < 0 || to < 0 || to < from) {
    throw new Error(`docs/formats.md has no generated block ${name}`);
  }
  return doc.slice(from + begin.length, to).trim();
}

describe("markdownCell", () => {
  it("escapes pipes and backslashes and flattens line breaks", () => {
    expect(markdownCell("a | b")).toBe("a \\| b");
    expect(markdownCell("a\\b")).toBe("a\\\\b");
    expect(markdownCell("a\nb")).toBe("a b");
    expect(markdownCell("plain")).toBe("plain");
  });
});

describe("docs/formats.md", () => {
  it("embeds the reference-state table exactly as the constants render it", () => {
    expect(block("reference-states")).toBe(renderReferenceStateTable());
  });

  it("embeds the field-to-layer table exactly as the constants render it", () => {
    expect(block("field-layers")).toBe(renderFieldLayerTable());
  });

  it("embeds the per-kind table exactly as the constants render it", () => {
    expect(block("kinds")).toBe(renderKindTable());
  });

  it("embeds the ID prefix table exactly as the constants render it", () => {
    expect(block("id-prefixes")).toBe(renderIdPrefixTable());
  });

  it("has one row per reference-state entry", () => {
    const rows = block("reference-states").split("\n").slice(2);
    expect(rows).toHaveLength(REFERENCE_STATES.length);
  });

  it("is linked from the README", () => {
    const readme = fs.readFileSync(
      fileURLToPath(new URL("../../README.md", import.meta.url)),
      "utf8",
    );
    expect(readme).toContain("docs/formats.md");
  });

  it("carries no run identifiers, dates, long dashes or home paths", () => {
    expect(doc).not.toMatch(/\b(?:F|N|P|Q|R5|D|O|T)-\d+\b/);
    expect(doc).not.toMatch(/\b20\d\d-\d\d-\d\d\b(?!T)/);
    expect(doc).not.toContain(String.fromCharCode(0x2014));
    expect(doc).not.toContain(String.fromCharCode(0x2013));
    expect(doc).not.toContain("/Users/");
  });
});

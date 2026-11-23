import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FILE_ERROR_CODES,
  MAX_FILE_BYTES,
  REPORT_FORMAT,
  RULES,
  renderRuleTable,
} from "../../src/lint/index.js";

const read = (rel: string) =>
  fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const doc = read("../../docs/lint.md");

function block(name: string): string {
  const begin = `<!-- BEGIN generated: ${name} -->`;
  const end = `<!-- END generated: ${name} -->`;
  const from = doc.indexOf(begin);
  const to = doc.indexOf(end);
  if (from < 0 || to < 0 || to < from) {
    throw new Error(`docs/lint.md has no generated block ${name}`);
  }
  return doc.slice(from + begin.length, to).trim();
}

describe("docs/lint.md", () => {
  it("embeds the rule table exactly as the registry renders it", () => {
    expect(block("rules")).toBe(renderRuleTable());
  });

  it("has one row per registered rule", () => {
    const rows = block("rules").split("\n").slice(2);
    expect(rows).toHaveLength(RULES.length);
  });

  it("names every rule, file error code, the report format and the size limit", () => {
    for (const rule of RULES) expect(doc, rule.id).toContain(`\`${rule.id}\``);
    for (const code of FILE_ERROR_CODES)
      expect(doc, code).toContain(`\`${code}\``);
    expect(doc).toContain(REPORT_FORMAT);
    expect(MAX_FILE_BYTES).toBe(4 * 1024 * 1024);
    expect(doc).toContain("4 MiB");
  });

  it("documents the exit codes, the flags, the verbs and the files", () => {
    for (const word of [
      "--strict",
      "--final",
      "--profile",
      "--config",
      "--repo",
      "--default-ref",
      "--base",
      "## Git inputs",
      "rule-skipped",
      "lint-ack",
      "acks.yaml",
      "source/meta.json",
      "triage.json",
      "profile_source",
      "## Exit codes",
    ]) {
      expect(doc, word).toContain(word);
    }
    expect(doc).toMatch(/\| 0 \|/);
    expect(doc).toMatch(/\| 1 \|/);
    expect(doc).toMatch(/\| 2 \|/);
  });

  it("is linked from the README and the changelog names the verb", () => {
    expect(read("../../README.md")).toContain("docs/lint.md");
    expect(read("../../CHANGELOG.md")).toContain("spec-gate lint");
  });
});

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DIGEST_ERROR_CODES,
  DIGEST_FORMAT,
  PLAN_FIELD_CLASSES,
} from "../../src/canonical/index.js";
import { FIELD_LAYERS } from "../../src/formats/index.js";

const read = (rel: string) =>
  fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const doc = read("../../docs/digest.md");

describe("docs/digest.md", () => {
  it("is linked from the README and the changelog names the verb", () => {
    expect(read("../../README.md")).toContain("docs/digest.md");
    expect(read("../../CHANGELOG.md")).toContain("spec-gate digest");
  });

  it("names every error code", () => {
    for (const code of DIGEST_ERROR_CODES) {
      expect(doc, code).toContain(`\`${code}\``);
    }
  });

  it("names the format constant and the excluded inputs", () => {
    expect(doc).toContain(DIGEST_FORMAT);
    for (const word of [
      "status",
      "superseded_by",
      "Context",
      "bindings.yaml",
      "bindings.log",
      "acks.yaml",
      "notes",
      "source/",
      "questions.json",
      "triage.json",
      "evidence/",
      "retired_ids",
      "RFC 8785",
    ]) {
      expect(doc, word).toContain(word);
    }
  });

  it("lists every normative test-plan field under its class", () => {
    const section = (label: string): string[] => {
      const m = new RegExp(`- ${label} test-plan fields: ([^;.]*[;.])`).exec(
        doc.replace(/\n\s+/g, " "),
      );
      expect(m, label).not.toBeNull();
      return [...m![1]!.matchAll(/`([a-z_]+)`/g)].map((x) => x[1]!);
    };
    const prose = section("prose");
    const exact = section("exact");
    const byClass = (cls: string) =>
      Object.entries(PLAN_FIELD_CLASSES)
        .filter(([, c]) => c === cls)
        .map(([f]) => f)
        .sort();
    expect([...prose].sort()).toEqual(byClass("prose"));
    expect([...exact].sort()).toEqual(byClass("exact"));
  });

  it("states that the frontmatter id is part of the digest", () => {
    expect(doc).toMatch(/frontmatter's `id`, `base_commit`/);
    expect(doc).not.toMatch(/stays out[\s\S]*frontmatter `id`/);
  });

  it("names the normative reference to a command", () => {
    expect(FIELD_LAYERS["check_command_ref"]).toBe("normative");
    expect(doc).toContain("check_command_ref");
  });

  it("carries no run identifiers, dates, long dashes or home paths", () => {
    expect(doc).not.toMatch(/\b(?:F|N|P|Q|R5|D|O|T)-\d+\b/);
    expect(doc).not.toMatch(/\b20\d\d-\d\d-\d\d\b(?!T)/);
    expect(doc).not.toContain(String.fromCharCode(0x2014));
    expect(doc).not.toContain(String.fromCharCode(0x2013));
    expect(doc).not.toContain("/Users/");
  });
});

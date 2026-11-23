import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DIGEST_ERROR_CODES,
  DIGEST_FORMAT,
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

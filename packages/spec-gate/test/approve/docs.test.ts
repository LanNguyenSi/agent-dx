import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APPROVE_FORMAT,
  APPROVER_PROBLEMS,
  CONDITIONS,
  FAILURE_CODES,
  GAPS,
} from "../../src/approve/index.js";
import {
  CI_RUN_STATES,
  ENFORCEMENT_STATES,
  REVIEW_PATHS,
  REVIEW_STATES,
} from "../../src/host/index.js";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const doc = fs.readFileSync(at("../../docs/approve.md"), "utf8");

/** The section of the doc for one condition: from its heading to the next one. */
function section(condition: number): string {
  const from = doc.indexOf(`\n### ${condition}. `);
  expect(from, `section ${condition}`).toBeGreaterThan(-1);
  const to = doc.indexOf("\n## ", from + 1);
  const next = doc.indexOf("\n### ", from + 1);
  const end = next > -1 && next < to ? next : to;
  return doc.slice(from, end);
}

describe("docs/approve.md", () => {
  it("has one table row and one section per condition", () => {
    for (const c of CONDITIONS) {
      expect(doc).toContain(`| ${c.condition} | \`${c.name}\` |`);
      expect(section(c.condition)).toContain("Codes:");
    }
    expect(CONDITIONS.map((c) => c.condition)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("names every failure code in the section of each condition that uses it, and only there", () => {
    for (const [code, conditions] of Object.entries(FAILURE_CODES)) {
      for (const c of CONDITIONS) {
        const codes = section(c.condition).split("Codes:")[1]!;
        expect(
          codes.includes(`\`${code}\``),
          `${code} in the codes of condition ${c.condition}`,
        ).toBe((conditions as readonly number[]).includes(c.condition));
      }
    }
  });

  it("names the format, the approver problems, the gaps and the host vocabulary", () => {
    expect(doc).toContain(APPROVE_FORMAT);
    for (const word of [
      ...APPROVER_PROBLEMS,
      ...GAPS.map((gap) => gap.code),
      ...REVIEW_STATES,
      ...ENFORCEMENT_STATES,
      ...CI_RUN_STATES,
      ...REVIEW_PATHS,
      "approve_reported",
      "last_config_commit",
      "pull_request",
    ]) {
      expect(doc, word).toContain(`\`${word}\``);
    }
  });

  it("states the boundary and the gaps", () => {
    for (const phrase of [
      "It cannot say that a person approved",
      "Admin bypass",
      "Squash merges",
      "no cold-read format exists yet",
      "never from text of the\n  pull request",
    ]) {
      expect(doc).toContain(phrase);
    }
  });
});

describe("the approval sources", () => {
  const sources = ["../../src/approve", "../../src/host"].flatMap((rel) =>
    fs
      .readdirSync(at(rel))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(at(rel), name)),
  );

  it("start no process and open no connection of their own: git goes through the hardened readers", () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8");
      const imports = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${path.basename(file)} imports ${spec}`).toMatch(
          /^(\.{1,2}\/|node:(fs|path|crypto)$)/,
        );
      }
      expect(text, path.basename(file)).not.toMatch(
        /\b(fetch|require|XMLHttpRequest|WebSocket)\s*\(/,
      );
      expect(text, path.basename(file)).not.toMatch(/\bimport\s*\(/);
    }
  });

  it("the only git arguments they write are a read of a tree", () => {
    const calls = sources.flatMap((file) =>
      [
        ...fs
          .readFileSync(file, "utf8")
          .matchAll(/runGit\(\s*\w+,\s*\[([^\]]*)\]/g),
      ].map((m) => m[1]!.replace(/\s+/g, " ").trim()),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(
      /^"ls-tree", "-r", "-z", "--full-tree", "--end-of-options", commit, "--", prefix,?$/,
    );
  });
});

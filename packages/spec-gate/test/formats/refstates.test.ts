import { describe, expect, it } from "vitest";
import {
  REFERENCE_STATES,
  referenceStateOf,
  renderReferenceStateTable,
} from "../../src/formats/index.js";

describe("reference states", () => {
  const ids = REFERENCE_STATES.map((r) => r.id);

  it("covers every input: each file, base_commit, commands_ref, the binding reference, the start commit and evidence", () => {
    expect(ids).toEqual([
      "spec",
      "testplan",
      "bindings",
      "triage",
      "questions",
      "config",
      "commands",
      "source-meta",
      "base-commit",
      "commands-ref",
      "binding-reference",
      "start-commit",
      "evidence",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("states revision, setter, step, storage and ancestry check for every row", () => {
    for (const r of REFERENCE_STATES) {
      for (const field of [
        r.input,
        r.revisionRead,
        r.setBy,
        r.step,
        r.storedIn,
        r.ancestryCheck,
      ]) {
        expect(field.trim().length, `${r.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("has a code step, never a model role, set every reference revision", () => {
    const references = REFERENCE_STATES.filter((r) => r.kind === "reference");
    expect(references.map((r) => r.id)).toEqual([
      "base-commit",
      "commands-ref",
      "binding-reference",
      "start-commit",
      "evidence",
    ]);
    for (const r of references) {
      expect(r.setByCode, r.id).toBe(true);
      expect(r.setBy, r.id).not.toMatch(/translator|discoverer|cold-reader/);
    }
  });

  it("stores base_commit and commands_ref in source/meta.json, set by intake", () => {
    for (const id of ["base-commit", "commands-ref"]) {
      const r = referenceStateOf(id)!;
      expect(r.storedIn).toContain("source/meta.json");
      expect(r.setBy).toContain("intake");
      expect(r.ancestryCheck).toMatch(/ancestor/);
    }
  });

  it("reads repo-wide inputs on the default branch, never at the head of a spec pull request", () => {
    expect(referenceStateOf("config")!.revisionRead).toMatch(
      /never the head of a spec pull request/,
    );
    expect(referenceStateOf("commands")!.revisionRead).toContain(
      "commands_ref",
    );
  });

  it("names the baseline and closure rules for evidence", () => {
    const e = referenceStateOf("evidence")!;
    expect(e.ancestryCheck).toContain("baseline");
    expect(e.ancestryCheck).toContain("closure");
    expect(e.ancestryCheck).toContain("squash");
  });

  it("finds a row by id and returns nothing for an unknown id", () => {
    expect(referenceStateOf("spec")!.input).toBe("`spec.md`");
    expect(referenceStateOf("nope")).toBeUndefined();
  });

  it("renders a markdown table with one row per entry and no raw pipe inside a cell", () => {
    const lines = renderReferenceStateTable().split("\n");
    expect(lines).toHaveLength(REFERENCE_STATES.length + 2);
    for (const line of lines.slice(2)) {
      expect(line.split(/(?<!\\)\|/).length).toBe(8);
    }
  });
});

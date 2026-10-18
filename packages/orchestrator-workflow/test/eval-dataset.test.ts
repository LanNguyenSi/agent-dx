import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  datasetCounts,
  findMachinePath,
  loadDataset,
  substitutePlaceholders,
  validateEntry,
} from "../eval/dataset.js";
import type { DatasetEntry } from "../eval/dataset.js";
import { knownFinding, makeEntry, writeDataset } from "./eval-helpers.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function entry(overrides: Partial<DatasetEntry> = {}): DatasetEntry {
  return makeEntry(
    { dir: "/repo/local", baseSha: SHA_A, headSha: SHA_B, futureSha: SHA_B },
    overrides,
  );
}

function errorsOf(raw: unknown): string[] {
  return validateEntry(raw).errors;
}

describe("validateEntry", () => {
  it("accepts a finding entry and a control entry", () => {
    expect(validateEntry(entry()).valid).toBe(true);
    expect(
      validateEntry(entry({ kind: "control", known_findings: [] })).valid,
    ).toBe(true);
  });

  it("rejects a non-object and a wrong schema version", () => {
    expect(errorsOf("x")).toEqual(["<root>: expected an object"]);
    expect(errorsOf({ ...entry(), schema: 2 })).toContain("schema: expected 1");
  });

  it("rejects a bad id, kind and review method", () => {
    const errors = errorsOf({
      ...entry(),
      id: "Bad Id",
      kind: "other",
      review_method: "gentle",
    });
    expect(errors.some((e) => e.startsWith("id:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("kind:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("review_method:"))).toBe(true);
  });

  it("requires full shas that differ", () => {
    const base = entry();
    expect(
      errorsOf({ ...base, repo: { ...base.repo, head_sha: "abc1234" } }),
    ).toContain("repo.head_sha: expected a full 40-character lowercase sha");
    expect(
      errorsOf({ ...base, repo: { ...base.repo, base_sha: SHA_B } }),
    ).toContain("repo: head_sha and base_sha must differ");
  });

  it("keeps setup commands inside the checkout", () => {
    const base = entry();
    expect(
      errorsOf({ ...base, setup: [{ cwd: "../x", argv: ["npm", "ci"] }] }),
    ).toContain("setup[0].cwd: must stay inside the checkout (got ../x)");
    expect(
      errorsOf({ ...base, setup: [{ cwd: "/abs", argv: ["npm", "ci"] }] }),
    ).toContain("setup[0].cwd: must stay inside the checkout (got /abs)");
    expect(errorsOf({ ...base, setup: [{ cwd: ".", argv: [] }] })).toContain(
      "setup[0].argv: expected a non-empty array of strings",
    );
    expect(
      errorsOf({
        ...base,
        setup: [{ cwd: ".", argv: ["npm"], timeout_s: -1 }],
      }),
    ).toContain("setup[0].timeout_s: expected a positive number");
  });

  it("needs a medium or higher known finding on a finding entry", () => {
    const onlyLow = entry({ known_findings: [knownFinding("K1", "low")] });
    expect(errorsOf(onlyLow)).toContain(
      "known_findings: a finding entry needs at least one medium or higher known finding",
    );
    expect(
      errorsOf(entry({ known_findings: [] })).some((e) =>
        e.includes("at least one medium"),
      ),
    ).toBe(true);
  });

  it("rejects known findings on a control entry", () => {
    expect(
      errorsOf(entry({ kind: "control" })).some((e) =>
        e.includes("a control entry must list none"),
      ),
    ).toBe(true);
  });

  it("rejects duplicate known ids and bad severities", () => {
    const errors = errorsOf(
      entry({
        known_findings: [
          knownFinding("K1"),
          knownFinding("K1"),
          { ...knownFinding("K2"), severity: "huge" as never },
        ],
      }),
    );
    expect(errors).toContain("known_findings[1].id: duplicate id K1");
    expect(errors.some((e) => e.startsWith("known_findings[2].severity"))).toBe(
      true,
    );
  });

  it("rejects a machine path in the brief or the task spec", () => {
    const home = ["", "Users", "someone", "work"].join("/");
    const errors = errorsOf(entry({ brief: `see ${home}/file` }));
    expect(
      errors.some((e) => e.startsWith("brief: contains a machine path")),
    ).toBe(true);
    expect(
      errorsOf(entry({ task_spec: `at ${home}` })).some((e) =>
        e.startsWith("task_spec: contains a machine path"),
      ),
    ).toBe(true);
  });

  it("needs provenance with a positive round", () => {
    expect(
      errorsOf({ ...entry(), provenance: { source: "x", round: 0 } }),
    ).toContain("provenance.round: expected a positive integer");
    expect(errorsOf({ ...entry(), provenance: undefined })).toContain(
      "provenance: expected an object",
    );
  });
});

describe("findMachinePath", () => {
  it("finds a home path and ignores relative or system paths", () => {
    expect(findMachinePath(`x ${["", "home", "dev", "a"].join("/")}`)).toBe(
      ["", "home", "dev"].join("/"),
    );
    expect(findMachinePath("see src/index.ts and /usr/bin/git")).toBeNull();
  });
});

describe("substitutePlaceholders", () => {
  const values = {
    WORKTREE: "/w",
    EVIDENCE_DIR: "/e",
    RUN_DIR: "/r",
    BASE_SHA: "base",
    HEAD_SHA: "head",
  };

  it("replaces every known placeholder, repeated ones included", () => {
    expect(
      substitutePlaceholders(
        "{{WORKTREE}} {{WORKTREE}} {{BASE_SHA}}..{{HEAD_SHA}}",
        values,
      ),
    ).toBe("/w /w base..head");
  });

  it("leaves unknown double-brace text alone", () => {
    expect(
      substitutePlaceholders(
        "{{OTHER}} {{ WORKTREE }} {{EVIDENCE_DIR}}",
        values,
      ),
    ).toBe("{{OTHER}} {{ WORKTREE }} /e");
  });
});

describe("loadDataset", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });
  const fresh = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "ow-eval-ds-"));
    dirs.push(dir);
    return dir;
  };

  it("loads a valid dataset and counts kinds", () => {
    const dir = fresh();
    writeDataset(dir, [
      entry({ id: "f-1" }),
      entry({ id: "c-1", kind: "control", known_findings: [] }),
    ]);
    const loaded = loadDataset(dir);
    expect(loaded.errors).toEqual([]);
    expect(datasetCounts(loaded.dataset!)).toEqual({ finding: 1, control: 1 });
  });

  it("reports a missing index and a broken entry file", () => {
    const dir = fresh();
    expect(loadDataset(dir).errors[0]).toContain("index.json not found");
    writeDataset(dir, [entry({ id: "f-1" })]);
    writeFileSync(join(dir, "entries", "f-1.json"), "{not json");
    const loaded = loadDataset(dir);
    expect(loaded.dataset).toBeNull();
    expect(loaded.errors[0]).toContain("entries/f-1.json");
  });

  it("reports an invalid entry with its file name", () => {
    const dir = fresh();
    writeDataset(dir, [entry({ id: "f-1", known_findings: [] })]);
    const loaded = loadDataset(dir);
    expect(
      loaded.errors.some((e) =>
        e.startsWith("entries/f-1.json: known_findings"),
      ),
    ).toBe(true);
  });

  it("rejects an index whose id or kind disagrees with the entry file", () => {
    const dir = fresh();
    writeDataset(dir, [entry({ id: "f-1" })]);
    writeFileSync(
      join(dir, "index.json"),
      JSON.stringify({
        schema: 1,
        entries: [{ id: "f-1", kind: "control", file: "entries/f-1.json" }],
      }),
    );
    expect(loadDataset(dir).errors[0]).toContain("does not match index kind");
    writeFileSync(
      join(dir, "index.json"),
      JSON.stringify({
        schema: 1,
        entries: [{ id: "f-2", kind: "finding", file: "entries/f-1.json" }],
      }),
    );
    expect(loadDataset(dir).errors[0]).toContain("does not match index id");
  });

  it("rejects duplicate index ids and escaping file paths", () => {
    const dir = fresh();
    writeDataset(dir, [entry({ id: "f-1" })]);
    writeFileSync(
      join(dir, "index.json"),
      JSON.stringify({
        schema: 1,
        entries: [
          { id: "f-1", kind: "finding", file: "entries/f-1.json" },
          { id: "f-1", kind: "finding", file: "entries/f-1.json" },
          { id: "f-3", kind: "finding", file: "../x.json" },
        ],
      }),
    );
    const errors = loadDataset(dir).errors;
    expect(errors).toContain("index.json: duplicate id f-1");
    expect(errors.some((e) => e.includes("must stay inside the dataset"))).toBe(
      true,
    );
  });
});

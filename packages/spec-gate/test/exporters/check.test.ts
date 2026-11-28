/**
 * `spec-gate export --check`: the exit codes, the missing-id list and its
 * order, and the token boundary that keeps `#AC-1` from matching inside
 * `#AC-10` or the id of one spec from answering for a longer token.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli, scratch } from "../lint/helpers.js";
import { containsQualifiedId } from "../../src/exporters/index.js";
import { fixtureText } from "./repo.js";

const CHECK_FIXTURES = fileURLToPath(
  new URL("../fixtures/export-check", import.meta.url),
);

/** A spec directory with the export fixture's `spec.md` and `testplan.yaml`. */
function checkDir(): string {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, "spec.md"), fixtureText("spec.md"));
  fs.writeFileSync(
    path.join(dir, "testplan.yaml"),
    fixtureText("testplan.yaml"),
  );
  return dir;
}

async function checkRun(name: string, extraArgs: string[] = []) {
  return runCli([
    "export",
    checkDir(),
    "--check",
    ...(name === "" ? [] : [path.join(CHECK_FIXTURES, name)]),
    ...extraArgs,
  ]);
}

describe("spec-gate export --check and the spec directory path", () => {
  it("refuses a spec directory that is a symlink before reading spec.md", async () => {
    const real = checkDir();
    const link = path.join(scratch(), "spec-link");
    fs.symlinkSync(real, link);
    for (const suffix of ["", "/", "/."]) {
      const run = await runCli([
        "export",
        `${link}${suffix}`,
        "--check",
        path.join(CHECK_FIXTURES, "return-ok.yaml"),
      ]);
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("spec-dir-invalid");
      expect(run.stderr).toContain(
        `${link}${suffix} is a symlink, refusing to read it`,
      );
    }
  });

  it("keeps the outcome for a missing spec directory and a regular file", async () => {
    const holder = scratch();
    const ret = path.join(CHECK_FIXTURES, "return-ok.yaml");
    const missing = path.join(holder, "nope");
    const run = await runCli(["export", missing, "--check", ret]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("input-missing");
    const file = path.join(holder, "file");
    fs.writeFileSync(file, "x");
    const second = await runCli(["export", file, "--check", ret]);
    expect(second.code).toBe(2);
    expect(second.stdout).toBe("");
    expect(second.stderr).toContain("input-missing");
  });

  it("keeps the outcome for a real spec directory", async () => {
    const run = await checkRun("return-ok.yaml");
    expect(run.code).toBe(0);
  });
});

describe("spec-gate export --check", () => {
  it("exits 0 when every qualified id appears in a task", async () => {
    const run = await checkRun("return-ok.yaml");
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  it("exits 1 and lists the missing ids in id order", async () => {
    const run = await checkRun("return-missing.yaml");
    expect(run.code).toBe(1);
    expect(run.stdout).toBe(
      "missing tiny-valid#AC-2\nmissing tiny-valid#TP-3\n",
    );
  });

  it("refuses a prefix match: #AC-10 does not answer for #AC-1", async () => {
    const run = await checkRun("return-trap.yaml");
    expect(run.code).toBe(1);
    expect(run.stdout).toBe(
      "missing tiny-valid#AC-1\nmissing tiny-valid#AC-2\n",
    );
  });

  it("exits 2 on a return that is not valid YAML", async () => {
    const run = await checkRun("return-broken.yaml");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("export: return-parse");
  });

  it("exits 2 when the return has no tasks list", async () => {
    const run = await checkRun("return-shape.yaml");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("export: return-shape");
  });

  it("exits 2 when the return file does not exist", async () => {
    const run = await checkRun("return-absent.yaml");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("export: return-unreadable");
  });

  it("refuses --check together with the export flags", async () => {
    const run = await checkRun("return-ok.yaml", ["--repo", CHECK_FIXTURES]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("export: usage");
  });

  /** Runs `--check` over a slicer return with this text. */
  async function checkText(text: string) {
    const file = path.join(scratch(), "return.yaml");
    fs.writeFileSync(file, text);
    return runCli(["export", checkDir(), "--check", file]);
  }

  const ALL_IDS = [
    "tiny-valid#AC-1",
    "tiny-valid#AC-2",
    "tiny-valid#TP-1",
    "tiny-valid#TP-2",
    "tiny-valid#TP-3",
    "tiny-valid#TP-4",
  ];

  it("finds ids that appear only inside a list field of a task", async () => {
    const run = await checkText(
      `tasks:\n  - id: T-1\n    acceptance_criteria:\n${ALL_IDS.map(
        (id) => `      - "${id}: shown"\n`,
      ).join("")}`,
    );
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("");
    expect(run.code).toBe(0);
  });

  it("finds ids in a list nested in a list and in a mapping inside a list", async () => {
    const run = await checkText(
      "tasks:\n" +
        "  - id: T-1\n" +
        "    groups:\n" +
        `      - - "${ALL_IDS[0]}"\n` +
        `        - - "${ALL_IDS[1]}"\n` +
        `          - "${ALL_IDS[2]}"\n` +
        `      - tests:\n` +
        `          - name: "${ALL_IDS[3]}"\n` +
        `          - "${ALL_IDS[4]}"\n`,
    );
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(`missing ${ALL_IDS[5]}\n`);
    expect(run.code).toBe(1);
  });

  it.each([
    ["a string", `"${ALL_IDS.join(" ")}"`],
    ["null", "null"],
    ["a list", `["${ALL_IDS.join('", "')}"]`],
    ["a number", "7"],
  ])("exits 2 when a task is %s", async (_what, task) => {
    const run = await checkText(`tasks:\n  - id: T-1\n  - ${task}\n`);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      "export: return-shape: task 1 of the slicer return must be a mapping",
    );
    expect(run.stdout).toBe("");
  });

  it("refuses a --check option without a path", async () => {
    const run = await runCli(["export", checkDir(), "--check"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("argument missing");
  });
});

describe("containsQualifiedId", () => {
  const id = "tiny-valid#AC-1";

  it.each([
    ["the id alone", id],
    ["at the start", `${id} and more`],
    ["at the end", `more ${id}`],
    ["between punctuation", `(${id}, ${id}.`],
    ["before another id's hash", `${id}#suffix`],
  ])("matches %s", (_what, text) => {
    expect(containsQualifiedId(text, id)).toBe(true);
  });

  it.each([
    ["inside a longer number", "tiny-valid#AC-10"],
    ["inside a longer spec id", "x-tiny-valid#AC-1"],
    ["inside an underscore token", "x_tiny-valid#AC-1"],
    ["after a letter", "Xtiny-valid#AC-1"],
  ])("refuses %s", (_what, text) => {
    expect(containsQualifiedId(text, id)).toBe(false);
  });

  it("matches in one of several occurrences", () => {
    expect(
      containsQualifiedId("tiny-valid#AC-10 then (tiny-valid#AC-1)", id),
    ).toBe(true);
  });
});

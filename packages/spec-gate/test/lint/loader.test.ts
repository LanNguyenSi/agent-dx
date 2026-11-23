import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  lintSpecDir,
  parseSourceMeta,
  readSpecFile,
  type LintReport,
} from "../../src/lint/index.js";
import { execFileSync } from "node:child_process";
import { edited, runCli, scratch, specDir } from "./helpers.js";

function lint(dir: string, options = {}): LintReport {
  const result = lintSpecDir(dir, options);
  if (!result.ok) throw new Error(result.message);
  return result.report;
}

function summary(report: LintReport) {
  return report.errors.map((f) => `${f.rule} ${f.file} ${f.code ?? ""}`.trim());
}

describe("readSpecFile", () => {
  it("reads a regular UTF-8 file", () => {
    const dir = specDir();
    const read = readSpecFile(dir, "spec.md");
    expect(read.ok).toBe(true);
  });

  it("reports a missing file as input-missing", () => {
    const dir = specDir({ "bindings.yaml": null });
    expect(readSpecFile(dir, "bindings.yaml")).toMatchObject({
      ok: false,
      code: "input-missing",
    });
  });

  it("refuses a symlink, even to a regular file", () => {
    const dir = specDir();
    fs.renameSync(path.join(dir, "spec.md"), path.join(dir, "real.md"));
    fs.symlinkSync("real.md", path.join(dir, "spec.md"));
    expect(readSpecFile(dir, "spec.md")).toMatchObject({
      ok: false,
      code: "input-not-regular",
    });
  });

  it("refuses a directory in place of a file", () => {
    const dir = specDir();
    fs.rmSync(path.join(dir, "bindings.yaml"));
    fs.mkdirSync(path.join(dir, "bindings.yaml"));
    expect(readSpecFile(dir, "bindings.yaml")).toMatchObject({
      ok: false,
      code: "input-not-regular",
    });
  });

  it("refuses a file below a directory that is a symlink", () => {
    const dir = specDir();
    const outside = scratch();
    fs.copyFileSync(
      path.join(dir, "source", "meta.json"),
      path.join(outside, "meta.json"),
    );
    fs.rmSync(path.join(dir, "source"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, "source"));
    expect(readSpecFile(dir, "source/meta.json")).toMatchObject({
      ok: false,
      code: "input-not-regular",
    });
  });

  it("reports a missing directory above the file as input-missing", () => {
    const dir = specDir({ "source/meta.json": null });
    expect(readSpecFile(dir, "source/meta.json")).toMatchObject({
      ok: false,
      code: "input-missing",
    });
  });

  it("refuses a file over the size limit and accepts one at the limit", () => {
    const dir = scratch();
    fs.writeFileSync(
      path.join(dir, "big"),
      Buffer.alloc(MAX_FILE_BYTES + 1, 97),
    );
    expect(readSpecFile(dir, "big")).toMatchObject({
      ok: false,
      code: "input-too-large",
    });
    fs.writeFileSync(path.join(dir, "edge"), Buffer.alloc(MAX_FILE_BYTES, 97));
    expect(readSpecFile(dir, "edge").ok).toBe(true);
  });

  it("refuses bytes that are not UTF-8 instead of replacing them", () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, "bad"), Buffer.from([0x61, 0xff, 0x62]));
    expect(readSpecFile(dir, "bad")).toMatchObject({
      ok: false,
      code: "input-not-utf8",
    });
  });

  it("never puts the directory in a message", () => {
    const dir = scratch();
    for (const rel of ["missing", "a/b"]) {
      const read = readSpecFile(dir, rel);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.message).not.toContain(dir);
    }
  });
});

describe("loader findings", () => {
  it("a missing required file is a file error, not an exception", () => {
    for (const name of ["spec.md", "testplan.yaml"]) {
      const report = lint(specDir({ [name]: null }));
      expect(report.errors).toContainEqual(
        expect.objectContaining({
          rule: "file",
          file: name,
          path: "$",
          code: "input-missing",
          level: "error",
        }),
      );
    }
  });

  it("a missing optional file is no finding", () => {
    const report = lint(
      specDir({
        "bindings.yaml": null,
        "questions.json": null,
        "source/meta.json": null,
        "acks.yaml": null,
      }),
    );
    expect(report.errors).toEqual([]);
  });

  it("an unsafe optional file is a file error", () => {
    const dir = specDir({ "bindings.yaml": null });
    fs.symlinkSync("spec.md", path.join(dir, "bindings.yaml"));
    expect(summary(lint(dir))).toEqual([
      "file bindings.yaml input-not-regular",
    ]);
  });

  it("each unsafe condition of a required file is a file error", () => {
    const big = specDir({ "spec.md": "x".repeat(MAX_FILE_BYTES + 1) });
    expect(summary(lint(big))).toContain("file spec.md input-too-large");
    const dir = specDir();
    fs.writeFileSync(
      path.join(dir, "testplan.yaml"),
      Buffer.from([0xff, 0xfe]),
    );
    expect(summary(lint(dir))).toContain("file testplan.yaml input-not-utf8");
  });

  it("wraps every format error with its code, path, id and line", () => {
    const report = lint(
      specDir({ "spec.md": edited("spec.md", "  - owner: alice\n", "") }),
    );
    expect(report.errors).toContainEqual({
      rule: "format",
      level: "error",
      file: "spec.md",
      path: "AC-1.owner",
      id: "AC-1",
      line: 15,
      code: "missing-attribute",
      message: expect.stringContaining("owner"),
    });
  });

  it("a format error without a line or an id carries neither", () => {
    const report = lint(specDir({ "testplan.yaml": "- [broken" }));
    const finding = report.errors.find((f) => f.rule === "format");
    expect(finding).toBeDefined();
    expect(finding!.id).toBeUndefined();
  });

  it("each file that fails to parse is a format error on that file", () => {
    for (const [name, text] of [
      ["spec.md", "no frontmatter\n"],
      ["testplan.yaml", "- [broken"],
      ["bindings.yaml", "- not a mapping"],
      ["questions.json", "{ not json"],
      ["triage.json", "[]"],
      ["source/meta.json", "{}"],
      ["acks.yaml", "not: a list"],
    ] as const) {
      const report = lint(specDir({ [name]: text }));
      const own = report.errors.filter((f) => f.file === name);
      expect(own.length, name).toBeGreaterThan(0);
      expect(
        own.every((f) => f.rule === "format"),
        name,
      ).toBe(true);
    }
  });

  it("skips the rules that need a file that did not parse, without follow-up findings", () => {
    // testplan.yaml fails: ac-coverage must not report AC-1 as uncovered.
    const planFails = lint(specDir({ "testplan.yaml": "- [broken" }));
    expect(planFails.errors.map((f) => f.rule)).toEqual(["format"]);
    // spec.md fails: no goal-count, ac-coverage or non-goals-empty.
    const specFails = lint(specDir({ "spec.md": "no frontmatter\n" }));
    expect(specFails.errors.map((f) => f.rule)).toEqual(["format"]);
    expect(specFails.spec).toBeNull();
    expect(specFails.status).toBeNull();
  });

  it("a second GOAL is one format error and not also a goal-count error", () => {
    const text = edited(
      "spec.md",
      "- GOAL: Reject a token that was issued before a password change.\n",
      "- GOAL: Reject a token that was issued before a password change.\n- GOAL: Another goal.\n",
    );
    const report = lint(specDir({ "spec.md": text }));
    expect(report.errors.map((f) => f.rule)).toEqual(["format"]);
    expect(report.errors[0]!.code).toBe("duplicate-id");
  });

  it("a spec directory that is not a directory is a failure result, not a finding", () => {
    const dir = scratch();
    expect(lintSpecDir(path.join(dir, "nope"))).toMatchObject({ ok: false });
    fs.writeFileSync(path.join(dir, "file"), "x");
    expect(lintSpecDir(path.join(dir, "file"))).toMatchObject({ ok: false });
  });
});

describe("parseSourceMeta", () => {
  const line = { id: "L1-0123456789ab", kind: "text" };

  it("accepts a list of { id, kind } and ignores the other fields", () => {
    expect(
      parseSourceMeta(JSON.stringify({ sha256: "x", lines: [line] })),
    ).toEqual({ ok: true, value: { lines: [line] } });
    expect(parseSourceMeta('{"lines": []}')).toEqual({
      ok: true,
      value: { lines: [] },
    });
  });

  it("rejects what is not strict JSON, not an object, or has no list", () => {
    const codes = (text: string) => {
      const r = parseSourceMeta(text);
      return r.ok ? [] : r.errors.map((e) => `${e.code} ${e.path}`);
    };
    expect(codes("{ nope")).toEqual(["invalid-json $"]);
    expect(codes("[]")).toEqual(["wrong-type $"]);
    expect(codes("{}")).toEqual(["missing-field lines"]);
    expect(codes('{"lines": {}}')).toEqual(["wrong-type lines"]);
  });

  it("rejects an entry with a bad id, kind or shape, and a repeated id", () => {
    const codes = (lines: unknown[]) => {
      const r = parseSourceMeta(JSON.stringify({ lines }));
      return r.ok ? [] : r.errors.map((e) => `${e.code} ${e.path}`);
    };
    expect(codes(["x"])).toEqual(["wrong-type lines[0]"]);
    expect(codes([{ id: "L1-short", kind: "text" }])).toEqual([
      "invalid-id lines[0].id",
    ]);
    expect(codes([{ id: line.id, kind: "video" }])).toEqual([
      "invalid-value lines[0].kind",
    ]);
    expect(codes([{ kind: "text" }])).toEqual(["invalid-id lines[0].id"]);
    expect(codes([line, line])).toEqual(["duplicate-value lines[1].id"]);
  });
});

describe("a named pipe in place of an input", () => {
  // Run through the bounded CLI: a reader that opens a pipe waits for a
  // writer, and the run is cut off instead of hanging the suite.
  function fifoIn(dir: string, name: string): void {
    fs.rmSync(path.join(dir, name), { force: true });
    execFileSync("mkfifo", [path.join(dir, name)]);
  }

  it.each(["spec.md", "acks.yaml"])(
    "lint reports %s as a file error and does not block",
    async (name) => {
      const dir = specDir();
      fifoIn(dir, name);
      const run = await runCli(["lint", dir], 10_000);
      expect(run.code).toBe(1);
      const parsed = JSON.parse(run.stdout) as LintReport;
      expect(parsed.errors).toContainEqual(
        expect.objectContaining({
          rule: "file",
          file: name,
          code: "input-not-regular",
        }),
      );
    },
    // above the run limit, so the group kill fires before vitest gives up
    30_000,
  );

  it("lint-ack refuses an acks.yaml that is a pipe and does not block", async () => {
    const dir = specDir({ "triage.json": null });
    fifoIn(dir, "acks.yaml");
    const run = await runCli(
      ["lint-ack", dir, "profile-default", "triage", "--reason", "r"],
      10_000,
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("lint-ack:");
  }, 30_000);
});

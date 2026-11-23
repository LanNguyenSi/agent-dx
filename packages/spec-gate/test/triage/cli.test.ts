import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      ...args,
    ]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function discovererDoc(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const values: Record<string, string> = {
    single_goal: "yes",
    code_related: "yes",
    core_is_decision: "no",
    scope_within_request: "yes",
    multiple_repos: "no",
    trivial: "no",
  };
  const doc: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    doc[name] = { value, evidence: "the discoverer's note" };
  }
  doc["blocking_unknowns"] = [];
  return { ...doc, ...overrides };
}

const tmpRoots: string[] = [];

function makeSpecDir(doc: Record<string, unknown> | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-triage-"));
  tmpRoots.push(dir);
  const text = typeof doc === "string" ? doc : JSON.stringify(doc, null, 2);
  fs.writeFileSync(path.join(dir, "triage.json"), text);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("spec-gate triage", () => {
  it("derives the class, writes it back and prints the report", async () => {
    const dir = makeSpecDir(
      discovererDoc({ code_related: { value: "no", evidence: "not code" } }),
    );
    const run = await runCli(["triage", dir]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      class: "unsuitable",
      rule_version: 1,
      row: 1,
      unknown_fields: [],
      profile: null,
    });
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, "triage.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(written["class"]).toBe("unsuitable");
    expect(written["rule_version"]).toBe(1);
  });

  it("overwrites an earlier class that disagrees with the fields", async () => {
    const dir = makeSpecDir(
      discovererDoc({
        single_goal: { value: "no", evidence: "two goals" },
        class: "actionable",
        rule_version: 1,
      }),
    );
    const run = await runCli(["triage", dir]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ class: "split", row: 3 });
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, "triage.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(written["class"]).toBe("split");
  });

  it("keeps every other field and the key order, 2-space, trailing newline", async () => {
    const dir = makeSpecDir(
      discovererDoc({ trivial: { value: "yes", evidence: "one line" } }),
    );
    const run = await runCli(["triage", dir]);
    expect(run.code).toBe(0);
    const text = fs.readFileSync(path.join(dir, "triage.json"), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "trivial": {');
    expect(text).toContain("one line");
    const written = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual([
      "single_goal",
      "code_related",
      "core_is_decision",
      "scope_within_request",
      "multiple_repos",
      "trivial",
      "blocking_unknowns",
      "class",
      "rule_version",
    ]);
  });

  it("a parse error exits non-zero, prints the parser errors, file unchanged", async () => {
    const dir = makeSpecDir("{ not json");
    const before = fs.readFileSync(path.join(dir, "triage.json"));
    const run = await runCli(["triage", dir]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("invalid-json");
    expect(fs.readFileSync(path.join(dir, "triage.json"))).toEqual(before);
  });

  it("a field the format rejects exits non-zero and leaves the file unchanged", async () => {
    const dir = makeSpecDir(
      discovererDoc({ code_related: { value: "maybe", evidence: "x" } }),
    );
    const before = fs.readFileSync(path.join(dir, "triage.json"));
    const run = await runCli(["triage", dir]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("invalid-value");
    expect(fs.readFileSync(path.join(dir, "triage.json"))).toEqual(before);
  });

  it("a missing triage.json is a named error with a non-zero exit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-triage-"));
    tmpRoots.push(dir);
    const run = await runCli(["triage", dir]);
    expect(run.code).not.toBe(0);
    expect(run.stderr.trim()).toBe(`triage: no triage.json in ${dir}`);
  });

  it("a directory named triage.json is a named read error and stays there", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-triage-"));
    tmpRoots.push(dir);
    const file = path.join(dir, "triage.json");
    fs.mkdirSync(file);
    const run = await runCli(["triage", dir]);
    expect(run.code).not.toBe(0);
    expect(run.stderr.trim()).toBe(`triage: cannot read ${file}: EISDIR`);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  it("a symlinked triage.json is refused with a named error and the target is untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-triage-"));
    tmpRoots.push(dir);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gate-triage-"));
    tmpRoots.push(outside);
    const target = path.join(outside, "real-triage.json");
    fs.writeFileSync(target, JSON.stringify(discovererDoc(), null, 2));
    const before = fs.readFileSync(target);
    fs.symlinkSync(target, path.join(dir, "triage.json"));
    const run = await runCli(["triage", dir]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("is a symlink, refusing to read it");
    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.lstatSync(path.join(dir, "triage.json")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("a read-only triage.json is a named write error with the bytes unchanged", async () => {
    const dir = makeSpecDir(discovererDoc());
    const file = path.join(dir, "triage.json");
    const before = fs.readFileSync(file);
    fs.chmodSync(file, 0o444);
    try {
      const run = await runCli(["triage", dir]);
      expect(run.code).not.toBe(0);
      expect(run.stderr.trim()).toBe(`triage: cannot write ${file}: EACCES`);
      expect(fs.readFileSync(file)).toEqual(before);
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });

  it("a read-only spec directory is a named write error with the bytes unchanged", async () => {
    const dir = makeSpecDir(discovererDoc());
    const file = path.join(dir, "triage.json");
    const before = fs.readFileSync(file);
    fs.chmodSync(dir, 0o555);
    try {
      const run = await runCli(["triage", dir]);
      expect(run.code).not.toBe(0);
      expect(run.stderr.trim()).toBe(`triage: cannot write ${file}: EACCES`);
      expect(fs.readFileSync(file)).toEqual(before);
      expect(fs.readdirSync(dir)).toEqual(["triage.json"]);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it("the report profile follows the class", async () => {
    for (const [doc, profile] of [
      [discovererDoc({ trivial: { value: "yes", evidence: "e" } }), "light"],
      [discovererDoc(), "full"],
      [
        discovererDoc({ core_is_decision: { value: "yes", evidence: "e" } }),
        null,
      ],
    ] as [Record<string, unknown>, string | null][]) {
      const dir = makeSpecDir(doc);
      const run = await runCli(["triage", dir]);
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout).profile, JSON.stringify(doc)).toBe(profile);
    }
  });

  it("requires the <spec-dir> argument", async () => {
    const run = await runCli(["triage"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("missing required argument");
  });
});

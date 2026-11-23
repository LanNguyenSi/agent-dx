import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runTriage } from "../../src/triage/run.js";

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

function mkdtemp(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spec-gate-run-${label}-`));
  tmpRoots.push(dir);
  return dir;
}

function makeSpecDir(): { dir: string; file: string; before: Buffer } {
  const dir = mkdtemp("spec");
  const file = path.join(dir, "triage.json");
  fs.writeFileSync(file, JSON.stringify(discovererDoc(), null, 2));
  const before = fs.readFileSync(file);
  return { dir, file, before };
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runTriage write path", () => {
  // A fixed umask that strips group and other write bits, so a mode that
  // carries them (0664, 0666) shows whether the bits are set explicitly.
  let previousUmask = 0;
  beforeAll(() => {
    previousUmask = process.umask(0o022);
  });
  afterAll(() => {
    process.umask(previousUmask);
  });

  for (const mode of [0o600, 0o640, 0o664, 0o666]) {
    it(`keeps a 0${mode.toString(8)} file at 0${mode.toString(8)} after triage`, () => {
      const { dir, file } = makeSpecDir();
      fs.chmodSync(file, mode);
      const result = runTriage(dir);
      expect(result.ok).toBe(true);
      expect(fs.statSync(file).mode & 0o7777).toBe(mode);
      expect(fs.readdirSync(dir)).toEqual(["triage.json"]);
    });
  }

  it("does not delete a foreign regular file at the temporary name", () => {
    const { dir, file, before } = makeSpecDir();
    const temp = `${file}.tmp-${process.pid}`;
    const foreign = "foreign content, never ours";
    fs.writeFileSync(temp, foreign);
    const result = runTriage(dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a write error");
    expect(result.kind).toBe("write-error");
    expect(result.message).toContain("EEXIST");
    expect(fs.readFileSync(temp, "utf8")).toBe(foreign);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("does not delete a symlink at the temporary name or touch its target", () => {
    const { dir, file, before } = makeSpecDir();
    const outside = mkdtemp("outside");
    const target = path.join(outside, "target.txt");
    fs.writeFileSync(target, "target content");
    const targetBefore = fs.readFileSync(target);
    const temp = `${file}.tmp-${process.pid}`;
    fs.symlinkSync(target, temp);
    const result = runTriage(dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a write error");
    expect(result.kind).toBe("write-error");
    expect(result.message).toContain("EEXIST");
    expect(fs.lstatSync(temp).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target)).toEqual(targetBefore);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("drops setuid and sticky bits and keeps the permission bits", () => {
    for (const [given, expected] of [
      [0o4644, 0o644],
      [0o1644, 0o644],
    ] as const) {
      const { dir, file } = makeSpecDir();
      fs.chmodSync(file, given);
      // The fixture must really carry the bit, or the case proves nothing.
      expect(fs.statSync(file).mode & 0o7777).toBe(given);
      const result = runTriage(dir);
      expect(result.ok).toBe(true);
      expect(fs.statSync(file).mode & 0o7777).toBe(expected);
    }
  });

  it("leaves no temporary file behind when setting the mode fails", () => {
    const { dir, file, before } = makeSpecDir();
    const temp = `${file}.tmp-${process.pid}`;
    const spy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    try {
      const result = runTriage(dir);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a write error");
      expect(result.kind).toBe("write-error");
      expect(result.message).toContain("EPERM");
      expect(fs.existsSync(temp)).toBe(false);
      expect(fs.readFileSync(file)).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves no temporary file behind when the rename fails", () => {
    const { dir, file, before } = makeSpecDir();
    const temp = `${file}.tmp-${process.pid}`;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("disk out of space"), { code: "ENOSPC" });
    });
    try {
      const result = runTriage(dir);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a write error");
      expect(result.kind).toBe("write-error");
      expect(result.message).toContain("ENOSPC");
      expect(fs.existsSync(temp)).toBe(false);
      expect(fs.readFileSync(file)).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
});

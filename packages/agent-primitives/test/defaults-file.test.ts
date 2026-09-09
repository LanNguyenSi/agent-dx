import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULTS_FILE_MAX_BYTES,
  DEFAULTS_FILE_NAME,
  readDefaultsFile,
} from "../src/probe/defaults-file.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-defaults-file-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeDefaultsFile(dir: string, contents: string): void {
  fs.writeFileSync(path.join(dir, DEFAULTS_FILE_NAME), contents);
}

describe("readDefaultsFile", () => {
  it("an absent file is not an error: present false, links empty", () => {
    const root = makeTmpDir();
    const result = readDefaultsFile(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.present).toBe(false);
    expect(result.links).toEqual([]);
    expect(result.path).toBe(path.join(root, DEFAULTS_FILE_NAME));
  });

  it("reads a valid { link: [...] } file", () => {
    const root = makeTmpDir();
    writeDefaultsFile(
      root,
      JSON.stringify({ link: ["vendor", "docroot/core"] }),
    );
    const result = readDefaultsFile(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.present).toBe(true);
    expect(result.links).toEqual(["vendor", "docroot/core"]);
  });

  it("a file with no link key at all reads as present with an empty links list", () => {
    const root = makeTmpDir();
    writeDefaultsFile(root, JSON.stringify({}));
    const result = readDefaultsFile(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.present).toBe(true);
    expect(result.links).toEqual([]);
  });

  it("refuses an unknown key, naming the path and the key", () => {
    const root = makeTmpDir();
    writeDefaultsFile(root, JSON.stringify({ link: ["vendor"], extra: true }));
    const result = readDefaultsFile(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("defaults_file_invalid");
    expect(result.message).toContain(path.join(root, DEFAULTS_FILE_NAME));
    expect(result.message).toContain('"extra"');
  });

  it("refuses unparsable JSON, naming the path", () => {
    const root = makeTmpDir();
    writeDefaultsFile(root, "{ not json");
    const result = readDefaultsFile(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("defaults_file_invalid");
    expect(result.message).toContain(path.join(root, DEFAULTS_FILE_NAME));
    expect(result.message).toContain("not valid JSON");
  });

  it("refuses a JSON value that is not an object (an array, a string, a number)", () => {
    const root = makeTmpDir();
    writeDefaultsFile(root, JSON.stringify(["vendor"]));
    const result = readDefaultsFile(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("defaults_file_invalid");
    expect(result.message).toContain("must be a JSON object");
  });

  it("refuses link that is not an array", () => {
    const root = makeTmpDir();
    writeDefaultsFile(root, JSON.stringify({ link: "vendor" }));
    const result = readDefaultsFile(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("defaults_file_invalid");
    expect(result.message).toContain("must be an array of strings");
  });

  it("refuses a link entry carrying a $(...) command substitution or a backtick, naming the entry", () => {
    const root = makeTmpDir();
    writeDefaultsFile(
      root,
      JSON.stringify({ link: ["vendor", "$(rm -rf /)"] }),
    );
    const result = readDefaultsFile(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("defaults_file_invalid");
    expect(result.message).toContain("link[1]");
    expect(result.message).toMatch(/\$\(/);
  });

  it("refuses a directory at the defaults-file path as not readable", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, DEFAULTS_FILE_NAME));
    const result = readDefaultsFile(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("defaults_file_not_readable");
    expect(result.message).toContain("not a regular file");
  });

  it("refuses a file over the size cap as not readable", () => {
    const root = makeTmpDir();
    writeDefaultsFile(
      root,
      JSON.stringify({ link: ["x".repeat(DEFAULTS_FILE_MAX_BYTES + 1)] }),
    );
    const result = readDefaultsFile(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("defaults_file_not_readable");
    expect(result.message).toContain("cap");
  });
});

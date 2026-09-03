import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { sha256File } from "../src/hash.js";
import { sha256File as sha256FileFromIndex } from "../src/index.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-hash-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sha256File", () => {
  it("returns the same hash for two reads of an unchanged file", async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "a.txt");
    fs.writeFileSync(filePath, "hello world");
    const first = await sha256File(filePath);
    const second = await sha256File(filePath);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different hash after the content changes", async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "a.txt");
    fs.writeFileSync(filePath, "hello world");
    const before = await sha256File(filePath);
    fs.writeFileSync(filePath, "hello world!");
    const after = await sha256File(filePath);
    expect(after).not.toBe(before);
  });

  it("rejects with an error for a missing path", async () => {
    const dir = makeTmpDir();
    await expect(
      sha256File(path.join(dir, "does-not-exist.txt")),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects with an error for a directory", async () => {
    const dir = makeTmpDir();
    await expect(sha256File(dir)).rejects.toThrow(/not a regular file/);
  });

  it("re-exports sha256File from ../src/index.js with identical behavior", async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "a.txt");
    fs.writeFileSync(filePath, "hello world");
    const hash = await sha256FileFromIndex(filePath);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

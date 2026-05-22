import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkTextFiles } from "../src/walk.js";

let root = "";

function scaffold(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-scout-walk-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;");
  fs.writeFileSync(path.join(root, "src", "b.png"), "not text");
  fs.writeFileSync(path.join(root, "node_modules", "dep.ts"), "ignored");
  fs.writeFileSync(path.join(root, "readme.md"), "# hi");
  return root;
}

afterEach(() => {
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("walkTextFiles", () => {
  it("yields text files and skips node_modules and non-text extensions", () => {
    scaffold();
    const files = [...walkTextFiles(root)].map((f) => path.basename(f)).sort();
    expect(files).toEqual(["a.ts", "readme.md"]);
  });
  it("honours maxFiles", () => {
    scaffold();
    expect([...walkTextFiles(root, { maxFiles: 1 })]).toHaveLength(1);
  });
  it("returns nothing for a missing root", () => {
    expect([...walkTextFiles("/no/such/dir-xyz")]).toEqual([]);
  });
});

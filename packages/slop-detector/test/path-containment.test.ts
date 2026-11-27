import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isInside,
  realPath,
  resolvesInside,
} from "../src/util/path-containment.js";

describe("isInside", () => {
  it("accepts the root itself and paths below it", () => {
    expect(isInside("/x/repo", "/x/repo")).toBe(true);
    expect(isInside("/x/repo", "/x/repo/a.md")).toBe(true);
    expect(isInside("/x/repo", "/x/repo/docs/a.md")).toBe(true);
    expect(isInside("/x/repo/", "/x/repo/a.md")).toBe(true);
  });

  it("rejects a root-sibling that only shares a string prefix", () => {
    expect(isInside("/x/repo", "/x/repo2")).toBe(false);
    expect(isInside("/x/repo", "/x/repo2/a.md")).toBe(false);
    expect(isInside("/x/repo", "/x/repo.md")).toBe(false);
  });

  it("rejects parents and unrelated paths", () => {
    expect(isInside("/x/repo", "/x")).toBe(false);
    expect(isInside("/x/repo", "/etc/passwd")).toBe(false);
  });

  it("normalises `..` segments before comparing", () => {
    expect(isInside("/x/repo", "/x/repo/../etc")).toBe(false);
    expect(isInside("/x/repo", "/x/repo/docs/../../repo2")).toBe(false);
    expect(isInside("/x/repo", "/x/repo/docs/..")).toBe(true);
    expect(isInside("/x/repo/sub/..", "/x/repo/a.md")).toBe(true);
  });

  it("ignores a trailing separator on either side", () => {
    expect(isInside("/x/repo", "/x/repo/")).toBe(true);
    expect(isInside("/x/repo/", "/x/repo")).toBe(true);
    expect(isInside("/x/repo/", "/x/repo2/")).toBe(false);
  });

  it("treats the filesystem root as containing everything", () => {
    expect(isInside("/", "/etc/passwd")).toBe(true);
  });
});

describe("resolvesInside", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(() => {
    // Spelled through os.tmpdir() on purpose: on macOS that is a
    // /var/folders/... path whose real path starts with /private.
    base = fs.mkdtempSync(path.join(os.tmpdir(), "slop-contain-"));
    root = path.join(base, "repo");
    outside = path.join(base, "outside");
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, "a.md"), "a\n");
    fs.writeFileSync(path.join(outside, "secret.txt"), "s\n");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "out"));
    fs.symlinkSync(outside, path.join(root, "outdir"));
    fs.symlinkSync("a.md", path.join(root, "alias.md"));
    fs.symlinkSync(path.join(base, "nowhere"), path.join(root, "dangling"));
    fs.mkdirSync(path.join(base, "repo2"));
    fs.writeFileSync(path.join(base, "repo2", "x.md"), "x\n");
    fs.symlinkSync(path.join(base, "repo2"), path.join(root, "sibling"));
    fs.symlinkSync(root, path.join(base, "repo-link"));
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("accepts a regular file and an in-tree symlink", () => {
    expect(resolvesInside(root, "a.md")).toBe(true);
    expect(resolvesInside(root, "alias.md")).toBe(true);
    expect(resolvesInside(root, "docs")).toBe(true);
    expect(resolvesInside(root, ".")).toBe(true);
  });

  it("rejects a symlink to a file or directory outside", () => {
    expect(resolvesInside(root, "out")).toBe(false);
    expect(resolvesInside(root, "outdir")).toBe(false);
    expect(resolvesInside(root, "outdir/secret.txt")).toBe(false);
  });

  it("rejects a symlink into a root-sibling directory", () => {
    expect(resolvesInside(root, "sibling/x.md")).toBe(false);
  });

  it("rejects dangling links, missing paths and `..`", () => {
    expect(resolvesInside(root, "dangling")).toBe(false);
    expect(resolvesInside(root, "gone.md")).toBe(false);
    expect(resolvesInside(root, "../outside/secret.txt")).toBe(false);
  });

  it("agrees when the root is spelled through a symlink", () => {
    const linked = path.join(base, "repo-link");
    expect(resolvesInside(linked, "a.md")).toBe(true);
    expect(resolvesInside(linked, path.join(root, "a.md"))).toBe(true);
    expect(resolvesInside(linked, "out")).toBe(false);
  });

  it("agrees when root and target are spelled differently (realpath on both sides)", () => {
    const real = realPath(root);
    expect(real).toBeDefined();
    expect(resolvesInside(root, path.join(real as string, "a.md"))).toBe(true);
    expect(resolvesInside(real as string, path.join(root, "a.md"))).toBe(true);
  });

  it("an unresolvable root contains nothing", () => {
    expect(resolvesInside(path.join(base, "no-root"), "a.md")).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "agrees across letter case on a case-insensitive macOS volume",
    () => {
      const upper = path.join(base, "REPO");
      // Only meaningful where the volume folds case.
      if (!fs.existsSync(upper)) return;
      expect(resolvesInside(upper, "a.md")).toBe(true);
      expect(resolvesInside(root, path.join(upper, "A.MD"))).toBe(true);
      expect(resolvesInside(upper, "out")).toBe(false);
    },
  );
});

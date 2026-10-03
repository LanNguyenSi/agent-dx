import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureSnapshot,
  compareSnapshots,
  persistSnapshot,
} from "../src/snapshot/index.js";
import { spawnCli } from "./helpers/spawn-cli.js";
const dirs: string[] = [];
function temp() {
  const p = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "delta-test-")),
  );
  dirs.push(p);
  return p;
}
function git(r: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: r, encoding: "utf8" });
}
function repo() {
  const r = temp();
  git(r, "init", "-q");
  fs.writeFileSync(path.join(r, "f"), "base");
  git(r, "add", "f");
  git(r, "-c", "user.name=x", "-c", "user.email=x@y", "commit", "-qm", "base");
  return r;
}
afterEach(() =>
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
);
describe("delta", () => {
  it("detects edits to already dirty files, untracked modifications/additions/deletions deterministically", () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "f"), "dirty before");
    fs.writeFileSync(path.join(r, "u"), "first");
    fs.writeFileSync(path.join(r, "gone"), "first");
    const a = captureSnapshot(r);
    fs.writeFileSync(path.join(r, "f"), "dirty after");
    fs.writeFileSync(path.join(r, "u"), "second");
    fs.unlinkSync(path.join(r, "gone"));
    fs.writeFileSync(path.join(r, "a"), "new");
    expect(compareSnapshots(a, captureSnapshot(r))).toMatchObject({
      status: "fail",
      changed: true,
      index: { added: [], modified: [], deleted: [] },
      workingTree: { added: ["a"], modified: ["f", "u"], deleted: ["gone"] },
    });
  });
  it("separates staging-only changes and tracked deletion from working-tree fingerprints", () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "f"), "dirty");
    const a = captureSnapshot(r);
    git(r, "add", "f");
    const d = compareSnapshots(a, captureSnapshot(r));
    expect(d.index.modified).toEqual(["f"]);
    expect(d.workingTree.modified).toEqual([]);
    const b = captureSnapshot(r);
    fs.unlinkSync(path.join(r, "f"));
    expect(compareSnapshots(b, captureSnapshot(r)).workingTree.deleted).toEqual(
      ["f"],
    );
    git(r, "rm", "--cached", "f");
    expect(compareSnapshots(b, captureSnapshot(r)).index.deleted).toEqual([
      "f",
    ]);
  });
  it("compares mode/type, HEAD and branch changes and ignores artifact timestamp and order", () => {
    const r = repo();
    const a = captureSnapshot(r);
    fs.chmodSync(path.join(r, "f"), 0o755);
    expect(
      compareSnapshots(a, captureSnapshot(r)).workingTree.modified,
    ).toEqual(["f"]);
    fs.chmodSync(path.join(r, "f"), 0o644);
    fs.unlinkSync(path.join(r, "f"));
    fs.symlinkSync("target", path.join(r, "f"));
    expect(
      compareSnapshots(a, captureSnapshot(r)).workingTree.modified,
    ).toEqual(["f"]);
    fs.unlinkSync(path.join(r, "f"));
    fs.writeFileSync(path.join(r, "f"), "base");
    git(r, "checkout", "-qb", "other");
    expect(compareSnapshots(a, captureSnapshot(r)).branch?.after).toBe(
      "refs/heads/other",
    );
    git(
      r,
      "-c",
      "user.name=x",
      "-c",
      "user.email=x@y",
      "commit",
      "--allow-empty",
      "-qm",
      "next",
    );
    expect(compareSnapshots(a, captureSnapshot(r)).head).not.toBeNull();
    const b = captureSnapshot(r);
    b.checkout = {
      commonDir: b.checkout.commonDir,
      gitDir: b.checkout.gitDir,
      root: b.checkout.root,
    };
    b.capturedAt = "2020-01-01T00:00:00.000Z";
    expect(compareSnapshots(b, captureSnapshot(r)).changed).toBe(false);
  });
  it("rejects different checkouts including linked worktrees sharing commonDir", () => {
    const r = repo();
    const a = captureSnapshot(r);
    const other = repo();
    expect(() => compareSnapshots(a, captureSnapshot(other))).toThrow(
      /same physical checkout/,
    );
    const linked = path.join(temp(), "linked");
    git(r, "worktree", "add", "--detach", linked);
    const b = captureSnapshot(linked);
    expect(b.checkout.commonDir).toBe(a.checkout.commonDir);
    expect(() =>
      persistSnapshot(b, {
        cwd: linked,
        logDir: temp(),
        output: path.join(b.checkout.gitDir, "HEAD.lock"),
      }),
    ).toThrow(/outside/);
    expect(() =>
      persistSnapshot(b, { cwd: linked, logDir: b.checkout.commonDir }),
    ).toThrow(/outside/);
    expect(() => compareSnapshots(a, b)).toThrow(/same physical checkout/);
  });
  it("CLI distinguishes unchanged/changed/cannot conclude and writes bounded delta logs", async () => {
    const r = repo();
    const dir = temp();
    const out = persistSnapshot(captureSnapshot(r), {
      cwd: r,
      logDir: dir,
    }).artifactPath;
    const run = (since = out) =>
      spawnCli(["-C", r, "-l", dir, "delta", "--since", since]);
    expect((await run()).code).toBe(0);
    fs.writeFileSync(path.join(r, "f"), "changed");
    const changed = await run();
    expect(changed.code).toBe(1);
    expect(JSON.parse(changed.stdout).workingTree.modified).toEqual(["f"]);
    fs.writeFileSync(out, "{}");
    expect((await run()).code).toBe(2);
    for (let i = 0; i < 80; i++)
      fs.writeFileSync(path.join(r, `long-${i}`), "x");
    const baseline = persistSnapshot(captureSnapshot(r), {
      cwd: r,
      logDir: dir,
    }).artifactPath;
    for (let i = 0; i < 80; i++)
      fs.writeFileSync(path.join(r, `long-${i}`), "y");
    const bounded = await spawnCli([
      "-C",
      r,
      "-l",
      dir,
      "-m",
      "700",
      "delta",
      "--since",
      baseline,
    ]);
    expect(bounded.code).toBe(1);
    const e = JSON.parse(bounded.stdout);
    expect(e.truncated).toBe(true);
    expect(bounded.stdout.length).toBeLessThanOrEqual(701);
    expect(e.logs.length).toBeGreaterThan(0);
  });
});

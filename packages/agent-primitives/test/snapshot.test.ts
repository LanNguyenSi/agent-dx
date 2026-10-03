import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureSnapshot,
  persistSnapshot,
  readSnapshot,
  validateSnapshot,
  MAX_ARTIFACT_BYTES,
} from "../src/snapshot/index.js";
import { decode } from "../src/snapshot/git.js";
import { spawnCli, CLI_PATH, buildSpawnEnv } from "./helpers/spawn-cli.js";
const roots: string[] = [];
function temp() {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-test-")),
  );
  roots.push(d);
  return d;
}
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: temp(), GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  });
}
function repo() {
  const root = temp();
  git(root, "init", "-q");
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  roots
    .splice(0)
    .forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});
describe("snapshot capture", () => {
  it("captures unborn, dirty/index/ignored/untracked and unusual UTF-8 paths without mutation", () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "tracked"), "staged");
    git(r, "add", "tracked");
    fs.writeFileSync(path.join(r, "tracked"), "dirty");
    fs.writeFileSync(path.join(r, ".gitignore"), "ignored\ntracked\n");
    fs.writeFileSync(path.join(r, "ignored"), "hidden");
    for (const p of [
      "-dash",
      "white space",
      "line\n\tname",
      "ü.txt",
      "\ufeffbom",
    ])
      fs.writeFileSync(path.join(r, p), p);
    const index = fs.readFileSync(path.join(r, ".git/index"));
    const status = git(r, "status", "--porcelain=v1", "-z");
    const a = captureSnapshot(r);
    expect(a.head).toBeNull();
    expect(a.branch).toMatch(/^refs\/heads\//);
    expect(a.index[0]).toMatchObject({
      path: "tracked",
      stage: 0,
      mode: "100644",
    });
    expect(a.untracked).not.toContain("ignored");
    expect(a.workingTree.find((e) => e.path === "tracked")?.hash).toBe(
      createHash("sha256").update("dirty").digest("hex"),
    );
    expect(fs.readFileSync(path.join(r, ".git/index"))).toEqual(index);
    expect(git(r, "status", "--porcelain=v1", "-z")).toBe(status);
    const out = path.join(temp(), "full.json");
    expect(
      persistSnapshot(a, { cwd: r, logDir: temp(), output: out }).artifactPath,
    ).toBe(out);
    expect(readSnapshot(out)).toEqual(a);
    expect(fs.readFileSync(path.join(r, "tracked"), "utf8")).toBe("dirty");
  });
  it("normalizes nested cwd, records missing tracked files, executable mode and symlink target bytes", () => {
    const r = repo();
    fs.mkdirSync(path.join(r, "sub"));
    fs.writeFileSync(path.join(r, "gone"), "x");
    git(r, "add", "gone");
    fs.unlinkSync(path.join(r, "gone"));
    fs.writeFileSync(path.join(r, "exec"), "x", { mode: 0o755 });
    const target = path.join(temp(), "secret");
    fs.writeFileSync(target, "first");
    fs.symlinkSync(target, path.join(r, "link"));
    const a = captureSnapshot(path.join(r, "sub"));
    fs.writeFileSync(target, "second");
    const b = captureSnapshot(r);
    expect(a.checkout).toEqual(b.checkout);
    expect(a.workingTree.find((e) => e.path === "link")).toEqual(
      b.workingTree.find((e) => e.path === "link"),
    );
    expect(a.workingTree.find((e) => e.path === "gone")?.type).toBe("missing");
    expect(a.workingTree.find((e) => e.path === "exec")?.executable).toBe(true);
  });
  it("records conflict stages and detached HEAD", () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "f"), "x");
    git(r, "add", "f");
    git(
      r,
      "-c",
      "user.name=x",
      "-c",
      "user.email=x@y",
      "commit",
      "-qm",
      "base",
    );
    git(r, "checkout", "--detach", "-q");
    const oid = git(r, "rev-parse", "HEAD:f").trim();
    git(r, "update-index", "--force-remove", "f");
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: r,
      input: `100644 ${oid} 1\tf\n100644 ${oid} 2\tf\n100644 ${oid} 3\tf\n`,
    });
    const a = captureSnapshot(r);
    expect(a.branch).toBeNull();
    expect(a.index.map((e) => e.stage)).toEqual([1, 2, 3]);
  });
  it("refuses nested repos, sparse checkouts, gitlinks, symlink ancestors and special files", () => {
    const r = repo();
    const nested = path.join(r, "nested");
    fs.mkdirSync(nested);
    git(nested, "init", "-q");
    fs.writeFileSync(path.join(nested, "f"), "x");
    expect(() => captureSnapshot(r)).toThrow(/nested repository/);
    fs.rmSync(nested, { recursive: true });
    git(r, "config", "core.sparseCheckout", "true");
    expect(() => captureSnapshot(r)).toThrow(/sparse/);
    git(r, "config", "core.sparseCheckout", "false");
    git(
      r,
      "update-index",
      "--add",
      "--cacheinfo",
      "160000,1111111111111111111111111111111111111111,submodule",
    );
    expect(() => captureSnapshot(r)).toThrow(/gitlinks/);
    git(r, "update-index", "--force-remove", "submodule");
    fs.mkdirSync(path.join(r, "dir"));
    fs.writeFileSync(path.join(r, "dir/f"), "x");
    git(r, "add", "dir/f");
    fs.rmSync(path.join(r, "dir"), { recursive: true });
    fs.symlinkSync(temp(), path.join(r, "dir"));
    expect(() => captureSnapshot(r)).toThrow(/ancestor/);
    fs.unlinkSync(path.join(r, "dir"));
    git(r, "update-index", "--force-remove", "dir/f");
    execFileSync("mkfifo", [path.join(r, "fifo")]);
    expect(() => captureSnapshot(r)).toThrow(/file type/);
  });
  it("rejects invalid UTF-8 Git paths and Git environment redirection", () => {
    const r = repo();
    expect(() => decode(Buffer.from([255]))).toThrow(/UTF-8/);
    vi.stubEnv("GIT_INDEX_FILE", path.join(temp(), "index"));
    try {
      expect(() => captureSnapshot(r)).toThrow(/environment/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("detects ordinary file modification during capture", () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "f"), "x");
    const original = fs.readSync;
    let changed = false;
    vi.spyOn(fs, "readSync").mockImplementation(((
      ...args: Parameters<typeof fs.readSync>
    ) => {
      const n = Reflect.apply(original, fs, args);
      if (!changed) {
        changed = true;
        fs.appendFileSync(path.join(r, "f"), "y");
      }
      return n;
    }) as typeof fs.readSync);
    expect(() => captureSnapshot(r)).toThrow(/unstable/);
  });
});
describe("snapshot persistence and validation", () => {
  it("does not overwrite, follow output links or write inside checkout through aliases", () => {
    const r = repo();
    const a = captureSnapshot(r);
    const dir = temp();
    const out = path.join(dir, "out");
    fs.writeFileSync(out, "original");
    expect(() =>
      persistSnapshot(a, { cwd: r, logDir: dir, output: out }),
    ).toThrow();
    expect(fs.readFileSync(out, "utf8")).toBe("original");
    const alias = path.join(dir, "alias");
    fs.symlinkSync(r, alias);
    expect(() =>
      persistSnapshot(a, {
        cwd: r,
        logDir: dir,
        output: path.join(alias, "artifact"),
      }),
    ).toThrow(/outside/);
    expect(() =>
      persistSnapshot(a, { cwd: r, logDir: r, output: path.join(dir, "new") }),
    ).toThrow(/outside/);
    expect(fs.existsSync(path.join(dir, "new"))).toBe(false);
    const link = path.join(dir, "link");
    fs.symlinkSync(out, link);
    expect(() =>
      persistSnapshot(a, { cwd: r, logDir: dir, output: link }),
    ).toThrow();
  });
  it("rejects malformed schema/version/paths/duplicates/union/modes/hashes and oversized input", () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "f"), "x");
    const a = captureSnapshot(r);
    for (const change of [
      (s: any) => (s.format = "v2"),
      (s: any) => (s.hashAlgorithm = "md5"),
      (s: any) => (s.workingTree[0].path = "../f"),
      (s: any) => s.workingTree.push(s.workingTree[0]),
      (s: any) => (s.untracked = []),
      (s: any) => (s.workingTree[0].hash = "bad"),
      (s: any) =>
        (s.index = [
          { path: "f", stage: 4, mode: "160000", oid: "0".repeat(40) },
        ]),
    ]) {
      const s = structuredClone(a);
      change(s);
      expect(() => validateSnapshot(s)).toThrow();
    }
    const out = path.join(temp(), "big");
    const fd = fs.openSync(out, "w");
    fs.ftruncateSync(fd, MAX_ARTIFACT_BYTES + 1);
    fs.closeSync(fd);
    expect(() => readSnapshot(out)).toThrow(/byte limit/);
    execFileSync("mkfifo", [path.join(path.dirname(out), "fifo")]);
    expect(() => readSnapshot(path.join(path.dirname(out), "fifo"))).toThrow(
      /regular/,
    );
    fs.writeFileSync(out, "{broken");
    expect(() => readSnapshot(out)).toThrow(/malformed/);
  });
  it("CLI keeps full artifact separate from bounded stdout and rejects unsafe failure logs", async () => {
    const r = repo();
    for (let i = 0; i < 80; i++)
      fs.writeFileSync(path.join(r, `file-${i}`), "x");
    const dir = temp();
    const out = path.join(dir, "artifact.json");
    const run = await spawnCli([
      "-C",
      r,
      "-l",
      dir,
      "-m",
      "1200",
      "snapshot",
      "--output",
      out,
    ]);
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.artifactPath).toBe(out);
    expect(result.workingTree).toBeUndefined();
    expect(readSnapshot(out).workingTree).toHaveLength(80);
    expect(run.stdout.length).toBeLessThanOrEqual(1201);
    for (const args of [
      ["snapshot", "--output", path.join(r, "bad")],
      ["delta", "--since", "missing"],
      ["delta"],
    ]) {
      const failure = await spawnCli([
        "-C",
        r,
        "-l",
        path.join(r, "logs"),
        "-m",
        "1",
        ...args,
      ]);
      expect(failure.code).toBe(2);
      expect(fs.existsSync(path.join(r, "logs"))).toBe(false);
    }
  });
});

describe("observation commands share global option semantics", () => {
  it("preserves format-conflict and invalid-cwd usage errors without writing logs", async () => {
    const r = repo();
    const logDir = path.join(r, "logs");
    for (const args of [["snapshot"], ["delta", "--since", "missing"]]) {
      const conflict = await spawnCli([
        "-C",
        r,
        "-l",
        logDir,
        "--json",
        "-f",
        "text",
        ...args,
      ]);
      expect(conflict.code).toBe(2);
      expect(JSON.parse(conflict.stdout)).toMatchObject({
        status: "usage_error",
        reason: "format_conflict",
        logs: [],
      });
      const badCwd = await spawnCli([
        "-C",
        path.join(r, "missing"),
        "-l",
        logDir,
        ...args,
      ]);
      expect(badCwd.code).toBe(2);
      expect(JSON.parse(badCwd.stdout)).toMatchObject({
        status: "usage_error",
        reason: "usage_error",
        logs: [],
      });
      const tiny = await spawnCli([
        "-C",
        path.join(r, "missing"),
        "-l",
        logDir,
        "-m",
        "1",
        ...args,
      ]);
      expect(tiny.code).toBe(2);
      expect(fs.existsSync(logDir)).toBe(false);
    }
  });
  it("resolves flag and environment log paths from invocation cwd while artifact inputs stay relative to -C", () => {
    const parent = temp();
    const r = path.join(parent, "repo");
    fs.mkdirSync(r);
    git(r, "init", "-q");
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, [CLI_PATH, "-C", "repo", ...args], {
        cwd: parent,
        env: buildSpawnEnv(env),
        encoding: "utf8",
      });
    const baseline = path.join(parent, "before.json");
    for (const options of [
      { args: ["-l", "./flaglogs"], env: {}, name: "flaglogs" },
      {
        args: [],
        env: { AGENT_PRIMITIVES_LOG_DIR: "./envlogs" },
        name: "envlogs",
      },
      {
        args: ["-l", path.join(parent, "absolute")],
        env: {},
        name: "absolute",
      },
    ]) {
      const snap = run([...options.args, "snapshot"], options.env);
      expect(snap.status, snap.stdout + snap.stderr).toBe(0);
      const result = JSON.parse(snap.stdout);
      expect(result.status).toBe("ok");
      expect(path.dirname(result.artifactPath)).toBe(
        path.join(parent, options.name),
      );
      expect(fs.existsSync(path.join(r, options.name))).toBe(false);
      if (!fs.existsSync(baseline)) {
        const output = run(
          [...options.args, "snapshot", "--output", "../before.json"],
          options.env,
        );
        expect(output.status, output.stdout + output.stderr).toBe(0);
        expect(JSON.parse(output.stdout).artifactPath).toBe(baseline);
      }
      const delta = run(
        [...options.args, "delta", "--since", "../before.json"],
        options.env,
      );
      expect(delta.status, delta.stdout + delta.stderr).toBe(0);
      expect(JSON.parse(delta.stdout)).toMatchObject({
        status: "ok",
        changed: false,
      });
    }
    for (const command of [
      ["snapshot"],
      ["delta", "--since", "../before.json"],
    ]) {
      for (const options of [
        { args: ["-l", "./repo/unsafe-flag"], env: {} },
        { args: [], env: { AGENT_PRIMITIVES_LOG_DIR: "./repo/unsafe-env" } },
      ]) {
        const rejected = run([...options.args, ...command], options.env);
        expect(rejected.status).toBe(2);
        expect(JSON.parse(rejected.stdout)).toMatchObject({
          status: "error",
          reason: "cannot_conclude",
          logs: [],
        });
        expect(
          run([...options.args, "-m", "1", ...command], options.env).status,
        ).toBe(2);
        expect(fs.existsSync(path.join(r, "unsafe-flag"))).toBe(false);
        expect(fs.existsSync(path.join(r, "unsafe-env"))).toBe(false);
      }
    }
  });
});

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FrictionDb } from "../src/db.js";
import { installEpipeGuard } from "../src/epipe.js";

const PKG = join(import.meta.dirname, "..");
// Real-process tests spawn tsx; give them more than vitest's 5 s default and
// keep every kill timer below that bound so a hung child never outlives a test.
const REAL_PROCESS_TEST_MS = 40_000;
const CHILD_KILL_MS = 30_000;
let dir: string;
let env: NodeJS.ProcessEnv;
let dbPath: string;

function cli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(PKG, "src", "cli.ts"), ...args],
    { cwd: PKG, env, encoding: "utf8", timeout: CHILD_KILL_MS },
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fl-stdout-json-"));
  dbPath = join(dir, "f.db");
  env = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "cfg"),
    XDG_DATA_HOME: join(dir, "data"),
    FRICTION_LOG_CONFIG: join(dir, "none.yml"),
  };
  const r = cli(["log", "--title", "cli sample", "--db", dbPath]);
  expect(r.status).toBe(0);
}, REAL_PROCESS_TEST_MS);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("file --sink stdout-json (real process)", () => {
  it(
    "keeps stdout to exactly the JSON record and sends status lines to stderr",
    () => {
      const r = cli(["file", "1", "--sink", "stdout-json", "--db", dbPath]);
      expect(r.status).toBe(0);
      const lines = r.stdout.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        sink: "stdout-json",
        friction: { id: 1 },
      });
      expect(r.stderr).toContain("filed friction id=1 via sink=stdout-json");
    },
    REAL_PROCESS_TEST_MS,
  );

  it(
    "exits 0 without an EPIPE error when the reader has closed stdout",
    async () => {
      const logged = cli(["log", "--title", "epipe sample", "--db", dbPath]);
      expect(logged.status).toBe(0);
      const before = new FrictionDb(dbPath);
      const id = before
        .listFrictions({})
        .find((f) => f.title === "epipe sample")!.id;
      before.close();
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          join(PKG, "src", "cli.ts"),
          "file",
          String(id),
          "--sink",
          "stdout-json",
          "--db",
          dbPath,
        ],
        { cwd: PKG, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      // Close the read end before the child writes: its write hits a broken pipe.
      child.stdout.destroy();
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_MS);
      const code = await new Promise<number | null>((res) =>
        child.on("close", (c) => res(c)),
      );
      clearTimeout(timer);
      expect(stderr).not.toMatch(/EPIPE|at .*\.(ts|js):\d+/);
      expect(code).toBe(0);
      // The friction is recorded as filed before the broken pipe ends the process.
      const after = new FrictionDb(dbPath);
      try {
        expect(after.getFriction(id)?.status).toBe("filed");
        expect(after.listTasksForFriction(id)).toHaveLength(1);
      } finally {
        after.close();
      }
    },
    REAL_PROCESS_TEST_MS,
  );
});

describe("installEpipeGuard", () => {
  it("exits 0 on EPIPE and rethrows other errors", () => {
    const handlers: Array<(e: NodeJS.ErrnoException) => void> = [];
    const stream = {
      on: (_: string, h: (e: NodeJS.ErrnoException) => void) => {
        handlers.push(h);
      },
    } as unknown as NodeJS.WritableStream;
    const exits: number[] = [];
    installEpipeGuard(stream, (c) => exits.push(c));
    handlers[0](Object.assign(new Error("x"), { code: "EPIPE" }));
    expect(exits).toEqual([0]);
    expect(() =>
      handlers[0](Object.assign(new Error("boom"), { code: "EIO" })),
    ).toThrow("boom");
    expect(exits).toEqual([0]);
  });
});

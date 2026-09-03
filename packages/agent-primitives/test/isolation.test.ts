import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { beginInplace } from "../src/probe/isolation.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-isolation-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("beginInplace", () => {
  it("copies the target into the log dir and restores it byte for byte", () => {
    const dir = makeTmpDir();
    const logDir = makeTmpDir();
    const target = path.join(dir, "fixture.js");
    const original = "original content\n";
    fs.writeFileSync(target, original);

    const session = beginInplace(target, logDir);
    fs.writeFileSync(target, "mutated\n");
    expect(session.restore()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });

  it("never overwrites a backup name that already exists: it claims a distinct one", () => {
    const dir = makeTmpDir();
    const logDir = makeTmpDir();
    const target = path.join(dir, "fixture.js");
    fs.writeFileSync(target, "original content\n");

    // A backup from an earlier session sharing this log dir (the
    // stale-marker recovery path re-uses the log dir of the probe that
    // recovers it). Its content is the only copy of some other target's
    // pre-mutation state, so overwriting it would destroy that state.
    const takenPath = path.join(logDir, "backup-fixture.js");
    const takenContent = "an earlier session's backup\n";
    fs.writeFileSync(takenPath, takenContent);

    const session = beginInplace(target, logDir);

    expect(session.backupPath).not.toBe(takenPath);
    expect(fs.readFileSync(takenPath, "utf8")).toBe(takenContent);
    expect(fs.readFileSync(session.backupPath, "utf8")).toBe(
      "original content\n",
    );
  });

  it("keeps claiming further distinct names as more of them are taken", () => {
    const dir = makeTmpDir();
    const logDir = makeTmpDir();
    const target = path.join(dir, "fixture.js");
    fs.writeFileSync(target, "original content\n");

    const first = beginInplace(target, logDir);
    const second = beginInplace(target, logDir);
    const third = beginInplace(target, logDir);

    const paths = [first.backupPath, second.backupPath, third.backupPath];
    expect(new Set(paths).size).toBe(3);
    for (const backupPath of paths) {
      expect(fs.readFileSync(backupPath, "utf8")).toBe("original content\n");
    }
  });
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createRunScratch } from "../eval/isolation.js";

/**
 * Roots another account wins the race for: between the scratch root's first
 * check and its creation, a directory writable by others appears in its
 * place, which `mkdirSync` with `recursive` adopts without an error.
 */
const raced = vi.hoisted(() => new Set<string>());

/** Links re-pointed just before the next `mkdirSync`: link path and its new target. */
const repoint = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      const path = String(args[0]);
      for (const [link, target] of repoint) {
        actual.rmSync(link);
        actual.symlinkSync(target, link);
      }
      repoint.clear();
      if (raced.has(path)) {
        actual.mkdirSync(path);
        actual.chmodSync(path, 0o777);
        // As for a directory that already existed: nothing was created.
        return undefined;
      }
      return actual.mkdirSync(...args);
    },
  };
});

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("scratch root race", () => {
  it("checks the root again after creating it, and refuses one another account made in the meantime", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "ow-eval-race-")));
    dirs.push(parent);
    const root = join(parent, "root");
    raced.add(root);
    expect(() => createRunScratch(root)).toThrow(/group or others/);
    // No run directory was made inside the adopted root.
    expect(readdirSync(root)).toEqual([]);
    // Without the race the same place is accepted.
    const fair = join(parent, "fair");
    const scratch = createRunScratch(fair);
    expect(scratch.root.startsWith(`${fair}/`)).toBe(true);
  });

  it("creates the root where it was checked, by its resolved path, even if a link on the way changes afterwards", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "ow-eval-race-")));
    dirs.push(parent);
    const checked = join(parent, "checked");
    const other = join(parent, "other");
    mkdirSync(checked, { mode: 0o700 });
    mkdirSync(other, { mode: 0o700 });
    const link = join(parent, "link");
    symlinkSync(checked, link);
    repoint.set(link, other);
    const scratch = createRunScratch(join(link, "root"));
    expect(scratch.root.startsWith(join(checked, "root") + "/")).toBe(true);
    expect(existsSync(join(other, "root"))).toBe(false);
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseBindings,
  parseBindingsLog,
  sha256Tag,
} from "../../src/formats/index.js";
import {
  bindSpecDir,
  bindStatusProblem,
  serializeBindings,
} from "../../src/state/index.js";
import { runCli } from "../lint/helpers.js";
import {
  commitSpec,
  draftRepo,
  lintGit,
  proposedRepo,
  readSpec,
  writeSpec,
} from "./helpers.js";

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) out[name] = fs.readFileSync(file, "utf8");
  }
  return out;
}

describe("bindStatusProblem", () => {
  it("follows the binding status the kind needs at proposed", () => {
    // red-first: new may move on to existing, never back
    expect(bindStatusProblem("red-first", "new", "new")).toBeNull();
    expect(bindStatusProblem("red-first", "new", "existing")).toBeNull();
    expect(bindStatusProblem("red-first", "existing", "existing")).toBeNull();
    expect(bindStatusProblem("red-first", "existing", "new")).toMatch(
      /never back/,
    );
    // stays-green: existing only
    expect(bindStatusProblem("stays-green", "existing", "existing")).toBeNull();
    expect(bindStatusProblem("stays-green", "existing", "new")).toMatch(
      /needs binding status existing/,
    );
    // any: either way
    for (const [a, b] of [
      ["new", "existing"],
      ["existing", "new"],
    ] as const) {
      expect(bindStatusProblem("measurement", a, b)).toBeNull();
    }
    // manual: no binding at all
    expect(bindStatusProblem("manual", "new", "new")).toMatch(
      /takes no binding/,
    );
  });
});

describe("serializeBindings", () => {
  it("writes a file that parses back to the same bindings, in key order", () => {
    const bindings = {
      "TP-2": { status: "existing" as const, fixtures: [] },
      "TP-1": {
        status: "new" as const,
        selector: "a: b # not a comment",
        file: "test/x.test.ts",
        fixtures: ["test/f.json"],
        notes: "yes",
      },
    };
    const text = serializeBindings(bindings);
    const parsed = parseBindings(text);
    expect(parsed.ok && parsed.value).toEqual(bindings);
    expect(Object.keys(parsed.ok ? parsed.value : {})).toEqual([
      "TP-2",
      "TP-1",
    ]);
    expect(text).not.toContain("fixtures: []");
  });
});

describe("spec-gate bind", { timeout: 60_000 }, () => {
  it("appends one bind entry with the full binding and rewrites bindings.yaml; the lint at HEAD then passes", async () => {
    const { repo } = await proposedRepo();
    const before = readSpec(repo, "bindings.log");
    const result = bindSpecDir(repo.spec, "TP-2", {
      status: "existing",
      selector: "login still works",
      file: "test/login.test.ts",
      fixtures: ["test/users.json"],
    });
    expect(result).toEqual({ ok: true, tp: "TP-2", seq: 2 });
    const log = readSpec(repo, "bindings.log");
    expect(log.startsWith(before)).toBe(true);
    const parsed = parseBindingsLog(log);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.binds).toEqual([
        {
          seq: 2,
          kind: "bind",
          tp: "TP-2",
          binding: {
            status: "existing",
            selector: "login still works",
            file: "test/login.test.ts",
            fixtures: ["test/users.json"],
          },
          prev: sha256Tag(before.trimEnd()),
        },
      ]);
    }
    const bindings = parseBindings(readSpec(repo, "bindings.yaml"));
    expect(bindings.ok && bindings.value).toEqual({
      "TP-1": {
        status: "new",
        selector: "rejects old token",
        file: "test/auth.test.ts",
        fixtures: [],
      },
      "TP-2": {
        status: "existing",
        selector: "login still works",
        file: "test/login.test.ts",
        fixtures: ["test/users.json"],
      },
    });
    await commitSpec(repo, "bind");
    expect(lintGit(repo).errors).toEqual([]);
  });

  it("refuses a TP ID that is not a test-plan row, and one without a binding (no new or renamed ID)", async () => {
    const { repo } = await proposedRepo();
    const before = snapshot(repo.spec);
    for (const [tp, message] of [
      ["TP-9", /"TP-9" is not a row of testplan\.yaml/],
      ["TP-3", /TP-3 has no binding in bindings\.yaml/],
      ["AC-1", /"AC-1" is not a row of testplan\.yaml/],
    ] as const) {
      const result = bindSpecDir(repo.spec, tp, { status: "existing" });
      expect(result.ok, tp).toBe(false);
      if (!result.ok) expect(result.message).toMatch(message);
    }
    expect(snapshot(repo.spec)).toEqual(before);
  });

  it("refuses a spec that is not proposed", async () => {
    const { repo } = await draftRepo();
    const before = snapshot(repo.spec);
    const result = bindSpecDir(repo.spec, "TP-1", { status: "new" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/the status is draft/);
    expect(snapshot(repo.spec)).toEqual(before);
  });

  it("refuses a binding the bindings parser refuses", async () => {
    const { repo } = await proposedRepo();
    const before = snapshot(repo.spec);
    for (const request of [
      { status: "maybe" },
      { status: "new", selector: "-x" },
      { status: "new", file: "../outside" },
      { status: "new", fixtures: ["/abs"] },
      { status: "new", selector: "" },
    ]) {
      const result = bindSpecDir(repo.spec, "TP-1", request);
      expect(result.ok, JSON.stringify(request)).toBe(false);
      if (!result.ok)
        expect(result.message).toMatch(/the new binding is not valid/);
    }
    expect(snapshot(repo.spec)).toEqual(before);
  });

  it("refuses a status the row's kind does not allow, and allows red-first new to existing", async () => {
    const { repo } = await proposedRepo();
    const before = snapshot(repo.spec);
    const stays = bindSpecDir(repo.spec, "TP-2", { status: "new" });
    expect(stays.ok).toBe(false);
    if (!stays.ok)
      expect(stays.message).toMatch(
        /TP-2: kind stays-green needs binding status existing/,
      );
    expect(snapshot(repo.spec)).toEqual(before);

    expect(bindSpecDir(repo.spec, "TP-1", { status: "existing" }).ok).toBe(
      true,
    );
    const afterForward = snapshot(repo.spec);
    const back = bindSpecDir(repo.spec, "TP-1", { status: "new" });
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.message).toMatch(/never back/);
    expect(snapshot(repo.spec)).toEqual(afterForward);
  });

  it("refuses a missing or broken bindings.log", async () => {
    const { repo } = await proposedRepo();
    const log = readSpec(repo, "bindings.log");
    writeSpec(repo, "bindings.log", log.replace('"seq":1', '"seq":2'));
    const broken = bindSpecDir(repo.spec, "TP-1", { status: "new" });
    expect(broken.ok).toBe(false);
    if (!broken.ok)
      expect(broken.message).toMatch(/bindings\.log does not parse \(log-seq/);
    fs.rmSync(path.join(repo.spec, "bindings.log"));
    const missing = bindSpecDir(repo.spec, "TP-1", { status: "new" });
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(missing.message).toMatch(/bindings\.log does not exist/);
    expect(readSpec(repo, "bindings.yaml")).not.toContain("fixtures");
  });

  it("the CLI: exit 0 when written, 2 on a refusal or a usage error", async () => {
    const { repo } = await proposedRepo();
    const ok = await runCli([
      "bind",
      repo.spec,
      "TP-1",
      "--status",
      "new",
      "--selector",
      "rejects a stale token",
      "--fixtures",
      "a.json",
      "--fixtures",
      "b.json",
      "--notes",
      "renamed",
    ]);
    expect(ok).toEqual({
      code: 0,
      stdout: "bound TP-1 (entry 2)\n",
      stderr: "",
    });
    const bindings = parseBindings(readSpec(repo, "bindings.yaml"));
    expect(bindings.ok && bindings.value["TP-1"]).toEqual({
      status: "new",
      selector: "rejects a stale token",
      fixtures: ["a.json", "b.json"],
      notes: "renamed",
    });
    const refused = await runCli([
      "bind",
      repo.spec,
      "TP-9",
      "--status",
      "new",
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toMatch(/^spec-gate: bind: "TP-9" is not a row/);
    const usage = await runCli(["bind", repo.spec, "TP-1"]);
    expect(usage.code).toBe(2);
    expect(usage.stdout).toBe("");
  });
});

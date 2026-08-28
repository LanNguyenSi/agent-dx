import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OPERATOR_HOME_ENV,
  createOperatorManifest,
  readOperatorManifest,
  resolveOperatorHome,
  upsertOperatorTarget,
  writeOperatorManifest,
} from "../src/operator-manifest.js";
import type {
  OperatorManifest,
  OperatorManifestDefaults,
} from "../src/operator-manifest.js";

let home: string;
let targetDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "operator-home-"));
  targetDir = mkdtempSync(join(tmpdir(), "operator-target-"));
  savedEnv = process.env[OPERATOR_HOME_ENV];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(targetDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env[OPERATOR_HOME_ENV];
  else process.env[OPERATOR_HOME_ENV] = savedEnv;
});

const defaults = (): OperatorManifestDefaults => ({
  harnesses: ["claude"],
  profile: "full",
  tiers: false,
  models: { implementer: "sonnet" },
});

describe("resolveOperatorHome", () => {
  it("defaults to ~/.orchestrator-workflow", () => {
    delete process.env[OPERATOR_HOME_ENV];
    expect(resolveOperatorHome()).toBe(
      join(homedir(), ".orchestrator-workflow"),
    );
  });

  it("env var wins over the default", () => {
    process.env[OPERATOR_HOME_ENV] = "/tmp/env-home";
    expect(resolveOperatorHome()).toBe("/tmp/env-home");
  });

  it("explicit argument wins over env var and default", () => {
    process.env[OPERATOR_HOME_ENV] = "/tmp/env-home";
    expect(resolveOperatorHome("/tmp/explicit-home")).toBe(
      "/tmp/explicit-home",
    );
  });

  it("an empty ORCHESTRATOR_WORKFLOW_HOME falls through to the default", () => {
    const previous = process.env.ORCHESTRATOR_WORKFLOW_HOME;
    process.env.ORCHESTRATOR_WORKFLOW_HOME = "";
    try {
      expect(resolveOperatorHome()).toBe(
        join(homedir(), ".orchestrator-workflow"),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.ORCHESTRATOR_WORKFLOW_HOME;
      } else {
        process.env.ORCHESTRATOR_WORKFLOW_HOME = previous;
      }
    }
  });

  it("relative values become absolute", () => {
    delete process.env[OPERATOR_HOME_ENV];
    expect(resolveOperatorHome("relative-home")).toBe(
      join(process.cwd(), "relative-home"),
    );

    process.env[OPERATOR_HOME_ENV] = "relative-env-home";
    expect(resolveOperatorHome()).toBe(
      join(process.cwd(), "relative-env-home"),
    );
  });
});

describe("createOperatorManifest", () => {
  it("produces the expected shape", () => {
    const manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    expect(manifest).toEqual({
      kit: "orchestrator-workflow",
      schemaVersion: 1,
      defaults: defaults(),
      targets: [],
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("defaults `now` to the current time when omitted", () => {
    const manifest = createOperatorManifest(defaults());
    expect(manifest.createdAt).toBe(manifest.updatedAt);
    expect(() => new Date(manifest.createdAt).toISOString()).not.toThrow();
  });
});

describe("readOperatorManifest", () => {
  it("returns undefined when the file is missing", () => {
    expect(readOperatorManifest(home)).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    writeFileSync(join(home, "manifest.json"), "{not json", "utf8");
    expect(readOperatorManifest(home)).toBeUndefined();
  });

  it("returns undefined for the wrong kit", () => {
    writeFileSync(
      join(home, "manifest.json"),
      JSON.stringify({ kit: "something-else", schemaVersion: 1 }),
      "utf8",
    );
    expect(readOperatorManifest(home)).toBeUndefined();
  });

  it("returns undefined for the wrong schemaVersion", () => {
    writeFileSync(
      join(home, "manifest.json"),
      JSON.stringify({ kit: "orchestrator-workflow", schemaVersion: 2 }),
      "utf8",
    );
    expect(readOperatorManifest(home)).toBeUndefined();
  });

  it("degrades each field independently on a tampered manifest", () => {
    writeFileSync(
      join(home, "manifest.json"),
      JSON.stringify({
        kit: "orchestrator-workflow",
        schemaVersion: 1,
        defaults: {
          harnesses: ["claude", "not-a-harness"],
          models: { implementer: "sonnet", reviewer: 'bad"id' },
          profile: "not-a-profile",
          tiers: "yes",
        },
        targets: [
          { path: targetDir, lastAppliedVersion: "1.0.0", lastAppliedAt: "t" },
          {
            path: "relative/path",
            lastAppliedVersion: "1.0.0",
            lastAppliedAt: "t",
          },
          { path: 42, lastAppliedVersion: "1.0.0", lastAppliedAt: "t" },
        ],
        createdAt: 123,
        updatedAt: "2026-08-28T00:00:00.000Z",
      }),
      "utf8",
    );

    const manifest = readOperatorManifest(home);
    expect(manifest).toBeDefined();
    expect(manifest!.defaults.harnesses).toEqual(["claude"]);
    expect(manifest!.defaults.models).toEqual({ implementer: "sonnet" });
    expect(manifest!.defaults.profile).toBe("full");
    expect(manifest!.defaults.tiers).toBe(false);
    expect(manifest!.targets).toEqual([
      { path: targetDir, lastAppliedVersion: "1.0.0", lastAppliedAt: "t" },
    ]);
    expect(manifest!.createdAt).toBe("");
    expect(manifest!.updatedAt).toBe("2026-08-28T00:00:00.000Z");
  });
});

describe("writeOperatorManifest / round-trip", () => {
  it("creates a nonexistent home recursively", () => {
    const nestedHome = join(home, "nested", "deeper");
    const manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    writeOperatorManifest(nestedHome, manifest);
    expect(readOperatorManifest(nestedHome)).toEqual(manifest);
  });

  it("writes two-space JSON with exactly one trailing newline", () => {
    writeOperatorManifest(
      home,
      createOperatorManifest(defaults(), "2026-01-01T00:00:00.000Z"),
    );
    const raw = readFileSync(join(home, "manifest.json"), "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw.endsWith("\n\n")).toBe(false);
    expect(raw).toContain('\n  "kit": "orchestrator-workflow",\n');
  });

  it("round-trips a manifest with 0 targets", () => {
    const manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    writeOperatorManifest(home, manifest);
    expect(readOperatorManifest(home)).toEqual(manifest);
  });

  it("round-trips a manifest with 1 target", () => {
    let manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    manifest = upsertOperatorTarget(
      manifest,
      targetDir,
      "1.0.0",
      "2026-08-28T00:00:00.000Z",
    );
    writeOperatorManifest(home, manifest);
    expect(readOperatorManifest(home)).toEqual(manifest);
  });

  it("round-trips a manifest with 2+ targets", () => {
    const targetDir2 = mkdtempSync(join(tmpdir(), "operator-target2-"));
    try {
      let manifest = createOperatorManifest(
        defaults(),
        "2026-08-28T00:00:00.000Z",
      );
      manifest = upsertOperatorTarget(
        manifest,
        targetDir,
        "1.0.0",
        "2026-08-28T00:00:00.000Z",
      );
      manifest = upsertOperatorTarget(
        manifest,
        targetDir2,
        "1.0.0",
        "2026-08-28T00:00:00.000Z",
      );
      writeOperatorManifest(home, manifest);
      expect(readOperatorManifest(home)).toEqual(manifest);
    } finally {
      rmSync(targetDir2, { recursive: true, force: true });
    }
  });
});

describe("upsertOperatorTarget", () => {
  it("first insert yields exactly one entry", () => {
    const manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    const updated = upsertOperatorTarget(
      manifest,
      targetDir,
      "1.0.0",
      "2026-08-28T00:00:00.000Z",
    );
    expect(updated.targets).toHaveLength(1);
    expect(updated.targets[0]).toEqual({
      path: updated.targets[0].path,
      lastAppliedVersion: "1.0.0",
      lastAppliedAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("a second call for the same realpath updates in place (length stays 1)", () => {
    let manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    manifest = upsertOperatorTarget(
      manifest,
      targetDir,
      "1.0.0",
      "2026-08-28T00:00:00.000Z",
    );
    manifest = upsertOperatorTarget(
      manifest,
      targetDir,
      "1.1.0",
      "2026-08-29T00:00:00.000Z",
    );
    expect(manifest.targets).toHaveLength(1);
    expect(manifest.targets[0].lastAppliedVersion).toBe("1.1.0");
    expect(manifest.targets[0].lastAppliedAt).toBe("2026-08-29T00:00:00.000Z");
  });

  it("still upserts when a previously recorded target directory no longer exists", () => {
    const gone = mkdtempSync(join(tmpdir(), "ow-op-gone-"));
    const first = upsertOperatorTarget(
      createOperatorManifest(defaults(), "2026-01-01T00:00:00.000Z"),
      gone,
      "0.25.0",
      "2026-01-01T00:00:00.000Z",
    );
    rmSync(gone, { recursive: true, force: true });
    const second = upsertOperatorTarget(
      first,
      targetDir,
      "0.25.0",
      "2026-01-02T00:00:00.000Z",
    );
    expect(second.targets).toHaveLength(2);
    expect(second.targets[0].path).toBe(first.targets[0].path);
    expect(second.targets[1].path).toBe(realpathSync(targetDir));
  });

  it("dedupes against a stored path that is a symlink to the same directory", () => {
    const link = join(home, "target-link");
    symlinkSync(targetDir, link);
    const first = upsertOperatorTarget(
      createOperatorManifest(defaults(), "2026-01-01T00:00:00.000Z"),
      link,
      "0.25.0",
      "2026-01-01T00:00:00.000Z",
    );
    const second = upsertOperatorTarget(
      first,
      targetDir,
      "0.25.1",
      "2026-01-02T00:00:00.000Z",
    );
    expect(second.targets).toHaveLength(1);
    expect(second.targets[0].lastAppliedVersion).toBe("0.25.1");
  });

  it("does not mutate the input manifest or its nested arrays/objects", () => {
    const manifest = createOperatorManifest(
      defaults(),
      "2026-08-28T00:00:00.000Z",
    );
    const before = JSON.parse(JSON.stringify(manifest)) as OperatorManifest;
    const updated = upsertOperatorTarget(
      manifest,
      targetDir,
      "1.0.0",
      "2026-08-28T00:00:00.000Z",
    );
    expect(manifest).toEqual(before);
    expect(updated).not.toBe(manifest);
    expect(updated.targets).not.toBe(manifest.targets);
    expect(updated.defaults).not.toBe(manifest.defaults);
    expect(updated.defaults.models).not.toBe(manifest.defaults.models);
  });
});

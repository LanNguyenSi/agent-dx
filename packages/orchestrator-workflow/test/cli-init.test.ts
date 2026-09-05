import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { buildInitInitInputs } from "../src/cli-init.js";
import type { Manifest } from "../src/init.js";
import { DEFAULT_MODELS, DEFAULT_PROFILE } from "../src/models.js";

/**
 * Unit coverage for `buildInitInitInputs`, extracted from `init`'s CLI
 * action so a future edit to the call site cannot silently reintroduce a
 * `stickyPreChecked` (or `stickyAnnotateDetected`) override without a
 * targeted test catching it, mirroring `test/cli-apply.test.ts`'s coverage
 * of `buildApplyInitInputs` (agent-tasks 7669907c, fix round 2, review
 * finding 1).
 */

function fakePrevious(overrides: Partial<Manifest> = {}): Manifest {
  return {
    kit: "orchestrator-workflow",
    version: "0.26.0",
    harnesses: [],
    harnessesRecordedEmpty: true,
    models: { ...DEFAULT_MODELS },
    profile: DEFAULT_PROFILE,
    tiers: false,
    files: {},
    installedAt: "",
    ...overrides,
  };
}

describe("buildInitInitInputs", () => {
  it("never overrides stickyPreChecked or stickyAnnotateDetected, so resolveInitInputs's own defaults apply", () => {
    const previous = fakePrevious();
    const result = buildInitInitInputs(["claude", "codex"], previous, true, {});

    expect("stickyPreChecked" in result).toBe(false);
    expect("stickyAnnotateDetected" in result).toBe(false);
  });

  it("passes detected, interactive, previous, and opts through unchanged, and pins previousIsRecordedManifest to true", () => {
    const previous = fakePrevious({ profile: "minimal" });
    const opts = { harness: "codex" };
    const result = buildInitInitInputs(["claude"], previous, false, opts);

    expect(result.detected).toEqual(["claude"]);
    expect(result.interactive).toBe(false);
    expect(result.previous).toBe(previous);
    expect(result.opts).toBe(opts);
    expect(result.previousIsRecordedManifest).toBe(true);
  });

  it("passes previous through as undefined for a target with no prior install", () => {
    const result = buildInitInitInputs([], undefined, true, {});

    expect(result.previous).toBeUndefined();
    expect(result.previousIsRecordedManifest).toBe(true);
  });
});

describe("init's CLI action hands buildInitInitInputs's result straight to resolveInitInputs", () => {
  // The builder pins the sticky-branch wiring, but a call site that spreads
  // the builder's result into a fresh object literal (`{ ...build(...),
  // stickyPreChecked: detected }`) could restore the pre-D-002 behaviour
  // with every other test green. Inspecting the call tree closes that door
  // without coupling the assertion to formatting or the shape of opts.
  const cliSource = readFileSync(
    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
    "utf8",
  );

  it("passes the builder call directly as resolveInitInputs's only argument", () => {
    const source = ts.createSourceFile(
      "cli.ts",
      cliSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const builders: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "buildInitInitInputs"
      )
        builders.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(builders).toHaveLength(1);
    const builder = builders[0];
    const parent = builder.parent;
    expect(ts.isCallExpression(parent)).toBe(true);
    if (!ts.isCallExpression(parent))
      throw new Error(
        "Builder result must be passed directly to resolveInitInputs",
      );
    expect(parent.expression.getText(source)).toBe("resolveInitInputs");
    expect(parent.arguments).toHaveLength(1);
    expect(parent.arguments[0]).toBe(builder);
    expect(
      builder.arguments.slice(0, 3).map((argument) => argument.getText(source)),
    ).toEqual(["detected", "previous", "interactive"]);
    expect(builder.arguments).toHaveLength(4);
  });
});

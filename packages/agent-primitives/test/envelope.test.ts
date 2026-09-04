import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  applyCaps,
  buildEnvelope,
  depthForScale,
  exitCodeForStatus,
  statusClass,
  type CapLimits,
} from "../src/envelope.js";
import { buildEnvelope as buildEnvelopeFromIndex } from "../src/index.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-envelope-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The fixed envelope fields, in the order the envelope carries them. */
const FIXED_FIELDS = [
  "tool",
  "version",
  "command",
  "status",
  "durationMs",
  "cwd",
  "truncated",
  "logs",
  "warnings",
];

/** `...(N more items omitted)` -> N. */
function arrayMarkerCount(marker: unknown): number {
  expect(typeof marker).toBe("string");
  const match = /^\.\.\.\((\d+) more items? omitted\)$/.exec(marker as string);
  expect(match, `not an array marker: ${String(marker)}`).toBeTruthy();
  return Number(match?.[1]);
}

/** `N more keys omitted` -> N. */
function objectMarkerCount(marker: unknown): number {
  expect(typeof marker).toBe("string");
  const match = /^(\d+) more keys? omitted$/.exec(marker as string);
  expect(match, `not an object marker: ${String(marker)}`).toBeTruthy();
  return Number(match?.[1]);
}

/** `...(N more characters omitted)` -> N. */
function stringMarkerCount(value: string): number {
  const match = /\.\.\.\((\d+) more characters? omitted\)$/.exec(value);
  expect(match, `no string marker at the end of a cut string`).toBeTruthy();
  return Number(match?.[1]);
}

const DEPTH_MARKER_PREFIX = "...(subtree pruned at depth ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface TreeOptions {
  /** Levels of nesting, counted from the payload key: at `depth` the value
   * is a leaf object, above it every level is a container. */
  depth: number;
  /** Children per container. */
  arity: number;
  /** Key of the i-th child. Longer keys matter: a key is never capped, so
   * key length is what decides whether a level of a tree fits at all. */
  key?: (index: number) => string;
  leaf?: () => Record<string, unknown>;
}

/**
 * A deep, narrow fixture: the shape no earlier fixture in this file had.
 * Every other payload here is wide and shallow, and the breadth caps alone
 * reduce those; a tree is reduced by the depth cap or not at all, which is
 * how a whole nested payload came to vanish while the suite stayed green.
 */
function nestedTree({
  depth,
  arity,
  key = (i) => `branch-${i}`,
  leaf = () => ({ name: "leaf", covered: true, hits: 12, note: "short" }),
}: TreeOptions): Record<string, unknown> {
  if (depth <= 1) return leaf();
  const node: Record<string, unknown> = {};
  for (let i = 0; i < arity; i++) {
    node[key(i)] = nestedTree({ depth: depth - 1, arity, key, leaf });
  }
  return node;
}

/**
 * Asserts that `reduced` is an honest rendering of `original` at `depth`,
 * and recurses, so the claim covers every surviving level rather than the
 * first one: a pruned subtree names the depth it was pruned at, an object
 * accounts for every key it did not keep, a cut string states how many
 * characters went, and anything else survived verbatim.
 */
function assertHonestAtEveryLevel(
  original: unknown,
  reduced: unknown,
  depth: number,
): void {
  if (typeof reduced === "string" && reduced.startsWith(DEPTH_MARKER_PREFIX)) {
    expect(reduced).toBe(`${DEPTH_MARKER_PREFIX}${depth})`);
    expect(isRecord(original) || Array.isArray(original)).toBe(true);
    return;
  }
  if (typeof original === "string" && typeof reduced === "string") {
    if (reduced === original) return;
    const omitted = stringMarkerCount(reduced);
    const suffix = `...(${omitted} more character${omitted === 1 ? "" : "s"} omitted)`;
    expect(reduced.length - suffix.length + omitted).toBe(original.length);
    return;
  }
  if (isRecord(original) && isRecord(reduced)) {
    const kept = Object.keys(reduced).filter((k) => k !== "...");
    const omitted = "..." in reduced ? objectMarkerCount(reduced["..."]) : 0;
    expect(kept.length + omitted).toBe(Object.keys(original).length);
    for (const k of kept) {
      expect(Object.keys(original)).toContain(k);
      assertHonestAtEveryLevel(original[k], reduced[k], depth + 1);
    }
    return;
  }
  expect(reduced).toEqual(original);
}

/** Deepest level at which `value` is still a container, counting `value`
 * itself as `level`; 0 when it is not a container at all. */
function deepestContainerLevel(value: unknown, level: number): number {
  if (!isRecord(value)) return level - 1;
  let deepest = level;
  for (const [k, child] of Object.entries(value)) {
    if (k === "...") continue;
    deepest = Math.max(deepest, deepestContainerLevel(child, level + 1));
  }
  return deepest;
}

/** The envelope's keys that are not fixed fields. */
function payloadKeysOf(envelope: Record<string, unknown>): string[] {
  return Object.keys(envelope).filter((k) => !FIXED_FIELDS.includes(k));
}

const TOTAL_LOSS_PREFIX = "result reduced to the fixed fields only";

describe("statusClass / exitCodeForStatus", () => {
  it("maps ok class statuses to exit 0", () => {
    expect(statusClass("ok")).toBe("ok");
    expect(exitCodeForStatus("ok")).toBe(0);
    expect(exitCodeForStatus("pass")).toBe(0);
    expect(exitCodeForStatus("killed")).toBe(0);
  });

  it("maps finding class statuses to exit 1", () => {
    expect(statusClass("missing")).toBe("finding");
    expect(exitCodeForStatus("missing")).toBe(1);
    expect(exitCodeForStatus("fail")).toBe(1);
    expect(exitCodeForStatus("survived")).toBe(1);
  });

  it("maps cannot-conclude class statuses (including usage_error) to exit 2", () => {
    expect(statusClass("usage_error")).toBe("cannot-conclude");
    expect(exitCodeForStatus("usage_error")).toBe(2);
    expect(exitCodeForStatus("inconclusive")).toBe(2);
  });

  it("treats an unrecognized status as cannot-conclude (exit 2), never falls through to ok", () => {
    expect(exitCodeForStatus("something-new")).toBe(2);
  });
});

describe("buildEnvelope: hard bound", () => {
  it("keeps a small result untouched and not truncated", () => {
    const { envelope, exitCode } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp",
      extra: { tools: [{ name: "git", found: true }] },
    });
    expect(envelope.truncated).toBe(false);
    expect(envelope.logs).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("caps a synthetic result carrying a 5 MB single-line tail so the serialized envelope stays under maxChars, marks truncated, and records the full-result path", () => {
    const logDir = makeTmpDir();
    const hugeTail = "x".repeat(5 * 1024 * 1024);
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { checks: [{ name: "test", rawOutput: hugeTail }] },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    expect(envelope.truncated).toBe(true);
    const logs = envelope.logs as string[];
    expect(logs.length).toBeGreaterThan(0);
    const fullResultPath = logs[logs.length - 1];
    expect(fs.existsSync(fullResultPath)).toBe(true);
    const fullResult = JSON.parse(fs.readFileSync(fullResultPath, "utf8"));
    expect(fullResult.checks[0].rawOutput.length).toBe(hugeTail.length);
  });

  it("names the run in the full-result file, so a second invocation sharing one log dir does not overwrite the first's evidence", () => {
    const logDir = makeTmpDir();
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { blob: "x".repeat(50_000) },
      maxChars: 8000,
      logDir,
    });
    const logs = envelope.logs as string[];
    const name = path.basename(logs[logs.length - 1]);
    expect(name).not.toBe("result-full.json");
    expect(name).toMatch(/^result-full-.+\.json$/);
  });
});

describe("buildEnvelope: balance between sibling strings", () => {
  it("cuts two equally long sibling tails to (near) equal lengths instead of spending the whole budget on the first one", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "probe",
      status: "survived",
      durationMs: 10,
      cwd: "/tmp",
      extra: {
        baseline: { tail: "b".repeat(20_000) },
        mutated: { tail: "m".repeat(20_000) },
      },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    const baselineTail = (envelope.baseline as { tail: string }).tail;
    const mutatedTail = (envelope.mutated as { tail: string }).tail;
    // Both sides of a probe have to survive: an envelope that keeps the
    // baseline tail whole and drops the mutant's says nothing about why
    // the probe came out the way it did.
    expect(baselineTail.length).toBeGreaterThanOrEqual(1000);
    expect(mutatedTail.length).toBeGreaterThanOrEqual(1000);
    const spread =
      Math.abs(baselineTail.length - mutatedTail.length) /
      Math.max(baselineTail.length, mutatedTail.length);
    expect(spread).toBeLessThanOrEqual(0.1);
  });
});

describe("buildEnvelope: granular container trimming", () => {
  it("trims entries inside a 500-entry map instead of deleting the map wholesale, keeps its sibling field, and states how many entries went", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    // A per-file coverage map: the container is keyed, so what has to be
    // trimmed are its entries. Deleting the whole `files` value would meet
    // the bound too, and would tell the reader nothing at all.
    const files = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [
        `src/module-${i}/file.ts`,
        {
          path: `src/module-${i}/file.ts`,
          status: i % 3 === 0 ? "covered" : "partial",
        },
      ]),
    );
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { coverage: { files, total: 500 } },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    const coverage = envelope.coverage as {
      files: Record<string, unknown>;
      total: number;
    };
    expect(coverage.total).toBe(500);
    const keptKeys = Object.keys(coverage.files).filter((k) => k !== "...");
    expect(keptKeys.length).toBeGreaterThanOrEqual(50);
    expect(objectMarkerCount(coverage.files["..."]) + keptKeys.length).toBe(
      500,
    );
    // The surviving entries are whole, not stubs.
    const first = coverage.files[keptKeys[0]] as {
      path: string;
      status: string;
    };
    expect(first.path).toBe(keptKeys[0]);
    expect(["covered", "partial"]).toContain(first.status);
  });
});

describe("buildEnvelope: deeply nested results", () => {
  const maxChars = 8000;

  it("keeps four levels of a 3-ary depth-6 tree, marks every surviving level honestly, and uses at least half the budget", () => {
    const logDir = makeTmpDir();
    const tree = nestedTree({ depth: 6, arity: 3 });
    const summary = { nodes: 364, leaves: 243 };
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { tree, summary },
      maxChars,
      logDir,
    });
    const length = JSON.stringify(envelope).length;
    expect(length).toBeLessThanOrEqual(maxChars);
    expect(envelope.truncated).toBe(true);
    // The regression this fixture pins: a nested payload used to reduce to
    // the fixed fields and nothing else, silently.
    expect(payloadKeysOf(envelope)).toEqual(["tree", "summary"]);
    expect(envelope.summary).toEqual(summary);
    expect(deepestContainerLevel(envelope.tree, 1)).toBe(4);
    assertHonestAtEveryLevel(tree, envelope.tree, 1);
    // A bounded envelope that spends a tenth of the budget is bounded and
    // useless: the caller asked for 8000 characters of evidence.
    expect(length).toBeGreaterThanOrEqual(maxChars * 0.5);
    expect(envelope.warnings).toEqual([]);
  });

  it("keeps the surviving keys of a nested coverage map instead of dropping the map whole", () => {
    const logDir = makeTmpDir();
    const coverage = nestedTree({
      depth: 5,
      arity: 3,
      key: (i) => `src/module-${i}`,
      leaf: () => ({
        path: "src/services/billing/invoices/renderer-and-mailer.ts",
        status: "partial",
        missing: "12-19, 33, 47-51, 88-96, 120-134, 141-149, 158-176, 201",
        covered: "41 of 96 statements",
      }),
    });
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { coverage },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    expect(payloadKeysOf(envelope)).toEqual(["coverage"]);
    // Every module of the map is still named, at every level that survived.
    expect(Object.keys(envelope.coverage as Record<string, unknown>)).toEqual(
      Object.keys(coverage),
    );
    expect(deepestContainerLevel(envelope.coverage, 1)).toBe(4);
    assertHonestAtEveryLevel(coverage, envelope.coverage, 1);
  });

  it("falls back to a shallower structure when no scale fits at all, instead of returning the bare skeleton", () => {
    const logDir = makeTmpDir();
    // An object key is never capped, so a tree keyed by long paths is
    // still over the bound at the narrowest breadth the scale search can
    // reach. Only the shallower depth limits below the search's own floor
    // fit, and those are exactly what the depth-only fallback tries.
    const tree = nestedTree({
      depth: 6,
      arity: 3,
      key: (i) => `packages/agent-primitives/src/generated/module-${i}`,
    });
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { tree },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    expect(payloadKeysOf(envelope)).toEqual(["tree"]);
    expect(isRecord(envelope.tree)).toBe(true);
    expect(deepestContainerLevel(envelope.tree, 1)).toBe(3);
    assertHonestAtEveryLevel(tree, envelope.tree, 1);
    expect(
      (envelope.warnings as string[]).some((w) =>
        w.startsWith(TOTAL_LOSS_PREFIX),
      ),
    ).toBe(false);
  });
});

describe("buildEnvelope: depth-search tuning constants (round-6 pin)", () => {
  const maxChars = 8000;

  it("lands the depth-only fallback on FALLBACK_DEPTHS' second and third entries, not just its first", () => {
    // The earlier fixture above (key length 0) lands on FALLBACK_DEPTHS[0]
    // (3). Longer keys leave less breadth budget at MIN_SCALE, so the same
    // shape needs a shallower fallback depth to fit: 250-character keys
    // land on FALLBACK_DEPTHS[1] (2), and 1000-character keys on
    // FALLBACK_DEPTHS[2] (1). A FALLBACK_DEPTHS shortened to just [3] would
    // find nothing that fits at either length and silently fall through to
    // the fixed fields alone.
    for (const [keyLength, expectedDepth] of [
      [250, 2],
      [1000, 1],
    ] as const) {
      const logDir = makeTmpDir();
      const tree = nestedTree({
        depth: 6,
        arity: 3,
        key: (i) => "k".repeat(keyLength) + "-" + i,
      });
      const { envelope } = buildEnvelope({
        version: "0.1.0",
        command: "verify",
        status: "fail",
        durationMs: 10,
        cwd: "/tmp",
        extra: { tree },
        maxChars,
        logDir,
      });
      expect(
        JSON.stringify(envelope).length,
        `key length ${keyLength}`,
      ).toBeLessThanOrEqual(maxChars);
      expect(payloadKeysOf(envelope), `key length ${keyLength}`).toEqual([
        "tree",
      ]);
      expect(
        deepestContainerLevel(envelope.tree, 1),
        `key length ${keyLength}`,
      ).toBe(expectedDepth);
      expect(
        (envelope.warnings as string[]).some((w) =>
          w.startsWith(TOTAL_LOSS_PREFIX),
        ),
        `key length ${keyLength}`,
      ).toBe(false);
    }
  });

  it("pairs the depth-only fallback with the narrowest breadth caps (MIN_SCALE), not the widest (scale 1)", () => {
    // Ten long-keyed children at the surviving fallback level only fit
    // three of them under the narrow MIN_SCALE breadth cap; at scale 1
    // (unbounded relative to this tiny width) all ten would fit instead,
    // so the kept top-level key count is the discriminator.
    const logDir = makeTmpDir();
    const tree = nestedTree({
      depth: 6,
      arity: 10,
      key: (i) => "k".repeat(250) + "-" + i,
    });
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { tree },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    const top = envelope.tree as Record<string, unknown>;
    const kept = Object.keys(top).filter((k) => k !== "...");
    expect(kept.length).toBe(3);
    expect(objectMarkerCount(top["..."])).toBe(7);
  });

  it("depthForScale floors with Math.floor, not Math.ceil, at a non-power-of-two scale", () => {
    // log2(0.3) is about -1.737: floor gives -2 (depth 10), ceil would give
    // -1 (depth 11). Both stay above MIN_SEARCH_DEPTH, so the two rounding
    // directions disagree by exactly one level here.
    expect(depthForScale(12, 0.3)).toBe(10);
  });

  it("clamps depthForScale at MIN_SEARCH_DEPTH (4), not one level shallower", () => {
    // MIN_SCALE is 2 ** -11 (eleven halvings below scale 1): unclamped that
    // is baseDepth - 11 = 1, well under the floor, so the clamp is what
    // decides the result.
    const MIN_SCALE = 2 ** -11;
    expect(depthForScale(12, MIN_SCALE)).toBe(4);
  });
});

describe("buildEnvelope: a payload that fits nowhere", () => {
  const cases = [
    {
      name: "a small result at a bound below the skeleton's own size",
      extra: { tools: Array.from({ length: 20 }, (_, i) => ({ i })) },
      maxChars: 10,
      expectPayloadKeys: false,
    },
    {
      name: "keys too long to keep even one of",
      extra: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`${"K".repeat(4000)}${i}`, i]),
      ),
      maxChars: 8000,
      expectPayloadKeys: false,
    },
    {
      name: "a deep tree the fallback can still sketch",
      extra: {
        tree: nestedTree({
          depth: 6,
          arity: 3,
          key: (i) => `packages/agent-primitives/src/generated/module-${i}`,
        }),
      },
      maxChars: 8000,
      expectPayloadKeys: true,
    },
    {
      name: "a wide result the scale search reduces normally",
      extra: Object.fromEntries(
        Array.from({ length: 5000 }, (_, i) => [`k${i}`, "v".repeat(20)]),
      ),
      maxChars: 8000,
      expectPayloadKeys: true,
    },
  ];

  it("warns exactly when a non-empty payload came back with no payload key at all", () => {
    for (const testCase of cases) {
      const logDir = makeTmpDir();
      const { envelope } = buildEnvelope({
        version: "0.1.0",
        command: "verify",
        status: "fail",
        durationMs: 10,
        cwd: "/tmp",
        extra: testCase.extra,
        maxChars: testCase.maxChars,
        logDir,
      });
      const keptAnything = payloadKeysOf(envelope).length > 0;
      expect(keptAnything, testCase.name).toBe(testCase.expectPayloadKeys);
      const warned = (envelope.warnings as string[]).some((w) =>
        w.startsWith(TOTAL_LOSS_PREFIX),
      );
      expect(warned, testCase.name).toBe(!keptAnything);
    }
  });

  it("points the warning at logs for the full result, and says so when none was written", () => {
    const logDir = makeTmpDir();
    const extra = { tools: Array.from({ length: 20 }, (_, i) => ({ i })) };
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp",
      extra,
      maxChars: 10,
      logDir,
    });
    const logs = envelope.logs as string[];
    expect(logs.length).toBe(1);
    const warning = (envelope.warnings as string[]).find((w) =>
      w.startsWith(TOTAL_LOSS_PREFIX),
    );
    expect(warning).toBe(
      "result reduced to the fixed fields only: no payload structure fits within max-chars 10; the full result is in logs",
    );
    expect(fs.existsSync(logs[0])).toBe(true);

    const withoutLogDir = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp",
      extra,
      maxChars: 10,
    }).envelope;
    expect((withoutLogDir.warnings as string[])[0]).toBe(
      "result reduced to the fixed fields only: no payload structure fits within max-chars 10; no full result was written",
    );
  });

  it("does not warn when there was no payload to lose", () => {
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp",
      maxChars: 10,
    });
    expect(payloadKeysOf(envelope)).toEqual([]);
    expect(
      (envelope.warnings as string[]).some((w) =>
        w.startsWith(TOTAL_LOSS_PREFIX),
      ),
    ).toBe(false);
  });
});

describe("buildEnvelope: an own __proto__ key in a result", () => {
  it("keeps it as an own property, leaves the prototype alone, and counts it in the marker arithmetic", () => {
    const logDir = makeTmpDir();
    const parsed = JSON.parse('{"__proto__":{"x":1},"a":1}') as Record<
      string,
      unknown
    >;
    // The fixture really is the dangerous shape: `JSON.parse` produces an
    // own `__proto__` data property, which plain assignment would turn
    // into a prototype reassignment on the rebuilt object.
    expect(Object.getOwnPropertyNames(parsed)).toEqual(["__proto__", "a"]);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);

    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { data: parsed, filler: "x".repeat(50_000) },
      maxChars: 8000,
      logDir,
    });
    expect(envelope.truncated).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(envelope)).toBe(Object.prototype);
    const own = Object.getOwnPropertyNames(data);
    const kept = own.filter((k) => k !== "...");
    const omitted = own.includes("...") ? objectMarkerCount(data["..."]) : 0;
    expect(kept).toEqual(["__proto__", "a"]);
    expect(kept.length + omitted).toBe(
      Object.getOwnPropertyNames(parsed).length,
    );
    expect(Object.getOwnPropertyDescriptor(data, "__proto__")?.value).toEqual({
      x: 1,
    });
    expect(JSON.stringify(data)).toBe('{"__proto__":{"x":1},"a":1}');
  });
});

describe("applyCaps: a cap that would grow a value leaves it alone", () => {
  it("returns a short string whole when its own marker would be longer than it", () => {
    const limits: CapLimits = {
      maxString: 3,
      maxArray: 3,
      maxKeys: 3,
      maxDepth: 4,
    };
    expect(applyCaps({ s: "abcdef" }, limits)).toEqual({ s: "abcdef" });
  });

  it("keeps tiny values whole through a full reduction, so nothing in the envelope grew", () => {
    const value = "abcd";
    const extra = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [
        `field-${String(i).padStart(2, "0")}-${"n".repeat(80)}`,
        value,
      ]),
    );
    const maxChars = 500;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra,
      maxChars,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    const kept = payloadKeysOf(envelope).filter((k) => k !== "...");
    expect(kept.length).toBeGreaterThan(0);
    // The kept-key count is the settled `maxKeys`, and `maxString` is the
    // same number: fewer kept keys than the value is long means the string
    // cap was under it and the shrink guard is what kept it whole.
    expect(kept.length).toBeLessThan(value.length);
    for (const key of kept) expect(envelope[key]).toBe(value);
  });
});

describe("buildEnvelope: serialization order", () => {
  it("puts the fixed fields first, ahead of every payload field, truncated or not", () => {
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp",
      extra: { alpha: 1, zebra: 2 },
    });
    expect(Object.keys(envelope)).toEqual([...FIXED_FIELDS, "alpha", "zebra"]);
    // A reader of the raw line, or of a head of it, meets the envelope's
    // own identity before the result's fields.
    expect(
      JSON.stringify(envelope).startsWith('{"tool":"agent-primitives"'),
    ).toBe(true);

    const logDir = makeTmpDir();
    const reduced = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { alpha: "a".repeat(50_000), zebra: 2 },
      maxChars: 8000,
      logDir,
    }).envelope;
    expect(reduced.truncated).toBe(true);
    expect(Object.keys(reduced).slice(0, FIXED_FIELDS.length)).toEqual(
      FIXED_FIELDS,
    );
  });
});

describe("buildEnvelope: wide objects", () => {
  it("keeps a useful number of a 5,000-key object's keys under maxChars 8000", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: Object.fromEntries(
        Array.from({ length: 5000 }, (_, i) => [`k${i}`, "v".repeat(20)]),
      ),
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    const kept = Object.keys(envelope).filter((k) => k.startsWith("k"));
    expect(kept.length).toBeGreaterThanOrEqual(100);
    expect(objectMarkerCount(envelope["..."]) + kept.length).toBe(5000);
    // Every kept value is whole: the keys that survive are worth reading.
    expect(envelope[kept[0]]).toBe("v".repeat(20));
  });

  it("stays under the bound for a 20,000-key object of 100-character values", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: Object.fromEntries(
        Array.from({ length: 20_000 }, (_, i) => [`k${i}`, "v".repeat(100)]),
      ),
      maxChars,
      logDir,
    });
    // The bound, not a wall time: the pass count is fixed and each pass is
    // linear, so the guarantee this test can state is the result, and a
    // loaded machine never makes it flake.
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    expect(envelope.truncated).toBe(true);
    expect(
      Object.keys(envelope).filter((k) => k.startsWith("k")).length,
    ).toBeGreaterThan(0);
  });
});

describe("buildEnvelope: utilization", () => {
  it("uses at least 90 percent of the requested budget for an input far above it", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { blob: "z".repeat(1_000_000) },
      maxChars,
      logDir,
    });
    const length = JSON.stringify(envelope).length;
    expect(length).toBeLessThanOrEqual(maxChars);
    // A reduction that always undershoots is bounded but useless: the
    // caller asked for 8000 characters of evidence and should get them.
    expect(length).toBeGreaterThanOrEqual(maxChars * 0.9);
  });
});

describe("buildEnvelope: determinism", () => {
  function reducibleInput(logDir: string) {
    return {
      version: "0.1.0",
      command: "verify",
      status: "fail" as const,
      durationMs: 10,
      cwd: "/tmp",
      extra: {
        blob: "q".repeat(60_000),
        list: Array.from({ length: 300 }, (_, i) => ({ i, name: `n-${i}` })),
      },
      maxChars: 8000,
      logDir,
    };
  }

  it("produces exactly one distinct serialization over 50 calls with the same input", () => {
    const logDir = makeTmpDir();
    const serializations = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { envelope } = buildEnvelope(reducibleInput(logDir));
      serializations.add(JSON.stringify(envelope));
    }
    expect(serializations.size).toBe(1);
  });

  it("reduces without reading a clock: Date.now and performance.now may throw throughout", () => {
    const logDir = makeTmpDir();
    const boom = (): never => {
      throw new Error("clock read");
    };
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(boom);
    const perfSpy = vi.spyOn(performance, "now").mockImplementation(boom);
    let envelope: Record<string, unknown>;
    try {
      // Negative control: the stubs really are in place, so a clock read
      // anywhere inside buildEnvelope would surface as a thrown error
      // rather than as a silently ignored value.
      expect(() => Date.now()).toThrow("clock read");
      expect(() => performance.now()).toThrow("clock read");
      envelope = buildEnvelope(reducibleInput(logDir)).envelope;
    } finally {
      dateSpy.mockRestore();
      perfSpy.mockRestore();
    }
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(8000);
    expect(envelope.truncated).toBe(true);
  });
});

describe("buildEnvelope: tiny bounds", () => {
  for (const maxChars of [0, 10, 50]) {
    it(`yields parseable JSON at the skeleton floor with an honest overrun warning at maxChars ${maxChars}`, () => {
      const logDir = makeTmpDir();
      const { envelope } = buildEnvelope({
        version: "0.1.0",
        command: "doctor",
        status: "ok",
        durationMs: 5,
        cwd: "/tmp/some/cwd",
        extra: { tools: Array.from({ length: 20 }, (_, i) => ({ i })) },
        maxChars,
        logDir,
      });
      const json = JSON.stringify(envelope);
      expect(() => JSON.parse(json)).not.toThrow();
      // Nothing but the fixed fields is left, and the JSON string itself
      // was never cut mid-token to get there.
      expect(Object.keys(envelope)).toEqual(FIXED_FIELDS);
      const warnings = envelope.warnings as string[];
      expect(warnings[warnings.length - 1]).toBe(
        `envelope is ${json.length} characters; requested max-chars ${maxChars} could not be met`,
      );
    });
  }
});

describe("buildEnvelope: honest in-band markers", () => {
  it("states the count omitted from an array's ORIGINAL length, whatever scale the search settled on", () => {
    const logDir = makeTmpDir();
    const originalLength = 5000;
    const items = Array.from(
      { length: originalLength },
      (_, i) => `item-${String(i).padStart(4, "0")}`,
    );
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { items },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    const reduced = envelope.items as unknown[];
    const omitted = arrayMarkerCount(reduced[reduced.length - 1]);
    expect(omitted + (reduced.length - 1)).toBe(originalLength);
    // The kept elements are the head of the original, untouched.
    expect(reduced[0]).toBe("item-0000");
  });

  it("states the count omitted from a string's original length in its suffix", () => {
    const logDir = makeTmpDir();
    const original = "s".repeat(40_000);
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { tail: original },
      maxChars: 8000,
      logDir,
    });
    const tail = envelope.tail as string;
    const omitted = stringMarkerCount(tail);
    const suffixLength = `...(${omitted} more characters omitted)`.length;
    expect(omitted + (tail.length - suffixLength)).toBe(original.length);
  });

  it("replaces a subtree below the depth limit with a placeholder naming the depth", () => {
    const logDir = makeTmpDir();
    let chain: unknown = "leaf";
    for (let i = 0; i < 20; i++) chain = { next: chain, level: i };
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { deep: chain, filler: "x".repeat(50_000) },
      maxChars: 8000,
      logDir,
    });
    let cursor: unknown = envelope.deep;
    let placeholder: string | undefined;
    while (cursor !== undefined && cursor !== null) {
      if (typeof cursor === "string") {
        if (cursor.startsWith("...(subtree pruned at depth ")) {
          placeholder = cursor;
        }
        break;
      }
      cursor = (cursor as { next?: unknown }).next;
    }
    expect(placeholder).toMatch(/^\.\.\.\(subtree pruned at depth \d+\)$/);
  });

  it("never re-marks an already marked value: applyCaps reads only the pristine payload", () => {
    const payload = { items: Array.from({ length: 100 }, (_, i) => i) };
    const limits: CapLimits = {
      maxString: 1000,
      maxArray: 10,
      maxKeys: 1000,
      maxDepth: 12,
    };
    const once = applyCaps(payload, limits) as { items: unknown[] };
    // Same input, same limits, same answer; and the caller's payload is
    // untouched, so a second pass can start from it again.
    const again = applyCaps(payload, limits) as { items: unknown[] };
    expect(JSON.stringify(again)).toBe(JSON.stringify(once));
    expect(payload.items.length).toBe(100);
    expect(arrayMarkerCount(once.items[once.items.length - 1])).toBe(90);
  });
});

describe("buildEnvelope: PROTECTED_KEYS are held apart from the payload", () => {
  it("keeps every fixed field and logs[0] verbatim at maxChars 50, even though the cut must reach the skeleton", () => {
    const logDir = makeTmpDir();
    const cwd = "/tmp/some/reasonably/long/cwd/path/used/for/discrimination";
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd,
      extra: {
        tools: Array.from({ length: 50 }, (_, i) => ({
          name: `tool-${i}`,
          found: true,
        })),
      },
      maxChars: 50,
      logDir,
    });
    expect(envelope.tool).toBe("agent-primitives");
    expect(envelope.version).toBe("0.1.0");
    expect(envelope.command).toBe("doctor");
    expect(envelope.status).toBe("ok");
    expect(envelope.cwd).toBe(cwd);
    expect(envelope.truncated).toBe(true);
    const logs = envelope.logs as string[];
    expect(logs.length).toBeGreaterThan(0);
    // The full-result path itself must survive untouched: it is a fairly
    // long string, a plausible target for the string cap if the fixed
    // fields were reduced along with the payload.
    expect(logs[0].startsWith(logDir)).toBe(true);
    expect(fs.existsSync(logs[0])).toBe(true);
  });

  it("keeps the fixed fields byte for byte at every scale the search can settle on", () => {
    const cwd = "/tmp/a/deliberately/long/working/directory/for/this/assertion";
    const longWarning = "w".repeat(300);
    for (const maxChars of [10, 50, 200, 1000, 4000, 8000, 100_000]) {
      const logDir = makeTmpDir();
      const { envelope } = buildEnvelope({
        version: "0.1.0",
        command: "verify",
        status: "fail",
        durationMs: 42,
        cwd,
        warnings: [longWarning],
        extra: {
          blob: "z".repeat(200_000),
          rows: Array.from({ length: 2000 }, (_, i) => ({
            i,
            text: "t".repeat(80),
          })),
        },
        maxChars,
        logDir,
      });
      expect(envelope.tool).toBe("agent-primitives");
      expect(envelope.version).toBe("0.1.0");
      expect(envelope.command).toBe("verify");
      expect(envelope.status).toBe("fail");
      expect(envelope.durationMs).toBe(42);
      expect(envelope.cwd).toBe(cwd);
      expect((envelope.warnings as string[])[0]).toBe(longWarning);
      const logs = envelope.logs as string[];
      expect(logs.length).toBe(1);
      expect(fs.existsSync(logs[0])).toBe(true);
    }
  });
});

describe("buildEnvelope: overrun warning names the true final length", () => {
  it("pushes a warning naming the actual final length when even the skeleton exceeds maxChars", () => {
    const logDir = makeTmpDir();
    const maxChars = 10;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp/some/cwd",
      extra: { tools: [{ name: "git", found: true }] },
      maxChars,
      logDir,
    });
    const finalLength = JSON.stringify(envelope).length;
    const warnings = envelope.warnings as string[];
    const overrun = warnings.find((w) => w.includes("could not be met"));
    expect(overrun).toBeTruthy();
    expect(overrun).toBe(
      `envelope is ${finalLength} characters; requested max-chars ${maxChars} could not be met`,
    );
  });

  it("does not warn when the requested bound was actually met", () => {
    const logDir = makeTmpDir();
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp",
      extra: { tools: [{ name: "git", found: true }] },
      maxChars: 8000,
      logDir,
    });
    const warnings = envelope.warnings as string[];
    expect(warnings.some((w) => w.includes("could not be met"))).toBe(false);
  });

  it("does not warn for a heavily reduced result that did meet the bound", () => {
    const logDir = makeTmpDir();
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: Object.fromEntries(
        Array.from({ length: 5000 }, (_, i) => [`k${i}`, "ab"]),
      ),
      maxChars: 8000,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(8000);
    const warnings = envelope.warnings as string[];
    expect(warnings.some((w) => w.includes("could not be met"))).toBe(false);
  });

  it("states the envelope's true final length at every size in a range that crosses a digit-count boundary", () => {
    const maxChars = 10;
    const digitCounts = new Set<number>();
    // The warning's own number is part of the length it reports, so the
    // sizes where the number gains a digit are exactly the ones an
    // approximate answer gets wrong. The cwd is a fixed field, never cut,
    // so its length drives the final size one character at a time. The
    // range is where the crossing sits for this envelope: everything else
    // the envelope carries at this bound, the total-loss warning included,
    // shifts it, and the final assertion below fails loudly if it moved
    // out of range rather than passing on a sweep that never crosses.
    for (let cwdLength = 660; cwdLength <= 680; cwdLength++) {
      const { envelope } = buildEnvelope({
        version: "0.1.0",
        command: "doctor",
        status: "ok",
        durationMs: 5,
        cwd: `/${"c".repeat(cwdLength)}`,
        extra: { tools: [{ name: "git", found: true }] },
        maxChars,
      });
      const finalLength = JSON.stringify(envelope).length;
      digitCounts.add(String(finalLength).length);
      const warnings = envelope.warnings as string[];
      expect(warnings[warnings.length - 1]).toBe(
        `envelope is ${finalLength} characters; requested max-chars ${maxChars} could not be met`,
      );
    }
    expect(digitCounts.size).toBeGreaterThan(1);
  });
});

describe("buildEnvelope: never mutates the caller's extra", () => {
  it("leaves the caller's extra object (including nested arrays/objects) exactly as passed in, even under heavy reduction", () => {
    const logDir = makeTmpDir();
    const original = {
      checks: Array.from({ length: 50 }, (_, i) => ({
        name: `check-${i}`,
        message: "m".repeat(500),
      })),
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: original,
      maxChars: 200,
      logDir,
    });
    expect(original).toEqual(snapshot);
  });
});

describe("buildEnvelope: base fields win over extra", () => {
  it("does not let extra's status/truncated/tool keys shadow the real ones", () => {
    const { envelope, exitCode } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp",
      extra: {
        status: "hijacked",
        truncated: true,
        tool: "not-agent-primitives",
        command: "hijacked-command",
        version: "9.9.9",
        cwd: "/hijacked",
      },
    });
    expect(envelope.status).toBe("ok");
    expect(envelope.truncated).toBe(false);
    expect(envelope.tool).toBe("agent-primitives");
    expect(envelope.command).toBe("doctor");
    expect(envelope.version).toBe("0.1.0");
    expect(envelope.cwd).toBe("/tmp");
    expect(exitCode).toBe(0);
  });
});

describe("buildEnvelope: unwritable log dir", () => {
  it("pushes a warning naming the failure instead of silently swallowing it", () => {
    const parentDir = makeTmpDir();
    // A regular file where a directory is expected: mkdirSync(recursive)
    // fails with ENOTDIR trying to create a subdirectory under it.
    const blockerFile = path.join(parentDir, "blocker");
    fs.writeFileSync(blockerFile, "not a directory");
    const unwritableLogDir = path.join(blockerFile, "sub");

    const hugeTail = "x".repeat(1024 * 1024);
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { checks: [{ name: "test", rawOutput: hugeTail }] },
      maxChars: 8000,
      logDir: unwritableLogDir,
    });
    expect(envelope.truncated).toBe(true);
    const warnings = envelope.warnings as string[];
    expect(
      warnings.some((w) =>
        w.startsWith(`full result not written to ${unwritableLogDir}:`),
      ),
    ).toBe(true);
    expect(envelope.logs).toEqual([]);
  });
});

describe("index.js seam", () => {
  it("re-exports buildEnvelope with identical behavior", () => {
    const { envelope } = buildEnvelopeFromIndex({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 1,
      cwd: "/tmp",
    });
    expect(envelope.tool).toBe("agent-primitives");
    expect(envelope.status).toBe("ok");
  });
});

describe("buildEnvelope: undefined-valued fields", () => {
  it("measures a result carrying an undefined-valued field instead of throwing on it, and keeps the key", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp",
      // `absent` is what a subcommand produces when an optional capture
      // came back empty (doctor's `version` for a binary that printed
      // nothing). JSON.stringify returns undefined, not a string, for such
      // a value, so measuring it as a reduction candidate used to throw
      // and turn the whole command into `status: error`.
      extra: { absent: undefined, filler: "x".repeat(50_000) },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    expect(envelope.truncated).toBe(true);
    expect(envelope.status).toBe("ok");
    expect("absent" in envelope).toBe(true);
  });
});

describe("buildEnvelope: results that cannot be serialized at all", () => {
  it("emits the skeleton and a warning naming the reason for a value structuredClone refuses (a function), keeping the command's real status", () => {
    const { envelope, exitCode } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { onDone: () => {}, name: "unit" },
    });
    expect(envelope.status).toBe("fail");
    expect(exitCode).toBe(1);
    expect(envelope.onDone).toBeUndefined();
    expect(envelope.name).toBeUndefined();
    expect(envelope.truncated).toBe(true);
    const warnings = envelope.warnings as string[];
    expect(
      warnings.some((w) =>
        w.startsWith("result fields dropped: not serializable"),
      ),
    ).toBe(true);
  });

  it("does the same for a circular object, which structuredClone copies happily and JSON.stringify then refuses", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { graph: node },
    });
    expect(envelope.status).toBe("fail");
    expect(envelope.graph).toBeUndefined();
    expect(envelope.truncated).toBe(true);
    const warnings = envelope.warnings as string[];
    expect(
      warnings.some((w) =>
        w.startsWith("result fields dropped: not serializable"),
      ),
    ).toBe(true);
    expect(() => JSON.stringify(envelope)).not.toThrow();
  });

  it("does the same for a BigInt, which structuredClone copies and JSON.stringify refuses", () => {
    const { envelope, exitCode } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { count: 10n, name: "unit" },
    });
    expect(envelope.status).toBe("fail");
    expect(exitCode).toBe(1);
    expect(envelope.count).toBeUndefined();
    expect(envelope.truncated).toBe(true);
    const warnings = envelope.warnings as string[];
    expect(
      warnings.some((w) =>
        w.startsWith("result fields dropped: not serializable"),
      ),
    ).toBe(true);
    expect(() => JSON.stringify(envelope)).not.toThrow();
  });
});

describe("keepWhole: a named path is reported whole, never reduced", () => {
  /** A payload shaped like a plan result: a long array of entries plus
   * the small summary a reader needs whatever the reduction cuts. */
  function planPayload(count: number): Record<string, unknown> {
    return {
      reason: "mutant_inconclusive",
      plan: {
        baseline: { exitCode: 0, durationMs: 1234, logPath: "/tmp/base.log" },
        results: Array.from({ length: count }, (_v, i) => ({
          index: i,
          file: `/a/very/long/path/to/the/file/under/test/fixture-${String(i)}.ts`,
          expect: "fail",
          status: "killed",
          warnings: [],
          mutation_probe: {
            mutant: `line ${String(i)}: before -> after`,
            verified_applied_via: `line ${String(i)} now reads after`,
            result: "killed",
            restored_verified: true,
          },
          logs: [`/tmp/logs/exec-${String(i)}.log`],
        })),
        summary: {
          total: count,
          killed: count,
          survived: 0,
          inconclusive: 0,
          not_run: 0,
        },
      },
    };
  }

  const BOUND = 900;

  it("keeps the named path whole while its siblings are cut, and the caller's bound still holds", () => {
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "probe",
      status: "killed",
      durationMs: 10,
      cwd: "/tmp",
      extra: planPayload(40),
      keepWhole: ["plan.summary"],
      maxChars: BOUND,
    });
    expect(envelope.truncated).toBe(true);
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(BOUND);
    const plan = envelope.plan as Record<string, unknown>;
    // The five counts are all there, and they still describe all forty
    // mutants, not the handful of entries that survived beside them.
    expect(plan.summary).toEqual({
      total: 40,
      killed: 40,
      survived: 0,
      inconclusive: 0,
      not_run: 0,
    });
    expect((plan.results as unknown[]).length).toBeLessThan(40);
  });

  it("without the path named, the same bound cuts into the summary itself (the control)", () => {
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "probe",
      status: "killed",
      durationMs: 10,
      cwd: "/tmp",
      extra: planPayload(40),
      maxChars: BOUND,
    });
    const plan = envelope.plan as Record<string, unknown>;
    expect(plan.summary).not.toEqual({
      total: 40,
      killed: 40,
      survived: 0,
      inconclusive: 0,
      not_run: 0,
    });
  });

  it("holds a path out of the key budget without lying about what was dropped", () => {
    const limits: CapLimits = {
      maxString: 50,
      maxArray: 50,
      maxKeys: 1,
      maxDepth: 6,
    };
    const capped = applyCaps(
      {
        a: 1,
        plan: { results: [1, 2], summary: { total: 2 }, extra: 3 },
        z: 9,
      },
      limits,
      ["plan.summary"],
    );
    // `plan` is on the kept path, so it is emitted beside the one key
    // the budget allows; only `z` is missing at the top level.
    expect(Object.keys(capped)).toEqual(["a", "plan", "..."]);
    expect(capped["..."]).toBe("1 more key omitted");
    const plan = capped.plan as Record<string, unknown>;
    // Inside it, the held key is exempt from the budget while the other
    // keys still spend it, and the marker counts exactly what it cut.
    expect(plan.summary).toEqual({ total: 2 });
    expect(Object.keys(plan)).toEqual(["results", "summary", "..."]);
    expect(plan["..."]).toBe("1 more key omitted");
  });

  it("survives a depth limit that would otherwise prune the container holding it", () => {
    const limits: CapLimits = {
      maxString: 50,
      maxArray: 50,
      maxKeys: 50,
      maxDepth: 1,
    };
    const capped = applyCaps(
      { plan: { summary: { total: 2 }, results: [{ index: 0 }] } },
      limits,
      ["plan.summary"],
    );
    const plan = capped.plan as Record<string, unknown>;
    expect(plan.summary).toEqual({ total: 2 });
    // Everything not on the kept path is still pruned at that depth.
    expect(typeof plan.results).toBe("string");
  });

  it("is exactly the reduction it always was when no path is named", () => {
    const limits: CapLimits = {
      maxString: 50,
      maxArray: 50,
      maxKeys: 1,
      maxDepth: 6,
    };
    const payload = { a: 1, b: 2, c: 3 };
    expect(applyCaps(payload, limits, [])).toEqual(applyCaps(payload, limits));
    expect(applyCaps(payload, limits, [""])).toEqual(
      applyCaps(payload, limits),
    );
  });

  it("a held value too large to fit even alone is dropped in total loss, not shown past the bound (H2 round 3)", () => {
    // A held path is exempt from every cap (it is copied uncapped into
    // every candidate the search tries), but it is not exempt from the
    // bound check itself: a candidate that includes it and still
    // overflows is simply never chosen as `best`. When the held value
    // alone (plus the fixed skeleton) is too big for ANY candidate to
    // fit, no scale or depth-only fallback ever succeeds, so the result
    // falls all the way back to the existing "reduced to the fixed
    // fields only" total-loss outcome: the held value is not shown
    // oversized past the bound, it disappears along with the rest of
    // the payload, and the bound itself is still met.
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "probe",
      status: "killed",
      durationMs: 10,
      cwd: "/tmp",
      extra: {
        plan: {
          summary: "x".repeat(50000),
          other: "y".repeat(50),
        },
      },
      keepWhole: ["plan.summary"],
      maxChars: 900,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(900);
    expect(envelope.truncated).toBe(true);
    expect(envelope.plan).toBeUndefined();
    expect(envelope.warnings).toEqual([
      "result reduced to the fixed fields only: no payload structure fits within max-chars 900; no full result was written",
    ]);
  });
});

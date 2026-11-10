import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@iarna/toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseCodexFallbackMode,
  parseRoutingResolution,
  planCodexFallback,
} from "../src/codex-fallback.js";
import { runDoctor } from "../src/doctor.js";
import { MANIFEST_PATH, readInstalledManifest, runInit } from "../src/init.js";
import type { InitOptions } from "../src/init.js";
import { DEFAULT_MODELS } from "../src/models.js";
import { OPERATOR_HOME_ENV } from "../src/operator-manifest.js";
import {
  codexModelCandidates,
  codexModelsRoutingPatch,
  defaultCodexRouting,
  parseCodexModelCandidates,
  parseCodexModels,
} from "../src/routing.js";
import { runUninstall } from "../src/uninstall.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

// The bundled intended model of each alias class.
const SMALL = "gpt-6-luna";
const BALANCED = "gpt-6.1-sol";
const STRONG = "gpt-6-astra";

const ALL_EFFORTS = ["low", "medium", "high", "xhigh"];

/** A catalog model; `efforts: null` leaves `supported_reasoning_levels` out. */
function model(slug: string, efforts: string[] | null = ALL_EFFORTS) {
  return efforts === null
    ? { slug }
    : {
        slug,
        supported_reasoning_levels: efforts.map((effort) => ({ effort })),
      };
}

function catalog(...models: ReturnType<typeof model>[]) {
  return { models };
}

let directory: string;
let target: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ow-codex-fallback-"));
  target = join(directory, "target");
  mkdirSync(target);
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** Every Codex leaf installed: all roles, default tiers and variants. */
function options(extra: Partial<InitOptions> = {}): InitOptions {
  return {
    targetDir: target,
    harnesses: ["codex"],
    models: { ...DEFAULT_MODELS },
    profile: "full",
    tiers: true,
    ...extra,
  };
}

function agent(name: string, dir = target) {
  const parsed = parse(
    readFileSync(join(dir, ".codex", "agents", `${name}.toml`), "utf8"),
  );
  return { model: parsed.model, effort: parsed.model_reasoning_effort };
}

function rawManifest(dir = target): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, MANIFEST_PATH), "utf8"));
}

/** Every file below `dir` with its content, to prove nothing changed. */
function snapshot(dir = target): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return files;
}

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

const fallbackNotes = (notes: string[]) =>
  notes.filter((note) => note.startsWith("Codex fallback:"));

describe("Codex alias candidates", () => {
  it("reads a string value as a list of one", () => {
    expect(parseCodexModelCandidates({ balanced: "gpt-a" })).toEqual({
      balanced: ["gpt-a"],
    });
    expect(parseCodexModels({ balanced: "gpt-a" })).toEqual({
      balanced: "gpt-a",
    });
  });

  it("reads an array value in order and takes its first entry as the intended model", () => {
    const value = { balanced: ["gpt-a", "gpt-b"], strong: ["gpt-c"] };
    expect(parseCodexModelCandidates(value)).toEqual(value);
    expect(parseCodexModels(value)).toEqual({
      balanced: "gpt-a",
      strong: "gpt-c",
    });
  });

  it("builds the same routing patch from an array as from its first entry", () => {
    expect(codexModelsRoutingPatch({ balanced: ["gpt-a", "gpt-b"] })).toEqual(
      codexModelsRoutingPatch({ balanced: "gpt-a" }),
    );
  });

  it.each([
    [{ balanced: [] }, /at least one model id/],
    [{ balanced: ["gpt-a", "gpt-a"] }, /more than once/],
    [{ balanced: ["gpt-a", 7] }, /non-empty trimmed string/],
    [{ balanced: ["gpt-a", "strong"] }, /internal Codex alias/],
    [{ balanced: ["gpt-a", "opus"] }, /not Claude alias/],
    [{ medium: ["gpt-a"] }, /Unknown Codex model alias/],
  ])("rejects the candidate map %j", (value, message) => {
    expect(() => parseCodexModelCandidates(value)).toThrow(message);
  });

  it("keeps the bundled lists and replaces only a supplied alias, whole", () => {
    expect(codexModelCandidates()).toEqual({
      small: [SMALL],
      balanced: [BALANCED],
      strong: [STRONG],
    });
    expect(codexModelCandidates({ strong: ["gpt-x", "gpt-y"] })).toEqual({
      small: [SMALL],
      balanced: [BALANCED],
      strong: ["gpt-x", "gpt-y"],
    });
  });
});

describe("--codex-fallback values", () => {
  it.each(["stop", "degrade"])("accepts %s", (mode) => {
    expect(parseCodexFallbackMode(mode)).toBe(mode);
  });

  it.each(["", "omit", "Degrade", undefined])("rejects %j", (mode) => {
    expect(() => parseCodexFallbackMode(mode)).toThrow(/valid values/);
  });

  it("rejects an unknown mode passed to runInit before writing", () => {
    expect(() => runInit(options({ codexFallback: "omit" as never }))).toThrow(
      /valid values: stop, degrade/,
    );
    expect(readdirSync(target)).toEqual([]);
  });
});

describe("stop: the default with a catalog that lacks a selected model", () => {
  const lacksStrong = catalog(model(SMALL), model(BALANCED));

  it("stops before writing and prints the substitution table, one line per affected leaf", () => {
    const message = thrown(() =>
      runInit(options({ codexCatalog: lacksStrong })),
    );
    expect(message).toContain("unavailable in the supplied catalog");
    expect(message.split("\n").slice(2)).toEqual([
      `  implementer/xhigh: ${STRONG} (high) -> ${BALANCED} (high) [lower-class]`,
      `  reviewer/high: ${STRONG} (high) -> ${BALANCED} (high) [lower-class]`,
      `  reviewer/xhigh: ${STRONG} (xhigh) -> ${BALANCED} (xhigh) [lower-class]`,
      `  advisor/high: ${STRONG} (high) -> ${BALANCED} (high) [lower-class]`,
      `  advisor/xhigh: ${STRONG} (xhigh) -> ${BALANCED} (xhigh) [lower-class]`,
    ]);
    expect(readdirSync(target)).toEqual([]);
  });

  it("behaves the same when stop is passed explicitly", () => {
    const implicit = thrown(() =>
      runInit(options({ codexCatalog: lacksStrong })),
    );
    const explicit = thrown(() =>
      runInit(options({ codexCatalog: lacksStrong, codexFallback: "stop" })),
    );
    expect(explicit).toBe(implicit);
    expect(readdirSync(target)).toEqual([]);
  });

  it("names a leaf without a substitute and the reason in the table", () => {
    const message = thrown(() =>
      runInit(options({ codexCatalog: catalog(model(SMALL)), tiers: false })),
    );
    expect(message).toContain(
      `reviewer/high: ${STRONG} (high) -> no substitute: the catalog offers no usable candidate of the strong or balanced class (the reviewer is never substituted below the balanced class)`,
    );
    expect(message).toContain(
      `explorer/medium: ${BALANCED} (medium) -> ${SMALL} (high) [lower-class]`,
    );
    expect(readdirSync(target)).toEqual([]);
  });
});

describe("degrade: substitution by the fixed rule", () => {
  it("takes the first later candidate of the same class that the catalog offers", () => {
    const report = runInit(
      options({
        codexFallback: "degrade",
        codexModelCandidates: {
          strong: [STRONG, "gpt-strong-b", "gpt-strong-c"],
        },
        codexCatalog: catalog(
          model(SMALL),
          model(BALANCED),
          model("gpt-strong-c"),
          model("gpt-strong-b"),
        ),
      }),
    );
    expect(agent("implementer-xhigh")).toEqual({
      model: "gpt-strong-b",
      effort: "high",
    });
    expect(agent("reviewer-xhigh")).toEqual({
      model: "gpt-strong-b",
      effort: "xhigh",
    });
    expect(
      readInstalledManifest(target)?.routingResolution?.codex?.reviewer?.high,
    ).toEqual({
      intended: { model: STRONG, effort: "high" },
      used: { model: "gpt-strong-b", effort: "high" },
      reason: "class-candidate",
    });
    expect(fallbackNotes(report.notes)).toContain(
      `Codex fallback: reviewer/high uses gpt-strong-b (high) instead of intended ${STRONG} (high) [class-candidate].`,
    );
  });

  it("skips a same-class candidate the catalog lacks and takes the next one", () => {
    runInit(
      options({
        codexFallback: "degrade",
        codexModelCandidates: {
          strong: [STRONG, "gpt-strong-b", "gpt-strong-c"],
        },
        codexCatalog: catalog(
          model(SMALL),
          model(BALANCED),
          model("gpt-strong-c"),
        ),
      }),
    );
    expect(agent("advisor").model).toBe("gpt-strong-c");
    expect(
      readInstalledManifest(target)?.routingResolution?.codex?.advisor?.high
        ?.reason,
    ).toBe("class-candidate");
  });

  it("never substitutes a candidate listed before the intended model", () => {
    // The leaf is pinned to the second candidate; the first is offered, but
    // only later candidates and lower classes are substitutes.
    const message = thrown(() =>
      runInit(
        options({
          tiers: false,
          codexFallback: "degrade",
          codexModelCandidates: { balanced: ["gpt-first", "gpt-second"] },
          routing: {
            codex: {
              reviewer: { high: { model: "gpt-second", effort: "high" } },
            },
          },
          codexCatalog: catalog(
            model(SMALL),
            model(BALANCED),
            model("gpt-first"),
          ),
        }),
      ),
    );
    expect(message).toContain(
      "reviewer/high: gpt-second (high) -> no substitute",
    );
    expect(readdirSync(target)).toEqual([]);
  });

  it("steps to the next lower class when the own class has no offered candidate, and raises the effort to high", () => {
    const report = runInit(
      options({
        tiers: false,
        codexFallback: "degrade",
        codexCatalog: catalog(model(SMALL), model(STRONG)),
      }),
    );
    // The balanced default leaves run at medium; on the small class they run
    // at high.
    for (const role of ["explorer", "task-slicer", "implementer"]) {
      expect(agent(role)).toEqual({ model: SMALL, effort: "high" });
    }
    expect(
      readInstalledManifest(target)?.routingResolution?.codex?.explorer?.medium,
    ).toEqual({
      intended: { model: BALANCED, effort: "medium" },
      used: { model: SMALL, effort: "high" },
      reason: "lower-class",
    });
    expect(fallbackNotes(report.notes)).toHaveLength(3);
  });

  it("keeps an effort above high when a leaf drops a class", () => {
    runInit(
      options({
        codexFallback: "degrade",
        codexCatalog: catalog(model(SMALL), model(BALANCED)),
      }),
    );
    expect(agent("reviewer-xhigh")).toEqual({
      model: BALANCED,
      effort: "xhigh",
    });
    expect(agent("implementer-xhigh")).toEqual({
      model: BALANCED,
      effort: "high",
    });
  });

  it("keeps stepping down past a class without an offered candidate", () => {
    runInit(
      options({
        profile: "minimal",
        codexFallback: "degrade",
        routing: {
          // No floor applies to the implementer; the reviewer leaves stay
          // on an offered model so they do not block this install.
          codex: {
            reviewer: {
              medium: { model: "gpt-review", effort: "medium" },
              high: { model: "gpt-review", effort: "high" },
              xhigh: { model: "gpt-review", effort: "xhigh" },
            },
            implementer: {
              medium: { model: SMALL, effort: "medium" },
              high: { model: SMALL, effort: "high" },
            },
          },
        },
        codexCatalog: catalog(model(SMALL), model("gpt-review")),
      }),
    );
    expect(agent("implementer-xhigh")).toEqual({
      model: SMALL,
      effort: "high",
    });
    expect(
      readInstalledManifest(target)?.routingResolution?.codex?.implementer,
    ).toEqual({
      xhigh: {
        intended: { model: STRONG, effort: "high" },
        used: { model: SMALL, effort: "high" },
        reason: "lower-class",
      },
    });
  });

  it("prefers a same-class candidate over a lower class", () => {
    runInit(
      options({
        codexFallback: "degrade",
        codexModelCandidates: { strong: [STRONG, "gpt-strong-b"] },
        codexCatalog: catalog(
          model(SMALL),
          model(BALANCED),
          model("gpt-strong-b"),
        ),
      }),
    );
    expect(agent("reviewer").model).toBe("gpt-strong-b");
  });

  it("takes the first offered candidate of the lower class, in list order", () => {
    runInit(
      options({
        codexFallback: "degrade",
        codexModelCandidates: {
          balanced: [BALANCED, "gpt-bal-b", "gpt-bal-c"],
        },
        codexCatalog: catalog(
          model(SMALL),
          model("gpt-bal-c"),
          model("gpt-bal-b"),
        ),
      }),
    );
    // The catalog lists gpt-bal-c first; the candidate list decides.
    expect(agent("advisor")).toEqual({ model: "gpt-bal-b", effort: "high" });
    expect(
      readInstalledManifest(target)?.routingResolution?.codex?.advisor?.high
        ?.reason,
    ).toBe("lower-class");
    expect(
      readInstalledManifest(target)?.routingResolution?.codex?.implementer
        ?.medium,
    ).toEqual({
      intended: { model: BALANCED, effort: "medium" },
      used: { model: "gpt-bal-b", effort: "medium" },
      reason: "class-candidate",
    });
  });
});

describe("degrade: effort of a substituted leaf", () => {
  const candidates = { strong: [STRONG, "gpt-strong-b"] };

  it("clamps to the next lower level the catalog lists for the chosen model", () => {
    runInit(
      options({
        codexFallback: "degrade",
        codexModelCandidates: candidates,
        codexCatalog: catalog(
          model(SMALL),
          model(BALANCED),
          model("gpt-strong-b", ["low", "medium", "high"]),
        ),
      }),
    );
    expect(agent("reviewer-xhigh")).toEqual({
      model: "gpt-strong-b",
      effort: "high",
    });
    expect(agent("reviewer")).toEqual({
      model: "gpt-strong-b",
      effort: "high",
    });
    expect(
      readInstalledManifest(target)?.routingResolution?.codex?.reviewer?.xhigh,
    ).toEqual({
      intended: { model: STRONG, effort: "xhigh" },
      used: { model: "gpt-strong-b", effort: "high" },
      reason: "class-candidate",
    });
  });

  it("skips a level the catalog does not list when clamping down", () => {
    runInit(
      options({
        codexFallback: "degrade",
        codexModelCandidates: candidates,
        codexCatalog: catalog(
          model(SMALL),
          model(BALANCED),
          model("gpt-strong-b", ["low", "medium", "xhigh"]),
        ),
      }),
    );
    // Intended high is not listed: the next lower listed level is medium.
    expect(agent("reviewer")).toEqual({
      model: "gpt-strong-b",
      effort: "medium",
    });
    expect(agent("reviewer-xhigh").effort).toBe("xhigh");
  });

  it("takes the lowest listed level when the intended effort is below all of them", () => {
    runInit(
      options({
        codexFallback: "degrade",
        codexModelCandidates: { balanced: [BALANCED, "gpt-bal-b"] },
        codexCatalog: catalog(
          model(SMALL),
          model(STRONG),
          model("gpt-bal-b", ["medium", "high"]),
        ),
      }),
    );
    // task-slicer/low intends the balanced model at low.
    expect(agent("task-slicer-low")).toEqual({
      model: "gpt-bal-b",
      effort: "medium",
    });
  });

  it("keeps the effort and warns when the catalog lists no levels for the chosen model", () => {
    const report = runInit(
      options({
        codexFallback: "degrade",
        codexModelCandidates: candidates,
        codexCatalog: catalog(
          model(SMALL),
          model(BALANCED),
          model("gpt-strong-b", null),
        ),
      }),
    );
    expect(agent("reviewer-xhigh")).toEqual({
      model: "gpt-strong-b",
      effort: "xhigh",
    });
    expect(
      report.notes.filter((note) => note.includes("could not be validated")),
    ).toEqual([
      'Codex catalog: Codex catalog does not provide reasoning-effort support for "gpt-strong-b"; its selected effort could not be validated.',
    ]);
  });

  it("does not use a lower-class model that lists no effort of high or above", () => {
    const message = thrown(() =>
      runInit(
        options({
          tiers: false,
          codexFallback: "degrade",
          codexCatalog: catalog(
            model(SMALL),
            model(BALANCED, ["low", "medium"]),
          ),
        }),
      ),
    );
    expect(message).toContain(
      `advisor/high: ${STRONG} (high) -> no substitute: the catalog offers no usable candidate of the strong or balanced class (the advisor is never substituted below the balanced class); ${BALANCED} lists no effort of high or above, which a lower-class substitute needs`,
    );
    expect(readdirSync(target)).toEqual([]);
  });

  it("still rejects an unsupported effort on a model the catalog offers", () => {
    expect(() =>
      runInit(
        options({
          codexFallback: "degrade",
          codexCatalog: catalog(
            model(SMALL),
            model(BALANCED),
            model(STRONG, ["high"]),
          ),
        }),
      ),
    ).toThrow(/does not support reasoning effort "xhigh"/);
    expect(readdirSync(target)).toEqual([]);
  });
});

describe("degrade: leaves that are never substituted", () => {
  it("stops and names a leaf whose model is in no candidate list", () => {
    const message = thrown(() =>
      runInit(
        options({
          codexFallback: "degrade",
          routing: {
            codex: {
              implementer: {
                medium: { model: "gpt-custom", effort: "medium" },
              },
            },
          },
          codexCatalog: catalog(model(SMALL), model(BALANCED), model(STRONG)),
        }),
      ),
    );
    expect(message).toContain(
      "--codex-fallback degrade cannot proceed: 1 of 1 affected leaves have no substitute.",
    );
    expect(message).toContain(
      'implementer/medium: gpt-custom (medium) -> no substitute: "gpt-custom" is in no candidate list, and an explicitly selected model is never replaced',
    );
    expect(readdirSync(target)).toEqual([]);
  });

  it("substitutes a leaf set through --routing when its model is in a candidate list", () => {
    runInit(
      options({
        tiers: false,
        codexFallback: "degrade",
        routing: {
          codex: { implementer: { medium: { model: STRONG, effort: "high" } } },
        },
        codexCatalog: catalog(model(SMALL), model(BALANCED)),
      }),
    );
    expect(agent("implementer")).toEqual({ model: BALANCED, effort: "high" });
    expect(
      readInstalledManifest(target)?.routing?.codex?.implementer?.medium,
    ).toEqual({ model: STRONG, effort: "high" });
    expect(
      readInstalledManifest(target)?.routingResolution?.codex?.implementer
        ?.medium,
    ).toEqual({
      intended: { model: STRONG, effort: "high" },
      used: { model: BALANCED, effort: "high" },
      reason: "lower-class",
    });
  });

  it("writes no file and leaves the manifest alone when a leaf of an existing install has no substitute", () => {
    runInit(options());
    const before = snapshot();
    expect(() =>
      runInit(
        options({
          codexFallback: "degrade",
          codexCatalog: catalog(model(SMALL)),
        }),
      ),
    ).toThrow(/have no substitute/);
    expect(snapshot()).toEqual(before);
  });

  it.each(["reviewer", "advisor"] as const)(
    "never moves a %s leaf below the balanced class",
    (role) => {
      const message = thrown(() =>
        runInit(
          options({
            tiers: false,
            codexFallback: "degrade",
            // Only this role's leaf is on the missing strong model.
            routing: {
              codex: {
                [role === "reviewer" ? "advisor" : "reviewer"]: {
                  high: { model: SMALL, effort: "high" },
                },
                explorer: { medium: { model: SMALL, effort: "high" } },
                "task-slicer": { medium: { model: SMALL, effort: "high" } },
                implementer: { medium: { model: SMALL, effort: "high" } },
              },
            },
            codexCatalog: catalog(model(SMALL)),
          }),
        ),
      );
      expect(message).toContain(
        `--codex-fallback degrade cannot proceed: 1 of 1 affected leaves have no substitute.`,
      );
      expect(message).toContain(
        `${role}/high: ${STRONG} (high) -> no substitute:`,
      );
      expect(readdirSync(target)).toEqual([]);
    },
  );

  it("lets a role without a floor drop to the small class in the same catalog", () => {
    const plan = planCodexFallback(
      {
        codex: {
          implementer: { xhigh: { model: STRONG, effort: "high" } },
          reviewer: { high: { model: STRONG, effort: "high" } },
        },
      },
      catalog(model(SMALL)),
      codexModelCandidates(),
    );
    expect(plan.rows.map((row) => [row.role, row.used?.model])).toEqual([
      ["implementer", SMALL],
      ["reviewer", undefined],
    ]);
  });

  it("does not substitute a reviewer leaf that is itself on a class below the floor", () => {
    const plan = planCodexFallback(
      { codex: { reviewer: { medium: { model: SMALL, effort: "medium" } } } },
      catalog(model("gpt-small-b"), model(BALANCED)),
      codexModelCandidates({ small: [SMALL, "gpt-small-b"] }),
    );
    expect(plan.rows).toEqual([
      {
        role: "reviewer",
        tier: "medium",
        intended: { model: SMALL, effort: "medium" },
        problem:
          "the small class is below the balanced class, and the reviewer is never substituted below it",
      },
    ]);
  });

  describe("a candidate of a class below the floor, listed in a higher list too", () => {
    // SMALL is in the small list first and in the balanced list second, so it
    // is a small-class model whichever list offers it.
    const overlapping = {
      small: [SMALL],
      balanced: [BALANCED, SMALL],
    };
    const smallOnly = catalog(model(SMALL));

    it.each(["reviewer", "advisor"] as const)(
      "gives a %s leaf no substitute and says which candidate was skipped",
      (role) => {
        const plan = planCodexFallback(
          { codex: { [role]: { high: { model: STRONG, effort: "high" } } } },
          smallOnly,
          codexModelCandidates(overlapping),
        );
        expect(plan.rows).toEqual([
          {
            role,
            tier: "high",
            intended: { model: STRONG, effort: "high" },
            problem: `the catalog offers no usable candidate of the strong or balanced class (the ${role} is never substituted below the balanced class); ${SMALL} is of the small class, below the balanced class`,
          },
        ]);
      },
    );

    it("lets an implementer leaf take it", () => {
      const plan = planCodexFallback(
        { codex: { implementer: { high: { model: STRONG, effort: "high" } } } },
        smallOnly,
        codexModelCandidates(overlapping),
      );
      expect(plan.rows[0].used).toEqual({ model: SMALL, effort: "high" });
      expect(plan.rows[0].reason).toBe("lower-class");
    });

    it("stops an install whose reviewer leaf has only that candidate, and writes nothing", () => {
      const message = thrown(() =>
        runInit(
          options({
            tiers: false,
            codexFallback: "degrade",
            codexModelCandidates: overlapping,
            codexCatalog: smallOnly,
          }),
        ),
      );
      expect(message).toContain(
        `reviewer/high: ${STRONG} (high) -> no substitute:`,
      );
      expect(message).toContain(
        `advisor/high: ${STRONG} (high) -> no substitute:`,
      );
      expect(readdirSync(target)).toEqual([]);
    });

    it("counts a model first in both the balanced and the small list as balanced", () => {
      const plan = planCodexFallback(
        { codex: { reviewer: { high: { model: STRONG, effort: "high" } } } },
        catalog(model("gpt-tie")),
        codexModelCandidates({ small: ["gpt-tie"], balanced: ["gpt-tie"] }),
      );
      expect(plan.rows[0].used).toEqual({ model: "gpt-tie", effort: "high" });
    });
  });

  it("lets a reviewer leaf drop from strong to balanced", () => {
    runInit(
      options({
        tiers: false,
        codexFallback: "degrade",
        codexCatalog: catalog(model(SMALL), model(BALANCED)),
      }),
    );
    expect(agent("reviewer")).toEqual({ model: BALANCED, effort: "high" });
  });
});

describe("class of a model that several candidate lists name", () => {
  it("uses the list that names it earliest, and the stronger class on a tie", () => {
    const leaf = { model: "gpt-shared", effort: "high" as const };
    const plan = (candidates: Record<string, string[]>) =>
      planCodexFallback(
        { codex: { implementer: { high: leaf } } },
        catalog(
          model("gpt-small-next"),
          model("gpt-bal-next"),
          model("gpt-strong-next"),
        ),
        codexModelCandidates(candidates),
      ).rows[0].used?.model;
    // Earliest position wins: first in balanced, second in strong.
    expect(
      plan({
        balanced: ["gpt-shared", "gpt-bal-next"],
        strong: ["gpt-other", "gpt-shared", "gpt-strong-next"],
      }),
    ).toBe("gpt-bal-next");
    // Same position in both: the stronger class.
    expect(
      plan({
        balanced: ["gpt-shared", "gpt-bal-next"],
        strong: ["gpt-shared", "gpt-strong-next"],
      }),
    ).toBe("gpt-strong-next");
  });
});

describe("the routingResolution record", () => {
  const lacksStrong = catalog(model(SMALL), model(BALANCED));
  const complete = catalog(model(SMALL), model(BALANCED), model(STRONG));

  it("is written only for the degraded leaves, and routing stays the intended routing", () => {
    runInit(options({ codexFallback: "degrade", codexCatalog: lacksStrong }));
    const manifest = rawManifest();
    expect(Object.keys(manifest)).toEqual([
      "kit",
      "version",
      "harnesses",
      "models",
      "profile",
      "tiers",
      "routing",
      "routingResolution",
      "files",
      "installedAt",
    ]);
    expect(manifest.routing).toEqual(defaultCodexRouting());
    const lowerClass = (effort: string) => ({
      intended: { model: STRONG, effort },
      used: { model: BALANCED, effort },
      reason: "lower-class",
    });
    expect(manifest.routingResolution).toEqual({
      codex: {
        implementer: { xhigh: lowerClass("high") },
        reviewer: { high: lowerClass("high"), xhigh: lowerClass("xhigh") },
        advisor: { high: lowerClass("high"), xhigh: lowerClass("xhigh") },
      },
    });
    // A leaf on an offered model renders its intended routing.
    expect(agent("implementer")).toEqual({ model: BALANCED, effort: "medium" });
    expect(agent("advisor")).toEqual({ model: BALANCED, effort: "high" });
  });

  it("is not written when degrade is allowed but nothing is degraded", () => {
    runInit(options({ codexCatalog: complete }));
    const before = snapshot();
    const report = runInit(
      options({ codexFallback: "degrade", codexCatalog: complete }),
    );
    expect(snapshot()).toEqual(before);
    expect("routingResolution" in rawManifest()).toBe(false);
    expect(fallbackNotes(report.notes)).toEqual([]);
  });

  it("changes nothing without a catalog, whatever the fallback mode", () => {
    const plain = join(directory, "plain");
    mkdirSync(plain);
    const plainReport = runInit(options({ targetDir: plain }));
    const report = runInit(options({ codexFallback: "degrade" }));
    const files = snapshot();
    const plainFiles = snapshot(plain);
    const withoutTime = (text: string) =>
      text.replace(/"installedAt": "[^"]+"/, '"installedAt": ""');
    files[MANIFEST_PATH] = withoutTime(files[MANIFEST_PATH]);
    plainFiles[MANIFEST_PATH] = withoutTime(plainFiles[MANIFEST_PATH]);
    expect(files).toEqual(plainFiles);
    expect(report.notes).toEqual(plainReport.notes);
    expect(
      report.notes.filter((note) =>
        note.includes("no capability catalog supplied"),
      ),
    ).toHaveLength(1);
  });

  it("is read strictly: a malformed record stops the read", () => {
    runInit(options({ codexFallback: "degrade", codexCatalog: lacksStrong }));
    const manifest = rawManifest();
    const write = (routingResolution: unknown) =>
      writeFileSync(
        join(target, MANIFEST_PATH),
        JSON.stringify({ ...manifest, routingResolution }),
      );
    const entry = {
      intended: { model: STRONG, effort: "high" },
      used: { model: BALANCED, effort: "high" },
      reason: "lower-class",
    };
    for (const [value, message] of [
      [[], /routingResolution must be an object/],
      [{ claude: {} }, /Unknown routingResolution harness "claude"/],
      [{ codex: { nobody: { high: entry } } }, /intended is invalid/],
      [
        { codex: { advisor: { low: entry } } },
        /not allowed for role "advisor"/,
      ],
      [
        { codex: { advisor: { high: { ...entry, reason: "omitted" } } } },
        /reason must be one of class-candidate, lower-class/,
      ],
      [
        {
          codex: { advisor: { high: { ...entry, used: { model: BALANCED } } } },
        },
        /used is invalid/,
      ],
      [
        { codex: { advisor: { high: { ...entry, note: "x" } } } },
        /Unknown routingResolution.codex.advisor.high field "note"/,
      ],
    ] as const) {
      write(value);
      expect(() => readInstalledManifest(target)).toThrow(message);
    }
    write({ codex: { advisor: { high: entry } } });
    expect(readInstalledManifest(target)?.routingResolution).toEqual({
      codex: { advisor: { high: entry } },
    });
  });

  it("reads a record without entries as no record", () => {
    expect(parseRoutingResolution({})).toBeUndefined();
    expect(parseRoutingResolution({ codex: {} })).toBeUndefined();
    expect(parseRoutingResolution({ codex: { reviewer: {} } })).toBeUndefined();
  });
});

describe("re-install of a degraded target", () => {
  const lacksStrong = catalog(model(SMALL), model(BALANCED));
  const complete = catalog(model(SMALL), model(BALANCED), model(STRONG));
  const degraded = () =>
    runInit(options({ codexFallback: "degrade", codexCatalog: lacksStrong }));

  it("keeps the record and every file without a catalog, and says which substitutes it kept", () => {
    degraded();
    const before = snapshot();
    const report = runInit(options());
    expect(snapshot()).toEqual(before);
    expect(fallbackNotes(report.notes)).toEqual([
      `Codex fallback: implementer/xhigh keeps the recorded substitute ${BALANCED} (high) for intended ${STRONG} (high) [lower-class]; no catalog was supplied, so availability was not checked again.`,
      `Codex fallback: reviewer/high keeps the recorded substitute ${BALANCED} (high) for intended ${STRONG} (high) [lower-class]; no catalog was supplied, so availability was not checked again.`,
      `Codex fallback: reviewer/xhigh keeps the recorded substitute ${BALANCED} (xhigh) for intended ${STRONG} (xhigh) [lower-class]; no catalog was supplied, so availability was not checked again.`,
      `Codex fallback: advisor/high keeps the recorded substitute ${BALANCED} (high) for intended ${STRONG} (high) [lower-class]; no catalog was supplied, so availability was not checked again.`,
      `Codex fallback: advisor/xhigh keeps the recorded substitute ${BALANCED} (xhigh) for intended ${STRONG} (xhigh) [lower-class]; no catalog was supplied, so availability was not checked again.`,
    ]);
  });

  it("returns to the intended model and removes the record when the catalog offers it again", () => {
    degraded();
    const report = runInit(options({ codexCatalog: complete }));
    expect(agent("reviewer")).toEqual({ model: STRONG, effort: "high" });
    expect(agent("implementer-xhigh")).toEqual({
      model: STRONG,
      effort: "high",
    });
    expect("routingResolution" in rawManifest()).toBe(false);
    expect(rawManifest().routing).toEqual(defaultCodexRouting());
    expect(fallbackNotes(report.notes)).toContain(
      `Codex fallback: reviewer/high returns to its intended model ${STRONG} (high), which the catalog offers again; the substitute ${BALANCED} (high) is no longer used.`,
    );
    expect(fallbackNotes(report.notes)).toHaveLength(5);
    // The result equals an install that never degraded.
    const fresh = join(directory, "fresh");
    mkdirSync(fresh);
    runInit(options({ targetDir: fresh, codexCatalog: complete }));
    expect(agent("reviewer")).toEqual(agent("reviewer", fresh));
    expect(Object.keys(rawManifest())).toEqual(Object.keys(rawManifest(fresh)));
  });

  it("stops with the table when the model is still missing and degrade is not passed again", () => {
    degraded();
    const before = snapshot();
    const message = thrown(() =>
      runInit(options({ codexCatalog: lacksStrong })),
    );
    expect(message).toContain(
      "--codex-fallback degrade would apply these substitutions:",
    );
    expect(message).toContain(
      `reviewer/high: ${STRONG} (high) -> ${BALANCED} (high) [lower-class]`,
    );
    expect(snapshot()).toEqual(before);
  });

  it("is a no-op when degrade is passed again with the same catalog", () => {
    degraded();
    const before = snapshot();
    const report = degraded();
    expect(snapshot()).toEqual(before);
    expect(fallbackNotes(report.notes)).toHaveLength(5);
  });

  it("recomputes from the intended routing when the catalog changes", () => {
    runInit(
      options({
        codexFallback: "degrade",
        codexModelCandidates: { strong: [STRONG, "gpt-strong-b"] },
        codexCatalog: lacksStrong,
      }),
    );
    expect(agent("reviewer").model).toBe(BALANCED);
    // The same-class candidate is offered now: the leaf moves up to it
    // instead of staying on the lower class it was recorded with.
    runInit(
      options({
        codexFallback: "degrade",
        codexModelCandidates: { strong: [STRONG, "gpt-strong-b"] },
        codexCatalog: catalog(
          model(SMALL),
          model(BALANCED),
          model("gpt-strong-b"),
        ),
      }),
    );
    expect(agent("reviewer").model).toBe("gpt-strong-b");
    expect(
      readInstalledManifest(target)?.routingResolution?.codex?.reviewer?.high,
    ).toEqual({
      intended: { model: STRONG, effort: "high" },
      used: { model: "gpt-strong-b", effort: "high" },
      reason: "class-candidate",
    });
  });

  it("drops the record of a leaf whose intended routing changed, and says so", () => {
    degraded();
    const report = runInit(
      options({
        routing: {
          codex: { reviewer: { high: { model: BALANCED, effort: "high" } } },
        },
      }),
    );
    const resolution = readInstalledManifest(target)?.routingResolution;
    expect(resolution?.codex?.reviewer).toEqual({
      xhigh: {
        intended: { model: STRONG, effort: "xhigh" },
        used: { model: BALANCED, effort: "xhigh" },
        reason: "lower-class",
      },
    });
    expect(fallbackNotes(report.notes)).toContain(
      `Codex fallback: the recorded substitution of reviewer/high (${BALANCED} (high) for intended ${STRONG} (high)) is dropped, because the intended routing of that leaf changed to ${BALANCED} (high).`,
    );
    expect(
      readInstalledManifest(target)?.routing?.codex?.reviewer?.high,
    ).toEqual({ model: BALANCED, effort: "high" });
  });

  it("drops the record of a leaf whose intended effort alone changed, and renders the intended model", () => {
    degraded();
    const report = runInit(
      options({
        routing: {
          codex: { reviewer: { high: { model: STRONG, effort: "medium" } } },
        },
      }),
    );
    expect(
      readInstalledManifest(target)?.routingResolution?.codex?.reviewer?.high,
    ).toBeUndefined();
    expect(agent("reviewer")).toEqual({ model: STRONG, effort: "medium" });
    expect(fallbackNotes(report.notes)).toContain(
      `Codex fallback: the recorded substitution of reviewer/high (${BALANCED} (high) for intended ${STRONG} (high)) is dropped, because the intended routing of that leaf changed to ${STRONG} (medium).`,
    );
    // The other leaves keep their records.
    expect(
      readInstalledManifest(target)?.routingResolution?.codex?.reviewer?.xhigh,
    ).toBeDefined();
  });

  describe("a leaf that is not installed in this run", () => {
    const uninstalled = [
      "implementer/xhigh",
      "reviewer/xhigh",
      "advisor/xhigh",
    ];
    const noteFor = (notes: string[], leaf: string) =>
      fallbackNotes(notes).filter((note) => note.includes(leaf));

    it("drops its record with a note when the catalog offers its intended model at the intended effort", () => {
      degraded();
      // Variants off: only the default tiers are installed and re-checked.
      const report = runInit(options({ tiers: false, codexCatalog: complete }));
      expect(agent("reviewer").model).toBe(STRONG);
      expect(rawManifest().routingResolution).toBeUndefined();
      expect(
        fallbackNotes(report.notes).filter((note) =>
          note.includes("returns to"),
        ),
      ).toHaveLength(2);
      for (const leaf of uninstalled) {
        const [dropped, ...others] = noteFor(report.notes, leaf);
        expect(others).toEqual([]);
        expect(dropped).toContain(`the recorded substitution of ${leaf} (`);
        expect(dropped).toContain(
          "is dropped, because this run's catalog offers the intended model, and",
        );
        expect(dropped).toContain("is not installed in this run");
      }
    });

    it("carries its record, with one note per carried record, when the catalog does not offer the intended model", () => {
      degraded();
      const report = runInit(
        options({
          tiers: false,
          codexFallback: "degrade",
          codexCatalog: lacksStrong,
        }),
      );
      const codex = readInstalledManifest(target)?.routingResolution?.codex;
      expect(Object.keys(codex ?? {})).toEqual([
        "implementer",
        "reviewer",
        "advisor",
      ]);
      expect(Object.keys(codex?.reviewer ?? {})).toEqual(["high", "xhigh"]);
      for (const leaf of uninstalled) {
        expect(noteFor(report.notes, leaf)).toEqual([
          expect.stringMatching(
            new RegExp(
              `^Codex fallback: ${leaf} is not installed in this run; its recorded substitute .* is carried unchecked\\.$`,
            ),
          ),
        ]);
      }
      expect(
        fallbackNotes(report.notes).filter((note) =>
          note.includes("carried unchecked"),
        ),
      ).toHaveLength(uninstalled.length);
    });

    it("carries its record when the catalog offers the model but not the intended effort", () => {
      degraded();
      const report = runInit(
        options({
          tiers: false,
          codexCatalog: catalog(
            model(SMALL),
            model(BALANCED),
            model(STRONG, ["low", "medium", "high"]),
          ),
        }),
      );
      const codex = readInstalledManifest(target)?.routingResolution?.codex;
      expect(Object.keys(codex?.reviewer ?? {})).toEqual(["xhigh"]);
      expect(noteFor(report.notes, "reviewer/xhigh")).toEqual([
        expect.stringContaining("is carried unchecked"),
      ]);
      // Variants on again without a catalog: the carried record is rendered.
      runInit(options());
      expect(agent("reviewer-xhigh")).toEqual({
        model: BALANCED,
        effort: "xhigh",
      });
      expect(agent("reviewer")).toEqual({ model: STRONG, effort: "high" });
    });
  });

  it("keeps the record when Codex is not among the harnesses of a run", () => {
    degraded();
    const resolution = rawManifest().routingResolution;
    const report = runInit(
      options({ harnesses: ["claude"], codexCatalog: { malformed: true } }),
    );
    expect(rawManifest().routingResolution).toEqual(resolution);
    expect(fallbackNotes(report.notes)).toEqual([]);
  });

  it("uninstalls the degraded files through the ledger", () => {
    degraded();
    expect(runUninstall({ targetDir: target }).kept).toEqual([]);
    expect(existsSync(join(target, ".codex", "agents"))).toBe(false);
    expect(existsSync(join(target, MANIFEST_PATH))).toBe(false);
  });
});

describe("--codex-fallback on the command line", () => {
  let home: string;
  const lacksStrong = catalog(model(SMALL), model(BALANCED));

  beforeEach(() => {
    home = join(directory, "operator");
  });

  function run(...args: string[]) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      {
        cwd: PACKAGE_DIR,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, [OPERATOR_HOME_ENV]: home },
      },
    );
  }

  function jsonFile(name: string, data: unknown): string {
    const path = join(directory, `${name}.json`);
    writeFileSync(path, `${JSON.stringify(data)}\n`);
    return path;
  }

  const codexInit = ["--yes", "--harness", "codex", "--tiers"];

  it.each(["init", "setup", "apply"])(
    "%s --help lists the option",
    (command) => {
      const help = run(command, "--help").stdout.replace(/\s+/g, " ");
      expect(help).toContain("--codex-fallback <mode>");
      expect(help).toContain("(stop, degrade)");
      expect(help).toContain("stop (default)");
    },
  );

  it("init stops by default, degrades on request, and returns when the model is offered again", () => {
    const lacking = jsonFile("lacking", lacksStrong);
    const stopped = run(
      "init",
      target,
      ...codexInit,
      "--codex-catalog",
      lacking,
    );
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain(
      `  reviewer/high: ${STRONG} (high) -> ${BALANCED} (high) [lower-class]`,
    );
    expect(readdirSync(target)).toEqual([]);

    const degraded = run(
      "init",
      target,
      ...codexInit,
      "--codex-catalog",
      lacking,
      "--codex-fallback",
      "degrade",
    );
    expect(degraded.status, degraded.stderr).toBe(0);
    expect(degraded.stdout).toContain(
      `Codex fallback: reviewer/high uses ${BALANCED} (high) instead of intended ${STRONG} (high) [lower-class].`,
    );
    expect(agent("reviewer").model).toBe(BALANCED);
    expect(rawManifest().routing).toEqual(defaultCodexRouting());

    const before = snapshot();
    const kept = run("init", target, "--yes");
    expect(kept.status, kept.stderr).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(kept.stdout).toContain(
      "reviewer/high keeps the recorded substitute",
    );

    const complete = jsonFile(
      "complete",
      catalog(model(SMALL), model(BALANCED), model(STRONG)),
    );
    const returned = run("init", target, "--yes", "--codex-catalog", complete);
    expect(returned.status, returned.stderr).toBe(0);
    expect(returned.stdout).toContain(
      `Codex fallback: reviewer/high returns to its intended model ${STRONG} (high)`,
    );
    expect(agent("reviewer").model).toBe(STRONG);
    expect("routingResolution" in rawManifest()).toBe(false);
  });

  it("init takes same-class candidates from --codex-models arrays", () => {
    const result = run(
      "init",
      target,
      ...codexInit,
      "--codex-models",
      jsonFile("aliases", { strong: [STRONG, "gpt-strong-b"] }),
      "--codex-catalog",
      jsonFile(
        "catalog",
        catalog(model(SMALL), model(BALANCED), model("gpt-strong-b")),
      ),
      "--codex-fallback",
      "degrade",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(agent("reviewer")).toEqual({
      model: "gpt-strong-b",
      effort: "high",
    });
    expect(
      readInstalledManifest(target)?.routing?.codex?.reviewer?.high?.model,
    ).toBe(STRONG);
  });

  it.each(["init", "setup", "apply"])(
    "%s rejects an unknown mode before doing anything",
    (command) => {
      const result = run(
        command,
        ...(command === "init"
          ? [target]
          : command === "apply"
            ? ["--target", target]
            : []),
        "--yes",
        "--harness",
        "codex",
        "--codex-fallback",
        "omit",
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("valid values: stop, degrade");
      expect(readdirSync(target)).toEqual([]);
      expect(existsSync(home)).toBe(false);
    },
  );

  it("setup stops by default and, with degrade, stores the intended routing without a resolution", () => {
    const lacking = jsonFile("lacking", lacksStrong);
    const setup = ["setup", "--yes", "--harness", "codex", "--tiers"];
    const stopped = run(...setup, "--codex-catalog", lacking);
    expect(stopped.status).toBe(2);
    expect(stopped.stderr).toContain(
      `  advisor/high: ${STRONG} (high) -> ${BALANCED} (high) [lower-class]`,
    );
    expect(existsSync(join(home, "manifest.json"))).toBe(false);

    const saved = run(
      ...setup,
      "--codex-catalog",
      lacking,
      "--codex-fallback",
      "degrade",
    );
    expect(saved.status, saved.stderr).toBe(0);
    expect(saved.stderr).toContain(
      `Warning: Codex fallback: advisor/high: ${STRONG} (high) -> ${BALANCED} (high) [lower-class]. The stored defaults keep the intended model ${STRONG}; an install substitutes ${BALANCED} only with a catalog and --codex-fallback degrade.`,
    );
    const stored = JSON.parse(
      readFileSync(join(home, "manifest.json"), "utf8"),
    );
    expect(stored.defaults.routing).toEqual(defaultCodexRouting());
    expect(JSON.stringify(stored)).not.toContain("routingResolution");

    const blocked = run(
      ...setup,
      "--codex-catalog",
      jsonFile("small-only", catalog(model(SMALL))),
      "--codex-fallback",
      "degrade",
    );
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("have no substitute");
  });

  it("setup with --codex-models names the condition, and an apply without the file chooses from the bundled lists", () => {
    const lists = jsonFile("lists", {
      balanced: [BALANCED, "gpt-bal-b"],
      strong: [STRONG, "gpt-strong-b"],
    });
    const offered = jsonFile(
      "offered",
      catalog(model(SMALL), model("gpt-bal-b"), model("gpt-strong-b")),
    );
    const saved = run(
      "setup",
      "--yes",
      "--harness",
      "codex",
      "--tiers",
      "--codex-models",
      lists,
      "--codex-catalog",
      offered,
      "--codex-fallback",
      "degrade",
    );
    expect(saved.status, saved.stderr).toBe(0);
    expect(saved.stderr).toContain(
      `Codex fallback: advisor/high: ${STRONG} (high) -> gpt-strong-b (high) [class-candidate]. The stored defaults keep the intended model ${STRONG}; an install substitutes gpt-strong-b only with a catalog, --codex-fallback degrade and the same --codex-models file.`,
    );

    // The same catalog without the file: the bundled lists have no substitute
    // for the strong leaves, and the apply prints its own table.
    const applied = run(
      "apply",
      "--target",
      target,
      "--yes",
      "--codex-catalog",
      offered,
      "--codex-fallback",
      "degrade",
    );
    expect(applied.status).toBe(1);
    expect(applied.stderr).toContain(
      "--codex-fallback degrade cannot proceed:",
    );
    expect(applied.stderr).toContain(
      `  advisor/high: ${STRONG} (high) -> no substitute:`,
    );
    expect(readdirSync(target)).toEqual([]);
  });

  it("apply degrades a target, doctor reports it clean, and apply --sync keeps the record", () => {
    expect(run("setup", "--yes", "--harness", "codex", "--tiers").status).toBe(
      0,
    );
    const lacking = jsonFile("lacking", lacksStrong);
    const stopped = run(
      "apply",
      "--target",
      target,
      "--yes",
      "--codex-catalog",
      lacking,
    );
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain("--codex-fallback degrade would apply");
    expect(readdirSync(target)).toEqual([]);

    const applied = run(
      "apply",
      "--target",
      target,
      "--yes",
      "--codex-catalog",
      lacking,
      "--codex-fallback",
      "degrade",
    );
    expect(applied.status, applied.stderr).toBe(0);
    expect(agent("advisor-xhigh")).toEqual({
      model: BALANCED,
      effort: "xhigh",
    });

    // The comparison with the operator defaults uses the intended routing,
    // and the ledger holds the hashes of the rendered files.
    const report = runDoctor(home, {});
    expect(report.targets[0]).toMatchObject({
      status: "clean",
      driftFiles: null,
      divergence: { profile: false, tiers: false, models: false },
    });
    expect(report.targets[0].divergence?.routing).toBeUndefined();
    const operator = readFileSync(join(home, "manifest.json"), "utf8");
    expect(operator).not.toContain("routingResolution");

    const before = snapshot();
    const synced = run("apply", "--target", target, "--yes", "--sync");
    expect(synced.status, synced.stderr).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(synced.stdout).toContain(
      "advisor/xhigh keeps the recorded substitute",
    );
  });
});

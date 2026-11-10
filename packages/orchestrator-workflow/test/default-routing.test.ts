import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "@iarna/toml";

import { OPERATOR_HOME_ENV } from "../src/operator-manifest.js";

import { resolveInitInputs } from "../src/cli-inputs.js";
import { MANIFEST_PATH, readInstalledManifest, runInit } from "../src/init.js";
import type { Harness } from "../src/detect.js";
import { DEFAULT_MODELS, ROLES } from "../src/models.js";
import type { Role, Tier } from "../src/models.js";
import type { HarnessRouting } from "../src/routing.js";
import {
  opencodeClassLeafModel,
  recordedOpencodeInheritance,
} from "../src/routing-state.js";

/**
 * The default routing of a fresh install, written out as plain data so the
 * expectation is independent of the code tables: per role and tier, the
 * Claude Code model alias and effort, and the Codex model id and effort.
 */
const CLAUDE_TABLE: Record<Role, Partial<Record<Tier, [string, string]>>> = {
  explorer: {
    low: ["haiku", "low"],
    medium: ["sonnet", "medium"],
    high: ["sonnet", "high"],
  },
  "task-slicer": {
    low: ["sonnet", "low"],
    medium: ["opus", "medium"],
    high: ["opus", "high"],
  },
  implementer: {
    low: ["sonnet", "low"],
    medium: ["sonnet", "medium"],
    high: ["sonnet", "high"],
    xhigh: ["fable", "high"],
  },
  reviewer: {
    medium: ["sonnet", "medium"],
    high: ["opus", "high"],
    xhigh: ["fable", "high"],
  },
  advisor: {
    high: ["fable", "high"],
    xhigh: ["fable", "xhigh"],
  },
};

const CODEX_TABLE: Record<Role, Partial<Record<Tier, [string, string]>>> = {
  explorer: {
    low: ["gpt-6-luna", "high"],
    medium: ["gpt-6.1-sol", "medium"],
    high: ["gpt-6.1-sol", "high"],
  },
  "task-slicer": {
    low: ["gpt-6.1-sol", "low"],
    medium: ["gpt-6.1-sol", "medium"],
    high: ["gpt-6.1-sol", "high"],
  },
  implementer: {
    low: ["gpt-6-luna", "high"],
    medium: ["gpt-6.1-sol", "medium"],
    high: ["gpt-6.1-sol", "high"],
    xhigh: ["gpt-6-astra", "high"],
  },
  reviewer: {
    medium: ["gpt-6.1-sol", "medium"],
    high: ["gpt-6-astra", "high"],
    xhigh: ["gpt-6-astra", "xhigh"],
  },
  advisor: {
    high: ["gpt-6-astra", "high"],
    xhigh: ["gpt-6-astra", "xhigh"],
  },
};

/** The routing a 0.50.0 install recorded, with its explicit old defaults. */
const OLD_MODELS: Record<Role, string> = {
  explorer: "sonnet",
  "task-slicer": "sonnet",
  implementer: "sonnet",
  reviewer: "opus",
  advisor: "opus",
};

const OLD_CLAUDE_TABLE: Record<
  Role,
  Partial<Record<Tier, [string, string]>>
> = {
  explorer: {
    low: ["haiku", "low"],
    medium: ["sonnet", "medium"],
    high: ["sonnet", "high"],
  },
  "task-slicer": {
    low: ["haiku", "low"],
    medium: ["sonnet", "medium"],
    high: ["sonnet", "high"],
  },
  implementer: {
    low: ["haiku", "low"],
    medium: ["sonnet", "medium"],
    high: ["sonnet", "high"],
    xhigh: ["opus", "xhigh"],
  },
  reviewer: {
    medium: ["sonnet", "medium"],
    high: ["opus", "high"],
    xhigh: ["opus", "xhigh"],
  },
  advisor: {
    high: ["opus", "high"],
    xhigh: ["opus", "xhigh"],
  },
};

const OLD_CODEX_TABLE: Record<Role, Partial<Record<Tier, [string, string]>>> = {
  explorer: {
    low: ["gpt-6-luna", "low"],
    medium: ["gpt-6.1-sol", "medium"],
    high: ["gpt-6.1-sol", "high"],
  },
  "task-slicer": {
    low: ["gpt-6.1-sol", "low"],
    medium: ["gpt-6.1-sol", "medium"],
    high: ["gpt-6.1-sol", "high"],
  },
  implementer: {
    low: ["gpt-6-luna", "low"],
    medium: ["gpt-6.1-sol", "medium"],
    high: ["gpt-6.1-sol", "high"],
    xhigh: ["gpt-6-astra", "xhigh"],
  },
  reviewer: {
    medium: ["gpt-6.1-sol", "medium"],
    high: ["gpt-6-astra", "high"],
    xhigh: ["gpt-6-astra", "xhigh"],
  },
  advisor: {
    high: ["gpt-6-astra", "high"],
    xhigh: ["gpt-6-astra", "xhigh"],
  },
};

function toRouting(
  claude: Record<Role, Partial<Record<Tier, [string, string]>>>,
  codex: Record<Role, Partial<Record<Tier, [string, string]>>>,
): HarnessRouting {
  const build = (
    table: Record<Role, Partial<Record<Tier, [string, string]>>>,
  ) =>
    Object.fromEntries(
      ROLES.map((role) => [
        role,
        Object.fromEntries(
          Object.entries(table[role]).map(([tier, [model, effort]]) => [
            tier,
            { model, effort },
          ]),
        ),
      ]),
    );
  return { claude: build(claude), codex: build(codex) } as HarnessRouting;
}

let target: string;

beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), "ow-default-routing-"));
});

afterEach(() => {
  rmSync(target, { recursive: true, force: true });
});

function claudeFrontmatter(file: string): { model: string; effort: string } {
  const text = readFileSync(join(target, ".claude/agents", file), "utf8");
  return {
    model: /^model: (.+)$/m.exec(text)?.[1] ?? "",
    effort: /^effort: (.+)$/m.exec(text)?.[1] ?? "",
  };
}

function codexFields(file: string): { model: string; effort: string } {
  const parsed = parse(
    readFileSync(join(target, ".codex/agents", file), "utf8"),
  );
  return {
    model: parsed.model as string,
    effort: parsed.model_reasoning_effort as string,
  };
}

function agentFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const directory of [".claude/agents", ".codex/agents"]) {
    if (!existsSync(join(target, directory))) continue;
    for (const name of readdirSync(join(target, directory)).sort())
      files.set(
        join(directory, name),
        readFileSync(join(target, directory, name), "utf8"),
      );
  }
  return files;
}

function fileName(role: Role, tier: Tier, defaultTier: boolean): string {
  return defaultTier ? role : `${role}-${tier}`;
}

const DEFAULT_TIERS: Record<Role, Tier> = {
  explorer: "medium",
  "task-slicer": "medium",
  implementer: "medium",
  reviewer: "high",
  advisor: "high",
};

describe("fresh install renders the per-role default routing", () => {
  it("renders exactly the target table for claude and codex with --tiers", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude", "codex"],
      models: { ...DEFAULT_MODELS },
      tiers: true,
    });
    for (const role of ROLES) {
      for (const [tier, [model, effort]] of Object.entries(
        CLAUDE_TABLE[role],
      )) {
        const name = fileName(role, tier as Tier, DEFAULT_TIERS[role] === tier);
        expect(claudeFrontmatter(`${name}.md`), `claude ${name}`).toEqual({
          model,
          effort,
        });
      }
      for (const [tier, [model, effort]] of Object.entries(CODEX_TABLE[role])) {
        const name = fileName(role, tier as Tier, DEFAULT_TIERS[role] === tier);
        expect(codexFields(`${name}.toml`), `codex ${name}`).toEqual({
          model,
          effort,
        });
      }
    }
  });

  it("renders the default tier of each role without --tiers", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude", "codex"],
      models: { ...DEFAULT_MODELS },
    });
    expect(readdirSync(join(target, ".claude/agents")).sort()).toEqual(
      ROLES.map((role) => `${role}.md`).sort(),
    );
    for (const role of ROLES) {
      const tier = DEFAULT_TIERS[role];
      const [model, effort] = CLAUDE_TABLE[role][tier]!;
      expect(claudeFrontmatter(`${role}.md`)).toEqual({ model, effort });
      const [codexModel, codexEffort] = CODEX_TABLE[role][tier]!;
      expect(codexFields(`${role}.toml`)).toEqual({
        model: codexModel,
        effort: codexEffort,
      });
    }
  });

  it("records the default models and the full routing in the manifest", () => {
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
    });
    const manifest = readInstalledManifest(target)!;
    expect(manifest.models).toEqual({
      explorer: "sonnet",
      "task-slicer": "opus",
      implementer: "sonnet",
      reviewer: "opus",
      advisor: "fable",
    });
    expect(manifest.routing?.claude?.implementer?.xhigh).toEqual({
      model: "fable",
      effort: "high",
    });
  });
});

/** Recorded by a 0.50.0 install: explicit old values for every leaf. */
function writeOldManifest(
  tiers: boolean,
  harnesses: Harness[],
  withRouting: boolean,
): void {
  const manifest = {
    kit: "orchestrator-workflow",
    version: "0.50.0",
    harnesses,
    models: OLD_MODELS,
    profile: "full",
    tiers,
    ...(withRouting
      ? { routing: toRouting(OLD_CLAUDE_TABLE, OLD_CODEX_TABLE) }
      : {}),
    files: {},
    installedAt: "2026-11-04T00:00:00.000Z",
  };
  const path = join(target, MANIFEST_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** The same input path the CLI takes for a plain `init` re-run. */
async function reinstall(
  harnesses: Harness[],
  tiersFlag: boolean | undefined,
): Promise<void> {
  const previous = readInstalledManifest(target);
  const inputs = await resolveInitInputs({
    detected: harnesses,
    interactive: false,
    previous,
    previousIsRecordedManifest: true,
    opts: { tiers: tiersFlag },
  });
  runInit({
    targetDir: target,
    harnesses: inputs.harnesses,
    models: inputs.models,
    profile: inputs.profile,
    tiers: inputs.tiers,
    routing: inputs.routing,
    routingMode: "replace",
    opencodeModels: inputs.opencodeModels,
    opencodeClassModels: inputs.opencodeClassModels,
  });
}

describe("a re-install over a manifest recorded by the previous defaults changes no routing", () => {
  it.each([true, false])(
    "keeps the recorded routing and agent files byte-identical (tiers: %s, claude and codex)",
    async (tiers) => {
      writeOldManifest(tiers, ["claude", "codex"], true);
      // The first run materializes the files of the recorded install.
      await reinstall(["claude", "codex"], undefined);
      const first = readInstalledManifest(target)!;
      expect(first.routing).toEqual(
        toRouting(OLD_CLAUDE_TABLE, OLD_CODEX_TABLE),
      );
      expect(first.models).toEqual(OLD_MODELS);
      const filesBefore = agentFiles();
      const manifestBefore = readFileSync(join(target, MANIFEST_PATH), "utf8");

      await reinstall(["claude", "codex"], undefined);
      expect(agentFiles()).toEqual(filesBefore);
      expect(readInstalledManifest(target)?.routing).toEqual(first.routing);
      expect(readFileSync(join(target, MANIFEST_PATH), "utf8")).toBe(
        manifestBefore,
      );

      // The recorded old leaves are rendered, not the new defaults.
      expect(claudeFrontmatter("task-slicer.md")).toEqual({
        model: "sonnet",
        effort: "medium",
      });
      expect(claudeFrontmatter("advisor.md")).toEqual({
        model: "opus",
        effort: "high",
      });
      expect(codexFields("implementer.toml")).toEqual({
        model: "gpt-6.1-sol",
        effort: "medium",
      });
      if (tiers) {
        expect(claudeFrontmatter("implementer-xhigh.md")).toEqual({
          model: "opus",
          effort: "xhigh",
        });
        expect(codexFields("implementer-xhigh.toml")).toEqual({
          model: "gpt-6-astra",
          effort: "xhigh",
        });
        expect(codexFields("explorer-low.toml")).toEqual({
          model: "gpt-6-luna",
          effort: "low",
        });
      }
    },
  );

  it("keeps the recorded old leaves when --tiers is turned on by the re-install", async () => {
    writeOldManifest(false, ["claude", "codex"], true);
    await reinstall(["claude", "codex"], true);
    expect(claudeFrontmatter("implementer-xhigh.md")).toEqual({
      model: "opus",
      effort: "xhigh",
    });
    expect(claudeFrontmatter("task-slicer-high.md")).toEqual({
      model: "sonnet",
      effort: "high",
    });
    expect(codexFields("implementer-xhigh.toml")).toEqual({
      model: "gpt-6-astra",
      effort: "xhigh",
    });
    expect(readInstalledManifest(target)?.routing).toEqual(
      toRouting(OLD_CLAUDE_TABLE, OLD_CODEX_TABLE),
    );
  });

  it("keeps a recorded leaf in patch mode (plain runInit without resolved routing)", () => {
    writeOldManifest(true, ["claude", "codex"], true);
    // `models` is the recorded value, as the CLI passes it; a caller that
    // passes different models is asking to change those default tiers.
    runInit({
      targetDir: target,
      harnesses: ["claude", "codex"],
      models: { ...OLD_MODELS },
      tiers: true,
    });
    expect(readInstalledManifest(target)?.routing).toEqual(
      toRouting(OLD_CLAUDE_TABLE, OLD_CODEX_TABLE),
    );
    expect(claudeFrontmatter("advisor.md")).toEqual({
      model: "opus",
      effort: "high",
    });
  });

  it("an explicit --routing leaf is the only way a recorded leaf changes", async () => {
    writeOldManifest(true, ["claude"], true);
    const previous = readInstalledManifest(target);
    const inputs = await resolveInitInputs({
      detected: ["claude"],
      interactive: false,
      previous,
      previousIsRecordedManifest: true,
      opts: {
        routing: {
          claude: {
            "task-slicer": { medium: { model: "opus", effort: "medium" } },
          },
        },
      },
    });
    runInit({
      targetDir: target,
      harnesses: inputs.harnesses,
      models: inputs.models,
      profile: inputs.profile,
      tiers: inputs.tiers,
      routing: inputs.routing,
      routingMode: "replace",
    });
    expect(claudeFrontmatter("task-slicer.md")).toEqual({
      model: "opus",
      effort: "medium",
    });
    expect(claudeFrontmatter("task-slicer-high.md")).toEqual({
      model: "sonnet",
      effort: "high",
    });
  });
});

describe("a manifest recorded before routing existed (only `models`)", () => {
  it.each([true, false])(
    "keeps the tier-uniform routing it was installed under on re-install (tiers: %s)",
    async (tiers) => {
      writeOldManifest(tiers, ["claude"], false);
      const read = readInstalledManifest(target)!;
      // The materialized record is the old tier-uniform derivation.
      expect(read.routing?.claude?.["task-slicer"]).toEqual({
        low: { model: "haiku", effort: "low" },
        medium: { model: "sonnet", effort: "medium" },
        high: { model: "sonnet", effort: "high" },
      });
      expect(read.routing?.codex).toBeUndefined();

      await reinstall(["claude"], undefined);
      const manifest = readInstalledManifest(target)!;
      expect(manifest.routing?.claude).toEqual(
        toRouting(OLD_CLAUDE_TABLE, OLD_CODEX_TABLE).claude,
      );
      expect(claudeFrontmatter("task-slicer.md")).toEqual({
        model: "sonnet",
        effort: "medium",
      });
      expect(claudeFrontmatter("advisor.md")).toEqual({
        model: "opus",
        effort: "high",
      });
      if (tiers) {
        expect(claudeFrontmatter("implementer-low.md")).toEqual({
          model: "haiku",
          effort: "low",
        });
        expect(claudeFrontmatter("implementer-xhigh.md")).toEqual({
          model: "opus",
          effort: "xhigh",
        });
        expect(claudeFrontmatter("advisor-xhigh.md")).toEqual({
          model: "opus",
          effort: "xhigh",
        });
      }
    },
  );

  it("a pre-routing manifest records no Codex leaves, so Codex added by the re-install takes the current defaults", async () => {
    writeOldManifest(true, ["claude"], false);
    const previous = readInstalledManifest(target);
    const inputs = await resolveInitInputs({
      detected: ["claude", "codex"],
      interactive: false,
      previous,
      previousIsRecordedManifest: true,
      opts: { harness: "claude,codex" },
    });
    runInit({
      targetDir: target,
      harnesses: inputs.harnesses,
      models: inputs.models,
      profile: inputs.profile,
      tiers: inputs.tiers,
      routing: inputs.routing,
      routingMode: "replace",
    });
    expect(codexFields("explorer-low.toml")).toEqual({
      model: "gpt-6-luna",
      effort: "high",
    });
    expect(claudeFrontmatter("implementer-xhigh.md")).toEqual({
      model: "opus",
      effort: "xhigh",
    });
  });
});

describe("--models keeps its meaning: it sets the default tier of that role only", () => {
  it("changes the default-tier leaf and leaves the other tiers of the role on their class model", async () => {
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS, "task-slicer": "sonnet" },
      tiers: true,
    });
    expect(claudeFrontmatter("task-slicer.md")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
    expect(claudeFrontmatter("task-slicer-high.md")).toEqual({
      model: "opus",
      effort: "high",
    });
    expect(claudeFrontmatter("task-slicer-low.md")).toEqual({
      model: "sonnet",
      effort: "low",
    });
  });

  it("a recorded legacy models value wins over the table default for that install", async () => {
    writeOldManifest(false, ["claude"], false);
    await reinstall(["claude"], undefined);
    expect(readInstalledManifest(target)?.models["task-slicer"]).toBe("sonnet");
    expect(readInstalledManifest(target)?.models.advisor).toBe("opus");
  });
});

// ---------------------------------------------------------------------------
// One install can carry two tier tables: a recorded leaf is kept, a leaf that
// was never recorded takes the current default.
// ---------------------------------------------------------------------------

describe("recorded leaves are kept, leaves that were never recorded take the current default", () => {
  let binDir: string;
  let originalPath: string | undefined;

  function stubCatalog(lines: string[]): void {
    const script = `#!/bin/sh\nprintf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")}\n`;
    writeFileSync(join(binDir, "opencode"), script, { mode: 0o755 });
  }

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "ow-stub-opencode-"));
    originalPath = process.env.PATH;
    process.env.PATH = binDir;
    stubCatalog([
      "github-copilot/claude-haiku-4.5",
      "github-copilot/claude-sonnet-4.6",
      "github-copilot/claude-opus-4.8",
      "github-copilot/claude-fable-5",
    ]);
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  function opencodeFrontmatter(file: string): string {
    return readFileSync(join(target, ".opencode/agents", file), "utf8");
  }

  /** A 0.50.0 record with opencode: default-tier ids only, no class map. */
  function writeOldOpencodeManifest(
    harnesses: Harness[],
    tiers: boolean,
  ): void {
    const old = toRouting(OLD_CLAUDE_TABLE, OLD_CODEX_TABLE);
    const opencodeIds: Record<Role, string> = {
      explorer: "github-copilot/claude-sonnet-4.5",
      "task-slicer": "github-copilot/claude-sonnet-4.5",
      implementer: "github-copilot/claude-sonnet-4.5",
      reviewer: "github-copilot/claude-opus-4.6",
      advisor: "github-copilot/claude-opus-4.6",
    };
    const routing: HarnessRouting = {
      ...old,
      ...(harnesses.includes("opencode")
        ? {
            opencode: Object.fromEntries(
              ROLES.map((role) => [
                role,
                {
                  [DEFAULT_TIERS[role]]: {
                    model: opencodeIds[role],
                    effort: DEFAULT_TIERS[role],
                  },
                },
              ]),
            ),
          }
        : {}),
    } as HarnessRouting;
    const manifest = {
      kit: "orchestrator-workflow",
      version: "0.50.0",
      harnesses,
      models: OLD_MODELS,
      profile: "full",
      tiers,
      ...(harnesses.includes("opencode")
        ? { opencodeModels: opencodeIds }
        : {}),
      routing,
      files: {},
      installedAt: "2026-11-04T00:00:00.000Z",
    };
    const path = join(target, MANIFEST_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async function reinstallWith(
    detected: Harness[],
    opts: Record<string, unknown>,
  ): Promise<void> {
    const previous = readInstalledManifest(target);
    const inputs = await resolveInitInputs({
      detected,
      interactive: false,
      previous,
      previousIsRecordedManifest: true,
      opts,
    });
    runInit({
      targetDir: target,
      harnesses: inputs.harnesses,
      models: inputs.models,
      profile: inputs.profile,
      tiers: inputs.tiers,
      routing: inputs.routing,
      routingMode: "replace",
      opencodeModels: inputs.opencodeModels,
      opencodeClassModels: inputs.opencodeClassModels,
    });
  }

  it("turning --tiers on for a claude and opencode install: Claude variants stay old, opencode variants take the current table", async () => {
    writeOldOpencodeManifest(["claude", "opencode"], false);
    await reinstallWith(["claude", "opencode"], { tiers: true });

    // Claude variant leaves were recorded by the 0.50.0 install.
    expect(claudeFrontmatter("implementer-xhigh.md")).toEqual({
      model: "opus",
      effort: "xhigh",
    });
    expect(claudeFrontmatter("task-slicer-high.md")).toEqual({
      model: "sonnet",
      effort: "high",
    });
    // The opencode variant leaves were never recorded: current table.
    const manifest = readInstalledManifest(target)!;
    expect(manifest.routing?.opencode?.implementer?.xhigh).toEqual({
      model: "github-copilot/claude-fable-5",
      effort: "high",
    });
    expect(manifest.routing?.opencode?.["task-slicer"]?.high).toEqual({
      model: "github-copilot/claude-opus-4.8",
      effort: "high",
    });
    expect(opencodeFrontmatter("implementer-xhigh.md")).toContain(
      "model: github-copilot/claude-fable-5",
    );
    // The recorded opencode default-tier ids stay.
    expect(manifest.routing?.opencode?.reviewer?.high?.model).toBe(
      "github-copilot/claude-opus-4.6",
    );
  });

  it("opencode added to a claude install: its variants take the current table, Claude and Codex leaves stay recorded", async () => {
    writeOldOpencodeManifest(["claude"], true);
    await reinstallWith(["claude", "opencode"], { harness: "claude,opencode" });

    expect(claudeFrontmatter("implementer-xhigh.md")).toEqual({
      model: "opus",
      effort: "xhigh",
    });
    const manifest = readInstalledManifest(target)!;
    expect(manifest.routing?.opencode?.implementer?.xhigh).toEqual({
      model: "github-copilot/claude-fable-5",
      effort: "high",
    });
    expect(manifest.routing?.opencode?.advisor?.xhigh).toEqual({
      model: "github-copilot/claude-fable-5",
      effort: "xhigh",
    });
    // The legacy models value is recorded and wins for the default tier.
    expect(manifest.routing?.opencode?.advisor?.high?.model).toBe(
      "github-copilot/claude-opus-4.8",
    );
    expect(manifest.routing?.codex).toEqual(
      toRouting(OLD_CLAUDE_TABLE, OLD_CODEX_TABLE).codex,
    );
  });

  it("Codex added to an install recorded by a routing-aware version keeps the recorded Codex defaults", async () => {
    writeOldManifest(true, ["claude"], true);
    await reinstallWith(["claude", "codex"], { harness: "claude,codex" });
    expect(codexFields("task-slicer.toml")).toEqual({
      model: "gpt-6.1-sol",
      effort: "medium",
    });
    expect(codexFields("implementer-low.toml")).toEqual({
      model: "gpt-6-luna",
      effort: "low",
    });
  });

  it("a partial recorded routing map keeps what it records and takes the current default for the rest", async () => {
    const manifest = {
      kit: "orchestrator-workflow",
      version: "0.50.0",
      harnesses: ["claude"],
      models: OLD_MODELS,
      profile: "full",
      tiers: true,
      routing: {
        claude: {
          "task-slicer": { medium: { model: "sonnet", effort: "medium" } },
        },
      },
      files: {},
      installedAt: "2026-11-04T00:00:00.000Z",
    };
    const path = join(target, MANIFEST_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    await reinstallWith(["claude"], {});

    // Recorded: kept.
    expect(claudeFrontmatter("task-slicer.md")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
    // Never recorded: the current table.
    expect(claudeFrontmatter("task-slicer-high.md")).toEqual({
      model: "opus",
      effort: "high",
    });
    expect(claudeFrontmatter("implementer-xhigh.md")).toEqual({
      model: "fable",
      effort: "high",
    });
    expect(claudeFrontmatter("advisor-xhigh.md")).toEqual({
      model: "fable",
      effort: "xhigh",
    });
  });
});

describe("opencode role class floor in the rendered files", () => {
  const haiku = "github-copilot/claude-haiku-4.5";

  it("a reviewer or advisor variant whose class model is the small class model is not rendered; other roles are", () => {
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
      tiers: true,
      opencodeModels: {
        explorer: undefined,
        "task-slicer": undefined,
        implementer: undefined,
        reviewer: undefined,
        advisor: undefined,
      },
      opencodeClassModels: {
        small: haiku,
        medium: haiku,
        large: haiku,
        xlarge: haiku,
      },
    });
    const files = readdirSync(join(target, ".opencode/agents"));
    expect(files).toContain("implementer-xhigh.md");
    expect(files).toContain("task-slicer-high.md");
    expect(files).not.toContain("reviewer-medium.md");
    expect(files).not.toContain("reviewer-xhigh.md");
    expect(files).not.toContain("advisor-xhigh.md");
  });

  it("a below-floor class model is a recorded inheritance for the reviewer and advisor leaves only", () => {
    const maps = {
      opencodeClassModels: {
        small: haiku,
        medium: haiku,
        large: haiku,
        xlarge: haiku,
      },
    };
    expect(
      opencodeClassLeafModel("reviewer", "xlarge", maps.opencodeClassModels),
    ).toBeUndefined();
    expect(
      opencodeClassLeafModel("implementer", "xlarge", maps.opencodeClassModels),
    ).toBe(haiku);
    expect(recordedOpencodeInheritance(maps, "reviewer", "medium")).toBe(true);
    expect(recordedOpencodeInheritance(maps, "advisor", "xhigh")).toBe(true);
    expect(recordedOpencodeInheritance(maps, "implementer", "low")).toBe(false);
    expect(recordedOpencodeInheritance(maps, "implementer", "xhigh")).toBe(
      false,
    );
  });

  it("a reviewer variant on a genuine medium class model is rendered", () => {
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      models: { ...DEFAULT_MODELS },
      tiers: true,
      opencodeModels: {},
      opencodeClassModels: {
        small: haiku,
        medium: "github-copilot/claude-sonnet-4.6",
        large: "github-copilot/claude-sonnet-4.6",
        xlarge: "github-copilot/claude-sonnet-4.6",
      },
    });
    const files = readdirSync(join(target, ".opencode/agents"));
    expect(files).toContain("reviewer-medium.md");
    expect(files).toContain("reviewer-xhigh.md");
    expect(files).toContain("advisor-xhigh.md");
  });
});

// ---------------------------------------------------------------------------
// A pre-routing operator manifest is materialized like a pre-routing repo one.
// ---------------------------------------------------------------------------

describe("a routing-less operator manifest is materialized with the table it was written under", () => {
  const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ow-operator-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeRoutinglessOperator(tiers: boolean): void {
    writeFileSync(
      join(home, "manifest.json"),
      `${JSON.stringify(
        {
          kit: "orchestrator-workflow",
          schemaVersion: 1,
          defaults: {
            harnesses: ["claude"],
            profile: "full",
            tiers,
            models: OLD_MODELS,
          },
          targets: [],
          createdAt: "2026-11-04T00:00:00.000Z",
          updatedAt: "2026-11-04T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
  }

  function runCli(...args: string[]) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      {
        cwd: PACKAGE_DIR,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, [OPERATOR_HOME_ENV]: home },
      },
    );
  }

  it("apply --sync against it leaves the tier files of a 0.50.0 target unchanged", () => {
    writeOldManifest(true, ["claude"], true);
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...OLD_MODELS },
      tiers: true,
      routing: toRouting(OLD_CLAUDE_TABLE, OLD_CODEX_TABLE),
      routingMode: "replace",
    });
    writeRoutinglessOperator(true);
    const filesBefore = agentFiles();
    const claudeRoutingBefore = readInstalledManifest(target)!.routing?.claude;

    const result = runCli("apply", "--target", target, "--sync", "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(agentFiles()).toEqual(filesBefore);
    expect(readInstalledManifest(target)!.routing?.claude).toEqual(
      claudeRoutingBefore,
    );
    expect(claudeFrontmatter("implementer-xhigh.md")).toEqual({
      model: "opus",
      effort: "xhigh",
    });
  });
});

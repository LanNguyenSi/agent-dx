import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "@iarna/toml";

import { resolveInitInputs } from "../src/cli-inputs.js";
import { MANIFEST_PATH, readInstalledManifest, runInit } from "../src/init.js";
import type { Harness } from "../src/detect.js";
import { DEFAULT_MODELS, ROLES } from "../src/models.js";
import type { Role, Tier } from "../src/models.js";
import type { HarnessRouting } from "../src/routing.js";

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

  it("gives a harness added by the re-install the new defaults, since it never had routing", async () => {
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

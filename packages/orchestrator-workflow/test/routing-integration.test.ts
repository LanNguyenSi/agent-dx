import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "@iarna/toml";
import { afterEach, describe, expect, it } from "vitest";

import { MANIFEST_PATH, readInstalledManifest, runInit } from "../src/init.js";
import { runUninstall } from "../src/uninstall.js";
import type { InitOptions } from "../src/init.js";
import { DEFAULT_MODELS, ROLES } from "../src/models.js";
import {
  defaultCodexRouting,
  mergeRouting,
  parseRouting,
} from "../src/routing.js";

const targets: string[] = [];

function target(): string {
  const directory = mkdtempSync(join(tmpdir(), "ow-routing-integration-"));
  targets.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of targets.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("routing installer integration", () => {
  it("installs native Codex defaults and tiers through the manifest ledger", () => {
    const directory = target();
    runInit({
      targetDir: directory,
      harnesses: ["codex"],
      models: { ...DEFAULT_MODELS },
      profile: "minimal",
      tiers: true,
    });

    const defaultAgent = parse(
      readFileSync(
        join(directory, ".codex", "agents", "implementer.toml"),
        "utf8",
      ),
    );
    const tierAgent = parse(
      readFileSync(
        join(directory, ".codex", "agents", "implementer-xhigh.toml"),
        "utf8",
      ),
    );
    expect(defaultAgent).toMatchObject({
      name: "implementer",
      model: "gpt-5.6-terra",
      model_reasoning_effort: "medium",
    });
    expect(tierAgent).toMatchObject({
      name: "implementer-xhigh",
      model: "gpt-6-astra",
      model_reasoning_effort: "xhigh",
    });

    const manifest = JSON.parse(
      readFileSync(join(directory, ".ai", "workflow", "manifest.json"), "utf8"),
    );
    expect(manifest.routing.codex.implementer.medium).toEqual({
      model: "gpt-5.6-terra",
      effort: "medium",
    });
    expect(manifest.files[".codex/agents/implementer.toml"]).toBeTruthy();
    expect(manifest.files[".codex/agents/implementer-xhigh.toml"]).toBeTruthy();
  });

  it("uses independent harness selections and keeps an explicit opencode id offline", () => {
    const directory = target();
    const routing = mergeRouting(
      defaultCodexRouting(),
      parseRouting({
        claude: {
          implementer: {
            medium: { model: "opus", effort: "high" },
          },
        },
        opencode: {
          implementer: {
            medium: { model: "ollama/llama3:8b", effort: "high" },
          },
        },
        codex: {
          implementer: {
            medium: { model: "gpt-future", effort: "high" },
          },
        },
      }),
    );
    runInit({
      targetDir: directory,
      harnesses: ["claude", "opencode", "codex"],
      models: { ...DEFAULT_MODELS },
      profile: "minimal",
      routing,
    });

    expect(
      readFileSync(
        join(directory, ".claude", "agents", "implementer.md"),
        "utf8",
      ),
    ).toContain("model: opus");
    const opencodeAgent = readFileSync(
      join(directory, ".opencode", "agents", "implementer.md"),
      "utf8",
    );
    const encodedModel = opencodeAgent
      .split("\n")
      .find((line) => line.startsWith("model: "))
      ?.slice("model: ".length);
    // YAML double-quoted scalars use the JSON string grammar for this input,
    // so parsing the emitted scalar proves a colon-bearing provider id round
    // trips rather than becoming YAML mapping syntax.
    expect(JSON.parse(encodedModel ?? "")).toBe("ollama/llama3:8b");
    expect(opencodeAgent).not.toContain("reasoningEffort:");
    expect(
      parse(
        readFileSync(
          join(directory, ".codex", "agents", "implementer.toml"),
          "utf8",
        ),
      ),
    ).toMatchObject({ model: "gpt-future", model_reasoning_effort: "high" });
  });

  it("rejects an unavailable selected Codex model before writing files", () => {
    const directory = target();
    expect(() =>
      runInit({
        targetDir: directory,
        harnesses: ["codex"],
        models: { ...DEFAULT_MODELS },
        profile: "minimal",
        routing: parseRouting({
          codex: {
            implementer: {
              medium: { model: "gpt-missing", effort: "medium" },
            },
          },
        }),
        codexCatalog: { models: [] },
      }),
    ).toThrow(/unavailable/);
    expect(
      existsSync(join(directory, ".ai", "workflow", "manifest.json")),
    ).toBe(false);
    expect(existsSync(join(directory, ".codex", "agents"))).toBe(false);
  });
});

describe("routing persistence and validation", () => {
  const selection = (model: string) => ({ model, effort: "high" as const });
  const base = (directory: string): InitOptions => ({
    targetDir: directory,
    harnesses: ["codex"],
    models: { ...DEFAULT_MODELS },
    profile: "minimal",
  });

  it("keeps prior leaves across consecutive sparse API patches and replaces them only explicitly", () => {
    const directory = target();
    runInit({
      ...base(directory),
      routing: {
        codex: { implementer: { medium: selection("gpt-custom-impl") } },
      },
    });
    runInit({
      ...base(directory),
      routing: {
        codex: { reviewer: { high: selection("gpt-custom-review") } },
      },
    });
    expect(
      readInstalledManifest(directory)?.routing?.codex?.implementer?.medium
        ?.model,
    ).toBe("gpt-custom-impl");
    expect(
      parse(
        readFileSync(join(directory, ".codex/agents/implementer.toml"), "utf8"),
      ).model,
    ).toBe("gpt-custom-impl");
    const before = readFileSync(join(directory, MANIFEST_PATH), "utf8");
    runInit(base(directory));
    expect(readFileSync(join(directory, MANIFEST_PATH), "utf8")).toBe(before);
    runInit({
      ...base(directory),
      routingMode: "replace",
      routing: { codex: { reviewer: { high: selection("gpt-operator") } } },
    });
    expect(
      readInstalledManifest(directory)?.routing?.codex?.implementer?.medium
        ?.model,
    ).toBe("gpt-5.6-terra");
    expect(
      readInstalledManifest(directory)?.routing?.codex?.reviewer?.high?.model,
    ).toBe("gpt-operator");
  });

  it("materializes resolved API opencode ids and keeps default and variant bytes on an offline reinstall", () => {
    const directory = target();
    const options: InitOptions = {
      ...base(directory),
      harnesses: ["opencode"],
      tiers: true,
    };
    const opencodeModels = Object.fromEntries(
      ROLES.map((role) => [role, "provider/claude-sonnet-pinned"]),
    ) as Record<(typeof ROLES)[number], string>;
    const opencodeClassModels = {
      small: "provider/claude-haiku-pinned",
      medium: "provider/claude-sonnet-pinned",
      large: "provider/claude-opus-pinned",
    };
    runInit({ ...options, opencodeModels, opencodeClassModels });
    const manifest = readFileSync(join(directory, MANIFEST_PATH), "utf8");
    const defaultFile = readFileSync(
      join(directory, ".opencode/agents/implementer.md"),
      "utf8",
    );
    const variantFile = readFileSync(
      join(directory, ".opencode/agents/implementer-xhigh.md"),
      "utf8",
    );
    runInit(options);
    expect(readFileSync(join(directory, MANIFEST_PATH), "utf8")).toBe(manifest);
    expect(
      readFileSync(join(directory, ".opencode/agents/implementer.md"), "utf8"),
    ).toBe(defaultFile);
    expect(
      readFileSync(
        join(directory, ".opencode/agents/implementer-xhigh.md"),
        "utf8",
      ),
    ).toBe(variantFile);
    expect(
      readInstalledManifest(directory)?.routing?.opencode?.implementer?.xhigh
        ?.model,
    ).toBe(opencodeClassModels.large);
    runInit({
      ...options,
      models: { ...DEFAULT_MODELS, implementer: "provider/new-model" },
    });
    expect(
      readInstalledManifest(directory)?.routing?.opencode?.implementer?.medium
        ?.model,
    ).toBe("provider/new-model");
    expect(
      readInstalledManifest(directory)?.routing?.opencode?.implementer?.xhigh
        ?.model,
    ).toBe(opencodeClassModels.large);
  });

  it("honors explicit API resolved-id updates and routing patches over legacy model changes", () => {
    const directory = target();
    const options: InitOptions = {
      ...base(directory),
      harnesses: ["claude", "opencode"],
    };
    runInit({
      ...options,
      routing: {
        opencode: { implementer: { medium: selection("provider/old") } },
      },
    });
    const opencodeModels = Object.fromEntries(
      ROLES.map((role) => [role, "provider/new"]),
    ) as Record<(typeof ROLES)[number], string>;
    runInit({ ...options, opencodeModels });
    expect(
      readInstalledManifest(directory)?.routing?.opencode?.implementer?.medium
        ?.model,
    ).toBe("provider/new");
    runInit({
      ...options,
      models: { ...DEFAULT_MODELS, implementer: "haiku" },
      routing: { claude: { implementer: { medium: selection("opus") } } },
    });
    expect(
      readInstalledManifest(directory)?.routing?.claude?.implementer?.medium
        ?.model,
    ).toBe("opus");
    expect(
      readInstalledManifest(directory)?.routing?.opencode?.implementer?.medium,
    ).toBeUndefined();
  });

  it.each([
    { routing: { codxe: {} } },
    {
      routing: {
        codex: {
          implementer: { medium: { model: "gpt-valid", effort: "bogus" } },
        },
      },
    },
    { routingMode: "merge" },
    { routingMode: null },
  ])("rejects untyped invalid routing before writing: %j", (invalid) => {
    const directory = target();
    expect(() =>
      runInit({ ...base(directory), ...invalid } as InitOptions),
    ).toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("validates only active Codex leaves and emits one absence notice", () => {
    const directory = target();
    const catalog = {
      models: [
        {
          slug: "gpt-5.6-terra",
          supported_reasoning_levels: [{ effort: "medium" }],
        },
        {
          slug: "gpt-6-astra",
          supported_reasoning_levels: [{ effort: "high" }],
        },
      ],
    };
    expect(
      runInit({ ...base(directory), codexCatalog: catalog }).notes,
    ).toEqual([]);
    expect(
      runInit(base(directory)).notes.filter((note) =>
        note.includes("no capability catalog supplied"),
      ),
    ).toHaveLength(1);
    expect(
      runInit({
        ...base(target()),
        harnesses: ["claude"],
        codexCatalog: { malformed: true },
      }).notes,
    ).toEqual([]);
  });
});

describe("legacy opencode API lifecycle", () => {
  it("keeps bare class IDs readable and unchanged across omitted-input reinstall and uninstall", () => {
    const directory = target();
    const options: InitOptions = {
      targetDir: directory,
      harnesses: ["opencode"],
      profile: "minimal",
      tiers: true,
      models: { ...DEFAULT_MODELS },
    };
    const opencodeClassModels = {
      small: "local-model",
      medium: "local-model",
      large: "local-model",
    };
    runInit({ ...options, opencodeClassModels });
    const installed = readInstalledManifest(directory);
    expect(installed?.opencodeClassModels).toEqual(opencodeClassModels);
    expect(installed?.routing?.opencode?.implementer?.xhigh).toBeUndefined();
    expect(() => parseRouting(installed?.routing)).not.toThrow();
    const before = readFileSync(join(directory, MANIFEST_PATH), "utf8");
    runInit(options);
    expect(readFileSync(join(directory, MANIFEST_PATH), "utf8")).toBe(before);
    expect(
      readFileSync(
        join(directory, ".opencode/agents/implementer-xhigh.md"),
        "utf8",
      ),
    ).toContain("model: local-model");
    expect(runUninstall({ targetDir: directory }).kept).toEqual([]);
    expect(existsSync(join(directory, MANIFEST_PATH))).toBe(false);
  });

  it("keeps explicit qualified routing above legacy compatibility fallbacks", () => {
    const directory = target();
    const options: InitOptions = {
      targetDir: directory,
      harnesses: ["opencode"],
      profile: "minimal",
      tiers: true,
      models: { ...DEFAULT_MODELS },
    };
    runInit({
      ...options,
      opencodeClassModels: { large: "local-model" },
      routing: {
        opencode: {
          implementer: { xhigh: { model: "provider/pinned", effort: "xhigh" } },
        },
      },
    });
    runInit(options);
    expect(
      readFileSync(
        join(directory, ".opencode/agents/implementer-xhigh.md"),
        "utf8",
      ),
    ).toContain("model: provider/pinned");
    expect(
      readFileSync(
        join(directory, ".opencode/agents/reviewer-xhigh.md"),
        "utf8",
      ),
    ).toContain("model: local-model");
    expect(() =>
      runInit({
        ...options,
        routing: {
          opencode: {
            implementer: { medium: { model: "local-model", effort: "medium" } },
          },
        },
      }),
    ).toThrow(/qualified/);
  });

  it.each([
    null,
    [],
    { unknown: "local-model" },
    { large: 7 },
    { large: "bad\nid" },
  ])(
    "rejects invalid legacy class map %j before writing",
    (opencodeClassModels) => {
      const directory = target();
      expect(() =>
        runInit({
          targetDir: directory,
          harnesses: ["opencode"],
          models: { ...DEFAULT_MODELS },
          opencodeClassModels,
        } as InitOptions),
      ).toThrow();
      expect(readdirSync(directory)).toEqual([]);
    },
  );
});

describe("recorded opencode inheritance", () => {
  it("preserves explicit unresolved role and class maps across omitted-input API reinstalls", () => {
    const directory = target();
    const options: InitOptions = {
      targetDir: directory,
      harnesses: ["opencode"],
      profile: "minimal",
      tiers: true,
      models: {
        ...DEFAULT_MODELS,
        implementer: "provider/custom",
        reviewer: "provider/reviewer",
      },
    };
    runInit({
      ...options,
      opencodeModels: { implementer: undefined },
      opencodeClassModels: {},
    });
    expect(readInstalledManifest(directory)?.opencodeModels).toEqual({});
    expect(readInstalledManifest(directory)?.opencodeClassModels).toEqual({});
    const before = readFileSync(join(directory, MANIFEST_PATH), "utf8");
    const inherited = readFileSync(
      join(directory, ".opencode/agents/implementer.md"),
      "utf8",
    );
    expect(inherited).not.toMatch(/^model:/m);
    runInit(options);
    expect(readFileSync(join(directory, MANIFEST_PATH), "utf8")).toBe(before);
    expect(
      readFileSync(join(directory, ".opencode/agents/implementer.md"), "utf8"),
    ).toBe(inherited);
    expect(
      existsSync(join(directory, ".opencode/agents/implementer-xhigh.md")),
    ).toBe(false);
    const updated = {
      ...options,
      models: { ...options.models, implementer: "provider/intentional-update" },
    };
    runInit(updated);
    expect(
      readFileSync(join(directory, ".opencode/agents/implementer.md"), "utf8"),
    ).toContain("model: provider/intentional-update");
    expect(
      readFileSync(join(directory, ".opencode/agents/reviewer.md"), "utf8"),
    ).not.toMatch(/^model:/m);
    runInit({
      ...updated,
      routing: {
        opencode: {
          reviewer: { high: { model: "provider/explicit", effort: "high" } },
        },
      },
    });
    runInit(updated);
    expect(
      readFileSync(join(directory, ".opencode/agents/reviewer.md"), "utf8"),
    ).toContain("model: provider/explicit");
  });

  it("keeps inheritance markers for omitted roles outside the currently installed profile", () => {
    const directory = target();
    const options: InitOptions = {
      targetDir: directory,
      harnesses: ["opencode"],
      profile: "minimal",
      models: { ...DEFAULT_MODELS, explorer: "provider/custom" },
    };
    runInit({
      ...options,
      opencodeModels: {
        implementer: "provider/impl",
        reviewer: "provider/review",
      },
    });
    expect(readInstalledManifest(directory)?.opencodeModels).toEqual({});
    runInit({ ...options, profile: "full" });
    expect(
      readFileSync(join(directory, ".opencode/agents/explorer.md"), "utf8"),
    ).not.toMatch(/^model:/m);
  });
});

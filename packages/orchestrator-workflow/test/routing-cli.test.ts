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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "@iarna/toml";

import { MANIFEST_PATH, readInstalledManifest, runInit } from "../src/init.js";
import { DEFAULT_MODELS, ROLES } from "../src/models.js";
import {
  OPERATOR_HOME_ENV,
  createOperatorManifest,
  updateOperatorManifest,
} from "../src/operator-manifest.js";
import { runDoctor } from "../src/doctor.js";
import { runUninstall } from "../src/uninstall.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
let directory: string;
let home: string;
let target: string;
let bin: string;
let catalogCalls: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ow-routing-cli-"));
  home = join(directory, "operator");
  target = join(directory, "target");
  bin = join(directory, "bin");
  catalogCalls = join(directory, "catalog-calls");
  for (const path of [target, bin]) mkdirSync(path);
  // Any unexpected lookup is observable; all fixtures already pin their ids.
  writeFileSync(
    join(bin, "opencode"),
    '#!/bin/sh\necho called >> "$OW_TEST_CATALOG_CALLS"\nexit 1\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "codex"),
    '#!/bin/sh\necho called >> "$OW_TEST_CATALOG_CALLS"\nexit 1\n',
    { mode: 0o755 },
  );
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run(...args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      ...args,
      ...(["init", "setup", "apply"].includes(args[0]) ? ["--yes"] : []),
    ],
    {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        [OPERATOR_HOME_ENV]: home,
        OW_TEST_CATALOG_CALLS: catalogCalls,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    },
  );
}

function ok(...args: string[]) {
  const result = run(...args);
  expect(result.status, result.stderr).toBe(0);
  return result;
}

function jsonFile(name: string, data: unknown): string {
  const path = join(directory, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(data)}\n`);
  return path;
}

const leaf = (model: string) => ({ model, effort: "high" as const });
const minimalCatalog = {
  models: [
    {
      slug: "gpt-5.6-terra",
      supported_reasoning_levels: [{ effort: "medium" }],
    },
    { slug: "gpt-6-astra", supported_reasoning_levels: [{ effort: "high" }] },
  ],
};

describe("routing command flags", () => {
  it("init applies sparse patches, keeps previous selections, and never queries model CLIs", () => {
    const implementer = jsonFile("impl", {
      codex: { implementer: { medium: leaf("gpt-pinned-impl") } },
    });
    const reviewer = jsonFile("review", {
      codex: { reviewer: { high: leaf("gpt-pinned-review") } },
    });
    const first = ok(
      "init",
      target,
      "--harness",
      "codex",
      "--profile",
      "minimal",
      "--routing",
      implementer,
    );
    expect(
      (first.stdout + first.stderr).match(/no capability catalog supplied/g),
    ).toHaveLength(1);
    ok("init", target, "--routing", reviewer);
    const before = readFileSync(join(target, MANIFEST_PATH), "utf8");
    ok("init", target);
    expect(readFileSync(join(target, MANIFEST_PATH), "utf8")).toBe(before);
    expect(
      readInstalledManifest(target)?.routing?.codex?.implementer?.medium?.model,
    ).toBe("gpt-pinned-impl");
    expect(
      readInstalledManifest(target)?.routing?.codex?.reviewer?.high?.model,
    ).toBe("gpt-pinned-review");
    expect(existsSync(catalogCalls)).toBe(false);
  });

  it("setup and init validate only active Codex leaves, skipping a foreign catalog for Claude", () => {
    const catalog = jsonFile("minimal-catalog", minimalCatalog);
    ok(
      "setup",
      "--harness",
      "codex",
      "--profile",
      "minimal",
      "--no-tiers",
      "--codex-catalog",
      catalog,
    );
    ok(
      "init",
      target,
      "--harness",
      "codex",
      "--profile",
      "minimal",
      "--no-tiers",
      "--codex-catalog",
      catalog,
    );
    const stored = JSON.parse(
      readFileSync(join(home, "manifest.json"), "utf8"),
    );
    expect(stored.defaults.harnesses).toEqual(["codex"]);
    const malformedCatalog = jsonFile("foreign-catalog", { malformed: true });
    const result = ok(
      "setup",
      "--harness",
      "claude",
      "--codex-catalog",
      malformedCatalog,
    );
    expect(result.stdout + result.stderr).not.toContain("Codex catalog");
    const before = readFileSync(join(home, "manifest.json"), "utf8");
    const invalid = run(
      "setup",
      "--harness",
      "codex",
      "--tiers",
      "--codex-catalog",
      catalog,
    );
    expect(invalid.status).toBe(2);
    expect(readFileSync(join(home, "manifest.json"), "utf8")).toBe(before);
  });

  it("setup preserves sparse defaults and emits exactly one no-catalog notice", () => {
    const implementer = jsonFile("impl", {
      codex: { implementer: { medium: leaf("gpt-operator-impl") } },
    });
    const reviewer = jsonFile("review", {
      codex: { reviewer: { high: leaf("gpt-operator-review") } },
    });
    const result = ok(
      "setup",
      "--harness",
      "codex",
      "--profile",
      "minimal",
      "--routing",
      implementer,
    );
    expect(
      (result.stdout + result.stderr).match(/no capability catalog supplied/g),
    ).toHaveLength(1);
    ok("setup", "--routing", reviewer);
    const stored = JSON.parse(
      readFileSync(join(home, "manifest.json"), "utf8"),
    );
    expect(stored.defaults.routing.codex.implementer.medium.model).toBe(
      "gpt-operator-impl",
    );
    expect(stored.defaults.routing.codex.reviewer.high.model).toBe(
      "gpt-operator-review",
    );
  });

  it("apply deep-merges operator < sparse repo < explicit patch and sync discards repo routing", () => {
    const operator = jsonFile("operator-routing", {
      codex: { reviewer: { high: leaf("gpt-operator-review") } },
    });
    ok(
      "setup",
      "--harness",
      "codex",
      "--profile",
      "minimal",
      "--routing",
      operator,
    );
    runInit({
      targetDir: target,
      harnesses: ["codex"],
      profile: "minimal",
      models: { ...DEFAULT_MODELS },
      routing: { codex: { implementer: { medium: leaf("gpt-repo-impl") } } },
    });
    // Simulate a valid sparse repo manifest, as produced by an older API caller.
    const manifest = JSON.parse(
      readFileSync(join(target, MANIFEST_PATH), "utf8"),
    );
    manifest.routing = {
      codex: { implementer: { medium: leaf("gpt-repo-impl") } },
    };
    writeFileSync(join(target, MANIFEST_PATH), JSON.stringify(manifest));
    ok("apply", "--target", target);
    expect(
      readInstalledManifest(target)?.routing?.codex?.implementer?.medium?.model,
    ).toBe("gpt-repo-impl");
    expect(
      readInstalledManifest(target)?.routing?.codex?.reviewer?.high?.model,
    ).toBe("gpt-operator-review");
    const explicit = jsonFile("explicit", {
      codex: { reviewer: { high: leaf("gpt-explicit-review") } },
    });
    ok("apply", "--target", target, "--routing", explicit);
    expect(
      readInstalledManifest(target)?.routing?.codex?.reviewer?.high?.model,
    ).toBe("gpt-explicit-review");
    ok("apply", "--target", target, "--sync");
    expect(
      readInstalledManifest(target)?.routing?.codex?.implementer?.medium?.model,
    ).toBe("gpt-5.6-terra");
    expect(
      readInstalledManifest(target)?.routing?.codex?.reviewer?.high?.model,
    ).toBe("gpt-operator-review");
    ok("apply", "--target", target, "--sync", "--routing", explicit);
    expect(
      parse(readFileSync(join(target, ".codex/agents/reviewer.toml"), "utf8"))
        .model,
    ).toBe("gpt-explicit-review");
    expect(existsSync(catalogCalls)).toBe(false);
  });

  it("keeps templates-only harness intent on a real apply with routing options", () => {
    ok("setup", "--harness", "codex");
    ok("init", target, "--harness", "none");
    mkdirSync(join(target, ".claude"));
    const patch = jsonFile("patch", {
      codex: { reviewer: { high: leaf("gpt-pinned") } },
    });
    ok("apply", "--target", target, "--routing", patch);
    expect(readInstalledManifest(target)?.harnesses).toEqual([]);
    expect(existsSync(join(target, ".codex/agents"))).toBe(false);
    expect(existsSync(join(target, ".claude/agents"))).toBe(false);
  });

  it("preserves API-resolved opencode defaults and tiers across CLI offline init/apply/sync", () => {
    const opencodeModels = Object.fromEntries(
      ROLES.map((role) => [role, "provider/claude-sonnet-pinned"]),
    ) as Record<(typeof ROLES)[number], string>;
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      profile: "minimal",
      models: { ...DEFAULT_MODELS },
      tiers: true,
      opencodeModels,
      opencodeClassModels: {
        small: "provider/claude-haiku-pinned",
        medium: "provider/claude-sonnet-pinned",
        large: "provider/claude-opus-pinned",
      },
    });
    const routing = readInstalledManifest(target)?.routing;
    const routingFile = jsonFile("opencode-routing", routing);
    ok(
      "setup",
      "--harness",
      "opencode",
      "--profile",
      "minimal",
      "--tiers",
      "--routing",
      routingFile,
    );
    const before = readFileSync(join(target, MANIFEST_PATH), "utf8");
    const agentsBefore = Object.fromEntries(
      readdirSync(join(target, ".opencode/agents")).map((name) => [
        name,
        readFileSync(join(target, ".opencode/agents", name), "utf8"),
      ]),
    );
    ok("init", target);
    ok("apply", "--target", target);
    ok("apply", "--target", target, "--sync");
    expect(readFileSync(join(target, MANIFEST_PATH), "utf8")).toBe(before);
    for (const [name, content] of Object.entries(agentsBefore))
      expect(readFileSync(join(target, ".opencode/agents", name), "utf8")).toBe(
        content,
      );
    expect(existsSync(catalogCalls)).toBe(false);
  });

  it("legacy --models updates default roles only and explicit routing remains the final layer", () => {
    const firstRouting = jsonFile("first", {
      claude: { implementer: { medium: leaf("opus") } },
      codex: { implementer: { medium: leaf("gpt-pinned") } },
    });
    ok(
      "init",
      target,
      "--harness",
      "claude,codex",
      "--profile",
      "minimal",
      "--tiers",
      "--routing",
      firstRouting,
    );
    const claudeTier = readFileSync(
      join(target, ".claude/agents/implementer-high.md"),
      "utf8",
    );
    ok("init", target, "--models", "implementer=haiku");
    expect(
      readInstalledManifest(target)?.routing?.claude?.implementer?.medium
        ?.model,
    ).toBe("haiku");
    expect(
      readInstalledManifest(target)?.routing?.codex?.implementer?.medium?.model,
    ).toBe("gpt-pinned");
    expect(
      readFileSync(join(target, ".claude/agents/implementer-high.md"), "utf8"),
    ).toBe(claudeTier);
    ok(
      "init",
      target,
      "--models",
      "implementer=sonnet",
      "--routing",
      firstRouting,
    );
    expect(
      readInstalledManifest(target)?.routing?.claude?.implementer?.medium
        ?.model,
    ).toBe("opus");
  });

  it("rejects invalid routing and unavailable catalog selections before modifying a target", () => {
    const badRouting = jsonFile("bad-routing", {
      codex: {
        implementer: { medium: { model: "gpt-valid", effort: "invalid" } },
      },
    });
    expect(
      run("init", target, "--harness", "codex", "--routing", badRouting).status,
    ).toBe(2);
    expect(readdirSync(target)).toEqual([]);
    const emptyCatalog = jsonFile("empty-catalog", { models: [] });
    const failed = run(
      "init",
      target,
      "--harness",
      "codex",
      "--codex-catalog",
      emptyCatalog,
    );
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("unavailable");
    expect(readdirSync(target)).toEqual([]);
    ok("setup", "--harness", "codex");
    const operatorBefore = readFileSync(join(home, "manifest.json"), "utf8");
    const applyFailed = run(
      "apply",
      "--target",
      target,
      "--codex-catalog",
      emptyCatalog,
    );
    expect(applyFailed.status).not.toBe(0);
    expect(readFileSync(join(home, "manifest.json"), "utf8")).toBe(
      operatorBefore,
    );
    expect(readdirSync(target)).toEqual([]);
  });
});

describe("legacy routing compatibility across commands", () => {
  it("ordinary apply keeps a legacy repo model over materialized operator defaults, while sync replaces it", () => {
    ok("setup", "--harness", "claude", "--profile", "minimal");
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      profile: "minimal",
      models: { ...DEFAULT_MODELS, implementer: "haiku" },
    });
    const manifest = JSON.parse(
      readFileSync(join(target, MANIFEST_PATH), "utf8"),
    );
    delete manifest.routing;
    writeFileSync(join(target, MANIFEST_PATH), JSON.stringify(manifest));
    ok("apply", "--target", target);
    expect(readInstalledManifest(target)?.models.implementer).toBe("haiku");
    expect(
      readInstalledManifest(target)?.routing?.claude?.implementer?.medium
        ?.model,
    ).toBe("haiku");
    expect(
      readFileSync(join(target, ".claude/agents/implementer.md"), "utf8"),
    ).toContain("model: haiku");
    ok("apply", "--target", target, "--sync");
    expect(readInstalledManifest(target)?.models.implementer).toBe("sonnet");
    expect(
      readInstalledManifest(target)?.routing?.claude?.implementer?.medium
        ?.model,
    ).toBe("sonnet");
    expect(
      readFileSync(join(target, ".claude/agents/implementer.md"), "utf8"),
    ).toContain("model: sonnet");
    const patch = jsonFile("legacy-explicit", {
      claude: { implementer: { medium: leaf("opus") } },
    });
    ok("apply", "--target", target, "--sync", "--routing", patch);
    expect(
      readInstalledManifest(target)?.routing?.claude?.implementer?.medium
        ?.model,
    ).toBe("opus");
  });

  it("keeps bare legacy opencode IDs through offline init, apply, setup, doctor, and uninstall", () => {
    const opencodeModels = Object.fromEntries(
      ROLES.map((role) => [role, "local-model"]),
    );
    const opencodeClassModels = {
      small: "local-small",
      medium: "local-medium",
      large: "local-large",
    };
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      profile: "minimal",
      tiers: true,
      models: { ...DEFAULT_MODELS },
      opencodeModels,
      opencodeClassModels,
    });
    const operator = createOperatorManifest({
      harnesses: ["opencode"],
      profile: "minimal",
      tiers: true,
      models: { ...DEFAULT_MODELS },
      opencodeModels,
      opencodeClassModels,
    });
    updateOperatorManifest(home, () => operator);
    const before = readFileSync(join(target, MANIFEST_PATH), "utf8");
    ok("init", target);
    ok("apply", "--target", target);
    ok("setup");
    ok("apply", "--target", target, "--sync");
    expect(existsSync(catalogCalls)).toBe(false);
    expect(readFileSync(join(target, MANIFEST_PATH), "utf8")).toBe(before);
    const report = runDoctor(home, {});
    expect(report.targets[0]).toMatchObject({
      status: "clean",
      driftFiles: null,
    });
    expect(report.targets[0].routingComparisonGaps).toBeUndefined();
    expect(
      readFileSync(
        join(target, ".opencode/agents/implementer-xhigh.md"),
        "utf8",
      ),
    ).toContain("model: local-large");
    expect(runUninstall({ targetDir: target }).kept).toEqual([]);
    expect(existsSync(join(target, MANIFEST_PATH))).toBe(false);
  });
});

describe("adopt bootstrap routing compatibility", () => {
  it("retains bare opencode defaults and class IDs through adopt, doctor, and sync", () => {
    const opencodeModels = Object.fromEntries(
      ROLES.map((role) => [role, "local-pinned"]),
    );
    const opencodeClassModels = {
      small: "local-small-pinned",
      medium: "local-medium-pinned",
      large: "local-large-pinned",
    };
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      profile: "minimal",
      tiers: true,
      models: { ...DEFAULT_MODELS },
      opencodeModels,
      opencodeClassModels,
    });
    const before = readFileSync(join(target, MANIFEST_PATH), "utf8");
    const defaultAgent = readFileSync(
      join(target, ".opencode/agents/implementer.md"),
      "utf8",
    );
    const variantAgent = readFileSync(
      join(target, ".opencode/agents/implementer-xhigh.md"),
      "utf8",
    );
    expect(existsSync(join(home, "manifest.json"))).toBe(false);
    const adopted = JSON.parse(ok("adopt", target, "--json").stdout);
    expect(adopted.bootstrapped).toBe(true);
    const operator = JSON.parse(
      readFileSync(join(home, "manifest.json"), "utf8"),
    );
    expect(operator.defaults.opencodeModels).toEqual(opencodeModels);
    expect(operator.defaults.opencodeClassModels).toEqual(opencodeClassModels);
    expect(readFileSync(join(target, MANIFEST_PATH), "utf8")).toBe(before);
    const doctor = JSON.parse(ok("doctor", "--json").stdout);
    expect(doctor.targets[0]).toMatchObject({
      status: "clean",
      driftFiles: null,
    });
    expect(doctor.targets[0].routingComparisonGaps).toBeUndefined();
    ok("apply", "--target", target, "--sync");
    expect(readFileSync(join(target, MANIFEST_PATH), "utf8")).toBe(before);
    expect(
      readFileSync(join(target, ".opencode/agents/implementer.md"), "utf8"),
    ).toBe(defaultAgent);
    expect(
      readFileSync(
        join(target, ".opencode/agents/implementer-xhigh.md"),
        "utf8",
      ),
    ).toBe(variantAgent);
    expect(existsSync(catalogCalls)).toBe(false);
  });
});

describe("recorded inheritance across command boundaries", () => {
  it("preserves API inheritance through init/adopt/doctor/sync and masks lower operator selections on ordinary apply", () => {
    runInit({
      targetDir: target,
      harnesses: ["opencode"],
      profile: "minimal",
      tiers: true,
      models: { ...DEFAULT_MODELS, implementer: "provider/custom" },
      opencodeModels: { implementer: undefined },
      opencodeClassModels: {},
    });
    const before = readFileSync(join(target, MANIFEST_PATH), "utf8");
    ok("init", target);
    const adopted = JSON.parse(ok("adopt", target, "--json").stdout);
    expect(adopted.bootstrapped).toBe(true);
    expect(
      JSON.parse(readFileSync(join(home, "manifest.json"), "utf8")).defaults,
    ).toMatchObject({ opencodeModels: {}, opencodeClassModels: {} });
    const doctor = JSON.parse(ok("doctor", "--json").stdout);
    expect(doctor.targets[0]).toMatchObject({
      status: "clean",
      driftFiles: null,
    });
    expect(doctor.targets[0].routingComparisonGaps).toBeUndefined();
    ok("apply", "--target", target, "--sync");
    expect(readFileSync(join(target, MANIFEST_PATH), "utf8")).toBe(before);
    updateOperatorManifest(home, (current) => ({
      ...current!,
      defaults: {
        ...current!.defaults,
        routing: {
          opencode: {
            implementer: {
              medium: { model: "provider/operator", effort: "medium" },
              high: { model: "provider/operator-high", effort: "high" },
            },
          },
        },
      },
    }));
    const divergent = JSON.parse(ok("doctor", "--json").stdout);
    expect(divergent.targets[0].divergence.routing).toBe(true);
    expect(divergent.targets[0].routingComparisonGaps).toBeUndefined();
    ok("apply", "--target", target);
    expect(
      readFileSync(join(target, ".opencode/agents/implementer.md"), "utf8"),
    ).not.toMatch(/^model:/m);
    expect(
      existsSync(join(target, ".opencode/agents/implementer-high.md")),
    ).toBe(false);
    ok("apply", "--target", target, "--sync");
    expect(
      readFileSync(join(target, ".opencode/agents/implementer.md"), "utf8"),
    ).toContain("model: provider/operator");
    expect(
      readFileSync(
        join(target, ".opencode/agents/implementer-high.md"),
        "utf8",
      ),
    ).toContain("model: provider/operator-high");
    const explicit = jsonFile("inheritance-explicit", {
      opencode: {
        implementer: {
          medium: { model: "provider/explicit", effort: "medium" },
        },
      },
    });
    ok("apply", "--target", target, "--routing", explicit);
    expect(
      readFileSync(join(target, ".opencode/agents/implementer.md"), "utf8"),
    ).toContain("model: provider/explicit");
    expect(existsSync(catalogCalls)).toBe(false);
  }, 30_000);

  it.each(["roles", "classes"] as const)(
    "does not fill recorded inherited %s when another selection needs catalog resolution",
    (inherited) => {
      writeFileSync(
        join(bin, "opencode"),
        '#!/bin/sh\necho called >> "$OW_TEST_CATALOG_CALLS"\nprintf "%s\\n" provider/claude-haiku-4-5 provider/claude-sonnet-4-6 provider/claude-opus-4-8\n',
        { mode: 0o755 },
      );
      runInit({
        targetDir: target,
        harnesses: ["opencode"],
        profile: "minimal",
        tiers: inherited === "classes",
        models: { ...DEFAULT_MODELS },
        ...(inherited === "roles"
          ? { opencodeModels: {} }
          : { opencodeClassModels: {} }),
      });
      ok("init", target, "--tiers");
      expect(existsSync(catalogCalls)).toBe(true);
      const base = readFileSync(
        join(target, ".opencode/agents/implementer.md"),
        "utf8",
      );
      if (inherited === "roles") {
        expect(base).not.toMatch(/^model:/m);
        expect(
          readFileSync(
            join(target, ".opencode/agents/implementer-high.md"),
            "utf8",
          ),
        ).toContain("model: provider/claude-sonnet-4-6");
      } else {
        expect(base).toContain("model: provider/claude-sonnet-4-6");
        expect(
          existsSync(join(target, ".opencode/agents/implementer-high.md")),
        ).toBe(false);
      }
    },
  );
});

describe("dormant recorded opencode choices", () => {
  it.each([false, true])(
    "retains dormant role/class selections through sync (harness disabled: %s)",
    (disabled) => {
      const opencodeModels = Object.fromEntries(
        ROLES.map((role) => [role, `local-${role}`]),
      );
      const opencodeClassModels = {
        small: "local-small",
        medium: "local-medium",
        large: "local-large",
      };
      runInit({
        targetDir: target,
        harnesses: ["opencode"],
        profile: "minimal",
        tiers: false,
        models: { ...DEFAULT_MODELS },
        opencodeModels,
        opencodeClassModels,
      });
      if (disabled) ok("init", target, "--harness", "none");
      const before = readFileSync(join(target, MANIFEST_PATH), "utf8");
      ok("adopt", target, "--json");
      ok("apply", "--target", target, "--sync");
      expect(readFileSync(join(target, MANIFEST_PATH), "utf8")).toBe(before);
      ok(
        "init",
        target,
        "--harness",
        "opencode",
        "--profile",
        "full",
        "--tiers",
      );
      expect(readInstalledManifest(target)?.opencodeModels).toEqual(
        opencodeModels,
      );
      expect(readInstalledManifest(target)?.opencodeClassModels).toEqual(
        opencodeClassModels,
      );
      expect(
        readFileSync(join(target, ".opencode/agents/explorer.md"), "utf8"),
      ).toContain("model: local-explorer");
      expect(
        readFileSync(join(target, ".opencode/agents/advisor-xhigh.md"), "utf8"),
      ).toContain("model: local-large");
      expect(existsSync(catalogCalls)).toBe(false);
    },
  );
});

describe("dormant choices over a different operator layer", () => {
  it.each([
    { disabled: false, inherited: false },
    { disabled: true, inherited: false },
    { disabled: false, inherited: true },
    { disabled: true, inherited: true },
  ])(
    "preserves upper concrete and inherited slots independent of scope: %j",
    ({ disabled, inherited }) => {
      const upperModels = inherited
        ? {}
        : Object.fromEntries(
            ROLES.map((role) => [role, `local-upper-${role}`]),
          );
      const upperClasses = inherited
        ? {}
        : {
            small: "local-upper-small",
            medium: "local-upper-medium",
            large: "local-upper-large",
          };
      runInit({
        targetDir: target,
        harnesses: ["opencode"],
        profile: "minimal",
        tiers: false,
        models: { ...DEFAULT_MODELS },
        opencodeModels: upperModels,
        opencodeClassModels: upperClasses,
        routing: {
          opencode: {
            reviewer: {
              xhigh: { model: "provider/upper-explicit", effort: "xhigh" },
            },
          },
        },
      });
      if (disabled) ok("init", target, "--harness", "none");
      updateOperatorManifest(home, () =>
        createOperatorManifest({
          harnesses: ["opencode"],
          profile: "full",
          tiers: true,
          models: { ...DEFAULT_MODELS },
          opencodeModels: Object.fromEntries(
            ROLES.map((role) => [role, `local-lower-${role}`]),
          ),
          opencodeClassModels: {
            small: "local-lower-small",
            medium: "local-lower-medium",
            large: "local-lower-large",
          },
        }),
      );
      ok("apply", "--target", target);
      expect(readInstalledManifest(target)?.opencodeModels).toEqual(
        upperModels,
      );
      expect(readInstalledManifest(target)?.opencodeClassModels).toEqual(
        upperClasses,
      );
      expect(readFileSync(join(target, MANIFEST_PATH), "utf8")).not.toContain(
        "local-lower",
      );
      ok(
        "init",
        target,
        "--harness",
        "opencode",
        "--profile",
        "full",
        "--tiers",
      );
      for (const role of ROLES) {
        const agent = readFileSync(
          join(target, `.opencode/agents/${role}.md`),
          "utf8",
        );
        if (inherited) expect(agent).not.toMatch(/^model:/m);
        else expect(agent).toContain(`model: local-upper-${role}`);
      }
      expect(
        readFileSync(
          join(target, ".opencode/agents/reviewer-xhigh.md"),
          "utf8",
        ),
      ).toContain("model: provider/upper-explicit");
      if (inherited)
        expect(
          existsSync(join(target, ".opencode/agents/implementer-xhigh.md")),
        ).toBe(false);
      else
        expect(
          readFileSync(
            join(target, ".opencode/agents/implementer-xhigh.md"),
            "utf8",
          ),
        ).toContain("model: local-upper-large");
      expect(existsSync(catalogCalls)).toBe(false);
    },
  );
});

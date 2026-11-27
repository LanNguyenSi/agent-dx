import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Every `npx orchestrator-workflow` a reader can copy from the root README,
// the package README, INSTALL-AGENT.md and the shipped reference docs names
// the release the docs describe, so the pins must move with each release. A
// release that bumps packages/orchestrator-workflow/package.json without
// moving them fails here, and the tag cannot publish.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const pkgDir = `${repoRoot}/packages/orchestrator-workflow`;

const version = (
  JSON.parse(readFileSync(`${pkgDir}/package.json`, "utf8")) as {
    version: string;
  }
).version;

const PIN_FILES = [
  "README.md",
  "packages/orchestrator-workflow/README.md",
  "packages/orchestrator-workflow/INSTALL-AGENT.md",
  "packages/orchestrator-workflow/docs/model-routing-reference.md",
  "packages/orchestrator-workflow/docs/install-reference.md",
];

describe("root README quick start pins the published orchestrator-workflow version", () => {
  it("npx orchestrator-workflow@<version> init matches package.json", () => {
    const readme = readFileSync(`${repoRoot}/README.md`, "utf8");
    const match = readme.match(/npx orchestrator-workflow@([\w.-]+) init/);
    expect(
      match,
      "npx orchestrator-workflow@<version> example not found in the root README.md",
    ).not.toBeNull();
    expect(match?.[1]).toBe(version);
  });
});

// One site per `npx` or `npm exec` invocation of the package, with or without
// flags before the package name (`npx -y`, `npx --yes`); group 1 is the
// `@<version>` suffix, if any.
const PIN_SITE =
  /\b(?:npx|npm exec)(?:\s+--?[\w-]+)*\s+orchestrator-workflow(@[^\s`)]*)?/g;

describe("the pin site pattern", () => {
  it("finds flag forms and reports them unpinned", () => {
    const text =
      "npx -y orchestrator-workflow init\nnpx --yes orchestrator-workflow@1.2.3 doctor\nnpm exec orchestrator-workflow apply";
    const sites = [...text.matchAll(PIN_SITE)].map((m) => m[1]);
    expect(sites).toEqual([undefined, "@1.2.3", undefined]);
  });
});

describe("every npx orchestrator-workflow invocation carries the package.json version", () => {
  for (const file of PIN_FILES) {
    it(file, () => {
      const text = readFileSync(`${repoRoot}/${file}`, "utf8");
      const sites = [...text.matchAll(PIN_SITE)];
      expect(
        sites.length,
        `no npx orchestrator-workflow example found in ${file}`,
      ).toBeGreaterThan(0);
      for (const site of sites) {
        expect(site[1], `unpinned or mispinned site: ${site[0]}`).toBe(
          `@${version}`,
        );
      }
    });
  }
});

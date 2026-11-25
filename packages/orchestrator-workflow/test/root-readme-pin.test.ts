import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The repository root README's quick start names the version readers npx,
// so it must move with each release. This test covers only the root README:
// a release that bumps packages/orchestrator-workflow/package.json without
// the root pin fails here.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const version = (
  JSON.parse(
    readFileSync(
      `${repoRoot}/packages/orchestrator-workflow/package.json`,
      "utf8",
    ),
  ) as { version: string }
).version;

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

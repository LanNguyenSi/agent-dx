import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The repository root README's quick start names the version readers npx,
// so it must move with each release. The OW bundle's docs-consistency suite
// covers okf-kit's own README; this test covers only the root README, so a
// release that bumps packages/okf-kit/package.json without the root pin
// fails here.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const version = (
  JSON.parse(
    readFileSync(`${repoRoot}/packages/okf-kit/package.json`, "utf8"),
  ) as { version: string }
).version;

describe("root README quick start pins the published okf-kit version", () => {
  it("npx okf-kit@<version> check matches packages/okf-kit/package.json", () => {
    const readme = readFileSync(`${repoRoot}/README.md`, "utf8");
    const match = readme.match(/npx okf-kit@([\w.-]+) check path\/to\/bundle/);
    expect(
      match,
      "npx okf-kit@<version> example not found in the root README.md",
    ).not.toBeNull();
    expect(match?.[1]).toBe(version);
  });
});

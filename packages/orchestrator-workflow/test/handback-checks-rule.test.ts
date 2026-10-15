import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";
import { DEFAULT_MODELS } from "../src/models.js";
import { runInit } from "../src/init.js";

const unwrap = (text: string) => text.replace(/\\n/g, " ").replace(/\s+/g, " ");

const IMPLEMENTER_SENTENCES = [
  "run the documentation checks that exist, scoped to your delta",
  "run its bundle check",
  "a drift check that lists docs and comments still naming a removed or renamed identifier is connected, run it over base..head",
  "A check that cannot run is a limitation, not a pass",
  "carries either the path of a recorded verify envelope",
  "or the exact command plus its exit code",
];

const REVIEWER_SENTENCES = [
  "Claimed checks: verify every check result the implementer claims against the recorded verify envelope or the exact command plus exit code it cites, not against the prose",
  "A claim with neither an envelope path nor a command plus exit code is a finding",
];

const CONTRACT_SENTENCES = [
  "Every claimed check result in `tests.executed`, `summary`, or `criterion_evidence` carries the path of a recorded verify envelope or the exact command plus its exit code",
  "a claim without either is a finding",
];

describe("handback checks and claim traceability rule", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("is carried by the implementer prompt asset", () => {
    const text = unwrap(readAsset("agents/implementer.md"));
    for (const s of IMPLEMENTER_SENTENCES) expect(text).toContain(s);
  });

  it("is carried by the reviewer prompt asset", () => {
    const text = unwrap(readAsset("agents/reviewer.md"));
    for (const s of REVIEWER_SENTENCES) expect(text).toContain(s);
  });

  it("is carried by the contracts reference", () => {
    const text = unwrap(readAsset("skill/references/contracts.md"));
    for (const s of CONTRACT_SENTENCES) expect(text).toContain(s);
  });

  it.each([
    ["claude", ".claude"],
    ["opencode", ".opencode"],
    ["codex", ".codex"],
  ] as const)(
    "reaches every rendered %s implementer and reviewer",
    (h, dir) => {
      const target = mkdtempSync(join(tmpdir(), "ow-handback-rule-"));
      dirs.push(target);
      runInit({
        targetDir: target,
        harnesses: [h],
        models: { ...DEFAULT_MODELS },
        profile: "full",
        tiers: true,
      });
      const agentsDir = join(target, dir, "agents");
      const files = readdirSync(agentsDir);
      const impl = files.filter((f) => f.startsWith("implementer"));
      const rev = files.filter((f) => f.startsWith("reviewer"));
      expect(impl.length).toBeGreaterThan(0);
      expect(rev.length).toBeGreaterThan(0);
      for (const f of impl) {
        const text = unwrap(readFileSync(join(agentsDir, f), "utf8"));
        for (const s of IMPLEMENTER_SENTENCES) expect(text, f).toContain(s);
      }
      for (const f of rev) {
        const text = unwrap(readFileSync(join(agentsDir, f), "utf8"));
        for (const s of REVIEWER_SENTENCES) expect(text, f).toContain(s);
      }
    },
  );
});

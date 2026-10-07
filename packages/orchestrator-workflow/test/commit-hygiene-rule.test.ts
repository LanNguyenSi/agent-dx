import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";
import { DEFAULT_MODELS } from "../src/models.js";
import { runInit } from "../src/init.js";

const unwrap = (text: string) => text.replace(/\s+/g, " ");

const RULE_SENTENCES = [
  "Run a commit hygiene check before every commit and again before returning",
  "When a hygiene runner is available (the briefing names the command)",
  "naming every file the assignment says you only extend",
  "`git status --porcelain` and `git diff --stat <base>..HEAD`",
  "backup files (`*-E`, `*.bak`, `*.orig`, `*~`)",
  "a changed test file that has fewer test cases than before",
  "A finding blocks the commit or the return",
  "a bare `sed -i -E` on macOS treats `-E` as the backup suffix",
];

describe("implementer commit hygiene rule", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("is carried by the implementer prompt asset", () => {
    const text = unwrap(readAsset("agents/implementer.md"));
    for (const sentence of RULE_SENTENCES) expect(text).toContain(sentence);
  });

  it("reaches every rendered implementer tier variant", () => {
    const target = mkdtempSync(join(tmpdir(), "ow-hygiene-rule-"));
    dirs.push(target);
    runInit({
      targetDir: target,
      harnesses: ["claude"],
      models: { ...DEFAULT_MODELS },
      profile: "full",
      tiers: true,
    });
    for (const name of [
      "implementer",
      "implementer-low",
      "implementer-high",
      "implementer-xhigh",
    ]) {
      const rendered = unwrap(
        readFileSync(join(target, ".claude", "agents", `${name}.md`), "utf8"),
      );
      for (const sentence of RULE_SENTENCES) {
        expect(rendered, name).toContain(sentence);
      }
    }
  });
});

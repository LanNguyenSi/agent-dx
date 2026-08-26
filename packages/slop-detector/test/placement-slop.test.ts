import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkText, checkPath } from "../src/engine.js";
import { defaultConfig, mergeConfig, loadConfig } from "../src/config.js";
import { allPacks } from "../src/packs/registry.js";
import type { PackDefinition, Rule, RuleContext } from "../src/types.js";

const baseOpts = () => ({
  packs: allPacks,
  config: defaultConfig(),
  packFilter: ["placement-slop"],
});

describe("placement-slop", () => {
  it("(a) fires dated-evidence and tally-phrase on a dated A/B measurement line", () => {
    const text =
      "`implementer-low` (2026-08-24 A/B measurement, n=8: implementer-low reached accept a median 320 seconds slower, p=0.016, with 9 high-plus-critical review findings against 1";
    const v = checkText(text, "x/SKILL.md", baseOpts());
    expect(
      v.find((x) => x.ruleId === "placement-slop/dated-evidence"),
    ).toBeDefined();
    expect(
      v.find((x) => x.ruleId === "placement-slop/tally-phrase"),
    ).toBeDefined();
  });

  it("(b) fires opaque-id on a blinded task id", () => {
    const text =
      "blinded reviews, agent-tasks task 7f38899d): implementer-low reached accept";
    const v = checkText(text, "x/SKILL.md", baseOpts());
    expect(
      v.find((x) => x.ruleId === "placement-slop/opaque-id"),
    ).toBeDefined();
  });

  it("(c) fires tally-phrase on 'so far'", () => {
    const text =
      "whose outcome was recorded (four so far) has resolved on the first resume attempt";
    const v = checkText(text, "x/SKILL.md", baseOpts());
    expect(
      v.find((x) => x.ruleId === "placement-slop/tally-phrase"),
    ).toBeDefined();
  });

  it("(d) fires home-path on a literal ~/ path", () => {
    const text =
      "(`DEPSIGHT_TOKEN` in `~/git/pandora/.env`, minted on the Settings page)";
    const v = checkText(text, "x/SKILL.md", baseOpts());
    expect(
      v.find((x) => x.ruleId === "placement-slop/home-path"),
    ).toBeDefined();
  });

  it("(i) negative control: a plain rule paragraph without evidence produces 0 violations", () => {
    const text =
      "Prefer resume over a fresh respawn when the subagent returned near-instantly with no tool activity.";
    const v = checkText(text, "x/SKILL.md", baseOpts());
    expect(v).toHaveLength(0);
  });

  it("(ii) negative control: the same four fixture lines in README.md (not an instruction file) produce 0 violations", () => {
    const text = [
      "`implementer-low` (2026-08-24 A/B measurement, n=8: implementer-low reached accept a median 320 seconds slower, p=0.016, with 9 high-plus-critical review findings against 1",
      "blinded reviews, agent-tasks task 7f38899d): implementer-low reached accept",
      "whose outcome was recorded (four so far) has resolved on the first resume attempt",
      "(`DEPSIGHT_TOKEN` in `~/git/pandora/.env`, minted on the Settings page)",
    ].join("\n");
    const v = checkText(text, "README.md", baseOpts());
    expect(v.filter((x) => x.pack === "placement-slop")).toHaveLength(0);
  });

  it("(iii) placement.allow suppresses an org-marker match; without it the marker still fires", () => {
    const text = "install from https://github.com/example-org/kit/tree/master";

    const withAllow = mergeConfig({
      placement: {
        markers: ["example-org"],
        allow: ["github\\.com/example-org/"],
      },
    });
    const vAllowed = checkText(text, "x/SKILL.md", {
      packs: allPacks,
      config: withAllow,
      packFilter: ["placement-slop"],
    });
    expect(vAllowed).toHaveLength(0);

    const withoutAllow = mergeConfig({
      placement: { markers: ["example-org"] },
    });
    const vBlocked = checkText(text, "x/SKILL.md", {
      packs: allPacks,
      config: withoutAllow,
      packFilter: ["placement-slop"],
    });
    const orgMarkerHits = vBlocked.filter(
      (x) => x.ruleId === "placement-slop/org-marker",
    );
    expect(orgMarkerHits).toHaveLength(1);
  });

  describe("placement.allow is span-scoped, not line-wide (agent-dx #119 R2)", () => {
    const withAllow = mergeConfig({
      placement: {
        markers: ["example-org"],
        allow: ["github\\.com/example-org/"],
      },
    });
    const scopedOpts = () => ({
      packs: allPacks,
      config: withAllow,
      packFilter: ["placement-slop"],
    });

    it("an allowed URL suppresses org-marker but a home path on the same line still fires", () => {
      const text =
        "install from https://github.com/example-org/kit see /Users/example/project also";
      const v = checkText(text, "x/SKILL.md", scopedOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/org-marker"),
      ).toBeUndefined();
      expect(
        v.find((x) => x.ruleId === "placement-slop/home-path"),
      ).toBeDefined();
    });

    it("an allowed URL suppresses org-marker but dated evidence on the same line still fires", () => {
      const text =
        "install from https://github.com/example-org/kit dated 2026-08-24";
      const v = checkText(text, "x/SKILL.md", scopedOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/org-marker"),
      ).toBeUndefined();
      expect(
        v.find((x) => x.ruleId === "placement-slop/dated-evidence"),
      ).toBeDefined();
    });

    it("an allowed URL suppresses org-marker but a tally phrase on the same line still fires", () => {
      const text =
        "install from https://github.com/example-org/kit worked so far";
      const v = checkText(text, "x/SKILL.md", scopedOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/org-marker"),
      ).toBeUndefined();
      expect(
        v.find((x) => x.ruleId === "placement-slop/tally-phrase"),
      ).toBeDefined();
    });

    it("semantics-preservation control: a line carrying only the allowed URL still reports nothing (passes with or without the span-scoping fix)", () => {
      const text = "install from https://github.com/example-org/kit";
      const v = checkText(text, "x/SKILL.md", scopedOpts());
      expect(v.filter((x) => x.pack === "placement-slop")).toHaveLength(0);
    });

    it("an anchored allow pattern (^...) still matches on a non-first line, not just at file start", () => {
      const anchoredAllow = mergeConfig({
        placement: {
          markers: ["example-org"],
          allow: ["^install from https://github\\.com/example-org/"],
        },
      });
      const text = [
        "context line one",
        "context line two",
        "install from https://github.com/example-org/kit",
      ].join("\n");
      const v = checkText(text, "x/SKILL.md", {
        packs: allPacks,
        config: anchoredAllow,
        packFilter: ["placement-slop"],
      });
      expect(
        v.find((x) => x.ruleId === "placement-slop/org-marker"),
      ).toBeUndefined();
    });

    it("an allow pattern that can cross a newline (e.g. start[\\s\\S]*end) does not excuse findings on adjacent lines", () => {
      const crossLineAllow = mergeConfig({
        placement: {
          markers: ["example-org"],
          allow: ["start[\\s\\S]*end"],
        },
      });
      const text = [
        "start example-org",
        "/Users/lan/x/ and 2026-08-24",
        "end",
      ].join("\n");
      const v = checkText(text, "x/SKILL.md", {
        packs: allPacks,
        config: crossLineAllow,
        packFilter: ["placement-slop"],
      });
      expect(
        v.find((x) => x.ruleId === "placement-slop/org-marker"),
      ).toBeDefined();
      expect(
        v.find((x) => x.ruleId === "placement-slop/home-path"),
      ).toBeDefined();
      expect(
        v.find((x) => x.ruleId === "placement-slop/dated-evidence"),
      ).toBeDefined();
    });

    it("an allowed URL suppresses org-marker but an opaque id later on the same line still fires", () => {
      const text =
        "install from https://github.com/example-org/kit ref deadbeef";
      const v = checkText(text, "x/SKILL.md", scopedOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/org-marker"),
      ).toBeUndefined();
      expect(
        v.find((x) => x.ruleId === "placement-slop/opaque-id"),
      ).toBeDefined();
    });

    it("an allow span that only partially overlaps an org-marker match does not excuse it", () => {
      const partialAllow = mergeConfig({
        placement: {
          markers: ["example-org"],
          allow: ["org/kit"],
        },
      });
      const text = "hit example-org/kit direct";
      const v = checkText(text, "x/SKILL.md", {
        packs: allPacks,
        config: partialAllow,
        packFilter: ["placement-slop"],
      });
      expect(
        v.find((x) => x.ruleId === "placement-slop/org-marker"),
      ).toBeDefined();
    });

    it("a CRLF instruction file with an allow span still reports a bare marker on a later line at the correct line:column", () => {
      const text = [
        "first line here",
        "install from https://github.com/example-org/kit",
        "example-org appears bare here",
      ].join("\r\n");
      const v = checkText(text, "x/SKILL.md", scopedOpts());
      const hit = v.find((x) => x.ruleId === "placement-slop/org-marker");
      expect(hit).toBeDefined();
      expect(hit?.line).toBe(3);
      expect(hit?.column).toBe(1);
    });

    it("a $-anchored allow pattern still matches on a CRLF file (R3 #2)", () => {
      const anchoredAllow = mergeConfig({
        placement: {
          markers: ["example-org"],
          allow: ["example-org$"],
        },
      });
      const text = "install example-org\r\nplain";
      const v = checkText(text, "x/SKILL.md", {
        packs: allPacks,
        config: anchoredAllow,
        packFilter: ["placement-slop"],
      });
      expect(
        v.find((x) => x.ruleId === "placement-slop/org-marker"),
      ).toBeUndefined();
    });

    it("an allow span spanning the shared path suppresses home-path directly, not just via org-marker (R3 #1)", () => {
      const allowHomePath = mergeConfig({
        placement: { allow: ["~/git/pandora/\\.env"] },
      });
      const text = "see instructions in ~/git/pandora/.env for setup";
      const v = checkText(text, "x/SKILL.md", {
        packs: allPacks,
        config: allowHomePath,
        packFilter: ["placement-slop"],
      });
      expect(
        v.find((x) => x.ruleId === "placement-slop/home-path"),
      ).toBeUndefined();
    });

    it("an allow span spanning a date suppresses dated-evidence directly (R3 #1)", () => {
      const allowDate = mergeConfig({
        placement: { allow: ["2026-08-24"] },
      });
      const text = "the run recorded on 2026-08-24 was the last one";
      const v = checkText(text, "x/SKILL.md", {
        packs: allPacks,
        config: allowDate,
        packFilter: ["placement-slop"],
      });
      expect(
        v.find((x) => x.ruleId === "placement-slop/dated-evidence"),
      ).toBeUndefined();
    });

    it("an allow span spanning a tally phrase suppresses tally-phrase directly (R3 #1)", () => {
      const allowTally = mergeConfig({
        placement: { allow: ["four so far"] },
      });
      const text = "the count stands at four so far, unresolved";
      const v = checkText(text, "x/SKILL.md", {
        packs: allPacks,
        config: allowTally,
        packFilter: ["placement-slop"],
      });
      expect(
        v.find((x) => x.ruleId === "placement-slop/tally-phrase"),
      ).toBeUndefined();
    });

    it("an allow span never crosses a line break, so a phrase wrapped across one is not excused (R3 #3)", () => {
      const allowAcrossBreak = mergeConfig({
        placement: { allow: ["recorded so far"] },
      });
      const cleanText = "recorded so far in the log";
      const vClean = checkText(cleanText, "x/SKILL.md", {
        packs: allPacks,
        config: allowAcrossBreak,
        packFilter: ["placement-slop"],
      });
      expect(
        vClean.find((x) => x.ruleId === "placement-slop/tally-phrase"),
      ).toBeUndefined();

      const wrappedText = "recorded so\nfar in the log";
      const vWrapped = checkText(wrappedText, "x/SKILL.md", {
        packs: allPacks,
        config: allowAcrossBreak,
        packFilter: ["placement-slop"],
      });
      const hit = vWrapped.find(
        (x) => x.ruleId === "placement-slop/tally-phrase",
      );
      expect(hit).toBeDefined();
      expect(hit?.line).toBe(1);
      expect(hit?.endLine).toBe(2);
    });
  });

  it("with no placement.markers configured, org-marker never fires", () => {
    const text = "anything at all, example-org included";
    const v = checkText(text, "x/SKILL.md", baseOpts());
    expect(
      v.find((x) => x.ruleId === "placement-slop/org-marker"),
    ).toBeUndefined();
  });

  describe("opaque-id URL exclusion", () => {
    it("does not fire on a hex run inside an http(s) URL", () => {
      const v = checkText(
        "https://example.com/commit/deadbeef",
        "x/SKILL.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "placement-slop/opaque-id"),
      ).toBeUndefined();
    });

    it("fires on the same hex string when it is not part of a URL", () => {
      const v = checkText(
        "task deadbeef was blinded",
        "x/SKILL.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "placement-slop/opaque-id"),
      ).toBeDefined();
    });
  });

  it("off by default: the pack does not run without --pack / packs.placement-slop: true", () => {
    const v = checkText("~/work/project/.env 2026-08-24 n=8", "x/SKILL.md", {
      packs: allPacks,
      config: defaultConfig(),
    });
    expect(v.filter((x) => x.pack === "placement-slop")).toHaveLength(0);
  });

  it("enabled via packs.placement-slop: true in config (no --pack needed)", () => {
    const cfg = mergeConfig({ packs: { "placement-slop": true } });
    const v = checkText("~/work/project/.env", "x/SKILL.md", {
      packs: allPacks,
      config: cfg,
    });
    expect(
      v.find((x) => x.ruleId === "placement-slop/home-path"),
    ).toBeDefined();
  });

  it("respects an additive placement.instructionGlobs pattern", () => {
    const cfg = mergeConfig({
      placement: { instructionGlobs: ["**/PLAYBOOK.md"] },
    });
    const v = checkText("~/work/project/.env", "x/PLAYBOOK.md", {
      packs: allPacks,
      config: cfg,
      packFilter: ["placement-slop"],
    });
    expect(
      v.find((x) => x.ruleId === "placement-slop/home-path"),
    ).toBeDefined();

    // A file matching neither the default globs nor the additive one is
    // still untouched.
    const vOther = checkText("~/work/project/.env", "x/NOTES.md", {
      packs: allPacks,
      config: cfg,
      packFilter: ["placement-slop"],
    });
    expect(vOther.filter((x) => x.pack === "placement-slop")).toHaveLength(0);
  });

  it("tolerates a hand-built ResolvedConfig that omits `placement` entirely", () => {
    const cfg = defaultConfig();
    // Simulate a hand-built config from before this pack existed.
    delete (cfg as { placement?: unknown }).placement;
    expect(() =>
      checkText("~/work/project/.env example-org", "x/SKILL.md", {
        packs: allPacks,
        config: cfg,
        packFilter: ["placement-slop"],
      }),
    ).not.toThrow();
  });

  describe("tally-phrase across a line wrap", () => {
    it("fires on 'so far' wrapped across a newline, reporting the first token's line", () => {
      const text = "line one\nline two\nSo\nfar has this held.";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      const hit = v.find((x) => x.ruleId === "placement-slop/tally-phrase");
      expect(hit).toBeDefined();
      expect(hit?.line).toBe(3);
    });

    it("fires on 'the one measured' wrapped across a newline, reporting the first token's line", () => {
      const text = "context\nthe one\nmeasured so far was different.";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      const hit = v.find(
        (x) =>
          x.ruleId === "placement-slop/tally-phrase" && /the/i.test(x.matched),
      );
      expect(hit).toBeDefined();
      expect(hit?.line).toBe(2);
    });

    it("does not fire on 'up to date' (negative lookbehind excludes the currency idiom)", () => {
      const text = "Keep this file up to date as the project evolves.";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/tally-phrase"),
      ).toBeUndefined();
    });

    it("still fires on a standalone 'to date' not preceded by 'up'", () => {
      const text = "No regression has been found to date.";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/tally-phrase"),
      ).toBeDefined();
    });
  });

  describe("URL / markdown-link exclusion (home-path, dated-evidence, opaque-id, tally-phrase)", () => {
    it("home-path does not fire on a /home/ path segment inside a URL", () => {
      const text = "See https://example.com/home/config for the sample.";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/home-path"),
      ).toBeUndefined();
    });

    it("home-path does not fire on an angle-bracket placeholder segment", () => {
      const text = "The token lives at /home/<user>/config on any box.";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/home-path"),
      ).toBeUndefined();
    });

    it("home-path still fires on a real-looking container account path (documented limitation)", () => {
      const text = "mount the volume at /home/node/app in the container.";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/home-path"),
      ).toBeDefined();
    });

    it("dated-evidence does not fire on a date-shaped URL path segment", () => {
      const text = "Report: https://example.com/reports/2026-08-24/summary.md";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/dated-evidence"),
      ).toBeUndefined();
    });

    it("dated-evidence still fires on a bare date outside a URL", () => {
      const text = "Measured on 2026-08-24 during the sweep.";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/dated-evidence"),
      ).toBeDefined();
    });

    it("tally-phrase does not fire on n= / p= query params inside a URL", () => {
      const text =
        "See https://example.com/results?n=8&p=0.016 for the raw numbers.";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/tally-phrase"),
      ).toBeUndefined();
    });

    it("tally-phrase still fires on 'n=8' outside a URL", () => {
      const text = "the A/B measurement (n=8) held up under review";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/tally-phrase"),
      ).toBeDefined();
    });
  });

  describe("opaque-id refinements", () => {
    it("does not fire on an all-digit 8-char run", () => {
      const v = checkText("build 12345678 shipped", "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/opaque-id"),
      ).toBeUndefined();
    });

    it("does not fire on an 8-digit date written without dashes", () => {
      const v = checkText("as of 20260824 this held", "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/opaque-id"),
      ).toBeUndefined();
    });

    it("does not fire on an 8-hex run immediately preceded by '#' (color / anchor)", () => {
      const v = checkText("background: #aabbccdd;", "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/opaque-id"),
      ).toBeUndefined();
    });

    it("does not fire on a hex run inside a markdown link target", () => {
      const v = checkText(
        "See [x](../commits/deadbeef) for details.",
        "x/SKILL.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "placement-slop/opaque-id"),
      ).toBeUndefined();
    });

    it("fires on the same hex string used as a bare reference", () => {
      const v = checkText(
        "task deadbeef was blinded",
        "x/SKILL.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "placement-slop/opaque-id"),
      ).toBeDefined();
    });

    it("does not fire on a 40-char SHA (no internal 8-char word boundary)", () => {
      const v = checkText(
        "commit abcdef0123456789abcdef0123456789abcdef01 landed",
        "x/SKILL.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "placement-slop/opaque-id"),
      ).toBeUndefined();
    });
  });

  describe("org-marker: case sensitivity, per-line matching, and the violation cap", () => {
    it("markers are matched case-sensitively (no implicit 'i' flag)", () => {
      const cfg = mergeConfig({ placement: { markers: ["example-org"] } });
      const opts = {
        packs: allPacks,
        config: cfg,
        packFilter: ["placement-slop"],
      };

      const lower = checkText("run the example-org sweep", "x/SKILL.md", opts);
      expect(
        lower.find((x) => x.ruleId === "placement-slop/org-marker"),
      ).toBeDefined();

      const upper = checkText("run the EXAMPLE-ORG sweep", "x/SKILL.md", opts);
      expect(
        upper.find((x) => x.ruleId === "placement-slop/org-marker"),
      ).toBeUndefined();
    });

    it("caps org-marker violations per rule per file", () => {
      const lines = Array.from(
        { length: 60 },
        (_, i) => `line ${i} example-org`,
      );
      const cfg = mergeConfig({ placement: { markers: ["example-org"] } });
      const v = checkText(lines.join("\n"), "x/SKILL.md", {
        packs: allPacks,
        config: cfg,
        packFilter: ["placement-slop"],
      });
      expect(
        v.filter((x) => x.ruleId === "placement-slop/org-marker"),
      ).toHaveLength(50);
    });
  });

  describe("disable comments scoped to placement-slop", () => {
    it("disable-line suppresses a single placement rule on that line", () => {
      const text =
        "Set the token from ~/work/project/.env <!-- slop-detector:disable-line=placement-slop/home-path -->";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/home-path"),
      ).toBeUndefined();
    });

    it("disable-next-line scoped to the whole pack suppresses every placement rule on the next line", () => {
      const text =
        "<!-- slop-detector:disable-next-line=placement-slop -->\nSet the token from ~/work/project/.env";
      const v = checkText(text, "x/SKILL.md", baseOpts());
      expect(v.filter((x) => x.pack === "placement-slop")).toHaveLength(0);
    });
  });

  describe("globToRegex: '**/' anchors on a path segment (finding placement-slop/#7)", () => {
    it("does not treat docs/SUBAGENTS.md as an AGENTS.md instruction file", () => {
      const v = checkText(
        "~/work/project/.env example-org",
        "docs/SUBAGENTS.md",
        {
          packs: allPacks,
          config: mergeConfig({ placement: { markers: ["example-org"] } }),
          packFilter: ["placement-slop"],
        },
      );
      expect(v.filter((x) => x.pack === "placement-slop")).toHaveLength(0);
    });

    it("does not treat docs/MYSKILL.md as a SKILL.md instruction file", () => {
      const v = checkText(
        "~/work/project/.env example-org",
        "docs/MYSKILL.md",
        {
          packs: allPacks,
          config: mergeConfig({ placement: { markers: ["example-org"] } }),
          packFilter: ["placement-slop"],
        },
      );
      expect(v.filter((x) => x.pack === "placement-slop")).toHaveLength(0);
    });

    it("still treats a real AGENTS.md as an instruction file", () => {
      const v = checkText("~/work/project/.env", "docs/AGENTS.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "placement-slop/home-path"),
      ).toBeDefined();
    });
  });
});

describe("placement-slop: scan-root-relative instructionGlobs (via checkPath)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-placement-root-"));
    fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "sub", "PLAYBOOK.md"),
      "Set the token from ~/work/project/.env before running.\n",
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("matches an additive instructionGlobs pattern the same way for a relative, ./-prefixed, and absolute scan path", () => {
    // `checkPath`'s scanRoot is the exact directory string it's given (see
    // README's "Marking a src barrel as an entrypoint" for the sibling
    // convention on `entrypointGlobs`), so all three invocations here scan
    // `tmp` — the glob is written relative to `tmp`, matching its child
    // `sub/PLAYBOOK.md`. Before this fix, three different string spellings
    // of the same directory produced three different (raw, unrelativized)
    // match results; after it, `path.resolve` collapses all three to the
    // same absolute scanRoot, so the relative path — and the match — is
    // identical regardless of which form was passed.
    const relRoot = path.relative(process.cwd(), tmp);
    const dotRoot = "./" + relRoot;

    const cfg = mergeConfig({
      packs: { "placement-slop": true },
      placement: { instructionGlobs: ["sub/**/*.md"] },
    });
    const opts = {
      packs: allPacks,
      config: cfg,
      packFilter: ["placement-slop"],
    };

    const relative = checkPath(relRoot, opts);
    const dotPrefixed = checkPath(dotRoot, opts);
    const absolute = checkPath(tmp, opts);

    for (const summary of [relative, dotPrefixed, absolute]) {
      expect(summary.filesScanned).toBe(1);
      expect(
        summary.violations.find((v) => v.ruleId === "placement-slop/home-path"),
      ).toBeDefined();
    }
  });

  it("surfaces a warning when a placement.instructionGlobs pattern matches no scanned files", () => {
    const cfg = mergeConfig({
      packs: { "placement-slop": true },
      placement: { instructionGlobs: ["sub/**/*.md", "sub/**/TYPO.md"] },
    });
    const summary = checkPath(tmp, {
      packs: allPacks,
      config: cfg,
      packFilter: ["placement-slop"],
    });
    expect(
      summary.warnings?.some((w) =>
        w.includes('placement.instructionGlobs pattern "sub/**/TYPO.md"'),
      ),
    ).toBe(true);
  });

  it("does not warn when every instructionGlobs pattern matches a scanned file", () => {
    const cfg = mergeConfig({
      packs: { "placement-slop": true },
      placement: { instructionGlobs: ["sub/**/*.md"] },
    });
    const summary = checkPath(tmp, {
      packs: allPacks,
      config: cfg,
      packFilter: ["placement-slop"],
    });
    expect(summary.warnings).toBeUndefined();
  });

  // ── single-file scan-root regression (round-3 fix) ──────────────────────
  //
  // `checkPath(<file>)` used to set `scanRoot: options.scanRoot ?? rootPath`
  // even when `rootPath` is a file, so `path.relative(scanRoot, file)` came
  // out `""` and no instruction glob (built-in or configured) could ever
  // match: `checkPath(<file>)` silently reported zero violations while
  // scanning the same file's parent directory found them fine. Fixed by
  // routing every scan-root derivation through one `resolveScanRoot`
  // helper that dirnames a file target.

  it("(a) checkPath on a single FILE with a configured instructionGlobs pattern fires home-path", () => {
    const filePath = path.join(tmp, "sub", "PLAYBOOK.md");
    const cfg = mergeConfig({
      packs: { "placement-slop": true },
      placement: { instructionGlobs: ["**/PLAYBOOK.md"] },
    });
    const summary = checkPath(filePath, {
      packs: allPacks,
      config: cfg,
      packFilter: ["placement-slop"],
    });
    expect(summary.filesScanned).toBe(1);
    expect(
      summary.violations.find((v) => v.ruleId === "placement-slop/home-path"),
    ).toBeDefined();
  });

  it("(b) checkPath on a single default-glob FILE (SKILL.md) fires home-path with no placement config", () => {
    const filePath = path.join(tmp, "SKILL.md");
    fs.writeFileSync(
      filePath,
      "Set the token from ~/work/project/.env before running.\n",
    );
    const summary = checkPath(filePath, {
      packs: allPacks,
      config: mergeConfig({ packs: { "placement-slop": true } }),
      packFilter: ["placement-slop"],
    });
    expect(summary.filesScanned).toBe(1);
    expect(
      summary.violations.find((v) => v.ruleId === "placement-slop/home-path"),
    ).toBeDefined();
  });

  it("(c) a single-file target and its parent-directory target report the same violations for that file", () => {
    const filePath = path.join(tmp, "SKILL.md");
    fs.writeFileSync(
      filePath,
      "Set the token from ~/work/project/.env before running.\n",
    );
    const opts = {
      packs: allPacks,
      config: mergeConfig({ packs: { "placement-slop": true } }),
      packFilter: ["placement-slop"],
    };

    const fileSummary = checkPath(filePath, opts);
    const dirSummary = checkPath(tmp, opts);

    const shape = (v: (typeof fileSummary.violations)[number]) => ({
      ruleId: v.ruleId,
      line: v.line,
      column: v.column,
      matched: v.matched,
    });
    const fileViolationsForFile = fileSummary.violations
      .filter((v) => v.path === filePath)
      .map(shape);
    const dirViolationsForFile = dirSummary.violations
      .filter((v) => v.path === filePath)
      .map(shape);

    expect(fileViolationsForFile.length).toBeGreaterThan(0);
    expect(fileViolationsForFile).toEqual(dirViolationsForFile);
  });

  it("(e) ctx.scanRoot seen by a rule is always an absolute directory, even from a relative invocation after a cwd change", () => {
    const seenScanRoots: string[] = [];
    const probeRule: Rule = {
      id: "placement-slop/__scanroot-probe",
      pack: "placement-slop",
      defaultSeverity: "info",
      enabledByDefault: true,
      rationale: "test probe: records ctx.scanRoot, fires no violations.",
      appliesTo: () => true,
      check(ctx: RuleContext) {
        if (ctx.scanRoot) seenScanRoots.push(ctx.scanRoot);
        return [];
      },
    };
    const probePack: PackDefinition = {
      id: "placement-slop",
      description: "test probe pack",
      rules: [probeRule],
    };

    const originalCwd = process.cwd();
    process.chdir(tmp);
    let summary: ReturnType<typeof checkPath>;
    try {
      summary = checkPath("sub/PLAYBOOK.md", {
        packs: [probePack],
        config: mergeConfig({ packs: { "placement-slop": true } }),
        packFilter: ["placement-slop"],
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(summary.filesScanned).toBe(1);
    expect(seenScanRoots.length).toBeGreaterThan(0);
    for (const root of seenScanRoots) {
      expect(path.isAbsolute(root)).toBe(true);
    }
  });
});

// ── monorepo package-README rollout regression (agent-tasks 80e4743d) ─────
//
// A `packages/*/README.md` instructionGlobs entry is meant to widen
// coverage to every package's own README while leaving the monorepo's
// own root README.md alone (it is the repo overview, not a package's
// doc). Fixture-root test since the glob is scan-root-relative: a
// `checkText` call has no real directory tree to relativize against.

describe("placement-slop: packages/*/README.md rollout (agent-dx #80e4743d)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-placement-readmes-"));
    fs.mkdirSync(path.join(tmp, "packages", "x"), { recursive: true });
    const evidenceLine =
      "As of 2026-08-24 (n=8), the low tier reached accept a median 320 seconds slower.\n";
    fs.writeFileSync(path.join(tmp, "packages", "x", "README.md"), evidenceLine);
    fs.writeFileSync(path.join(tmp, "README.md"), evidenceLine);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("flags a package README but not the repo-root README under a packages/*/README.md glob", () => {
    const cfg = mergeConfig({
      packs: { "placement-slop": true },
      placement: { instructionGlobs: ["packages/*/README.md"] },
    });
    const summary = checkPath(tmp, {
      packs: allPacks,
      config: cfg,
      packFilter: ["placement-slop"],
    });

    const packageReadmePath = path.join(tmp, "packages", "x", "README.md");
    const rootReadmePath = path.join(tmp, "README.md");

    expect(
      summary.violations.some(
        (v) =>
          v.path === packageReadmePath &&
          v.ruleId === "placement-slop/dated-evidence",
      ),
    ).toBe(true);
    expect(
      summary.violations.some((v) => v.path === rootReadmePath),
    ).toBe(false);
  });
});

// ── allow-narrowness: a bare "~/" allow must not excuse a real username ───
//
// `placement.allow: ["~/"]` is meant to excuse only the two literal
// characters "~/" (a portable, generic idiom), never a path that also
// carries a real machine-bound username. A single shared allow-span
// computation feeds every rule in the pack, so this is a genuine risk: a
// broad or careless allow pattern could silently widen past its intended
// two characters. These lines pair the generic idiom with a
// machine-bound form on the SAME line, so `home-path` must still fire on
// the machine-bound span even though the "~/" span right next to it is
// excused.

describe("placement-slop: a bare '~/' allow entry stays narrow", () => {
  const cfg = mergeConfig({
    packs: { "placement-slop": true },
    placement: { allow: ["~/"] },
  });
  const opts = {
    packs: allPacks,
    config: cfg,
    packFilter: ["placement-slop"],
  };

  it("still fires on /Users/<name>/ sharing a line with a ~/ idiom", () => {
    const v = checkText(
      "Use ~/git for scratch clones; the real one lives at /Users/lannguyensi/git/pandora.",
      "x/SKILL.md",
      opts,
    );
    const hit = v.find((x) => x.ruleId === "placement-slop/home-path");
    expect(hit).toBeDefined();
    expect(hit?.matched).toBe("/Users/lannguyensi/");
  });

  it("still fires on /home/<name>/ sharing a line with a ~/ idiom", () => {
    const v = checkText(
      "Prefer ~/git over the container path /home/lannguyensi/git for this.",
      "x/SKILL.md",
      opts,
    );
    const hit = v.find((x) => x.ruleId === "placement-slop/home-path");
    expect(hit).toBeDefined();
    expect(hit?.matched).toBe("/home/lannguyensi/");
  });

  it("still fires on $HOME/ sharing a line with a ~/ idiom", () => {
    const v = checkText(
      "Either ~/git or $HOME/git works, but scripts should use $HOME/git.",
      "x/SKILL.md",
      opts,
    );
    const hit = v.find((x) => x.ruleId === "placement-slop/home-path");
    expect(hit).toBeDefined();
    expect(hit?.matched).toBe("$HOME/");
  });

  it("does not fire at all on a bare ~/ idiom alone", () => {
    const v = checkText("Clone your work into ~/git before running the sweep.", "x/SKILL.md", opts);
    expect(v.filter((x) => x.pack === "placement-slop")).toHaveLength(0);
  });
});

// ── lowercase org-marker vs. a legitimate lowercase GitHub URL ────────────
//
// The lowercase "lannguyensi" placement.markers entry (added to catch this
// org's lowercase machine-path convention, see the fixture above) is a
// bare-substring, case-sensitive match with no automatic URL exclusion:
// org-marker does not run computeExcludedSpans the way home-path/
// dated-evidence/tally-phrase/opaque-id do (see README's `allow` section),
// so a real, legitimate lowercase GitHub URL for this same org
// (https://github.com/lannguyensi/...) would otherwise fire org-marker
// unless a matching lowercase allow entry excuses it explicitly.

describe("placement-slop: lowercase org-marker vs. a lowercase GitHub URL allow", () => {
  const cfg = mergeConfig({
    packs: { "placement-slop": true },
    placement: {
      markers: ["LanNguyenSi", "lannguyensi"],
      allow: [
        "https://github\\.com/LanNguyenSi/",
        "https://raw\\.githubusercontent\\.com/LanNguyenSi/",
        "https://github\\.com/lannguyensi/",
        "https://raw\\.githubusercontent\\.com/lannguyensi/",
      ],
    },
  });
  const opts = {
    packs: allPacks,
    config: cfg,
    packFilter: ["placement-slop"],
  };

  it("does not fire org-marker on a lowercase github.com URL for this org", () => {
    const v = checkText(
      "See https://github.com/lannguyensi/somerepo for details.",
      "x/SKILL.md",
      opts,
    );
    expect(v.filter((x) => x.pack === "placement-slop")).toHaveLength(0);
  });

  it("still fires org-marker on a lowercase non-URL occurrence", () => {
    const v = checkText("Clone via ~/../lannguyensi/x before running.", "x/SKILL.md", opts);
    const hit = v.find((x) => x.ruleId === "placement-slop/org-marker");
    expect(hit).toBeDefined();
    expect(hit?.matched).toBe("lannguyensi");
  });
});

// ── real repo-root slop.config.yml, loaded and parsed for real ────────────
//
// Every other test in this file exercises the pack's mechanics against an
// inline `mergeConfig` fixture; none of them read the actual root
// `slop.config.yml` this repo's `placement-guard` CI job runs against, so
// a typo or an accidental revert to that file could pass every other test
// here while leaving the CI job's real coverage silently narrower (or
// wider) than intended. Loads and parses the real file with the pack's
// own `loadConfig`, resolved relative to this test file rather than to
// `process.cwd()` (which vitest may or may not set to the repo root).

describe("placement-slop: the actual repo-root slop.config.yml (agent-dx #80e4743d)", () => {
  const repoRootConfigPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "slop.config.yml",
  );

  it("covers packages/*/README.md and keeps '~/' as the only bare home-idiom allow entry", () => {
    const cfg = loadConfig(repoRootConfigPath);

    expect(cfg.placement?.instructionGlobs).toContain("packages/*/README.md");

    // "Bare" here means the tilde form on its own, with no username or
    // placeholder attached, as opposed to e.g. "/Users/you/", which is
    // also a home-idiom allow entry but names a specific placeholder, not
    // a bare shorthand. Only one entry should start with "~" at all, and
    // it should be the exact narrow "~/" this rollout was measured
    // against, not some wider variant (a bare "~", a "~.*" pattern, ...)
    // that would silently widen what the allow excuses.
    const tildeEntries = (cfg.placement?.allow ?? []).filter((p) =>
      p.startsWith("~"),
    );
    expect(tildeEntries).toEqual(["~/"]);
  });
});

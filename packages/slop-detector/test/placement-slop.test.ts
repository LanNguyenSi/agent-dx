import { describe, it, expect } from "vitest";
import { checkText } from "../src/engine.js";
import { defaultConfig, mergeConfig } from "../src/config.js";
import { allPacks } from "../src/packs/registry.js";

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
    const v = checkText("~/git/pandora/.env 2026-08-24 n=8", "x/SKILL.md", {
      packs: allPacks,
      config: defaultConfig(),
    });
    expect(v.filter((x) => x.pack === "placement-slop")).toHaveLength(0);
  });

  it("enabled via packs.placement-slop: true in config (no --pack needed)", () => {
    const cfg = mergeConfig({ packs: { "placement-slop": true } });
    const v = checkText("~/git/pandora/.env", "x/SKILL.md", {
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
    const v = checkText("~/git/pandora/.env", "x/PLAYBOOK.md", {
      packs: allPacks,
      config: cfg,
      packFilter: ["placement-slop"],
    });
    expect(
      v.find((x) => x.ruleId === "placement-slop/home-path"),
    ).toBeDefined();

    // A file matching neither the default globs nor the additive one is
    // still untouched.
    const vOther = checkText("~/git/pandora/.env", "x/NOTES.md", {
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
      checkText("~/git/pandora/.env example-org", "x/SKILL.md", {
        packs: allPacks,
        config: cfg,
        packFilter: ["placement-slop"],
      }),
    ).not.toThrow();
  });
});

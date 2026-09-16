import { describe, it, expect } from "vitest";
import { checkText } from "../src/engine.js";
import { defaultConfig, mergeConfig } from "../src/config.js";
import { allPacks } from "../src/packs/registry.js";

const baseOpts = () => ({
  packs: allPacks,
  config: defaultConfig(),
  packFilter: ["review-slop"],
});

describe("review-slop", () => {
  describe("finding-id (Markdown)", () => {
    it("fires on a bare finding-id token", () => {
      const v = checkText("See F1 for the fix.", "docs/NOTES.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeDefined();
    });

    it("fires on a lettered finding-id token", () => {
      const v = checkText(
        "Addressed in F2a of the review.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeDefined();
    });

    it("fires twice on a slash-joined finding-id crossover line", () => {
      const v = checkText(
        "F2/F5 crossover: both fixed together.",
        "docs/NOTES.md",
        baseOpts(),
      );
      const hits = v.filter((x) => x.ruleId === "review-slop/finding-id");
      expect(hits).toHaveLength(2);
      expect(hits.map((h) => h.matched).sort()).toEqual(["F2", "F5"]);
    });

    it("fires inside a 'finding'-prefixed id", () => {
      const v = checkText(
        "Fixed per finding F5 above.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeDefined();
    });

    it("negative: an 8-hex tracker id does not fire", () => {
      const v = checkText(
        "See tracker task e904f25a for context.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeUndefined();
    });

    it("negative: version numbers do not fire", () => {
      const v = checkText(
        "Upgraded to v1.2.3 (was 1.0).",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeUndefined();
    });

    it("negative: a two-digit F-number does not fire", () => {
      const v = checkText(
        "Pressed F16 to open the debug menu; F22 and F12 do nothing here.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeUndefined();
    });

    it("negative: an F-number immediately followed by a hyphenated year does not fire", () => {
      const v = checkText(
        "Filed under F1-2026 in the archive.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeUndefined();
    });

    it("negative: a finding-id-shaped key name inside a fenced code block does not fire", () => {
      const text = ["```json", '{ "F1": "value" }', "```"].join("\n");
      const v = checkText(text, "docs/NOTES.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeUndefined();
    });

    it("negative: a finding-id-shaped key name inside a tilde-fenced code block does not fire", () => {
      const text = ["~~~json", '{ "F1": "value" }', "~~~"].join("\n");
      const v = checkText(text, "docs/NOTES.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeUndefined();
    });
  });

  describe("round-reference (Markdown)", () => {
    it("fires on a round-plus-digit reference", () => {
      const v = checkText(
        "Fixed in round 2 of the review.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeDefined();
    });

    it("fires on a bare round-letter token", () => {
      // A bare `R3` needs a review-process context word in the same
      // sentence (an isolated `R3` reads as a Cloudflare bucket, a
      // model name suffix, etc. -- see the "negative: a bare round-letter
      // token with no review context" test below).
      const v = checkText(
        "Landed the fix at R3 after review.",
        "docs/NOTES.md",
        baseOpts(),
      );
      const hit = v.find((x) => x.ruleId === "review-slop/round-reference");
      expect(hit).toBeDefined();
      expect(hit?.matched).toBe("R3");
    });

    it("negative: a bare round-letter token with no review context does not fire", () => {
      const v = checkText(
        "Cloudflare R2 storage backs the CDN.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeUndefined();
    });

    it("negative: a hyphen-adjacent bare token with no review context does not fire", () => {
      const v = checkText(
        "Benchmarked against DeepSeek-R1 on the same prompts.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeUndefined();
    });

    it("fires on a review-cycle-plus-digit phrase", () => {
      const v = checkText(
        "This is the review round 1 fixes commit.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeDefined();
    });

    it("negative: a digitless 'review round' phrase does not fire", () => {
      // The kit's own shipped vocabulary uses this exact digitless phrase
      // (e.g. `assets/agents/reviewer.md`'s "review round" prose) to name
      // its own review-round mechanism generically; only a *specific
      // numbered* round is run-local evidence, so the pack never fires on
      // this phrase at all, at any severity, regardless of context words.
      const v = checkText(
        "Deferred to the next review round.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeUndefined();
    });

    it("negative: a hyphenated round-N cross-reference does not fire (round-word requires whitespace)", () => {
      const v = checkText(
        "See the round-2 review discussion below.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeUndefined();
    });

    it("negative: 'round 2' with no review-process context in the sentence does not fire", () => {
      const v = checkText(
        "## Round 2\n\nThe DNS retry runs round 2 of the backoff schedule.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeUndefined();
    });

    it("fires when the context word is one soft-wrapped line above the match, in the same paragraph (dogfood regression)", () => {
      // A hand-wrapped Markdown paragraph (no blank line) puts the
      // context word ("findings") on the line above the match; a single
      // `\n` inside a paragraph must not truncate the sentence window,
      // or this regresses to the bug this pack's own dogfood run over
      // `docs/okf/log.md` found: a context word one wrapped line away
      // was wrongly invisible.
      const text =
        "The changed-files-only scan now reports 7 and 16 block findings\n(down from round 1's 21 and 29), while still reporting more.";
      const v = checkText(text, "docs/NOTES.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeDefined();
    });

    it("negative: a context word in a different (blank-line-separated) paragraph does not count", () => {
      const text =
        "Some review findings landed earlier.\n\nSeparately, round 2 of the DNS retry ran fine.";
      const v = checkText(text, "docs/NOTES.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeUndefined();
    });

    it("negative: round-trip does not fire", () => {
      const v = checkText(
        "Measures the round-trip latency.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeUndefined();
    });

    it("negative: Math.round( does not fire", () => {
      const v = checkText(
        "Calls Math.round(value) to normalize.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeUndefined();
    });

    it("negative: 'rounds' as a bare plural noun does not fire", () => {
      const v = checkText(
        "We ran two rounds of interviews.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeUndefined();
    });

    it("negative: a round-letter-shaped resistor label inside a fenced code block does not fire", () => {
      const text = ["```", "R1 --- 220 ohm --- GND", "```"].join("\n");
      const v = checkText(text, "docs/NOTES.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeUndefined();
    });
  });

  describe("handoff-phrase (Markdown)", () => {
    it("fires (warn) on a workspace-handoff phrase", () => {
      const v = checkText(
        "Read per the pandora handoffs before starting.",
        "docs/NOTES.md",
        baseOpts(),
      );
      const hit = v.find((x) => x.ruleId === "review-slop/handoff-phrase");
      expect(hit).toBeDefined();
      expect(hit?.severity).toBe("warn");
    });

    it("negative: an unrelated sentence does not fire", () => {
      const v = checkText(
        "Read the install guide before starting.",
        "docs/NOTES.md",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/handoff-phrase"),
      ).toBeUndefined();
    });
  });

  describe("severities", () => {
    it("finding-id and round-reference default to block, handoff-phrase to warn", () => {
      const text = "F1 landed in review round 2, per the pandora handoffs.";
      const v = checkText(text, "docs/NOTES.md", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id")?.severity,
      ).toBe("block");
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference")?.severity,
      ).toBe("block");
      expect(
        v.find((x) => x.ruleId === "review-slop/handoff-phrase")?.severity,
      ).toBe("warn");
    });
  });

  describe("TS/JS source comments", () => {
    it("fires on a finding id inside a line comment", () => {
      const text = [
        "function fix() {",
        "  // Mutation-check intent (F1, review R1)",
        "  return true;",
        "}",
      ].join("\n");
      const v = checkText(text, "src/fix.ts", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeDefined();
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeDefined();
    });

    it("fires on a round reference inside a block comment", () => {
      const text = [
        "/**",
        " * review round 2 finding F5",
        " */",
        "function fix() {}",
      ].join("\n");
      const v = checkText(text, "src/fix.ts", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeDefined();
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeDefined();
    });

    it("negative: an 8-hex tracker id in a comment does not fire", () => {
      const text = ["// tracked as e904f25a", "function fix() {}"].join("\n");
      const v = checkText(text, "src/fix.ts", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeUndefined();
    });

    it("a non-TS/JS code file (e.g. .py) is not scanned", () => {
      const text = "# F1 round 2 per the pandora handoffs";
      const v = checkText(text, "src/fix.py", baseOpts());
      expect(v).toHaveLength(0);
    });
  });

  describe("test titles", () => {
    it("fires on a finding id in an it() title", () => {
      const text =
        'it("F1: mutation-check intent", () => { expect(1).toBe(1); });';
      const v = checkText(text, "src/fix.test.ts", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeDefined();
    });

    it("fires twice on a describe.skip crossover title", () => {
      const text =
        'describe.skip("F2/F5 crossover:", () => { it("x", () => {}); });';
      const v = checkText(text, "src/fix.test.ts", baseOpts());
      const hits = v.filter((x) => x.ruleId === "review-slop/finding-id");
      expect(hits).toHaveLength(2);
    });

    it("fires on a finding id in a tagged it.each(table)(title, fn) title", () => {
      const text =
        'it.each(table)("F1: kills the mutant", ({ x }) => { expect(x).toBe(1); });';
      const v = checkText(text, "src/fix.test.ts", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeDefined();
    });

    it("fires on a round reference in a test() title", () => {
      const text = 'test("review round 1 fixes the bug", () => {});';
      const v = checkText(text, "src/fix.test.ts", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeDefined();
    });

    it("negative: an ordinary title with no review tokens does not fire", () => {
      const text = 'it("computes the total", () => { expect(1).toBe(1); });';
      const v = checkText(text, "src/fix.test.ts", baseOpts());
      expect(v).toHaveLength(0);
    });

    it("negative: a finding-id token in a non-test string literal (not a title) does not fire", () => {
      const text = 'const key = "F1";';
      const v = checkText(text, "src/fix.ts", baseOpts());
      expect(v).toHaveLength(0);
    });
  });

  describe("commit-message file", () => {
    it("fires on --stdin-path COMMIT_MSG carrying finding ids and round references", () => {
      const text = [
        "fix: address review feedback",
        "",
        "Fixes F1 and F2a from review round 2.",
      ].join("\n");
      const v = checkText(text, "COMMIT_MSG", baseOpts());
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeDefined();
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeDefined();
    });

    it("fires on a real .git/COMMIT_EDITMSG path", () => {
      const v = checkText(
        "fix: apply F1 from round 2",
        ".git/COMMIT_EDITMSG",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeDefined();
    });

    it("fires on a .commitmsg path", () => {
      const v = checkText(
        "fix: apply F1 from round 2",
        "tmp/msg.commitmsg",
        baseOpts(),
      );
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeDefined();
    });

    it("negative: an ordinary commit message with no review tokens does not fire", () => {
      const v = checkText(
        "fix: correct the off-by-one in the paginator",
        "COMMIT_MSG",
        baseOpts(),
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("review.allow suppresses a match", () => {
    it("an allow pattern excuses the matched span, and only the matched span", () => {
      const withAllow = mergeConfig({ review: { allow: ["F1"] } });
      const text = "F1 and F2 both need review.";
      const vAllowed = checkText(text, "docs/NOTES.md", {
        packs: allPacks,
        config: withAllow,
        packFilter: ["review-slop"],
      });
      expect(vAllowed.find((x) => x.matched === "F1")).toBeUndefined();
      expect(vAllowed.find((x) => x.matched === "F2")).toBeDefined();

      const withoutAllow = defaultConfig();
      const vBlocked = checkText(text, "docs/NOTES.md", {
        packs: allPacks,
        config: withoutAllow,
        packFilter: ["review-slop"],
      });
      expect(vBlocked.find((x) => x.matched === "F1")).toBeDefined();
    });

    it("an allow pattern can excuse a match that spans a line break", () => {
      // `\bround\s+\d+\b` matches across a line break (`\s+` includes
      // `\n`); the allow-span computation used to run per line, so it
      // could never cover a match like this one. Scanned over the whole
      // text instead, the allow pattern can excuse it too.
      const text = "Fixed per review round\n2 needs no further action.";
      const withAllow = mergeConfig({ review: { allow: ["round\\n2"] } });
      const vAllowed = checkText(text, "docs/NOTES.md", {
        packs: allPacks,
        config: withAllow,
        packFilter: ["review-slop"],
      });
      expect(
        vAllowed.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeUndefined();

      const withoutAllow = defaultConfig();
      const vBlocked = checkText(text, "docs/NOTES.md", {
        packs: allPacks,
        config: withoutAllow,
        packFilter: ["review-slop"],
      });
      expect(
        vBlocked.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeDefined();
    });
  });

  describe("review.allowPaths (CHANGELOG default)", () => {
    it("a CHANGELOG.md path is clean by default even with review tokens", () => {
      const text = "- Fixed F1 in round 2 (review round 1 fixes).";
      const v = checkText(text, "packages/foo/CHANGELOG.md", baseOpts());
      expect(v).toHaveLength(0);
    });

    it("emptying review.allowPaths makes the same CHANGELOG.md text flag", () => {
      const emptied = mergeConfig({ review: { allowPaths: [] } });
      const text = "- Fixed F1 in round 2.";
      const v = checkText(text, "packages/foo/CHANGELOG.md", {
        packs: allPacks,
        config: emptied,
        packFilter: ["review-slop"],
      });
      expect(
        v.find((x) => x.ruleId === "review-slop/finding-id"),
      ).toBeDefined();
      expect(
        v.find((x) => x.ruleId === "review-slop/round-reference"),
      ).toBeDefined();
    });

    it("a non-default allowPaths glob is honored", () => {
      const custom = mergeConfig({
        review: { allowPaths: ["**/NOTES.md"] },
      });
      const v = checkText("F1 in round 2", "docs/NOTES.md", {
        packs: allPacks,
        config: custom,
        packFilter: ["review-slop"],
      });
      expect(v).toHaveLength(0);
    });

    it("a leading './' in a configured allowPaths glob still matches", () => {
      const custom = mergeConfig({
        review: { allowPaths: ["./docs/NOTES.md"] },
      });
      const v = checkText("F1 in round 2", "docs/NOTES.md", {
        packs: allPacks,
        config: custom,
        packFilter: ["review-slop"],
      });
      expect(v).toHaveLength(0);
    });

    it("a hand-built ResolvedConfig omitting `review` entirely still applies the CHANGELOG default", () => {
      const withoutReview = {
        packs: { ...defaultConfig().packs },
        ruleOverrides: {},
        ignorePaths: [],
        treatAsProse: [],
        treatAsCode: [],
      };
      const v = checkText(
        "- Fixed F1 in round 2 (review round 1 fixes).",
        "packages/foo/CHANGELOG.md",
        { packs: allPacks, config: withoutReview, packFilter: ["review-slop"] },
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("off by default", () => {
    it("review-slop does not run without --pack review-slop", () => {
      const v = checkText(
        "F1 landed in round 2, per the pandora handoffs.",
        "docs/NOTES.md",
        { packs: allPacks, config: defaultConfig() },
      );
      expect(v.filter((x) => x.pack === "review-slop")).toHaveLength(0);
    });

    it("packs.review-slop: true in config also enables it without --pack", () => {
      const enabled = mergeConfig({ packs: { "review-slop": true } });
      const v = checkText("F1 landed in round 2.", "docs/NOTES.md", {
        packs: allPacks,
        config: enabled,
      });
      expect(v.filter((x) => x.pack === "review-slop").length).toBeGreaterThan(
        0,
      );
    });
  });
});

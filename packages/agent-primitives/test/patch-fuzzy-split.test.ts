import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isNormalizationBoundary,
  MATCH_TIERS,
  normalizeForTier,
  PrefixProbe,
} from "../src/patch/engine.js";
import { patch } from "../src/patch/index.js";

/**
 * The candidate-end search of the fuzzy split (`matchesInOriginal` in
 * `src/patch/engine.ts`) reads each candidate end through a `PrefixProbe`
 * that normalizes incrementally. Two things are pinned here: the probe
 * answers exactly what a fresh normalization of the slice answers, at every
 * end, and a long single line with two adjacent unicode-tier edits is no
 * longer quadratic.
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-fuzzy-split-")),
  );
  tmpDirs.push(dir);
  return dir;
}

/** Contexts that stand in front of a character: marks that reorder and
 * compose, Hangul jamo, a lone surrogate, a fullwidth letter. */
const CONTEXTS = [
  "",
  "a",
  "L\u0304",
  "L\u0304\u0323",
  "\u0301",
  "\u3099",
  "x\u0323\u0304",
  "\u1100",
  "\u1100\u1161",
  "\u1112\u1161",
  "\uAC00",
  "\uD83D",
  "\uFF3A",
  "\u0B47",
  "\u09C7",
];

describe("patch: the normalization boundary of the fuzzy split", () => {
  it("every boundary character is stable under NFKC and combines with nothing before it", () => {
    const bad: string[] = [];
    let count = 0;
    for (let code = 0; code <= 0xffff; code++) {
      if (!isNormalizationBoundary(code)) continue;
      count += 1;
      const c = String.fromCharCode(code);
      if (c.normalize("NFKC") !== c) {
        bad.push(`U+${code.toString(16)} changes under NFKC`);
        continue;
      }
      for (const a of CONTEXTS) {
        if ((a + c).normalize("NFKC") !== a.normalize("NFKC") + c) {
          bad.push(`U+${code.toString(16)} after ${JSON.stringify(a)}`);
          break;
        }
      }
    }
    expect(bad).toEqual([]);
    expect(count).toBeGreaterThan(20_000);
  });

  it("surrogate halves, combining marks and Hangul jamo are no boundary", () => {
    for (const code of [
      0xd83d, 0xde00, 0x0301, 0x0323, 0x3099, 0x1161, 0x11a8,
    ]) {
      expect(isNormalizationBoundary(code), code.toString(16)).toBe(false);
    }
  });
});

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "a",
  "b",
  "Z",
  " ",
  " ",
  "\t",
  "\n",
  "\n",
  "\u00A0",
  "\u3000",
  "\u2028",
  "L",
  "\u0304",
  "\u0323",
  "\u0301",
  "\uFF3A",
  "\uFF21",
  "\u1E38",
  "\uFB01",
  "\u4E2D",
  "\u1100",
  "\u1161",
  "\u11A8",
  "\uAC00",
  "\u30AB",
  "\u3099",
  "\u2019",
  "\u2014",
  "\u00E9",
  "e",
  "\uD83D\uDE00",
  "\uD83D",
  "\uDE00",
];

describe("patch: the prefix probe answers what a fresh normalization answers", () => {
  for (const tier of MATCH_TIERS) {
    it(`${tier}: equal answers at every end of random texts`, () => {
      const next = rng(0xa11ce + tier.length);
      let compared = 0;
      let equalHits = 0;
      for (let round = 0; round < 1500; round++) {
        const pieces = 1 + Math.floor(next() * 30);
        let original = "";
        for (let i = 0; i < pieces; i++) {
          original += PIECES[Math.floor(next() * PIECES.length)];
        }
        const s = Math.floor(next() * (original.length + 1));
        // A target that some end really produces, and one that none does.
        const reachable = Math.floor(s + next() * (original.length - s + 1));
        const targets = [
          normalizeForTier(original.slice(s, reachable), tier),
          normalizeForTier(original.slice(s), tier) + "q",
        ];
        for (const target of targets) {
          const probe = new PrefixProbe(original, s, tier, target);
          let e = s;
          while (e <= original.length) {
            const fresh = normalizeForTier(original.slice(s, e), tier);
            const seen = probe.at(e);
            expect(seen, `${JSON.stringify(original)} s=${s} e=${e}`).toEqual({
              equals: fresh === target,
              length: fresh.length,
            });
            compared += 1;
            if (seen.equals) equalHits += 1;
            e += 1 + Math.floor(next() * 3);
          }
        }
      }
      expect(compared).toBeGreaterThan(5_000);
      // The comparison is not vacuous: many ends do equal their target.
      expect(equalHits).toBeGreaterThan(100);
    });
  }

  it("unicode: a mark that composes backwards after the last boundary is renormalized, not frozen", () => {
    // NFKC of L + U+0304 is two characters, with U+0323 appended it is the
    // one character U+1E38: the length of the prefix shrinks again.
    const original = "xL\u0304\u0323y";
    const probe = new PrefixProbe(original, 1, "unicode", "\u1E38");
    expect(probe.at(2)).toEqual({ equals: false, length: 1 });
    expect(probe.at(3)).toEqual({ equals: false, length: 2 });
    expect(probe.at(4)).toEqual({ equals: true, length: 1 });
  });

  it("unicode: trailing whitespace is dropped only at a line end or at the end of the text", () => {
    const original = "a \u00A0\nb  ";
    const probe = new PrefixProbe(original, 0, "unicode", "a\nb");
    expect(probe.at(1)).toEqual({ equals: false, length: 1 });
    expect(probe.at(2)).toEqual({ equals: false, length: 1 });
    expect(probe.at(3)).toEqual({ equals: false, length: 1 });
    expect(probe.at(4)).toEqual({ equals: false, length: 2 });
    expect(probe.at(5)).toEqual({ equals: true, length: 3 });
    expect(probe.at(7)).toEqual({ equals: true, length: 3 });
  });
});

describe("patch: adjacent fuzzy edits on one line (equivalence at the slice end)", () => {
  function plan(content: string, edits: { old: string; new: string }[]) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "f.txt"), content);
    const r = patch({
      cwd: dir,
      edits: edits.map((e) => ({ file: "f.txt", ...e })),
    });
    return { r, text: fs.readFileSync(path.join(dir, "f.txt"), "utf8") };
  }

  it("a ligature that expands at the end of the first match", () => {
    const { r, text } = plan("\uFB01\uFF3A\n", [
      { old: "fi", new: "X" },
      { old: "Z", new: "Y" },
    ]);
    expect(r.status).toBe("written");
    expect(text).toBe("XY\n");
  });

  it("a combining mark that composes at the end of the first match", () => {
    const { r, text } = plan("e\u0301\uFF3A\n", [
      { old: "\u00E9", new: "E" },
      { old: "Z", new: "Y" },
    ]);
    expect(r.status).toBe("written");
    expect(text).toBe("EY\n");
  });

  it("Hangul jamo that compose into a syllable, then a fullwidth letter", () => {
    const { r, text } = plan("\u1100\u1161\uFF3A\n", [
      { old: "\uAC00", new: "G" },
      { old: "Z", new: "Y" },
    ]);
    expect(r.status).toBe("written");
    expect(text).toBe("GY\n");
  });

  it("trailing whitespace of the first match's line end stays outside both matches", () => {
    const { r, text } = plan("a\uFF3A  \nb\n", [
      { old: "aZ", new: "Q" },
      { old: "b", new: "B" },
    ]);
    expect(r.status).toBe("written");
    expect(text).toBe("Q  \nB\n");
  });

  it("a curly quote and an en dash in two adjacent matches", () => {
    const { r, text } = plan("it\u2019s\u2013ok\n", [
      { old: "it's", new: "IT" },
      { old: "-ok", new: "OK" },
    ]);
    expect(r.status).toBe("written");
    expect(text).toBe("ITOK\n");
  });
});

describe("patch: a long single line with two adjacent unicode-tier edits", () => {
  it("is not quadratic in the line length", () => {
    const n = 200_000;
    const half = "x".repeat(n / 2);
    const content = `a\uFF3A${half}\uFF3Ab${"y".repeat(n / 2 - 4)}\n`;
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "f.txt"), content);
    const started = process.hrtime.bigint();
    const r = patch({
      cwd: dir,
      edits: [
        { file: "f.txt", old: `aZ${half}`, new: "Q" },
        { file: "f.txt", old: "Zb", new: "R" },
      ],
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(r.status).toBe("written");
    expect(r.edits.map((e) => e.tier)).toEqual(["unicode", "unicode"]);
    expect(fs.readFileSync(path.join(dir, "f.txt"), "utf8")).toBe(
      `QR${"y".repeat(n / 2 - 4)}\n`,
    );
    // Normalizing the whole slice again for every candidate end is
    // quadratic in n: at this length that takes more than a hundred times
    // as long as the linear search. The bound sits far below the former and
    // well above the latter.
    expect(ms).toBeLessThan(500);
  }, 60_000);
});

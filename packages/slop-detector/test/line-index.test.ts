import { describe, it, expect } from "vitest";
import { checkText } from "../src/engine.js";
import { defaultConfig } from "../src/config.js";
import { allPacks } from "../src/packs/registry.js";
import { lineIndexBuildCount, offsetToLineCol } from "../src/util/text.js";

const BOUND_MS = 8000;
const TIMEOUT_MS = 60000;

// The scan the index replaced, kept as the oracle for the positions.
function scanOffsetToLineCol(text: string, offset: number) {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}

describe("offsetToLineCol", () => {
  const texts: Record<string, string> = {
    empty: "",
    "single line, no newline": "abc",
    "final line without newline": "one\ntwo\nthree",
    "trailing newline": "one\ntwo\n",
    "only newlines": "\n\n\n",
    CRLF: "one\r\ntwo\r\n\r\nfour",
    "lone CR": "one\rtwo\nthree",
    BOM: "\uFEFFon: push\njobs:\n  j: {}\n",
    "multi-byte and surrogate pairs":
      "café \u{1F600}x\n\u{1F468}\u200D\u{1F469} y\n中文",
    "lone surrogate": "a\uD83Db\nc",
  };

  for (const [name, text] of Object.entries(texts)) {
    it(`matches the per-offset scan at every offset, ${name}`, () => {
      // From before the start to past the end, so the line starts, the
      // line ends, EOF and the out-of-range offsets are all covered.
      for (let offset = -2; offset <= text.length + 3; offset++) {
        expect(offsetToLineCol(text, offset), `offset ${offset}`).toEqual(
          scanOffsetToLineCol(text, offset),
        );
      }
    });
  }

  it("answers correctly when two different texts alternate", () => {
    // The last pair has the same length but different newline positions,
    // so a cache keyed by anything short of the content would answer wrong.
    const pairs: Array<[string, string]> = [
      ["a\nbb\nccc", "xxxx\ny"],
      ["ab\ncd\nef", "abc\nd\nef"],
    ];
    for (const [a, b] of pairs) {
      for (let offset = 0; offset <= a.length + 1; offset++) {
        expect(offsetToLineCol(a, offset), `a@${offset}`).toEqual(
          scanOffsetToLineCol(a, offset),
        );
        expect(offsetToLineCol(b, offset), `b@${offset}`).toEqual(
          scanOffsetToLineCol(b, offset),
        );
      }
    }
  });

  it("builds the index once for many lookups on one text", () => {
    // Distinct string objects with equal content share the index too.
    const text = ["one", "two", "three"].join("\n");
    const copy = ["one", "two", "three"].join("\n");
    // Prime the cache with another text so the first lookup below must build.
    offsetToLineCol("unrelated\ntext", 3);
    const before = lineIndexBuildCount();
    for (let i = 0; i < 500; i++) {
      offsetToLineCol(i % 2 === 0 ? text : copy, i % text.length);
    }
    expect(lineIndexBuildCount() - before).toBe(1);
  });
});

describe("finding positions scale with file size plus findings", () => {
  // Each step interpolating an input into run: is one finding, placed
  // further into the file than the last. On a developer machine the index
  // builds all of them in well under a second, while a scan from offset 0
  // per finding takes about 20 s and grows with the square of the finding
  // count. CI measured about five times slower than a developer machine,
  // so the bound leaves the linear path more than that margin and still
  // sits far below the scan; the test timeout is above the bound.
  it(
    "builds twenty thousand findings in one file within a CI-safe bound",
    () => {
      const n = 20000;
      const lines = [
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
      ];
      for (let i = 0; i < n; i++) {
        lines.push("      - run: echo ${{ inputs.version }}");
      }
      const text = lines.join("\n");
      const buildsBefore = lineIndexBuildCount();
      const started = Date.now();
      const findings = checkText(text, ".github/workflows/publish.yml", {
        packs: allPacks,
        config: defaultConfig(),
        packFilter: ["workflow-slop"],
      }).filter((v) => v.ruleId === "workflow-slop/run-expression");
      const elapsed = Date.now() - started;
      expect(findings).toHaveLength(n);
      expect(findings[n - 1].line).toBe(5 + n);
      expect(findings[n - 1].column).toBe(19);
      // Deterministic form of the same contract: 20000 findings reuse the
      // index of the one file instead of rebuilding it per finding.
      expect(lineIndexBuildCount() - buildsBefore).toBeLessThanOrEqual(5);
      expect(elapsed).toBeLessThan(BOUND_MS);
    },
    TIMEOUT_MS,
  );
});

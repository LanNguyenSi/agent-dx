import path from "node:path";
import { describe, expect, it } from "vitest";
import { citationsResolveRule } from "../src/rules/citations-resolve.js";
import type { BundleContext, Finding } from "../src/types.js";
import { FIXTURES_DIR, loadFixture } from "./helpers.js";

/**
 * `.tsx` targets in `citations-resolve`, the JSX closing-only start lines,
 * the `extension-unrecognised` notice for directory-less RANGE/ANCHORED
 * citations and malformed anchors on unrecognised extensions, the
 * continuation-governor reset after an unrecognised citation (noticed or
 * silent), and `TEST_FILE_RE` covering `.test.tsx`/`.spec.tsx` and Go's
 * `_test.go` with the latter's own Go head/closing grammar.
 * `.tsx` joins every extension set the way `.go` did (see
 * citations-resolve-go.test.ts); the fixture repo is
 * test/fixtures/citations-resolve-tsx/ (src/App.tsx with a line per JSX
 * closing shape, src/App.test.tsx with describe/it blocks, src/tmpl.ts a
 * non-JSX target holding a `</div>` line in a template literal,
 * internal/main_test.go with one func per Go test-function prefix,
 * docs/okf/sample.md). The unchanged `.test.ts` describe/it grammar is
 * pinned by citations-resolve.test.ts ("citations-resolve: short-form
 * citations", src/target.test.ts).
 */

const TSX_ROOT = path.join(FIXTURES_DIR, "citations-resolve-tsx");

function loadTsx(requireAnchors = false): BundleContext {
  const ctx = loadFixture("citations-resolve-tsx/docs/okf", TSX_ROOT);
  return requireAnchors ? { ...ctx, requireAnchors: { allow: [] } } : ctx;
}

function findingsFor(findings: Finding[], citation: string): Finding[] {
  const prefix = `\`${citation}\`: `;
  return findings.filter((f) => f.message.startsWith(prefix));
}

function findingFor(
  findings: Finding[],
  citation: string,
): Finding | undefined {
  return findingsFor(findings, citation)[0];
}

function unrecognisedFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.message.includes("[extension-unrecognised]"));
}

describe("citations-resolve .tsx targets", () => {
  it("a correct .tsx citation on real content produces no finding", () => {
    const findings = citationsResolveRule.run(loadTsx());
    expect(findingFor(findings, "src/App.tsx:11")).toBeUndefined();
  });

  it("a .tsx citation past the end of file fails like a .ts one", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const f = findingFor(findings, "src/App.tsx:999");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[range-exceeds-file]");
    expect(f?.severity).toBe("warning");
  });

  it("a .tsx citation starting on a lone `/>` line is flagged closing-brace-start-line, like a lone `}`", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const f = findingFor(findings, "src/App.tsx:14");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[closing-brace-start-line]");
    expect(f?.severity).toBe("warning");
  });

  it("a .tsx citation starting on a lone `</div>` line is flagged closing-brace-start-line", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const f = findingFor(findings, "src/App.tsx:15");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[closing-brace-start-line]");
    expect(f?.severity).toBe("warning");
  });

  it("a .tsx citation starting on a lone `</>` line is flagged closing-brace-start-line", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const f = findingFor(findings, "src/App.tsx:16");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[closing-brace-start-line]");
    expect(f?.severity).toBe("warning");
  });

  it("a .tsx citation starting on a lone `)}` line is flagged closing-brace-start-line", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const f = findingFor(findings, "src/App.tsx:30");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[closing-brace-start-line]");
    expect(f?.severity).toBe("warning");
  });

  it("a lone `</div>` start line in a non-JSX .ts target is flagged too: the JSX alternatives apply to every closing-only target (decision: kept)", () => {
    // The check judges the start LINE (closing-only content is the drift
    // signature), not the target's language: a `</div>` sitting inside a
    // .ts template literal is just as much a closing-only start line as
    // one closing a render tree, so the JSX alternatives are deliberately
    // NOT restricted to `.tsx`. `}`/`]`/`)` behaviour is unchanged.
    const findings = citationsResolveRule.run(loadTsx());
    const f = findingFor(findings, "src/tmpl.ts:3");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[closing-brace-start-line]");
    expect(f?.severity).toBe("warning");
  });

  it("a .tsx range ending on JSX closing lines is not flagged, like a range ending on `});`", () => {
    const findings = citationsResolveRule.run(loadTsx());
    expect(findingFor(findings, "src/App.tsx:6-17")).toBeUndefined();
  });

  it("under --require-anchors a JSX closing-only tail is boilerplate: an anchor on the last CONTENT line above `/>`/`</div>` is clean", () => {
    // The rule for `}` applied to JSX: CLOSING_BOILERPLATE_RE drives
    // lastContentLineInRange for anchor-not-on-last-line; without the JSX
    // tokens in it the range's last content line would read as the `</div>`
    // itself and this clean citation would get a false warning.
    const findings = citationsResolveRule.run(loadTsx(true));
    expect(
      findings.some(
        (f) =>
          f.message.startsWith('`src/App.tsx:6-15#"onDone();"`') &&
          f.message.includes("[anchor-not-on-last-line]"),
      ),
    ).toBe(false);
  });

  it("under --require-anchors an anchor sitting ON the `/>` boilerplate line is still flagged anchor-not-on-last-line", () => {
    const findings = citationsResolveRule.run(loadTsx(true));
    // The citation label spells the quoted anchor out, so match on the
    // prefix up to the `#` and the rule id instead of repeating the exact
    // anchor text; this run has exactly one such finding.
    const flagged = findings.filter(
      (f) =>
        f.message.startsWith("`src/App.tsx:6-15#") &&
        f.message.includes("[anchor-not-on-last-line]"),
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain(
      "not the cited range's last content line",
    );
  });
});

describe("citations-resolve extension-unrecognised notice, directory-less and malformed-anchor forms", () => {
  it("a directory-less RANGE citation produces exactly one notice naming the extension", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const all = findingsFor(findings, "install.sh:561-618");
    expect(all).toHaveLength(1);
    expect(all[0]?.message).toContain('".sh"');
    expect(all[0]?.message).toContain("the citation is not checked");
    expect(all[0]?.severity).toBe("notice");
  });

  it("a directory-less ANCHORED citation produces exactly one notice", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const all = findingsFor(findings, 'deploy.sh:5#"install"');
    expect(all).toHaveLength(1);
    expect(all[0]?.message).toContain("[extension-unrecognised]");
    expect(all[0]?.severity).toBe("notice");
  });

  it("a directory-less ANCHORED citation on a TLD extension produces exactly one notice, not two and not silence", () => {
    // The HOSTNAME_TLD carve-out is scoped to the unanchored range form;
    // the anchored form fires like any other anchored directory-less
    // citation, and the malformed-anchor companion must not double-report
    // the same span.
    const findings = citationsResolveRule.run(loadTsx());
    const all = findingsFor(findings, 'example.com:5#"x"');
    expect(all).toHaveLength(1);
    expect(all[0]?.message).toContain("[extension-unrecognised]");
    expect(all[0]?.message).toContain('".com"');
    expect(all[0]?.severity).toBe("notice");
  });

  it("a directory-less single-number citation stays silent (the host:port collision)", () => {
    const findings = citationsResolveRule.run(loadTsx());
    expect(findings.some((f) => f.message.includes("foo.sh:12"))).toBe(false);
  });

  it("host:port look-alikes stay silent, single and range form, including example.com:80-90", () => {
    const findings = citationsResolveRule.run(loadTsx());
    for (const shape of [
      "localhost:8080",
      "db.internal:5432",
      "example.com:80-90",
      "db.internal:1-1024",
    ]) {
      expect(
        findings.some((f) => f.message.includes(shape)),
        `expected silence for ${shape}`,
      ).toBe(false);
    }
  });

  it("a malformed anchor on an unrecognised citation is a notice, not silence: unterminated quote", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const all = findingsFor(findings, 'src/lib.rs:1#"unterminated');
    expect(all).toHaveLength(1);
    expect(all[0]?.message).toContain("[extension-unrecognised]");
    expect(all[0]?.severity).toBe("notice");
  });

  it("a malformed anchor on an unrecognised citation is a notice, not silence: bare trailing hash", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const all = findingsFor(findings, "src/lib.rs:2#");
    expect(all).toHaveLength(1);
    expect(all[0]?.message).toContain("[extension-unrecognised]");
  });

  it("a malformed anchor on a RECOGNISED citation stays anchor-malformed, never an extension notice", () => {
    const findings = citationsResolveRule.run(loadTsx());
    // The label of an anchor-malformed citation omits the unparseable `#`
    // (the anchor is null on the atom), so it is just `src/App.tsx:1`.
    const all = findingsFor(findings, "src/App.tsx:2");
    expect(all).toHaveLength(1);
    expect(all[0]?.message).toContain("[anchor-malformed]");
    expect(
      unrecognisedFindings(findings).some((f) =>
        f.message.startsWith("`src/App.tsx:"),
      ),
    ).toBe(false);
  });
});

describe("citations-resolve continuation governor after an unrecognised citation", () => {
  it("control: a continuation right after a recognised citation IS checked against it", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const f = findingFor(findings, "src/App.tsx:998 (continuation)");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[range-exceeds-file]");
  });

  it("after an unrecognised citation the `:N`, -`M` and (`N`) continuations are NOT attributed to the earlier file", () => {
    const findings = citationsResolveRule.run(loadTsx());
    for (const label of [
      "src/App.tsx:997 (continuation)",
      "src/App.tsx:997-996 (continuation)",
      "src/App.tsx:995 (continuation)",
    ]) {
      expect(findingsFor(findings, label), `expected no ${label}`).toHaveLength(
        0,
      );
    }
    // The unrecognised citation between them is itself noticed.
    expect(findingsFor(findings, "src/lib.rs:12")).toHaveLength(1);
  });

  it("the silent directory-less single-number form (`foo.sh:12`) resets the chain without a notice", () => {
    // `src/App.tsx:5`, then `foo.sh:12`, then `:999`: no
    // `src/App.tsx:999 (continuation)` range-exceeds-file warning -- the
    // silent form broke the chain even though it emits nothing.
    const findings = citationsResolveRule.run(loadTsx());
    expect(
      findingsFor(findings, "src/App.tsx:999 (continuation)"),
    ).toHaveLength(0);
    expect(
      findings.some((f) => f.message.includes("foo.sh:12")),
      "the single-number form must stay notice-silent",
    ).toBe(false);
  });

  it("a TLD-silenced range (`example.com:80-90`) resets the chain without a notice", () => {
    // `src/App.tsx:5`, then `example.com:80-90`, then `:996`: same reset,
    // same silence.
    const findings = citationsResolveRule.run(loadTsx());
    expect(
      findingsFor(findings, "src/App.tsx:996 (continuation)"),
    ).toHaveLength(0);
    expect(
      findings.some((f) => f.message.includes("example.com:80-90")),
      "the unanchored TLD range must stay notice-silent",
    ).toBe(false);
  });
});

describe("citations-resolve TEST_FILE_RE for .tsx and _test.go targets", () => {
  it("a .test.tsx short-form range on a describe/it block resolves cleanly", () => {
    const findings = citationsResolveRule.run(loadTsx());
    expect(
      findingFor(findings, "src/App.test.tsx:3-7 (short-form)"),
    ).toBeUndefined();
  });

  it("a .test.tsx short-form range starting off the head line is flagged test-range-start-not-head", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const f = findingFor(findings, "src/App.test.tsx:5-6 (short-form)");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[test-range-start-not-head]");
    expect(f?.severity).toBe("warning");
  });

  it("a .test.tsx short-form range ending off the closing line is flagged test-range-end-not-closing", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const f = findingFor(findings, "src/App.test.tsx:4-5 (short-form)");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[test-range-end-not-closing]");
    expect(f?.severity).toBe("notice");
  });

  it("a _test.go short-form range covering a whole func TestXxx is clean: Go gets its own head/closing grammar", () => {
    // Line 9 is `func TestThing(t *testing.T) {` and line 13 the func's
    // closing `}` -- a head and a close under the Go grammar, so the
    // range is the correct whole-block citation it always meant to be.
    const findings = citationsResolveRule.run(loadTsx());
    expect(
      findingFor(findings, "internal/main_test.go:9-13 (short-form)"),
    ).toBeUndefined();
  });

  it("a _test.go short-form range starting on a non-head line is flagged test-range-start-not-head", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const f = findingFor(findings, "internal/main_test.go:10-12 (short-form)");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[test-range-start-not-head]");
    expect(f?.severity).toBe("warning");
  });

  it("a _test.go short-form range ending mid-func on a non-} line is flagged test-range-end-not-closing, as a NOTICE", () => {
    const findings = citationsResolveRule.run(loadTsx());
    const f = findingFor(findings, "internal/main_test.go:9-11 (short-form)");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[test-range-end-not-closing]");
    expect(f?.severity).toBe("notice");
  });

  it("a _test.go range ending on a nested indented `}` counts as a closing line, like `});` closes down to in the JS grammar", () => {
    const findings = citationsResolveRule.run(loadTsx());
    expect(
      findingFor(findings, "internal/main_test.go:9-12 (short-form)"),
    ).toBeUndefined();
  });

  it("Benchmark/Fuzz/Example heads and bare func Example() are heads too: their whole-func ranges are clean", () => {
    const findings = citationsResolveRule.run(loadTsx());
    for (const citation of [
      "internal/main_test.go:15-19 (short-form)",
      "internal/main_test.go:21-23 (short-form)",
      "internal/main_test.go:25-27 (short-form)",
    ]) {
      expect(
        findingsFor(findings, citation),
        `expected no ${citation}`,
      ).toHaveLength(0);
    }
  });

  it("under --require-anchors the straddle check selects the Go grammar too: a full Go range running into the next func head is flagged, whole-func ranges are not", () => {
    const findings = citationsResolveRule.run(loadTsx(true));
    expect(
      findingsFor(findings, "internal/main_test.go:9-19").filter((f) =>
        f.message.includes("[test-range-straddles-block]"),
      ),
      "expected the 9-19 range to straddle into func BenchmarkThing's head",
    ).toHaveLength(1);
    for (const citation of [
      "internal/main_test.go:9-13",
      "internal/main_test.go:21-23",
    ]) {
      expect(
        findingsFor(findings, citation).filter((f) =>
          f.message.includes("[test-range-straddles-block]"),
        ),
        `expected no straddle finding for ${citation}`,
      ).toHaveLength(0);
    }
  });

  it("the fixture doc produces exactly the expected findings, no extras", () => {
    const findings = citationsResolveRule.run(loadTsx());
    expect(findings).toHaveLength(18);
    expect(findings.filter((f) => f.severity === "warning")).toHaveLength(9);
    expect(findings.filter((f) => f.severity === "notice")).toHaveLength(9);
  });
});

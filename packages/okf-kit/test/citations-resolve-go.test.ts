import path from "node:path";
import { describe, expect, it } from "vitest";
import { citationsResolveRule } from "../src/rules/citations-resolve.js";
import type { BundleContext, Finding } from "../src/types.js";
import { FIXTURES_DIR, loadFixture } from "./helpers.js";

/**
 * `.go` targets in `citations-resolve`, and the `extension-unrecognised`
 * notice for backticked citations whose extension the rule does not
 * recognise. The extension list (CITATION_RE, see
 * src/rules/citations-resolve.ts) grew a `.go` entry after a bundle in a Go
 * repo carried 129 citations into `.go` files that no check ever looked at,
 * so a warn-only CI job read "clean" without checking them. The fixture
 * bundles the `.go` shapes in the same order as the `.prisma` fixture
 * mirrors the `.ts` controls, backticked `.rs` citations in both the
 * bare and the recommended anchored form (and a `.tsx` one, kept to show
 * the recognised extension set now absorbs it), the anchored recognised
 * forms the notice must refuse, and the look-alike shapes the notice must
 * refuse. The last suite pins the Go test-block grammar over
 * `internal/sample_test.go`: a testify suite-method head, a `t.Run(` subtest
 * head (closing on `})`), the head-kind pairing of the closing line, the
 * non-head look-alikes (`x.Runner(`, `t.Run` in a comment or string) and the
 * `t.Run` straddle under `--require-anchors`.
 */

const GO_ROOT = path.join(FIXTURES_DIR, "citations-resolve-go");

function loadGo(requireAnchors = false): BundleContext {
  const ctx = loadFixture("citations-resolve-go/docs/okf", GO_ROOT);
  return requireAnchors ? { ...ctx, requireAnchors: { allow: [] } } : ctx;
}

/** A finding's message always starts with `` `<citation>`: `` (see pushDrift). */
function findingFor(
  findings: Finding[],
  citation: string,
): Finding | undefined {
  const prefix = `\`${citation}\`: `;
  return findings.find((f) => f.message.startsWith(prefix));
}

function unrecognisedFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.message.includes("[extension-unrecognised]"));
}

/** `unrecognisedFindings` further narrowed to one exact citation label. */
function noticesFor(findings: Finding[], citation: string): Finding[] {
  const prefix = `\`${citation}\`: `;
  return unrecognisedFindings(findings).filter((f) =>
    f.message.startsWith(prefix),
  );
}

/** Every finding (of any kind) whose label is this exact citation. */
function findingsFor(findings: Finding[], citation: string): Finding[] {
  const prefix = `\`${citation}\`: `;
  return findings.filter((f) => f.message.startsWith(prefix));
}

describe("citations-resolve .go targets", () => {
  it("an in-range .go citation on real content produces no finding", () => {
    const findings = citationsResolveRule.run(loadGo());
    expect(findingFor(findings, "internal/main.go:5")).toBeUndefined();
  });

  it("a .go citation to a missing file is flagged missing-file", () => {
    const findings = citationsResolveRule.run(loadGo());
    const f = findingFor(findings, "internal/missing.go:5");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[missing-file]");
  });

  it("a .go citation past the end of file is flagged range-exceeds-file", () => {
    const findings = citationsResolveRule.run(loadGo());
    const f = findingFor(findings, "internal/main.go:999");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[range-exceeds-file]");
  });

  it("a .go range whose end is past EOF is flagged range-exceeds-file", () => {
    const findings = citationsResolveRule.run(loadGo());
    const f = findingFor(findings, "internal/main.go:5-999");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[range-exceeds-file]");
  });

  it("a #anchor outside the cited range into a .go target is flagged anchor-not-found-in-range", () => {
    const findings = citationsResolveRule.run(loadGo());
    const f = findingFor(findings, `internal/main.go:5-6#"needle in helper"`);
    expect(f).toBeDefined();
    expect(f?.message).toContain("[anchor-not-found-in-range]");
  });

  it("a .go citation landing on a lone closing brace is flagged closing-brace-start-line", () => {
    const findings = citationsResolveRule.run(loadGo());
    const f = findingFor(findings, "internal/main.go:7");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[closing-brace-start-line]");
  });

  it("a .go range ending on a lone closing brace is not flagged, like the same range into a .ts target", () => {
    // Ending a range on a closing brace is normal (see the cont-ext comment
    // in src/rules/citations-resolve.ts); only a range STARTING on one is
    // the drift signature CLOSING_ONLY_EXTS gates.
    const findings = citationsResolveRule.run(loadGo());
    expect(findingFor(findings, "internal/main.go:5-7")).toBeUndefined();
  });
});

describe("citations-resolve extension-unrecognised notice", () => {
  it("a backticked `path.ext:N` with an unrecognised extension produces exactly one notice naming the extension and saying the citation is not checked", () => {
    const findings = citationsResolveRule.run(loadGo());
    const notices = noticesFor(findings, "src/lib.rs:12");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain(".rs");
    expect(notices[0]?.message).toContain("the citation is not checked");
    expect(notices[0]?.severity).toBe("notice");
  });

  it("the same citation shape outside backticks produces no notice", () => {
    // The unbackticked occurrence in the fixture deliberately carries a
    // different line number (34 vs the backticked 12) so a mutant that
    // dropped the backtick requirement is visible here under its own label,
    // not hidden behind the backticked one's identical label.
    const findings = citationsResolveRule.run(loadGo());
    expect(noticesFor(findings, "src/lib.rs:12")).toHaveLength(1);
    expect(findings.some((f) => f.message.includes("src/lib.rs:34"))).toBe(
      false,
    );
  });

  it("a URL with a port produces no notice", () => {
    const findings = citationsResolveRule.run(loadGo());
    expect(findings.some((f) => f.message.includes("example.com:8080"))).toBe(
      false,
    );
  });

  it("a host:port produces no notice", () => {
    const findings = citationsResolveRule.run(loadGo());
    expect(findings.some((f) => f.message.includes("db.internal:5432"))).toBe(
      false,
    );
  });

  it("an absolute backticked path produces no notice, matching the main scan's out-of-scope skip", () => {
    const findings = citationsResolveRule.run(loadGo());
    expect(findings.some((f) => f.message.includes("/srv/src/lib.rs:12"))).toBe(
      false,
    );
  });

  it("a directory-less single-segment `a.b:3` produces no notice", () => {
    const findings = citationsResolveRule.run(loadGo());
    expect(findings.some((f) => f.message.includes("a.b:3"))).toBe(false);
  });

  it("a digits-only extension produces no notice", () => {
    const findings = citationsResolveRule.run(loadGo());
    expect(
      findings.some((f) => f.message.includes("scripts/tool.123:45")),
    ).toBe(false);
  });

  it("a recognised .go citation never produces the notice, only its own drift findings", () => {
    const findings = citationsResolveRule.run(loadGo());
    // Quoted `".go"` (the extension as the notice message spells it) rather
    // than a bare `.go` substring: the fixture's look-alike labels
    // (`src/x.gomod:3`, `src/x.go.bak:3`, `src/x.golden:3`) all contain
    // `.go` as a substring without being `.go` citations.
    expect(
      unrecognisedFindings(findings).some((f) => f.message.includes('".go"')),
    ).toBe(false);
  });

  it("an anchored .rs citation with a quoted anchor produces exactly one notice", () => {
    const findings = citationsResolveRule.run(loadGo());
    const notices = noticesFor(findings, 'src/lib.rs:1#"main"');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('".rs"');
    expect(notices[0]?.severity).toBe("notice");
  });

  it("an anchored .rs citation with a bare-word anchor produces exactly one notice", () => {
    const findings = citationsResolveRule.run(loadGo());
    const notices = noticesFor(findings, "src/lib.rs:2#main");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('".rs"');
    expect(notices[0]?.severity).toBe("notice");
  });

  it("the recommended-form anchored .tsx citation is now a RECOGNISED target: no notice, only the main scan's own finding", () => {
    // `.tsx` joined the recognised extension set (see
    // citations-resolve-tsx.test.ts); this fixture has no page.tsx file, so
    // the citation goes through the ordinary path and lands on
    // missing-file -- proof that a `.tsx` span is no longer diverted to the
    // unrecognised scan.
    const findings = citationsResolveRule.run(loadGo());
    const citation = `src/app/page.tsx:31-33#"router.replace('/login')"`;
    expect(noticesFor(findings, citation)).toHaveLength(0);
    const all = findingsFor(findings, citation);
    expect(all).toHaveLength(1);
    expect(all[0]?.message).toContain("[missing-file]");
  });

  it("an anchored recognised .go citation produces no notice and no other finding", () => {
    const findings = citationsResolveRule.run(loadGo());
    expect(
      findingsFor(findings, 'internal/main.go:9-12#"needle in helper"'),
    ).toHaveLength(0);
  });

  it("an anchored recognised .ts citation produces no notice and no other finding", () => {
    const findings = citationsResolveRule.run(loadGo());
    expect(
      findingsFor(findings, 'web/app.ts:1-2#"needle in app"'),
    ).toHaveLength(0);
  });

  it("`src/x.gomod:3` is never a .go citation: exactly one .gomod notice, nothing else", () => {
    const findings = citationsResolveRule.run(loadGo());
    const all = findingsFor(findings, "src/x.gomod:3");
    expect(all).toHaveLength(1);
    expect(all[0]?.message).toContain("[extension-unrecognised]");
    expect(all[0]?.message).toContain('".gomod"');
  });

  it("`src/x.go.bak:3` is never a .go citation: exactly one .bak notice, nothing else", () => {
    const findings = citationsResolveRule.run(loadGo());
    const all = findingsFor(findings, "src/x.go.bak:3");
    expect(all).toHaveLength(1);
    expect(all[0]?.message).toContain("[extension-unrecognised]");
    expect(all[0]?.message).toContain('".bak"');
  });

  it("`src/x.golden:3` is never a .go citation: exactly one .golden notice, nothing else", () => {
    const findings = citationsResolveRule.run(loadGo());
    const all = findingsFor(findings, "src/x.golden:3");
    expect(all).toHaveLength(1);
    expect(all[0]?.message).toContain("[extension-unrecognised]");
    expect(all[0]?.message).toContain('".golden"');
  });
});

describe("citations-resolve Go subtest and suite-method test heads", () => {
  it("a short-form range starting on a testify suite-method head and ending on } is clean", () => {
    const findings = citationsResolveRule.run(loadGo());
    expect(
      findingFor(findings, "internal/sample_test.go:7-11 (short-form)"),
    ).toBeUndefined();
  });

  it("a short-form range starting on a t.Run subtest head and ending on }) is clean", () => {
    const findings = citationsResolveRule.run(loadGo());
    expect(
      findingFor(findings, "internal/sample_test.go:16-20 (short-form)"),
    ).toBeUndefined();
  });

  it('a t.Run subtest range ended on a plain "}" (closer kind mismatch) keeps the end-not-closing notice', () => {
    const findings = citationsResolveRule.run(loadGo());
    const f = findingFor(
      findings,
      "internal/sample_test.go:16-19 (short-form)",
    );
    expect(f).toBeDefined();
    expect(f?.message).toContain("[test-range-end-not-closing]");
    expect(f?.message).toContain('closing "})"');
    expect(f?.severity).toBe("notice");
  });

  it('a func-head range ended on "})" (closer kind mismatch) keeps the end-not-closing notice', () => {
    const findings = citationsResolveRule.run(loadGo());
    const f = findingFor(
      findings,
      "internal/sample_test.go:13-20 (short-form)",
    );
    expect(f).toBeDefined();
    expect(f?.message).toContain("[test-range-end-not-closing]");
    expect(f?.severity).toBe("notice");
  });

  it("an x.Runner( call, a t.Run in a comment and a t.Run in a string are all start-not-head, not heads", () => {
    const findings = citationsResolveRule.run(loadGo());
    for (const citation of [
      "internal/sample_test.go:42-46 (short-form)",
      "internal/sample_test.go:43-45 (short-form)",
      "internal/sample_test.go:44-46 (short-form)",
      "internal/sample_test.go:69-71 (short-form)",
    ]) {
      const f = findingFor(findings, citation);
      expect(f, `expected start-not-head for ${citation}`).toBeDefined();
      expect(f?.message).toContain("[test-range-start-not-head]");
      expect(f?.severity).toBe("warning");
    }
  });

  it("under --require-anchors a Go full range crossing into a sibling t.Run straddles", () => {
    const findings = citationsResolveRule.run(loadGo(true));
    const straddles = findingsFor(
      findings,
      "internal/sample_test.go:25-28",
    ).filter((f) => f.message.includes("[test-range-straddles-block]"));
    expect(straddles).toHaveLength(1);
    expect(straddles[0]?.severity).toBe("warning");
  });

  it("under --require-anchors a nested t.Run deeper than the start is not a straddle, nor is a clean whole subtest", () => {
    const findings = citationsResolveRule.run(loadGo(true));
    for (const citation of [
      "internal/sample_test.go:34-38",
      "internal/sample_test.go:16-20",
    ]) {
      expect(
        findingsFor(findings, citation).filter((f) =>
          f.message.includes("[test-range-straddles-block]"),
        ),
        `expected no straddle for ${citation}`,
      ).toHaveLength(0);
    }
  });

  it("a value-receiver suite-method head closes a clean short-form range on }", () => {
    const findings = citationsResolveRule.run(loadGo());
    expect(
      findingFor(findings, "internal/sample_test.go:52-54 (short-form)"),
    ).toBeUndefined();
  });

  it('a testify s.Run("x", func() {) subtest head closes a clean short-form range on })', () => {
    const findings = citationsResolveRule.run(loadGo());
    expect(
      findingFor(findings, "internal/sample_test.go:57-59 (short-form)"),
    ).toBeUndefined();
  });

  it("a suite.Run(t, new(S)) call with no func literal is start-not-head, not a subtest head", () => {
    const findings = citationsResolveRule.run(loadGo());
    const f = findingFor(
      findings,
      "internal/sample_test.go:49-50 (short-form)",
    );
    expect(f).toBeDefined();
    expect(f?.message).toContain("[test-range-start-not-head]");
    expect(f?.severity).toBe("warning");
  });

  it("under --require-anchors a full range from one suite method into the next suite method straddles", () => {
    const findings = citationsResolveRule.run(loadGo(true));
    const straddles = findingsFor(
      findings,
      "internal/sample_test.go:52-56",
    ).filter((f) => f.message.includes("[test-range-straddles-block]"));
    expect(straddles).toHaveLength(1);
    expect(straddles[0]?.severity).toBe("warning");
  });

  it("under --require-anchors an indented func look-alike, a cmd.Run(newfunc(x)) call and an x.Runner( call at the start's indent are not straddle heads", () => {
    const findings = citationsResolveRule.run(loadGo(true));
    expect(
      findingsFor(findings, "internal/sample_test.go:63-70").filter((f) =>
        f.message.includes("[test-range-straddles-block]"),
      ),
    ).toHaveLength(0);
  });
});

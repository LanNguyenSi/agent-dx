import path from "node:path";
import { describe, expect, it } from "vitest";
import { citationsResolveRule } from "../src/rules/citations-resolve.js";
import type { BundleContext, Finding } from "../src/types.js";
import { FIXTURES_DIR, loadFixture } from "./helpers.js";

/**
 * `.tsx` targets in `citations-resolve`, the JSX closing-only start lines,
 * the `extension-unrecognised` notice for directory-less RANGE/ANCHORED
 * citations and malformed anchors on unrecognised extensions, the
 * continuation-governor reset after an unrecognised citation, and
 * `TEST_FILE_RE` covering `.test.tsx`/`.spec.tsx` and Go's `_test.go`.
 * `.tsx` joins every extension set the way `.go` did (see
 * citations-resolve-go.test.ts); the fixture repo is
 * test/fixtures/citations-resolve-tsx/ (src/App.tsx with a line per JSX
 * closing shape, src/App.test.tsx with describe/it blocks,
 * internal/main_test.go, docs/okf/sample.md).
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

  it("a _test.go short-form range is held to the test-file boundary check, not treated as an ordinary file", () => {
    // Before TEST_FILE_RE grew `_test.go`, a range into a Go test file got
    // no boundary check at all (the rule's test branch never fired); the
    // Go `func TestXxx` head is not a describe/it head, so the range is
    // now reported -- the classification is what this pins.
    const findings = citationsResolveRule.run(loadTsx());
    const f = findingFor(findings, "internal/main_test.go:9-13 (short-form)");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[test-range-start-not-head]");
    expect(f?.severity).toBe("warning");
  });

  it("the fixture doc produces exactly the expected findings, no extras", () => {
    const findings = citationsResolveRule.run(loadTsx());
    expect(findings).toHaveLength(15);
    expect(findings.filter((f) => f.severity === "warning")).toHaveLength(8);
    expect(findings.filter((f) => f.severity === "notice")).toHaveLength(7);
  });
});

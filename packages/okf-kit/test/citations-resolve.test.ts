import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { citationsResolveRule } from "../src/rules/citations-resolve.js";
import type { Finding } from "../src/types.js";
import { FIXTURES_DIR, loadFixture } from "./helpers.js";

/**
 * Ported from agent-grounding's `scripts/okf-citations-resolve.test.mjs`
 * (PR #185, node:test) to vitest, exercising `citationsResolveRule` (a
 * `Rule`, not the original's standalone `run(root)`) against equivalent
 * fixtures. Fixture roots double as the "repo root" for path resolution,
 * matching the original tests' FIXTURE_ROOT / CONT_FIXTURE_ROOT split:
 *   - test/fixtures/citations-resolve-main/ (docs/okf/sample.md + src/):
 *     one good citation plus one drifted citation per warn rule.
 *   - test/fixtures/citations-resolve-continuations/ (its own docs/okf +
 *     src/): the three continuation-citation forms.
 * Not ported: the original's parseArgs tests. Those exercised the
 * standalone script's own `--root`/`--json`/`--fail-on-warn` argument
 * parser, which has no equivalent here; citations-resolve is a Rule
 * plugged into okf-kit's existing `check` command and its existing
 * `--repo-root`/`--json`/`--strict` flags, unchanged.
 */

const MAIN_ROOT = path.join(FIXTURES_DIR, "citations-resolve-main");
const CONT_ROOT = path.join(FIXTURES_DIR, "citations-resolve-continuations");

function loadMain() {
  return loadFixture("citations-resolve-main/docs/okf", MAIN_ROOT);
}

function loadCont() {
  return loadFixture("citations-resolve-continuations/docs/okf", CONT_ROOT);
}

/** A finding's message always starts with `` `<citation>`: `` (see pushDrift/pushAmbiguous). */
function findingFor(
  findings: Finding[],
  citation: string,
): Finding | undefined {
  const prefix = `\`${citation}\`: `;
  return findings.find((f) => f.message.startsWith(prefix));
}

describe("citations-resolve", () => {
  it("scans the fixture doc and returns all five expected findings, no false positives", () => {
    const ctx = loadMain();
    expect(ctx.docs.map((d) => d.relPath)).toEqual(["sample.md"]);

    const findings = citationsResolveRule.run(ctx);
    expect(findings).toHaveLength(5);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });

  it("good citation on real, non-blank content produces no finding", () => {
    const findings = citationsResolveRule.run(loadMain());
    expect(findingFor(findings, "src/target.ts:1")).toBeUndefined();
  });

  it("drifted citation landing on a blank line is flagged blank-start-line", () => {
    const findings = citationsResolveRule.run(loadMain());
    const f = findingFor(findings, "src/target.ts:4");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[blank-start-line]");
    expect(f?.detail).toBe("resolvedTo: src/target.ts");
  });

  it("citation landing on a lone closing brace is flagged closing-brace-start-line", () => {
    const findings = citationsResolveRule.run(loadMain());
    const f = findingFor(findings, "src/target.ts:3");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[closing-brace-start-line]");
  });

  it("citation past end of file is flagged range-exceeds-file", () => {
    const findings = citationsResolveRule.run(loadMain());
    const f = findingFor(findings, "src/target.ts:50");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[range-exceeds-file]");
  });

  it("citation into a nonexistent file is flagged missing-file", () => {
    const findings = citationsResolveRule.run(loadMain());
    const f = findingFor(findings, "does-not-exist.ts:1");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[missing-file]");
    expect(f?.detail).toBeUndefined();
  });

  it("markdown target only gets the blank-start-line check, not closing-brace", () => {
    const findings = citationsResolveRule.run(loadMain());
    const f = findingFor(findings, "src/note.md:1");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[blank-start-line]");
  });

  it("negative control: a citation manually corrected to the real post-drift line resolves clean", () => {
    // `src/target.ts:4` (blank) is the drifted citation in the main fixture;
    // the content that actually moved there sits at line 5 (`export
    // function bar() {`). A disposable fixture citing line 5 instead must
    // produce no finding for that citation, confirming the rule reacts to
    // the cited line's real content rather than a fixed offset from the
    // drifted fixture.
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-negctl-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "src/target.ts"),
        [
          "export function foo() {",
          "  return 1;",
          "}",
          "",
          "export function bar() {",
          "  return 2;",
          "}",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/sample.md"),
        [
          "---",
          "type: reference",
          "sources:",
          "  - src/target.ts",
          "---",
          "",
          "Corrected citation: `src/target.ts:5`.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      expect(findingFor(findings, "src/target.ts:5")).toBeUndefined();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -- Continuation citations (`:N`, -`M`/–`M`, (`N`)) -----------------------

  it("continuations: fresh single-line continuation on real content produces no finding", () => {
    const findings = citationsResolveRule.run(loadCont());
    expect(
      findingFor(findings, "src/target.ts:2 (continuation)"),
    ).toBeUndefined();
  });

  it("continuations: fresh single-line continuation landing on a blank line is flagged", () => {
    const findings = citationsResolveRule.run(loadCont());
    const f = findingFor(findings, "src/target.ts:4 (continuation)");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[blank-start-line]");
    expect(f?.detail).toBe("resolvedTo: src/target.ts");
  });

  it("continuations: dash-form range end landing on a closing brace is NOT flagged (legitimate range end)", () => {
    const findings = citationsResolveRule.run(loadCont());
    expect(
      findingFor(findings, "src/target.ts:1-3 (continuation)"),
    ).toBeUndefined();
  });

  it("continuations: colon-form range end landing on a closing brace is NOT flagged (legitimate range end)", () => {
    const findings = citationsResolveRule.run(loadCont());
    expect(
      findingFor(findings, "src/target.ts:5-7 (continuation)"),
    ).toBeUndefined();
  });

  it("continuations: dash-form range end past the end of file is flagged range-exceeds-file", () => {
    const findings = citationsResolveRule.run(loadCont());
    const f = findingFor(findings, "src/target.ts:1-50 (continuation)");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[range-exceeds-file]");
  });

  it("continuations: paren-form fresh continuation on a closing brace IS flagged (not an extension)", () => {
    const findings = citationsResolveRule.run(loadCont());
    const f = findingFor(findings, "src/target.ts:3 (continuation)");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[closing-brace-start-line]");
  });

  it("continuations: a citedPath with a '..' segment is rejected without being resolved", () => {
    const findings = citationsResolveRule.run(loadCont());
    const f = findingFor(findings, "../evil.ts:1");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[path-traversal-rejected]");
    expect(f?.detail).toBeUndefined();
  });

  it("continuations: a continuation right after a rejected citation is silently skipped, not misattributed", () => {
    const findings = citationsResolveRule.run(loadCont());
    // The doc's trailing `:4` immediately follows the rejected
    // `../evil.ts:1` citation, which resets `governing` to null. Deliberately
    // the blank line in src/target.ts, not real content: if the reset didn't
    // happen, `:4` would wrongly inherit the still-set src/target.ts
    // governing from the earlier `src/target.ts:1` citation and produce a
    // SECOND "blank-start-line" finding for this exact citation -- an
    // earlier, unrelated fixture paragraph legitimately produces one finding
    // with this exact citation string, so the count must stay at exactly
    // one, not grow to two.
    const matches = findings.filter((f) =>
      f.message.startsWith("`src/target.ts:4 (continuation)`: "),
    );
    expect(matches).toHaveLength(1);
    expect(findings).toHaveLength(7);
  });

  it("continuations: a full citation with an inverted embedded range (end before start) is flagged inverted-range", () => {
    const findings = citationsResolveRule.run(loadCont());
    const f = findingFor(findings, "src/target.ts:5-3");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[inverted-range]");
  });

  it("continuations: a cont-ext atom extending a range to before its start is flagged inverted-range, not silently accepted", () => {
    const findings = citationsResolveRule.run(loadCont());
    // Before the range-bound-only fix (ported from the original), cont-ext
    // re-ran the full checkTarget against the (real-content) start line and
    // never checked the range's own shape at all, so an inverted split
    // range like this one silently passed with no finding.
    const f = findingFor(findings, "src/target.ts:5-3 (continuation)");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[inverted-range]");
  });

  it("continuations: a cont-ext atom extending a blank-start range does not re-flag the already-reported start line", () => {
    const findings = citationsResolveRule.run(loadCont());
    // `src/target.ts:4`-`6`: the full citation "4" alone already reports
    // blank-start-line. The cont-ext "6" extension must not re-run the full
    // start-line check against the same blank line 4 and report it a second
    // time as "src/target.ts:4-6 (continuation)".
    expect(
      findingFor(findings, "src/target.ts:4-6 (continuation)"),
    ).toBeUndefined();
    const startFindings = findings.filter((f) =>
      f.message.startsWith("`src/target.ts:4`: "),
    );
    expect(startFindings).toHaveLength(1);
    expect(startFindings[0].message).toContain("[blank-start-line]");
  });

  it("continuations fixture: exactly the seven expected findings, no extras", () => {
    const ctx = loadCont();
    expect(ctx.docs.map((d) => d.relPath)).toEqual(["continuations.md"]);

    const findings = citationsResolveRule.run(ctx);
    expect(findings).toHaveLength(7);
    expect(findings.filter((f) => f.severity === "notice")).toHaveLength(0);
  });

  // -- EXCLUDED_DIRS: this rule's own fixtures never pollute basename search -

  it("EXCLUDED_DIRS: a decoy file inside a directory named like the fixtures dir is never picked up by the repo-wide basename search", () => {
    // Without excluding a directory named `okf-citations-resolve-fixtures`,
    // the bare-basename citation below would resolve ambiguously (two
    // `shared.ts` files under tmpRoot): the real target under src/, and a
    // decoy under a directory sharing the excluded fixtures directory name.
    // With the exclusion, only the real target is found, so resolution is
    // clean (no finding, nothing ambiguous).
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-excldirs-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.mkdirSync(
        path.join(tmpRoot, "scripts/okf-citations-resolve-fixtures"),
        {
          recursive: true,
        },
      );
      fs.writeFileSync(
        path.join(tmpRoot, "src/shared.ts"),
        "export const x = 1;\n",
      );
      fs.writeFileSync(
        path.join(tmpRoot, "scripts/okf-citations-resolve-fixtures/shared.ts"),
        "export const decoy = 1;\n",
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "title: Excluded-dir fixture",
          "---",
          "",
          "Bare-basename citation resolved via repo-wide search: `shared.ts:1`.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      expect(findings).toHaveLength(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -- repoRoot handling --------------------------------------------------

  it("emits exactly one bundle-level notice when repoRoot is not a git work tree", () => {
    const plainDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-kit-citations-plain-"),
    );
    try {
      fs.writeFileSync(
        path.join(plainDir, "doc.md"),
        ["---", "type: reference", "---", "", "`src/x.ts:1`.", ""].join("\n"),
      );

      const ctx = loadBundle(plainDir, undefined);
      const findings = citationsResolveRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0].ruleId).toBe("citations-resolve");
      expect(findings[0].severity).toBe("notice");
      expect(findings[0].message).toContain("not inside a git work tree");
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it("finds zero violations on a bundle with no citations", () => {
    // valid-bundle's docs contain no `path:N` citations at all, so this is
    // clean regardless of repo root; repoRoot is still passed (a real dir)
    // since an unset one short-circuits to the "skipped" notice above.
    const ctx = loadFixture("valid-bundle", FIXTURES_DIR);
    expect(citationsResolveRule.run(ctx)).toEqual([]);
  });
});

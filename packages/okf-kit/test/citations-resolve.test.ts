import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { citationsResolveRule } from "../src/rules/citations-resolve.js";
import type { Finding } from "../src/types.js";
import { FIXTURES_DIR, loadFixture, runCli } from "./helpers.js";

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
const SHORT_FORM_ROOT = path.join(FIXTURES_DIR, "citations-resolve-short-form");

function loadMain() {
  return loadFixture("citations-resolve-main/docs/okf", MAIN_ROOT);
}

function loadCont() {
  return loadFixture("citations-resolve-continuations/docs/okf", CONT_ROOT);
}

function loadShortForm() {
  return loadFixture("citations-resolve-short-form/docs/okf", SHORT_FORM_ROOT);
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

  // -- unresolved-ambiguous coverage (review round 2, finding 1) -----------

  it("unresolved-ambiguous: two same-basename candidates produce a notice tagged [unresolved-ambiguous] with candidates in detail, and --strict alone does not fail on it", () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-ambig-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src/a"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src/b"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "src/a/shared.ts"),
        "export const a = 1;\n",
      );
      fs.writeFileSync(
        path.join(tmpRoot, "src/b/shared.ts"),
        "export const b = 1;\n",
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "title: Ambiguous-basename fixture",
          "---",
          "",
          "Bare-basename citation with two same-named candidates: `shared.ts:1`.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      const f = findingFor(findings, "shared.ts:1");
      expect(f).toBeDefined();
      expect(f?.severity).toBe("notice");
      expect(f?.message).toContain("[unresolved-ambiguous]");
      expect(f?.detail).toMatch(/^candidates: /);
      expect(f?.detail).toContain("src/a/shared.ts");
      expect(f?.detail).toContain("src/b/shared.ts");

      // runCheck's exitCode only counts errors, and warnings under
      // --strict (see cli.ts): a notice never counts toward either, so a
      // bundle whose only finding is this unresolved-ambiguous notice must
      // still exit 0 even with --strict.
      const strictRun = runCli([
        "check",
        path.join(tmpRoot, "docs/okf"),
        "--repo-root",
        tmpRoot,
        "--strict",
      ]);
      expect(strictRun.status).toBe(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -- unreadable target (review round 2, finding 2) -----------------------

  const isUnsupportedForChmod =
    process.platform === "win32" || process.getuid?.() === 0;

  it.skipIf(isUnsupportedForChmod)(
    "unreadable target: a chmod 000 file is reported as a notice tagged [unreadable-target] with the OS error code in detail, not a thrown error",
    () => {
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "okf-citations-resolve-unreadable-"),
      );
      const targetPath = path.join(tmpRoot, "src/secret.ts");
      try {
        fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
        fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
        fs.writeFileSync(targetPath, "export const a = 1;\n");
        fs.chmodSync(targetPath, 0o000);
        fs.writeFileSync(
          path.join(tmpRoot, "docs/okf/doc.md"),
          [
            "---",
            "type: reference",
            "title: Unreadable-target fixture",
            "sources:",
            "  - src/secret.ts",
            "---",
            "",
            "Citation into a file this process cannot read: `src/secret.ts:1`.",
            "",
          ].join("\n"),
        );

        const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
        const findings = citationsResolveRule.run(ctx);
        const f = findingFor(findings, "src/secret.ts:1");
        expect(f).toBeDefined();
        expect(f?.severity).toBe("notice");
        expect(f?.message).toContain("[unreadable-target]");
        expect(f?.detail).toContain("errorCode:");
      } finally {
        fs.chmodSync(targetPath, 0o644); // restore so rmSync can clean up
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    },
  );

  // -- root-README shadowing (review round 2, finding 3a) -------------------

  it("path resolution: a bare filename citation prefers the nearest ancestor directory over a same-named file at the repo root (shadowing)", () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shadow-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "packages/pkg/docs/okf"), {
        recursive: true,
      });
      // Root-level README.md: short, so a wrong resolution here would trip
      // range-exceeds-file for a citation meant for the package README.
      fs.writeFileSync(
        path.join(tmpRoot, "README.md"),
        Array.from({ length: 5 }, (_, i) => `root line ${i + 1}`).join("\n") +
          "\n",
      );
      // Package-level README.md: long enough to cover the cited range.
      fs.writeFileSync(
        path.join(tmpRoot, "packages/pkg/README.md"),
        Array.from({ length: 20 }, (_, i) => `pkg line ${i + 1}`).join("\n") +
          "\n",
      );
      fs.writeFileSync(
        path.join(tmpRoot, "packages/pkg/docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "title: README shadowing fixture",
          "---",
          "",
          "Bare filename citation meaning this package's own README: `README.md:10-12`.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(
        path.join(tmpRoot, "packages/pkg/docs/okf"),
        tmpRoot,
      );
      const findings = citationsResolveRule.run(ctx);
      expect(findingFor(findings, "README.md:10-12")).toBeUndefined();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -- hard-wrapped path in prose (review round 2, finding 3b) --------------

  it("hard-wrapped prose: a filename split across a line break by the wrap does not produce a phantom missing-file citation for its tail", () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-wrap-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "src/run-state-lifecycle-and-markers.md"),
        "line 1\nline 2\n",
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "title: Hard-wrap fixture",
          "---",
          "",
          "See the details in src/run-state-lifecycle-and-",
          "markers.md:1 for more.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      // Without the guard, CITATION_RE matches the phantom tail
      // "markers.md:1" on its own (a bare filename that does not exist)
      // and reports it as missing-file.
      expect(findingFor(findings, "markers.md:1")).toBeUndefined();
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Short-form (paragraph-bound) citations: a bare (no backtick) colon-range
 * `:N-M` or parenthesized range `(N-M)`, bound to the last full `path:N-M`
 * citation named earlier in the same paragraph (see citations-resolve.ts's
 * "Short-form citations" doc block). Fixture:
 * test/fixtures/citations-resolve-short-form/ (docs/okf/short-form.md +
 * src/target.test.ts, src/note.md).
 */
describe("citations-resolve: short-form citations", () => {
  it("AC1: a paren-form short-form citation binds to the last-named target and resolves cleanly on real content", () => {
    const findings = citationsResolveRule.run(loadShortForm());
    expect(
      findingFor(findings, "src/target.test.ts:9-13 (short-form)"),
    ).toBeUndefined();
  });

  it("AC2: a paren-form short-form range into a test file starting on a non-describe/it line is flagged test-range-start-not-head", () => {
    const findings = citationsResolveRule.run(loadShortForm());
    const f = findingFor(findings, "src/target.test.ts:5-6 (short-form)");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.message).toContain("[test-range-start-not-head]");
  });

  it('AC2: a paren-form short-form range into a test file ending on a line that is not a matching "});" is flagged test-range-end-not-closing', () => {
    const findings = citationsResolveRule.run(loadShortForm());
    const f = findingFor(findings, "src/target.test.ts:4-5 (short-form)");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.message).toContain("[test-range-end-not-closing]");
  });

  it("colon-form short-form citations are NOT held to the test-file describe/it boundary check (documented scope decision)", () => {
    // `:9-9` cites a single content line inside the second describe/it
    // block that is not itself a describe/it head -- if the boundary check
    // applied here as it does to the paren-form "3-4" case above, this
    // would be flagged too. The colon-form sibling must not be, per the
    // scope decision documented on checkRangeBoundary /
    // collectShortFormMatches (colon-form marks an approximate detail
    // location within an already-cited block in this rule's own dogfood
    // corpus, not a block citation).
    const findings = citationsResolveRule.run(loadShortForm());
    expect(
      findingFor(findings, "src/target.test.ts:11-11 (short-form)"),
    ).toBeUndefined();
  });

  it("a short-form citation with no full citation earlier in its own paragraph is reported short-form-unbound, not silently skipped", () => {
    const findings = citationsResolveRule.run(loadShortForm());
    const f = findingFor(findings, "99-101 (short-form)");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.message).toContain(
      "no target document named earlier in this paragraph",
    );
    expect(f?.message).toContain("[short-form-unbound]");
  });

  it("markdown target: a short-form range whose boundary lines are real prose produces no notice", () => {
    const findings = citationsResolveRule.run(loadShortForm());
    expect(
      findingFor(findings, "src/note.md:2-4 (short-form)"),
    ).toBeUndefined();
  });

  it("markdown target: a short-form range starting on a bare bracket line is a NOTICE, not a warning", () => {
    const findings = citationsResolveRule.run(loadShortForm());
    const f = findingFor(findings, "src/note.md:1-3 (short-form)");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("notice");
    expect(f?.message).toContain("[markdown-range-boundary-bracket-or-fence]");
  });

  it("the fixture doc produces exactly the four expected findings, no extras", () => {
    const findings = citationsResolveRule.run(loadShortForm());
    expect(findings).toHaveLength(4);
    expect(findings.filter((f) => f.severity === "warning")).toHaveLength(3);
    expect(findings.filter((f) => f.severity === "notice")).toHaveLength(1);
  });

  it("paragraph boundary: a short-form citation in a LATER paragraph does not inherit an earlier paragraph's target", () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-paragraph-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "src/target.ts"),
        ["line one", "line two", "line three", ""].join("\n"),
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "sources:",
          "  - src/target.ts",
          "---",
          "",
          "First paragraph names the target: `src/target.ts:1-2`.",
          "",
          "Second, later paragraph never names a target of its own: (1-2).",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      const f = findingFor(findings, "1-2 (short-form)");
      expect(f).toBeDefined();
      expect(f?.message).toContain("[short-form-unbound]");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("AC1 negative control: a short-form citation shifted by +2 from its correct line lands on a closing brace and is flagged", () => {
    // Simulates the round-4 drift this rule closes: a formatter run shifts
    // a short-form citation's target lines with no file name attached to
    // re-anchor it. The correct citation here would be `(1-2)` (the
    // function signature and its body); shifted +2 it now reads `(3-4)`,
    // landing on the closing brace and the following blank line.
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-shift-"),
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
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "sources:",
          "  - src/target.ts",
          "---",
          "",
          "Short-form binding demonstration: `src/target.ts:1-2` names the",
          "target. Simulating a prettier-run shift of +2 lines, the same",
          "short-form citation now reads (3-4), landing on the function's",
          "closing brace instead of its body.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      const f = findingFor(findings, "src/target.ts:3-4 (short-form)");
      expect(f).toBeDefined();
      expect(f?.severity).toBe("warning");
      expect(f?.message).toContain("[closing-brace-start-line]");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("reserved files (log.md): short-form matching is skipped entirely, even for a range that would otherwise be flagged", () => {
    // log.md narrates history with "old N-M -> new X-Y" prose; a bare
    // colon-range there is data about the past, not a live citation. This
    // pins that the carve-out is scoped to reserved files (doc.isReserved),
    // not a general suppression.
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-reserved-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "src/target.ts"),
        ["line one", "", "line three", ""].join("\n"),
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/log.md"),
        [
          "- 2026-01-01: moved a block from `src/target.ts:1-1` old :2-2 to new position.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      expect(ctx.docs.find((d) => d.relPath === "log.md")?.isReserved).toBe(
        true,
      );
      expect(findings.filter((f) => f.message.includes("short-form"))).toEqual(
        [],
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

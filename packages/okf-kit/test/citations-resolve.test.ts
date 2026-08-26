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
const ANCHOR_ROOT = path.join(FIXTURES_DIR, "citations-resolve-anchor");
const ANCHOR2_ROOT = path.join(FIXTURES_DIR, "citations-resolve-anchor2");
const ANCHOR_MALFORMED_ROOT = path.join(
  FIXTURES_DIR,
  "citations-resolve-anchor-malformed",
);

function loadMain() {
  return loadFixture("citations-resolve-main/docs/okf", MAIN_ROOT);
}

function loadCont() {
  return loadFixture("citations-resolve-continuations/docs/okf", CONT_ROOT);
}

function loadShortForm() {
  return loadFixture("citations-resolve-short-form/docs/okf", SHORT_FORM_ROOT);
}

function loadAnchor() {
  return loadFixture("citations-resolve-anchor/docs/okf", ANCHOR_ROOT);
}

function loadAnchor2() {
  return loadFixture("citations-resolve-anchor2/docs/okf", ANCHOR2_ROOT);
}

function loadAnchorMalformed() {
  return loadFixture(
    "citations-resolve-anchor-malformed/docs/okf",
    ANCHOR_MALFORMED_ROOT,
  );
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

  // -- unresolved-ambiguous coverage ---------------------------------------

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

  // -- unreadable target -----------------------------------------------

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

  // -- root-README shadowing ---------------------------------------------

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

  // -- hard-wrapped path in prose ----------------------------------------

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
 * `:N-M`, collected only when serial-connective-gated (see
 * isSerialConnectivePreceded), bound unconditionally to the last full
 * `path:N-M` citation named earlier in the same paragraph (see
 * citations-resolve.ts's "Short-form citations" doc block). The bare
 * paren-form `(N-M)` is not collected at all -- see that doc block for
 * why. Fixture: test/fixtures/citations-resolve-short-form/
 * (docs/okf/short-form.md + src/target.test.ts, src/note.md).
 */
describe("citations-resolve: short-form citations", () => {
  it("AC1: a comma-gated short-form citation binds to the last-named target and resolves cleanly on real content", () => {
    const findings = citationsResolveRule.run(loadShortForm());
    expect(
      findingFor(findings, "src/target.test.ts:9-13 (short-form)"),
    ).toBeUndefined();
  });

  it("AC2: a paren-gated short-form range into a test file starting on a non-describe/it line is flagged test-range-start-not-head", () => {
    const findings = citationsResolveRule.run(loadShortForm());
    const f = findingFor(findings, "src/target.test.ts:5-6 (short-form)");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.message).toContain("[test-range-start-not-head]");
  });

  it('AC2: a paren-gated short-form range into a test file ending on a line that is not a matching "});" is flagged test-range-end-not-closing, as a NOTICE (correct start, plausibly a deliberate partial citation)', () => {
    const findings = citationsResolveRule.run(loadShortForm());
    const f = findingFor(findings, "src/target.test.ts:4-5 (short-form)");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("notice");
    expect(f?.message).toContain("[test-range-end-not-closing]");
  });

  it("a comma-gated short-form citation with a bad start line IS held to the test-file describe/it boundary check", () => {
    // `:11-11` cites a single content line inside the second describe/it
    // block that is not itself a describe/it head -- sampling this rule's
    // own dogfood corpus showed whole-block citations shifted by a
    // constant offset, not a "detail location" convention -- a wrong
    // start line is strong drift evidence, so it is a warning.
    const findings = citationsResolveRule.run(loadShortForm());
    const f = findingFor(findings, "src/target.test.ts:11-11 (short-form)");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.message).toContain("[test-range-start-not-head]");
  });

  it("colon-form short-form range whose block-boundary drifted onto ordinary content is flagged (shape: a sub-block citation shifted by a constant offset, nested inside a wider compound-list citation)", () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-colon-drift-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "src/target.test.ts"),
        [
          'import { describe, expect, it } from "vitest";',
          "",
          'describe("alpha", () => {',
          '  it("does a", () => {',
          "    expect(1).toBe(1);",
          "  });",
          "});",
          "",
          'describe("beta", () => {',
          '  it("does b", () => {',
          "    expect(2).toBe(2);",
          "  });",
          "});",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "sources:",
          "  - src/target.test.ts",
          "---",
          "",
          "Names the target once: `src/target.test.ts:3-13`, covering both",
          "blocks below in one compound list; the second block's own sub-",
          "citation is shifted +2 by a formatter run, landing inside it",
          "instead of on its head, :5-9.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      const f = findingFor(findings, "src/target.test.ts:5-9 (short-form)");
      expect(f).toBeDefined();
      expect(f?.severity).toBe("warning");
      expect(f?.message).toContain("[test-range-start-not-head]");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("a short-form citation with no full citation earlier in its own paragraph is reported short-form-unbound, as a NOTICE, not silently skipped", () => {
    const findings = citationsResolveRule.run(loadShortForm());
    const f = findingFor(findings, "99-101 (short-form)");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("notice");
    expect(f?.message).toContain(
      "no full `path:N` citation earlier in this paragraph to bind to",
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

  it("the fixture doc produces exactly the five expected findings, no extras", () => {
    // (5-6) test-range-start-not-head [warning], (4-5) test-range-end-not-closing
    // [notice], :11-11 test-range-start-not-head [warning], (99-101)
    // short-form-unbound [notice], note.md (1-3) markdown-range-boundary
    // -bracket-or-fence [notice].
    const findings = citationsResolveRule.run(loadShortForm());
    expect(findings).toHaveLength(5);
    expect(findings.filter((f) => f.severity === "warning")).toHaveLength(2);
    expect(findings.filter((f) => f.severity === "notice")).toHaveLength(3);
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
          "Second, later paragraph never names a target of its own: (:1-2).",
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
    // Simulates the shape this rule closes: a formatter run shifts
    // a short-form citation's target lines with no file name attached to
    // re-anchor it. The correct citation here would be `(:1-2)` (the
    // function signature and its body); shifted +2 it now reads `(:3-4)`,
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
          "short-form citation now reads (:3-4), landing on the function's",
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

  it("reserved files (log.md): short-form matching is skipped entirely, even for a gate-passing range that would otherwise be flagged", () => {
    // log.md narrates history with "old :N-M -> new :X-Y" prose (not
    // serial-connective-gated in reality, so it would already be excluded
    // by the gate alone); this test uses an "and"-gated range instead so
    // it pins the reserved-file carve-out (doc.isReserved) as its own,
    // separate mechanism, not merely a side effect of the gate.
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
          "- 2026-01-01: moved a block from `src/target.ts:1-1`, and :2-2 to new position.",
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

  it("markdown target: an and-gated short-form range starting on a bracket line is a NOTICE", () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-md-colon-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "src/note.md"),
        ["]", "Second line of prose.", "Third line of prose.", ""].join("\n"),
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "sources:",
          "  - src/note.md",
          "---",
          "",
          "Markdown target, colon-form bracket start: `src/note.md:1-3`",
          "establishes the target, and :1-3 is the flagged sub-citation.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      const f = findingFor(findings, "src/note.md:1-3 (short-form)");
      expect(f).toBeDefined();
      expect(f?.severity).toBe("notice");
      expect(f?.message).toContain(
        "[markdown-range-boundary-bracket-or-fence]",
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -- Code-span / table exclusion, one independent test per exclusion -----
  // (previously one combined fixture; splitting into four pins each
  // exclusion in isolation. The combined fixture's own examples turned out
  // not to exercise computeFencedSpans or computeInlineCodeSpans at all: its
  // fenced block used a backtick fence, already redundantly covered by
  // computeInlineCodeSpans's backtick-pairing regex (the two fence
  // delimiters paired as one giant inline span), and its inline-code
  // example's range sat directly against the closing backtick, already
  // caught by collectShortFormMatches's own pre-existing adjacent-backtick
  // guard. Deleting either computeFencedSpans or computeInlineCodeSpans left
  // the full suite green. The fenced case below uses a tilde `~~~` fence
  // (not backtick-shaped, so computeInlineCodeSpans cannot incidentally
  // cover it) and the inline-code case uses a range with prose on both
  // sides of it inside the span, not touching either backtick.)

  it("a bare range inside a TILDE-fenced code block is never collected as a short-form citation", () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-fenced-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "title: Tilde-fenced exclusion fixture",
          "---",
          "",
          "~~~text",
          "lines, :10-20 drifted",
          "and :55-99 covers scores",
          "~~~",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("a bare range inside an indented code block is never collected as a short-form citation", () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-indented-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "title: Indented code exclusion fixture",
          "---",
          "",
          "Paragraph before.",
          "",
          "    ranges, :30-40 here",
          "",
          "Paragraph after.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("a bare range inside a Markdown table cell is never collected as a short-form citation", () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-table-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "title: Table row exclusion fixture",
          "---",
          "",
          "| col | value |",
          "| --- | --- |",
          "| a, :5-9 | 1 |",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("a bare range inside an inline code span, NOT directly touching either backtick, is never collected as a short-form citation", () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-inline-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "title: Inline code exclusion fixture",
          "---",
          "",
          "Inline code span with a bare range in the middle: `cols, :5-9 shown`.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -- Fence-opening exception (start AND, per this round's fix, end) ------
  // Neither branch of the exception had a fixture before this round:
  // replacing `startIsFence && !isFenceOpeningLine(...)` with plain
  // `startIsFence` also left the full suite green.

  it("a short-form range spanning a whole fenced code block, from its own genuine opening delimiter to its own matching closing delimiter, produces no boundary notice at either end", () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-fence-open-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "src/fenced.md"),
        [
          "Intro line.",
          "",
          "```ts",
          "const x = 1;",
          "```",
          "",
          "Outro line.",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "sources:",
          "  - src/fenced.md",
          "---",
          "",
          "Fence-opening exception: `src/fenced.md:1-7` names the target, and",
          "the sub-citation spanning the whole fenced block by its own",
          "delimiters is (:3-5).",
          "",
          "Fence-closing-as-start: `src/fenced.md:1-7` names the target",
          "again, and the sub-citation starting on the fence's closing",
          "delimiter instead of its opening one is (:5-7).",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);

      expect(
        findingFor(findings, "src/fenced.md:3-5 (short-form)"),
      ).toBeUndefined();

      const f = findingFor(findings, "src/fenced.md:5-7 (short-form)");
      expect(f).toBeDefined();
      expect(f?.severity).toBe("notice");
      expect(f?.message).toContain(
        "[markdown-range-boundary-bracket-or-fence]",
      );
      expect(f?.message).toContain("range start is a bare bracket/fence line");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -- Serial-connective gate (structural, replaces the earlier value-shape
  // -- and containment/adjacency gates -- see the "Short-form citations"
  // -- doc block in citations-resolve.ts) ----------------------------------

  it("comma-, paren-, and and-preceded siblings all bind, while a sibling with no serial connective before it is never collected at all", () => {
    // One source file with two blank lines (3 and 4) so a bound candidate
    // that lands on one produces a real blank-start-line warning -- proof
    // the candidate was actually checked against real content, not merely
    // that the gate silently let it through. Four paragraphs, one full
    // citation each, one candidate each, only the connective preceding the
    // candidate varies.
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-connective-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "src/target.ts"),
        ["line one", "line two", "", "", "line five", ""].join("\n"),
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
          "Comma-preceded: `src/target.ts:1-5` names the target, :3-3 is",
          "comma-preceded and binds.",
          "",
          "Paren-preceded: `src/target.ts:1-5` names the target again, and",
          "this time the range (:4-4) is paren-preceded and binds.",
          "",
          "And-preceded: `src/target.ts:1-5` names the target once more,",
          "and :3-4 is and-preceded and binds.",
          "",
          "No connective: `src/target.ts:1-5` names the target yet again",
          "but :4-5 is not preceded by a serial connective and is never",
          "collected.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);

      const comma = findingFor(findings, "src/target.ts:3-3 (short-form)");
      expect(comma).toBeDefined();
      expect(comma?.severity).toBe("warning");
      expect(comma?.message).toContain("[blank-start-line]");

      const paren = findingFor(findings, "src/target.ts:4-4 (short-form)");
      expect(paren).toBeDefined();
      expect(paren?.severity).toBe("warning");
      expect(paren?.message).toContain("[blank-start-line]");

      const and = findingFor(findings, "src/target.ts:3-4 (short-form)");
      expect(and).toBeDefined();
      expect(and?.severity).toBe("warning");
      expect(and?.message).toContain("[blank-start-line]");

      // The no-connective candidate (:4-5) is dropped before binding is
      // ever attempted: no finding at all, not even short-form-unbound.
      expect(
        findingFor(findings, "src/target.ts:4-5 (short-form)"),
      ).toBeUndefined();
      expect(findingFor(findings, "4-5 (short-form)")).toBeUndefined();
      expect(findings).toHaveLength(3);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('advisor\'s measured probe: a real `path:3-7` citation followed by plain-English "covers phases (1-2), (2-4), and (5-6)" produces no finding, and --strict exits 0', () => {
    // Bare `(N-M)` is never collected as a short-form citation candidate at
    // all -- the regex requires a leading `:`. This is the exact false
    // positive that defeated the previous round's containment/adjacency
    // gate: a doc with `src/t.test.ts:3-7` followed by a compound
    // paren-form list produced two false test-range-start-not-head
    // warnings there ((1-2) bound as "adjacent", (5-6) bound as
    // "contained"). Dropping paren-form collection removes the false
    // positive without any gate to get wrong.
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-advisor-probe-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "src/t.test.ts"),
        [
          'import { describe, expect, it } from "vitest";',
          "",
          'describe("group", () => {',
          '  it("does x", () => {',
          "    expect(1).toBe(1);",
          "  });",
          "});",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "sources:",
          "  - src/t.test.ts",
          "---",
          "",
          "The `src/t.test.ts:3-7` block covers phases (1-2), (2-4), and",
          "(5-6).",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      expect(findings).toEqual([]);

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

  it('reviewer\'s original probe: a real `path:3-7` citation plus plain-English "Follow steps (2-4) to reproduce" produces no finding, and --strict exits 0', () => {
    // (2-4) is a bare paren-form range, never a short-form candidate at
    // all under this round's design -- not bound, not reported unbound,
    // just never collected.
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-reviewer-probe-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "src/t.test.ts"),
        [
          'import { describe, expect, it } from "vitest";',
          "",
          'describe("group", () => {',
          '  it("does x", () => {',
          "    expect(1).toBe(1);",
          "  });",
          "});",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "sources:",
          "  - src/t.test.ts",
          "---",
          "",
          "The `src/t.test.ts:3-7` block is covered. Follow steps (2-4) to",
          "reproduce.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      expect(findings).toEqual([]);

      const strictRun = runCli([
        "check",
        path.join(tmpRoot, "docs/okf"),
        "--repo-root",
        tmpRoot,
        "--strict",
      ]);
      expect(strictRun.status).toBe(0);
      expect(strictRun.stdout).not.toContain("WARN");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -- Unmatched backtick (single-line inline-code confinement) ------------

  it("an unmatched backtick earlier in the paragraph does not pair across a line break with an unrelated later backtick run, silently swallowing a short-form range in between", () => {
    // Reviewer probe: a stray, unpartnered backtick on one line used to pair
    // greedily with the *next* backtick run anywhere later in the document
    // (computeInlineCodeSpans previously matched across newlines), treating
    // everything between the two -- including an unrelated short-form range
    // on a later line -- as one giant inline code span. Confining the
    // pairing regex to a single line means a backtick with no partner on
    // its own line produces no span at all.
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-citations-resolve-shortform-stray-backtick-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "src/a.ts"),
        [
          "export function foo() {",
          "  return 1;",
          "}",
          "",
          "",
          "export function bar() {",
          "  return 2;",
          "}",
          "// trailer",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs/okf/doc.md"),
        [
          "---",
          "type: reference",
          "sources:",
          "  - src/a.ts",
          "---",
          "",
          "Names `src/a.ts:1-4`. An unmatched ` backtick here, then, :5-9",
          "drifted, then `code`.",
          "",
        ].join("\n"),
      );

      const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
      const findings = citationsResolveRule.run(ctx);
      const f = findingFor(findings, "src/a.ts:5-9 (short-form)");
      expect(f).toBeDefined();
      expect(f?.severity).toBe("warning");
      expect(f?.message).toContain("[blank-start-line]");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("citations-resolve: anchored citations", () => {
  it("scans the fixture doc and returns exactly the four expected anchor findings", () => {
    const ctx = loadAnchor();
    const findings = citationsResolveRule.run(ctx);
    const anchorRuleIds = [
      "anchor-heading-does-not-enclose",
      "anchor-heading-mismatch",
      "anchor-heading-not-found",
      "anchor-not-found-in-range",
    ];
    const anchorFindings = findings.filter((f) =>
      anchorRuleIds.some((id) => f.message.includes(`[${id}]`)),
    );
    expect(anchorFindings).toHaveLength(4);
    expect(anchorFindings.every((f) => f.severity === "warning")).toBe(true);
  });

  it("heading anchor that encloses the whole range produces no finding", () => {
    const findings = citationsResolveRule.run(loadAnchor());
    expect(findingFor(findings, "src/CHANGELOG.md:7-8#2.0.0")).toBeUndefined();
  });

  it("bracket-wrapped heading anchor (`#[2.0.0]`) is equivalent to the bare form", () => {
    const findings = citationsResolveRule.run(loadAnchor());
    expect(findingFor(findings, "src/CHANGELOG.md:8-9#2.0.0")).toBeUndefined();
  });

  it("heading anchor whose range crosses into the next release section is flagged anchor-heading-does-not-enclose", () => {
    const findings = citationsResolveRule.run(loadAnchor());
    const f = findingFor(findings, "src/CHANGELOG.md:9-19#2.0.0");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.message).toContain("[anchor-heading-does-not-enclose]");
    // Pins a concrete piece of the message text (offending line number and
    // heading text), not just "a finding exists" -- so a mutation that
    // removes the enclosure walk but keeps some other unrelated finding
    // alive on this citation would still fail this assertion. The message
    // also names the anchor itself now, so a mutation that drops the anchor
    // text from this specific message (while leaving the label alone) is
    // caught too.
    expect(f?.message).toContain('anchor "2.0.0"');
    expect(f?.message).toContain(
      'next heading "[1.0.0] - 2026-01-01" at line 15',
    );
  });

  it("heading anchor naming the wrong release is flagged anchor-heading-mismatch", () => {
    const findings = citationsResolveRule.run(loadAnchor());
    const f = findingFor(findings, "src/CHANGELOG.md:13-13#1.0.0");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.message).toContain("[anchor-heading-mismatch]");
    expect(f?.message).toContain('does not contain anchor "1.0.0"');
  });

  it("heading anchor with no heading preceding the cited range is flagged anchor-heading-not-found", () => {
    const findings = citationsResolveRule.run(loadAnchor());
    const f = findingFor(findings, "src/CHANGELOG.md:1-1#2.0.0");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.message).toContain("[anchor-heading-not-found]");
    expect(f?.message).toContain('anchor "2.0.0"');
  });

  it("string anchor found inside the cited range produces no finding", () => {
    const findings = citationsResolveRule.run(loadAnchor());
    expect(
      findingFor(findings, 'src/note.md:2-2#"Second line"'),
    ).toBeUndefined();
  });

  it("string anchor not found inside the cited range is flagged anchor-not-found-in-range", () => {
    const findings = citationsResolveRule.run(loadAnchor());
    const f = findingFor(findings, 'src/note.md:2-3#"nonexistent phrase"');
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.message).toContain("[anchor-not-found-in-range]");
    expect(f?.message).toContain('anchor "nonexistent phrase"');
  });

  it("an ordinary anchorless citation is unaffected: same behavior as before anchors existed", () => {
    const findings = citationsResolveRule.run(loadAnchor());
    expect(findingFor(findings, "src/note.md:1")).toBeUndefined();
  });
});

// Fixes from the first review round on anchored citations, exercised
// against their own fixture bundle (citations-resolve-anchor2) rather than
// growing the pinned fixture above, whose exact finding count and line
// numbers several existing assertions already depend on.
describe("citations-resolve: anchored citations (fence, charset, and quoting edge cases)", () => {
  it("a fenced code block's `#`-led comment line in the target is not mistaken for a heading", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    expect(findingFor(findings, "src/fenced.md:1-10#3.0.0")).toBeUndefined();
  });

  it("a heading-anchored citation starting after a fenced `#`-led comment still finds the real heading above the fence", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    expect(findingFor(findings, "src/fenced.md:10-10#3.0.0")).toBeUndefined();
  });

  it("the same target content without fence markers really does end the section at the `#`-led line", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    const f = findingFor(findings, "src/fenced-plain.md:1-8#3.0.0");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[anchor-heading-does-not-enclose]");
    expect(f?.message).toContain('anchor "3.0.0"');
    expect(f?.message).toContain('next heading "not a heading" at line 5');
  });

  it("a heading anchor at the end of a sentence does not swallow the trailing period", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    expect(findingFor(findings, "src/CHANGELOG.md:5-6#2.0.0")).toBeUndefined();
  });

  it("a hyphenated heading anchor is captured whole, not truncated at the hyphen", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    const f = findingFor(findings, "src/CHANGELOG.md:5-7#2.0.0-rc1");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[anchor-heading-mismatch]");
    expect(f?.message).toContain('anchor "2.0.0-rc1"');
  });

  it("a hyphenated, non-numeric heading anchor is also captured whole", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    const f = findingFor(findings, "src/CHANGELOG.md:6-7#some-anchor");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[anchor-heading-mismatch]");
    expect(f?.message).toContain('anchor "some-anchor"');
  });

  it("a malformed (unterminated) quoted anchor does not swallow a later citation across a line break", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    const f = findingFor(findings, "src/note.md:10-11");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[range-exceeds-file]");
  });

  it("a bracket-wrapped anchor is stripped before comparison against a heading with no brackets of its own", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    expect(findingFor(findings, "src/CHANGELOG.md:11#3.0.0")).toBeUndefined();
  });

  it("a single-line heading-anchored citation (no dash range) resolves correctly", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    expect(findingFor(findings, "src/CHANGELOG.md:5#2.0.0")).toBeUndefined();
  });

  it("a string anchor against a non-Markdown target, found", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    expect(
      findingFor(findings, 'src/code.ts:1#"verifyVerdict"'),
    ).toBeUndefined();
  });

  it("a string anchor against a non-Markdown target, not found", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    const f = findingFor(findings, 'src/code.ts:2#"verifyVerdict"');
    expect(f).toBeDefined();
    expect(f?.message).toContain("[anchor-not-found-in-range]");
    expect(f?.message).toContain('anchor "verifyVerdict"');
  });

  it("an anchored full citation's short-form sibling in the same paragraph still binds and is checked", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    const f = findingFor(findings, "src/CHANGELOG.md:20-21 (short-form)");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[range-exceeds-file]");
  });

  // The fence scanner every fence-aware check here (computeFencedSpans,
  // computeFencedLineIndices, isFenceOpeningLine) draws from is a single
  // shared state machine (see scanFenceLines in the source); these two
  // cases exercise the target-side twin (computeFencedLineIndices, via the
  // anchor heading search) against a TILDE fence and an UNTERMINATED fence
  // respectively -- both already covered for the backtick, terminated case
  // above (`src/fenced.md`). A mutation that broke the tilde or
  // "till end of file" derivation specifically (while leaving the backtick
  // case intact) would turn either of these two red without touching any
  // other test in this file.
  it("a heading-anchored citation past a TILDE-fenced `#`-led comment still finds the real heading above the fence", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    expect(
      findingFor(findings, "src/fenced-tilde.md:10-10#5.0.0"),
    ).toBeUndefined();
  });

  it("a heading-anchored citation landing deep inside an UNTERMINATED fence still finds the real heading above it", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    expect(
      findingFor(findings, "src/fenced-unterminated.md:7-8#6.0.0"),
    ).toBeUndefined();
  });
});

// anchor-malformed: a `#` immediately follows a citation's range but the
// text after it does not parse as either anchor form (unbalanced quotes, a
// backtick inside a quoted anchor, or nothing at all after the `#`). See
// the "Anchored citations" doc block above `parseAnchor` in the source.
describe("citations-resolve: anchor-malformed", () => {
  it("a backtick inside a quoted anchor is flagged anchor-malformed (notice), citation still checked anchorless", () => {
    const findings = citationsResolveRule.run(loadAnchorMalformed());
    const f = findingFor(findings, "src/short.md:3-3");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("notice");
    expect(f?.message).toContain("[anchor-malformed]");
  });

  it("nothing after the `#` at the end of a line is flagged anchor-malformed too", () => {
    const findings = citationsResolveRule.run(loadAnchorMalformed());
    const f = findingFor(findings, "src/note.md:2");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("notice");
    expect(f?.message).toContain("[anchor-malformed]");
  });

  it("an unterminated quoted anchor (elsewhere in this suite, citations-resolve-anchor2) is flagged anchor-malformed too", () => {
    const findings = citationsResolveRule.run(loadAnchor2());
    const f = findingFor(findings, "src/note.md:1");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("notice");
    expect(f?.message).toContain("[anchor-malformed]");
  });

  it("negative control: a valid anchor produces no anchor-malformed finding", () => {
    const findings = citationsResolveRule.run(loadAnchorMalformed());
    const anchorMalformed = findings.filter((f) =>
      f.message.includes("[anchor-malformed]"),
    );
    // Exactly the two malformed citations above (short.md:3-3, note.md:2);
    // the valid string anchor (short.md:1#"intro") and the stray `#` in
    // prose below both contribute nothing.
    expect(anchorMalformed).toHaveLength(2);
    expect(
      findingFor(findings, 'src/short.md:1#"intro"'),
    ).toBeUndefined();
  });

  it("negative control: a `#` in prose with no preceding citation range produces nothing", () => {
    const findings = citationsResolveRule.run(loadAnchorMalformed());
    expect(
      findings.some((f) => f.message.includes("this doc uses")),
    ).toBe(false);
  });
});

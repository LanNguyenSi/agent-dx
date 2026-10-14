import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/cli.js";
import type { Finding } from "../src/types.js";
import { FIXTURES_DIR } from "./helpers.js";

// Baseline pin for OKF v0.1 behavior: the COMPLETE finding list every
// pre-existing fixture produces, captured before any v0.2 work landed and
// snapshotted so a later change to version detection, the timestamp helpers
// or any rule cannot quietly move a v0.1 bundle's findings. Every fixture
// is checked with an explicit `repoRoot` equal to the fixture directory
// itself and a `runGit` stub that reports "no git answer", so the result
// depends on the fixture content alone -- never on the ambient git work
// tree this package happens to live in, and never on real commit history.
//
// The fixture list is deliberately explicit (not a readdir of the
// fixtures directory): this file pins the fixtures that existed when v0.2
// support started, and new fixtures added by later tasks belong to those
// tasks' own tests, not to this baseline.
const V01_FIXTURES = [
  "absolute-link",
  "bad-sources-shape",
  "broken-link",
  "broken-link-angle",
  "broken-link-titled",
  "citations-resolve-anchor",
  "citations-resolve-anchor-malformed",
  "citations-resolve-anchor2",
  "citations-resolve-continuations",
  "citations-resolve-heading-section",
  "citations-resolve-main",
  "citations-resolve-require-anchors",
  "citations-resolve-require-anchors-continuation-exemptions",
  "citations-resolve-require-anchors-continuations",
  "citations-resolve-short-form",
  "docs-for-bundle",
  "empty-type",
  "frontmatter-on-reserved",
  "frontmatter-refs",
  "malformed-yaml",
  "missing-frontmatter",
  "missing-source-path",
  "prose-line-references-ambiguous",
  "prose-line-references-binder",
  "prose-line-references-heading-comment",
  "prose-line-references-hyphenword",
  "prose-line-references-json-ext",
  "prose-line-references-main",
  "prose-line-references-mentions",
  "prose-line-references-negative",
  "prose-line-references-ranges",
  "prose-line-references-reserved",
  "prose-line-references-zero",
  "valid-bundle",
];

function checkFixture(name: string): Finding[] {
  const dir = path.join(FIXTURES_DIR, name);
  // A stub runGit that fails every call: repoRoot is explicit, so the only
  // git reads left are the staleness lookups, which then deterministically
  // answer "no history" for every source and doc.
  //
  // `reserved-files-structure` is dropped from the comparison on purpose: it
  // is a new rule that warns about the body shape of the reserved files, and
  // several pre-existing fixtures carry a non-conformant `log.md` (for example
  // `valid-bundle`'s bullet-only log). This baseline predates that rule and is
  // meant to pin the OLD rules only, so its snapshot is left untouched rather
  // than folded around findings the fixtures were never written to satisfy.
  return runCheck(dir, { repoRoot: dir, runGit: () => null }).findings.filter(
    (finding) => finding.ruleId !== "reserved-files-structure",
  );
}

describe("v0.1 fixture baseline", () => {
  it("pins the complete finding list of every pre-existing v0.1 fixture", () => {
    const findingsByFixture: Record<
      string,
      Array<Record<string, unknown>>
    > = {};
    for (const name of V01_FIXTURES) {
      findingsByFixture[name] = checkFixture(name).map((finding) => ({
        ruleId: finding.ruleId,
        severity: finding.severity,
        file: finding.file,
        message: finding.message,
        ...(finding.detail === undefined
          ? {}
          : { detail: finding.detail as string }),
      }));
    }
    expect(findingsByFixture).toMatchSnapshot();
  });
});

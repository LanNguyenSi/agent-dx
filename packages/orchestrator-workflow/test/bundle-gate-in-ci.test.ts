import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

const bundleGate = readAsset("skill/references/bundle-gate-in-ci.md");
const skillMd = readAsset("skill/SKILL.md");

// Collapse line wraps and indentation so a pin matches a whole sentence
// regardless of where the asset wraps it.
const unwrap = (text: string) => text.replace(/\s+/g, " ");

const pin = (doc: string, sentence: string) => {
  expect(unwrap(doc)).toContain(sentence);
};

/** The hand-off step of the SKILL.md orchestration sequence, alone. */
function handOffStep(): string {
  const start = skillMd.indexOf("6. **Hand off.**");
  expect(start, "hand-off step not found in SKILL.md").toBeGreaterThan(-1);
  const end = skillMd.indexOf("\n## ", start);
  return skillMd.slice(start, end === -1 ? undefined : end);
}

describe("bundle gate in CI reference", () => {
  it("is linked from the SKILL.md hand-off step", () => {
    pin(
      handOffStep(),
      "To catch drift between runs as well, gate the bundles in CI as described in [bundle gate in CI](references/bundle-gate-in-ci.md).",
    );
  });

  it("states the limit of what the gate proves", () => {
    pin(
      bundleGate,
      "The gate proves that a doc was re-stamped after its sources changed, not that its content is correct; review of the doc against its sources stays mandatory.",
    );
  });

  it("requires a full-history checkout and says why", () => {
    pin(
      bundleGate,
      "Check out the full history (`fetch-depth: 0` with `actions/checkout`): the `sources-fresh` rule dates each source by its last commit and asks whether the doc's own last commit re-stamped the doc, and a shallow clone cannot answer that, so it reports `staleness not assessable` notices instead of a STALE verdict.",
    );
    expect(bundleGate).toContain("fetch-depth: 0\n");
  });

  it("names the three rollout stages", () => {
    pin(
      bundleGate,
      "1. Stage 1, warn-only: run the check on every change, publish every finding as an annotation and in the job summary, and never fail the job on a finding.",
    );
    pin(
      bundleGate,
      "2. Stage 2, block on structure and staleness: fail the job on any error-severity finding (structure: frontmatter, links, sources shape) and on any `sources-fresh` or `sources-fresh-future` warning, selected from the `--json` report with a filter; other warnings stay advisory.",
    );
    pin(
      bundleGate,
      "3. Stage 3, strict: run the check with `--strict`, which fails on every warning from every rule.",
    );
    pin(
      bundleGate,
      "The exit code alone is not the signal for stage 1 or stage 2: `okf-kit check` exits 0 when it finds only warnings (STALE and FUTURE-DATED findings are warnings) and 1 when it finds an error, so read the JSON report to decide.",
    );
  });

  it("gives the pre-commit recipe with --dirty-as-now", () => {
    pin(
      bundleGate,
      "Run `okf-kit check <bundle> --repo-root <repoRoot> --dirty-as-now` before committing: it treats every uncommitted change as one virtual commit made now, so the local run reports the same `sources-fresh` and `sources-fresh-future` verdict CI will report once the commit lands.",
    );
  });

  it("covers every configured bundle with its own repo root", () => {
    pin(
      bundleGate,
      "Run one check per bundle and pass `--repo-root <repoRoot>` explicitly:",
    );
    expect(bundleGate).toContain('--repo-root "$REPO_ROOT"');
  });

  it("keeps the example free of a concrete pin and a hard-coded runner", () => {
    expect(bundleGate).toContain("okf-kit@<pinned-version>");
    expect(bundleGate).not.toMatch(/okf-kit@\d/);
    expect(bundleGate).not.toMatch(/actions\/checkout@v\d/);
    expect(bundleGate).toContain("runs-on: ${{ inputs.runner }}");
    expect(bundleGate).not.toMatch(/runs-on: (?!\$\{\{ inputs\.runner \}\})/);
  });
});

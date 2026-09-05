import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

/**
 * The run templates carry a machine-readable solution-acceptance marker that a
 * downstream run-gate reads instead of parsing prose. These checks pin the
 * marker shape (exactly one per template) and the shipped fail-closed default
 * (`TODO`, which is not a valid enum value) so the contract cannot drift.
 */
describe("solution-acceptance markers in run templates", () => {
  const handoffTemplate = readAsset("templates/06-handoff.md");
  const reviewTemplate = readAsset("templates/05-review-findings.md");
  const goalTemplate = readAsset("templates/00-goal.md");

  const finalStatusRe = /solution-acceptance:\s*final-status\s*=\s*(\S+)/g;
  const recommendationRe =
    /solution-acceptance:\s*acceptance-recommendation\s*=\s*(\S+)/g;
  const runBaseRe = /solution-acceptance:\s*run-base\s*=\s*(\S+)/g;

  it("06-handoff.md has exactly one final-status marker, defaulting to TODO", () => {
    const matches = [...handoffTemplate.matchAll(finalStatusRe)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("TODO");
  });

  it("05-review-findings.md has exactly one acceptance-recommendation marker, defaulting to TODO", () => {
    const matches = [...reviewTemplate.matchAll(recommendationRe)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("TODO");
  });

  it("00-goal.md has exactly one run-base marker, defaulting to TODO", () => {
    const matches = [...goalTemplate.matchAll(runBaseRe)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("TODO");
  });

  it("00-goal.md carries the run-base marker line byte-exactly, wrapper included", () => {
    expect(goalTemplate).toContain(
      "<!-- solution-acceptance: run-base = TODO -->",
    );
  });

  /**
   * grounding-mcp's ow-run-completeness reader treats a whole-line HTML
   * comment matching `<!-- solution-acceptance: run-base[<key>] = <sha> -->`
   * as a keyed run-base marker for multi-repo runs, but skips a key of the
   * placeholder shape `<...>` as a documentation example rather than a real
   * marker. This pins the shipped placeholder line: its exact text, its
   * whole-line-comment shape (not embedded in a list bullet or prose), and
   * its position immediately after the unkeyed marker, so the two repos
   * cannot drift apart on the grammar.
   */
  it("00-goal.md carries the keyed run-base placeholder line byte-exactly, wrapper included", () => {
    expect(goalTemplate).toContain(
      "<!-- solution-acceptance: run-base[<repo-basename>] = <sha> -->",
    );
  });

  it("the keyed run-base placeholder line is a standalone whole-line comment", () => {
    const lines = goalTemplate.split(/\r?\n/);
    const keyedLine = lines.find((line) =>
      line.includes("run-base[<repo-basename>]"),
    );
    expect(keyedLine).toBeDefined();
    const trimmed = (keyedLine ?? "").trim();
    expect(trimmed.startsWith("<!--")).toBe(true);
    expect(trimmed.endsWith("-->")).toBe(true);
  });

  it("the keyed run-base placeholder line sits directly below the unkeyed marker", () => {
    const lines = goalTemplate.split(/\r?\n/);
    const unkeyedIndex = lines.findIndex((line) =>
      line.includes("<!-- solution-acceptance: run-base = TODO -->"),
    );
    expect(unkeyedIndex).toBeGreaterThanOrEqual(0);
    expect(lines[unkeyedIndex + 1]).toBe(
      "<!-- solution-acceptance: run-base[<repo-basename>] = <sha> -->",
    );
  });

  it("the existing unkeyed run-base regex still matches exactly once (the keyed line's bracket does not match `run-base\\s*=`)", () => {
    const matches = [...goalTemplate.matchAll(runBaseRe)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("TODO");
  });

  /**
   * Property test carrying grounding-mcp's KEYED_RUN_BASE_STRICT regex and
   * its PLACEHOLDER_KEY check (ow-run-completeness.ts) verbatim, kept in
   * sync by hand: a change to either regex there must be copied here too.
   * Asserts the shipped line matches the strict consumer shape, its
   * captured key is the placeholder shape, and that near-miss variants
   * (uppercase, space before the colon) do not match, as a sanity check of
   * the copied regex itself.
   */
  it("the shipped keyed run-base line matches the strict consumer shape and near-miss variants do not", () => {
    const KEYED_RUN_BASE_STRICT =
      /^\s*<!--\s*solution-acceptance:\s*run-base\[([^\]\n]+)\]\s*=\s*(?!-->)(\S+)\s*-->\s*$/;
    const PLACEHOLDER_KEY = /^<[^>]*>$/;

    const lines = goalTemplate.split(/\r?\n/);
    const keyedLine = lines.find((line) =>
      line.includes("run-base[<repo-basename>]"),
    );
    expect(keyedLine).toBeDefined();

    const match = (keyedLine ?? "").match(KEYED_RUN_BASE_STRICT);
    expect(match).not.toBeNull();
    expect(PLACEHOLDER_KEY.test(match?.[1] ?? "")).toBe(true);

    const nearMissVariants = [
      // uppercase
      "<!-- Solution-acceptance: run-base[<repo>] = <commit> -->",
      // space before the colon
      "<!-- solution-acceptance : run-base[<repo>] = <commit> -->",
    ];
    for (const variant of nearMissVariants) {
      expect(KEYED_RUN_BASE_STRICT.test(variant)).toBe(false);
    }
  });

  it("05-review-findings.md carries a recurrence note pointing at the reviewer contract's recurrence field and the review-round escalation budget", () => {
    expect(reviewTemplate).toContain(
      "<!-- Recurrence note: each finding in the reviewer output contract also carries a `recurrence` field (new or repeated), letting the orchestrator read the Review-round escalation budget's trigger (SKILL.md, Review-round escalation budget) off the reviewer's own return instead of reconstructing it by hand. A repeated finding here is what feeds that budget's round count. -->",
    );
  });
});

/**
 * The grounding-mcp orchestrator-workflow completeness reader locates the
 * findings table by its header row (a table row whose cells include both
 * `Severity` and `Decision`, case-insensitive) rather than by heading text,
 * and yields an explicit blocker when a findings section has content but no
 * such header row anywhere in the file. This pins the shipped header row so
 * the template cannot silently drift onto a convention (e.g. a
 * Decision-less `| Severity | Finding | Resolution |` table) the reader
 * cannot verify.
 */
describe("05-review-findings.md findings-table header convention", () => {
  const reviewTemplate = readAsset("templates/05-review-findings.md");

  it("carries a header row with both Severity and Decision columns", () => {
    const headerRow = reviewTemplate
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("|") && /severity/i.test(line));
    expect(headerRow).toBeDefined();
    const cells = (headerRow ?? "")
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().toLowerCase());
    expect(cells).toContain("severity");
    expect(cells).toContain("decision");
  });

  it("documents the header as load-bearing above the table", () => {
    expect(reviewTemplate).toMatch(/<!--[^>]*load-bearing[^>]*-->/i);
  });

  it("invites only the reader's resolved Decision vocabulary in the example row", () => {
    // grounding-mcp's completeness reader treats a high/critical finding as
    // resolved ONLY when its Decision is `accepted` or `defer` (RESOLVED_DECISIONS).
    // The example row must not offer arming values (fix/reject) as if they were
    // resolutions, or an operator following the template hits a surprising gate.
    const exampleRow = reviewTemplate
      .split(/\r?\n/)
      .find(
        (line) =>
          line.trim().startsWith("|") &&
          /low\/medium\/high\/critical/i.test(line),
      );
    expect(exampleRow).toBeDefined();
    const cells = (exampleRow ?? "")
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const decisionCell = cells[cells.length - 1];
    const tokens = decisionCell
      .split("/")
      .map((token) => token.trim())
      .filter(Boolean);
    // Mutation-check: re-adding fix/reject to the example cell fails this.
    expect(tokens).toEqual(["accepted", "defer"]);
  });

  it("documents that non-resolved Decision values arm the completeness gate", () => {
    // The legend must name the arming behavior so the narrowed example reads as
    // "these resolve; others arm", not "these are the only legal values".
    expect(reviewTemplate).toMatch(
      /RESOLVED_DECISIONS\s*=\s*\{\s*accepted\s*,\s*defer\s*\}/,
    );
    expect(reviewTemplate).toMatch(/arms? the (?:completeness )?gate/i);
  });
});

/**
 * grounding-mcp's ow-run-completeness reader (packages/grounding-mcp/src/
 * ow-run-completeness.ts, own release cycle in the agent-grounding repo)
 * matches this exact example row literally to decide a row is the shipped
 * legend, not a real finding (its SEVERITY cell is the slash-list
 * `low/medium/high/critical` rather than a single concrete value). A lockstep
 * sibling change there makes an untouched copy of this row, with no concrete
 * finding row alongside it, fail the completeness gate closed instead of
 * silently passing (the "Mixed-State-Bypass": marker set to `accepted`,
 * table left as the pristine template). This test pins the row's literal
 * wording on the agent-dx side so the two repos cannot drift apart silently.
 */
describe("05-review-findings.md placeholder-row fail-closed convention", () => {
  const reviewTemplate = readAsset("templates/05-review-findings.md");

  it("carries the exact placeholder row grounding-mcp's completeness reader matches literally", () => {
    // Mutation-check: editing any cell of this row (including the HTML-comment
    // placeholders) fails this assertion.
    expect(reviewTemplate).toContain(
      "| low/medium/high/critical | correctness/architecture/security/tests/maintainability/performance/docs | <!-- finding --> | <!-- fix --> | accepted/defer |",
    );
  });

  it("documents the placeholder row's fail-closed semantics next to the row", () => {
    // The rule must be spelled out where an operator edits the row: replace it
    // when transferring findings, delete it for a genuine zero-findings review.
    expect(reviewTemplate).toMatch(/replace this row/i);
    expect(reviewTemplate).toMatch(/zero-findings review, delete this row/i);
  });
});

/**
 * The fix-round mutation-probe replay rule (SKILL.md step 6,
 * assets/agents/implementer.md) names 04-implementation-summary.md as the
 * source of prior rounds' probes, but the template previously had no slot
 * to hold them. This pins the added "Mutation Probes" subsection under
 * Test Evidence, one row per probe with the round it was named in and the
 * `replayed` flag, so a task's evidence has somewhere to actually live.
 */
describe("04-implementation-summary.md Mutation Probes subsection", () => {
  const implementationTemplate = readAsset(
    "templates/04-implementation-summary.md",
  );

  it("carries a Mutation Probes subsection under Test Evidence", () => {
    expect(implementationTemplate).toContain("### Mutation Probes");
  });

  it("places the Mutation Probes subsection between Test Evidence and Risks / Notes", () => {
    const testEvidenceIndex = implementationTemplate.indexOf(
      "## Test Evidence",
    );
    const mutationProbesIndex = implementationTemplate.indexOf(
      "### Mutation Probes",
    );
    const risksIndex = implementationTemplate.indexOf("## Risks / Notes");
    expect(testEvidenceIndex).toBeGreaterThanOrEqual(0);
    expect(mutationProbesIndex).toBeGreaterThan(testEvidenceIndex);
    expect(risksIndex).toBeGreaterThan(mutationProbesIndex);
  });

  it("carries a header row with Round, Mutant, Verified Applied Via, Result, Restored Verified, and Replayed columns", () => {
    const mutationProbesIndex = implementationTemplate.indexOf(
      "### Mutation Probes",
    );
    expect(mutationProbesIndex).toBeGreaterThanOrEqual(0);
    const tableText = implementationTemplate.slice(mutationProbesIndex);
    const headerRow = tableText
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("|") && /round/i.test(line));
    expect(headerRow).toBeDefined();
    const cells = (headerRow ?? "")
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().toLowerCase());
    expect(cells).toEqual([
      "round",
      "mutant",
      "verified applied via",
      "result",
      "restored verified",
      "replayed",
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { readAsset as readRawAsset } from "../src/assets.js";

const workflowReferences = [
  "run-state-and-harness.md",
  "evidence-and-probes.md",
  "contracts.md",
  "review-and-recovery.md",
];
const readAsset = (path: string) =>
  path === "skill/SKILL.md"
    ? [
        readRawAsset(path),
        ...workflowReferences.map((name) =>
          readRawAsset(`skill/references/${name}`),
        ),
      ].join("\n\n")
    : readRawAsset(path);

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
 * The review-method axis (SKILL.md step 7, assets/agents/reviewer.md) adds a
 * per-round `review_method`/`method_applied` note to 05-review-findings.md,
 * deliberately outside the pinned Findings table (whose Severity/Decision
 * header row the completeness reader locates the table by, per the tests
 * above). The grounding-mcp reader parses both markers; these tests pin their
 * shapes and position above the Findings heading, so a future edit cannot
 * silently move either one inside the guarded table or drop it. The explicit
 * method-applied marker has a lockstep pin below.
 */
describe("05-review-findings.md carries a review-method note per round, outside the Findings table", () => {
  const reviewTemplate = readAsset("templates/05-review-findings.md");

  const reviewMethodRe = /review-method\[<round>\]\s*=\s*(\S+)/g;

  it("has exactly one review-method marker, offering only the three obligation sets", () => {
    const matches = [...reviewTemplate.matchAll(reviewMethodRe)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("normal|rigorous|adversarial");
  });

  it("carries the marker line byte-exactly, wrapper included", () => {
    expect(reviewTemplate).toContain(
      "<!-- review-method[<round>] = normal|rigorous|adversarial -->",
    );
  });

  it("carries a prose Method line naming review_method and method_applied", () => {
    const lines = reviewTemplate.split(/\r?\n/);
    const methodLineIndex = lines.findIndex((line) =>
      line.startsWith("Method:"),
    );
    expect(methodLineIndex).toBeGreaterThanOrEqual(0);
    const methodParagraph = lines
      .slice(methodLineIndex, methodLineIndex + 3)
      .join(" ");
    expect(methodParagraph).toContain("review_method");
    expect(methodParagraph).toContain("method_applied");
  });

  it("states the reader-backed method-applied grammar", () => {
    expect(reviewTemplate).toContain(
      "<!-- method-applied[<round>] = normal|rigorous|adversarial -->",
    );
  });

  it("sits above the Findings heading, outside the pinned table", () => {
    const markerIndex = reviewTemplate.indexOf(
      "<!-- review-method[<round>] = normal|rigorous|adversarial -->",
    );
    const findingsHeadingIndex = reviewTemplate.indexOf("## Findings");
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(findingsHeadingIndex).toBeGreaterThan(markerIndex);
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
    expect(cells).toHaveLength(5);
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
    const decisionCell = cells[cells.indexOf("accepted/defer")];
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
  const legacyTableHeader =
    "| Severity | Category | Description | Suggested Fix | Decision |";
  const legacyTableSeparator = "|---|---|---|---|---|";
  const legacyPlaceholder =
    "| low/medium/high/critical | correctness/architecture/security/tests/maintainability/performance/docs | <!-- finding --> | <!-- fix --> | accepted/defer |";

  it("carries the exact placeholder row grounding-mcp's completeness reader matches literally", () => {
    // Mutation-check: editing any cell of this row (including the HTML-comment
    // placeholders) fails this assertion.
    expect(reviewTemplate).toContain(
      [legacyTableHeader, legacyTableSeparator, legacyPlaceholder].join("\n"),
    );
  });

  it("keeps the entire legacy five-cell table schema byte- and cell-stable", () => {
    const tableRows = [
      legacyTableHeader,
      legacyTableSeparator,
      legacyPlaceholder,
    ];
    for (const row of tableRows) {
      expect(reviewTemplate.split(/\r?\n/)).toContain(row);
      expect(row.split("|").slice(1, -1)).toHaveLength(5);
    }
  });

  it("documents the placeholder row's fail-closed semantics next to the row", () => {
    // The rule must be spelled out where an operator edits the row: replace it
    // when transferring findings, delete it for a genuine zero-findings review.
    expect(reviewTemplate).toMatch(/replace this row/i);
    expect(reviewTemplate).toMatch(/zero-findings review, delete this row/i);
  });
});

describe("05-review-findings.md preserves per-finding delta attribution", () => {
  const reviewTemplate = readAsset("templates/05-review-findings.md");

  it("records the reviewer contract's three attribution values in Description without changing the legacy table schema", () => {
    expect(reviewTemplate).toContain(
      "| Severity | Category | Description | Suggested Fix | Decision |",
    );
    expect(reviewTemplate).toContain(
      "Description field as `(introduced_by_delta: yes|no|unknown)`",
    );
    expect(reviewTemplate).toContain("named base build and replay");
    expect(reviewTemplate).toContain("ordinary finding gate");
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
    const testEvidenceIndex =
      implementationTemplate.indexOf("## Test Evidence");
    const mutationProbesIndex = implementationTemplate.indexOf(
      "### Mutation Probes",
    );
    const risksIndex = implementationTemplate.indexOf("## Risks / Notes");
    expect(testEvidenceIndex).toBeGreaterThanOrEqual(0);
    expect(mutationProbesIndex).toBeGreaterThan(testEvidenceIndex);
    expect(risksIndex).toBeGreaterThan(mutationProbesIndex);
  });

  it("carries a header row with Round, Mutant, File, Anchor, Before, After, Verified Applied Via, Result, Expectation, Reason, Restored Verified, and Replayed columns", () => {
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
      "file",
      "anchor",
      "before",
      "after",
      "verified applied via",
      "result",
      "expectation",
      "reason",
      "restored verified",
      "replayed",
    ]);
  });

  it("states Before/After cells hold a single-line excerpt, with the full text or diff elsewhere for multi-line or patch-form mutants", () => {
    const mutationProbesIndex = implementationTemplate.indexOf(
      "### Mutation Probes",
    );
    expect(mutationProbesIndex).toBeGreaterThanOrEqual(0);
    const sectionText = implementationTemplate
      .slice(mutationProbesIndex)
      .replace(/\s+/g, " ");
    expect(sectionText).toContain(
      "Before/After cells hold a single-line excerpt",
    );
    expect(sectionText).toContain(
      "the full text or diff in the implementer report or a fenced block directly under the table",
    );
  });

  /**
   * Reviewer round-2 finding: nothing tied the template's Mutation Probes
   * columns to the implementer output contract's `mutation_probes`
   * sub-field list, so the two could drift independently (a column
   * renamed or dropped in one without the other) with no test to catch
   * it. This derives both lists programmatically -- the template's header
   * row (dropping the "round" column, which is about which round a probe
   * was named in, not a `mutation_probes` sub-field) and implementer.md's
   * YAML sub-field order (dropping the `mutation_probes` array key itself)
   * -- and asserts they agree.
   */
  it("the template's Mutation Probes columns and the mutation_probes contract's sub-field list agree", () => {
    const implementerMd = readAsset("agents/implementer.md");
    const match = implementerMd.match(/^mutation_probes:\n(?: {2}.+\n)*/m);
    expect(
      match,
      "mutation_probes block not found in implementer.md",
    ).toBeTruthy();
    const subFieldNames = [
      ...(match as RegExpMatchArray)[0].matchAll(/^\s*(?:- )?(\w+):/gm),
    ]
      .map((m) => m[1])
      .filter((name) => name !== "mutation_probes");

    const mutationProbesIndex = implementationTemplate.indexOf(
      "### Mutation Probes",
    );
    const tableText = implementationTemplate.slice(mutationProbesIndex);
    const headerRow = tableText
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("|") && /round/i.test(line));
    const columnNames = (headerRow ?? "")
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().toLowerCase().replace(/ /g, "_"))
      .filter((name) => name !== "round");

    expect(columnNames).toEqual(subFieldNames);
  });
});

/**
 * A fix round used to close only the reported instance of a defect class
 * rather than the class itself, so the class routinely recurred at a new
 * site in a later review round. This pins the added "Class Closure"
 * subsection, one row per fix round, sitting between the Mutation Probes
 * subsection (whose own probes a fix round also names) and the Optional
 * Probe Plan and Result Index, both still between Test Evidence and
 * Risks / Notes.
 */
describe("04-implementation-summary.md Class Closure subsection", () => {
  const implementationTemplate = readAsset(
    "templates/04-implementation-summary.md",
  );

  it("carries a Class Closure subsection", () => {
    expect(implementationTemplate).toContain("### Class Closure");
  });

  it("places the Class Closure subsection between Mutation Probes and the Optional Probe Plan and Result Index", () => {
    const mutationProbesIndex = implementationTemplate.indexOf(
      "### Mutation Probes",
    );
    const classClosureIndex =
      implementationTemplate.indexOf("### Class Closure");
    const probePlanIndex = implementationTemplate.indexOf(
      "### Optional Probe Plan and Result Index",
    );
    const risksIndex = implementationTemplate.indexOf("## Risks / Notes");
    expect(mutationProbesIndex).toBeGreaterThanOrEqual(0);
    expect(classClosureIndex).toBeGreaterThan(mutationProbesIndex);
    expect(probePlanIndex).toBeGreaterThan(classClosureIndex);
    expect(risksIndex).toBeGreaterThan(probePlanIndex);
  });

  it("carries a header row with Round, Class, Enumeration Command, Sites, and Closure Kind columns", () => {
    const classClosureIndex =
      implementationTemplate.indexOf("### Class Closure");
    expect(classClosureIndex).toBeGreaterThanOrEqual(0);
    const tableText = implementationTemplate.slice(classClosureIndex);
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
      "class",
      "enumeration command",
      "sites",
      "closure kind",
    ]);
  });

  it("states the closure-kind enum and the blank-command-on-source-closure rule", () => {
    const classClosureIndex =
      implementationTemplate.indexOf("### Class Closure");
    expect(classClosureIndex).toBeGreaterThanOrEqual(0);
    const sectionText = implementationTemplate
      .slice(classClosureIndex)
      .replace(/\s+/g, " ");
    expect(sectionText).toContain("enumerated | source | not_applicable");
    expect(sectionText).toContain("blank when `Closure Kind` is `source`");
  });
});

describe("04-implementation-summary.md Mutation Probes / Class Closure placement guard", () => {
  const implementationTemplate = readAsset(
    "templates/04-implementation-summary.md",
  );

  /**
   * Review round 3 finding (LOW): SKILL.md step 6's Before/After
   * single-line-excerpt sentence had no cross-copy pin, unlike the
   * template's own copy of the same rule above. Both state the same
   * rule (a single-line excerpt in the table cell, with the full text or
   * a diff placed elsewhere for a multi-line, `|`-containing, or
   * patch-form mutant); this pins the shared key phrases in both.
   */
  it("SKILL.md step 6 states the same Before/After single-line-excerpt rule as the template note", () => {
    const skillMd = readAsset("skill/SKILL.md");
    const sharedPhrases = [
      "cells hold a single-line excerpt",
      "multi-line",
      "unescaped `|`",
      "patch/diff",
      "fenced block",
    ];
    for (const phrase of sharedPhrases) {
      expect(skillMd).toContain(phrase);
      expect(implementationTemplate).toContain(phrase);
    }
  });
});

describe("05-review-findings.md method-applied reader grammar", () => {
  const reviewTemplate = readAsset("templates/05-review-findings.md");

  it("carries method-applied directly below review-method, byte-exactly", () => {
    // Lockstep with grounding-mcp's OW_REVIEW_METHOD_PLACEHOLDER_MARKER and
    // its sibling method-applied grammar in ow-run-completeness.ts.
    const lines = reviewTemplate.split(/\r?\n/);
    const reviewMethodIndex = lines.indexOf(
      "<!-- review-method[<round>] = normal|rigorous|adversarial -->",
    );
    expect(reviewMethodIndex).toBeGreaterThanOrEqual(0);
    expect(lines[reviewMethodIndex + 1]).toBe(
      "<!-- method-applied[<round>] = normal|rigorous|adversarial -->",
    );
  });

  it("states the one-line declaration and constrained Method fallback grammar", () => {
    expect(reviewTemplate).toContain("Write one\ndeclaration per line.");
    expect(reviewTemplate).toContain(
      "only by\nend-of-sentence punctuation or one balanced, non-nested parenthetical aside.",
    );
  });
});

/**
 * The run mode marker reuses the solution-acceptance grammar. It ships with
 * the default value, not with a TODO: unlike the acceptance verdicts it fails
 * open (a missing or unrecognised value means `delegated`), so the shipped
 * template is already a valid run of the default mode. This block sits at the
 * end of the file so that no line cited from the knowledge bundle moves.
 */
describe("run mode marker in 00-goal.md", () => {
  const goalTemplate = readAsset("templates/00-goal.md");
  const lines = goalTemplate.split(/\r?\n/);

  it("has exactly one mode marker, defaulting to delegated", () => {
    const modeRe = /solution-acceptance:\s*mode\s*=\s*(\S+)/g;
    const matches = [...goalTemplate.matchAll(modeRe)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("delegated");
  });

  it("carries the marker line byte-exactly, directly below the keyed run-base line", () => {
    const keyedIndex = lines.indexOf(
      "<!-- solution-acceptance: run-base[<repo-basename>] = <sha> -->",
    );
    expect(keyedIndex).toBeGreaterThanOrEqual(0);
    expect(lines[keyedIndex + 1]).toBe(
      "<!-- solution-acceptance: mode = delegated -->",
    );
  });

  it("adds no line that names both tokens of a run-base marker", () => {
    // The consuming reader treats any line carrying both tokens as an
    // attempted run-base marker; the mode marker and its comment must not
    // look like one.
    const both = lines.filter(
      (line) =>
        line.includes("solution-acceptance") && line.includes("run-base"),
    );
    expect(both).toHaveLength(2);
  });
});

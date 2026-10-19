import { describe, expect, it } from "vitest";

import { listSkillReferenceNames, readAsset } from "../src/assets.js";

// The AGENTS.md section is a charter: a short, always-loaded statement of the
// rules every session must hold. Everything else lives once in the skill
// references. This file pins the size bound, that every pointer resolves, and
// that a sentence the charter or a rule-holding reference states is not
// restated anywhere else in the skill.

const BEGIN = "<!-- orchestrator-workflow:begin -->";
const END = "<!-- orchestrator-workflow:end -->";
const MAX_CHARTER_WORDS = 800;
const MIN_CHARTER_WORDS = 600;

const charterFile = readAsset("agents-md-section.md");
const skillMd = readAsset("skill/SKILL.md");
const referenceNames = listSkillReferenceNames();
const references = new Map(
  referenceNames.map((name) => [name, readAsset(`skill/references/${name}`)]),
);

/** Same tokenizer as `wc -w`: runs of non-whitespace. */
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
const unwrap = (text: string) => text.replace(/\s+/g, " ");
/** Unwrap and drop list markers, so a bullet matches the sentence it holds. */
const flatten = (text: string) =>
  unwrap(
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*-\s+/, ""))
      .join("\n"),
  );

const between = () => {
  const start = charterFile.indexOf(BEGIN);
  const end = charterFile.indexOf(END);
  expect(start, "begin marker").toBeGreaterThanOrEqual(0);
  expect(end, "end marker").toBeGreaterThan(start);
  return charterFile.slice(start + BEGIN.length, end);
};

/** Sentences of a markdown body: headings and fenced lines dropped, wraps joined. */
function sentences(text: string): string[] {
  const body = text
    .split(/\r?\n/)
    .filter((line) => !/^#{1,6}\s/.test(line) && !line.startsWith("```"))
    .map((line) => line.replace(/^\s*-\s+/, ""))
    .join("\n");
  return unwrap(body)
    .split(/(?<=\.)\s+(?=[A-Z`])/)
    .map((sentence) => sentence.replace(/^[-\s]+/, "").trim())
    .filter((sentence) => wordCount(sentence) >= 8);
}

/** Every file the skill loads next to the charter. */
function corpus(): Map<string, string> {
  const all = new Map<string, string>();
  all.set("agents-md-section.md", flatten(between()));
  all.set("SKILL.md", flatten(skillMd));
  for (const [name, text] of references) {
    all.set(`references/${name}`, flatten(text));
  }
  return all;
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

function sitesOf(sentence: string): string[] {
  const sites: string[] = [];
  for (const [name, text] of corpus()) {
    for (let i = 0; i < occurrences(text, sentence); i += 1) sites.push(name);
  }
  return sites;
}

describe("the AGENTS.md section is a charter of at most 800 words", () => {
  it(`has at most ${MAX_CHARTER_WORDS} words between the markers and in the whole file`, () => {
    expect(wordCount(between())).toBeLessThanOrEqual(MAX_CHARTER_WORDS);
    expect(wordCount(charterFile)).toBeLessThanOrEqual(MAX_CHARTER_WORDS);
  });

  it(`has at least ${MIN_CHARTER_WORDS} words between the markers`, () => {
    expect(wordCount(between())).toBeGreaterThanOrEqual(MIN_CHARTER_WORDS);
  });

  it("is a single fenced block with one begin and one end marker", () => {
    expect(occurrences(charterFile, BEGIN)).toBe(1);
    expect(occurrences(charterFile, END)).toBe(1);
    expect(charterFile.startsWith(`${BEGIN}\n`)).toBe(true);
    expect(charterFile.trimEnd().endsWith(END)).toBe(true);
  });

  it("keeps the five charter parts and drops the detail sections", () => {
    const headings = charterFile
      .split(/\r?\n/)
      .filter((line) => /^###? /.test(line));
    expect(headings).toEqual([
      "## Agentic Coding Workflow",
      "### Roles and run modes",
      "### Review gate",
      "### Instruction trust boundary",
      "### Outward-facing actions",
      "### Definition of done",
    ]);
  });
});

describe("every pointer in the charter and SKILL.md resolves to a shipped reference", () => {
  const pointed = (text: string) =>
    [...text.matchAll(/references\/([A-Za-z0-9-]+\.md)/g)].map(
      (match) => match[1],
    );

  it("the charter names only shipped references, and names the two it depends on", () => {
    const names = new Set(pointed(charterFile));
    for (const name of names) expect(referenceNames).toContain(name);
    expect(names).toContain("trust-and-outward.md");
    expect(names).toContain("review-and-recovery.md");
  });

  it("SKILL.md routes to every shipped reference", () => {
    const names = new Set(pointed(skillMd));
    for (const name of referenceNames) expect(names).toContain(name);
  });
});

describe("a charter sentence is normative once: no skill file restates it", () => {
  const charterSentences = sentences(between());

  it("found the charter's sentences (sanity: not vacuously true)", () => {
    expect(charterSentences.length).toBeGreaterThan(20);
  });

  for (const sentence of charterSentences) {
    it(`states once: ${sentence.slice(0, 70)}`, () => {
      expect(sitesOf(sentence)).toEqual(["agents-md-section.md"]);
    });
  }
});

describe("a rule-holding reference states each of its sentences once", () => {
  const holders = ["trust-and-outward.md", "delegation-and-tiers.md"] as const;

  for (const name of holders) {
    const own = sentences(references.get(name) as string);

    it(`${name}: found sentences (sanity: not vacuously true)`, () => {
      expect(own.length).toBeGreaterThan(10);
    });

    for (const sentence of own) {
      it(`${name} states once: ${sentence.slice(0, 60)}`, () => {
        expect(sitesOf(sentence)).toEqual([`references/${name}`]);
      });
    }
  }

  it("the docs-only closing rule sits only in review-and-recovery.md", () => {
    const rule =
      "After independent review, the orchestrator may close a docs-only delta without another reviewer round only when its entire unreviewed delta is explanatory documentation, comments, or citations;";
    expect(sitesOf(rule)).toEqual(["references/review-and-recovery.md"]);
  });

  it("the definition of non-trivial work sits only in run-state-and-harness.md", () => {
    const rule =
      "Slicing and, in run modes `delegated` and `batch`, implementer subagents are for non-trivial work: multiple files, real logic, or anything that benefits from decomposition or a fresh context.";
    expect(sitesOf(rule)).toEqual(["references/run-state-and-harness.md"]);
  });

  it("the runbook selection rule sits only in trust-and-outward.md", () => {
    const rule =
      "In every run, in every run mode, and whether or not discovery runs, the orchestrator selects the applicable runbooks";
    expect(sitesOf(rule)).toEqual(["references/trust-and-outward.md"]);
  });
});

describe("the docs-or-test medium closing option is normative once", () => {
  it("sits only in review-and-recovery.md", () => {
    const clauses = [
      "A second closing option covers a medium finding in the category the reviewer reported (`docs` or `tests`).",
      "The second class adds tests or tightens existing ones, with no assertion removed or loosened and no test deleted or skipped.",
      "A fix that changes code, configuration, or instruction semantics keeps the reviewer round, whatever the finding's category.",
      "A finding that fires the Round-2 halt signal, and any fix on a task whose Review-round escalation budget has fired, is not eligible for this option: those rules govern and the next attempt goes through the reviewer subagent.",
      "High and critical findings stay blocking: neither closing option closes one, and accepting one follows the waiver rules.",
    ];
    for (const clause of clauses) {
      expect(sitesOf(clause)).toEqual(["references/review-and-recovery.md"]);
    }
  });
});

describe("the review method and tier class mapping is normative once", () => {
  it("sits only in delegation-and-tiers.md", () => {
    const clauses = [
      "This section is the one place that maps a change class to a method and a reviewer tier; every other file points here.",
      "`adversarial`, on the unsuffixed reviewer (high) or `reviewer-xhigh`: security judgment, sandbox or isolation code, installers and install or deploy scripts, hand-edited lockfiles, cross-major overrides, a change to the safety rules the repository declares as its core, and anything the operator flags high-risk.",
      "`rigorous`, on `reviewer-medium`: all other code changes, tests and CI or configuration that changes behaviour included, and all other changes to instruction, prompt, template, or policy files.",
      "Never pair `adversarial` with the `-medium` reviewer tier, a budget mismatch that names probes without the effort to run them; tiers themselves are unchanged by this axis.",
      "A delta that spans classes takes the method and tier of its highest class, and a doubt between two classes goes to the higher one.",
      "The tier a row names is the default reviewer tier for that class. A higher tier is the non-default choice, recorded with a one-line reason; a lower tier than the row names is never chosen.",
      "The closing options in [review and recovery](review-and-recovery.md) are not review rounds and are governed there, not here.",
    ];
    for (const clause of clauses) {
      expect(sitesOf(clause)).toEqual(["references/delegation-and-tiers.md"]);
    }
  });

  it("is not restated in the reviewer prompt, which runs without the skill", () => {
    const reviewerPrompt = flatten(readAsset("agents/reviewer.md"));
    for (const clause of [
      "`adversarial`, on the unsuffixed reviewer (high) or `reviewer-xhigh`:",
      "`rigorous`, on `reviewer-medium`:",
      "`normal`, on `reviewer-medium`:",
      "Never pair `adversarial` with the `-medium` reviewer tier",
      "a doubt between two classes goes to the higher one",
      "a lower tier than the row names is never chosen",
    ]) {
      expect(reviewerPrompt).not.toContain(clause);
    }
  });
});

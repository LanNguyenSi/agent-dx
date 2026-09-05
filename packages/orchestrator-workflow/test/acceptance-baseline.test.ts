import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@iarna/toml";
import { describe, expect, it } from "vitest";

import { composeCodexAgent } from "../src/codex.js";
import { readAsset } from "../src/assets.js";
import { runInit } from "../src/init.js";
import { DEFAULT_MODELS, DEFAULT_TIER, ROLE_TIERS } from "../src/models.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(PACKAGE_DIR, "test/fixtures/acceptance-baseline");
const frozenIds = ["P1-AC1", "P1-AC2"];
const baselineKeys = ["id", "revision"];
const criterionKeys = [
  "id",
  "required",
  "text",
  "verification",
  "negative_space",
];
const producerKeys = [
  "status",
  "role",
  "task_id",
  "acceptance_baseline",
  "criterion_evidence",
  "summary",
  "changed_files",
  "tests",
  "mutation_probes",
  "risks",
  "open_questions",
  "recommendation",
  "commits",
];
const propagationRule =
  "- Preserve the delegated baseline ID/revision and copy each assigned criterion unchanged, including its stable ID, required status, verification definition and negative space.";
const selectionRule =
  "For a recorded original string-list contract, retain the original `acceptance_criteria` strings and omit only the introduced `acceptance_baseline` and `criterion_evidence` fields; keep all existing role output fields.";
const unwrap = (text: string) => text.replace(/\s+/g, " ");
const readFixture = (name: string) => readFileSync(join(FIXTURE, name), "utf8");

// Bounded contract assertions for these Markdown fixtures, not a YAML parser
// or an acceptance engine. Each inventory entry selects its actual fence.
function yamlAfter(document: string, heading: string): string {
  const start = document.indexOf(heading);
  expect(start, `missing contract boundary ${heading}`).toBeGreaterThanOrEqual(
    0,
  );
  const rest = document.slice(start + heading.length);
  const nextHeading = rest.search(/\n#{1,3} /);
  const section = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
  const blocks = [...section.matchAll(/```yaml\n([\s\S]*?)```/g)];
  expect(blocks, `expected one actual YAML block in ${heading}`).toHaveLength(
    1,
  );
  return blocks[0][1];
}

function keys(block: string, indent = 0): string[] {
  return [...block.matchAll(new RegExp(`^ {${indent}}(\\w+):`, "gm"))].map(
    (match) => match[1],
  );
}

function nested(block: string, field: string, indent = 0): string {
  const lines = block.split("\n");
  const matches = lines.flatMap((line, index) =>
    line === `${" ".repeat(indent)}${field}:` ? [index] : [],
  );
  expect(
    matches,
    `missing or duplicate nested field ${field} at indent ${indent}`,
  ).toHaveLength(1);
  const start = matches[0] + 1;
  let end = start;
  while (
    end < lines.length &&
    (!lines[end].trim() || lines[end].search(/\S/) > indent)
  )
    end++;
  return lines.slice(start, end).join("\n");
}

function taskItem(block: string): string {
  const tasks = nested(block, "tasks");
  expect(tasks).toMatch(/^ {2}- id: T-001\n/);
  return tasks
    .replace(/^ {2}- /, "    ")
    .split("\n")
    .map((line) => line.slice(4))
    .join("\n");
}

function assertBaselineShape(block: string): void {
  expect(keys(nested(block, "acceptance_baseline"), 2)).toEqual(baselineKeys);
}

function assertCriteriaShape(block: string): void {
  assertBaselineShape(block);
  const records = nested(block, "acceptance_criteria");
  expect(records).toMatch(/^ {2}- id:/);
  expect(keys(records.replace(/^ {2}- /, "    "), 4)).toEqual(criterionKeys);
  expect(records).toMatch(/^ {4}required: true(?: #.*)?$/m);
}

function assertProducerShape(block: string): void {
  expect(keys(block)).toEqual(producerKeys);
  assertBaselineShape(block);
  const evidence = nested(block, "criterion_evidence");
  expect(evidence).toMatch(/^ {2}- criterion_id:/);
  expect(keys(evidence.replace(/^ {2}- /, "    "), 4)).toEqual([
    "criterion_id",
    "evidence_refs",
  ]);
  expect(nested(evidence, "evidence_refs", 4)).toMatch(/^ {6}- ""$/m);
  const probes = nested(block, "mutation_probes").replace(/^ {2}- /, "    ");
  expect(keys(probes, 4)).toEqual([
    "mutant",
    "verified_applied_via",
    "result",
    "restored_verified",
    "replayed",
  ]);
}

const inventory = [
  {
    boundary: "Baseline",
    asset: "templates/00-goal.md",
    heading: "## Acceptance Baseline",
    nesting: "root",
    kind: "criteria",
  },
  {
    boundary: "Delegation input",
    asset: "skill/SKILL.md",
    heading: "## Subagent input contract",
    nesting: "root",
    kind: "criteria",
  },
  {
    boundary: "Slicing/assignment: skill",
    asset: "skill/SKILL.md",
    heading: "## Task slicer output contract",
    nesting: "tasks[0]",
    kind: "criteria",
  },
  {
    boundary: "Slicing/assignment: agent",
    asset: "agents/task-slicer.md",
    heading: "Return exactly this structure",
    nesting: "tasks[0]",
    kind: "criteria",
  },
  {
    boundary: "Slicing/assignment: T-001",
    asset: "templates/02-tasks.md",
    heading: "### T-001:",
    nesting: "root",
    kind: "criteria",
  },
  {
    boundary: "Producer return: skill",
    asset: "skill/SKILL.md",
    heading: "## Implementer output contract",
    nesting: "root",
    kind: "producer",
  },
  {
    boundary: "Producer return: agent",
    asset: "agents/implementer.md",
    heading: "Return exactly this structure",
    nesting: "root",
    kind: "producer",
  },
] as const;

function inventoryBlock(entry: (typeof inventory)[number]): string {
  const block = yamlAfter(readAsset(entry.asset), entry.heading);
  return entry.nesting === "tasks[0]" ? taskItem(block) : block;
}

function assertSelection(body: string): void {
  const text = unwrap(body);
  expect(text).toContain(
    "recorded `Acceptance contract: acceptance-baseline/v1` in `00-goal.md` at run creation, before slicing, and communicated that selection in the delegation.",
  );
  expect(text).toContain("Existing runs use their recorded original contract.");
  expect(text).toContain(
    "Unknown provenance is reported and resolved before dependent delegation; missing fields never select a version.",
  );
  expect(text).toContain(selectionRule);
  expect(text).toContain(
    "This selection governs the rules and every YAML block below.",
  );
}

function assertRole(
  body: string,
  role: "task-slicer" | "implementer" | "reviewer",
): void {
  assertSelection(body);
  const output = yamlAfter(body, "Return exactly this structure");
  if (role === "task-slicer") {
    assertCriteriaShape(taskItem(output));
    expect(body).toContain(propagationRule);
    expect(body.indexOf("Contract selection:")).toBeLessThan(
      body.indexOf(propagationRule),
    );
  } else if (role === "implementer") {
    assertProducerShape(output);
    expect(unwrap(body)).toContain(
      "one `criterion_evidence` entry for every assigned criterion",
    );
    expect(unwrap(body)).toContain(
      "Empty `evidence_refs: []` means unresolved; explain why in `risks` or `open_questions`",
    );
  } else {
    expect(unwrap(body)).toContain(
      "Compare the returned `criterion_evidence` references to every assigned frozen criterion",
    );
    expect(unwrap(body)).toContain(
      "required empty references remain unresolved and block acceptance",
    );
    expect(output).toBe(
      yamlAfter(readAsset("skill/SKILL.md"), "## Reviewer output contract"),
    );
    expect(output).not.toContain("criterion_evidence:");
  }
  if (role !== "reviewer") {
    expect(unwrap(body)).toContain(
      "Return exactly this structure for v1, applying Contract selection above for a recorded original contract; output nothing else:",
    );
  }
}

describe("acceptance-baseline five-boundary contract inventory", () => {
  it.each(inventory)(
    "independently requires nested fields in $boundary ($nesting)",
    (entry) => {
      const block = inventoryBlock(entry);
      if (entry.kind === "producer") assertProducerShape(block);
      else assertCriteriaShape(block);
    },
  );

  it.each(inventory)(
    "rejects deleted mandatory fields at $boundary even when mirrors could also omit them",
    (entry) => {
      const block = inventoryBlock(entry);
      const check =
        entry.kind === "producer" ? assertProducerShape : assertCriteriaShape;
      const patterns =
        entry.kind === "producer"
          ? [
              /^acceptance_baseline:.*\n/m,
              /^ {2}id:.*\n/m,
              /^ {2}revision:.*\n/m,
              /^criterion_evidence:.*\n/m,
              /^ {2}- criterion_id:.*\n/m,
              /^ {4}evidence_refs:.*\n/m,
              /^ {6}- "".*\n?/m,
            ]
          : [
              /^acceptance_baseline:.*\n/m,
              /^ {2}id:.*\n/m,
              /^ {2}revision:.*\n/m,
              /^acceptance_criteria:.*\n/m,
              /^ {2}- id:.*\n/m,
              ...criterionKeys
                .slice(1)
                .map((field) => new RegExp(`^ {4}${field}:.*\\n?`, "m")),
            ];
      for (const pattern of patterns) {
        expect(block).toMatch(pattern);
        expect(
          () => check(block.replace(pattern, "")),
          String(pattern),
        ).toThrow();
      }
    },
  );

  it("retains the complete input envelope, context and scope fields", () => {
    const input = yamlAfter(
      readAsset("skill/SKILL.md"),
      "## Subagent input contract",
    );
    expect(keys(input)).toEqual([
      "role",
      "task_id",
      "goal",
      "acceptance_baseline",
      "acceptance_criteria",
      "context",
      "constraints",
      "allowed_changes",
      "forbidden_changes",
      "expected_output",
    ]);
    expect(keys(nested(input, "context"), 2)).toEqual([
      "relevant_files",
      "relevant_docs",
    ]);
    expect(nested(input, "expected_output")).toBe("  format: structured\n");
    for (const field of [
      "constraints",
      "allowed_changes",
      "forbidden_changes",
    ]) {
      expect(nested(input, field)).toBe('  - ""');
    }
  });

  it("compares complete producer and slicer copies after independent requirements", () => {
    const skill = readAsset("skill/SKILL.md");
    expect(
      yamlAfter(
        readAsset("agents/implementer.md"),
        "Return exactly this structure",
      ),
    ).toBe(yamlAfter(skill, "## Implementer output contract"));
    expect(
      yamlAfter(
        readAsset("agents/task-slicer.md"),
        "Return exactly this structure",
      ),
    ).toBe(yamlAfter(skill, "## Task slicer output contract"));
  });

  it("scopes the actual input, producer, slicer and reviewer blocks to recorded selection", () => {
    const skill = readAsset("skill/SKILL.md");
    assertSelection(skill);
    for (const heading of [
      "## Subagent input contract",
      "## Implementer output contract",
      "## Task slicer output contract",
      "## Reviewer output contract",
    ]) {
      const start = skill.indexOf(heading);
      const prose = skill.slice(start, skill.indexOf("```yaml", start));
      expect(prose).toContain("Contract selection");
    }
    for (const role of ["task-slicer", "implementer", "reviewer"] as const)
      assertRole(readAsset(`agents/${role}.md`), role);
  });

  it("covers the fifth boundary: returned references are indexed and required empty refs block acceptance", () => {
    const summary = unwrap(readAsset("templates/04-implementation-summary.md"));
    expect(summary).toContain(
      "Acceptance-Baseline Coverage and Open Required Residuals sections apply only to a run that recorded `Acceptance contract: acceptance-baseline/v1`",
    );
    expect(summary).toContain(
      "Existing runs retain their recorded original summary contract",
    );
    expect(summary).toContain(
      "returned `criterion_evidence` references against the frozen `acceptance_baseline` and assigned criteria",
    );
    expect(summary).toContain("Empty `evidence_refs: []` stays unresolved");
    expect(summary).toContain("blocks acceptance");
    expect(summary).toContain("directory containing this summary file");
    expect(summary).toContain(
      "| Criterion ID | Baseline ID / revision | Evidence reference | Result |",
    );
    expect(summary).toContain(
      "| Criterion ID | Why evidence is not decisive | Acceptance effect |",
    );
    const task = unwrap(readAsset("templates/02-tasks.md"));
    expect(task).toContain(
      "non-normative tracking keyed to the frozen criterion IDs",
    );
    expect(task).toContain(
      "original contract, keep the original checklist semantics",
    );
    const goal = unwrap(readAsset("templates/00-goal.md"));
    expect(goal).toContain("before planning, slicing, or delegation:");
    expect(goal).toContain(
      "missing v1 fields neither identify a legacy run nor block it",
    );
  });
});

// Concrete example readers: exact records and actual table rows/links are the
// assertions' inputs. A fixture's green label is never an acceptance verdict.
function identity(block: string): { id: string; revision: string } {
  const record = nested(block, "acceptance_baseline");
  expect(keys(record, 2)).toEqual(baselineKeys);
  return {
    id: scalar(record, "id", 2),
    revision: scalar(record, "revision", 2),
  };
}
function scalar(block: string, field: string, indent: number): string {
  const matches = [
    ...block.matchAll(new RegExp(`^ {${indent}}${field}: (.+)$`, "gm")),
  ];
  expect(matches, `missing scalar ${field}`).toHaveLength(1);
  return matches[0][1];
}
function record(
  block: string,
  indent: number,
): Record<string, string | boolean> {
  expect(keys(block, indent)).toEqual(criterionKeys);
  return Object.fromEntries(
    criterionKeys.map((field) => {
      const value = scalar(block, field, indent);
      return [field, field === "required" ? value === "true" : value];
    }),
  );
}
function criteria(block: string): Record<string, string | boolean>[] {
  return nested(block, "acceptance_criteria")
    .split(/^ {2}- /m)
    .slice(1)
    .map((item) => record(`    ${item.trimEnd()}`, 4));
}
function coverage(summary: string): string[][] {
  return summary
    .split("\n")
    .filter(
      (line) =>
        /^\| P1-AC\d+ \|/.test(line) && line.includes("baseline-demo /"),
    )
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}
function links(document: string, owner: string): string[] {
  return [...document.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => {
    const [path, fragment] = match[1].split("#");
    const resolved = join(dirname(owner), path);
    expect(
      existsSync(resolved),
      `unresolvable reference ${match[1]} from ${owner}`,
    ).toBe(true);
    if (fragment) expect(readFileSync(resolved, "utf8")).toContain(fragment);
    return resolved;
  });
}
function assertAssignment(goal: string, task: string): void {
  const frozen = yamlAfter(goal, "## Acceptance Baseline");
  const assigned = yamlAfter(task, "### T-001:");
  expect(criteria(frozen).map((item) => item.id)).toEqual(frozenIds);
  expect(criteria(frozen).map((item) => item.required)).toEqual([true, true]);
  expect(identity(assigned)).toEqual(identity(frozen));
  expect(criteria(assigned)).toEqual(criteria(frozen));
}

describe("acceptance baseline worked examples", () => {
  const goal = readFixture("00-goal.md");
  const tasks = readFixture("02-tasks.md");
  const summary = readFixture("04-implementation-summary.md");
  const frozen = criteria(yamlAfter(goal, "## Acceptance Baseline"));

  it("freezes the independently expected two required criteria and real T-001 assignment", () => {
    expect(goal).toContain("Acceptance contract: acceptance-baseline/v1");
    expect(identity(yamlAfter(goal, "## Acceptance Baseline"))).toEqual({
      id: "baseline-demo",
      revision: "r1",
    });
    expect(frozen).toEqual([
      {
        id: "P1-AC1",
        required: true,
        text: "Automated artifact references resolve.",
        verification: "npm test exits 0.",
        negative_space: "Does not establish manual review quality.",
      },
      {
        id: "P1-AC2",
        required: true,
        text: "A reviewer judges the release note.",
        verification:
          "Reviewer examines release-note.md; passes only when the note names the migration boundary.",
        negative_space: "Does not establish command output.",
      },
    ]);
    assertAssignment(goal, tasks);
    expect(() =>
      assertAssignment(
        goal,
        tasks.replace("required: true", "required: false"),
      ),
    ).toThrow();
    expect(() =>
      assertAssignment(
        goal,
        tasks.replace(
          "verification: npm test exits 0.",
          "verification: any build passes.",
        ),
      ),
    ).toThrow();
    expect(() =>
      assertAssignment(goal, tasks.replace("### T-001:", "### T-999:")),
    ).toThrow();
  });

  it("resolves actual coverage-row and producer-return references with full automated metadata", () => {
    const rows = coverage(summary);
    expect(rows.map(([id]) => id)).toEqual(frozenIds);
    expect(rows.map((row) => row[1])).toEqual([
      "baseline-demo / r1",
      "baseline-demo / r1",
    ]);
    const [autoPath] = links(
      rows[0][2],
      join(FIXTURE, "04-implementation-summary.md"),
    );
    const automated = JSON.parse(readFileSync(autoPath, "utf8"));
    expect(automated).toEqual({
      attempt: "attempt-01",
      repository: "demo/repository",
      checkedRevision: "abc123+dirty:sha256:example",
      cwd: "packages/demo",
      check: "npm test",
      status: "passed",
      exit: 0,
      criteria: ["P1-AC1"],
      baseline: { id: "baseline-demo", revision: "r1" },
      expectedOutcome: "exit 0",
      abort: null,
    });
    const output = yamlAfter(
      readFixture("implementer-output.md"),
      "# Implementer return",
    );
    expect(keys(output)).toEqual(producerKeys);
    expect(identity(output)).toEqual(
      identity(yamlAfter(goal, "## Acceptance Baseline")),
    );
    expect(scalar(output, "task_id", 0)).toBe("T-001");
    const entries = nested(output, "criterion_evidence")
      .split(/^ {2}- criterion_id: /m)
      .slice(1);
    expect(entries.map((entry) => entry.split("\n")[0])).toEqual(frozenIds);
    for (const [i, entry] of entries.entries()) {
      const refs = [...entry.matchAll(/^ {6}- (.+)$/gm)].map((match) =>
        join(FIXTURE, match[1]),
      );
      expect(refs).toEqual(
        links(rows[i][2], join(FIXTURE, "04-implementation-summary.md")),
      );
    }
    expect(() =>
      links(
        rows[0][2].replace("attempt-01.json", "absent.json"),
        join(FIXTURE, "04-implementation-summary.md"),
      ),
    ).toThrow();
  });

  it("resolves concrete manual evidence and its reviewed artifact/revision and reasoned result", () => {
    const row = coverage(summary)[1];
    expect(row[3]).toBe("manual");
    const [reviewPath] = links(
      row[2],
      join(FIXTURE, "04-implementation-summary.md"),
    );
    const review = readFileSync(reviewPath, "utf8");
    expect(review).toContain("Baseline: baseline-demo / r1");
    expect(review).toContain("Criterion: P1-AC2");
    expect(review).toContain("Reviewer: reviewer");
    expect(review).toContain(
      "Method: read the release note against the frozen P1-AC2 verification definition.",
    );
    expect(review).toContain(
      "Pass/fail standard: the note names the migration boundary.",
    );
    expect(review).toContain(
      "Reasoned result: pass; the note identifies version 2 as the boundary and says version 1 runs complete under their original contract.",
    );
    const [artifact] = links(review, reviewPath);
    expect(review).toContain("Artifact revision: r7");
    const note = readFileSync(artifact, "utf8");
    expect(note).toContain("Artifact revision: r7");
    expect(unwrap(note)).toContain(
      "migration boundary is version 2: version 1 runs are not migrated",
    );
  });

  it("retains the missing-result required ID as an unaccepted blocking residual", () => {
    const negative = readFixture("04-negative-implementation-summary.md");
    const rows = coverage(negative);
    expect(rows.map(([id]) => id)).toEqual(frozenIds);
    expect(frozen.find((item) => item.id === rows[0][0])?.required).toBe(true);
    expect(rows[0]).toEqual([
      "P1-AC1",
      "baseline-demo / r1",
      "missing result",
      "residual",
    ]);
    expect(
      links(rows[0][2], join(FIXTURE, "04-negative-implementation-summary.md")),
    ).toEqual([]);
    expect(negative).toContain(
      "| P1-AC1 | missing result | blocks acceptance |",
    );
    expect(negative).toContain("not accepted");
    expect(
      links(rows[1][2], join(FIXTURE, "04-negative-implementation-summary.md")),
    ).toHaveLength(1);
  });

  it("compares actual old/new records, authoritative revision, invalidation and checked carry-forward", () => {
    const revision = readFixture("revision.md");
    const change = yamlAfter(revision, "# Acceptance baseline revision");
    const newGoal = readFixture("revised-00-goal.md");
    const revised = criteria(yamlAfter(newGoal, "## Acceptance Baseline"));
    expect(record(nested(change, "old_record"), 2)).toEqual(frozen[1]);
    expect(record(nested(change, "new_record"), 2)).toEqual(revised[1]);
    expect(revised[1]).toEqual({
      ...frozen[1],
      text: "A reviewer judges the updated release note.",
      verification:
        "Reviewer examines release-note.md; passes only when the note names the revised migration boundary.",
    });
    expect(revised[0]).toEqual(frozen[0]);
    assertAssignment(newGoal, readFixture("revised-02-tasks.md"));
    expect(revision).toContain("Old revision: baseline-demo / r1");
    expect(revision).toContain("New revision: baseline-demo / r2");
    expect(revision).toContain("Affected IDs: P1-AC2");
    expect(revision).toContain(
      "Reason: operator-approved scope clarification.",
    );
    const resolved = links(revision, join(FIXTURE, "revision.md"));
    expect(readFileSync(resolved[0], "utf8")).toContain(
      "Authority: operator-approved orchestrator decision.",
    );
    expect(readFileSync(resolved[0], "utf8")).toContain(
      "Consequence: invalidate the prior manual review and rerun it against r2.",
    );
    expect(revision).toContain("rerun required and pending for P1-AC2 at r2");
    const carryPath = join(FIXTURE, "reviews/carry-forward-r2.md");
    expect(resolved).toContain(carryPath);
    const carry = readFileSync(carryPath, "utf8");
    const carryLinks = links(carry, carryPath);
    expect(carryLinks).toEqual([
      join(FIXTURE, "00-goal.md"),
      join(FIXTURE, "revised-00-goal.md"),
      join(FIXTURE, "results/attempt-01.json"),
    ]);
    const bytes = readFileSync(carryLinks[2]);
    const result = JSON.parse(bytes.toString());
    expect(carry).toContain(
      `Artifact SHA-256: ${createHash("sha256").update(bytes).digest("hex")}`,
    );
    for (const [label, field] of [
      ["Repository", "repository"],
      ["Checked revision", "checkedRevision"],
      ["Working directory", "cwd"],
      ["Applied check", "check"],
      ["Expected outcome", "expectedOutcome"],
    ]) {
      expect(carry).toContain(`${label}: ${result[field]}`);
    }
    expect(carry).toContain("From baseline: baseline-demo / r1");
    expect(carry).toContain("To baseline: baseline-demo / r2");
    expect(carry).toContain("Reviewer: orchestrator");
    expect(carry).toContain("Reasoned result: carry forward P1-AC1 only");
    const revisedSummary = readFixture("04-revised-implementation-summary.md");
    const rows = coverage(revisedSummary);
    expect(rows.map(([id]) => id)).toEqual(frozenIds);
    expect(rows[0][1]).toBe("baseline-demo / r2");
    expect(
      links(rows[0][2], join(FIXTURE, "04-revised-implementation-summary.md")),
    ).toEqual([carryLinks[2], carryPath]);
    expect(rows[1]).toEqual([
      "P1-AC2",
      "baseline-demo / r2",
      "invalidated prior manual review; rerun pending",
      "residual",
    ]);
    expect(revisedSummary).toContain(
      "| P1-AC2 | prior review invalidated; r2 rerun pending | blocks acceptance |",
    );
    expect(revisedSummary).toContain("not accepted");
    const weakened = change.replace("required: true", "required: false");
    expect(() =>
      expect(record(nested(weakened, "old_record"), 2)).toEqual(frozen[1]),
    ).toThrow();
  });
});

describe("generated and legacy installed contracts", () => {
  it("decodes every supported Codex role/tier contract and applicability", () => {
    for (const role of ["task-slicer", "implementer", "reviewer"] as const) {
      for (const tier of [undefined, ...ROLE_TIERS[role]]) {
        const rendered = composeCodexAgent(
          role,
          { model: DEFAULT_MODELS[role], effort: "medium" },
          tier,
        );
        const body = parse(rendered).developer_instructions;
        expect(typeof body).toBe("string");
        assertRole(body as string, role);
      }
    }
  });

  it("runs the real installer with seeded old runs and inspects every harness/tier body", () => {
    const target = mkdtempSync(join(tmpdir(), "acceptance-baseline-"));
    const oldRun = join(target, ".ai/runs/2000-01-01-recorded-original");
    const seed = new Map<string, Buffer>();
    try {
      mkdirSync(oldRun, { recursive: true });
      for (const name of [
        "00-goal.md",
        "02-tasks.md",
        "04-implementation-summary.md",
      ]) {
        const bytes = readFileSync(join(FIXTURE, `legacy-${name}`));
        seed.set(join(oldRun, name), bytes);
        writeFileSync(join(oldRun, name), bytes);
      }
      const install = () =>
        runInit({
          targetDir: target,
          harnesses: ["claude", "codex", "opencode"],
          models: { ...DEFAULT_MODELS },
          tiers: true,
          opencodeClassModels: {
            small: "test/small",
            medium: "test/medium",
            large: "test/large",
          },
        });
      install();
      install();
      for (const [path, before] of seed)
        expect(readFileSync(path).equals(before), path).toBe(true);
      const locations = [
        [".claude/agents", ".md"],
        [".codex/agents", ".toml"],
        [".opencode/agents", ".md"],
      ] as const;
      for (const [directory, extension] of locations) {
        for (const role of [
          "task-slicer",
          "implementer",
          "reviewer",
        ] as const) {
          for (const suffix of [
            "",
            ...ROLE_TIERS[role]
              .filter((tier) => tier !== DEFAULT_TIER[role])
              .map((tier) => `-${tier}`),
          ]) {
            const rendered = readFileSync(
              join(target, directory, `${role}${suffix}${extension}`),
              "utf8",
            );
            const body =
              extension === ".toml"
                ? (parse(rendered).developer_instructions as string)
                : rendered;
            assertRole(body, role);
          }
        }
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

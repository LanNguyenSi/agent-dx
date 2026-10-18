import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@iarna/toml";
import { describe, expect, it } from "vitest";

import { composeCodexAgent } from "../src/codex.js";
import { readAsset as readRawAsset } from "../src/assets.js";
import { runInit } from "../src/init.js";
import { DEFAULT_MODELS, DEFAULT_TIER, ROLE_TIERS } from "../src/models.js";

// One acceptance contract: each task carries `acceptance_criteria` as a list
// of strings, and no role prompt, reference, or template carries a second
// contract, a contract selection, or the retired baseline and evidence fields.
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(PACKAGE_DIR, "test/fixtures/acceptance-contract");
const ASSETS = join(PACKAGE_DIR, "assets");
const inputKeys = [
  "role",
  "task_id",
  "goal",
  "acceptance_criteria",
  "context",
  "runbooks",
  "verification_set",
  "constraints",
  "allowed_changes",
  "forbidden_changes",
  "expected_output",
];
const taskKeys = [
  "id",
  "title",
  "goal",
  "acceptance_criteria",
  "relevant_files",
  "relevant_docs",
  "constraints",
  "suggested_tests",
  "allowed_changes",
  "forbidden_changes",
  "dependencies",
  "verification_set",
  "risk",
];
const producerKeys = [
  "status",
  "role",
  "task_id",
  "summary",
  "changed_files",
  "tests",
  "mutation_probes",
  "class_closure",
  "runbooks_consulted",
  "risks",
  "open_questions",
  "recommendation",
  "commits",
];
const probeKeys = [
  "mutant",
  "file",
  "anchor",
  "before",
  "after",
  "verified_applied_via",
  "result",
  "expectation",
  "reason",
  "restored_verified",
  "replayed",
];
// The retired second contract. No shipped prompt, reference, or template may
// bring any of these back.
const retiredVocabulary = [
  "acceptance-baseline",
  "acceptance_baseline",
  "criterion_evidence",
  "evidence_refs",
  "Contract selection",
  "Acceptance contract:",
  "negative_space",
];
const unwrap = (text: string) => text.replace(/\s+/g, " ");
const readFixture = (name: string) => readFileSync(join(FIXTURE, name), "utf8");
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

function assertCriteriaList(block: string, indent: number): void {
  expect(nested(block, "acceptance_criteria", indent).trimEnd()).toBe(
    `${" ".repeat(indent + 2)}- ""`,
  );
}

function assertProbeShape(block: string): void {
  const probes = nested(block, "mutation_probes").replace(/^ {2}- /, "    ");
  expect(keys(probes, 4)).toEqual(probeKeys);
}

function assertProducerShape(block: string): void {
  expect(keys(block)).toEqual(producerKeys);
  assertProbeShape(block);
}

function assertTaskShape(block: string): void {
  expect(keys(block)).toEqual(taskKeys);
  assertCriteriaList(block, 0);
}

function assertInputShape(block: string): void {
  expect(keys(block)).toEqual(inputKeys);
  assertCriteriaList(block, 0);
  expect(keys(nested(block, "context"), 2)).toEqual([
    "relevant_files",
    "relevant_docs",
  ]);
  expect(nested(block, "expected_output")).toBe("  format: structured\n");
  for (const field of ["constraints", "allowed_changes", "forbidden_changes"]) {
    expect(nested(block, field)).toBe('  - ""');
  }
}

function assertNoRetiredVocabulary(text: string, where: string): void {
  for (const term of retiredVocabulary) {
    expect(text, `${where} still carries retired "${term}"`).not.toContain(
      term,
    );
  }
}

function assertRole(
  body: string,
  role: "task-slicer" | "implementer" | "reviewer",
): void {
  assertNoRetiredVocabulary(body, `the ${role} body`);
  const output = yamlAfter(body, "Return exactly this structure");
  if (role === "task-slicer") assertTaskShape(taskItem(output));
  else if (role === "implementer") assertProducerShape(output);
  else
    expect(output).toBe(
      yamlAfter(readAsset("skill/SKILL.md"), "## Reviewer output contract"),
    );
}

function assetFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? assetFiles(path) : [path];
  });
}

describe("the single acceptance contract", () => {
  const skill = readAsset("skill/SKILL.md");

  it("the subagent input contract carries acceptance_criteria as a list of strings and the whole envelope", () => {
    assertInputShape(yamlAfter(skill, "## Subagent input contract"));
  });

  it("the task slicer output carries acceptance_criteria as a list of strings in the skill and in the agent", () => {
    for (const block of [
      yamlAfter(skill, "## Task slicer output contract"),
      yamlAfter(
        readAsset("agents/task-slicer.md"),
        "Return exactly this structure",
      ),
    ])
      assertTaskShape(taskItem(block));
  });

  it("the implementer return carries no baseline or evidence-reference field, in the skill and in the agent", () => {
    for (const block of [
      yamlAfter(skill, "## Implementer output contract"),
      yamlAfter(
        readAsset("agents/implementer.md"),
        "Return exactly this structure",
      ),
    ])
      assertProducerShape(block);
  });

  it("the agent output blocks are copies of the skill's contract blocks", () => {
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
    expect(
      yamlAfter(
        readAsset("agents/reviewer.md"),
        "Return exactly this structure",
      ),
    ).toBe(yamlAfter(skill, "## Reviewer output contract"));
  });

  it("a deleted field fails the shape checks", () => {
    const input = yamlAfter(skill, "## Subagent input contract");
    expect(() =>
      assertInputShape(input.replace(/^acceptance_criteria:\n {2}- ""\n/m, "")),
    ).toThrow();
    const producer = yamlAfter(skill, "## Implementer output contract");
    expect(() =>
      assertProducerShape(
        producer.replace(/^class_closure:\n(?: {2}.*\n)+/m, ""),
      ),
    ).toThrow();
    expect(() =>
      assertProducerShape(`${producer}acceptance_baseline:\n  id: ""\n`),
    ).toThrow();
    const slicer = taskItem(yamlAfter(skill, "## Task slicer output contract"));
    expect(() =>
      assertTaskShape(slicer.replace(/^acceptance_criteria:\n {2}- ""\n/m, "")),
    ).toThrow();
  });

  it("no shipped prompt, reference, template, or policy file carries the retired contract", () => {
    const files = assetFiles(ASSETS);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      assertNoRetiredVocabulary(readFileSync(file, "utf8"), file);
    }
  });

  it("the goal template asks for no contract selection and keeps the run markers", () => {
    const goal = readAsset("templates/00-goal.md");
    expect(goal).not.toContain("## Acceptance Baseline");
    for (const marker of [
      "<!-- solution-acceptance: run-base = TODO -->",
      "<!-- solution-acceptance: mode = delegated -->",
      "<!-- outward: classes = none -->",
    ])
      expect(goal).toContain(marker);
  });

  it("the task and summary templates carry the original checklist and no coverage tables", () => {
    const tasks = readAsset("templates/02-tasks.md");
    expect(tasks).toContain("**Acceptance Criteria**");
    expect(tasks).not.toContain("**Delegated Acceptance Contract**");
    const summary = readAsset("templates/04-implementation-summary.md");
    expect(summary).toContain("## Test Evidence");
    expect(summary).not.toContain("Coverage");
    expect(summary).not.toContain("Open Required Residuals");
  });

  it("the illustrative implementer return matches the producer contract", () => {
    const output = yamlAfter(
      readFixture("implementer-output.md"),
      "# Implementer return",
    );
    expect(keys(output)).toEqual(producerKeys);
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
    const target = mkdtempSync(join(tmpdir(), "acceptance-contract-"));
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

/**
 * Review finding (LOW): a task's FIRST round has no review finding to fix,
 * so `class_closure` has nothing to enumerate -- but the shape the field
 * takes there was never stated, leaving a reader to guess whether `closed`
 * is `true` (no site was found to leave open) or `false` (nothing was
 * closed). The shape is stated once, at its normative site
 * (`assets/agents/implementer.md`), and pinned here beside the illustrative
 * producer return that has to match it, so prompt and fixture cannot drift
 * apart. This block sits at the end of the file so that no line cited from
 * the knowledge bundle moves.
 */
describe("class_closure on a task's first round", () => {
  const firstRoundShape =
    "On the task's first round `kind` is `not_applicable`, `command` and `sites` are empty, and `closed` is `true`, since no site was found to leave open.";

  it("the implementer prompt states the first-round shape at its normative site", () => {
    expect(unwrap(readAsset("agents/implementer.md"))).toContain(
      firstRoundShape,
    );
  });

  it("the illustrative implementer return carries exactly that first-round shape", () => {
    const output = yamlAfter(
      readFixture("implementer-output.md"),
      "# Implementer return",
    );
    expect(nested(output, "class_closure").split("\n")).toEqual([
      "  kind: not_applicable",
      '  command: ""',
      "  sites: []",
      "  closed: true",
    ]);
  });
});

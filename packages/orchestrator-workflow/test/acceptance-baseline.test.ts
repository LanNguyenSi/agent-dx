import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { composeCodexAgent } from "../src/codex.js";
import { readAsset } from "../src/assets.js";
import { runInit } from "../src/init.js";
import {
  DEFAULT_MODELS,
  DEFAULT_TIER,
  ROLE_TIERS,
  ROLES,
} from "../src/models.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(PACKAGE_DIR, "test/fixtures/acceptance-baseline");

type Criterion = {
  id: string;
  required: boolean;
  text: string;
  verification: string;
  negative_space: string;
};

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE, name), "utf8");
}

function yamlBlock(document: string): string {
  const match = document.match(/```yaml\n([\s\S]*?)```/);
  expect(match, "expected an actual YAML contract block").toBeTruthy();
  return (match as RegExpMatchArray)[1];
}

function baseline(block: string): { id: string; revision: string } {
  const match = block.match(
    /acceptance_baseline:\n  id: ([^\n]+)\n  revision: ([^\n]+)/,
  );
  expect(match, "expected acceptance_baseline identity").toBeTruthy();
  return { id: match![1], revision: match![2] };
}

function criteria(block: string): Criterion[] {
  return [...block.matchAll(
    /  - id: ([^\n]+)\n    required: (true|false)\n    text: ([^\n]+)\n    verification: ([^\n]+)\n    negative_space: ([^\n]+)/g,
  )].map((match) => ({
    id: match[1],
    required: match[2] === "true",
    text: match[3],
    verification: match[4],
    negative_space: match[5],
  }));
}

function coverageIds(document: string): string[] {
  return document
    .split("\n")
    .filter((line) => /^\| P1-AC\d+ \| baseline-demo \/ r1 \|/.test(line))
    .map((line) => line.split("|")[1].trim());
}

function linkedFixturePath(document: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.match(new RegExp(`\\[${escaped}\\]\\(([^)]+)\\)`));
  expect(match, `expected ${label} link`).toBeTruthy();
  return join(FIXTURE, match![1]);
}

function normalizeRenderedBody(body: string): string {
  return body.replace(/\\n/g, " ").replace(/\s+/g, " ");
}

describe("acceptance baseline worked example", () => {
  const goal = readFixture("00-goal.md");
  const tasks = readFixture("02-tasks.md");
  const summary = readFixture("04-implementation-summary.md");

  it("freezes two required records and propagates their full nested contract into T-001", () => {
    expect(goal).toContain("Acceptance contract: acceptance-baseline/v1");
    const goalBlock = yamlBlock(goal);
    const taskBlock = yamlBlock(tasks);
    const frozenCriteria = criteria(goalBlock);
    expect(frozenCriteria).toEqual([
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
    expect(baseline(taskBlock)).toEqual(baseline(goalBlock));
    expect(criteria(taskBlock)).toEqual(frozenCriteria);
    expect(coverageIds(summary)).toEqual(frozenCriteria.map(({ id }) => id));
  });

  it("uses coverage-derived resolving automated and concrete manual artifacts", () => {
    const automated = linkedFixturePath(summary, "automated result");
    const manual = linkedFixturePath(summary, "manual review");
    expect(existsSync(automated)).toBe(true);
    expect(existsSync(manual)).toBe(true);
    expect(JSON.parse(readFileSync(automated, "utf8"))).toMatchObject({
      attempt: "attempt-01",
      checkedRevision: "abc123+dirty:sha256:example",
      cwd: "packages/demo",
      check: "npm test",
      status: "passed",
      exit: 0,
      criteria: ["P1-AC1"],
    });
    expect(readFileSync(manual, "utf8")).toContain("Reviewer: reviewer");
    expect(readFileSync(manual, "utf8")).toContain("Pass/fail standard:");
    expect(readFileSync(manual, "utf8")).toContain("Reasoned result:");
  });

  it("retains one of the same required IDs as a blocking residual when its result is absent", () => {
    const negative = readFixture("04-negative-implementation-summary.md");
    const requiredIds = criteria(yamlBlock(goal))
      .filter(({ required }) => required)
      .map(({ id }) => id);
    expect(coverageIds(negative)).toEqual(requiredIds);
    expect(negative).toContain("| P1-AC1 | baseline-demo / r1 | missing result | residual |");
    expect(negative).toContain("| P1-AC1 | missing result | blocks acceptance |");
    expect(negative).not.toContain("accepted: true");
    expect(negative).not.toContain("P1-AC3");
  });

  it("records old and new criterion records, invalidation, and a concrete carry-forward comparison", () => {
    const revision = readFixture("revision.md");
    expect(revision).toContain("Old revision: baseline-demo / r1");
    expect(revision).toContain("New revision: baseline-demo / r2");
    expect(revision).toContain("Affected IDs: P1-AC2");
    expect(existsSync(linkedFixturePath(revision, "D-002 approval"))).toBe(true);
    const revisionBlock = yamlBlock(revision);
    expect(revisionBlock).toContain("old_record:");
    expect(revisionBlock).toContain("new_record:");
    expect(revisionBlock).toContain("A reviewer judges the release note.");
    expect(revisionBlock).toContain("A reviewer judges the updated release note.");
    expect(revision).toContain("rerun required and pending");
    expect(revision).toContain("command `npm test`");
    expect(revision).toContain("repository state");
    expect(revision).toContain("results/attempt-01.json");
  });
});

describe("acceptance-baseline installed contract", () => {
  it("pins canonical nested input and per-task propagation instead of string lists", () => {
    const goal = readAsset("templates/00-goal.md");
    const tasks = readAsset("templates/02-tasks.md");
    const skill = readAsset("skill/SKILL.md");
    const slicer = readAsset("agents/task-slicer.md");
    for (const source of [goal, tasks, skill, slicer]) {
      expect(source).toContain("acceptance_baseline:");
      expect(source).toContain("acceptance_criteria:");
      expect(source).toContain("required: true");
      expect(source).toContain("negative_space:");
    }
    expect(tasks).toContain("### T-001:");
    expect(tasks).toContain("**Delegated Acceptance Contract**");
    expect(slicer).toContain(
      "- Preserve the delegated baseline ID/revision and copy each assigned criterion unchanged, including its stable ID, required status, verification definition and negative space.",
    );
  });

  it("limits v1 obligations to explicitly adopted new runs without migrating an old run", () => {
    const legacy = readFixture("legacy-00-goal.md");
    expect(legacy).not.toContain("Acceptance contract: acceptance-baseline/v1");
    expect(legacy).not.toContain("acceptance_baseline:");
    for (const source of [
      readAsset("templates/00-goal.md"),
      readAsset("skill/SKILL.md"),
      readAsset("agents/task-slicer.md"),
      readAsset("agents/implementer.md"),
      readAsset("agents/reviewer.md"),
    ]) {
      expect(normalizeRenderedBody(source)).toContain("Existing runs");
      expect(normalizeRenderedBody(source)).toContain("v1 fields");
    }
  });

  it("renders the adopted-run baseline rule in every supported Codex role and tier body", () => {
    for (const role of ROLES) {
      const tiers = [undefined, ...ROLE_TIERS[role]];
      for (const tier of tiers) {
        const rendered = composeCodexAgent(
          role,
          { model: DEFAULT_MODELS[role], effort: "medium" },
          tier,
        );
        if (["task-slicer", "implementer", "reviewer"].includes(role)) {
          expect(normalizeRenderedBody(rendered)).toContain(
            "Existing runs without recorded adoption",
          );
        }
      }
    }
  });

  it("installs the changed role bodies for every harness and tier", () => {
    const target = mkdtempSync(join(tmpdir(), "acceptance-baseline-"));
    try {
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
      const locations = [
        [".claude/agents", ".md"],
        [".codex/agents", ".toml"],
        [".opencode/agents", ".md"],
      ] as const;
      for (const [directory, extension] of locations) {
        for (const role of ["task-slicer", "implementer", "reviewer"] as const) {
          const bodies = [
            readFileSync(join(target, directory, `${role}${extension}`), "utf8"),
            ...ROLE_TIERS[role]
              .filter((tier) => tier !== DEFAULT_TIER[role])
              .map((tier) =>
                readFileSync(join(target, directory, `${role}-${tier}${extension}`), "utf8"),
              ),
          ];
          for (const body of bodies) {
            expect(normalizeRenderedBody(body)).toContain(
              "Existing runs without recorded adoption",
            );
          }
        }
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

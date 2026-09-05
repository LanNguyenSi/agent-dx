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

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE, name), "utf8");
}

function criterionRows(document: string): string[] {
  return document.split("\n").filter((line) => /^\| P1-AC[12] \|/.test(line));
}

describe("acceptance baseline worked example", () => {
  const goal = readFixture("00-goal.md");
  const tasks = readFixture("02-tasks.md");
  const summary = readFixture("04-implementation-summary.md");

  it("carries two unchanged required criteria through 00, 02, and 04", () => {
    expect(criterionRows(goal)).toEqual(criterionRows(tasks));
    expect(goal).toContain("baseline-demo / r1");
    expect(tasks).toContain("baseline-demo / r1");
    expect(summary).toContain("| P1-AC1 | baseline-demo / r1 |");
    expect(summary).toContain("| P1-AC2 | baseline-demo / r1 |");
  });

  it("uses resolving automated and concrete manual evidence artifacts", () => {
    const automated = join(FIXTURE, "results/attempt-01.json");
    const manual = join(FIXTURE, "reviews/release-note-r7.md");
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
    expect(existsSync(join(FIXTURE, "release-note.md"))).toBe(true);
  });

  it("keeps an unresolved required criterion as an acceptance-blocking residual", () => {
    const negative = readFixture("04-negative-implementation-summary.md");
    const residual =
      negative
        .split("\n")
        .find((line) => line.startsWith("| P1-AC1 | missing result |")) ?? "";
    expect(residual).toContain("missing result");
    expect(residual).toContain("blocks acceptance");
    expect(negative).not.toContain("accepted: true");
    expect(summary).not.toContain("Open Required Residuals");
  });

  it("records authority and invalidation when a baseline revision changes", () => {
    const revision = readFixture("revision.md");
    expect(revision).toContain("Old revision: baseline-demo / r1");
    expect(revision).toContain("New revision: baseline-demo / r2");
    expect(revision).toContain("Affected IDs: P1-AC2");
    expect(revision).toContain("Decision authority: [D-002 approval]");
    expect(existsSync(join(FIXTURE, "decisions/D-002.md"))).toBe(true);
    expect(revision).toContain("Invalidated evidence:");
    expect(revision).not.toContain("implementer decision");
  });
});

describe("acceptance-baseline installed contract", () => {
  it("pins baseline propagation in the task-slicer asset", () => {
    expect(readAsset("agents/task-slicer.md")).toContain(
      "- Preserve the delegated baseline ID/revision and copy each assigned criterion unchanged, including its stable ID, required status, verification definition and negative space.",
    );
  });

  it("renders the baseline rule in every supported Codex role and tier body", () => {
    for (const role of ROLES) {
      const tiers = [undefined, ...ROLE_TIERS[role]];
      for (const tier of tiers) {
        const rendered = composeCodexAgent(
          role,
          { model: DEFAULT_MODELS[role], effort: "medium" },
          tier,
        );
        if (role === "task-slicer") {
          expect(rendered).toContain(
            "Preserve the delegated baseline ID/revision",
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
        for (const role of [
          "task-slicer",
          "implementer",
          "reviewer",
        ] as const) {
          const bodies = [
            readFileSync(
              join(target, directory, `${role}${extension}`),
              "utf8",
            ),
            ...ROLE_TIERS[role]
              .filter((tier) => tier !== DEFAULT_TIER[role])
              .map((tier) =>
                readFileSync(
                  join(target, directory, `${role}-${tier}${extension}`),
                  "utf8",
                ),
              ),
          ];
          for (const body of bodies) {
            expect(body).toContain(
              role === "task-slicer"
                ? "Preserve the delegated baseline ID/revision"
                : role === "implementer"
                  ? "delegated acceptance baseline as frozen"
                  : "Acceptance baseline: compare the implementation",
            );
          }
        }
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("keeps baseline coverage outside the existing Test Evidence subsection group", () => {
    const template = readAsset("templates/04-implementation-summary.md");
    expect(template.indexOf("## Acceptance-Baseline Coverage")).toBeLessThan(
      template.indexOf("## Test Evidence"),
    );
    expect(template.indexOf("### Executed")).toBeGreaterThan(
      template.indexOf("## Test Evidence"),
    );
  });
});

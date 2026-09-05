import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@iarna/toml";
import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";
import { composeCodexAgent } from "../src/codex.js";
import { runInit } from "../src/init.js";
import { DEFAULT_MODELS, DEFAULT_TIER, ROLE_TIERS } from "../src/models.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(PACKAGE_DIR, "test/fixtures/decision-authority");
const authorityPin =
  "A reviewer recommendation is not orchestrator acceptance and cannot authorize a critical waiver; only the operator may authorize a critical waiver.";

function rows(document: string): string[][] {
  return document
    .split("\n")
    .filter((line) => /^\| D-\d+ \|/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

function links(document: string, owner: string): string[] {
  return [...document.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => {
    const target = join(dirname(owner), match[1]);
    expect(target, `unresolvable reference ${match[1]} from ${owner}`).toSatisfy(
      (path: string) => {
        try {
          readFileSync(path, "utf8");
          return true;
        } catch {
          return false;
        }
      },
    );
    return target;
  });
}

function field(document: string, label: string): string {
  const match = document.match(new RegExp(`^- ${label}: (.+)$`, "m"));
  expect(match, `missing ${label}`).toHaveLength(2);
  return match![1];
}

function assertIllustrativeAuthority(
  decisions: string,
  revision: string,
  waiver: string,
): void {
  const records = rows(decisions);
  const byId = new Map(records.map((record) => [record[0], record]));
  for (const record of records) {
    expect(record).toHaveLength(7);
    if (record[6]) expect([...byId.keys()]).toContain(record[6]);
  }
  expect(byId.get("D-001")?.[3]).toContain("baseline-demo r1");
  expect(byId.get("D-002")?.[6]).toBe("D-001");
  expect(field(revision, "Decision")).toBe("D-002");
  expect(field(revision, "Baseline")).toBe("baseline-demo / r1 → r2");
  expect(field(revision, "Affected criterion")).toBe("P2-AC2");
  expect(field(waiver, "Decision")).toBe("D-003");
  expect(field(waiver, "Finding")).toBe("CRIT-001");
  expect(field(waiver, "Severity")).toBe("critical");
  expect(field(waiver, "Actor")).toBe("operator");
  expect(field(waiver, "Approval outcome")).toBe("approved");
}

describe("decision authority contract", () => {
  it("ships the seven-column decision schema without changing escalation markers", () => {
    const template = readAsset("templates/03-decisions.md");
    const header = template.split("\n").find((line) => line.startsWith("| ID |"));
    expect(header?.split("|").slice(1, -1).map((cell) => cell.trim())).toEqual([
      "ID",
      "Date",
      "Trigger / Evidence",
      "Decision",
      "Authority / Source",
      "Consequences",
      "Supersedes",
    ]);
    expect(template).toContain("<!-- review-round-escalation: choice = n/a -->");
    expect(template).toContain("Markdown alone does not grant authority");
    expect(template).toContain("Established runs retain their recorded decision format.");
  });

  it("resolves illustrative routine, baseline-revision, and critical-waiver decisions", () => {
    const decisionsPath = join(FIXTURE, "decision-records.md");
    const document = readFileSync(decisionsPath, "utf8");
    const revisionPath = join(FIXTURE, "baseline-revision.md");
    const waiverPath = join(FIXTURE, "critical-waiver.md");
    const revision = readFileSync(revisionPath, "utf8");
    const waiver = readFileSync(waiverPath, "utf8");
    const records = rows(document);
    expect(records).toHaveLength(3);
    const byId = new Map(records.map((record) => [record[0], record]));
    expect(byId.get("D-001")?.[4]).toContain("Orchestrator");
    expect(byId.get("D-002")?.[4]).toContain("Operator approval");
    expect(byId.get("D-002")?.[6]).toBe("D-001");
    expect(byId.get("D-003")?.[4]).toContain("Operator approval");
    const decisionLinks = links(document, decisionsPath);
    const scopePath = decisionLinks.find((path) => path.endsWith("scope-request.md"));
    const waiverRecordPath = decisionLinks.find((path) =>
      path.endsWith("critical-waiver.md"),
    );
    expect(scopePath).toBe(join(FIXTURE, "scope-request.md"));
    expect(waiverRecordPath).toBe(waiverPath);
    expect(links(revision, revisionPath)).toEqual([scopePath]);
    const scope = readFileSync(scopePath!, "utf8");
    expect(field(scope, "Decision")).toBe("D-002");
    expect(field(scope, "Actor")).toBe("operator");
    expect(field(scope, "Approval outcome")).toBe("approved");
    const waiverLinks = links(waiver, waiverPath);
    const approval = readFileSync(waiverLinks[0], "utf8");
    expect(field(approval, "Decision")).toBe("D-003");
    expect(field(approval, "Finding")).toBe("CRIT-001");
    expect(field(approval, "Actor")).toBe("operator");
    expect(field(approval, "Approval outcome")).toBe("approved");
    assertIllustrativeAuthority(document, revision, waiver);
    expect(() => {
      assertIllustrativeAuthority(
        document.replace("| D-001 |", "| D-999 |"),
        revision,
        waiver,
      );
    }).toThrow();
    expect(() =>
      assertIllustrativeAuthority(
        document,
        revision,
        waiver.replace("Actor: operator", "Actor: reviewer"),
      ),
    ).toThrow();
    expect(() =>
      links(waiver.replace("operator-critical-waiver.md", "missing.md"), waiverPath),
    ).toThrow();
  });

  it("pins role separation in the skill and every generated reviewer prompt", () => {
    const skill = readAsset("skill/SKILL.md");
    expect(skill).toContain(authorityPin);
    expect(skill).toContain("Markdown records evidence of real authority and never grant it by themselves.");
    expect(skill.replace(/\s+/g, " ")).toContain(
      "Established runs retain their recorded decision format; absent fields never create a retroactive blocker.",
    );

    const codexBodies = [
      parse(
        composeCodexAgent("reviewer", {
          model: "gpt-6-astra",
          effort: "high",
        }),
      ).developer_instructions,
      ...ROLE_TIERS.reviewer.map((tier) =>
        parse(
          composeCodexAgent(
            "reviewer",
            { model: "gpt-6-astra", effort: tier },
            tier,
          ),
        ).developer_instructions,
      ),
    ];
    for (const body of codexBodies) expect(body).toContain(authorityPin);

    const target = mkdtempSync(join(tmpdir(), "ow-decision-authority-"));
    try {
      runInit({
        targetDir: target,
        harnesses: ["claude", "opencode"],
        models: { ...DEFAULT_MODELS },
        opencodeModels: { reviewer: "anthropic/claude-opus-4-8" },
        opencodeClassModels: {
          small: "anthropic/claude-haiku-4-5",
          medium: "anthropic/claude-sonnet-4-6",
          large: "anthropic/claude-opus-4-8",
        },
        tiers: true,
      });
      for (const harness of [".claude", ".opencode"]) {
        for (const tier of ROLE_TIERS.reviewer) {
          const suffix = tier === DEFAULT_TIER.reviewer ? "" : `-${tier}`;
          const rendered = readFileSync(
            join(target, harness, "agents", `reviewer${suffix}.md`),
            "utf8",
          );
          expect(rendered, `${harness}/reviewer${suffix}.md`).toContain(authorityPin);
        }
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("retains review and waiver rules without treating Markdown as authorization", () => {
    const skill = readAsset("skill/SKILL.md").replace(/\s+/g, " ");
    expect(skill).toContain("critical findings require operator sign-off");
    expect(skill).toContain("high findings require the orchestrator to record a rationale");
    expect(skill).toContain("Review judgment still applies to every change");
    expect(skill).toContain("trivial change (a typo, a one-line fix) may be done directly by the orchestrator and reviewed by it");
  });
});

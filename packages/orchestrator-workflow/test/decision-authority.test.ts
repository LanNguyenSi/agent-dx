import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(PACKAGE_DIR, "test/fixtures/decision-authority");
const authorityPin =
  "A reviewer recommendation is not orchestrator acceptance and cannot authorize a critical waiver; only the operator may authorize a critical waiver.";
function rows(document: string): string[][] {
  return document
    .split("\n")
    .filter((line) => /^\| D-\d+ \|/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

function links(document: string, owner: string): string[] {
  return [...document.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => {
    const target = join(dirname(owner), match[1]);
    expect(
      target,
      `unresolvable reference ${match[1]} from ${owner}`,
    ).toSatisfy((path: string) => {
      try {
        readFileSync(path, "utf8");
        return true;
      } catch {
        return false;
      }
    });
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
    const header = template
      .split("\n")
      .find((line) => line.startsWith("| ID |"));
    expect(
      header
        ?.split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    ).toEqual([
      "ID",
      "Date",
      "Trigger / Evidence",
      "Decision",
      "Authority / Source",
      "Consequences",
      "Supersedes",
    ]);
    expect(template).toContain(
      "<!-- review-round-escalation: choice = n/a -->",
    );
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
    const scopePath = decisionLinks.find((path) =>
      path.endsWith("scope-request.md"),
    );
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
      links(
        waiver.replace("operator-critical-waiver.md", "missing.md"),
        waiverPath,
      ),
    ).toThrow();
  });

  it("pins the reviewer's role separation: a recommendation never authorizes a critical waiver", () => {
    // Waiver authority is stated once for the orchestrator in the policy
    // section's review gate (pinned in docs-consistency.test.ts); this is the
    // reviewer prompt's own statement, pinned at that one site.
    expect(readAsset("agents/reviewer.md").replace(/\s+/g, " ")).toContain(
      authorityPin,
    );
  });
});

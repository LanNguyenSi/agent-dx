import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { stringify as stringifyYaml } from "yaml";

import type { DatasetEntry, KnownFinding } from "../eval/dataset.js";

export const STUB = fileURLToPath(
  new URL("./fixtures/eval/stub-claude.mjs", import.meta.url),
);

/** Stand-in for `agent-primitives guard`; see the fixture's header. */
export const FAKE_GUARD = fileURLToPath(
  new URL("./fixtures/eval/fake-guard.mjs", import.meta.url),
);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A claude binary for a test: the stub, started with these STUB_* variables.
 * The runner passes only its allowlist to the session, so the stub's own
 * configuration travels in the wrapper script instead of the environment.
 */
export function stubBin(
  dir: string,
  vars: Record<string, string> = {},
): string {
  const file = join(mkdtempSync(join(dir, "stub-")), "claude");
  const assigns = Object.entries(vars)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  writeFileSync(
    file,
    `#!/bin/sh\n${assigns.length > 0 ? `export ${assigns}\n` : ""}exec ${shellQuote(process.execPath)} ${shellQuote(STUB)} "$@"\n`,
    { mode: 0o755 },
  );
  return file;
}

export interface FakeFinding {
  severity: string;
  description?: string;
}

/** A reviewer return in the shipped output structure, fenced as yaml. */
export function reviewerReturn(findings: FakeFinding[] = []): string {
  const doc = {
    status: "reviewed",
    role: "reviewer",
    task_id: "T-000",
    summary: ["checked"],
    findings: findings.map((f) => ({
      severity: f.severity,
      category: "correctness",
      description: f.description ?? "a defect",
      suggested_fix: "fix it",
      recurrence: "new",
      introduced_by_delta: "yes",
    })),
    acceptance_recommendation: findings.length > 0 ? "fix_required" : "accept",
    missing_tests: [],
    residual_risks: [],
    reproduction: {
      method: "ran the tests",
      sample_size: "1",
      result: "pass",
      matches_implementer_claim: "not_applicable",
    },
    method_applied: "rigorous",
    withdrawn: [],
    runbook_notes: [],
  };
  return `\`\`\`yaml\n${stringifyYaml(doc)}\`\`\``;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

export interface FixtureRepo {
  dir: string;
  baseSha: string;
  headSha: string;
  futureSha: string;
}

/**
 * A tiny repository with a base commit, a head commit that is reachable from
 * no ref (its branch is deleted again), and a later commit on the main branch.
 */
export function makeFixtureRepo(): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), "ow-eval-src-"));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "--quiet", "-m", "base"]);
  const baseSha = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "--quiet", "-b", "topic"]);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git(dir, ["commit", "--quiet", "-am", "head"]);
  const headSha = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "--quiet", "main"]);
  writeFileSync(join(dir, "b.txt"), "later\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "--quiet", "-m", "future"]);
  const futureSha = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["branch", "-D", "topic"]);
  git(dir, ["tag", "later-tag", futureSha]);
  return { dir, baseSha, headSha, futureSha };
}

export const SETUP_SCRIPT =
  "const fs=require('fs');fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/marker','1')";

export function makeEntry(
  repo: FixtureRepo,
  overrides: Partial<DatasetEntry> = {},
): DatasetEntry {
  return {
    schema: 1,
    id: "entry-a",
    kind: "finding",
    repo: {
      name: "fixture",
      path: repo.dir,
      head_sha: repo.headSha,
      base_sha: repo.baseSha,
    },
    setup: [{ cwd: ".", argv: ["node", "-e", SETUP_SCRIPT] }],
    review_method: "rigorous",
    leak: "none",
    brief:
      "Review the change in {{WORKTREE}}. Evidence goes to {{EVIDENCE_DIR}}, run files to {{RUN_DIR}}.",
    task_spec: "Add a second line to a.txt.",
    known_findings: [
      {
        id: "K1",
        severity: "medium",
        category: "correctness",
        description: "the second line is missing a newline",
      },
    ],
    provenance: { source: "synthetic", round: 1 },
    ...overrides,
  };
}

export function writeDataset(dir: string, entries: DatasetEntry[]): void {
  mkdirSync(join(dir, "entries"), { recursive: true });
  for (const entry of entries) {
    writeFileSync(
      join(dir, "entries", `${entry.id}.json`),
      JSON.stringify(entry, null, 2),
    );
  }
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({
      schema: 1,
      entries: entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        file: `entries/${e.id}.json`,
      })),
    }),
  );
}

export function knownFinding(id: string, severity = "medium"): KnownFinding {
  return {
    id,
    severity: severity as KnownFinding["severity"],
    category: "correctness",
    description: `defect ${id}`,
  };
}

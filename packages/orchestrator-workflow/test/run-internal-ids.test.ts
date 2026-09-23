import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "@iarna/toml";
import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";
import { composeCodexAgent } from "../src/codex.js";
import { runInit } from "../src/init.js";
import { DEFAULT_MODELS, DEFAULT_TIER, ROLE_TIERS } from "../src/models.js";

// Issue #337: identifiers the run files assign leak from briefings into
// committed code, tests and commit messages, where they read as broken
// references. The implementer prompt forbids them, the reviewer prompt
// names them as a maintainability finding, and evidence-and-probes.md
// documents a check for them once.

const unwrap = (text: string) => text.replace(/\s+/g, " ");

const ID_KINDS =
  "run-internal identifiers (criterion, task, decision, or review round IDs from the run files)";
const IMPLEMENTER_RULE = `Never write ${ID_KINDS} into code, comments, tests, or commit messages; reference the ticket or issue and describe the behaviour instead.`;
const REVIEWER_FINDING = `Run-internal identifiers (criterion, task, decision, or review round IDs from the run files) written into code, comments, tests, or commit messages are a maintainability finding; the fix references the ticket or issue and describes the behaviour instead.`;
const POINTER =
  "evidence-and-probes.md's Run-internal identifiers section defines these IDs and documents a check for them.";

const probesRaw = readAsset("skill/references/evidence-and-probes.md");
const section = probesRaw.slice(
  probesRaw.indexOf("# Run-internal identifiers"),
);
const scriptFence = section.match(/```sh\n([\s\S]*?)\n```/);
if (!scriptFence) {
  throw new Error("the Run-internal identifiers check script is missing");
}
const script = scriptFence[1];

function renderedBodies(
  role: "implementer" | "reviewer",
): Array<[string, string]> {
  const bodies: Array<[string, string]> = [
    [
      `codex/${role}`,
      String(
        parse(composeCodexAgent(role, { model: "gpt-6-astra", effort: "high" }))
          .developer_instructions,
      ),
    ],
  ];
  for (const tier of ROLE_TIERS[role]) {
    bodies.push([
      `codex/${role}-${tier}`,
      String(
        parse(
          composeCodexAgent(role, { model: "gpt-6-astra", effort: tier }, tier),
        ).developer_instructions,
      ),
    ]);
  }
  const target = mkdtempSync(join(tmpdir(), "ow-run-internal-ids-"));
  try {
    runInit({
      targetDir: target,
      harnesses: ["claude", "opencode"],
      models: { ...DEFAULT_MODELS },
      opencodeModels: { [role]: "anthropic/claude-opus-4-8" },
      opencodeClassModels: {
        small: "anthropic/claude-haiku-4-5",
        medium: "anthropic/claude-sonnet-4-6",
        large: "anthropic/claude-opus-4-8",
      },
      tiers: true,
    });
    for (const harness of [".claude", ".opencode"]) {
      for (const tier of ROLE_TIERS[role]) {
        const suffix = tier === DEFAULT_TIER[role] ? "" : `-${tier}`;
        const file = join(target, harness, "agents", `${role}${suffix}.md`);
        bodies.push([
          `${harness}/${role}${suffix}.md`,
          readFileSync(file, "utf8"),
        ]);
      }
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
  return bodies;
}

describe("run-internal identifiers in role prompts", () => {
  it("every rendered implementer variant forbids them and points at the check", () => {
    expect(unwrap(readAsset("agents/implementer.md"))).toContain(
      `${IMPLEMENTER_RULE} ${POINTER}`,
    );
    for (const [name, body] of renderedBodies("implementer")) {
      expect(unwrap(body), name).toContain(`${IMPLEMENTER_RULE} ${POINTER}`);
    }
  });

  it("every rendered reviewer variant lists them in the maintainability checklist item", () => {
    const item = `- Maintainability: naming, dead code, needless abstraction, doc drift. ${REVIEWER_FINDING} ${POINTER}`;
    expect(unwrap(readAsset("agents/reviewer.md"))).toContain(item);
    for (const [name, body] of renderedBodies("reviewer")) {
      expect(unwrap(body), name).toContain(item);
    }
  });
});

describe("run-internal identifiers section of evidence-and-probes.md", () => {
  const text = unwrap(section);

  it("derives every ID format from the template that assigns it", () => {
    expect(text).toContain(
      "criterion IDs in `00-goal.md` (`AC-` plus three digits), task IDs in `02-tasks.md` (`T-` plus three digits), decision IDs in `03-decisions.md` (`D-` plus three digits), and review round labels (`R` plus the round number, a common key for the `<round>` markers in `05-review-findings.md`)",
    );
    expect(readAsset("templates/00-goal.md")).toMatch(/\bAC-\d{3}\b/);
    expect(readAsset("templates/02-tasks.md")).toMatch(/\bT-\d{3}\b/);
    expect(readAsset("templates/03-decisions.md")).toMatch(/\bD-\d{3}\b/);
    expect(readAsset("templates/05-review-findings.md")).toContain(
      "review-method[<round>]",
    );
  });

  it("states the rule, the extra's argv and base, and the exit codes", () => {
    expect(text).toContain(
      "Code, comments, tests, and commit messages reference the ticket or issue and describe the behaviour instead",
    );
    expect(text).toContain(
      'with `cwd` at the repository root and the run-base recorded in `00-goal.md` for that repository as its only argument. Its argv is `["sh", "-c", <the script below as one string>, "sh", <run-base>]`',
    );
    expect(text).toContain(
      "Exit `0` means no hit, exit `1` means at least one hit, each printed (a diff hit prefixed by its file path), and exit `2` means the run-base does not resolve to a commit.",
    );
  });

  it("states what the check covers, what it does not, and how a false positive is handled", () => {
    expect(text).toContain(
      "It covers the lines added between the run-base and `HEAD` outside `.ai/`, and the message of every commit in `run-base..HEAD`.",
    );
    expect(text).toContain(
      "It does not cover uncommitted changes, removed lines, pull request titles or bodies, branch names, or identifiers in any other format.",
    );
    expect(text).toContain(
      "A hit is a failure of the extra; when the orchestrator confirms a hit is a false positive it records that decision",
    );
  });
});

describe("the documented run-internal identifier check", () => {
  // The fixture identifiers are assembled at run time so this file does not
  // itself carry one.
  const id = (prefix: string, digits: string) => [prefix, digits].join("-");
  const criterion = id("AC", "004");
  const decision = id("D", "011");
  const task = id("T", "001");
  const round = ["R", "1"].join("");

  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  };
  const commit = (
    cwd: string,
    files: Record<string, string>,
    message: string,
  ) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(cwd, path, ".."), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", message);
  };
  const runCheck = (cwd: string, base: string) =>
    spawnSync("sh", ["-c", script, "sh", base], { cwd, encoding: "utf8" });

  it("passes a clean history, flags added lines and commit messages, and ignores the run directory", () => {
    const repo = mkdtempSync(join(tmpdir(), "ow-run-internal-ids-repo-"));
    try {
      git(repo, "init", "-q");
      commit(repo, { "README.md": `legacy ${criterion} note\n` }, "initial");
      const base = git(repo, "rev-parse", "HEAD");

      commit(
        repo,
        {
          "src/a.ts": `// keeps the retry bound (issue #12), not ${id("AC", "1234")}\n`,
        },
        "feat: bound the retry loop\n\nRefs: #12",
      );
      const clean = runCheck(repo, base);
      expect(clean.status).toBe(0);
      expect(clean.stdout).toBe("");

      commit(
        repo,
        {
          "src/b.ts": `// mandatory from the cut-off date (${criterion})\n`,
          ".ai/runs/x/02-tasks.md": `${task} stays inside the run directory\n`,
        },
        `fix: apply the ${decision} ordering from review ${round}`,
      );
      const dirty = runCheck(repo, base);
      expect(dirty.status).toBe(1);
      expect(dirty.stdout).toContain(
        `src/b.ts: // mandatory from the cut-off date (${criterion})`,
      );
      expect(dirty.stdout).toContain(
        `fix: apply the ${decision} ordering from review ${round}`,
      );
      expect(dirty.stdout).not.toContain("run directory");
      expect(dirty.stdout).not.toContain("legacy");
      expect(dirty.stdout).not.toContain("src/a.ts");

      expect(runCheck(repo, "not-a-commit").status).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

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
      'as an extra of kind `command` in the `after_preflight` phase, with `cwd` at the repository root and the run-base recorded in `00-goal.md` for that repository as its only argument. Its argv is `["sh", "-c", <the script below as one string>, "sh", <run-base>]`',
    );
    expect(text).toContain(
      "Exit `0` means no hit, exit `1` means at least one hit, each printed (a diff hit prefixed by its file path, in git's quoted form for a path git quotes), and exit `2` means the run-base does not resolve to a commit or a git, awk, or grep command failed. The check fails closed: it reads the whole diff and log into memory and checks the status of every stage, so a failure part way through (an unreadable object, or a text tool rejecting a byte, for example) exits `2` instead of passing on partial output; the text stages run byte-wise (`LC_ALL=C`) so no locale can make them reject the input.",
    );
    expect(text).toContain(
      "It changes to the top level of the repository first, so a `cwd` in a subdirectory scans the same range. The diff options override the external diff, textconv, binary, rename, color, and prefix settings of the user's git configuration and the repository's attributes (`--text` diffs a file marked `-diff` or `binary` as text), and the log option suppresses signature output, so those settings cannot hide an added line from the scan or add lines to it.",
    );
  });

  it("states what the check covers, what it does not, and how a false positive is handled", () => {
    expect(text).toContain(
      "It covers the lines added between the run-base and `HEAD` outside the top-level `.ai/` directory, and the message of every commit reachable from `HEAD` and not from the run-base. That range includes upstream work merged into the branch after the run-base, whose added lines and commit messages are scanned as well and can produce hits the branch did not write.",
    );
    expect(text).toContain(
      "It does not cover uncommitted changes, removed lines, an identifier directly next to a NUL byte (the shell drops NUL bytes from the captured diff), pull request titles or bodies, branch names, or identifiers in any other format.",
    );
    expect(text).toContain(
      "because `--text` also diffs files git detects as binary by content, an added image, font, or archive usually produces hits made of its raw bytes,",
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
  const runCheck = (
    cwd: string,
    base: string,
    env: NodeJS.ProcessEnv = process.env,
  ) =>
    spawnSync("sh", ["-c", script, "sh", base], {
      cwd,
      encoding: "utf8",
      env,
    });
  const withRepo = (body: (repo: string) => void) => {
    const repo = mkdtempSync(join(tmpdir(), "ow-run-internal-ids-repo-"));
    try {
      git(repo, "init", "-q");
      body(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  };
  // Deletes the loose object file behind an object id, so git fails when it
  // has to read that object.
  const dropObject = (repo: string, objectId: string) => {
    rmSync(
      join(repo, ".git", "objects", objectId.slice(0, 2), objectId.slice(2)),
    );
  };

  it("passes a clean history, flags added lines and commit messages each on their own, and ignores the run directory", () => {
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
          "src/b.ts": [
            `// mandatory from the cut-off date (${criterion})`,
            `// ordering as agreed in ${decision}`,
            `// split out of ${task}`,
            `// survived review ${round}`,
            "",
          ].join("\n"),
          ".ai/runs/x/02-tasks.md": `${task} stays inside the run directory\n`,
        },
        "refactor: split the ordering helper",
      );
      const inCode = runCheck(repo, base);
      expect(inCode.status).toBe(1);
      for (const line of [
        `src/b.ts: // mandatory from the cut-off date (${criterion})`,
        `src/b.ts: // ordering as agreed in ${decision}`,
        `src/b.ts: // split out of ${task}`,
        `src/b.ts: // survived review ${round}`,
      ]) {
        expect(inCode.stdout).toContain(line);
      }
      expect(inCode.stdout).not.toContain("run directory");
      expect(inCode.stdout).not.toContain("legacy");
      expect(inCode.stdout).not.toContain("src/a.ts");
      expect(inCode.stdout).not.toContain("refactor:");

      const beforeMessage = git(repo, "rev-parse", "HEAD");
      commit(
        repo,
        { "src/c.ts": "export const order = 1;\n" },
        `fix: apply the ordering from ${decision}`,
      );
      const inMessage = runCheck(repo, beforeMessage);
      expect(inMessage.status).toBe(1);
      expect(inMessage.stdout).toBe(
        `fix: apply the ordering from ${decision}\n`,
      );

      const badBase = runCheck(repo, "not-a-commit");
      expect(badBase.status).toBe(2);
      expect(badBase.stdout).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not scan removed lines", () => {
    withRepo((repo) => {
      commit(
        repo,
        { "notes.md": `keep\nordering from ${decision}\n` },
        "initial",
      );
      const base = git(repo, "rev-parse", "HEAD");
      commit(repo, { "notes.md": "keep\n" }, "docs: drop a stale note");
      const removed = runCheck(repo, base);
      expect(removed.status).toBe(0);
      expect(removed.stdout).toBe("");
    });
  });

  it("scans the whole repository when run from a subdirectory", () => {
    withRepo((repo) => {
      commit(repo, { "pkg/index.ts": "export {};\n" }, "initial");
      const base = git(repo, "rev-parse", "HEAD");
      commit(
        repo,
        { "top.ts": `// split out of ${task}\n` },
        "refactor: split the helper",
      );
      const fromSubdirectory = runCheck(join(repo, "pkg"), base);
      expect(fromSubdirectory.status).toBe(1);
      expect(fromSubdirectory.stdout).toBe(`top.ts: // split out of ${task}\n`);
    });
  });

  it("finds an added line despite an external diff driver, a textconv filter, and user diff settings", () => {
    withRepo((repo) => {
      commit(
        repo,
        { "README.md": "fixture\n", "legacy.md": `from ${criterion}\n` },
        "initial",
      );
      const base = git(repo, "rev-parse", "HEAD");
      git(repo, "config", "diff.scrub.textconv", "sed -e s/./x/g");
      git(repo, "config", "diff.noprefix", "true");
      git(repo, "config", "diff.renames", "false");
      git(repo, "mv", "legacy.md", "kept.md");
      commit(
        repo,
        {
          ".gitattributes": "*.ts diff=scrub\n",
          "src/a.ts": `// ordering as agreed in ${decision}\n`,
        },
        "refactor: order the helper",
      );
      const configured = runCheck(repo, base, {
        ...process.env,
        GIT_EXTERNAL_DIFF: "true",
      });
      expect(configured.status).toBe(1);
      expect(configured.stdout).toBe(
        `src/a.ts: // ordering as agreed in ${decision}\n`,
      );
    });
  });

  it("exits 2 when git cannot read an object in the diff", () => {
    withRepo((repo) => {
      commit(repo, { "README.md": "fixture\n" }, "initial");
      const base = git(repo, "rev-parse", "HEAD");
      commit(
        repo,
        { "src/a.ts": `// survived review ${round}\n` },
        "feat: add the helper",
      );
      dropObject(repo, git(repo, "rev-parse", "HEAD:src/a.ts"));
      const unreadable = runCheck(repo, base);
      expect(unreadable.status).toBe(2);
      expect(unreadable.stdout).toBe("");
    });
  });

  it("exits 2 when git cannot walk a commit in the range", () => {
    withRepo((repo) => {
      commit(repo, { "README.md": "fixture\n" }, "initial");
      const base = git(repo, "rev-parse", "HEAD");
      commit(
        repo,
        { "src/a.ts": "export const a = 1;\n" },
        `feat: add the helper for ${task}`,
      );
      const middle = git(repo, "rev-parse", "HEAD");
      commit(repo, { "src/b.ts": "export const b = 2;\n" }, "feat: add b");
      dropObject(repo, middle);
      const unwalkable = runCheck(repo, base);
      expect(unwalkable.status).toBe(2);
      expect(unwalkable.stdout).toBe("");
    });
  });

  it("scans every file after a byte that is not valid UTF-8, under a UTF-8 locale", () => {
    withRepo((repo) => {
      commit(repo, { "README.md": "fixture\n" }, "initial");
      const base = git(repo, "rev-parse", "HEAD");
      writeFileSync(
        join(repo, "a1.ts"),
        Buffer.from([0x2f, 0x2f, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a]),
      );
      commit(
        repo,
        { "z.ts": `// kept as agreed in ${decision}\n` },
        "feat: add two helpers",
      );
      const utf8 = runCheck(repo, base, {
        ...process.env,
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
      });
      expect(utf8.status).toBe(1);
      expect(utf8.stdout).toBe(`z.ts: // kept as agreed in ${decision}\n`);
    });
  });

  it("finds an added line in a file the repository marks -diff", () => {
    withRepo((repo) => {
      commit(repo, { ".gitattributes": "*.ts -diff\n" }, "initial");
      const base = git(repo, "rev-parse", "HEAD");
      commit(
        repo,
        { "src/a.ts": `// split out of ${task}\n` },
        "refactor: split the helper",
      );
      const unmarked = runCheck(repo, base);
      expect(unmarked.status).toBe(1);
      expect(unmarked.stdout).toBe(`src/a.ts: // split out of ${task}\n`);
    });
  });

  it("scans the body of a commit message, not only its subject", () => {
    withRepo((repo) => {
      commit(repo, { "README.md": "fixture\n" }, "initial");
      const base = git(repo, "rev-parse", "HEAD");
      commit(
        repo,
        { "src/a.ts": "export const a = 1;\n" },
        `feat: add the helper\n\nas decided in ${decision}`,
      );
      const body = runCheck(repo, base);
      expect(body.status).toBe(1);
      expect(body.stdout).toBe(`as decided in ${decision}\n`);
    });
  });

  it("reads an added line starting with '++ ' as content, not as a file header", () => {
    withRepo((repo) => {
      commit(repo, { "README.md": "fixture\n" }, "initial");
      const base = git(repo, "rev-parse", "HEAD");
      commit(
        repo,
        { "notes.md": `++ counter from ${round}\nplain line\n` },
        "docs: add notes",
      );
      const content = runCheck(repo, base);
      expect(content.status).toBe(1);
      expect(content.stdout).toBe(`notes.md: ++ counter from ${round}\n`);
    });
  });

  // A text stage that fails must not read as "no hit". Each case puts a
  // failing stand-in for one tool first on PATH while the range carries an
  // identifier, so only the stage status can turn the result into exit 2.
  const withFailingTool = (
    tool: "awk" | "grep",
    body: (env: NodeJS.ProcessEnv) => void,
  ) => {
    const bin = mkdtempSync(join(tmpdir(), "ow-run-internal-ids-bin-"));
    try {
      writeFileSync(join(bin, tool), "#!/bin/sh\necho failing >&2\nexit 2\n", {
        mode: 0o755,
      });
      body({ ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  };

  for (const tool of ["awk", "grep"] as const) {
    it(`exits 2 when ${tool} fails, even though the range carries an identifier`, () => {
      withRepo((repo) => {
        commit(repo, { "README.md": "fixture\n" }, "initial");
        const base = git(repo, "rev-parse", "HEAD");
        commit(
          repo,
          { "src/a.ts": `// split out of ${task}\n` },
          `refactor: split the helper for ${task}`,
        );
        withFailingTool(tool, (env) => {
          expect(runCheck(repo, base, env).status).toBe(2);
        });
      });
    });
  }

  it("ignores GREP_OPTIONS in the environment", () => {
    withRepo((repo) => {
      commit(repo, { "README.md": "fixture\n" }, "initial");
      const base = git(repo, "rev-parse", "HEAD");
      commit(
        repo,
        { "src/a.ts": `// split out of ${task}\n` },
        "refactor: split the helper",
      );
      const withOptions = runCheck(repo, base, {
        ...process.env,
        GREP_OPTIONS: "-m0",
      });
      expect(withOptions.status).toBe(1);
    });
  });
});

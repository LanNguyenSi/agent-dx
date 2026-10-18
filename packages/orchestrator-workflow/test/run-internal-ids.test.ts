import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

// Issue #337: identifiers the run files assign leak from briefings into
// committed code, tests and commit messages, where they read as broken
// references. evidence-and-probes.md documents a check for them once; the
// script's behaviour and the templates' ID formats are what is pinned here,
// not the prompt sentences that forbid the identifiers.

const probesRaw = readAsset("skill/references/evidence-and-probes.md");
const section = probesRaw.slice(
  probesRaw.indexOf("# Run-internal identifiers"),
);
const scriptFence = section.match(/```sh\n([\s\S]*?)\n```/);
if (!scriptFence) {
  throw new Error("the Run-internal identifiers check script is missing");
}
const script = scriptFence[1];

describe("run-internal identifier formats are assigned by the run templates", () => {
  it("the templates assign the ID formats the check scans for", () => {
    expect(readAsset("templates/02-tasks.md")).toMatch(/\bT-\d{3}\b/);
    expect(readAsset("templates/03-decisions.md")).toMatch(/\bD-\d{3}\b/);
    expect(readAsset("templates/05-review-findings.md")).toContain(
      "review-method[<round>]",
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
      // GNU grep ignores GREP_OPTIONS, so a stand-in that refuses to run
      // while the variable is set makes the test fail on every platform if
      // the check stops clearing it.
      const realGrep = spawnSync("sh", ["-c", "command -v grep"], {
        encoding: "utf8",
      }).stdout.trim();
      const bin = mkdtempSync(join(tmpdir(), "ow-run-internal-ids-bin-"));
      try {
        writeFileSync(
          join(bin, "grep"),
          `#!/bin/sh\n[ -n "\${GREP_OPTIONS+x}" ] && exit 3\nexec ${realGrep} "$@"\n`,
          { mode: 0o755 },
        );
        const withOptions = runCheck(repo, base, {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GREP_OPTIONS: "-m0",
        });
        expect(withOptions.status).toBe(1);
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
  });
});

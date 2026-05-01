import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateChangelog } from "./commands/changelog.js";
import { runPrep } from "./commands/prep.js";
import { suggestVersion } from "./commands/version.js";

const tempRepos: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRepos
      .splice(0)
      .map((repoPath) => rm(repoPath, { recursive: true, force: true })),
  );
});

describe("release-prep commands", () => {
  it("suggests a minor bump when a feature was added after the latest tag", async () => {
    const repoPath = await createFixtureRepo({
      packageVersion: "1.2.3",
      commits: [
        {
          message: "chore: initial release",
          tag: "v1.2.3",
        },
        {
          message: "feat(api): add release endpoint",
        },
      ],
    });

    const output = await captureConsoleOutput(() =>
      withCwd(repoPath, () => suggestVersion()),
    );

    expect(output).toContain("Current version: 1.2.3");
    expect(output).toContain("Previous tag: v1.2.3");
    expect(output).toContain("Recommended bump: minor");
    expect(output).toContain("Suggested version: 1.3.0");
    expect(output).toContain("Suggested tag: v1.3.0");
  });

  it("prints grouped changelog json based on commits since the latest tag", async () => {
    const repoPath = await createFixtureRepo({
      packageVersion: "1.2.3",
      commits: [
        {
          message: "chore: initial release",
          tag: "v1.2.3",
        },
        {
          message: "fix: handle missing tags",
        },
        {
          message: "docs: update readme",
        },
      ],
    });

    const output = await captureConsoleOutput(() =>
      withCwd(repoPath, () => generateChangelog({ format: "json" })),
    );
    const parsed = JSON.parse(output) as {
      previousTag: string | null;
      currentVersion: string;
      commitCount: number;
      groups: Array<{ type: string; commits: Array<{ description: string }> }>;
    };

    expect(parsed.previousTag).toBe("v1.2.3");
    expect(parsed.currentVersion).toBe("1.2.3");
    expect(parsed.commitCount).toBe(2);
    expect(parsed.groups.map((group) => group.type)).toEqual(["fix", "docs"]);
    expect(parsed.groups[0]?.commits[0]?.description).toBe(
      "handle missing tags",
    );
  });

  it("runs prep in dry-run mode without mutating the repository", async () => {
    const repoPath = await createFixtureRepo({
      packageVersion: "0.4.0",
      commits: [
        {
          message: "chore: initial release",
          tag: "v0.4.0",
        },
        {
          message: "fix!: change release layout",
          body: "BREAKING CHANGE: changelog sections were renamed",
        },
      ],
    });

    const output = await captureConsoleOutput(() =>
      withCwd(repoPath, () =>
        runPrep({ dryRun: true, tag: false, release: false }),
      ),
    );
    const tagsAfter = await listTags(repoPath);

    expect(output).toContain("Release summary");
    expect(output).toContain("Recommended bump: major");
    expect(output).toContain("Version strategy: major");
    expect(output).toContain("Next version: 1.0.0");
    expect(output).toContain("Dry run: no tag or GitHub release was created.");
    expect(tagsAfter).toEqual(["v0.4.0"]);
  });
});

async function captureConsoleOutput(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

  try {
    await run();
  } finally {
    logSpy.mockRestore();
  }

  return lines.join("\n");
}

async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  process.chdir(cwd);

  try {
    return await run();
  } finally {
    process.chdir(previousCwd);
  }
}

async function createFixtureRepo(input: {
  packageVersion: string;
  commits: Array<{
    message: string;
    body?: string;
    tag?: string;
  }>;
}): Promise<string> {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "release-prep-test-"));
  tempRepos.push(repoPath);

  await execa("git", ["init"], { cwd: repoPath });
  await execa("git", ["config", "user.name", "Release Prep Test"], {
    cwd: repoPath,
  });
  await execa("git", ["config", "user.email", "release-prep@example.com"], {
    cwd: repoPath,
  });

  await writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify(
      {
        name: "fixture-release-prep",
        version: input.packageVersion,
        private: true,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  for (const [index, commit] of input.commits.entries()) {
    await writeFile(
      path.join(repoPath, `file-${index}.txt`),
      `${commit.message}\n`,
      "utf8",
    );
    await execa("git", ["add", "."], { cwd: repoPath });

    const messageArgs = ["commit", "-m", commit.message];
    if (commit.body) {
      messageArgs.push("-m", commit.body);
    }

    await execa("git", messageArgs, { cwd: repoPath });

    if (commit.tag) {
      await execa("git", ["tag", commit.tag], { cwd: repoPath });
    }
  }

  return repoPath;
}

async function listTags(cwd: string): Promise<string[]> {
  const { stdout } = await execa("git", ["tag", "--sort=creatordate"], { cwd });
  return stdout
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

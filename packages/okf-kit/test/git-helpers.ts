import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export interface TmpGitRepo {
  dir: string;
  git(args: string[]): string;
  /**
   * Writes a file (creating parent directories as needed) and commits it
   * with both author and committer date pinned to `isoDate`, so the
   * resulting `git log --format=%ct` epoch is deterministic regardless of
   * when the test actually runs.
   */
  commitFile(relPath: string, content: string, isoDate: string): void;
  /**
   * Writes multiple files and commits them in a SINGLE commit with both
   * author and committer date pinned to `isoDate`. Stages exactly the given
   * paths, so files deliberately left untracked by a test stay untracked.
   */
  commitFiles(
    files: Array<{ relPath: string; content: string }>,
    isoDate: string,
  ): void;
  /**
   * Runs an arbitrary git command with BOTH author and committer date pinned
   * to `isoDate`, the same way `commitFile`/`commitFiles` do. Needed for the
   * history shapes those two cannot build -- `git mv` + `commit` (rename),
   * `git checkout -b` + `git merge` (merge commits) -- whose commit times
   * must stay as deterministic as every other fixture commit's.
   */
  gitAt(args: string[], isoDate: string): string;
  cleanup(): void;
}

export function createTmpGitRepo(): TmpGitRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-git-"));
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.email", "okf-kit-tests@example.com"]);
  git(["config", "user.name", "okf-kit tests"]);

  return {
    dir,
    git,
    commitFile(relPath, content, isoDate) {
      const abs = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      git(["add", relPath]);
      execFileSync("git", ["commit", "--quiet", "-m", `commit ${relPath}`], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: isoDate,
          GIT_COMMITTER_DATE: isoDate,
        },
      });
    },
    commitFiles(files, isoDate) {
      for (const { relPath, content } of files) {
        const abs = path.join(dir, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
      git(["add", ...files.map((f) => f.relPath)]);
      execFileSync("git", ["commit", "--quiet", "-m", "bulk commit"], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: isoDate,
          GIT_COMMITTER_DATE: isoDate,
        },
      });
    },
    gitAt(args, isoDate) {
      return execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: isoDate,
          GIT_COMMITTER_DATE: isoDate,
        },
      }).trim();
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Renders an OKF doc (frontmatter + a throwaway body) as file content. */
export function docContent(frontmatter: Record<string, unknown>): string {
  return `---\n${YAML.stringify(frontmatter)}---\n\n# Doc\n`;
}

/** Writes an OKF doc (frontmatter + a throwaway body) at `baseDir/relPath`. */
export function writeDoc(
  baseDir: string,
  relPath: string,
  frontmatter: Record<string, unknown>,
): void {
  const abs = path.join(baseDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, docContent(frontmatter));
}

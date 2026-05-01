import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import semver from "semver";
import simpleGit, { type SimpleGit } from "simple-git";

export type CommitType =
  | "feat"
  | "fix"
  | "perf"
  | "refactor"
  | "docs"
  | "test"
  | "chore"
  | "ci"
  | "build"
  | "style"
  | "revert"
  | "other";

export type VersionBump = "major" | "minor" | "patch";

export interface ParsedCommit {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  type: CommitType;
  scope: string | null;
  description: string;
  breaking: boolean;
}

export interface ReleaseContext {
  previousTag: string | null;
  currentVersion: string;
  commits: ParsedCommit[];
  recommendedBump: VersionBump | null;
}

export interface ChangelogJson {
  previousTag: string | null;
  currentVersion: string;
  recommendedBump: VersionBump | null;
  commitCount: number;
  groups: Array<{
    type: CommitType;
    title: string;
    commits: ParsedCommit[];
  }>;
}

const SECTION_TITLES: Record<CommitType, string> = {
  feat: "Features",
  fix: "Fixes",
  perf: "Performance",
  refactor: "Refactors",
  docs: "Documentation",
  test: "Tests",
  chore: "Chores",
  ci: "CI",
  build: "Build",
  style: "Style",
  revert: "Reverts",
  other: "Other",
};

const SECTION_ORDER: CommitType[] = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "chore",
  "ci",
  "build",
  "style",
  "revert",
  "other",
];

const CONVENTIONAL_COMMIT_PATTERN = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/i;

export function createGitClient(cwd = process.cwd()): SimpleGit {
  return simpleGit({
    baseDir: cwd,
    maxConcurrentProcesses: 1,
  });
}

export async function analyzeReleaseContext(
  cwd = process.cwd(),
): Promise<ReleaseContext> {
  const git = createGitClient(cwd);
  await ensureGitRepository(git);

  const previousTag = await getLatestTag(git);
  const currentVersion = await resolveCurrentVersion(cwd, previousTag);
  const commits = await getCommitsSinceTag(git, previousTag);

  return {
    previousTag,
    currentVersion,
    commits,
    recommendedBump: recommendVersionBump(commits),
  };
}

export async function ensureGitRepository(git: SimpleGit): Promise<void> {
  const isRepo = await git.checkIsRepo();

  if (!isRepo) {
    throw new Error("Current directory is not a git repository.");
  }
}

export async function getLatestTag(git: SimpleGit): Promise<string | null> {
  const output = await git.raw(["tag", "--sort=-creatordate"]);
  const tags = output
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);

  return tags[0] ?? null;
}

export async function resolveCurrentVersion(
  cwd: string,
  previousTag: string | null,
): Promise<string> {
  const versionFromTag = previousTag ? semver.clean(previousTag) : null;

  if (versionFromTag) {
    return versionFromTag;
  }

  const packageVersion = await readPackageVersion(cwd);
  const normalizedPackageVersion = semver.valid(packageVersion);

  if (normalizedPackageVersion) {
    return normalizedPackageVersion;
  }

  throw new Error(
    "Could not determine a valid current version from git tags or package.json.",
  );
}

export async function readPackageVersion(cwd: string): Promise<string> {
  const packageJsonPath = path.join(cwd, "package.json");
  const content = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(content) as { version?: unknown };

  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json does not contain a valid version field.");
  }

  return parsed.version;
}

export async function getCommitsSinceTag(
  git: SimpleGit,
  previousTag: string | null,
): Promise<ParsedCommit[]> {
  const format = ["%H", "%h", "%s", "%b"].join("%x1f") + "%x1e";
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const output = await git.raw(["log", range, `--pretty=format:${format}`]);

  return parseGitLog(output);
}

export function parseGitLog(output: string): ParsedCommit[] {
  return output
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, shortHash, subject, ...bodyParts] = entry.split("\x1f");
      const body = bodyParts.join("\x1f").trim();

      if (!hash || !shortHash || !subject) {
        throw new Error("Encountered malformed git log output.");
      }

      return parseCommit({
        hash,
        shortHash,
        subject,
        body,
      });
    });
}

export function parseCommit(input: {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
}): ParsedCommit {
  const match = input.subject.match(CONVENTIONAL_COMMIT_PATTERN);
  const breakingFromBody = /BREAKING CHANGE:/i.test(input.body);

  if (!match) {
    return {
      ...input,
      type: "other",
      scope: null,
      description: input.subject,
      breaking: breakingFromBody,
    };
  }

  const [, rawType, scope, bang, description] = match;
  const normalizedType = rawType.toLowerCase() as CommitType;
  const type = SECTION_ORDER.includes(normalizedType)
    ? normalizedType
    : "other";

  return {
    ...input,
    type,
    scope: scope ?? null,
    description,
    breaking: bang === "!" || breakingFromBody,
  };
}

export function recommendVersionBump(
  commits: ParsedCommit[],
): VersionBump | null {
  if (commits.length === 0) {
    return null;
  }

  if (commits.some((commit) => commit.breaking)) {
    return "major";
  }

  if (commits.some((commit) => commit.type === "feat")) {
    return "minor";
  }

  return "patch";
}

export function computeNextVersion(
  currentVersion: string,
  requestedBump: VersionBump | null,
  explicitVersion?: string,
): string {
  if (explicitVersion) {
    const normalizedExplicitVersion = semver.valid(explicitVersion);

    if (!normalizedExplicitVersion) {
      throw new Error(`Invalid version: ${explicitVersion}`);
    }

    return normalizedExplicitVersion;
  }

  if (!requestedBump) {
    throw new Error(
      "No commits found to derive the next version. Use --version to set one explicitly.",
    );
  }

  const nextVersion = semver.inc(currentVersion, requestedBump);

  if (!nextVersion) {
    throw new Error(
      `Unable to increment version ${currentVersion} with bump ${requestedBump}.`,
    );
  }

  return nextVersion;
}

export function computePlannedVersion(
  context: Pick<
    ReleaseContext,
    "currentVersion" | "previousTag" | "recommendedBump"
  >,
  requestedBump: VersionBump | null,
  explicitVersion?: string,
): string {
  if (explicitVersion || requestedBump) {
    return computeNextVersion(
      context.currentVersion,
      requestedBump,
      explicitVersion,
    );
  }

  if (!context.previousTag) {
    return context.currentVersion;
  }

  return computeNextVersion(context.currentVersion, context.recommendedBump);
}

export function formatTagName(version: string): string {
  return `v${version}`;
}

export function buildChangelogMarkdown(
  context: ReleaseContext,
  versionLabel = "Unreleased",
): string {
  const lines: string[] = ["# Changelog", "", `## ${versionLabel}`];

  if (context.previousTag) {
    lines.push("", `Changes since \`${context.previousTag}\`.`);
  } else {
    lines.push("", "Initial release.");
  }

  const groupedCommits = groupCommits(context.commits);

  if (groupedCommits.length === 0) {
    lines.push("", "- No changes detected.");
    return lines.join("\n");
  }

  for (const group of groupedCommits) {
    lines.push("", `### ${group.title}`);

    for (const commit of group.commits) {
      const scopePrefix = commit.scope ? `**${commit.scope}:** ` : "";
      const breakingSuffix = commit.breaking ? " [breaking]" : "";
      lines.push(
        `- ${scopePrefix}${commit.description} (${commit.shortHash})${breakingSuffix}`,
      );
    }
  }

  return lines.join("\n");
}

export function buildChangelogJson(context: ReleaseContext): ChangelogJson {
  const groups = groupCommits(context.commits).map((group) => ({
    ...group,
    commits: group.commits.map((commit) => ({ ...commit })),
  }));

  return {
    previousTag: context.previousTag,
    currentVersion: context.currentVersion,
    recommendedBump: context.recommendedBump,
    commitCount: context.commits.length,
    groups,
  };
}

export function groupCommits(commits: ParsedCommit[]): Array<{
  type: CommitType;
  title: string;
  commits: ParsedCommit[];
}> {
  return SECTION_ORDER.map((type) => ({
    type,
    title: SECTION_TITLES[type],
    commits: commits.filter((commit) => commit.type === type),
  })).filter((group) => group.commits.length > 0);
}

export async function ensureTagDoesNotExist(
  git: SimpleGit,
  tagName: string,
): Promise<void> {
  const output = await git.raw(["tag", "-l", tagName]);

  if (output.trim() === tagName) {
    throw new Error(`Tag ${tagName} already exists.`);
  }
}

export async function createAnnotatedTag(
  git: SimpleGit,
  tagName: string,
): Promise<void> {
  await git.raw(["tag", "-a", tagName, "-m", `Release ${tagName}`]);
}

export async function ensureGhCliAvailable(): Promise<void> {
  try {
    await execa("gh", ["--version"]);
  } catch {
    throw new Error("GitHub CLI (gh) is required to create releases.");
  }
}

export async function createGitHubRelease(
  tagName: string,
  notes: string,
): Promise<void> {
  await ensureGhCliAvailable();

  await execa(
    "gh",
    [
      "release",
      "create",
      tagName,
      "--title",
      tagName,
      "--notes-file",
      "-",
      "--target",
      "HEAD",
    ],
    {
      input: notes,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
}

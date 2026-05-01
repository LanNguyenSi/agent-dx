import chalk from "chalk";
import ora from "ora";
import {
  analyzeReleaseContext,
  buildChangelogMarkdown,
  computePlannedVersion,
  createAnnotatedTag,
  createGitClient,
  createGitHubRelease,
  ensureTagDoesNotExist,
  formatTagName,
  type VersionBump,
} from "../lib/release.js";

interface PrepOptions {
  type?: string;
  version?: string;
  tag?: boolean;
  release?: boolean;
  dryRun?: boolean;
}

const VALID_BUMPS: VersionBump[] = ["major", "minor", "patch"];

export async function runPrep(options: PrepOptions): Promise<void> {
  const requestedBump = normalizeRequestedBump(options.type);
  const spinner = ora("Analyzing repository").start();

  try {
    const context = await analyzeReleaseContext();
    const nextVersion = computePlannedVersion(
      context,
      requestedBump,
      options.version,
    );
    const tagName = formatTagName(nextVersion);
    const changelog = buildChangelogMarkdown(context, tagName);

    spinner.succeed("Release plan prepared");

    printSummary({
      currentVersion: context.currentVersion,
      previousTag: context.previousTag,
      recommendedBump: context.recommendedBump,
      versionStrategy: options.version
        ? "explicit"
        : requestedBump
          ? requestedBump
          : context.previousTag
            ? (context.recommendedBump ?? "none")
            : "initial",
      nextVersion,
      tagName,
      createTag: options.tag !== false,
      createRelease: options.release !== false,
      commitCount: context.commits.length,
      dryRun: options.dryRun === true,
    });

    console.log("");
    console.log(changelog);

    if (options.dryRun) {
      console.log("");
      console.log(
        chalk.yellow("Dry run: no tag or GitHub release was created."),
      );
      return;
    }

    const git = createGitClient();

    if (options.tag !== false) {
      const tagSpinner = ora(`Creating annotated tag ${tagName}`).start();
      await ensureTagDoesNotExist(git, tagName);
      await createAnnotatedTag(git, tagName);
      tagSpinner.succeed(`Created tag ${tagName}`);
    }

    if (options.release !== false) {
      const releaseSpinner = ora(`Creating GitHub release ${tagName}`).start();
      await createGitHubRelease(tagName, changelog);
      releaseSpinner.succeed(`Created GitHub release ${tagName}`);
    }
  } catch (error) {
    spinner.fail("Release preparation failed");
    throw error;
  }
}

function normalizeRequestedBump(rawType?: string): VersionBump | null {
  if (!rawType) {
    return null;
  }

  if (!VALID_BUMPS.includes(rawType as VersionBump)) {
    throw new Error(
      `Invalid bump type: ${rawType}. Use major, minor, or patch.`,
    );
  }

  return rawType as VersionBump;
}

function printSummary(input: {
  currentVersion: string;
  previousTag: string | null;
  recommendedBump: VersionBump | null;
  versionStrategy: VersionBump | "explicit" | "initial" | "none";
  nextVersion: string;
  tagName: string;
  createTag: boolean;
  createRelease: boolean;
  commitCount: number;
  dryRun: boolean;
}): void {
  console.log(chalk.cyan("Release summary"));
  console.log(`- Current version: ${input.currentVersion}`);
  console.log(`- Previous tag: ${input.previousTag ?? "none"}`);
  console.log(`- Commits considered: ${input.commitCount}`);
  console.log(`- Recommended bump: ${input.recommendedBump ?? "none"}`);
  console.log(`- Version strategy: ${input.versionStrategy}`);
  console.log(`- Next version: ${input.nextVersion}`);
  console.log(`- Tag name: ${input.tagName}`);
  console.log(`- Create local tag: ${input.createTag ? "yes" : "no"}`);
  console.log(`- Create GitHub release: ${input.createRelease ? "yes" : "no"}`);
  console.log(`- Mode: ${input.dryRun ? "dry-run" : "live"}`);
}

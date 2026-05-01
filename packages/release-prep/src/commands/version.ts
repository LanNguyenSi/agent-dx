import chalk from "chalk";
import {
  analyzeReleaseContext,
  computePlannedVersion,
  formatTagName,
} from "../lib/release.js";

export async function suggestVersion(): Promise<void> {
  const context = await analyzeReleaseContext();
  const bump = context.recommendedBump;

  console.log(chalk.cyan(`Current version: ${context.currentVersion}`));
  console.log(chalk.cyan(`Previous tag: ${context.previousTag ?? "none"}`));
  console.log(chalk.cyan(`Commits considered: ${context.commits.length}`));

  if (!bump) {
    console.log(chalk.yellow("No commits found since the last release."));
    return;
  }

  const nextVersion = computePlannedVersion(context, null);

  console.log(chalk.green(`Recommended bump: ${bump}`));
  console.log(chalk.green(`Suggested version: ${nextVersion}`));
  console.log(chalk.gray(`Suggested tag: ${formatTagName(nextVersion)}`));
}

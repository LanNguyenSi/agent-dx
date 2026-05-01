import { writeFile } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import {
  analyzeReleaseContext,
  buildChangelogJson,
  buildChangelogMarkdown,
} from "../lib/release.js";

interface ChangelogOptions {
  output?: string;
  format?: string;
}

export async function generateChangelog(
  options: ChangelogOptions,
): Promise<void> {
  const format = options.format ?? "markdown";

  if (format !== "markdown" && format !== "json") {
    throw new Error(`Unsupported format: ${format}. Use "markdown" or "json".`);
  }

  const context = await analyzeReleaseContext();
  const result =
    format === "json"
      ? JSON.stringify(buildChangelogJson(context), null, 2)
      : buildChangelogMarkdown(context);

  if (options.output) {
    const outputPath = path.resolve(process.cwd(), options.output);
    await writeFile(outputPath, result + "\n", "utf8");
    console.log(chalk.green(`✓ Wrote changelog to ${outputPath}`));
    return;
  }

  console.log(result);
}

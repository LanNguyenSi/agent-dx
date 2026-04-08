import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";
import { generateSkill, toSkillIdentifier, toSkillSlug } from "./skill.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dirPath) => rm(dirPath, { recursive: true, force: true })),
  );
});

describe("skill generator helpers", () => {
  it("creates a normalized slug", () => {
    expect(toSkillSlug("  Build Report v2  ")).toBe("build-report-v2");
  });

  it("builds a valid identifier from slug", () => {
    expect(toSkillIdentifier("build-report-v2")).toBe("buildReportV2Skill");
  });
});

describe("generateSkill", () => {
  it("creates skill files and updates TypeScript loader", async () => {
    const projectDir = await createTempProject(
      "loader.ts",
      `export interface Skill {
  name: string;
  description: string;
  run(input: string): Promise<string>;
}

import { exampleSkill } from "./example.js";

export function loadSkills(): Skill[] {
  return [exampleSkill];
}
`,
    );

    const result = await generateSkill({
      projectDir,
      rawName: "Release Notes",
      description: "Generate release notes.",
    });

    expect(result.slug).toBe("release-notes");
    expect(result.identifier).toBe("releaseNotesSkill");

    const loader = await readFile(result.loaderPath, "utf8");
    expect(loader).toContain(
      'import { releaseNotesSkill } from "./release-notes.js";',
    );
    expect(loader).toContain("return [exampleSkill, releaseNotesSkill];");

    const skillModule = await readFile(result.skillPath, "utf8");
    expect(skillModule).toContain("export const releaseNotesSkill: Skill");
    expect(skillModule).toContain("Generate release notes.");

    const skillMarkdown = await readFile(result.markdownPath, "utf8");
    expect(skillMarkdown).toContain("# release-notes");
    expect(skillMarkdown).toContain("Generate release notes.");
  });

  it("is idempotent when called repeatedly for the same skill", async () => {
    const projectDir = await createTempProject(
      "loader.js",
      `import { exampleSkill } from "./example.js";

export function loadSkills() {
  return [exampleSkill];
}
`,
    );

    await generateSkill({
      projectDir,
      rawName: "summarize-context",
    });
    await generateSkill({
      projectDir,
      rawName: "summarize-context",
    });

    const loader = await readFile(
      path.join(projectDir, "src", "skills", "loader.js"),
      "utf8",
    );
    const occurrences = loader.match(/summarizeContextSkill/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});

async function createTempProject(
  loaderFile: "loader.ts" | "loader.js",
  loaderContent: string,
): Promise<string> {
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), "agent-dev-kit-skill-test-"),
  );
  tempDirs.push(projectDir);

  const skillsDir = path.join(projectDir, "src", "skills");
  await fs.ensureDir(skillsDir);
  await writeFile(path.join(skillsDir, loaderFile), loaderContent, "utf8");

  return projectDir;
}

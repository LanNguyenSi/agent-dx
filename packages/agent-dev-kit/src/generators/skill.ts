import path from "node:path";
import fs from "fs-extra";

export interface SkillGenerationOptions {
  projectDir: string;
  rawName: string;
  description?: string;
}

export interface SkillGenerationResult {
  slug: string;
  identifier: string;
  loaderPath: string;
  skillPath: string;
  markdownPath: string;
  createdSkillFile: boolean;
  createdMarkdownFile: boolean;
}

export function toSkillSlug(rawName: string): string {
  const normalized = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new Error("Skill name must contain at least one letter or number.");
  }

  return normalized;
}

export function toSkillIdentifier(slug: string): string {
  const parts = slug.split("-").filter((part) => part.length > 0);
  const camelCase = parts
    .map((part, index) =>
      index === 0 ? part : `${part[0].toUpperCase()}${part.slice(1)}`,
    )
    .join("");

  return `${camelCase}Skill`;
}

function buildSkillModuleContent(
  extension: "ts" | "js",
  identifier: string,
  description: string,
): string {
  if (extension === "ts") {
    return `import type { Skill } from "./loader.js";

export const ${identifier}: Skill = {
  name: "${identifier}",
  description: "${description}",
  async run(input: string): Promise<string> {
    return \`${identifier} received: \${input}\`;
  },
};
`;
  }

  return `export const ${identifier} = {
  name: "${identifier}",
  description: "${description}",
  async run(input) {
    return \`${identifier} received: \${input}\`;
  },
};
`;
}

function buildSkillMarkdownContent(slug: string, description: string): string {
  return `# ${slug}

## Purpose

${description}

## Input

- Describe the expected input format.

## Output

- Describe the expected output format.
`;
}

function updateLoaderContent(
  source: string,
  importLine: string,
  identifier: string,
): string {
  let content = source;

  if (!content.includes(importLine)) {
    const importRegex = /^import .*;$/gm;
    const imports = [...content.matchAll(importRegex)];

    if (imports.length > 0) {
      const lastImport = imports[imports.length - 1];
      const insertIndex = (lastImport.index ?? 0) + lastImport[0].length;
      content =
        content.slice(0, insertIndex) +
        `\n${importLine}` +
        content.slice(insertIndex);
    } else {
      content = `${importLine}\n${content}`;
    }
  }

  const returnMatch = content.match(/return\s*\[([\s\S]*?)\];/);
  if (!returnMatch) {
    throw new Error(
      "Could not update skills loader: expected `return [ ... ];` in loadSkills().",
    );
  }

  const currentEntries = returnMatch[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (!currentEntries.includes(identifier)) {
    currentEntries.push(identifier);
    const replacement = `return [${currentEntries.join(", ")}];`;
    content = content.replace(returnMatch[0], replacement);
  }

  return content;
}

function detectLoader(projectDir: string): {
  path: string;
  extension: "ts" | "js";
} {
  const tsPath = path.join(projectDir, "src", "skills", "loader.ts");
  const jsPath = path.join(projectDir, "src", "skills", "loader.js");

  if (fs.existsSync(tsPath)) {
    return {
      path: tsPath,
      extension: "ts",
    };
  }

  if (fs.existsSync(jsPath)) {
    return {
      path: jsPath,
      extension: "js",
    };
  }

  throw new Error(
    "Could not find skills loader. Expected src/skills/loader.ts or src/skills/loader.js.",
  );
}

export async function generateSkill(
  options: SkillGenerationOptions,
): Promise<SkillGenerationResult> {
  const slug = toSkillSlug(options.rawName);
  const identifier = toSkillIdentifier(slug);
  const description = options.description || `Skill for ${slug} tasks.`;

  const loader = detectLoader(options.projectDir);
  const skillsDir = path.join(options.projectDir, "src", "skills");
  const skillPath = path.join(skillsDir, `${slug}.${loader.extension}`);
  const markdownPath = path.join(skillsDir, slug, "SKILL.md");

  await fs.ensureDir(path.dirname(markdownPath));

  let createdSkillFile = false;
  let createdMarkdownFile = false;

  if (!(await fs.pathExists(skillPath))) {
    await fs.writeFile(
      skillPath,
      buildSkillModuleContent(loader.extension, identifier, description),
      "utf8",
    );
    createdSkillFile = true;
  }

  if (!(await fs.pathExists(markdownPath))) {
    await fs.writeFile(
      markdownPath,
      buildSkillMarkdownContent(slug, description),
      "utf8",
    );
    createdMarkdownFile = true;
  }

  const loaderContent = await fs.readFile(loader.path, "utf8");
  const updatedLoader = updateLoaderContent(
    loaderContent,
    `import { ${identifier} } from "./${slug}.js";`,
    identifier,
  );
  await fs.writeFile(loader.path, updatedLoader, "utf8");

  return {
    slug,
    identifier,
    loaderPath: loader.path,
    skillPath,
    markdownPath,
    createdSkillFile,
    createdMarkdownFile,
  };
}

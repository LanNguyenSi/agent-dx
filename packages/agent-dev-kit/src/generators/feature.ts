import path from "node:path";
import fs from "fs-extra";
import { FEATURE_NAMES, type FeatureName } from "../features.js";

export interface AddFeatureOptions {
  projectDir: string;
  feature: string;
}

export interface AddFeatureResult {
  feature: FeatureName;
  createdFiles: string[];
  updatedFiles: string[];
  alreadyPresent: boolean;
}

function assertFeatureName(value: string): FeatureName {
  if ((FEATURE_NAMES as readonly string[]).includes(value)) {
    return value as FeatureName;
  }

  throw new Error(
    `Unknown feature: ${value}. Allowed features: ${FEATURE_NAMES.join(", ")}.`,
  );
}

function detectLanguage(projectDir: string): { extension: "ts" | "js" } {
  const tsPath = path.join(projectDir, "src", "index.ts");
  if (fs.existsSync(tsPath)) {
    return { extension: "ts" };
  }

  const jsPath = path.join(projectDir, "src", "index.js");
  if (fs.existsSync(jsPath)) {
    return { extension: "js" };
  }

  throw new Error(
    "Could not find src/index.ts or src/index.js in the current directory.",
  );
}

function ensureImport(content: string, importLine: string): string {
  if (content.includes(importLine)) {
    return content;
  }

  const importRegex = /^import .*;$/gm;
  const imports = [...content.matchAll(importRegex)];

  if (imports.length === 0) {
    return `${importLine}\n${content}`;
  }

  const lastImport = imports[imports.length - 1];
  const insertIndex = (lastImport.index ?? 0) + lastImport[0].length;
  return (
    content.slice(0, insertIndex) +
    `\n${importLine}` +
    content.slice(insertIndex)
  );
}

function ensureClassField(
  content: string,
  anchor: string,
  fieldLine: string,
): string {
  if (content.includes(fieldLine)) {
    return content;
  }

  if (!content.includes(anchor)) {
    throw new Error(
      "Could not update src/index file: expected generated Agent class field layout.",
    );
  }

  return content.replace(anchor, `${anchor}\n${fieldLine}`);
}

function ensureConstructorTriologue(content: string): string {
  if (content.includes("this.triologue = new Triologue")) {
    return content;
  }

  const assignmentPattern =
    /(\s*this\.name = process\.env\.AGENT_NAME \|\| '.*';)/;
  const match = content.match(assignmentPattern);
  if (!match) {
    throw new Error(
      "Could not update src/index file: expected AGENT_NAME assignment in constructor.",
    );
  }

  const block = `\n    if (process.env.BYOA_TOKEN) {\n      this.triologue = new Triologue({\n        baseUrl: process.env.TRIOLOGUE_URL || 'https://opentriologue.ai',\n        token: process.env.BYOA_TOKEN,\n      });\n    }`;
  return content.replace(assignmentPattern, `${match[1]}${block}`);
}

function ensureSummaryFeature(content: string, featureLabel: string): string {
  const summaryPattern = /const enabledFeatures = \[([^\]]*)\];/;
  const match = content.match(summaryPattern);
  if (!match) {
    throw new Error(
      "Could not update src/index file: expected enabledFeatures array in getSummary().",
    );
  }

  const entries = match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (!entries.includes(featureLabel)) {
    entries.push(featureLabel);
  }

  return content.replace(
    match[0],
    `const enabledFeatures = [${entries.join(", ")}];`,
  );
}

function ensureRunSnippet(content: string, snippet: string): string {
  if (content.includes(snippet.trim())) {
    return content;
  }

  const marker = "    console.log('Implement your agent workflow here.');";
  if (!content.includes(marker)) {
    throw new Error(
      "Could not update src/index file: expected generated run() implementation marker.",
    );
  }

  return content.replace(marker, `${snippet}\n${marker}`);
}

async function ensureMemoryScaffold(
  projectDir: string,
  extension: "ts" | "js",
): Promise<string | null> {
  const memoryPath = path.join(
    projectDir,
    "src",
    "memory",
    `index.${extension}`,
  );
  if (await fs.pathExists(memoryPath)) {
    return null;
  }

  const content =
    extension === "ts"
      ? `export interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface MemoryStore {
  remember(input: { content: string; tags?: string[] }): Promise<MemoryEntry>;
  recall(tag?: string): Promise<MemoryEntry[]>;
}

export class LocalMemoryStore implements MemoryStore {
  private entries: MemoryEntry[] = [];

  async remember(input: { content: string; tags?: string[] }): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: \`memory-\${this.entries.length + 1}\`,
      content: input.content,
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
    };

    this.entries.push(entry);
    return entry;
  }

  async recall(tag?: string): Promise<MemoryEntry[]> {
    if (!tag) {
      return [...this.entries];
    }

    return this.entries.filter((entry) => entry.tags.includes(tag));
  }
}

export function createMemoryStore(): MemoryStore {
  return new LocalMemoryStore();
}
`
      : `export class LocalMemoryStore {
  constructor() {
    this.entries = [];
  }

  async remember(input) {
    const entry = {
      id: \`memory-\${this.entries.length + 1}\`,
      content: input.content,
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
    };

    this.entries.push(entry);
    return entry;
  }

  async recall(tag) {
    if (!tag) {
      return [...this.entries];
    }

    return this.entries.filter((entry) => entry.tags.includes(tag));
  }
}

export function createMemoryStore() {
  return new LocalMemoryStore();
}
`;

  await fs.ensureDir(path.dirname(memoryPath));
  await fs.writeFile(memoryPath, content, "utf8");
  return memoryPath;
}

async function ensureSkillsScaffold(
  projectDir: string,
  extension: "ts" | "js",
): Promise<string[]> {
  const created: string[] = [];
  const loaderPath = path.join(
    projectDir,
    "src",
    "skills",
    `loader.${extension}`,
  );
  const examplePath = path.join(
    projectDir,
    "src",
    "skills",
    `example.${extension}`,
  );
  const markdownPath = path.join(
    projectDir,
    "src",
    "skills",
    "example",
    "SKILL.md",
  );

  await fs.ensureDir(path.dirname(markdownPath));

  if (!(await fs.pathExists(loaderPath))) {
    const loaderContent =
      extension === "ts"
        ? `export interface Skill {
  name: string;
  description: string;
  run(input: string): Promise<string>;
}

import { exampleSkill } from "./example.js";

export function loadSkills(): Skill[] {
  return [exampleSkill];
}
`
        : `import { exampleSkill } from "./example.js";

export function loadSkills() {
  return [exampleSkill];
}
`;

    await fs.writeFile(loaderPath, loaderContent, "utf8");
    created.push(loaderPath);
  }

  if (!(await fs.pathExists(examplePath))) {
    const exampleContent =
      extension === "ts"
        ? `import type { Skill } from "./loader.js";

export const exampleSkill: Skill = {
  name: "summarize-context",
  description: "A minimal example skill that transforms a short input string.",
  async run(input: string): Promise<string> {
    return \`Example skill received: \${input}\`;
  },
};
`
        : `export const exampleSkill = {
  name: "summarize-context",
  description: "A minimal example skill that transforms a short input string.",
  async run(input) {
    return \`Example skill received: \${input}\`;
  },
};
`;

    await fs.writeFile(examplePath, exampleContent, "utf8");
    created.push(examplePath);
  }

  if (!(await fs.pathExists(markdownPath))) {
    const markdownContent = `# Example Skill

## Name

summarize-context

## Purpose

Demonstrates how a skill can describe its input, output and expected behaviour.

## Input

- A short string that represents the current context.

## Output

- A short confirmation string that can be used in tests or smoke runs.
`;
    await fs.writeFile(markdownPath, markdownContent, "utf8");
    created.push(markdownPath);
  }

  return created;
}

async function ensureEnvBlock(
  projectDir: string,
  lines: string[],
): Promise<boolean> {
  const envPath = path.join(projectDir, ".env.example");
  const existing = (await fs.pathExists(envPath))
    ? await fs.readFile(envPath, "utf8")
    : "";

  let next = existing;
  let changed = false;

  for (const line of lines) {
    if (!next.includes(line)) {
      next = `${next.trimEnd()}\n${line}\n`;
      changed = true;
    }
  }

  if (changed) {
    await fs.writeFile(envPath, next, "utf8");
  }

  return changed;
}

async function ensureTriologueDependency(projectDir: string): Promise<boolean> {
  const packagePath = path.join(projectDir, "package.json");
  if (!(await fs.pathExists(packagePath))) {
    throw new Error("Could not find package.json in the current directory.");
  }

  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8")) as {
    dependencies?: Record<string, string>;
  };

  packageJson.dependencies ??= {};
  if (packageJson.dependencies["triologue-sdk"]) {
    return false;
  }

  packageJson.dependencies["triologue-sdk"] = "^0.1.0";
  await fs.writeFile(
    packagePath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
  return true;
}

export async function addFeatureToProject(
  options: AddFeatureOptions,
): Promise<AddFeatureResult> {
  const feature = assertFeatureName(options.feature);
  const { extension } = detectLanguage(options.projectDir);
  const indexPath = path.join(options.projectDir, "src", `index.${extension}`);

  if (!(await fs.pathExists(indexPath))) {
    throw new Error(`Could not find ${indexPath}.`);
  }

  let indexContent = await fs.readFile(indexPath, "utf8");
  const originalIndexContent = indexContent;
  const createdFiles: string[] = [];
  const updatedFiles: string[] = [];

  if (feature === "memory") {
    const createdMemory = await ensureMemoryScaffold(
      options.projectDir,
      extension,
    );
    if (createdMemory) {
      createdFiles.push(createdMemory);
    }

    indexContent = ensureImport(
      indexContent,
      "import { createMemoryStore } from './memory/index.js';",
    );
    indexContent = ensureClassField(
      indexContent,
      extension === "ts" ? "  private name: string;" : "  name;",
      extension === "ts"
        ? "  private memory = createMemoryStore();"
        : "  memory = createMemoryStore();",
    );
    indexContent = ensureSummaryFeature(indexContent, "'memory'");
    indexContent = ensureRunSnippet(
      indexContent,
      `    await this.memory.remember({
      content: 'Agent boot sequence completed',
      tags: ['system'],
    });`,
    );

    if (await ensureEnvBlock(options.projectDir, ["MEMORY_BACKEND=local"])) {
      updatedFiles.push(path.join(options.projectDir, ".env.example"));
    }
  }

  if (feature === "skills") {
    createdFiles.push(
      ...(await ensureSkillsScaffold(options.projectDir, extension)),
    );

    indexContent = ensureImport(
      indexContent,
      extension === "ts"
        ? "import { loadSkills, type Skill } from './skills/loader.js';"
        : "import { loadSkills } from './skills/loader.js';",
    );
    indexContent = ensureClassField(
      indexContent,
      extension === "ts" ? "  private name: string;" : "  name;",
      extension === "ts"
        ? "  private skills: Skill[] = loadSkills();"
        : "  skills = loadSkills();",
    );
    indexContent = ensureSummaryFeature(indexContent, "'skills'");
    indexContent = ensureRunSnippet(
      indexContent,
      `    if (this.skills.length > 0) {
      const preview = await this.skills[0].run('boot');
      console.log(\`Loaded \${this.skills.length} skill(s). Example output: \${preview}\`);
    }`,
    );
  }

  if (feature === "triologue") {
    indexContent = ensureImport(
      indexContent,
      "import { Triologue } from 'triologue-sdk';",
    );
    indexContent = ensureClassField(
      indexContent,
      extension === "ts" ? "  private name: string;" : "  name;",
      extension === "ts" ? "  private triologue?: Triologue;" : "  triologue;",
    );
    indexContent = ensureConstructorTriologue(indexContent);
    indexContent = ensureSummaryFeature(indexContent, "'triologue'");
    indexContent = ensureRunSnippet(
      indexContent,
      `    if (this.triologue) {
      console.log('Triologue client configured.');
    }`,
    );

    if (await ensureTriologueDependency(options.projectDir)) {
      updatedFiles.push(path.join(options.projectDir, "package.json"));
    }

    if (
      await ensureEnvBlock(options.projectDir, [
        "BYOA_TOKEN=your-token-here",
        "TRIOLOGUE_URL=https://opentriologue.ai",
      ])
    ) {
      updatedFiles.push(path.join(options.projectDir, ".env.example"));
    }
  }

  if (indexContent !== originalIndexContent) {
    await fs.writeFile(indexPath, indexContent, "utf8");
    updatedFiles.push(indexPath);
  }

  return {
    feature,
    createdFiles,
    updatedFiles,
    alreadyPresent: createdFiles.length === 0 && updatedFiles.length === 0,
  };
}

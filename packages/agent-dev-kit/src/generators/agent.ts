import path from "path";
import Handlebars from "handlebars";
import type {
  AgentConfig,
  TemplateContext,
  GeneratorOptions,
} from "../types.js";
import { FileUtils } from "../utils/files.js";

export class AgentGenerator {
  private config: AgentConfig;
  private targetDir: string;
  private verbose: boolean;

  constructor(options: GeneratorOptions) {
    this.config = options.config;
    this.targetDir = options.targetDir;
    this.verbose = options.verbose || false;
  }

  /**
   * Generate template context from config
   */
  private getTemplateContext(): TemplateContext {
    const sourceEntry = this.getSourceEntryPath();
    const testEntry = this.getTestEntryPath();
    const capabilities = ["Core runtime"];

    if (this.config.features.memory) {
      capabilities.push("Memory");
    }

    if (this.config.features.triologue) {
      capabilities.push("Triologue");
    }

    if (this.config.features.skills) {
      capabilities.push("Skills");
    }

    return {
      agentName: this.config.name,
      agentRole: this.config.description || "AI Agent",
      capabilities: capabilities.join(", "),
      hasMemory: this.config.features.memory,
      hasTriologue: this.config.features.triologue,
      hasSkills: this.config.features.skills,
      hasTypeScript: this.config.options.typescript,
      languageName: this.config.options.typescript
        ? "TypeScript"
        : "JavaScript",
      sourceEntry,
      testEntry,
      memoryBackend: "local",
      date: new Date().toISOString().split("T")[0],
    };
  }

  private getExtension(): "ts" | "js" {
    return this.config.options.typescript ? "ts" : "js";
  }

  private getSourceEntryPath(): string {
    return `src/index.${this.getExtension()}`;
  }

  private getTestEntryPath(): string {
    return `src/index.test.${this.getExtension()}`;
  }

  private getSkillLoaderPath(): string {
    return `src/skills/loader.${this.getExtension()}`;
  }

  private getMemoryModulePath(): string {
    return `src/memory/index.${this.getExtension()}`;
  }

  /**
   * Log message if verbose
   */
  private log(message: string): void {
    if (this.verbose) {
      console.log(message);
    }
  }

  /**
   * Generate .ai/ context files
   */
  private async generateAiContext(): Promise<void> {
    this.log("Generating .ai/ context files...");

    const context = this.getTemplateContext();
    const aiDir = path.join(this.targetDir, ".ai");
    await FileUtils.ensureDir(aiDir);

    const contextFiles = [
      "AGENTS.md",
      "ARCHITECTURE.md",
      "TASKS.md",
      "DECISIONS.md",
    ];

    for (const file of contextFiles) {
      const templateContent = await FileUtils.readTemplate(
        `ai-context/${file}.hbs`,
      );
      const template = Handlebars.compile(templateContent);
      const content = template(context);

      await FileUtils.writeFile(path.join(aiDir, file), content);
      this.log(`  ✓ ${file}`);
    }
  }

  /**
   * Generate package.json
   */
  private async generatePackageJson(): Promise<void> {
    this.log("Generating package.json...");

    const packageJson = {
      name: this.config.name,
      version: "1.0.0",
      description: this.config.description || "AI Agent",
      main: this.config.options.typescript ? "dist/index.js" : "src/index.js",
      type: "module",
      scripts: this.getScripts(),
      keywords: ["ai", "agent"],
      author: this.config.metadata?.author || "",
      license: this.config.metadata?.license || "MIT",
      dependencies: this.getDependencies(),
      devDependencies: this.getDevDependencies(),
    };

    await FileUtils.writeFile(
      path.join(this.targetDir, "package.json"),
      JSON.stringify(packageJson, null, 2),
    );
    this.log("  ✓ package.json");
  }

  private getScripts(): Record<string, string> {
    if (this.config.options.typescript) {
      return {
        build: "tsc",
        dev: "node --import tsx --watch src/index.ts",
        start: "node dist/index.js",
        test: "vitest run",
      };
    }

    return {
      dev: "node --watch src/index.js",
      start: "node src/index.js",
      test: "vitest run",
    };
  }

  private getDevDependencies(): Record<string, string> {
    if (this.config.options.typescript) {
      return {
        "@types/node": "^20.11.0",
        tsx: "^4.19.3",
        typescript: "^5.3.3",
        vitest: "^3.2.4",
      };
    }

    return {
      vitest: "^3.2.4",
    };
  }

  /**
   * Get dependencies based on features
   */
  private getDependencies(): Record<string, string> {
    const deps: Record<string, string> = {
      dotenv: "^16.4.0",
    };

    if (this.config.features.triologue) {
      deps["triologue-sdk"] = "^0.1.0";
    }

    return deps;
  }

  /**
   * Generate TypeScript config
   */
  private async generateTsConfig(): Promise<void> {
    if (!this.config.options.typescript) return;

    this.log("Generating tsconfig.json...");

    const tsConfig = {
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "node",
        outDir: "./dist",
        rootDir: "./src",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
      },
      include: ["src/**/*"],
      exclude: ["node_modules", "dist"],
    };

    await FileUtils.writeFile(
      path.join(this.targetDir, "tsconfig.json"),
      JSON.stringify(tsConfig, null, 2),
    );
    this.log("  ✓ tsconfig.json");
  }

  /**
   * Generate .gitignore
   */
  private async generateGitignore(): Promise<void> {
    this.log("Generating .gitignore...");

    const content = `node_modules/
${this.config.options.typescript ? "dist/\n" : ""}*.log
.env
.env.local
.DS_Store
`;

    await FileUtils.writeFile(path.join(this.targetDir, ".gitignore"), content);
    this.log("  ✓ .gitignore");
  }

  /**
   * Generate .env.example
   */
  private async generateEnvExample(): Promise<void> {
    this.log("Generating .env.example...");

    let content = `# Agent Configuration
AGENT_NAME=${this.config.name}
NODE_ENV=development
`;

    if (this.config.features.triologue) {
      content += `\n# Triologue
BYOA_TOKEN=your-token-here
TRIOLOGUE_URL=https://opentriologue.ai
`;
    }

    if (this.config.features.memory) {
      content += `\n# Memory
MEMORY_BACKEND=local
`;
    }

    await FileUtils.writeFile(
      path.join(this.targetDir, ".env.example"),
      content,
    );
    this.log("  ✓ .env.example");
  }

  /**
   * Generate README
   */
  private async generateReadme(): Promise<void> {
    this.log("Generating README.md...");

    const sourceEntry = this.getSourceEntryPath();
    const testEntry = this.getTestEntryPath();
    const memoryPath = this.getMemoryModulePath();
    const skillLoaderPath = this.getSkillLoaderPath();

    const features = [
      "- Core runtime scaffold",
      this.config.features.memory
        ? `- Local memory scaffold in \`${memoryPath}\``
        : null,
      this.config.features.triologue
        ? `- Triologue client wiring in \`${sourceEntry}\``
        : null,
      this.config.features.skills
        ? `- Skills loader and example skill in \`${skillLoaderPath}\``
        : null,
    ]
      .filter((value): value is string => value !== null)
      .join("\n");

    const generatedFiles = [
      `- \`${sourceEntry}\` - main agent entrypoint`,
      `- \`${testEntry}\` - smoke test for the generated agent`,
      this.config.features.memory
        ? `- \`${memoryPath}\` - local in-memory stub implementation`
        : null,
      this.config.features.skills
        ? `- \`${skillLoaderPath}\` - example skills loader`
        : null,
      this.config.features.skills
        ? `- \`src/skills/example/SKILL.md\` - skill prompt template`
        : null,
      "- `.ai/` - project context for humans and agents",
    ]
      .filter((value): value is string => value !== null)
      .join("\n");

    const setupStep = this.config.options.typescript
      ? "4. Build and run:\n~~~bash\nnpm run build\nnpm start\n~~~"
      : "4. Run the agent:\n~~~bash\nnpm start\n~~~";

    const content = `# ${this.config.name}

${this.config.description || "AI Agent"}

## Features

${features}

## Generated Files

${generatedFiles}

## Setup

1. Install dependencies:
~~~bash
npm install
~~~

2. Configure environment:
~~~bash
cp .env.example .env
~~~

3. Run the default test suite:
~~~bash
npm test
~~~

${setupStep}

## Development

~~~bash
npm run dev
~~~

## Notes

${this.config.features.memory ? "- The memory scaffold uses a local in-process store so the project works without extra services.\n" : ""}${this.config.features.skills ? "- The bundled example skill is intended as a starting point for your own SKILL.md-based workflows.\n" : ""}${this.config.features.triologue ? "- Set `BYOA_TOKEN` in `.env` before enabling live Triologue calls.\n" : ""}See [\`.ai/ARCHITECTURE.md\`](.ai/ARCHITECTURE.md) for the generated project overview.

## License

${this.config.metadata?.license || "MIT"}
`;

    await FileUtils.writeFile(path.join(this.targetDir, "README.md"), content);
    this.log("  ✓ README.md");
  }

  /**
   * Generate main agent file
   */
  private async generateMainFile(): Promise<void> {
    this.log("Generating main agent file...");

    const ext = this.getExtension();
    const srcDir = path.join(this.targetDir, "src");
    await FileUtils.ensureDir(srcDir);

    const content = this.buildMainFileContent();

    await FileUtils.writeFile(path.join(srcDir, `index.${ext}`), content);
    this.log(`  ✓ src/index.${ext}`);
  }

  private buildMainFileContent(): string {
    const isTypeScript = this.config.options.typescript;
    const imports = [
      isTypeScript
        ? "import { config } from 'dotenv';"
        : "import dotenv from 'dotenv';",
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
    ];

    if (this.config.features.memory) {
      imports.push("import { createMemoryStore } from './memory/index.js';");
    }

    if (this.config.features.skills) {
      imports.push(
        "import { loadSkills" +
          (isTypeScript ? ", type Skill" : "") +
          " } from './skills/loader.js';",
      );
    }

    if (this.config.features.triologue) {
      imports.push("import { Triologue } from 'triologue-sdk';");
    }

    const classFields = isTypeScript
      ? [
          "  private name: string;",
          this.config.features.memory
            ? "  private memory = createMemoryStore();"
            : "",
          this.config.features.skills
            ? "  private skills: Skill[] = loadSkills();"
            : "",
          this.config.features.triologue
            ? "  private triologue?: Triologue;"
            : "",
        ]
          .filter((line) => line !== "")
          .join("\n")
      : [
          "  name;",
          this.config.features.memory ? "  memory = createMemoryStore();" : "",
          this.config.features.skills ? "  skills = loadSkills();" : "",
          this.config.features.triologue ? "  triologue;" : "",
        ]
          .filter((line) => line !== "")
          .join("\n");

    const constructorLines = [
      `    this.name = process.env.AGENT_NAME || '${this.config.name}';`,
      this.config.features.triologue
        ? `    if (process.env.BYOA_TOKEN) {
      this.triologue = new Triologue({
        baseUrl: process.env.TRIOLOGUE_URL || 'https://opentriologue.ai',
        token: process.env.BYOA_TOKEN,
      });
    }`
        : "",
    ]
      .filter((line) => line !== "")
      .join("\n");

    const summaryFeatures = [
      "'core runtime'",
      this.config.features.memory ? "'memory'" : "",
      this.config.features.triologue ? "'triologue'" : "",
      this.config.features.skills ? "'skills'" : "",
    ]
      .filter((value) => value !== "")
      .join(", ");

    const runLines = [
      "    console.log(this.getSummary());",
      this.config.features.memory
        ? `    await this.memory.remember({
      content: 'Agent boot sequence completed',
      tags: ['system'],
    });`
        : "",
      this.config.features.skills
        ? `    if (this.skills.length > 0) {
      const preview = await this.skills[0].run('boot');
      console.log(\`Loaded \${this.skills.length} skill(s). Example output: \${preview}\`);
    }`
        : "",
      this.config.features.triologue
        ? `    if (this.triologue) {
      console.log('Triologue client configured.');
    }`
        : "",
      "    console.log('Implement your agent workflow here.');",
    ]
      .filter((line) => line !== "")
      .join("\n");

    return `${imports.join("\n")}

${isTypeScript ? "config();" : "dotenv.config();"}

export class Agent {
${classFields !== "" ? `${classFields}\n` : ""}

  constructor() {
${constructorLines}
  }

  ${isTypeScript ? "getSummary(): string" : "getSummary()"} {
    const enabledFeatures = [${summaryFeatures}];
    return \`\${this.name} ready with \${enabledFeatures.join(', ')}.\`;
  }

  ${isTypeScript ? "async run(): Promise<void>" : "async run()"} {
${runLines}
  }
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  const agent = new Agent();
  agent.run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
`;
  }

  private async generateMemoryScaffold(): Promise<void> {
    if (!this.config.features.memory) {
      return;
    }

    this.log("Generating memory scaffold...");

    const ext = this.getExtension();
    const memoryDir = path.join(this.targetDir, "src", "memory");
    const content = this.config.options.typescript
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

    await FileUtils.writeFile(path.join(memoryDir, `index.${ext}`), content);
    this.log(`  ✓ src/memory/index.${ext}`);
  }

  private async generateSkillsScaffold(): Promise<void> {
    if (!this.config.features.skills) {
      return;
    }

    this.log("Generating skills scaffold...");

    const ext = this.getExtension();
    const skillsDir = path.join(this.targetDir, "src", "skills");
    const loaderContent = this.config.options.typescript
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
    const exampleContent = this.config.options.typescript
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
    const skillMarkdown = `# Example Skill

## Name

summarize-context

## Purpose

Demonstrates how a skill can describe its input, output and expected behaviour.

## Input

- A short string that represents the current context.

## Output

- A short confirmation string that can be used in tests or smoke runs.
`;

    await FileUtils.writeFile(
      path.join(skillsDir, `loader.${ext}`),
      loaderContent,
    );
    await FileUtils.writeFile(
      path.join(skillsDir, `example.${ext}`),
      exampleContent,
    );
    await FileUtils.writeFile(
      path.join(skillsDir, "example", "SKILL.md"),
      skillMarkdown,
    );
    this.log(`  ✓ src/skills/loader.${ext}`);
    this.log(`  ✓ src/skills/example.${ext}`);
    this.log("  ✓ src/skills/example/SKILL.md");
  }

  private async generateTestFile(): Promise<void> {
    this.log("Generating test file...");

    const ext = this.getExtension();
    const testContent = `import { describe, expect, it } from "vitest";
import { Agent } from "./index.js";

describe("Agent", () => {
  it("exposes the generated agent name in its summary", () => {
    const agent = new Agent();

    expect(agent.getSummary()).toContain("${this.config.name}");
  });
});
`;

    await FileUtils.writeFile(
      path.join(this.targetDir, "src", `index.test.${ext}`),
      testContent,
    );
    this.log(`  ✓ src/index.test.${ext}`);
  }

  /**
   * Generate complete agent
   */
  async generate(): Promise<void> {
    console.log(`\nGenerating agent: ${this.config.name}\n`);

    await this.generateAiContext();
    await this.generatePackageJson();
    await this.generateTsConfig();
    await this.generateGitignore();
    await this.generateEnvExample();
    await this.generateReadme();
    await this.generateMemoryScaffold();
    await this.generateSkillsScaffold();
    await this.generateMainFile();
    await this.generateTestFile();

    console.log(`\n✅ Agent generated successfully at: ${this.targetDir}\n`);
  }
}

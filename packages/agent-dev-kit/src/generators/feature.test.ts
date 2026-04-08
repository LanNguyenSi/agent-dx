import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addFeatureToProject } from "./feature.js";
import { AgentGenerator } from "./agent.js";
import type { AgentConfig } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dirPath) => rm(dirPath, { recursive: true, force: true })),
  );
});

describe("addFeatureToProject", () => {
  it("adds memory scaffold and wiring to a TypeScript project", async () => {
    const projectDir = await createGeneratedProject({
      name: "feature-memory",
      description: "feature-memory",
      features: {
        memory: false,
        triologue: false,
        skills: false,
      },
      options: {
        typescript: true,
        git: false,
        install: false,
      },
    });

    const result = await addFeatureToProject({
      projectDir,
      feature: "memory",
    });

    expect(result.feature).toBe("memory");
    expect(result.alreadyPresent).toBe(false);

    const indexContent = await readFile(
      path.join(projectDir, "src/index.ts"),
      "utf8",
    );
    expect(indexContent).toContain(
      "import { createMemoryStore } from './memory/index.js';",
    );
    expect(indexContent).toContain("private memory = createMemoryStore();");
    expect(indexContent).toContain("await this.memory.remember({");
    expect(indexContent).toContain(
      "const enabledFeatures = ['core runtime', 'memory'];",
    );

    const memoryModule = await readFile(
      path.join(projectDir, "src/memory/index.ts"),
      "utf8",
    );
    expect(memoryModule).toContain("export interface MemoryStore");

    const envExample = await readFile(
      path.join(projectDir, ".env.example"),
      "utf8",
    );
    expect(envExample).toContain("MEMORY_BACKEND=local");
  });

  it("adds triologue wiring and dependency to a JavaScript project", async () => {
    const projectDir = await createGeneratedProject({
      name: "feature-triologue",
      description: "feature-triologue",
      features: {
        memory: false,
        triologue: false,
        skills: false,
      },
      options: {
        typescript: false,
        git: false,
        install: false,
      },
    });

    const result = await addFeatureToProject({
      projectDir,
      feature: "triologue",
    });

    expect(result.feature).toBe("triologue");
    expect(result.alreadyPresent).toBe(false);

    const indexContent = await readFile(
      path.join(projectDir, "src/index.js"),
      "utf8",
    );
    expect(indexContent).toContain(
      "import { Triologue } from 'triologue-sdk';",
    );
    expect(indexContent).toContain("triologue;");
    expect(indexContent).toContain("this.triologue = new Triologue({");
    expect(indexContent).toContain(
      "const enabledFeatures = ['core runtime', 'triologue'];",
    );

    const packageJson = JSON.parse(
      await readFile(path.join(projectDir, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(packageJson.dependencies["triologue-sdk"]).toBe("^0.1.0");

    const envExample = await readFile(
      path.join(projectDir, ".env.example"),
      "utf8",
    );
    expect(envExample).toContain("BYOA_TOKEN=your-token-here");
    expect(envExample).toContain("TRIOLOGUE_URL=https://opentriologue.ai");
  });

  it("is idempotent when the same feature is added twice", async () => {
    const projectDir = await createGeneratedProject({
      name: "feature-idempotent",
      description: "feature-idempotent",
      features: {
        memory: false,
        triologue: false,
        skills: false,
      },
      options: {
        typescript: true,
        git: false,
        install: false,
      },
    });

    await addFeatureToProject({
      projectDir,
      feature: "skills",
    });

    const secondRun = await addFeatureToProject({
      projectDir,
      feature: "skills",
    });

    expect(secondRun.alreadyPresent).toBe(true);
  });
});

async function createGeneratedProject(
  overrides: Partial<AgentConfig> & {
    name: string;
    description: string;
  },
): Promise<string> {
  const targetDir = await mkdtemp(
    path.join(os.tmpdir(), "agent-dev-kit-feature-test-"),
  );
  tempDirs.push(targetDir);

  const config: AgentConfig = {
    name: overrides.name,
    description: overrides.description,
    features: overrides.features ?? {
      memory: false,
      triologue: false,
      skills: false,
    },
    options: overrides.options ?? {
      typescript: true,
      git: false,
      install: false,
    },
    metadata: overrides.metadata ?? {
      license: "MIT",
    },
  };

  const generator = new AgentGenerator({
    targetDir,
    config,
    verbose: false,
  });

  await generator.generate();
  return targetDir;
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileUtils } from "./files.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dirPath) => rm(dirPath, { recursive: true, force: true })),
  );
});

describe("FileUtils", () => {
  it("treats a missing directory as empty", async () => {
    const dirPath = path.join(await createTempDir(), "missing-dir");
    await expect(FileUtils.isDirEmpty(dirPath)).resolves.toBe(true);
  });

  it("writes transformed content when copying a file", async () => {
    const dirPath = await createTempDir();
    const sourcePath = path.join(dirPath, "source.txt");
    const destPath = path.join(dirPath, "nested", "dest.txt");

    await writeFile(sourcePath, "hello world\n", "utf8");
    await FileUtils.copyFile(sourcePath, destPath, (content) =>
      content.toUpperCase(),
    );

    await expect(readFile(destPath, "utf8")).resolves.toBe("HELLO WORLD\n");
  });

  it("reads template files from the bundled templates directory", async () => {
    const template = await FileUtils.readTemplate("ai-context/AGENTS.md.hbs");

    expect(template).toContain("# Agent Team");
    expect(template).toContain("{{agentName}}");
  });
});

async function createTempDir(): Promise<string> {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "agent-dev-kit-test-"));
  tempDirs.push(dirPath);
  return dirPath;
}

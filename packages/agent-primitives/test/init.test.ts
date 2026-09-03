import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { init, ALL_HARNESSES } from "../src/init/index.js";
import { init as initFromIndex } from "../src/index.js";
import { UsageError } from "../src/envelope.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-init-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CONTENT_A = "# skill A\n";
const CONTENT_B = "# skill B (different)\n";

describe("init", () => {
  it("is re-exported from the package's index", () => {
    expect(initFromIndex).toBe(init);
  });

  it("writes a fresh file for the default harness (claude)", async () => {
    const dir = makeTmpDir();
    const result = await init({ targetDir: dir, content: CONTENT_A });
    expect(result.status).toBe("written");
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.harness).toBe("claude");
    const filePath = path.join(
      dir,
      ".claude",
      "skills",
      "agent-primitives",
      "SKILL.md",
    );
    expect(result.targets[0]?.path).toBe(filePath);
    expect(fs.readFileSync(filePath, "utf8")).toBe(CONTENT_A);
  });

  it("reports unchanged when the existing content is byte-identical", async () => {
    const dir = makeTmpDir();
    await init({ targetDir: dir, content: CONTENT_A });
    const result = await init({ targetDir: dir, content: CONTENT_A });
    expect(result.status).toBe("unchanged");
    expect(result.targets[0]?.status).toBe("unchanged");
  });

  it("reports conflicted, and leaves the file untouched, when the content differs", async () => {
    const dir = makeTmpDir();
    await init({ targetDir: dir, content: CONTENT_A });
    const result = await init({ targetDir: dir, content: CONTENT_B });
    expect(result.status).toBe("conflicted");
    expect(result.targets[0]?.status).toBe("conflicted");
    const filePath = path.join(
      dir,
      ".claude",
      "skills",
      "agent-primitives",
      "SKILL.md",
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(CONTENT_A);
  });

  it("overwrites and reports written when --force resolves a conflict", async () => {
    const dir = makeTmpDir();
    await init({ targetDir: dir, content: CONTENT_A });
    await init({ targetDir: dir, content: CONTENT_B }); // conflicted, untouched
    const result = await init({
      targetDir: dir,
      content: CONTENT_B,
      force: true,
    });
    expect(result.status).toBe("written");
    const filePath = path.join(
      dir,
      ".claude",
      "skills",
      "agent-primitives",
      "SKILL.md",
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(CONTENT_B);
  });

  it("writes every requested harness to its own path, and never under .claude/agents", async () => {
    const dir = makeTmpDir();
    const result = await init({
      targetDir: dir,
      content: CONTENT_A,
      harnesses: [...ALL_HARNESSES],
    });
    expect(result.status).toBe("written");
    expect(result.targets).toHaveLength(3);
    expect(
      fs.readFileSync(
        path.join(dir, ".claude", "skills", "agent-primitives", "SKILL.md"),
        "utf8",
      ),
    ).toBe(CONTENT_A);
    expect(
      fs.readFileSync(
        path.join(dir, ".agents", "skills", "agent-primitives", "SKILL.md"),
        "utf8",
      ),
    ).toBe(CONTENT_A);
    expect(
      fs.readFileSync(
        path.join(dir, ".opencode", "skills", "agent-primitives", "SKILL.md"),
        "utf8",
      ),
    ).toBe(CONTENT_A);
    expect(fs.existsSync(path.join(dir, ".claude", "agents"))).toBe(false);
  });

  it("aggregates to conflicted when any one of several harnesses conflicts", async () => {
    const dir = makeTmpDir();
    await init({ targetDir: dir, content: CONTENT_A, harnesses: ["claude"] });
    const result = await init({
      targetDir: dir,
      content: CONTENT_B,
      harnesses: [...ALL_HARNESSES],
    });
    expect(result.status).toBe("conflicted");
    const claudeTarget = result.targets.find((t) => t.harness === "claude");
    const codexTarget = result.targets.find((t) => t.harness === "codex");
    expect(claudeTarget?.status).toBe("conflicted");
    expect(codexTarget?.status).toBe("written");
  });

  it("refuses a target that resolves outside targetDir via a pre-existing symlink", async () => {
    const dir = makeTmpDir();
    const outside = makeTmpDir();
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, ".claude", "skills"));
    await expect(
      init({ targetDir: dir, content: CONTENT_A }),
    ).rejects.toThrow(UsageError);
    expect(
      fs.existsSync(path.join(outside, "agent-primitives", "SKILL.md")),
    ).toBe(false);
  });

  it("defaults to the packaged assets/skill/SKILL.md when no content override is given", async () => {
    const dir = makeTmpDir();
    const result = await init({ targetDir: dir });
    expect(result.status).toBe("written");
    const written = fs.readFileSync(result.targets[0]!.path, "utf8");
    expect(written).toMatch(/^---\nname: agent-primitives\n/);
  });
});

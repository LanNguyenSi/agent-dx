import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ASSETS_DIR,
  isSafeSkillReferenceEntry,
  listSkillReferenceNames,
} from "../src/assets.js";
import { runInit } from "../src/init.js";
import { DEFAULT_MODELS } from "../src/models.js";
import { runUninstall } from "../src/uninstall.js";

let target: string;

beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), "orchestrator-skill-references-"));
});

afterEach(() => {
  rmSync(target, { recursive: true, force: true });
});

const allHarnesses = ["claude", "codex", "opencode"] as const;
const skillDirs = [
  ".claude/skills/orchestrator-workflow",
  ".agents/skills/orchestrator-workflow",
  ".opencode/skills/orchestrator-workflow",
];
const sha256 = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

function initAll() {
  return runInit({
    targetDir: target,
    harnesses: [...allHarnesses],
    models: { ...DEFAULT_MODELS },
  });
}

function initClaude(force = false) {
  return runInit({
    targetDir: target,
    harnesses: ["claude"],
    models: { ...DEFAULT_MODELS },
    force,
  });
}

function sourceReference(name: string): string {
  return readFileSync(join(ASSETS_DIR, "skill", "references", name), "utf8");
}

describe("packaged skill references", () => {
  it("filters source entries to safe, flat regular markdown files", () => {
    const entry = (name: string, file: boolean, symlink = false) => ({
      name,
      isFile: () => file,
      isSymbolicLink: () => symlink,
    });

    expect(isSafeSkillReferenceEntry(entry("valid-reference.md", true))).toBe(
      true,
    );
    expect(isSafeSkillReferenceEntry(entry("../escape.md", true))).toBe(false);
    expect(isSafeSkillReferenceEntry(entry("notes.txt", true))).toBe(false);
    expect(isSafeSkillReferenceEntry(entry("directory.md", false))).toBe(false);
    expect(isSafeSkillReferenceEntry(entry("linked.md", true, true))).toBe(
      false,
    );
  });

  it("installs and tracks every packaged reference for every supported harness", () => {
    initAll();
    const references = listSkillReferenceNames();
    expect(references).toEqual([
      "contracts.md",
      "evidence-and-probes.md",
      "review-and-recovery.md",
      "run-state-and-harness.md",
    ]);

    const manifest = JSON.parse(
      readFileSync(join(target, ".ai", "workflow", "manifest.json"), "utf8"),
    ) as { files: Record<string, string> };
    for (const skillDir of skillDirs) {
      for (const reference of references) {
        const relativePath = join(skillDir, "references", reference);
        const installedPath = join(target, relativePath);
        expect(readFileSync(installedPath, "utf8")).toBe(
          sourceReference(reference),
        );
        expect(manifest.files[relativePath]).toBe(
          sha256(sourceReference(reference)),
        );
      }
    }
  });

  it("updates unedited references from the hash ledger", () => {
    initAll();
    const reference = listSkillReferenceNames()[0];
    const oldContent = "# Old packaged reference\n";
    const manifestPath = join(target, ".ai", "workflow", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: Record<string, string>;
    };

    for (const skillDir of skillDirs) {
      const relativePath = join(skillDir, "references", reference);
      writeFileSync(join(target, relativePath), oldContent);
      manifest.files[relativePath] = sha256(oldContent);
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const report = initAll();
    for (const skillDir of skillDirs) {
      const installedPath = join(target, skillDir, "references", reference);
      expect(report.updated).toContain(installedPath);
      expect(readFileSync(installedPath, "utf8")).toBe(
        sourceReference(reference),
      );
    }
  });

  it("keeps an old core active when an unrecorded required reference conflicts", () => {
    initClaude();
    const skillDir = skillDirs[0];
    const coreRelativePath = join(skillDir, "SKILL.md");
    const corePath = join(target, coreRelativePath);
    const oldCore = "# Old core\n";
    const conflictReference = "contracts.md";
    const conflictPath = join(
      target,
      skillDir,
      "references",
      conflictReference,
    );
    const manifestPath = join(target, ".ai", "workflow", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: Record<string, string>;
    };
    writeFileSync(corePath, oldCore);
    manifest.files[coreRelativePath] = sha256(oldCore);
    for (const reference of listSkillReferenceNames()) {
      delete manifest.files[join(skillDir, "references", reference)];
    }
    writeFileSync(conflictPath, "# User contract override\n");
    const beforeReferences = new Map(
      listSkillReferenceNames().map((reference) => [
        reference,
        readFileSync(join(target, skillDir, "references", reference), "utf8"),
      ]),
    );
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const report = initClaude();

    expect(report.conflicted).toContain(conflictPath);
    expect(readFileSync(corePath, "utf8")).toBe(oldCore);
    for (const [reference, content] of beforeReferences) {
      expect(
        readFileSync(join(target, skillDir, "references", reference), "utf8"),
      ).toBe(content);
    }
    const after = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: Record<string, string>;
    };
    expect(after.files[coreRelativePath]).toBe(sha256(oldCore));

    initClaude(true);
    expect(readFileSync(corePath, "utf8")).toBe(
      readFileSync(join(ASSETS_DIR, "skill", "SKILL.md"), "utf8"),
    );
    expect(readFileSync(conflictPath, "utf8")).toBe(
      sourceReference(conflictReference),
    );
  });

  it("blocks a core update when a tracked reference was locally changed", () => {
    initClaude();
    const skillDir = skillDirs[0];
    const coreRelativePath = join(skillDir, "SKILL.md");
    const corePath = join(target, coreRelativePath);
    const oldCore = "# Old core\n";
    const conflictPath = join(target, skillDir, "references", "contracts.md");
    const manifestPath = join(target, ".ai", "workflow", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: Record<string, string>;
    };
    writeFileSync(corePath, oldCore);
    manifest.files[coreRelativePath] = sha256(oldCore);
    writeFileSync(conflictPath, "# Locally changed tracked reference\n");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const report = initClaude();

    expect(report.conflicted).toContain(conflictPath);
    expect(readFileSync(corePath, "utf8")).toBe(oldCore);
    expect(readFileSync(conflictPath, "utf8")).toBe(
      "# Locally changed tracked reference\n",
    );
  });

  it("notes a previously tracked reference that is no longer shipped", () => {
    initClaude();
    const skillDir = skillDirs[0];
    const retiredRelativePath = join(
      skillDir,
      "references",
      "retired-reference.md",
    );
    const retiredPath = join(target, retiredRelativePath);
    const retiredContent = "# Retired reference\n";
    const manifestPath = join(target, ".ai", "workflow", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: Record<string, string>;
    };
    writeFileSync(retiredPath, retiredContent);
    manifest.files[retiredRelativePath] = sha256(retiredContent);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const report = initClaude();

    expect(report.notes.join("\n")).toContain(
      `${retiredRelativePath}: now untracked because this packaged skill reference is no longer shipped`,
    );
    expect(readFileSync(retiredPath, "utf8")).toBe(retiredContent);
  });

  it("prunes reference and skill directories after an unedited uninstall", () => {
    initAll();

    runUninstall({ targetDir: target });

    for (const skillDir of skillDirs) {
      expect(existsSync(join(target, skillDir, "references"))).toBe(false);
      expect(existsSync(join(target, skillDir))).toBe(false);
    }
  });

  it("keeps locally edited references protected on update and uninstall", () => {
    initAll();
    const reference = listSkillReferenceNames()[0];
    const localContent = "# Local reference edit\n";
    const editedPaths = skillDirs.map((skillDir) =>
      join(target, skillDir, "references", reference),
    );
    for (const path of editedPaths) writeFileSync(path, localContent);

    const update = initAll();
    for (const path of editedPaths) {
      expect(update.conflicted).toContain(path);
      expect(readFileSync(path, "utf8")).toBe(localContent);
    }

    const uninstall = runUninstall({ targetDir: target });
    for (const path of editedPaths) {
      expect(uninstall.kept).toContain(path);
      expect(readFileSync(path, "utf8")).toBe(localContent);
    }
    for (const skillDir of skillDirs) {
      for (const otherReference of listSkillReferenceNames()) {
        if (otherReference === reference) continue;
        expect(
          existsSync(join(target, skillDir, "references", otherReference)),
        ).toBe(false);
      }
    }
  });

  it("does not install references in templates-only harness-none mode", () => {
    runInit({
      targetDir: target,
      harnesses: [],
      models: { ...DEFAULT_MODELS },
    });

    for (const skillDir of skillDirs) {
      expect(existsSync(join(target, skillDir, "references"))).toBe(false);
    }
  });
});

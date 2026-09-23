import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readSkillLedger } from "../src/init/ledger.js";
import { compareSemver, ledgerEntryForTag } from "./helpers/ledger-tag.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(packageRoot, "..", "..");
const tmpDirs: string[] = [];

// 0.1.0 was published before this package started creating release tags. A
// pending entry is permitted separately below only when it is after the
// package's current version; the released allowlist must stay explicit.
const UNTAGGED_RELEASE_ALLOWLIST = ["0.1.0"];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-ledger-"),
  );
  tmpDirs.push(dir);
  return dir;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function isShallowCheckout(): boolean {
  return git(["rev-parse", "--is-shallow-repository"]).trim() === "true";
}

function currentPackageVersion(): string {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as { version: string };
  return packageJson.version;
}

function releasedTags(): string[] {
  return git(["tag", "--merged", "HEAD", "--list", "agent-primitives/v*"])
    .split("\n")
    .filter(Boolean)
    .sort();
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("skill ledger release coverage", () => {
  it("the packed package reports a real earlier skill asset as outdated without changing it", (t) => {
    const olderTag = "agent-primitives/v0.4.0";
    if (!releasedTags().includes(olderTag)) {
      t.skip(true, `packed-install smoke needs ${olderTag} in this checkout`);
      return;
    }

    const workspaceCommander = path.join(
      packageRoot,
      "node_modules",
      "commander",
    );
    if (!fs.existsSync(workspaceCommander)) {
      t.skip(
        true,
        "packed-install smoke needs workspace node_modules/commander",
      );
      return;
    }

    const oldAsset = git([
      "show",
      `${olderTag}:packages/agent-primitives/assets/skill/SKILL.md`,
    ]);
    const root = makeTmpDir();
    const packDir = path.join(root, "pack");
    const scratch = path.join(root, "scratch");
    const targetDir = path.join(root, "target");
    fs.mkdirSync(packDir);
    fs.mkdirSync(scratch);
    fs.mkdirSync(path.join(scratch, "node_modules"));
    // Pre-seed the only runtime dependency from this workspace so installing
    // the tarball is genuinely offline and does not depend on npm's cache.
    fs.cpSync(
      workspaceCommander,
      path.join(scratch, "node_modules", "commander"),
      {
        recursive: true,
      },
    );
    fs.writeFileSync(
      path.join(scratch, "package.json"),
      JSON.stringify({ name: "agent-primitives-offline-smoke", private: true }),
    );

    const packed = spawnSync(
      "npm",
      ["pack", "--offline", "--pack-destination", packDir, "--json"],
      { cwd: packageRoot, encoding: "utf8" },
    );
    expect(packed.status, packed.stderr).toBe(0);
    const [{ filename }] = JSON.parse(packed.stdout) as Array<{
      filename: string;
    }>;
    const tarball = path.join(packDir, filename);

    const installed = spawnSync(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      { cwd: scratch, encoding: "utf8" },
    );
    expect(installed.status, installed.stderr).toBe(0);

    const target = path.join(
      targetDir,
      ".claude",
      "skills",
      "agent-primitives",
      "SKILL.md",
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, oldAsset);
    const installedCli = path.join(
      scratch,
      "node_modules",
      "agent-primitives",
      "dist",
      "cli.js",
    );
    const init = spawnSync(
      process.execPath,
      [installedCli, "init", "-t", targetDir],
      {
        encoding: "utf8",
      },
    );

    expect(init.status, init.stderr).toBe(1);
    const envelope = JSON.parse(init.stdout) as {
      status: string;
      targets: Array<{ status: string; matchedVersion?: string }>;
    };
    expect(envelope.status).toBe("outdated");
    expect(envelope.targets).toEqual([
      expect.objectContaining({ status: "outdated", matchedVersion: "0.4.0" }),
    ]);
    expect(fs.readFileSync(target, "utf8")).toBe(oldAsset);
  }, 30000);

  it("matches every reachable release tag and allows only documented untagged entries", (t) => {
    // A shallow clone (Actions' default checkout, fetch-depth 1) reaches at
    // most the checked-out tag, so every earlier tagged release would read
    // as an untagged ledger entry. Locally that skips; on GitHub Actions,
    // where every checkout running this suite fetches full history, a
    // shallow checkout means the guard was lost, so it fails instead.
    if (isShallowCheckout()) {
      expect(
        process.env.GITHUB_ACTIONS,
        "release-tag coverage needs full history and tags on GitHub Actions (checkout fetch-depth: 0)",
      ).not.toBe("true");
      t.skip(
        true,
        "release-tag coverage needs full history and tags; this checkout is shallow",
      );
      return;
    }
    const tags = releasedTags();
    if (tags.length === 0) {
      t.skip(
        true,
        "release-tag coverage needs reachable agent-primitives/v* tags",
      );
      return;
    }
    const ledger = readSkillLedger();
    const entries = new Map(ledger.map((entry) => [entry.version, entry]));

    for (const version of UNTAGGED_RELEASE_ALLOWLIST) {
      expect(
        entries.has(version),
        `untagged allowlist version ${version} has no ledger entry`,
      ).toBe(true);
    }

    for (const tag of tags) {
      const version = tag.slice("agent-primitives/v".length);
      const entry = ledgerEntryForTag(version, ledger);
      expect(entry, `${tag} has no ledger entry at or before it`).toBeDefined();
      const asset = git([
        "show",
        `${tag}:packages/agent-primitives/assets/skill/SKILL.md`,
      ]);
      expect(
        sha256(asset),
        `${tag}'s skill digest differs from the ledger`,
      ).toBe(entry?.sha256);
    }

    const taggedVersions = new Set(
      tags.map((tag) => tag.slice("agent-primitives/v".length)),
    );
    const packageVersion = currentPackageVersion();
    for (const [index, entry] of ledger.entries()) {
      const isPending =
        index === ledger.length - 1 &&
        compareSemver(entry.version, packageVersion) > 0;
      expect(
        taggedVersions.has(entry.version) ||
          UNTAGGED_RELEASE_ALLOWLIST.includes(entry.version) ||
          isPending,
        `untagged ledger entry ${entry.version} is neither the trailing pending entry nor in UNTAGGED_RELEASE_ALLOWLIST`,
      ).toBe(true);
    }
  });
});

describe("ledgerEntryForTag", () => {
  const ledger = [
    { version: "0.1.0", sha256: "a" },
    { version: "0.2.0", sha256: "b" },
    { version: "0.5.0", sha256: "c" },
  ];

  it("returns the exact entry for a release that changed the asset", () => {
    expect(ledgerEntryForTag("0.2.0", ledger)?.sha256).toBe("b");
    expect(ledgerEntryForTag("0.5.0", ledger)?.sha256).toBe("c");
  });

  it("maps an unchanged-skill release to the nearest earlier entry", () => {
    expect(ledgerEntryForTag("0.3.0", ledger)?.sha256).toBe("b");
    expect(ledgerEntryForTag("0.4.9", ledger)?.sha256).toBe("b");
    expect(ledgerEntryForTag("0.10.0", ledger)?.sha256).toBe("c");
  });

  it("returns undefined for a version below every entry", () => {
    expect(ledgerEntryForTag("0.0.9", ledger)).toBeUndefined();
    expect(ledgerEntryForTag("0.3.0", [])).toBeUndefined();
  });

  it("does not depend on the ledger's order", () => {
    const unsorted = [ledger[2], ledger[0], ledger[1]];
    expect(ledgerEntryForTag("0.3.0", unsorted)?.sha256).toBe("b");
    expect(ledgerEntryForTag("0.9.0", unsorted)?.sha256).toBe("c");
    expect(ledgerEntryForTag("0.1.5", unsorted)?.sha256).toBe("a");
  });

  it("orders a prerelease tag before its release", () => {
    const withRelease = [...ledger, { version: "0.6.0", sha256: "d" }];
    expect(ledgerEntryForTag("0.6.0-rc.1", withRelease)?.sha256).toBe("c");
    const withPrerelease = [
      ...withRelease,
      { version: "0.6.0-rc.1", sha256: "e" },
    ];
    expect(ledgerEntryForTag("0.6.0-rc.1", withPrerelease)?.sha256).toBe("e");
    expect(ledgerEntryForTag("0.6.0-rc.2", withPrerelease)?.sha256).toBe("e");
    expect(ledgerEntryForTag("0.6.1", withPrerelease)?.sha256).toBe("d");
  });
});

describe("compareSemver", () => {
  it("orders by the numeric core, not lexically", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareSemver("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareSemver("0.8.1", "0.8.1")).toBe(0);
  });

  it("sorts a prerelease before its release and compares prerelease identifiers", () => {
    expect(compareSemver("0.9.0-rc.1", "0.9.0")).toBeLessThan(0);
    expect(compareSemver("0.9.0", "0.9.0-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("0.9.0-rc.1", "0.8.9")).toBeGreaterThan(0);
    expect(compareSemver("0.9.0-rc.2", "0.9.0-rc.10")).toBeLessThan(0);
    expect(compareSemver("0.9.0-alpha", "0.9.0-beta")).toBeLessThan(0);
    expect(compareSemver("0.9.0-1", "0.9.0-alpha")).toBeLessThan(0);
    expect(compareSemver("0.9.0-rc", "0.9.0-rc.1")).toBeLessThan(0);
  });

  it("ignores build metadata", () => {
    expect(compareSemver("0.9.0+build.1", "0.9.0")).toBe(0);
  });

  it("rejects a string that is not semver", () => {
    expect(() => compareSemver("0.9", "0.9.0")).toThrow(/not a semver/);
    expect(() => compareSemver("0.9.0", "v0.9.0")).toThrow(/not a semver/);
  });
});

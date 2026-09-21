import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

interface CliRun {
  status: number;
  stdout: string;
}

/**
 * Runs a COPY of the built CLI whose packaged ledger the test may break.
 * The ledger is resolved relative to the compiled module, so the copy
 * carries `dist/`, `assets/` and `package.json`, and borrows the real
 * `node_modules` through a symlink. The library-level degradation tests
 * in init.test.ts spy on `fs.readFileSync` and therefore never see what
 * the CLI prints.
 */
function runCopiedCli(pkgCopy: string, args: string[]): CliRun {
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join(pkgCopy, "dist", "cli.js"), ...args],
      { encoding: "utf8", timeout: 30_000 },
    );
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown };
    if (typeof e.stdout !== "string") throw err;
    return { status: e.status ?? 1, stdout: e.stdout };
  }
}

describe("init CLI: a degraded skill digest ledger is visible in every format", () => {
  const scratch: string[] = [];

  afterEach(() => {
    for (const dir of scratch.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(): { pkgCopy: string; targetDir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-init-cli-"));
    scratch.push(root);
    const pkgCopy = path.join(root, "pkg");
    fs.mkdirSync(pkgCopy);
    for (const entry of ["dist", "assets"]) {
      fs.cpSync(path.join(PKG_ROOT, entry), path.join(pkgCopy, entry), {
        recursive: true,
      });
    }
    fs.copyFileSync(
      path.join(PKG_ROOT, "package.json"),
      path.join(pkgCopy, "package.json"),
    );
    fs.symlinkSync(
      path.join(PKG_ROOT, "node_modules"),
      path.join(pkgCopy, "node_modules"),
      "dir",
    );
    fs.writeFileSync(
      path.join(pkgCopy, "assets", "skill-ledger.json"),
      "{ this is not json",
    );
    const targetDir = path.join(root, "workspace");
    const skillDir = path.join(
      targetDir,
      ".claude",
      "skills",
      "agent-primitives",
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# a local edit\n");
    return { pkgCopy, targetDir };
  }

  it("text format prints the ledger warning under a warnings block, status conflicted, exit 1", () => {
    const { pkgCopy, targetDir } = setup();
    const run = runCopiedCli(pkgCopy, ["-f", "text", "init", "-t", targetDir]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("status: conflicted");
    expect(run.stdout).toMatch(/\nwarnings:\n {2}- .*skill digest ledger/);
  });

  it.skipIf(process.getuid?.() === 0)(
    "a usage error later in the same run keeps the ledger warning already collected",
    () => {
      const { pkgCopy, targetDir } = setup();
      // The second harness's parent directory is not writable: init fails
      // with a usage error AFTER the first target already read the broken
      // ledger and was classified.
      const agentsDir = path.join(targetDir, ".agents");
      fs.mkdirSync(agentsDir);
      fs.chmodSync(agentsDir, 0o555);
      let run: CliRun;
      try {
        run = runCopiedCli(pkgCopy, [
          "init",
          "-H",
          "claude,codex",
          "-t",
          targetDir,
        ]);
      } finally {
        fs.chmodSync(agentsDir, 0o755);
      }
      expect(run.status).toBe(2);
      const envelope = JSON.parse(run.stdout) as {
        status: string;
        reason: string;
        warnings: string[];
        targets: Array<{ status: string }>;
      };
      expect(envelope.status).toBe("usage_error");
      expect(envelope.reason).toBe("target_not_writable");
      expect(envelope.targets.map((t) => t.status)).toEqual(["conflicted"]);
      expect(envelope.warnings).toHaveLength(1);
      expect(envelope.warnings[0]).toContain("skill digest ledger");
    },
  );

  it("json format carries the same warning, command identity and targets", () => {
    const { pkgCopy, targetDir } = setup();
    const run = runCopiedCli(pkgCopy, ["init", "-t", targetDir]);
    expect(run.status).toBe(1);
    const envelope = JSON.parse(run.stdout) as {
      command: string;
      status: string;
      warnings: string[];
      targets: Array<{ status: string }>;
    };
    expect(envelope.command).toBe("init");
    expect(envelope.status).toBe("conflicted");
    expect(envelope.targets.map((t) => t.status)).toEqual(["conflicted"]);
    expect(envelope.warnings).toHaveLength(1);
    expect(envelope.warnings[0]).toContain("skill digest ledger");
  });
});

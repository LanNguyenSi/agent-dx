import { execFile } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cli = cliPath): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cli,
      ...args,
    ]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe("spec-gate CLI", () => {
  it("--version prints the package.json version and exits 0", async () => {
    const run = await runCli(["--version"]);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(pkg.version);
  });

  it("--help exits 0 and names the program", async () => {
    const run = await runCli(["--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`Usage: ${pkg.name}`);
  });

  it("an unknown option exits non-zero with a usage message on stderr", async () => {
    const run = await runCli(["--nope"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("unknown option");
    expect(run.stderr).toContain("Usage: spec-gate");
  });

  it("an unknown command exits non-zero with a usage message on stderr", async () => {
    const run = await runCli(["frobnicate"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("unknown command");
    expect(run.stderr).toContain("Usage: spec-gate");
  });

  describe("version source", () => {
    const tmpRoots: string[] = [];
    afterEach(() => {
      for (const dir of tmpRoots.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // The copy lives inside the package so that `commander` still resolves
    // from the package's node_modules. The whole `dist` tree is copied:
    // `cli.js` imports the triage and format modules by relative path, so a
    // lone `cli.js` would fail to load.
    function copyCli(pkgJson: string): string {
      const root = fs.mkdtempSync(
        path.join(fileURLToPath(new URL("..", import.meta.url)), ".tmp-cli-"),
      );
      tmpRoots.push(root);
      fs.cpSync(path.dirname(cliPath), path.join(root, "dist"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, "package.json"), pkgJson);
      return path.join(root, "dist", "cli.js");
    }

    it("--version reads the version from the package.json next to dist", async () => {
      const cli = copyCli(JSON.stringify({ version: "9.8.7", type: "module" }));
      const run = await runCli(["--version"], cli);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toBe("9.8.7");
    });

    it("fails loudly when package.json has no version", async () => {
      const cli = copyCli(JSON.stringify({ type: "module" }));
      const run = await runCli(["--version"], cli);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("no version");
    });

    it("fails loudly when package.json has an empty version", async () => {
      const cli = copyCli(JSON.stringify({ version: "", type: "module" }));
      const run = await runCli(["--version"], cli);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("no version");
    });
  });
});

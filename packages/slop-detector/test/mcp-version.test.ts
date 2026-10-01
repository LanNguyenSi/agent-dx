import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt } from "./built-cli.js";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const builtEntry = path.join(packageRoot, "dist", "mcp.js");

describe("slop-detector-mcp --version", () => {
  beforeAll(() => {
    ensureBuilt();
  }, 180_000);

  it("exits cleanly when the stdout reader is already closed", async () => {
    const result = await new Promise<{ status: number | null; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [builtEntry, "--version"], {
          cwd: packageRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stderr: Buffer[] = [];
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        // Close before the child finishes starting, so its version write
        // reaches a real pipe whose reader has gone away.
        child.stdout.destroy();
        child.on("error", reject);
        child.on("close", (status) => {
          resolve({ status, stderr: Buffer.concat(stderr).toString("utf8") });
        });
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  }, 30_000);
});

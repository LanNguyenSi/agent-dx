import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "dist", "cli.js");

function runCli(args: string[]) {
  return spawnSync("node", [CLI_PATH, ...args], { encoding: "utf8" });
}

describe("cli", () => {
  it("prints parseable JSON with status: usage_error on stdout and exits 2 for a mistyped flag", () => {
    const result = runCli(["doctor", "--no-such-flag"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("usage_error");
    expect(parsed.tool).toBe("agent-primitives");
  });

  it("exits 0 for --help", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
  });

  it("exits 0 for doctor --help", () => {
    const result = runCli(["doctor", "--help"]);
    expect(result.status).toBe(0);
  });

  it("exits 2 with usage_error for an invalid --format value", () => {
    const result = runCli(["doctor", "-f", "yaml"]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("usage_error");
  });

  it("reports a missing required tool as status: missing with exit 1", () => {
    const result = runCli([
      "doctor",
      "-r",
      "git,node,npm,rg,definitely-not-a-binary-xyz",
    ]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("missing");
    const tool = parsed.tools.find(
      (t: { name: string }) => t.name === "definitely-not-a-binary-xyz",
    );
    expect(tool.found).toBe(false);
  });

  it("exits 0 with status ok when all default required tools are present", () => {
    const result = runCli(["doctor"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("ok");
  });

  it("returns not_implemented usage_error for probe, verify, and init stubs", () => {
    for (const sub of ["probe", "verify", "init"]) {
      const result = runCli([sub]);
      expect(result.status).toBe(2);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe("usage_error");
      expect(parsed.reason).toBe("not_implemented");
    }
  });
});

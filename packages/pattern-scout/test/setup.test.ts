import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSetup } from "../src/setup.js";
import { defaultConfig } from "../src/config.js";

let workdir = "";

afterEach(() => {
  if (workdir) {
    fs.rmSync(workdir, { recursive: true, force: true });
    workdir = "";
  }
});

/** Write a fake `opensrc` script and return it as an `opensrcCommand`. */
function fakeOpensrc(body: string): string {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-scout-setup-"));
  const script = path.join(workdir, "fake-opensrc.mjs");
  fs.writeFileSync(script, body);
  return `node ${script}`;
}

describe("runSetup", () => {
  it("reports per-spec success and failure without aborting the batch", async () => {
    // argv: [node, fake-opensrc.mjs, "fetch", <spec>]
    const opensrcCommand = fakeOpensrc(
      [
        "const spec = process.argv[3];",
        "if (spec === 'bad') {",
        "  process.stderr.write('cannot fetch\\n');",
        "  process.exit(1);",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    const results = await runSetup({
      ...defaultConfig(),
      opensrcCommand,
      defaultRepos: ["good", "bad", "alsogood"],
    });
    expect(results).toHaveLength(3);
    expect(results.find((r) => r.spec === "good")?.ok).toBe(true);
    expect(results.find((r) => r.spec === "bad")?.ok).toBe(false);
    expect(results.find((r) => r.spec === "alsogood")?.ok).toBe(true);
  });

  it("throws when opensrc itself cannot be run", async () => {
    await expect(
      runSetup({
        ...defaultConfig(),
        opensrcCommand: "pattern-scout-no-such-opensrc-zzz",
        defaultRepos: ["x"],
      }),
    ).rejects.toThrow(/could not be run/);
  });
});

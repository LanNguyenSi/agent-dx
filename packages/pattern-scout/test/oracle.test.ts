import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseOracleSearch, searchOracle } from "../src/oracle.js";

describe("parseOracleSearch", () => {
  it("parses headers with a path and a line range", () => {
    const out = [
      "",
      "--- src/engine.ts:10-24 (agent-tasks) ---",
      "export function run() {",
      "  return 1;",
      "}",
      "",
      "--- src/cli.ts:3 (harness) ---",
      "import process from 'node:process';",
    ].join("\n");
    const results = parseOracleSearch(out);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      kind: "ours",
      source: "agent-tasks",
      path: "src/engine.ts",
      line: 10,
    });
    expect(results[0].snippet).toContain("export function run()");
    expect(results[1]).toMatchObject({
      source: "harness",
      path: "src/cli.ts",
      line: 3,
    });
  });

  it("handles a location with no line number", () => {
    const results = parseOracleSearch("--- README.md (lab) ---\nhello");
    expect(results[0]).toMatchObject({ path: "README.md", line: 0 });
  });

  it("returns an empty list when there are no headers", () => {
    expect(parseOracleSearch("no matches found\n")).toEqual([]);
  });
});

describe("searchOracle", () => {
  let workdir = "";
  afterEach(() => {
    if (workdir) {
      fs.rmSync(workdir, { recursive: true, force: true });
      workdir = "";
    }
  });

  function fakeOracle(body: string): string {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-scout-oracle-"));
    const script = path.join(workdir, "fake-oracle.mjs");
    fs.writeFileSync(script, body);
    return `node ${script}`;
  }

  it("parses results and reports ok on success", async () => {
    const cmd = fakeOracle(
      "process.stdout.write('--- src/a.ts:5 (myrepo) ---\\nhello world\\n');\n",
    );
    const outcome = await searchOracle(cmd, "q", { limit: 5 });
    expect(outcome.ok).toBe(true);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({
      kind: "ours",
      source: "myrepo",
      path: "src/a.ts",
      line: 5,
    });
  });

  it("degrades to ok:false on a non-zero exit", async () => {
    const cmd = fakeOracle("process.stderr.write('boom\\n');\nprocess.exit(3);\n");
    const outcome = await searchOracle(cmd, "q", { limit: 5 });
    expect(outcome.ok).toBe(false);
    expect(outcome.results).toEqual([]);
    expect(outcome.detail).toMatch(/failed/);
  });

  it("degrades to ok:false when the binary cannot be run", async () => {
    const outcome = await searchOracle("pattern-scout-no-such-oracle-zzz", "q", {
      limit: 5,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/could not be run/);
  });
});

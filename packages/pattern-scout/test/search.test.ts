import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { federatedSearch } from "../src/search.js";
import { defaultConfig } from "../src/config.js";

let workdir = "";

afterEach(() => {
  if (workdir) {
    fs.rmSync(workdir, { recursive: true, force: true });
    workdir = "";
  }
});

/**
 * Build a fake exemplar repo plus fake `opensrc` and `codebase-oracle`
 * scripts, so federatedSearch can be exercised end to end without the real
 * tools. The repo path ends in `.../fake-repo/main` so parseOpensrcList
 * derives the short name `fake-repo`.
 */
function scaffold(): { opensrcCommand: string; oracleCommand: string } {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-scout-fed-"));
  const repoDir = path.join(workdir, "cache", "fake-repo", "main");
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "src", "sample.ts"),
    "const x = 1;\nexport function uniqueNeedle() {}\n",
  );
  const posixRepoDir = repoDir.split(path.sep).join("/");

  const fakeOpensrc = path.join(workdir, "fake-opensrc.mjs");
  fs.writeFileSync(
    fakeOpensrc,
    [
      "const cmd = process.argv[2];",
      "if (cmd === 'list') {",
      `  process.stdout.write('Repositories:\\n\\n  fake-repo@main\\n    Path: ${posixRepoDir}\\n');`,
      "} else {",
      "  process.exit(0);",
      "}",
      "",
    ].join("\n"),
  );

  const fakeOracle = path.join(workdir, "fake-oracle.mjs");
  fs.writeFileSync(
    fakeOracle,
    "process.stdout.write('--- src/own.ts:7 (our-repo) ---\\nuniqueNeedle lives here\\n');\n",
  );

  return {
    opensrcCommand: `node ${fakeOpensrc}`,
    oracleCommand: `node ${fakeOracle}`,
  };
}

describe("federatedSearch", () => {
  it("merges both sources into one set tagged by source", async () => {
    const { opensrcCommand, oracleCommand } = scaffold();
    const summary = await federatedSearch(
      { ...defaultConfig(), opensrcCommand, oracleCommand },
      { query: "uniqueNeedle" },
    );
    expect(summary.exemplarCount).toBe(1);
    expect(summary.oursCount).toBe(1);
    expect(summary.results).toHaveLength(2);
    expect(summary.results.filter((r) => r.kind === "exemplar")).toHaveLength(
      1,
    );
    expect(summary.results.filter((r) => r.kind === "ours")).toHaveLength(1);
    expect(summary.sources.every((s) => s.ok)).toBe(true);
  });

  it("returns exemplar hits tagged by source", async () => {
    const { opensrcCommand } = scaffold();
    const summary = await federatedSearch(
      { ...defaultConfig(), opensrcCommand },
      { query: "uniqueNeedle", exemplarsOnly: true },
    );
    expect(summary.exemplarCount).toBe(1);
    expect(summary.results[0].kind).toBe("exemplar");
    expect(summary.results[0].source).toBe("fake-repo");
    const opensrcStatus = summary.sources.find((s) => s.name === "opensrc");
    expect(opensrcStatus?.ok).toBe(true);
  });

  it("degrades gracefully when opensrc is missing", async () => {
    const summary = await federatedSearch(
      {
        ...defaultConfig(),
        opensrcCommand: "pattern-scout-no-such-binary-zzz",
      },
      { query: "anything", exemplarsOnly: true },
    );
    expect(summary.exemplarCount).toBe(0);
    const opensrcStatus = summary.sources.find((s) => s.name === "opensrc");
    expect(opensrcStatus?.ok).toBe(false);
  });
});

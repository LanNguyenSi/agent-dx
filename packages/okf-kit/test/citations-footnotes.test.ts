import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { citationsResolveRule } from "../src/rules/citations-resolve.js";
import type { Finding, SpecVersion } from "../src/types.js";
import { FIXTURES_DIR } from "./helpers.js";

// Line-precise code citations in the OKF v0.2 footnote form: the footnote's
// `sources` entry names the file, the footnote DEFINITION text names the
// lines in backticks, and `citations-resolve` checks them like an inline
// `resource:N-M` citation.

describe("citations-resolve: footnote line citations", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-fncite-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "v02-mappings-footnotes", "src", "client.ts"),
      path.join(dir, "src", "client.ts"),
    );
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(
      path.join(dir, "docs", "index.md"),
      '---\nokf_version: "0.2"\n---\n\n# Index\n',
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(
    sources: string,
    definitionText: string,
    spec: SpecVersion = "v0.2",
  ): Finding[] {
    fs.writeFileSync(
      path.join(dir, "docs", "doc.md"),
      `---\ntype: concept\nsources:\n${sources}\n---\n\nClaim.[^n]\n\n[^n]: ${definitionText}\n`,
    );
    const ctx = loadBundle(path.join(dir, "docs"), dir);
    ctx.specVersion = spec;
    return citationsResolveRule.run(ctx);
  }

  const CLIENT = "  - id: n\n    resource: src/client.ts";

  it("is clean for in-range lines on the footnote's file (all accepted spellings)", () => {
    expect(run(CLIENT, "Loop, `L2-4`, `3`, `2-4`, `L3-L4`.")).toEqual([]);
  });

  it("flags a line range past the end of the file, naming the footnote", () => {
    const findings = run(CLIENT, "Loop, `L5-99`.");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "citations-resolve",
      severity: "warning",
      file: "doc.md",
    });
    expect(findings[0].message).toContain(
      "`src/client.ts:5-99 (footnote [^n])`",
    );
    expect(findings[0].message).toContain("[range-exceeds-file]");
    expect(findings[0].detail).toBe("resolvedTo: src/client.ts");
  });

  it("flags a blank start line", () => {
    const findings = run(CLIENT, "Gap, `L6`.");
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("[blank-start-line]");
  });

  it("flags a closing-brace start line like an inline citation would", () => {
    const findings = run(CLIENT, "End, `L4`.");
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("[closing-brace-start-line]");
  });

  it("flags an inverted range", () => {
    const findings = run(CLIENT, "Backwards, `L4-2`.");
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("[inverted-range]");
  });

  it("checks every line citation in one definition separately", () => {
    expect(run(CLIENT, "Two bad: `L90` and `L91`.")).toHaveLength(2);
  });

  it("reads indented continuation lines of the definition", () => {
    fs.writeFileSync(
      path.join(dir, "docs", "doc.md"),
      `---\ntype: concept\nsources:\n${CLIENT}\n---\n\nClaim.[^n]\n\n[^n]: Loop\n    spanning \`L90\`.\n`,
    );
    const ctx = loadBundle(path.join(dir, "docs"), dir);
    expect(citationsResolveRule.run(ctx)).toHaveLength(1);
  });

  it("ignores numbers that are not backticked line citations", () => {
    expect(run(CLIENT, "Retried 90 times, see RFC 9110 and `abc99`.")).toEqual(
      [],
    );
  });

  it("checks nothing under spec v0.1", () => {
    expect(run(CLIENT, "Loop, `L90`.", "v0.1")).toEqual([]);
  });

  it("skips a URL resource, a footnote with no matching id, and an entry without an id", () => {
    expect(
      run("  - id: n\n    resource: https://example.com/x", "`L90`"),
    ).toEqual([]);
    expect(run("  - id: other\n    resource: src/client.ts", "`L90`")).toEqual(
      [],
    );
    expect(run("  - src/client.ts", "`L90`")).toEqual([]);
  });

  it("leaves a missing or escaping resource to sources-shape", () => {
    expect(run("  - id: n\n    resource: src/gone.ts", "`L90`")).toEqual([]);
    expect(run("  - id: n\n    resource: ../outside.ts", "`L90`")).toEqual([]);
  });

  it("does not check a directory resource (no lines to cite)", () => {
    expect(run("  - id: n\n    resource: src", "`L90`")).toEqual([]);
  });

  it("does not check a footnote written inside a code fence", () => {
    fs.writeFileSync(
      path.join(dir, "docs", "doc.md"),
      `---\ntype: concept\nsources:\n${CLIENT}\n---\n\n\`\`\`\n[^n]: \`L90\`\n\`\`\`\n`,
    );
    const ctx = loadBundle(path.join(dir, "docs"), dir);
    expect(citationsResolveRule.run(ctx)).toEqual([]);
  });

  it("the shipped fixture's footnote line citation resolves", () => {
    const fixture = path.join(FIXTURES_DIR, "v02-mappings-footnotes");
    const ctx = loadBundle(path.join(fixture, "docs"), fixture);
    expect(ctx.specVersion).toBe("v0.2");
    expect(citationsResolveRule.run(ctx)).toEqual([]);
  });
});

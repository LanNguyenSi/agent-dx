import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { parseSpecVersion, runCheck } from "../src/cli.js";
import { UsageError } from "../src/errors.js";
import type { Finding } from "../src/types.js";
import { writeDoc } from "./git-helpers.js";
import { FIXTURES_DIR, loadFixture, runCli } from "./helpers.js";

// OKF v0.2 spec-version detection (`okf_version` on the bundle-root
// index.md) and the `--spec` override. Static fixtures cover detection and
// the reserved-files frontmatter side; the git-backed freshness behavior of
// a v0.2 stamp lives in test/sources-fresh-generated.test.ts.

function checkFixture(name: string, spec?: string): Finding[] {
  const dir = path.join(FIXTURES_DIR, name);
  // Explicit repoRoot + a failing-runGit stub: the verdict depends on the
  // fixture content alone, never on the ambient git work tree.
  return runCheck(dir, { repoRoot: dir, runGit: () => null, spec }).findings;
}

describe("spec version detection (bundle-root index.md okf_version)", () => {
  it("detects v0.2 from the quoted-string form", () => {
    expect(loadFixture("spec-v02").specVersion).toBe("v0.2");
  });

  it("accepts the YAML number form (okf_version: 0.2)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-spec-num-"));
    try {
      writeDoc(dir, "index.md", { okf_version: 0.2 });
      expect(loadBundle(dir).specVersion).toBe("v0.2");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no key, no frontmatter, 0.1 and an unrecognized value all resolve to v0.1", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-spec-def-"));
    try {
      expect(loadFixture("valid-bundle").specVersion).toBe("v0.1");

      writeDoc(dir, "index.md", { okf_version: "0.1" });
      expect(loadBundle(dir).specVersion).toBe("v0.1");

      fs.rmSync(path.join(dir, "index.md"));
      writeDoc(dir, "index.md", { okf_version: "0.3" });
      expect(loadBundle(dir).specVersion).toBe("v0.1");

      fs.rmSync(path.join(dir, "index.md"));
      writeDoc(dir, "index.md", { okf_version: true });
      expect(loadBundle(dir).specVersion).toBe("v0.1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only the BUNDLE-ROOT index.md declares the version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-spec-sub-"));
    try {
      fs.writeFileSync(path.join(dir, "index.md"), "# Root index\n");
      writeDoc(dir, "sub/index.md", { okf_version: "0.2" });
      expect(loadBundle(dir).specVersion).toBe("v0.1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("check --spec override", () => {
  it("--spec v0.1 on a detected-v0.2 bundle reports the version block again", () => {
    // Detection alone would let the root index block through (v0.2
    // exception); the override restores the v0.1 rule for it.
    const detected = checkFixture("spec-v02").filter(
      (f) => f.ruleId === "reserved-files-bare",
    );
    expect(detected).toEqual([]);

    const overridden = checkFixture("spec-v02", "v0.1").filter(
      (f) => f.ruleId === "reserved-files-bare",
    );
    expect(overridden).toHaveLength(1);
    expect(overridden[0]).toMatchObject({
      severity: "error",
      file: "index.md",
    });
    expect(overridden[0].message).toContain("must not carry a frontmatter");
  });

  it("--spec v0.2 on a detected-v0.1 bundle activates the v0.2 generated rules", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-spec-ovr-"));
    try {
      fs.writeFileSync(path.join(dir, "index.md"), "# Root index\n");
      writeDoc(dir, "doc.md", {
        type: "concept",
        generated: { by: "okf-kit/0.19.0", at: "2026-01-05T00:00:00" },
      });

      // Detected as v0.1: the offset requirement does not exist yet, and
      // the root index has no block to complain about.
      expect(
        runCheck(dir, { repoRoot: dir, runGit: () => null }).findings,
      ).toEqual([]);

      const v02 = runCheck(dir, {
        repoRoot: dir,
        runGit: () => null,
        spec: "v0.2",
      }).findings;
      expect(v02).toHaveLength(1);
      expect(v02[0]).toMatchObject({
        ruleId: "generated-shape",
        severity: "error",
        file: "doc.md",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an invalid --spec value is a UsageError from runCheck", () => {
    const dir = path.join(FIXTURES_DIR, "valid-bundle");
    expect(() => runCheck(dir, { spec: "v0.3" })).toThrow(UsageError);
    expect(() => runCheck(dir, { spec: "0.2" })).toThrow(UsageError); // bare numbers are not a flag spelling
    expect(parseSpecVersion(" v0.2 ")).toBe("v0.2");
    expect(parseSpecVersion("v0.1")).toBe("v0.1");
  });
});

describe("check --spec through the CLI", () => {
  it("reports the version block under --spec v0.1 and stays silent under --spec v0.2", () => {
    const bundle = "test/fixtures/spec-v02";
    const filtered = [
      "--repo-root",
      bundle,
      "--rule",
      "reserved-files-bare",
      "--min-severity",
      "error",
    ];

    const asV01 = runCli(["check", bundle, ...filtered, "--spec", "v0.1"]);
    expect(asV01.status).toBe(1);
    expect(asV01.stdout).toContain("index.md");

    const asV02 = runCli(["check", bundle, ...filtered, "--spec", "v0.2"]);
    expect(asV02.status).toBe(0);

    const detected = runCli(["check", bundle, ...filtered]);
    expect(detected.status).toBe(0);
  });

  it("an invalid --spec value is a usage error (exit 2)", () => {
    const result = runCli([
      "check",
      "test/fixtures/valid-bundle",
      "--spec",
      "v0.3",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--spec must be one of v0.1, v0.2");
  });
});

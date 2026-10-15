import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { runCheck } from "../src/cli.js";
import { generatedShapeRule } from "../src/rules/generated-shape.js";
import { reservedFilesBareRule } from "../src/rules/reserved-files-bare.js";
import type { Finding, SpecVersion } from "../src/types.js";

// The two silent OKF v0.2 migration cases: a bundle-root `index.md` declaring
// an `okf_version` this tool does not have (it resolves to v0.1, and the author
// used to see nothing but the generic "reserved file must not carry a
// frontmatter block" error), and a `generated` stamp whose shape v0.2 does not
// admit (used to pass while the freshness rules silently read no stamp at all).

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-v02diag-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes a file byte-for-byte. The frontmatter-rendering helpers would
 * normalize away the exact spelling under test (`0.20` is written back as
 * `0.2`, `generated: <scalar>` as a mapping), so these cases need raw text.
 */
function writeRaw(relPath: string, content: string): void {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function checkBundle(): Finding[] {
  return runCheck(dir, { repoRoot: dir, runGit: () => null }).findings;
}

describe("unrecognized okf_version on the bundle root", () => {
  it("names the value and the supported versions instead of the generic reserved-file error", () => {
    writeRaw("index.md", '---\nokf_version: "0.3"\n---\n\n# Index\n');
    expect(loadBundle(dir).specVersion).toBe("v0.1");

    const findings = checkBundle();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "reserved-files-bare",
      severity: "error",
      file: "index.md",
    });
    expect(findings[0].message).toContain("okf_version: 0.3");
    expect(findings[0].message).toContain("0.1, 0.2");
    expect(findings[0].message).not.toContain("must not carry a frontmatter");
  });

  it("keeps the generic error for a recognized version the resolved spec forbids", () => {
    // `okf_version: "0.1"` is a real version: the bundle IS a v0.1 bundle, and
    // under v0.1 no reserved file may carry a block at all.
    writeRaw("index.md", '---\nokf_version: "0.1"\n---\n\n# Index\n');
    const findings = checkBundle();
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("must not carry a frontmatter block");
  });

  it("accepts the exact YAML number spelling and reports the 0.20 that YAML parses to it", () => {
    writeRaw("index.md", "---\nokf_version: 0.2\n---\n\n# Index\n");
    expect(loadBundle(dir).specVersion).toBe("v0.2");
    expect(checkBundle()).toEqual([]);

    // A trailing comment is not part of the value, so this is still `0.2`.
    writeRaw(
      "index.md",
      "---\nokf_version: 0.2 # current spec\n---\n\n# Index\n",
    );
    expect(loadBundle(dir).specVersion).toBe("v0.2");

    // The number `0.20` IS the number `0.2` to YAML; only the raw frontmatter
    // spelling tells the two apart, and a misspelling is not a declaration.
    writeRaw("index.md", "---\nokf_version: 0.20\n---\n\n# Index\n");
    expect(loadBundle(dir).specVersion).toBe("v0.1");
    const findings = reservedFilesBareRule.run(loadBundle(dir));
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("okf_version: 0.20");
    expect(findings[0].message).toContain("0.1, 0.2");
  });
});

describe("malformed generated stamp under v0.2", () => {
  function runDoc(frontmatterTail: string, spec: SpecVersion = "v0.2") {
    writeRaw(
      "index.md",
      spec === "v0.2"
        ? '---\nokf_version: "0.2"\n---\n\n# Index\n'
        : "# Index\n",
    );
    writeRaw("doc.md", `---\ntype: concept\n${frontmatterTail}---\n\n# Doc\n`);
    const ctx = loadBundle(dir);
    expect(ctx.specVersion).toBe(spec);
    return generatedShapeRule.run(ctx);
  }

  it("reports a generated key that is not a mapping, once, naming what it found", () => {
    const scalar = runDoc("generated: 2026-01-01T00:00:00Z\n");
    expect(scalar).toHaveLength(1);
    expect(scalar[0]).toMatchObject({
      ruleId: "generated-shape",
      severity: "warning",
      file: "doc.md",
    });
    expect(scalar[0].message).toContain("generated must be a mapping");
    expect(scalar[0].message).toContain("`2026-01-01T00:00:00Z`");

    expect(runDoc("generated:\n")[0]?.message).toContain("found no value");
    expect(runDoc("generated:\n  - by\n")[0]?.message).toContain(
      "found a list",
    );
  });

  it("reports a native YAML date generated value, once, naming it as a date", () => {
    // `!!timestamp` resolves to a JS Date, which `isRecord` accepts, so a
    // Date must be reported as the non-mapping it spells rather than as a
    // mapping missing both keys.
    const findings = runDoc("generated: !!timestamp 2026-01-01T00:00:00Z\n");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "generated-shape",
      severity: "warning",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("generated must be a mapping");
    expect(findings[0].message).toContain("a native YAML date");
  });

  it("reports nothing for a doc with no generated key, or one still on timestamp alone", () => {
    // The shape contract binds a doc that CARRIES the key; v0.2 explicitly
    // allows a mid-migration doc to keep stamping itself with `timestamp`.
    expect(runDoc("")).toEqual([]);
    expect(runDoc("timestamp: 2026-01-01T00:00:00Z\n")).toEqual([]);
  });

  it("reports a generated mapping without by, once", () => {
    const findings = runDoc("generated:\n  at: 2026-01-05T00:00:00Z\n");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "generated-shape",
      severity: "warning",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("generated has no `by`");
  });

  it("reports a generated mapping without at, once", () => {
    const findings = runDoc("generated:\n  by: okf-kit/0.19.0\n");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "generated-shape",
      severity: "warning",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("generated has no `at`");
  });

  it("stays silent on a complete mapping, and on every malformed shape under v0.1", () => {
    expect(
      runDoc("generated:\n  by: okf-kit/0.19.0\n  at: 2026-01-05T00:00:00Z\n"),
    ).toEqual([]);
    expect(runDoc("generated: 2026-01-01T00:00:00Z\n", "v0.1")).toEqual([]);
    expect(runDoc("generated:\n  by: okf-kit/0.19.0\n", "v0.1")).toEqual([]);
    expect(runDoc("generated:\n  at: 2026-01-05T00:00:00Z\n", "v0.1")).toEqual(
      [],
    );
  });
});

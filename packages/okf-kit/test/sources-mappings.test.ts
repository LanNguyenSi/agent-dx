import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { runDocsFor } from "../src/docs-for.js";
import { sourcesShapeRule } from "../src/rules/sources-shape.js";
import {
  analyzeSources,
  getDeclaredSourceIds,
  getValidSources,
  isUrlResource,
} from "../src/util.js";
import { FIXTURES_DIR } from "./helpers.js";

// OKF v0.2 `sources` mapping entries (`resource`, optional `id`) next to the
// v0.1 plain-string entries, in the shared reader and in the two consumers
// that need more than the path list (sources-shape, docs-for). Staleness and
// the full-bundle acceptance cases live in test/v02-sources-footnotes.test.ts.

describe("isUrlResource", () => {
  it.each([
    "https://example.com/a",
    "http://example.com",
    "file:///etc/hosts",
    "HTTPS://EXAMPLE.COM",
    "git+ssh://host/repo.git",
  ])("treats %s as a URL", (resource) => {
    expect(isUrlResource(resource)).toBe(true);
  });

  it.each([
    "src/a.ts",
    "../outside.ts",
    "/src/a.ts",
    "./src/a.ts",
    "docs/a://b.md",
    "//host/share/file.ts",
    "C://windows/x",
    "urn:isbn:123",
    "mailto:a@b.c",
    "not a url",
  ])("treats %s as a path", (resource) => {
    expect(isUrlResource(resource)).toBe(false);
  });
});

describe("analyzeSources / getValidSources", () => {
  it("a list of plain strings yields exactly those paths", () => {
    const parsed = { sources: ["a.ts", "dir/b.ts"] };
    expect(getValidSources(parsed)).toEqual(["a.ts", "dir/b.ts"]);
    expect(analyzeSources(parsed).entries).toEqual([
      { resource: "a.ts", form: "string", kind: "path" },
      { resource: "dir/b.ts", form: "string", kind: "path" },
    ]);
  });

  it("a mapping contributes its resource as a path, next to string entries", () => {
    const parsed = {
      sources: ["a.ts", { resource: "b.ts", id: "b", title: "B" }],
    };
    expect(getValidSources(parsed)).toEqual(["a.ts", "b.ts"]);
    expect(analyzeSources(parsed).entries[1]).toEqual({
      resource: "b.ts",
      id: "b",
      form: "mapping",
      kind: "path",
    });
  });

  it("a URL resource is an entry of kind url and is left out of the path list", () => {
    const parsed = {
      sources: [
        { resource: "https://example.com/doc", id: "doc" },
        { resource: "file:///tmp/x" },
        { resource: "real.ts" },
      ],
    };
    expect(getValidSources(parsed)).toEqual(["real.ts"]);
    expect(analyzeSources(parsed).entries.map((e) => e.kind)).toEqual([
      "url",
      "url",
      "path",
    ]);
  });

  it("a path-looking string entry is a path even when it contains ://", () => {
    expect(getValidSources({ sources: ["https://example.com/a"] })).toEqual([
      "https://example.com/a",
    ]);
  });

  it("a `..` mapping resource stays a path (containment still applies)", () => {
    const parsed = { sources: [{ resource: "../outside.ts" }] };
    expect(getValidSources(parsed)).toEqual(["../outside.ts"]);
  });

  it("a mapping without a usable resource is an item problem and does not invalidate the list", () => {
    const parsed = {
      sources: [
        { id: "x" },
        { resource: "" },
        { resource: 5 },
        { resource: "ok.ts" },
      ],
    };
    const analysis = analyzeSources(parsed);
    expect(analysis.usable).toBe(true);
    expect(analysis.problems.map((p) => p.position)).toEqual([1, 2, 3]);
    expect(analysis.problems[0].message).toContain("without a `resource`");
    expect(analysis.problems[1].message).toContain("not a non-empty string");
    expect(getValidSources(parsed)).toEqual(["ok.ts"]);
  });

  it("an id that is neither a non-empty string nor a number is a problem; a number is stringified", () => {
    const analysis = analyzeSources({
      sources: [
        { resource: "a.ts", id: "" },
        { resource: "b.ts", id: [1] },
        { resource: "c.ts", id: 7 },
      ],
    });
    expect(analysis.problems.map((p) => p.position)).toEqual([1, 2]);
    expect(analysis.entries.map((e) => e.id)).toEqual([
      undefined,
      undefined,
      "7",
    ]);
  });

  it.each([
    ["absent", {}],
    ["not an array", { sources: "a.ts" }],
    ["an empty array", { sources: [] }],
    ["a number item", { sources: ["a.ts", 5] }],
    ["a blank string item", { sources: ["a.ts", "  "] }],
    ["a nested list item", { sources: [["a.ts"]] }],
    ["null item", { sources: [null] }],
  ])("the whole list is unusable for %s", (_name, parsed) => {
    expect(analyzeSources(parsed).usable).toBe(false);
    expect(getValidSources(parsed)).toBeUndefined();
  });

  it("getDeclaredSourceIds reads ids from every mapping, usable or not", () => {
    expect(
      getDeclaredSourceIds({
        sources: ["s.ts", { id: "a" }, { id: 2, resource: "x" }, { id: "" }],
      }),
    ).toEqual(["a", "2"]);
    expect(getDeclaredSourceIds({ sources: "nope" })).toEqual([]);
    expect(getDeclaredSourceIds({})).toEqual([]);
  });
});

describe("sources-shape with mapping entries", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-mappings-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "real.ts"), "export {};\n");
    fs.mkdirSync(path.join(dir, "bundle"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function check(sourcesYaml: string, repoRoot: string | null = dir) {
    fs.writeFileSync(
      path.join(dir, "bundle", "doc.md"),
      `---\ntype: concept\nsources:\n${sourcesYaml}\n---\n\nBody.\n`,
    );
    return sourcesShapeRule.run(
      loadBundle(path.join(dir, "bundle"), repoRoot ?? undefined),
    );
  }

  it("is clean for an existing mapping resource, a string entry and a URL resource", () => {
    expect(
      check(
        "  - resource: src/real.ts\n    id: r\n  - src/real.ts\n  - resource: https://example.com/never-fetched",
      ),
    ).toEqual([]);
  });

  it("reports a mapping without resource exactly once", () => {
    const findings = check(
      "  - id: x\n    title: no resource\n  - src/real.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-shape",
      severity: "error",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("without a `resource`");
  });

  it("reports a missing mapping resource path like a missing string entry", () => {
    const findings = check("  - resource: src/gone.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe(
      "Source path does not exist under repo root: `src/gone.ts`",
    );
  });

  it("applies the repo-root containment rule to a mapping resource", () => {
    const findings = check("  - resource: ../outside.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe(
      "`sources` path escapes the repo root: `../outside.ts`",
    );
  });

  it("does not let a URL-looking prefix hide an escaping path", () => {
    // Not a URL (no scheme before ://): still a path, still contained.
    const findings = check("  - resource: ../x://y.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("escapes the repo root");
  });

  it("does not stat a file:// URL resource", () => {
    expect(check("  - resource: file:///definitely/not/there")).toEqual([]);
  });

  it("keeps the v0.1 list-level message for a list with no mapping", () => {
    const findings = check("  - 5");
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe(
      "Frontmatter `sources` must be a non-empty array of non-empty strings.",
    );
  });

  it("words the list-level message for both shapes when a mapping is present", () => {
    const findings = check("  - resource: src/real.ts\n  - 5");
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe(
      "Frontmatter `sources` must be a non-empty array of non-empty strings or mappings with a `resource`.",
    );
  });

  it("checks nothing on disk without a repo root, but still flags the missing resource", () => {
    const findings = check("  - id: x\n  - resource: src/gone.ts", null);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("without a `resource`");
  });
});

describe("docs-for with mapping entries", () => {
  const REPO_ROOT = path.join(FIXTURES_DIR, "v02-mappings-footnotes");
  const BUNDLE_DIR = path.join(REPO_ROOT, "docs");

  it("returns the doc whose sources name the path as a mapping resource", () => {
    const result = runDocsFor(BUNDLE_DIR, ["src/client.ts"], {
      repoRoot: REPO_ROOT,
    });
    expect(result.matches).toEqual([
      {
        doc: "client.md",
        sources: ["src/client.ts"],
        via: ["sources"],
      },
    ]);
  });

  it("never matches a URL resource, and matches by directory containment like a string entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-docsfor-map-"));
    try {
      fs.mkdirSync(path.join(dir, "src", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "pkg", "x.ts"), "export {};\n");
      fs.mkdirSync(path.join(dir, "bundle"));
      fs.writeFileSync(
        path.join(dir, "bundle", "doc.md"),
        "---\ntype: concept\nsources:\n  - resource: src/pkg\n  - resource: https://example.com/src/pkg/x.ts\n---\n\nBody.\n",
      );
      const hit = runDocsFor(path.join(dir, "bundle"), ["src/pkg/x.ts"], {
        repoRoot: dir,
      });
      expect(hit.matches).toEqual([
        { doc: "doc.md", sources: ["src/pkg"], via: ["sources"] },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

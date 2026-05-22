import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMatcher,
  parseOpensrcList,
  searchCachedRepos,
} from "../src/opensrc.js";

describe("parseOpensrcList", () => {
  it("extracts repos and derives short names from Path lines", () => {
    const out = [
      "npm Packages:",
      "",
      "  zod@4.4.3",
      "    Path: /home/u/.opensrc/repos/github.com/colinhacks/zod/4.4.3",
      "    Fetched: May 22, 2026",
      "",
      "Repositories:",
      "",
      "  github.com/vercel/turborepo@main",
      "    Path: /home/u/.opensrc/repos/github.com/vercel/turborepo/main",
      "    Fetched: May 22, 2026",
    ].join("\n");
    expect(parseOpensrcList(out)).toEqual([
      {
        name: "zod",
        path: "/home/u/.opensrc/repos/github.com/colinhacks/zod/4.4.3",
      },
      {
        name: "turborepo",
        path: "/home/u/.opensrc/repos/github.com/vercel/turborepo/main",
      },
    ]);
  });
  it("returns an empty list for an empty cache", () => {
    expect(parseOpensrcList("No sources cached yet.\n")).toEqual([]);
  });
  it("derives names for crates entries from their github.com clone path", () => {
    const out = [
      "crates.io Packages:",
      "",
      "  clap@4.6.1",
      "    Path: /home/u/.opensrc/repos/github.com/clap-rs/clap/4.6.1",
    ].join("\n");
    expect(parseOpensrcList(out)).toEqual([
      {
        name: "clap",
        path: "/home/u/.opensrc/repos/github.com/clap-rs/clap/4.6.1",
      },
    ]);
  });
});

describe("buildMatcher", () => {
  it("matches the query as a literal substring by default", () => {
    const m = buildMatcher("a.b");
    expect(m.regex.test("xx a.b xx")).toBe(true);
    expect(m.regex.test("xx axb xx")).toBe(false);
  });
  it("treats an explicit pattern as a regex", () => {
    const m = buildMatcher("ignored", "registerTool\\(");
    expect(m.regex.test("server.registerTool(")).toBe(true);
  });
  it("throws on an invalid regex", () => {
    expect(() => buildMatcher("q", "(")).toThrow(/Invalid --pattern/);
  });
  it("throws on an empty query with no pattern", () => {
    expect(() => buildMatcher("")).toThrow(/empty/);
  });
});

describe("searchCachedRepos", () => {
  let root = "";
  afterEach(() => {
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("finds matching lines and tags them as exemplar hits", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-scout-repo-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "x.ts"),
      "line one\nconst needle = 1;\nline three",
    );
    const results = searchCachedRepos(
      [{ name: "demo", path: root }],
      buildMatcher("needle"),
      { limit: 10 },
    );
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("exemplar");
    expect(results[0].source).toBe("demo");
    expect(results[0].line).toBe(2);
    expect(results[0].snippet).toContain("needle");
    // `src/x.ts`, matched line is a bare `const` (a local binding) => usage
    expect(results[0].relevance.signals).toEqual(["impl-file", "usage"]);
  });

  it("respects the limit", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-scout-repo-"));
    fs.writeFileSync(path.join(root, "a.ts"), "x\nx\nx\nx");
    const results = searchCachedRepos(
      [{ name: "d", path: root }],
      buildMatcher("x"),
      { limit: 2 },
    );
    expect(results).toHaveLength(2);
  });

  it("filters by repo name", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-scout-repo-"));
    fs.writeFileSync(path.join(root, "a.ts"), "needle");
    const results = searchCachedRepos(
      [{ name: "demo", path: root }],
      buildMatcher("needle"),
      { limit: 10, repoFilter: "nomatch" },
    );
    expect(results).toHaveLength(0);
  });

  it("spreads results round-robin across repos rather than filling from the first", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-scout-repo-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-scout-repo-b-"));
    fs.writeFileSync(path.join(a, "f.ts"), "hit\nhit\nhit");
    fs.writeFileSync(path.join(b, "f.ts"), "hit\nhit\nhit");
    try {
      const results = searchCachedRepos(
        [
          { name: "repo-a", path: a },
          { name: "repo-b", path: b },
        ],
        buildMatcher("hit"),
        { limit: 4 },
      );
      expect(results).toHaveLength(4);
      expect(results.filter((r) => r.source === "repo-a")).toHaveLength(2);
      expect(results.filter((r) => r.source === "repo-b")).toHaveLength(2);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

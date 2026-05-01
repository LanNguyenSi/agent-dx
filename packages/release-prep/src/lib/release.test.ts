import { describe, expect, it } from "vitest";
import {
  buildChangelogJson,
  buildChangelogMarkdown,
  computeNextVersion,
  parseCommit,
  recommendVersionBump,
} from "./release.js";

describe("parseCommit", () => {
  it("parses conventional commits with scope and breaking marker", () => {
    const commit = parseCommit({
      hash: "abc123",
      shortHash: "abc123",
      subject: "feat(cli)!: add release command",
      body: "",
    });

    expect(commit.type).toBe("feat");
    expect(commit.scope).toBe("cli");
    expect(commit.description).toBe("add release command");
    expect(commit.breaking).toBe(true);
  });

  it("detects breaking changes from commit body", () => {
    const commit = parseCommit({
      hash: "abc123",
      shortHash: "abc123",
      subject: "fix: update release output",
      body: "BREAKING CHANGE: output format changed",
    });

    expect(commit.type).toBe("fix");
    expect(commit.breaking).toBe(true);
  });

  it("falls back to other for non-conventional commits", () => {
    const commit = parseCommit({
      hash: "abc123",
      shortHash: "abc123",
      subject: "Initial import",
      body: "",
    });

    expect(commit.type).toBe("other");
    expect(commit.description).toBe("Initial import");
  });
});

describe("recommendVersionBump", () => {
  it("prefers major over lower bumps", () => {
    const bump = recommendVersionBump([
      parseCommit({
        hash: "1",
        shortHash: "1",
        subject: "feat: add release notes",
        body: "",
      }),
      parseCommit({
        hash: "2",
        shortHash: "2",
        subject: "fix!: change tag naming",
        body: "",
      }),
    ]);

    expect(bump).toBe("major");
  });

  it("returns minor for features when there are no breaking changes", () => {
    const bump = recommendVersionBump([
      parseCommit({
        hash: "1",
        shortHash: "1",
        subject: "feat: add release notes",
        body: "",
      }),
    ]);

    expect(bump).toBe("minor");
  });

  it("returns patch for all other commits", () => {
    const bump = recommendVersionBump([
      parseCommit({
        hash: "1",
        shortHash: "1",
        subject: "docs: improve readme",
        body: "",
      }),
    ]);

    expect(bump).toBe("patch");
  });
});

describe("computeNextVersion", () => {
  it("increments versions from bumps", () => {
    expect(computeNextVersion("1.2.3", "major")).toBe("2.0.0");
    expect(computeNextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(computeNextVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  it("uses explicit versions when provided", () => {
    expect(computeNextVersion("1.2.3", "patch", "2.1.0")).toBe("2.1.0");
  });
});

describe("changelog builders", () => {
  it("creates grouped markdown and json output", () => {
    const commits = [
      parseCommit({
        hash: "1",
        shortHash: "1",
        subject: "feat(cli): add prep command",
        body: "",
      }),
      parseCommit({
        hash: "2",
        shortHash: "2",
        subject: "fix: handle empty tags",
        body: "",
      }),
    ];

    const context = {
      previousTag: "v1.2.3",
      currentVersion: "1.2.3",
      commits,
      recommendedBump: "minor" as const,
    };

    const markdown = buildChangelogMarkdown(context, "v1.3.0");
    const json = buildChangelogJson(context);

    expect(markdown).toContain("## v1.3.0");
    expect(markdown).toContain("### Features");
    expect(markdown).toContain("### Fixes");
    expect(json.commitCount).toBe(2);
    expect(json.groups).toHaveLength(2);
  });
});

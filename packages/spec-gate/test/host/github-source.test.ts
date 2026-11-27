import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENFORCEMENT_STATES,
  GITHUB_API_URL,
  GITHUB_API_VERSION,
  GITHUB_MAX_BODY_BYTES,
  GITHUB_MAX_PAGES,
  GITHUB_PAGE_SIZE,
  GITHUB_TIMEOUT_MS,
  REVIEW_STATES,
} from "../../src/host/index.js";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const source = fs.readFileSync(at("../../src/host/github.ts"), "utf8");
const doc = fs.readFileSync(at("../../docs/approve.md"), "utf8");

/** The section of the doc about the adapter: from its heading to the next of its level. */
function adapterSection(): string {
  const from = doc.indexOf("\n## GitHub adapter\n");
  expect(from).toBeGreaterThan(-1);
  const to = doc.indexOf("\n## ", from + 1);
  expect(to).toBeGreaterThan(from);
  return doc.slice(from, to);
}

describe("src/host/github.ts", () => {
  it("reaches the network at one place only, through the fetch it was given or the global one", () => {
    expect(source.match(/\bsend\(/g)).toHaveLength(1);
    expect(source).toContain("const send = options.fetch ?? globalThis.fetch;");
    // The type of the option and the default: no other use of the global.
    expect(source.match(/globalThis\.fetch/g)).toHaveLength(2);
    expect(source).not.toMatch(/\b(XMLHttpRequest|WebSocket|EventSource)\b/);
  });

  it("imports nothing but its own package, starts no process and writes nowhere", () => {
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).toMatch(/^\.{1,2}\//);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\b(console|process|child_process|eval)\b/);
    expect(source).not.toMatch(/\bnode:/);
  });

  it("sends GET only", () => {
    const methods = [...source.matchAll(/method: "([A-Z]+)"/g)].map(
      (m) => m[1],
    );
    expect(methods).toEqual(["GET"]);
    expect(source).not.toMatch(/"(POST|PUT|PATCH|DELETE)"/);
  });
});

describe('docs/approve.md, "GitHub adapter"', () => {
  // Line breaks of the prose are not part of what it says.
  const section = adapterSection().replace(/\s+/g, " ");

  it("names every request the adapter makes", () => {
    for (const request of [
      "`/pulls/{number}`",
      "`/pulls/{number}/reviews`",
      "`/rules/branches/{branch}`",
      "`/branches/{branch}/protection`",
      "`/commits?sha={branch}&path=.spec-gate&per_page=1`",
      "`/commits/{sha}/pulls`",
      "`/actions/runs/{id}`",
    ]) {
      expect(section, request).toContain(request);
    }
    // And the source asks for nothing the doc does not name.
    const asked = [...source.matchAll(/\$\{repoPath\}(\/[a-z/]+)/g)].map(
      (m) => m[1]!,
    );
    expect([...new Set(asked)].sort()).toEqual([
      "/actions/runs/",
      "/branches/",
      "/commits",
      "/commits/",
      "/pulls/",
      "/rules/branches/",
    ]);
  });

  it("names the limits with the values of the source", () => {
    expect(section).toContain(`\`${GITHUB_API_URL}\``);
    // The doc names the constant, not its value: the version is a date.
    expect(section).toContain("`X-GitHub-Api-Version` header that pins");
    expect(section).toContain("`GITHUB_API_VERSION` in `src/host/github.ts`");
    expect(GITHUB_API_VERSION).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    expect(section).toContain(`${GITHUB_TIMEOUT_MS / 1000} seconds`);
    expect(section).toContain(`${GITHUB_MAX_BODY_BYTES / (1024 * 1024)} MiB`);
    expect(section).toContain(`${GITHUB_PAGE_SIZE} entries at a time`);
    expect(section).toContain(`At most ${GITHUB_MAX_PAGES} pages`);
  });

  it("names the states, the enforcement rule and its limits", () => {
    for (const word of [...REVIEW_STATES, ...ENFORCEMENT_STATES, "PENDING"]) {
      expect(section, word).toContain(`\`${word}\``);
    }
    for (const phrase of [
      "required_approving_review_count",
      "`evaluate` or `disabled`",
      "A source is not readable when it answers 403 or 404",
      "does not tell the two apart",
      "A required code-owner review",
      "the answer is the same for `specs/` and `.spec-gate/`",
      "such as `.Spec-Gate`, is not seen here",
      "submitted on the head commit of the merged pull request (`head.sha`) and not after the merge (`merged_at`)",
      "cannot be read as reviews",
      "read only when the API root is `https://api.github.com`",
      "(a role, a team, an app, not only an administrator) can merge without the review while the adapter reports `enforced`",
      "`null` included, is refused",
      "Redirects are not followed",
      "`rate limited`",
      "With one of these headers a rate limit is never read as a missing permission",
      "It never holds the token, a response body or a header",
      "the token is never sent to an address taken from a header",
    ]) {
      expect(section, phrase).toContain(phrase);
    }
  });

  it("names the permissions and what a workflow token cannot read", () => {
    for (const phrase of [
      "`pull-requests: read`",
      "`contents: read`",
      "`actions: read`",
      "Administration: read",
      "The token of a workflow run cannot be given the administration permission",
      "gets `unknown`",
    ]) {
      expect(section, phrase).toContain(phrase);
    }
  });

  it("cites the sections of the GitHub REST documentation the mapping rests on", () => {
    for (const title of [
      "Get a pull request",
      "List reviews for a pull request",
      "Get rules for a branch",
      "Get branch protection",
      "List commits",
      "List pull requests associated with a commit",
      "Get a workflow run",
      "Using pagination in the REST API",
      "Rate limits for the REST API",
      "Troubleshooting the REST API",
      "Permissions required for fine-grained personal access tokens",
    ]) {
      expect(section, title).toContain(`"${title}"`);
    }
  });

  it("describes ciRunStatus with its two arguments and says the approval check does not call it", () => {
    expect(doc).toContain("`ciRunStatus(commit, run)`");
    expect(doc).not.toContain("ciRunStatus(ref)");
    expect(doc).toContain("the approval check does not call it");
  });
});

// Every third-party/first-party action referenced by a remote `uses:` in this
// repo's `.github/workflows/*.yml` and in the slop-detector composite action is
// pinned to a full 40-hex commit SHA with the version as a trailing comment, so
// a moving tag cannot silently change the code a runner fetches. A local `./`
// (or `../`) action is exempt: it is fetched with the repository itself, not
// from a ref that could move under it.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// A line that carries a `uses:` step key: an optional `- ` list dash, then the
// `uses:` key. A comment line starts with `#`, so it never matches here even
// when its prose mentions `uses:`.
const USES_LINE_RE = /^\s*(?:-\s+)?uses:\s*(.*)$/;

// A correctly pinned remote ref: `owner/repo` (plus an optional subpath) at
// exactly a full 40-hex commit SHA. `{40}` is exact on purpose: a short SHA or
// an otherwise-truncated pin is not a full commit pin.
const PINNED_REF_RE =
  /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._/-]+)?@[0-9a-f]{40}$/;

// The required trailing `# v<version>` annotation, matched on the comment text
// (which begins at the `#`).
const VERSION_COMMENT_RE = /^#\s*v\d/i;

/**
 * The remote `uses:` values in `text` that are not a full 40-hex SHA pin with
 * a `# v<version>` comment. Local `./`/`../` actions are skipped. Each finding
 * names the line and the offending value, so a failure points at one site.
 */
function findUnpinnedRemoteUses(text: string): string[] {
  const findings: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = USES_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const rest = m[1];
    // A `uses:` value never contains `#`, so the first `#` starts the trailing
    // comment and everything before it is the value.
    const hashIndex = rest.indexOf("#");
    const value = (hashIndex === -1 ? rest : rest.slice(0, hashIndex)).trim();
    const comment = hashIndex === -1 ? "" : rest.slice(hashIndex).trim();
    if (value === "") continue;
    if (value.startsWith("./") || value.startsWith("../")) continue;
    const bare = value.replace(/^["']/, "").replace(/["']$/, "");
    if (!PINNED_REF_RE.test(bare)) {
      findings.push(`line ${i + 1}: unpinned remote uses: ${value}`);
      continue;
    }
    if (!VERSION_COMMENT_RE.test(comment)) {
      findings.push(
        `line ${i + 1}: SHA-pinned remote uses: missing "# v<version>" comment: ${value}`,
      );
    }
  }
  return findings;
}

/** Counts the correctly pinned remote `uses:` sites (sanity: not vacuous). */
function pinnedRemoteUsesCount(text: string): number {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = USES_LINE_RE.exec(line);
    if (!m) continue;
    const rest = m[1];
    const hashIndex = rest.indexOf("#");
    const value = (hashIndex === -1 ? rest : rest.slice(0, hashIndex)).trim();
    if (value.startsWith("./") || value.startsWith("../")) continue;
    const bare = value.replace(/^["']/, "").replace(/["']$/, "");
    if (PINNED_REF_RE.test(bare)) count++;
  }
  return count;
}

function targetFiles(): string[] {
  const workflows = readdirSync(`${repoRoot}/.github/workflows`)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => `.github/workflows/${name}`);
  return [...workflows, "packages/slop-detector/action/action.yml"];
}

describe("every remote uses: in this repo is SHA-pinned with a version comment", () => {
  it("finds no unpinned or comment-less remote uses: across the workflows and the composite action", () => {
    const findings: string[] = [];
    for (const rel of targetFiles()) {
      const text = readFileSync(`${repoRoot}/${rel}`, "utf8");
      for (const f of findUnpinnedRemoteUses(text))
        findings.push(`${rel}: ${f}`);
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  it("scans a non-trivial number of pinned remote sites (sanity: not vacuously true)", () => {
    let pinned = 0;
    for (const rel of targetFiles()) {
      pinned += pinnedRemoteUsesCount(
        readFileSync(`${repoRoot}/${rel}`, "utf8"),
      );
    }
    expect(pinned).toBeGreaterThan(30);
  });
});

describe("findUnpinnedRemoteUses fixture cases", () => {
  it("accepts a full SHA pin with a version comment", () => {
    expect(
      findUnpinnedRemoteUses(
        "      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0",
      ),
    ).toEqual([]);
  });

  it("flags a moving-major tag pin", () => {
    expect(
      findUnpinnedRemoteUses("      - uses: actions/checkout@v5"),
    ).toHaveLength(1);
  });

  it("flags a branch ref pin", () => {
    expect(
      findUnpinnedRemoteUses("      - uses: some-owner/some-repo@main"),
    ).toHaveLength(1);
  });

  it("flags a 39-hex SHA (one character short of a full commit SHA)", () => {
    expect(
      findUnpinnedRemoteUses(
        "      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c0 # v5.1.0",
      ),
    ).toHaveLength(1);
  });

  it("exempts a local ./ action", () => {
    expect(
      findUnpinnedRemoteUses("      - uses: ./packages/slop-detector/action"),
    ).toEqual([]);
  });
});

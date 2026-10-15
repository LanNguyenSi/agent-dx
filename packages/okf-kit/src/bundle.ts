import fs from "node:fs";
import path from "node:path";
import YAML, { isScalar } from "yaml";
import { isRecord } from "./util.js";
import type {
  BundleContext,
  BundleDoc,
  FrontmatterInfo,
  RunGit,
  SpecVersion,
} from "./types.js";

const RESERVED_BASENAMES = new Set(["index.md", "log.md"]);

/**
 * The OKF spec versions this tool knows, in the exact spelling a bundle-root
 * `index.md` must use for them (also what a finding names as supported).
 */
export const SUPPORTED_OKF_VERSION_TEXTS = ["0.1", "0.2"] as const;

export function loadBundle(
  bundleDir: string,
  repoRoot?: string,
  runGit?: RunGit,
): BundleContext {
  const files = walkMarkdownFiles(bundleDir);
  const docs: BundleDoc[] = files.map((absPath) => {
    const relPath = path.relative(bundleDir, absPath).split(path.sep).join("/");
    const basename = path.basename(absPath);
    const raw = fs.readFileSync(absPath, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    return {
      relPath,
      basename,
      isReserved: RESERVED_BASENAMES.has(basename),
      raw,
      frontmatter,
      body,
    };
  });
  docs.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    bundleDir,
    repoRoot,
    docs,
    runGit,
    specVersion: detectSpecVersion(docs),
  };
}

/** One bundle-root `okf_version` value, as read from a doc's frontmatter. */
export interface OkfVersionRead {
  /** The supported version the value declares, undefined when it declares none (an unrecognized value, a non-scalar, no frontmatter, an unparseable block). */
  version?: (typeof SUPPORTED_OKF_VERSION_TEXTS)[number];
  /** The value as the frontmatter spells it, for naming in a finding. */
  text: string;
}

/**
 * Reads the `okf_version` value of a bundle-root `index.md` frontmatter,
 * accepting both the quoted-string form (`okf_version: "0.2"`) and the YAML
 * number form (`okf_version: 0.2`). A NUMBER is recognized only when the raw
 * frontmatter spells one of the supported versions exactly: YAML resolves
 * `0.20` (or `0.200`) to the number `0.2`, so the parsed value alone would
 * read a misspelling as a v0.2 declaration. A string needs no such check
 * because YAML keeps its text, quotes and all.
 */
export function readOkfVersion(frontmatter: FrontmatterInfo): OkfVersionRead {
  const value = isRecord(frontmatter.parsed)
    ? frontmatter.parsed.okf_version
    : undefined;
  if (typeof value === "string") return asOkfVersion(value.trim());
  if (typeof value === "number") {
    const raw = rawOkfVersionText(frontmatter.yaml);
    const text = raw === undefined || raw.trim() === "" ? String(value) : raw;
    return asOkfVersion(text);
  }
  return { text: describeOkfVersionValue(value) };
}

function asOkfVersion(text: string): OkfVersionRead {
  const version = SUPPORTED_OKF_VERSION_TEXTS.find((v) => v === text);
  return version === undefined ? { text } : { version, text };
}

/**
 * The raw `okf_version` scalar as the frontmatter spells it, read through the
 * YAML AST rather than a line regex, so a trailing comment (`0.2 # current`),
 * a flow-style block (`{ okf_version: 0.2 }`) and an `okf_version:` line
 * anywhere outside this block never confuse it. Undefined when the key is
 * absent or is not a scalar.
 */
function rawOkfVersionText(yamlText: string | undefined): string | undefined {
  if (yamlText === undefined) return undefined;
  try {
    const node = YAML.parseDocument(yamlText).getIn(["okf_version"], true);
    if (!isScalar(node) || !node.range) return undefined;
    return yamlText.slice(node.range[0], node.range[1]);
  } catch {
    // A block this reader cannot walk declares nothing; the caller falls back
    // to the parsed value's text.
    return undefined;
  }
}

/** How an `okf_version` value that is neither a string nor a number is named in a finding. */
function describeOkfVersionValue(value: unknown): string {
  if (value === null) return "(no value)";
  if (value === undefined) return "(absent)";
  if (typeof value === "object")
    return Array.isArray(value) ? "(a list)" : "(a mapping)";
  return String(value);
}

/**
 * The OKF spec version declared by the bundle: the bundle-root `index.md`
 * frontmatter's `okf_version` key (OKF v0.2), accepted in both the YAML
 * number form (`okf_version: 0.2`, spelled exactly that -- see
 * `readOkfVersion`) and the quoted-string form (`okf_version: "0.2"`). No key,
 * no frontmatter, an unparseable block, a non-root `index.md` (only the BUNDLE
 * ROOT declares the version), or a value that is neither `0.1` nor `0.2` all
 * resolve to `v0.1`: the absent case is the entire existing corpus, which
 * predates the key, and an unrecognized value (a future `0.3`, a typo, a `0.20`
 * that YAML parses to 0.2) must not silently promote the bundle to v0.2 rule
 * semantics -- `reserved-files-bare` reports it by name, so the author is not
 * left with the generic "reserved file must not carry a frontmatter block"
 * error as the only hint. `runCheck` may replace this with the explicit
 * `--spec` override.
 */
function detectSpecVersion(docs: BundleDoc[]): SpecVersion {
  const rootIndex = docs.find((doc) => doc.relPath === "index.md");
  if (!rootIndex) return "v0.1";
  return readOkfVersion(rootIndex.frontmatter).version === "0.2"
    ? "v0.2"
    : "v0.1";
}

function walkMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A frontmatter block is the first line being exactly `---` up to the next
 * line that is exactly `---`. Anything else (no opening delimiter, or an
 * opening delimiter with no matching close) counts as no frontmatter block
 * at all, per the OKF v0.1 shape rule.
 *
 * Exported so `sources-fresh` can apply the IDENTICAL parse to a historical
 * blob (`git show <sha>:<path>`) that `loadBundle` applies to the working-tree
 * file: the rule's re-stamp test compares the parsed frontmatter `timestamp`
 * VALUE across a commit boundary, and a second, subtly different parser there
 * would decide freshness by a different notion of "frontmatter" than the rest
 * of the tool.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: FrontmatterInfo;
  body: string;
} {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { frontmatter: { present: false }, body: raw };
  }
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    return { frontmatter: { present: false }, body: raw };
  }
  const yamlText = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n");
  try {
    const parsed = YAML.parse(yamlText);
    return { frontmatter: { present: true, parsed, yaml: yamlText }, body };
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    return { frontmatter: { present: true, parseError, yaml: yamlText }, body };
  }
}

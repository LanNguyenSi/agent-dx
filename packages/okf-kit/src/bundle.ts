import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { isRecord } from "./util.js";
import type {
  BundleContext,
  BundleDoc,
  FrontmatterInfo,
  RunGit,
  SpecVersion,
} from "./types.js";

const RESERVED_BASENAMES = new Set(["index.md", "log.md"]);

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

/**
 * The OKF spec version declared by the bundle: the bundle-root `index.md`
 * frontmatter's `okf_version` key (OKF v0.2), accepted in both the YAML
 * number form (`okf_version: 0.2`) and the quoted-string form
 * (`okf_version: "0.2"`). No key, no frontmatter, an unparseable block, a
 * non-root `index.md` (only the BUNDLE ROOT declares the version), or a
 * value that is neither `0.1` nor `0.2` all resolve to `v0.1`: the absent
 * case is the entire existing corpus, which predates the key, and an
 * unrecognized value (a future `0.3`, a typo) must not silently promote the
 * bundle to v0.2 rule semantics. `runCheck` may replace this with the
 * explicit `--spec` override.
 */
function detectSpecVersion(docs: BundleDoc[]): SpecVersion {
  const rootIndex = docs.find((doc) => doc.relPath === "index.md");
  const parsed = rootIndex?.frontmatter.parsed;
  if (!isRecord(parsed) || !("okf_version" in parsed)) return "v0.1";
  const value = parsed.okf_version;
  const text =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  return text === "0.2" ? "v0.2" : "v0.1";
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
    return { frontmatter: { present: true, parsed }, body };
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    return { frontmatter: { present: true, parseError }, body };
  }
}

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { BundleContext, BundleDoc, FrontmatterInfo } from "./types.js";

const RESERVED_BASENAMES = new Set(["index.md", "log.md"]);

export function loadBundle(
  bundleDir: string,
  repoRoot?: string,
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
  return { bundleDir, repoRoot, docs };
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
 */
function parseFrontmatter(raw: string): {
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

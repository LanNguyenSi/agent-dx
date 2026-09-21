import path from "node:path";
import type { FileKind, ResolvedConfig } from "../types.js";

const PROSE_EXT = new Set([".md", ".mdx", ".markdown", ".txt", ".rst"]);
const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".json",
  ".jsonc",
  ".json5",
  ".env",
  ".conf",
  ".config",
]);
const STYLE_EXT = new Set([".css", ".scss", ".sass", ".less"]);
const MARKUP_EXT = new Set([".html", ".htm", ".vue", ".svelte"]);
const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp4",
  ".mp3",
  ".wav",
  ".bin",
  ".so",
  ".dll",
  ".node",
]);

export function detectFileKind(
  filePath: string,
  config?: ResolvedConfig,
  /**
   * The config-pattern anchor from `resolvePatternAnchor` (present only
   * when a `--config`/`configPath` was given AND `filePath` lies inside
   * that config's directory). When given, `treatAsProse`/`treatAsCode`
   * match `filePath` relativized to it, so an absolute or
   * differently-spelled file argument is judged the same way a directory
   * scan of the same target judges it. When omitted, both families match
   * `filePath` exactly as spelled, the pre-existing behavior, preserved
   * so a caller with no config anchor (or one outside its directory) sees
   * no change.
   */
  anchor?: string,
): FileKind {
  const anchored = anchor
    ? path.relative(anchor, path.resolve(filePath)).split(path.sep).join("/")
    : filePath.split(path.sep).join("/");
  if (config?.treatAsProse.some((p) => matchesGlob(anchored, p)))
    return "prose";
  if (config?.treatAsCode.some((p) => matchesGlob(anchored, p))) return "code";

  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXT.has(ext)) return "binary";
  if (PROSE_EXT.has(ext)) return "prose";
  if (STYLE_EXT.has(ext)) return "style";
  if (MARKUP_EXT.has(ext)) return "markup";
  if (CODE_EXT.has(ext)) return "code";

  const base = path.basename(filePath).toLowerCase();
  if (base.startsWith("readme") || base === "changelog" || base === "license")
    return "prose";
  if (base === "dockerfile" || base.endsWith(".env") || base === "makefile")
    return "code";

  return "prose";
}

function matchesGlob(filePath: string, glob: string): boolean {
  const re = globToRegex(glob);
  return re.test(filePath);
}

export function globToRegex(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          // `**/` matches zero or more *whole* path segments, not an
          // arbitrary substring — `.*` alone let `**/AGENTS.md` match
          // `docs/SUBAGENTS.md` (".*" happily eats "docs/SUB" and leaves
          // a literal "AGENTS.md" suffix match) even though "SUBAGENTS.md"
          // is a different filename on a different segment boundary.
          // `(?:.*/)?` only ever stops right after a "/", so what follows
          // must start a fresh path segment.
          re += "(?:.*/)?";
          i++;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^$|()[]{}\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

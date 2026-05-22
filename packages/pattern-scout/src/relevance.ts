import { extname } from "node:path";
import type { Relevance } from "./types.js";

/** Coarse category of the file a hit came from. */
export type PathCategory =
  | "impl"
  | "test"
  | "example"
  | "doc"
  | "config"
  | "other";

/** Where in a source line a match sits, structurally. */
export type MatchContext = "definition" | "usage" | "comment";

const TEST_SEGMENTS = new Set(["test", "tests", "spec", "specs", "__tests__"]);
const EXAMPLE_SEGMENTS = new Set([
  "example",
  "examples",
  "demo",
  "demos",
  "samples",
]);
const DOC_SEGMENTS = new Set(["doc", "docs"]);
const IMPL_SEGMENTS = new Set(["src", "lib", "source"]);
const CONFIG_EXTENSIONS = new Set([".json", ".yml", ".yaml", ".toml"]);

/**
 * Classify a file path into a coarse category. Check order matters: a file
 * like `src/foo.test.ts` is test code, not impl, so `test` is checked first.
 */
export function classifyPath(filePath: string): PathCategory {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const base = segments[segments.length - 1] || normalized;

  if (
    /\.(test|spec)\.[a-z0-9]+$/.test(base) ||
    segments.some((s) => TEST_SEGMENTS.has(s))
  ) {
    return "test";
  }
  if (segments.some((s) => EXAMPLE_SEGMENTS.has(s))) {
    return "example";
  }
  if (
    base.endsWith(".md") ||
    base.endsWith(".mdx") ||
    segments.some((s) => DOC_SEGMENTS.has(s))
  ) {
    return "doc";
  }
  if (segments.includes(".github") || CONFIG_EXTENSIONS.has(extname(base))) {
    return "config";
  }
  if (segments.some((s) => IMPL_SEGMENTS.has(s))) {
    return "impl";
  }
  return "other";
}

// Unambiguous comment-line markers for the JS/TS/Rust/Go-dominant corpus
// pattern-scout fetches. Deliberately excludes `#` (Rust `#[attr]` and TS
// `#field` are not comments) and `--` / `;` (too ambiguous to be reliable).
const COMMENT_PREFIXES = ["//", "/*", "*", "<!--"];

// A trimmed line starting like this is a declaration. Approximate by design:
// regex, no AST. Covers JS/TS, Python, Rust, Go.
const DECLARATION_RE =
  /^(?:export\s+|default\s+|pub\s+|public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:function|class|interface|type|enum|struct|trait|impl|module|namespace|def|fn|func)\s/;

// `const` / `let` / `var` / `static` count as a declaration only when
// exported. A bare `const x = foo()` is a local binding, i.e. a usage, not
// the definition of the symbol being searched for; counting it as a
// definition would inflate the strongest signal on the weakest evidence.
const EXPORTED_BINDING_RE =
  /^(?:export|pub|public)\s+(?:default\s+|static\s+|async\s+)*(?:const|let|var|static)\s/;

/**
 * Heuristic classification of a matched source line: declaration, comment,
 * or plain usage. Regex-only, no AST, so it is approximate by design.
 */
export function classifyMatchLine(line: string): MatchContext {
  const trimmed = line.trim();
  if (COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return "comment";
  }
  if (DECLARATION_RE.test(trimmed) || EXPORTED_BINDING_RE.test(trimmed)) {
    return "definition";
  }
  return "usage";
}

const CATEGORY_PHRASE: Record<PathCategory, string> = {
  impl: "an implementation file",
  test: "test code",
  example: "example code",
  doc: "documentation",
  config: "a config file",
  other: "the source",
};

const CONTEXT_PHRASE: Record<MatchContext, string> = {
  definition: "definition",
  usage: "usage",
  comment: "comment mention",
};

/**
 * Build the relevance hint for an exemplar (opensrc, lexical) hit. Combines
 * where the file sits with what the matched line structurally looks like, so
 * an agent can tell "definition in an implementation file" from "comment
 * mention in test code" and weight the hit accordingly.
 */
export function exemplarRelevance(filePath: string, line: string): Relevance {
  const category = classifyPath(filePath);
  const context = classifyMatchLine(line);
  return {
    reason: `${CONTEXT_PHRASE[context]} in ${CATEGORY_PHRASE[category]}`,
    signals: [`${category}-file`, context],
  };
}

/** Build the relevance hint for an oracle (codebase-oracle, semantic) hit. */
export function oracleRelevance(filePath: string): Relevance {
  const category = classifyPath(filePath);
  return {
    reason: `semantic match in ${CATEGORY_PHRASE[category]} (codebase-oracle)`,
    signals: ["semantic", `${category}-file`],
  };
}

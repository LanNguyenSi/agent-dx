import { parse } from "@typescript-eslint/parser";
import type { TSESTree } from "@typescript-eslint/types";
import type { FileTarget } from "../types.js";

const CODE_EXTENSIONS = [".ts", ".tsx", ".cts", ".mts", ".js", ".jsx", ".cjs", ".mjs"];

export type ParsedTsFile = TSESTree.Program & {
  comments?: TSESTree.Comment[];
  tokens?: TSESTree.Token[];
};

export interface ParseResult {
  ok: true;
  ast: ParsedTsFile;
}

export interface ParseFailure {
  ok: false;
  error: string;
}

export function isTypeScriptOrJavaScript(file: FileTarget): boolean {
  if (file.kind !== "code") return false;
  const lower = file.path.toLowerCase();
  return CODE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// One parse per file across the rule loop. The engine runs every rule of a
// pack against the same FileTarget object reference, so a WeakMap keyed by
// the target is sufficient — no need to plumb a parsed AST through
// RuleContext.
const parseCache = new WeakMap<FileTarget, ParseResult | ParseFailure>();

export function parseTsFile(file: FileTarget): ParseResult | ParseFailure {
  const cached = parseCache.get(file);
  if (cached) return cached;
  const isTsx = file.path.toLowerCase().endsWith(".tsx") || file.path.toLowerCase().endsWith(".jsx");
  let result: ParseResult | ParseFailure;
  try {
    const ast = parse(file.text, {
      loc: true,
      range: true,
      comment: true,
      tokens: false,
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: { jsx: isTsx },
    }) as ParsedTsFile;
    result = { ok: true, ast };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  parseCache.set(file, result);
  return result;
}

export type AnyNode = TSESTree.Node;

export function walk(node: AnyNode, visit: (node: AnyNode, parent: AnyNode | null) => void): void {
  function recurse(current: AnyNode, parent: AnyNode | null): void {
    visit(current, parent);
    for (const key of Object.keys(current)) {
      if (key === "parent" || key === "loc" || key === "range") continue;
      const value = (current as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string") {
            recurse(item as AnyNode, current);
          }
        }
      } else if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string") {
        recurse(value as AnyNode, current);
      }
    }
  }
  recurse(node, null);
}


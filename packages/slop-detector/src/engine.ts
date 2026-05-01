import fs from "node:fs";
import path from "node:path";
import type {
  CheckSummary,
  FileTarget,
  PackDefinition,
  ResolvedConfig,
  Rule,
  Violation,
} from "./types.js";
import { effectiveSeverity, isRuleEnabled } from "./config.js";
import { detectFileKind, globToRegex } from "./util/file-kind.js";
import { buildDisableMap } from "./util/disable-comments.js";

export interface CheckOptions {
  packs: PackDefinition[];
  config: ResolvedConfig;
  packFilter?: string[];
}

export function checkText(
  text: string,
  filePath: string,
  options: CheckOptions,
): Violation[] {
  const file: FileTarget = {
    path: filePath,
    text,
    kind: detectFileKind(filePath, options.config),
  };
  if (file.kind === "binary") return [];

  const disable = buildDisableMap(text);
  const violations: Violation[] = [];

  for (const pack of options.packs) {
    if (options.packFilter && !options.packFilter.includes(pack.id)) continue;
    if (!options.config.packs[pack.id]) continue;

    for (const rule of pack.rules) {
      if (!isRuleEnabled(rule.id, rule.pack, rule.enabledByDefault, options.config)) continue;
      if (!rule.appliesTo(file)) continue;

      const ruleViolations = runRule(rule, { file, config: options.config });
      for (const v of ruleViolations) {
        if (disable.lineDisabled(v.line, v.ruleId, v.pack)) continue;
        v.severity = effectiveSeverity(rule.id, rule.defaultSeverity, options.config);
        violations.push(v);
      }
    }
  }

  return violations;
}

function runRule(rule: Rule, ctx: { file: FileTarget; config: ResolvedConfig }): Violation[] {
  try {
    return rule.check(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Rule ${rule.id} failed on ${ctx.file.path}: ${msg}`);
  }
}

export function checkFiles(
  files: string[],
  options: CheckOptions,
): CheckSummary {
  const violations: Violation[] = [];
  let scanned = 0;
  for (const filePath of files) {
    const text = fs.readFileSync(filePath, "utf8");
    violations.push(...checkText(text, filePath, options));
    scanned++;
  }
  return summarize(violations, scanned);
}

export function checkPath(
  rootPath: string,
  options: CheckOptions,
): CheckSummary {
  const files = walk(rootPath, options.config);
  return checkFiles(files, options);
}

export function summarize(violations: Violation[], filesScanned: number): CheckSummary {
  return {
    filesScanned,
    violations,
    blockCount: violations.filter((v) => v.severity === "block").length,
    warnCount: violations.filter((v) => v.severity === "warn").length,
    infoCount: violations.filter((v) => v.severity === "info").length,
  };
}

function walk(rootPath: string, config: ResolvedConfig): string[] {
  const stat = fs.statSync(rootPath);
  if (stat.isFile()) {
    return shouldIgnore(rootPath, config, false) ? [] : [rootPath];
  }
  const out: string[] = [];
  const stack: string[] = [rootPath];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const isDir = entry.isDirectory();
      if (shouldIgnore(full, config, isDir)) continue;
      if (isDir) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function shouldIgnore(filePath: string, config: ResolvedConfig, isDirectory: boolean): boolean {
  const normalized = filePath.split(path.sep).join("/");
  const candidates = isDirectory ? [normalized, normalized + "/"] : [normalized];
  return config.ignorePaths.some((glob) => {
    const re = globToRegex(glob);
    if (candidates.some((c) => re.test(c))) return true;
    if (isDirectory && glob.endsWith("/**")) {
      const dirGlob = glob.slice(0, -3);
      if (globToRegex(dirGlob).test(normalized)) return true;
    }
    return false;
  });
}

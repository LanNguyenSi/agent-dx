import path from "node:path";

/**
 * The one rule every entry point (`cli.ts`'s file and stdin branches,
 * `mcp-check.ts`'s path and text branches) derives its config-pattern
 * anchor through: when a `--config`/`configPath` is given AND the target
 * lies inside that config file's own directory, every path pattern in the
 * config (`review.allowPaths`, `placement.instructionGlobs`,
 * `entrypointGlobs`, `ignorePaths`, `treatAsProse`, `treatAsCode`) is
 * matched against the target's path made relative to the config file's
 * directory, and this function returns that directory. Otherwise (no config
 * file, or a target outside the config file's directory) this returns
 * `undefined`, so a caller falls back to whatever per-target resolution it
 * used before this anchor existed (see `engine.ts`'s `resolveScanRoot`/
 * `resolveScanRootForFile`, and `shouldIgnore`/`detectFileKind`'s
 * as-spelled matching when no anchor is passed).
 *
 * "Inside the config file's directory" is decided on resolved absolute
 * paths (`path.resolve`, no `fs.realpathSync`): a symlinked target is
 * judged by the path it was spelled with, not by where it ultimately
 * points.
 */
export function resolvePatternAnchor(
  configPath: string | undefined,
  targetPath: string,
): string | undefined {
  if (!configPath) return undefined;
  const configDir = path.dirname(path.resolve(configPath));
  const absTarget = path.resolve(targetPath);
  const rel = path.relative(configDir, absTarget);
  const isContained =
    rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return isContained ? configDir : undefined;
}

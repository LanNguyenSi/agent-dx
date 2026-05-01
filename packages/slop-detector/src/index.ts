export type {
  CheckSummary,
  FileKind,
  FileTarget,
  PackDefinition,
  PackId,
  ResolvedConfig,
  Rule,
  RuleContext,
  Severity,
  Violation,
} from "./types.js";

export { checkText, checkFiles, checkPath, summarize } from "./engine.js";
export type { CheckOptions } from "./engine.js";

export { defaultConfig, loadConfig, mergeConfig } from "./config.js";
export type { ConfigFile } from "./config.js";

export { agentTicsPack } from "./packs/agent-tics.js";
export { proseSlopPack } from "./packs/prose-slop.js";
export { allPacks, packsByFilter } from "./packs/registry.js";

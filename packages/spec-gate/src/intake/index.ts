export { errnoCode, IntakeError } from "./errors.js";
export { diffSourceLines } from "./drift.js";
export type { DriftResult } from "./drift.js";
export {
  gitEnv,
  GIT_TIMEOUT_MS,
  gitToplevel,
  parseFetchHead,
  ProcessFailure,
  remoteBaseCommit,
  runProcess,
} from "./git.js";
export {
  DEFAULT_GIT_TIMEOUT_SECONDS,
  GIT_TIMEOUT_ENV,
  resolveGitTimeoutMs,
} from "./timeout.js";
export { parseRecordedMeta, serializeMeta, sha256Hex } from "./meta.js";
export type {
  SourceAttachment,
  SourceLineRef,
  SourceMeta,
  SourceSection,
} from "./meta.js";
export { assertScannableText, findSecret, SECRET_PATTERNS } from "./secrets.js";
export type { SecretHit, SecretPattern } from "./secrets.js";
export { writeSource } from "./write.js";
export type { SourceFiles } from "./write.js";

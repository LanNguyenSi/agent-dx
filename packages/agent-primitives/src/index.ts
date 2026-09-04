export { doctor } from "./doctor/index.js";
export type {
  DoctorOptions,
  DoctorResult,
  ToolCheck,
  DoctorCheckItem,
} from "./doctor/index.js";
export {
  applyCaps,
  buildEnvelope,
  currentRunId,
  statusClass,
  exitCodeForStatus,
  TOOL_NAME,
  UsageError,
} from "./envelope.js";
export type {
  CapLimits,
  EnvelopeInput,
  EnvelopeOutput,
  StatusClass,
} from "./envelope.js";
export { execCommand } from "./exec.js";
export type { ExecOptions, ExecResult } from "./exec.js";
export { sha256File } from "./hash.js";
export {
  verify,
  selectDetector,
  genericDetector,
  DEFAULT_CHECKS,
  DEFAULT_MAX_FAILURES,
} from "./verify/index.js";
export type {
  CheckResult,
  CheckStatus,
  Detector,
  DetectorInput,
  DetectorParseResult,
  ExecLike,
  Failure,
  Summary,
  VerifyOptions,
  VerifyResult,
  VerifyStatus,
} from "./verify/index.js";
export {
  acquireLock,
  isPidAlive,
  listMarkers,
  markerFilePathFor,
} from "./lock.js";
export type {
  AcquireLockResult,
  LockDirDeps,
  MarkerData,
  MarkerEntry,
} from "./lock.js";
export { probe, probePlan } from "./probe/index.js";
export type {
  ExpectVerdict,
  ExecPhaseField,
  IsolationField,
  IsolationMode,
  MutantField,
  MutationProbeField,
  PlanMutantResult,
  PlanMutantStatus,
  PlanSummaryField,
  ProbeOptions,
  ProbePlanOptions,
  ProbePlanResult,
  ProbeResult,
  ProbeStatus,
  TestPhaseField,
} from "./probe/index.js";
export { parsePlanFile, PLAN_MAX_BYTES } from "./probe/plan.js";
export type {
  PlanMutantSpec,
  PlanParseResult,
  PlanParseFailureReason,
  ProbePlanSpec,
} from "./probe/plan.js";
export { init, ALL_HARNESSES, InitFsUsageError } from "./init/index.js";
export type {
  Harness,
  InitFsErrorReason,
  InitOptions,
  InitResult,
  InitTargetResult,
  InitTargetStatus,
} from "./init/index.js";

import path from "node:path";
import { UsageError } from "../envelope.js";

export const SNAPSHOT_FORMAT = "agent-primitives-snapshot/v1";
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const MAX_ENTRIES = 100000;
export interface CheckoutIdentity {
  root: string;
  gitDir: string;
  commonDir: string;
}
export interface IndexEntry {
  path: string;
  stage: number;
  mode: string;
  oid: string;
}
export interface WorkingEntry {
  path: string;
  type: "file" | "symlink" | "missing";
  executable: boolean;
  hash: string | null;
}
export interface SnapshotArtifact {
  format: typeof SNAPSHOT_FORMAT;
  hashAlgorithm: "sha256";
  objectFormat: "sha1" | "sha256";
  capturedAt: string;
  checkout: CheckoutIdentity;
  head: string | null;
  branch: string | null;
  index: IndexEntry[];
  untracked: string[];
  workingTree: WorkingEntry[];
}
export function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 4096 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    value
      .split("/")
      .every((p) => p !== "" && p !== "." && p !== ".." && p !== ".git") &&
    !/[\uD800-\uDFFF]/u.test(
      value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
    )
  );
}
function invalid(): never {
  throw new UsageError("invalid or unsupported snapshot artifact");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join() !== expected.sort().join()) invalid();
}
function entries(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) invalid();
  return value;
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) invalid();
}
export function validateSnapshot(value: unknown): SnapshotArtifact {
  const v = object(value);
  keys(v, [
    "format",
    "hashAlgorithm",
    "objectFormat",
    "capturedAt",
    "checkout",
    "head",
    "branch",
    "index",
    "untracked",
    "workingTree",
  ]);
  if (
    v.format !== SNAPSHOT_FORMAT ||
    v.hashAlgorithm !== "sha256" ||
    typeof v.objectFormat !== "string" ||
    !["sha1", "sha256"].includes(v.objectFormat)
  )
    invalid();
  const oid = new RegExp(`^[0-9a-f]{${v.objectFormat === "sha1" ? 40 : 64}}$`);
  if (v.head !== null && (typeof v.head !== "string" || !oid.test(v.head)))
    invalid();
  if (
    v.branch !== null &&
    (typeof v.branch !== "string" ||
      !v.branch.startsWith("refs/heads/") ||
      v.branch.length > 4096 ||
      /[\x00-\x20\x7f]/.test(v.branch))
  )
    invalid();
  if (
    typeof v.capturedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.capturedAt) ||
    !Number.isFinite(Date.parse(v.capturedAt))
  )
    invalid();
  const identity = object(v.checkout);
  keys(identity, ["root", "gitDir", "commonDir"]);
  for (const p of Object.values(identity))
    if (
      typeof p !== "string" ||
      p.length > 16384 ||
      p.includes("\0") ||
      !path.isAbsolute(p) ||
      path.normalize(p) !== p
    )
      invalid();
  const index = entries(v.index).map((item) => {
    const e = object(item);
    keys(e, ["path", "stage", "mode", "oid"]);
    if (
      !safePath(e.path) ||
      !Number.isInteger(e.stage) ||
      Number(e.stage) < 0 ||
      Number(e.stage) > 3 ||
      typeof e.mode !== "string" ||
      !["100644", "100755", "120000"].includes(e.mode) ||
      typeof e.oid !== "string" ||
      !oid.test(e.oid)
    )
      invalid();
    return e as unknown as IndexEntry;
  });
  unique(index.map((e) => `${e.path}\0${e.stage}`));
  const stages = new Map<string, number[]>();
  for (const e of index)
    stages.set(e.path, [...(stages.get(e.path) ?? []), e.stage]);
  for (const s of stages.values()) if (s.includes(0) && s.length > 1) invalid();
  const untracked = entries(v.untracked);
  for (const p of untracked) if (!safePath(p) || stages.has(p)) invalid();
  unique(untracked as string[]);
  const union = new Set([...stages.keys(), ...(untracked as string[])]);
  const workingTree = entries(v.workingTree).map((item) => {
    const e = object(item);
    keys(e, ["path", "type", "executable", "hash"]);
    if (
      !safePath(e.path) ||
      !union.has(e.path) ||
      typeof e.type !== "string" ||
      !["file", "symlink", "missing"].includes(e.type) ||
      typeof e.executable !== "boolean"
    )
      invalid();
    if (e.type === "missing") {
      if (e.hash !== null || e.executable || untracked.includes(e.path))
        invalid();
    } else if (
      typeof e.hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(e.hash) ||
      (e.type === "symlink" && e.executable)
    )
      invalid();
    return e as unknown as WorkingEntry;
  });
  unique(workingTree.map((e) => e.path));
  if (workingTree.length !== union.size) invalid();
  for (const p of union) {
    const components = p.split("/");
    for (let n = 1; n < components.length; n++)
      if (union.has(components.slice(0, n).join("/"))) invalid();
  }
  return v as unknown as SnapshotArtifact;
}

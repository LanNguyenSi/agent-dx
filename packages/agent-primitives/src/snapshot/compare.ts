import { UsageError } from "../envelope.js";
import { validateSnapshot, type SnapshotArtifact } from "./schema.js";
export interface EntryChanges {
  added: string[];
  modified: string[];
  deleted: string[];
}
export interface DeltaResult {
  status: "ok" | "fail";
  changed: boolean;
  head: { before: string | null; after: string | null } | null;
  branch: { before: string | null; after: string | null } | null;
  index: EntryChanges;
  workingTree: EntryChanges;
}
function changes(
  before: Map<string, string>,
  after: Map<string, string>,
): EntryChanges {
  const result: EntryChanges = { added: [], modified: [], deleted: [] };
  for (const p of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (!before.has(p)) result.added.push(p);
    else if (!after.has(p)) result.deleted.push(p);
    else if (before.get(p) !== after.get(p)) result.modified.push(p);
  }
  return result;
}
export function compareSnapshots(
  saved: unknown,
  current: SnapshotArtifact,
): DeltaResult {
  const before = validateSnapshot(saved);
  const after = validateSnapshot(current);
  if (
    before.checkout.root !== after.checkout.root ||
    before.checkout.gitDir !== after.checkout.gitDir ||
    before.checkout.commonDir !== after.checkout.commonDir
  )
    throw new UsageError("delta requires the same physical checkout");
  if (before.objectFormat !== after.objectFormat)
    throw new UsageError("delta object formats differ");
  const indexMap = (s: SnapshotArtifact) => {
    const m = new Map<string, string>();
    const grouped = new Map<string, typeof s.index>();
    for (const entry of s.index) {
      const group = grouped.get(entry.path) ?? [];
      group.push(entry);
      grouped.set(entry.path, group);
    }
    for (const [p, group] of grouped)
      m.set(
        p,
        JSON.stringify(
          group
            .sort((a, b) => a.stage - b.stage)
            .map((e) => [e.stage, e.mode, e.oid]),
        ),
      );
    return m;
  };
  const workingMap = (s: SnapshotArtifact) =>
    new Map(
      s.workingTree
        .filter((e) => e.type !== "missing")
        .map((e) => [e.path, JSON.stringify([e.type, e.executable, e.hash])]),
    );
  const index = changes(indexMap(before), indexMap(after));
  const workingTree = changes(workingMap(before), workingMap(after));
  const head =
    before.head === after.head
      ? null
      : { before: before.head, after: after.head };
  const branch =
    before.branch === after.branch
      ? null
      : { before: before.branch, after: after.branch };
  const changed = !!(
    head ||
    branch ||
    [...Object.values(index), ...Object.values(workingTree)].some(
      (v) => v.length,
    )
  );
  return {
    status: changed ? "fail" : "ok",
    changed,
    head,
    branch,
    index,
    workingTree,
  };
}

import { parseSourceLineId } from "../formats/index.js";
import { IntakeError } from "./errors.js";
import type { SourceLineRef } from "./meta.js";

export interface DriftResult {
  status: "source-drift";
  changed_lines: { old: string; new: string }[];
  added: string[];
  removed: string[];
}

/**
 * Diff of the recorded line IDs against the current ones, aligned by
 * position. A position present in both with different IDs is a changed
 * line; an old position gone is removed; a new position is added. The
 * lists are in position order. All three lists can be empty: the hash
 * differs while every line ID is the same (a change that the line
 * normalisation does not see).
 */
export function diffSourceLines(
  oldLines: readonly SourceLineRef[],
  newLines: readonly SourceLineRef[],
): DriftResult {
  const atPosition = (
    lines: readonly SourceLineRef[],
    what: string,
  ): Map<number, string> => {
    const byPos = new Map<number, string>();
    for (const l of lines) {
      const parsed = parseSourceLineId(l.id);
      if (!parsed.ok) {
        throw new IntakeError(
          "meta-invalid",
          `${JSON.stringify(l.id)} in ${what} is not a source line ID`,
        );
      }
      byPos.set(parsed.value.position, l.id);
    }
    return byPos;
  };
  const oldByPos = atPosition(oldLines, "meta.json");
  const newByPos = atPosition(newLines, "the file");
  const changed_lines: { old: string; new: string }[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const positions = [...new Set([...oldByPos.keys(), ...newByPos.keys()])];
  positions.sort((a, b) => a - b);
  for (const pos of positions) {
    const old = oldByPos.get(pos);
    const next = newByPos.get(pos);
    if (old !== undefined && next !== undefined) {
      if (old !== next) changed_lines.push({ old, new: next });
    } else if (old !== undefined) {
      removed.push(old);
    } else if (next !== undefined) {
      added.push(next);
    }
  }
  return { status: "source-drift", changed_lines, added, removed };
}

import { createHash } from "node:crypto";
import { parseJsonText } from "../formats/index.js";
import type { SourceLineKind } from "../formats/index.js";
import { IntakeError } from "./errors.js";

export interface SourceSection {
  name: string;
  author: string | null;
  sha256: string;
}

export interface SourceAttachment {
  name: string;
  sha256: string;
  size: number;
  type: string;
}

export interface SourceLineRef {
  id: string;
  kind: SourceLineKind;
}

export interface SourceMeta {
  adapter: "file";
  origin: string;
  fetched_at: string;
  sha256: string;
  trust: "untrusted";
  sections: SourceSection[];
  attachments: SourceAttachment[];
  raw: boolean;
  lines: SourceLineRef[];
  base_commit: string;
  commands_ref: string;
}

/** Key order as listed in `docs/formats.md`, 2-space JSON, trailing newline. */
export function serializeMeta(meta: SourceMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The two fields of a recorded `meta.json` that `--check` needs. Anything
 * that is not strict JSON, not an object, or has no `sha256` string and no
 * `lines` array of `{ id, kind }` entries is a `meta-invalid` error.
 */
export function parseRecordedMeta(
  raw: string,
  shown: string,
): { sha256: string; lines: SourceLineRef[] } {
  const parsed = parseJsonText(raw);
  if (!parsed.ok) {
    throw new IntakeError(
      "meta-invalid",
      `${shown} is not strict JSON: ${parsed.errors[0]?.message ?? ""}`,
    );
  }
  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IntakeError("meta-invalid", `${shown} is not a JSON object`);
  }
  const { sha256, lines: recorded } = value as {
    sha256?: unknown;
    lines?: unknown;
  };
  if (typeof sha256 !== "string" || !Array.isArray(recorded)) {
    throw new IntakeError(
      "meta-invalid",
      `${shown} holds no sha256 string or no lines array`,
    );
  }
  const lines: SourceLineRef[] = [];
  for (const entry of recorded) {
    const l = entry as { id?: unknown; kind?: unknown } | null;
    if (typeof l?.id !== "string" || typeof l.kind !== "string") {
      throw new IntakeError(
        "meta-invalid",
        `${shown} has a lines entry that is not { id, kind }`,
      );
    }
    lines.push({ id: l.id, kind: l.kind as SourceLineKind });
  }
  return { sha256, lines };
}

/**
 * `spec-gate export`: a deterministic slicer briefing (`--format ow`) from
 * a merged proposed spec, and the check that a slicer return names every
 * qualified id of a spec (`--check`). Neither reads the network, writes
 * anything, or runs a command: export reads the spec files, the bindings
 * and the reference commit, computes the canonical digest, and prints or
 * compares.
 */
import { computeSpecDigest, DigestError } from "../canonical/index.js";
import { ExportError } from "./errors.js";
import type { ExportErrorCode } from "./errors.js";
import { loadMergedSpecDir } from "./merged.js";
import { OW_FORMAT, buildOwExport } from "./ow.js";

export { ExportError } from "./errors.js";
export type { ExportErrorCode } from "./errors.js";
export { checkSlicerReturn, containsQualifiedId } from "./check.js";
export type { CheckOutcome } from "./check.js";
export { OW_FORMAT, QUALIFIED_ID_CONSTRAINT } from "./ow.js";

export interface ExportRequest {
  /** `--format`: the briefing format; `ow` is the only one. */
  format?: string;
  /** `--repo`: the trusted checkout root. */
  repo?: string;
  /** `--default-ref`: full ref name of the branch the spec must be merged on. */
  defaultRef?: string;
}

export type ExportOutcome =
  | { ok: true; text: string }
  | { ok: false; code: ExportErrorCode; message: string };

/** Build the `ow` briefing of a merged proposed spec. */
export function exportSpecDir(
  specDir: string,
  request: ExportRequest,
): ExportOutcome {
  try {
    if (request.format === undefined) {
      throw new ExportError(
        "usage",
        "export needs --format ow or --check <slicer-return.yaml>",
      );
    }
    if (request.format !== OW_FORMAT) {
      throw new ExportError(
        "usage",
        `--format ${JSON.stringify(request.format)} is not a format of spec-gate export; the only format is ${OW_FORMAT}`,
      );
    }
    const inputs = loadMergedSpecDir(specDir, request);
    let digest: string;
    try {
      digest = computeSpecDigest(specDir, { repo: request.repo });
    } catch (err) {
      if (!(err instanceof DigestError)) throw err;
      throw new ExportError(
        "digest-failed",
        `the digest of the spec could not be computed: ${err.message}`,
      );
    }
    return { ok: true, text: buildOwExport(inputs, digest) };
  } catch (err) {
    if (!(err instanceof ExportError)) throw err;
    return { ok: false, code: err.code, message: err.message };
  }
}

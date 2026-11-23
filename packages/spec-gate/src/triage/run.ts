/**
 * The `triage` step: read `<spec-dir>/triage.json` through the format
 * parser, derive the class, write `class` and `rule_version` back, and
 * report what was derived. The derivation itself is pure and lives in
 * `rules.ts`; this module owns the file system.
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseTriage,
  type FormatError,
  type TriageClass,
  type TriageFieldName,
} from "../formats/index.js";
import {
  deriveTriageClass,
  profileForClass,
  type TriageDerivation,
  type TriageProfile,
} from "./rules.js";

/** The report the verb prints on stdout. */
export interface TriageReport {
  class: TriageClass;
  rule_version: number;
  row: number;
  unknown_fields: TriageFieldName[];
  profile: TriageProfile | null;
}

export type TriageRunResult =
  | {
      ok: true;
      file: string;
      derivation: TriageDerivation;
      report: TriageReport;
    }
  | {
      ok: false;
      kind:
        | "missing-file"
        | "symlink"
        | "read-error"
        | "parse-error"
        | "write-error";
      file: string;
      message: string;
      errors?: FormatError[];
    };

/** The file the verb reads and writes. */
export function triageFilePath(specDir: string): string {
  return path.join(specDir, "triage.json");
}

/**
 * Runs the verb on `<specDir>/triage.json`. A missing or unreadable file, a
 * symlink, or a parse error returns a failure and never writes. The file is
 * rewritten only once the fields parse: the new text goes to a temporary
 * file in the same directory, which is renamed over `triage.json`; a failed
 * write removes the temporary file and leaves the original untouched.
 */
export function runTriage(specDir: string): TriageRunResult {
  const file = triageFilePath(specDir);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      return {
        ok: false,
        kind: "symlink",
        file,
        message: `triage: ${file} is a symlink, refusing to read it`,
      };
    }
  } catch {
    // lstat failed; the read below reports the missing or unreadable file.
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        kind: "missing-file",
        file,
        message: `triage: no triage.json in ${specDir}`,
      };
    }
    return {
      ok: false,
      kind: "read-error",
      file,
      message: `triage: cannot read ${file}: ${code ?? (err as Error).message}`,
    };
  }

  const parsed = parseTriage(text);
  if (!parsed.ok) {
    return {
      ok: false,
      kind: "parse-error",
      file,
      message: `triage: ${file} is not a valid triage.json`,
      errors: parsed.errors,
    };
  }

  const derivation = deriveTriageClass(parsed.value);
  const doc = JSON.parse(text) as Record<string, unknown>;
  doc["class"] = derivation.class;
  doc["rule_version"] = derivation.rule_version;
  const written = `${JSON.stringify(doc, null, 2)}\n`;
  const temp = `${file}.tmp-${process.pid}`;
  // Carry the original permission bits onto the rewritten file; the default
  // mode of `writeFileSync` (0666 minus the umask) would widen a 0600 file.
  let mode: number;
  let created = false;
  try {
    mode = fs.statSync(file).mode & 0o7777;
    fs.accessSync(file, fs.constants.W_OK);
    // `wx`: never follow or reuse an existing path at the temporary name.
    fs.writeFileSync(temp, written, { flag: "wx", mode });
    created = true;
    // The umask applies to the `mode` option, so set the bits explicitly.
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (err) {
    // Only delete the temporary path this run created; something else may
    // already sit at the temporary name (EEXIST) and must be left alone.
    if (created) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // the temporary file stays; the named failure below is what callers see.
      }
    }
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      kind: "write-error",
      file,
      message: `triage: cannot write ${file}: ${code ?? (err as Error).message}`,
    };
  }

  return {
    ok: true,
    file,
    derivation,
    report: {
      class: derivation.class,
      rule_version: derivation.rule_version,
      row: derivation.row,
      unknown_fields: derivation.unknown_fields,
      profile: profileForClass(derivation.class),
    },
  };
}

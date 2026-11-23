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
      kind: "missing-file" | "read-error" | "parse-error";
      file: string;
      message: string;
      errors?: FormatError[];
    };

/** The file the verb reads and writes. */
export function triageFilePath(specDir: string): string {
  return path.join(specDir, "triage.json");
}

/**
 * Runs the verb on `<specDir>/triage.json`. A missing or unreadable file, or
 * a parse error, returns a failure and never writes; the file is rewritten
 * only once the fields parse.
 */
export function runTriage(specDir: string): TriageRunResult {
  const file = triageFilePath(specDir);
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
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);

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

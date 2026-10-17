import {
  getGenerated,
  getGeneratedAtValue,
  getStampDivergence,
  hasUtcDesignator,
  isRecord,
} from "../util.js";
import type { Finding, Rule } from "../types.js";

const RULE_ID = "generated-shape";

/**
 * The three shapes OKF v0.2 admits for `generated.by`:
 * `<producer>/<version>` (e.g. `okf-kit/0.19.0`), `human:<id>` and
 * `process:<id>`. Checked shape-first: `human:`/`process:` before the
 * producer slash, so `human:okf-kit/x` is read as the `human:<id>` shape it
 * spells. Whitespace outside the value is trimmed before the test;
 * whitespace inside one is not a shape anyone produces, so `\S+` per part
 * is the shape. A value that is not a string at all (`by: 42`, `by:` with
 * no value) matches none of the three and is reported like any other
 * mismatch.
 */
const GENERATED_BY_SHAPE_RE = /^(?:human:\S+|process:\S+|\S+\/\S+)$/;

/**
 * Whether a `generated.at` value names a usable instant: a native YAML date,
 * or a string that parses to one (forcing UTC for a designator-less string,
 * exactly as every timestamp reader in this package does, so a real date that
 * merely omits its offset is still recognised as a date here and left to the
 * designator error below). Anything else -- a present-but-null value, a blank
 * string, a string that is not a date at all, a number, a nested mapping --
 * names no instant: the doc spells `generated.at` but carries no stamp anyone
 * can read from it.
 */
function atNamesInstant(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  const ms = Date.parse(hasUtcDesignator(trimmed) ? trimmed : `${trimmed}Z`);
  return !Number.isNaN(ms);
}

/** How one side of the divergence finding names a stamp value: its raw spelling quoted, or, for a native YAML date (no raw spelling), the instant it resolved to. */
function describeStampValue(stamp: Date | string, ms: number): string {
  return typeof stamp === "string"
    ? `\`${stamp.trim()}\``
    : `a native YAML date naming ${new Date(ms).toISOString()}`;
}

/** How a `generated` value that is not a mapping is named in a finding. */
function describeGeneratedValue(value: unknown): string {
  if (typeof value === "string") return `\`${value.trim()}\``;
  if (value instanceof Date) return "a native YAML date";
  if (Array.isArray(value)) return "a list";
  if (value === null) return "no value";
  return `\`${String(value)}\``;
}

export const generatedShapeRule: Rule = {
  id: RULE_ID,
  description:
    "Frontmatter `generated` (the OKF v0.2 replacement for `timestamp`): `generated.by` must match one of `<producer>/<version>`, `human:<id>`, `process:<id>` (warning, any spec version, since only a v0.2 bundle may carry the key at all); under spec v0.2 the mapping itself is checked too -- `generated` must be a mapping and must carry both `by` and `at` (warning each, and again for an `at` present but naming no instant: null, blank, or not a date-time), and `generated.at` must carry an explicit UTC designator (`Z`) or numeric offset (error); and a `generated.at` and a `timestamp` naming DIFFERENT instants on one doc is reported once (warning), because the freshness rules read `generated.at` and silently leave the other behind.",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      // A reserved file's frontmatter block is reserved-files-bare's
      // business entirely; anything it still carries is already an error.
      if (doc.isReserved || !doc.frontmatter.present) continue;
      const parsed = doc.frontmatter.parsed;
      const generated = getGenerated(parsed);
      // A native YAML date (`generated: !!timestamp ...`) is an object, so
      // `isRecord` accepts it and `getGenerated` hands it back as if it were
      // the mapping; a Date is the non-mapping it spells, reported here
      // rather than below as a mapping missing both keys.
      if (!generated || generated instanceof Date) {
        // v0.2 made `generated: { by, at }` THE stamp, so a `generated` key
        // this tool cannot read (a v0.1-style scalar stamp, a list, an empty
        // value) means the doc declares a stamp it has no usable form of:
        // report the shape under v0.2 instead of silently falling back to
        // `timestamp`. Under v0.1 the key is not the spec's own, so its shape
        // stays exactly as unremarked as it was before this check existed.
        const keyIsPresent = isRecord(parsed) && "generated" in parsed;
        if (ctx.specVersion === "v0.2" && keyIsPresent) {
          findings.push({
            ruleId: RULE_ID,
            severity: "warning",
            file: doc.relPath,
            message: `generated must be a mapping \`{ by, at }\` under OKF v0.2; found ${describeGeneratedValue(parsed.generated)}`,
          });
        }
        continue;
      }

      // The same v0.2 contract, one level down: a mapping missing a key is
      // half a stamp, and `getGeneratedAtValue` treats an absent `at` as "no
      // v0.2 stamp here", which is the spec's fallback posture for a READER
      // and a silent hole for an AUTHOR who meant to declare one.
      if (ctx.specVersion === "v0.2" && !("by" in generated)) {
        findings.push({
          ruleId: RULE_ID,
          severity: "warning",
          file: doc.relPath,
          message:
            "generated has no `by`; OKF v0.2 requires it to name the producer (`<producer>/<version>`, `human:<id>` or `process:<id>`)",
        });
      }
      if (ctx.specVersion === "v0.2" && !("at" in generated)) {
        findings.push({
          ruleId: RULE_ID,
          severity: "warning",
          file: doc.relPath,
          message:
            "generated has no `at`; OKF v0.2 requires it to name the instant as an ISO 8601 date-time with an explicit offset",
        });
      }
      // The key is spelled but names no usable instant: `at: null`, an empty
      // value, or a string that is not a date at all are the same half-stamp a
      // missing key is, so the same warning follows the absent one's style.
      if (
        ctx.specVersion === "v0.2" &&
        "at" in generated &&
        !atNamesInstant(generated.at)
      ) {
        findings.push({
          ruleId: RULE_ID,
          severity: "warning",
          file: doc.relPath,
          message:
            "generated has an `at` that names no instant (null, blank, or not an ISO 8601 date-time); OKF v0.2 requires it to name the instant as an ISO 8601 date-time with an explicit offset",
        });
      }

      if ("by" in generated) {
        const by = generated.by;
        const text = typeof by === "string" ? by.trim() : String(by);
        if (!GENERATED_BY_SHAPE_RE.test(text)) {
          findings.push({
            ruleId: RULE_ID,
            severity: "warning",
            file: doc.relPath,
            message: `generated.by \`${text}\` matches none of the shapes \`<producer>/<version>\` (e.g. \`okf-kit/0.19.0\`), \`human:<id>\` or \`process:<id>\``,
          });
        }
      }

      // v0.2 makes the offset part of the `generated.at` contract ("an ISO
      // 8601 date-time with an explicit offset"), so a designator-less
      // value is an error naming the value; the value is still assessed
      // for staleness as the UTC instant `sources-fresh` resolves it to
      // (designator-less values are read as UTC, as for `timestamp`). A native YAML
      // date carries its instant and needs no designator. Checked only on a
      // value that is a real date (atNamesInstant): one that names no instant
      // at all is already reported as a missing stamp by the branch above, and
      // asking whether a non-date has an offset would only bury that finding
      // under a second, less useful one.
      if (ctx.specVersion === "v0.2") {
        const at = getGeneratedAtValue(parsed);
        if (
          typeof at === "string" &&
          atNamesInstant(at) &&
          !hasUtcDesignator(at)
        ) {
          findings.push({
            ruleId: RULE_ID,
            severity: "error",
            file: doc.relPath,
            message: `generated.at \`${at.trim()}\` has no explicit UTC designator (\`Z\`) or numeric offset (e.g. \`+02:00\`), required by OKF v0.2`,
          });
        }
      }

      const divergence = getStampDivergence(parsed);
      if (divergence) {
        findings.push({
          ruleId: RULE_ID,
          severity: "warning",
          file: doc.relPath,
          message: `generated.at ${describeStampValue(
            divergence.generatedAt,
            divergence.generatedAtMs,
          )} and timestamp ${describeStampValue(
            divergence.timestamp,
            divergence.timestampMs,
          )} name different instants; generated.at is the stamp the freshness rules use, remove the stale timestamp`,
        });
      }
    }
    return findings;
  },
};

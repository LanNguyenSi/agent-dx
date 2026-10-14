import {
  getGenerated,
  getGeneratedAtValue,
  getStampDivergence,
  hasUtcDesignator,
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

/** How one side of the divergence finding names a stamp value: its raw spelling quoted, or, for a native YAML date (no raw spelling), the instant it resolved to. */
function describeStampValue(stamp: Date | string, ms: number): string {
  return typeof stamp === "string"
    ? `\`${stamp.trim()}\``
    : `a native YAML date naming ${new Date(ms).toISOString()}`;
}

export const generatedShapeRule: Rule = {
  id: RULE_ID,
  description:
    "Frontmatter `generated` (the OKF v0.2 replacement for `timestamp`): `generated.by` must match one of `<producer>/<version>`, `human:<id>`, `process:<id>` (warning, any spec version, since only a v0.2 bundle may carry the key at all); under spec v0.2 `generated.at` must carry an explicit UTC designator (`Z`) or numeric offset (error); and a `generated.at` and a `timestamp` naming DIFFERENT instants on one doc is reported once (warning), because the freshness rules read `generated.at` and silently leave the other behind.",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      // A reserved file's frontmatter block is reserved-files-bare's
      // business entirely; anything it still carries is already an error.
      if (doc.isReserved || !doc.frontmatter.present) continue;
      const parsed = doc.frontmatter.parsed;
      const generated = getGenerated(parsed);
      if (!generated) continue;

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
      // date carries its instant and needs no designator.
      if (ctx.specVersion === "v0.2") {
        const at = getGeneratedAtValue(parsed);
        if (typeof at === "string" && !hasUtcDesignator(at)) {
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

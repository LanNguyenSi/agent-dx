import fs from "node:fs";
import path from "node:path";
import { ALIAS_PATTERN } from "../companions.js";
import { isRecord } from "../util.js";
import type { BundleContext, Finding, Rule } from "../types.js";

const RULE_ID = "frontmatter-refs-resolve";

/**
 * Frontmatter references, checked only when the field is present:
 *
 * - `lessons[].runbook` (a string per entry), on any doc;
 * - `derived_from[]` (an array of strings), on any doc.
 *
 * Reference grammar:
 *
 * - `<alias>:<path>` resolves to `<companion dir>/<path>`, where the prefix
 *   before the FIRST `:` is an alias when it matches `[a-z0-9-]+`. The
 *   alias must have been declared with `--companion <alias>=<dir>`;
 *   otherwise the ref is an error, or a notice under `--skip-companion-refs`.
 * - Anything else, including a value that contains a colon whose prefix is
 *   not alias-shaped (`C:\x`, `Notes v2:a.md`), is an unprefixed path
 *   relative to the doc's own directory inside the checked bundle.
 * - The target must be an existing file ending in `.md`.
 *
 * Containment is lexical (`path.resolve` plus a relative-path check), the
 * same level of strictness `links-resolve` applies to body links: it does
 * not follow symlinks, so a symlink inside the bundle or companion dir that
 * points elsewhere is not detected. An unprefixed ref must stay inside the
 * bundle and an alias ref inside its companion dir, otherwise it is an
 * error even when the escaped path happens to exist.
 *
 * Malformed shapes are errors, not crashes and not silent skips: `lessons`
 * present but not an array, an entry that is not a mapping, `runbook` present
 * but not a non-empty string, `derived_from` present but not an array, or an
 * element that is not a non-empty string. A doc whose frontmatter is missing
 * or unparseable is skipped here (`frontmatter-required` reports it).
 */
export const frontmatterRefsResolveRule: Rule = {
  id: RULE_ID,
  description:
    "Frontmatter `lessons[].runbook` and `derived_from[]`, when present, must resolve to an existing `.md` file (in the bundle, or in a `--companion` bundle for `<alias>:<path>`).",
  run(ctx) {
    const findings: Finding[] = [];
    for (const doc of ctx.docs) {
      const parsed = doc.frontmatter.parsed;
      if (!isRecord(parsed)) continue;
      const report = (severity: Finding["severity"], message: string) =>
        findings.push({
          ruleId: RULE_ID,
          severity,
          file: doc.relPath,
          message,
        });

      if ("lessons" in parsed) {
        const lessons = parsed.lessons;
        if (!Array.isArray(lessons)) {
          report("error", "Frontmatter `lessons` must be an array.");
        } else {
          lessons.forEach((lesson, i) => {
            if (!isRecord(lesson)) {
              report(
                "error",
                `Frontmatter \`lessons[${i}]\` must be a mapping.`,
              );
              return;
            }
            if (!("runbook" in lesson)) return;
            const runbook = lesson.runbook;
            if (typeof runbook !== "string" || runbook.trim() === "") {
              report(
                "error",
                `Frontmatter \`lessons[${i}].runbook\` must be a non-empty string.`,
              );
              return;
            }
            checkRef(
              ctx,
              doc.relPath,
              runbook,
              `lessons[${i}].runbook`,
              report,
            );
          });
        }
      }

      if ("derived_from" in parsed) {
        const derived = parsed.derived_from;
        if (!Array.isArray(derived)) {
          report("error", "Frontmatter `derived_from` must be an array.");
        } else {
          derived.forEach((ref, i) => {
            if (typeof ref !== "string" || ref.trim() === "") {
              report(
                "error",
                `Frontmatter \`derived_from[${i}]\` must be a non-empty string.`,
              );
              return;
            }
            checkRef(ctx, doc.relPath, ref, `derived_from[${i}]`, report);
          });
        }
      }
    }
    return findings;
  },
};

type Report = (severity: Finding["severity"], message: string) => void;

function checkRef(
  ctx: BundleContext,
  docRelPath: string,
  ref: string,
  field: string,
  report: Report,
): void {
  let baseDir: string;
  let relPart: string;
  let scope: string;

  const colon = ref.indexOf(":");
  const prefix = colon === -1 ? "" : ref.slice(0, colon);
  if (colon !== -1 && ALIAS_PATTERN.test(prefix)) {
    const companionDir = ctx.companions?.get(prefix);
    if (!companionDir) {
      if (ctx.skipCompanionRefs) {
        report(
          "notice",
          `Skipped \`${field}\` reference \`${ref}\`: companion alias \`${prefix}\` was not passed (--skip-companion-refs).`,
        );
      } else {
        report(
          "error",
          `\`${field}\` reference \`${ref}\` uses companion alias \`${prefix}\`, which was not passed; add --companion ${prefix}=<dir> or --skip-companion-refs.`,
        );
      }
      return;
    }
    baseDir = companionDir;
    relPart = ref.slice(colon + 1);
    scope = `companion \`${prefix}\``;
  } else {
    baseDir = path.dirname(path.join(ctx.bundleDir, docRelPath));
    relPart = ref;
    scope = "the bundle";
  }

  const root = scope === "the bundle" ? ctx.bundleDir : (baseDir as string);
  const target = path.resolve(baseDir, relPart);
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    report("error", `\`${field}\` reference \`${ref}\` escapes ${scope}.`);
    return;
  }
  if (!target.endsWith(".md")) {
    report(
      "error",
      `\`${field}\` reference \`${ref}\` must point to a \`.md\` file.`,
    );
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    report(
      "error",
      `\`${field}\` reference does not resolve to a file in ${scope}: \`${ref}\``,
    );
  }
}

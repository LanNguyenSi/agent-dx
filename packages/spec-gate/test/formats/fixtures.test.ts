import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseBindings,
  parseCommandSet,
  parseConfig,
  parseEvidenceEnvelope,
  parseEvidenceLines,
  parseQuestions,
  parseSpec,
  parseTestPlan,
  parseTriage,
} from "../../src/formats/index.js";

const root = fileURLToPath(new URL("../fixtures/formats/", import.meta.url));

type Parser =
  | typeof parseSpec
  | typeof parseTestPlan
  | typeof parseBindings
  | typeof parseTriage
  | typeof parseQuestions
  | typeof parseConfig
  | typeof parseCommandSet
  | typeof parseEvidenceLines
  | typeof parseEvidenceEnvelope;

/** The parser each fixture directory is read with, chosen by file extension. */
const FORMATS: Record<string, Record<string, Parser>> = {
  spec: { ".md": parseSpec },
  testplan: { ".yaml": parseTestPlan },
  bindings: { ".yaml": parseBindings },
  triage: { ".json": parseTriage },
  questions: { ".json": parseQuestions },
  config: { ".yaml": parseConfig },
  commands: { ".yaml": parseCommandSet },
  evidence: { ".jsonl": parseEvidenceLines, ".json": parseEvidenceEnvelope },
};

interface Expected {
  code: string;
  path: string;
}

function files(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function summarize(errors: { code: string; path: string }[]): string[] {
  return errors.map((e) => `${e.code} @ ${e.path}`).sort();
}

describe("format fixtures", () => {
  it("covers every format with a positive and several negative fixtures", () => {
    expect(fs.readdirSync(root).sort()).toEqual(Object.keys(FORMATS).sort());
    for (const format of Object.keys(FORMATS)) {
      const valid = files(path.join(root, format, "valid"));
      const invalid = files(path.join(root, format, "invalid")).filter(
        (f) => !f.endsWith(".expected.json"),
      );
      expect(valid.length, `${format}: valid fixtures`).toBeGreaterThanOrEqual(
        1,
      );
      expect(
        invalid.length,
        `${format}: invalid fixtures`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  for (const [format, parsers] of Object.entries(FORMATS)) {
    describe(format, () => {
      for (const file of files(path.join(root, format, "valid"))) {
        it(`valid/${file} parses`, () => {
          const parse = parsers[path.extname(file)];
          expect(parse, `no parser for ${file}`).toBeDefined();
          const text = fs.readFileSync(
            path.join(root, format, "valid", file),
            "utf8",
          );
          const result = parse!(text);
          if (!result.ok) {
            throw new Error(JSON.stringify(result.errors, null, 2));
          }
          expect(result.ok).toBe(true);
        });
      }

      for (const file of files(path.join(root, format, "invalid"))) {
        if (file.endsWith(".expected.json")) continue;
        it(`invalid/${file} fails with the pinned errors`, () => {
          const parse = parsers[path.extname(file)];
          expect(parse, `no parser for ${file}`).toBeDefined();
          const base = file.slice(0, file.length - path.extname(file).length);
          const sidecar = path.join(
            root,
            format,
            "invalid",
            `${base}.expected.json`,
          );
          expect(fs.existsSync(sidecar), `missing ${base}.expected.json`).toBe(
            true,
          );
          const expected = JSON.parse(
            fs.readFileSync(sidecar, "utf8"),
          ) as Expected[];
          expect(expected.length).toBeGreaterThan(0);
          const text = fs.readFileSync(
            path.join(root, format, "invalid", file),
            "utf8",
          );
          const result = parse!(text);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(summarize(result.errors)).toEqual(summarize(expected));
          for (const e of result.errors) {
            expect(e.message.length).toBeGreaterThan(0);
          }
        });
      }

      it("every sidecar belongs to an invalid fixture", () => {
        const dir = path.join(root, format, "invalid");
        const all = files(dir);
        for (const side of all.filter((f) => f.endsWith(".expected.json"))) {
          const base = side.slice(0, -".expected.json".length);
          const has = all.some(
            (f) => !f.endsWith(".expected.json") && f.startsWith(`${base}.`),
          );
          expect(has, `${side} has no fixture`).toBe(true);
        }
      });
    });
  }
});

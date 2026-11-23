/**
 * Golden digests. `test/fixtures/golden-digest/` holds one spec directory
 * (`base/`), the repository content its `commands_ref` names (`repo/`),
 * alternative files (`alt/`) and a table of variants. Every variant edits
 * a copy of `base/` (and sometimes the repository) and says whether the
 * digest must change. The digest of the base and of every variant that
 * changes it are committed in `expected.json`; to write them again after
 * an intended change of the digest format, run the suite with
 * `UPDATE_GOLDEN=1` and review the diff.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeSpecDigest } from "../../src/canonical/index.js";
import { FIELD_LAYERS, parseTestPlan } from "../../src/formats/index.js";
import { COMMANDS_FILE, makeRepo, tempDir } from "./helpers.js";

const fixtures = fileURLToPath(
  new URL("../fixtures/golden-digest/", import.meta.url),
);

type Edit =
  | { file: string; find: string; replace: string }
  | { file: string; copyFrom: string }
  | { file: string; write: string }
  | { file: string; delete: true };

interface Variant {
  name: string;
  effect: "changes" | "same";
  edits: Edit[];
  repo?: { commands?: string; later?: string };
}

interface Expected {
  base: string;
  variants: Record<string, string>;
}

const variants = JSON.parse(
  fs.readFileSync(path.join(fixtures, "variants.json"), "utf8"),
) as Variant[];
const expectedPath = path.join(fixtures, "expected.json");
const update = process.env["UPDATE_GOLDEN"] === "1";
const expected: Expected = fs.existsSync(expectedPath)
  ? (JSON.parse(fs.readFileSync(expectedPath, "utf8")) as Expected)
  : { base: "", variants: {} };

const baseDir = path.join(fixtures, "base");
const baseCommandsRef = /^commands_ref: ([0-9a-f]+)$/m.exec(
  fs.readFileSync(path.join(baseDir, "spec.md"), "utf8"),
)![1]!;
const baseCommands = fs.readFileSync(
  path.join(fixtures, "repo", COMMANDS_FILE),
  "utf8",
);

let scratch = "";
let baseRepo: { dir: string; shas: string[] };
const results = new Map<string, string>();
let baseDigest = "";

function applyEdit(dir: string, edit: Edit): void {
  const target = path.join(dir, edit.file);
  if ("find" in edit) {
    const text = fs.readFileSync(target, "utf8");
    const parts = text.split(edit.find);
    if (parts.length !== 2) {
      throw new Error(
        `edit of ${edit.file}: ${JSON.stringify(edit.find)} occurs ${parts.length - 1} times, not once`,
      );
    }
    fs.writeFileSync(target, parts.join(edit.replace));
  } else if ("copyFrom" in edit) {
    fs.copyFileSync(path.join(fixtures, edit.copyFrom), target);
  } else if ("write" in edit) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, edit.write);
  } else {
    fs.rmSync(target);
  }
}

async function digestOf(
  variant: Variant | null,
  index: number,
): Promise<string> {
  const dir = path.join(scratch, `spec-${index}`);
  fs.cpSync(baseDir, dir, { recursive: true });
  let repo = baseRepo.dir;
  for (const edit of variant?.edits ?? []) applyEdit(dir, edit);
  const files = (name: string) => [
    {
      path: COMMANDS_FILE,
      content: fs.readFileSync(path.join(fixtures, name)),
    },
  ];
  if (variant?.repo?.commands !== undefined) {
    const made = await makeRepo(scratch, [files(variant.repo.commands)]);
    repo = made.dir;
    applyEdit(dir, {
      file: "spec.md",
      find: `commands_ref: ${baseCommandsRef}`,
      replace: `commands_ref: ${made.shas[0]}`,
    });
  }
  if (variant?.repo?.later !== undefined) {
    const made = await makeRepo(scratch, [
      [{ path: COMMANDS_FILE, content: baseCommands }],
      files(variant.repo.later),
    ]);
    repo = made.dir;
    expect(made.shas[0]).toBe(baseCommandsRef);
  }
  return computeSpecDigest(dir, { repo });
}

beforeAll(async () => {
  scratch = tempDir("spec-gate-golden-");
  baseRepo = await makeRepo(scratch, [
    [{ path: COMMANDS_FILE, content: baseCommands }],
  ]);
  // The commit id is part of the spec text. It is only the same on every
  // machine because the fixture commit is made from fixed inputs.
  expect(
    baseRepo.shas[0],
    "the fixture commit id changed: set commands_ref in base/spec.md to it",
  ).toBe(baseCommandsRef);
  baseDigest = await digestOf(null, 0);
  let i = 1;
  for (const v of variants) results.set(v.name, await digestOf(v, i++));
  if (update) {
    const next: Expected = { base: baseDigest, variants: {} };
    for (const v of variants) {
      if (v.effect === "changes") next.variants[v.name] = results.get(v.name)!;
    }
    fs.writeFileSync(expectedPath, `${JSON.stringify(next, null, 1)}\n`);
  }
}, 120_000);

afterAll(() => {
  if (scratch !== "") fs.rmSync(scratch, { recursive: true, force: true });
});

describe("golden digest", () => {
  it("matches the committed digest of the base spec", () => {
    expect(baseDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(update ? baseDigest : expected.base).toBe(baseDigest);
  });

  it("has a unique name for every variant", () => {
    const names = variants.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  describe("variants that change the digest", () => {
    for (const v of variants.filter((x) => x.effect === "changes")) {
      it(v.name, () => {
        const digest = results.get(v.name)!;
        expect(digest).not.toBe(baseDigest);
        expect(digest).toBe(expected.variants[v.name]);
      });
    }
  });

  describe("variants that leave the digest unchanged", () => {
    for (const v of variants.filter((x) => x.effect === "same")) {
      it(v.name, () => {
        expect(results.get(v.name)).toBe(baseDigest);
      });
    }
  });

  it("gives every changing variant its own digest", () => {
    const digests = variants
      .filter((v) => v.effect === "changes")
      .map((v) => results.get(v.name)!);
    expect(new Set([...digests, baseDigest]).size).toBe(digests.length + 1);
  });

  it("commits a digest for exactly the changing variants", () => {
    const names = variants
      .filter((v) => v.effect === "changes")
      .map((v) => v.name);
    expect(Object.keys(expected.variants).sort()).toEqual(names.sort());
  });
});

describe("golden coverage", () => {
  const names = new Set(variants.map((v) => v.name));
  const changing = new Set(
    variants.filter((v) => v.effect === "changes").map((v) => v.name),
  );

  it("changes the digest through every normative test-plan field", () => {
    const plan = parseTestPlan(
      fs.readFileSync(path.join(baseDir, "testplan.yaml"), "utf8"),
    );
    if (!plan.ok) throw new Error("base test plan does not parse");
    const used = new Set(plan.value.flatMap((row) => Object.keys(row)));
    for (const [field, layer] of Object.entries(FIELD_LAYERS)) {
      if (layer !== "normative") continue;
      expect(used.has(field), `base test plan has no ${field}`).toBe(true);
      const variant = `tp-${field.replace(/_/g, "-")}`;
      expect(changing.has(variant), `no changing variant ${variant}`).toBe(
        true,
      );
    }
  });

  it("changes the digest through every normative field of the spec", () => {
    const required = [
      "goal-text",
      "frontmatter-id",
      "base-commit",
      "commands-ref-only",
      "commands-argv-at-ref",
      "retired-ids-added",
      "retired-ids-removed",
      "retired-ids-changed",
      "ac-text",
      "ac-source",
      "ac-owner",
      "ng-text",
      "ng-paths",
      "ng-paths-inner-space",
      "df-text",
      "df-reason",
      "df-affects-behavior",
      "dc-text",
      "dc-question",
      "dc-channel",
      "dc-author",
      "dc-time",
      "dc-comment-url",
      "rs-text",
      "rs-class",
      "rs-status",
      "rs-question",
      "sl-source-line",
      "sl-targets",
      "sl-out-reason",
    ];
    for (const name of required) {
      expect(changing.has(name), `no changing variant ${name}`).toBe(true);
    }
  });

  it("changes the digest for inner whitespace in the exact test-plan values that carry text", () => {
    for (const name of [
      "tp-fail-match-inner-space",
      "tp-evidence-location-inner-space",
      "tp-expected-inner-space",
      "tp-input-inner-tab",
      "tp-steps-inner-space",
    ]) {
      expect(changing.has(name), `no changing variant ${name}`).toBe(true);
    }
  });

  it("leaves the digest alone for every excluded input and every reordering", () => {
    const required = [
      "status-proposed",
      "status-superseded",
      "context-text",
      "notes-changed",
      "bindings-status",
      "bindings-log",
      "acks",
      "evidence",
      "coldread",
      "source-meta",
      "questions",
      "triage",
      "spec-rows-shuffled",
      "spec-keys-shuffled",
      "spec-whitespace",
      "testplan-rows-shuffled",
      "testplan-keys-shuffled",
      "testplan-whitespace",
      "commands-changed-at-later-commit",
    ];
    for (const name of required) {
      expect(names.has(name) && !changing.has(name), `variant ${name}`).toBe(
        true,
      );
    }
  });
});

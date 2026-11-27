// README.md and docs/ci.md carry copy-paste CI snippets, so a floating tag
// there (`actions/checkout@v5`) models the exact policy the shipped template
// and the surrounding prose reject: actions are pinned by commit SHA with the
// release in a trailing comment. These tests pin every `uses:` line in the
// fenced YAML of both docs to the commit SHA the shipped
// `templates/okf-staleness.yml` pins for the same action, so a snippet cannot
// drift back to a floating tag or to a SHA the template does not use.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

const template = read("../templates/okf-staleness.yml");

// `<action>@<40-hex SHA>` optionally followed by a `# <release>` comment.
const USE_LINE = /^\s*(?:-\s+)?uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/;
const SHA_REF = /^([^@\s]+)@([0-9a-f]{40})$/;

// Every `uses:` ref inside a ```yaml / ```yml fenced block, in order.
function usesRefs(markdown: string): { ref: string; comment?: string }[] {
  const refs: { ref: string; comment?: string }[] = [];
  let inYaml = false;
  for (const line of markdown.split("\n")) {
    const fence = line.match(/^ {0,3}`{3,}\s*(\S*)\s*$/);
    if (fence) {
      if (inYaml) inYaml = (fence[1] ?? "").length > 0;
      else inYaml = /^ya?ml$/i.test(fence[1] ?? "");
      continue;
    }
    if (!inYaml) continue;
    const use = line.match(USE_LINE);
    if (use?.[1]) refs.push({ ref: use[1], comment: use[2] });
  }
  return refs;
}

// action name -> pinned SHA, as the shipped template pins them.
function templatePins(text: string): Map<string, string> {
  const pins = new Map<string, string>();
  for (const line of text.split("\n")) {
    const use = line.match(USE_LINE);
    const pinned = use?.[1]?.match(SHA_REF);
    if (pinned) pins.set(pinned[1] as string, pinned[2] as string);
  }
  return pins;
}

const pins = templatePins(template);

describe("CI snippets in README.md and docs/ci.md pin actions by SHA", () => {
  it("the template itself pins every action by SHA (the reference)", () => {
    expect([...pins.keys()].length).toBeGreaterThan(0);
    expect(pins.has("actions/checkout")).toBe(true);
  });

  for (const doc of ["../README.md", "../docs/ci.md"]) {
    describe(doc, () => {
      const refs = usesRefs(read(doc));

      it("carries at least one uses: line", () => {
        expect(refs.length).toBeGreaterThan(0);
      });

      it("pins every uses: line by 40-hex SHA with a # v comment equal to the template's pin", () => {
        for (const { ref, comment } of refs) {
          const match = ref.match(SHA_REF);
          expect(
            match,
            `${ref} is not pinned by a 40-character commit SHA (use <action>@<sha> # <release>)`,
          ).not.toBeNull();
          expect(
            comment,
            `${ref} has no trailing # <release> comment`,
          ).toBeDefined();
          expect(comment).toMatch(/^v/);
          const action = match?.[1] as string;
          const sha = match?.[2] as string;
          expect(
            pins.has(action),
            `the template ships no SHA pin for ${action}`,
          ).toBe(true);
          expect(
            sha,
            `${ref} does not equal the template's pin for ${action}`,
          ).toBe(pins.get(action));
        }
      });
    });
  }
});

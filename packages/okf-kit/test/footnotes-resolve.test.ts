import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { runCheck } from "../src/cli.js";
import { footnotesResolveRule } from "../src/rules/footnotes-resolve.js";
import { FIXTURES_DIR } from "./helpers.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-footnotes-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function v02Bundle(doc: string, spec = "0.2"): void {
  write("index.md", `---\nokf_version: "${spec}"\n---\n\n# Index\n`);
  write("doc.md", doc);
}

function doc(sources: string, body: string): string {
  return `---\ntype: concept\nsources:\n${sources}\n---\n\n${body}\n`;
}

const SRC_ID_A = "  - id: a\n    resource: src/a.ts";

function run() {
  return footnotesResolveRule.run(loadBundle(dir));
}

describe("footnotes-resolve", () => {
  it("is clean on the v0.2 fixture (references resolve, ids referenced, code ignored)", () => {
    const ctx = loadBundle(
      path.join(FIXTURES_DIR, "v02-mappings-footnotes", "docs"),
    );
    expect(ctx.specVersion).toBe("v0.2");
    expect(footnotesResolveRule.run(ctx)).toEqual([]);
  });

  it("reports a dangling reference as one error, however often it is cited", () => {
    v02Bundle(doc(SRC_ID_A, "One.[^a] Two.[^ghost] Again.[^ghost]"));
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "footnotes-resolve",
      severity: "error",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("[^ghost]");
  });

  it("reports an unreferenced sources id as one warning", () => {
    v02Bundle(
      doc(
        `${SRC_ID_A}\n  - id: b\n    resource: src/b.ts`,
        "Only the first.[^a]",
      ),
    );
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "footnotes-resolve",
      severity: "warning",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("src/b.ts");
    expect(findings[0].message).toContain("[^b]");
  });

  it("a definition line alone does not count as referencing the entry", () => {
    v02Bundle(doc(SRC_ID_A, "No reference.\n\n[^a]: Definition only."));
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
  });

  it("a definition line is not itself a reference to resolve", () => {
    v02Bundle(doc(SRC_ID_A, "Cited.[^a]\n\n[^a]: Text.\n[^orphan]: Text."));
    expect(run()).toEqual([]);
  });

  it("matches ids case-sensitively", () => {
    v02Bundle(doc(SRC_ID_A, "Wrong case.[^A]"));
    const findings = run();
    expect(findings.map((f) => f.severity).sort()).toEqual([
      "error",
      "warning",
    ]);
  });

  it("does not read footnote-looking text in code as a reference", () => {
    v02Bundle(
      doc(SRC_ID_A, "Real.[^a] `[^x]`\n\n```\n[^y]\n```\n\nEscaped \\[^z]."),
    );
    expect(run()).toEqual([]);
  });

  it("an unpaired backtick does not hide a dangling footnote in a later paragraph", () => {
    v02Bundle(
      doc(
        SRC_ID_A,
        "Use the ` character.[^a]\n\nSecond.[^ghost]\n\nThird `code`.",
      ),
    );
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toContain("[^ghost]");
  });

  it("does not read a footnote inside an HTML comment as a reference", () => {
    v02Bundle(
      doc(SRC_ID_A, "Cited.[^a]\n\n<!-- [^todo] -->\n\n<!--\n[^todo2]\n-->"),
    );
    expect(run()).toEqual([]);
  });

  it("a prose `<!--` whose only later `-->` is in a fenced example hides no reference", () => {
    // The `-->` inside the ```html block is code and closes nothing, so the
    // prose `<!--` is plain text: `[^a]` stays referenced (no unreferenced
    // warning) and the dangling `[^missing]` is still reported.
    v02Bundle(
      doc(
        SRC_ID_A,
        "In prose, write <!-- to start an HTML comment. The real claim.[^a]\n\n```html\n<!-- example -->\n```\n\nA dangling one.[^missing]\n\n[^a]: see the source.",
      ),
    );
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "footnotes-resolve",
      severity: "error",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("[^missing]");
  });

  it("reports a duplicated sources id once, naming both entry positions", () => {
    v02Bundle(
      doc(
        `${SRC_ID_A}\n  - id: b\n    resource: src/b.ts\n  - id: a\n    resource: src/c.ts`,
        "Cited.[^a][^b]",
      ),
    );
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "footnotes-resolve",
      severity: "error",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("entries 1, 3");
    expect(findings[0].message).toContain("`id: a`");
  });

  it("accepts a numeric YAML id for a numeric footnote", () => {
    v02Bundle(doc("  - id: 1\n    resource: src/a.ts", "Cited.[^1]"));
    expect(run()).toEqual([]);
  });

  it("a doc without sources has every footnote dangling", () => {
    v02Bundle("---\ntype: concept\n---\n\nText.[^a]\n");
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
  });

  it("a plain string source entry has no id and is never reported as unreferenced", () => {
    v02Bundle(doc("  - src/a.ts", "No footnotes at all."));
    expect(run()).toEqual([]);
  });

  it("a mapping without a resource still declares its id (no second finding for its footnote)", () => {
    v02Bundle(doc("  - id: a\n    title: no resource", "Cited.[^a]"));
    expect(run()).toEqual([]);
  });

  it("does not scan reserved files", () => {
    v02Bundle(doc(SRC_ID_A, "Cited.[^a]"));
    write("log.md", "# Log\n\n## 2026-01-01\n\n- Note.[^nope]\n");
    expect(run()).toEqual([]);
  });

  it("is silent for a v0.1 bundle even when it uses footnotes", () => {
    v02Bundle(doc(SRC_ID_A, "Plain GFM footnote.[^nope]"), "0.1");
    expect(run()).toEqual([]);
  });

  it("--spec v0.2 turns the rule on for a bundle with no okf_version, --spec v0.1 turns it off", () => {
    write("doc.md", doc(SRC_ID_A, "Dangling.[^ghost]"));
    const on = runCheck(dir, { repoRoot: dir, spec: "v0.2" }).findings.filter(
      (f) => f.ruleId === "footnotes-resolve",
    );
    expect(on).toHaveLength(2);
    const off = runCheck(dir, { repoRoot: dir, spec: "v0.1" }).findings.filter(
      (f) => f.ruleId === "footnotes-resolve",
    );
    expect(off).toEqual([]);
  });
});

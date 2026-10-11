import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCompanions } from "../src/companions.js";
import { runCheck } from "../src/cli.js";
import { UsageError } from "../src/errors.js";
import { frontmatterRefsResolveRule } from "../src/rules/frontmatter-refs-resolve.js";
import { FIXTURES_DIR, loadFixture, runCli } from "./helpers.js";

const BUNDLE = path.join(FIXTURES_DIR, "frontmatter-refs", "bundle");
const COMPANION = path.join(FIXTURES_DIR, "frontmatter-refs", "companion");

function run(opts: { companion?: boolean; skip?: boolean } = {}) {
  const ctx = loadFixture("frontmatter-refs/bundle");
  if (opts.companion) ctx.companions = new Map([["shipped", COMPANION]]);
  if (opts.skip) ctx.skipCompanionRefs = true;
  return frontmatterRefsResolveRule.run(ctx);
}

function forFile(findings: ReturnType<typeof run>, file: string) {
  return findings.filter((f) => f.file === file);
}

describe("frontmatter-refs-resolve", () => {
  it("accepts an in-bundle runbook that exists", () => {
    expect(forFile(run(), "inbundle-ok.md")).toEqual([]);
  });

  it("flags an in-bundle runbook that does not exist", () => {
    const f = forFile(run(), "inbundle-dangling.md");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      ruleId: "frontmatter-refs-resolve",
      severity: "error",
    });
    expect(f[0].message).toContain("runbooks/missing.md");
  });

  it("flags a target that exists but is not a .md file", () => {
    const f = forFile(run(), "non-md-target.md");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
    expect(f[0].message).toContain(".md");
  });

  it("accepts a companion ref that exists", () => {
    expect(forFile(run({ companion: true }), "companion-ok.md")).toEqual([]);
  });

  it("flags a companion ref that does not exist", () => {
    const f = forFile(run({ companion: true }), "companion-dangling.md");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
    expect(f[0].message).toContain("companion `shipped`");
  });

  it("flags a companion ref to a non-.md file", () => {
    const f = forFile(run({ companion: true }), "companion-non-md.md");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
  });

  it("errors by default when the companion alias was not passed", () => {
    const f = forFile(run(), "companion-ok.md");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
    expect(f[0].message).toContain("--companion shipped=<dir>");
  });

  it("downgrades a missing alias to a notice under --skip-companion-refs", () => {
    const f = forFile(run({ skip: true }), "companion-ok.md");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("notice");
  });

  it("--skip-companion-refs does not hide a dangling in-bundle ref", () => {
    const f = forFile(run({ skip: true }), "inbundle-dangling.md");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
  });

  it("checks derived_from[]: ok entries pass", () => {
    expect(forFile(run({ companion: true }), "derived-ok.md")).toEqual([]);
  });

  it("checks derived_from[]: a dangling entry is an error naming the index", () => {
    const f = forFile(run({ companion: true }), "derived-dangling.md");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
    expect(f[0].message).toContain("derived_from[1]");
  });

  it("flags an unprefixed ref escaping the bundle even when the target exists", () => {
    const f = forFile(run(), "escape-unprefixed.md");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
    expect(f[0].message).toContain("escapes the bundle");
  });

  it("flags an alias ref escaping the companion dir even when the target exists", () => {
    const f = forFile(run({ companion: true }), "escape-alias.md");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
    expect(f[0].message).toContain("escapes companion `shipped`");
  });

  it("flags an absolute path after an alias as an escape", () => {
    const f = forFile(run({ companion: true }), "escape-alias-absolute.md");
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("escapes companion `shipped`");
  });

  it("treats a colon prefix that is not alias-shaped as an unprefixed path", () => {
    // `Notes v2` fails [a-z0-9-]+, so no alias lookup happens even with a
    // companion passed; the whole value is a (dangling) in-bundle path.
    const f = forFile(run({ companion: true }), "colon-non-alias.md");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
    expect(f[0].message).toContain("in the bundle");
  });

  it("resolves a nested doc's refs against its own directory, contained by the bundle", () => {
    const f = forFile(run(), "nested/doc.md");
    // lessons[0].runbook `../runbooks/ok-runbook.md` leaves the doc dir but
    // stays in the bundle: ok. derived_from `runbooks/ok-runbook.md` resolves
    // to nested/runbooks/ and is dangling.
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
    expect(f[0].message).toContain("derived_from[0]");
    expect(f[0].message).toContain("does not resolve to a file in the bundle");
  });

  it("rejects URL-shaped values with a dedicated message, also under --skip-companion-refs", () => {
    for (const opts of [{}, { skip: true }, { companion: true }]) {
      for (const file of [
        "url-https.md",
        "url-mailto.md",
        "url-alias-slashes.md",
        "url-uppercase.md",
      ]) {
        const f = forFile(run(opts), file);
        expect(f).toHaveLength(
          file === "url-alias-slashes.md" || file === "url-uppercase.md"
            ? 2
            : 1,
        );
        for (const finding of f) {
          expect(finding.severity).toBe("error");
          expect(finding.message).toContain("URLs are not supported");
          expect(finding.message).not.toContain("--companion");
        }
      }
    }
  });

  it("rejects an absolute unprefixed ref as not relative", () => {
    const f = forFile(run(), "absolute-unprefixed.md");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
    expect(f[0].message).toContain("must be relative");
  });

  it("reports malformed shapes as errors without crashing", () => {
    const findings = run({ companion: true });
    const expectOne = (file: string, text: string) => {
      const f = forFile(findings, file);
      expect(f).toHaveLength(1);
      expect(f[0].severity).toBe("error");
      expect(f[0].message).toContain(text);
    };
    expectOne("malformed-lessons-scalar.md", "`lessons` must be an array");
    expectOne("malformed-lesson-entry.md", "`lessons[0]` must be a mapping");
    expectOne("malformed-runbook-type.md", "`lessons[0].runbook` must be");
    expectOne("malformed-derived-scalar.md", "`derived_from` must be an array");
    expectOne("malformed-derived-element.md", "`derived_from[0]` must be");
  });

  it("ignores a lesson entry with no runbook key", () => {
    expect(forFile(run(), "lesson-without-runbook.md")).toEqual([]);
  });

  it("produces no findings for a bundle without these fields", () => {
    expect(frontmatterRefsResolveRule.run(loadFixture("valid-bundle"))).toEqual(
      [],
    );
  });
});

describe("--companion parsing", () => {
  const bad: Array<[string, string[], string]> = [
    ["no =", ["shipped"], "missing `=`"],
    ["empty alias", ["=" + COMPANION], "alias is empty"],
    ["empty dir", ["shipped="], "directory is empty"],
    ["reserved URL alias https", ["https=" + COMPANION], "reserved for URLs"],
    ["reserved URL alias mailto", ["mailto=" + COMPANION], "`mailto`"],
    ["bad alias chars", ["Shipped=" + COMPANION], "[a-z0-9-]+"],
    [
      "duplicate alias",
      [`shipped=${COMPANION}`, `shipped=${COMPANION}`],
      "given twice",
    ],
    ["missing dir", ["shipped=" + COMPANION + "/nope"], "does not exist"],
    [
      "dir is a file",
      ["shipped=" + COMPANION + "/runbooks/r1.md"],
      "does not exist",
    ],
  ];
  for (const [name, values, message] of bad) {
    it(`rejects ${name} with a clear message`, () => {
      expect(() => parseCompanions(values)).toThrow(UsageError);
      expect(() => parseCompanions(values)).toThrow(message);
    });
  }

  it("parses a valid pair to an absolute directory", () => {
    const map = parseCompanions([`shipped=${COMPANION}`]);
    expect(map.get("shipped")).toBe(COMPANION);
  });

  it("runCheck rejects a malformed companion before checking", () => {
    expect(() => runCheck(BUNDLE, { companions: ["nope"] })).toThrow(
      UsageError,
    );
  });
});

describe("check CLI: --companion / --skip-companion-refs", () => {
  it("exits 2 with a message for a malformed --companion", () => {
    const r = runCli(["check", BUNDLE, "--companion", "no-equals"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--companion expects <alias>=<dir>");
  });

  it("an unpassed alias fails the check; passing it clears that finding", () => {
    const without = runCli(["check", BUNDLE, "--json"]);
    const withAlias = runCli([
      "check",
      BUNDLE,
      "--json",
      "--companion",
      `shipped=${COMPANION}`,
    ]);
    const msgs = (out: string) =>
      (
        JSON.parse(out) as {
          findings: Array<{ ruleId: string; file: string; severity: string }>;
        }
      ).findings.filter(
        (f) =>
          f.ruleId === "frontmatter-refs-resolve" &&
          f.file === "companion-ok.md",
      );
    expect(without.status).toBe(1);
    expect(msgs(without.stdout)).toHaveLength(1);
    expect(msgs(withAlias.stdout)).toHaveLength(0);
  });

  it("--skip-companion-refs reports the unpassed alias as a notice", () => {
    const r = runCli(["check", BUNDLE, "--json", "--skip-companion-refs"]);
    const findings = (
      JSON.parse(r.stdout) as {
        findings: Array<{ ruleId: string; file: string; severity: string }>;
      }
    ).findings.filter(
      (f) =>
        f.ruleId === "frontmatter-refs-resolve" && f.file === "companion-ok.md",
    );
    expect(findings).toEqual([expect.objectContaining({ severity: "notice" })]);
  });
});

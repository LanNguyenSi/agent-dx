import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMinSeverity, runCheck } from "../src/cli.js";
import { FIXTURES_DIR, runCli } from "./helpers.js";
import fs from "node:fs";
import os from "node:os";

const BROKEN = path.join(FIXTURES_DIR, "broken-link");
const ABSOLUTE = path.join(FIXTURES_DIR, "absolute-link");

describe("check --rule", () => {
  it("reports only the selected rule, in runCheck", () => {
    const all = runCheck(BROKEN);
    expect(all.findings.some((f) => f.ruleId === "links-resolve")).toBe(true);
    const only = runCheck(BROKEN, { rules: ["links-resolve"] });
    expect(only.findings).toEqual(
      all.findings.filter((f) => f.ruleId === "links-resolve"),
    );
    const none = runCheck(BROKEN, { rules: ["no-absolute-links"] });
    expect(none.findings).toEqual(
      all.findings.filter((f) => f.ruleId === "no-absolute-links"),
    );
    expect(none.findings.some((f) => f.ruleId === "links-resolve")).toBe(false);
  });

  it("exit status counts only the reported findings", () => {
    expect(runCli(["check", BROKEN]).status).toBe(1);
    expect(
      runCli(["check", BROKEN, "--rule", "no-absolute-links"]).status,
    ).toBe(0);
    expect(runCli(["check", BROKEN, "--rule", "links-resolve"]).status).toBe(1);
  });

  it("accepts a comma-separated list and repeated flags", () => {
    const r = runCli([
      "check",
      BROKEN,
      "--json",
      "--rule",
      "no-absolute-links,links-resolve",
      "--rule",
      "frontmatter-required",
    ]);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout) as {
      findings: { ruleId: string }[];
      summary: { errors: number };
    };
    expect(out.findings.length).toBeGreaterThan(0);
    for (const f of out.findings) {
      expect([
        "no-absolute-links",
        "links-resolve",
        "frontmatter-required",
      ]).toContain(f.ruleId);
    }
  });

  it("an unknown rule id is a usage error that lists the valid ids", () => {
    const r = runCli(["check", BROKEN, "--rule", "links-resolve,nope"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("`nope`");
    expect(r.stderr).toContain("valid ids:");
    expect(r.stderr).toContain("links-resolve");
    expect(r.stderr).toContain("sources-fresh-future");
    expect(() => runCheck(BROKEN, { rules: ["nope"] })).toThrow(/valid ids:/);
  });
});

describe("check --min-severity", () => {
  it("filters out warnings below error, and the JSON summary counts only what is reported", () => {
    const strictAll = runCli(["check", ABSOLUTE, "--strict", "--json"]);
    expect(strictAll.status).toBe(1);
    const allOut = JSON.parse(strictAll.stdout) as {
      summary: { warnings: number };
    };
    expect(allOut.summary.warnings).toBeGreaterThan(0);

    const r = runCli([
      "check",
      ABSOLUTE,
      "--strict",
      "--json",
      "--min-severity",
      "error",
    ]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      findings: { severity: string }[];
      summary: { warnings: number; notices: number };
    };
    expect(out.findings.every((f) => f.severity === "error")).toBe(true);
    expect(out.summary.warnings).toBe(0);
    expect(out.summary.notices).toBe(0);
  });

  it("--min-severity warning keeps warnings and drops notices, in runCheck", () => {
    const all = runCheck(ABSOLUTE);
    const r = runCheck(ABSOLUTE, { minSeverity: "warning" });
    expect(r.findings).toEqual(
      all.findings.filter((f) => f.severity !== "notice"),
    );
    expect(r.findings.some((f) => f.severity === "warning")).toBe(true);
  });

  it("an invalid level is a usage error", () => {
    const r = runCli(["check", ABSOLUTE, "--min-severity", "fatal"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      "--min-severity must be one of error, warning, notice",
    );
    expect(() => parseMinSeverity("fatal")).toThrow(/must be one of/);
    expect(parseMinSeverity(" notice ")).toBe("notice");
  });
});

describe("check --rule with --min-severity", () => {
  it("both filters apply together", () => {
    expect(
      runCli(["check", ABSOLUTE, "--strict", "--rule", "no-absolute-links"])
        .status,
    ).toBe(1);
    const r = runCli([
      "check",
      ABSOLUTE,
      "--strict",
      "--json",
      "--rule",
      "no-absolute-links",
      "--min-severity",
      "error",
    ]);
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { findings: unknown[] }).findings).toEqual(
      [],
    );
  });
});

describe("check --min-severity at the notice boundary", () => {
  // A bundle outside any git work tree whose doc has `sources`: the
  // staleness rule then reports one notice ("staleness skipped"), and the
  // absolute link reports one warning. The runGit stub makes repo-root
  // detection fail, so no real git process is involved.
  function noticeBundle(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-notice-"));
    fs.writeFileSync(
      path.join(dir, "doc.md"),
      "---\ntype: concept\nsources:\n  - src/x.ts\n---\n\n[Other](/other.md)\n",
    );
    fs.writeFileSync(
      path.join(dir, "other.md"),
      "---\ntype: concept\n---\n\n# Other\n",
    );
    return dir;
  }
  const noGit = () => null;

  it("--min-severity warning drops the notice and keeps the warning", () => {
    const dir = noticeBundle();
    try {
      const all = runCheck(dir, { runGit: noGit });
      expect(all.findings.some((f) => f.severity === "notice")).toBe(true);
      expect(all.findings.some((f) => f.severity === "warning")).toBe(true);
      const filtered = runCheck(dir, {
        runGit: noGit,
        minSeverity: "warning",
      });
      expect(filtered.findings.some((f) => f.severity === "notice")).toBe(
        false,
      );
      expect(filtered.findings.some((f) => f.severity === "warning")).toBe(
        true,
      );
      expect(filtered.findings).toEqual(
        all.findings.filter((f) => f.severity !== "notice"),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--min-severity notice keeps everything", () => {
    const dir = noticeBundle();
    try {
      const all = runCheck(dir, { runGit: noGit });
      const r = runCheck(dir, { runGit: noGit, minSeverity: "notice" });
      expect(r.findings).toEqual(all.findings);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("check --rule with an empty value", () => {
  it("is a usage error, not 'every rule'", () => {
    for (const value of ["", ",", " , "]) {
      const r = runCli(["check", BROKEN, "--rule", value]);
      expect(r.status, `--rule "${value}"`).toBe(2);
      expect(r.stderr).toContain("--rule needs at least one rule id");
    }
  });
});

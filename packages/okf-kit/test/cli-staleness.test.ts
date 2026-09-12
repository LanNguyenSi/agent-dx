import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers.js";
import { createTmpGitRepo, writeDoc, type TmpGitRepo } from "./git-helpers.js";

interface JsonReport {
  findings: Array<{ ruleId: string; severity: string; message: string }>;
  summary: { errors: number; warnings: number; notices: number };
}

describe("okf-kit cli staleness (sources-fresh + repo-root auto-detection)", () => {
  let repo: TmpGitRepo;

  beforeEach(() => {
    repo = createTmpGitRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("auto-detects repoRoot via git when --repo-root is omitted: sources-shape existence and sources-fresh staleness both run", () => {
    repo.commitFile("real.ts", "export const a = 1;\n", "2025-01-01T00:00:00Z");
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2026-01-01T00:00:00Z", // after the commit: not stale
      sources: ["real.ts", "missing.ts"], // missing.ts: sources-shape existence error
    });

    const result = runCli(["check", path.join(repo.dir, "bundle"), "--json"]);
    expect(result.status).toBe(1);

    const parsed = JSON.parse(result.stdout) as JsonReport;
    expect(
      parsed.findings.some(
        (f) => f.ruleId === "sources-shape" && f.message.includes("missing.ts"),
      ),
    ).toBe(true);
    expect(
      parsed.findings.some(
        (f) =>
          f.ruleId === "sources-fresh" &&
          f.message.includes("not inside a git work tree"),
      ),
    ).toBe(false);
  });

  it("includes sources-fresh findings in --json, and --strict turns a STALE-only bundle into exit 1 while default exits 0", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-01T00:00:00Z",
    );
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2025-12-01T00:00:00Z", // before the commit: stale
      sources: ["source.ts"],
    });

    const defaultRun = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--json",
    ]);
    expect(defaultRun.status).toBe(0);
    const parsed = JSON.parse(defaultRun.stdout) as JsonReport;
    expect(
      parsed.findings.some(
        (f) => f.ruleId === "sources-fresh" && f.severity === "warning",
      ),
    ).toBe(true);
    expect(parsed.summary.warnings).toBeGreaterThan(0);
    expect(parsed.summary.errors).toBe(0);

    const strictRun = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--strict",
    ]);
    expect(strictRun.status).toBe(1);
  });

  it("includes sources-fresh-future findings in --json, and --strict turns a FUTURE-DATED-only bundle into exit 1 while default exits 0", () => {
    repo.commitFile(
      "bundle/doc.md",
      "---\ntype: concept\ntimestamp: 2026-01-02T00:00:00.000Z\nsources:\n  - source.ts\n---\n\n# Doc\n",
      "2026-01-01T00:00:00Z",
    );
    fs.writeFileSync(path.join(repo.dir, "source.ts"), "export const a = 1;\n");

    const defaultRun = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--json",
    ]);
    expect(defaultRun.status).toBe(0);
    const parsed = JSON.parse(defaultRun.stdout) as JsonReport;
    expect(
      parsed.findings.some(
        (f) => f.ruleId === "sources-fresh-future" && f.severity === "warning",
      ),
    ).toBe(true);
    expect(parsed.summary.warnings).toBeGreaterThan(0);
    expect(parsed.summary.errors).toBe(0);

    const strictRun = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--strict",
    ]);
    expect(strictRun.status).toBe(1);
  });

  it("--future-skew-minutes narrows the allowance so a timestamp that passed under the default now fails", () => {
    repo.commitFile(
      "bundle/doc.md",
      // 5 minutes after the doc's own commit: fresh under the default
      // 10-minute skew.
      "---\ntype: concept\ntimestamp: 2026-01-01T00:05:00.000Z\nsources:\n  - source.ts\n---\n\n# Doc\n",
      "2026-01-01T00:00:00Z",
    );
    fs.writeFileSync(path.join(repo.dir, "source.ts"), "export const a = 1;\n");

    const defaultRun = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--json",
    ]);
    const defaultParsed = JSON.parse(defaultRun.stdout) as JsonReport;
    expect(
      defaultParsed.findings.some((f) => f.ruleId === "sources-fresh-future"),
    ).toBe(false);

    const narrowRun = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--future-skew-minutes",
      "1",
      "--json",
    ]);
    const narrowParsed = JSON.parse(narrowRun.stdout) as JsonReport;
    expect(
      narrowParsed.findings.some((f) => f.ruleId === "sources-fresh-future"),
    ).toBe(true);
  });

  it("rejects a negative --future-skew-minutes as a usage error (exit 2)", () => {
    const result = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--future-skew-minutes",
      "-5",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--future-skew-minutes");
  });

  it("rejects an empty (or whitespace-only) --future-skew-minutes as a usage error (exit 2), not 0", () => {
    const result = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--future-skew-minutes",
      "",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--future-skew-minutes");

    const whitespaceResult = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--future-skew-minutes",
      "   ",
    ]);
    expect(whitespaceResult.status).toBe(2);
    expect(whitespaceResult.stderr).toContain("--future-skew-minutes");
  });

  it("accepts 0 as a valid --future-skew-minutes (the tightest allowance)", () => {
    repo.commitFile(
      "bundle/doc.md",
      // Exactly at the doc's own commit instant: still fresh even under a
      // 0-second (no) skew allowance.
      "---\ntype: concept\ntimestamp: 2026-01-01T00:00:00.000Z\nsources:\n  - source.ts\n---\n\n# Doc\n",
      "2026-01-01T00:00:00Z",
    );
    fs.writeFileSync(path.join(repo.dir, "source.ts"), "export const a = 1;\n");

    const result = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--future-skew-minutes",
      "0",
      "--json",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as JsonReport;
    expect(
      parsed.findings.some((f) => f.ruleId === "sources-fresh-future"),
    ).toBe(false);
  });

  it("--dirty-as-now: a clean run is quiet, the flag surfaces a dirty-source STALE line, and --strict then exits 1", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    // Doc committed and left clean: this test is about the CLI wiring of
    // --dirty-as-now for a dirty SOURCE, not the doc's own dirty state.
    repo.commitFile(
      "bundle/doc.md",
      "---\ntype: concept\ntimestamp: 2025-06-01T00:00:00Z\nsources:\n  - source.ts\n---\n\n# Doc\n",
      "2025-06-01T00:00:00Z",
    );
    // Dirty the source on disk without committing.
    fs.writeFileSync(path.join(repo.dir, "source.ts"), "export const a = 2;\n");

    const withoutFlag = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--json",
    ]);
    expect(withoutFlag.status).toBe(0);
    const withoutFlagParsed = JSON.parse(withoutFlag.stdout) as JsonReport;
    expect(
      withoutFlagParsed.findings.some((f) => f.ruleId === "sources-fresh"),
    ).toBe(false);

    const withFlag = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--dirty-as-now",
      "--json",
    ]);
    expect(withFlag.status).toBe(0);
    const withFlagParsed = JSON.parse(withFlag.stdout) as JsonReport;
    expect(
      withFlagParsed.findings.some(
        (f) =>
          f.ruleId === "sources-fresh" &&
          f.severity === "warning" &&
          f.message.includes("STALE") &&
          f.message.includes("source.ts"),
      ),
    ).toBe(true);

    const withFlagStrict = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--dirty-as-now",
      "--strict",
    ]);
    expect(withFlagStrict.status).toBe(1);
  });

  /**
   * The recommended pre-commit recipe (README "Uncommitted edits
   * (--dirty-as-now)"): `check --dirty-as-now --strict` pinned end-to-end
   * through the BUILT CLI, exit codes only -- not the finding list, which
   * the unit-level tests in sources-fresh-dirty-as-now.test.ts already
   * cover. `source.ts` is committed 2025-01-01, `bundle/doc.md` is
   * committed 2025-02-01 with a matching `timestamp`, in every case below.
   *
   * This is also the regression coverage for the round-2 review finding:
   * `sources-fresh-future` used to compare a doc's `timestamp` against its
   * REAL last-commit epoch even under `--dirty-as-now`, so re-stamping a
   * doc to "now" on disk (exactly the flag's own recommended remedy) read
   * FUTURE-DATED and still failed `--strict` in the one state CI reports
   * clean for. Case (i) below pins that this no longer happens, for two
   * different re-stamp/check lags (5s, 60s) simulated by backdating the
   * on-disk timestamp instead of sleeping.
   */
  describe("--dirty-as-now virtual-commit parity matrix (recommended recipe, --strict)", () => {
    function setupBaseline(repo: TmpGitRepo): void {
      repo.commitFile(
        "source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      repo.commitFile(
        "bundle/doc.md",
        "---\ntype: concept\ntimestamp: 2025-02-01T00:00:00.000Z\nsources:\n  - source.ts\n---\n\n# Doc\n",
        "2025-02-01T00:00:00Z",
      );
    }

    function dirtyDoc(repo: TmpGitRepo, timestampIso: string): void {
      fs.writeFileSync(
        path.join(repo.dir, "bundle/doc.md"),
        `---\ntype: concept\ntimestamp: ${timestampIso}\nsources:\n  - source.ts\n---\n\n# Doc\n`,
      );
    }

    for (const lagSeconds of [5, 60]) {
      it(`(i) source dirty + doc re-stamped on disk to now (${lagSeconds}s lag): clean, exit 0`, () => {
        const repo = createTmpGitRepo();
        try {
          setupBaseline(repo);
          fs.writeFileSync(
            path.join(repo.dir, "source.ts"),
            "export const a = 2;\n",
          );
          const nowIso = new Date(Date.now() - lagSeconds * 1000).toISOString();
          dirtyDoc(repo, nowIso);

          const result = runCli([
            "check",
            path.join(repo.dir, "bundle"),
            "--repo-root",
            repo.dir,
            "--dirty-as-now",
            "--strict",
            "--json",
          ]);
          const parsed = JSON.parse(result.stdout) as JsonReport;
          expect(
            parsed.findings.some((f) => f.ruleId === "sources-fresh"),
          ).toBe(false);
          expect(
            parsed.findings.some((f) => f.ruleId === "sources-fresh-future"),
          ).toBe(false);
          expect(result.status).toBe(0);
        } finally {
          repo.cleanup();
        }
      });
    }

    it("(ii) source dirty + doc NOT re-stamped: STALE, exit 1", () => {
      const repo = createTmpGitRepo();
      try {
        setupBaseline(repo);
        fs.writeFileSync(
          path.join(repo.dir, "source.ts"),
          "export const a = 2;\n",
        );

        const result = runCli([
          "check",
          path.join(repo.dir, "bundle"),
          "--repo-root",
          repo.dir,
          "--dirty-as-now",
          "--strict",
          "--json",
        ]);
        const parsed = JSON.parse(result.stdout) as JsonReport;
        expect(
          parsed.findings.some(
            (f) => f.ruleId === "sources-fresh" && f.message.includes("STALE"),
          ),
        ).toBe(true);
        expect(result.status).toBe(1);
      } finally {
        repo.cleanup();
      }
    });

    it("(iii) control: source edit + doc re-stamp committed TOGETHER, flag OFF: clean, exit 0", () => {
      const repo = createTmpGitRepo();
      try {
        setupBaseline(repo);
        repo.commitFiles(
          [
            { relPath: "source.ts", content: "export const a = 2;\n" },
            {
              relPath: "bundle/doc.md",
              content:
                "---\ntype: concept\ntimestamp: 2025-09-01T00:00:00.000Z\nsources:\n  - source.ts\n---\n\n# Doc\n",
            },
          ],
          "2025-09-01T00:00:00Z",
        );

        const result = runCli([
          "check",
          path.join(repo.dir, "bundle"),
          "--repo-root",
          repo.dir,
          "--strict",
        ]);
        expect(result.status).toBe(0);
      } finally {
        repo.cleanup();
      }
    });

    it("(iv) doc body-edited only (timestamp unchanged) + source dirty: STALE, exit 1", () => {
      const repo = createTmpGitRepo();
      try {
        setupBaseline(repo);
        fs.writeFileSync(
          path.join(repo.dir, "source.ts"),
          "export const a = 2;\n",
        );
        fs.writeFileSync(
          path.join(repo.dir, "bundle/doc.md"),
          "---\ntype: concept\ntimestamp: 2025-02-01T00:00:00.000Z\nsources:\n  - source.ts\n---\n\n# Doc\n\nA local note, not a re-stamp.\n",
        );

        const result = runCli([
          "check",
          path.join(repo.dir, "bundle"),
          "--repo-root",
          repo.dir,
          "--dirty-as-now",
          "--strict",
          "--json",
        ]);
        const parsed = JSON.parse(result.stdout) as JsonReport;
        expect(
          parsed.findings.some(
            (f) => f.ruleId === "sources-fresh" && f.message.includes("STALE"),
          ),
        ).toBe(true);
        expect(result.status).toBe(1);
      } finally {
        repo.cleanup();
      }
    });

    it("(v) backwards re-stamp (on-disk timestamp moved EARLIER than HEAD's) + source dirty: still a re-stamp, clean, exit 0 (documented)", () => {
      const repo = createTmpGitRepo();
      try {
        setupBaseline(repo);
        fs.writeFileSync(
          path.join(repo.dir, "source.ts"),
          "export const a = 2;\n",
        );
        // Moved BACKWARDS relative to the committed 2025-02-01 value --
        // still counts as a re-stamp (a changed value in EITHER direction),
        // documented in the README's "any CHANGE of value" wording.
        dirtyDoc(repo, "2025-01-15T00:00:00.000Z");

        const result = runCli([
          "check",
          path.join(repo.dir, "bundle"),
          "--repo-root",
          repo.dir,
          "--dirty-as-now",
          "--strict",
        ]);
        expect(result.status).toBe(0);
      } finally {
        repo.cleanup();
      }
    });
  });

  it("skips staleness with a notice when the bundle is not inside a git work tree", () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-plain-"));
    try {
      fs.writeFileSync(
        path.join(plainDir, "source.ts"),
        "export const a = 1;\n",
      );
      writeDoc(plainDir, "doc.md", {
        type: "concept",
        timestamp: "2026-01-01T00:00:00Z",
        sources: ["source.ts"],
      });

      const result = runCli(["check", plainDir, "--json"]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as JsonReport;
      expect(
        parsed.findings.some(
          (f) =>
            f.ruleId === "sources-fresh" &&
            f.message.includes("not inside a git work tree"),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

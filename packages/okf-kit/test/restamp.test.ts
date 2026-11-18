import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck, UsageError } from "../src/cli.js";
import { addLogEntry } from "../src/log-entry.js";
import { renderRestampText, runRestamp } from "../src/restamp.js";
import type { RunGit } from "../src/types.js";
import { runGit as realGit } from "../src/git.js";
import { createTmpGitRepo, type TmpGitRepo } from "./git-helpers.js";
import { runCli } from "./helpers.js";

const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const NOW = "2026-01-03T00:00:00Z";
const nowMs = (iso: string) => () => Date.parse(iso);
/** `iso` moved by `seconds`, in the `YYYY-MM-DDTHH:MM:SSZ` spelling. */
const plus = (iso: string, seconds: number): string =>
  new Date(Date.parse(iso) + seconds * 1000)
    .toISOString()
    .replace(".000Z", "Z");

let repo: TmpGitRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const bundle = (r: TmpGitRepo) => path.join(r.dir, "docs/okf");
const read = (r: TmpGitRepo, rel: string) =>
  fs.readFileSync(path.join(r.dir, rel), "utf8");

function doc(stamp: string, extra = "", sources = "src/a.ts"): string {
  return `---\ntype: concept\n${extra}timestamp: ${stamp}\nsources:\n  - ${sources}\n---\n\n# Doc\n\nBody.\n`;
}

const LOG = "# Log\n\n## 2026-01-01\n\n- 2026-01-01T00:00:00Z, first.\n";

/**
 * A repo whose doc is stamped T0 and whose source was committed at T1, so
 * `check` reports the doc STALE. `docText` replaces the doc's content.
 */
function staleRepo(docText = doc(T0), log: string | null = LOG): TmpGitRepo {
  repo = createTmpGitRepo();
  const files = [
    { relPath: "docs/okf/doc.md", content: docText },
    { relPath: "src/a.ts", content: "export const a = 1;\n" },
  ];
  if (log !== null) files.push({ relPath: "docs/okf/log.md", content: log });
  repo.commitFiles(files, T0);
  repo.commitFile("src/a.ts", "export const a = 2;\n", T1);
  return repo;
}

const staleDocs = (r: TmpGitRepo): string[] =>
  runCheck(bundle(r), { repoRoot: r.dir, rules: ["sources-fresh"] })
    .findings.filter((f) => f.message.startsWith("STALE:"))
    .map((f) => f.file);

describe("restamp: dry run and write", () => {
  it("reports the planned stamp and writes nothing without --write", () => {
    const r = staleRepo();
    const before = read(r, "docs/okf/doc.md");
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      now: nowMs(NOW),
    });
    expect(result.written).toBe(false);
    expect(result.stamped).toEqual([
      {
        doc: "doc.md",
        field: "timestamp",
        previous: T0,
        next: NOW,
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(read(r, "docs/okf/doc.md")).toBe(before);
    expect(renderRestampText(result)).toContain(
      `would re-stamp doc.md: timestamp ${T0} -> ${NOW}`,
    );
  });

  it("rewrites only the stamp under --write, and check is clean once the doc is committed", () => {
    const r = staleRepo();
    expect(staleDocs(r)).toEqual(["doc.md"]);
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      write: true,
      now: nowMs(NOW),
    });
    expect(result.written).toBe(true);
    expect(read(r, "docs/okf/doc.md")).toBe(doc(NOW));
    r.commitFile("docs/okf/doc.md", read(r, "docs/okf/doc.md"), NOW);
    const findings = runCheck(bundle(r), {
      repoRoot: r.dir,
      rules: ["sources-fresh", "sources-fresh-future"],
    }).findings.filter((f) => f.severity !== "notice");
    expect(findings).toEqual([]);
  });

  it("takes its stale set from the sources-fresh verdict: a fresh doc is left alone", () => {
    const r = staleRepo();
    r.commitFile(
      "docs/okf/fresh.md",
      doc("2026-01-02T12:00:00Z"),
      "2026-01-02T12:00:00Z",
    );
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      now: nowMs(NOW),
    });
    expect(result.stale).toEqual(staleDocs(r));
    expect(result.stamped.map((s) => s.doc)).toEqual(["doc.md"]);
  });

  it("a doc `check` only reports a notice for (no valid stamp) is neither stamped nor listed", () => {
    const r = staleRepo();
    r.commitFile("docs/okf/bad.md", doc("not-a-date"), T0);
    const result = runRestamp(bundle(r), { repoRoot: r.dir, now: nowMs(NOW) });
    expect(result.stale).toEqual(["doc.md"]);
    expect(result.manual).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("does nothing, exit 0, when no doc is stale", () => {
    const r = staleRepo();
    r.commitFile("docs/okf/doc.md", doc(NOW), NOW);
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      write: true,
      logEntry: "nothing",
      now: nowMs(NOW),
    });
    expect(result.stamped).toEqual([]);
    expect(result.logEntry).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(read(r, "docs/okf/log.md")).toBe(LOG);
    expect(renderRestampText(result)).toContain("no doc is stale");
  });

  it("keeps quoting, a trailing comment and CRLF line endings", () => {
    const quoted = doc(`"${T0}" # verified`).replace(/\n/g, "\r\n");
    const r = staleRepo(quoted);
    runRestamp(bundle(r), { repoRoot: r.dir, write: true, now: nowMs(NOW) });
    expect(read(r, "docs/okf/doc.md")).toBe(
      doc(`"${NOW}" # verified`).replace(/\n/g, "\r\n"),
    );
  });
});

describe("restamp: strictly later than the previous stamp", () => {
  // The source commit must be after the stamp for the doc to be stale; by
  // default it is the second right after it.
  function staleWithStamp(
    stamp: string,
    sourceAt = plus(stamp, 1),
  ): TmpGitRepo {
    repo = createTmpGitRepo();
    repo.commitFiles(
      [
        { relPath: "docs/okf/doc.md", content: doc(stamp) },
        { relPath: "src/a.ts", content: "export const a = 1;\n" },
      ],
      T0,
    );
    repo.commitFile("src/a.ts", "export const a = 2;\n", sourceAt);
    return repo;
  }

  /**
   * `git log` answers the first lookup of `src/a.ts`'s commit time (the one
   * `check` makes) and none after it: the restamp's own read of the same
   * time then finds nothing, so only the previous-stamp floor is left.
   */
  function sourceTimeReadOnce(): RunGit {
    let reads = 0;
    return (args, cwd) => {
      if (args[0] === "log" && args.some((a) => a.endsWith("src/a.ts"))) {
        reads += 1;
        if (reads > 1) return null;
      }
      return realGit(args, cwd);
    };
  }

  it("equal to now: one second later", () => {
    const r = staleWithStamp(NOW);
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      now: nowMs(NOW),
    });
    expect(result.stamped[0].next).toBe("2026-01-03T00:00:01Z");
  });

  it("equal to now and the source time unreadable: previous plus one second is the floor", () => {
    const r = staleWithStamp(NOW);
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      now: nowMs(NOW),
      runGit: sourceTimeReadOnce(),
    });
    expect(result.stamped[0].next).toBe(plus(NOW, 1));
  });

  it("in the future within the allowance and the source time unreadable: one second after it", () => {
    const r = staleWithStamp(plus(NOW, 300));
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      now: nowMs(NOW),
      runGit: sourceTimeReadOnce(),
    });
    expect(result.stamped[0].next).toBe(plus(NOW, 301));
  });

  it("in the future within the allowance: one second after it, not now", () => {
    const r = staleWithStamp("2026-01-03T00:05:00Z");
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      now: nowMs(NOW),
    });
    expect(result.stamped[0].next).toBe("2026-01-03T00:05:01Z");
  });

  it("in the past: now wins over previous plus one second", () => {
    const r = staleWithStamp("2026-01-02T00:00:00Z");
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      now: nowMs(NOW),
    });
    expect(result.stamped[0].next).toBe(NOW);
  });

  it("the sub-second part of the clock is dropped, not rounded up", () => {
    const r = staleWithStamp(T0);
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      now: () => Date.parse(NOW) + 999,
    });
    expect(result.stamped[0].next).toBe(NOW);
  });

  it("further in the future than the allowance: manual, never stamped, the others still are", () => {
    const r = staleWithStamp("2026-01-03T01:00:00Z");
    r.commitFiles(
      [
        {
          relPath: "docs/okf/other.md",
          content: doc(T0, "", "src/b.ts"),
        },
        { relPath: "src/b.ts", content: "export const b = 1;\n" },
      ],
      T0,
    );
    r.commitFile("src/b.ts", "export const b = 2;\n", T1);
    const before = read(r, "docs/okf/doc.md");
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      write: true,
      now: nowMs(NOW),
    });
    expect(result.manual.map((m) => m.doc)).toEqual(["doc.md"]);
    expect(result.manual[0].reason).toContain("its stamp");
    expect(result.manual[0].reason).toContain("in the future");
    expect(result.stamped.map((s) => s.doc)).toEqual(["other.md"]);
    expect(result.exitCode).toBe(1);
    expect(read(r, "docs/okf/doc.md")).toBe(before);
    expect(read(r, "docs/okf/other.md")).toBe(doc(NOW, "", "src/b.ts"));
  });
});

describe("restamp: the future allowance edge", () => {
  // The allowance is strict, like `sources-fresh-future`'s `>`: a stamp
  // exactly `allowance` seconds ahead of the clock is accepted, one second
  // more is flagged. The smallest valid stamp is one second after the
  // previous one.
  function staleAhead(previousAhead: number): TmpGitRepo {
    repo = createTmpGitRepo();
    repo.commitFiles(
      [
        {
          relPath: "docs/okf/doc.md",
          content: doc(plus(NOW, previousAhead)),
        },
        { relPath: "src/a.ts", content: "export const a = 1;\n" },
      ],
      T0,
    );
    repo.commitFile(
      "src/a.ts",
      "export const a = 2;\n",
      plus(NOW, previousAhead + 1),
    );
    return repo;
  }
  const run = (r: TmpGitRepo, futureSkewSeconds?: number) =>
    runRestamp(bundle(r), {
      repoRoot: r.dir,
      now: nowMs(NOW),
      futureSkewSeconds,
    });

  it("previous stamp 599 s ahead: stamped exactly at the allowance (now + 600 s)", () => {
    const result = run(staleAhead(599));
    expect(result.manual).toEqual([]);
    expect(result.stamped.map((s) => s.next)).toEqual([plus(NOW, 600)]);
    expect(result.exitCode).toBe(0);
  });

  it("previous stamp 600 s ahead: manual, since its successor would be 601 s ahead", () => {
    const result = run(staleAhead(600));
    expect(result.stamped).toEqual([]);
    expect(result.manual.map((m) => m.doc)).toEqual(["doc.md"]);
    expect(result.exitCode).toBe(1);
  });

  it("the accepted edge is the one `check` accepts: a stamp 600 s past the doc's commit is not future-dated, 601 s is", () => {
    const r = staleAhead(599);
    runRestamp(bundle(r), {
      repoRoot: r.dir,
      write: true,
      now: nowMs(NOW),
    });
    r.commitFile("docs/okf/doc.md", read(r, "docs/okf/doc.md"), NOW);
    const future = (r2: TmpGitRepo) =>
      runCheck(bundle(r2), {
        repoRoot: r2.dir,
        rules: ["sources-fresh", "sources-fresh-future"],
      }).findings.filter((f) => f.severity !== "notice");
    expect(future(r)).toEqual([]);
    r.commitFile("docs/okf/doc.md", doc(plus(NOW, 601)), NOW);
    expect(future(r).map((f) => f.ruleId)).toContain("sources-fresh-future");
  });

  it("a smaller allowance moves the manual boundary down", () => {
    // 59 s ahead is fine by default, manual with a 60 s allowance
    // (successor 60 s ahead is accepted) only from 60 s ahead on.
    expect(run(staleAhead(59), 60).manual).toEqual([]);
    expect(run(staleAhead(60), 60).manual).toHaveLength(1);
    expect(run(staleAhead(60)).manual).toEqual([]);
  });

  it("a larger allowance moves it up", () => {
    expect(run(staleAhead(600), 900).manual).toEqual([]);
    expect(run(staleAhead(900), 900).manual).toHaveLength(1);
    expect(run(staleAhead(600)).manual).toHaveLength(1);
  });

  it("an allowance of zero accepts only a stamp at the clock", () => {
    const behind = staleAhead(-5);
    expect(run(behind, 0).stamped.map((s) => s.next)).toEqual([NOW]);
    expect(run(staleAhead(0), 0).manual).toHaveLength(1);
  });
});

describe("restamp: the stamp clears the source commit", () => {
  function staleWithSourceAt(
    sourceAt: string,
    extraSource = false,
  ): TmpGitRepo {
    repo = createTmpGitRepo();
    repo.commitFiles(
      [
        {
          relPath: "docs/okf/doc.md",
          content: doc(
            T0,
            "",
            extraSource ? "src/a.ts\n  - src/b.ts" : "src/a.ts",
          ),
        },
        { relPath: "src/a.ts", content: "export const a = 1;\n" },
        { relPath: "src/b.ts", content: "export const b = 1;\n" },
      ],
      T0,
    );
    repo.commitFile("src/a.ts", "export const a = 2;\n", sourceAt);
    return repo;
  }
  const noFindings = (r: TmpGitRepo) =>
    runCheck(bundle(r), {
      repoRoot: r.dir,
      rules: ["sources-fresh", "sources-fresh-future"],
    }).findings.filter((f) => f.severity !== "notice");

  it("a source committed after the clock but within the allowance: the stamp is that commit's time, and check is clean once the doc is committed", () => {
    const sourceAt = plus(NOW, 300);
    const r = staleWithSourceAt(sourceAt);
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      write: true,
      now: nowMs(NOW),
    });
    expect(result.stamped.map((s) => s.next)).toEqual([sourceAt]);
    expect(result.exitCode).toBe(0);
    // the doc lands at the clock's time, before the source's commit date
    r.commitFile("docs/okf/doc.md", read(r, "docs/okf/doc.md"), NOW);
    expect(noFindings(r)).toEqual([]);
  });

  it("a source committed at or before the clock changes nothing: now is the stamp", () => {
    const r = staleWithSourceAt("2026-01-02T12:00:00Z");
    expect(
      runRestamp(bundle(r), { repoRoot: r.dir, now: nowMs(NOW) }).stamped[0]
        .next,
    ).toBe(NOW);
  });

  it("a source committed at now + 2 h: manual with the source named, nothing written", () => {
    const r = staleWithSourceAt(plus(NOW, 7200));
    const before = read(r, "docs/okf/doc.md");
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      write: true,
      now: nowMs(NOW),
    });
    expect(result.stamped).toEqual([]);
    expect(result.manual).toHaveLength(1);
    expect(result.manual[0].reason).toContain("`src/a.ts` was committed");
    expect(result.manual[0].reason).toContain("in the future");
    expect(result.exitCode).toBe(1);
    expect(read(r, "docs/okf/doc.md")).toBe(before);
  });

  it("the latest of several stale sources sets the floor", () => {
    const r = staleWithSourceAt(plus(NOW, 120), true);
    r.commitFile("src/b.ts", "export const b = 2;\n", plus(NOW, 240));
    const result = runRestamp(bundle(r), { repoRoot: r.dir, now: nowMs(NOW) });
    expect(result.stamped.map((s) => s.next)).toEqual([plus(NOW, 240)]);
  });
});

describe("restamp: refuses while a source is uncommitted", () => {
  it("modified source: nothing written, exit 1, log untouched", () => {
    const r = staleRepo();
    fs.writeFileSync(path.join(r.dir, "src/a.ts"), "export const a = 9;\n");
    const before = read(r, "docs/okf/doc.md");
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      write: true,
      logEntry: "x",
      now: nowMs(NOW),
    });
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toMatchObject({
      doc: "doc.md",
      source: "src/a.ts",
    });
    expect(result.refused[0].reason).toContain(
      "commit the source change first",
    );
    expect(result.stamped).toEqual([]);
    expect(result.written).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(read(r, "docs/okf/doc.md")).toBe(before);
    expect(read(r, "docs/okf/log.md")).toBe(LOG);
    expect(renderRestampText(result)).toContain("REFUSED doc.md");
  });

  it("a dirty source the doc lists but that is not the stale one still refuses", () => {
    const r = staleRepo(doc(T0, "", "src/a.ts\n  - src/b.ts"));
    r.commitFile("src/b.ts", "export const b = 1;\n", T0);
    fs.writeFileSync(path.join(r.dir, "src/b.ts"), "export const b = 2;\n");
    const result = runRestamp(bundle(r), { repoRoot: r.dir, now: nowMs(NOW) });
    expect(result.refused.map((x) => x.source)).toEqual(["src/b.ts"]);
  });

  it("a staged source and an untracked source file under a directory source refuse too", () => {
    const r = staleRepo(doc(T0, "", "src"));
    fs.writeFileSync(path.join(r.dir, "src/new.ts"), "export const n = 1;\n");
    expect(
      runRestamp(bundle(r), { repoRoot: r.dir, now: nowMs(NOW) }).refused,
    ).toHaveLength(1);
    fs.rmSync(path.join(r.dir, "src/new.ts"));
    fs.writeFileSync(path.join(r.dir, "src/a.ts"), "export const a = 5;\n");
    r.git(["add", "src/a.ts"]);
    expect(
      runRestamp(bundle(r), { repoRoot: r.dir, now: nowMs(NOW) }).refused,
    ).toHaveLength(1);
  });

  it("dirty source of a doc that is not stale does not block", () => {
    const r = staleRepo();
    r.commitFile("src/c.ts", "export const c = 1;\n", T0);
    r.commitFile("docs/okf/other.md", doc(NOW, "", "src/c.ts"), NOW);
    fs.writeFileSync(path.join(r.dir, "src/c.ts"), "export const c = 2;\n");
    const result = runRestamp(bundle(r), { repoRoot: r.dir, now: nowMs(NOW) });
    expect(result.refused).toEqual([]);
    expect(result.stamped.map((s) => s.doc)).toEqual(["doc.md"]);
  });

  it("a refused run prints a refusal summary, with or without --write, never the dry-run one", () => {
    const r = staleRepo();
    fs.writeFileSync(path.join(r.dir, "src/a.ts"), "export const a = 9;\n");
    for (const write of [true, false]) {
      const text = renderRestampText(
        runRestamp(bundle(r), { repoRoot: r.dir, write, now: nowMs(NOW) }),
      );
      expect(text).toContain(
        "0 re-stamped (refused, nothing written), 1 refused, 0 need manual handling",
      );
      expect(text).not.toContain("dry run");
    }
  });

  it("a dry run that is not refused still says so", () => {
    const r = staleRepo();
    const text = renderRestampText(
      runRestamp(bundle(r), { repoRoot: r.dir, now: nowMs(NOW) }),
    );
    expect(text).toContain(
      "1 to re-stamp (dry run, pass --write to rewrite), 0 refused",
    );
  });

  it("a dirty file elsewhere (a doc, the log) does not block", () => {
    const r = staleRepo();
    fs.writeFileSync(path.join(r.dir, "docs/okf/log.md"), LOG + "\n- extra\n");
    const result = runRestamp(bundle(r), { repoRoot: r.dir, now: nowMs(NOW) });
    expect(result.refused).toEqual([]);
  });

  describe("a directory source that contains the bundle", () => {
    // `docs` holds the bundle (docs/okf) and a note; the note's commit makes
    // the doc stale.
    function dirRepo(): TmpGitRepo {
      repo = createTmpGitRepo();
      repo.commitFiles(
        [
          { relPath: "docs/okf/doc.md", content: doc(T0, "", "docs") },
          { relPath: "docs/okf/log.md", content: LOG },
          { relPath: "docs/note.txt", content: "one\n" },
        ],
        T0,
      );
      repo.commitFile("docs/note.txt", "two\n", T1);
      return repo;
    }

    it("the bundle's own docs and log, modified or new, do not count as a dirty source", () => {
      const r = dirRepo();
      fs.writeFileSync(path.join(r.dir, "docs/okf/log.md"), LOG + "- more\n");
      fs.writeFileSync(
        path.join(r.dir, "docs/okf/doc.md"),
        doc(T0, "extra: 1\n", "docs"),
      );
      fs.writeFileSync(
        path.join(r.dir, "docs/okf/new.md"),
        doc(NOW, "", "docs"),
      );
      const result = runRestamp(bundle(r), {
        repoRoot: r.dir,
        now: nowMs(NOW),
      });
      expect(result.refused).toEqual([]);
      expect(result.stamped.map((s) => s.doc)).toEqual(["doc.md"]);
    });

    it("a dirty file of the directory that is not a bundle doc still refuses", () => {
      const r = dirRepo();
      fs.writeFileSync(path.join(r.dir, "docs/note.txt"), "three\n");
      const result = runRestamp(bundle(r), {
        repoRoot: r.dir,
        now: nowMs(NOW),
      });
      expect(result.refused.map((x) => x.source)).toEqual(["docs"]);
    });

    it("a non-doc file inside the bundle directory still refuses", () => {
      const r = dirRepo();
      fs.writeFileSync(path.join(r.dir, "docs/okf/figure.png"), "png");
      const result = runRestamp(bundle(r), {
        repoRoot: r.dir,
        now: nowMs(NOW),
      });
      expect(result.refused).toHaveLength(1);
    });

    it("a file source that is itself a bundle doc is not excluded", () => {
      const r = staleRepo(doc(T0, "", "docs/okf/log.md"));
      r.commitFile("docs/okf/log.md", LOG + "- committed\n", T1);
      fs.writeFileSync(path.join(r.dir, "docs/okf/log.md"), LOG + "- dirty\n");
      const result = runRestamp(bundle(r), {
        repoRoot: r.dir,
        now: nowMs(NOW),
      });
      expect(result.refused.map((x) => x.source)).toEqual(["docs/okf/log.md"]);
    });
  });

  it("git status that cannot be read is a refusal, never a pass", () => {
    const r = staleRepo();
    const noStatus: RunGit = (args, cwd) =>
      args.includes("status") ? null : realGit(args, cwd);
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      now: nowMs(NOW),
      runGit: noStatus,
    });
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].reason).toContain("could not be read");
    expect(result.exitCode).toBe(1);
  });
});

describe("restamp: OKF v0.2 generated.at", () => {
  const v2doc = (at: string, extra = "") =>
    `---\ntype: concept\ngenerated:\n  by: okf-kit\n  at: ${at}\n${extra}sources:\n  - src/a.ts\n---\n\n# Doc\n`;

  it("stamps generated.at and leaves the rest alone", () => {
    const r = staleRepo(v2doc(T0));
    const result = runRestamp(bundle(r), {
      repoRoot: r.dir,
      write: true,
      now: nowMs(NOW),
    });
    expect(result.stamped[0]).toMatchObject({
      field: "generated.at",
      previous: T0,
    });
    expect(read(r, "docs/okf/doc.md")).toBe(v2doc(NOW));
  });

  it("keeps a timestamp that names the same instant in step", () => {
    const r = staleRepo(v2doc(T0, `timestamp: ${T0}\n`));
    runRestamp(bundle(r), { repoRoot: r.dir, write: true, now: nowMs(NOW) });
    expect(read(r, "docs/okf/doc.md")).toBe(v2doc(NOW, `timestamp: ${NOW}\n`));
  });

  it("leaves a timestamp that names another instant alone", () => {
    const r = staleRepo(v2doc(T0, "timestamp: 2025-12-01T00:00:00Z\n"));
    runRestamp(bundle(r), { repoRoot: r.dir, write: true, now: nowMs(NOW) });
    expect(read(r, "docs/okf/doc.md")).toBe(
      v2doc(NOW, "timestamp: 2025-12-01T00:00:00Z\n"),
    );
  });
});

describe("restamp: the log entry", () => {
  it("is added under the newest heading of the same day, first, on --write only", () => {
    const log = "# Log\n\n## 2026-01-03\n\n- 2026-01-03T00:00:00Z, earlier.\n";
    const r = staleRepo(doc(T0), log);
    const dry = runRestamp(bundle(r), {
      repoRoot: r.dir,
      logEntry: "re-stamped doc.md",
      now: nowMs(NOW),
    });
    expect(dry.logEntry).toMatchObject({ file: "log.md", date: "2026-01-03" });
    expect(read(r, "docs/okf/log.md")).toBe(log);
    runRestamp(bundle(r), {
      repoRoot: r.dir,
      write: true,
      logEntry: "re-stamped doc.md",
      now: nowMs(NOW),
    });
    expect(read(r, "docs/okf/log.md")).toBe(
      "# Log\n\n## 2026-01-03\n\n- 2026-01-03T00:00:00Z, re-stamped doc.md\n\n- 2026-01-03T00:00:00Z, earlier.\n",
    );
    const structure = runCheck(bundle(r), {
      repoRoot: r.dir,
      rules: ["reserved-files-structure"],
    }).findings;
    expect(structure).toEqual([]);
  });

  it("when every stale doc is left for manual handling, no entry is added", () => {
    repo = createTmpGitRepo();
    repo.commitFiles(
      [
        { relPath: "docs/okf/doc.md", content: doc("2026-01-03T01:00:00Z") },
        { relPath: "docs/okf/log.md", content: LOG },
        { relPath: "src/a.ts", content: "export const a = 1;\n" },
      ],
      T0,
    );
    repo.commitFile(
      "src/a.ts",
      "export const a = 2;\n",
      "2026-01-03T02:00:00Z",
    );
    const result = runRestamp(bundle(repo), {
      repoRoot: repo.dir,
      write: true,
      logEntry: "x",
      now: nowMs(NOW),
    });
    expect(result.stamped).toEqual([]);
    expect(result.manual).toHaveLength(1);
    expect(result.logEntry).toBeUndefined();
    expect(read(repo, "docs/okf/log.md")).toBe(LOG);
  });

  it("a bundle without log.md is a usage error, whatever else is stale", () => {
    const r = staleRepo(doc(T0), null);
    expect(() =>
      runRestamp(bundle(r), { repoRoot: r.dir, logEntry: "x" }),
    ).toThrow(UsageError);
    // Without --log-entry the missing log is not a problem.
    expect(
      runRestamp(bundle(r), { repoRoot: r.dir, now: nowMs(NOW) }).exitCode,
    ).toBe(0);
  });

  it("an empty entry text is a usage error", () => {
    const r = staleRepo();
    expect(() =>
      runRestamp(bundle(r), { repoRoot: r.dir, logEntry: "   " }),
    ).toThrow(/needs the text/);
  });

  it("a log whose newest heading is later than today refuses before anything is written", () => {
    const log = "# Log\n\n## 2026-02-01\n\n- 2026-02-01T00:00:00Z, later.\n";
    const r = staleRepo(doc(T0), log);
    expect(() =>
      runRestamp(bundle(r), {
        repoRoot: r.dir,
        write: true,
        logEntry: "x",
        now: nowMs(NOW),
      }),
    ).toThrow(/later than 2026-01-03/);
    expect(read(r, "docs/okf/doc.md")).toBe(doc(T0));
  });
});

describe("addLogEntry placement", () => {
  const STAMP = "2026-01-03T00:00:00Z";
  const ENTRY = `- ${STAMP}, new.`;

  it("newest heading is today: first entry under it, loose list stays loose", () => {
    const raw =
      "# Log\n\n## 2026-01-03\n\n- a\n\n- b\n\n## 2026-01-01\n\n- c\n";
    expect(addLogEntry(raw, STAMP, "new.")).toBe(
      `# Log\n\n## 2026-01-03\n\n${ENTRY}\n\n- a\n\n- b\n\n## 2026-01-01\n\n- c\n`,
    );
  });

  it("newest heading is today: a packed list stays packed", () => {
    const raw = "## 2026-01-03\n\n- a\n- b\n";
    expect(addLogEntry(raw, STAMP, "new.")).toBe(
      `## 2026-01-03\n\n${ENTRY}\n- a\n- b\n`,
    );
  });

  it("newest heading is today, one entry: the new entry is separated from it", () => {
    expect(addLogEntry("## 2026-01-03\n\n- a\n", STAMP, "new.")).toBe(
      `## 2026-01-03\n\n${ENTRY}\n\n- a\n`,
    );
  });

  it("a nested bullet is not an entry: spacing is read from top-level bullets", () => {
    const raw = "## 2026-01-03\n\n- a\n  - nested\n\n- b\n";
    expect(addLogEntry(raw, STAMP, "new.")).toBe(
      `## 2026-01-03\n\n${ENTRY}\n\n- a\n  - nested\n\n- b\n`,
    );
  });

  it("bullets above the first heading do not set the spacing under it", () => {
    const raw = "- stray\n- stray2\n\n## 2026-01-03\n\n- a\n\n- b\n";
    expect(addLogEntry(raw, STAMP, "new.")).toBe(
      `- stray\n- stray2\n\n## 2026-01-03\n\n${ENTRY}\n\n- a\n\n- b\n`,
    );
  });

  it("newest heading is today and has no entry yet: the entry follows it", () => {
    expect(addLogEntry("# Log\n\n## 2026-01-03\n", STAMP, "new.")).toBe(
      `# Log\n\n## 2026-01-03\n\n${ENTRY}\n`,
    );
  });

  it("newest heading is older: a new heading goes above it", () => {
    const raw = "# Log\n\n<!-- note -->\n\n## 2026-01-01\n\n- c\n";
    expect(addLogEntry(raw, STAMP, "new.")).toBe(
      `# Log\n\n<!-- note -->\n\n## 2026-01-03\n\n${ENTRY}\n\n## 2026-01-01\n\n- c\n`,
    );
  });

  it("newest heading is later: refuses", () => {
    expect(() => addLogEntry("## 2026-02-01\n\n- c\n", STAMP, "new.")).toThrow(
      UsageError,
    );
  });

  it("flat list: the entry goes above the first bullet, in the list's spacing", () => {
    expect(addLogEntry("# Log\n\n- a\n\n- b\n", STAMP, "new.")).toBe(
      `# Log\n\n${ENTRY}\n\n- a\n\n- b\n`,
    );
    expect(addLogEntry("# Log\n\n- a\n- b\n", STAMP, "new.")).toBe(
      `# Log\n\n${ENTRY}\n- a\n- b\n`,
    );
  });

  it("no entries and no headings: a date heading and the entry are appended", () => {
    expect(addLogEntry("# Log\n", STAMP, "new.")).toBe(
      `# Log\n\n## 2026-01-03\n\n${ENTRY}\n`,
    );
    expect(addLogEntry("", STAMP, "new.")).toBe(`## 2026-01-03\n\n${ENTRY}\n`);
  });

  it("headings and bullets inside a fence or a comment are not read", () => {
    const raw =
      "# Log\n\n<!-- ## 2026-02-01 -->\n\n```\n## 2026-02-01\n- fenced\n```\n\n## 2026-01-01\n\n- c\n";
    expect(addLogEntry(raw, STAMP, "new.")).toBe(
      `# Log\n\n<!-- ## 2026-02-01 -->\n\n\`\`\`\n## 2026-02-01\n- fenced\n\`\`\`\n\n## 2026-01-03\n\n${ENTRY}\n\n## 2026-01-01\n\n- c\n`,
    );
  });

  it("a multi-line text continues on indented lines", () => {
    expect(
      addLogEntry(
        "## 2026-01-03\n\n- a\n",
        STAMP,
        "first\n# not a heading\nthird",
      ),
    ).toBe(
      `## 2026-01-03\n\n- ${STAMP}, first\n  # not a heading\n  third\n\n- a\n`,
    );
  });

  it("keeps CRLF line endings", () => {
    expect(addLogEntry("## 2026-01-01\r\n\r\n- a\r\n", STAMP, "new.")).toBe(
      `## 2026-01-03\r\n\r\n${ENTRY}\r\n\r\n## 2026-01-01\r\n\r\n- a\r\n`,
    );
  });
});

describe("restamp CLI", () => {
  it("dry run exits 0 and writes nothing; --write stamps; the check passes after the commit", () => {
    const r = staleRepo();
    const dry = runCli(["restamp", bundle(r), "--repo-root", r.dir]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("would re-stamp doc.md");
    expect(read(r, "docs/okf/doc.md")).toBe(doc(T0));
    const written = runCli([
      "restamp",
      bundle(r),
      "--repo-root",
      r.dir,
      "--write",
      "--log-entry",
      "re-stamped after the source change",
    ]);
    expect(written.status).toBe(0);
    expect(read(r, "docs/okf/doc.md")).not.toBe(doc(T0));
    expect(read(r, "docs/okf/log.md")).toContain(
      "re-stamped after the source change",
    );
    r.commitFiles(
      [
        { relPath: "docs/okf/doc.md", content: read(r, "docs/okf/doc.md") },
        { relPath: "docs/okf/log.md", content: read(r, "docs/okf/log.md") },
      ],
      new Date().toISOString(),
    );
    const check = runCli([
      "check",
      bundle(r),
      "--repo-root",
      r.dir,
      "--strict",
    ]);
    expect(check.stdout).not.toContain("STALE");
    expect(check.status).toBe(0);
  }, 30_000);

  it("exits 1 with a REFUSED line for an uncommitted source, 2 for a missing log", () => {
    const r = staleRepo();
    fs.writeFileSync(path.join(r.dir, "src/a.ts"), "export const a = 9;\n");
    const refused = runCli([
      "restamp",
      bundle(r),
      "--repo-root",
      r.dir,
      "--write",
    ]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain("REFUSED doc.md");
    expect(read(r, "docs/okf/doc.md")).toBe(doc(T0));
    fs.rmSync(path.join(r.dir, "docs/okf/log.md"));
    const noLog = runCli([
      "restamp",
      bundle(r),
      "--repo-root",
      r.dir,
      "--log-entry",
      "x",
    ]);
    expect(noLog.status).toBe(2);
    expect(noLog.stderr).toContain("log.md");
  }, 30_000);

  describe("--future-skew-minutes", () => {
    // The CLI reads the real clock, so the stamps are set relative to it.
    const ago = (seconds: number) =>
      new Date(Date.now() - seconds * 1000)
        .toISOString()
        .replace(/\.\d+Z$/, "Z");
    /** A stale doc whose stamp is 120 s ahead of the clock. */
    function aheadRepo(): TmpGitRepo {
      const stamp = ago(-120);
      repo = createTmpGitRepo();
      repo.commitFiles(
        [
          { relPath: "docs/okf/doc.md", content: doc(stamp) },
          { relPath: "src/a.ts", content: "export const a = 1;\n" },
        ],
        T0,
      );
      repo.commitFile("src/a.ts", "export const a = 2;\n", plus(stamp, 1));
      return repo;
    }

    it("the default allowance (10 minutes) stamps it; a 1 minute allowance lists it as manual", () => {
      const r = aheadRepo();
      const base = ["restamp", bundle(r), "--repo-root", r.dir, "--json"];
      const byDefault = JSON.parse(runCli(base).stdout);
      expect(byDefault.stamped).toHaveLength(1);
      const narrow = runCli([...base, "--future-skew-minutes", "1"]);
      expect(narrow.status).toBe(1);
      const parsed = JSON.parse(narrow.stdout);
      expect(parsed.stamped).toEqual([]);
      expect(parsed.manual).toHaveLength(1);
      expect(parsed.manual[0].reason).toContain("the allowance is 60 s");
    }, 30_000);

    it("a fractional value is read in minutes; an invalid one is a usage error", () => {
      const r = aheadRepo();
      const base = ["restamp", bundle(r), "--repo-root", r.dir, "--json"];
      // 3.5 minutes = 210 s: the successor of a stamp 120 s ahead is accepted
      expect(
        JSON.parse(runCli([...base, "--future-skew-minutes", "3.5"]).stdout)
          .stamped,
      ).toHaveLength(1);
      for (const bad of ["abc", "-1", ""]) {
        const out = runCli([...base, "--future-skew-minutes", bad]);
        expect(out.status).toBe(2);
        expect(out.stderr).toContain("--future-skew-minutes");
      }
    }, 30_000);
  });

  it("--json lists the plan", () => {
    const r = staleRepo();
    const out = runCli(["restamp", bundle(r), "--repo-root", r.dir, "--json"]);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.written).toBe(false);
    expect(parsed.stamped[0]).toMatchObject({
      doc: "doc.md",
      field: "timestamp",
    });
    expect(parsed.logEntry).toBeNull();
  }, 30_000);
});

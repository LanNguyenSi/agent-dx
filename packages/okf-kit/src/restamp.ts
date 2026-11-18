import fs from "node:fs";
import path from "node:path";
import YAML, { isScalar } from "yaml";
import { loadBundle } from "./bundle.js";
import { UsageError } from "./errors.js";
import { detectRepoRoot } from "./git.js";
import { addLogEntry } from "./log-entry.js";
import {
  DEFAULT_FUTURE_SKEW_SECONDS,
  getSourceCommitEpoch,
  isSourceDirty,
  isStaleFinding,
  sourcesFreshRule,
} from "./rules/sources-fresh.js";
import type { BundleDoc, RunGit } from "./types.js";
import {
  getGeneratedAtValue,
  getStampDivergence,
  getTimestampEpochMs,
  getValidSources,
  resolveRepoPath,
} from "./util.js";

export interface RestampOptions {
  repoRoot?: string;
  /** Rewrite the docs. Without it nothing is written and the plan is only reported. */
  write?: boolean;
  /** Text of one `log.md` entry to add when at least one doc is re-stamped. */
  logEntry?: string;
  /**
   * Clock-skew allowance in seconds: how far ahead of the clock a stamp may
   * be before `sources-fresh-future` flags it (default
   * `DEFAULT_FUTURE_SKEW_SECONDS`; CLI: `--future-skew-minutes`).
   */
  futureSkewSeconds?: number;
  /** Clock in milliseconds since the epoch (default `Date.now`); tests pin it. */
  now?: () => number;
  /** Test-only override for git access. */
  runGit?: RunGit;
}

export interface PlannedStamp {
  /** Bundle-relative doc path. */
  doc: string;
  /** The frontmatter key that carries the stamp. */
  field: "timestamp" | "generated.at";
  /** The stamp as the doc spells it now. */
  previous: string;
  /** The stamp written (or to be written). */
  next: string;
}

export interface RefusedRestamp {
  doc: string;
  /** The `sources` entry whose state blocks the re-stamp. */
  source: string;
  reason: string;
}

export interface ManualRestamp {
  doc: string;
  reason: string;
}

export interface RestampResult {
  bundleDir: string;
  /** True when the docs were rewritten, false for the dry run. */
  written: boolean;
  /** Docs `check` reports STALE, whatever came of them. */
  stale: string[];
  stamped: PlannedStamp[];
  /** A source with uncommitted changes: nothing at all is written. */
  refused: RefusedRestamp[];
  /** A doc that cannot be stamped mechanically; the others are still stamped. */
  manual: ManualRestamp[];
  /** The `log.md` entry added (or to add): its text and the date heading it sits under. */
  logEntry?: { file: string; entry: string; date: string };
  exitCode: number;
}

const TIMESTAMP_PATH = ["timestamp"];
const GENERATED_AT_PATH = ["generated", "at"];

/**
 * `okf-kit restamp <bundleDir> [--write] [--log-entry <text>]`: sets the
 * stamp of every doc `check` reports STALE to the current UTC time. The stale
 * set is the `sources-fresh` rule's own verdict (`isStaleFinding`), not a
 * reading of `check`'s output.
 *
 * A stamp is a claim that the doc was verified against the sources as they
 * are, and `sources-fresh` accepts it only when the doc's own commit lands at
 * or after the source's commit and moved the stamp strictly later. So the
 * command belongs AFTER the source change is committed, and the re-stamped
 * docs are committed next. It refuses, writing nothing, when a `sources`
 * entry of a doc it would stamp has uncommitted changes (or git cannot say).
 *
 * The new stamp is the clock reading to the second, but never equal to or
 * earlier than the stamp it replaces (one second later when that one is not
 * in the past) and never earlier than the latest commit of the doc's stale
 * sources (a source commit dated after the clock sets the floor; a stamp
 * equal to the commit time is fresh, `sources-fresh` calls a source stale
 * only when its commit is strictly later). A stamp more than the future
 * allowance (`sources-fresh-future`, `futureSkewSeconds`) ahead of the clock
 * would be flagged future-dated, so a doc whose smallest valid stamp is past
 * that line is listed for manual handling. The allowance is strict: a stamp
 * exactly `futureSkewSeconds` ahead of the clock is accepted, one second
 * more is not. The stamp is written where the doc keeps it: `generated.at`
 * when the doc has one (OKF v0.2), else `timestamp`, quoting kept.
 *
 * Exit code: 0 when nothing is refused or left for manual handling, 1
 * otherwise (stamps for the other docs are still written under `--write`
 * unless something is refused).
 */
export function runRestamp(
  bundleDir: string,
  options: RestampOptions = {},
): RestampResult {
  if (!fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) {
    throw new UsageError(`Bundle directory does not exist: ${bundleDir}`);
  }
  const resolvedBundleDir = path.resolve(bundleDir);
  const repoRoot = options.repoRoot
    ? path.resolve(options.repoRoot)
    : detectRepoRoot(resolvedBundleDir, options.runGit);
  if (!repoRoot) {
    throw new UsageError(
      "restamp needs a git work tree: the bundle is not inside one (pass --repo-root)",
    );
  }
  const logText = options.logEntry?.trim();
  if (options.logEntry !== undefined && !logText) {
    throw new UsageError("--log-entry needs the text of the entry");
  }
  const ctx = loadBundle(resolvedBundleDir, repoRoot, options.runGit);
  const logDoc = ctx.docs.find((doc) => doc.relPath === "log.md");
  if (logText !== undefined && logDoc === undefined) {
    throw new UsageError(
      `--log-entry needs a log.md in the bundle root, ${resolvedBundleDir} has none`,
    );
  }

  const staleDocs = [
    ...new Set(
      sourcesFreshRule
        .run(ctx)
        .filter(isStaleFinding)
        .map((finding) => finding.file),
    ),
  ];
  const result: RestampResult = {
    bundleDir: resolvedBundleDir,
    written: false,
    stale: staleDocs,
    stamped: [],
    refused: [],
    manual: [],
    exitCode: 0,
  };
  const docsByPath = new Map(ctx.docs.map((doc) => [doc.relPath, doc]));

  // The stamp must follow the source commit: a source with uncommitted
  // changes is not a commit yet, so the stamp would vouch for content that
  // has not landed, and the commit that lands it could still carry a date the
  // stamp does not clear. Every source of the doc counts, not only the one
  // found stale. The bundle's own docs (and its log) do not count as dirty
  // content of a directory source that contains the bundle: they are what
  // this command writes.
  const bundleFiles = ctx.docs.map((d) =>
    path
      .relative(repoRoot, path.join(resolvedBundleDir, d.relPath))
      .split(path.sep)
      .join("/"),
  );
  for (const docPath of staleDocs) {
    const doc = docsByPath.get(docPath);
    for (const source of getValidSources(doc?.frontmatter.parsed) ?? []) {
      const dirty = isSourceDirty(
        ctx,
        repoRoot,
        source,
        isDirectory(resolveRepoPath(repoRoot, source)) ? bundleFiles : [],
      );
      if (dirty === true) {
        result.refused.push({
          doc: docPath,
          source,
          reason: `\`${source}\` has uncommitted changes; commit the source change first, then re-stamp`,
        });
      } else if (dirty === null) {
        result.refused.push({
          doc: docPath,
          source,
          reason: `git status could not be read, so whether \`${source}\` has uncommitted changes is unknown`,
        });
      }
    }
  }
  if (result.refused.length > 0) {
    result.exitCode = 1;
    return result;
  }

  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
  const skewSeconds = options.futureSkewSeconds ?? DEFAULT_FUTURE_SKEW_SECONDS;
  const edits = new Map<string, string>();
  for (const docPath of staleDocs) {
    const doc = docsByPath.get(docPath) as BundleDoc;
    const previousMs = getTimestampEpochMs(doc.frontmatter.parsed);
    if (previousMs === undefined) {
      result.manual.push({
        doc: docPath,
        reason: "the doc has no readable stamp",
      });
      continue;
    }
    const previousSeconds = Math.floor(previousMs / 1000);
    // The latest commit among the doc's sources: the stamp has to be at or
    // after it for `sources-fresh` to call them fresh. A source that is not
    // stale was committed before the stamp it already carries, so it never
    // raises the floor.
    let sourceSeconds = Number.NEGATIVE_INFINITY;
    let latestSource = "";
    for (const source of getValidSources(doc.frontmatter.parsed) ?? []) {
      const epoch = getSourceCommitEpoch(ctx, repoRoot, source);
      if (epoch !== null && epoch > sourceSeconds) {
        sourceSeconds = epoch;
        latestSource = source;
      }
    }
    const afterPrevious = previousSeconds + 1;
    const nextSeconds = Math.max(nowSeconds, afterPrevious, sourceSeconds);
    if (nextSeconds > nowSeconds + skewSeconds) {
      result.manual.push({
        doc: docPath,
        reason:
          afterPrevious <= nowSeconds + skewSeconds
            ? `\`${latestSource}\` was committed ${isoSeconds(sourceSeconds)}, ${sourceSeconds - nowSeconds} s in the future of the clock (the allowance is ${skewSeconds} s), so no stamp that clears the commit would escape being flagged future-dated; re-stamp after the clock passes it, or correct the commit date`
            : `its stamp ${new Date(previousMs).toISOString()} is in the future (${previousSeconds - nowSeconds} s ahead of the clock, the allowance is ${skewSeconds} s), so a stamp strictly later than it would be flagged future-dated; correct it by hand`,
      });
      continue;
    }
    const next = isoSeconds(nextSeconds);
    const replaced = replaceStamp(doc, next);
    if ("error" in replaced) {
      result.manual.push({ doc: docPath, reason: replaced.error });
      continue;
    }
    result.stamped.push({
      doc: docPath,
      field: replaced.field,
      previous: replaced.previous,
      next,
    });
    edits.set(docPath, replaced.raw);
  }

  if (
    logText !== undefined &&
    logDoc !== undefined &&
    result.stamped.length > 0
  ) {
    const stamp = isoSeconds(nowSeconds);
    edits.set(logDoc.relPath, addLogEntry(logDoc.raw, stamp, logText));
    result.logEntry = {
      file: logDoc.relPath,
      entry: logText,
      date: stamp.slice(0, 10),
    };
  }

  if (options.write) {
    for (const [relPath, raw] of edits) {
      fs.writeFileSync(path.join(resolvedBundleDir, relPath), raw);
    }
    result.written = true;
  }
  result.exitCode = result.manual.length > 0 ? 1 : 0;
  return result;
}

function isDirectory(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/** `YYYY-MM-DDTHH:MM:SSZ`, the spelling bundles stamp with. */
function isoSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(".000Z", "Z");
}

type Replaced =
  | {
      raw: string;
      field: PlannedStamp["field"];
      previous: string;
    }
  | { error: string };

/**
 * `doc.raw` with its effective stamp (`generated.at` when present, else
 * `timestamp`, as every freshness reader resolves it) replaced by `next`; the
 * rest of the file stays byte for byte, quoting and line endings included. A
 * `timestamp` that sits beside a `generated.at` naming the same instant is
 * kept in step; one that names another instant is left alone.
 */
function replaceStamp(doc: BundleDoc, next: string): Replaced {
  const yamlText = doc.frontmatter.yaml;
  if (!doc.frontmatter.present || yamlText === undefined) {
    return { error: "the doc has no frontmatter block" };
  }
  const parsed = doc.frontmatter.parsed;
  const onGeneratedAt = getGeneratedAtValue(parsed) !== undefined;
  const hasTimestamp =
    typeof (parsed as { timestamp?: unknown })?.timestamp !== "undefined";
  const paths = onGeneratedAt
    ? hasTimestamp && getStampDivergence(parsed) === undefined
      ? [GENERATED_AT_PATH, TIMESTAMP_PATH]
      : [GENERATED_AT_PATH]
    : [TIMESTAMP_PATH];

  // Line contents and their separators, so the file is put back unchanged.
  const parts = doc.raw.split(/(\r?\n)/);
  const yamlDoc = YAML.parseDocument(yamlText);
  let previous = "";
  for (const [i, keyPath] of paths.entries()) {
    const node = yamlDoc.getIn(keyPath, true);
    if (!isScalar(node) || !node.range) {
      return {
        error: `the stamp \`${keyPath.join(".")}\` is not a plain value`,
      };
    }
    const [start, end] = node.range;
    const held = yamlText.slice(start, end);
    if (held.includes("\n")) {
      return {
        error: `the stamp \`${keyPath.join(".")}\` spans several lines`,
      };
    }
    const before = yamlText.slice(0, start);
    const lineInYaml = before.split("\n").length - 1;
    const column = start - (before.lastIndexOf("\n") + 1);
    // Frontmatter line k sits on raw line k + 1 (after the opening `---`).
    const partIndex = (lineInYaml + 1) * 2;
    const line = parts[partIndex];
    if (
      line === undefined ||
      line.slice(column, column + held.length) !== held
    ) {
      return {
        error: `the stamp \`${keyPath.join(".")}\` could not be located in the file`,
      };
    }
    const quote =
      node.type === "QUOTE_DOUBLE"
        ? '"'
        : node.type === "QUOTE_SINGLE"
          ? "'"
          : "";
    parts[partIndex] =
      line.slice(0, column) +
      `${quote}${next}${quote}` +
      line.slice(column + held.length);
    if (i === 0) previous = quote ? held.slice(1, -1) : held;
  }
  return {
    raw: parts.join(""),
    field: onGeneratedAt ? "generated.at" : "timestamp",
    previous,
  };
}

export function renderRestampText(result: RestampResult): string {
  const lines: string[] = [];
  const verb = result.written ? "re-stamped" : "would re-stamp";
  for (const s of result.stamped) {
    lines.push(`${verb} ${s.doc}: ${s.field} ${s.previous} -> ${s.next}`);
  }
  if (result.logEntry) {
    lines.push(
      `${result.written ? "added" : "would add"} to ${result.logEntry.file} under ## ${result.logEntry.date}: ${firstLine(result.logEntry.entry)}`,
    );
  }
  for (const r of result.refused) {
    lines.push(`REFUSED ${r.doc}: ${r.reason}`);
  }
  for (const m of result.manual) {
    lines.push(`MANUAL ${m.doc}: ${m.reason}`);
  }
  if (result.refused.length > 0) {
    lines.push(
      "nothing written: a stamp must follow the commit of the sources it vouches for, so commit the source changes and run restamp again",
    );
  } else if (result.stale.length === 0) {
    lines.push("no doc is stale, nothing to re-stamp");
  }
  if (result.refused.length > 0) {
    lines.push(
      `0 re-stamped (refused, nothing written), ${result.refused.length} refused, ${result.manual.length} need manual handling`,
    );
  } else {
    lines.push(
      `${result.stamped.length} ${result.written ? "re-stamped" : "to re-stamp (dry run, pass --write to rewrite)"}, ${result.refused.length} refused, ${result.manual.length} need manual handling`,
    );
  }
  return lines.join("\n") + "\n";
}

export function renderRestampJson(result: RestampResult): string {
  return (
    JSON.stringify(
      {
        bundleDir: result.bundleDir,
        written: result.written,
        stale: result.stale,
        stamped: result.stamped,
        refused: result.refused,
        manual: result.manual,
        logEntry: result.logEntry ?? null,
      },
      null,
      2,
    ) + "\n"
  );
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0];
}

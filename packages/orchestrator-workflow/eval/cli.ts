import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderCanary, runCanary } from "./canary.js";
import {
  LEAK_TAGS,
  datasetCounts,
  loadDataset,
  MEDIUM_PLUS,
} from "./dataset.js";
import type { Dataset, DatasetEntry, LeakTag } from "./dataset.js";
import {
  checkPlacement,
  createRunScratch,
  hostGitEnv,
  protectedHome,
  redactPaths,
  sessionEnv,
  setupEnv,
} from "./isolation.js";
import { runGuarded } from "./processes.js";
import { renderAggregates, renderComparison } from "./report.js";
import { cliVersion, removeTree, runEntry, summarizeRun } from "./runner.js";
import type { RunnerOptions } from "./runner.js";
import {
  aggregate,
  buildJudgePrompt,
  compareVariants,
  computeNoise,
  DEFAULT_NOISE_FLOOR_ENTRIES,
  parseJudgeAnswer,
  provenanceWarnings,
  runProvenance,
  scoreRun,
  splitByLeak,
} from "./score.js";
import type { JudgeFile, RunResult, RunScore } from "./score.js";
import { DEFAULT_REVISION, resolveVariant } from "./variants.js";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
}

const USAGE = `Usage: eval <command> [options]

Commands:
  validate-dataset --dataset <dir>
  canary  --dataset <dir> --out <dir> [--model opus] [--effort high]
          [--claude <bin>] [--guard <bin>] [--timeout-min 15] [--budget-usd 2]
          [--max-rss-mib 8192] [--scratch <dir>] [--no-bare]
          [--api-key-env ANTHROPIC_API_KEY]
  run     --dataset <dir> --out <dir> --variant current|degraded|file:<path>
          [--variant-id <id>] [--rev <git rev>] [--repeat <n>] [--only id,id]
          [--kind finding|control] [--model opus] [--effort high]
          [--claude <bin>] [--guard <bin>] [--timeout-min 45]
          [--budget-usd 15] [--max-rss-mib 8192] [--scratch <dir>]
          [--keep-checkout] [--force] [--no-retry] [--no-bare]
          [--api-key-env ANTHROPIC_API_KEY] [--repo-root <dir>] [--jobs <n>]
  judge   --dataset <dir> --out <dir> [--judge-model sonnet]
          [--judge-effort high] [--claude <bin>] [--guard <bin>]
          [--budget-usd 2] [--attempts 2] [--no-bare]
          [--api-key-env ANTHROPIC_API_KEY]
  score   --dataset <dir> --out <dir> [--exclude-leak high|none|<tag,tag>]
  compare --dataset <dir> --out <dir> --a <variant id> --b <variant id>
          [--exclude-leak high] [--noise-floor <entries>]
`;

const DEFAULT_GUARD = "agent-primitives";
const DEFAULT_MAX_RSS_MIB = 8192;

const DEFAULT_REPO_ROOT = (env: NodeJS.ProcessEnv): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  return execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: hostGitEnv(env),
    timeout: 60_000,
  }).trim();
};

function loadOrReport(dir: string | undefined, io: Io): Dataset | null {
  if (dir === undefined) {
    io.err("--dataset is required");
    return null;
  }
  const loaded = loadDataset(resolve(dir));
  if (loaded.dataset === null) {
    for (const message of loaded.errors) io.err(message);
    return null;
  }
  return loaded.dataset;
}

/** Every `result.json` under an output directory, optionally for one variant. */
export function loadRunResults(
  outDir: string,
  variantId?: string,
): { result: RunResult; dir: string }[] {
  const found: { result: RunResult; dir: string }[] = [];
  if (!existsSync(outDir)) return found;
  for (const variant of readdirSync(outDir, { withFileTypes: true })) {
    if (!variant.isDirectory()) continue;
    if (variantId !== undefined && variant.name !== variantId) continue;
    const variantDir = join(outDir, variant.name);
    for (const entry of readdirSync(variantDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const run of readdirSync(join(variantDir, entry.name), {
        withFileTypes: true,
      })) {
        const file = join(variantDir, entry.name, run.name, "result.json");
        if (!run.isDirectory() || !existsSync(file)) continue;
        found.push({
          result: JSON.parse(readFileSync(file, "utf8")) as RunResult,
          dir: join(variantDir, entry.name, run.name),
        });
      }
    }
  }
  return found;
}

function readJudge(dir: string): JudgeFile | null {
  const file = join(dir, "judge.json");
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as JudgeFile)
    : null;
}

function scoresByVariant(
  dataset: Dataset,
  outDir: string,
): Map<string, RunScore[]> {
  const byId = new Map(dataset.entries.map((e) => [e.id, e]));
  const grouped = new Map<string, RunScore[]>();
  for (const { result, dir } of loadRunResults(outDir)) {
    const entry = byId.get(result.entry_id);
    if (entry === undefined) continue;
    const list = grouped.get(result.variant.id) ?? [];
    list.push(scoreRun(entry, result, readJudge(dir)));
    grouped.set(result.variant.id, list);
  }
  return grouped;
}

function selectEntries(
  dataset: Dataset,
  only?: string,
  kind?: string,
): DatasetEntry[] {
  const ids =
    only === undefined ? null : new Set(only.split(",").map((s) => s.trim()));
  return dataset.entries.filter(
    (e) =>
      (ids === null || ids.has(e.id)) &&
      (kind === undefined || e.kind === kind),
  );
}

function positive(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!(n > 0) || !Number.isFinite(n))
    throw new Error(`${name} must be a positive number`);
  return n;
}

function nonNegative(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!(n >= 0) || !Number.isFinite(n))
    throw new Error(`${name} must be zero or a positive number`);
  return n;
}

/** `--exclude-leak`: `none` keeps every entry; otherwise a comma list of tags (default `high`). */
export function parseLeakExclusion(value: string | undefined): LeakTag[] {
  if (value === undefined) return ["high"];
  if (value.trim() === "none") return [];
  const tags = value.split(",").map((s) => s.trim());
  for (const tag of tags) {
    if (!(LEAK_TAGS as readonly string[]).includes(tag)) {
      throw new Error(
        `--exclude-leak takes none or a list of ${LEAK_TAGS.join(", ")} (got ${tag})`,
      );
    }
  }
  return tags as LeakTag[];
}

function requireKey(io: Io, apiKeyEnv: string): boolean {
  if (io.env[apiKeyEnv] === undefined || io.env[apiKeyEnv] === "") {
    io.err(
      `${apiKeyEnv} is not set: sessions authenticate with an API key from that variable (see --api-key-env)`,
    );
    return false;
  }
  return true;
}

const SESSION_OPTIONS = {
  dataset: { type: "string" },
  out: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  claude: { type: "string" },
  guard: { type: "string" },
  "timeout-min": { type: "string" },
  "budget-usd": { type: "string" },
  "max-rss-mib": { type: "string" },
  scratch: { type: "string" },
  "no-bare": { type: "boolean" },
  "api-key-env": { type: "string" },
} as const;

type SessionValues = {
  dataset?: string;
  out?: string;
  model?: string;
  effort?: string;
  claude?: string;
  guard?: string;
  "timeout-min"?: string;
  "budget-usd"?: string;
  "max-rss-mib"?: string;
  scratch?: string;
  "no-bare"?: boolean;
  "api-key-env"?: string;
};

/** Runner options shared by `run` and `canary`, or an error already reported. */
function sessionOptions(
  values: SessionValues,
  dataset: Dataset,
  io: Io,
  defaults: { timeoutMin: number; budgetUsd: number },
): RunnerOptions | null {
  if (values.out === undefined) {
    io.err("--out is required");
    return null;
  }
  const apiKeyEnv = values["api-key-env"] ?? "ANTHROPIC_API_KEY";
  if (!requireKey(io, apiKeyEnv)) return null;
  const outDir = resolve(values.out);
  const scratchRoot = resolve(values.scratch ?? join(tmpdir(), "ow-eval"));
  const placement = checkPlacement({
    scratchRoot,
    outDir,
    datasetDir: dataset.dir,
    home: protectedHome(io.env),
  });
  if (placement !== null) {
    io.err(placement);
    return null;
  }
  return {
    claudeBin: values.claude ?? "claude",
    guardBin: values.guard ?? DEFAULT_GUARD,
    model: values.model ?? "opus",
    effort: values.effort ?? "high",
    timeoutMs:
      positive(values["timeout-min"], defaults.timeoutMin, "--timeout-min") *
      60_000,
    budgetUsd: positive(
      values["budget-usd"],
      defaults.budgetUsd,
      "--budget-usd",
    ),
    maxRssMiB: positive(
      values["max-rss-mib"],
      DEFAULT_MAX_RSS_MIB,
      "--max-rss-mib",
    ),
    scratchRoot,
    outDir,
    datasetDir: dataset.dir,
    bare: values["no-bare"] !== true,
    apiKeyEnv,
    keepCheckout: false,
    force: false,
    retryFailed: true,
    env: io.env,
  };
}

async function commandCanary(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: SESSION_OPTIONS,
    strict: true,
  });
  const dataset = loadOrReport(values.dataset, io);
  if (dataset === null) return 2;
  const options = sessionOptions(values, dataset, io, {
    timeoutMin: 15,
    budgetUsd: 2,
  });
  if (options === null) return 2;
  const recordDir = join(
    options.outDir,
    "canary",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  const result = await runCanary(options, recordDir);
  io.out(renderCanary(result));
  return result.status === "pass" ? 0 : 1;
}

async function commandRun(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      ...SESSION_OPTIONS,
      variant: { type: "string" },
      "variant-id": { type: "string" },
      rev: { type: "string" },
      repeat: { type: "string" },
      only: { type: "string" },
      kind: { type: "string" },
      "keep-checkout": { type: "boolean" },
      force: { type: "boolean" },
      "no-retry": { type: "boolean" },
      "repo-root": { type: "string" },
      jobs: { type: "string" },
    },
    strict: true,
  });
  const dataset = loadOrReport(values.dataset, io);
  if (dataset === null) return 2;
  if (values.out === undefined || values.variant === undefined) {
    io.err("--out and --variant are required");
    return 2;
  }
  if (
    values.kind !== undefined &&
    values.kind !== "finding" &&
    values.kind !== "control"
  ) {
    io.err("--kind must be finding or control");
    return 2;
  }
  const base = sessionOptions(values, dataset, io, {
    timeoutMin: 45,
    budgetUsd: 15,
  });
  if (base === null) return 2;
  const options: RunnerOptions = {
    ...base,
    keepCheckout: values["keep-checkout"] === true,
    force: values.force === true,
    retryFailed: values["no-retry"] !== true,
  };
  const repeat = Math.floor(positive(values.repeat, 1, "--repeat"));
  const entries = selectEntries(dataset, values.only, values.kind);
  if (entries.length === 0) {
    io.err("no dataset entry matches --only/--kind");
    return 2;
  }
  const variant = resolveVariant({
    spec: values.variant,
    id: values["variant-id"],
    repoRoot: resolve(values["repo-root"] ?? DEFAULT_REPO_ROOT(io.env)),
    revision: values.rev ?? DEFAULT_REVISION,
    env: io.env,
  });
  const variantDir = join(options.outDir, variant.id);
  const snapshot = join(variantDir, "variant-prompt.md");
  if (existsSync(snapshot) && readFileSync(snapshot, "utf8") !== variant.text) {
    io.err(
      `variant id ${variant.id} already exists in ${options.outDir} with a different prompt; use another --variant-id or --out`,
    );
    return 2;
  }
  mkdirSync(variantDir, { recursive: true });
  writeFileSync(snapshot, variant.text);
  writeFileSync(
    join(variantDir, "variant.json"),
    `${JSON.stringify({ id: variant.id, source: variant.source, sha256: variant.sha256 }, null, 2)}\n`,
  );

  const sessions = entries.length * repeat;
  io.out(
    `variant ${variant.id} (${variant.source}, sha256 ${variant.sha256.slice(0, 12)}): ${entries.length} entries x ${repeat} repeat = ${sessions} sessions, model ${options.model}, effort ${options.effort}, cap ${options.budgetUsd} USD each (worst case ${(sessions * options.budgetUsd).toFixed(0)} USD)`,
  );
  const jobs = Math.floor(positive(values.jobs, 1, "--jobs"));
  const work: { entry: DatasetEntry; repeat: number }[] = [];
  for (let r = 1; r <= repeat; r += 1) {
    for (const entry of entries) work.push({ entry, repeat: r });
  }
  let failed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = work[next];
      next += 1;
      if (item === undefined) return;
      const result = await runEntry(item.entry, variant, item.repeat, options);
      io.out(summarizeRun(result));
      if (result.status !== "completed") failed += 1;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(jobs, work.length) }, () => worker()),
  );
  io.out(
    `done: ${sessions - failed} completed, ${failed} not completed; records in ${options.outDir}`,
  );
  return 0;
}

/**
 * The review text the judge sees: the session's own paths, the results and
 * dataset trees and the home directory replaced by labels, and the entry id
 * removed, so nothing in it names the variant, the entry or the dataset.
 */
export function judgeView(
  result: RunResult,
  context: { outDir: string; datasetDir: string; home: string },
): string {
  const paths = [
    ...(result.paths === undefined
      ? []
      : [
          { path: result.paths.worktree, label: "<worktree>" },
          { path: result.paths.evidence, label: "<evidence>" },
          { path: result.paths.run_files, label: "<run-files>" },
        ]),
    { path: context.outDir, label: "<results>", whole: true },
    { path: context.datasetDir, label: "<dataset>", whole: true },
    {
      path: dirname(context.datasetDir),
      label: "<dataset-parent>",
      whole: true,
    },
    { path: context.home, label: "<home>", whole: true },
  ];
  return redactPaths(result.final_text, paths)
    .split(result.entry_id)
    .join("<entry>");
}

async function commandJudge(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      dataset: { type: "string" },
      out: { type: "string" },
      "judge-model": { type: "string" },
      "judge-effort": { type: "string" },
      claude: { type: "string" },
      guard: { type: "string" },
      "budget-usd": { type: "string" },
      attempts: { type: "string" },
      "no-bare": { type: "boolean" },
      "api-key-env": { type: "string" },
    },
    strict: true,
  });
  const dataset = loadOrReport(values.dataset, io);
  if (dataset === null) return 2;
  if (values.out === undefined) {
    io.err("--out is required");
    return 2;
  }
  const bare = values["no-bare"] !== true;
  const apiKeyEnv = values["api-key-env"] ?? "ANTHROPIC_API_KEY";
  if (!requireKey(io, apiKeyEnv)) return 2;
  const apiKey = io.env[apiKeyEnv];
  const model = values["judge-model"] ?? "sonnet";
  // --bare ignores the user's effortLevel, so the judge's effort is always passed.
  const effort = values["judge-effort"] ?? "high";
  const claude = values.claude ?? "claude";
  const guardBin = values.guard ?? DEFAULT_GUARD;
  const budget = positive(values["budget-usd"], 2, "--budget-usd");
  const attempts = Math.floor(positive(values.attempts, 2, "--attempts"));
  const outDir = resolve(values.out);
  const home = protectedHome(io.env);
  const byId = new Map(dataset.entries.map((e) => [e.id, e]));
  const workRoot = mkdtempSync(join(tmpdir(), "ow-eval-judge-"));
  let judged = 0;
  let failed = 0;
  try {
    const versionScratch = createRunScratch(workRoot);
    const version = cliVersion(
      claude,
      setupEnv(io.env, {
        scratch: versionScratch,
        npmCache: join(versionScratch.tmp, "npm-cache"),
      }),
    );
    removeTree(versionScratch.root);
    for (const { result, dir } of loadRunResults(outDir)) {
      const entry = byId.get(result.entry_id);
      if (entry === undefined || entry.kind !== "finding") continue;
      if (
        result.final_text.trim().length === 0 ||
        existsSync(join(dir, "judge.json"))
      )
        continue;
      const known = entry.known_findings.filter((k) =>
        MEDIUM_PLUS.includes(k.severity),
      );
      const prompt = buildJudgePrompt(
        known,
        judgeView(result, { outDir, datasetDir: dataset.dir, home }),
      );
      writeFileSync(join(dir, "judge-prompt.md"), prompt);
      let done = false;
      let lastErrors: string[] = [];
      for (let attempt = 1; attempt <= attempts && !done; attempt += 1) {
        // A fresh, empty scratch per call: the judge has no files to read and
        // nothing in its paths names the variant or the entry.
        const scratch = createRunScratch(workRoot);
        mkdirSync(scratch.checkout);
        const promptFile = join(scratch.meta, "judge-prompt.md");
        writeFileSync(promptFile, prompt);
        const stdoutFile = join(scratch.meta, "out.json");
        await runGuarded(
          claude,
          [
            "-p",
            "--model",
            model,
            "--effort",
            effort,
            "--permission-prompts",
            "none",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--settings",
            '{"crossSessionInbound":"refuse"}',
            "--no-session-persistence",
            "--output-format",
            "json",
            "--max-budget-usd",
            String(budget),
            ...(bare ? ["--bare"] : []),
          ],
          {
            guardBin,
            cwd: scratch.checkout,
            env: sessionEnv(io.env, {
              scratch,
              npmCache: join(scratch.tmp, "npm-cache"),
              apiKey,
            }),
            timeoutMs: 10 * 60_000,
            maxRssMiB: DEFAULT_MAX_RSS_MIB,
            stdinFile: promptFile,
            stdoutFile,
            stderrFile: join(scratch.meta, "err.log"),
            logDir: join(scratch.meta, "guard"),
            sweepRoots: [scratch.root],
          },
        );
        let answer = "";
        let cost: number | null = null;
        let parsedOk = true;
        try {
          const json = JSON.parse(readFileSync(stdoutFile, "utf8")) as Record<
            string,
            unknown
          >;
          answer = typeof json.result === "string" ? json.result : "";
          cost =
            typeof json.total_cost_usd === "number"
              ? json.total_cost_usd
              : null;
        } catch {
          parsedOk = false;
        }
        removeTree(scratch.root);
        if (!parsedOk) {
          lastErrors = ["judge session produced no JSON"];
          continue;
        }
        const parsed = parseJudgeAnswer(
          answer,
          known.map((k) => k.id),
        );
        if (parsed.ok) {
          const file: JudgeFile = {
            matches: parsed.matches,
            model,
            effort,
            cli_version: version,
            cost_usd: cost,
          };
          writeFileSync(
            join(dir, "judge.json"),
            `${JSON.stringify(file, null, 2)}\n`,
          );
          rmSync(join(dir, "judge-error.json"), { force: true });
          done = true;
        } else {
          lastErrors = parsed.errors;
          writeFileSync(
            join(dir, "judge-error.json"),
            `${JSON.stringify({ errors: parsed.errors, raw: answer }, null, 2)}\n`,
          );
        }
      }
      if (done) judged += 1;
      else {
        failed += 1;
        io.err(
          `${result.variant.id} ${result.entry_id} run-${result.repeat}: judgment failed: ${lastErrors.join("; ")}`,
        );
      }
    }
  } finally {
    removeTree(workRoot);
  }
  io.out(`judged ${judged} run(s), ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

function commandScore(args: string[], io: Io): number {
  const { values } = parseArgs({
    args,
    options: {
      dataset: { type: "string" },
      out: { type: "string" },
      "exclude-leak": { type: "string" },
    },
    strict: true,
  });
  const dataset = loadOrReport(values.dataset, io);
  if (dataset === null) return 2;
  if (values.out === undefined) {
    io.err("--out is required");
    return 2;
  }
  const excluded = parseLeakExclusion(values["exclude-leak"]);
  const outDir = resolve(values.out);
  const grouped = scoresByVariant(dataset, outDir);
  if (grouped.size === 0) {
    io.err(`no run records under ${outDir}`);
    return 2;
  }
  const rows = (pick: "kept" | "excluded") =>
    [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, all]) => {
        const scores = splitByLeak(all, excluded)[pick];
        return {
          aggregate: aggregate(id, scores),
          noise: computeNoise(scores),
          scores,
        };
      });
  const primary = rows("kept");
  const left = excluded.length === 0 ? [] : rows("excluded");
  writeFileSync(
    join(outDir, "scores.json"),
    `${JSON.stringify({ exclude_leak: excluded, primary, excluded: left }, null, 2)}\n`,
  );
  io.out(
    excluded.length === 0
      ? "All entries."
      : `Primary score: entries tagged leak ${excluded.join(", ")} are left out (reported below).`,
  );
  io.out(renderAggregates(primary));
  if (left.some((r) => r.scores.length > 0)) {
    io.out("");
    io.out(`Entries tagged leak ${excluded.join(", ")} only:`);
    io.out(renderAggregates(left.filter((r) => r.scores.length > 0)));
  }
  return 0;
}

function commandCompare(args: string[], io: Io): number {
  const { values } = parseArgs({
    args,
    options: {
      dataset: { type: "string" },
      out: { type: "string" },
      a: { type: "string" },
      b: { type: "string" },
      "exclude-leak": { type: "string" },
      "noise-floor": { type: "string" },
    },
    strict: true,
  });
  const dataset = loadOrReport(values.dataset, io);
  if (dataset === null) return 2;
  if (
    values.out === undefined ||
    values.a === undefined ||
    values.b === undefined
  ) {
    io.err("--out, --a and --b are required");
    return 2;
  }
  const excluded = parseLeakExclusion(values["exclude-leak"]);
  const floor = nonNegative(
    values["noise-floor"],
    DEFAULT_NOISE_FLOOR_ENTRIES,
    "--noise-floor",
  );
  const outDir = resolve(values.out);
  const grouped = scoresByVariant(dataset, outDir);
  const a = grouped.get(values.a);
  const b = grouped.get(values.b);
  if (a === undefined || b === undefined) {
    io.err(
      `variant ${a === undefined ? values.a : values.b} has no run records in ${outDir}`,
    );
    return 2;
  }
  const compare = (pick: "kept" | "excluded") => {
    const sa = splitByLeak(a, excluded)[pick];
    const sb = splitByLeak(b, excluded)[pick];
    return compareVariants(
      { id: values.a!, scores: sa, noise: computeNoise(sa) },
      { id: values.b!, scores: sb },
      floor,
    );
  };
  const primary = compare("kept");
  const left = excluded.length === 0 ? null : compare("excluded");
  const provenance = (id: string) =>
    loadRunResults(outDir, id).map(({ result, dir }) =>
      runProvenance(result, readJudge(dir)),
    );
  const warnings = provenanceWarnings(
    { id: values.a, runs: provenance(values.a) },
    { id: values.b, runs: provenance(values.b) },
  );
  for (const warning of warnings) io.err(`warning: ${warning}`);
  writeFileSync(
    join(outDir, `compare-${values.a}-vs-${values.b}.json`),
    `${JSON.stringify({ exclude_leak: excluded, warnings, primary, excluded: left }, null, 2)}\n`,
  );
  if (excluded.length > 0)
    io.out(
      `Primary comparison: entries tagged leak ${excluded.join(", ")} are left out (reported below).`,
    );
  io.out(renderComparison(primary));
  if (left !== null && left.recall.n > 0) {
    io.out("");
    io.out(`Entries tagged leak ${excluded.join(", ")} only:`);
    io.out(renderComparison(left));
  }
  return 0;
}

export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "validate-dataset": {
        const { values } = parseArgs({
          args: rest,
          options: { dataset: { type: "string" } },
          strict: true,
        });
        const dataset = loadOrReport(values.dataset, io);
        if (dataset === null) return 1;
        const counts = datasetCounts(dataset);
        io.out(
          `dataset ok: ${dataset.entries.length} entries (${counts.finding} finding, ${counts.control} control)`,
        );
        return 0;
      }
      case "canary":
        return await commandCanary(rest, io);
      case "run":
        return await commandRun(rest, io);
      case "judge":
        return await commandJudge(rest, io);
      case "score":
        return commandScore(rest, io);
      case "compare":
        return commandCompare(rest, io);
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    env: process.env,
  }).then((code) => process.exit(code));
}

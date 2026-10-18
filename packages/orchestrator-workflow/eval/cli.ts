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

import { datasetCounts, loadDataset, MEDIUM_PLUS } from "./dataset.js";
import type { Dataset, DatasetEntry } from "./dataset.js";
import { renderAggregates, renderComparison } from "./report.js";
import { runEntry, runGrouped, scrubEnv, summarizeRun } from "./runner.js";
import type { RunnerOptions } from "./runner.js";
import {
  aggregate,
  buildJudgePrompt,
  compareVariants,
  computeNoise,
  parseJudgeAnswer,
  scoreRun,
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
  run     --dataset <dir> --out <dir> --variant current|degraded|file:<path>
          [--variant-id <id>] [--rev <git rev>] [--repeat <n>] [--only id,id]
          [--kind finding|control] [--model opus] [--effort high]
          [--claude <bin>] [--timeout-min 45] [--budget-usd 15]
          [--scratch <dir>] [--keep-checkout] [--force] [--no-bare]
          [--keep-home] [--api-key-env ANTHROPIC_API_KEY] [--repo-root <dir>]
          [--jobs <n>]
  judge   --dataset <dir> --out <dir> [--judge-model sonnet] [--claude <bin>]
          [--budget-usd 2] [--attempts 2] [--no-bare] [--api-key-env NAME]
  score   --dataset <dir> --out <dir>
  compare --dataset <dir> --out <dir> --a <variant id> --b <variant id>
`;

const DEFAULT_REPO_ROOT = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  return execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
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

async function commandRun(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      dataset: { type: "string" },
      out: { type: "string" },
      variant: { type: "string" },
      "variant-id": { type: "string" },
      rev: { type: "string" },
      repeat: { type: "string" },
      only: { type: "string" },
      kind: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      claude: { type: "string" },
      "timeout-min": { type: "string" },
      "budget-usd": { type: "string" },
      scratch: { type: "string" },
      "keep-checkout": { type: "boolean" },
      force: { type: "boolean" },
      "no-bare": { type: "boolean" },
      "keep-home": { type: "boolean" },
      "api-key-env": { type: "string" },
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
  const bare = values["no-bare"] !== true;
  const apiKeyEnv = values["api-key-env"] ?? "ANTHROPIC_API_KEY";
  if (bare && io.env[apiKeyEnv] === undefined) {
    io.err(
      `bare mode authenticates with ${apiKeyEnv}, which is not set (or pass --no-bare)`,
    );
    return 2;
  }
  const outDir = resolve(values.out);
  const scratchRoot = resolve(values.scratch ?? join(tmpdir(), "ow-eval"));
  const options: RunnerOptions = {
    claudeBin: values.claude ?? "claude",
    model: values.model ?? "opus",
    effort: values.effort ?? "high",
    timeoutMs: positive(values["timeout-min"], 45, "--timeout-min") * 60_000,
    budgetUsd: positive(values["budget-usd"], 15, "--budget-usd"),
    scratchRoot,
    outDir,
    bare,
    isolateHome: bare && values["keep-home"] !== true,
    apiKeyEnv,
    keepCheckout: values["keep-checkout"] === true,
    force: values.force === true,
    env: io.env,
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
    repoRoot: resolve(values["repo-root"] ?? DEFAULT_REPO_ROOT()),
    revision: values.rev ?? DEFAULT_REVISION,
  });
  const variantDir = join(outDir, variant.id);
  const snapshot = join(variantDir, "variant-prompt.md");
  if (existsSync(snapshot) && readFileSync(snapshot, "utf8") !== variant.text) {
    io.err(
      `variant id ${variant.id} already exists in ${outDir} with a different prompt; use another --variant-id or --out`,
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
    `done: ${sessions - failed} completed, ${failed} not completed; records in ${outDir}`,
  );
  return 0;
}

async function commandJudge(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      dataset: { type: "string" },
      out: { type: "string" },
      "judge-model": { type: "string" },
      claude: { type: "string" },
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
  if (bare && io.env[apiKeyEnv] === undefined) {
    io.err(
      `bare mode authenticates with ${apiKeyEnv}, which is not set (or pass --no-bare)`,
    );
    return 2;
  }
  const model = values["judge-model"] ?? "sonnet";
  const claude = values.claude ?? "claude";
  const budget = positive(values["budget-usd"], 2, "--budget-usd");
  const attempts = Math.floor(positive(values.attempts, 2, "--attempts"));
  const outDir = resolve(values.out);
  const byId = new Map(dataset.entries.map((e) => [e.id, e]));
  const workRoot = mkdtempSync(join(tmpdir(), "ow-eval-judge-"));
  let judged = 0;
  let failed = 0;
  try {
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
      const prompt = buildJudgePrompt(known, result.final_text);
      writeFileSync(join(dir, "judge-prompt.md"), prompt);
      let done = false;
      let lastErrors: string[] = [];
      for (let attempt = 1; attempt <= attempts && !done; attempt += 1) {
        // A fresh empty directory per call: the judge has no files to read and
        // nothing in its path names the variant.
        const work = mkdtempSync(join(workRoot, "j-"));
        const stdoutFile = join(work, "out.json");
        const extra: Record<string, string> = {};
        const key = io.env[apiKeyEnv];
        if (bare && key !== undefined) extra.ANTHROPIC_API_KEY = key;
        const run = await runGrouped(
          claude,
          [
            "-p",
            "--model",
            model,
            "--tools",
            "",
            "--no-session-persistence",
            "--output-format",
            "json",
            "--max-budget-usd",
            String(budget),
            ...(bare ? ["--bare"] : []),
          ],
          {
            cwd: work,
            env: scrubEnv(io.env, extra),
            timeoutMs: 10 * 60_000,
            stdin: prompt,
            stdoutFile,
            stderrFile: join(work, "err.log"),
          },
        );
        let answer = "";
        let cost: number | null = null;
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
          lastErrors = [`judge session produced no JSON (exit ${run.code})`];
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
    rmSync(workRoot, { recursive: true, force: true });
  }
  io.out(`judged ${judged} run(s), ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

function commandScore(args: string[], io: Io): number {
  const { values } = parseArgs({
    args,
    options: { dataset: { type: "string" }, out: { type: "string" } },
    strict: true,
  });
  const dataset = loadOrReport(values.dataset, io);
  if (dataset === null) return 2;
  if (values.out === undefined) {
    io.err("--out is required");
    return 2;
  }
  const outDir = resolve(values.out);
  const grouped = scoresByVariant(dataset, outDir);
  if (grouped.size === 0) {
    io.err(`no run records under ${outDir}`);
    return 2;
  }
  const rows = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, scores]) => ({
      aggregate: aggregate(id, scores),
      noise: computeNoise(scores),
      scores,
    }));
  writeFileSync(
    join(outDir, "scores.json"),
    `${JSON.stringify(rows, null, 2)}\n`,
  );
  io.out(renderAggregates(rows));
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
  const comparison = compareVariants(
    { aggregate: aggregate(values.a, a), scores: a, noise: computeNoise(a) },
    { aggregate: aggregate(values.b, b), scores: b },
  );
  writeFileSync(
    join(outDir, `compare-${values.a}-vs-${values.b}.json`),
    `${JSON.stringify(comparison, null, 2)}\n`,
  );
  io.out(renderComparison(comparison));
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

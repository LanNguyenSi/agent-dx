import type {
  Comparison,
  MetricDelta,
  NoiseReport,
  VariantAggregate,
} from "./score.js";

/** toFixed without a negative zero ("-0.0"). */
function fixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/^-(0(?:\.0+)?)$/, "$1");
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${fixed(value * 100, 1)}%`;
}

function usd(value: number | null): string {
  return value === null ? "n/a" : fixed(value, 2);
}

function num(value: number | null, digits = 2): string {
  return value === null ? "n/a" : fixed(value, digits);
}

export function renderAggregates(
  rows: { aggregate: VariantAggregate; noise: NoiseReport | null }[],
): string {
  const lines = [
    "| variant | runs | entries | validity | recall | recall (per-run mean) | false positives (controls) | cost total USD | cost mean USD | wall mean s | timeouts |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const { aggregate: a } of rows) {
    lines.push(
      `| ${a.variant_id} | ${a.n_runs} | ${a.n_entries} | ${pct(a.validity_rate)} | ${pct(a.recall)} | ${pct(a.recall_macro)} | ${a.false_positives} in ${a.n_control_runs} runs (${a.controls_with_false_positive} runs affected) | ${usd(a.cost_total_usd)} | ${usd(a.cost_mean_usd)} | ${num(a.wall_mean_s, 0)} | ${a.timeouts} |`,
    );
  }
  const notes: string[] = [];
  for (const { aggregate: a } of rows) {
    if (a.n_excluded > 0) {
      notes.push(
        `${a.variant_id}: ${a.n_excluded} run(s) excluded after a setup failure.`,
      );
    }
    if (a.unjudged_finding_runs > 0) {
      notes.push(
        `${a.variant_id}: ${a.unjudged_finding_runs} finding run(s) have no judgment yet and are left out of recall.`,
      );
    }
  }
  for (const { aggregate: a, noise } of rows) {
    if (noise === null) continue;
    notes.push(
      `${a.variant_id} noise over ${noise.repeats.length} repeats on ${noise.entries_compared} common entries: recall range ${pct(noise.recall_range)}, false-positive rate range ${pct(noise.false_positive_rate_range)} (absolute range ${noise.false_positives_range}), validity range ${pct(noise.validity_range)}, flip rate ${pct(noise.flip_rate)}.`,
    );
  }
  return [...lines, "", ...notes.map((n) => `- ${n}`)].join("\n");
}

function deltaRow(
  label: string,
  m: MetricDelta,
  format: (v: number | null) => string,
): string {
  const verdict =
    m.exceeds_noise === null
      ? "no noise reference"
      : m.exceeds_noise
        ? "above noise"
        : "within noise";
  return `| ${label} | ${format(m.a)} | ${format(m.b)} | ${format(m.delta)} | ${format(m.noise)} | ${verdict} |`;
}

export function renderComparison(c: Comparison): string {
  return [
    `Variant A: ${c.a}. Variant B: ${c.b}. Delta is B minus A; noise is the run-to-run range of A.`,
    "",
    "| metric | A | B | delta | noise of A | verdict |",
    "|---|---|---|---|---|---|",
    deltaRow("recall", c.recall, pct),
    deltaRow("false positives per control run", c.false_positives, (v) =>
      num(v, 3),
    ),
    deltaRow("validity", c.validity, pct),
    deltaRow("cost mean USD", c.cost_mean_usd, usd),
    deltaRow("wall mean s", c.wall_mean_s, (v) => num(v, 0)),
    "",
    `Paired recall on ${c.paired_recall.entries} common finding entries: B higher on ${c.paired_recall.b_higher}, equal on ${c.paired_recall.equal}, lower on ${c.paired_recall.b_lower}.`,
  ].join("\n");
}

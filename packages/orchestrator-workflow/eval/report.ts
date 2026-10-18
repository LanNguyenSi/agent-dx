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
    "| variant | sessions | completed | session failed | timeouts | entries | repeats | validity | recall | recall (per-entry mean) | false positives (controls) | cost total USD | cost mean USD | wall mean s |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const { aggregate: a } of rows) {
    lines.push(
      `| ${a.variant_id} | ${a.n_runs} | ${a.n_completed} | ${a.n_session_failed} | ${a.n_timeouts} | ${a.n_entries} | ${a.n_repeats} | ${pct(a.validity_rate)} | ${pct(a.recall)} (n=${a.recall_entries}) | ${pct(a.recall_macro)} | ${a.false_positives} in ${a.n_control_runs} runs, ${num(a.false_positives_per_control_run, 3)} per control entry (n=${a.control_entries}) | ${usd(a.cost_total_usd)} | ${usd(a.cost_mean_usd)} | ${num(a.wall_mean_s, 0)} |`,
    );
  }
  const notes: string[] = [
    "Validity, recall and false positives count completed runs only, as per-entry means over repeats; session failures and timeouts are counted on their own.",
  ];
  for (const { aggregate: a } of rows) {
    if (a.n_setup_failed > 0) {
      notes.push(
        `${a.variant_id}: ${a.n_setup_failed} run(s) excluded after a setup failure.`,
      );
    }
    if (a.unjudged_finding_runs > 0) {
      notes.push(
        `${a.variant_id}: ${a.unjudged_finding_runs} finding run(s) have no judgment yet and are left out of recall.`,
      );
    }
    if (a.recall_by_repeat.length > 1) {
      notes.push(
        `${a.variant_id} recall by repeat: ${a.recall_by_repeat.map((r) => `run-${r.repeat} ${pct(r.recall)} (n=${r.entries})`).join(", ")}.`,
      );
    }
  }
  for (const { aggregate: a, noise } of rows) {
    if (noise === null) continue;
    notes.push(
      `${a.variant_id} noise over ${noise.repeats.length} repeats on ${noise.entries_compared} common entries: recall range ${pct(noise.recall_range)} (n=${noise.recall_entries}), false-positive rate range ${num(noise.false_positive_rate_range, 3)} per control entry (n=${noise.control_entries}, absolute range ${noise.false_positives_range}), validity range ${pct(noise.validity_range)}, flip rate ${pct(noise.flip_rate)}.`,
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
  return `| ${label} | ${format(m.a)} | ${format(m.b)} | ${format(m.delta)} | ${format(m.noise)} | ${format(m.floor)} | ${verdict} (n=${m.n}, A ${m.a_repeats} repeat(s), B ${m.b_repeats} repeat(s)) |`;
}

export function renderComparison(c: Comparison): string {
  return [
    `Variant A: ${c.a}. Variant B: ${c.b}. Each metric is paired: both variants on the same entries, per-entry means over repeats. Delta is B minus A; the verdict compares it with the larger of A's run-to-run range and a floor of ${c.noise_floor_entries} entry's worth (floor = entries / n).`,
    "",
    "| metric | A | B | delta | noise of A | floor | verdict |",
    "|---|---|---|---|---|---|---|",
    deltaRow("recall", c.recall, pct),
    deltaRow("false positives per control entry", c.false_positives, (v) =>
      num(v, 3),
    ),
    deltaRow("validity", c.validity, pct),
    deltaRow("cost mean USD", c.cost_mean_usd, usd),
    deltaRow("wall mean s", c.wall_mean_s, (v) => num(v, 0)),
    "",
    `Paired recall on ${c.paired_recall.entries} common finding entries: B higher on ${c.paired_recall.b_higher}, equal on ${c.paired_recall.equal}, lower on ${c.paired_recall.b_lower}.`,
  ].join("\n");
}

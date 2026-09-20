import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkText, checkFiles } from "../src/engine.js";
import { defaultConfig, mergeConfig } from "../src/config.js";
import { allPacks } from "../src/packs/registry.js";

const WORKFLOW_PATH = ".github/workflows/publish.yml";

const baseOpts = () => ({
  packs: allPacks,
  config: defaultConfig(),
  packFilter: ["workflow-slop"],
});

function runViolations(text: string, filePath = WORKFLOW_PATH) {
  return checkText(text, filePath, baseOpts()).filter(
    (v) => v.pack === "workflow-slop",
  );
}

describe("workflow-slop/run-expression", () => {
  it("flags a step-output expression interpolated into run: (the agent-tasks #517 shape, single-line)", () => {
    const text = [
      "name: publish",
      "on: push",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - id: target",
      "        run: echo setting up",
      "      - run: npm publish --tag ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].ruleId).toBe("workflow-slop/run-expression");
    expect(v[0].severity).toBe("block");
  });

  it("flags a step-output expression inside a block-scalar (|) run:", () => {
    const text = [
      "on: push",
      "jobs:",
      "  publish:",
      "    steps:",
      "      - run: |",
      "          set -e",
      "          npm publish --tag ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(1);
  });

  it("flags needs.*.outputs.*, inputs.*, env.*, and github.ref/head_ref, one finding each", () => {
    const cases = [
      "${{ needs.build.outputs.version }}",
      "${{ inputs.version }}",
      "${{ env.VERSION }}",
      "${{ github.ref }}",
      "${{ github.ref_name }}",
      "${{ github.head_ref }}",
      "${{ github.base_ref }}",
      "${{ github.event.pull_request.title }}",
      "${{ vars.SOME_VAR }}",
    ];
    for (const expr of cases) {
      const text = [
        "on: push",
        "jobs:",
        "  j:",
        "    steps:",
        `      - run: echo ${expr}`,
      ].join("\n");
      const v = runViolations(text);
      expect(v, `expected exactly one finding for ${expr}`).toHaveLength(1);
    }
  });

  it("allows steps.<id>.outcome/.conclusion (a fixed 4-value runtime enum, not a step output) but still flags steps.<id>.outputs.*", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - id: deprecate",
      "        run: npm deprecate x y",
      "      - run: echo ${{ steps.deprecate.outcome }}",
      "      - run: echo ${{ steps.deprecate.conclusion }}",
      "      - run: echo ${{ steps.deprecate.outputs.foo }}",
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].matched).toContain("outputs.foo");
  });

  it("flags matrix.* by default (deliberately excluded from the allowlist: not verifiable as literal-only from a scalar alone)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    strategy:",
      "      matrix:",
      "        node: [20, 22]",
      "    steps:",
      "      - run: echo ${{ matrix.node }}",
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(1);
  });

  it("workflow.allowExpressions can explicitly allowlist a repo-verified-literal matrix field", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    strategy:",
      "      matrix:",
      "        node: [20, 22]",
      "    steps:",
      "      - run: echo ${{ matrix.node }}",
    ].join("\n");
    const withExtra = mergeConfig({
      workflow: { allowExpressions: ["matrix.node"] },
    });
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config: withExtra,
      packFilter: ["workflow-slop"],
    }).filter((x) => x.pack === "workflow-slop");
    expect(v).toHaveLength(0);
  });

  it("negative control: allowlisted contexts routed through run: produce 0 findings", () => {
    const allowed = [
      "github.workspace",
      "runner.temp",
      "runner.os",
      "runner.arch",
      "runner.tool_cache",
      "github.action_path",
      "github.run_id",
      "github.run_number",
      "github.run_attempt",
      "github.sha",
      "github.job",
      "github.repository",
      "github.repository_owner",
      "github.actor",
      "github.event_name",
      "github.workflow",
      "github.server_url",
      "github.api_url",
      "github.token",
      "secrets.NPM_TOKEN",
      "secrets.ANY_NAME_AT_ALL",
      "steps.deprecate.outcome",
      "steps.move.conclusion",
    ];
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      ...allowed.map((expr) => `      - run: echo "\${{ ${expr} }}"`),
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(0);
  });

  it("negative control: the env-routed fix (agent-tasks #517's actual shape) produces 0 findings", () => {
    const text = [
      "on: push",
      "jobs:",
      "  publish:",
      "    steps:",
      "      - id: target",
      "        run: echo id",
      "      - env:",
      "          EXPECTED: ${{ steps.target.outputs.expected }}",
      '        run: npm publish --tag "$EXPECTED"',
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(0);
  });

  it("negative control: a ${{ }} in name:, if:, with:, or env: (not run:) is not a finding", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - name: ${{ steps.x.outputs.label }}",
      "        if: ${{ steps.x.outputs.ok == 'true' }}",
      "        uses: some/action@v1",
      "        with:",
      "          value: ${{ steps.x.outputs.value }}",
      "        env:",
      "          V: ${{ steps.x.outputs.value }}",
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(0);
  });

  it("negative control: the same unsafe expression outside .github/workflows/*.yml is not scanned", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: echo ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text, "docs/example-workflow.yml");
    expect(v).toHaveLength(0);
  });

  it("a single-quoted run: scalar is scanned the same as a plain or double-quoted one", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: 'echo ${{ steps.target.outputs.expected }}'",
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(1);
  });

  it("workflow.allowExpressions extends the allowlist (e.g. a repo-verified-literal matrix field)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: echo ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const withExtra = mergeConfig({
      workflow: { allowExpressions: ["steps.target.outputs.expected"] },
    });
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config: withExtra,
      packFilter: ["workflow-slop"],
    }).filter((x) => x.pack === "workflow-slop");
    expect(v).toHaveLength(0);
  });

  it("off by default: workflow-slop does not fire without --pack/config opt-in", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: echo ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config: defaultConfig(),
    });
    expect(v.filter((x) => x.pack === "workflow-slop")).toHaveLength(0);
  });

  // ── file targeting: extension and nesting (round-2 fix) ─────────────────

  it("flags a .github/workflows/*.yaml file the same as .yml", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: echo ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text, ".github/workflows/publish.yaml");
    expect(v.some((x) => x.ruleId === "workflow-slop/run-expression")).toBe(
      true,
    );
  });

  it("does not scan a file nested one directory deeper than .github/workflows/ (pins the [^/]+ clause)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: echo ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text, ".github/workflows/sub/deep.yml");
    expect(v).toHaveLength(0);
  });

  it("still matches a workflow path spelled with backslash separators (Windows path.join)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: echo ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text, ".github\\workflows\\publish.yml");
    expect(v.some((x) => x.ruleId === "workflow-slop/run-expression")).toBe(
      true,
    );
  });

  // ── with:-block run key is not a shell script (round-2 fix) ─────────────

  it("does not treat a custom action's with:.run input as a shell run: (only a step's own run: is scanned)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: some/action@v1",
      "        with:",
      "          run: echo ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(0);
  });

  it("still flags the step's own run: sitting next to a with: block", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: some/action@v1",
      "        with:",
      "          run: echo ${{ steps.target.outputs.expected }}",
      "      - run: echo ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text);
    expect(
      v.filter((x) => x.ruleId === "workflow-slop/run-expression"),
    ).toHaveLength(1);
  });

  // ── with:-gating is schema-position, not key-name-anywhere (round-3 fix) ─

  it("flags a run: under a job literally named 'with' (not a uses: step's input block)", () => {
    const text = [
      "name: t",
      "on: push",
      "jobs:",
      "  with:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo ${{ github.head_ref }}",
    ].join("\n");
    const v = runViolations(text);
    expect(
      v.filter((x) => x.ruleId === "workflow-slop/run-expression"),
    ).toHaveLength(1);
  });

  it("does not treat a run: two levels deep under a uses: step's with: block as a shell script", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: some/action@v1",
      "        with:",
      "          nested:",
      "            run: echo ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(0);
  });

  it("still flags a run: step whose job also has an env: { with: x } key", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    env:",
      "      with: x",
      "    steps:",
      "      - run: echo ${{ github.head_ref }}",
    ].join("\n");
    const v = runViolations(text);
    expect(
      v.filter((x) => x.ruleId === "workflow-slop/run-expression"),
    ).toHaveLength(1);
  });

  it("still scans a run: under a with: key at the top level of the workflow (not a uses: step's input block)", () => {
    const text = [
      "on: push",
      "with:",
      "  run: echo ${{ steps.target.outputs.expected }}",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: echo hi",
    ].join("\n");
    const v = runViolations(text);
    expect(
      v.filter((x) => x.ruleId === "workflow-slop/run-expression"),
    ).toHaveLength(1);
  });

  // ── executed-input list: consulted BEFORE the with: exemption ───────────

  it("flags a ${{ }} inside actions/github-script's with.script (block scalar), naming the input as executed code", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      // v99: a fictitious major, deliberately off the node20-action-major
      // default list, so this fixture isolates run-expression's finding.
      "      - uses: actions/github-script@v99",
      "        with:",
      "          script: |",
      '            const title = "${{ github.event.issue.title }}";',
      "            console.log(title);",
    ].join("\n");
    const v = runViolations(text).filter(
      (x) => x.ruleId === "workflow-slop/run-expression",
    );
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("block");
    expect(v[0].message).toContain("actions/github-script");
    expect(v[0].message).toContain("script");
    expect(v[0].message).toContain("executes as code");
  });

  it("flags with.script written as a single-line plain scalar", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/github-script@v99",
      "        with:",
      "          script: console.log(${{ github.event.issue.title }})",
    ].join("\n");
    const v = runViolations(text).filter(
      (x) => x.ruleId === "workflow-slop/run-expression",
    );
    expect(v).toHaveLength(1);
  });

  it("flags with.script written as a double-quoted scalar", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/github-script@v99",
      "        with:",
      '          script: "console.log(${{ github.event.issue.title }})"',
    ].join("\n");
    const v = runViolations(text).filter(
      (x) => x.ruleId === "workflow-slop/run-expression",
    );
    expect(v).toHaveLength(1);
  });

  it("negative control: the documented non-attacker-controllable contexts stay clean inside with.script too", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/github-script@v99",
      "        with:",
      "          script: console.log(${{ github.repository }})",
    ].join("\n");
    const v = runViolations(text).filter(
      (x) => x.ruleId === "workflow-slop/run-expression",
    );
    expect(v).toHaveLength(0);
  });

  it("negative control: other with: inputs of the same github-script step stay exempt", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/github-script@v99",
      "        with:",
      "          debug: ${{ steps.target.outputs.expected }}",
      "          script: console.log('safe')",
    ].join("\n");
    const v = runViolations(text).filter(
      (x) => x.ruleId === "workflow-slop/run-expression",
    );
    expect(v).toHaveLength(0);
  });

  it("negative control: with.script of an action not on the executed-input list stays exempt", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: some/other-action@v1",
      "        with:",
      "          script: ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(0);
  });

  it("negative control: a local ./ action's with.script never matches (parseUsesValue has no owner/repo for it)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: ./local-action",
      "        with:",
      "          script: ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(0);
  });

  it("negative control: a docker:// action's with.script never matches", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: docker://alpine:3",
      "        with:",
      "          script: ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(0);
  });

  it("matches regardless of ref: a sha-pinned github-script with a trailing version comment is still flagged", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/github-script@e69ef5462fd455e02edcaf4dad0af5c3766a0ac # v99",
      "        with:",
      "          script: ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text).filter(
      (x) => x.ruleId === "workflow-slop/run-expression",
    );
    expect(v).toHaveLength(1);
  });

  it("matches regardless of ref: a moving branch ref is still flagged", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/github-script@main",
      "        with:",
      "          script: ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text).filter(
      (x) => x.ruleId === "workflow-slop/run-expression",
    );
    expect(v).toHaveLength(1);
  });

  it("matches owner/repo case-insensitively", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: Actions/Github-Script@v99",
      "        with:",
      "          script: ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text).filter(
      (x) => x.ruleId === "workflow-slop/run-expression",
    );
    expect(v).toHaveLength(1);
  });

  it("workflow.executedActionInputs extends the default list", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: acme/run-code@v1",
      "        with:",
      "          code: ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const cfg = mergeConfig({
      workflow: { executedActionInputs: ["acme/run-code:code"] },
    });
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config: cfg,
      packFilter: ["workflow-slop"],
    }).filter((x) => x.ruleId === "workflow-slop/run-expression");
    expect(v).toHaveLength(1);
  });

  it("workflow.executedActionInputs does not widen an unconfigured action", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: acme/other-action@v1",
      "        with:",
      "          code: ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const cfg = mergeConfig({
      workflow: { executedActionInputs: ["acme/run-code:code"] },
    });
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config: cfg,
      packFilter: ["workflow-slop"],
    }).filter((x) => x.ruleId === "workflow-slop/run-expression");
    expect(v).toHaveLength(0);
  });

  // ── executed-input name matching is case- and space/underscore-insensitive,
  // mirroring the Actions runner's own INPUT_<NAME> fold ──────────────────

  it("matches a with: key capitalised as Script (the Actions runner folds with: input names case-insensitively into INPUT_<NAME>)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/github-script@v99",
      "        with:",
      "          Script: console.log(${{ github.event.issue.title }})",
    ].join("\n");
    const v = runViolations(text).filter(
      (x) => x.ruleId === "workflow-slop/run-expression",
    );
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("actions/github-script");
    expect(v[0].message).toContain("executes as code");
  });

  it("matches a with: key fully upper-cased as SCRIPT the same way", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/github-script@v99",
      "        with:",
      "          SCRIPT: console.log(${{ github.event.issue.title }})",
    ].join("\n");
    const v = runViolations(text).filter(
      (x) => x.ruleId === "workflow-slop/run-expression",
    );
    expect(v).toHaveLength(1);
  });

  // The runner and @actions/core fold input names UP. A dotless i and a
  // long s upper-case to the ASCII letters of SCRIPT but lower-case to
  // themselves, so a lower-case fold would miss both.
  for (const [label, key] of [
    ["a dotless i (U+0131)", "scr\u0131pt"],
    ["a long s (U+017F)", "\u017Fcript"],
  ] as const) {
    it(`matches a with: key spelled with ${label} that upper-cases to SCRIPT`, () => {
      const text = [
        "on: push",
        "jobs:",
        "  j:",
        "    steps:",
        "      - uses: actions/github-script@v99",
        "        with:",
        `          ${key}: console.log(\${{ github.event.issue.title }})`,
      ].join("\n");
      const v = runViolations(text).filter(
        (x) => x.ruleId === "workflow-slop/run-expression",
      );
      expect(v).toHaveLength(1);
    });
  }

  it("does not match a Kelvin sign key (U+212A) against an ASCII-named entry: it lower-cases to k but does not upper-case to K", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: acme/run-code@v1",
      "        with:",
      "          to\u212Aen: console.log(${{ github.event.issue.title }})",
    ].join("\n");
    const cfg = mergeConfig({
      workflow: { executedActionInputs: ["acme/run-code:token"] },
    });
    const scan = (t: string) =>
      checkText(t, WORKFLOW_PATH, {
        packs: allPacks,
        config: cfg,
        packFilter: ["workflow-slop"],
      }).filter((x) => x.ruleId === "workflow-slop/run-expression");
    expect(scan(text)).toHaveLength(0);
    // Control: the same step with an ASCII k is reported, so the zero above
    // comes from the Kelvin sign and not from a dead fixture.
    expect(scan(text.replace(/\u212A/g, "k"))).toHaveLength(1);
  });

  it("a config-supplied entry whose case differs from the workflow key still matches (acme/run-code:Code vs a workflow with: code:)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: acme/run-code@v1",
      "        with:",
      "          code: ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const cfg = mergeConfig({
      workflow: { executedActionInputs: ["acme/run-code:Code"] },
    });
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config: cfg,
      packFilter: ["workflow-slop"],
    }).filter((x) => x.ruleId === "workflow-slop/run-expression");
    expect(v).toHaveLength(1);
  });

  it("a space in the workflow with: key matches an underscore in the configured entry (acme/run-code:my_input vs a workflow with: 'my input:')", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: acme/run-code@v1",
      "        with:",
      "          my input: ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const cfg = mergeConfig({
      workflow: { executedActionInputs: ["acme/run-code:my_input"] },
    });
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config: cfg,
      packFilter: ["workflow-slop"],
    }).filter((x) => x.ruleId === "workflow-slop/run-expression");
    expect(v).toHaveLength(1);
  });

  // ── scope: only .github/workflows/*.yml|.yaml is scanned; a composite
  // action's own action.yml is a documented, deliberate blind spot ───────

  it("negative control: a github-script step's with.script inside a composite action's own action.yml is not scanned (workflow-slop only reads .github/workflows/*.yml|.yaml, per WORKFLOW_FILE_RE)", () => {
    const text = [
      "runs:",
      "  using: composite",
      "  steps:",
      "    - uses: actions/github-script@v99",
      "      with:",
      "        script: console.log(${{ github.event.issue.title }})",
    ].join("\n");
    const v = runViolations(text, "action.yml");
    expect(v).toHaveLength(0);
  });

  // ── null/empty uses: fail-closed for the with: exemption ────────────────

  it("fail-closed: a step whose uses: is present but null no longer grants the with: exemption (its run: is walked like a plain mapping)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses:",
      "        with:",
      "          run: echo ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text);
    expect(
      v.filter((x) => x.ruleId === "workflow-slop/run-expression"),
    ).toHaveLength(1);
  });

  it("fail-closed: a step whose uses: is an empty string no longer grants the with: exemption", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      '      - uses: ""',
      "        with:",
      "          run: echo ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text);
    expect(
      v.filter((x) => x.ruleId === "workflow-slop/run-expression"),
    ).toHaveLength(1);
  });

  it("negative control: a step with a real, non-empty uses: still grants the with: exemption (unaffected by the fail-closed fix)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: some/action@v1",
      "        with:",
      "          run: echo ${{ steps.target.outputs.expected }}",
    ].join("\n");
    const v = runViolations(text);
    expect(v).toHaveLength(0);
  });

  // ── unparseable-workflow: fail-closed on a broken workflow file ─────────

  describe("workflow-slop/unparseable-workflow", () => {
    it("reports a finding (not a clean result) when an unterminated quote drops a later unsafe expression", () => {
      const text = [
        "on: push",
        "jobs:",
        "  j:",
        "    steps:",
        '      - run: "unterminated',
        "      - run: echo ${{ github.base_ref }}",
      ].join("\n");
      const v = runViolations(text);
      expect(
        v.some((x) => x.ruleId === "workflow-slop/unparseable-workflow"),
      ).toBe(true);
      // Previously this fixture reported clean (exit 0): a workflow-slop
      // finding must exist regardless of whether run-expression itself
      // recovers the later ${{ github.base_ref }} from the partial tree.
      expect(v.length).toBeGreaterThan(0);
    });

    it("reports a finding for a malformed flow collection (jobs: [[[)", () => {
      const v = runViolations("jobs: [[[");
      expect(
        v.some((x) => x.ruleId === "workflow-slop/unparseable-workflow"),
      ).toBe(true);
    });

    it("does not fire on a workflow file that parses cleanly", () => {
      const text = [
        "on: push",
        "jobs:",
        "  j:",
        "    steps:",
        "      - run: echo hi",
      ].join("\n");
      const v = runViolations(text);
      expect(
        v.some((x) => x.ruleId === "workflow-slop/unparseable-workflow"),
      ).toBe(false);
    });

    it("negative control: an empty file reports clean", () => {
      const v = runViolations("");
      expect(v).toHaveLength(0);
    });

    it("negative control: valid YAML that isn't a workflow shape reports clean", () => {
      const v = runViolations("foo: bar");
      expect(v).toHaveLength(0);
    });
  });

  // ── workflow.allowExpressions unmatched-entry warning (round-2 fix) ─────

  describe("workflow.allowExpressions unmatched-entry warning", () => {
    let tmp: string;

    function writeWorkflow(text: string): string {
      const dir = path.join(tmp, ".github", "workflows");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "ci.yml");
      fs.writeFileSync(file, text);
      return file;
    }

    it("surfaces a warning when an allowExpressions entry matches no scanned run: expression", () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-workflow-"));
      const file = writeWorkflow(
        [
          "on: push",
          "jobs:",
          "  j:",
          "    steps:",
          "      - run: echo ${{ matrix.node }}",
        ].join("\n"),
      );
      const cfg = mergeConfig({
        packs: { "workflow-slop": true },
        workflow: { allowExpressions: ["matrix.node", "matrix.os"] },
      });
      const summary = checkFiles([file], {
        packs: allPacks,
        config: cfg,
        packFilter: ["workflow-slop"],
      });
      expect(
        summary.warnings?.some((w) =>
          w.includes('workflow.allowExpressions entry "matrix.os"'),
        ),
      ).toBe(true);
      expect(summary.warnings?.some((w) => w.includes('"matrix.node"'))).toBe(
        false,
      );
    });

    it("does not warn when every allowExpressions entry matches a scanned expression", () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-workflow-"));
      const file = writeWorkflow(
        [
          "on: push",
          "jobs:",
          "  j:",
          "    steps:",
          "      - run: echo ${{ matrix.node }}",
        ].join("\n"),
      );
      const cfg = mergeConfig({
        packs: { "workflow-slop": true },
        workflow: { allowExpressions: ["matrix.node"] },
      });
      const summary = checkFiles([file], {
        packs: allPacks,
        config: cfg,
        packFilter: ["workflow-slop"],
      });
      expect(summary.warnings).toBeUndefined();
    });

    it("does not surface the warning when --pack names another pack even though config enables workflow-slop", () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-workflow-"));
      const file = writeWorkflow(
        [
          "on: push",
          "jobs:",
          "  j:",
          "    steps:",
          "      - run: echo ${{ matrix.node }}",
        ].join("\n"),
      );
      const cfg = mergeConfig({
        packs: { "workflow-slop": true },
        workflow: { allowExpressions: ["matrix.os"] },
      });
      const summary = checkFiles([file], {
        packs: allPacks,
        config: cfg,
        packFilter: ["prose-slop"],
      });
      expect(
        (summary.warnings ?? []).filter((w) => w.includes("allowExpressions")),
      ).toEqual([]);
    });

    it("does not surface the warning when workflow-slop is not the selected pack", () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-workflow-"));
      const file = writeWorkflow(
        [
          "on: push",
          "jobs:",
          "  j:",
          "    steps:",
          "      - run: echo ${{ matrix.node }}",
        ].join("\n"),
      );
      const cfg = mergeConfig({
        workflow: { allowExpressions: ["matrix.node", "matrix.os"] },
      });
      const summary = checkFiles([file], {
        packs: allPacks,
        config: cfg,
        packFilter: ["prose-slop"],
      });
      expect(
        summary.warnings?.some((w) => w.includes("allowExpressions")),
      ).toBeFalsy();
    });
  });
});

// ─────────────────────────── node20-action-major ───────────────────────────

describe("workflow-slop/node20-action-major", () => {
  function ruleViolations(text: string, filePath = WORKFLOW_PATH) {
    return runViolations(text, filePath).filter(
      (v) => v.ruleId === "workflow-slop/node20-action-major",
    );
  }

  it("flags a step-level uses: on the default Node-20 list (actions/checkout@v4)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/checkout@v4",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("block");
    expect(v[0].matched).toBe("actions/checkout@v4");
  });

  it("flags a job-level uses: the same as a step-level one (docker/build-push-action@v5, a JS action despite the org name)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    uses: docker/build-push-action@v5",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
  });

  it("flags a fixed point-release pin by its major (actions/setup-node@v4.0.3 still resolves to the v4 major)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/setup-node@v4.0.3",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
  });

  it("negative control: a major not on the list (actions/checkout@v5) is not flagged", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/checkout@v5",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("negative control: a local ./path action is never flagged", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: ./.github/actions/local",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("negative control: a docker://image reference is never flagged", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: docker://alpine:3.18",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("negative control: a reusable-workflow call (uses: naming a .yml file) is never flagged, even when its owner/repo (actions/checkout) is itself on the default Node-20 list", () => {
    // Deliberately owned by "actions/checkout" (on the default list as
    // actions/checkout@v4): if the `.ya?ml` reusable-workflow exclusion in
    // parseUsesValue were ever removed, `before.split("/")` would still
    // resolve ownerRepo to "actions/checkout" and this would start
    // flagging. An owner/repo not on the list (the previous fixture) would
    // survive that same mutation undetected.
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    uses: actions/checkout/.github/workflows/build.yml@v4",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("flags a sha-pinned uses: only when a trailing # vN comment resolves it to a listed major", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/checkout@8f4b7f8864 # v4",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
  });

  it("documented limitation: a sha-pinned uses: with no version comment is not flagged", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/checkout@8f4b7f8864",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("workflow.node20Majors extends the default list", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: acme/custom-action@v1",
    ].join("\n");
    const cfg = mergeConfig({
      workflow: { node20Majors: ["acme/custom-action@v1"] },
    });
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config: cfg,
      packFilter: ["workflow-slop"],
    }).filter((x) => x.ruleId === "workflow-slop/node20-action-major");
    expect(v).toHaveLength(1);
  });

  it("workflow.node20MajorsIgnore drops a default-list entry", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/checkout@v4",
    ].join("\n");
    const cfg = mergeConfig({
      workflow: { node20MajorsIgnore: ["actions/checkout@v4"] },
    });
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config: cfg,
      packFilter: ["workflow-slop"],
    }).filter((x) => x.ruleId === "workflow-slop/node20-action-major");
    expect(v).toHaveLength(0);
  });

  it("negative control: off by default, does not fire without --pack/config opt-in", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/checkout@v4",
    ].join("\n");
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config: defaultConfig(),
    });
    expect(v.filter((x) => x.pack === "workflow-slop")).toHaveLength(0);
  });

  it("the verified default list excludes softprops/action-gh-release@v1 (runs.using: node16, not node20) but includes @v2", async () => {
    const { DEFAULT_NODE20_ACTIONS } =
      await import("../src/data/node20-actions.js");
    const uses = DEFAULT_NODE20_ACTIONS.map((e) => e.uses);
    expect(uses).not.toContain("softprops/action-gh-release@v1");
    expect(uses).toContain("softprops/action-gh-release@v2");
  });

  it("matches owner/repo case-insensitively (Actions/Checkout@v4 resolves to the same default-list entry as actions/checkout@v4)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: Actions/Checkout@v4",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
  });

  it("matches the version letter case-insensitively (actions/checkout@V4 resolves to the v4 default-list entry)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/checkout@V4",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
  });

  it("case-folds a workflow.node20MajorsIgnore entry against a differently-cased default-list entry", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/checkout@v4",
    ].join("\n");
    const cfg = mergeConfig({
      workflow: { node20MajorsIgnore: ["ACTIONS/CHECKOUT@V4"] },
    });
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config: cfg,
      packFilter: ["workflow-slop"],
    }).filter((x) => x.ruleId === "workflow-slop/node20-action-major");
    expect(v).toHaveLength(0);
  });

  it("resolves a prerelease-suffixed ref to its major (actions/checkout@v4-beta still resolves to v4)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/checkout@v4-beta",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
  });

  it("negative control: a uses:-named input inside a real step's with: block is not flagged (mirrors the run:-named-input gating collectRunScalars already has)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: acme/custom-action@v9",
      "        with:",
      "          uses: actions/checkout@v4",
    ].join("\n");
    // Only the step's real `uses:` (acme/custom-action@v9, not on the
    // default list) is collected; the `with:` block's `uses:` input is a
    // custom-action input, not a step, and must not be flagged even
    // though its text is exactly a default-list entry.
    expect(ruleViolations(text)).toHaveLength(0);
  });
});

// ───────────── audit-gate-missing / audit-gate-shape ─────────────
//
// These two rules are a SHAPE ALLOWLIST, so the tests come in two
// halves: negative controls that pin which blocks are recognised
// (every one of them a real fleet shape or a variant an operator
// would plausibly write), and findings that pin the reason string
// reported for everything else. The reason strings are asserted
// exactly, because "is reported at all" was satisfied by earlier
// revisions of this rule that reported the wrong thing.

const AUDIT_PATH = ".github/workflows/audit.yml";

const MISSING_RULE = "workflow-slop/audit-gate-missing";
const SHAPE_RULE = "workflow-slop/audit-gate-shape";

function auditViolations(
  text: string,
  ruleId: string,
  config = defaultConfig(),
  filePath = AUDIT_PATH,
) {
  return checkText(text, filePath, {
    packs: allPacks,
    config,
    packFilter: ["workflow-slop"],
  }).filter((v) => v.ruleId === ruleId);
}

const missingViolations = (text: string, config = defaultConfig()) =>
  auditViolations(text, MISSING_RULE, config);
const shapeViolations = (text: string, config = defaultConfig()) =>
  auditViolations(text, SHAPE_RULE, config);

/** An audit.yml with the fleet's non-blocking report step plus `gateStep`. */
function auditYml(gateStep: string[]): string {
  return [
    "on: push",
    "jobs:",
    "  audit:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: npm audit (full report, non-blocking)",
    "        run: timeout 60s npm audit --no-fund || true",
    ...gateStep,
  ].join("\n");
}

/** A gate step whose `run:` is the literal block scalar `body`. */
function gateStep(body: string[], stepKeys: string[] = []): string[] {
  return [
    "      - name: npm audit gate (high/critical fail)",
    ...stepKeys.map((k) => `        ${k}`),
    "        run: |",
    ...body.map((line) => `          ${line}`),
  ];
}

const SHAPE_MESSAGE_TAIL =
  "A gate step must match one of the recognised shapes (`R-bare`: the gate command alone, no tail; `R-classify`: `set +e`, the gate, `VAR=$?`, `set -e`, then an `exit` of a non-zero literal and an `exit` of the captured status) or an exact template registered in `workflow.auditGateTemplates`.";

/**
 * The full message `audit-gate-shape` reports for `reason`. Only the
 * envelope is shared with the rule; every test writes its own `reason`
 * out literally, since the reason is the load-bearing part.
 */
function shapeMessage(
  reason: string,
  opts: { digest?: string; signal?: string } = {},
): string {
  const parts = [
    `Unrecognised npm-audit gate shape in this audit workflow: ${reason}.`,
    SHAPE_MESSAGE_TAIL,
  ];
  if (opts.digest) {
    parts.push(
      `No registered template matches this block; its normalised statements hash to sha256 ${opts.digest}.`,
    );
  }
  if (opts.signal)
    parts.push(`Detected neutralisation signal: ${opts.signal}.`);
  return parts.join(" ");
}

const MISSING_GATE_MESSAGE =
  "No certifiable npm-audit gate command was found in this audit workflow: no `run:` step's normalised shell statements invoke `npm audit` with `--audit-level=low`, `--audit-level=moderate`, `--audit-level=high`, or `--audit-level=critical`. Text inside a here-doc body is data, not a command, and a `run:` scalar that is not a literal block scalar (`|`) or a single-line plain scalar is not analysed as shell text, so neither counts as a present gate. (This rule only recognises `npm audit`; a `pnpm audit` or a non-npm audit command is out of its scope, see the README.)";

// The fleet's canonical gate block, byte-identical (after normalisation)
// in all ten fleet audit.yml files at the revision this fixture was taken
// from. The digest below is the sha256 of its normalised statements, the
// value a consuming repo registers in `workflow.auditGateTemplates`. It
// is NOT a package default: a canonical org gate block is org content.
const REAL_FLEET_AUDIT_YML = fs.readFileSync(
  path.join(import.meta.dirname, "fixtures", "fleet-audit-real-shape.yml"),
  "utf8",
);

const FLEET_TEMPLATE_SHA256 =
  "039827d6b99e8648dad25933d62413fd94e32de33be03c0d46cea225b7b6f0ec";

const withFleetTemplate = () =>
  mergeConfig({
    workflow: {
      auditGateTemplates: [
        { name: "pandora-canonical-audit-gate", sha256: FLEET_TEMPLATE_SHA256 },
      ],
    },
  });

// The canonical `set +e` / capture / restore / verdict shape, reduced to
// the statements `R-classify` actually requires.
const CLASSIFY_BODY = [
  "set +e",
  "npm audit --audit-level=high",
  "STATUS=$?",
  "set -e",
  'if [ "$STATUS" -ne 0 ]; then',
  "  exit 1",
  "fi",
  "exit $STATUS",
];

describe("workflow-slop/audit-gate-missing", () => {
  it("flags an audit.yml with no npm-audit gate step at all", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm ci",
    ].join("\n");
    const v = missingViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(MISSING_GATE_MESSAGE);
    expect(v[0].severity).toBe("block");
  });

  it("the report step's own `npm audit --no-fund || true` (no --audit-level) is not a gate", () => {
    const text = auditYml([]);
    expect(missingViolations(text)).toHaveLength(1);
    // ...and it is not treated as a gate step by the shape rule either.
    expect(shapeViolations(text)).toHaveLength(0);
  });

  it("a gate command sitting only in a shell comment is not a present gate", () => {
    const text = auditYml(
      gateStep([
        "# npm audit --audit-level=high (temporarily disabled)",
        "true",
      ]),
    );
    expect(missingViolations(text)).toHaveLength(1);
    expect(shapeViolations(text)).toHaveLength(0);
  });

  // ACCEPTANCE PROBE p4: the gate moved into a here-doc body.
  it("acceptance probe p4: a gate command only inside a `cat <<'MSG'` here-doc body is not a present gate", () => {
    const text = auditYml(
      gateStep([
        "cat <<'MSG'",
        "npm audit --audit-level=high",
        "MSG",
        "echo done",
      ]),
    );
    const v = missingViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(MISSING_GATE_MESSAGE);
    // The step is not a gate step at all once the here-doc body is gone,
    // so the shape rule has nothing to judge: the missing-gate rule is
    // the one that reports this.
    expect(shapeViolations(text)).toHaveLength(0);
  });

  // ACCEPTANCE PROBE p5: the block rewritten as a folded scalar.
  it("acceptance probe p5: a gate in a folded `run: >` scalar is not a present gate, and the shape rule refuses it", () => {
    const text = auditYml([
      "      - name: npm audit gate (high/critical fail)",
      "        run: >",
      "          npm audit",
      "          --audit-level=high",
    ]);
    const missing = missingViolations(text);
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toBe(MISSING_GATE_MESSAGE);
    const shape = shapeViolations(text);
    expect(shape).toHaveLength(1);
    expect(shape[0].message).toBe(
      shapeMessage(
        "the gate step's `run:` value is a folded block scalar (`>`), not a literal block scalar (`|`) or a single-line plain scalar",
      ),
    );
  });

  it("a gate in a multi-line double-quoted scalar is not a present gate, and the shape rule refuses it", () => {
    const text = auditYml([
      "      - name: npm audit gate (high/critical fail)",
      '        run: "npm audit --audit-level=high\\n  || true"',
    ]);
    expect(missingViolations(text)).toHaveLength(1);
    const shape = shapeViolations(text);
    expect(shape).toHaveLength(1);
    expect(shape[0].message).toContain(
      "the gate step's `run:` value is a quoted scalar (YAML escapes are not decoded before shell analysis)",
    );
  });

  it("negative control: a single-line plain `run:` gate is a present gate", () => {
    const text = auditYml([
      "      - name: npm audit gate (high/critical fail)",
      "        run: npm audit --audit-level=high",
    ]);
    expect(missingViolations(text)).toHaveLength(0);
  });

  it("negative control: the real fleet audit.yml has a present gate", () => {
    expect(missingViolations(REAL_FLEET_AUDIT_YML)).toHaveLength(0);
  });

  it("does not scan a workflow file that is not audit.yml/audit.yaml", () => {
    const text = [
      "on: push",
      "jobs:",
      "  ci:",
      "    steps:",
      "      - run: npm ci",
    ].join("\n");
    expect(
      auditViolations(
        text,
        MISSING_RULE,
        defaultConfig(),
        ".github/workflows/ci.yml",
      ),
    ).toHaveLength(0);
  });

  it("scans audit.yaml the same as audit.yml", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm ci",
    ].join("\n");
    expect(
      auditViolations(
        text,
        MISSING_RULE,
        defaultConfig(),
        ".github/workflows/audit.yaml",
      ),
    ).toHaveLength(1);
  });
});

describe("workflow-slop/audit-gate-shape: R-bare", () => {
  it("negative control: the bare gate command alone is recognised", () => {
    const text = auditYml([
      "      - name: npm audit gate (high/critical fail)",
      "        run: npm audit --audit-level=high",
    ]);
    expect(shapeViolations(text)).toHaveLength(0);
    expect(missingViolations(text)).toHaveLength(0);
  });

  it("negative control: --audit-level=moderate (a stronger threshold) is recognised", () => {
    const text = auditYml(["      - run: npm audit --audit-level=moderate"]);
    expect(shapeViolations(text)).toHaveLength(0);
    expect(missingViolations(text)).toHaveLength(0);
  });

  it("negative control: `npm  audit` with doubled whitespace and extra flags is recognised", () => {
    const text = auditYml([
      "      - run: timeout 60s npm  audit --audit-level=critical --omit=dev",
    ]);
    expect(shapeViolations(text)).toHaveLength(0);
  });

  it("negative control: CRLF line endings are recognised the same as LF", () => {
    const text = auditYml(gateStep(["npm audit --audit-level=high"])).replace(
      /\n/g,
      "\r\n",
    );
    expect(text).toContain("\r\n");
    expect(shapeViolations(text)).toHaveLength(0);
    expect(missingViolations(text)).toHaveLength(0);
  });

  // ACCEPTANCE PROBE p1: `|| true` on the gate line.
  it("acceptance probe p1: `|| true` on the gate line is reported, with the neutralisation signal", () => {
    const text = auditYml(gateStep(["npm audit --audit-level=high || true"]));
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the gate command's logical line carries a `||` tail (`true`)",
        {
          signal:
            "the gate command's logical line ends in a `||` whose right-hand side is not `exit`/`false`/`return`, which makes a failing gate exit zero",
        },
      ),
    );
    expect(v[0].matched).toBe("npm audit --audit-level=high");
    expect(v[0].severity).toBe("block");
  });

  it("acceptance probe p1 in single-line plain form: `|| true` is reported there too", () => {
    const text = auditYml([
      "      - run: npm audit --audit-level=high || true",
    ]);
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "the gate command's logical line carries a `||` tail (`true`)",
    );
  });

  it("`|| true` written on a backslash continuation line is still a tail on the gate", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high \\", "  || true"]),
    );
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "the gate command's logical line carries a `||` tail (`true`)",
    );
  });

  it("`; true` after the gate command is reported", () => {
    const text = auditYml(gateStep(["npm audit --audit-level=high ; true"]));
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the gate command's logical line carries a `;` tail (`true`)",
        {
          signal:
            "the gate command's logical line ends in `; true` or `; :`, which makes the step's last command succeed",
        },
      ),
    );
  });

  it("`&& echo ok` after the gate command is reported", () => {
    const text = auditYml(
      gateStep(['npm audit --audit-level=high && echo "clean"']),
    );
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        'the gate command\'s logical line carries a `&&` tail (`echo "clean"`)',
      ),
    );
  });

  it("a stdout redirection on the bare gate is reported", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high >/dev/null"]),
    );
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the gate statement (`npm audit --audit-level=high >/dev/null`) carries a redirection, a substitution or a token this rule does not model",
      ),
    );
  });

  it("documented conservatism: an unquoted `$( ... || echo x)` on the gate line is reported, not parsed", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high $(echo a || echo b)"]),
    );
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "a command substitution in the run block spans a statement separator",
      ),
    );
  });

  it("a gate piped into tee with no `set +e` window is reported", () => {
    const text = auditYml(
      gateStep(['npm audit --audit-level=high | tee "$LOG"']),
    );
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the gate command is piped, which only the `set +e` classification shape permits",
      ),
    );
  });

  it("a `set -o pipefail` before the bare gate is still an extra statement", () => {
    const text = auditYml(
      gateStep([
        "set -o pipefail",
        'npm audit --audit-level=high | tee "$LOG"',
      ]),
    );
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the run block carries another statement beside the gate command (`set -o pipefail`) without a `set +e` classification window",
      ),
    );
  });

  it("an extra statement on its own line beside the bare gate is reported", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high", "echo checked"]),
    );
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the run block carries another statement beside the gate command (`echo checked`) without a `set +e` classification window",
      ),
    );
  });

  it("a `cd` before the bare gate is reported (the bare shape is the gate command alone)", () => {
    const text = auditYml(gateStep(["cd api", "npm audit --audit-level=high"]));
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "the run block carries another statement beside the gate command (`cd api`)",
    );
  });
});

describe("workflow-slop/audit-gate-shape: R-classify", () => {
  it("negative control: the canonical set +e / capture / restore / verdict shape is recognised", () => {
    const text = auditYml(gateStep(CLASSIFY_BODY));
    expect(shapeViolations(text)).toHaveLength(0);
    expect(missingViolations(text)).toHaveLength(0);
  });

  it("negative control: `set +eu` opens the window the same as `set +e`", () => {
    const body = ["set +eu", ...CLASSIFY_BODY.slice(1)];
    expect(shapeViolations(auditYml(gateStep(body)))).toHaveLength(0);
  });

  it("negative control: `set +o errexit` opens the window and `set -o errexit` restores it", () => {
    const body = [
      "set +o errexit",
      "npm audit --audit-level=high",
      "STATUS=$?",
      "set -o errexit",
      "exit 1",
      'exit "$STATUS"',
    ];
    expect(shapeViolations(auditYml(gateStep(body)))).toHaveLength(0);
  });

  it("negative control: `set -euo pipefail` restores the window, with the gate piped into tee under pipefail", () => {
    const body = [
      "set -o pipefail",
      "set +e",
      'npm audit --audit-level=high --no-fund 2>&1 | tee "$LOG"',
      "STATUS=$?",
      "set -euo pipefail",
      "exit 1",
      'exit "$STATUS"',
    ];
    expect(shapeViolations(auditYml(gateStep(body)))).toHaveLength(0);
  });

  it("negative control: `exit ${STATUS}` counts as the exit of the captured status", () => {
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      'STATUS="$?"',
      "set -e",
      "exit 1",
      "exit ${STATUS}",
    ];
    expect(shapeViolations(auditYml(gateStep(body)))).toHaveLength(0);
  });

  it("negative control: pre-window assignments, a trap and a mktemp are permitted", () => {
    const body = [
      "AUDIT_TIMEOUT_SECS=60",
      'LOG="$(mktemp)"',
      "trap 'rm -f \"$LOG\"' EXIT",
      "set -o pipefail",
      ...CLASSIFY_BODY,
    ];
    expect(shapeViolations(auditYml(gateStep(body)))).toHaveLength(0);
  });

  // ACCEPTANCE PROBE p3: the `set -e` restore deleted.
  it("acceptance probe p3: a `set +e` window with no `set -e` restore is reported", () => {
    const body = CLASSIFY_BODY.filter((line) => line !== "set -e");
    expect(body).not.toContain("set -e");
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage("`set +e` is never followed by a `set -e` restore", {
        signal:
          "the run block disables `errexit` and never restores it, so a failing gate does not fail the step",
      }),
    );
  });

  it("a window whose captured status is never exited is reported", () => {
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      "STATUS=$?",
      "set -e",
      'echo "status $STATUS"',
      "exit 1",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "no `exit $STATUS` of the captured gate status runs after the `set -e` restore",
      ),
    );
  });

  it("a window with no `exit` of a non-zero literal is reported", () => {
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      "STATUS=$?",
      "set -e",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "no `exit` of a non-zero literal runs after the `set -e` restore, so nothing turns a failing gate into a failing step",
      ),
    );
  });

  it("an `exit 0` after the restore is reported", () => {
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      "STATUS=$?",
      "set -e",
      'if [ "$STATUS" -eq 0 ]; then',
      "  exit 0",
      "fi",
      "exit 1",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "an `exit 0` statement runs after the `set -e` restore, so the step can report success on a failing gate",
      ),
    );
  });

  it("a bare `exit` after the restore is reported (it exits the last command's status, not the gate's)", () => {
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      "STATUS=$?",
      "set -e",
      'echo "audit done"',
      "exit",
      "exit 1",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "an `exit` after the `set -e` restore exits neither a non-zero literal nor the captured status (`exit`)",
      ),
    );
  });

  it("an `exit` of a variable other than the captured status is reported", () => {
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      "STATUS=$?",
      "set -e",
      "exit $OTHER",
      "exit 1",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "an `exit` after the `set -e` restore exits neither a non-zero literal nor the captured status (`exit $OTHER`)",
      ),
    );
  });

  it("an `exit ${STATUS:-0}` default-expansion verdict is reported, not read as the captured status", () => {
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      "STATUS=$?",
      "set -e",
      "exit 1",
      "exit ${STATUS:-0}",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "an `exit` after the `set -e` restore exits neither a non-zero literal nor the captured status (`exit ${STATUS:-0}`)",
      ),
    );
  });

  it("a pre-window `trap` that calls `exit` is reported (an EXIT trap can override every verdict)", () => {
    const body = ["trap 'exit 0' EXIT", ...CLASSIFY_BODY];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "a statement this rule does not model runs before the `set +e` (`trap 'exit 0' EXIT`)",
      ),
    );
  });

  it("negative control: a pre-window cleanup `trap` naming the EXIT signal is permitted", () => {
    const body = ["trap 'rm -f \"$LOG\"' EXIT", ...CLASSIFY_BODY];
    expect(shapeViolations(auditYml(gateStep(body)))).toHaveLength(0);
  });

  it("reassigning the captured status after the restore is reported", () => {
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      "STATUS=$?",
      "set -e",
      "STATUS=0",
      "exit 1",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "a statement this rule does not model runs after the `set -e` restore (`STATUS=0`)",
      ),
    );
  });

  it("a capture that runs before the gate command (wrong order) is reported", () => {
    const body = [
      "set +e",
      "STATUS=$?",
      "npm audit --audit-level=high",
      "set -e",
      "exit 1",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the `set +e` window carries a statement before the gate command (`STATUS=$?`)",
      ),
    );
  });

  it("documented: the window admits only the capture, so an `echo` inside it is reported", () => {
    const body = [
      "set +e",
      'echo "set +e"',
      "npm audit --audit-level=high",
      "STATUS=$?",
      "set -e",
      "exit 1",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        'the `set +e` window carries a statement before the gate command (`echo "set +e"`)',
      ),
    );
  });

  it("a second statement inside the window beside the capture is reported", () => {
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      "STATUS=$?",
      "echo inside",
      "set -e",
      "exit 1",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the `set +e` window carries more statements than the gate command and one `VAR=$?` capture (`echo inside`)",
      ),
    );
  });

  it("a piped gate with no `set -o pipefail` before it is reported", () => {
    const body = [
      "set +e",
      'npm audit --audit-level=high | tee "$LOG"',
      "STATUS=$?",
      "set -e",
      "exit 1",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the gate command is piped without `set -o pipefail` earlier in the run block, so the pipeline reports `tee`'s exit status, not the gate's",
      ),
    );
  });

  it("a gate piped into something other than tee is reported", () => {
    const body = [
      "set -o pipefail",
      "set +e",
      "npm audit --audit-level=high | grep -v deprecated",
      "STATUS=$?",
      "set -e",
      "exit 1",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the gate command is piped into something other than `tee` (`grep -v deprecated`)",
      ),
    );
  });

  it("two `set +e` statements in one block are reported", () => {
    const body = ["set +e", "set +e", ...CLASSIFY_BODY.slice(1)];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage("the run block disables `errexit` more than once"),
    );
  });

  it("two `set -e` restores after the window are reported", () => {
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      "STATUS=$?",
      "set -e",
      "set -e",
      "exit 1",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage("`set +e` is followed by more than one `set -e` restore"),
    );
  });

  it("a gate command outside the `set +e` window is reported", () => {
    const body = [
      "npm audit --audit-level=high",
      "set +e",
      "STATUS=$?",
      "set -e",
      "exit 1",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the gate command does not sit strictly between the `set +e` and its `set -e` restore",
      ),
    );
  });

  it("two gate commands in one block are reported", () => {
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      "npm audit --audit-level=critical",
      "STATUS=$?",
      "set -e",
      "exit 1",
      "exit $STATUS",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage("the run block carries 2 npm-audit gate commands, not one"),
    );
  });

  it("a `set +u` before the window is reported (only option-enabling `set -` runs pre-window)", () => {
    const body = ["set +u", ...CLASSIFY_BODY];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "a statement this rule does not model runs before the `set +e` (`set +u`)",
      ),
    );
  });

  it("an unmodelled command before the window is reported", () => {
    const body = ["npm ci", ...CLASSIFY_BODY];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "a statement this rule does not model runs before the `set +e` (`npm ci`)",
      ),
    );
  });
});

describe("workflow-slop/audit-gate-shape: normaliser refusals", () => {
  it("a here-doc redirection in the gate block is refused", () => {
    const body = [
      "npm audit --audit-level=high",
      "cat <<'MSG'",
      "all good",
      "MSG",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the run block redirects a here-doc, a construct this rule does not model",
      ),
    );
  });

  it("an `exit 1` that only lives inside a here-doc body after a bare `set +e` is refused, never certified", () => {
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      "cat <<'MSG'",
      "exit 1",
      "MSG",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the run block redirects a here-doc, a construct this rule does not model",
      ),
    );
  });

  it("a here-doc whose terminator is missing is refused with its own reason", () => {
    const body = [
      "npm audit --audit-level=high",
      "cat <<'MSG'",
      "no terminator follows",
    ];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the run block opens a here-doc whose terminator this rule could not locate",
      ),
    );
  });

  it("a `<<<` herestring is not mistaken for a here-doc", () => {
    const body = ["npm audit --audit-level=high", 'grep -q x <<< "$OUT"'];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        'the run block carries another statement beside the gate command (`grep -q x <<< "$OUT"`) without a `set +e` classification window',
      ),
    );
  });

  it("a shell function definition is refused", () => {
    const body = ["has_summary() {", '  grep -q x "$1"', "}", ...CLASSIFY_BODY];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the run block defines a shell function, a construct this rule does not model",
      ),
    );
  });

  it("a `function name` definition is refused too", () => {
    const body = ["function helper {", "  true", "}", ...CLASSIFY_BODY];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "the run block defines a shell function, a construct this rule does not model",
    );
  });

  it("an `eval` is refused", () => {
    const body = ['eval "$GATE"', ...CLASSIFY_BODY];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the run block calls `eval`, a construct this rule does not model",
      ),
    );
  });

  it("a backgrounded gate command is refused", () => {
    const body = ["npm audit --audit-level=high &", "wait"];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage("the run block backgrounds a command with `&`"),
    );
  });

  it("negative control: `2>&1` and `>&2` are redirections, not backgrounding", () => {
    const body = [
      "set -o pipefail",
      "set +e",
      'npm audit --audit-level=high 2>&1 | tee "$LOG"',
      "STATUS=$?",
      "set -e",
      'echo "done" >&2',
      "exit 1",
      "exit $STATUS",
    ];
    expect(shapeViolations(auditYml(gateStep(body)))).toHaveLength(0);
  });

  it("an unbalanced quote (a string spanning physical lines) is refused", () => {
    const body = ['echo "set +e', "npm audit --audit-level=high"];
    const v = shapeViolations(auditYml(gateStep(body)));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage("a line of the run block leaves a quote unbalanced"),
    );
  });
});

describe("workflow-slop/audit-gate-shape: continue-on-error", () => {
  // ACCEPTANCE PROBE p6: continue-on-error: true on the gate step.
  it("acceptance probe p6: `continue-on-error: true` on an otherwise recognised gate step is reported", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ["continue-on-error: true"]),
    );
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      "`continue-on-error` on the gate step is set to `true`, which cannot be proven false: the job may stay green regardless of the `npm audit --audit-level=...` gate's exit status.",
    );
    expect(v[0].matched).toBe("continue-on-error: true");
  });

  it("job-level `continue-on-error: true` is reported on the gate step's job", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    continue-on-error: true",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      "`continue-on-error` on the gate step's enclosing job is set to `true`, which cannot be proven false: the job may stay green regardless of the `npm audit --audit-level=...` gate's exit status.",
    );
  });

  it("an unresolved `${{ }}` continue-on-error cannot be proven false and is reported", () => {
    const text = auditYml(
      gateStep(
        ["npm audit --audit-level=high"],
        ["continue-on-error: ${{ github.event_name == 'push' }}"],
      ),
    );
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("cannot be proven false");
  });

  it("negative control: `continue-on-error: false` is provably false and is not reported", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ["continue-on-error: false"]),
    );
    expect(shapeViolations(text)).toHaveLength(0);
  });
});

describe("workflow-slop/audit-gate-shape: registered templates and the fleet shape", () => {
  it("the package ships no org template: the real fleet gate block is reported without one", () => {
    const v = shapeViolations(REAL_FLEET_AUDIT_YML);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shapeMessage(
        "the run block defines a shell function, a construct this rule does not model",
      ),
    );
    expect(missingViolations(REAL_FLEET_AUDIT_YML)).toHaveLength(0);
  });

  it("negative control: the real fleet gate block is recognised once its template is registered", () => {
    const cfg = withFleetTemplate();
    expect(shapeViolations(REAL_FLEET_AUDIT_YML, cfg)).toHaveLength(0);
    expect(missingViolations(REAL_FLEET_AUDIT_YML, cfg)).toHaveLength(0);
  });

  it("a template registered as an explicit statement list matches the same block as its sha256", () => {
    const cfg = mergeConfig({
      workflow: {
        auditGateTemplates: [
          {
            name: "inline-bare-gate",
            statements: [
              "set +e",
              "npm audit --audit-level=high",
              "STATUS=$?",
              "set -e",
            ],
          },
        ],
      },
    });
    // The statement list above is a `set +e` window with no verdict at
    // all: unrecognised by shape, recognised only because it is
    // registered. That is what "a template is trusted as is" means.
    const body = [
      "set +e",
      "npm audit --audit-level=high",
      "STATUS=$?",
      "set -e",
    ];
    expect(shapeViolations(auditYml(gateStep(body)), cfg)).toHaveLength(0);
    expect(shapeViolations(auditYml(gateStep(body)))).toHaveLength(1);
  });

  it("a block that matches no registered template is reported, with the digest to register", () => {
    const cfg = withFleetTemplate();
    const text = auditYml(gateStep(["npm audit --audit-level=high || true"]));
    const v = shapeViolations(text, cfg);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "the gate command's logical line carries a `||` tail (`true`)",
    );
    expect(v[0].message).toMatch(
      /No registered template matches this block; its normalised statements hash to sha256 [0-9a-f]{64}\./,
    );
  });

  // ACCEPTANCE PROBE p2: the real fleet block with its findings-branch
  // `exit 1` flipped to `exit 0`. The block is recognised only as a
  // registered template, so any edit to it, this one included, changes
  // the digest and is reported.
  it("acceptance probe p2: flipping the findings-branch `exit 1` to `exit 0` in the real fleet block is reported", () => {
    const neutralised = REAL_FLEET_AUDIT_YML.replace(
      'read the report step above"\n            exit 1',
      'read the report step above"\n            exit 0',
    );
    // Guard the flip itself: a fixture refresh that moves this line must
    // fail here rather than silently turn the probe into a re-run of the
    // negative control above.
    expect(neutralised).not.toBe(REAL_FLEET_AUDIT_YML);
    const cfg = withFleetTemplate();
    const v = shapeViolations(neutralised, cfg);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "Unrecognised npm-audit gate shape in this audit workflow: the run block defines a shell function, a construct this rule does not model.",
    );
    expect(v[0].message).toMatch(
      /No registered template matches this block; its normalised statements hash to sha256 [0-9a-f]{64}\./,
    );
  });

  it("a reformat that changes only comments and indentation keeps the registered template matching", () => {
    const reformatted = REAL_FLEET_AUDIT_YML.replace(
      "          set +e\n",
      "          # classify the gate's own exit code\n          set +e\n",
    );
    expect(reformatted).not.toBe(REAL_FLEET_AUDIT_YML);
    expect(shapeViolations(reformatted, withFleetTemplate())).toHaveLength(0);
  });

  it("a separator-only edit of a registered block (an `exit 1` glued onto the previous command with `||`) changes the digest and is reported", () => {
    const glued = REAL_FLEET_AUDIT_YML.replace(
      'read the report step above"\n            exit 1\n',
      'read the report step above" || exit 1\n',
    );
    expect(glued).not.toBe(REAL_FLEET_AUDIT_YML);
    const v = shapeViolations(glued, withFleetTemplate());
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("No registered template matches this block");
    // The separator must be part of the hashed text itself, independent of
    // which digest happens to be registered: with a template that matches
    // neither block, the finding prints each block's own digest, and the
    // two must differ.
    const bogus = mergeConfig({
      workflow: {
        auditGateTemplates: [
          {
            name: "bogus",
            sha256:
              "abcdef0000000000000000000000000000000000000000000000000000000000",
          },
        ],
      },
    });
    const digestOf = (text: string): string => {
      const found = shapeViolations(text, bogus);
      expect(found).toHaveLength(1);
      const match = /hash to sha256 ([0-9a-f]{64})/.exec(found[0].message);
      expect(match).not.toBeNull();
      return match![1];
    };
    expect(digestOf(glued)).not.toBe(digestOf(REAL_FLEET_AUDIT_YML));
  });

  it("documented limit: R-classify does not evaluate branch conditions, so verdict exits inside a never-taken branch still recognise the block", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          set +e",
      "          npm audit --audit-level=high",
      "          STATUS=$?",
      "          set -e",
      "          if false; then",
      "            exit 1",
      "          fi",
      "          if false; then",
      "            exit $STATUS",
      "          fi",
      '          echo "gate done"',
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(0);
  });
});

describe("workflow-slop/audit-gate-shape: multiple gate steps", () => {
  it("a clean gate step beside a neutralised one still reports the neutralised one", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: gate (root)",
      "        run: npm audit --audit-level=high",
      "      - name: gate (mcp)",
      "        run: npm audit --audit-level=high || true",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(9);
    expect(v[0].message).toContain(
      "the gate command's logical line carries a `||` tail (`true`)",
    );
    expect(missingViolations(text)).toHaveLength(0);
  });

  it("a `run:` inside a uses: step's with: block is not a gate step", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: acme/runner@v1",
      "        with:",
      "          run: npm audit --audit-level=high || true",
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(0);
    expect(missingViolations(text)).toHaveLength(1);
  });

  it("a per-line disable comment still works on a shape finding", () => {
    const text = auditYml([
      "      - run: npm audit --audit-level=high || true # slop-detector:disable-line=workflow-slop/audit-gate-shape",
    ]);
    expect(shapeViolations(text)).toHaveLength(0);
    // Without the comment the same file reports, so the assertion above
    // pins the opt-out, not an accidentally clean fixture.
    expect(
      shapeViolations(
        auditYml(["      - run: npm audit --audit-level=high || true"]),
      ),
    ).toHaveLength(1);
  });
});

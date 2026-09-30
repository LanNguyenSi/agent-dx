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
    expect(v[0].message).toContain("(see docs/workflow-slop.md)");
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
    expect(v[0].message).toContain("(see docs/workflow-slop.md)");
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

// A shell refusal (the "0." check, before any shape or template is even
// considered) cannot be cleared by matching a recognised shape or
// registering a template, so it carries its own tail naming the actual
// remedies instead of `SHAPE_MESSAGE_TAIL`'s.
const SHELL_MESSAGE_TAIL =
  'Set an explicit bash `shell:` on the gate step (or its job\'s or the workflow\'s `defaults.run.shell`), or use the reviewed per-repo exception instead: a `# slop-detector:disable-line=workflow-slop/audit-gate-shape` comment on this line, or `rules: { "workflow-slop/audit-gate-shape": { enabled: false } }` in `slop.config.yml` to disable the rule for the whole repo (see docs/workflow-slop.md\'s "Scope" section).';

/** The full message `audit-gate-shape` reports for a shell refusal. */
function shellMessage(reason: string): string {
  return `Unrecognised npm-audit gate shape in this audit workflow: ${reason}. ${SHELL_MESSAGE_TAIL}`;
}

const MISSING_GATE_MESSAGE =
  "No certifiable npm-audit gate command was found in this audit workflow: no `run:` step's normalised shell statements invoke `npm audit` with `--audit-level=low`, `--audit-level=moderate`, `--audit-level=high`, or `--audit-level=critical`. Text inside a here-doc body is data, not a command, and a `run:` scalar that is not a literal block scalar (`|`) or a single-line plain scalar is not analysed as shell text, so neither counts as a present gate. (This rule only recognises `npm audit`; a `pnpm audit` or a non-npm audit command is out of its scope, see docs/workflow-slop.md.)";

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
        { name: "acme-canonical-audit-gate", sha256: FLEET_TEMPLATE_SHA256 },
      ],
    },
  });

/**
 * The real fleet fixture with `shell: <shell>` injected onto the gate
 * step, used to prove the shell check runs (and refuses) even over a
 * block whose template is registered: a registered template is an
 * attestation about the script AS BASH, so it must never rescue a
 * non-bash-certifiable shell.
 */
function fleetAuditWithGateShell(shell: string): string {
  const marker = "      - name: npm audit gate (high/critical fail)\n";
  if (!REAL_FLEET_AUDIT_YML.includes(marker)) {
    throw new Error("fleet audit fixture: gate step marker not found");
  }
  return REAL_FLEET_AUDIT_YML.replace(
    marker,
    `${marker}        shell: ${shell}\n`,
  );
}

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

describe("workflow-slop/audit-gate-shape: gate step shell", () => {
  // ACCEPTANCE PROBE p7 (mutant a): a step-level `shell:` naming a
  // non-bash interpreter is refused, even though the block is an
  // otherwise-recognised `R-bare` shape. Removing the step-level shell
  // check must turn this back into a clean verdict.
  it("acceptance probe p7: a step-level `shell: pwsh` is refused on an otherwise-recognised R-bare gate", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ["shell: pwsh"]),
    );
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step's `shell:` is `pwsh`, which this rule does not analyse as bash",
      ),
    );
  });

  it.each(["powershell", "python", "cmd", "sh"])(
    "a step-level `shell: %s` is refused",
    (shell) => {
      const text = auditYml(
        gateStep(["npm audit --audit-level=high"], [`shell: ${shell}`]),
      );
      expect(shapeViolations(text)).toEqual([
        expect.objectContaining({
          message: shellMessage(
            `the gate step's \`shell:\` is \`${shell}\`, which this rule does not analyse as bash`,
          ),
        }),
      ]);
    },
  );

  it("a custom shell command template whose program is not bash (`perl {0}`) is refused", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ["shell: perl {0}"]),
    );
    expect(shapeViolations(text)).toEqual([
      expect.objectContaining({
        message: shellMessage(
          "the gate step's `shell:` is `perl {0}`, which this rule does not analyse as bash",
        ),
      }),
    ]);
  });

  it("mixed-case `shell: Bash` is refused: shell names are matched case-sensitively", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ["shell: Bash"]),
    );
    expect(shapeViolations(text)).toEqual([
      expect.objectContaining({
        message: shellMessage(
          "the gate step's `shell:` is `Bash`, which this rule does not analyse as bash",
        ),
      }),
    ]);
  });

  // Contrast the case-SENSITIVE `shell:` program name check just above:
  // a `runs-on:` LABEL is free text an operator could spell any way, so
  // it is matched case-INSENSITIVELY (`WINDOWS_LABEL_RE`'s `i` flag),
  // pinned here next to the shell name's case-sensitivity test.
  it("an absent shell on a case-varied `runs-on: Windows-Latest` job is refused (case-insensitive label match)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: Windows-Latest",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step has no `shell:` at any level and its job's `runs-on` names a Windows runner, whose default shell is not bash",
      ),
    );
  });

  it("a non-literal `shell: ${{ matrix.shell }}` cannot be resolved to bash and is refused", () => {
    const text = auditYml(
      gateStep(
        ["npm audit --audit-level=high"],
        ["shell: ${{ matrix.shell }}"],
      ),
    );
    expect(shapeViolations(text)).toEqual([
      expect.objectContaining({
        message: shellMessage(
          "the gate step's `shell:` is a non-literal `${{ matrix.shell }}` expression, which this rule cannot resolve to bash",
        ),
      }),
    ]);
  });

  it("an empty `shell:` (present, nothing after it) is refused rather than falling through", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ["shell:"]),
    );
    expect(shapeViolations(text)).toEqual([
      expect.objectContaining({
        message: shellMessage(
          "the gate step's `shell:` is empty, which this rule does not analyse as bash",
        ),
      }),
    ]);
  });

  it("negative control: the literal `shell: bash` is certifiable", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ["shell: bash"]),
    );
    expect(shapeViolations(text)).toHaveLength(0);
  });

  it("negative control: a custom bash template without `-e` (`shell: bash {0}`) is certifiable", () => {
    // R-bare permits no statement after the gate command at all, and
    // R-classify manages `errexit` itself with explicit `set +e`/`set -e`
    // and an explicit `exit`; neither shape's exit-code guarantee depends
    // on the invoking shell's own `-e`/`pipefail` defaults, so a bash
    // template missing `-e` is certified exactly like the literal `bash`
    // keyword. See docs/workflow-slop.md for the full decision and reasoning.
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ["shell: bash {0}"]),
    );
    expect(shapeViolations(text)).toHaveLength(0);
  });

  it("negative control: `shell: bash -e {0}` is certifiable", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ["shell: bash -e {0}"]),
    );
    expect(shapeViolations(text)).toHaveLength(0);
  });

  it("negative control: GitHub's own default bash expansion is certifiable", () => {
    const text = auditYml(
      gateStep(
        ["npm audit --audit-level=high"],
        ["shell: bash --noprofile --norc -eo pipefail {0}"],
      ),
    );
    expect(shapeViolations(text)).toHaveLength(0);
  });

  it('negative control: a quoted `shell: "bash"` is certifiable (quoting does not change the resolved value)', () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ['shell: "bash"']),
    );
    expect(shapeViolations(text)).toHaveLength(0);
  });

  it("negative control: surrounding whitespace around the shell value is trimmed before comparison", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ['shell: " bash "']),
    );
    expect(shapeViolations(text)).toHaveLength(0);
  });

  // ACCEPTANCE PROBE p8 (mutant b): no step-level `shell:`, but the
  // enclosing job's `defaults.run.shell` names a non-bash interpreter.
  // Removing the `defaults.run.shell` fallback must turn this back into
  // a clean verdict (the step-level check alone would miss it).
  it("acceptance probe p8: a job-level `defaults.run.shell: pwsh` is refused when the step sets no shell of its own", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    defaults:",
      "      run:",
      "        shell: pwsh",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step's shell is `pwsh`, set by its job's `defaults.run.shell`, which this rule does not analyse as bash",
      ),
    );
  });

  it("the workflow's own `defaults.run.shell: pwsh` is refused when neither the step nor its job set a shell", () => {
    const text = [
      "on: push",
      "defaults:",
      "  run:",
      "    shell: pwsh",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step's shell is `pwsh`, set by the workflow's `defaults.run.shell`, which this rule does not analyse as bash",
      ),
    );
  });

  it("negative control: `defaults:` present without `run:` falls through to the absent-shell check", () => {
    const text = [
      "on: push",
      "defaults:",
      "  something-else: true",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(0);
  });

  it("precedence: a step-level `shell: bash` wins over the job's `defaults.run.shell: pwsh`", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    defaults:",
      "      run:",
      "        shell: pwsh",
      "    steps:",
      "      - run: npm audit --audit-level=high",
      "        shell: bash",
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(0);
  });

  it("precedence: the job's `defaults.run.shell: bash` wins over the workflow's `defaults.run.shell: pwsh`", () => {
    const text = [
      "on: push",
      "defaults:",
      "  run:",
      "    shell: pwsh",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    defaults:",
      "      run:",
      "        shell: bash",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(0);
  });

  // The two precedence tests above pin the CERTIFY direction (a bash
  // value at a nearer level wins over a non-bash value at a farther
  // one). These pin the REFUSE direction (a non-bash value at a nearer
  // level wins over a bash value at a farther one), and assert the
  // level phrase so a precedence regression that reported the wrong
  // level would still be caught even if the overall verdict (refused)
  // stayed the same.
  it("precedence (refuse direction): a step-level `shell: pwsh` overrides the job's `defaults.run.shell: bash`", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    defaults:",
      "      run:",
      "        shell: bash",
      "    steps:",
      "      - run: npm audit --audit-level=high",
      "        shell: pwsh",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step's `shell:` is `pwsh`, which this rule does not analyse as bash",
      ),
    );
  });

  it("precedence (refuse direction): the job's `defaults.run.shell: pwsh` overrides the workflow's `defaults.run.shell: bash`", () => {
    const text = [
      "on: push",
      "defaults:",
      "  run:",
      "    shell: bash",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    defaults:",
      "      run:",
      "        shell: pwsh",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step's shell is `pwsh`, set by its job's `defaults.run.shell`, which this rule does not analyse as bash",
      ),
    );
  });

  // ACCEPTANCE PROBE p9 (mutant c): no shell set at any of the three
  // levels, and the job's `runs-on` literally names a Windows runner.
  // Removing the Windows-default check must turn this back into a clean
  // verdict (GitHub's own default shell there is `pwsh`, not bash).
  it("acceptance probe p9: an absent shell on a literal `runs-on: windows-latest` job is refused", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: windows-latest",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step has no `shell:` at any level and its job's `runs-on` names a Windows runner, whose default shell is not bash",
      ),
    );
  });

  it("an absent shell on a self-hosted `runs-on: [self-hosted, windows]` job is refused", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: [self-hosted, windows]",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step has no `shell:` at any level and its job's `runs-on` names a Windows runner, whose default shell is not bash",
      ),
    );
  });

  it("negative control: an absent shell on a literal non-Windows `runs-on` (the existing fixture shape) is certifiable", () => {
    expect(
      shapeViolations(auditYml(gateStep(["npm audit --audit-level=high"]))),
    ).toHaveLength(0);
  });

  it("documented residual: an absent shell on a non-literal `runs-on: ${{ matrix.os }}` is not resolved and stays certifiable", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    strategy:",
      "      matrix:",
      "        os: [ubuntu-latest, windows-latest]",
      "    runs-on: ${{ matrix.os }}",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(0);
  });

  it("negative control: a reusable-workflow-call job (`uses:` at job level, no steps) is unaffected", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    uses: ./.github/workflows/audit-reusable.yml",
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(0);
    expect(missingViolations(text)).toHaveLength(1);
  });
});

describe("workflow-slop/audit-gate-shape: custom bash shell command template allowlist", () => {
  // The program token alone only settles WHICH program a template
  // invokes, not whether the rest of the command line actually runs the
  // gate script GitHub hands it as `{0}`: `shell: bash -c true {0}`
  // resolves to `bash` but never touches `{0}` at all. These fixtures
  // cover the certify and refuse sides of that token-level check.
  const CERTIFY_TEMPLATES = [
    "bash",
    "bash {0}",
    "bash -e {0}",
    "bash -eo pipefail {0}",
    "bash --noprofile --norc -eo pipefail {0}",
    "bash -eux -o pipefail {0}",
    "/bin/bash -e {0}",
    "/usr/bin/bash --noprofile --norc -eo pipefail {0}",
    "/usr/local/bin/bash {0}",
  ];

  it.each(CERTIFY_TEMPLATES)(
    "certifies the custom bash shell command template `%s`",
    (shell) => {
      const text = auditYml(
        gateStep(["npm audit --audit-level=high"], [`shell: ${shell}`]),
      );
      expect(shapeViolations(text)).toHaveLength(0);
    },
  );

  // [template, the exact reason text `bashShellTemplateRefusal` produces,
  // naming the offending token]. The reason text, not just the bare
  // offending token, is what the test asserts: the overall message
  // ALSO always echoes the raw `shell:` value verbatim earlier in its
  // text (e.g. "...`shell:` is `bash -c true {0}`..."), so a bare-token
  // assertion like `toContain("-c")` would pass on that echo alone even
  // if the token-level check that is actually under test were gutted --
  // it would not discriminate the mutant. The full reason phrase below
  // is rule-generated prose that is never a substring of the raw
  // template text itself, so it only matches when the real check fired.
  const REFUSE_TEMPLATES: Array<[string, string]> = [
    [
      "bash -c true {0}",
      "the template's `-c` token is not on the allowed list of no-op bash startup flags",
    ],
    [
      "bash -n {0}",
      "the template's `-n` token is not on the allowed list of no-op bash startup flags",
    ],
    [
      "bash --version {0}",
      "the template's `--version` token is not on the allowed list of no-op bash startup flags",
    ],
    [
      "bash -c 'exit 0' {0}",
      "the template's `-c` token is not on the allowed list of no-op bash startup flags",
    ],
    [
      "bash {0} || true",
      "the template has trailing text after its `{0}` placeholder (`|| true`)",
    ],
    [
      "bash -e",
      "the template contains no `{0}` placeholder, so GitHub Actions never hands the gate script to it",
    ],
    [
      "bash -en {0}",
      "the template's `-en` token is not on the allowed list of no-op bash startup flags",
    ],
    [
      "bash -o noexec {0}",
      "the template's `-o noexec` option is not one of the allowed `set -o` names (pipefail, errexit, nounset, xtrace)",
    ],
    [
      "bash +e {0}",
      "the template's `+e` token is not on the allowed list of no-op bash startup flags",
    ],
    ["bash {0} {0}", "the template's `{0}` placeholder appears more than once"],
    [
      "bash -e {0} extra",
      "the template has trailing text after its `{0}` placeholder (`extra`)",
    ],
    [
      "bash --rcfile x {0}",
      "the template's `--rcfile` token is not on the allowed list of no-op bash startup flags",
    ],
    [
      "bash -o {0}",
      "the template's `-o` option has no following `set -o` name",
    ],
    [
      "bash -eo {0}",
      "the template's `-eo` option has no following `set -o` name",
    ],
    // A program token is bash only when it is the bare name or a listed
    // absolute path: the runner executes exactly the named file, so a
    // committed wrapper called `bash` must not certify.
    [
      "./bash {0}",
      "the program `./bash` is neither the bare `bash` nor one of the listed absolute paths",
    ],
    [
      "/tmp/evil/bash -e {0}",
      "the program `/tmp/evil/bash` is neither the bare `bash` nor one of the listed absolute paths",
    ],
    [
      "bash.exe {0}",
      "the program `bash.exe` is neither the bare `bash` nor one of the listed absolute paths",
    ],
    [
      "/usr/bin/bash",
      "the template contains no `{0}` placeholder, so GitHub Actions never hands the gate script to it",
    ],
  ];

  it.each(REFUSE_TEMPLATES)(
    "refuses the custom bash shell command template `%s`, naming the offending token",
    (shell, reason) => {
      const text = auditYml(
        gateStep(["npm audit --audit-level=high"], [`shell: ${shell}`]),
      );
      const v = shapeViolations(text);
      expect(v).toHaveLength(1);
      expect(v[0].message).toContain(reason);
    },
  );

  // The shell check runs, and refuses, before a registered template is
  // even considered (a template match is an attestation about the
  // script AS BASH, which does not hold under a shell that never runs
  // it as written) -- run over the real fleet fixture, template
  // registered, to prove the bypass does not reopen once a template is
  // in play.
  it.each(REFUSE_TEMPLATES.slice(0, 3))(
    "also refuses `%s` over the real fleet fixture with its template registered",
    (shell, reason) => {
      const text = fleetAuditWithGateShell(shell);
      const v = shapeViolations(text, withFleetTemplate());
      expect(v).toHaveLength(1);
      expect(v[0].message).toContain(reason);
    },
  );
});

describe("workflow-slop/audit-gate-shape: runs-on object (runner-group) form", () => {
  it("the flow-style runner-group object form resolves Windows via its literal `labels:`", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: { group: my-group, labels: [windows-latest] }",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step has no `shell:` at any level and its job's `runs-on` names a Windows runner, whose default shell is not bash",
      ),
    );
  });

  it("the block-style runner-group object form resolves the same way", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on:",
      "      group: my-group",
      "      labels: [windows-latest]",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(1);
  });

  it("a scalar `labels:` (not a sequence) in the object form also resolves", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: { group: my-group, labels: windows-latest }",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(1);
  });

  it("negative control: a runner-group object form whose labels are not Windows is certifiable", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: { group: my-group, labels: [ubuntu-latest] }",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(0);
  });

  it("documented residual: a runner-group object form with no literal `labels:` stays unresolved (certifiable)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: { group: my-group }",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(0);
  });
});

describe("workflow-slop/audit-gate-shape: a duplicated shell key", () => {
  it("a step carrying `shell:` twice is never scanned clean: the file is reported as unparseable, whichever value the shell check read", () => {
    // The shell check reads the first occurrence of a key. A mapping with
    // the same key twice is invalid YAML, and the pack says so with a
    // block finding of its own, so `shell: bash` followed by `shell: pwsh`
    // cannot yield a clean file through the first-occurrence reading.
    const text = auditYml(
      gateStep(
        ["npm audit --audit-level=high"],
        ["shell: bash", "shell: pwsh"],
      ),
    );
    const unparseable = auditViolations(
      text,
      "workflow-slop/unparseable-workflow",
    );
    expect(unparseable).toHaveLength(1);
    expect(unparseable[0].severity).toBe("block");
  });
});

describe("workflow-slop/audit-gate-shape: non-scalar shell value", () => {
  it("a step-level `shell:` written as a sequence is refused rather than falling through", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ["shell: [bash]"]),
    );
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step's `shell:` is not a scalar value, which this rule does not analyse as bash",
      ),
    );
  });

  it("a job-level `defaults.run.shell:` written as a mapping is refused", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    defaults:",
      "      run:",
      "        shell: { name: bash }",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step's shell is not a scalar value, set by its job's `defaults.run.shell`, which this rule does not analyse as bash",
      ),
    );
  });

  it("a workflow-level `defaults.run.shell:` written as a sequence is refused", () => {
    const text = [
      "on: push",
      "defaults:",
      "  run:",
      "    shell: [bash, -e]",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step's shell is not a scalar value, set by the workflow's `defaults.run.shell`, which this rule does not analyse as bash",
      ),
    );
  });
});

describe("workflow-slop/audit-gate-shape: shell refusal message tail", () => {
  it("names the real remedies (an explicit bash shell, or the reviewed per-repo exception), not the shape/template tail", () => {
    const text = auditYml(
      gateStep(["npm audit --audit-level=high"], ["shell: pwsh"]),
    );
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "# slop-detector:disable-line=workflow-slop/audit-gate-shape",
    );
    expect(v[0].message).toContain(
      '"workflow-slop/audit-gate-shape": { enabled: false }',
    );
    expect(v[0].message).not.toContain("R-bare");
    expect(v[0].message).not.toContain("R-classify");
    expect(v[0].message).not.toContain("workflow.auditGateTemplates");
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

// ───────────── YAML anchors, aliases and merge keys ─────────────
//
// GitHub Actions accepts anchors and aliases and has no merge-key handling,
// so an alias is resolved before any structural read and a merge key is
// reported (and never certifies an audit gate). An anchor name defined more
// than once is reported and no alias to it is resolved.

const YAML_RULE = "workflow-slop/unsupported-yaml-construct";
const RUN_RULE = "workflow-slop/run-expression";
const NODE20_RULE = "workflow-slop/node20-action-major";

const violationsOf = (text: string, ruleId: string, filePath = WORKFLOW_PATH) =>
  runViolations(text, filePath).filter((v) => v.ruleId === ruleId);

describe("workflow-slop: alias resolution before the executed-input and uses reads", () => {
  it("scans a `with:` mapping supplied whole through an alias (`with: *w`) as the executed action's inputs", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: some-org/other-action@v1",
      "        with: &w",
      "          script: console.log('${{ github.event.issue.title }}')",
      "      - uses: actions/github-script@v8",
      "        with: *w",
    ].join("\n");
    const v = violationsOf(text, RUN_RULE);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("`actions/github-script`'s `script` input");
    // The scalar lives at its anchor site, so that is where it is reported.
    expect(v[0].line).toBe(8);
  });

  it("reports one finding when the same anchored input reaches two executed steps", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: actions/github-script@v8",
      "        with: &w",
      "          script: console.log('${{ github.head_ref }}')",
      "      - uses: actions/github-script@v8",
      "        with: *w",
    ].join("\n");
    expect(violationsOf(text, RUN_RULE)).toHaveLength(1);
  });

  it("scans an executed input whose value is an aliased scalar (`script: *s`)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: some-org/other-action@v1",
      "        with:",
      "          note: &s console.log('${{ github.ref_name }}')",
      "      - uses: actions/github-script@v8",
      "        with:",
      "          script: *s",
    ].join("\n");
    expect(violationsOf(text, RUN_RULE)).toHaveLength(1);
  });

  it("recognises a `uses:` step whose `uses:` value is an alias, so its `with:` is an input block", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: &act actions/github-script@v8",
      "        with:",
      "          script: |",
      "            core.info('ok')",
      "      - uses: *act",
      "        with:",
      "          run: echo ${{ github.ref }}",
    ].join("\n");
    // `run` here is an input name of the action, not a shell script: the
    // aliased `uses:` must still be seen as a `uses:` step for the exemption.
    expect(violationsOf(text, RUN_RULE)).toHaveLength(0);
  });

  it("scans a `run:` scalar supplied through an alias, once, at the anchor", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: some-org/other-action@v1",
      "        with:",
      "          note: &cmd echo ${{ github.ref }}",
      "      - run: *cmd",
      "      - run: *cmd",
    ].join("\n");
    // The anchor sits in an exempt `with:` block, so the reads through
    // `run:` are what report it; two aliases of one scalar, one finding.
    const v = violationsOf(text, RUN_RULE);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(7);
  });

  it("reports a Node-20 `uses:` supplied through an alias once, at its anchor", () => {
    const text = [
      "on: push",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: some-org/other-action@v1",
      "        with:",
      "          pin: &old actions/github-script@v7",
      "      - uses: *old",
      "  b:",
      "    steps:",
      "      - uses: *old",
    ].join("\n");
    // The anchor sits in an exempt `with:` block, so only the alias reads
    // reach it; two aliases of one scalar, one finding.
    const v = violationsOf(text, NODE20_RULE);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(7);
  });

  it("resolves no alias to an anchor name defined twice: the redefinition is reported and the Node-20 read is not certified on either definition", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: some-org/other-action@v1",
      "        with:",
      "          pin: &a actions/checkout@v6",
      "      - uses: *a",
      "      - uses: some-org/other-action@v1",
      "        with:",
      "          pin: &a actions/github-script@v7",
      "      - uses: *a",
    ].join("\n");
    const v = violationsOf(text, YAML_RULE);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("block");
    expect(v[0].line).toBe(11);
    expect(v[0].matched).toBe("&a");
    expect(v[0].message).toContain(
      "The YAML anchor `&a` is defined more than once in this file",
    );
    // No alias to the name was resolved, so the aliased `uses:` values are
    // not read as either definition.
    expect(violationsOf(text, NODE20_RULE)).toEqual([]);
  });

  it("does not report a file that only uses resolvable aliases", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    env: &e",
      "      A: b",
      "    steps:",
      "      - run: echo hi",
      "        env: *e",
    ].join("\n");
    expect(runViolations(text)).toEqual([]);
  });
});

describe("workflow-slop/unsupported-yaml-construct", () => {
  it("reports a `<<` merge key with a block finding at the key, and says GitHub does not merge it", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - &base",
      "        uses: actions/github-script@v8",
      "      - <<: *base",
      "        with:",
      "          script: console.log('${{ github.event.issue.title }}')",
    ].join("\n");
    const v = violationsOf(text, YAML_RULE);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("block");
    expect(v[0].line).toBe(7);
    expect(v[0].column).toBe(9);
    expect(v[0].matched).toBe("<<");
    expect(v[0].message).toBe(
      "A YAML merge key (`<<`) is not merged by GitHub Actions: its documentation covers anchors and aliases only, and the workflow parser has no merge-key handling. This pack does not merge it either, so the keys it would supply (a `uses:`, a `with:` input, `defaults:`, `shell:`, `runs-on:`) are read as absent and a result for this file cannot be trusted clean. Write the mapping out, or use an alias for the whole value (`key: *anchor`).",
    );
  });

  it("reports each merge key of a file, in source order, wherever the mapping sits", () => {
    const text = [
      "on: push",
      "x: &m",
      "  k: v",
      "env:",
      "  <<: *m",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: echo",
      "        env:",
      "          <<: [*m]",
    ].join("\n");
    const v = violationsOf(text, YAML_RULE);
    expect(v.map((x) => x.line)).toEqual([5, 11]);
  });

  it("does not report a mapping key that merely contains the text", () => {
    const text = ["on: push", "env:", "  A<<B: x", "  '<': y"].join("\n");
    expect(violationsOf(text, YAML_RULE)).toEqual([]);
  });

  it("reports an alias whose anchor was never defined", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: echo",
      "        env: *missing",
    ].join("\n");
    const v = violationsOf(text, YAML_RULE);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("block");
    expect(v[0].line).toBe(6);
    expect(v[0].matched).toBe("*missing");
    expect(v[0].message).toContain(
      "The YAML alias `*missing` cannot be resolved (no anchor of that name precedes it)",
    );
  });

  it("reports an alias that refers to a node containing it, without hanging", () => {
    const text = ["on: push", "x: &loop", "  - *loop"].join("\n");
    const v = violationsOf(text, YAML_RULE);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "The YAML alias `*loop` cannot be resolved (it refers to a node that contains it)",
    );
  });

  it("refuses to expand an alias bomb, reports it once and finishes", () => {
    const lines = ["on: push", "l0: &l0 [a, a, a, a, a, a, a, a, a]"];
    for (let i = 1; i <= 9; i++) {
      lines.push(
        `l${i}: &l${i} [${Array(9)
          .fill(`*l${i - 1}`)
          .join(", ")}]`,
      );
    }
    const started = Date.now();
    const v = violationsOf(lines.join("\n"), YAML_RULE);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "Resolving this file's YAML aliases would visit more than 200000 nodes, so none of them were resolved",
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports a key that is an alias standing for the scalar `<<`", () => {
    const text = [
      "on: push",
      "env:",
      '  K: &m "<<"',
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
      "        *m : {x: 1}",
    ].join("\n");
    const v = violationsOf(text, YAML_RULE);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(9);
    expect(v[0].matched).toBe("<<");
  });

  it("does not apply to a file outside .github/workflows", () => {
    const text = ["x: &a 1", "y:", "  <<: *a"].join("\n");
    expect(violationsOf(text, YAML_RULE, "docs/example.yml")).toEqual([]);
  });
});

describe("workflow-slop: an anchor name defined more than once", () => {
  it("reports an injection reached through a shadowed anchor and an alias nested in an earlier alias", () => {
    const text = [
      "on: issues",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    env:",
      '      SAFE: &R "echo hello"',
      "      WRAP: &B {v: *R}",
      '      EVIL: &R "echo ${{ github.event.issue.title }}"',
      "      AGAIN: *B",
      "    steps:",
      "      - run: *R",
    ].join("\n");
    const v = violationsOf(text, YAML_RULE);
    expect(v.map((x) => [x.line, x.matched])).toEqual([[8, "&R"]]);
  });

  it("reports the redefinition when the executed scalar is written at the later definition", () => {
    const text = [
      "on: issues",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    env:",
      '      SAFE: &R "echo hello"',
      '      EVIL: &R "echo ${{ github.event.issue.title }}"',
      "    steps:",
      "      - run: *R",
    ].join("\n");
    expect(violationsOf(text, YAML_RULE)).toHaveLength(1);
  });

  it("does not certify a gate whose shell alias names a redefined anchor", () => {
    const text = [
      "on: push",
      "env:",
      "  A: &SH bash",
      "  B: &W {x: *SH}",
      "  C: &SH pwsh",
      "  D: *W",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm audit --audit-level=high",
      "        shell: *SH",
    ].join("\n");
    const shape = shapeViolations(text);
    expect(shape).toHaveLength(1);
    expect(shape[0].message).toContain("alias this rule cannot resolve");
    expect(
      violationsOf(text, YAML_RULE, AUDIT_PATH).map((x) => x.line),
    ).toEqual([5]);
  });

  it("reports a redefinition that the nested-alias replay reads differently from YAML", () => {
    const text = [
      "on: issues",
      "env:",
      '  BASE: &R "echo hi"',
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - &S",
      "        run: *R",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    env:",
      '      X: &R "echo ${{ github.event.issue.title }}"',
      "    steps:",
      "      - *S",
    ].join("\n");
    const v = violationsOf(text, YAML_RULE);
    expect(v.map((x) => [x.line, x.matched])).toEqual([[13, "&R"]]);
  });

  it("does not report distinct anchor names or a name used by aliases only", () => {
    const text = [
      "on: push",
      "env:",
      "  A: &a 1",
      "  B: &b 2",
      "  C: *a",
      "  D: *a",
      "  E: *b",
    ].join("\n");
    expect(violationsOf(text, YAML_RULE)).toEqual([]);
  });
});

describe("workflow-slop: the redefinition finding sits on the anchor token", () => {
  it("reports a redefined block mapping at its `&name` token, not at its first key", () => {
    const text = [
      "on: push",
      "env:",
      "  A: &M",
      "    y: 1",
      "  B: &M",
      "    y: 2",
    ].join("\n");
    const v = violationsOf(text, YAML_RULE);
    expect(v.map((x) => [x.line, x.column, x.matched])).toEqual([[5, 6, "&M"]]);
  });

  it("lets a disable comment on the anchor line silence the redefinition finding", () => {
    const text = [
      "on: push",
      "env:",
      "  A: &M",
      "    y: 1",
      "  B: &M # slop-detector:disable-line=workflow-slop/unsupported-yaml-construct",
      "    y: 2",
    ].join("\n");
    expect(violationsOf(text, YAML_RULE)).toEqual([]);
  });
});

describe("workflow-slop: an anchor and an alias in the same pair", () => {
  it("resolves a value alias to the anchor on its own key (`&k shell: *k` is `shell: shell`)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - {run: npm audit --audit-level=high, &k shell: *k}",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step's `shell:` is `shell`, which this rule does not analyse as bash",
      ),
    );
    expect(auditViolations(text, YAML_RULE)).toEqual([]);
  });

  it("reports a key alias whose anchor sits on its own value (`*k : &k run`) as unresolvable", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - {*k : &k run}",
    ].join("\n");
    const v = auditViolations(text, YAML_RULE);
    expect(v.map((x) => [x.line, x.column, x.matched])).toEqual([
      [6, 10, "*k"],
    ]);
    expect(v[0].message).toContain("no anchor of that name precedes it");
  });
});

describe("workflow-slop/audit-gate-shape: a key this rule cannot name on the read path", () => {
  const DISABLE =
    " # slop-detector:disable-line=workflow-slop/unsupported-yaml-construct";
  // `*K` names a redefined anchor, so it stays an alias node: a YAML
  // parser reads it as the last `&K` (`name`), this rule cannot name it.
  const withKey = (name: string, body: string[], disable: boolean) =>
    [
      "on: push",
      "env:",
      `  A: &K ${name}x`,
      `  B: &K ${name}${disable ? DISABLE : ""}`,
      ...body,
    ].join("\n");
  const gate = "      - run: npm audit --audit-level=high";
  const cases: Array<{
    level: string;
    key: string;
    body: string[];
    reason: string;
  }> = [
    {
      level: "step shell",
      key: "shell",
      body: [
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
        "        *K : pwsh",
      ],
      reason: "the step mapping has a key this rule cannot name",
    },
    {
      level: "step continue-on-error",
      key: "continue-on-error",
      body: [
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
        "        *K : true",
      ],
      reason: "the step mapping has a key this rule cannot name",
    },
    {
      level: "job continue-on-error",
      key: "continue-on-error",
      body: [
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    *K : true",
        "    steps:",
        gate,
      ],
      reason: "the job mapping has a key this rule cannot name",
    },
    {
      level: "job runs-on",
      key: "runs-on",
      body: [
        "jobs:",
        "  audit:",
        "    *K : windows-latest",
        "    steps:",
        gate,
      ],
      reason: "the job mapping has a key this rule cannot name",
    },
    {
      level: "workflow defaults",
      key: "defaults",
      body: [
        "*K :",
        "  run:",
        "    shell: pwsh",
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
      ],
      reason: "the workflow mapping has a key this rule cannot name",
    },
    {
      level: "workflow jobs",
      key: "jobs",
      body: [
        "defaults:",
        "  run:",
        "    shell: pwsh",
        "*K :",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
      ],
      reason:
        "a mapping enclosing the step mapping has a key this rule cannot name",
    },
    {
      level: "job defaults",
      key: "run",
      body: [
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    defaults:",
        "      *K :",
        "        shell: pwsh",
        "    steps:",
        gate,
      ],
      reason: "the job's `defaults` mapping has a key this rule cannot name",
    },
    {
      level: "job defaults.run",
      key: "shell",
      body: [
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    defaults:",
        "      run:",
        "        *K : pwsh",
        "    steps:",
        gate,
      ],
      reason:
        "the job's `defaults.run` mapping has a key this rule cannot name",
    },
    {
      level: "workflow defaults.run",
      key: "shell",
      body: [
        "defaults:",
        "  run:",
        "    *K : pwsh",
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
      ],
      reason:
        "the workflow's `defaults.run` mapping has a key this rule cannot name",
    },
    {
      level: "runs-on mapping",
      key: "labels",
      body: [
        "jobs:",
        "  audit:",
        "    runs-on:",
        "      group: g",
        "      *K : [windows-latest]",
        "    steps:",
        gate,
      ],
      reason:
        "the job's `runs-on:` contains an alias this rule cannot resolve or a key it cannot name",
    },
    {
      level: "runs-on sequence value",
      key: "windows-latest",
      body: [
        "jobs:",
        "  audit:",
        "    runs-on: [ubuntu-latest, *K]",
        "    steps:",
        gate,
      ],
      reason:
        "the job's `runs-on:` contains an alias this rule cannot resolve or a key it cannot name",
    },
    {
      level: "runs-on labels value",
      key: "windows-latest",
      body: [
        "jobs:",
        "  audit:",
        "    runs-on:",
        "      group: g",
        "      labels: *K",
        "    steps:",
        gate,
      ],
      reason:
        "the job's `runs-on:` contains an alias this rule cannot resolve or a key it cannot name",
    },
  ];

  for (const c of cases) {
    it(`refuses the gate when the ${c.level} key is an alias it cannot resolve, with or without the construct finding disabled`, () => {
      for (const disable of [false, true]) {
        const text = withKey(c.key, c.body, disable);
        const v = shapeViolations(text);
        expect(v, `disable=${disable}`).toHaveLength(1);
        expect(v[0].message, `disable=${disable}`).toContain(c.reason);
        expect(
          auditViolations(text, YAML_RULE).map((x) => x.line),
          `disable=${disable}`,
        ).toEqual(disable ? [] : [4]);
      }
    });
  }

  it("refuses a gate whose step carries a key written as a collection, and reports the key", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      gate,
      "        ? [shell]",
      "        : pwsh",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "the step mapping has a key this rule cannot name",
    );
    expect(
      auditViolations(text, YAML_RULE).map((x) => [
        x.line,
        x.column,
        x.matched,
      ]),
    ).toEqual([[7, 11, "["]]);
  });

  it("certifies a gate whose key alias resolves to `shell:` with a bash value, and refuses a pwsh one as pwsh", () => {
    const body = (value: string) =>
      [
        "on: push",
        "env:",
        "  A: &K shell",
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
        `        *K : ${value}`,
      ].join("\n");
    expect(shapeViolations(body("bash"))).toEqual([]);
    const v = shapeViolations(body("pwsh"));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step's `shell:` is `pwsh`, which this rule does not analyse as bash",
      ),
    );
  });
});

describe("workflow-slop/unsupported-yaml-construct: a mapping key that is a collection", () => {
  it("reports a `?` key written as a sequence in place of `run:`, instead of scanning clean", () => {
    const text = [
      "on: issues",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - ? [run]",
      "        : echo ${{ github.event.issue.title }}",
    ].join("\n");
    const v = violationsOf(text, YAML_RULE);
    expect(v.map((x) => [x.line, x.column, x.matched])).toEqual([[6, 11, "["]]);
    expect(v[0].severity).toBe("block");
    expect(v[0].message).toContain("has no name this pack can read");
  });

  it("reports a key alias that stands for a collection at the alias", () => {
    const text = [
      "on: issues",
      "x: &C [script]",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/github-script@v8",
      "        with:",
      "          *C : console.log('${{ github.event.issue.title }}')",
    ].join("\n");
    expect(
      violationsOf(text, YAML_RULE).map((x) => [x.line, x.column, x.matched]),
    ).toEqual([[9, 11, "*C"]]);
  });

  it("does not report plain, quoted, null or numeric scalar keys", () => {
    const text = [
      "on: push",
      "env:",
      '  "quoted": 1',
      "  1: 2",
      "  true: 3",
      "  ? a",
      "  : 4",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
    ].join("\n");
    expect(violationsOf(text, YAML_RULE)).toEqual([]);
  });
});

describe("workflow-slop: alias resolution scales with the document", () => {
  it("resolves thousands of anchors and aliases in one file within a generous bound", () => {
    const n = 5000;
    const lines = ["on: push", "env:"];
    for (let i = 0; i < n; i++) lines.push(`  A${i}: &a${i} v${i}`);
    lines.push("jobs:", "  j:", "    runs-on: ubuntu-latest", "    env:");
    for (let i = 0; i < n; i++) lines.push(`      B${i}: *a${i}`);
    lines.push("    steps:", "      - run: echo hi");
    const started = Date.now();
    expect(runViolations(lines.join("\n"))).toEqual([]);
    // CI runners took about 7 s for this linear case; a quadratic
    // resolution takes several times the bound, so it still discriminates.
    expect(Date.now() - started).toBeLessThan(30000);
  }, 120000);
});

describe("workflow-slop/audit-gate-shape: aliases and merge keys on the shell read path", () => {
  it("resolves an alias used directly as a step `shell:` value, and refuses the non-bash value it stands for", () => {
    const text = [
      "on: push",
      "x: &sh pwsh",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - shell: *sh",
      "        run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step's `shell:` is `pwsh`, which this rule does not analyse as bash",
      ),
    );
  });

  it("certifies an alias `shell:` whose value is bash", () => {
    const text = [
      "on: push",
      "x: &sh bash",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - shell: *sh",
      "        run: npm audit --audit-level=high",
    ].join("\n");
    expect(shapeViolations(text)).toEqual([]);
    expect(auditViolations(text, YAML_RULE)).toEqual([]);
  });

  it("resolves a job `defaults:` mapping supplied through an alias the same way", () => {
    const pwsh = [
      "on: push",
      "x: &d",
      "  run:",
      "    shell: pwsh",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    defaults: *d",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(pwsh);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        "the gate step's shell is `pwsh`, set by its job's `defaults.run.shell`, which this rule does not analyse as bash",
      ),
    );
    expect(shapeViolations(pwsh.replace("shell: pwsh", "shell: bash"))).toEqual(
      [],
    );
  });

  it("resolves a workflow-level `defaults:` supplied through an alias", () => {
    const text = [
      "on: push",
      "x: &d",
      "  run:",
      "    shell: pwsh",
      "defaults: *d",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "set by the workflow's `defaults.run.shell`",
    );
  });

  it("resolves a Windows `runs-on:` supplied through an alias", () => {
    const text = [
      "on: push",
      "x: &os windows-latest",
      "jobs:",
      "  audit:",
      "    runs-on: *os",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("names a Windows runner");
  });

  it("resolves a job `continue-on-error:` supplied through an alias", () => {
    const text = [
      "on: push",
      "x: &c true",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    continue-on-error: *c",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "`continue-on-error` on the gate step's enclosing job is set to `true`",
    );
  });

  it("reports a step shared between two jobs through an alias once", () => {
    const text = [
      "on: push",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps: &steps",
      "      - shell: pwsh",
      "        run: npm audit --audit-level=high",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps: *steps",
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(1);
  });

  it("never certifies a `shell:` that arrives through a merge key, whatever it merges", () => {
    for (const shell of ["pwsh", "bash"]) {
      const text = [
        "on: push",
        "x: &d",
        "  run:",
        `    shell: ${shell}`,
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    defaults:",
        "      <<: *d",
        "    steps:",
        "      - run: npm audit --audit-level=high",
      ].join("\n");
      const v = shapeViolations(text);
      expect(v, shell).toHaveLength(1);
      expect(v[0].message).toContain(
        "the job's `defaults` chain passes through a mapping carrying a `<<` merge key, so this rule cannot tell which `shell:`, `runs-on` or `continue-on-error` applies to the gate step and does not certify it.",
      );
      expect(auditViolations(text, YAML_RULE), shell).toHaveLength(1);
    }
  });

  it("neither spelling of a `pwsh` default scans clean: the alias is read as pwsh, the merge key is refused", () => {
    const viaAlias = [
      "on: push",
      "x: &d",
      "  run:",
      "    shell: pwsh",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    defaults: *d",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const viaMerge = viaAlias.replace(
      "defaults: *d",
      "defaults:\n      <<: *d",
    );
    const all = (text: string) =>
      auditViolations(text, SHAPE_RULE).length +
      auditViolations(text, YAML_RULE).length;
    expect(all(viaAlias)).toBeGreaterThan(0);
    expect(all(viaMerge)).toBeGreaterThan(0);
  });

  it("refuses a gate under a workflow mapping carrying a merge key", () => {
    const text = [
      "x: &m",
      "  name: y",
      "<<: *m",
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "the workflow mapping carries a `<<` merge key",
    );
  });

  it("refuses a gate under a job mapping carrying a merge key", () => {
    const text = [
      "on: push",
      "x: &m",
      "  name: y",
      "jobs:",
      "  audit:",
      "    <<: *m",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("the job mapping carries a `<<` merge key");
  });

  it("refuses a gate step mapping carrying a merge key", () => {
    const text = [
      "on: push",
      "x: &m",
      "  name: y",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - <<: *m",
      "        run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("the step mapping carries a `<<` merge key");
  });

  it("refuses a `shell:` alias it cannot resolve, and the alias is reported on its own", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - shell: *nope",
      "        run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "the step's `shell:` is an alias this rule cannot resolve",
    );
    expect(auditViolations(text, YAML_RULE)).toHaveLength(1);
  });

  it("refuses a job `runs-on:` and `continue-on-error:` alias it cannot resolve", () => {
    for (const key of ["runs-on", "continue-on-error"]) {
      const text = [
        "on: push",
        "jobs:",
        "  audit:",
        ...(key === "runs-on"
          ? ["    runs-on: *nope"]
          : ["    runs-on: ubuntu-latest", "    continue-on-error: *nope"]),
        "    steps:",
        "      - run: npm audit --audit-level=high",
      ].join("\n");
      const v = shapeViolations(text);
      expect(v, key).toHaveLength(1);
      expect(v[0].message, key).toContain(
        `the job's \`${key}:\` is an alias this rule cannot resolve`,
      );
    }
  });

  it("refuses a `defaults.run.shell` alias it cannot resolve at job level", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    defaults:",
      "      run:",
      "        shell: *nope",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "the job's `defaults.run.shell` is an alias this rule cannot resolve",
    );
  });
});

// ───────────── previously unpinned behaviour of the shell and input reads ─────────────

describe("workflow-slop/audit-gate-shape: bash path refusals at the defaults levels", () => {
  const defaultsAt = (level: "job" | "workflow", shell: string): string => {
    const defaults = ["defaults:", "  run:", `    shell: ${shell}`];
    const indent = (lines: string[], by: string) =>
      lines.map((l) => `${by}${l}`);
    return [
      "on: push",
      ...(level === "workflow" ? defaults : []),
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      ...(level === "job" ? indent(defaults, "    ") : []),
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
  };
  const UNLISTED =
    "the program `/opt/homebrew/bin/bash` is neither the bare `bash` nor one of the listed absolute paths (/bin/bash, /usr/bin/bash, /usr/local/bin/bash), so a file merely named bash cannot be told apart";

  it("refuses an unlisted bash path in the job's `defaults.run.shell`", () => {
    const v = shapeViolations(defaultsAt("job", "/opt/homebrew/bin/bash {0}"));
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        `the gate step's shell is \`/opt/homebrew/bin/bash {0}\`, set by its job's \`defaults.run.shell\`, which this rule does not analyse as bash: ${UNLISTED}`,
      ),
    );
  });

  it("refuses an unlisted bash path in the workflow's `defaults.run.shell`", () => {
    const v = shapeViolations(
      defaultsAt("workflow", "/opt/homebrew/bin/bash {0}"),
    );
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe(
      shellMessage(
        `the gate step's shell is \`/opt/homebrew/bin/bash {0}\`, set by the workflow's \`defaults.run.shell\`, which this rule does not analyse as bash: ${UNLISTED}`,
      ),
    );
  });

  it.each(["/bin/bash", "/usr/local/bin/bash"])(
    "refuses the lone path `%s` (no `{0}`) at step, job and workflow level",
    (shell) => {
      const reason =
        "the template contains no `{0}` placeholder, so GitHub Actions never hands the gate script to it";
      const stepText = auditYml(
        gateStep(["npm audit --audit-level=high"], [`shell: ${shell}`]),
      );
      const step = shapeViolations(stepText);
      expect(step).toHaveLength(1);
      expect(step[0].message).toBe(
        shellMessage(
          `the gate step's \`shell:\` is \`${shell}\`, which this rule does not analyse as bash: ${reason}`,
        ),
      );
      const job = shapeViolations(defaultsAt("job", shell));
      expect(job).toHaveLength(1);
      expect(job[0].message).toBe(
        shellMessage(
          `the gate step's shell is \`${shell}\`, set by its job's \`defaults.run.shell\`, which this rule does not analyse as bash: ${reason}`,
        ),
      );
      const workflow = shapeViolations(defaultsAt("workflow", shell));
      expect(workflow).toHaveLength(1);
      expect(workflow[0].message).toBe(
        shellMessage(
          `the gate step's shell is \`${shell}\`, set by the workflow's \`defaults.run.shell\`, which this rule does not analyse as bash: ${reason}`,
        ),
      );
    },
  );
});

describe("workflow-slop/unparseable-workflow: a duplicated runs-on key", () => {
  it("reports a job carrying `runs-on:` twice as unparseable, so the first-occurrence read cannot scan it clean", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    runs-on: windows-latest",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = auditViolations(text, "workflow-slop/unparseable-workflow");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("block");
    expect(v[0].line).toBe(5);
    expect(v[0].message).toContain("Map keys must be unique");
  });
});

describe("workflow-slop/run-expression: executed-input name fold over-matches", () => {
  it("matches a `with:` key whose upper-casing equals the configured name (`ßcript` against `sscript`)", () => {
    // Full case mapping upper-cases `ß` to `SS`, so both names fold to
    // `SSCRIPT`. The over-match direction is the safe one for a block rule.
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: acme/run-code@v1",
      "        with:",
      "          ßcript: ${{ github.event.issue.title }}",
    ].join("\n");
    const config = mergeConfig({
      workflow: { executedActionInputs: ["acme/run-code:sscript"] },
    });
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config,
      packFilter: ["workflow-slop"],
    }).filter((x) => x.ruleId === RUN_RULE);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("`acme/run-code`'s `sscript` input");
  });

  it("does not match a different name that folds differently", () => {
    const text = [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: acme/run-code@v1",
      "        with:",
      "          scripts: ${{ github.event.issue.title }}",
    ].join("\n");
    const config = mergeConfig({
      workflow: { executedActionInputs: ["acme/run-code:sscript"] },
    });
    const v = checkText(text, WORKFLOW_PATH, {
      packs: allPacks,
      config,
      packFilter: ["workflow-slop"],
    }).filter((x) => x.ruleId === RUN_RULE);
    expect(v).toHaveLength(0);
  });
});

describe("workflow-slop: a key written twice once alias keys are resolved", () => {
  const DISABLE =
    " # slop-detector:disable-line=workflow-slop/unsupported-yaml-construct";
  const gate = "      - run: npm audit --audit-level=high";
  const job = ["jobs:", "  audit:", "    runs-on: ubuntu-latest"];
  const WRITTEN_TWICE =
    "has a key written twice once its YAML aliases are resolved";
  // `name` is the key the mapping carries twice; `plain` writes it by name
  // (its first line starts with `<indent><name>:`), `alias` writes it as
  // `*X`, and `X` (and `Y`) anchor that name in `env:`.
  const cases: Array<{
    level: string;
    name: string;
    before: string[];
    plain: string[];
    alias: string[];
    after: string[];
    reason: string;
  }> = [
    {
      level: "step shell",
      name: "shell",
      before: [...job, "    steps:", gate],
      plain: ["        shell: bash"],
      alias: ["        *X : pwsh"],
      after: [],
      reason: `the step mapping ${WRITTEN_TWICE}`,
    },
    {
      level: "step continue-on-error",
      name: "continue-on-error",
      before: [...job, "    steps:", gate],
      plain: ["        continue-on-error: false"],
      alias: ["        *X : true"],
      after: [],
      reason: `the step mapping ${WRITTEN_TWICE}`,
    },
    {
      level: "job runs-on",
      name: "runs-on",
      before: ["jobs:", "  audit:"],
      plain: ["    runs-on: ubuntu-latest"],
      alias: ["    *X : windows-latest"],
      after: ["    steps:", gate],
      reason: `the job mapping ${WRITTEN_TWICE}`,
    },
    {
      level: "job continue-on-error",
      name: "continue-on-error",
      before: job,
      plain: ["    continue-on-error: false"],
      alias: ["    *X : true"],
      after: ["    steps:", gate],
      reason: `the job mapping ${WRITTEN_TWICE}`,
    },
    {
      level: "workflow defaults",
      name: "defaults",
      before: [],
      plain: ["defaults:", "  run:", "    shell: bash"],
      alias: ["*X :", "  run:", "    shell: pwsh"],
      after: [...job, "    steps:", gate],
      reason: `the workflow mapping ${WRITTEN_TWICE}`,
    },
    {
      level: "workflow job id",
      name: "audit",
      before: ["jobs:"],
      plain: ["  audit:", "    runs-on: ubuntu-latest", "    steps:", gate],
      alias: [
        "  *X :",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo hi",
      ],
      after: [],
      reason: `a mapping enclosing the step mapping ${WRITTEN_TWICE}`,
    },
    {
      level: "workflow defaults run",
      name: "run",
      before: ["defaults:"],
      plain: ["  run:", "    shell: bash"],
      alias: ["  *X :", "    shell: pwsh"],
      after: [...job, "    steps:", gate],
      reason: `the workflow's \`defaults\` mapping ${WRITTEN_TWICE}`,
    },
    {
      level: "workflow defaults.run.shell",
      name: "shell",
      before: ["defaults:", "  run:"],
      plain: ["    shell: bash"],
      alias: ["    *X : pwsh"],
      after: [...job, "    steps:", gate],
      reason: `the workflow's \`defaults.run\` mapping ${WRITTEN_TWICE}`,
    },
    {
      level: "job defaults run",
      name: "run",
      before: [...job, "    defaults:"],
      plain: ["      run:", "        shell: bash"],
      alias: ["      *X :", "        shell: pwsh"],
      after: ["    steps:", gate],
      reason: `the job's \`defaults\` mapping ${WRITTEN_TWICE}`,
    },
    {
      level: "job defaults.run.shell",
      name: "shell",
      before: [...job, "    defaults:", "      run:"],
      plain: ["        shell: bash"],
      alias: ["        *X : pwsh"],
      after: ["    steps:", gate],
      reason: `the job's \`defaults.run\` mapping ${WRITTEN_TWICE}`,
    },
    {
      level: "runs-on mapping",
      name: "labels",
      before: ["jobs:", "  audit:", "    runs-on:", "      group: g"],
      plain: ["      labels: [ubuntu-latest]"],
      alias: ["      *X : [windows-latest]"],
      after: ["    steps:", gate],
      reason:
        "the job's `runs-on:` contains an alias this rule cannot resolve or a key it cannot name, or a mapping carrying a key twice once aliases are resolved",
    },
  ];
  const orders = ["plain first", "alias first", "two aliases"] as const;

  const build = (
    c: (typeof cases)[number],
    order: (typeof orders)[number],
    disable: boolean,
  ): { text: string; reportedLine: number } => {
    const alias = [
      `${c.alias[0]}${disable ? DISABLE : ""}`,
      ...c.alias.slice(1),
    ];
    const plain =
      order === "two aliases"
        ? [c.plain[0].replace(`${c.name}:`, "*Y :"), ...c.plain.slice(1)]
        : c.plain;
    const pair =
      order === "alias first" ? [...alias, ...plain] : [...plain, ...alias];
    const lines = [
      "on: push",
      "env:",
      `  A: &X ${c.name}`,
      `  B: &Y ${c.name}`,
      ...c.before,
      ...pair,
      ...c.after,
    ];
    return {
      text: lines.join("\n"),
      reportedLine: lines.indexOf(alias[0]) + 1,
    };
  };

  for (const c of cases) {
    for (const order of orders) {
      it(`refuses the gate when the ${c.level} key is written twice (${order}), with or without the construct finding disabled`, () => {
        for (const disable of [false, true]) {
          const { text, reportedLine } = build(c, order, disable);
          // A `continue-on-error: true` read first is reported on its own
          // as well; the refusal is the finding this test is about.
          const refusals = shapeViolations(text).filter((x) =>
            x.message.includes(c.reason),
          );
          expect(refusals, `disable=${disable}`).toHaveLength(1);
          expect(
            auditViolations(text, YAML_RULE).map((x) => [x.line, x.matched]),
            `disable=${disable}`,
          ).toEqual(disable ? [] : [[reportedLine, "*X"]]);
          expect(
            auditViolations(text, "workflow-slop/unparseable-workflow"),
          ).toEqual([]);
        }
      });
    }
  }

  it("reports the alias key at its own position with a message naming the duplicate", () => {
    const text = [
      "on: push",
      "env:",
      "  A: &X shell",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      gate,
      "        shell: bash",
      "        *X : pwsh",
    ].join("\n");
    const v = auditViolations(text, YAML_RULE);
    expect(v.map((x) => [x.line, x.column, x.matched, x.severity])).toEqual([
      [10, 9, "*X", "block"],
    ]);
    expect(v[0].message).toContain(
      "resolves to a name the same mapping already has",
    );
  });

  it("reports the duplicate in any workflow file, not only an audit workflow", () => {
    const text = [
      "on: push",
      "env:",
      "  A: &U uses",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: ./local",
      "        *U : actions/checkout@v4",
    ].join("\n");
    expect(
      runViolations(text)
        .filter((x) => x.ruleId === YAML_RULE)
        .map((x) => [x.line, x.matched]),
    ).toEqual([[9, "*U"]]);
  });

  it("leaves two plain keys of the same name to unparseable-workflow, as before", () => {
    for (const pair of [
      ["        shell: bash", "        shell: pwsh"],
      ["        continue-on-error: false", "        continue-on-error: true"],
    ]) {
      const text = [...["on: push"], ...job, "    steps:", gate, ...pair].join(
        "\n",
      );
      expect(
        auditViolations(text, "workflow-slop/unparseable-workflow"),
      ).toHaveLength(1);
      expect(auditViolations(text, YAML_RULE)).toEqual([]);
    }
    const runsOn = [
      "on: push",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    runs-on: windows-latest",
      "    steps:",
      gate,
    ].join("\n");
    expect(
      auditViolations(runsOn, "workflow-slop/unparseable-workflow"),
    ).toHaveLength(1);
    expect(auditViolations(runsOn, YAML_RULE)).toEqual([]);
  });

  it("certifies an alias key used once per mapping, and a mapping shared by two aliases", () => {
    const text = [
      "on: push",
      "env:",
      "  A: &X shell",
      "  D: &d { run: { shell: bash } }",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    defaults: *d",
      "    steps:",
      gate,
      "        *X : bash",
      "  other:",
      "    runs-on: ubuntu-latest",
      "    defaults: *d",
      "    steps:",
      gate,
      "        *X : bash",
    ].join("\n");
    expect(shapeViolations(text)).toEqual([]);
    expect(runViolations(text)).toEqual([]);
  });
});

describe("workflow-slop: an alias-key duplicate matches keys by resolved value, not by how they are written", () => {
  const WRITTEN_TWICE =
    "has a key written twice once its YAML aliases are resolved";
  const constructOff = mergeConfig({
    rules: { [YAML_RULE]: { enabled: false } },
  });
  // Four spellings of one key name: plain, single-quoted, double-quoted
  // with an escape for its second character, and `!!str`-tagged.
  const forms = (name: string): Array<[string, string]> => [
    ["plain", name],
    ["single-quoted", `'${name}'`],
    [
      "escaped double-quoted",
      `"${name[0]}\\x${name.charCodeAt(1).toString(16)}${name.slice(2)}"`,
    ],
    ["tagged", `!!str ${name}`],
  ];
  const levels = [
    {
      level: "step",
      name: "shell",
      before: [
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm audit --audit-level=high",
      ],
      plain: (key: string) => `        ${key}: bash`,
      alias: "        *X : pwsh",
      after: [] as string[],
      reason: `the step mapping ${WRITTEN_TWICE}`,
    },
    {
      level: "job",
      name: "runs-on",
      before: ["jobs:", "  audit:"],
      plain: (key: string) => `    ${key}: ubuntu-latest`,
      alias: "    *X : windows-latest",
      after: ["    steps:", "      - run: npm audit --audit-level=high"],
      reason: `the job mapping ${WRITTEN_TWICE}`,
    },
  ];

  for (const l of levels) {
    for (const [keyForm, key] of forms(l.name)) {
      for (const [anchorForm, anchor] of forms(l.name)) {
        for (const aliasFirst of [false, true]) {
          it(`refuses a ${l.level} whose ${keyForm} \`${l.name}\` key repeats an alias to a ${anchorForm} anchor (${aliasFirst ? "alias first" : "plain first"})`, () => {
            const pair = aliasFirst
              ? [l.alias, l.plain(key)]
              : [l.plain(key), l.alias];
            const lines = [
              "on: push",
              "env:",
              `  A: &X ${anchor}`,
              ...l.before,
              ...pair,
              ...l.after,
            ];
            const text = lines.join("\n");
            expect(
              auditViolations(text, "workflow-slop/unparseable-workflow"),
            ).toEqual([]);
            expect(
              auditViolations(text, YAML_RULE).map((x) => [x.line, x.matched]),
            ).toEqual([[lines.indexOf(l.alias) + 1, "*X"]]);
            for (const config of [defaultConfig(), constructOff]) {
              const refusals = shapeViolations(text, config).filter((x) =>
                x.message.includes(l.reason),
              );
              expect(refusals).toHaveLength(1);
            }
          });
        }
      }
    }
  }
});

describe("workflow-slop/audit-gate-shape: an alias-key duplicate off the gate's read path", () => {
  const constructOff = mergeConfig({
    rules: { [YAML_RULE]: { enabled: false } },
  });
  const fileReason = (sites: string) =>
    `the file has a mapping carrying a key twice once its YAML aliases are resolved, or an alias this rule could not resolve (${sites})`;
  const job = [
    "jobs:",
    "  audit:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm audit --audit-level=high",
  ];
  const fixtures: Array<{ name: string; lines: string[]; sites: string }> = [
    {
      name: "a mapping in the workflow env that no gate reads",
      lines: [
        "on: push",
        "env:",
        "  A: &X shell",
        "  D: { run: { shell: bash, *X : pwsh } }",
        ...job,
      ],
      sites: "`*X` at line 4",
    },
    {
      name: "another job's `uses:`",
      lines: [
        "on: push",
        "env:",
        "  A: &U uses",
        ...job,
        "  c:",
        "    uses: ./.github/workflows/a.yml",
        "    *U : ./.github/workflows/b.yml",
      ],
      sites: "`*U` at line 11",
    },
    {
      name: "the gate step's own `env:`",
      lines: [
        "on: push",
        "env:",
        "  A: &E FOO",
        ...job,
        "        env:",
        "          FOO: a",
        "          *E : b",
      ],
      sites: "`*E` at line 11",
    },
  ];

  for (const f of fixtures) {
    it(`refuses every gate of a file whose duplicate sits in ${f.name}, with the construct finding enabled or disabled`, () => {
      const text = f.lines.join("\n");
      expect(auditViolations(text, YAML_RULE)).toHaveLength(1);
      expect(auditViolations(text, YAML_RULE, constructOff)).toEqual([]);
      for (const config of [defaultConfig(), constructOff]) {
        const v = shapeViolations(text, config);
        expect(v).toHaveLength(1);
        expect(v[0].message).toContain(fileReason(f.sites));
      }
    });
  }

  it("names every duplicate of the file and refuses each gate", () => {
    const text = [
      "on: push",
      "env:",
      "  A: &X shell",
      "  D: { run: { shell: bash, *X : pwsh } }",
      "  E: { shell: bash, *X : cmd }",
      ...job,
      "  second:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = shapeViolations(text, constructOff);
    expect(v.map((x) => x.line)).toEqual([10, 14]);
    for (const x of v) {
      expect(x.message).toContain(fileReason("`*X` at line 4, `*X` at line 5"));
    }
  });

  it("certifies the same files once the duplicate is removed", () => {
    for (const f of fixtures) {
      const text = f.lines
        .filter((line) => !/^\s*\*[A-Z] :/.test(line))
        .map((line) => line.replace(/, \*X : pwsh/, ""))
        .join("\n");
      expect(shapeViolations(text), f.name).toEqual([]);
    }
  });

  it("words the file-level refusal as a file the rule cannot read as GitHub Actions does, not as an unknown shell", () => {
    const [v] = shapeViolations(fixtures[0].lines.join("\n"), constructOff);
    expect(v.message).toContain(
      "so this rule cannot trust that it reads this file the way GitHub Actions does (GitHub Actions may use the other value of a key written twice, and rejects an alias it cannot resolve) and does not certify it. Write each key of a mapping once, and give every alias an anchor of a unique name that precedes it, with few enough aliases to resolve.",
    );
    expect(v.message).not.toContain("cannot tell which");
    expect(v.message).not.toContain("does not merge");
  });

  it("gives both sentences when the gate's own read path is unreadable as well", () => {
    const text = [
      "on: push",
      "env:",
      "  A: &X shell",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm audit --audit-level=high",
      "        shell: bash",
      "        *X : pwsh",
    ].join("\n");
    const [v] = shapeViolations(text, constructOff);
    expect(v.message).toContain(
      "cannot tell which `shell:`, `runs-on` or `continue-on-error` applies to the gate step, cannot trust that it reads this file the way GitHub Actions does",
    );
    expect(v.message).toContain("GitHub Actions does not merge `<<` keys");
    expect(v.message).toContain("Write each key of a mapping once");
  });

  it("names the first three sites in file order and counts the rest", () => {
    const text = [
      "on: push",
      "env:",
      "  A: &X FOO",
      "  B: { FOO: a, *X : b }",
      "  C: { FOO: a, *X : b }",
      "  D: *later",
      "  E: { FOO: a, *X : b }",
      "  F: { FOO: a, *X : b }",
      "  G: &later g",
      ...job,
    ].join("\n");
    const v = shapeViolations(text, constructOff);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      fileReason(
        "`*X` at line 4, `*X` at line 5, `*later` at line 6 and 2 more",
      ),
    );
  });
});

describe("workflow-slop/audit-gate-shape: an alias this rule could not resolve, off the gate's read path", () => {
  const constructOff = mergeConfig({
    rules: { [YAML_RULE]: { enabled: false } },
  });
  const job = [
    "jobs:",
    "  audit:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm audit --audit-level=high",
  ];
  const bomb = ["  L0: &l0 [a, a, a, a, a, a, a, a, a]"];
  for (let i = 1; i <= 9; i++) {
    bomb.push(
      `  L${i}: &l${i} [${Array(9)
        .fill(`*l${i - 1}`)
        .join(", ")}]`,
    );
  }
  const fixtures: Array<{ name: string; lines: string[]; site: string }> = [
    {
      name: "an alias key whose anchor follows it",
      lines: [
        "on: push",
        "env:",
        "  FOO: a",
        "  *X : b",
        "  B: &X FOO",
        ...job,
      ],
      site: "`*X` at line 4",
    },
    {
      name: "an alias that refers to a node containing it",
      lines: ["on: push", "env:", "  A: &L", "    - *L", ...job],
      site: "`*L` at line 4",
    },
    {
      name: "an alias key whose anchor name is defined twice",
      lines: [
        "on: push",
        "env:",
        "  A: &X FOO",
        "  FOO: a",
        "  *X : b",
        "  B: &X BAR",
        ...job,
      ],
      site: "`&X` at line 6",
    },
    {
      name: "aliases beyond the resolution budget",
      lines: ["on: push", "env:", ...bomb, ...job],
      site: "aliases beyond the resolution budget at line 1",
    },
  ];

  for (const f of fixtures) {
    it(`refuses the gate of a file with ${f.name}, with the construct finding enabled or disabled`, () => {
      const text = f.lines.join("\n");
      expect(auditViolations(text, YAML_RULE).length).toBeGreaterThan(0);
      expect(auditViolations(text, YAML_RULE, constructOff)).toEqual([]);
      for (const config of [defaultConfig(), constructOff]) {
        const v = shapeViolations(text, config);
        expect(v).toHaveLength(1);
        expect(v[0].message).toContain(
          `the file has a mapping carrying a key twice once its YAML aliases are resolved, or an alias this rule could not resolve (${f.site})`,
        );
      }
    });
  }
});

describe("workflow-slop/audit-gate-shape: the file-level refusal scales with gates and sites", () => {
  it("refuses 4000 gates of a file with 4000 off-path duplicates within a generous bound, with a message length linear in the gates", () => {
    const n = 4000;
    const lines = ["on: push", "env:", "  A: &X FOO"];
    for (let i = 0; i < n; i++) lines.push(`  E${i}: { FOO: a, *X : b }`);
    lines.push("jobs:", "  audit:", "    runs-on: ubuntu-latest", "    steps:");
    for (let i = 0; i < n; i++) {
      lines.push("      - run: npm audit --audit-level=high");
    }
    const constructOff = mergeConfig({
      rules: { [YAML_RULE]: { enabled: false } },
    });
    const started = Date.now();
    const v = shapeViolations(lines.join("\n"), constructOff);
    const elapsed = Date.now() - started;
    expect(v).toHaveLength(n);
    // Each message names at most three sites, so the sum stays near
    // n x one message (about 1 KB); listing every site in every message
    // would put it above 300 MB.
    const total = v.reduce((sum, x) => sum + x.message.length, 0);
    expect(total).toBeLessThan(n * 2000);
    expect(v[0].message).toContain(`and ${n - 3} more`);
    // About 7 to 8.5 s on a developer machine, where the per-gate line
    // lookup of each finding dominates; the bound allows five times that
    // for slower CI runners.
    expect(elapsed).toBeLessThan(45000);
  }, 120000);
});

// A `<<` key that yaml reads as a merge key: under a `%YAML 1.1` directive
// it is a scalar whose value is a symbol (and yaml merges it), and a
// `!!merge` tag gives the same node in a YAML 1.2 document. GitHub Actions
// does not merge it, so it is reported and never certifies an audit gate.
describe("workflow-slop: a merge key that yaml reads as a symbol", () => {
  const DISABLE =
    " # slop-detector:disable-line=workflow-slop/unsupported-yaml-construct";
  const gate = "      - run: npm audit --audit-level=high";
  const shellAnchor = ["b: &b", "  shell: pwsh"];
  const defaultsAnchor = ["b: &b", "  run:", "    shell: pwsh"];
  const CANNOT_NAME = "has a key this rule cannot name";
  const KEY = "@@KEY@@";

  // How the merge key is spelled, and the lines that precede the document.
  const variants: Array<{ name: string; header: string[]; key: string }> = [
    { name: "%YAML 1.1 `<<`", header: ["%YAML 1.1", "---"], key: "<<" },
    { name: "`!!merge <<` in a YAML 1.2 file", header: [], key: "!!merge <<" },
  ];
  const cases: Array<{ level: string; lines: string[]; reason: string }> = [
    {
      level: "step",
      lines: [
        "on: push",
        ...shellAnchor,
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
        `        ${KEY}: *b`,
      ],
      reason: `the step mapping ${CANNOT_NAME}`,
    },
    {
      level: "job",
      lines: [
        "on: push",
        ...shellAnchor,
        "jobs:",
        "  audit:",
        `    ${KEY}: *b`,
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
      ],
      reason: `the job mapping ${CANNOT_NAME}`,
    },
    {
      level: "workflow",
      lines: [
        ...shellAnchor,
        `${KEY}: *b`,
        "on: push",
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
      ],
      reason: `the workflow mapping ${CANNOT_NAME}`,
    },
    {
      level: "jobs mapping",
      lines: [
        "on: push",
        ...shellAnchor,
        "jobs:",
        `  ${KEY}: *b`,
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
      ],
      reason: `a mapping enclosing the step mapping ${CANNOT_NAME}`,
    },
    {
      level: "workflow defaults",
      lines: [
        "on: push",
        ...defaultsAnchor,
        "defaults:",
        `  ${KEY}: *b`,
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
      ],
      reason: `the workflow's \`defaults\` mapping ${CANNOT_NAME}`,
    },
    {
      level: "workflow defaults.run",
      lines: [
        "on: push",
        ...shellAnchor,
        "defaults:",
        "  run:",
        `    ${KEY}: *b`,
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
      ],
      reason: `the workflow's \`defaults.run\` mapping ${CANNOT_NAME}`,
    },
    {
      level: "job defaults",
      lines: [
        "on: push",
        ...defaultsAnchor,
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    defaults:",
        `      ${KEY}: *b`,
        "    steps:",
        gate,
      ],
      reason: `the job's \`defaults\` mapping ${CANNOT_NAME}`,
    },
    {
      level: "job defaults.run",
      lines: [
        "on: push",
        ...shellAnchor,
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    defaults:",
        "      run:",
        `        ${KEY}: *b`,
        "    steps:",
        gate,
      ],
      reason: `the job's \`defaults.run\` mapping ${CANNOT_NAME}`,
    },
    {
      level: "runs-on mapping",
      lines: [
        "on: push",
        "b: &b",
        "  labels: windows-latest",
        "jobs:",
        "  audit:",
        "    runs-on:",
        "      group: g",
        `      ${KEY}: *b`,
        "    steps:",
        gate,
      ],
      reason: `the job's \`runs-on:\` contains an alias this rule cannot resolve or a key it cannot name`,
    },
  ];

  const build = (
    variant: (typeof variants)[number],
    lines: string[],
    disable: boolean,
  ) => {
    const body = lines.map((l) => l.replace(KEY, variant.key));
    const at = lines.findIndex((l) => l.includes(KEY));
    if (disable) body[at] += DISABLE;
    return {
      text: [...variant.header, ...body].join("\n"),
      line: variant.header.length + at + 1,
      // yaml places a tagged scalar's node at its value, after the tag.
      column: body[at].indexOf("<<") + 1,
    };
  };

  for (const variant of variants) {
    for (const c of cases) {
      it(`refuses the gate and reports the key: ${variant.name} at the ${c.level} level, with or without the construct finding disabled`, () => {
        for (const disable of [false, true]) {
          const { text, line, column } = build(variant, c.lines, disable);
          const label = `disable=${disable}`;
          const v = shapeViolations(text);
          expect(v, label).toHaveLength(1);
          expect(v[0].severity, label).toBe("block");
          expect(v[0].message, label).toContain(c.reason);
          const found = auditViolations(text, YAML_RULE);
          expect(
            found.map((x) => [x.line, x.column, x.matched]),
            label,
          ).toEqual(disable ? [] : [[line, column, "<<"]]);
        }
      });

      it(`refuses the gate with the construct rule switched off in the config: ${variant.name} at the ${c.level} level`, () => {
        const { text } = build(variant, c.lines, false);
        const off = mergeConfig({ rules: { [YAML_RULE]: { enabled: false } } });
        expect(auditViolations(text, YAML_RULE, off)).toEqual([]);
        const v = shapeViolations(text, off);
        expect(v).toHaveLength(1);
        expect(v[0].message).toContain(c.reason);
      });
    }
  }

  it("reports the merge key of a `? !!merge <<` explicit key at the key, not scanning clean", () => {
    const text = [
      "on: push",
      ...shellAnchor,
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      gate,
      "        ? !!merge <<",
      "        : *b",
    ].join("\n");
    expect(shapeViolations(text)).toHaveLength(1);
    expect(auditViolations(text, YAML_RULE).map((x) => x.matched)).toEqual([
      "<<",
    ]);
  });

  it("reports a merge key that stands in a `run:` scalar's own mapping in a non-audit workflow", () => {
    const text = [
      "%YAML 1.1",
      "---",
      "on: issues",
      "b: &b",
      "  name: x",
      "jobs:",
      "  j:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo ${{ github.event.issue.title }}",
      "        <<: *b",
    ].join("\n");
    const v = violationsOf(text, YAML_RULE);
    expect(v.map((x) => [x.line, x.column, x.matched])).toEqual([
      [11, 9, "<<"],
    ]);
  });

  it("certifies a `%YAML 1.1` gate whose keys are all plain text or plain scalars (`on`, `yes`, numbers), with no finding", () => {
    const text = [
      "%YAML 1.1",
      "---",
      "on: push",
      "env:",
      "  yes: a",
      "  1: b",
      "  0x10: c",
      "  1:30: d",
      "  ~: e",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      gate,
    ].join("\n");
    expect(shapeViolations(text)).toEqual([]);
    expect(violationsOf(text, YAML_RULE, AUDIT_PATH)).toEqual([]);
  });

  it("refuses a gate whose step carries a date or a binary key, and reports the key", () => {
    for (const key of ["2001-01-01", "!!binary cnVu"]) {
      const text = [
        "%YAML 1.1",
        "---",
        "on: push",
        "jobs:",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        gate,
        `        ${key}: x`,
      ].join("\n");
      const v = shapeViolations(text);
      expect(v, key).toHaveLength(1);
      expect(v[0].message, key).toContain(`the step mapping ${CANNOT_NAME}`);
      const found = auditViolations(text, YAML_RULE);
      // yaml places a tagged scalar's node at its value, after the tag.
      expect(
        found.map((x) => [x.line, x.column, x.matched]),
        key,
      ).toEqual([[9, 9 + key.lastIndexOf(" ") + 1, key.split(" ").pop()]]);
      expect(found[0].message, key).toContain("is not text");
    }
  });
});

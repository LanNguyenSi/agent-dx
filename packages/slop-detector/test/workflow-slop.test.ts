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

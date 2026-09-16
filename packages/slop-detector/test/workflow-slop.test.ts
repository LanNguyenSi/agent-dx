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

// ─────────────────────────── audit-gate-shape ───────────────────────────

describe("workflow-slop/audit-gate-shape", () => {
  const AUDIT_PATH = ".github/workflows/audit.yml";

  function ruleViolations(text: string, filePath = AUDIT_PATH) {
    return checkText(text, filePath, {
      packs: allPacks,
      config: defaultConfig(),
      packFilter: ["workflow-slop"],
    }).filter((v) => v.ruleId === "workflow-slop/audit-gate-shape");
  }

  // Shape copied from a real fleet audit.yml's gate step: `set +e`, run the
  // gate command, capture `$?`, `set -e`, then branch/exit on the captured
  // status. This is the negative control the rule must never flag, even
  // though it does carry a `set +e` before the gate command.
  const CANONICAL_AUDIT_YML = [
    "on: push",
    "jobs:",
    "  audit:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: npm audit (full report, non-blocking)",
    "        run: timeout 60s npm audit --no-fund || true",
    "      - name: npm audit gate (high/critical fail)",
    "        run: |",
    "          set -o pipefail",
    "          set +e",
    '          timeout 60s npm audit --audit-level=high --no-fund 2>&1 | tee "$LOG"',
    "          STATUS=$?",
    "          set -e",
    '          if [ "$STATUS" -eq 0 ]; then',
    "            exit 0",
    "          fi",
    "          exit 1",
  ].join("\n");

  it("negative control: the canonical set +e / capture $? / set -e gate shape is not flagged", () => {
    expect(ruleViolations(CANONICAL_AUDIT_YML)).toHaveLength(0);
  });

  it("negative control: the report step's own npm audit || true (no --audit-level=) is not itself a gate and is not flagged", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --no-fund || true",
      "      - run: npm audit --audit-level=high --no-fund",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("negative control: --audit-level=critical is recognised as a valid gate", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --audit-level=critical --no-fund",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("negative control: a || exit 1 right-hand side is not a neutralisation", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --audit-level=high || exit 1",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("flags a missing gate step (no npm audit --audit-level=high/critical run step anywhere in the file)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --no-fund || true",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "No recognised npm-audit gate command was found",
    );
  });

  it("flags a bare || true right after the gate command", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --audit-level=high || true",
    ].join("\n");
    expect(ruleViolations(text).length).toBeGreaterThanOrEqual(1);
  });

  it("flags || true # keep green (trailing comment does not hide the neutralisation)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --audit-level=high || true # keep green",
    ].join("\n");
    expect(ruleViolations(text).length).toBeGreaterThanOrEqual(1);
  });

  it("flags || true; (a trailing semicolon does not hide it)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --audit-level=high || true;",
    ].join("\n");
    expect(ruleViolations(text).length).toBeGreaterThanOrEqual(1);
  });

  it("flags ||true with no space", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --audit-level=high ||true",
    ].join("\n");
    expect(ruleViolations(text).length).toBeGreaterThanOrEqual(1);
  });

  it("flags a backslash-continued gate command followed by || : on the continuation line", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          npm audit --audit-level=high \\",
      "            || :",
    ].join("\n");
    expect(ruleViolations(text).length).toBeGreaterThanOrEqual(1);
  });

  it("flags set +e above the gate command with no exit-status capture/restore afterward", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          set +e",
      "          npm audit --audit-level=high",
      '          echo "ignoring failures"',
    ].join("\n");
    const v = ruleViolations(text);
    expect(v.some((x) => x.matched === "set +e")).toBe(true);
  });

  it("flags continue-on-error: true on the gate step", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - name: gate",
      "        continue-on-error: true",
      "        run: npm audit --audit-level=high",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v.some((x) => x.matched === "continue-on-error: true")).toBe(true);
  });

  it("negative control: continue-on-error: false on the gate step is not flagged", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - name: gate",
      "        continue-on-error: false",
      "        run: npm audit --audit-level=high",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("flags a gate line ending in ; true", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --audit-level=high; true",
    ].join("\n");
    expect(ruleViolations(text).length).toBeGreaterThanOrEqual(1);
  });

  it("flags a gate line ending in ; : (a block scalar run:, since a plain scalar ending in a bare trailing colon is itself ambiguous YAML)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          npm audit --audit-level=high; :",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.some((x) => x.message.includes("; true` or `; :`"))).toBe(true);
  });

  it("negative control: off by default, does not fire without --pack/config opt-in", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --no-fund || true",
    ].join("\n");
    const v = checkText(text, AUDIT_PATH, {
      packs: allPacks,
      config: defaultConfig(),
    });
    expect(v.filter((x) => x.pack === "workflow-slop")).toHaveLength(0);
  });

  it("negative control: a non-audit workflow file is never scanned by this rule, even with the exact same neutralised gate text", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --audit-level=high || true",
    ].join("\n");
    expect(ruleViolations(text, ".github/workflows/ci.yml")).toHaveLength(0);
  });

  // ── non-zero verdict requirement (round-1 review H1 / M3) ──
  // Presence of `$?` and `set -e` alone is not enough: the captured status
  // must actually be turned back into a non-zero exit.

  it("flags set +e / capture $? / restore set -e with NO exit verdict afterward (exit 0 only): capture-and-restore is not itself a verdict", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          set +e",
      "          npm audit --audit-level=high",
      "          STATUS=$?",
      "          set -e",
      "          exit 0",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v.some((x) => x.matched === "set +e")).toBe(true);
  });

  it("flags set +e / capture $? / restore set -e with only an echo of the status, no exit at all", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          set +e",
      "          npm audit --audit-level=high",
      "          STATUS=$?",
      "          set -e",
      '          echo "status $STATUS"',
    ].join("\n");
    const v = ruleViolations(text);
    expect(v.some((x) => x.matched === "set +e")).toBe(true);
  });

  it("flags set +e / capture $? / exit $STATUS with NO set -e restore (restoresStrict forced false)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          set +e",
      "          npm audit --audit-level=high",
      "          STATUS=$?",
      "          exit $STATUS",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v.some((x) => x.matched === "set +e")).toBe(true);
  });

  it("flags set +e / set -e restore / exit $STATUS with NO $? capture (capturesStatus forced false)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          set +e",
      "          npm audit --audit-level=high",
      "          set -e",
      "          exit $STATUS",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v.some((x) => x.matched === "set +e")).toBe(true);
  });

  it("negative control: set +e / capture $? / set -e / exit $STATUS (a real non-zero-verdict conversion) is not flagged", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          set +e",
      "          npm audit --audit-level=high",
      "          STATUS=$?",
      "          set -e",
      "          exit $STATUS",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  // ── comment-stripping discrimination (round-1 review M2 / L2) ──

  it("negative control: || inside a real trailing comment (block scalar) is not treated as a neutralisation, only once the comment is stripped before the || scan", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          npm audit --audit-level=high   # do not add || true here",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("flags ; true only once a trailing comment after it is stripped (block scalar; the comment text itself is not '; true')", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          npm audit --audit-level=high; true   # comment",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v.some((x) => x.message.includes("; true` or `; :`"))).toBe(true);
  });

  it("negative control: an escaped double-quote inside the gate line's own quoted argument does not fool the comment-quote-parity scan into leaving a real comment's || unstripped", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      '          npm audit --audit-level=high --note="it\\"s fine"   # || true',
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("catches ; true mid-line, not just at end-of-line (the tail check is no longer end-anchored)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          npm audit --audit-level=high; true ; echo done",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v.some((x) => x.message.includes("; true` or `; :`"))).toBe(true);
  });

  // ── continue-on-error: not-provably-false + job-level (round-1 review M1) ──

  it("flags continue-on-error set to an unresolved ${{ }} expression on the gate step (not provably false)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - name: gate",
      "        continue-on-error: ${{ inputs.allow_failure }}",
      "        run: npm audit --audit-level=high",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v.some((x) => x.message.includes("cannot be proven false"))).toBe(
      true,
    );
  });

  it("flags continue-on-error: true set at the job level, above the gate step", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    continue-on-error: true",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v.some((x) => x.message.includes("enclosing job"))).toBe(true);
  });

  it("negative control: continue-on-error: false at the job level is not flagged", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    continue-on-error: false",
      "    steps:",
      "      - run: npm audit --audit-level=high",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  // ── npm-only scope: moderate/low accepted, pnpm and non-npm documented (round-1 review M5) ──

  it("negative control: --audit-level=moderate is recognised as a (stronger) valid gate", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --audit-level=moderate --no-fund",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("negative control: --audit-level=low is recognised as a (stronger) valid gate", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: npm audit --audit-level=low --no-fund",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("documented finding: a pnpm audit --audit-level=high gate is out of this rule's npm-only scope and is reported as a missing gate with the new wording", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: pnpm audit --audit-level=high",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(
      "No recognised npm-audit gate command was found",
    );
  });

  // ── run-block normalisation ──
  // Every check in this rule consumes `normalizeRunBlock`'s output
  // (logical lines joined, trailing comments stripped per line,
  // statements cut at unquoted `;`/`&&`/`||`/`|`, quoted spans respected
  // per match kind) instead of the raw `run:` text. Each of the three
  // positives below scanned CLEAN against the raw-text analysis these
  // tests replaced, and the two negative controls below were false
  // positives under it.

  const NO_VERDICT_MESSAGE =
    "nothing afterward turns that captured status back into a non-zero step exit";
  const NO_CAPTURE_MESSAGE =
    "without both capturing its exit status (`$?`) and restoring `set -e` afterward";
  const MISSING_GATE_MESSAGE = "No recognised npm-audit gate command was found";
  const TAIL_NOOP_MESSAGE = "; true` or `; :`";

  it("flags the canonical gate shape with its exit verdict commented out (a `#`-commented `exit $STATUS` is not a verdict)", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          set +e",
      "          npm audit --audit-level=high",
      "          STATUS=$?",
      "          set -e",
      "          # exit $STATUS",
      '          echo "status=$STATUS"',
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].matched).toBe("set +e");
    expect(v[0].message).toContain(NO_VERDICT_MESSAGE);
  });

  it("flags a `set +e` gate whose gate boundary a comment naming --audit-level=high above it used to move", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          # we gate at --audit-level=high",
      "          set +e",
      "          npm audit --audit-level=high",
      "          echo done",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].matched).toBe("set +e");
    expect(v[0].message).toContain(NO_CAPTURE_MESSAGE);
  });

  it("flags a gate command that exists only inside a comment as a MISSING gate, not a present one", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          # TODO: restore npm audit --audit-level=high",
      '          echo "audit reported"',
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(MISSING_GATE_MESSAGE);
  });

  it("negative control: `set +e` written only inside a quoted echo string is data, not a `set +e`", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      '          echo "set +e"',
      "          npm audit --audit-level=high",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("negative control: a `; true` BEFORE the gate command (cd api; true && npm audit ...) is not a tail on the gate", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          cd api; true && npm audit --audit-level=high",
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("negative control: a `||` inside the gate command's own quoted argument is not a neutralisation", () => {
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      '          npm audit --audit-level=high --note="a || b"',
    ].join("\n");
    expect(ruleViolations(text)).toHaveLength(0);
  });

  it("comment stripping decides which logical line IS the gate line: a commented-out reference to the gate above the real, `; true`-tailed gate line", () => {
    // Positive-direction pin on the stripper: with comments left in, the
    // FIRST line matching the gate command is the comment, whose own
    // post-gate tail is empty, so the real `; true` below it is never
    // examined and the block scans clean. The `;` inside the comment sits
    // BEFORE the gate command there, which is what makes this case
    // discriminate (a comment whose `;` sits after the gate command would
    // flag either way).
    const text = [
      "on: push",
      "jobs:",
      "  audit:",
      "    steps:",
      "      - run: |",
      "          # never append `; true` to npm audit --audit-level=high",
      "          npm audit --audit-level=high ; true",
    ].join("\n");
    const v = ruleViolations(text);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(TAIL_NOOP_MESSAGE);
    expect(v[0].matched).toBe("; true");
  });

  // ── real fleet shape, and the reach of the verdict requirement ──

  const REAL_FLEET_AUDIT_YML = fs.readFileSync(
    path.join(import.meta.dirname, "fixtures", "fleet-audit-real-shape.yml"),
    "utf8",
  );

  it("negative control: the real fleet audit.yml shape (comment-heavy gate step: `|| true` in prose, four exit codes, a quoted `;`) is not flagged", () => {
    expect(ruleViolations(REAL_FLEET_AUDIT_YML)).toHaveLength(0);
  });

  it("documented limit: flipping only the findings-branch `exit 1` to `exit 0` in the real fleet shape still scans clean, because ANY non-zero exit after the gate satisfies the verdict requirement (its `exit 2`/`exit 3` outage branches remain)", () => {
    const neutralised = REAL_FLEET_AUDIT_YML.replace(
      'read the report step above"\n            exit 1',
      'read the report step above"\n            exit 0',
    );
    // Guard the flip itself: a fixture refresh that moves this line must
    // fail here rather than silently turn the pin into a re-run of the
    // negative control above.
    expect(neutralised).not.toBe(REAL_FLEET_AUDIT_YML);
    expect(ruleViolations(neutralised)).toHaveLength(0);
  });
});

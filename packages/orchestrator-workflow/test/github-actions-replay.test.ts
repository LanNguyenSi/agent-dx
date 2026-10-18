import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

// The GitHub Actions shell replay reaches a briefing only when the diff touches
// workflow or action files. The rule text lives in one skill reference, the
// orchestrator-side trigger and copy instruction is stated once in
// evidence-and-probes.md, and the reviewer flags a diff that matches the
// trigger when its briefing lacks the reference. The reference's own wording
// beyond its scratch-copy requirement is covered by review, not pinned here.

const unwrap = (text: string) => text.replace(/\s+/g, " ");
const reference = () =>
  unwrap(readAsset("skill/references/github-actions-replay.md"));
const TRIGGER_GLOBS = "`.github/workflows/**`";

describe("GitHub Actions replay rules", () => {
  it("ships the full rule in one skill reference, including the reviewer's scratch-copy requirement", () => {
    const rules = reference();
    expect(rules).toContain(
      "These rules apply only to a briefing that carries them;",
    );
    expect(rules).toContain(
      "`bash --noprofile --norc -eo pipefail` when `shell: bash` is set on the step or via `defaults.run.shell`",
    );
    expect(rules).toContain("`bash -e` otherwise on Linux and macOS runners");
    expect(rules).toContain(
      "replay with the expected-success and the expected-failure inputs",
    );
    expect(rules).toContain(
      "Do the replay in a scratch copy of the repository outside the reviewed working tree (a temporary clone or a copied checkout in your scratchpad directory) so it never runs against, or writes into, the tree you are reviewing; this keeps the replay compatible with the read-only Bash rule in your prompt.",
    );
  });

  it("states the trigger paths and the copy instruction once, in evidence-and-probes.md", () => {
    const rule = unwrap(
      "When the diff will touch `.github/workflows/**` or an `action.yml` or `action.yaml` at any depth (an implementer briefing judges this from the task's allowed changes, a reviewer briefing from the actual diff), copy [GitHub Actions replay rules](github-actions-replay.md), unedited and with its heading, into the briefing after its YAML block; leave it out of every briefing for a diff that touches none of those paths.",
    );
    const evidence = unwrap(
      readAsset("skill/references/evidence-and-probes.md"),
    );
    expect(evidence.split(rule)).toHaveLength(2);
    expect(evidence.split(TRIGGER_GLOBS)).toHaveLength(2);
    for (const other of [
      "skill/SKILL.md",
      "skill/references/contracts.md",
      "skill/references/github-actions-replay.md",
      "agents/implementer.md",
    ]) {
      expect(unwrap(readAsset(other))).not.toContain(TRIGGER_GLOBS);
    }
  });

  it("has the reviewer flag a trigger-matching diff whose briefing lacks the replay rules", () => {
    expect(unwrap(readAsset("agents/reviewer.md"))).toContain(
      "- GitHub Actions shell replay: when the briefing carries the GitHub Actions replay rules, follow them; a diff that touches `.github/workflows/**`, `action.yml` or `action.yaml` while the briefing lacks them is a finding.",
    );
  });

  it("has the implementer follow the rules a briefing carries and report a missing set as an open question", () => {
    expect(unwrap(readAsset("agents/implementer.md"))).toContain(
      "- When your briefing carries the GitHub Actions replay rules, follow them; if your diff adds or changes a GitHub Actions `run:` step and the briefing lacks them, report that as an open question.",
    );
  });

  it("keeps the replay rule text out of both role prompts", () => {
    for (const role of ["agents/implementer.md", "agents/reviewer.md"]) {
      const prompt = readAsset(role);
      expect(prompt).not.toContain("--noprofile");
      expect(prompt).not.toContain("pipefail");
      expect(prompt).not.toContain("pwsh");
      expect(prompt).not.toContain("expected-failure inputs");
      expect(prompt).not.toContain("outside the reviewed working tree");
    }
  });

  it("rewords the reviewer's cross-references so they hold without the replay block", () => {
    const reviewer = unwrap(readAsset("agents/reviewer.md"));
    expect(reviewer).toContain(
      "the empirical-reproduction rule, the GitHub Actions replay rules when the briefing carries them, and the probe replay of a run mode `single` briefing apply under every method.",
    );
    expect(reviewer).toContain(
      "A replay that the GitHub Actions replay rules call for, when the briefing carries them, is a second, explicitly non-probabilistic trigger for the same field: report it here too, with `sample_size: not_applicable` when the replay itself has no meaningful sample size.",
    );
    expect(reviewer).not.toContain("replay rule above");
  });
});

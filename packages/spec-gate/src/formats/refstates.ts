/**
 * Reference states.
 *
 * Every input a step reads is read at a named revision. This table says,
 * for each input, which revision that is, who sets it, at which step,
 * where it is stored, and which ancestry check applies.
 *
 * Principle: every reference revision (`base_commit`, `commands_ref`, the
 * binding reference, the start commit, the commit of an evidence
 * envelope) is set by a code step, never by a model role. A model may
 * write the content of a spec file; it never decides which commit a check
 * is read at.
 *
 * `docs/formats.md` embeds `renderReferenceStateTable()` between markers;
 * a test fails when the two differ.
 */
import { markdownCell } from "./markdown.js";

export type ReferenceStateKind = "file" | "reference";

export interface ReferenceState {
  /** Stable key. */
  id: string;
  /** What is read. */
  input: string;
  /** A file the steps read, or a revision identifier that steps use to read files. */
  kind: ReferenceStateKind;
  /** The revision that is read. */
  revisionRead: string;
  /** Who sets it. */
  setBy: string;
  /** True when a code step (or the host) sets it, false when a model role writes it. */
  setByCode: boolean;
  /** The step that sets it. */
  step: string;
  /** Where it is stored. */
  storedIn: string;
  /** The ancestry check that applies. */
  ancestryCheck: string;
}

export const REFERENCE_STATES: readonly ReferenceState[] = [
  {
    id: "spec",
    input: "`spec.md`",
    kind: "file",
    revisionRead:
      "the head of the spec pull request for lint, digest and propose; the merged default-branch tip once approved",
    setBy: "translator writes the content; `propose` sets `status` only",
    setByCode: false,
    step: "translate, propose",
    storedIn: "`specs/<id>/spec.md`",
    ancestryCheck:
      "none; the approval check compares the digest at the head with the digest at the approving review's commit, and again on the default branch after the merge",
  },
  {
    id: "testplan",
    input: "`testplan.yaml`",
    kind: "file",
    revisionRead: "as `spec.md`",
    setBy: "translator",
    setByCode: false,
    step: "test plan",
    storedIn: "`specs/<id>/testplan.yaml`",
    ancestryCheck: "none; same digest comparison as `spec.md`",
  },
  {
    id: "bindings",
    input: "`bindings.yaml`",
    kind: "file",
    revisionRead:
      "the head of the pull request; after `proposed`, compared with the binding reference",
    setBy: "translator until `proposed`, then only `bind`",
    setByCode: false,
    step: "test plan, bind",
    storedIn: "`specs/<id>/bindings.yaml`",
    ancestryCheck: "see binding reference",
  },
  {
    id: "triage",
    input: "`triage.json`",
    kind: "file",
    revisionRead: "the head of the pull request",
    setBy: "discoverer writes the fields; `triage` derives the class",
    setByCode: false,
    step: "triage",
    storedIn: "`specs/<id>/triage.json`",
    ancestryCheck: "none",
  },
  {
    id: "questions",
    input: "`questions.json`",
    kind: "file",
    revisionRead: "the head of the pull request",
    setBy: "translator writes questions; `answer` writes answers",
    setByCode: false,
    step: "translate, answer",
    storedIn: "`specs/<id>/questions.json`",
    ancestryCheck: "none",
  },
  {
    id: "config",
    input: "`.spec-gate/config.yaml`",
    kind: "file",
    revisionRead:
      "the default-branch tip; for a pull request its base commit; never the head of a spec pull request",
    setBy: "a person, in a pull request of its own",
    setByCode: false,
    step: "every step that reads it (lint, approval check)",
    storedIn: "`.spec-gate/config.yaml`",
    ancestryCheck:
      "none; a spec pull request that changes any file under `.spec-gate/` is a lint error and is never approved",
  },
  {
    id: "commands",
    input: "`.spec-gate/commands.yaml`",
    kind: "file",
    revisionRead:
      "the file at `commands_ref`; the runner, lint and digest all read this one revision",
    setBy:
      "a person, in a pull request of its own; the translator may only draft a proposal that never runs",
    setByCode: false,
    step: "every step that reads it (runner, lint, digest)",
    storedIn: "`.spec-gate/commands.yaml`",
    ancestryCheck: "the revision is `commands_ref`; see `commands_ref`",
  },
  {
    id: "source-meta",
    input: "`source/meta.json`",
    kind: "file",
    revisionRead: "the head of the pull request",
    setBy: "`intake`",
    setByCode: true,
    step: "intake",
    storedIn: "`specs/<id>/source/meta.json`",
    ancestryCheck:
      "none; it holds `base_commit` and `commands_ref`, and lint checks that the `spec.md` frontmatter matches",
  },
  {
    id: "base-commit",
    input: "`base_commit`",
    kind: "reference",
    revisionRead:
      "the head of the fetched remote default branch at intake; every discovery and baseline check runs there",
    setBy: "`intake`; `propose` only verifies and sets nothing",
    setByCode: true,
    step: "intake",
    storedIn: "`source/meta.json` and the `spec.md` frontmatter",
    ancestryCheck:
      "must be an ancestor of the default branch: of the fetched remote default branch while no pull request exists, of the pull request base afterwards; otherwise a lint error and the runner stops. A spec pull request whose target is not the default branch stops the runner and is never approved",
  },
  {
    id: "commands-ref",
    input: "`commands_ref`",
    kind: "reference",
    revisionRead:
      "the head of the fetched remote default branch at intake, the same commit as `base_commit`",
    setBy: "`intake`; `propose` only verifies and sets nothing",
    setByCode: true,
    step: "intake",
    storedIn: "`source/meta.json` and the `spec.md` frontmatter",
    ancestryCheck:
      "must be an ancestor of the default branch, checked as for `base_commit`; the approval check resolves the argv lists at this commit itself and prints them",
  },
  {
    id: "binding-reference",
    input: "binding reference",
    kind: "reference",
    revisionRead:
      "`bindings.yaml` at the commit `propose` ran at; once the log is on the default branch and the propose commit is no ancestor of the head (a squash or rebase merge), `bindings.yaml` at the diff base, read from git",
    setBy:
      "`propose`, as the hash of `bindings.yaml` in the first `bindings.log` entry",
    setByCode: true,
    step: "propose",
    storedIn: "`specs/<id>/bindings.log` (outside the digest)",
    ancestryCheck:
      "the propose commit must be an ancestor of the head; after a squash or rebase merge it may not be, and then the diff base must hold the log of the spec at the same path with the same propose entry, the log at the head must extend it, and only the bind entries after it are checked and replayed; otherwise a lint error",
  },
  {
    id: "start-commit",
    input: "start commit",
    kind: "reference",
    revisionRead:
      "the commit the implementation work started from; closing evidence is compared there",
    setBy: "the host, passed as `closure --start <commit>`",
    setByCode: true,
    step: "closure",
    storedIn: "not stored; an argument of the closing check",
    ancestryCheck:
      "must be a descendant of the merged spec commit; otherwise the closing check stops",
  },
  {
    id: "evidence",
    input: "evidence envelopes",
    kind: "reference",
    revisionRead:
      "the commit each envelope names in its `commit` field, which the runner reads from its own checkout",
    setBy: "the host runner; never a model role",
    setByCode: true,
    step: "evidence (phase `baseline`) and closure (phase `closure`)",
    storedIn:
      "`specs/<id>/evidence/TP-<n>.jsonl`, one file per test-plan row, JSON Lines, both phases in one file",
    ancestryCheck:
      "`baseline`: the commit must equal `base_commit`, the work tree clean, the `commands_digest` the digest of the row's one command at `commands_ref` and the selector the binding's, else `stale-evidence`; `closure` (which includes per-slice evidence): the commit must be the start commit or a descendant of it; after a squash merge an envelope stays valid if its commit is reachable from the default branch, otherwise only if it was on the PR branch before the squash and the PR's CI run references it",
  },
];

export function referenceStateOf(id: string): ReferenceState | undefined {
  return REFERENCE_STATES.find((r) => r.id === id);
}

/** Markdown table of `REFERENCE_STATES`, as embedded in `docs/formats.md`. */
export function renderReferenceStateTable(): string {
  const rows = [
    "| Input | Revision read | Set by | Step | Stored in | Ancestry check |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of REFERENCE_STATES) {
    rows.push(
      `| ${markdownCell(r.input)} | ${markdownCell(r.revisionRead)} | ${markdownCell(r.setBy)} | ${markdownCell(r.step)} | ${markdownCell(r.storedIn)} | ${markdownCell(r.ancestryCheck)} |`,
    );
  }
  return rows.join("\n");
}

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { REMOTE_MAIN, SPEC_REL } from "../lint/git-helpers.js";
import {
  build,
  check,
  cond,
  failing,
  keep,
  propose,
  review,
  type Scenario,
  type SpecChange,
} from "./helpers.js";

const NO_COMMIT = "0".repeat(40);

/** The standard repository: proposed spec at the head, `CONFIG` on the default branch. */
let S: Scenario;

beforeAll(async () => {
  S = keep(await build());
}, 60_000);

/** Replaces `old` in a file of the spec directory of the work tree. */
function edit(spec: string, name: string, old: string, next: string): void {
  const file = path.join(spec, name);
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(old)) throw new Error(`${name} does not contain ${old}`);
  fs.writeFileSync(file, text.replace(old, next));
}

describe(
  "condition 3: the digest that was approved",
  { timeout: 60_000 },
  () => {
    it("holds for an approval of an older commit with the same digest, though condition 1 does not", async () => {
      // Between the draft and the head only the status changed, which the
      // digest leaves out.
      const report = await check(S, {
        reviews: [review("alice", "APPROVED", S.draft)],
      });
      expect(cond(report, 1).code).toBe("approval-stale");
      expect(cond(report, 3)).toMatchObject({ ok: true, code: "ok" });
      expect(report.approved).toBe(false);
    });

    it("the spec changed after the approval: digest-mismatch; an approval of the head is compared instead of a stale one", async () => {
      const s = await build({ propose: false });
      edit(s.spec, "spec.md", "HTTP 401", "HTTP 403");
      await s.repo.commit({}, "another status code");
      const head = await propose(s.repo);
      const now = { ...s, head };
      const stale = await check(now, {
        reviews: [review("alice", "APPROVED", s.draft)],
      });
      expect(cond(stale, 3)).toMatchObject({
        ok: false,
        code: "digest-mismatch",
      });
      expect(cond(stale, 3).message).toContain(s.draft);
      expect(stale.approved).toBe(false);
      const fresh = await check(now, {
        reviews: [
          review("bob", "APPROVED", s.draft, 1),
          review("alice", "APPROVED", head, 2),
        ],
      });
      expect(cond(fresh, 3)).toMatchObject({ ok: true, code: "ok" });
      expect(fresh.approved).toBe(true);
    });

    it("no approving review: no-approval", async () => {
      const report = await check(S, { reviews: [] });
      expect(cond(report, 3)).toMatchObject({
        ok: false,
        code: "no-approval",
      });
    });

    it("the commit of the review is not in the repository: review-commit-unavailable", async () => {
      const report = await check(S, {
        reviews: [review("alice", "APPROVED", NO_COMMIT)],
      });
      expect(cond(report, 3)).toMatchObject({
        ok: false,
        code: "review-commit-unavailable",
      });
      expect(report.approved).toBe(false);
    });

    it("the commit of the review holds no spec: review-digest-unavailable", async () => {
      const report = await check(S, {
        reviews: [review("alice", "APPROVED", S.c1)],
      });
      expect(cond(report, 3)).toMatchObject({
        ok: false,
        code: "review-digest-unavailable",
      });
    });

    it("no digest exists at the head: digest-unavailable, even with an approval of the head", async () => {
      const s = await build();
      const head = await s.repo.commit(
        { [`${SPEC_REL}/testplan.yaml`]: "- id: [\n" },
        "broken plan",
      );
      const report = await check(
        { ...s, head },
        { reviews: [review("alice", "APPROVED", head)] },
      );
      expect(cond(report, 1).ok).toBe(true);
      expect(cond(report, 3)).toMatchObject({
        ok: false,
        code: "digest-unavailable",
      });
      expect(report.digest).toBeNull();
      expect(report.approved).toBe(false);
    });

    it("the digest is read from the head commit, not from the work tree", async () => {
      const s = await build();
      const clean = await check(s);
      edit(s.spec, "spec.md", "HTTP 401", "HTTP 403");
      const dirty = await check(s);
      expect(clean.digest).toMatch(/^sha256:/);
      expect(dirty.digest).toBe(clean.digest);
      expect(cond(dirty, 3).ok).toBe(true);
      expect(dirty.approved).toBe(false);
    });
  },
);

describe(
  "condition 4: proposed at the head, final lint clean",
  { timeout: 60_000 },
  () => {
    it("a draft at the head: status-not-proposed", async () => {
      const s = await build({ propose: false });
      const report = await check(s);
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "status-not-proposed",
      });
      expect(report.approved).toBe(false);
      expect(failing(report)).toEqual([4]);
    });

    it("the status is read from the head commit: a work tree that says proposed does not help", async () => {
      const s = await build({ propose: false });
      edit(s.spec, "spec.md", "status: draft", "status: proposed");
      const report = await check(s);
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "status-not-proposed",
      });
    });

    it("no spec.md at the head: spec-unreadable", async () => {
      const s = await build();
      const head = await s.repo.commit(
        { [`${SPEC_REL}/spec.md`]: null },
        "spec gone",
      );
      const report = await check(
        { ...s, head },
        { reviews: [review("alice", "APPROVED", head)] },
      );
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "spec-unreadable",
      });
      expect(report.spec).toBeNull();
      expect(report.approved).toBe(false);
    });

    it("the final lint has an error at the head: lint-errors, with the rule", async () => {
      const s = await build();
      // A binding changed without `bind`: the log no longer replays to it.
      const head = await s.repo.commit(
        {
          [`${SPEC_REL}/bindings.yaml`]:
            "TP-1:\n  status: existing\n  selector: other\nTP-2:\n  status: existing\n  selector: login works\n",
        },
        "binding by hand",
      );
      const report = await check(
        { ...s, head },
        { reviews: [review("alice", "APPROVED", head)] },
      );
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "lint-errors",
      });
      expect(cond(report, 4).message).toContain("bindings-log");
      expect(report.approved).toBe(false);
      expect(failing(report)).toEqual([4]);
    });

    it.each<[string, SpecChange]>([
      [
        "a spec.md edited after the checkout",
        (spec) => fs.appendFileSync(path.join(spec, "spec.md"), "\n"),
      ],
      [
        "an untracked acks.yaml",
        (spec) => fs.writeFileSync(path.join(spec, "acks.yaml"), "[]\n"),
      ],
    ])(
      "the spec directory of the work tree is not the head's, %s: worktree-not-head",
      async (_what, change) => {
        const s = await build();
        change(s.spec);
        const report = await check(s);
        expect(cond(report, 4)).toMatchObject({
          ok: false,
          code: "worktree-not-head",
        });
        expect(report.approved).toBe(false);
        expect(failing(report)).toEqual([4]);
      },
    );
  },
);

describe(
  "condition 7: nothing under .spec-gate/ changes",
  { timeout: 60_000 },
  () => {
    it.each([
      ["the settings", ".spec-gate/config.yaml", "approvers: [mallory]\n"],
      ["a new file", ".spec-gate/extra.yaml", "x: 1\n"],
    ])(
      "the pull request changes %s: spec-changes-config",
      async (_what, file, text) => {
        const s = await build();
        const head = await s.repo.commit({ [file]: text }, "change");
        const report = await check(
          { ...s, head },
          { reviews: [review("alice", "APPROVED", head)] },
        );
        expect(cond(report, 7)).toMatchObject({
          ok: false,
          code: "spec-changes-config",
        });
        expect(report.approved).toBe(false);
      },
    );

    it("a path that differs from .spec-gate only in case counts, as in the lint", async () => {
      const s = await build();
      const head = await s.repo.commitRaw(
        { ".Spec-Gate/commands.yaml": "commands: {}\n" },
        "other case",
      );
      const report = await check(
        { ...s, head },
        { reviews: [review("alice", "APPROVED", head)] },
      );
      expect(cond(report, 7)).toMatchObject({
        ok: false,
        code: "spec-changes-config",
      });
      expect(report.approved).toBe(false);
    });

    it("a change under .spec-gate/ on the default branch after the fork does not count", async () => {
      const s = await build();
      await s.repo.checkout("main");
      const c2 = await s.repo.commit(
        { ".spec-gate/extra.yaml": "x: 1\n" },
        "settings change on main",
      );
      await s.repo.setRef(REMOTE_MAIN, c2);
      await s.repo.checkout("pr");
      const report = await check(s);
      expect(cond(report, 7)).toMatchObject({ ok: true, code: "ok" });
      expect(report.reference).toBe(c2);
      expect(report.approved).toBe(true);
    });
  },
);

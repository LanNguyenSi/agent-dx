/**
 * The measuring base of propose: its final lint measures from the one merge
 * base of HEAD and the `--default-ref` commit. One row per case of the
 * claim (one merge base, several, none, a shallow repository, `--base`
 * given, `--base` without `--default-ref`); every refusal writes nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { proposeSpecDir } from "../../src/state/index.js";
import { REMOTE_MAIN, SPEC_REL, specFiles } from "../lint/git-helpers.js";
import {
  BASE_ALONE,
  BASE_OFF,
  NONE,
  SEVERAL,
  SHALLOW,
  noBase,
  oneBase,
  shallow,
  twoBases,
  type Files,
} from "../lint/measuring-helpers.js";
import { BIND_BINDINGS, BIND_PLAN, commitSpec, gitOf } from "./helpers.js";

const DRAFT: Files = (c1) => ({
  ...specFiles({ base: c1, ref: c1, plan: BIND_PLAN }),
  [`${SPEC_REL}/bindings.yaml`]: BIND_BINDINGS,
});

function specDirOf(dir: string): string {
  return path.join(dir, SPEC_REL);
}

/** Every file of the spec directory with its text. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, prefix: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(at, entry.name), rel);
      else out[rel] = fs.readFileSync(path.join(at, entry.name), "utf8");
    }
  };
  walk(specDirOf(dir), "");
  return out;
}

/** Proposes in `dir` and expects a refusal with `message` that wrote nothing. */
function refusedWith(
  dir: string,
  request: { defaultRef?: string; base?: string },
  message: string,
): void {
  const before = snapshot(dir);
  const result = proposeSpecDir(specDirOf(dir), { repo: dir, ...request });
  expect(result).toEqual({ kind: "refused", message: `propose: ${message}` });
  expect(snapshot(dir)).toEqual(before);
  expect(before["bindings.log"]).toBeUndefined();
}

describe("the measuring base of propose", { timeout: 60_000 }, () => {
  it("one merge base: the final lint measures from it and propose writes", async () => {
    const s = await oneBase(DRAFT);
    const result = proposeSpecDir(specDirOf(s.dir), gitOf(s.repo));
    expect(result.kind).toBe("written");
  });

  it("several merge bases: refused, nothing written", async () => {
    const s = await twoBases(DRAFT);
    refusedWith(s.dir, { defaultRef: REMOTE_MAIN }, SEVERAL);
    refusedWith(s.dir, { defaultRef: REMOTE_MAIN, base: s.c1 }, SEVERAL);
  });

  it("no merge base: refused, nothing written", async () => {
    const s = await noBase(DRAFT);
    refusedWith(s.dir, { defaultRef: REMOTE_MAIN }, NONE);
  });

  it("a shallow repository: refused, nothing written", async () => {
    const s = await shallow(DRAFT);
    refusedWith(s.dir, { defaultRef: REMOTE_MAIN }, SHALLOW);
  });

  it("--base older than a default commit the head merged: a merged bindings.log replaced through draft is a finding, whatever base is given", async () => {
    // The spec is proposed and merged into the default branch; a second
    // branch starts at the older base c1, merges the default branch, puts
    // the spec back to draft without its log and with other bindings, and
    // proposes again. Measured from c1 there is no merged log to compare
    // with; measured from the default branch the log was replaced.
    const s = await oneBase(DRAFT);
    const first = proposeSpecDir(specDirOf(s.dir), gitOf(s.repo));
    expect(first.kind).toBe("written");
    const proposed = await commitSpec(s.repo, "propose");
    await s.repo.checkout("main");
    await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge the spec", proposed);
    const newer = await s.repo.head();
    await s.repo.setRef(REMOTE_MAIN, newer);
    await s.repo.checkout("pr2", s.c1);
    await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge the default", newer);
    const file = path.join(specDirOf(s.dir), "spec.md");
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace(/^status: proposed$/m, "status: draft"),
    );
    await s.repo.commit(
      {
        [`${SPEC_REL}/bindings.log`]: null,
        [`${SPEC_REL}/bindings.yaml`]: BIND_BINDINGS.replace(
          "selector: login works",
          "selector: login still works",
        ),
      },
      "back to draft, without the log",
    );
    for (const request of [
      { defaultRef: REMOTE_MAIN, base: s.c1 },
      { defaultRef: REMOTE_MAIN },
    ]) {
      const before = snapshot(s.dir);
      const result = proposeSpecDir(specDirOf(s.dir), {
        repo: s.dir,
        ...request,
      });
      expect(result.kind, JSON.stringify(request)).toBe("findings");
      if (result.kind !== "findings") continue;
      expect(
        result.report.errors.filter((f) => f.rule === "bindings-log"),
      ).not.toEqual([]);
      expect(snapshot(s.dir)).toEqual(before);
    }
  });

  it("--base must lie on --default-ref: refused, nothing written", async () => {
    const s = await oneBase(DRAFT);
    await s.repo.checkout("side", s.c1);
    const side = await s.repo.commit({ "side.txt": "s\n" }, "side");
    await s.repo.checkout("pr");
    refusedWith(s.dir, { defaultRef: REMOTE_MAIN, base: side }, BASE_OFF);
  });

  it("--base without --default-ref: refused, nothing written", async () => {
    const s = await oneBase(DRAFT);
    refusedWith(s.dir, { base: s.c1 }, BASE_ALONE);
  });
});

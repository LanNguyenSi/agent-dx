import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeSpecDigest } from "../../src/canonical/index.js";
import { parseBindingsLog, sha256Tag } from "../../src/formats/index.js";
import { proposeSpecDir, withStatusProposed } from "../../src/state/index.js";
import { REMOTE_MAIN } from "../lint/git-helpers.js";
import { runCli } from "../lint/helpers.js";
import {
  BIND_BINDINGS,
  commitSpec,
  draftRepo,
  gitOf,
  readSpec,
  specExists,
  writeSpec,
} from "./helpers.js";

/** Every file of the spec directory, to prove that a refusal wrote nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (sub: string) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), {
      withFileTypes: true,
    })) {
      const rel = sub === "" ? entry.name : `${sub}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else out[rel] = fs.readFileSync(path.join(dir, rel), "utf8");
    }
  };
  walk("");
  return out;
}

describe("withStatusProposed", () => {
  it("changes the status line only and keeps its line ending", () => {
    const text = "---\nid: x\nstatus: draft\n---\n\nstatus: draft\n";
    expect(withStatusProposed(text)).toBe(
      "---\nid: x\nstatus: proposed\n---\n\nstatus: draft\n",
    );
    expect(withStatusProposed("---\r\nstatus: draft\r\n---\r\n")).toBe(
      "---\r\nstatus: proposed\r\n---\r\n",
    );
    expect(withStatusProposed("\uFEFF---\nstatus: draft\n---\n")).toBe(
      "\uFEFF---\nstatus: proposed\n---\n",
    );
  });

  it("gives up on a frontmatter without exactly one status line at column 0", () => {
    expect(withStatusProposed("---\nid: x\n---\n")).toBeNull();
    expect(withStatusProposed("---\n status: draft\n---\n")).toBeNull();
    expect(withStatusProposed("no frontmatter\n")).toBeNull();
    expect(withStatusProposed("---\nstatus: draft\n")).toBeNull();
  });
});

describe("spec-gate propose", { timeout: 60_000 }, () => {
  it("a clean final lint: sets status proposed alone, digest unchanged, and writes the propose entry for HEAD", async () => {
    const { repo, draft } = await draftRepo();
    const before = readSpec(repo, "spec.md");
    const digest = computeSpecDigest(repo.spec, { repo: repo.dir });
    const result = proposeSpecDir(repo.spec, gitOf(repo));
    expect(result).toEqual({
      kind: "written",
      spec: "tiny-valid",
      commit: draft,
    });
    const after = readSpec(repo, "spec.md");
    expect(after).toBe(before.replace(/^status: draft$/m, "status: proposed"));
    expect(computeSpecDigest(repo.spec, { repo: repo.dir })).toBe(digest);
    const log = readSpec(repo, "bindings.log");
    expect(log).toBe(
      `${JSON.stringify({ seq: 1, kind: "propose", commit: draft, bindings: sha256Tag(BIND_BINDINGS) })}\n`,
    );
    expect(parseBindingsLog(log).ok).toBe(true);
    // bindings.yaml itself is not touched
    expect(readSpec(repo, "bindings.yaml")).toBe(BIND_BINDINGS);
  });

  it("refuses without git inputs, and with --repo alone", async () => {
    const { repo } = await draftRepo();
    const before = snapshot(repo.spec);
    for (const request of [undefined, { repo: repo.dir }]) {
      const result = proposeSpecDir(repo.spec, request);
      expect(result.kind).toBe("refused");
      if (result.kind === "refused")
        expect(result.message).toMatch(/needs git inputs/);
    }
    expect(snapshot(repo.spec)).toEqual(before);
  });

  it("refuses a spec whose status is not draft", async () => {
    const { repo } = await draftRepo({
      "spec.md": readSpecTemplate().replace(
        "status: draft",
        "status: proposed",
      ),
    });
    const before = snapshot(repo.spec);
    const result = proposeSpecDir(repo.spec, gitOf(repo));
    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind === "refused")
      expect(result.message).toMatch(/the status is proposed/);
    expect(snapshot(repo.spec)).toEqual(before);
  });

  it("refuses when bindings.log exists, committed or not", async () => {
    const { repo } = await draftRepo();
    writeSpec(repo, "bindings.log", "anything\n");
    const before = snapshot(repo.spec);
    const result = proposeSpecDir(repo.spec, gitOf(repo));
    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind === "refused")
      expect(result.message).toMatch(/bindings\.log already exists/);
    expect(snapshot(repo.spec)).toEqual(before);
  });

  it("refuses when spec.md or bindings.yaml in the work tree differ from HEAD, or bindings.yaml is not committed", async () => {
    for (const [name, change] of [
      ["spec.md", (t: string) => `${t}\n`],
      ["bindings.yaml", (t: string) => t.replace("rejects", "refuses")],
    ] as const) {
      const { repo } = await draftRepo();
      writeSpec(repo, name, change(readSpec(repo, name)));
      const before = snapshot(repo.spec);
      const result = proposeSpecDir(repo.spec, gitOf(repo));
      expect(result, name).toMatchObject({ kind: "refused" });
      if (result.kind === "refused")
        expect(result.message).toContain(
          `${name} in the work tree differs from HEAD`,
        );
      expect(snapshot(repo.spec)).toEqual(before);
    }
    const { repo } = await draftRepo();
    await repo.sh("rm", "-q", "--cached", "specs/s1/bindings.yaml");
    await repo.sh("commit", "-q", "-m", "untrack bindings");
    const result = proposeSpecDir(repo.spec, gitOf(repo));
    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind === "refused")
      expect(result.message).toMatch(/bindings\.yaml is not committed at HEAD/);
  });

  it("a final lint with an error finding is the result and nothing is written", async () => {
    // A binding that the kind refuses at proposed: stays-green needs existing.
    const { repo } = await draftRepo({
      "bindings.yaml": BIND_BINDINGS.replace(
        "TP-2:\n  status: existing",
        "TP-2:\n  status: new",
      ),
    });
    const before = snapshot(repo.spec);
    const result = proposeSpecDir(repo.spec, gitOf(repo));
    expect(result.kind).toBe("findings");
    if (result.kind === "findings") {
      expect(result.report.mode).toBe("final");
      expect(result.report.errors.map((f) => f.rule)).toContain(
        "binding-status",
      );
    }
    expect(snapshot(repo.spec)).toEqual(before);
    expect(specExists(repo, "bindings.log")).toBe(false);
  });

  it("the CLI: exit 0 written, 1 with the final lint report on stdout, 2 on a refusal", async () => {
    const { repo, draft } = await draftRepo();
    const args = ["--repo", repo.dir, "--default-ref", REMOTE_MAIN];
    const none = await runCli(["propose", repo.spec]);
    expect(none.code).toBe(2);
    expect(none.stdout).toBe("");
    expect(none.stderr).toMatch(/^spec-gate: propose: needs git inputs/);

    const ok = await runCli(["propose", repo.spec, ...args]);
    expect(ok).toEqual({
      code: 0,
      stdout: `proposed tiny-valid at ${draft}\n`,
      stderr: "",
    });
    const again = await runCli(["propose", repo.spec, ...args]);
    expect(again.code).toBe(2);
    expect(again.stdout).toBe("");

    const bad = await draftRepo({
      "bindings.yaml": BIND_BINDINGS.replace(
        "TP-2:\n  status: existing",
        "TP-2:\n  status: new",
      ),
    });
    const findings = await runCli([
      "propose",
      bad.repo.spec,
      "--repo",
      bad.repo.dir,
      "--base",
      await bad.repo.sh("rev-parse", REMOTE_MAIN),
    ]);
    expect(findings.code).toBe(1);
    expect(findings.stderr).toBe("");
    const report = JSON.parse(findings.stdout) as {
      format: string;
      ok: boolean;
    };
    expect(report).toMatchObject({ format: "spec-gate-lint/1", ok: false });

    const usage = await runCli(["propose"]);
    expect(usage.code).toBe(2);
  });

  it("after propose and a commit, the lint with git inputs passes", async () => {
    const { repo } = await draftRepo();
    expect(proposeSpecDir(repo.spec, gitOf(repo)).kind).toBe("written");
    await commitSpec(repo, "propose");
    const run = await runCli([
      "lint",
      repo.spec,
      "--repo",
      repo.dir,
      "--default-ref",
      REMOTE_MAIN,
    ]);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "proposed",
      ok: true,
      errors: [],
    });
    expect(run.code).toBe(0);
  });
});

function readSpecTemplate(): string {
  return fs.readFileSync(
    new URL("../fixtures/lint-valid/pos/spec/spec.md", import.meta.url),
    "utf8",
  );
}

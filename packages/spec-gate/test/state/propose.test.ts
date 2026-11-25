import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeSpecDigest } from "../../src/canonical/index.js";
import { parseBindingsLog, sha256Tag } from "../../src/formats/index.js";
import { RULES, type RuleDef } from "../../src/lint/index.js";
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

  it("refuses a spec directory that is a symlink, and a spec.md or bindings.yaml that is not a regular file", async () => {
    const { repo } = await draftRepo();
    const link = path.join(repo.dir, "specs", "link");
    fs.symlinkSync("s1", link);
    const viaLink = proposeSpecDir(link, gitOf(repo));
    expect(viaLink).toMatchObject({ kind: "refused" });
    if (viaLink.kind === "refused")
      expect(viaLink.message).toMatch(/is a symlink/);
    fs.rmSync(link);
    for (const name of ["spec.md", "bindings.yaml"]) {
      const fresh = await draftRepo();
      const file = path.join(fresh.repo.spec, name);
      const text = fs.readFileSync(file, "utf8");
      fs.writeFileSync(path.join(fresh.repo.dir, "real"), text);
      fs.rmSync(file);
      fs.symlinkSync(path.join(fresh.repo.dir, "real"), file);
      const result = proposeSpecDir(fresh.repo.spec, gitOf(fresh.repo));
      expect(result, name).toMatchObject({ kind: "refused" });
      if (result.kind === "refused")
        expect(result.message).toContain(`${name} must be a regular file`);
      expect(specExists(fresh.repo, "bindings.log")).toBe(false);
    }
  });

  it("refuses a spec directory that is not specs/<name>, and writes nothing", async () => {
    for (const where of ["other/s1", "specs/group/s1", "s1top"]) {
      const { repo } = await draftRepo();
      const dir = path.join(repo.dir, where);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await repo.sh("mv", "specs/s1", where);
      await commitSpec(repo, "the draft elsewhere");
      const before = snapshot(dir);
      const result = proposeSpecDir(dir, gitOf(repo));
      expect(result, where).toMatchObject({ kind: "refused" });
      if (result.kind === "refused")
        expect(result.message, where).toContain("must be specs/<name>");
      expect(snapshot(dir), where).toEqual(before);

      const cli = await runCli([
        "propose",
        dir,
        "--repo",
        repo.dir,
        "--default-ref",
        REMOTE_MAIN,
      ]);
      expect(cli.code, where).toBe(2);
      expect(cli.stdout, where).toBe("");
      expect(cli.stderr, where).toMatch(
        /^spec-gate: propose: the spec directory must be specs\/<name>/,
      );
      expect(snapshot(dir), where).toEqual(before);
    }
  });

  it("refuses when HEAD moves while the final lint runs, and writes nothing", async () => {
    const { repo } = await draftRepo();
    const before = snapshot(repo.spec);
    const mover: RuleDef = {
      id: "head-mover",
      level: "warning",
      profiles: ["light", "full"],
      gated: false,
      ackable: true,
      summary: "moves HEAD",
      needs: [],
      check: () => {
        execFileSync(
          "git",
          [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "moved",
          ],
          {
            cwd: repo.dir,
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
          },
        );
        return [];
      },
    };
    const result = proposeSpecDir(repo.spec, gitOf(repo), [...RULES, mover]);
    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind === "refused")
      expect(result.message).toMatch(/HEAD moved while the lint ran/);
    expect(snapshot(repo.spec)).toEqual(before);
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

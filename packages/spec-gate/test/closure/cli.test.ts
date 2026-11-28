/**
 * `spec-gate closure` through the built CLI: the refusals (exit 2,
 * nothing on stdout), the report line and its field order, the exit
 * codes, and that a run writes nothing.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBounded } from "../canonical/helpers.js";
import { REMOTE_MAIN, SPEC_REL } from "../lint/git-helpers.js";
import { COMMANDS, scenario, writeEvidence, type Scenario } from "./helpers.js";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function cli(args: string[]): Promise<CliRun> {
  const run = await runBounded(process.execPath, [cliPath, ...args], {
    timeoutMs: 30_000,
  });
  if (run.timedOut) throw new Error("the CLI did not finish in time");
  return { code: run.code, stdout: run.stdout, stderr: run.stderr };
}

function argsOf(
  s: Scenario,
  options: { start?: string; head?: string; defaultRef?: string } = {},
): string[] {
  return [
    "closure",
    s.repo.spec,
    "--repo",
    s.repo.dir,
    "--default-ref",
    options.defaultRef ?? REMOTE_MAIN,
    "--start",
    options.start ?? s.spec,
    ...(options.head !== undefined ? ["--head", options.head] : []),
  ];
}

/** Asserts a refusal: exit 2, nothing on stdout, one stderr line naming `code`. */
async function refused(args: string[], code: string): Promise<void> {
  const run = await cli(args);
  expect(run.stdout).toBe("");
  expect(run.code).toBe(2);
  expect(run.stderr).toMatch(
    new RegExp(`^spec-gate: closure: ${code}: [^\\n]+\\n$`),
  );
}

function specFile(s: Scenario, name: string): string {
  return path.join(s.repo.spec, name);
}

describe("spec-gate closure: refusals", { timeout: 60_000 }, () => {
  it("refuses a spec.md that does not load", async () => {
    const s = await scenario();
    fs.writeFileSync(specFile(s, "spec.md"), "no frontmatter\n");
    await refused(argsOf(s), "[a-z-]+");
  });

  it("refuses a testplan.yaml that does not load", async () => {
    const s = await scenario();
    fs.writeFileSync(specFile(s, "testplan.yaml"), "- id: TP-1\n");
    await refused(argsOf(s), "[a-z-]+");
  });

  it("refuses a missing bindings.yaml", async () => {
    const s = await scenario();
    fs.rmSync(specFile(s, "bindings.yaml"));
    await refused(argsOf(s), "input-missing");
  });

  it("refuses an evidence file that does not parse", async () => {
    const s = await scenario();
    fs.mkdirSync(specFile(s, "evidence"));
    fs.writeFileSync(specFile(s, "evidence/TP-2.jsonl"), "{not json\n");
    await refused(argsOf(s), "[a-z-]+");
  });

  it("refuses a --start that is not a full commit id", async () => {
    const s = await scenario();
    await refused(argsOf(s, { start: s.spec.slice(0, 12) }), "start-invalid");
  });

  it("refuses a --start that is not in the repository", async () => {
    const s = await scenario();
    await refused(argsOf(s, { start: "b".repeat(40) }), "start-not-a-commit");
  });

  it("refuses a --head that is not a full commit id", async () => {
    const s = await scenario();
    await refused(argsOf(s, { head: "HEAD" }), "head-invalid");
  });

  it("refuses a --head that is not in the repository", async () => {
    const s = await scenario();
    await refused(argsOf(s, { head: "c".repeat(40) }), "head-not-a-commit");
  });

  it("refuses a --start before the merged spec commit", async () => {
    const s = await scenario();
    await refused(argsOf(s, { start: s.c1 }), "start-before-spec");
  });

  it("refuses a --start that is not on --default-ref", async () => {
    const s = await scenario();
    await refused(argsOf(s, { start: s.a }), "start-not-on-default");
  });

  it("refuses a --head that is not a descendant of --start", async () => {
    const s = await scenario();
    await refused(argsOf(s, { head: s.c1 }), "head-before-start");
  });

  it("refuses when no commit on --default-ref changed the spec", async () => {
    const s = await scenario();
    await s.repo.setRef(REMOTE_MAIN, s.c1);
    await refused(argsOf(s, { start: s.c1 }), "spec-not-merged");
  });

  it("refuses when the merged spec is not proposed", async () => {
    const s = await scenario({ status: "draft" });
    await refused(argsOf(s), "spec-not-proposed");
  });

  it("refuses a commands_ref that is not on --default-ref", async () => {
    const s = await scenario();
    const text = fs
      .readFileSync(specFile(s, "spec.md"), "utf8")
      .replace(/^commands_ref: .*$/m, `commands_ref: ${s.a}`);
    fs.writeFileSync(specFile(s, "spec.md"), text);
    await refused(argsOf(s), "commands-ref-untrusted");
  });

  it("refuses a command set missing at commands_ref", async () => {
    const s = await scenario();
    const text = fs
      .readFileSync(specFile(s, "spec.md"), "utf8")
      .replace(/^commands_ref: .*$/m, `commands_ref: ${s.c0}`);
    fs.writeFileSync(specFile(s, "spec.md"), text);
    await refused(argsOf(s), "commands-file-missing");
  });

  it("refuses a command set that does not parse at commands_ref", async () => {
    const s = await scenario();
    await s.repo.checkout("main");
    const bad = await s.repo.commit(
      { ".spec-gate/commands.yaml": "commands: [\n" },
      "broken commands",
    );
    const fixed = await s.repo.commit(
      { ".spec-gate/commands.yaml": COMMANDS },
      "fixed commands",
    );
    await s.repo.setRef(REMOTE_MAIN, fixed);
    const text = fs
      .readFileSync(specFile(s, "spec.md"), "utf8")
      .replace(/^commands_ref: .*$/m, `commands_ref: ${bad}`);
    fs.writeFileSync(specFile(s, "spec.md"), text);
    await refused(argsOf(s, { head: fixed }), "commands-file-invalid");
  });

  it("exits 2 without --start (a usage error)", async () => {
    const s = await scenario();
    const run = await cli(argsOf(s).slice(0, -2));
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
  });
});

function golden(s: Scenario, line: string): string {
  return line
    .split(s.spec)
    .join("<spec>")
    .split(s.a)
    .join("<a>")
    .split(s.b)
    .join("<b>");
}

describe("spec-gate closure: report and exit", { timeout: 60_000 }, () => {
  it("prints one JSON line in a fixed field order (golden) and exits 1 with an unproven row", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-1", [
      { commit: s.a, result: "fail" },
      { commit: s.b },
    ]);
    writeEvidence(s.repo, "TP-2", [
      { commit: s.spec, producer: "local" },
      { commit: s.b, dirty: true },
    ]);
    const run = await cli(argsOf(s));
    expect(run.code).toBe(1);
    expect(run.stderr).toBe("");
    expect(run.stdout.endsWith("\n")).toBe(true);
    expect(run.stdout.split("\n")).toHaveLength(2);
    expect(golden(s, run.stdout)).toBe(
      '{"format":"spec-gate-closure/1","spec":"tiny-valid","start":"<spec>","head":"<b>","spec_commit":"<spec>","ok":false,"rows":[' +
        '{"id":"TP-1","kind":"red-first","state":"proven","reason":"red-then-green","self_reported":false,"ci_unverified":false,"counted":2,"ignored":[],"red_reason":"not-checked"},' +
        '{"id":"TP-2","kind":"stays-green","state":"proven","reason":"pass-at-start-and-latest-pass","self_reported":true,"ci_unverified":false,"counted":1,"ignored":[{"line":2,"reason":"dirty"}],"probe":"not-checked"},' +
        '{"id":"TP-3","kind":"static","state":"unproven","reason":"no-evidence-file","self_reported":false,"ci_unverified":false,"counted":0,"ignored":[]},' +
        '{"id":"TP-4","kind":"measurement","state":"not-decidable","reason":"kind-needs-review","self_reported":false,"ci_unverified":false,"counted":0,"ignored":[],"evidence_location":null},' +
        '{"id":"TP-5","kind":"manual","state":"not-decidable","reason":"kind-needs-review","self_reported":false,"ci_unverified":false,"counted":0,"ignored":[],"evidence_location":"review/reset-mail.png"},' +
        '{"id":"TP-6","kind":"runtime","state":"not-decidable","reason":"kind-needs-review","self_reported":false,"ci_unverified":false,"counted":0,"ignored":[],"evidence_location":"review/runtime.md"},' +
        '{"id":"TP-7","kind":"post-deploy","state":"pending-post-deploy","reason":"post-deploy","self_reported":false,"ci_unverified":false,"counted":0,"ignored":[]}' +
        '],"counts":{"proven":2,"failed":0,"unproven":1,"not-decidable":3,"pending-post-deploy":1},"unknown_rows":[]}\n',
    );
  });

  it("exits 0 when every row is proven, not-decidable or pending", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-1", [
      { commit: s.a, result: "fail" },
      { commit: s.b },
    ]);
    writeEvidence(s.repo, "TP-2", [{ commit: s.spec }]);
    writeEvidence(s.repo, "TP-3", [{ commit: s.b }]);
    const run = await cli(argsOf(s));
    expect(run.code).toBe(0);
    const report = JSON.parse(run.stdout) as {
      ok: boolean;
      counts: Record<string, number>;
    };
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({
      proven: 3,
      failed: 0,
      unproven: 0,
      "not-decidable": 3,
      "pending-post-deploy": 1,
    });
  });

  it("exits 1 with a failed row", async () => {
    const s = await scenario({
      plan:
        "- id: TP-2\n  covers: [AC-1]\n  kind: stays-green\n" +
        '  claim: "login keeps working"\n  probe_hint: "break the login handler"\n',
    });
    writeEvidence(s.repo, "TP-2", [
      { commit: s.spec },
      { commit: s.b, result: "fail" },
    ]);
    const run = await cli(argsOf(s));
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).counts.failed).toBe(1);
  });

  it("exits 0 for a plan of review-decided and post-deploy rows only", async () => {
    const plan =
      "- id: TP-5\n  covers: [AC-1]\n  kind: manual\n" +
      '  claim: "the reset mail reads well"\n  verifier: "support lead"\n  evidence_location: "review/reset-mail.png"\n' +
      "- id: TP-7\n  covers: [AC-1]\n  kind: post-deploy\n" +
      '  claim: "no 5xx after deploy"\n  check: "error rate for 30 minutes"\n  environment: "production"\n';
    const s = await scenario({ plan, bindings: "{}\n" });
    const run = await cli(argsOf(s));
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).ok).toBe(true);
  });

  it("uses the checkout's HEAD when --head is not given", async () => {
    const s = await scenario();
    const run = await cli(argsOf(s));
    expect(JSON.parse(run.stdout).head).toBe(s.b);
  });
});

function treeState(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      const rel = path.relative(dir, full);
      if (st.isDirectory()) {
        out.push(`${rel}/ ${st.mtimeMs}`);
        walk(full);
      } else {
        const hash = createHash("sha256")
          .update(fs.readFileSync(full))
          .digest("hex");
        out.push(`${rel} ${st.size} ${st.mtimeMs} ${hash}`);
      }
    }
  };
  walk(dir);
  return out.join("\n");
}

describe("spec-gate closure: read-only", { timeout: 60_000 }, () => {
  it("leaves the work tree, the index and the git directory unchanged", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-2", [{ commit: s.spec }]);
    const before = treeState(s.repo.dir);
    const run = await cli(argsOf(s));
    expect(run.code).toBe(1);
    expect(treeState(s.repo.dir)).toBe(before);
    expect(await s.repo.sh("status", "--porcelain")).toBe(
      `?? ${SPEC_REL}/evidence/`,
    );
  });

  it("starts git only through the hardened runner and makes no request", () => {
    const dir = fileURLToPath(new URL("../../src/closure/", import.meta.url));
    for (const name of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      expect(text, name).not.toMatch(
        /child_process|fetch\(|node:https?|node:net/,
      );
      expect(text, name).not.toMatch(
        /writeFile|mkdir|rmSync|renameSync|appendFile/,
      );
    }
  });
});

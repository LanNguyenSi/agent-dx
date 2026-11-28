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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBounded } from "../canonical/helpers.js";
import { Stub } from "../host/stub.js";
import { REMOTE_MAIN, SPEC_REL } from "../lint/git-helpers.js";
import {
  COMMANDS,
  scenario,
  writeEvidence,
  type EnvelopeFields,
  type Scenario,
} from "./helpers.js";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function cli(
  args: string[],
  env?: NodeJS.ProcessEnv,
  options: { cwd?: string } = {},
): Promise<CliRun> {
  const run = await runBounded(process.execPath, [cliPath, ...args], {
    timeoutMs: 30_000,
    ...(env !== undefined ? { env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
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
  it("refuses a spec.md at the merged spec commit that is not a valid spec", async () => {
    const s = await scenario({ spec: "no frontmatter\n" });
    await refused(argsOf(s), "spec-invalid");
  });

  it("refuses a testplan.yaml at the merged spec commit that does not parse", async () => {
    const s = await scenario({ plan: "- id: TP-1\n" });
    await refused(argsOf(s), "testplan-invalid");
  });

  it("refuses a bindings.yaml that does not parse", async () => {
    const s = await scenario();
    fs.writeFileSync(specFile(s, "bindings.yaml"), "TP-1: [\n");
    await refused(argsOf(s), "invalid-yaml");
  });

  it("refuses a bindings.yaml that is not valid", async () => {
    const s = await scenario();
    fs.writeFileSync(specFile(s, "bindings.yaml"), "TP-1:\n  status: bogus\n");
    await refused(argsOf(s), "invalid-value");
  });

  it("refuses an evidence file that does not parse", async () => {
    const s = await scenario();
    fs.mkdirSync(specFile(s, "evidence"));
    fs.writeFileSync(specFile(s, "evidence/TP-2.jsonl"), "{not json\n");
    await refused(argsOf(s), "invalid-json");
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
    const s = await scenario({
      commandsRef: async ({ repo, c1 }) => {
        await repo.checkout("side", c1);
        return repo.commit({ "side.txt": "x\n" }, "side");
      },
    });
    await refused(argsOf(s), "commands-ref-untrusted");
  });

  it("refuses a command set missing at commands_ref", async () => {
    const s = await scenario({ commandsRef: async ({ c0 }) => c0 });
    await refused(argsOf(s), "commands-file-missing");
  });

  it("refuses a command set that does not parse at commands_ref", async () => {
    const s = await scenario({
      commandsRef: async ({ repo }) => {
        const bad = await repo.commit(
          { ".spec-gate/commands.yaml": "commands: [\n" },
          "broken commands",
        );
        await repo.commit(
          { ".spec-gate/commands.yaml": COMMANDS },
          "fixed commands",
        );
        return bad;
      },
    });
    await refused(argsOf(s), "commands-file-invalid");
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

  const STAYS_GREEN_ONLY =
    "- id: TP-2\n  covers: [AC-1]\n  kind: stays-green\n" +
    '  claim: "login keeps working"\n  probe_hint: "break the login handler"\n';

  /** Merges a side branch cut from the start into the head; its commit. */
  async function mergedSide(s: Scenario): Promise<string> {
    await s.repo.checkout("side", s.spec);
    const side = await s.repo.commit({ "side.txt": "x\n" }, "side");
    await s.repo.checkout("work");
    await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge side", "side");
    return side;
  }

  const lastOf: [string, EnvelopeFields][] = [
    ["a failed row", { commit: "", result: "fail" }],
    ["an unproven row", { commit: "", result: "skip", command: [] }],
  ];
  for (const [title, last] of lastOf) {
    it(`keeps exit 1 for ${title} when an envelope on a merged side branch is added`, async () => {
      const s = await scenario({ plan: STAYS_GREEN_ONLY });
      const side = await mergedSide(s);
      const own: EnvelopeFields[] = [
        { commit: s.spec },
        { ...last, commit: s.b },
      ];
      writeEvidence(s.repo, "TP-2", own);
      const control = await cli(argsOf(s));
      expect(control.code).toBe(1);
      writeEvidence(s.repo, "TP-2", [
        ...own,
        { commit: side, result: "skip", command: [], producer: "local" },
      ]);
      const attack = await cli(argsOf(s));
      expect(attack.code).toBe(1);
      const report = JSON.parse(attack.stdout) as {
        ok: boolean;
        rows: { state: string; reason: string }[];
      };
      expect(report.ok).toBe(false);
      expect(report.rows[0]).toMatchObject({
        state: "unproven",
        reason: "unordered-evidence",
      });
    });
  }

  it("exits 0 for a plan of review-decided and post-deploy rows only", async () => {
    const plan =
      "- id: TP-5\n  covers: [AC-1]\n  kind: manual\n" +
      '  claim: "the reset mail reads well"\n  verifier: "support lead"\n  evidence_location: "review/reset-mail.png"\n' +
      "- id: TP-7\n  covers: [AC-1]\n  kind: post-deploy\n" +
      '  claim: "no 5xx after deploy"\n  check: "error rate for 30 minutes"\n  environment: "production"\n';
    const s = await scenario({ plan, bindings: "{}\n" });
    fs.rmSync(specFile(s, "bindings.yaml"));
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

  it("starts git only through the hardened runner and asks for nothing itself: the only host the code calls is the adapter imported from src/host", () => {
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

const HOST_TOKEN = "closure-cli-token-4a7c1e93";
const RUN_CLI = "8123456789";

describe("spec-gate closure: the host flags", { timeout: 60_000 }, () => {
  let stub: Stub;

  beforeAll(async () => {
    stub = await Stub.start();
  });
  afterAll(async () => {
    await stub.close();
  });

  it("refuses an unknown option (a token given by mistake) without printing its value", async () => {
    const s = await scenario();
    const run = await cli([...argsOf(s), "--token=oops-cli-secret-58"]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(
      /^spec-gate: closure: unknown-argument: [^\n]+\n$/,
    );
    expect(run.stderr).not.toContain("oops-cli-secret-58");
  });

  it("takes --help for an unknown option and refuses it; the program's help still lists the verb", async () => {
    const s = await scenario();
    const run = await cli([...argsOf(s), "--help"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("closure: unknown-argument");
    const help = await cli(["help", "closure"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--github-repo <owner/name>");
    expect(help.stdout).toContain("--api-url <url>");
  });

  it("refuses --github-repo without GITHUB_TOKEN, naming the variable", async () => {
    const s = await scenario();
    const run = await cli([...argsOf(s), "--github-repo", "acme/widgets"], {
      ...process.env,
      GITHUB_TOKEN: "",
    });
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(
      /^spec-gate: closure: token-missing: [^\n]+GITHUB_TOKEN[^\n]*\n$/,
    );
  });

  it("refuses --api-url without --github-repo without echoing its value", async () => {
    const s = await scenario();
    const run = await cli([
      ...argsOf(s),
      "--api-url",
      "https://api.invalid/secret-root",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("closure: host-input-invalid");
    expect(run.stderr).not.toContain("secret-root");
  });

  it("with --github-repo and a reachable host: the line gains host and ci_status verified", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-2", [
      { commit: s.a, producer: "ci", ci_run: RUN_CLI },
    ]);
    stub.on(`/repos/acme/widgets/actions/runs/${RUN_CLI}`, {
      json: {
        id: Number(RUN_CLI),
        head_sha: s.a,
        status: "completed",
        conclusion: "success",
        repository: { full_name: "acme/widgets" },
      },
    });
    const run = await cli(
      [...argsOf(s), "--github-repo", "acme/widgets", "--api-url", stub.url],
      { ...process.env, GITHUB_TOKEN: HOST_TOKEN },
    );
    expect(run.code).toBe(1); // TP-1 has no evidence at all
    expect(run.stdout).not.toContain(HOST_TOKEN);
    const report = JSON.parse(run.stdout) as {
      host?: { repo: string; api_url: string | null };
      rows: { id: string; ci_status?: string; ci_unverified?: boolean }[];
    };
    expect(report.host).toEqual({ repo: "acme/widgets", api_url: stub.url });
    const row = report.rows.find((r) => r.id === "TP-2")!;
    expect(row.ci_status).toBe("verified");
    expect(row.ci_unverified).toBe(false);
    expect(
      stub.hitsOf(`/repos/acme/widgets/actions/runs/${RUN_CLI}`),
    ).toHaveLength(1);
  });

  it("with --github-repo and an unreachable host: host-failed, the report still printed, exit unchanged by the failure", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-2", [
      { commit: s.a, producer: "ci", ci_run: RUN_CLI },
    ]);
    const run = await cli(
      [
        ...argsOf(s),
        "--github-repo",
        "acme/widgets",
        "--api-url",
        "http://127.0.0.1:1",
      ],
      { ...process.env, GITHUB_TOKEN: HOST_TOKEN },
    );
    expect(run.code).toBe(1); // the same code the offline run gives
    const offline = await cli(argsOf(s));
    expect(offline.code).toBe(1);
    const report = JSON.parse(run.stdout) as {
      rows: { id: string; ci_status?: string }[];
    };
    const row = report.rows.find((r) => r.id === "TP-2")!;
    expect(row.ci_status).toBe("host-failed");
  });

  it("makes no request without --github-repo even with GITHUB_TOKEN set", async () => {
    const s = await scenario();
    writeEvidence(s.repo, "TP-2", [
      { commit: s.a, producer: "ci", ci_run: RUN_CLI },
    ]);
    const before = stub.hits.length;
    const run = await cli(argsOf(s), {
      ...process.env,
      GITHUB_TOKEN: HOST_TOKEN,
    });
    expect(stub.hits).toHaveLength(before);
    expect(run.stdout).not.toContain('"host"');
    expect(run.stdout).not.toContain("ci_status");
  });
});

const LEAK = "closure-leak-7b41d2";

describe(
  "spec-gate closure: a <spec-dir> that starts with a dash is an unknown argument",
  { timeout: 60_000 },
  () => {
    /** The verb's options with the <spec-dir> slot filled by `token`. */
    function withToken(s: Scenario, token: string, first: boolean): string[] {
      const tail = [
        "--repo",
        s.repo.dir,
        "--default-ref",
        REMOTE_MAIN,
        "--start",
        s.spec,
      ];
      return first
        ? ["closure", token, ...tail]
        : ["closure", ...tail, "--", token];
    }

    /** A token put where the <spec-dir> belongs is refused, never echoed. */
    async function refusedUnechoed(args: string[]): Promise<void> {
      const run = await cli(args);
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(
        /^spec-gate: closure: unknown-argument: [^\n]+\n$/,
      );
      expect(run.stderr).not.toContain(LEAK);
      expect(run.stdout).not.toContain(LEAK);
    }

    it("refuses --token=<v> given in the <spec-dir> slot", async () => {
      const s = await scenario();
      await refusedUnechoed(withToken(s, `--token=${LEAK}`, true));
    });

    it("refuses -t<v> given in the <spec-dir> slot", async () => {
      const s = await scenario();
      await refusedUnechoed(withToken(s, `-t${LEAK}`, true));
    });

    it("refuses -- --token=<v> given in the <spec-dir> slot", async () => {
      const s = await scenario();
      await refusedUnechoed(withToken(s, `--token=${LEAK}`, false));
    });

    it("takes a real directory named ./-x as the <spec-dir>, not as an unknown argument", async () => {
      const s = await scenario();
      fs.mkdirSync(path.join(s.repo.dir, "-x"));
      // The same real directory: the dash-prefixed token is the unknown
      // argument, the `./`-prefixed one is the directory.
      const asDash = await cli(
        [
          "closure",
          "-x",
          "--repo",
          s.repo.dir,
          "--default-ref",
          REMOTE_MAIN,
          "--start",
          s.spec,
        ],
        undefined,
        { cwd: s.repo.dir },
      );
      expect(asDash.code).toBe(2);
      expect(asDash.stderr).toContain("closure: unknown-argument");
      const asDir = await cli(
        [
          "closure",
          "./-x",
          "--repo",
          s.repo.dir,
          "--default-ref",
          REMOTE_MAIN,
          "--start",
          s.spec,
        ],
        undefined,
        { cwd: s.repo.dir },
      );
      expect(asDir.code).toBe(2);
      expect(asDir.stderr).toContain("closure: spec-dir-invalid");
      expect(asDir.stderr).not.toContain("unknown-argument");
    });
  },
);

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withoutRepoSelectionEnv } from "../src/git-env.js";
import {
  checkEvidenceOptions,
  commandsDigest,
  evidenceResult,
  parseDiscoveryText,
} from "../src/verify/evidence.js";
import type { EvidenceEnvelope } from "../src/verify/evidence.js";
import { verify, VerifyUsageError } from "../src/verify/index.js";
import type { ExecLike, VerifyOptions } from "../src/verify/types.js";
import type { ExecResult } from "../src/exec.js";
import { parseArgvOption, parseSelectorOption } from "../src/cli.js";
import { shellQuoteArgv } from "../src/verify/evidence.js";
import { spawnCli } from "./helpers/spawn-cli.js";
import { validate } from "./helpers/json-schema-lite.js";

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(PKG_ROOT, "schemas", "evidence-envelope.json");
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as Record<
  string,
  unknown
>;

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-evidence-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env: withoutRepoSelectionEnv(), encoding: "utf8" },
  ).trim();
}

/** A fresh git repository with one commit. */
function makeRepo(scripts: Record<string, string> = {}): string {
  const cwd = makeTmpDir();
  git(cwd, "init", "-q");
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", scripts }),
  );
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "init");
  return cwd;
}

interface Call {
  cmd: string;
  argv: string[] | undefined;
}

/** Never spawns: records what verify asked it to execute and returns a
 * canned result per command label. */
function makeStubExec(
  responses: Record<string, Partial<ExecResult>> = {},
  onCall?: (call: Call) => void,
): { fn: ExecLike; calls: Call[] } {
  const calls: Call[] = [];
  const fn: ExecLike = async (cmd, options) => {
    const call = { cmd, argv: options.argv };
    calls.push(call);
    onCall?.(call);
    const r = responses[cmd] ?? {};
    return {
      exitCode: r.exitCode ?? 0,
      durationMs: 1,
      stdoutTail: r.stdoutTail ?? "",
      stderrTail: r.stderrTail ?? "",
      logPath: path.join(options.logDir, "stub.log"),
      timedOut: r.timedOut ?? false,
      aborted: false,
      logWriteFailed: false,
      outputMayBeIncomplete: false,
      stdioClosed: true,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  };
  return { fn, calls };
}

const EVIDENCE = { phase: "baseline", producer: "local" } as const;

async function refusal(
  options: VerifyOptions,
): Promise<{ reason: string; message: string }> {
  try {
    await verify(options);
  } catch (err) {
    expect(err).toBeInstanceOf(VerifyUsageError);
    const e = err as VerifyUsageError;
    return { reason: e.reason, message: e.message };
  }
  throw new Error("expected a VerifyUsageError");
}

const VALID: EvidenceEnvelope = {
  schema_version: 1,
  phase: "baseline",
  producer: "local",
  time: "2026-01-02T03:04:05.678Z",
  commit: "a".repeat(40),
  dirty: false,
  commands_digest: "b".repeat(64),
  selector: null,
  command: ["sh", "-c", "exit 0"],
  exit: 0,
  result: "pass",
};

describe("evidence schema: shipped file and export", () => {
  it("is reachable as a package export and listed in the published files", () => {
    const require = createRequire(import.meta.url);
    const resolved =
      require.resolve("agent-primitives/schemas/evidence-envelope.json");
    expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(SCHEMA_PATH));
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"),
    ) as { files: string[]; exports: Record<string, string> };
    expect(pkg.files).toContain("schemas");
    expect(pkg.exports["./schemas/evidence-envelope.json"]).toBe(
      "./schemas/evidence-envelope.json",
    );
  });

  it("is a draft 2020-12 schema that forbids additional properties", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
  });

  it("accepts a well-formed envelope", () => {
    expect(validate(schema, VALID)).toEqual([]);
  });

  it("accepts each phase, producer and result value and a null exit and selector", () => {
    for (const phase of ["baseline", "closure"]) {
      expect(validate(schema, { ...VALID, phase })).toEqual([]);
    }
    for (const result of ["pass", "fail", "error"]) {
      expect(validate(schema, { ...VALID, result })).toEqual([]);
    }
    expect(validate(schema, { ...VALID, exit: null })).toEqual([]);
    expect(validate(schema, { ...VALID, selector: "alpha" })).toEqual([]);
    expect(validate(schema, { ...VALID, producer: "host" })).toEqual([]);
  });

  it("producer ci without ci_run is invalid; with ci_run it is valid", () => {
    expect(validate(schema, { ...VALID, producer: "ci" }).join("\n")).toContain(
      'missing required property "ci_run"',
    );
    expect(
      validate(schema, {
        ...VALID,
        producer: "ci",
        ci_run: "https://ci.example.invalid/runs/12",
      }),
    ).toEqual([]);
    expect(
      validate(schema, { ...VALID, producer: "ci", ci_run: "" }),
    ).not.toEqual([]);
  });

  it("ci_run is invalid for any producer other than ci", () => {
    for (const producer of ["local", "host"]) {
      expect(
        validate(schema, { ...VALID, producer, ci_run: "123" }),
      ).not.toEqual([]);
    }
  });

  it("rejects an unknown property, a missing field and wrong values", () => {
    expect(validate(schema, { ...VALID, extra: 1 })).not.toEqual([]);
    for (const key of Object.keys(VALID)) {
      const copy: Record<string, unknown> = { ...VALID };
      delete copy[key];
      expect(validate(schema, copy), `missing ${key}`).not.toEqual([]);
    }
    const bad: Array<Partial<Record<keyof EvidenceEnvelope, unknown>>> = [
      { schema_version: 2 },
      { phase: "other" },
      { producer: "cloud" },
      { result: "skipped" },
      { result: "passed" },
      { commit: "abc123" },
      { commit: "A".repeat(40) },
      { dirty: "false" },
      { commands_digest: "b".repeat(63) },
      { time: "2026-01-02 03:04:05" },
      { time: "2026-01-02T03:04:05+01:00" },
      { exit: "0" },
      { exit: 1.5 },
      { selector: 3 },
      { command: "sh -c true" },
      { command: [1] },
    ];
    for (const override of bad) {
      expect(
        validate(schema, { ...VALID, ...override }),
        JSON.stringify(override),
      ).not.toEqual([]);
    }
  });

  it("an empty command is valid only for a skip", () => {
    expect(validate(schema, { ...VALID, command: [] })).not.toEqual([]);
    expect(
      validate(schema, { ...VALID, command: [], result: "skip", exit: null }),
    ).toEqual([]);
  });

  it("the checker refuses a keyword it does not implement", () => {
    expect(() => validate({ minimum: 1 }, 3)).toThrow(/does not implement/);
  });
});

describe("evidence: result mapping and digest", () => {
  it("maps skipped to skip, never to pass", () => {
    expect(evidenceResult("skipped")).toBe("skip");
    expect(evidenceResult("pass")).toBe("pass");
    expect(evidenceResult("fail")).toBe("fail");
    expect(evidenceResult("error")).toBe("error");
  });

  it("commandsDigest is the SHA-256 of the unspaced JSON of the argv lists", () => {
    expect(commandsDigest([["sh", "-c", "exit 0"]])).toBe(
      "e1b5f9b3ba0f90595a9693bbe677e967def5c4bce98ea71f24fbff7bb7a7e649",
    );
    expect(
      commandsDigest([
        ["sh", "-c", "exit 0"],
        ["node", "-e", "1", "{selector}"],
      ]),
    ).toBe("e83e0657e8dc137b65a9f491e1ddca5fcfb255953ad5b35a5eed2b7d3bc2b9c3");
  });

  it("parseDiscoveryText splits on newline only and drops empty and NUL lines", () => {
    expect(parseDiscoveryText("a\nb c\n\nd\r\ne\u0000f\n")).toEqual([
      "a",
      "b c",
      "d\r",
    ]);
  });

  it("checkEvidenceOptions: ci needs a run reference, other producers refuse one", () => {
    const ok = (o: Parameters<typeof checkEvidenceOptions>[0]) =>
      checkEvidenceOptions(o)?.reason;
    expect(ok({ phase: "baseline", producer: "local" })).toBeUndefined();
    expect(ok({ phase: "closure", producer: "host" })).toBeUndefined();
    expect(
      ok({ phase: "baseline", producer: "ci", ciRun: "run-1" }),
    ).toBeUndefined();
    expect(ok({ phase: "baseline", producer: "ci" })).toBe(
      "evidence_ci_run_required",
    );
    expect(ok({ phase: "baseline", producer: "ci", ciRun: "" })).toBe(
      "evidence_ci_run_required",
    );
    expect(ok({ phase: "baseline", producer: "local", ciRun: "run-1" })).toBe(
      "evidence_ci_run_not_ci",
    );
    expect(ok({ phase: "baseline", producer: "host", ciRun: "run-1" })).toBe(
      "evidence_ci_run_not_ci",
    );
    expect(ok({ phase: "baseline", producer: "ci", ciRun: "a\nb" })).toBe(
      "evidence_ci_run_invalid",
    );
    expect(ok({ phase: "weekly" as "baseline", producer: "local" })).toBe(
      "evidence_phase_invalid",
    );
    expect(ok({ phase: "baseline", producer: "cloud" as "local" })).toBe(
      "evidence_producer_invalid",
    );
  });
});

describe("verify evidence: emission", () => {
  it("emits one schema-valid envelope per resolved check, skipped ones as skip", async () => {
    const cwd = makeRepo({ lint: "true" });
    const { fn } = makeStubExec({
      "exit 3": { exitCode: 3 },
      "exit 127": { exitCode: 127 },
    });
    const result = await verify({
      cwd,
      logDir: makeTmpDir(),
      checks: ["lint", "ok", "bad", "missing", "tool", "argvcheck"],
      overrides: { ok: "exit 0", bad: "exit 3", tool: "exit 127" },
      argvChecks: { argvcheck: ["node", "-e", "1", "{selector}"] },
      selectors: { argvcheck: "alpha" },
      discovery: { argvcheck: ["alpha"] },
      execFn: fn,
      evidence: { ...EVIDENCE },
    });
    const envelopes = result.evidence ?? [];
    expect(envelopes.map((e) => e.result)).toEqual([
      "pass",
      "pass",
      "fail",
      "skip",
      "error",
      "pass",
    ]);
    for (const envelope of envelopes) {
      expect(validate(schema, envelope)).toEqual([]);
    }
    const skipped = envelopes[3];
    expect(skipped.command).toEqual([]);
    expect(skipped.exit).toBeNull();
    expect(envelopes[1].command).toEqual(["sh", "-c", "exit 0"]);
    expect(envelopes[2].exit).toBe(3);
    expect(envelopes[5]).toMatchObject({
      command: ["node", "-e", "1", "alpha"],
      selector: "alpha",
    });
    expect(envelopes[0].selector).toBeNull();
  });

  it("a skipped check is never reported as pass", async () => {
    const cwd = makeRepo();
    const result = await verify({
      cwd,
      logDir: makeTmpDir(),
      checks: ["nothing"],
      execFn: makeStubExec().fn,
      evidence: { ...EVIDENCE },
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence?.[0].result).toBe("skip");
    expect(result.evidence?.[0].result).not.toBe("pass");
  });

  it("reads commit and dirty from the repository, per check", async () => {
    const cwd = makeRepo();
    const head = git(cwd, "rev-parse", "HEAD");
    // The first check leaves an untracked file behind: the second one runs
    // against a dirty tree.
    const { fn } = makeStubExec({}, (call) => {
      if (call.cmd === "first") fs.writeFileSync(path.join(cwd, "stray"), "x");
    });
    const result = await verify({
      cwd,
      logDir: makeTmpDir(),
      checks: ["a", "b"],
      overrides: { a: "first", b: "second" },
      execFn: fn,
      evidence: { ...EVIDENCE },
    });
    expect(result.evidence?.map((e) => [e.commit, e.dirty])).toEqual([
      [head, false],
      [head, true],
    ]);
  });

  it("a tracked modification makes dirty true, and the value cannot come from input", async () => {
    const cwd = makeRepo();
    fs.appendFileSync(path.join(cwd, "package.json"), "\n");
    const result = await verify({
      cwd,
      logDir: makeTmpDir(),
      checks: ["a"],
      overrides: { a: "true" },
      execFn: makeStubExec().fn,
      evidence: {
        ...EVIDENCE,
        // Unknown extras are not options: nothing here can claim a commit.
        ...({ commit: "f".repeat(40), dirty: false } as object),
      },
    });
    expect(result.evidence?.[0].dirty).toBe(true);
    expect(result.evidence?.[0].commit).toBe(git(cwd, "rev-parse", "HEAD"));
  });

  it("phase and producer are carried through; ci carries its run reference", async () => {
    const cwd = makeRepo();
    const run = async (evidence: VerifyOptions["evidence"]) =>
      (
        await verify({
          cwd,
          logDir: makeTmpDir(),
          checks: ["a"],
          overrides: { a: "true" },
          execFn: makeStubExec().fn,
          evidence,
        })
      ).evidence?.[0];
    const closure = await run({ phase: "closure", producer: "host" });
    expect(closure).toMatchObject({ phase: "closure", producer: "host" });
    expect(closure).not.toHaveProperty("ci_run");
    const ci = await run({
      phase: "baseline",
      producer: "ci",
      ciRun: "https://ci.example.invalid/runs/9",
    });
    expect(ci).toMatchObject({
      producer: "ci",
      ci_run: "https://ci.example.invalid/runs/9",
    });
    expect(validate(schema, ci)).toEqual([]);
  });

  it("time comes from the clock seam and is ISO 8601 UTC", async () => {
    const cwd = makeRepo();
    const result = await verify({
      cwd,
      logDir: makeTmpDir(),
      checks: ["a"],
      overrides: { a: "true" },
      execFn: makeStubExec().fn,
      evidence: {
        ...EVIDENCE,
        now: () => new Date("2026-03-04T05:06:07.089Z"),
      },
    });
    expect(result.evidence?.[0].time).toBe("2026-03-04T05:06:07.089Z");
  });

  it("producer ci without a run reference is refused and nothing runs", async () => {
    const cwd = makeRepo();
    const { fn, calls } = makeStubExec();
    const refused = await refusal({
      cwd,
      logDir: makeTmpDir(),
      checks: ["a"],
      overrides: { a: "true" },
      execFn: fn,
      evidence: { phase: "baseline", producer: "ci" },
    });
    expect(refused.reason).toBe("evidence_ci_run_required");
    expect(calls).toEqual([]);
  });

  it("a ci run reference with another producer is refused and nothing runs", async () => {
    const cwd = makeRepo();
    const { fn, calls } = makeStubExec();
    const refused = await refusal({
      cwd,
      logDir: makeTmpDir(),
      checks: ["a"],
      overrides: { a: "true" },
      execFn: fn,
      evidence: { phase: "baseline", producer: "local", ciRun: "1" },
    });
    expect(refused.reason).toBe("evidence_ci_run_not_ci");
    expect(calls).toEqual([]);
  });

  it("outside a git work tree it is a usage error and nothing runs", async () => {
    const cwd = makeTmpDir();
    const { fn, calls } = makeStubExec();
    const refused = await refusal({
      cwd,
      logDir: makeTmpDir(),
      checks: ["a"],
      overrides: { a: "true" },
      execFn: fn,
      evidence: { ...EVIDENCE },
    });
    expect(refused.reason).toBe("evidence_requires_git");
    expect(calls).toEqual([]);
  });

  it("a check whose git state cannot be read gets no envelope and a warning", async () => {
    const cwd = makeRepo();
    const { fn } = makeStubExec({}, (call) => {
      if (call.cmd === "first") {
        fs.rmSync(path.join(cwd, ".git"), { recursive: true, force: true });
      }
    });
    const result = await verify({
      cwd,
      logDir: makeTmpDir(),
      checks: ["a", "b"],
      overrides: { a: "first", b: "second" },
      execFn: fn,
      evidence: { ...EVIDENCE },
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain(
      "b: evidence not recorded, the git state could not be read",
    );
  });

  it("commands_digest covers the command set, not the selector or the outcome", async () => {
    const cwd = makeRepo();
    const run = async (selector: string, bad: string) =>
      (
        await verify({
          cwd,
          logDir: makeTmpDir(),
          checks: ["a", "t"],
          overrides: { a: "exit 0" },
          argvChecks: { t: ["node", "-e", "1", "{selector}"] },
          selectors: { t: selector },
          discovery: { t: ["one", "two"] },
          execFn: makeStubExec({ "exit 0": { exitCode: Number(bad) } }).fn,
          evidence: { ...EVIDENCE },
        })
      ).evidence ?? [];
    const first = await run("one", "0");
    const second = await run("two", "1");
    expect(first[0].commands_digest).toBe(
      "e83e0657e8dc137b65a9f491e1ddca5fcfb255953ad5b35a5eed2b7d3bc2b9c3",
    );
    expect(second[0].commands_digest).toBe(first[0].commands_digest);
    expect(first[1].commands_digest).toBe(first[0].commands_digest);
    expect(first[1].selector).toBe("one");
    expect(second[1].selector).toBe("two");
  });

  it("commands_digest changes with the command set", async () => {
    const cwd = makeRepo();
    const digest = async (command: string) =>
      (
        await verify({
          cwd,
          logDir: makeTmpDir(),
          checks: ["a"],
          overrides: { a: command },
          execFn: makeStubExec().fn,
          evidence: { ...EVIDENCE },
        })
      ).evidence?.[0].commands_digest;
    expect(await digest("exit 0")).toBe(
      "e1b5f9b3ba0f90595a9693bbe677e967def5c4bce98ea71f24fbff7bb7a7e649",
    );
    expect(await digest("exit 1")).not.toBe(await digest("exit 0"));
  });

  it("without the opt-in the result carries no evidence and no argv key", async () => {
    const cwd = makeRepo();
    const result = await verify({
      cwd,
      logDir: makeTmpDir(),
      checks: ["a"],
      overrides: { a: "true" },
      execFn: makeStubExec().fn,
    });
    expect("evidence" in result).toBe(false);
    expect("argv" in result.checks[0]).toBe(false);
    expect(Object.keys(result).sort()).toEqual(
      [
        "checks",
        "logs",
        "status",
        "totalDurationMs",
        "truncatedByMaxFailures",
        "warnings",
      ].sort(),
    );
  });

  it("runs outside a git work tree without the opt-in", async () => {
    const cwd = makeTmpDir();
    const result = await verify({
      cwd,
      logDir: makeTmpDir(),
      checks: ["a"],
      overrides: { a: "true" },
      execFn: makeStubExec().fn,
    });
    expect(result.status).toBe("pass");
  });
});

describe("verify: argv-form checks and selectors", () => {
  const base = (cwd: string, execFn: ExecLike): VerifyOptions => ({
    cwd,
    logDir: makeTmpDir(),
    checks: ["t"],
    execFn,
  });

  it("executes the substituted list without a shell and passes the selector as one element", async () => {
    const cwd = makeRepo();
    const { fn, calls } = makeStubExec();
    const selector = "a b; touch pwned $(id) 'q'";
    const result = await verify({
      ...base(cwd, fn),
      argvChecks: { t: ["npx", "vitest", "run", "-t", "{selector}"] },
      selectors: { t: selector },
      discovery: { t: ["x", selector] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(["npx", "vitest", "run", "-t", selector]);
    expect(result.checks[0]).toMatchObject({
      source: "argv",
      argv: ["npx", "vitest", "run", "-t", selector],
    });
  });

  it("really spawns without a shell: metacharacters in a listed selector stay literal", async () => {
    const cwd = makeRepo();
    const out = path.join(makeTmpDir(), "argv.json");
    const selector = "$HOME `echo x`; touch pwned";
    const result = await verify({
      cwd,
      logDir: makeTmpDir(),
      checks: ["t"],
      argvChecks: {
        t: [
          process.execPath,
          "-e",
          "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
          out,
          "{selector}",
        ],
      },
      selectors: { t: selector },
      discovery: { t: [selector] },
    });
    expect(result.status).toBe("pass");
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual([selector]);
    expect(fs.existsSync(path.join(cwd, "pwned"))).toBe(false);
  });

  it("a placeholder-free argv check runs as given and needs no selector", async () => {
    const cwd = makeRepo();
    const { fn, calls } = makeStubExec();
    await verify({ ...base(cwd, fn), argvChecks: { t: ["echo", "hi"] } });
    expect(calls[0].argv).toEqual(["echo", "hi"]);
  });

  it("every whole {selector} element is substituted", async () => {
    const cwd = makeRepo();
    const { fn, calls } = makeStubExec();
    await verify({
      ...base(cwd, fn),
      argvChecks: { t: ["run", "{selector}", "--again", "{selector}"] },
      selectors: { t: "one" },
      discovery: { t: ["one"] },
    });
    expect(calls[0].argv).toEqual(["run", "one", "--again", "one"]);
  });

  describe("rejections: each is a usage error and no command runs", () => {
    const template = ["run", "{selector}"];
    const cases: Array<{
      name: string;
      reason: string;
      options: (cwd: string) => Partial<VerifyOptions>;
    }> = [
      {
        name: "a selector starting with - even when the discovery list holds it",
        reason: "selector_leading_dash",
        options: () => ({
          argvChecks: { t: template },
          selectors: { t: "--config=evil" },
          discovery: { t: ["--config=evil", "ok"] },
        }),
      },
      {
        name: "a selector that is a single dash",
        reason: "selector_leading_dash",
        options: () => ({
          argvChecks: { t: template },
          selectors: { t: "-" },
          discovery: { t: ["-"] },
        }),
      },
      {
        name: "a selector that is not in the discovery list",
        reason: "selector_not_in_discovery",
        options: () => ({
          argvChecks: { t: template },
          selectors: { t: "other" },
          discovery: { t: ["alpha", "beta"] },
        }),
      },
      {
        name: "a selector against an empty discovery list",
        reason: "selector_not_in_discovery",
        options: () => ({
          argvChecks: { t: template },
          selectors: { t: "alpha" },
          discovery: { t: [] },
        }),
      },
      {
        name: "an empty selector",
        reason: "selector_not_in_discovery",
        options: () => ({
          argvChecks: { t: template },
          selectors: { t: "" },
          discovery: { t: parseDiscoveryText("alpha\n\n") },
        }),
      },
      {
        name: "a selector for a shell-string -x command",
        reason: "selector_for_shell_command",
        options: () => ({
          overrides: { t: "echo hi" },
          selectors: { t: "alpha" },
          discovery: { t: ["alpha"] },
        }),
      },
      {
        name: "a selector for a package.json script check",
        reason: "selector_for_shell_command",
        options: () => ({
          selectors: { t: "alpha" },
          discovery: { t: ["alpha"] },
        }),
      },
      {
        name: "a selector for a check that is not in the run list",
        reason: "selector_check_not_run",
        options: () => ({
          argvChecks: { t: template },
          selectors: { ghost: "alpha" },
          discovery: { ghost: ["alpha"] },
        }),
      },
      {
        name: "a selector for an argv check without a placeholder",
        reason: "selector_without_placeholder",
        options: () => ({
          argvChecks: { t: ["run"] },
          selectors: { t: "alpha" },
          discovery: { t: ["alpha"] },
        }),
      },
      {
        name: "a selector without a discovery list",
        reason: "selector_without_discovery",
        options: () => ({
          argvChecks: { t: template },
          selectors: { t: "alpha" },
        }),
      },
      {
        name: "a discovery list without a selector",
        reason: "discovery_without_selector",
        options: () => ({
          argvChecks: { t: ["run"] },
          discovery: { t: ["alpha"] },
        }),
      },
      {
        name: "a placeholder without a selector",
        reason: "selector_missing",
        options: () => ({ argvChecks: { t: template } }),
      },
      {
        name: "the placeholder as the program",
        reason: "argv_invalid",
        options: () => ({
          argvChecks: { t: ["{selector}", "x"] },
          selectors: { t: "alpha" },
          discovery: { t: ["alpha"] },
        }),
      },
      {
        name: "the placeholder inside a longer element",
        reason: "argv_invalid",
        options: () => ({
          argvChecks: { t: ["run", "--name={selector}"] },
          selectors: { t: "alpha" },
          discovery: { t: ["alpha"] },
        }),
      },
      {
        name: "an empty argv list",
        reason: "argv_invalid",
        options: () => ({ argvChecks: { t: [] } }),
      },
      {
        name: "an empty program",
        reason: "argv_invalid",
        options: () => ({ argvChecks: { t: ["", "x"] } }),
      },
      {
        name: "a non-string element",
        reason: "argv_invalid",
        options: () => ({
          argvChecks: { t: ["run", 3 as unknown as string] },
        }),
      },
      {
        name: "the same check given as -x and as --argv",
        reason: "argv_name_collision",
        options: () => ({
          overrides: { t: "echo hi" },
          argvChecks: { t: ["echo", "hi"] },
        }),
      },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const cwd = makeRepo({ t: "true" });
        const { fn, calls } = makeStubExec();
        const refused = await refusal({ ...base(cwd, fn), ...c.options(cwd) });
        expect(refused.reason).toBe(c.reason);
        expect(calls).toEqual([]);
      });
    }

    it("no two reasons share a message", async () => {
      const reasonOf = new Map<string, string>();
      for (const c of cases) {
        const cwd = makeRepo({ t: "true" });
        const refused = await refusal({
          ...base(cwd, makeStubExec().fn),
          ...c.options(cwd),
        });
        const seen = reasonOf.get(refused.message);
        if (seen !== undefined) expect(seen).toBe(refused.reason);
        reasonOf.set(refused.message, refused.reason);
      }
      const reasons = new Set(cases.map((c) => c.reason));
      expect(new Set(reasonOf.values())).toEqual(reasons);
    });
  });

  describe("selectors must equal a discovery entry exactly", () => {
    const list = ["alpha beta", "Gamma", "delta"];
    for (const [label, selector] of [
      ["a prefix", "alpha"],
      ["a substring", "beta"],
      ["a longer string containing an entry", "alpha beta gamma"],
      ["another case", "gamma"],
      ["a leading space", " delta"],
      ["a trailing space", "delta "],
      ["a trailing no-break space", "delta\u00a0"],
      ["a regular expression", "del.*"],
    ] as const) {
      it(`rejects ${label}`, async () => {
        const cwd = makeRepo();
        const { fn, calls } = makeStubExec();
        const refused = await refusal({
          ...base(cwd, fn),
          argvChecks: { t: ["run", "{selector}"] },
          selectors: { t: selector },
          discovery: { t: list },
        });
        expect(refused.reason).toBe("selector_not_in_discovery");
        expect(calls).toEqual([]);
      });
    }

    for (const entry of list) {
      it(`accepts the entry ${JSON.stringify(entry)} itself`, async () => {
        const cwd = makeRepo();
        const { fn, calls } = makeStubExec();
        await verify({
          ...base(cwd, fn),
          argvChecks: { t: ["run", "{selector}"] },
          selectors: { t: entry },
          discovery: { t: list },
        });
        expect(calls[0].argv).toEqual(["run", entry]);
      });
    }
  });

  describe("how an --argv check sits beside the other command sources", () => {
    it("-x semantics are unchanged: a {selector} in an -x command stays literal text", async () => {
      const cwd = makeRepo();
      const { fn, calls } = makeStubExec();
      await verify({
        ...base(cwd, fn),
        overrides: { t: "echo {selector}" },
      });
      expect(calls).toEqual([{ cmd: "echo {selector}", argv: undefined }]);
    });

    it("--argv wins over a package.json script and over a repo preset entry of the same name", async () => {
      const cwd = makeRepo({ t: "true", other: "true" });
      fs.writeFileSync(
        path.join(cwd, ".agent-primitives.json"),
        JSON.stringify({ verify: { checks: { t: "other" } } }),
      );
      const { fn, calls } = makeStubExec();
      const result = await verify({
        ...base(cwd, fn),
        argvChecks: { t: ["echo", "mine"] },
      });
      expect(calls.map((c) => c.argv)).toEqual([["echo", "mine"]]);
      expect(result.checks[0].source).toBe("argv");
    });

    it("an --argv check not named in -c is appended and runs after the listed ones", async () => {
      const cwd = makeRepo();
      const { fn, calls } = makeStubExec();
      await verify({
        cwd,
        logDir: makeTmpDir(),
        checks: ["a"],
        overrides: { a: "true" },
        argvChecks: { t: ["echo", "x"] },
        execFn: fn,
      });
      expect(calls.map((c) => c.cmd)).toEqual(["true", "echo x"]);
    });

    it("-c gives the run order of an --argv check", async () => {
      const cwd = makeRepo();
      const { fn, calls } = makeStubExec();
      await verify({
        cwd,
        logDir: makeTmpDir(),
        checks: ["t", "a"],
        overrides: { a: "true" },
        argvChecks: { t: ["echo", "x"] },
        execFn: fn,
      });
      expect(calls.map((c) => c.cmd)).toEqual(["echo x", "true"]);
    });

    it("--argv without -c warns that the default list still runs", async () => {
      const cwd = makeRepo();
      const result = await verify({
        cwd,
        logDir: makeTmpDir(),
        argvChecks: { t: ["echo", "x"] },
        execFn: makeStubExec().fn,
      });
      expect(result.warnings.join("\n")).toContain(
        "hint: --argv given without -c: the default check list",
      );
    });

    it("an argv check with a bad name is refused like any check name", async () => {
      const cwd = makeRepo();
      const refused = await refusal({
        ...base(cwd, makeStubExec().fn),
        argvChecks: { "bad name": ["echo"] },
      });
      expect(refused.reason).toBe("usage_error");
    });

    it("a --pass-regex may name an --argv check", async () => {
      const cwd = makeRepo();
      const result = await verify({
        ...base(cwd, makeStubExec({ "echo x": { stdoutTail: "OK" } }).fn),
        argvChecks: { t: ["echo", "x"] },
        passRegexes: { t: /OK/m },
      });
      expect(result.status).toBe("pass");
    });
  });

  describe("no shell can interpret an argv check, whatever execFn does", () => {
    // An exec function that ignores `options.argv` and runs the label
    // through a real shell, the way `execCommand` runs a shell check.
    const shellRunningExec: ExecLike = async (cmd, options) => {
      let exitCode = 0;
      try {
        execFileSync("sh", ["-c", cmd], { cwd: options.cwd, stdio: "ignore" });
      } catch (err) {
        exitCode = (err as { status?: number }).status ?? 1;
      }
      return {
        exitCode,
        durationMs: 1,
        stdoutTail: "",
        stderrTail: "",
        logPath: path.join(options.logDir, "x.log"),
        timedOut: false,
        aborted: false,
        logWriteFailed: false,
        outputMayBeIncomplete: false,
        stdioClosed: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    };

    for (const selector of [
      "; touch PWNED_LIB",
      "$(touch PWNED_LIB)",
      "`touch PWNED_LIB`",
      "a' ; touch PWNED_LIB ; echo '",
      "a | touch PWNED_LIB",
    ]) {
      it(`creates no file for ${JSON.stringify(selector)}`, async () => {
        const cwd = makeRepo();
        const out = path.join(makeTmpDir(), "argv.json");
        const result = await verify({
          cwd,
          logDir: makeTmpDir(),
          checks: ["t"],
          argvChecks: {
            t: [
              process.execPath,
              "-e",
              "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
              out,
              "{selector}",
            ],
          },
          selectors: { t: selector },
          discovery: { t: [selector] },
          execFn: shellRunningExec,
        });
        expect(result.status).toBe("pass");
        expect(fs.existsSync(path.join(cwd, "PWNED_LIB"))).toBe(false);
        // The shell ran exactly the argv, the selector as one element.
        expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual([selector]);
      });
    }

    it("shellQuoteArgv leaves plain words alone and quotes everything else", () => {
      expect(shellQuoteArgv(["npx", "vitest", "run", "-t", "a/b.c-d"])).toBe(
        "npx vitest run -t a/b.c-d",
      );
      expect(
        shellQuoteArgv(["a b", "", "it's", "$X", "A=b", "{selector}"]),
      ).toBe("'a b' '' 'it'\\''s' '$X' 'A=b' '{selector}'");
    });
  });

  describe("library inputs are type-checked at runtime", () => {
    const run = (extra: Partial<VerifyOptions>) =>
      refusal({
        cwd: makeRepo(),
        logDir: makeTmpDir(),
        checks: ["t"],
        argvChecks: { t: ["run", "{selector}"] },
        execFn: makeStubExec().fn,
        ...extra,
      });

    it("a raw string as a discovery list is refused, not read as a substring match", async () => {
      const refused = await run({
        selectors: { t: "lph" },
        discovery: { t: "alpha" as unknown as string[] },
      });
      expect(refused.reason).toBe("discovery_invalid");
    });

    it("a discovery list with a non-string entry is refused", async () => {
      const refused = await run({
        selectors: { t: "1" },
        discovery: { t: [1 as unknown as string] },
      });
      expect(refused.reason).toBe("discovery_invalid");
    });

    it("a discovery list without a selector is also type-checked", async () => {
      const refused = await run({
        argvChecks: { t: ["run"] },
        discovery: { t: null as unknown as string[] },
      });
      expect(refused.reason).toBe("discovery_invalid");
    });

    it("a selector with a newline or control character is refused before anything runs", async () => {
      for (const selector of [
        "x\ntouch PWNED_LIB",
        "x\rtouch",
        "a\u0000b",
        "a\tb",
        "a\u007fb",
      ]) {
        const refused = await run({
          selectors: { t: selector },
          discovery: { t: [selector] },
        });
        expect(refused.reason).toBe("selector_invalid");
        expect(refused.message).toContain("control character");
      }
    });

    it("a non-string selector is refused", async () => {
      for (const selector of [1, null, ["alpha"], { a: 1 }]) {
        const refused = await run({
          selectors: { t: selector as unknown as string },
          discovery: { t: ["alpha"] },
        });
        expect(refused.reason).toBe("selector_invalid");
      }
    });
  });

  it("parseArgvOption and parseSelectorOption refuse a repeated check and bad input", () => {
    expect(parseArgvOption('t=["a","b"]', {})).toEqual({ t: ["a", "b"] });
    expect(() => parseArgvOption('t=["a"]', { t: ["b"] })).toThrow(/twice/);
    expect(() => parseArgvOption("t=not json", {})).toThrow(/JSON array/);
    // A well-formed value of the wrong shape is verify()'s to refuse.
    expect(parseArgvOption('t={"a":1}', {})).toEqual({ t: { a: 1 } });
    expect(parseArgvOption("t=[1]", {})).toEqual({ t: [1] });
    expect(() => parseArgvOption('["a"]', {})).toThrow(/name=value/);
    expect(parseSelectorOption("t=a=b c", {})).toEqual({ t: "a=b c" });
    expect(() => parseSelectorOption("t=a", { t: "b" })).toThrow(/twice/);
  });
});

describe("cli verify: evidence and argv", () => {
  async function cli(cwd: string, args: string[]) {
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      makeTmpDir(),
      "verify",
      ...args,
    ]);
    return { ...run, json: JSON.parse(run.stdout) as Record<string, any> };
  }

  it("default output is unchanged: no evidence, argv or source additions", async () => {
    const cwd = makeRepo();
    const { code, json } = await cli(cwd, ["-c", "", "-x", "a=exit 0"]);
    expect(code).toBe(0);
    expect(Object.keys(json).sort()).toEqual(
      [
        "checks",
        "command",
        "cwd",
        "durationMs",
        "logs",
        "status",
        "tool",
        "totalDurationMs",
        "truncated",
        "version",
        "warnings",
      ].sort(),
    );
    expect(json).not.toHaveProperty("evidence");
    const check = json.checks[0];
    expect(Object.keys(check).sort()).toEqual(
      [
        "command",
        "detector",
        "durationMs",
        "exitCode",
        "failures",
        "logPath",
        "name",
        "source",
        "status",
        "summary",
        "timedOut",
      ].sort(),
    );
    expect(check).toMatchObject({
      name: "a",
      command: "exit 0",
      source: "exec",
      status: "pass",
      exitCode: 0,
    });
  });

  it("-f text and --summary render exactly as before without the opt-in flags", async () => {
    const cwd = makeRepo();
    const normalise = (text: string) =>
      text
        .replace(/\d+ms/g, "Nms")
        .replace(/totalDurationMs([:=] ?)\d+/g, "totalDurationMs$1N")
        .replace(/\/\S*?([0-9a-f-]{36})\S*/g, "<path>");
    const args = ["-C", cwd, "-l", makeTmpDir()];
    const verifyArgs = [
      "verify",
      "-c",
      "a,b",
      "-x",
      "a=exit 0",
      "-x",
      "b=exit 1",
    ];
    const text = await spawnCli([...args, "-f", "text", ...verifyArgs]);
    expect(text.code).toBe(1);
    expect(normalise(text.stdout)).toBe(
      [
        "status: fail",
        "",
        "checks:",
        "  [pass] a [exec] (exit 0) - Nms",
        "  [fail] b [exec] (exit 1) - Nms",
        "    - exit code 1: (no output)",
        "",
        "totalDurationMs: N",
        "",
        "logs:",
        "  - <path>",
        "  - <path>",
        "  - <path>",
        "",
        "warnings:",
        "  - b: detector_matched_nothing",
        "",
      ].join("\n"),
    );
    const summary = await spawnCli([...args, ...verifyArgs, "--summary"]);
    expect(summary.code).toBe(1);
    expect(normalise(summary.stdout)).toBe(
      [
        "a | pass | exit=0 | Nms | passed=1 failed=0 skipped=0 errors=0",
        "b | fail | exit=1 | Nms | passed=0 failed=1 skipped=0 errors=0 | first failure: exit code 1: (no output)",
        "warning: b: detector_matched_nothing",
        "totals: status=fail checks=2 pass=1 fail=1 skipped=0 error=0 totalDurationMs=N warnings=1 fullResult=<path>",
        "",
      ].join("\n"),
    );
  });

  it("exit codes are the same with and without the opt-in", async () => {
    const cwd = makeRepo();
    const dir = makeTmpDir();
    for (const command of ["exit 0", "exit 1", "exit 127"]) {
      const plain = await cli(cwd, ["-c", "", "-x", `a=${command}`]);
      const withEvidence = await cli(cwd, [
        "-c",
        "",
        "-x",
        `a=${command}`,
        "--evidence",
        path.join(dir, "e.jsonl"),
        "--phase",
        "baseline",
      ]);
      expect(withEvidence.code, command).toBe(plain.code);
      expect(withEvidence.json.status, command).toBe(plain.json.status);
    }
  });

  it("--evidence writes one schema-valid JSON line per check and names the file in the envelope", async () => {
    const cwd = makeRepo();
    const file = path.join(makeTmpDir(), "e.jsonl");
    const disc = path.join(makeTmpDir(), "disc.txt");
    fs.writeFileSync(disc, "alpha\nbeta\n");
    const { code, json } = await cli(cwd, [
      "-c",
      "a,t",
      "-x",
      "a=exit 0",
      "--argv",
      `t=${JSON.stringify([process.execPath, "-e", "1", "{selector}"])}`,
      "--selector",
      "t=beta",
      "--discovery",
      `t=${disc}`,
      "--evidence",
      file,
      "--phase",
      "closure",
      "--producer",
      "host",
    ]);
    expect(code).toBe(0);
    expect(json.evidence).toEqual({ file, count: 2 });
    const text = fs.readFileSync(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const head = git(cwd, "rev-parse", "HEAD");
    for (const line of lines) {
      const envelope = JSON.parse(line) as EvidenceEnvelope;
      expect(validate(schema, envelope)).toEqual([]);
      expect(envelope).toMatchObject({
        phase: "closure",
        producer: "host",
        commit: head,
        dirty: false,
      });
    }
    expect(JSON.parse(lines[1])).toMatchObject({
      selector: "beta",
      command: [process.execPath, "-e", "1", "beta"],
    });
  });

  it("the producer defaults to local", async () => {
    const cwd = makeRepo();
    const file = path.join(makeTmpDir(), "e.jsonl");
    await cli(cwd, [
      "-c",
      "",
      "-x",
      "a=exit 0",
      "--evidence",
      file,
      "--phase",
      "baseline",
    ]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).producer).toBe("local");
  });

  it("producer ci needs --ci-run; with it the envelope carries it", async () => {
    const cwd = makeRepo();
    const file = path.join(makeTmpDir(), "e.jsonl");
    const without = await cli(cwd, [
      "-c",
      "",
      "-x",
      "a=exit 0",
      "--evidence",
      file,
      "--phase",
      "baseline",
      "--producer",
      "ci",
    ]);
    expect(without.code).toBe(2);
    expect(without.json).toMatchObject({
      status: "usage_error",
      reason: "evidence_ci_run_required",
    });
    expect(fs.existsSync(file)).toBe(false);
    const withRun = await cli(cwd, [
      "-c",
      "",
      "-x",
      "a=exit 0",
      "--evidence",
      file,
      "--phase",
      "baseline",
      "--producer",
      "ci",
      "--ci-run",
      "https://ci.example.invalid/runs/1",
    ]);
    expect(withRun.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      producer: "ci",
      ci_run: "https://ci.example.invalid/runs/1",
    });
  });

  it("evidence options are refused without --evidence, and --evidence needs --phase", async () => {
    const cwd = makeRepo();
    const file = path.join(makeTmpDir(), "e.jsonl");
    for (const extra of [
      ["--phase", "baseline"],
      ["--producer", "local"],
      ["--ci-run", "1"],
    ]) {
      const run = await cli(cwd, ["-c", "", "-x", "a=exit 0", ...extra]);
      expect(run.code, extra.join(" ")).toBe(2);
      expect(run.json.reason).toBe("evidence_option_without_file");
    }
    const noPhase = await cli(cwd, [
      "-c",
      "",
      "-x",
      "a=exit 0",
      "--evidence",
      file,
    ]);
    expect(noPhase.code).toBe(2);
    expect(noPhase.json.reason).toBe("evidence_phase_required");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("an unknown phase or producer is a usage error", async () => {
    const cwd = makeRepo();
    for (const extra of [
      ["--phase", "weekly"],
      ["--producer", "cloud"],
    ]) {
      const run = await spawnCli([
        "-C",
        cwd,
        "-l",
        makeTmpDir(),
        "verify",
        "-c",
        "",
        "-x",
        "a=exit 0",
        "--evidence",
        path.join(makeTmpDir(), "e"),
        "--phase",
        "baseline",
        ...extra,
      ]);
      expect(run.code, extra.join(" ")).toBe(2);
    }
  });

  it("an unwritable evidence file turns a pass into an error and says so", async () => {
    const cwd = makeRepo();
    const file = path.join(makeTmpDir(), "missing-dir", "e.jsonl");
    const run = await cli(cwd, [
      "-c",
      "",
      "-x",
      "a=exit 0",
      "--evidence",
      file,
      "--phase",
      "baseline",
    ]);
    expect(run.code).toBe(2);
    expect(run.json.status).toBe("error");
    expect(run.json.reason).toBe("evidence_write_failed");
    expect(run.json.warnings.join("\n")).toContain("evidence: could not write");
    expect(run.json).not.toHaveProperty("evidence");
  });

  it("--selector is checked against the --discovery file, compared exactly", async () => {
    const cwd = makeRepo();
    const dir = makeTmpDir();
    const disc = path.join(dir, "disc.txt");
    fs.writeFileSync(disc, "alpha\r\nbeta\n\n--flag\n");
    const argv = `t=${JSON.stringify([process.execPath, "-e", "1", "{selector}"])}`;
    const attempt = (selector: string) =>
      cli(cwd, [
        "-c",
        "t",
        "--argv",
        argv,
        "--selector",
        `t=${selector}`,
        "--discovery",
        `t=${disc}`,
      ]);
    expect((await attempt("beta")).code).toBe(0);
    // The CR of a CRLF line is part of the entry: "alpha" is not equal to it.
    expect((await attempt("alpha")).json.reason).toBe(
      "selector_not_in_discovery",
    );
    expect((await attempt("--flag")).json.reason).toBe("selector_leading_dash");
    expect((await attempt("bet")).json.reason).toBe(
      "selector_not_in_discovery",
    );
  });

  it("an unreadable discovery file is a usage error and nothing runs", async () => {
    const cwd = makeRepo();
    const marker = path.join(makeTmpDir(), "ran");
    const run = await cli(cwd, [
      "-c",
      "t",
      "--argv",
      `t=${JSON.stringify(["touch", marker, "{selector}"])}`,
      "--selector",
      "t=x",
      "--discovery",
      `t=${path.join(makeTmpDir(), "nope.txt")}`,
    ]);
    expect(run.code).toBe(2);
    expect(run.json.reason).toBe("discovery_not_readable");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("a selector for a shell-string -x check is refused on the command line", async () => {
    const cwd = makeRepo();
    const disc = path.join(makeTmpDir(), "d.txt");
    fs.writeFileSync(disc, "alpha\n");
    const run = await cli(cwd, [
      "-c",
      "t",
      "-x",
      "t=exit 0",
      "--selector",
      "t=alpha",
      "--discovery",
      `t=${disc}`,
    ]);
    expect(run.code).toBe(2);
    expect(run.json.reason).toBe("selector_for_shell_command");
  });

  it("the same --argv check given twice is refused", async () => {
    const cwd = makeRepo();
    const run = await spawnCli([
      "-C",
      cwd,
      "-l",
      makeTmpDir(),
      "verify",
      "-c",
      "t",
      "--argv",
      't=["true"]',
      "--argv",
      't=["false"]',
    ]);
    expect(run.code).toBe(2);
  });

  it("--print evidence prints the evidence note, and is accepted next to status", async () => {
    const cwd = makeRepo();
    const file = path.join(makeTmpDir(), "e.jsonl");
    const run = await cli(cwd, [
      "-c",
      "",
      "-x",
      "a=exit 0",
      "--evidence",
      file,
      "--phase",
      "baseline",
      "--print",
      "status,evidence",
    ]);
    expect(run.code).toBe(0);
    expect(run.json).toEqual({ status: "pass", evidence: { file, count: 1 } });
  });

  it("--argv values of the wrong shape are argv_invalid; unparseable JSON stays a parse-time usage error", async () => {
    const cwd = makeRepo();
    for (const value of ['t={"a":1}', "t=[1]", "t=[]", 't=[""]']) {
      const run = await cli(cwd, ["-c", "t", "--argv", value]);
      expect(run.code, value).toBe(2);
      expect(run.json.reason, value).toBe("argv_invalid");
    }
    const bad = await spawnCli([
      "-C",
      cwd,
      "-l",
      makeTmpDir(),
      "verify",
      "-c",
      "t",
      "--argv",
      "t=not json",
    ]);
    expect(bad.code).toBe(2);
  });

  it("an --argv check reports source argv and the executed list", async () => {
    const cwd = makeRepo();
    const run = await cli(cwd, [
      "-c",
      "t",
      "--argv",
      `t=${JSON.stringify(["node", "-e", "process.exit(4)"])}`,
    ]);
    expect(run.code).toBe(1);
    expect(run.json.checks[0]).toMatchObject({
      source: "argv",
      argv: ["node", "-e", "process.exit(4)"],
      status: "fail",
      exitCode: 4,
    });
  });
});

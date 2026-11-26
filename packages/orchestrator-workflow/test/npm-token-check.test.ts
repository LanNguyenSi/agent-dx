// NPM_AGENT_DX_TOKEN validity and expiry are checked in the repository:
// .github/scripts/check-npm-token.mjs authenticates with npm whoami and
// enforces the expiry tracked in the single data file
// .github/npm-agent-dx-token.json; the weekly npm-token-check.yml job and
// the preflight steps of both operator workflows run it before anything
// reaches the registry. These tests run the real script against a stub npm
// (same posture as publish-npm-latest-check.test.ts), pin the wiring in the
// three workflow files, and replay every added or changed run: step body
// under the Actions bash invocation (bash --noprofile --norc -eo pipefail,
// since every affected workflow sets defaults.run.shell: bash).

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  defaults?: { run?: { shell?: string } };
  jobs: Record<string, { "timeout-minutes"?: number; steps: Step[] }>;
}

const rel = (p: string) =>
  fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const SCRIPT = rel(".github/scripts/check-npm-token.mjs");
const DATA_FILE = rel(".github/npm-agent-dx-token.json");
const workflowText = (file: string) =>
  readFileSync(rel(`.github/workflows/${file}`), "utf8");
const workflow = (file: string) => parse(workflowText(file)) as Workflow;
const jobSteps = (wf: Workflow) => {
  const jobs = Object.values(wf.jobs);
  expect(jobs).toHaveLength(1);
  return jobs[0].steps;
};
const stepsCallingScript = (steps: Step[]) =>
  steps.filter((s) => (s.run ?? "").includes("check-npm-token.mjs"));

// A stand-in for the real secret: every script invocation gets it as
// NODE_AUTH_TOKEN and no output may ever contain it.
const TOKEN = "npm_tesTSecrEtvaluE_4711";

// Stub npm: records its arguments, prints STUB_NPM_OUT, exits STUB_NPM_EXIT,
// and on demand echoes NODE_AUTH_TOKEN on stderr to pin the redaction.
const STUB_NPM = [
  "#!/usr/bin/env bash",
  'printf \'%s\\n\' "$*" > "${STUB_ARGS_FILE:?}"',
  'if [ -n "${STUB_NPM_ECHO_TOKEN:-}" ]; then printf \'npm error verbose leaked: %s\\n\' "${NODE_AUTH_TOKEN:-}" >&2; fi',
  'if [ -n "${STUB_NPM_OUT+set}" ]; then printf \'%s\\n\' "$STUB_NPM_OUT"; fi',
  'exit "${STUB_NPM_EXIT:-0}"',
  "",
].join("\n");

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "npm-token-check-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stubBin(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npm"), STUB_NPM);
  chmodSync(join(bin, "npm"), 0o755);
  return bin;
}

function stubEnv(
  dir: string,
  bin: string,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    NODE_AUTH_TOKEN: TOKEN,
    STUB_ARGS_FILE: join(dir, "args.txt"),
    ...extra,
  };
}

function runScript(
  dir: string,
  bin: string,
  args: string[],
  extra: Record<string, string>,
): SpawnSyncReturns<string> {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: stubEnv(dir, bin, extra),
  });
  // A spawn failure surfaces as r.error, never as a status.
  expect(r.error).toBeUndefined();
  return r;
}

const dateFileFixture = (
  dir: string,
  expires: string,
  warnDays: number | string,
): string => {
  const file = join(dir, "date.json");
  writeFileSync(file, JSON.stringify({ expires, warn_days: warnDays }));
  return file;
};

describe("tracked expiry data file", () => {
  it("carries a real YYYY-MM-DD expiry and a non-negative integer warn_days", () => {
    const data = JSON.parse(readFileSync(DATA_FILE, "utf8")) as Record<
      string,
      unknown
    >;
    expect(typeof data.expires).toBe("string");
    expect(data.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [y, m, d] = (data.expires as string).split("-").map(Number);
    const back = new Date(Date.UTC(y, m - 1, d));
    expect([
      back.getUTCFullYear(),
      back.getUTCMonth() + 1,
      back.getUTCDate(),
    ]).toEqual([y, m, d]);
    expect(Number.isInteger(data.warn_days)).toBe(true);
    expect(data.warn_days as number).toBeGreaterThanOrEqual(0);
  });
});

describe("check-npm-token.mjs against a stub npm", () => {
  it("passes on an authenticated user with the expiry outside the warn window", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-06-10", 7);
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-01"],
        {
          STUB_NPM_OUT: "octocat",
        },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("octocat");
      expect(r.stdout).toContain("expires 2026-06-10");
      expect(r.stdout).toContain("40 day(s) left");
      expect(`${r.stdout}${r.stderr}`).not.toContain(TOKEN);
    });
  });

  it("fails when the registry rejects the token (npm whoami exits non-zero)", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-06-10", 7);
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-01"],
        {
          STUB_NPM_EXIT: "1",
        },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("::error::");
      expect(r.stdout).toContain("exited 1");
    });
  });

  it("fails when npm whoami exits 0 but prints no user", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-06-10", 7);
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-01"],
        {
          STUB_NPM_OUT: "",
        },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("printed no user");
    });
  });

  it("fails when npm whoami exits 0 but prints only whitespace", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-06-10", 7);
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-01"],
        {
          STUB_NPM_OUT: "   ",
        },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("printed no user");
    });
  });

  it("passes just outside the warn window, at warn_days + 1 days left", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-05-18", 7);
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-10"],
        {
          STUB_NPM_OUT: "octocat",
        },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("8 day(s) left");
    });
  });

  it("fails inside the warn window, at exactly warn_days days left", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-05-17", 7);
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-10"],
        {
          STUB_NPM_OUT: "octocat",
        },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("::error::");
      expect(r.stdout).toContain("warn window");
    });
  });

  it("fails at 1 day left even with a one-day warn window (boundary precedence)", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-05-11", 1);
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-10"],
        {
          STUB_NPM_OUT: "octocat",
        },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("warn window");
    });
  });

  it("passes at 1 day left when warn_days is 0 (no window configured)", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-05-11", 0);
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-10"],
        {
          STUB_NPM_OUT: "octocat",
        },
      );
      expect(r.status).toBe(0);
    });
  });

  it("fails when the expiry is today: expired, refused before any npm call", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-05-10", 7);
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-10"],
        {
          STUB_NPM_OUT: "octocat",
        },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("expired");
      // The expiry verdict lands without touching the registry: the stub
      // recorded no arguments because npm never ran.
      expect(() => readFileSync(join(dir, "args.txt"), "utf8")).toThrow();
    });
  });

  it("fails when the expiry is past", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-05-10", 7);
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-11"],
        {
          STUB_NPM_OUT: "octocat",
        },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("expired");
      expect(r.stdout).toContain("1 day(s) ago");
    });
  });

  it("fails on a date file that is not JSON", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = join(dir, "date.json");
      writeFileSync(file, "not json {{{");
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-01"],
        {
          STUB_NPM_OUT: "octocat",
        },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("not valid JSON");
    });
  });

  it("fails on an expires value that is not a real calendar date", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = join(dir, "date.json");
      writeFileSync(
        file,
        JSON.stringify({ expires: "2026-02-31", warn_days: 7 }),
      );
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-01"],
        {
          STUB_NPM_OUT: "octocat",
        },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("not a real calendar date");
    });
  });

  it("fails on a missing date file", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const r = runScript(
        dir,
        bin,
        ["--date-file", join(dir, "absent.json"), "--today", "2026-05-01"],
        { STUB_NPM_OUT: "octocat" },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("cannot read the expiry date file");
    });
  });

  it("passes --registry and the whoami verb to npm", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-06-10", 7);
      runScript(dir, bin, ["--date-file", file, "--today", "2026-05-01"], {
        STUB_NPM_OUT: "octocat",
      });
      expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe(
        "whoami --registry https://registry.npmjs.org",
      );
    });
  });

  it("never echoes the token, even when a verbose npm leaks it on stderr", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-06-10", 7);
      const r = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-05-01"],
        {
          STUB_NPM_EXIT: "1",
          STUB_NPM_ECHO_TOKEN: "1",
        },
      );
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`).not.toContain(TOKEN);
      expect(r.stdout).toContain("[redacted]");
    });
  });

  it("without --date-file it reads the repository's own expiry file (--today far in the past)", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const r = runScript(dir, bin, ["--today", "2026-05-01"], {
        STUB_NPM_OUT: "octocat",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("authenticated");
    });
  });

  it("without --today it uses the real clock against the tracked expiry", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      // No date override: the verdict comes from the real today, so it can
      // legitimately differ as the tracked expiry approaches; what must
      // never happen is a crash or a verdict that names neither outcome.
      const r = runScript(dir, bin, ["--date-file", DATA_FILE], {
        STUB_NPM_OUT: "octocat",
      });
      expect([0, 1]).toContain(r.status);
      expect(`${r.stdout}${r.stderr}`).toContain("NPM_AGENT_DX_TOKEN");
    });
  });

  it("rejects a malformed --today and unknown flags as usage errors (exit 2)", () => {
    withTemp((dir) => {
      const bin = stubBin(dir);
      const file = dateFileFixture(dir, "2026-06-10", 7);
      const badToday = runScript(
        dir,
        bin,
        ["--date-file", file, "--today", "2026-5-1"],
        {
          STUB_NPM_OUT: "octocat",
        },
      );
      expect(badToday.status).toBe(2);
      expect(badToday.stderr).toContain("usage:");
      const unknownFlag = runScript(dir, bin, ["--date-filee", file], {
        STUB_NPM_OUT: "octocat",
      });
      expect(unknownFlag.status).toBe(2);
      expect(unknownFlag.stderr).toContain("usage:");
    });
  });
});

describe("npm-token-check.yml wiring", () => {
  const wf = workflow("npm-token-check.yml");
  const steps = jobSteps(wf);
  const job = Object.values(wf.jobs)[0];

  it("runs weekly on a schedule and can be dispatched manually", () => {
    const on = wf.on as {
      schedule?: Array<{ cron?: string }>;
      workflow_dispatch?: unknown;
    };
    expect(Array.isArray(on.schedule)).toBe(true);
    const crons = (on.schedule ?? []).map((s) => s.cron);
    expect(crons.length).toBeGreaterThan(0);
    // Weekly, not every-minute: the day-of-week field is pinned, not '*'.
    for (const cron of crons) {
      const fields = String(cron).trim().split(/\s+/);
      expect(fields).toHaveLength(5);
      expect(fields[4]).not.toBe("*");
    }
    expect("workflow_dispatch" in on).toBe(true);
  });

  it("holds only contents: read and shells with bash", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(wf.defaults?.run?.shell).toBe("bash");
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
  });

  it("pins every action to a full commit SHA with a version comment", () => {
    for (const line of workflowText("npm-token-check.yml").split("\n")) {
      const m = /^\s*(?:-\s+)?uses:\s*(.*)$/.exec(line);
      if (!m) continue;
      const [value, comment = ""] = m[1].split("#");
      expect(value.trim()).toMatch(
        /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[0-9a-f]{40}$/,
      );
      expect(comment.trim()).toMatch(/^v\d/i);
    }
    expect(
      steps.some((s) => (s.uses ?? "").startsWith("actions/checkout@")),
    ).toBe(true);
  });

  it("self-tests the checker, then runs the check with the secret only via env", () => {
    const selfIdx = steps.findIndex((s) => s.name === "Self-test the checker");
    const checkIdx = steps.findIndex((s) => s.name === "Check the token");
    expect(selfIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(selfIdx);
    expect(steps[selfIdx]?.run?.trim()).toBe(
      "node .github/scripts/check-npm-token.mjs --self-test",
    );
    expect(steps[checkIdx]?.run?.trim()).toBe(
      "node .github/scripts/check-npm-token.mjs",
    );
    expect(steps[checkIdx]?.env?.NODE_AUTH_TOKEN).toBe(
      "${{ secrets.NPM_AGENT_DX_TOKEN }}",
    );
  });

  it("carries no ${{ }} expression inside any run: body", () => {
    for (const step of steps) {
      expect(step.run ?? "").not.toContain("${{");
    }
  });
});

describe("operator workflow preflights call the checker", () => {
  const cases: Array<[string, string]> = [
    ["npm-deprecate.yml", "deprecate"],
    ["npm-dist-tag.yml", "dist-tag"],
  ];
  for (const [file, jobName] of cases) {
    describe(file, () => {
      const steps = workflow(file).jobs[jobName]?.steps ?? [];
      const preflightIdx = steps.findIndex((s) =>
        (s.run ?? "").includes("check-npm-token.mjs"),
      );
      const preflightRun = steps[preflightIdx]?.run ?? "";

      it("has a preflight step that runs the checker, not a presence test", () => {
        expect(preflightIdx).toBeGreaterThan(-1);
        expect(preflightRun).not.toContain("[ -z");
        expect(preflightRun).not.toContain("${{");
        expect(steps[preflightIdx]?.env?.NODE_AUTH_TOKEN).toBe(
          "${{ secrets.NPM_AGENT_DX_TOKEN }}",
        );
      });

      it("runs after setup-node (its .npmrc is what authenticates) and before the self-test and any registry step", () => {
        const setupIdx = steps.findIndex((s) =>
          (s.uses ?? "").includes("actions/setup-node@"),
        );
        const selfTestIdx = steps.findIndex((s) =>
          (s.run ?? "").includes("--self-test"),
        );
        const registryIdxs = steps
          .map((s, i) => [s, i] as const)
          .filter(([s]) =>
            /npm view|npm deprecate|npm dist-tag|print-deprecations\.mjs/.test(
              s.run ?? "",
            ),
          )
          .map(([, i]) => i);
        expect(setupIdx).toBeGreaterThan(-1);
        expect(preflightIdx).toBeGreaterThan(setupIdx);
        expect(selfTestIdx).toBeGreaterThan(-1);
        expect(preflightIdx).toBeLessThan(selfTestIdx);
        expect(registryIdxs.length).toBeGreaterThan(0);
        expect(preflightIdx).toBeLessThan(Math.min(...registryIdxs));
      });

      it("points the token comment at the tracked date file, not outside the repository", () => {
        const text = workflowText(file);
        expect(text).not.toContain("outside this repository");
        expect(text).toContain("npm-agent-dx-token.json");
        expect(text).toContain("npm-token-check.yml");
      });
    });
  }
});

describe("CONTRIBUTING.md token paragraph", () => {
  const src = readFileSync(rel("CONTRIBUTING.md"), "utf8");

  it("keeps exactly one paragraph naming the secret, and it carries the expiry guidance", () => {
    const paragraphs = src
      .split(/\r?\n[ \t]*\r?\n/)
      .filter((p) => p.includes("NPM_AGENT_DX_TOKEN"));
    expect(paragraphs).toHaveLength(1);
    const [paragraph] = paragraphs;
    expect(paragraph).toContain(".github/npm-agent-dx-token.json");
    expect(paragraph).toContain("check-npm-token.mjs");
    expect(paragraph).toContain("npm-token-check.yml");
  });

  it("documents the same-PR rotation and the operator-only scope and 2FA-bypass decisions", () => {
    const collapsed = src.replace(/\s+/g, " ");
    expect(collapsed).toContain(
      "update the date in `.github/npm-agent-dx-token.json` in the same pull request",
    );
    expect(collapsed).toMatch(
      /Narrowing the token's package scope and turning off its 2FA-bypass are operator decisions made on npmjs\.com/,
    );
  });
});

describe("added and changed run: steps replay under the Actions bash invocation", () => {
  // defaults.run.shell: bash is set on all three workflows, so Actions runs
  // these bodies with bash --noprofile --norc -eo pipefail.
  const replay = (body: string, dir: string, extra: Record<string, string>) => {
    const bin = stubBin(dir);
    const r = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", body],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 60000,
        env: stubEnv(dir, bin, extra),
      },
    );
    expect(r.error).toBeUndefined();
    return r;
  };

  // A scratch workspace holding the real scripts and a chosen expiry file,
  // so the replay exercises the workflow's exact command line, default
  // date-file resolution included.
  const makeWorkspace = (expires: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "npm-token-replay-"));
    mkdirSync(join(dir, ".github"), { recursive: true });
    cpSync(join(rel(".github"), "scripts"), join(dir, ".github", "scripts"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, ".github", "npm-agent-dx-token.json"),
      JSON.stringify({ expires, warn_days: 7 }),
    );
    return dir;
  };

  const tokenCheckSteps = jobSteps(workflow("npm-token-check.yml"));
  const scriptBody = (steps: Step[]): string => {
    const found = stepsCallingScript(steps).filter(
      (s) => !(s.run ?? "").includes("--self-test"),
    );
    expect(found.length).toBe(1);
    return (found[0]?.run ?? "").trim();
  };
  const checkBody = scriptBody(tokenCheckSteps);
  const deprecateBody = scriptBody(
    workflow("npm-deprecate.yml").jobs["deprecate"]?.steps ?? [],
  );
  const distTagBody = scriptBody(
    workflow("npm-dist-tag.yml").jobs["dist-tag"]?.steps ?? [],
  );
  const selfTestBody =
    tokenCheckSteps
      .find((s) => (s.run ?? "").includes("--self-test"))
      ?.run?.trim() ?? "";

  it("replays every checker body identically across the three workflows", () => {
    expect(checkBody).toBe("node .github/scripts/check-npm-token.mjs");
    expect(deprecateBody).toBe(checkBody);
    expect(distTagBody).toBe(checkBody);
    expect(selfTestBody).toBe(
      "node .github/scripts/check-npm-token.mjs --self-test",
    );
  });

  it(
    "self-test step passes as committed (expected success input)",
    () => {
      withTemp((dir) => {
        // The self-test's default-date-file case reads the file next to the
        // scripts' ../, so the scratch workspace needs the whole .github
        // tree, exactly as a checkout provides it.
        cpSync(rel(".github"), join(dir, ".github"), { recursive: true });
        const r = replay(selfTestBody, dir, {});
        expect(r.stdout).toContain("check-npm-token self-test:");
        expect(r.status).toBe(0);
      });
    },
    // The in-script self-test spawns a node process per case; the 5s
    // default times out when the full suite runs this alongside
    // everything else.
    120000,
  );

  const checkers: Array<[string, string]> = [
    ["npm-token-check.yml check step", checkBody],
    ["npm-deprecate.yml preflight", deprecateBody],
    ["npm-dist-tag.yml preflight", distTagBody],
  ];
  for (const [label, body] of checkers) {
    it(`${label}: expected success (valid token, expiry outside the window)`, () => {
      const ws = makeWorkspace("2099-01-01");
      try {
        const r = replay(body, ws, { STUB_NPM_OUT: "octocat" });
        expect(r.stdout).toContain("authenticated");
        expect(r.status).toBe(0);
        expect(`${r.stdout}${r.stderr}`).not.toContain(TOKEN);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it(`${label}: expected failure (registry rejects the token)`, () => {
      const ws = makeWorkspace("2099-01-01");
      try {
        const r = replay(body, ws, { STUB_NPM_EXIT: "1" });
        expect(r.status).not.toBe(0);
        expect(r.stdout).toContain("::error::");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it(`${label}: expected failure (tracked expiry inside the warn window)`, () => {
      const ws = makeWorkspace(
        new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
      );
      try {
        const r = replay(body, ws, { STUB_NPM_OUT: "octocat" });
        expect(r.status).not.toBe(0);
        expect(r.stdout).toContain("warn window");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  }
});

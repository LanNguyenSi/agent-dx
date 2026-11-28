/**
 * `spec-gate closure` with `--github-repo`: the host is asked once per
 * distinct `(commit, ci_run)` pair of the counted `producer: ci` envelopes,
 * the answer only marks (no answer changes a row's state or `ok`), a throw
 * or an out-of-type answer is `host-failed` and never a pass, the token
 * comes from `GITHUB_TOKEN` only and reaches no output, and without the
 * flag nothing is asked and the report is the offline one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NO_PULL_REQUEST } from "../../src/cli-host.js";
import { runClosure } from "../../src/closure/index.js";
import {
  CI_RUN_STATES,
  type GitHubHostOptions,
  type HostAdapter,
} from "../../src/host/index.js";
import { Stub } from "../host/stub.js";
import { REMOTE_MAIN } from "../lint/git-helpers.js";
import {
  reportIn,
  rowOf,
  scenario,
  writeEvidence,
  type EnvelopeFields,
  type Scenario,
} from "./helpers.js";

const TOKEN = "spec-gate-closure-host-token-9e2f6b14";
const REPOSITORY = "acme/widgets";
const RUN = "8123456789";
const RUN_PATH = `/repos/${REPOSITORY}/actions/runs/${RUN}`;

/** A host made of answers: `answer(commit, run)` is what `ciRunStatus` gives. */
function fakeHost(
  // The base no-unused-vars rule reads the names in a signature as variables.
  // eslint-disable-next-line no-unused-vars
  answer: (commit: string, run: string) => unknown = () => "verified",
): { host: HostAdapter; calls: [string, string][] } {
  const calls: [string, string][] = [];
  const host = {
    ciRunStatus: async (commit: string, run: string) => {
      calls.push([commit, run]);
      return answer(commit, run) as never;
    },
  } as unknown as HostAdapter;
  return { host, calls };
}

interface ClosureHostRun {
  result: Awaited<ReturnType<typeof runClosure>>;
  /** What the seam's `createHost` was given, once per call. */
  hostOptions: GitHubHostOptions[];
}

/** Runs the check in the scenario as `closure --github-repo acme/widgets` would. */
async function closureWithHost(
  s: Scenario,
  host: HostAdapter | null,
  options: {
    apiUrl?: string;
    env?: Record<string, string | undefined>;
    unknownArguments?: number;
    /** Make the real adapter instead of the fake (the stub-server cases). */
    real?: boolean;
    // eslint-disable-next-line no-unused-vars
    createHost?: (options: GitHubHostOptions) => HostAdapter;
  } = {},
): Promise<ClosureHostRun> {
  const hostOptions: GitHubHostOptions[] = [];
  const request = {
    repo: s.repo.dir,
    defaultRef: REMOTE_MAIN,
    start: s.spec,
    githubRepo: REPOSITORY,
    ...(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {}),
    ...(options.unknownArguments !== undefined
      ? { unknownArguments: options.unknownArguments }
      : {}),
  };
  const env = options.env ?? { GITHUB_TOKEN: TOKEN };
  const result = options.real
    ? await runClosure(s.repo.spec, request, env)
    : await runClosure(s.repo.spec, request, env, {
        createHost: (madeHostOptions) => {
          hostOptions.push(madeHostOptions);
          return (options.createHost ?? (() => host!))(madeHostOptions);
        },
      });
  return { result, hostOptions };
}

/** The report of a run with the host that must not be refused. */
async function reportWithHost(
  s: Scenario,
  host: HostAdapter | null,
  options: Parameters<typeof closureWithHost>[2] = {},
) {
  const run = await closureWithHost(s, host, options);
  if (!run.result.ok) {
    throw new Error(`refused: ${run.result.code}: ${run.result.message}`);
  }
  return run.result.report;
}

/** One clean `ci` envelope at commit `c`, named by the run id `ciRun`. */
function ci(
  commit: string,
  ciRun: string = RUN,
  over: Partial<EnvelopeFields> = {},
): EnvelopeFields {
  return { commit, producer: "ci", ci_run: ciRun, ...over };
}

describe(
  "closure with --github-repo: the truth table of one pair",
  { timeout: 60_000 },
  () => {
    it("verified: ci_status verified, ci_unverified false, host reported, key order fixed", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.spec)]);
      const report = await reportWithHost(s, fakeHost().host);
      const row = rowOf(report, "TP-2");
      expect(row.ci_status).toBe("verified");
      expect(row.ci_unverified).toBe(false);
      expect(row.state).toBe("proven");
      expect(report.host).toEqual({ repo: REPOSITORY, api_url: null });
      expect(Object.keys(report)).toEqual([
        "format",
        "spec",
        "start",
        "head",
        "spec_commit",
        "host",
        "ok",
        "rows",
        "counts",
        "unknown_rows",
      ]);
      expect(Object.keys(row).at(-1)).toBe("ci_status");
    });

    it("the --api-url value is reported as api_url", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.spec)]);
      const report = await reportWithHost(s, fakeHost().host, {
        apiUrl: "http://127.0.0.1:1/api",
      });
      expect(report.host).toEqual({
        repo: REPOSITORY,
        api_url: "http://127.0.0.1:1/api",
      });
    });

    it.each(CI_RUN_STATES.filter((state) => state !== "verified"))(
      "%s: that status, ci_unverified true",
      async (state) => {
        const s = await scenario();
        writeEvidence(s.repo, "TP-2", [ci(s.spec)]);
        const row = rowOf(
          await reportWithHost(s, fakeHost(() => state).host),
          "TP-2",
        );
        expect(row.ci_status).toBe(state);
        expect(row.ci_unverified).toBe(true);
      },
    );

    it("a host that throws: host-failed, the report still printed, never a refusal", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.spec)]);
      const host = fakeHost(() => {
        throw new Error("github: GET /repos/acme/widgets/actions/runs failed");
      }).host;
      const run = await closureWithHost(s, host);
      expect(run.result.ok).toBe(true);
      if (!run.result.ok) return;
      const row = rowOf(run.result.report, "TP-2");
      expect(row.ci_status).toBe("host-failed");
      expect(row.ci_unverified).toBe(true);
    });

    it.each([
      ["verified with a space", "verified "],
      ["the word in capitals", "VERIFIED"],
      ["a boolean", true],
      ["a number", 7],
      ["null", null],
      ["undefined", undefined],
    ])(
      "an answer outside CI_RUN_STATES (%s): host-failed",
      async (_name, answer) => {
        const s = await scenario();
        writeEvidence(s.repo, "TP-2", [ci(s.spec)]);
        const row = rowOf(
          await reportWithHost(s, fakeHost(() => answer).host),
          "TP-2",
        );
        expect(row.ci_status).toBe("host-failed");
        expect(row.ci_unverified).toBe(true);
      },
    );

    it("no answer changes the state of a row whose only evidence is unverified ci evidence", async () => {
      // TP-1 red-first: a counted fail at `a` and a counted pass at `b`,
      // both `producer: ci`: `proven` offline, and `proven` with any host.
      const s = await scenario();
      writeEvidence(s.repo, "TP-1", [
        ci(s.a, "1", { result: "fail" }),
        ci(s.b, "2"),
      ]);
      const offline = rowOf(await reportIn(s), "TP-1");
      expect(offline.state).toBe("proven");
      for (const answer of ["verified", "unverified", "unknown", null]) {
        const host = fakeHost(() => {
          if (answer === null) throw new Error("the host is down");
          return answer;
        }).host;
        const row = rowOf(await reportWithHost(s, host), "TP-1");
        expect(row.state).toBe("proven");
        expect(row.reason).toBe(offline.reason);
      }
    });

    it("the worst status of a row's counted ci envelopes decides ci_status: host-failed beats unverified and verified", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [
        ci(s.spec, "1"),
        ci(s.spec, "2", { result: "fail" }),
        ci(s.spec, "3"),
      ]);
      const host = fakeHost((_commit, run) => {
        if (run === "1") throw new Error("down");
        return run === "2" ? "unverified" : "verified";
      }).host;
      const row = rowOf(await reportWithHost(s, host), "TP-2");
      expect(row.ci_status).toBe("host-failed");
      expect(row.ci_unverified).toBe(true);
    });

    it("unknown beats unverified, and any unverified makes the row ci_unverified even beside a verified pair", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-1", [
        ci(s.a, "1", { result: "fail" }),
        ci(s.b, "2"),
      ]);
      const row = rowOf(
        await reportWithHost(
          s,
          fakeHost((_commit, run) => (run === "1" ? "unverified" : "unknown"))
            .host,
        ),
        "TP-1",
      );
      expect(row.ci_status).toBe("unknown");
      expect(row.ci_unverified).toBe(true);
      const mixed = rowOf(
        await reportWithHost(
          s,
          fakeHost((_commit, run) => (run === "1" ? "verified" : "unknown"))
            .host,
        ),
        "TP-1",
      );
      expect(mixed.ci_status).toBe("unknown");
      expect(mixed.ci_unverified).toBe(true);
    });
  },
);

describe(
  "closure with --github-repo: one call per distinct pair",
  { timeout: 60_000 },
  () => {
    it("asks once per distinct (commit, ci_run), not once per envelope", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.a), ci(s.a)]);
      writeEvidence(s.repo, "TP-3", [ci(s.a)]);
      const made = fakeHost();
      await reportWithHost(s, made.host);
      expect(made.calls).toEqual([[s.a, RUN]]);
    });

    it("asks once per pair, across rows", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.a, "11")]);
      writeEvidence(s.repo, "TP-3", [ci(s.b, "22")]);
      const made = fakeHost();
      await reportWithHost(s, made.host);
      expect(made.calls).toEqual([
        [s.a, "11"],
        [s.b, "22"],
      ]);
    });

    it("asks nothing when no counted envelope is producer ci, and marks no row", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [{ commit: s.a }]);
      const made = fakeHost();
      const report = await reportWithHost(s, made.host);
      expect(made.calls).toEqual([]);
      expect(rowOf(report, "TP-2").ci_status).toBeUndefined();
      expect(report.host).toEqual({ repo: REPOSITORY, api_url: null });
    });
  },
);

describe(
  "closure with --github-repo: the dedup is over the whole (commit, ci_run) pair",
  { timeout: 60_000 },
  () => {
    it("asks once per pair for one run id at two commits, and does not share the answer", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-1", [
        ci(s.a, "7", { result: "fail" }),
        ci(s.b, "7"),
      ]);
      const made = fakeHost((commit) =>
        commit === s.a ? "verified" : "unverified",
      );
      const row = rowOf(await reportWithHost(s, made.host), "TP-1");
      expect(made.calls).toEqual([
        [s.a, "7"],
        [s.b, "7"],
      ]);
      expect(row.ci_unverified).toBe(true);
    });

    it("asks once per pair for two run ids at one commit, and keeps the answers apart", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.spec, "1"), ci(s.spec, "2")]);
      const made = fakeHost((_commit, run) =>
        run === "1" ? "verified" : "unverified",
      );
      const row = rowOf(await reportWithHost(s, made.host), "TP-2");
      expect(made.calls).toEqual([
        [s.spec, "1"],
        [s.spec, "2"],
      ]);
      expect(row.ci_status).toBe("unverified");
      expect(row.ci_unverified).toBe(true);
    });

    it("does not ask an ignored ci envelope, and it cannot mark the row", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [
        ci(s.spec, "1", { dirty: true }),
        ci(s.spec, "2"),
        { commit: s.spec, producer: "local" },
      ]);
      const made = fakeHost((_commit, run) =>
        run === "2" ? "verified" : "unverified",
      );
      const row = rowOf(await reportWithHost(s, made.host), "TP-2");
      expect(made.calls.map(([, run]) => run)).toEqual(["2"]);
      expect(row.ci_status).toBe("verified");
      expect(row.ci_unverified).toBe(false);
      expect(row.self_reported).toBe(true);
    });
  },
);

describe(
  "closure with --github-repo: an output that holds the token is withheld whole",
  { timeout: 60_000 },
  () => {
    it("withholds a report that holds the token (the host repo is the token)", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.spec)]);
      const result = await runClosure(
        s.repo.spec,
        {
          repo: s.repo.dir,
          defaultRef: REMOTE_MAIN,
          start: s.spec,
          githubRepo: TOKEN,
        },
        { GITHUB_TOKEN: TOKEN },
        { createHost: () => fakeHost().host },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("token-in-output");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it("withholds an unexpected host-construction error whose text holds the token", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.spec)]);
      const seams = {
        // eslint-disable-next-line no-unused-vars
        get createHost(): (options: GitHubHostOptions) => HostAdapter {
          throw new Error(`host construction broke on ${TOKEN}`);
        },
      };
      const result = await runClosure(
        s.repo.spec,
        {
          repo: s.repo.dir,
          defaultRef: REMOTE_MAIN,
          start: s.spec,
          githubRepo: REPOSITORY,
        },
        { GITHUB_TOKEN: TOKEN },
        seams,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("token-in-output");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });
  },
);

describe(
  "closure without --github-repo: nothing is asked",
  { timeout: 60_000 },
  () => {
    it("the adapter seam is never made and the report is the offline one, byte for byte", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.a)]);
      const offline = await reportIn(s);
      const run = await runClosure(
        s.repo.spec,
        { repo: s.repo.dir, defaultRef: REMOTE_MAIN, start: s.spec },
        { GITHUB_TOKEN: TOKEN },
        {
          createHost: () => {
            throw new Error("no host may be made without --github-repo");
          },
        },
      );
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(JSON.stringify(run.report)).toBe(JSON.stringify(offline));
      expect(run.report.host).toBeUndefined();
      expect(rowOf(run.report, "TP-2").ci_status).toBeUndefined();
      expect(rowOf(run.report, "TP-2").ci_unverified).toBe(true);
    });

    it("a set GITHUB_TOKEN changes nothing without --github-repo", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.a)]);
      const a = await runClosure(
        s.repo.spec,
        { repo: s.repo.dir, defaultRef: REMOTE_MAIN, start: s.spec },
        {},
      );
      const b = await runClosure(
        s.repo.spec,
        { repo: s.repo.dir, defaultRef: REMOTE_MAIN, start: s.spec },
        { GITHUB_TOKEN: TOKEN },
      );
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });

    it("refuses --api-url without --github-repo, unechoed", async () => {
      const s = await scenario();
      const result = await runClosure(
        s.repo.spec,
        {
          repo: s.repo.dir,
          defaultRef: REMOTE_MAIN,
          start: s.spec,
          apiUrl: "https://api.example/secret-root",
        },
        { GITHUB_TOKEN: TOKEN },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("host-input-invalid");
      expect(result.message).not.toContain("secret-root");
    });
  },
);

describe(
  "closure with --github-repo: the token and the refusals",
  { timeout: 60_000 },
  () => {
    it("makes the adapter from the flags and the token: no pull request, no apiUrl key by default", async () => {
      const s = await scenario();
      const run = await closureWithHost(s, fakeHost().host);
      expect(run.hostOptions).toEqual([
        {
          repository: REPOSITORY,
          pullRequest: NO_PULL_REQUEST,
          token: TOKEN,
        },
      ]);
    });

    it("refuses --github-repo without GITHUB_TOKEN", async () => {
      const s = await scenario();
      const run = await closureWithHost(s, fakeHost().host, { env: {} });
      expect(run.result.ok).toBe(false);
      if (run.result.ok) return;
      expect(run.result.code).toBe("token-missing");
      expect(run.result.message).toContain("GITHUB_TOKEN");
    });

    it("refuses an empty GITHUB_TOKEN", async () => {
      const s = await scenario();
      const run = await closureWithHost(s, fakeHost().host, {
        env: { GITHUB_TOKEN: "" },
      });
      expect(run.result.ok).toBe(false);
      if (run.result.ok) return;
      expect(run.result.code).toBe("token-missing");
    });

    it("refuses an unknown argument or option without repeating it", async () => {
      const s = await scenario();
      const run = await closureWithHost(s, fakeHost().host, {
        unknownArguments: 1,
      });
      expect(run.result.ok).toBe(false);
      if (run.result.ok) return;
      expect(run.result.code).toBe("unknown-argument");
      expect(run.result.message).toContain("is not repeated here");
      expect(run.result.message).toContain("GITHUB_TOKEN");
    });

    it("refuses a host input the adapter will not take, without echoing its value", async () => {
      const s = await scenario();
      const run = await closureWithHost(s, null, {
        createHost: () => {
          throw new Error("github: repository must be <owner>/<name>");
        },
      });
      expect(run.result.ok).toBe(false);
      if (run.result.ok) return;
      expect(run.result.code).toBe("host-input-invalid");
      expect(run.result.message).toBe(
        "github: repository must be <owner>/<name>",
      );
    });

    it("refuses a --github-repo the real adapter will not take, before any git read", async () => {
      const s = await scenario();
      const result = await runClosure(
        s.repo.spec,
        {
          repo: s.repo.dir,
          defaultRef: REMOTE_MAIN,
          start: "not-a-commit",
          githubRepo: "not a repository",
        },
        { GITHUB_TOKEN: TOKEN },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("host-input-invalid");
      expect(result.message).toBe("github: repository must be <owner>/<name>");
    });

    it("withholds a construction error whose text holds the token", async () => {
      const s = await scenario();
      const run = await closureWithHost(s, null, {
        createHost: () => {
          throw new Error(`the adapter broke on ${TOKEN}`);
        },
      });
      expect(run.result.ok).toBe(false);
      if (run.result.ok) return;
      expect(run.result.code).toBe("token-in-output");
      expect(run.result.message).not.toContain(TOKEN);
    });
  },
);

describe(
  "closure with --github-repo: against a stub host",
  { timeout: 60_000 },
  () => {
    let stub: Stub;

    beforeAll(async () => {
      stub = await Stub.start();
    });
    afterAll(async () => {
      await stub.close();
    });
    beforeEach(() => {
      stub.reset();
    });

    /** A workflow run as GitHub gives it, at `headSha`. */
    function runJson(headSha: string): Record<string, unknown> {
      return {
        id: Number(RUN),
        name: "ci",
        head_branch: "feature",
        head_sha: headSha,
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        repository: { full_name: REPOSITORY },
      };
    }

    it("the real adapter verifies a completed run of the repository at the commit", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.a)]);
      stub.on(RUN_PATH, { json: runJson(s.a) });
      const report = await reportWithHost(s, null, {
        real: true,
        apiUrl: stub.url,
      });
      expect(rowOf(report, "TP-2").ci_status).toBe("verified");
      expect(rowOf(report, "TP-2").ci_unverified).toBe(false);
      expect(stub.hits.map((hit) => hit.url)).toEqual([RUN_PATH]);
    });

    it("a run at another commit is unverified, not a pass", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.a)]);
      stub.on(RUN_PATH, { json: runJson(s.b) });
      const row = rowOf(
        await reportWithHost(s, null, { real: true, apiUrl: stub.url }),
        "TP-2",
      );
      expect(row.ci_status).toBe("unverified");
      expect(row.ci_unverified).toBe(true);
    });

    it("an unreachable host is host-failed: not a refusal, not a pass, not a new state", async () => {
      const s = await scenario();
      writeEvidence(s.repo, "TP-2", [ci(s.a)]);
      const row = rowOf(
        await reportWithHost(s, null, {
          real: true,
          apiUrl: "http://127.0.0.1:1",
        }),
        "TP-2",
      );
      expect(row.ci_status).toBe("host-failed");
      expect(row.ci_unverified).toBe(true);
      // The state without --github-repo of a pass at `a` with no pass at
      // the start commit, unchanged by the host failing.
      expect(row.state).toBe("unproven");
    });
  },
);

describe(
  "closure with --github-repo: the host is asked a bounded number of pairs at a time",
  { timeout: 60_000 },
  () => {
    /** A host that records the highest number of calls in flight at once. */
    function concurrencyHost(answer = "verified"): {
      host: HostAdapter;
      inFlightMax: () => number;
      calls: () => number;
    } {
      let inFlight = 0;
      let peak = 0;
      let started = 0;
      const host = {
        ciRunStatus: async () => {
          started += 1;
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((res) => setTimeout(res, 5));
          inFlight -= 1;
          return answer as never;
        },
      } as unknown as HostAdapter;
      return { host, inFlightMax: () => peak, calls: () => started };
    }

    it("never has more than four distinct pairs in flight", async () => {
      const s = await scenario();
      writeEvidence(
        s.repo,
        "TP-2",
        Array.from({ length: 10 }, (_, i) => ci(s.spec, String(1000 + i))),
      );
      const made = concurrencyHost();
      await reportWithHost(s, made.host);
      expect(made.calls()).toBe(10);
      expect(made.inFlightMax()).toBe(4);
    });

    it("asks every pair once when some host calls throw or reject, and keeps four in flight", async () => {
      const s = await scenario();
      writeEvidence(
        s.repo,
        "TP-2",
        Array.from({ length: 12 }, (_, i) => ci(s.spec, String(2000 + i))),
      );
      const asked: string[] = [];
      let inFlight = 0;
      let peak = 0;
      const host = {
        ciRunStatus: (_commit: string, run: string) => {
          asked.push(run);
          const k = Number(run) % 4;
          if (k === 1) throw new Error("sync throw");
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              inFlight -= 1;
              if (k === 2) reject(new Error("rejected"));
              else resolve("verified" as never);
            }, 5);
          });
        },
      } as unknown as HostAdapter;
      const report = await reportWithHost(s, host);
      expect([...asked].sort()).toEqual(
        Array.from({ length: 12 }, (_, i) => String(2000 + i)),
      );
      expect(peak).toBe(4);
      expect(JSON.stringify(report)).toContain('"ci_status":"host-failed"');
    });
  },
);

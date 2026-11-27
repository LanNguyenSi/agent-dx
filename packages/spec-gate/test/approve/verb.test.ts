/**
 * `runApproveCheck` in process, with the adapter and the check replaced:
 * what the verb hands on, how a result becomes an exit code, and that the
 * token reaches no output. The built command is run in `test/cli.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  TOKEN_VARIABLE,
  runApproveCheck,
  type ApproveCheckArgs,
  type ApproveCheckRun,
  type ApproveCheckSeams,
  type ApproveReport,
  type ApproveRequest,
  type ApproveResult,
} from "../../src/approve/index.js";
import type { GitHubHostOptions, HostAdapter } from "../../src/host/index.js";

/** Not a real token. */
const TOKEN = "spec-gate-verb-token-51c9a37f";

const ARGS: ApproveCheckArgs = {
  specDir: "specs/s1",
  repo: "/work/repo",
  defaultRef: "refs/remotes/origin/main",
  githubRepo: "acme/widgets",
  pr: "7",
};

/** A host that stands for the adapter the verb made; no method is called. */
const HOST = { made: "by the seam" } as unknown as HostAdapter;

const report = (over: Record<string, unknown> = {}): ApproveReport =>
  ({
    format: "spec-gate-approve/1",
    spec: "tiny-valid",
    approved: true,
    ...over,
  }) as unknown as ApproveReport;

interface Seen {
  hostOptions: GitHubHostOptions[];
  requests: ApproveRequest[];
}

/** Seams that record what they are given; `result` is what the check gives or throws. */
function seams(
  result: ApproveResult | (() => ApproveResult) = {
    kind: "report",
    report: report(),
  },
  createHost: () => HostAdapter = () => HOST,
): ApproveCheckSeams & { seen: Seen } {
  const seen: Seen = { hostOptions: [], requests: [] };
  return {
    seen,
    createHost: (options) => {
      seen.hostOptions.push(options);
      return createHost();
    },
    check: async (request) => {
      seen.requests.push(request);
      return typeof result === "function" ? result() : result;
    },
  };
}

const ENV = { [TOKEN_VARIABLE]: TOKEN };

/** Runs the verb and fails when an output holds the token. */
async function run(
  args: ApproveCheckArgs,
  env: Record<string, string | undefined>,
  using: ApproveCheckSeams,
): Promise<ApproveCheckRun> {
  const out = await runApproveCheck(args, env, using);
  expect(out.stdout.includes(TOKEN), "the token on stdout").toBe(false);
  expect(out.stderr.includes(TOKEN), "the token on stderr").toBe(false);
  return out;
}

const refusedWith = (text: string) => ({
  exitCode: 2,
  stdout: "",
  stderr: expect.stringContaining(text),
});

describe("runApproveCheck: what it hands on", () => {
  it("makes the adapter from --github-repo, --pr and the token of the environment, and leaves the API root to the adapter", async () => {
    const using = seams();
    await run(ARGS, ENV, using);
    expect(using.seen.hostOptions).toEqual([
      { repository: "acme/widgets", pullRequest: 7, token: TOKEN },
    ]);
    expect(Object.keys(using.seen.hostOptions[0]!)).not.toContain("apiUrl");
  });

  it("hands --api-url to the adapter as it is", async () => {
    const using = seams();
    await run({ ...ARGS, apiUrl: "http://127.0.0.1:1/api/v3" }, ENV, using);
    expect(using.seen.hostOptions[0]).toEqual({
      repository: "acme/widgets",
      pullRequest: 7,
      token: TOKEN,
      apiUrl: "http://127.0.0.1:1/api/v3",
    });
  });

  it("hands the spec directory, the repository, the default ref and the adapter to the check, without a base", async () => {
    const using = seams();
    await run(ARGS, ENV, using);
    expect(using.seen.requests).toEqual([
      {
        repo: "/work/repo",
        specDir: "specs/s1",
        defaultRef: "refs/remotes/origin/main",
        host: HOST,
      },
    ]);
    expect(Object.keys(using.seen.requests[0]!)).not.toContain("base");
    expect(using.seen.requests[0]!.host).toBe(HOST);
  });

  it("hands --base to the check as it is", async () => {
    const using = seams();
    await run({ ...ARGS, base: "b".repeat(40) }, ENV, using);
    expect(using.seen.requests[0]!.base).toBe("b".repeat(40));
  });

  it("without --merged the request names no mode: the check judges an open pull request", async () => {
    for (const args of [ARGS, { ...ARGS, merged: false }]) {
      const using = seams();
      await run(args, ENV, using);
      expect(Object.keys(using.seen.requests[0]!)).not.toContain("merged");
    }
  });

  it("hands --merged to the check as merged true, with and without --base", async () => {
    const using = seams();
    await run({ ...ARGS, merged: true }, ENV, using);
    expect(using.seen.requests).toEqual([
      {
        repo: "/work/repo",
        specDir: "specs/s1",
        defaultRef: "refs/remotes/origin/main",
        merged: true,
        host: HOST,
      },
    ]);
    const both = seams();
    await run({ ...ARGS, merged: true, base: "b".repeat(40) }, ENV, both);
    expect(both.seen.requests[0]).toMatchObject({
      merged: true,
      base: "b".repeat(40),
    });
  });

  it("a value of merged that only reads as true is not the flag", async () => {
    const using = seams();
    await run({ ...ARGS, merged: "true" as never }, ENV, using);
    expect(Object.keys(using.seen.requests[0]!)).not.toContain("merged");
  });
});

describe("runApproveCheck: exit codes", () => {
  it("0 and the report as one JSON line for a report that says approved", async () => {
    const approved = report();
    const out = await run(
      ARGS,
      ENV,
      seams({ kind: "report", report: approved }),
    );
    expect(out).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(approved)}\n`,
      stderr: "",
    });
  });

  it("1 and the report for a report that does not say approved", async () => {
    const not = report({ approved: false });
    const out = await run(ARGS, ENV, seams({ kind: "report", report: not }));
    expect(out).toEqual({
      exitCode: 1,
      stdout: `${JSON.stringify(not)}\n`,
      stderr: "",
    });
  });

  it.each([["yes"], [1], [null], [undefined], [{}]])(
    "1 for a report whose approved is %j: only the value true is an approval",
    async (approved) => {
      const out = await run(
        ARGS,
        ENV,
        seams({ kind: "report", report: report({ approved }) }),
      );
      expect(out.exitCode).toBe(1);
    },
  );

  it("2 and no report for a refusal of the check, never 1", async () => {
    const out = await run(
      ARGS,
      ENV,
      seams({ kind: "refused", message: "approve-check: no such directory" }),
    );
    expect(out).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "spec-gate: approve-check: no such directory\n",
    });
  });

  it("2 for an exception of the check, with its text on stderr", async () => {
    const out = await run(
      ARGS,
      ENV,
      seams(() => {
        throw new TypeError("a bug in the check");
      }),
    );
    expect(out).toEqual(
      refusedWith(
        "approve-check: unexpected error: TypeError: a bug in the check",
      ),
    );
  });

  it("2 for an error without a stack, with its message", async () => {
    const error = new RangeError("no stack here");
    error.stack = undefined;
    const out = await run(
      ARGS,
      ENV,
      seams(() => {
        throw error;
      }),
    );
    expect(out).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "spec-gate: approve-check: unexpected error: no stack here\n",
    });
  });

  it("2 for a value thrown that is no error", async () => {
    const out = await run(
      ARGS,
      ENV,
      seams(() => {
        throw "a text, thrown";
      }),
    );
    expect(out).toEqual(
      refusedWith("approve-check: unexpected error: a text, thrown\n"),
    );
  });

  it("2 with the adapter's own words when it refuses its options, and the check is not run", async () => {
    const using = seams(undefined, () => {
      throw new Error("github: repository must be <owner>/<name>");
    });
    const out = await run({ ...ARGS, githubRepo: "nope" }, ENV, using);
    expect(out).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "spec-gate: approve-check: github: repository must be <owner>/<name>\n",
    });
    expect(using.seen.requests).toEqual([]);
  });

  it("2 when the adapter throws a value that is no error", async () => {
    const using = seams(undefined, () => {
      throw "refused";
    });
    const out = await run(ARGS, ENV, using);
    expect(out).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "spec-gate: approve-check: refused\n",
    });
    expect(using.seen.requests).toEqual([]);
  });
});

describe("runApproveCheck: usage", () => {
  /** A refusal before anything was made or asked. */
  async function refusedEarly(
    args: ApproveCheckArgs,
    env: Record<string, string | undefined>,
  ): Promise<string> {
    const using = seams();
    const out = await run(args, env, using);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe("");
    expect(using.seen).toEqual({ hostOptions: [], requests: [] });
    return out.stderr;
  }

  it.each([
    ["no variable", {}],
    ["an empty variable", { [TOKEN_VARIABLE]: "" }],
    ["a variable that is undefined", { [TOKEN_VARIABLE]: undefined }],
    ["the token under another name", { GH_TOKEN: TOKEN, github_token: TOKEN }],
  ])("refuses without a token: %s", async (_what, env) => {
    expect(await refusedEarly(ARGS, env)).toBe(
      "spec-gate: approve-check: needs a token in the environment variable GITHUB_TOKEN; it is read from there only, never from an option\n",
    );
  });

  it.each([
    ["abc"],
    [""],
    ["0"],
    ["-7"],
    ["+7"],
    ["07"],
    ["7.0"],
    ["7e0"],
    ["0x7"],
    [" 7"],
    ["7 "],
    ["7\n"],
    ["7,8"],
    ["1234567890123456"],
    [TOKEN],
  ])("refuses --pr %j and does not repeat it", async (pr) => {
    const stderr = await refusedEarly({ ...ARGS, pr }, ENV);
    expect(stderr).toBe(
      "spec-gate: approve-check: --pr must be the number of the pull request: digits only, 1 or more\n",
    );
  });

  it.each([["1"], ["42"], ["123456789012345"]])(
    "accepts --pr %s as that number",
    async (pr) => {
      const using = seams();
      const out = await run({ ...ARGS, pr }, ENV, using);
      expect(out.exitCode).toBe(0);
      expect(using.seen.hostOptions[0]!.pullRequest).toBe(Number(pr));
      expect(Number.isSafeInteger(using.seen.hostOptions[0]!.pullRequest)).toBe(
        true,
      );
    },
  );

  it.each([[1], [3]])(
    "refuses %d arguments it does not know, with and without a token, and names the variable",
    async (unknownArguments) => {
      for (const env of [ENV, {}]) {
        const stderr = await refusedEarly({ ...ARGS, unknownArguments }, env);
        expect(stderr).toContain("an argument or option it does not know");
        expect(stderr).toContain("GITHUB_TOKEN only");
      }
    },
  );

  it("accepts a command line without an unknown argument", async () => {
    const out = await run({ ...ARGS, unknownArguments: 0 }, ENV, seams());
    expect(out.exitCode).toBe(0);
  });
});

describe("runApproveCheck: the token reaches no output", () => {
  const WITHHELD = {
    exitCode: 2,
    stdout: "",
    stderr:
      "spec-gate: approve-check: an output held the token and was withheld; nothing is reported\n",
  };

  it("a report that holds the token is withheld as a whole, approved or not", async () => {
    for (const approved of [true, false]) {
      const out = await run(
        ARGS,
        ENV,
        seams({
          kind: "report",
          report: report({ approved, spec: `id-${TOKEN}` }),
        }),
      );
      expect(out).toEqual(WITHHELD);
    }
  });

  it("a refusal that holds the token is withheld", async () => {
    const out = await run(
      ARGS,
      ENV,
      seams({ kind: "refused", message: `approve-check: ${TOKEN}` }),
    );
    expect(out).toEqual(WITHHELD);
  });

  it("an exception whose message and stack hold the token is withheld", async () => {
    const out = await run(
      ARGS,
      ENV,
      seams(() => {
        throw new Error(`request failed: Authorization: Bearer ${TOKEN}`);
      }),
    );
    expect(out).toEqual(WITHHELD);
  });

  it("an adapter refusal that holds the token is withheld", async () => {
    const out = await run(
      ARGS,
      ENV,
      seams(undefined, () => {
        throw new Error(`github: bad token ${TOKEN}`);
      }),
    );
    expect(out).toEqual(WITHHELD);
  });

  it("a token with characters JSON escapes is found in the report as JSON writes it", async () => {
    const odd = 'tok"en\\with-escapes-9d2e';
    const env = { [TOKEN_VARIABLE]: odd };
    const out = await runApproveCheck(
      ARGS,
      env,
      seams({ kind: "report", report: report({ spec: `id-${odd}` }) }),
    );
    expect(out).toEqual(WITHHELD);
    // The same report under another token is printed.
    const other = await runApproveCheck(
      ARGS,
      ENV,
      seams({ kind: "report", report: report({ spec: `id-${odd}` }) }),
    );
    expect(other.exitCode).toBe(0);
    expect(JSON.parse(other.stdout)).toMatchObject({ spec: `id-${odd}` });
  });

  it("an output without the token is passed on unchanged", async () => {
    const out = await run(ARGS, ENV, seams());
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(report());
  });
});

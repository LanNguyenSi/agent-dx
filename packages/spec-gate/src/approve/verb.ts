/**
 * `spec-gate approve-check`: the approval check for one pull request on
 * GitHub, as a command a CI job runs.
 *
 * It builds the GitHub host adapter and calls `checkApproval`. The verb is
 * the only caller in `src/approve/` that makes an adapter: `checkApproval`
 * itself stays a function of the facts it is handed and opens nothing.
 *
 * The token comes from the environment variable `GITHUB_TOKEN` and from
 * nowhere else. There is no option for it, and nothing this module returns
 * holds it: a refusal names the input that is wrong and never its value,
 * and an output that would hold the token is withheld as a whole.
 *
 * Exit codes: 0 for a report that says approved, 1 for a report that does
 * not, 2 for everything else (a usage error, a refusal, an exception).
 * Only exit 0 means approved.
 */
import {
  createGitHubHost,
  type GitHubHostOptions,
  type HostAdapter,
} from "../host/index.js";
import { checkApproval } from "./check.js";
import type { ApproveRequest, ApproveResult } from "./types.js";

/** The environment variable the token is read from. */
export const TOKEN_VARIABLE = "GITHUB_TOKEN";

/** The values of the command line, as texts. */
export interface ApproveCheckArgs {
  /** `<spec-dir>`. */
  specDir: string;
  /** `--repo`. */
  repo: string;
  /** `--default-ref`. */
  defaultRef: string;
  /** `--base`. */
  base?: string;
  /** `--github-repo`: `<owner>/<name>`. */
  githubRepo: string;
  /** `--pr`, as it was typed. */
  pr: string;
  /** `--api-url`. */
  apiUrl?: string;
  /** How many arguments and options the command line held that the verb does not know. */
  unknownArguments?: number;
}

/** What the command writes and how it ends. */
export interface ApproveCheckRun {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

/** What the verb calls. Replaced in tests only. */
export interface ApproveCheckSeams {
  // The base no-unused-vars rule reads the names in a signature as variables.
  // eslint-disable-next-line no-unused-vars
  createHost: (options: GitHubHostOptions) => HostAdapter;
  // eslint-disable-next-line no-unused-vars
  check: (request: ApproveRequest) => Promise<ApproveResult>;
}

/** The number of a pull request: digits without a sign, 1 or more, in the safe range. */
const PULL_NUMBER_RE = /^[1-9][0-9]{0,14}$/;

function refusal(message: string): ApproveCheckRun {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `spec-gate: approve-check: ${message}\n`,
  };
}

async function attempt(
  args: ApproveCheckArgs,
  token: string,
  seams: ApproveCheckSeams,
): Promise<ApproveCheckRun> {
  if ((args.unknownArguments ?? 0) > 0) {
    // What was not understood is not repeated: an argument given by mistake
    // may be a secret.
    return refusal(
      `takes one <spec-dir> and the options --repo, --default-ref, --base, --github-repo, --pr and --api-url; an argument or option it does not know was given (it is not repeated here). The token is read from ${TOKEN_VARIABLE} only`,
    );
  }
  if (!PULL_NUMBER_RE.test(args.pr)) {
    return refusal(
      "--pr must be the number of the pull request: digits only, 1 or more",
    );
  }
  if (token === "") {
    return refusal(
      `needs a token in the environment variable ${TOKEN_VARIABLE}; it is read from there only, never from an option`,
    );
  }
  let host: HostAdapter;
  try {
    host = seams.createHost({
      repository: args.githubRepo,
      pullRequest: Number(args.pr),
      token,
      ...(args.apiUrl !== undefined ? { apiUrl: args.apiUrl } : {}),
    });
  } catch (err) {
    // The adapter names the option that does not fit, never its value:
    // `repository` is --github-repo, `apiUrl` is --api-url.
    return refusal(err instanceof Error ? err.message : String(err));
  }
  const result = await seams.check({
    repo: args.repo,
    specDir: args.specDir,
    defaultRef: args.defaultRef,
    ...(args.base !== undefined ? { base: args.base } : {}),
    host,
  });
  if (result.kind === "refused") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `spec-gate: ${result.message}\n`,
    };
  }
  return {
    exitCode: result.report.approved === true ? 0 : 1,
    stdout: `${JSON.stringify(result.report)}\n`,
    stderr: "",
  };
}

/**
 * `run`, unless one of its outputs holds the token, as it is or as a JSON
 * text holds it: then nothing of the run is passed on and the exit code is
 * 2. No path of the verb is known to put the token into an output; this is
 * the last check before anything is written.
 */
function withoutToken(run: ApproveCheckRun, token: string): ApproveCheckRun {
  if (token === "") return run;
  const forms = [token, JSON.stringify(token).slice(1, -1)];
  if (
    !forms.some(
      (form) => run.stdout.includes(form) || run.stderr.includes(form),
    )
  ) {
    return run;
  }
  return refusal(
    "an output held the token and was withheld; nothing is reported",
  );
}

/**
 * Runs the verb. It never throws: an exception of the check or of the
 * adapter ends as exit 2 with its text on stderr.
 */
export async function runApproveCheck(
  args: ApproveCheckArgs,
  env: Readonly<Record<string, string | undefined>>,
  seams: ApproveCheckSeams = {
    createHost: createGitHubHost,
    check: checkApproval,
  },
): Promise<ApproveCheckRun> {
  const token = env[TOKEN_VARIABLE] ?? "";
  let run: ApproveCheckRun;
  try {
    run = await attempt(args, token, seams);
  } catch (err) {
    const text =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    run = refusal(`unexpected error: ${text}`);
  }
  return withoutToken(run, token);
}

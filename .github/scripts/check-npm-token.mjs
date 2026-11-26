#!/usr/bin/env node
// Check the NPM_AGENT_DX_TOKEN the operator workflows write with, before
// anything reaches the registry: is it still accepted by the registry
// (`npm whoami --registry https://registry.npmjs.org`), and is its tracked
// expiry (the single data file .github/npm-agent-dx-token.json) already past
// or inside the warn window?
//
// This exists because a presence test (`[ -z "$NPM_AGENT_DX_TOKEN" ]`)
// proves only that a string is configured: a revoked or expired token passes
// it and fails later, at the registry write, where npm masks an unauthorized
// request as a 404 and can even exit non-zero after a partial effect. Here a
// missing, revoked, rejected, expired or soon-expiring token all fail the
// same step before any write, and the weekly npm-token-check.yml schedule
// reports the same verdict before anyone needs the token at all.
//
// The token itself is never printed: npm's stderr is quoted in failure
// output only after every value the environment holds under
// NODE_AUTH_TOKEN or NPM_AGENT_DX_TOKEN has been redacted. The user name
// whoami prints is not a secret and is printed on success.
//
// The token reaches npm the way the registry-write steps get it: the step
// exports the secret as NODE_AUTH_TOKEN and actions/setup-node's .npmrc
// (`//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`) does the rest.
// This script never reads or writes the secret; it only spawns npm.
//
// Modes:
//   (no flags)   run the check: date file first, then `npm whoami`;
//                exit 0 when authenticated and outside the warn window,
//                exit 1 on any refusal (missing/invalid secret, non-zero
//                whoami, empty whoami user, malformed date file, past or
//                inside-window expiry)
//   --self-test  exercise the check against a stub npm and fixture date
//                files; no registry, no real token, no network
//
// Test hooks (not used by any workflow):
//   --date-file <path>     expiry data file (default: the
//                          npm-agent-dx-token.json next to this script's
//                          ../ directory, so a checkout always carries its
//                          own copy)
//   --today <YYYY-MM-DD>   override "today" for the date arithmetic
//
// A usage error (unknown flag, malformed --today) exits 2.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org";
const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ROTATE =
  "Rotate per CONTRIBUTING.md: new granular token on npmjs.com, update the NPM_AGENT_DX_TOKEN repository secret, and update the date in .github/npm-agent-dx-token.json in the same pull request.";

const SECRET_ENV_NAMES = ["NODE_AUTH_TOKEN", "NPM_AGENT_DX_TOKEN"];

// YYYY-MM-DD -> UTC milliseconds, rejecting shapes the Date constructor
// would silently coerce (2026-2-1, 2026-02-31, two-digit years).
function utcMs(dateStr, what) {
  const m = DATE_RE.exec(typeof dateStr === "string" ? dateStr : "");
  if (!m) throw new Error(`${what} '${dateStr}' is not YYYY-MM-DD`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    throw new Error(`${what} '${dateStr}' is not a real calendar date`);
  }
  return ms;
}

// Read and validate the expiry data file. Throws with the reason; the caller
// turns any throw into a ::error:: and exit 1.
function readDateFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read the expiry date file ${path}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`the expiry date file ${path} is not valid JSON`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`the expiry date file ${path} does not hold an object`);
  }
  const expires = data.expires;
  try {
    utcMs(expires, `${path} field 'expires'`);
  } catch (err) {
    throw new Error(`the expiry date file ${path}: ${err.message}`);
  }
  const warnDays = data.warn_days;
  if (!Number.isInteger(warnDays) || warnDays < 0) {
    throw new Error(`the expiry date file ${path}: field 'warn_days' must be a non-negative integer, got ${JSON.stringify(warnDays)}`);
  }
  return { expires, warnDays };
}

// Never let a token value reach the log, whatever npm decides to echo:
// replace every value the environment holds under the secret names.
function redact(text) {
  let out = String(text ?? "");
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];
    if (value && value.length >= 4) out = out.split(value).join("[redacted]");
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 300);
}

function runCheck({ dateFile, today }) {
  let meta;
  try {
    meta = readDateFile(dateFile);
  } catch (err) {
    console.log(`::error::${err.message}`);
    return 1;
  }
  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  let daysLeft;
  try {
    daysLeft = Math.round((utcMs(meta.expires, "expires") - utcMs(todayStr, "today")) / DAY_MS);
  } catch (err) {
    console.log(`::error::${err.message}`);
    return 1;
  }

  // Date verdicts first: they need no registry call, and an expired token
  // must be refused even while the registry would still accept it.
  if (daysLeft <= 0) {
    console.log(
      `::error::the NPM_AGENT_DX_TOKEN expiry tracked in ${dateFile} was ${meta.expires} (${daysLeft === 0 ? "today" : `${-daysLeft} day(s) ago`}): an expired token must not reach the registry. ${ROTATE}`,
    );
    return 1;
  }
  if (daysLeft <= meta.warnDays) {
    console.log(
      `::error::the NPM_AGENT_DX_TOKEN tracked in ${dateFile} expires on ${meta.expires}, ${daysLeft} day(s) left, inside the ${meta.warnDays}-day warn window; rotate it now, before an operator run discovers this at the registry. ${ROTATE}`,
    );
    return 1;
  }

  const run = spawnSync("npm", ["whoami", "--registry", REGISTRY], {
    encoding: "utf8",
    timeout: 60000,
  });
  if (run.error) {
    console.log(`::error::could not run npm whoami --registry ${REGISTRY}: ${redact(run.error.message)}`);
    return 1;
  }
  if (run.status !== 0) {
    console.log(
      `::error::npm whoami --registry ${REGISTRY} exited ${run.status}: the NPM_AGENT_DX_TOKEN secret is missing, revoked, or rejected by the registry; refusing to continue. npm said: ${redact(run.stderr || run.stdout)}`,
    );
    return 1;
  }
  const user = String(run.stdout ?? "").trim();
  if (!user) {
    console.log(`::error::npm whoami --registry ${REGISTRY} exited 0 but printed no user; treating the token as not authenticated.`);
    return 1;
  }
  console.log(
    `::notice::npm whoami: '${user}' is authenticated against ${REGISTRY}; the NPM_AGENT_DX_TOKEN expires ${meta.expires} (${daysLeft} day(s) left, warn window ${meta.warnDays} day(s)).`,
  );
  return 0;
}

function selfTest() {
  const self = fileURLToPath(import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), "check-npm-token-"));
  const TOKEN = "npm_sELfTestDONTprint_1234";
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const stub = join(bin, "npm");
    // $* lands in STUB_ARGS_FILE so a case can assert what the script
    // passed to npm; NODE_AUTH_TOKEN is echoed on demand to pin redaction.
    writeFileSync(
      stub,
      [
        "#!/usr/bin/env bash",
        'printf \'%s\\n\' "$*" > "${STUB_ARGS_FILE:?}"',
        'if [ -n "${STUB_NPM_ECHO_TOKEN:-}" ]; then printf \'npm error -a verbose npm leaked: %s\\n\' "${NODE_AUTH_TOKEN:-}" >&2; fi',
        'if [ -n "${STUB_NPM_OUT+set}" ]; then printf \'%s\\n\' "$STUB_NPM_OUT"; fi',
        'exit "${STUB_NPM_EXIT:-0}"',
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
    const dataFile = join(dir, "date.json");
    const argsFile = join(dir, "args.txt");

    // [name, date-file content (null: leave the file absent), extra argv,
    //  stub env, wanted exit, wanted stdout fragment(s), forbidden fragment]
    const far = JSON.stringify({ expires: "2026-06-10", warn_days: 7 });
    const cases = [
      [
        "valid token, expiry outside the warn window",
        far,
        ["--date-file", dataFile, "--today", "2026-05-01"],
        { STUB_NPM_OUT: "octocat" },
        0,
        ["authenticated", "octocat", "expires 2026-06-10", "40 day(s) left"],
        TOKEN,
      ],
      [
        "registry rejects the token (npm whoami exits non-zero)",
        far,
        ["--date-file", dataFile, "--today", "2026-05-01"],
        { STUB_NPM_EXIT: "1" },
        1,
        ["::error::", "exited 1", "missing, revoked"],
        TOKEN,
      ],
      [
        "whoami exits 0 but prints no user",
        far,
        ["--date-file", dataFile, "--today", "2026-05-01"],
        { STUB_NPM_OUT: "" },
        1,
        ["::error::", "printed no user"],
        TOKEN,
      ],
      [
        "whoami exits 0 but prints only whitespace",
        far,
        ["--date-file", dataFile, "--today", "2026-05-01"],
        { STUB_NPM_OUT: "   " },
        1,
        ["::error::", "printed no user"],
        TOKEN,
      ],
      [
        "expiry is today: expired, refused before any registry call",
        JSON.stringify({ expires: "2026-05-10", warn_days: 7 }),
        ["--date-file", dataFile, "--today", "2026-05-10"],
        { STUB_NPM_OUT: "octocat" },
        1,
        ["::error::", "expired", "today"],
        TOKEN,
      ],
      [
        "expiry is past",
        JSON.stringify({ expires: "2026-05-10", warn_days: 7 }),
        ["--date-file", dataFile, "--today", "2026-05-11"],
        { STUB_NPM_OUT: "octocat" },
        1,
        ["::error::", "expired", "1 day(s) ago"],
        TOKEN,
      ],
      [
        "inside the warn window at exactly warn_days: refused",
        JSON.stringify({ expires: "2026-05-17", warn_days: 7 }),
        ["--date-file", dataFile, "--today", "2026-05-10"],
        { STUB_NPM_OUT: "octocat" },
        1,
        ["::error::", "warn window", "7 day(s) left"],
        TOKEN,
      ],
      [
        "one day outside the warn window: passes",
        JSON.stringify({ expires: "2026-05-18", warn_days: 7 }),
        ["--date-file", dataFile, "--today", "2026-05-10"],
        { STUB_NPM_OUT: "octocat" },
        0,
        ["authenticated", "8 day(s) left"],
        TOKEN,
      ],
      [
        "missing date file is refused",
        null,
        ["--date-file", dataFile, "--today", "2026-05-01"],
        { STUB_NPM_OUT: "octocat" },
        1,
        ["::error::", "cannot read the expiry date file"],
        TOKEN,
      ],
      [
        "date file is not JSON",
        "not json {{{",
        ["--date-file", dataFile, "--today", "2026-05-01"],
        { STUB_NPM_OUT: "octocat" },
        1,
        ["::error::", "not valid JSON"],
        TOKEN,
      ],
      [
        "expires has a malformed shape",
        JSON.stringify({ expires: "2026-5-1", warn_days: 7 }),
        ["--date-file", dataFile, "--today", "2026-05-01"],
        { STUB_NPM_OUT: "octocat" },
        1,
        ["::error::", "not YYYY-MM-DD"],
        TOKEN,
      ],
      [
        "expires is not a real calendar date",
        JSON.stringify({ expires: "2026-02-31", warn_days: 7 }),
        ["--date-file", dataFile, "--today", "2026-05-01"],
        { STUB_NPM_OUT: "octocat" },
        1,
        ["::error::", "not a real calendar date"],
        TOKEN,
      ],
      [
        "warn_days missing is refused",
        JSON.stringify({ expires: "2026-06-10" }),
        ["--date-file", dataFile, "--today", "2026-05-01"],
        { STUB_NPM_OUT: "octocat" },
        1,
        ["::error::", "warn_days"],
        TOKEN,
      ],
      [
        "warn_days negative is refused",
        JSON.stringify({ expires: "2026-06-10", warn_days: -1 }),
        ["--date-file", dataFile, "--today", "2026-05-01"],
        { STUB_NPM_OUT: "octocat" },
        1,
        ["::error::", "warn_days"],
        TOKEN,
      ],
      [
        "a verbose npm leaking the token on stderr is redacted",
        far,
        ["--date-file", dataFile, "--today", "2026-05-01"],
        { STUB_NPM_EXIT: "1", STUB_NPM_ECHO_TOKEN: "1" },
        1,
        ["::error::", "[redacted]"],
        TOKEN,
      ],
      [
        "malformed --today is a usage error",
        far,
        ["--date-file", dataFile, "--today", "2026-5-1"],
        { STUB_NPM_OUT: "octocat" },
        2,
        ["usage:"],
        TOKEN,
      ],
      [
        "unknown flag is a usage error, never silently ignored",
        far,
        ["--date-filee", dataFile],
        { STUB_NPM_OUT: "octocat" },
        2,
        ["usage:"],
        TOKEN,
      ],
      [
        "the date file is read before npm runs: bad file, npm that would succeed, still exit 1",
        "not json {{{",
        ["--date-file", dataFile, "--today", "2026-05-01"],
        { STUB_NPM_OUT: "octocat" },
        1,
        ["::error::", "not valid JSON"],
        TOKEN,
      ],
    ];

    let failed = 0;
    let total = 0;
    for (const [name, content, args, stubEnv, wantedExit, fragments, forbidden] of cases) {
      total++;
      if (content === null) {
        rmSync(dataFile, { force: true });
      } else {
        writeFileSync(dataFile, content);
      }
      const run = spawnSync(process.execPath, [self, ...args], {
        encoding: "utf8",
        timeout: 20000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          NODE_AUTH_TOKEN: TOKEN,
          STUB_ARGS_FILE: argsFile,
          ...stubEnv,
        },
      });
      const combined = `${run.stdout}\n${run.stderr}`;
      const pass =
        run.status === wantedExit &&
        fragments.every((f) => combined.includes(f)) &&
        !combined.includes(forbidden);
      if (!pass) failed++;
      console.log(
        `  ${pass ? "PASS" : "FAIL"}  ${name} (wanted exit ${wantedExit}; got exit ${run.status}: ${combined.trim().slice(0, 100)})`,
      );
    }

    // The stub always saw the documented npm invocation, not a bare whoami.
    total++;
    writeFileSync(dataFile, far);
    spawnSync(process.execPath, [self, "--date-file", dataFile, "--today", "2026-05-01"], {
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NODE_AUTH_TOKEN: TOKEN,
        STUB_ARGS_FILE: argsFile,
        STUB_NPM_OUT: "octocat",
      },
    });
    const seenArgs = readFileSync(argsFile, "utf8").trim();
    const argsPass = seenArgs === `whoami --registry ${REGISTRY}`;
    if (!argsPass) failed++;
    console.log(`  ${argsPass ? "PASS" : "FAIL"}  npm was invoked as 'whoami --registry ${REGISTRY}' (got '${seenArgs}')`);

    // Without --date-file the check reads the repository's own data file
    // (resolved from the script's location, not the working directory):
    // a --today in the deep past must land outside every plausible warn
    // window, so exit 0 proves the default file was found and parsed.
    total++;
    const viaDefault = spawnSync(process.execPath, [self, "--today", "2026-05-01"], {
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NODE_AUTH_TOKEN: TOKEN,
        STUB_ARGS_FILE: argsFile,
        STUB_NPM_OUT: "octocat",
      },
    });
    const defaultPass = viaDefault.status === 0 && viaDefault.stdout.includes("authenticated");
    if (!defaultPass) failed++;
    console.log(
      `  ${defaultPass ? "PASS" : "FAIL"}  no --date-file: the repository's own expiry file is used (got exit ${viaDefault.status}: ${viaDefault.stdout.trim().slice(0, 100)})`,
    );

    if (failed > 0) {
      console.error(`::error::${failed} self-test case(s) failed; refusing to trust the token check`);
      process.exit(1);
    }
    console.log(`check-npm-token self-test: ${total} cases pass`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function usage() {
  console.error(
    "usage: check-npm-token.mjs [--date-file <path>] [--today YYYY-MM-DD] | --self-test",
  );
  return 2;
}

function runCli(argv) {
  if (argv.includes("--self-test")) {
    selfTest();
    return 0;
  }
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const dateFile = get("--date-file") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "npm-agent-dx-token.json");
  const today = get("--today");
  if (today !== undefined && !DATE_RE.test(today)) {
    usage();
    return 2;
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--date-file" || arg === "--today") {
      if (i + 1 >= argv.length) {
        console.error(`missing value for ${arg}`);
        usage();
        return 2;
      }
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      console.error(`unknown flag: ${arg}`);
      usage();
      return 2;
    }
    console.error(`unexpected argument: ${arg}`);
    usage();
    return 2;
  }
  return runCheck({ dateFile, today });
}

process.exit(runCli(process.argv.slice(2)));

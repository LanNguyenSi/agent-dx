import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Isolation of a replayed review session and of its setup commands: the
 * per-run scratch layout, the environment allowlist, and the Claude Code
 * settings that sandbox the session. Every settings key below names the
 * documentation section it was checked against (Claude Code 2.1.302); a key
 * Claude Code does not know is ignored without an error in `-p` mode ("Settings
 * files that fail validation are silently ignored", `claude --help`), so the
 * `canary` command is the proof that the keys take effect.
 */

/* ------------------------------------------------------------------ */
/* Scratch layout                                                       */
/* ------------------------------------------------------------------ */

export interface RunScratch {
  /** `<scratch root>/<random id>`: nothing in the path names the variant or the entry. */
  root: string;
  id: string;
  /** The checkout under review; the session's working directory. */
  checkout: string;
  /** The session's own evidence directory ({{EVIDENCE_DIR}}). */
  evidence: string;
  /** An empty directory standing in for the run directory ({{RUN_DIR}}). */
  runFiles: string;
  /** HOME of the session and the setup commands. */
  home: string;
  /** CLAUDE_CONFIG_DIR of the session. */
  configDir: string;
  /** TMPDIR (and Claude Code's own temp root) of the session. */
  tmp: string;
  /** An empty GH_CONFIG_DIR. */
  gh: string;
  /** Session-only files: agent definition, settings, prompt, raw output. Read-denied to the session. */
  meta: string;
}

const ID_BYTES = 6;

/** Creates a fresh run directory with an opaque name under `scratchRoot`. */
export function createRunScratch(scratchRoot: string): RunScratch {
  mkdirSync(scratchRoot, { recursive: true });
  const base = realpathSync(scratchRoot);
  for (;;) {
    const id = randomBytes(ID_BYTES).toString("hex");
    const root = join(base, id);
    if (existsSync(root)) continue;
    const scratch: RunScratch = {
      root,
      id,
      checkout: join(root, "checkout"),
      evidence: join(root, "evidence"),
      runFiles: join(root, "run"),
      home: join(root, "home"),
      configDir: join(root, "home", ".claude"),
      tmp: join(root, "tmp"),
      gh: join(root, "gh"),
      meta: join(root, "meta"),
    };
    for (const dir of [
      scratch.evidence,
      scratch.runFiles,
      scratch.configDir,
      scratch.tmp,
      scratch.gh,
      scratch.meta,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    return scratch;
  }
}

/**
 * Default scratch root: a directory outside the home directory and outside
 * every temp root, because the session's file-tool deny rules cover both (a
 * checkout inside either would be unreadable to its own session). Only macOS
 * has such a place without configuration (`/Users/Shared`); elsewhere the
 * caller must pass `--scratch`, and this returns null.
 */
export function defaultScratchRoot(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (platform === "darwin" && exists("/Users/Shared"))
    return "/Users/Shared/ow-eval";
  return null;
}

/** Shared npm cache of the setup commands, under the scratch root. */
export function setupNpmCache(scratchRoot: string): string {
  return join(scratchRoot, "npm-cache");
}

/* ------------------------------------------------------------------ */
/* Environment allowlist                                                */
/* ------------------------------------------------------------------ */

/** The only variables copied from the invoking environment (plus every `LC_*`). */
export const PASSED_ENV = [
  "PATH",
  "LANG",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
] as const;

/** Fixed values that keep git and gh away from the user's configuration and credentials. */
export const FIXED_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_SSH_COMMAND: "false",
  GIT_TERMINAL_PROMPT: "0",
};

function passed(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSED_ENV) {
    if (base[name] !== undefined) env[name] = base[name];
  }
  for (const [name, value] of Object.entries(base)) {
    if (name.startsWith("LC_") && value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Minimal environment for git commands the tool runs on the host itself
 * (reading a prompt revision, finding the repository root): the passed
 * variables and the fixed git settings, nothing else.
 */
export function hostGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...passed(base), ...FIXED_ENV };
}

export interface ChildEnvOptions {
  scratch: Pick<RunScratch, "home" | "configDir" | "tmp" | "gh">;
  npmCache: string;
  /**
   * The API key, for the claude process only. Setup commands never get one;
   * the session gets it as ANTHROPIC_API_KEY whatever variable it came from.
   */
  apiKey?: string;
}

/**
 * Environment of a setup command: the allowlist, a scratch HOME, TMPDIR,
 * Claude config dir, empty gh config and npm cache, and the fixed git
 * settings. Everything else in `base` (tokens, sockets, session ids, the API
 * key) is dropped. SSH_AUTH_SOCK is never set.
 */
export function setupEnv(
  base: NodeJS.ProcessEnv,
  options: Omit<ChildEnvOptions, "apiKey">,
): NodeJS.ProcessEnv {
  return {
    ...passed(base),
    ...FIXED_ENV,
    HOME: options.scratch.home,
    CLAUDE_CONFIG_DIR: options.scratch.configDir,
    TMPDIR: options.scratch.tmp,
    GH_CONFIG_DIR: options.scratch.gh,
    npm_config_cache: options.npmCache,
  };
}

/**
 * Environment of the claude process: the setup environment plus the API key
 * and CLAUDE_CODE_TMPDIR, which moves Claude Code's own temp files, and the
 * per-user temp directory sandboxed commands may write to, into the run
 * scratch (env-vars docs, CLAUDE_CODE_TMPDIR) instead of the temp root shared
 * with the user's other sessions. CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is never
 * set: in Claude Code 2.1.302 it forces the permission mode to `default`
 * whatever `--permission-mode` says, and a headless session then stalls on
 * its first approval. The sandbox's credential setting keeps the key out of
 * Bash commands instead (`sessionSettings`).
 */
export function sessionEnv(
  base: NodeJS.ProcessEnv,
  options: ChildEnvOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...setupEnv(base, options),
    CLAUDE_CODE_TMPDIR: options.scratch.tmp,
  };
  if (options.apiKey !== undefined) env.ANTHROPIC_API_KEY = options.apiKey;
  return env;
}

/* ------------------------------------------------------------------ */
/* Protected paths                                                      */
/* ------------------------------------------------------------------ */

/** True when `child` is `parent` or lies inside it (both absolute). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A path and, when it differs, its resolved form (symlinks followed). */
export function pathForms(path: string): string[] {
  const abs = resolve(path);
  const real = realOrSelf(abs);
  return real === abs ? [abs] : [abs, real];
}

/** Home directory of the invoking user, the root of the read denial. */
export function protectedHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  return home !== undefined && isAbsolute(home) ? home : homedir();
}

const RULE_UNSAFE = /[*?[\]\\()]/;

/**
 * Refuses a scratch or results directory that the session's deny rules would
 * cover (so its own checkout would be unreadable) or that sits in the
 * dataset's parent tree (where the session's paths would name the dataset).
 * Returns an error message, or null.
 */
export function checkPlacement(options: {
  scratchRoot: string;
  outDir: string;
  datasetDir: string;
  home: string;
  /** Shared temp roots; defaults to `systemTempRoots()`. */
  tempRoots?: string[];
}): string | null {
  const scratch = pathForms(options.scratchRoot);
  const out = pathForms(options.outDir);
  const datasetParent = pathForms(dirname(resolve(options.datasetDir)));
  const home = pathForms(options.home);
  const tempRoots = uniq(
    (options.tempRoots ?? systemTempRoots()).flatMap(pathForms),
  );
  const inside = (a: string[], b: string[]): boolean =>
    a.some((x) => b.some((y) => isInside(x, y)));
  if (inside(scratch, datasetParent))
    return `--scratch ${options.scratchRoot} is inside the dataset's parent directory; choose a directory outside it`;
  if (inside(out, datasetParent))
    return `--out ${options.outDir} is inside the dataset's parent directory; choose a directory outside it`;
  if (inside(scratch, home))
    return `--scratch ${options.scratchRoot} is inside the home directory, which the file-tool deny rules cover, so the session could not read its own checkout; choose a directory outside the home directory and the temp roots`;
  if (inside(scratch, tempRoots))
    return `--scratch ${options.scratchRoot} is inside a temp root (${tempRoots.join(", ")}), which the file-tool deny rules cover, so the session could not read its own checkout; choose a directory outside the home directory and the temp roots`;
  if (inside(scratch, out))
    return `--scratch ${options.scratchRoot} is inside --out, which the session may not read`;
  for (const path of [...scratch, ...out, ...datasetParent, ...home]) {
    if (RULE_UNSAFE.test(path))
      return `path ${path} contains a character that permission rules treat as a pattern`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Session settings                                                     */
/* ------------------------------------------------------------------ */

/**
 * Tools the session may not use. File edits, as in the shipped agent; the
 * subagent and web tools; and every tool that reaches another session, a
 * remote service, a schedule or a notification (tools-reference docs, tools
 * table): SendMessage and ListAgents are the cross-session pair
 * (cross-session-messaging docs, "Turn off cross-session messaging").
 */
export const DISALLOWED_TOOLS = [
  "Agent",
  "WebFetch",
  "WebSearch",
  "Edit",
  "Write",
  "NotebookEdit",
  "SendMessage",
  "ListAgents",
  "TaskStop",
  "Workflow",
  "Artifact",
  "PushNotification",
  "RemoteTrigger",
  "SendUserFile",
  "ShareOnboardingGuide",
  "SendFeedback",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "Monitor",
  "EnterWorktree",
  "ExitWorktree",
];

export interface SessionSettingsInput {
  scratch: Pick<
    RunScratch,
    "checkout" | "evidence" | "runFiles" | "home" | "tmp" | "meta"
  >;
  /** The scratch root: other runs' directories live there. */
  scratchRoot: string;
  /** Directories the session may not read at all: the user's home, the dataset tree, the results directory, the source repositories. */
  denied: string[];
  /** Shared temp roots (`systemTempRoots()`): read-denied to Bash commands; this run's own scratch is re-opened by the narrower allowRead entries. */
  tempRoots: string[];
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

/**
 * The host's shared temp roots: the resolved `os.tmpdir()` and `/private/tmp`
 * with its `/tmp` alias, each in every form that exists. Other sessions keep
 * their task output there.
 */
export function systemTempRoots(): string[] {
  return uniq(
    [tmpdir(), "/private/tmp", "/tmp"]
      .filter((path) => existsSync(path))
      .flatMap(pathForms),
  );
}

/** `//abs/path` form of a permission rule path (permissions docs, "Read and Edit"). */
function rulePath(path: string): string {
  return `/${path}`;
}

/**
 * The per-run settings passed with `--settings`. Paths are absolute; the
 * permission rules use the `//` prefix, which anchors at the filesystem root
 * (permissions docs, "Read and Edit": a single leading slash anchors at the
 * settings file's directory instead).
 */
export function sessionSettings(
  input: SessionSettingsInput,
): Record<string, unknown> {
  const { scratch } = input;
  const denied = uniq(input.denied.flatMap(pathForms));
  const own = [
    scratch.checkout,
    scratch.evidence,
    scratch.runFiles,
    scratch.home,
    scratch.tmp,
  ];
  // The temp roots get the same file-tool denial as the home: other sessions keep their task
  // output there, and Read/Edit are not covered by the sandbox's denyRead. The run's own
  // scratch must therefore lie outside them (`checkPlacement`).
  const tempDenied = uniq(input.tempRoots.flatMap(pathForms));
  const fileRules = uniq([...denied, ...tempDenied, scratch.meta]).flatMap(
    (path) => [
      `Read(${rulePath(path)})`,
      `Read(${rulePath(path)}/**)`,
      `Edit(${rulePath(path)})`,
      `Edit(${rulePath(path)}/**)`,
    ],
  );
  return {
    sandbox: {
      // settings-reference#sandbox-enabled: sandbox Bash commands.
      enabled: true,
      // settings-reference#sandbox-failifunavailable: exit at startup instead of running unsandboxed.
      failIfUnavailable: true,
      // settings-reference#sandbox-allowunsandboxedcommands: false ignores dangerouslyDisableSandbox (strict sandbox mode).
      allowUnsandboxedCommands: false,
      // settings-reference#sandbox-excludedcommands: no command runs outside the sandbox.
      excludedCommands: [],
      network: {
        // settings-reference#sandbox-network-alloweddomains: no host is allowed.
        allowedDomains: [],
        // settings-reference#sandbox-network-strictallowlist: deny hosts outside the (empty) allowlist
        // instead of deciding by permission mode; bypassPermissions would otherwise allow them
        // (sandboxing docs, "Hosts outside your allowed domains"). Honoured from --settings
        // (sandboxing docs, "Network isolation").
        strictAllowlist: true,
        // settings-reference#sandbox-network-allowunixsockets: no socket path (macOS).
        allowUnixSockets: [],
        // settings-reference#sandbox-network-allowallunixsockets: no Unix socket at all.
        allowAllUnixSockets: false,
        // settings-reference#sandbox-network-allowlocalbinding: no listening, no localhost connections (macOS).
        allowLocalBinding: false,
      },
      // Settings schema of Claude Code 2.1.302, sandbox.credentials.envVars: "`deny` unsets the
      // variable for sandboxed commands". Keeps the API key out of Bash commands.
      credentials: {
        envVars: [{ name: "ANTHROPIC_API_KEY", mode: "deny" }],
      },
      filesystem: {
        // settings-reference#sandbox-filesystem-denyread: the protected trees, every other run's
        // scratch and the shared temp roots.
        denyRead: uniq([
          ...denied,
          ...pathForms(input.scratchRoot),
          ...input.tempRoots.flatMap(pathForms),
        ]),
        // settings-reference#sandbox-filesystem-allowread: the narrower path wins (sandboxing docs,
        // "Configure sandboxing"), so this re-opens only this run's own directories; meta stays denied.
        allowRead: own,
        // settings-reference#sandbox-filesystem-allowwrite: the checkout, the evidence directory, the
        // scratch tmp and the scratch home. With only the evidence directory listed, a sandboxed
        // command can write neither the checkout nor the temp directory, and Claude Code falls
        // back to a per-user directory under the shared temp root, which is denied (measured on
        // Claude Code 2.1.302). meta, the run files and the other runs' scratch stay unwritable.
        allowWrite: [
          scratch.checkout,
          scratch.evidence,
          scratch.tmp,
          scratch.home,
        ],
        // settings-reference#sandbox-filesystem-denywrite: never the protected trees.
        denyWrite: denied,
      },
    },
    permissions: {
      // settings-reference#permissions-deny: deny rules block in every mode, bypassPermissions
      // included (permission-modes docs, "Available modes"). Read rules also cover Grep and Glob
      // (permissions docs, "Read and Edit"); a Glob(...) or Grep(...) path rule is accepted but
      // never consulted, so none is written.
      deny: [...fileRules, "SendMessage", "ListAgents"],
      // permissions.blockReadsOutsideWorkingDirectories is deliberately not set: together with the
      // enabled sandbox it hangs the session before its first tool call, with no output, 0 % CPU
      // and SIGTERM ignored (measured on Claude Code 2.1.302, one-line prompt on a small model).
      // The file tools' reach is limited by the Read/Edit deny rules above instead.
    },
    // cross-session-messaging docs, "Control inbound messages": drop every inbound peer message.
    crossSessionInbound: "refuse",
    // cross-session-messaging docs, "Require approval for cross-machine messages".
    isolatePeerMachines: true,
  };
}

/* ------------------------------------------------------------------ */
/* Secret scan                                                          */
/* ------------------------------------------------------------------ */

const SECRET_NAME = /TOKEN|SECRET|PASSW|CREDENTIAL|API_?KEY|_KEY$|AUTH/i;
const MIN_SECRET_VALUE = 12;

/**
 * Names the sandbox and git use to pass git configuration through the
 * environment (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`).
 * They hold git config key names and values, not credentials, so a name check
 * that matches on "KEY" must not count them.
 */
const GIT_CONFIG_ENV_NAME = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/;

/** True for the git configuration pass-through names (never a secret by name). */
export function isGitConfigEnvName(name: string): boolean {
  return GIT_CONFIG_ENV_NAME.test(name);
}

export const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Anthropic key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  {
    name: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
];

/**
 * Values that must never appear in a record: the API key and every value of
 * a credential-looking variable of the invoking environment.
 */
export function secretValues(
  base: NodeJS.ProcessEnv,
  apiKey?: string,
): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  if (apiKey !== undefined && apiKey.length > 0)
    out.push({ name: "the API key", value: apiKey });
  for (const [name, value] of Object.entries(base)) {
    if (
      value !== undefined &&
      value.length >= MIN_SECRET_VALUE &&
      SECRET_NAME.test(name)
    ) {
      out.push({ name: `the value of ${name}`, value });
    }
  }
  return out;
}

/** What a text leaks, by kind only: the matched value is never returned. */
export function scanForSecrets(
  text: string,
  values: { name: string; value: string }[],
): string[] {
  const hits: string[] = [];
  for (const { name, value } of values) {
    if (value.length > 0 && text.includes(value)) hits.push(name);
  }
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) hits.push(name);
  }
  return uniq(hits);
}

/** The text with every listed value and every secret pattern replaced by a label. */
export function redactSecrets(
  text: string,
  values: { name: string; value: string }[],
): string {
  let out = text;
  for (const { name, value } of values) {
    if (value.length > 0) out = out.split(value).join(`<redacted: ${name}>`);
  }
  for (const { name, pattern } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, "g"), `<redacted: ${name}>`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Redaction for the blind judge                                        */
/* ------------------------------------------------------------------ */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces each path (and its resolved form) with its label, longest first.
 * A `whole` path is replaced together with whatever path follows it (under a
 * results directory the rest names the variant and the entry); otherwise
 * only the prefix goes, so `<worktree>/src/a.ts` keeps the file it names.
 */
export function redactPaths(
  text: string,
  paths: { path: string; label: string; whole?: boolean }[],
): string {
  const pairs = paths
    .flatMap(({ path, label, whole }) =>
      pathForms(path).map((p) => ({ p, label, whole: whole === true })),
    )
    .filter(({ p }) => p.length > 1)
    .sort((a, b) => b.p.length - a.p.length);
  let out = text;
  for (const { p, label, whole } of pairs) {
    out = whole
      ? out.replace(
          new RegExp(`${escapeRegExp(p)}(?:/[^\\s"'\`<>()\\[\\]{}]*)?`, "g"),
          // Sentence punctuation after the path stays.
          (match) => label + (/[.,;:!?]+$/.exec(match)?.[0] ?? ""),
        )
      : out.split(p).join(label);
  }
  return out;
}

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
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

/** Random bytes of a run id: 8 hex characters, short because the temp path must stay short. */
const ID_BYTES = 4;

/**
 * Claude Code 2.1.302 keeps `CLAUDE_CODE_TMPDIR` only while
 * `Buffer.byteLength(join(CLAUDE_CODE_TMPDIR, "claude-<uid>")) <= 44` (the
 * constant `E1r = 44` in its bundled source, with the warning "Shorten
 * CLAUDE_CODE_TMPDIR to <=~30 bytes"). Over it, Claude Code falls back to
 * `/tmp/claude-<uid>`, which the session's deny rules cover, so every
 * sandboxed command fails on its own working-directory file (measured: a 38
 * byte tmp path fell back for uid 501, 31 and 29 bytes worked).
 */
export const CLAUDE_TMPDIR_MAX_BYTES = 44;

/** The uid Claude Code puts into its temp directory name (`process.getuid?.() ?? 0`, as Claude Code itself). */
export function currentUid(): number {
  return process.getuid?.() ?? 0;
}

/**
 * Longest scratch tmp path (`<scratch root>/<run id>/tmp`), in bytes, that
 * Claude Code accepts as `CLAUDE_CODE_TMPDIR` for `uid`: 44, less the path
 * separator, less the bytes of `claude-<uid>` (33 for uid 501).
 */
export function maxTmpPathBytes(uid: number = currentUid()): number {
  return CLAUDE_TMPDIR_MAX_BYTES - 1 - Buffer.byteLength(`claude-${uid}`);
}

/** Characters of a run id (hex, one byte each), for the placement check's length estimate. */
export const RUN_ID_LENGTH = ID_BYTES * 2;

/**
 * Bytes of the tmp path a run under `scratchRoot` gets, in the longest form
 * of the root (symlinks followed or not): `<root>/<run id>/tmp`.
 */
export function scratchTmpPathBytes(scratchRoot: string): number {
  const longest = Math.max(
    ...pathForms(scratchRoot).map((p) => Buffer.byteLength(p)),
  );
  return longest + 1 + RUN_ID_LENGTH + "/tmp".length;
}

/** Mode of the scratch root and of every run directory: only the owner can enter them. */
export const SCRATCH_DIR_MODE = 0o700;

const STICKY = 0o1000;

/**
 * The first ancestor of `path` (nearest first, `path` itself excluded) that
 * another account can write, as an error fragment, or null. An ancestor is
 * unsafe when it is neither yours nor root's, or when the group or others can
 * write it without the sticky bit: either lets another account rename or
 * replace the next directory down the chain, and with it the scratch root.
 * A sticky directory (`/tmp`, `/Users/Shared`) only lets an account remove
 * its own entries, so it passes. The chain is followed through the resolved
 * path of the nearest existing directory, so symlinks in the path are
 * followed, not trusted.
 */
export function unsafeAncestor(
  path: string,
  uid: number | null,
): string | null {
  // `path` itself is judged by the caller. Start at its parent, or, when it
  // does not exist yet, at the nearest existing directory (where it will be
  // created); both through the resolved path.
  let dir = resolve(path);
  const exists = existsSync(dir);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  let current = exists ? dirname(realpathSync(dir)) : realpathSync(dir);
  for (;;) {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(current);
    } catch {
      return null;
    }
    if (uid !== null && st.uid !== uid && st.uid !== 0)
      return `${current} is owned by uid ${st.uid}, who could replace the directories below it`;
    if ((st.mode & 0o022) !== 0 && (st.mode & STICKY) === 0)
      return `${current} can be written by the group or others without the sticky bit (mode ${(st.mode & 0o7777).toString(8)}), so another account could rename or replace the directories below it`;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Refuses a scratch root another account could control: a symbolic link, a
 * directory owned by another uid, one the group or others can write (the
 * default root sits in the world-writable, sticky `/Users/Shared`, where
 * another account could create it first), or one below an ancestor another
 * account can write without the sticky bit (see `unsafeAncestor`). A root that
 * does not exist yet passes its own checks: `createRunScratch` creates it with
 * mode 0700; the ancestors are still checked, from the directory it will be
 * created in. Returns an error message, or null.
 */
export function checkScratchRoot(
  scratchRoot: string,
  uid: number | null = process.getuid?.() ?? null,
): string | null {
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(scratchRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return `--scratch ${scratchRoot} cannot be inspected: ${error instanceof Error ? error.message : error}`;
  }
  if (st !== null) {
    if (st.isSymbolicLink())
      return `--scratch ${scratchRoot} is a symbolic link; pass the directory itself, owned by you and writable only by you`;
    if (!st.isDirectory()) return `--scratch ${scratchRoot} is not a directory`;
    if (uid !== null && st.uid !== uid)
      return `--scratch ${scratchRoot} is owned by uid ${st.uid}, not by you (uid ${uid}); another account could read or replace the runs in it`;
    if ((st.mode & 0o022) !== 0)
      return `--scratch ${scratchRoot} can be written by the group or others (mode ${(st.mode & 0o777).toString(8)}); run chmod go-w on it or choose another directory`;
  }
  const ancestor = unsafeAncestor(scratchRoot, uid);
  if (ancestor !== null)
    return `--scratch ${scratchRoot} lies below an unsafe directory: ${ancestor}; choose a directory whose parents only you and root can change`;
  return null;
}

/**
 * Creates a fresh run directory with an opaque name under `scratchRoot`, with
 * mode 0700 (and the root too, if it has to be created). Throws when the root
 * fails `checkScratchRoot`.
 */
export function createRunScratch(scratchRoot: string): RunScratch {
  if (
    mkdirSync(scratchRoot, { recursive: true, mode: SCRATCH_DIR_MODE }) !==
    undefined
  )
    chmodSync(scratchRoot, SCRATCH_DIR_MODE);
  const refused = checkScratchRoot(scratchRoot);
  if (refused !== null) throw new Error(refused);
  const base = realpathSync(scratchRoot);
  for (;;) {
    const id = randomBytes(ID_BYTES).toString("hex");
    const root = join(base, id);
    try {
      // Not recursive: an existing directory of that name is never adopted.
      mkdirSync(root, { mode: SCRATCH_DIR_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    // The umask can only narrow mkdir's mode; this makes it exactly 0700.
    chmodSync(root, SCRATCH_DIR_MODE);
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
 * caller must pass `--scratch`, and this returns null. The name is short on
 * purpose: the run's tmp path may not exceed `maxTmpPathBytes()`.
 */
export function defaultScratchRoot(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (platform === "darwin" && exists("/Users/Shared"))
    return "/Users/Shared/oe";
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
 * Claude config dir, empty gh config and npm cache (omitted when the path is
 * not an absolute path), and the fixed git
 * settings. Everything else in `base` (tokens, sockets, session ids, the API
 * key) is dropped. SSH_AUTH_SOCK is never set.
 */
export function setupEnv(
  base: NodeJS.ProcessEnv,
  options: Omit<ChildEnvOptions, "apiKey">,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...passed(base),
    ...FIXED_ENV,
    HOME: options.scratch.home,
    CLAUDE_CONFIG_DIR: options.scratch.configDir,
    TMPDIR: options.scratch.tmp,
    GH_CONFIG_DIR: options.scratch.gh,
  };
  // A missing or malformed cache path is left out: a stringified `undefined` would name a
  // directory called "undefined" in the working directory.
  if (usableCache(options.npmCache)) env.npm_config_cache = options.npmCache;
  return env;
}

export interface SessionEnvOptions {
  scratch: Pick<RunScratch, "home" | "configDir" | "tmp" | "gh">;
  /** The API key, for the claude process only (see `ChildEnvOptions`). */
  apiKey?: string;
}

/** npm cache of the session: a directory inside the scratch home. */
export function sessionNpmCache(scratch: Pick<RunScratch, "home">): string {
  return join(scratch.home, ".npm");
}

/** True for a value usable as `npm_config_cache`: an absolute path, so never the literal "undefined". */
function usableCache(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value);
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
  options: SessionEnvOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...setupEnv(base, {
      scratch: options.scratch,
      npmCache: sessionNpmCache(options.scratch),
    }),
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
  /** Longest scratch tmp path in bytes; defaults to `maxTmpPathBytes()` for this uid (test seam). */
  maxTmpPath?: number;
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
  const maxTmpPath = options.maxTmpPath ?? maxTmpPathBytes();
  const tmpBytes = scratchTmpPathBytes(options.scratchRoot);
  if (tmpBytes > maxTmpPath)
    return `--scratch ${options.scratchRoot} is too long: the run's tmp path would be ${tmpBytes} bytes (<scratch>/<8 hex>/tmp), and the limit is ${maxTmpPath} bytes (${CLAUDE_TMPDIR_MAX_BYTES}, less the separator and claude-<uid>). Beyond it Claude Code ignores CLAUDE_CODE_TMPDIR and silently falls back to /tmp/claude-<uid>, which is denied, so every sandboxed command fails. Choose a shorter directory, for example /Users/Shared/oe`;
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
    "checkout" | "evidence" | "runFiles" | "home" | "configDir" | "tmp" | "meta"
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
 * Every form of a path inside the scratch: its own forms, and the same path
 * under each form of the scratch root (a run's paths are built from the
 * resolved root, the caller may name the root through a symlink).
 */
export function scratchPathForms(path: string, scratchRoot: string): string[] {
  const realRoot = realOrSelf(resolve(scratchRoot));
  const rel = relative(realRoot, path);
  const under =
    rel.startsWith("..") || isAbsolute(rel)
      ? []
      : pathForms(scratchRoot).map((root) => join(root, rel));
  return uniq([...pathForms(path), ...under]);
}

/**
 * The private parts of every run under the scratch root, as `*` patterns
 * (one path segment: the run id): meta (prompt, settings, raw output),
 * evidence and home. The patterns cover this run's own evidence and home as
 * well, which the session reaches through Bash, not through the file tools.
 */
const PRIVATE_RUN_PARTS = ["meta", "evidence", "home"] as const;

function privateRunPatterns(
  scratchRoot: string,
  parts: readonly (typeof PRIVATE_RUN_PARTS)[number][],
): string[] {
  return pathForms(scratchRoot).flatMap((root) =>
    parts.map((part) => `${root}/*/${part}`),
  );
}

function denyRules(tools: ("Read" | "Edit")[], paths: string[]): string[] {
  return paths.flatMap((path) =>
    tools.flatMap((tool) => [
      `${tool}(${rulePath(path)})`,
      `${tool}(${rulePath(path)}/**)`,
    ]),
  );
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
  // CLAUDE_CONFIG_DIR of the session: user settings there are a trusted tier (for example for
  // sandbox.excludedCommands) and Claude Code reloads a changed settings file, so neither a
  // sandboxed command nor a file tool may write it. Claude Code adds it to the sandbox's
  // denyWrite on its own only under CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, which is never set
  // (`sessionEnv`). Bash may still read it: every Bash command first runs Claude Code's
  // shell snapshot from there.
  const configDir = scratchPathForms(scratch.configDir, input.scratchRoot);
  // Other runs' prompts, evidence and homes, which the file tools could otherwise read while
  // `--jobs` runs sessions side by side (the sandbox's denyRead covers Bash only). Claude Code
  // 2.1.302 also merges Read deny rules into the sandbox's read denial, where this run's
  // allowRead entries win, and Edit deny rules into its write denial, which wins over
  // allowWrite. So evidence and home get Read rules only: an Edit rule there would take this
  // run's own evidence and home from Bash, and it would hold nothing back from the file tools,
  // since Edit, Write and NotebookEdit are disallowed and other runs lie outside allowWrite.
  const fileRules = uniq([
    ...denyRules(
      ["Read", "Edit"],
      uniq([
        ...denied,
        ...tempDenied,
        scratch.meta,
        ...configDir,
        ...privateRunPatterns(input.scratchRoot, ["meta"]),
      ]),
    ),
    ...denyRules(
      ["Read"],
      privateRunPatterns(input.scratchRoot, ["evidence", "home"]),
    ),
  ]);
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
        // settings-reference#sandbox-filesystem-denywrite: never the protected trees, and never
        // the session's own Claude Code config directory inside the writable home (the narrower
        // path wins).
        denyWrite: uniq([...denied, ...configDir]),
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
/**
 * Git configuration passed through the environment: a value can carry a
 * credential (an `http.extraHeader` with a token) without its name looking
 * like one.
 */
const GIT_CONFIG_VALUE_NAME = /^GIT_CONFIG_VALUE_\d+$/i;
const MIN_SECRET_VALUE = 12;

/**
 * Git configuration pass-through names (`GIT_CONFIG_COUNT`,
 * `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`), compared without case.
 */
const GIT_CONFIG_ENV_NAME = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/i;

/** True for the git configuration pass-through names. */
export function isGitConfigEnvName(name: string): boolean {
  return GIT_CONFIG_ENV_NAME.test(name);
}

/**
 * True for a name the Claude Code sandbox itself puts into a sandboxed
 * command's environment: its network proxy's password
 * (`CLOUDSDK_PROXY_PASSWORD`) and the git configuration it passes through the
 * environment. Compared without case.
 */
export function isSandboxInjectedName(name: string): boolean {
  return (
    name.toUpperCase() === "CLOUDSDK_PROXY_PASSWORD" || isGitConfigEnvName(name)
  );
}

/**
 * Variable names that are secrets whether or not the host environment holds
 * them: if one shows up in the session, it leaked from somewhere. None of them
 * is a sandbox-injected name, so each always counts in `leakedSecretNames`;
 * the canary's name probe must catch each of them.
 */
export const KNOWN_SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AGENT_TASKS_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_MESSAGING_SOCKET",
] as const;

/**
 * A variable name as the session reported it, reduced to the name: trimmed,
 * backticks removed, and anything from the first `=` on dropped (a printed
 * `NAME=value` never carries its value into a record).
 */
export function normalizeEnvName(raw: string): string {
  return raw.trim().replace(/`/g, "").split("=")[0].trim();
}

/**
 * The reported variable names that count as leaked, normalized
 * (`normalizeEnvName`). Every name counts except a sandbox-injected one
 * (`isSandboxInjectedName`) that the host environment the runner was started
 * with does not hold, compared without case: an unknown name fails the check
 * instead of passing it.
 */
export function leakedSecretNames(
  names: string[],
  hostNames: Iterable<string>,
): string[] {
  const host = new Set([...hostNames].map((name) => name.toUpperCase()));
  const leaked: string[] = [];
  for (const raw of names) {
    const name = normalizeEnvName(raw);
    if (name.length === 0) continue;
    if (isSandboxInjectedName(name) && !host.has(name.toUpperCase())) continue;
    leaked.push(name);
  }
  return uniq(leaked);
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
 * a credential-looking variable of the invoking environment, git
 * configuration values included.
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
      (SECRET_NAME.test(name) || GIT_CONFIG_VALUE_NAME.test(name))
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

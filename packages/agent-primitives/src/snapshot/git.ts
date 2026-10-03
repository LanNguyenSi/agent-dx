import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { UsageError } from "../envelope.js";
import type { CheckoutIdentity } from "./schema.js";

export function decode(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new UsageError("snapshot requires UTF-8 Git paths");
  }
}
export function git(cwd: string, args: string[], allowed = [0]): Buffer {
  for (const key of Object.keys(process.env))
    if (
      /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_NAMESPACE|GIT_CONFIG.*|GIT_SHALLOW_FILE|GIT_REPLACE_REF_BASE|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM)$/.test(
        key,
      )
    )
      throw new UsageError(`snapshot refuses Git environment override: ${key}`);
  const r = spawnSync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    {
      cwd,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("GIT_"),
          ),
        ),
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: 10000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "buffer",
      windowsHide: true,
    },
  );
  if (r.error || r.signal || r.status === null || !allowed.includes(r.status))
    throw new UsageError(
      `snapshot Git command failed (${args[0]}): ${r.error?.message ?? decode(r.stderr).trim()}`,
    );
  return r.stdout;
}
export function gitText(cwd: string, args: string[], allowed = [0]): string {
  return decode(git(cwd, args, allowed)).replace(/\n$/, "");
}
export function checkoutIdentity(cwd: string): CheckoutIdentity {
  const root = fs.realpathSync(gitText(cwd, ["rev-parse", "--show-toplevel"]));
  const resolveDir = (flag: string) =>
    fs.realpathSync(path.resolve(root, gitText(root, ["rev-parse", flag])));
  return {
    root,
    gitDir: resolveDir("--absolute-git-dir"),
    commonDir: resolveDir("--git-common-dir"),
  };
}

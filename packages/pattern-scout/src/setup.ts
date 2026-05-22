import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { oneLine, splitCommand, truncate } from "./util.js";
import type { ResolvedConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export interface SetupResult {
  spec: string;
  ok: boolean;
  detail: string;
}

/**
 * Fetch the configured default exemplar repos into the opensrc cache, one
 * spec at a time so a single bad spec does not abort the rest. Throws only
 * when opensrc itself is missing, since then nothing can proceed.
 */
export async function runSetup(config: ResolvedConfig): Promise<SetupResult[]> {
  const [bin, ...prefix] = splitCommand(config.opensrcCommand);
  const results: SetupResult[] = [];

  for (const spec of config.defaultRepos) {
    try {
      await execFileAsync(bin, [...prefix, "fetch", spec], {
        maxBuffer: 8 * 1024 * 1024,
      });
      results.push({ spec, ok: true, detail: "fetched / already cached" });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      // A string `code` is a spawn-level failure: opensrc itself cannot be
      // run, so no spec can proceed. A numeric `code` is a per-spec fetch
      // failure, recorded below without aborting the batch.
      if (e && typeof e.code === "string") {
        throw new Error(
          `\`${bin}\` could not be run (${e.code}); install opensrc from https://github.com/vercel-labs/opensrc`,
        );
      }
      const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
      const message =
        stderr || (err instanceof Error ? err.message : String(err));
      results.push({ spec, ok: false, detail: truncate(oneLine(message), 160) });
    }
  }
  return results;
}

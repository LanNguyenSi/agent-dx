import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distCli = path.join(packageRoot, "dist", "cli.js");

// Reading built output means the build has to be at least as new as the
// source: CI's package job builds before it tests, and a mutation probe
// passes `--pre 'npm run build'` so the mutant reaches `dist/`. For every
// other way of running the suite, a missing OR stale `dist/cli.js` (older
// than the newest file under `src/`) is rebuilt here, so these tests can
// neither go inert nor pass against previously built code.
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const mtime = entry.isDirectory()
      ? newestMtimeMs(full)
      : fs.statSync(full).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function distIsCurrent(): boolean {
  if (!fs.existsSync(distCli)) return false;
  return (
    newestMtimeMs(path.join(packageRoot, "dist")) >=
    newestMtimeMs(path.join(packageRoot, "src"))
  );
}

export function ensureBuilt(): void {
  if (distIsCurrent()) return;
  const built = spawnSync("npm", ["run", "build"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (built.status !== 0) {
    throw new Error(
      `npm run build failed (${built.status}): ${built.stderr ?? ""}`,
    );
  }
}

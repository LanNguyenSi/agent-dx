import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";

/**
 * Returns the sha256 (hex) of a regular file's contents. Throws a
 * descriptive error for a missing path or a path that is not a regular
 * file (a directory, a symlink to nowhere, a socket, ...).
 */
export function sha256File(filePath: string): Promise<string> {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return Promise.reject(new Error(`hash: path does not exist: ${filePath}`));
  }
  if (!stat.isFile()) {
    return Promise.reject(new Error(`hash: not a regular file: ${filePath}`));
  }
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

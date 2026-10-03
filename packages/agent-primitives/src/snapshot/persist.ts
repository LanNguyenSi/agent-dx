import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UsageError } from "../envelope.js";
import { decode } from "./git.js";
import {
  MAX_ARTIFACT_BYTES,
  validateSnapshot,
  type SnapshotArtifact,
  type CheckoutIdentity,
} from "./schema.js";

/** Resolve existing ancestors before checking containment, including symlink aliases. */
export function outsideCheckout(
  input: string,
  checkout: string | CheckoutIdentity,
  cwd: string,
): string {
  const resolved = path.resolve(cwd, input);
  let ancestor = resolved;
  const suffix: string[] = [];
  while (!fs.existsSync(ancestor)) {
    // A dangling link must not be mistaken for a missing directory.
    try {
      if (fs.lstatSync(ancestor).isSymbolicLink())
        throw new UsageError("dangling persistence symlink");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor)
      throw new UsageError("cannot resolve persistence path");
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const target = path.join(fs.realpathSync(ancestor), ...suffix);
  const roots =
    typeof checkout === "string"
      ? [checkout]
      : [checkout.root, checkout.gitDir, checkout.commonDir];
  for (const root of roots) {
    const rel = path.relative(root, target);
    if (
      rel === "" ||
      (!rel.startsWith(`..${path.sep}`) &&
        rel !== ".." &&
        !path.isAbsolute(rel))
    )
      throw new UsageError(
        "snapshot/delta artifact and log paths must be outside checkout",
      );
  }
  return target;
}
export function persistSnapshot(
  artifact: SnapshotArtifact,
  options: { cwd: string; logDir: string; output?: string },
): { artifactPath: string; logDir: string } {
  const logDir = outsideCheckout(
    options.logDir,
    artifact.checkout,
    options.cwd,
  );
  const artifactPath = outsideCheckout(
    options.output ?? path.join(logDir, `snapshot-${randomUUID()}.json`),
    artifact.checkout,
    options.cwd,
  );
  const content = JSON.stringify(validateSnapshot(artifact), null, 2) + "\n";
  if (Buffer.byteLength(content) > MAX_ARTIFACT_BYTES)
    throw new UsageError("snapshot artifact byte limit exceeded");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  // Re-resolve after mkdir to catch ordinary ancestor replacements.
  if (
    outsideCheckout(artifactPath, artifact.checkout, options.cwd) !==
    artifactPath
  )
    throw new UsageError("unstable persistence path");
  const fd = fs.openSync(
    artifactPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, content);
  } catch (e) {
    fs.closeSync(fd);
    fs.unlinkSync(artifactPath);
    throw e;
  }
  fs.closeSync(fd);
  return { artifactPath, logDir };
}
export function readSnapshot(file: string): SnapshotArtifact {
  if (!fs.lstatSync(file).isFile())
    throw new UsageError("snapshot input must be a regular file");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > MAX_ARTIFACT_BYTES)
      throw new UsageError(
        "snapshot input must be a regular file within the byte limit",
      );
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(65536);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      total += n;
      if (total > MAX_ARTIFACT_BYTES)
        throw new UsageError("snapshot input byte limit exceeded");
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    const after = fs.fstatSync(fd);
    if (
      s.size !== after.size ||
      s.mtimeMs !== after.mtimeMs ||
      s.ctimeMs !== after.ctimeMs
    )
      throw new UsageError("unstable snapshot input");
    try {
      return validateSnapshot(JSON.parse(decode(Buffer.concat(chunks))));
    } catch (e) {
      if (e instanceof UsageError) throw e;
      throw new UsageError("malformed snapshot JSON");
    }
  } finally {
    fs.closeSync(fd);
  }
}

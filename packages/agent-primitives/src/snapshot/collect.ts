import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { UsageError } from "../envelope.js";
import { checkoutIdentity, decode, git, gitText } from "./git.js";
import {
  MAX_ENTRIES,
  safePath,
  SNAPSHOT_FORMAT,
  validateSnapshot,
  type IndexEntry,
  type SnapshotArtifact,
  type WorkingEntry,
} from "./schema.js";

function inventory(root: string) {
  if (
    gitText(root, ["config", "--bool", "core.sparseCheckout"], [0, 1]) ===
    "true"
  )
    throw new UsageError("sparse checkouts are unsupported");
  const rawIndex = decode(git(root, ["ls-files", "--stage", "-z"]));
  const rawUntracked = decode(
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  const index: IndexEntry[] = rawIndex
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(line);
      if (
        !m ||
        !safePath(m[4]) ||
        !["100644", "100755", "120000"].includes(m[1])
      )
        throw new UsageError(
          "unsupported index path/mode (gitlinks/submodules are unsupported)",
        );
      return { path: m[4], mode: m[1], oid: m[2], stage: Number(m[3]) };
    })
    .sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : a.stage - b.stage,
    );
  const untracked = rawUntracked.split("\0").filter(Boolean).sort();
  if (untracked.some((p) => !safePath(p)))
    throw new UsageError("unsupported untracked path or nested repository");
  if (index.length > MAX_ENTRIES || untracked.length > MAX_ENTRIES)
    throw new UsageError("snapshot entry limit exceeded");
  const head =
    gitText(root, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1]) || null;
  const branch =
    gitText(root, ["symbolic-ref", "--quiet", "HEAD"], [0, 1]) || null;
  return { index, untracked, head, branch };
}
export function checkAncestors(root: string, relative: string): void {
  let dir = root;
  for (const part of relative.split("/").slice(0, -1)) {
    dir = path.join(dir, part);
    try {
      const s = fs.lstatSync(dir);
      if (!s.isDirectory() || s.isSymbolicLink())
        throw new UsageError(
          "unsupported symlink or non-directory path ancestor",
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
  }
}
function metadata(s: fs.Stats): string {
  return [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(":");
}
function observe(
  root: string,
  relative: string,
): { entry: WorkingEntry; stamp: string } {
  checkAncestors(root, relative);
  const file = path.join(root, relative);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return {
        entry: {
          path: relative,
          type: "missing",
          hash: null,
          executable: false,
        },
        stamp: "missing",
      };
    throw e;
  }
  const hash = createHash("sha256");
  if (before.isSymbolicLink())
    hash.update(fs.readlinkSync(file, { encoding: "buffer" }));
  else if (before.isFile()) {
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      if (metadata(fs.fstatSync(fd)) !== metadata(before))
        throw new UsageError("unstable snapshot: file replaced before read");
      const buffer = Buffer.alloc(65536);
      let count: number;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
        hash.update(buffer.subarray(0, count));
      if (metadata(fs.fstatSync(fd)) !== metadata(before))
        throw new UsageError("unstable snapshot: file changed during read");
    } finally {
      fs.closeSync(fd);
    }
  } else throw new UsageError("unsupported working-tree file type");
  if (metadata(fs.lstatSync(file)) !== metadata(before))
    throw new UsageError("unstable snapshot: path changed during read");
  return {
    entry: {
      path: relative,
      type: before.isSymbolicLink() ? "symlink" : "file",
      executable: before.isFile() && (before.mode & 0o111) !== 0,
      hash: hash.digest("hex"),
    },
    stamp: metadata(before),
  };
}
function rejectUnsupportedFiles(root: string, index: IndexEntry[]): void {
  const tracked = index.map((e) => e.path);
  function walk(dir: string, prefix: string): void {
    for (const name of fs.readdirSync(dir, { encoding: "buffer" })) {
      const text = decode(name);
      if (!prefix && text === ".git") continue;
      const relative = prefix + text;
      if (text === ".git")
        throw new UsageError("nested repository is unsupported");
      const full = path.join(dir, text);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        if (
          !tracked.some((p) => p.startsWith(relative + "/")) &&
          git(root, ["check-ignore", "--", relative], [0, 1]).length
        )
          continue;
        walk(full, relative + "/");
      } else if (
        !stat.isFile() &&
        !stat.isSymbolicLink() &&
        !git(root, ["check-ignore", "--", relative], [0, 1]).length
      )
        throw new UsageError("unsupported working-tree file type");
    }
  }
  walk(root, "");
}
export function captureSnapshot(cwd: string): SnapshotArtifact {
  const checkout = checkoutIdentity(cwd);
  const first = inventory(checkout.root);
  rejectUnsupportedFiles(checkout.root, first.index);
  const paths = [
    ...new Set([...first.index.map((e) => e.path), ...first.untracked]),
  ].sort();
  const observed = paths.map((p) => observe(checkout.root, p));
  const last = inventory(checkout.root);
  rejectUnsupportedFiles(checkout.root, last.index);
  if (
    JSON.stringify(first) !== JSON.stringify(last) ||
    JSON.stringify(checkout) !== JSON.stringify(checkoutIdentity(cwd))
  )
    throw new UsageError("unstable snapshot: Git inventory changed");
  paths.forEach((p, i) => {
    checkAncestors(checkout.root, p);
    let stamp: string;
    try {
      stamp = metadata(fs.lstatSync(path.join(checkout.root, p)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      stamp = "missing";
    }
    if (stamp !== observed[i].stamp)
      throw new UsageError("unstable snapshot: file changed during capture");
  });
  return validateSnapshot({
    format: SNAPSHOT_FORMAT,
    hashAlgorithm: "sha256",
    objectFormat: gitText(checkout.root, ["rev-parse", "--show-object-format"]),
    capturedAt: new Date().toISOString(),
    checkout,
    ...first,
    workingTree: observed.map((o) => o.entry),
  });
}
